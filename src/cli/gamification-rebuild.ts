import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { GamificationService } from '../services/gamification.service';

/*
 * gamification:rebuild — recompute the progression projection from the event log.
 *
 *   npm run gamification:rebuild                 # every account with recorded sessions
 *   npm run gamification:rebuild -- --user <id>  # one account
 *
 * WHY THIS SHIPS WITH THE FEATURE RATHER THAN AFTER IT. `user_gamification` is only allowed to be
 * a projection — updated in the same transaction as the insert, cached in a single row, never
 * audited — because it is derivable. This command is what makes that true in practice instead of
 * in principle. Without it, the first time a row drifts (a bad deploy, a hand-edited record, a
 * changed rule) the totals are unrecoverable and the "projection" was always really a source of
 * truth nobody was protecting.
 *
 * It is also the test that the economy is a pure fold: rebuilding an untouched account must
 * reproduce its stored row exactly. If it does not, the scoring path has acquired a dependency on
 * something other than the event stream, and that is a defect wherever it is.
 *
 * Reads nothing but `focus_sessions`; writes nothing but `user_gamification`. Safe to run live,
 * though it is not a hot path and there is no reason to.
 */

interface Options {
  readonly userId: string | null;
}

function parseArgs(argv: readonly string[]): Options {
  const index = argv.indexOf('--user');
  if (index < 0) return { userId: null };

  const userId = argv[index + 1];
  if (!userId || userId.startsWith('--')) {
    throw new Error('--user requires an account id.');
  }

  return { userId };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  // No HTTP server: this is the application's providers without a listener.
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });

  try {
    const gamification = app.get(GamificationService);
    const userIds = options.userId ? [options.userId] : await gamification.listRebuildableUsers();

    if (userIds.length === 0) {
      process.stdout.write('No accounts with recorded sessions. Nothing to rebuild.\n');
      return;
    }

    process.stdout.write(`Rebuilding ${userIds.length} account(s)...\n`);

    for (const userId of userIds) {
      const state = await gamification.rebuild(userId);
      process.stdout.write(
        `  ${userId}  lifetime=${state.lifetimePoints}  ` +
          `dayStreak=${state.currentDayStreak}  run=${state.currentSessionRun}  ` +
          `titles=${state.unlockedTitles.length}\n`,
      );
    }

    process.stdout.write('Done.\n');
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`gamification:rebuild failed — ${String(error)}\n`);
  process.exitCode = 1;
});
