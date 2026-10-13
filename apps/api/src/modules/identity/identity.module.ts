import { Global, Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { IdentityService } from './identity.service';
import { MfaService } from './mfa.service';
import { SessionService } from './session.service';

@Global()
@Module({
  controllers: [AuthController],
  providers: [IdentityService, SessionService, MfaService],
  exports: [SessionService, MfaService],
})
export class IdentityModule {}
