import { webcrypto } from 'node:crypto';

/**
 * Give the test environment the WebCrypto global that Node has natively.
 *
 * Prisma generates `@default(uuid(7))` values client-side, and reaches for them
 * with `globalThis.crypto ?? await import('node:crypto')`. Jest's node
 * environment does not expose `globalThis.crypto`, so that falls through to the
 * dynamic import — and a dynamic import inside Jest's CommonJS VM fails with
 * "A dynamic import callback was invoked without --experimental-vm-modules".
 *
 * The error names a Jest flag and points at whichever query happened to run
 * first, so it reads like a module-format problem. It is not: it is a missing
 * global. Supplying it means the fallback is never taken, which is both the
 * smaller change and the faster path.
 */
if (globalThis.crypto === undefined) {
  Object.defineProperty(globalThis, 'crypto', {
    value: webcrypto,
    configurable: true,
    writable: false,
  });
}
