import { Injectable } from '@nestjs/common';
import { type AdminUserSummary, toAdminUserSummary } from '../common/types/user.types';
import { adminSearchKey } from '../domain/admin-user';
import type { ListAdminUsersQueryDto } from '../dto/admin.dto';
import { UserRepository } from '../repositories/user.repository';

/**
 * Reading the account directory, for an operator.
 *
 * A THIN SERVICE, AND HONESTLY SO. There is no domain weight in listing accounts: the DTO has
 * already validated and bounded the query, the repository owns the keyset predicate, and the
 * projection is a pure function. What is left is the one transformation neither of those should
 * own — turning what the operator typed into the form the columns are stored in — plus the
 * allow-list projection, which is applied here so a controller can never hand a raw row to the
 * serialiser.
 *
 * It is deliberately not a method on `UserService`. That service is the signed-in account acting on
 * itself; this one is an operator acting on everybody, behind a different guard, and merging them
 * would put a route that reads every row next to routes whose entire safety property is that they
 * read exactly one.
 *
 * READ-ONLY, AND NO AUDIT EVENT. A GET that changes nothing has nothing to record, and an audit
 * trail that logs reads drowns the writes that matter in noise. The Pino request log already records
 * who called what and when (`admin_role_plan.md` §6.1). Every *mutating* admin route is audited —
 * none of them exists yet.
 */
@Injectable()
export class AdminUserService {
  constructor(private readonly users: UserRepository) {}

  async listUsers(
    query: ListAdminUsersQueryDto,
  ): Promise<{ users: AdminUserSummary[]; nextCursor: string | null }> {
    const { users, nextCursor } = await this.users.listForAdmin({
      // Undefined rather than an empty string: absent means "no filter", and the repository
      // distinguishes the two by presence, not by truthiness.
      search: query.q === undefined ? undefined : adminSearchKey(query.q),
      role: query.role,
      status: query.status,
      cursor: query.cursor,
      limit: query.limit,
    });

    return { users: users.map(toAdminUserSummary), nextCursor };
  }
}
