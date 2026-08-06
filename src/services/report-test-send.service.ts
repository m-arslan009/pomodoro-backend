import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Clock } from '../common/ports/clock.port';
import type { Env } from '../config/env.schema';
import { Mailer } from '../common/ports/mailer.port';
import {
  type ReportFrequency,
  buildReport,
  isEmptyReport,
  localDate,
  precedingPeriod,
  previousPeriod,
} from '../domain/report';
import { ReportSubscriptionRepository } from '../repositories/report-subscription.repository';
import { SessionRepository } from '../repositories/session.repository';
import { UserRepository } from '../repositories/user.repository';
import { ReportLinkService } from './report-link.service';
import { ReportRendererService } from './report-renderer.service';

/*
 * The one deliberate path to a real inbox — `npm run report:send-test` (see cli/report-send-test.ts).
 *
 * It is a separate service rather than a method on the worker, because it must NOT behave like the
 * worker. It takes no batch, claims no delivery row, writes nothing to the ledger, and does not mark
 * a period as covered — so running it can never suppress the real report the account is owed, and
 * running it twice is not a duplicate-send bug in the ledger's terms.
 *
 * Every safety rule is in this file rather than in the CLI, so a second caller could not obtain a
 * looser version of it by calling the service directly.
 */

const WINDOW_PADDING_MS = 2 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface TestSendRequest {
  /** Required, and never defaulted or searched for. */
  readonly userId: string;
  readonly period: ReportFrequency | null;
  readonly allowUnverified: boolean;
  readonly send: boolean;
}

export interface TestSendResult {
  /** The mailer accepted the message. NOT a claim that anything left this machine — see `reachedProvider`. */
  readonly sent: boolean;
  /**
   * Whether the configured adapter actually talks to a mail provider.
   *
   * False under the console adapter, which writes the message to the log and sends nothing. The
   * distinction is surfaced because the whole purpose of this command is to answer "did a real
   * email go out?", and a bare "Sent." under MAIL_PROVIDER=console answers it wrongly — a tester
   * would go and look in an inbox that was never going to receive anything.
   */
  readonly reachedProvider: boolean;
  /** Ready to print. Contains no secret, no token, and no full address. */
  readonly summary: string;
}

@Injectable()
export class ReportTestSendService {
  private readonly provider: Env['MAIL_PROVIDER'];

  constructor(
    config: ConfigService<Env, true>,
    private readonly users: UserRepository,
    private readonly subscriptions: ReportSubscriptionRepository,
    private readonly sessions: SessionRepository,
    private readonly renderer: ReportRendererService,
    private readonly links: ReportLinkService,
    private readonly mailer: Mailer,
    private readonly clock: Clock,
  ) {
    this.provider = config.get('MAIL_PROVIDER', { infer: true });
  }

