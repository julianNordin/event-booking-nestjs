import type { Registration } from '../generated/prisma/client';
import { RegistrationResponseDto } from './dto/registration-response.dto';

export function toRegistrationResponse(registration: Registration): RegistrationResponseDto {
  return {
    id: registration.id,
    eventId: registration.eventId,
    attendeeId: registration.attendeeId,
    status: registration.status,
    waitlistPosition: registration.waitlistPosition,
    registeredAt: registration.registeredAt.toISOString(),
    cancelledAt: registration.cancelledAt?.toISOString() ?? null,
  };
}
