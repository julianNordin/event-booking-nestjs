import { ValidationFailedError } from '../errors/domain-error';
import { MAX_PAGE_SIZE } from './page-query.dto';
import { PagedResponse } from './paged-response';
import { clampPageSize, parseSort, SortOrder, toSkip } from './sort';

const ALLOWED = ['startsAt', 'title', 'capacity'] as const;
const FALLBACK: SortOrder[] = [{ field: 'startsAt', direction: 'asc' }];

describe('parseSort', () => {
  it('falls back when no sort is given', () => {
    expect(parseSort(undefined, ALLOWED, FALLBACK)).toEqual([
      { field: 'startsAt', direction: 'asc' },
      { field: 'id', direction: 'asc' },
    ]);
  });

  it('treats an empty or whitespace sort as absent', () => {
    expect(parseSort('', ALLOWED, FALLBACK)).toEqual(parseSort(undefined, ALLOWED, FALLBACK));
    expect(parseSort('   ', ALLOWED, FALLBACK)).toEqual(parseSort(undefined, ALLOWED, FALLBACK));
  });

  it('defaults the direction to ascending', () => {
    expect(parseSort('title', ALLOWED, FALLBACK)[0]).toEqual({
      field: 'title',
      direction: 'asc',
    });
  });

  it.each(['asc', 'desc'] as const)('accepts an explicit %s direction', (direction) => {
    expect(parseSort(`title,${direction}`, ALLOWED, FALLBACK)[0]).toEqual({
      field: 'title',
      direction,
    });
  });

  it('tolerates spaces around the parts', () => {
    expect(parseSort(' title , desc ', ALLOWED, FALLBACK)[0]).toEqual({
      field: 'title',
      direction: 'desc',
    });
  });

  describe('the tiebreak', () => {
    it('is appended to every sort', () => {
      // Without it PostgreSQL may order equal rows differently between two
      // identical queries, and under paging a row then appears on two pages
      // while another appears on none.
      const orders = parseSort('title,desc', ALLOWED, FALLBACK);

      expect(orders[orders.length - 1]).toEqual({ field: 'id', direction: 'asc' });
    });

    it('is not duplicated when the caller already sorts by id', () => {
      const orders = parseSort('id', ['id'], FALLBACK);

      expect(orders).toEqual([{ field: 'id', direction: 'asc' }]);
    });
  });

  describe('the whitelist', () => {
    it('rejects a field that is not on it', () => {
      // An unchecked sort field goes straight into an ORDER BY, which lets a
      // caller sort by columns the response never exposes and read them back a
      // page at a time.
      expect(() => parseSort('secretColumn', ALLOWED, FALLBACK)).toThrow(ValidationFailedError);
    });

    it('names the allowed fields in the rejection', () => {
      try {
        parseSort('secretColumn', ALLOWED, FALLBACK);
        throw new Error('expected parseSort to throw');
      } catch (error) {
        const failure = error as ValidationFailedError;
        expect(failure.errors[0]?.field).toBe('sort');
        expect(failure.errors[0]?.message).toMatch(/startsAt, title, capacity/);
      }
    });

    it('is case-sensitive, because column names are', () => {
      expect(() => parseSort('STARTSAT', ALLOWED, FALLBACK)).toThrow(ValidationFailedError);
    });

    it('rejects an unknown direction', () => {
      expect(() => parseSort('title,sideways', ALLOWED, FALLBACK)).toThrow(ValidationFailedError);
    });

    it('rejects more than two parts', () => {
      expect(() => parseSort('title,asc,extra', ALLOWED, FALLBACK)).toThrow(ValidationFailedError);
    });
  });
});

describe('clampPageSize', () => {
  it('leaves a reasonable size alone', () => {
    expect(clampPageSize(20)).toBe(20);
  });

  it('caps an enormous request rather than refusing it', () => {
    // ?size=100000 is one request that reads the table, serialises it and holds
    // it in memory. Clamping costs the caller nothing they were entitled to.
    expect(clampPageSize(100_000)).toBe(MAX_PAGE_SIZE);
  });

  it('accepts exactly the maximum', () => {
    expect(clampPageSize(MAX_PAGE_SIZE)).toBe(MAX_PAGE_SIZE);
  });

  it.each([0, -1, -100])('floors %p at one', (size) => {
    expect(clampPageSize(size)).toBe(1);
  });
});

describe('toSkip', () => {
  it.each([
    [1, 20, 0],
    [2, 20, 20],
    [5, 10, 40],
  ])('page %i of size %i skips %i', (page, size, expected) => {
    expect(toSkip(page, size)).toBe(expected);
  });
});

describe('PagedResponse.of', () => {
  it('computes the page count by rounding up', () => {
    expect(PagedResponse.of([], 1, 20, 41).totalPages).toBe(3);
  });

  it('reports zero pages for an empty result, not one', () => {
    // "Page 1 of 1, containing nothing" is a lie, and clients that trust it
    // render an empty page instead of an empty state.
    const page = PagedResponse.of([], 1, 20, 0);

    expect(page.totalPages).toBe(0);
    expect(page.hasNext).toBe(false);
    expect(page.hasPrevious).toBe(false);
  });

  it('knows when there is a next page', () => {
    expect(PagedResponse.of([], 1, 20, 41).hasNext).toBe(true);
    expect(PagedResponse.of([], 3, 20, 41).hasNext).toBe(false);
  });

  it('knows when there is a previous page', () => {
    expect(PagedResponse.of([], 1, 20, 41).hasPrevious).toBe(false);
    expect(PagedResponse.of([], 2, 20, 41).hasPrevious).toBe(true);
  });

  it('reports the size that was asked for, not the number returned', () => {
    // The last page is short. Reporting its length as the size would tell a
    // client the page size changed underneath them.
    const page = PagedResponse.of([1], 3, 20, 41);

    expect(page.size).toBe(20);
    expect(page.items).toHaveLength(1);
  });
});
