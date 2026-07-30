import {
  Body,
  Controller,
  Get,
  Headers,
  Patch,
  Put,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { AVATAR_THROTTLE } from '../common/constants/auth.constants';
import { CurrentAuth } from '../common/decorators/current-auth.decorator';
import { notFoundProblem } from '../common/errors/problem.exception';
import type { AuthContext, UserProfile } from '../common/types/user.types';
import { AVATAR_UPLOAD_LIMIT_BYTES } from '../domain/image';
import { type UpdateProfileDto, updateProfileSchema } from '../dto/user.dto';
import { JwtGuard } from '../guards/jwt.guard';
import { ZodValidationPipe } from '../pipes/zod-validation.pipe';
import { AvatarService, type UploadedImage } from '../services/avatar.service';
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
  constructor(
    private readonly users: UserService,
    private readonly avatars: AvatarService,
  ) {}

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

  /*
   * No `storage` is configured because multer defaults to memory when neither storage nor dest is
   * given, which is what this needs: the bytes go straight to Postgres and never touch a disk that
   * would not survive a redeploy anyway.
   */
  @Put('avatar')
  @Throttle({ default: AVATAR_THROTTLE })
  @UseInterceptors(
    FileInterceptor('avatar', { limits: { fileSize: AVATAR_UPLOAD_LIMIT_BYTES, files: 1 } }),
  )
  async replaceAvatar(
    @CurrentAuth() auth: AuthContext,
    @UploadedFile() file: UploadedImage | undefined,
  ): Promise<{ user: UserProfile }> {
    return { user: await this.avatars.replace(auth.userId, file) };
  }

  /**
   * Serves the bytes to their owner and nobody else.
   *
   * The ETag is the profile's `avatarUpdatedAt`, which the guard has already loaded — so an
   * unchanged photo is answered with a 304 without the image ever leaving the database.
   */
  @Get('avatar')
  async readAvatar(
    @CurrentAuth() auth: AuthContext,
    @Headers('if-none-match') ifNoneMatch: string | undefined,
    @Res() response: Response,
  ): Promise<void> {
    const { avatarUpdatedAt } = auth.profile;
    if (!avatarUpdatedAt) throw notFoundProblem('This account has no profile photo.');

    const etag = `"${avatarUpdatedAt}"`;
    if (ifNoneMatch === etag) {
      response.status(304).end();
      return;
    }

    const avatar = await this.avatars.read(auth.userId);

    response.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
    response.setHeader('ETag', etag);
    response.setHeader('Content-Disposition', 'inline');
    response.type(avatar.contentType).send(Buffer.from(avatar.data));
  }
}
