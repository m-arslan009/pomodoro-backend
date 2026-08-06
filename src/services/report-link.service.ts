import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.schema';
import { deriveUnsubscribeToken } from '../domain/report';

/*
 * Every link that appears in a report email, and the one credential the worker has to be able to
 * reproduce.
 *
 * THE PROBLEM THIS SOLVES. §23.1 stores the unsubscribe token **hashed**, and §26.5 requires an
 * unsubscribe link in every report — including reports sent months apart. Those two are only
 * compatible if the token can be recomputed, because a hash cannot be reversed and a freshly minted
 * token on every send would kill the link in every email already delivered. A link in a year-old
 * email that has stopped working is a link that lied, which is exactly what §25.4 refuses.
 *
 * So the token is DERIVED rather than random: `HMAC-SHA256(JWT_SECRET, "report-unsubscribe:<userId>")`.
 * The column still stores only its SHA-256, so a database dump on its own yields no working links —
 * an attacker would need the application's signing key as well, at which point unsubscribe links are
 * not the interesting thing they can do.
 *
 * The label is domain separation, and it is not decoration: it is what stops a value derived here
 * from ever being valid anywhere else that uses the same key.
 */

@Injectable()
export class ReportLinkService {
  private readonly secret: string;
  private readonly appOrigin: string;

  constructor(config: ConfigService<Env, true>) {
    this.secret = config.get('JWT_SECRET', { infer: true });
    /*
     * Never derived from a request. A `Host` header is attacker-controlled, and an unsubscribe link
     * built from one points wherever the attacker chose. `env.schema.ts` requires APP_ORIGIN
     * whenever a real mail provider is configured; the fallback applies only under the console
     * adapter, where the link is printed to a developer's own log.
     */
    this.appOrigin = config.get('APP_ORIGIN', { infer: true }) ?? 'http://localhost:5173';
  }

  /** The plaintext token for an account. Reproducible, so an old email's link still works. */
  unsubscribeToken(userId: string): string {
    return deriveUnsubscribeToken(this.secret, userId);
  }

  /** The absolute URL that lands on the frontend page, which then POSTs (§25.4). */
  unsubscribeUrl(userId: string): string {
    const token = encodeURIComponent(this.unsubscribeToken(userId));
    return `${this.appOrigin}/reports/unsubscribe?token=${token}`;
  }

  /** Where "change how often" goes. No token — it needs a session, and that is the point. */
  settingsUrl(): string {
    return `${this.appOrigin}/settings`;
  }
}
