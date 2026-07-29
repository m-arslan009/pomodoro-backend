/*
 * The second allowed port (ADR-005). Time authority is a domain concern here — sign-in
 * timestamps, and later streak attribution — so tests must be able to control "now" without
 * sleeping or accepting wall-clock flake.
 */
export abstract class Clock {
  abstract now(): Date;
}
