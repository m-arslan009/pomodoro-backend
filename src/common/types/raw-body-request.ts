import type { Request } from 'express';

/**
 * A request carrying the exact bytes its body arrived as.
 *
 * Populated by the `verify` hook on the JSON body parser in `main.ts`, for one consumer: the mail
 * provider's delivery webhook (CONTRACT.md §25.6). A Svix signature covers the raw payload, and
 * re-serialising a parsed object produces a different string — different key order, different
 * whitespace, different number formatting — so a signature checked against `JSON.stringify(body)`
 * fails on legitimate requests. That failure is dangerous rather than merely annoying: the obvious
 * "fix" is to stop verifying.
 *
 * Optional because most routes never look at it, and because a request that arrived with no body at
 * all has none to keep.
 */
export interface RawBodyRequest extends Request {
  rawBody?: Buffer;
}
