import { ValidationFailedError } from '../errors/domain-error';
import { MAX_PAGE_SIZE } from './page-query.dto';

export type SortDirection = 'asc' | 'desc';

export interface SortOrder {
  field: string;
  direction: SortDirection;
}

/**
 * The tiebreak appended to every sort.
 *
 * Without it, two rows with equal sort keys may be returned in either order,
 * and PostgreSQL is entitled to choose differently between two identical
 * queries. Under paging that is not a cosmetic problem: a row can appear on
 * page one and again on page two, while another appears on neither.
 */
const TIEBREAK: SortOrder = { field: 'id', direction: 'asc' };

/**
 * Parses `field` or `field,direction` against a whitelist.
 *
 * The whitelist is not decoration. A sort field goes straight into an ORDER BY,
 * so accepting an arbitrary one lets a caller sort by any column in the table —
 * including ones the response never exposes, which turns a listing endpoint
 * into an oracle for reading hidden values a page at a time.
 *
 * Called from the service rather than a pipe, so that a second caller arriving
 * from anywhere else is covered by the same rule.
 */
export function parseSort(
  spec: string | undefined,
  allowed: readonly string[],
  fallback: readonly SortOrder[],
): SortOrder[] {
  if (spec === undefined || spec.trim() === '') {
    return withTiebreak(fallback);
  }

  const [rawField, rawDirection = 'asc', ...rest] = spec.split(',').map((part) => part.trim());

  if (rest.length > 0) {
    throw sortError(`sort takes at most "field,direction"`, allowed);
  }

  if (rawField === undefined || !allowed.includes(rawField)) {
    throw sortError(`sort must be one of: ${allowed.join(', ')}`, allowed);
  }

  if (rawDirection !== 'asc' && rawDirection !== 'desc') {
    throw sortError('sort direction must be asc or desc', allowed);
  }

  return withTiebreak([{ field: rawField, direction: rawDirection }]);
}

/** Applies the page-size ceiling. Never rejects; a client asking big gets big-but-bounded. */
export function clampPageSize(size: number): number {
  return Math.min(Math.max(Math.trunc(size), 1), MAX_PAGE_SIZE);
}

export function toSkip(page: number, size: number): number {
  return (page - 1) * size;
}

function withTiebreak(orders: readonly SortOrder[]): SortOrder[] {
  return orders.some((order) => order.field === TIEBREAK.field)
    ? [...orders]
    : [...orders, TIEBREAK];
}

function sortError(message: string, allowed: readonly string[]): ValidationFailedError {
  return new ValidationFailedError([
    { field: 'sort', message: `${message}. Allowed fields: ${allowed.join(', ')}` },
  ]);
}
