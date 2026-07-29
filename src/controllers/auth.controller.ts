import { Body, Controller, Get, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CREDENTIAL_THROTTLE } from '../common/constants/auth.constants';
import { CurrentAuth } from '../common/decorators/current-auth.decorator';
import type { AuthContext, UserProfile } from '../common/types/user.types';
import {
  type ChangePasswordDto,
  type LoginDto,
  type RegisterDto,
  changePasswordSchema,
  loginSchema,
  registerSchema,
} from '../dto/auth.dto';
import { JwtGuard } from '../guards/jwt.guard';
import { ZodValidationPipe } from '../pipes/zod-validation.pipe';
import { AuthService, type AuthResult } from '../services/auth.service';

/*
 * HTTP only. Parses, delegates, returns the body — no rules live here.
 *
 * Every successful authentication answers with the same three fields and no cookie. The access
 * token is the entire credential and it travels in the body precisely because a script must
 * attach it to the next request; the client is required to hold it in memory and never in
 * storage, which is the only thing keeping an XSS bug from harvesting it.
 */

interface AuthResponse {
  user: UserProfile;
  accessToken: string;
  /** Milliseconds until the token expires, after which the user has to sign in again. */
  expiresIn: number;
}

function authResponse(result: AuthResult): AuthResponse {
  return {
    user: result.profile,
    accessToken: result.accessToken,
    expiresIn: result.accessTokenExpiresIn,
  };
}

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  /**
   * 201 with an access token: registering signs you in, which is what the sign-up form has
   * always implied. A taken email or username comes back as 409 with field errors.
   */
  @Post('register')
  @Throttle({ default: CREDENTIAL_THROTTLE })
  @HttpCode(HttpStatus.CREATED)
  async register(
    @Body(new ZodValidationPipe(registerSchema)) dto: RegisterDto,
  ): Promise<AuthResponse> {
    return authResponse(await this.auth.register(dto));
  }

  /** Accepts an email or a username in one field; 401 for every failure, with one wording. */
  @Post('login')
  @Throttle({ default: CREDENTIAL_THROTTLE })
  @HttpCode(HttpStatus.OK)
  async login(@Body(new ZodValidationPipe(loginSchema)) dto: LoginDto): Promise<AuthResponse> {
    return authResponse(await this.auth.login(dto));
  }

  /** The profile of the bearer of the presented access token. */
  @Get('me')
  @UseGuards(JwtGuard)
  me(@CurrentAuth() auth: AuthContext): { user: UserProfile } {
    return { user: auth.profile };
  }

  /**
   * Acknowledges that the client has discarded its token. That is the whole of it.
   *
   * There is no session to revoke and no cookie to clear, so this endpoint changes nothing on
   * the server — the token stays valid until it expires whether or not this is ever called. It
   * exists so the client has one call to make, and so signing out remains a server-observable
   * event when auditing or telemetry needs one. It is guarded, so only a real token can log it.
   *
   * There is deliberately no `logout-all`: signing out other devices is not something this
   * design can do, and an endpoint that claimed to would be worse than its absence.
   */
  @Post('logout')
  @UseGuards(JwtGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  logout(): void {}

  /**
   * Returns a new access token, so the caller does not have to sign in again after changing a
   * password. Tokens held by *other* devices are unaffected and keep working until they expire.
   */
  @Post('change-password')
  @UseGuards(JwtGuard)
  @Throttle({ default: CREDENTIAL_THROTTLE })
  @HttpCode(HttpStatus.OK)
  async changePassword(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(changePasswordSchema)) dto: ChangePasswordDto,
  ): Promise<AuthResponse> {
    return authResponse(await this.auth.changePassword(auth, dto));
  }
}
