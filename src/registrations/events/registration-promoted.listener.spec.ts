import { Logger } from '@nestjs/common';
import { EventEmitter2, EventEmitterModule } from '@nestjs/event-emitter';
import { Test } from '@nestjs/testing';

import { REGISTRATION_PROMOTED, RegistrationPromotedEvent } from './registration-promoted.event';
import { RegistrationPromotedListener } from './registration-promoted.listener';

const promotion = new RegistrationPromotedEvent(
  '0195e3a0-0000-7000-8000-0000000000c1',
  '0195e3a0-0000-7000-8000-0000000000e1',
  '0195e3a0-0000-7000-8000-0000000000a1',
  new Date('2027-06-01T12:00:00.000Z'),
);

describe('the registration.promoted seam', () => {
  let emitter: EventEmitter2;
  let logged: jest.SpyInstance;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [EventEmitterModule.forRoot()],
      providers: [RegistrationPromotedListener],
    }).compile();

    await moduleRef.init();
    emitter = moduleRef.get(EventEmitter2);
    logged = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    logged.mockRestore();
  });

  it('reaches the listener when the event is emitted', async () => {
    // The whole point of the seam: nothing in the registration service knows
    // this listener exists, and adding a mailer means adding a listener rather
    // than another branch in the write path.
    emitter.emit(REGISTRATION_PROMOTED, promotion);
    await Promise.resolve();

    expect(logged).toHaveBeenCalled();
  });

  it('reports who was promoted, to what, and when', () => {
    emitter.emit(REGISTRATION_PROMOTED, promotion);

    const calls = logged.mock.calls as [unknown][];
    const message = String(calls[0]?.[0]);
    expect(message).toContain(promotion.attendeeId);
    expect(message).toContain(promotion.eventId);
    expect(message).toContain(promotion.registrationId);
    expect(message).toContain('2027-06-01T12:00:00.000Z');
  });

  it('is not reached by an unrelated event', () => {
    emitter.emit('registration.cancelled', promotion);

    expect(logged).not.toHaveBeenCalled();
  });

  it('uses a name that cannot be confused with the domain Event', () => {
    // This project has two things called an event. Keeping the emitter's
    // vocabulary explicit is what stops that collision spreading.
    expect(REGISTRATION_PROMOTED).toBe('registration.promoted');
  });
});
