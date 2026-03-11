import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsDate,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

import { EVENT_LIMITS, MAX_CAPACITY } from '../event-limits';

/**
 * The body of POST /events.
 *
 * Note what is absent: `status`. Every event begins as a draft, and the only
 * ways out of that are the publish and cancel endpoints, which run the state
 * machine. Accepting a status here would let a caller reach PUBLISHED without
 * passing through it — and with forbidNonWhitelisted on, sending one is a 400
 * rather than a value that is quietly dropped.
 *
 * Dates arrive as ISO-8601 strings and are converted once, here, so the service
 * and the mapper both work in Date and nothing downstream parses strings.
 */
export class CreateEventDto {
  @IsString()
  @MinLength(1)
  @MaxLength(EVENT_LIMITS.title)
  title!: string;

  @IsOptional()
  @IsString()
  @MaxLength(EVENT_LIMITS.description)
  description?: string | null;

  @IsString()
  @MinLength(1)
  @MaxLength(EVENT_LIMITS.venue)
  venue!: string;

  @Type(() => Date)
  @IsDate({ message: 'startsAt must be an ISO-8601 date-time string' })
  startsAt!: Date;

  @Type(() => Date)
  @IsDate({ message: 'endsAt must be an ISO-8601 date-time string' })
  endsAt!: Date;

  @IsInt()
  @Min(1)
  @Max(MAX_CAPACITY)
  capacity!: number;

  @IsOptional()
  @IsBoolean()
  waitlistEnabled?: boolean;

  @IsOptional()
  @Type(() => Date)
  @IsDate({ message: 'registrationOpensAt must be an ISO-8601 date-time string' })
  registrationOpensAt?: Date | null;

  @IsOptional()
  @Type(() => Date)
  @IsDate({ message: 'registrationClosesAt must be an ISO-8601 date-time string' })
  registrationClosesAt?: Date | null;
}
