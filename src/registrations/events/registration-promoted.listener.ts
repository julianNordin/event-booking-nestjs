import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';

import { REGISTRATION_PROMOTED, RegistrationPromotedEvent } from './registration-promoted.event';

@Injectable()
export class RegistrationPromotedListener {
  private readonly logger = new Logger('RegistrationPromoted');

  /**
   * Logs, and nothing more.
   *
   * Deliberately the whole implementation: this project is not building a
   * mailer, and a fake one would be more code and less honest. What matters is
   * that the seam exists and that notifying someone is a listener rather than
   * another branch inside the registration service — so it cannot hold the
   * event's row lock open while it talks to something slow, and it cannot fail
   * the promotion by failing itself.
   */
  @OnEvent(REGISTRATION_PROMOTED)
  handlePromotion(event: RegistrationPromotedEvent): void {
    this.logger.log(
      `attendee ${event.attendeeId} promoted to a confirmed seat at event ${event.eventId} ` +
        `(registration ${event.registrationId}) at ${event.promotedAt.toISOString()}`,
    );
  }
}
