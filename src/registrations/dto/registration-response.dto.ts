import { ApiProperty } from '@nestjs/swagger';

import { REGISTRATION_STATUSES, type RegistrationStatus } from '../registration-status';

export class RegistrationResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;
  @ApiProperty({ format: 'uuid' })
  eventId!: string;
  @ApiProperty({ format: 'uuid' })
  attendeeId!: string;

  @ApiProperty({ enum: REGISTRATION_STATUSES, example: 'CONFIRMED' })
  status!: RegistrationStatus;

  /** 1 is next in line. Null unless the registration is WAITLISTED. */
  @ApiProperty({
    nullable: true,
    type: Number,
    minimum: 1,
    description: 'The ticket issued on joining the queue. Null unless WAITLISTED.',
  })
  waitlistPosition!: number | null;

  @ApiProperty({ format: 'date-time' })
  registeredAt!: string;

  @ApiProperty({ format: 'date-time', nullable: true, type: String })
  cancelledAt!: string | null;
}
