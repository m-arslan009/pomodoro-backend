import { Injectable } from '@nestjs/common';
import { Clock } from '../common/ports/clock.port';

/** The production Clock: the server's wall clock, which is the only time authority we trust. */
@Injectable()
export class SystemClock extends Clock {
  now(): Date {
    return new Date();
  }
}
