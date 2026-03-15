import { Injectable } from '@nestjs/common';

import { ResourceNotFoundError } from '../common/errors/domain-error';
import { PrismaService } from '../prisma/prisma.service';
import { RegistrationResponseDto } from '../registrations/dto/registration-response.dto';
import { toRegistrationResponse } from '../registrations/registration.mapper';
import { AttendeeResponseDto } from './dto/attendee-response.dto';
import { CreateAttendeeDto } from './dto/create-attendee.dto';
import { toAttendeeResponse } from './attendee.mapper';

@Injectable()
export class AttendeesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * No pre-flight "does this email exist" query.
   *
   * That check would be a check-then-act: two people registering the same
   * address at once both find it free and both insert. The functional unique
   * index on lower(email) is the authority, its violation is already mapped to
   * a 409 naming the field, and letting it speak is both correct under
   * concurrency and one round trip cheaper.
   */
  async create(dto: CreateAttendeeDto): Promise<AttendeeResponseDto> {
    const attendee = await this.prisma.attendee.create({
      data: { email: dto.email, name: dto.name },
    });

    return toAttendeeResponse(attendee);
  }

  async findOne(id: string): Promise<AttendeeResponseDto> {
    return toAttendeeResponse(await this.requireAttendee(id));
  }

  async findRegistrations(id: string): Promise<RegistrationResponseDto[]> {
    // The existence check earns its round trip here: without it an unknown
    // attendee and an attendee who has registered for nothing both return an
    // empty list, and the caller cannot tell a typo from a fact.
    await this.requireAttendee(id);

    const registrations = await this.prisma.registration.findMany({
      where: { attendeeId: id },
      orderBy: [{ registeredAt: 'desc' }, { id: 'asc' }],
    });

    return registrations.map(toRegistrationResponse);
  }

  private async requireAttendee(id: string) {
    const attendee = await this.prisma.attendee.findUnique({ where: { id } });

    if (attendee === null) {
      throw new ResourceNotFoundError('attendee', id);
    }

    return attendee;
  }
}
