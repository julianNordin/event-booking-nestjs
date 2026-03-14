import type { ValidationError } from 'class-validator';

import { FieldError } from './domain-error';

/**
 * Flattens class-validator's tree into a list a client can act on.
 *
 * The raw structure is recursive — a failing nested object reports its own
 * failures as `children` — and the default Nest response throws that shape away
 * in favour of an array of sentences. Sentences are fine to read and useless to
 * act on: a form cannot highlight a field it has to find by parsing prose.
 *
 * Paths are dotted, so a nested failure is reported as `schedule.startsAt`
 * rather than `startsAt`, which would be ambiguous the moment two objects in
 * one payload have a field of the same name.
 */
export function toFieldErrors(errors: readonly ValidationError[], prefix = ''): FieldError[] {
  return errors.flatMap((error) => {
    const path = prefix === '' ? error.property : `${prefix}.${error.property}`;

    const own = Object.values(error.constraints ?? {}).map((message) => ({
      field: path,
      message,
    }));

    const nested = error.children === undefined ? [] : toFieldErrors(error.children, path);

    return [...own, ...nested];
  });
}
