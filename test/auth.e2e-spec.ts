import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import { randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { REFRESH_COOKIE_PATH } from '../src/common/utils/cookies';
import { PrismaService } from '../src/database/prisma.service';
import { ProblemDetailsFilter } from '../src/filters/problem-details.filter';

/*
 * Password sign-up and sign-in, against a real PostgreSQL.
 *
 * This exists because the unit specs cannot reach the two facts that matter most, and both are
 * facts about the *database* rather than about the service:
 *
 *  1. what `password_hash` actually holds once a registration has landed, and
 *  2. that a repeat registration is refused by the UNIQUE index — the collision the repository
 *     translates into a 409, which no fake can produce honestly.
 *
 * Requires `npm run db:up` and a migrated schema. `npm run test:e2e` is opt-in and is never part of
 * a phase gate.
 */

/** The success shape every auth route answers with (CONTRACT.md §4). */
interface AuthBody {
  user: {
    id: string;
    email: string;
    username: string;
    firstName: string;
    timezone: string;
  };
  accessToken: string;
  expiresIn: number;
}

/** RFC 9457 problem details (§6). */
interface ProblemBody {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  errors?: Array<{ field: string; message: string }>;
}

const authBody = (response: request.Response): AuthBody => response.body as AuthBody;
const problemBody = (response: request.Response): ProblemBody => response.body as ProblemBody;

/** The `Set-Cookie` values on a response, whatever the header's arity. */
function cookiesOf(response: request.Response): string[] {
  const header = response.headers['set-cookie'] as string | string[] | undefined;
  if (!header) return [];
  return Array.isArray(header) ? header : [header];
}

/** A registration nobody else owns, so runs cannot collide and teardown can be exact. */
function makeSignup() {
  // `e2e_` plus 8 hex characters stays inside the 20-character username limit and the
  // letters/numbers/underscore character set.
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

describe('password sign-up and login (e2e)', () => {
  let app: INestApplication;
  /** `getHttpServer()` is typed `any`; naming it once keeps every request below type-checked. */
  let server: Server;
  let prisma: PrismaService;
  const registeredEmails: string[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      /*
       * The rate limiter is disabled rather than exercised. `CREDENTIAL_THROTTLE` is 5/min per IP
       * and every request here is a credential request from one address, so leaving it on would
       * fail the suite on its own sixth call — a result about the throttler, reported as a broken
       * login.
       */
      .overrideGuard(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleRef.createNestApplication();
    // The same two lines main.ts applies. Without the prefix the routes are not where the client
    // looks; without the filter a rejection arrives as a Nest error rather than a problem document.
    app.setGlobalPrefix('api/v1', { exclude: ['health'] });
    app.useGlobalFilters(new ProblemDetailsFilter());

    await app.init();
    server = app.getHttpServer() as Server;
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    if (registeredEmails.length > 0) {
      // Sessions and every other owned row cascade from the account.
      await prisma.user.deleteMany({ where: { email: { in: registeredEmails } } });
    }
    await app.close();
  });

  /** Register through the API, and remember the account for teardown. */
  async function register(signup: ReturnType<typeof makeSignup>): Promise<request.Response> {
    const response = await request(server).post('/api/v1/auth/register').send(signup);
    registeredEmails.push(signup.email);
    return response;
  }

  it('signs a new account up, then signs it back in with the same email and password', async () => {
    const signup = makeSignup();

    const registered = await register(signup);

    expect(registered.status).toBe(201);
    expect(authBody(registered).user).toMatchObject({
      email: signup.email,
      username: signup.username,
      firstName: 'Ada',
      timezone: 'Europe/London',
    });
    expect(authBody(registered).accessToken).toBeTruthy();
    expect(authBody(registered).expiresIn).toBeGreaterThan(0);

    // Registering signs you in, so it must set the refresh cookie a later renewal reads — and that
    // cookie must be unreachable from script, which is the whole reason it holds the long-lived
    // half of the credential pair.
    const sessionCookie = cookiesOf(registered).find((value) =>
      value.includes(`Path=${REFRESH_COOKIE_PATH}`),
    );
    expect(sessionCookie).toBeDefined();
    expect(sessionCookie).toContain('HttpOnly');

    // The account is really there, and the password is not: the column holds an Argon2id digest,
    // which is the one thing a database dump must not hand over.
    const row = await prisma.user.findUnique({ where: { email: signup.email } });
    expect(row).not.toBeNull();
    expect(row?.usernameLower).toBe(signup.username.toLowerCase());
    expect(row?.passwordHash).not.toBe(signup.password);
    expect(row?.passwordHash).toMatch(/^\$argon2id\$/);

    // The point of the file: a credential stored only as a hash still verifies.
    const loggedIn = await request(server)
      .post('/api/v1/auth/login')
      .send({ identifier: signup.email, password: signup.password });

    expect(loggedIn.status).toBe(200);
    expect(authBody(loggedIn).user.id).toBe(authBody(registered).user.id);
    expect(authBody(loggedIn).accessToken).toBeTruthy();
    expect(cookiesOf(loggedIn).some((value) => value.includes('HttpOnly'))).toBe(true);

    // The sign-in opened its own session rather than reusing the sign-up's, and recorded the
    // account-level fact beside it.
    expect(await prisma.authSession.count({ where: { userId: row?.id } })).toBe(2);

    const afterLogin = await prisma.user.findUnique({ where: { email: signup.email } });
    expect(afterLogin?.lastLoginAt).not.toBeNull();
  });

  it('refuses a second registration on a taken email, and on a taken username', async () => {
    const first = makeSignup();
    expect((await register(first)).status).toBe(201);

    const sameEmail = await request(server)
      .post('/api/v1/auth/register')
      .send({ ...makeSignup(), email: first.email });

    expect(sameEmail.status).toBe(409);
    expect(problemBody(sameEmail).errors).toContainEqual({
      field: 'email',
      message: 'An account with this email already exists.',
    });

    // Uniqueness is case-insensitive through `username_lower`, so a different casing of a taken
    // handle is the same handle. This is the collision the UNIQUE index catches and that a
    // read-then-write pre-check would race on.
    const sameUsername = await request(server)
      .post('/api/v1/auth/register')
      .send({ ...makeSignup(), username: first.username.toUpperCase() });

    expect(sameUsername.status).toBe(409);
    expect(problemBody(sameUsername).errors).toContainEqual({
      field: 'username',
      message: 'That username is already taken.',
    });

    // Neither refused attempt left anything behind.
    expect(await prisma.user.count({ where: { email: first.email } })).toBe(1);
  });

  it('answers a wrong password and an account that does not exist identically', async () => {
    const signup = makeSignup();
    await register(signup);

    const wrongPassword = await request(server)
      .post('/api/v1/auth/login')
      .send({ identifier: signup.email, password: 'a different password entirely' });

    const noSuchAccount = await request(server)
      .post('/api/v1/auth/login')
      .send({
        identifier: `absent_${randomBytes(4).toString('hex')}@evergrove.test`,
        password: signup.password,
      });

    /*
     * Identical but for the request id. Any other difference — status, title, detail, the presence
     * of a field error — turns the login form into a way to ask whether an address has an account
     * here, which is the enumeration channel §6 closes.
     */
    expect(wrongPassword.status).toBe(401);
    expect(noSuchAccount.status).toBe(401);
    expect(problemBody(wrongPassword).title).toBe('Invalid credentials');
    expect(problemBody(wrongPassword).errors).toBeUndefined();
    expect({ ...problemBody(noSuchAccount), instance: undefined }).toEqual({
      ...problemBody(wrongPassword),
      instance: undefined,
    });

    // A refused sign-in opens nothing; the only session is the one registration created.
    const user = await prisma.user.findUnique({ where: { email: signup.email } });
    expect(await prisma.authSession.count({ where: { userId: user?.id } })).toBe(1);
  });
});
