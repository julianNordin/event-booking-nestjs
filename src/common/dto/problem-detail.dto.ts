/**
 * An RFC 9457 problem detail.
 *
 * The five standard members, plus whatever extensions the specific problem
 * carries. Extensions sit at the top level of the object, not inside a nested
 * bag — that is what the RFC specifies, and it is why the index signature is
 * here.
 */
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ProblemDetailDto {
  /** A URI identifying the problem type. Always a URN in this API. */
  @ApiProperty({
    description: 'A URN identifying the problem type. Never a dereferenceable URL.',
    example: 'urn:problem-type:event-booking:transition-not-allowed',
  })
  type!: string;

  /** Short, human-readable, and constant for the type. */
  @ApiProperty({ example: 'The requested state change is not allowed' })
  title!: string;

  @ApiProperty({ example: 409 })
  status!: number;

  /** Specific to this occurrence. Safe to show a user; never a driver message. */
  @ApiProperty({ example: 'this event is already published' })
  detail!: string;

  /** The request that produced it. */
  @ApiPropertyOptional({ example: '/api/v1/events/0195e3a0-0000-7000-8000-000000000001/publish' })
  instance?: string;

  [extension: string]: unknown;
}
