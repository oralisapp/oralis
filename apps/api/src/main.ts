import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { configureApp } from './bootstrap';
import { env } from './config/env';

async function main() {
  const config = env();
  const app = await NestFactory.create(AppModule, { bodyParser: false, rawBody: true, logger: ['error', 'warn', 'log'] });
  configureApp(app);
  app.enableShutdownHooks();
  const port = config.PORT ?? config.API_PORT;
  await app.listen(port, config.API_HOST);
  new Logger('Oralis').log(`API ouvindo em http://${config.API_HOST}:${port}/api (${config.APP_ENV})`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
