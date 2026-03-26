import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsDate, IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

import { PageQueryDto } from '../../common/dto/page-query.dto';
import { EVENT_LIMITS } from '../event-limits';
import { EVENT_STATUSES, type EventStatus } from '../event-status';

/** How long a search term may be. Long enough for a title, short enough not to be a payload. */
export const MAX_SEARCH_LENGTH = 200;

export class ListEventsQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: EVENT_STATUSES })
  @IsOptional()
  @IsIn(EVENT_STATUSES, {
    message: `status must be one of: ${EVENT_STATUSES.join(', ')}`,
  })
  status?: EventStatus;

  /** Matched as a case-insensitive substring, so "stockholm" finds "Norra Latin, Stockholm". */
  @ApiPropertyOptional({ description: 'Case-insensitive substring.', example: 'stockholm' })
  @IsOptional()
  @IsString()
  @MaxLength(EVENT_LIMITS.venue)
  venue?: string;

  /** Events starting at or after this instant. */
  @ApiPropertyOptional({ format: 'date-time', description: 'Events starting at or after this.' })
  @IsOptional()
  @Type(() => Date)
  @IsDate({ message: 'from must be an ISO-8601 date-time string' })
  from?: Date;

  /** Events starting at or before this instant. */
  @ApiPropertyOptional({ format: 'date-time', description: 'Events starting at or before this.' })
  @IsOptional()
  @Type(() => Date)
  @IsDate({ message: 'to must be an ISO-8601 date-time string' })
  to?: Date;

  /** Free text over title and description. */
  @ApiPropertyOptional({
    description: 'Free text over title and description, case-insensitive.',
    example: 'postgres',
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_SEARCH_LENGTH)
  q?: string;
}
