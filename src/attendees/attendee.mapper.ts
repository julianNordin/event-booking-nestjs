import type { Attendee } from '../generated/prisma/client';
import { AttendeeResponseDto } from './dto/attendee-response.dto';

export function toAttendeeResponse(attendee: Attendee): AttendeeResponseDto {
  return {
    id: attendee.id,
    email: attendee.email,
    name: attendee.name,
    createdAt: attendee.createdAt.toISOString(),
    updatedAt: attendee.updatedAt.toISOString(),
  };
}
