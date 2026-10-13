import { hash, verify } from '@node-rs/argon2';

// argon2id (padrão da biblioteca) com os parâmetros mínimos recomendados pela OWASP.
const OPTIONS = { memoryCost: 19456, timeCost: 2, parallelism: 1 };

export function hashPassword(password: string): Promise<string> {
  return hash(password, OPTIONS);
}

let dummyHash: Promise<string> | undefined;

/**
 * Verifica a senha. Quando o usuário não existe, compara contra um hash
 * descartável para que o tempo de resposta não revele se o e-mail tem conta.
 */
export async function verifyPassword(storedHash: string | null, password: string): Promise<boolean> {
  if (!storedHash) {
    dummyHash ??= hash('senha-inexistente-para-equalizar-tempo', OPTIONS);
    await verify(await dummyHash, password).catch(() => false);
    return false;
  }
  return verify(storedHash, password).catch(() => false);
}
