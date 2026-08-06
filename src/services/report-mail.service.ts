import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Mailer } from '../common/ports/mailer.port';
import type { Env } from '../config/env.schema';
import type { ReportFrequency } from '../domain/report';

/*
 * Composes the messages this feature sends, and owns the one thing a message must never get wrong:
 * the links in it.
 *
 * Separate from ReportSubscriptionService because that service is about *state* — who asked for
 * what, and what the server did about it — and this is about *wording*. Folding them together would
 * put copy decisions in the same file as the L3 activation rule, and the R5 report email would
 * arrive on top of both.
 */

/** How long a user has to click. Read from config so it can be shortened during an incident. */
@Injectable()
export class ReportMailService {
  private readonly appOrigin: string;

  constructor(
    private readonly mailer: Mailer,
    config: ConfigService<Env, true>,
  ) {
    /*
     * The browser-facing origin, and the only thing a link is ever built from.
     *
     * NEVER derived from the request. A `Host` header is attacker-controlled, and a confirmation
     * link built from one points wherever the attacker chose — which, for a link whose entire
     * purpose is to prove the reader controls the address, hands over the exact thing it was
     * verifying. env.schema.ts requires this whenever a real provider is configured; the fallback
     * only ever applies under the console adapter, where the link is printed to a developer's log.
     */
    this.appOrigin = config.get('APP_ORIGIN', { infer: true }) ?? 'http://localhost:5173';
  }

  /**
   * Ask the reader to confirm that this address is theirs (§25.2, L3).
   *
   * **It carries no personal data.** Not a session count, not a streak, not a task title — nothing
   * but the offer and the link. That is deliberate: this is the one message in the feature that can
   * reach an address nobody has proven belongs to the account, because proving it is what the
   * message is for. If it lands in a stranger's inbox, the worst outcome is a stranger who ignores
   * it.
   */
  async sendConfirmation(input: {
    to: string;
    firstName: string;
    frequency: ReportFrequency;
    token: string;
  }): Promise<void> {
    const link = `${this.appOrigin}/reports/confirm?token=${encodeURIComponent(input.token)}`;
    const cadence = input.frequency === 'monthly' ? 'monthly' : 'weekly';

    const text = [
      `Hi ${input.firstName},`,
      '',
      `You asked Evergrove to send you a ${cadence} summary of your focus sessions.`,
      'Open this link to confirm your email address and start receiving them:',
      '',
      link,
      '',
      'The link works once and expires in seven days.',
      '',
      'If you did not ask for this, ignore this email — nothing will be sent.',
    ].join('\n');

    await this.mailer.send({
      to: input.to,
      subject: `Confirm your ${cadence} Evergrove report`,
      text,
      html: confirmationHtml(input.firstName, cadence, link),
    });
  }
}

/**
 * The HTML alternative, generated from the same values as the text part.
 *
 * Inline styles and no images. A confirmation mail that depends on a remote stylesheet or a spacer
 * image is a confirmation mail that renders as a blank page in the clients that block them — and a
 * remote asset in a message about someone's account is a tracking pixel whether or not it was meant
 * as one (§26.4).
 *
 * Interpolated values are escaped: `firstName` is user-authored and reaches this template verbatim.
 */
function confirmationHtml(firstName: string, cadence: string, link: string): string {
  const name = escapeHtml(firstName);
  const href = escapeHtml(link);

  return [
    '<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;line-height:1.6;color:#1f2a22">',
    `<p>Hi ${name},</p>`,
    `<p>You asked Evergrove to send you a ${cadence} summary of your focus sessions.</p>`,
    `<p><a href="${href}" style="display:inline-block;padding:12px 20px;border-radius:8px;background:#a9c98d;color:#10200f;font-weight:600;text-decoration:none">Confirm your email address</a></p>`,
    '<p style="color:#5b6b5f;font-size:13px">The link works once and expires in seven days. If you did not ask for this, ignore this email — nothing will be sent.</p>',
    `<p style="color:#5b6b5f;font-size:13px">If the button does not work, paste this into your browser:<br>${href}</p>`,
    '</div>',
  ].join('');
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
