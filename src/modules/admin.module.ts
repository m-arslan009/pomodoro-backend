import { Module } from '@nestjs/common';
import { AdminUserController } from '../controllers/admin-user.controller';
import { AdminGuard } from '../guards/admin.guard';
import { AdminUserService } from '../services/admin-user.service';
import { AuthModule } from './auth.module';

/*
 * Administration — the operator's read of the account directory.
 *
 * Imports AuthModule for JwtGuard, as every feature module does, and here for a second reason as
 * well: `UserRepository` is exported from that module and this one needs it. That is the narrow
 * exception ADR-020 already allows — the users table still has exactly one component that touches
 * it, and this module calls one read on it rather than reaching for the table itself.
 *
 * It declares no repository of its own, and exports nothing. Nothing in the product may depend on
 * the admin surface: it is a leaf, and a feature module importing it would be a feature that only
 * works for administrators.
 *
 * AdminGuard is registered here rather than exported from AuthModule because it belongs to this
 * surface alone. It takes no constructor arguments, so unlike JwtGuard it needs nothing exported to
 * be constructible — listing it as a provider simply keeps the module's contents self-describing.
 */
@Module({
  imports: [AuthModule],
  controllers: [AdminUserController],
  providers: [AdminUserService, AdminGuard],
})
export class AdminModule {}
