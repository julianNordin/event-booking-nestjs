/**
 * One page of results, with enough metadata for a client to navigate without
 * guessing.
 *
 * Written here rather than pulled from a library: the shape is part of this
 * API's public contract, and a dependency that changes its serialisation in a
 * minor release would change the contract with it.
 */
export class PagedResponse<T> {
  items!: T[];

  /** 1-based, because that is what appears in a URL a person reads. */
  page!: number;

  /** How many were asked for, after clamping — not how many came back. */
  size!: number;

  totalItems!: number;
  totalPages!: number;
  hasNext!: boolean;
  hasPrevious!: boolean;

  static of<T>(items: T[], page: number, size: number, totalItems: number): PagedResponse<T> {
    // ceil of a division, with the empty case pinned to zero rather than one.
    // "Page 1 of 1, containing nothing" is a lie a surprising number of APIs
    // tell.
    const totalPages = totalItems === 0 ? 0 : Math.ceil(totalItems / size);

    return {
      items,
      page,
      size,
      totalItems,
      totalPages,
      hasNext: page < totalPages,
      hasPrevious: page > 1 && totalPages > 0,
    };
  }
}
