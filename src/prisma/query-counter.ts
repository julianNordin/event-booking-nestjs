import type { PrismaClient } from '../generated/prisma/client';

/**
 * Counts the queries a block of code actually issues.
 *
 * Built on `$extends`, which is Prisma 7's replacement for the middleware API:
 * `$allOperations` wraps every model call, so nothing has to be instrumented at
 * the call site and no query can quietly avoid being counted.
 *
 * This exists because "is there an N+1 here" is a question with a number for an
 * answer, and reading the service to guess at it is how N+1s survive review.
 * The performance tests assert on that number.
 */
export interface QueryRecord {
  model: string;
  operation: string;
}

export class QueryCounter {
  private records: QueryRecord[] = [];

  record(model: string | undefined, operation: string): void {
    this.records.push({ model: model ?? 'raw', operation });
  }

  reset(): void {
    this.records = [];
  }

  get total(): number {
    return this.records.length;
  }

  get calls(): readonly QueryRecord[] {
    return this.records;
  }

  /** How many calls hit one model with one operation — e.g. registration.count. */
  countOf(model: string, operation: string): number {
    return this.records.filter((record) => record.model === model && record.operation === operation)
      .length;
  }

  /** A compact summary, for putting in a failure message rather than a log. */
  summary(): string {
    const grouped = new Map<string, number>();

    for (const record of this.records) {
      const key = `${record.model}.${record.operation}`;
      grouped.set(key, (grouped.get(key) ?? 0) + 1);
    }

    return [...grouped]
      .sort()
      .map(([key, count]) => `${key} x${String(count)}`)
      .join(', ');
  }
}

/**
 * Wraps a client so every model operation is counted.
 *
 * The returned client is a Prisma extension, structurally compatible with the
 * one it wraps for every call this application makes — which is what lets a
 * test hand it to a service in place of PrismaService and change nothing else.
 */
export function withQueryCounter(client: PrismaClient): {
  client: PrismaClient;
  counter: QueryCounter;
} {
  const counter = new QueryCounter();

  const extended = client.$extends({
    query: {
      $allOperations({ model, operation, args, query }) {
        counter.record(model, operation);
        return query(args);
      },
    },
  });

  return { client: extended as unknown as PrismaClient, counter };
}
