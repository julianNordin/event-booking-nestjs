import { validateSchedule } from './event-schedule';

const startsAt = new Date('2027-05-20T09:00:00.000Z');
const endsAt = new Date('2027-05-20T17:00:00.000Z');

const fieldsOf = (violations: { field: string }[]): string[] =>
  violations.map((violation) => violation.field);

describe('validateSchedule', () => {
  it('accepts a well-formed schedule', () => {
    expect(
      validateSchedule({
        startsAt,
        endsAt,
        registrationOpensAt: new Date('2027-04-01T00:00:00.000Z'),
        registrationClosesAt: new Date('2027-05-19T23:59:00.000Z'),
      }),
    ).toEqual([]);
  });

  it('accepts a schedule with no registration window at all', () => {
    expect(validateSchedule({ startsAt, endsAt })).toEqual([]);
  });

  describe('endsAt', () => {
    it('rejects an event that ends before it starts', () => {
      const violations = validateSchedule({ startsAt, endsAt: new Date('2027-05-20T08:00:00Z') });

      expect(fieldsOf(violations)).toEqual(['endsAt']);
    });

    it('rejects an event with no duration', () => {
      const violations = validateSchedule({ startsAt, endsAt: startsAt });

      expect(fieldsOf(violations)).toEqual(['endsAt']);
    });

    it('accepts an event one millisecond long', () => {
      expect(validateSchedule({ startsAt, endsAt: new Date(startsAt.getTime() + 1) })).toEqual([]);
    });
  });

  describe('registrationClosesAt', () => {
    it('rejects registration closing after the event starts', () => {
      // Otherwise people book seats at an event already underway.
      const violations = validateSchedule({
        startsAt,
        endsAt,
        registrationClosesAt: new Date('2027-05-20T10:00:00.000Z'),
      });

      expect(fieldsOf(violations)).toEqual(['registrationClosesAt']);
    });

    it('accepts registration closing exactly as the event starts', () => {
      expect(validateSchedule({ startsAt, endsAt, registrationClosesAt: startsAt })).toEqual([]);
    });
  });

  describe('registrationOpensAt', () => {
    it('rejects a window that opens after it closes', () => {
      const violations = validateSchedule({
        startsAt,
        endsAt,
        registrationOpensAt: new Date('2027-05-10T00:00:00.000Z'),
        registrationClosesAt: new Date('2027-05-01T00:00:00.000Z'),
      });

      expect(fieldsOf(violations)).toEqual(['registrationOpensAt']);
    });

    it('rejects a window that opens and closes at the same instant', () => {
      const instant = new Date('2027-05-01T00:00:00.000Z');
      const violations = validateSchedule({
        startsAt,
        endsAt,
        registrationOpensAt: instant,
        registrationClosesAt: instant,
      });

      expect(fieldsOf(violations)).toEqual(['registrationOpensAt']);
    });

    it('rejects opening after the event starts when there is no close time', () => {
      const violations = validateSchedule({
        startsAt,
        endsAt,
        registrationOpensAt: new Date('2027-06-01T00:00:00.000Z'),
      });

      expect(fieldsOf(violations)).toEqual(['registrationOpensAt']);
    });
  });

  it('reports every broken rule at once', () => {
    // One round trip per mistake is a bad way to fill in a form.
    const violations = validateSchedule({
      startsAt,
      endsAt: startsAt,
      registrationOpensAt: new Date('2027-05-19T00:00:00.000Z'),
      registrationClosesAt: new Date('2027-05-18T00:00:00.000Z'),
    });

    expect(fieldsOf(violations).sort()).toEqual(['endsAt', 'registrationOpensAt']);
  });

  it('treats null and undefined the same way', () => {
    expect(
      validateSchedule({
        startsAt,
        endsAt,
        registrationOpensAt: null,
        registrationClosesAt: null,
      }),
    ).toEqual(validateSchedule({ startsAt, endsAt }));
  });
});
