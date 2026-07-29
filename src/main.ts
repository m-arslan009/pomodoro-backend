import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { type Express, json } from 'express';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import type { Env } from './config/env.schema';
import { ProblemDetailsFilter } from './filters/problem-details.filter';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, {
    // Buffer until Pino is attached, so boot-time messages use the real logger.
    bufferLogs: true,
    // Disabled so the body parser below can enforce the configured size limit; Nest's default
    // parser would otherwise run first with its own.
    bodyParser: false,
  });

  app.useLogger(app.get(Logger));

  const config = app.get<ConfigService<Env, true>>(ConfigService);
  const isProduction = config.get('NODE_ENV', { infer: true }) === 'production';

  app.use(helmet());
  app.use(json({ limit: config.get('BODY_LIMIT', { infer: true }) }));

  // /health stays off the versioned prefix so uptime checks survive an API version bump.
  app.setGlobalPrefix('api/v1', { exclude: ['health'] });
  app.useGlobalFilters(new ProblemDetailsFilter());

  /*
   * CORS exists for local development only. In production the SPA reaches the API through the
   * Netlify `/api/*` rewrite, which makes every call same-origin.
   *
   * No `credentials: true`: the API sets no cookies and reads none, so the browser has no
   * ambient credential to withhold. The access token rides in an explicit header instead —
   * which is also why Authorization is listed here, since it is not CORS-safelisted and the
   * preflight would otherwise refuse every authenticated request.
   */
  const origins = config.get('CORS_ORIGINS', { infer: true });
  app.enableCors({
    origin: origins.length > 0 ? origins : false,
    allowedHeaders: ['Authorization', 'Content-Type'],
  });

  // Behind Fly/Render's proxy, req.ip is the load balancer without this.
  if (isProduction) {
    const httpServer = app.getHttpAdapter().getInstance() as Express;
    httpServer.set('trust proxy', 1);
  }

  app.enableShutdownHooks();

  await app.listen(config.get('PORT', { infer: true }));
}

void bootstrap();
