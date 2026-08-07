import { Module } from '@nestjs/common';
import { AdminUserController } from '../controllers/admin-user.controller';
import { AdminGuard } from '../guards/admin.guard';
import { AdminUserService } from '../services/admin-user.service';
import { AuthModule } from './auth.module';
import { ReportModule } from './report.module';
import { SessionModule } from './session.module';
import { TaskModule } from './task.module';

/*
 * Administration — the account directory, one account's detail, and the actions on it.
 *
 * IT DECLARES NO REPOSITORY OF ITS OWN, and that is the whole reason it imports four modules. The
 * detail view answers questions about seven tables, and ADR-020 gives each of those tables exactly
 * one component that touches it — so this module borrows those components rather than opening a
 * second door to any table. Every one of the borrowed reads is an admin-specific projection defined
 * on the owning repository, which is what keeps `provider_subject`, the session token digests, the
 * report token hashes and `report_deliveries.last_error` out of this surface by construction.
 *
 * The imports, and what each is for:
 *
 *   AuthModule    — JwtGuard, plus UserRepository (the account and every write on it),
 *                   AuthSessionRepository (how many sessions, last seen) and AuthIdentityRepository
 *                   (which providers are linked).
 *   SessionModule — SessionRepository, for the gamification projection and the focus-session count.
 *   TaskModule    — TaskRepository, for the task count.
 *   ReportModule  — ReportSubscriptionRepository, for the subscription and its last delivery.
 *
 * IT EXPORTS NOTHING, AND NOTHING IN THE PRODUCT MAY DEPEND ON IT. This is a leaf: a feature module
 * importing it would be a feature that only works for administrators. The dependency arrow points
 * one way, which is also why importing four modules here creates no cycle.
 *
 * AdminGuard is registered here rather than exported from AuthModule because it belongs to this
 * surface alone. It takes no constructor arguments, so unlike JwtGuard it needs nothing exported to
 * be constructible — listing it as a provider simply keeps the module's contents self-describing.
 */
@Module({
  imports: [AuthModule, SessionModule, TaskModule, ReportModule],
  controllers: [AdminUserController],
  providers: [AdminUserService, AdminGuard],
})
export class AdminModule {}
