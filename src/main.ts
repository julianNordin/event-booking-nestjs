import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module';
import { AppConfig, appConfig } from './config/app.config';
import { configureApp } from './configure-app';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  configureApp(app);

  const { port, globalPrefix, nodeEnv } = app.get<AppConfig>(appConfig.KEY);
  await app.listen(port);

  Logger.log(`listening on http://localhost:${port}/${globalPrefix} [${nodeEnv}]`, 'Bootstrap');
}

bootstrap().catch((error: unknown) => {
  // A bad environment must stop the process here, loudly, rather than surface
  // later as a request-time failure with no obvious cause.
  Logger.error(error instanceof Error ? error.message : String(error), 'Bootstrap');
  process.exit(1);
});
