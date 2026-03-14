/**
 * An RFC 9457 problem detail.
 *
 * The five standard members, plus whatever extensions the specific problem
 * carries. Extensions sit at the top level of the object, not inside a nested
 * bag — that is what the RFC specifies, and it is why the index signature is
 * here.
 */
export class ProblemDetailDto {
  /** A URI identifying the problem type. Always a URN in this API. */
  type!: string;

  /** Short, human-readable, and constant for the type. */
  title!: string;

  status!: number;

  /** Specific to this occurrence. Safe to show a user; never a driver message. */
  detail!: string;

  /** The request that produced it. */
  instance?: string;

  [extension: string]: unknown;
}
