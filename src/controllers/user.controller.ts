import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { CurrentAuth } from '../common/decorators/current-auth.decorator';
import type { AuthContext, UserProfile } from '../common/types/user.types';
import { type UpdateProfileDto, updateProfileSchema } from '../dto/user.dto';
import { JwtGuard } from '../guards/jwt.guard';
import { ZodValidationPipe } from '../pipes/zod-validation.pipe';
import { UserService } from '../services/user.service';

/**
 * The signed-in account's own profile (ADR-007: `/api/v1/me`).
 *
 * Ownership needs no check here: the id comes from the verified access token, so there is no
 * path by which a caller could address another user's row (ADR-010).
 */
@Controller('me')
@UseGuards(JwtGuard)
export class UserController {
  constructor(private readonly users: UserService) {}

  @Get()
  read(@CurrentAuth() auth: AuthContext): { user: UserProfile } {
    return { user: auth.profile };
  }

  @Patch()
  async update(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(updateProfileSchema)) dto: UpdateProfileDto,
  ): Promise<{ user: UserProfile }> {
    return { user: await this.users.updateProfile(auth.userId, dto) };
  }
}
