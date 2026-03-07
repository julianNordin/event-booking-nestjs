/**
 * Pulls the interesting parts out of a Prisma failure.
 *
 * Prisma 7 with a driver adapter nests the real database error two levels down,
 * under `meta.driverAdapterError.cause`. The constraint that actually fired is
 * only reachable there — the top-level code says P2002 for every unique index
 * in the schema, which is not enough to tell "this attendee already registered"
 * apart from "that email is taken".
 */
export interface Violation {
  /** Prisma's own code: P2002 unique, P2003 foreign key, P2025 not found, P2039 check. */
  code: string;
  /** The PostgreSQL SQLSTATE: 23505 unique, 23514 check, 23001 restrict. */
  sqlState?: string;
  /** The name of the index or constraint that rejected the write. */
  constraint?: string;
  message: string;
}

interface DriverCause {
  originalCode?: string;
  originalMessage?: string;
  constraint?: { index?: string };
}

interface PrismaLikeError {
  code?: string;
  message?: string;
  meta?: { driverAdapterError?: { cause?: DriverCause } };
}

export function asViolation(error: unknown): Violation {
  const prismaError = error as PrismaLikeError;
  const cause = prismaError.meta?.driverAdapterError?.cause;

  return {
    code: prismaError.code ?? '(no code)',
    sqlState: cause?.originalCode,
    constraint: cause?.constraint?.index ?? constraintFromMessage(cause?.originalMessage),
    message: cause?.originalMessage ?? prismaError.message ?? String(error),
  };
}

/**
 * A CHECK violation carries no structured constraint name — Prisma reports
 * P2039 with the raw driver message and nothing else — so it is read out of
 * the message. Only used for CHECKs, where there is no alternative.
 */
function constraintFromMessage(message: string | undefined): string | undefined {
  return /violates check constraint "([^"]+)"/.exec(message ?? '')?.[1];
}

/** Runs `operation`, requires it to reject, and returns the violation. */
export async function captureViolation(operation: () => Promise<unknown>): Promise<Violation> {
  try {
    await operation();
  } catch (error) {
    return asViolation(error);
  }

  throw new Error('expected the database to reject this write, but it succeeded');
}
