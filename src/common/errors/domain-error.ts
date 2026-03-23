/**
 * Errors the domain raises, independent of HTTP.
 *
 * Services throw these instead of Nest's HttpException subclasses so that the
 * rules stay testable without a web layer, and so that one filter decides how
 * every failure is rendered. Each carries the status and the RFC 9457 fields it
 * should become, because the service is the only place that knows *why*.
 */
export abstract class DomainError extends Error {
  /**
   * The problem type URI.
   *
   * A URN, not an https URL. An https `type` is a promise that something is
   * served there; inventing one that 404s is worse than useless, and pointing
   * at a domain you may not own forever is worse still. A URN identifies the
   * problem type without claiming to be dereferenceable, which is exactly what
   * RFC 9457 allows and what this API can actually honour.
   */
  abstract readonly problemType: string;

  /** Short, human-readable, and the same for every occurrence of this type. */
  abstract readonly title: string;

  abstract readonly status: number;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }

  /** Type-specific members added alongside the standard problem fields. */
  extensions(): Record<string, unknown> {
    return {};
  }
}

const TYPE_PREFIX = 'urn:problem-type:event-booking';

export class ResourceNotFoundError extends DomainError {
  readonly problemType = `${TYPE_PREFIX}:resource-not-found`;
  readonly title = 'Resource not found';
  readonly status = 404;

  constructor(
    readonly resource: string,
    // Optional because a P2025 from the driver says which model was missing but
    // not which row: the record was gone by the time the write reached it.
    readonly resourceId?: string,
  ) {
    super(
      resourceId === undefined ? `No such ${resource}` : `No ${resource} with id ${resourceId}`,
    );
  }

  override extensions(): Record<string, unknown> {
    return this.resourceId === undefined
      ? { resource: this.resource }
      : { resource: this.resource, resourceId: this.resourceId };
  }
}

export interface FieldError {
  field: string;
  message: string;
}

export class ValidationFailedError extends DomainError {
  readonly problemType = `${TYPE_PREFIX}:validation-failed`;
  readonly title = 'The request body failed validation';
  readonly status = 400;

  constructor(readonly errors: FieldError[]) {
    super(
      errors.length === 1
        ? `${errors[0]?.field ?? 'request'}: ${errors[0]?.message ?? 'is invalid'}`
        : `${String(errors.length)} fields failed validation`,
    );
  }

  override extensions(): Record<string, unknown> {
    // The per-field list is the part a client can act on. A single sentence
    // forces the caller to parse prose to find out which field to fix.
    return { errors: this.errors };
  }
}

/**
 * No usable credential was presented.
 *
 * Deliberately says nothing about *why*. Telling a caller that their key was
 * recognised-but-wrong, as opposed to absent, confirms that a string they found
 * somewhere is a real key — which is exactly what somebody probing the API
 * wants to learn.
 */
export class UnauthorizedError extends DomainError {
  readonly problemType = `${TYPE_PREFIX}:unauthorized`;
  readonly title = 'Authentication is required';
  readonly status = 401;
}

/** A state machine refused the transition that was asked for. */
export class TransitionNotAllowedError extends DomainError {
  readonly problemType = `${TYPE_PREFIX}:transition-not-allowed`;
  readonly title = 'The requested state change is not allowed';
  readonly status = 409;

  constructor(
    reason: string,
    readonly from: string,
    readonly action: string,
  ) {
    super(reason);
  }

  override extensions(): Record<string, unknown> {
    return { currentStatus: this.from, requestedAction: this.action };
  }
}

/** A uniqueness rule already holds for something else. */
export class AlreadyExistsError extends DomainError {
  readonly problemType = `${TYPE_PREFIX}:already-exists`;
  readonly title = 'That already exists';
  readonly status = 409;

  constructor(
    message: string,
    readonly conflictingOn: string,
  ) {
    super(message);
  }

  override extensions(): Record<string, unknown> {
    return { conflictingOn: this.conflictingOn };
  }
}

/** Something else still references this, so it cannot be removed. */
export class ResourceInUseError extends DomainError {
  readonly problemType = `${TYPE_PREFIX}:resource-in-use`;
  readonly title = 'The resource is still referenced';
  readonly status = 409;

  constructor(
    message: string,
    readonly referencedBy: string,
  ) {
    super(message);
  }

  override extensions(): Record<string, unknown> {
    return { referencedBy: this.referencedBy };
  }
}

/** A domain rule about the event itself was broken. */
export class RuleViolationError extends DomainError {
  readonly problemType = `${TYPE_PREFIX}:rule-violation`;
  readonly title = 'A domain rule was violated';
  readonly status = 409;

  constructor(
    message: string,
    readonly rule: string,
    private readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }

  override extensions(): Record<string, unknown> {
    return { rule: this.rule, ...this.details };
  }
}
