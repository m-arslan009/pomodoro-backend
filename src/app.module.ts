import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { randomUUID } from 'node:crypto';
import { LoggerModule } from 'nestjs-pino';
import { HealthController } from './controllers/health.controller';
import { type Env, validateEnv } from './config/env.schema';
import { PrismaModule } from './database/prisma.module';
import { AuthModule } from './modules/auth.module';
import { SessionModule } from './modules/session.module';
import { SettingsModule } from './modules/settings.module';
import { TaskModule } from './modules/task.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, cache: true, validate: validateEnv }),

    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        pinoHttp: {
          level: config.get('LOG_LEVEL', { infer: true }),
          // Sets req.id, which the exception filter reports as `instance` so a user-visible
          // failure maps to exactly one log line (ADR-016).
          genReqId: () => randomUUID(),
          /*
           * Credentials must never reach a log file. Removing rather than masking keeps the
           * field out entirely, so a log shipper cannot later "helpfully" index it.
           *
           * The two cookie entries are **not** speculative, unlike `res.body.accessToken` below.
           * pino-http's default serialisers *do* log `req.headers` and `res.headers`, so from the
           * moment ADR-008 rev. 3 introduced a refresh cookie, omitting these would write the
           * plaintext long-lived credential to disk on every auth request — at the development
           * default of LOG_LEVEL=debug, on every developer's machine.
           *
           * `res.body.accessToken` still matches nothing, because response bodies are not
           * serialised. It is listed so that turning on a body serialiser to debug the auth flow
           * cannot be the change that starts writing live tokens to disk.
           */
          redact: {
            paths: [
              'req.headers.authorization',
              'req.headers.cookie',
              'res.headers["set-cookie"]',
              'req.body.password',
              'req.body.newPassword',
              'req.body.currentPassword',
              'res.body.accessToken',
            ],
            remove: true,
          },
          transport:
            config.get('NODE_ENV', { infer: true }) === 'production'
              ? undefined
              : { target: 'pino-pretty', options: { singleLine: true } },
        },
      }),
    }),

    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        throttlers: [
          {
            ttl: config.get('THROTTLE_TTL_MS', { infer: true }),
            limit: config.get('THROTTLE_LIMIT', { infer: true }),
          },
        ],
      }),
    }),

    PrismaModule,
    AuthModule,
    SettingsModule,
    TaskModule,
    SessionModule,
  ],
  controllers: [HealthController],
  providers: [
    // Global by default: a new endpoint is rate-limited unless it opts out, rather than
    // unlimited until someone remembers to protect it.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}
