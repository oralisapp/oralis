import { randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { toString as qrToSvg } from 'qrcode';
import { AppError } from '../../common/app-error';
import { Clock } from '../../common/clock';
import { base32Encode, decrypt, encrypt, verifyTotp } from '../../common/crypto';
import type { AuthContext, RequestMeta } from '../../common/request-context';
import { DB, type Db, type DbOrTx } from '../../db/db';
import { mfaChallenges, mfaRecoveryCodes, userMfa, users } from '../../db/schema';
import { AuditService } from '../audit/audit.service';
import { verifyPassword } from './password';
import { newToken, sha256 } from './session.service';

const CHALLENGE_TTL_MS = 5 * 60_000;
const MAX_CHALLENGE_ATTEMPTS = 5;

/** MFA por aplicativo autenticador (TOTP) com códigos de recuperação de uso único. */
@Injectable()
export class MfaService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly clock: Clock,
    private readonly audit: AuditService,
  ) {}

  async isEnabled(db: DbOrTx, userId: string): Promise<boolean> {
    const [row] = await db.select({ enabledAt: userMfa.enabledAt }).from(userMfa).where(eq(userMfa.userId, userId));
    return !!row?.enabledAt;
  }

  async status(userId: string) {
    const [row] = await this.db.select().from(userMfa).where(eq(userMfa.userId, userId));
    const codes = await this.db.select().from(mfaRecoveryCodes).where(and(eq(mfaRecoveryCodes.userId, userId), isNull(mfaRecoveryCodes.usedAt)));
    return { enabled: !!row?.enabledAt, enabledAt: row?.enabledAt ?? null, recoveryCodesLeft: codes.length };
  }

  /** Gera um novo segredo (ainda não ativo) e o QR code para o aplicativo. */
  async setup(auth: AuthContext) {
    if (await this.isEnabled(this.db, auth.userId)) throw new AppError('conflict', 'A verificação em duas etapas já está ativa.');
    const secret = base32Encode(randomBytes(20));
    await this.db
      .insert(userMfa)
      .values({ userId: auth.userId, secretEncrypted: encrypt(secret) })
      .onConflictDoUpdate({ target: userMfa.userId, set: { secretEncrypted: encrypt(secret), enabledAt: null, lastUsedStep: null } });
    const uri = `otpauth://totp/${encodeURIComponent(`Oralis Cloud:${auth.email}`)}?secret=${secret}&issuer=${encodeURIComponent('Oralis Cloud')}&algorithm=SHA1&digits=6&period=30`;
    const qrSvg = await qrToSvg(uri, { type: 'svg', margin: 1, width: 200 });
    return { secret, uri, qrSvg };
  }

  /** Confirma o primeiro código, ativa e devolve os códigos de recuperação (mostrados uma vez). */
  async enable(auth: AuthContext, code: string, meta: RequestMeta) {
    return this.db.transaction(async (tx) => {
      const [row] = await tx.select().from(userMfa).where(eq(userMfa.userId, auth.userId)).for('update');
      if (!row) throw new AppError('validation_failed', 'Inicie a configuração antes de confirmar o código.');
      if (row.enabledAt) throw new AppError('conflict', 'A verificação em duas etapas já está ativa.');
      const step = verifyTotp(decrypt(row.secretEncrypted), code, this.clock.now(), null);
      if (step === null) throw new AppError('validation_failed', 'Código inválido. Confira o horário do celular e tente de novo.');
      await tx.update(userMfa).set({ enabledAt: this.clock.now(), lastUsedStep: step }).where(eq(userMfa.userId, auth.userId));
      const codes = Array.from({ length: 10 }, () => randomBytes(5).toString('hex').toUpperCase().replace(/(.{5})/, '$1-'));
      await tx.delete(mfaRecoveryCodes).where(eq(mfaRecoveryCodes.userId, auth.userId));
      await tx.insert(mfaRecoveryCodes).values(codes.map((c) => ({ userId: auth.userId, codeHash: sha256(c) })));
      await this.audit.record(tx, { organizationId: null, actorUserId: auth.userId, action: 'auth.mfa_enabled', entityType: 'user', entityId: auth.userId, meta });
      return { recoveryCodes: codes };
    });
  }

  async disable(auth: AuthContext, password: string, code: string, meta: RequestMeta) {
    const [u] = await this.db.select({ passwordHash: users.passwordHash }).from(users).where(eq(users.id, auth.userId));
    if (!(await verifyPassword(u?.passwordHash ?? null, password))) throw new AppError('validation_failed', 'Senha incorreta.');
    await this.db.transaction(async (tx) => {
      if (!(await this.checkCode(tx, auth.userId, code))) throw new AppError('validation_failed', 'Código inválido.');
      await tx.delete(userMfa).where(eq(userMfa.userId, auth.userId));
      await tx.delete(mfaRecoveryCodes).where(eq(mfaRecoveryCodes.userId, auth.userId));
      await this.audit.record(tx, { organizationId: null, actorUserId: auth.userId, action: 'auth.mfa_disabled', entityType: 'user', entityId: auth.userId, meta });
    });
    return { ok: true };
  }

  /** Aceita código TOTP (sem reutilização) ou código de recuperação (consumido). */
  async checkCode(tx: DbOrTx, userId: string, code: string): Promise<boolean> {
    const normalized = code.trim().toUpperCase();
    const [row] = await tx.select().from(userMfa).where(eq(userMfa.userId, userId)).for('update');
    if (!row?.enabledAt) return false;
    if (/^\d{6}$/.test(normalized)) {
      const step = verifyTotp(decrypt(row.secretEncrypted), normalized, this.clock.now(), row.lastUsedStep);
      if (step === null) return false;
      await tx.update(userMfa).set({ lastUsedStep: step }).where(eq(userMfa.userId, userId));
      return true;
    }
    const used = await tx
      .update(mfaRecoveryCodes)
      .set({ usedAt: this.clock.now() })
      .where(and(eq(mfaRecoveryCodes.userId, userId), eq(mfaRecoveryCodes.codeHash, sha256(normalized)), isNull(mfaRecoveryCodes.usedAt)))
      .returning({ id: mfaRecoveryCodes.id });
    return used.length > 0;
  }

  async createChallenge(db: DbOrTx, userId: string): Promise<string> {
    const token = newToken();
    await db.insert(mfaChallenges).values({ userId, tokenHash: sha256(token), expiresAt: new Date(this.clock.now().getTime() + CHALLENGE_TTL_MS) });
    return token;
  }

  /** Valida o desafio + código; devolve o usuário se ok. Erros não revelam qual parte falhou. */
  async completeChallenge(token: string, code: string): Promise<string> {
    // A transação sempre confirma: a tentativa errada também precisa ficar gravada.
    const userId = await this.db.transaction(async (tx) => {
      const [ch] = await tx
        .select()
        .from(mfaChallenges)
        .where(and(eq(mfaChallenges.tokenHash, sha256(token)), isNull(mfaChallenges.usedAt), gt(mfaChallenges.expiresAt, this.clock.now())))
        .for('update');
      if (!ch || ch.attempts >= MAX_CHALLENGE_ATTEMPTS) return null;
      if (!(await this.checkCode(tx, ch.userId, code))) {
        await tx.update(mfaChallenges).set({ attempts: ch.attempts + 1 }).where(eq(mfaChallenges.id, ch.id));
        return null;
      }
      await tx.update(mfaChallenges).set({ usedAt: this.clock.now() }).where(eq(mfaChallenges.id, ch.id));
      return ch.userId;
    });
    if (!userId) throw new AppError('unauthenticated', 'Código inválido ou expirado. Entre novamente se o problema continuar.');
    return userId;
  }
}
