import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, gt, isNull } from 'drizzle-orm';
import type { Response } from 'express';
import { env } from '../../config/env';
import { DB, type Db, type DbOrTx } from '../../db/db';
import { sessions, users } from '../../db/schema';
import type { AuthContext, RequestMeta } from '../../common/request-context';

export const SESSION_COOKIE = 'oralis_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Sessões opacas armazenadas no banco: podem ser listadas e revogadas
 * individualmente, e mudanças de papel valem na requisição seguinte,
 * porque as permissões são lidas do banco a cada requisição.
 */
@Injectable()
export class SessionService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async create(db: DbOrTx, userId: string, meta: RequestMeta): Promise<{ token: string; expiresAt: Date }> {
    const token = newToken();
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    await db.insert(sessions).values({ userId, tokenHash: sha256(token), expiresAt, ip: meta.ip, userAgent: meta.userAgent });
    return { token, expiresAt };
  }

  async resolve(token: string): Promise<AuthContext | null> {
    if (!token || token.length > 100) return null;
    const [row] = await this.db
      .select({
        sessionId: sessions.id,
        lastSeenAt: sessions.lastSeenAt,
        userId: users.id,
        email: users.email,
        name: users.name,
      })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(and(eq(sessions.tokenHash, sha256(token)), isNull(sessions.revokedAt), gt(sessions.expiresAt, new Date()), isNull(users.disabledAt)))
      .limit(1);
    if (!row) return null;
    if (Date.now() - row.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
      await this.db.update(sessions).set({ lastSeenAt: new Date() }).where(eq(sessions.id, row.sessionId));
    }
    return { sessionId: row.sessionId, userId: row.userId, email: row.email, name: row.name };
  }

  async revoke(sessionId: string, userId: string): Promise<boolean> {
    const r = await this.db
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId), isNull(sessions.revokedAt)))
      .returning({ id: sessions.id });
    return r.length > 0;
  }

  async listActive(userId: string) {
    return this.db
      .select({ id: sessions.id, ip: sessions.ip, userAgent: sessions.userAgent, createdAt: sessions.createdAt, lastSeenAt: sessions.lastSeenAt, expiresAt: sessions.expiresAt })
      .from(sessions)
      .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt), gt(sessions.expiresAt, new Date())))
      .orderBy(desc(sessions.lastSeenAt));
  }

  setCookie(res: Response, token: string, expiresAt: Date): void {
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: env().SESSION_COOKIE_SECURE,
      path: '/',
      expires: expiresAt,
    });
  }

  clearCookie(res: Response): void {
    res.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: 'lax', secure: env().SESSION_COOKIE_SECURE, path: '/' });
  }
}
