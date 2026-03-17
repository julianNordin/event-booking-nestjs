import { Injectable } from '@nestjs/common';

/**
 * "Now", as a provider.
 *
 * Every registration rule is a comparison against the current time — has
 * registration opened, has it closed, has the event already started — and each
 * one is untestable if the code reaches for `new Date()` itself. The choices
 * are then a test that manipulates real dates relative to the actual clock and
 * goes red at midnight or in another time zone, or one that mocks a global.
 * Injecting the clock makes the interesting cases ordinary arguments.
 *
 * An abstract class rather than an interface, because Nest resolves providers
 * by runtime token and an interface does not survive compilation.
 */
@Injectable()
export abstract class Clock {
  abstract now(): Date;
}

@Injectable()
export class SystemClock extends Clock {
  now(): Date {
    return new Date();
  }
}
