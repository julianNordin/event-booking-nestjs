import { PartialType } from '@nestjs/mapped-types';

import { CreateEventDto } from './create-event.dto';

/**
 * Every field of CreateEventDto, each optional — and therefore `status` is
 * absent here too, which is the important part. Status changes go through
 * publish and cancel so the state machine runs; a PATCH that could set it
 * would be a way around every rule the machine encodes.
 *
 * Derived with PartialType rather than written out, so a field added to
 * CreateEventDto cannot be silently unpatchable, and a validator tightened
 * there cannot stay loose here.
 */
export class UpdateEventDto extends PartialType(CreateEventDto) {}