  async sendOne(request: TestSendRequest): Promise<TestSendResult> {
    const user = await this.users.findById(request.userId);
    if (!user) throw new Error(`No account with id ${request.userId}.`);

    const subscription = await this.subscriptions.findByUserId(user.id);
    const verified = user.emailVerifiedAt !== null;

    /*
     * L3 is not suspended for testing. An unverified address is one nobody has proved belongs to
     * this account, and a full activity report is the last thing to send to it by accident — the
     * override exists for a seeded account whose mailbox you own, and it has to be typed.
     */
    if (!verified && !request.allowUnverified) {
      throw new Error(
        "This account's email address is not verified, so no report will be sent.\n" +
          'If you own this mailbox and are testing deliberately, re-run with --allow-unverified.',
      );
    }

    const frequency: ReportFrequency = request.period ?? subscription?.frequency ?? 'weekly';
    const now = this.clock.now();
    const period = previousPeriod(frequency, localDate(now, user.timezone));

    const earliest = precedingPeriod(period).start;
    const [sessions, progress] = await Promise.all([
      this.sessions.findEndedBetween(
        user.id,
        new Date(toDate(earliest).getTime() - WINDOW_PADDING_MS),
        new Date(toDate(period.end).getTime() + WINDOW_PADDING_MS + DAY_MS),
      ),
      this.sessions.getGamification(user.id),
    ]);

    const data = buildReport({
      period,
      timeZone: user.timezone,
      firstName: user.firstName,
      generatedAt: now,
      sessions: sessions.map((session) => ({
        type: session.type,
        status: session.status,
        endedAt: session.endedAt,
        actualDurationMs: session.actualDurationMs,
        taskTitleSnapshot: session.taskTitleSnapshot,
        terminationReason: session.terminationReason,
      })),
      progress,
    });

    const lines = [
      'Report test send',
      '────────────────────────────────────────────',
      `  account id     : ${user.id}`,
      // Masked, always. A terminal is a screen-share, a scrollback and a CI log.
      `  email          : ${maskEmail(user.email)}`,
      `  verified       : ${verified ? 'yes' : `no${request.allowUnverified ? ' (override in effect)' : ''}`}`,
      `  subscription   : ${subscription?.status ?? 'none — never asked'}`,
      `  frequency      : ${frequency}${request.period ? ' (forced)' : ''}`,
      `  timezone       : ${user.timezone}`,
      `  mail provider  : ${this.provider}${this.provider === 'console' ? ' — writes to the log, sends NOTHING' : ''}`,
      `  period         : ${data.periodLabel}`,
      `  sessions       : ${data.totals.completedSessions} completed, ${data.totals.terminatedSessions} stopped early`,
      `  focus minutes  : ${data.totals.focusMinutes}`,
      '────────────────────────────────────────────',
    ];

    if (isEmptyReport(data)) {
      /*
       * Reported, not refused. The worker would skip this period (P7), and a tester needs to know
       * that is why nothing arrived — otherwise the obvious conclusion is that sending is broken.
       */
      lines.push('This period holds no focus sessions, so the worker would skip it (P7).');
      lines.push('Nothing was sent. Record a session in this period and try again.');
      return { sent: false, reachedProvider: false, summary: lines.join('\n') };
    }

    const pdf = await this.renderer.render(data);
    lines.push(`Rendered PDF: ${pdf.byteLength.toLocaleString('en-GB')} bytes.`);

    if (!request.send) return { sent: false, reachedProvider: false, summary: lines.join('\n') };

    const receipt = await this.mailer.send({
      to: user.email,
      subject: `[TEST] Your ${frequency} Evergrove report — ${data.periodLabel}`,
      text: [
        `Hi ${data.firstName},`,
        '',
        'This is a TEST send of your Evergrove focus report.',
        '',
        `Period            : ${data.periodLabel} (${user.timezone})`,
        `Sessions completed: ${data.totals.completedSessions}`,
        `Stopped early     : ${data.totals.terminatedSessions}`,
        `Time focused      : ${data.totals.focusMinutes} minutes`,
        `Completion rate   : ${data.totals.completionRate}%`,
        '',
        'The attached PDF has the full breakdown.',
        '',
        'Change how often you get these, or turn them off:',
        this.links.settingsUrl(),
        '',
        'Unsubscribe:',
        this.links.unsubscribeUrl(user.id),
      ].join('\n'),
      attachments: [
        {
          filename: `evergrove-report-${period.start}.pdf`,
          content: pdf,
          contentType: 'application/pdf',
        },
      ],
      headers: {
        'List-Unsubscribe': `<${this.links.unsubscribeUrl(user.id)}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
    });

    /*
     * The provider's id is printed because it is the only handle on this message afterwards — it is
     * what a provider dashboard is searched by, and what a later delivery webhook names. It is an
     * opaque identifier for a message, not a credential.
     */
    lines.push(`Message id: ${receipt.messageId ?? '(the adapter returned none)'}`);

    return {
      sent: true,
      reachedProvider: this.provider !== 'console',
      summary: lines.join('\n'),
    };
  }
}

/**
 * `ad***@ex***.test` — enough to recognise an address you already know, not enough to learn one.
 *
 * The local part keeps two characters and the domain label two; the TLD stays, because it is the
 * part a tester checks when they are wondering whether they seeded the right environment.
 */
function maskEmail(email: string): string {
  const [local = '', domain = ''] = email.split('@');
  const labels = domain.split('.');
  const tld = labels.length > 1 ? labels.pop() : '';
  const head = labels.join('.');

  return `${local.slice(0, 2)}***@${head.slice(0, 2)}***${tld ? `.${tld}` : ''}`;
}

function toDate(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}
