import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { ReportTestSendService } from '../services/report-test-send.service';

/*
 * report:send-test — send exactly ONE report to exactly ONE named account.
 *
 *   npm run report:send-test -- --user-id <uuid> --confirm-send
 *   TEST_REPORT_USER_ID=<uuid> npm run report:send-test -- --confirm-send
 *
 * Optional:
 *   --period weekly|monthly     Which report to build. Defaults to the subscription's frequency.
 *   --allow-unverified          Send to an address Evergrove has not verified. See below.
 *   --dry-run                   Build and render, print the summary, send nothing.
 *
 * The npm script compiles first and runs `dist/`, rather than going through ts-node. Prisma 7's
 * generated client is TypeScript that requires its own `./internal/*.js` siblings, and ts-node
 * resolves those against the source tree where the .js files do not exist — so the ts-node form
 * fails at import time, before any argument is read.
 *
 * WHY THIS IS SHAPED THE WAY IT IS. It is the one command in the project that can put a real email
 * in a real person's inbox on purpose, so every default is the safe one and every dangerous thing is
 * a separate, explicit flag:
 *
 *   - THE ACCOUNT MUST BE NAMED. There is no "--all", no "--first", no query. A missing id is an
 *     error, not a search. It is impossible to fan out from here.
 *   - SENDING REQUIRES --confirm-send. Without it the command is a dry run that says what it would
 *     have done. Nobody sends mail by pressing up-arrow and enter.
 *   - UNVERIFIED ADDRESSES ARE REFUSED. L3 is not suspended for testing. Overriding it needs
 *     --allow-unverified, which exists for a seeded test account whose address you own.
 *   - THE OUTPUT IS DELIBERATELY THIN. Account id, MASKED email, verification state, subscription
 *     status, frequency, timezone, period. No token, no unsubscribe link, no API key, no message
 *     body, no other account's anything — a terminal is a screen-share, a scrollback and a CI log.
 */

interface Options {
  readonly userId: string;
  readonly confirmSend: boolean;
  readonly allowUnverified: boolean;
  readonly dryRun: boolean;
  readonly period: 'weekly' | 'monthly' | null;
}

function flagValue(argv: readonly string[], name: string): string | null {
  const index = argv.indexOf(name);
  if (index < 0) return null;
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value.`);
  return value;
}

function parseArgs(argv: readonly string[]): Options {
  /*
   * The flag wins over the environment variable, and neither is inferred. `TEST_REPORT_USER_ID`
   * exists so an id does not have to sit in shell history, not so the command can run without one.
   */
  const userId = flagValue(argv, '--user-id') ?? process.env.TEST_REPORT_USER_ID ?? '';
  if (!userId.trim()) {
    throw new Error(
      'An account must be named. Pass --user-id <uuid> or set TEST_REPORT_USER_ID.\n' +
        'This command never selects an account for you.',
    );
  }

  const period = flagValue(argv, '--period');
  if (period !== null && period !== 'weekly' && period !== 'monthly') {
    throw new Error('--period must be "weekly" or "monthly".');
  }

  return {
    userId: userId.trim(),
    confirmSend: argv.includes('--confirm-send'),
    allowUnverified: argv.includes('--allow-unverified'),
    dryRun: argv.includes('--dry-run'),
    period,
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  // No HTTP server: the application's providers without a listener.
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });

  try {
    const service = app.get(ReportTestSendService);
    const result = await service.sendOne({
      userId: options.userId,
      period: options.period,
      allowUnverified: options.allowUnverified,
      // A dry run overrides the confirmation, never the other way round.
      send: options.confirmSend && !options.dryRun,
    });

    process.stdout.write(`${result.summary}\n`);

    if (result.sent && result.reachedProvider) {
      process.stdout.write('\nSent. One message, to the account above.\n');
    } else if (result.sent) {
      /*
       * The console adapter accepted the message and wrote it to the log. Saying "Sent." here would
       * send a tester to an inbox that was never going to receive anything, and the silence would
       * read as a broken sending path rather than as the configuration it is.
       */
      process.stdout.write(
        '\nNOT sent to a real inbox. MAIL_PROVIDER=console, so the message was written to the\n' +
          'log and discarded. To reach an inbox, set MAIL_PROVIDER=resend with RESEND_API_KEY and\n' +
          'MAIL_FROM (an address on a domain verified with Resend), then run this again.\n',
      );
    } else if (options.dryRun) {
      process.stdout.write('\nDry run — nothing was sent.\n');
    } else if (!options.confirmSend) {
      process.stdout.write('\nNothing sent. Add --confirm-send to actually send this report.\n');
    }
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
