import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve, sep } from 'node:path';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Injectable } from '@nestjs/common';
import { env } from '../../config/env';
import { safeEqual, sign } from '../../common/crypto';

const ALLOWED: Record<string, (b: Buffer) => boolean> = {
  'application/pdf': (b) => b.subarray(0, 5).toString() === '%PDF-',
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/png': (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/webp': (b) => b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP',
  'text/plain': (b) => !b.includes(0),
};

export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

/**
 * Armazenamento privado de arquivos. Dois drivers com o mesmo contrato:
 * - local: diretório fora da pasta pública (desenvolvimento e testes);
 * - s3: bucket privado S3-compatível (AWS S3, Cloudflare R2...). Exigido em produção.
 * Nos dois casos o arquivo nunca é servido diretamente: o download passa pela
 * API com link assinado de curta duração, e uma chave nunca é sobrescrita.
 */
@Injectable()
export class StorageService {
  private s3?: S3Client;

  private client(): S3Client {
    const c = env();
    this.s3 ??= new S3Client({
      region: c.S3_REGION,
      endpoint: c.S3_ENDPOINT,
      forcePathStyle: c.S3_FORCE_PATH_STYLE,
      credentials: { accessKeyId: c.S3_ACCESS_KEY_ID!, secretAccessKey: c.S3_SECRET_ACCESS_KEY! },
    });
    return this.s3;
  }

  private useS3(): boolean {
    return env().STORAGE_DRIVER === 's3';
  }

  private s3Key(key: string): string {
    if (key.includes('..') || key.startsWith('/')) throw new Error('Chave de armazenamento inválida');
    return key;
  }

  private root(): string {
    const dir = env().STORAGE_DIR;
    // Caminho relativo = relativo à raiz do repositório (mesmo local em src/ e dist/).
    return isAbsolute(dir) ? dir : resolve(__dirname, '../../../../..', dir);
  }

  private pathFor(key: string): string {
    const full = resolve(this.root(), key);
    if (!full.startsWith(this.root() + sep)) throw new Error('Chave de armazenamento inválida');
    return full;
  }

  /** Confere o tipo pelo conteúdo (assinatura do arquivo), não só pela extensão. */
  validate(buffer: Buffer, mimeType: string): string | null {
    const check = ALLOWED[mimeType];
    if (!check) return 'Tipo de arquivo não permitido. Envie PDF, JPG, PNG, WEBP ou TXT.';
    if (!check(buffer)) return 'O conteúdo do arquivo não corresponde ao tipo informado.';
    if (buffer.length > MAX_UPLOAD_BYTES) return 'Arquivo maior que 15 MB.';
    return null;
  }

  async put(key: string, data: Buffer): Promise<{ sha256: string }> {
    const sha256 = createHash('sha256').update(data).digest('hex');
    if (this.useS3()) {
      // IfNoneMatch: falha se a chave já existir (mesma garantia do flag 'wx' local).
      await this.client().send(new PutObjectCommand({ Bucket: env().S3_BUCKET, Key: this.s3Key(key), Body: data, IfNoneMatch: '*', ChecksumAlgorithm: 'SHA256' }));
      return { sha256 };
    }
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data, { flag: 'wx' });
    return { sha256 };
  }

  async get(key: string): Promise<Buffer> {
    if (this.useS3()) {
      const out = await this.client().send(new GetObjectCommand({ Bucket: env().S3_BUCKET, Key: this.s3Key(key) }));
      return Buffer.from(await out.Body!.transformToByteArray());
    }
    return readFile(this.pathFor(key));
  }

  async remove(key: string): Promise<void> {
    if (this.useS3()) {
      await this.client().send(new DeleteObjectCommand({ Bucket: env().S3_BUCKET, Key: this.s3Key(key) }));
      return;
    }
    await rm(this.pathFor(key), { force: true });
  }

  /** Link temporário (5 min por padrão) para baixar UMA versão de arquivo. */
  signedPath(versionId: string, ttlSeconds = 300, now = Date.now()): string {
    const exp = Math.floor(now / 1000) + ttlSeconds;
    return `/api/files/${versionId}?exp=${exp}&sig=${sign(`${versionId}.${exp}`)}`;
  }

  verify(versionId: string, exp: string, sig: string, now = Date.now()): boolean {
    if (!/^\d+$/.test(exp) || Number(exp) * 1000 < now) return false;
    return safeEqual(sign(`${versionId}.${exp}`), sig);
  }
}
