import { Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post } from '@nestjs/common';

import { RegistrationResponseDto } from './dto/registration-response.dto';
import { RegistrationsService } from './registrations.service';

/**
 * A registration as a resource in its own right.
 *
 * It exists here as well as under its event because that is where its own
 * identity lives: the Location header of a successful registration points at
 * this route, and a client holding a registration id should not have to
 * remember which event it belonged to in order to cancel it.
 */
@Controller('registrations')
export class RegistrationsController {
  constructor(private readonly registrations: RegistrationsService) {}

  @Get(':id')
  findOne(
    @Param('id', new ParseUUIDPipe({ version: '7' })) id: string,
  ): Promise<RegistrationResponseDto> {
    return this.registrations.findOne(id);
  }

  /**
   * A POST to a named sub-resource, not a DELETE.
   *
   * The row survives: it is the record that this person held a place, and the
   * partial unique index ignores cancelled rows so they may register again.
   * DELETE would promise removal and not deliver it.
   */
  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  cancel(
    @Param('id', new ParseUUIDPipe({ version: '7' })) id: string,
  ): Promise<RegistrationResponseDto> {
    return this.registrations.cancel(id);
  }
}
