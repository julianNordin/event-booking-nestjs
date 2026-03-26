import { ApiProperty } from '@nestjs/swagger';

import { EVENT_STATUSES, type EventStatus } from '../event-status';

/**
 * What a client actually receives. Declared separately from the Prisma model
 * on purpose: a column added to the table should not silently appear in the
 * public response, and a field renamed on the wire should not force a
 * migration.
 *
 * Every field carries an explicit `@ApiProperty`. The Swagger CLI plugin would
 * infer most of them, but it only runs under `nest build` — not under ts-jest —
 * so a spec test would inspect empty schemas while production served complete
 * ones. Explicit decorators make both compilers agree, and they carry the
 * formats, enums and examples the plugin cannot infer from a type alone.
 */
export class EventResponseDto {
  @ApiProperty({ format: 'uuid', example: '0195e3a0-0000-7000-8000-000000000001' })
  id!: string;

  @ApiProperty({ maxLength: 200, example: 'Distributed Systems in Practice' })
  title!: string;

  @ApiProperty({ nullable: true, type: String, maxLength: 2000 })
  description!: string | null;

  @ApiProperty({ maxLength: 200, example: 'Norra Latin, Stockholm' })
  venue!: string;

  @ApiProperty({ format: 'date-time', example: '2027-03-29T09:00:00.000Z' })
  startsAt!: string;

  @ApiProperty({ format: 'date-time', example: '2027-03-29T17:00:00.000Z' })
  endsAt!: string;

  @ApiProperty({ minimum: 1, example: 40 })
  capacity!: number;

  @ApiProperty({ example: true })
  waitlistEnabled!: boolean;

  @ApiProperty({ format: 'date-time', nullable: true, type: String })
  registrationOpensAt!: string | null;

  @ApiProperty({ format: 'date-time', nullable: true, type: String })
  registrationClosesAt!: string | null;

  @ApiProperty({ enum: EVENT_STATUSES, example: 'PUBLISHED' })
  status!: EventStatus;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: string;

  @ApiProperty({ description: 'How many people currently hold a seat.', example: 38 })
  confirmedCount!: number;

  @ApiProperty({ description: 'How many are waiting for one.', example: 4 })
  waitlistCount!: number;

  @ApiProperty({
    description: 'Seats still to be had. Never negative: an overbooked event has none.',
    example: 2,
  })
  availableSeats!: number;
}
