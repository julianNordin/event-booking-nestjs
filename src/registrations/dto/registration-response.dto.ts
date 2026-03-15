import { RegistrationStatus } from '../registration-status';

export class RegistrationResponseDto {
  id!: string;
  eventId!: string;
  attendeeId!: string;
  status!: RegistrationStatus;

  /** 1 is next in line. Null unless the registration is WAITLISTED. */
  waitlistPosition!: number | null;

  registeredAt!: string;
  cancelledAt!: string | null;
}
