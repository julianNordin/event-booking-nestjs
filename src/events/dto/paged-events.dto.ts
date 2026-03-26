import { ApiProperty } from '@nestjs/swagger';

import { PagedResponse } from '../../common/dto/paged-response';
import { EventResponseDto } from './event-response.dto';

/**
 * A concrete page of events, purely so OpenAPI can describe it.
 *
 * `PagedResponse<T>` is generic, and generics do not survive to runtime — the
 * generator has no way to learn what `T` was. Declaring the one instantiation
 * this API actually returns is the smallest honest fix: no decorator gymnastics,
 * and the document says exactly what comes back.
 */
export class PagedEventsDto implements PagedResponse<EventResponseDto> {
  @ApiProperty({ type: [EventResponseDto] })
  items!: EventResponseDto[];

  @ApiProperty({ minimum: 1, example: 1, description: '1-based.' })
  page!: number;

  @ApiProperty({ example: 20, description: 'What was asked for, not how many came back.' })
  size!: number;

  @ApiProperty({ example: 41 })
  totalItems!: number;

  @ApiProperty({ example: 3, description: 'Zero when there are no results, never one.' })
  totalPages!: number;

  @ApiProperty()
  hasNext!: boolean;

  @ApiProperty()
  hasPrevious!: boolean;
}
