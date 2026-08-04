import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { Clock } from '../common/ports/clock.port';
import { PasswordHasher } from '../common/ports/password-hasher.port';
import type { Env } from '../config/env.schema';
import { AuthController } from '../controllers/auth.controller';
import { UserController } from '../controllers/user.controller';
import { JwtGuard } from '../guards/jwt.guard';
import { AuthSessionRepository } from '../repositories/auth-session.repository';
import { UserAvatarRepository } from '../repositories/user-avatar.repository';
import { UserRepository } from '../repositories/user.repository';
import { AccessTokenService } from '../services/access-token.service';
import { Argon2PasswordHasher } from '../services/argon2-password-hasher.service';
import { AuthService } from '../services/auth.service';
import { AvatarService } from '../services/avatar.service';
import { RefreshTokenService } from '../services/refresh-token.service';
import { SystemClock } from '../services/system-clock.service';
import { UserService } from '../services/user.service';

/*
 * Identity and access.
 *
 * The two ports are bound here, and only here: everything downstream depends on the abstract
 * class, so swapping Argon2 for bcrypt, or the system clock for a fake, is a one-line change in
 * this file (ADR-005).
 *
 * JwtGuard, PasswordHasher and Clock are exported because every future feature module needs to
 * authenticate requests.
 *
 * AccessTokenService and UserRepository are exported *only* to make that work. A controller-scoped
 * `@UseGuards(JwtGuard)` is constructed in the injector of the module declaring the controller, not
 * in this one, so exporting the guard alone leaves a feature module unable to build it —
 * SettingsModule fails at boot with "can't resolve dependencies of the JwtGuard". Exporting its two
 * constructor arguments is the narrowest fix; the alternative is a global APP_GUARD, which would
 * change the default for every route in the application.
 *
 * The intent that made them internal still holds and is now convention rather than structure:
 * nothing outside this module may read the users table directly (ADR-020), and no feature module
 * has any business minting credentials. A feature module that injects either into its own service
 * is doing something wrong.
 */
@Module({
  imports: [
    /*
     * Only the signing key is registered globally. Issuer, audience and lifetime are passed
     * explicitly at every sign and every verify inside AccessTokenService, so the options a
     * token is checked against are visible at the call site rather than inherited from a
     * default somebody could later relax without touching the verification code.
     */
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        secret: config.get('JWT_SECRET', { infer: true }),
      }),
    }),
  ],
  controllers: [AuthController, UserController],
  providers: [
    AuthService,
    UserService,
    AvatarService,
    AccessTokenService,
    /*
     * Not exported, and that is the point. A feature module has no business minting or revoking a
     * credential, and nothing outside this module may touch auth_sessions (ADR-020). Unlike
     * AccessTokenService and UserRepository below, no guard needs these to be constructible
     * elsewhere, so the narrow default is also the correct one.
     */
    RefreshTokenService,
    AuthSessionRepository,
    JwtGuard,
    UserRepository,
    UserAvatarRepository,
    { provide: PasswordHasher, useClass: Argon2PasswordHasher },
    { provide: Clock, useClass: SystemClock },
  ],
  exports: [JwtGuard, AccessTokenService, UserRepository, PasswordHasher, Clock],
})
export class AuthModule {}
