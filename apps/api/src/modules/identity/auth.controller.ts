import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Res, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  changePasswordSchema,
  forgotPasswordSchema,
  loginSchema,
  mfaCodeSchema,
  mfaDisableSchema,
  mfaLoginSchema,
  resetPasswordSchema,
  signupSchema,
} from '@oralis/shared';
import type { Response } from 'express';
import { notFound, parse } from '../../common/app-error';
import { AuthThrottlerGuard } from '../../common/guards';
import { Auth, type AuthContext, Meta, Public, type RequestMeta } from '../../common/request-context';
import { IdentityService } from './identity.service';
import { MfaService } from './mfa.service';
import { SessionService } from './session.service';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly identity: IdentityService,
    private readonly sessions: SessionService,
    private readonly mfa: MfaService,
  ) {}

  @Post('signup')
  @Public()
  @UseGuards(AuthThrottlerGuard)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async signup(@Body() body: unknown, @Meta() meta: RequestMeta, @Res({ passthrough: true }) res: Response) {
    const input = parse(signupSchema, body);
    const { token, expiresAt } = await this.identity.signup(input, meta);
    this.sessions.setCookie(res, token, expiresAt);
    return { ok: true };
  }

  /** Sem MFA: abre a sessão. Com MFA: devolve um desafio para a segunda etapa. */
  @Post('login')
  @Public()
  @HttpCode(200)
  @UseGuards(AuthThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async login(@Body() body: unknown, @Meta() meta: RequestMeta, @Res({ passthrough: true }) res: Response) {
    const r = await this.identity.login(parse(loginSchema, body), meta);
    if (r.kind === 'mfa') return { mfaRequired: true, challengeToken: r.challengeToken };
    this.sessions.setCookie(res, r.token, r.expiresAt);
    return { ok: true };
  }

  @Post('login/mfa')
  @Public()
  @HttpCode(200)
  @UseGuards(AuthThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async loginMfa(@Body() body: unknown, @Meta() meta: RequestMeta, @Res({ passthrough: true }) res: Response) {
    const input = parse(mfaLoginSchema, body);
    const { token, expiresAt } = await this.identity.completeMfaLogin(input.challengeToken, input.code, meta);
    this.sessions.setCookie(res, token, expiresAt);
    return { ok: true };
  }

  @Post('password/forgot')
  @Public()
  @HttpCode(200)
  @UseGuards(AuthThrottlerGuard)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async forgot(@Body() body: unknown, @Meta() meta: RequestMeta) {
    await this.identity.requestPasswordReset(parse(forgotPasswordSchema, body).email, meta);
    return { ok: true };
  }

  @Post('password/reset')
  @Public()
  @HttpCode(200)
  @UseGuards(AuthThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async reset(@Body() body: unknown, @Meta() meta: RequestMeta) {
    const input = parse(resetPasswordSchema, body);
    await this.identity.resetPassword(input.token, input.password, meta);
    return { ok: true };
  }

  @Post('password/change')
  @HttpCode(200)
  async change(@Auth() auth: AuthContext, @Body() body: unknown, @Meta() meta: RequestMeta) {
    const input = parse(changePasswordSchema, body);
    await this.identity.changePassword(auth, input.currentPassword, input.newPassword, meta);
    return { ok: true };
  }

  @Get('mfa')
  mfaStatus(@Auth() auth: AuthContext) {
    return this.mfa.status(auth.userId);
  }

  @Post('mfa/setup')
  mfaSetup(@Auth() auth: AuthContext) {
    return this.mfa.setup(auth);
  }

  @Post('mfa/enable')
  mfaEnable(@Auth() auth: AuthContext, @Body() body: unknown, @Meta() meta: RequestMeta) {
    return this.mfa.enable(auth, parse(mfaCodeSchema, body).code, meta);
  }

  @Post('mfa/disable')
  @HttpCode(200)
  mfaDisable(@Auth() auth: AuthContext, @Body() body: unknown, @Meta() meta: RequestMeta) {
    const input = parse(mfaDisableSchema, body);
    return this.mfa.disable(auth, input.password, input.code, meta);
  }

  @Post('logout')
  @HttpCode(200)
  async logout(@Auth() auth: AuthContext, @Res({ passthrough: true }) res: Response) {
    await this.sessions.revoke(auth.sessionId, auth.userId);
    this.sessions.clearCookie(res);
    return { ok: true };
  }

  @Get('me')
  me(@Auth() auth: AuthContext) {
    return this.identity.me(auth);
  }

  @Get('sessions')
  async listSessions(@Auth() auth: AuthContext) {
    const rows = await this.sessions.listActive(auth.userId);
    return rows.map((s) => ({ ...s, current: s.id === auth.sessionId }));
  }

  @Delete('sessions/:id')
  async revokeSession(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    if (!(await this.sessions.revoke(id, auth.userId))) throw notFound('Sessão');
    return { ok: true };
  }
}
