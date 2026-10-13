import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

/**
 * Configuração validada na inicialização. A aplicação não sobe com
 * configuração inválida, e nenhum valor daqui é enviado ao front-end.
 */
const optionalSetting = (schema: z.ZodType<string>) => z.preprocess((v) => v === '' ? undefined : v, schema.optional());
const whatsappTemplates = z.preprocess((v) => {
  if (!v) return {};
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return null; }
}, z.record(z.uuid(), z.object({
  contentSid: z.string().regex(/^HX[0-9a-f]{32}$/i),
  variables: z.record(z.string().regex(/^[1-9][0-9]*$/), z.enum(['primeiro_nome', 'clinica', 'data', 'hora', 'profissional', 'link'])).default({}),
})));

const envSchema = z.object({
  APP_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  DATABASE_URL: z.string().startsWith('postgres'),
  API_PORT: z.coerce.number().int().default(4000),
  /** Railway/Render/Fly definem PORT; quando presente, tem prioridade sobre API_PORT. */
  PORT: z.preprocess((v) => (v === '' ? undefined : v), z.coerce.number().int().optional()),
  /** 127.0.0.1 em desenvolvimento; 0.0.0.0 dentro de um contêiner. */
  API_HOST: z.string().default('127.0.0.1'),
  /**
   * Quantos proxies confiáveis existem na frente da API (para obter o IP real
   * do cliente). Local: 'loopback'. Vercel → provedor da API: normalmente 2.
   */
  TRUST_PROXY: z.string().regex(/^(loopback|[0-9]{1,2})$/).default('loopback'),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  WEB_ORIGIN: z.url(),
  SESSION_COOKIE_SECURE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  ENCRYPTION_KEY: z
    .string()
    .refine((v) => Buffer.from(v, 'base64').length === 32, { error: 'ENCRYPTION_KEY deve ter 32 bytes em base64.' }),
  SMTP_URL: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
  MAIL_FROM: z.string().default('Oralis Cloud <nao-responda@oralis.example>'),
  TWILIO_ACCOUNT_SID: optionalSetting(z.string().regex(/^AC[0-9a-f]{32}$/i)),
  TWILIO_AUTH_TOKEN: optionalSetting(z.string().min(16)),
  TWILIO_SMS_FROM: optionalSetting(z.string().regex(/^\+[1-9][0-9]{7,14}$/)),
  TWILIO_WHATSAPP_FROM: optionalSetting(z.string().regex(/^\+[1-9][0-9]{7,14}$/)),
  TWILIO_WHATSAPP_TEMPLATES: whatsappTemplates,
  TWILIO_TIMEOUT_MS: z.coerce.number().int().min(1000).max(30000).default(10000),
  STRIPE_SECRET_KEY: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
  STRIPE_WEBHOOK_SECRET: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
  /** local = pasta privada no disco (desenvolvimento); s3 = bucket privado S3-compatível. */
  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  STORAGE_DIR: z.string().default('.data/uploads'),
  S3_BUCKET: optionalSetting(z.string().min(3)),
  S3_REGION: z.string().default('sa-east-1'),
  /** Somente para provedores compatíveis (ex.: Cloudflare R2); vazio = AWS. */
  S3_ENDPOINT: optionalSetting(z.url()),
  S3_ACCESS_KEY_ID: optionalSetting(z.string().min(8)),
  S3_SECRET_ACCESS_KEY: optionalSetting(z.string().min(16)),
  S3_FORCE_PATH_STYLE: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  ANTHROPIC_API_KEY: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
  /** Executa tarefas periódicas (e-mails, automações) neste processo. */
  JOBS_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
});

export type AppEnv = z.infer<typeof envSchema>;

let cached: AppEnv | undefined;

export function loadEnvFile(): void {
  const file = resolve(__dirname, '../../../../.env');
  if (existsSync(file)) process.loadEnvFile(file);
}

export function env(): AppEnv {
  if (cached) return cached;
  loadEnvFile();
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
    throw new Error(`Configuração inválida ou ausente: ${fields}. Veja .env.example.`);
  }
  if (parsed.data.APP_ENV === 'production' && !parsed.data.SESSION_COOKIE_SECURE) {
    throw new Error('Em produção, SESSION_COOKIE_SECURE deve ser true.');
  }
  if (parsed.data.APP_ENV === 'production' && !parsed.data.SMTP_URL) {
    throw new Error('Em produção, SMTP_URL é obrigatório (a caixa de saída local é só para desenvolvimento).');
  }
  if (parsed.data.STORAGE_DRIVER === 's3' && (!parsed.data.S3_BUCKET || !parsed.data.S3_ACCESS_KEY_ID || !parsed.data.S3_SECRET_ACCESS_KEY)) {
    throw new Error('STORAGE_DRIVER=s3 exige S3_BUCKET, S3_ACCESS_KEY_ID e S3_SECRET_ACCESS_KEY.');
  }
  if (parsed.data.APP_ENV === 'production' && parsed.data.STORAGE_DRIVER !== 's3') {
    throw new Error('Em produção, STORAGE_DRIVER deve ser s3 (o disco de um contêiner é apagado a cada nova versão).');
  }
  if (parsed.data.APP_ENV === 'production' && !parsed.data.WEB_ORIGIN.startsWith('https://')) {
    throw new Error('Em produção, WEB_ORIGIN deve usar https://.');
  }
  cached = parsed.data;
  return cached;
}

/** Usado pelos testes para trocar a URL do banco antes de criar a aplicação. */
export function overrideEnvForTests(values: Partial<AppEnv>): void {
  cached = { ...env(), ...values };
}
