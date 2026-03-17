import { Global, Module } from '@nestjs/common';

import { Clock, SystemClock } from './clock.service';

/**
 * Global, because time is not a feature-level concern and every module that
 * needs it should get the same one — including in a test, where overriding this
 * single provider freezes the clock for the whole application at once.
 */
@Global()
@Module({
  providers: [{ provide: Clock, useClass: SystemClock }],
  exports: [Clock],
})
export class ClockModule {}
