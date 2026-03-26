import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';

import { ATTENDEE_LIMITS } from '../attendee-limits';

/**
 * Normalises the address at the boundary: trimmed and lower-cased, once, here.
 *
 * Doing it at the edge means everything downstream — the uniqueness check, the
 * lookup, the stored row — sees one canonical form, and nobody has to remember
 * to fold case at each call site.
 *
 * It is deliberately *not* the only defence. A functional unique index on
 * lower(email) enforces the same rule in the database, because this transform
 * only runs for requests that arrive through the validation pipe: a seed
 * script, a migration or a future internal caller goes straight past it.
 */
const normaliseEmail = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

export class CreateAttendeeDto {
  @ApiProperty({
    format: 'email',
    maxLength: ATTENDEE_LIMITS.email,
    description: 'Trimmed and lower-cased before it is stored.',
    example: 'ada@example.com',
  })
  @Transform(normaliseEmail)
  @IsEmail({}, { message: 'email must be a valid email address' })
  @MaxLength(ATTENDEE_LIMITS.email)
  email!: string;

  @ApiProperty({ maxLength: ATTENDEE_LIMITS.name, example: 'Ada Lindqvist' })
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1)
  @MaxLength(ATTENDEE_LIMITS.name)
  name!: string;
}
