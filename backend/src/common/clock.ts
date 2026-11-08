/**
 * The current instant, injectable so a test can stand at 23:59:59 or 00:00:00 Vietnam time
 * without waiting for it. Production uses `SystemClock`. Business rules that depend on "now"
 * read it from here instead of calling `new Date()`.
 */
export abstract class Clock {
  abstract now(): Date;
}

export class SystemClock extends Clock {
  now(): Date {
    return new Date();
  }
}
