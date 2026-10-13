import { loadEnvFile } from '../src/config/env';
import { runMigrations } from '../src/db/migrate';

/** Aplica as migrações no banco de TESTE antes da suíte. Nunca toca o banco de desenvolvimento. */
export default async function globalSetup(): Promise<void> {
  loadEnvFile();
  const url = process.env.DATABASE_URL_TEST;
  if (!url) throw new Error('Defina DATABASE_URL_TEST no .env para rodar os testes.');
  if (url === process.env.DATABASE_URL) throw new Error('DATABASE_URL_TEST não pode ser igual a DATABASE_URL.');
  try {
    await runMigrations(url);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Não foi possível preparar o banco de testes (${msg}). O PostgreSQL está rodando? Use: npm run db:start`);
  }
}
