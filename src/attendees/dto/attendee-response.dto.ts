import { ApiProperty } from '@nestjs/swagger';

export class AttendeeResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({
    format: 'email',
    maxLength: 320,
    description: 'Always lower-cased: addresses are normalised at the boundary.',
    example: 'ada@example.com',
  })
  email!: string;

  @ApiProperty({ maxLength: 200, example: 'Ada Lindqvist' })
  name!: string;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: string;
}
