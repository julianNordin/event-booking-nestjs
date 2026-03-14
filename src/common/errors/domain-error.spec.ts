import {
  AlreadyExistsError,
  DomainError,
  ResourceInUseError,
  ResourceNotFoundError,
  RuleViolationError,
  TransitionNotAllowedError,
  ValidationFailedError,
} from './domain-error';

const everyError: DomainError[] = [
  new ResourceNotFoundError('event', '0195e3a0-0000-7000-8000-000000000001'),
  new ValidationFailedError([{ field: 'capacity', message: 'must not be less than 1' }]),
  new TransitionNotAllowedError('this event is already published', 'PUBLISHED', 'publish'),
  new AlreadyExistsError('that email is already registered', 'email'),
  new ResourceInUseError('this attendee still holds registrations', 'registrations'),
  new RuleViolationError('capacity cannot be reduced below 12', 'capacity-covers-confirmed'),
];

describe('the domain error hierarchy', () => {
  describe.each(everyError.map((error) => [error.name, error] as const))('%s', (_name, error) => {
    it('is an Error, so a stack trace survives', () => {
      expect(error).toBeInstanceOf(Error);
      expect(error.stack).toBeDefined();
    });

    it('declares a URN problem type, never an https URL', () => {
      // An https type is a promise that something is served there. Inventing
      // one that 404s is worse than useless; a URN identifies the type without
      // claiming to be dereferenceable.
      expect(error.problemType).toMatch(/^urn:problem-type:event-booking:[a-z-]+$/);
      expect(error.problemType).not.toMatch(/^https?:/);
    });

    it('declares a title that does not merely restate the status code', () => {
      expect(error.title.length).toBeGreaterThan(5);
      expect(error.title).not.toMatch(/^(Conflict|Bad Request|Not Found)$/);
    });

    it('declares a status in the 4xx range', () => {
      expect(error.status).toBeGreaterThanOrEqual(400);
      expect(error.status).toBeLessThan(500);
    });

    it('carries a message a caller can act on', () => {
      expect(error.message.length).toBeGreaterThan(10);
    });
  });

  it('gives every type a distinct problem type URN', () => {
    const types = everyError.map((error) => error.problemType);

    expect(new Set(types).size).toBe(types.length);
  });

  describe('ResourceNotFoundError', () => {
    it('names the resource and the id as extensions', () => {
      const error = new ResourceNotFoundError('event', 'abc');

      expect(error.extensions()).toEqual({ resource: 'event', resourceId: 'abc' });
      expect(error.status).toBe(404);
    });
  });

  describe('ValidationFailedError', () => {
    it('exposes the per-field list a client can act on', () => {
      const error = new ValidationFailedError([
        { field: 'capacity', message: 'must not be less than 1' },
        { field: 'title', message: 'should not be empty' },
      ]);

      expect(error.extensions()).toEqual({
        errors: [
          { field: 'capacity', message: 'must not be less than 1' },
          { field: 'title', message: 'should not be empty' },
        ],
      });
    });

    it('names the single offending field in the summary', () => {
      const error = new ValidationFailedError([{ field: 'capacity', message: 'must be positive' }]);

      expect(error.message).toBe('capacity: must be positive');
    });

    it('counts them when there are several', () => {
      const error = new ValidationFailedError([
        { field: 'a', message: 'x' },
        { field: 'b', message: 'y' },
      ]);

      expect(error.message).toBe('2 fields failed validation');
    });
  });

  describe('TransitionNotAllowedError', () => {
    it('reports the state it was in and the action that was refused', () => {
      const error = new TransitionNotAllowedError('already published', 'PUBLISHED', 'publish');

      expect(error.extensions()).toEqual({
        currentStatus: 'PUBLISHED',
        requestedAction: 'publish',
      });
      expect(error.status).toBe(409);
    });
  });

  describe('RuleViolationError', () => {
    it('names the rule and merges any details', () => {
      const error = new RuleViolationError('too small', 'capacity-covers-confirmed', {
        confirmed: 12,
        requested: 5,
      });

      expect(error.extensions()).toEqual({
        rule: 'capacity-covers-confirmed',
        confirmed: 12,
        requested: 5,
      });
    });
  });
});
