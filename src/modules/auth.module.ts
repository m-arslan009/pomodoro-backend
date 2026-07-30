import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { Clock } from '../common/ports/clock.port';
import { PasswordHasher } from '../common/ports/password-hasher.port';
import type { Env } from '../config/env.schema';
import { AuthController } from '../controllers/auth.controller';
import { UserController } from '../controllers/user.controller';
import { JwtGuard } from '../guards/jwt.guard';
import { UserAvatarRepository } from '../repositories/user-avatar.repository';
import { UserRepository } from '../repositories/user.repository';
import { AccessTokenService } from '../services/access-token.service';
import { Argon2PasswordHasher } from '../services/argon2-password-hasher.service';
import { AuthService } from '../services/auth.service';
import { AvatarService } from '../services/avatar.service';
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
 * authenticate requests; the repositories are not, because nothing outside this module may read
 * the users table directly. AccessTokenService stays internal for the same reason — a feature
 * module has no business minting credentials.
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
    JwtGuard,
    UserRepository,
    UserAvatarRepository,
    { provide: PasswordHasher, useClass: Argon2PasswordHasher },
    { provide: Clock, useClass: SystemClock },
  ],
  exports: [JwtGuard, PasswordHasher, Clock],
})
export class AuthModule {}
