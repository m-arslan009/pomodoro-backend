import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import { randomBytes, randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import type { Task } from '../src/common/types/task.types';
import { PrismaService } from '../src/database/prisma.service';
import { ProblemDetailsFilter } from '../src/filters/problem-details.filter';

/*
 * Task CRUD against the real routes and a real PostgreSQL (CONTRACT.md §16.1-§16.4).
 *
 * The unit specs already cover each layer in isolation, and they cover it well — the controller's
 * envelopes, the service's `completedAt` pairing, the repository's where-clauses. What none of them
 * can reach is whether the four pieces, wired together behind a real token, actually store and
 * return a task. Every one of those specs asserts against a fake: the repository spec asserts the
 * QUERY IT BUILDS, never that Postgres honours it.
 *
 * So there are two facts here, and both are facts about the running system:
 *
 *  1. a task created through `POST` survives a round trip — it is listed, patched and deleted
 *     through the API, and the row underneath moves with it, and
 *  2. the ownership constraint holds in the database. The repository spec proves `userId` is in the
 *     where-clause; only this file proves that a second account therefore cannot read, patch or
 *     delete the first account's task (ADR-010).
 *
 * Requires `npm run db:up` and a migrated schema. `npm run test:e2e` is opt-in and is never part of
 * a phase gate.
 */

/** The success shape every auth route answers with (§4). */
interface AuthBody {
  user: { id: string };
  accessToken: string;
}

/** RFC 9457 problem details (§6). */
interface ProblemBody {
  title: string;
  status: number;
  detail?: string;
}

const authBody = (response: request.Response): AuthBody => response.body as AuthBody;
const taskBody = (response: request.Response): { task: Task } => response.body as { task: Task };
const listBody = (response: request.Response): { tasks: Task[]; nextCursor: string | null } =>
  response.body as { tasks: Task[]; nextCursor: string | null };
const problemBody = (response: request.Response): ProblemBody => response.body as ProblemBody;

/** A registration nobody else owns, so runs cannot collide and teardown can be exact. */
function makeSignup() {
  const suffix = randomBytes(4).toString('hex');
  return {
    firstName: 'Ada',
    lastName: 'Lovelace',
    email: `e2e_${suffix}@evergrove.test`,
    username: `e2e_${suffix}`,
    password: 'correct horse battery staple',
    timezone: 'Europe/London',
  };
}

/** One signed-in account: what every request below needs, and nothing more. */
interface Account {
  readonly id: string;
  readonly token: string;
}

describe('task CRUD (e2e)', () => {
  let app: INestApplication;
  /** `getHttpServer()` is typed `any`; naming it once keeps every request below type-checked. */
  let server: Server;
  let prisma: PrismaService;
  const registeredEmails: string[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      // Disabled rather than exercised: each test registers accounts from one address, and the
      // credential limiter would fail the suite on its own sixth call — a result about the
      // throttler, reported as broken task CRUD.
      .overrideGuard(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleRef.createNestApplication();
    // The same two lines main.ts applies. Without the prefix the routes are not where the client
    // looks; without the filter a 404 arrives as a Nest error rather than a problem document.
    app.setGlobalPrefix('api/v1', { exclude: ['health'] });
    app.useGlobalFilters(new ProblemDetailsFilter());

    await app.init();
    server = app.getHttpServer() as Server;
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    if (registeredEmails.length > 0) {
      // Tasks cascade from the account, so removing the users removes everything these tests wrote.
      await prisma.user.deleteMany({ where: { email: { in: registeredEmails } } });
    }
    await app.close();
  });

  /** Register through the API and keep the token, because that is how the guard is reached. */
  async function signUp(): Promise<Account> {
    const signup = makeSignup();
    const response = await request(server).post('/api/v1/auth/register').send(signup);
    registeredEmails.push(signup.email);

    expect(response.status).toBe(201);
    return { id: authBody(response).user.id, token: authBody(response).accessToken };
  }

  const asAccount = (account: Account) => `Bearer ${account.token}`;

  it('creates a task, lists it, updates it, and deletes it', async () => {
    const account = await signUp();

    // CREATE. The estimate is sent because it is the one optional field on the way in, and a
    // response that dropped it would still look correct in every other assertion.
    const created = await request(server)
      .post('/api/v1/tasks')
      .set('Authorization', asAccount(account))
      .send({ title: 'Thesis chapter 3', estimatedPomodoros: 3 });

    expect(created.status).toBe(201);
    expect(taskBody(created).task).toMatchObject({
      title: 'Thesis chapter 3',
      status: 'todo',
      estimatedPomodoros: 3,
      // A new task is not a completed one, and the column's CHECK constraint depends on the pairing.
      completedAt: null,
    });

    const taskId = taskBody(created).task.id;
    expect(taskId).toBeTruthy();

    // The row is really there, under the account that asked for it — the server assigned the owner
    // from the token, since no route accepts a user id.
    const stored = await prisma.task.findUnique({ where: { id: taskId } });
    expect(stored).not.toBeNull();
    expect(stored?.userId).toBe(account.id);
    expect(stored?.title).toBe('Thesis chapter 3');

    // READ. The owner gets it back from the unfiltered list, which is the read hydration performs.
    const listed = await request(server)
      .get('/api/v1/tasks')
      .set('Authorization', asAccount(account));

    expect(listed.status).toBe(200);
    expect(listBody(listed).tasks.map((task) => task.id)).toContain(taskId);
    expect(listBody(listed).tasks.find((task) => task.id === taskId)).toMatchObject({
      title: 'Thesis chapter 3',
      status: 'todo',
      estimatedPomodoros: 3,
    });

    // UPDATE. Both a renamed field and a status transition, because `completedAt` is derived from
    // the status by the server rather than sent — the one rule the service owns (§16.3).
    const updated = await request(server)
      .patch(`/api/v1/tasks/${taskId}`)
      .set('Authorization', asAccount(account))
      .send({ title: 'Thesis chapter 4', status: 'completed' });

    expect(updated.status).toBe(200);
    expect(taskBody(updated).task).toMatchObject({
      id: taskId,
      title: 'Thesis chapter 4',
      status: 'completed',
      // Untouched by the patch, and it must stay put: a rename is not a re-estimate.
      estimatedPomodoros: 3,
    });
    expect(taskBody(updated).task.completedAt).not.toBeNull();

    // Persisted, not merely echoed back out of the request.
    const afterPatch = await prisma.task.findUnique({ where: { id: taskId } });
    expect(afterPatch?.title).toBe('Thesis chapter 4');
    expect(afterPatch?.status).toBe('completed');
    expect(afterPatch?.completedAt).not.toBeNull();

    // DELETE. 204, and no body — §16.4.
    const deleted = await request(server)
      .delete(`/api/v1/tasks/${taskId}`)
      .set('Authorization', asAccount(account));

    expect(deleted.status).toBe(204);

    // Gone from the API and gone from the table. A soft delete that still listed would pass the
    // status assertion above and fail its user.
    const afterDelete = await request(server)
      .get('/api/v1/tasks')
      .set('Authorization', asAccount(account));

    expect(listBody(afterDelete).tasks.map((task) => task.id)).not.toContain(taskId);
    expect(await prisma.task.findUnique({ where: { id: taskId } })).toBeNull();

    // A second delete finds nothing. 404 rather than 204, which is what the client treats as
    // success anyway (§17.5) — what matters here is that the row did not come back.
    const deletedAgain = await request(server)
      .delete(`/api/v1/tasks/${taskId}`)
      .set('Authorization', asAccount(account));

    expect(deletedAgain.status).toBe(404);
  });

  it("never lets one account read, update or delete another account's task", async () => {
    const owner = await signUp();
    const stranger = await signUp();

    const created = await request(server)
      .post('/api/v1/tasks')
      .set('Authorization', asAccount(owner))
      .send({ title: 'Private work' });

    const taskId = taskBody(created).task.id;

    // READ. Not filtered out of a page the stranger can otherwise see — it is not in their read at
    // all, because the account is a constraint on the query rather than a filter applied after it.
    const strangersList = await request(server)
      .get('/api/v1/tasks')
      .set('Authorization', asAccount(stranger));

    expect(strangersList.status).toBe(200);
    expect(listBody(strangersList).tasks.map((task) => task.id)).not.toContain(taskId);

    /*
     * UPDATE and DELETE. 404 and never 403, and that is the assertion rather than an implementation
     * detail: a 403 would confirm the id exists, which is precisely the fact a stranger holding a
     * guessed id is trying to learn (ADR-010). The response must be the one an id that was never
     * issued would get.
     */
    const strangersPatch = await request(server)
      .patch(`/api/v1/tasks/${taskId}`)
      .set('Authorization', asAccount(stranger))
      .send({ title: 'Renamed by someone else', status: 'abandoned' });

    expect(strangersPatch.status).toBe(404);
    expect(problemBody(strangersPatch).title).toBe('Not found');

    const strangersDelete = await request(server)
      .delete(`/api/v1/tasks/${taskId}`)
      .set('Authorization', asAccount(stranger));

    expect(strangersDelete.status).toBe(404);

    // Indistinguishable from an id that belongs to nobody — the whole point of the two above.
    const absent = await request(server)
      .delete(`/api/v1/tasks/${randomUUID()}`)
      .set('Authorization', asAccount(stranger));

    expect(absent.status).toBe(strangersDelete.status);

    // The refused writes changed nothing. Without this the test would pass on an API that returned
    // 404 and applied the patch anyway.
    const untouched = await prisma.task.findUnique({ where: { id: taskId } });
    expect(untouched?.title).toBe('Private work');
    expect(untouched?.status).toBe('todo');
    expect(untouched?.userId).toBe(owner.id);

    // And the owner still has it, through the API.
    const ownersList = await request(server)
      .get('/api/v1/tasks')
      .set('Authorization', asAccount(owner));

    expect(listBody(ownersList).tasks.map((task) => task.id)).toContain(taskId);
  });
});
