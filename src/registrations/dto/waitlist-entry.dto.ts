import { ApiProperty } from '@nestjs/swagger';

export class WaitlistEntryDto {
  /**
   * Where this person stands right now: 1 is next in line.
   *
   * Derived on read, not stored. It changes as people ahead leave, and
   * computing it here is the one place that is both cheap and impossible to
   * get stale.
   */
  @ApiProperty({ minimum: 1, example: 1 })
  place!: number;

  /**
   * The ticket issued when they joined the queue.
   *
   * Stored, and never rewritten. Renumbering the queue on every departure would
   * turn one cancellation into an update of every row behind it. Gaps are
   * expected: a ticket of 7 at place 2 simply means five people ahead have
   * since left.
   */
  @ApiProperty({ minimum: 1, example: 7 })
  waitlistPosition!: number;

  @ApiProperty({ format: 'uuid' })
  registrationId!: string;

  @ApiProperty({ format: 'uuid' })
  attendeeId!: string;

  @ApiProperty({ format: 'date-time' })
  registeredAt!: string;
}
