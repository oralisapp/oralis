import { Controller, Get, Global, Module, type OnModuleInit } from '@nestjs/common';
import { forbidden } from '../../common/app-error';
import { Public } from '../../common/request-context';
import { env } from '../../config/env';
import { DomainEvents } from './domain-events';
import { JobsService } from './jobs.service';
import { MailService } from './mail.service';

/** Caixa de saída local — existe apenas fora de produção, para ver e-mails sem SMTP. */
@Controller('dev')
class DevController {
  constructor(private readonly mail: MailService) {}

  @Get('outbox')
  @Public()
  async outbox() {
    if (env().APP_ENV === 'production' || env().APP_ENV === 'staging') throw forbidden('Indisponível neste ambiente.');
    return { smtpConfigured: this.mail.configured, messages: await this.mail.outbox(100) };
  }
}

@Global()
@Module({
  controllers: [DevController],
  providers: [MailService, JobsService, DomainEvents],
  exports: [MailService, JobsService, DomainEvents],
})
export class PlatformModule implements OnModuleInit {
  constructor(
    private readonly jobs: JobsService,
    private readonly mail: MailService,
  ) {}

  onModuleInit() {
    this.jobs.every({ name: 'mail.retry', everyMs: 60_000, run: () => this.mail.retryDue() });
    this.jobs.every({ name: 'jobs.recover', everyMs: 5 * 60_000, run: () => this.jobs.recoverStale() });
  }
}
