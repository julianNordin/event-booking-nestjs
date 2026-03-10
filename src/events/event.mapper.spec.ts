import type { Event } from '../generated/prisma/client';
import { toEventResponse } from './event.mapper';

const row: Event = {
  id: '0195e3a0-0000-7000-8000-000000000001',
  title: 'Distributed Systems in Practice',
  description: 'Consensus and partial failure.',
  venue: 'Norra Latin, Stockholm',
  startsAt: new Date('2027-03-29T09:00:00.000Z'),
  endsAt: new Date('2027-03-29T17:00:00.000Z'),
  capacity: 40,
  waitlistEnabled: true,
  registrationOpensAt: new Date('2027-02-01T00:00:00.000Z'),
  registrationClosesAt: new Date('2027-03-28T23:59:59.000Z'),
  status: 'PUBLISHED',
  createdAt: new Date('2027-01-15T10:00:00.000Z'),
  updatedAt: new Date('2027-01-16T11:30:00.000Z'),
};

describe('toEventResponse', () => {
  it('renders every timestamp as an ISO-8601 string', () => {
    const dto = toEventResponse(row);

    expect(dto.startsAt).toBe('2027-03-29T09:00:00.000Z');
    expect(dto.endsAt).toBe('2027-03-29T17:00:00.000Z');
    expect(dto.registrationOpensAt).toBe('2027-02-01T00:00:00.000Z');
    expect(dto.registrationClosesAt).toBe('2027-03-28T23:59:59.000Z');
    expect(dto.createdAt).toBe('2027-01-15T10:00:00.000Z');
    expect(dto.updatedAt).toBe('2027-01-16T11:30:00.000Z');
  });

  it('keeps optional timestamps as null rather than undefined', () => {
    // undefined disappears from JSON entirely, so a client cannot tell an
    // absent field from a field the server forgot. null is a stated answer.
    const dto = toEventResponse({
      ...row,
      registrationOpensAt: null,
      registrationClosesAt: null,
    });

    expect(dto.registrationOpensAt).toBeNull();
    expect(dto.registrationClosesAt).toBeNull();
  });

  it('copies the scalar fields through unchanged', () => {
    const dto = toEventResponse(row);

    expect(dto).toMatchObject({
      id: row.id,
      title: row.title,
      description: row.description,
      venue: row.venue,
      capacity: 40,
      waitlistEnabled: true,
      status: 'PUBLISHED',
    });
  });

  it('exposes exactly the declared fields and nothing else', () => {
    // The assertion that stops a migration widening the public API. A column
    // added to the table cannot reach a client until it is added here too, and
    // this test is what makes that a deliberate act rather than an accident.
    const dto = toEventResponse({
      ...row,
      // A column that exists in the database but has no business being public.
      internalNote: 'do not ship this',
    } as Event & { internalNote: string });

    expect(Object.keys(dto).sort()).toEqual([
      'capacity',
      'createdAt',
      'description',
      'endsAt',
      'id',
      'registrationClosesAt',
      'registrationOpensAt',
      'startsAt',
      'status',
      'title',
      'updatedAt',
      'venue',
      'waitlistEnabled',
    ]);
  });
});
