import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

export class CreateRegistrationDto {
  /**
   * Who is registering.
   *
   * The attendee is identified rather than described: creating a person as a
   * side effect of registering them would make a typo in an email address into
   * a second account rather than a rejected request.
   */
  @ApiProperty({
    format: 'uuid',
    description: 'An existing attendee. This endpoint identifies people, it does not create them.',
  })
  @IsUUID('7', { message: 'attendeeId must be a version 7 uuid' })
  attendeeId!: string;
}
