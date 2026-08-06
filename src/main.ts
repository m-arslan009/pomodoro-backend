import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { type Express, json } from 'express';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import type { Env } from './config/env.schema';
import type { RawBodyRequest } from './common/types/raw-body-request';
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
  app.use(
    json({
      limit: config.get('BODY_LIMIT', { infer: true }),
      /*
       * Keep the exact bytes for the mail provider's webhook (§25.6).
       *
       * A Svix signature is computed over the RAW body. `JSON.parse` followed by
       * `JSON.stringify` is not the same string — key order, whitespace and number formatting can
       * all differ — so verifying against a re-serialised body fails for legitimate requests and,
       * worse, would tempt someone to "fix" it by not verifying at all. This is the only way to
       * check a signature honestly, and it costs one Buffer reference per request.
       */
      verify: (request, _response, buffer) => {
        (request as RawBodyRequest).rawBody = Buffer.from(buffer);
      },
    }),
  );

  // /health stays off the versioned prefix so uptime checks survive an API version bump.
  app.setGlobalPrefix('api/v1', { exclude: ['health'] });
  app.useGlobalFilters(new ProblemDetailsFilter());

  /*
   * CORS exists for local development only. In production the SPA reaches the API through the
   * Netlify `/api/*` rewrite, which makes every call same-origin.
   *
   * `credentials: true` since ADR-008 rev. 3: the refresh token is an HttpOnly cookie, and without
   * this the browser withholds it on any cross-origin call — which is every call in a dev setup
   * that points Vite straight at this port. `Authorization` stays listed because it is not
   * CORS-safelisted and the preflight would otherwise refuse every authenticated request.
   *
   * `origin` must stay the allowlist-or-`false` expression below. `origin: true` reflects whatever
   * Origin the caller sent, and reflecting an arbitrary origin *with* credentials enabled lets any
   * site read authenticated responses — the two settings are safe apart and an open door together.
   */
  const origins = config.get('CORS_ORIGINS', { infer: true });
  app.enableCors({
    origin: origins.length > 0 ? origins : false,
    allowedHeaders: ['Authorization', 'Content-Type'],
    credentials: true,
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
