import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'event-booking:is-public';

/**
 * Opt a route out of the API key requirement.
 *
 * The direction matters. The guard is global and every route needs a key
 * unless it says otherwise, so forgetting to annotate a new endpoint makes it
 * *unreachable* rather than *unprotected*. The opposite arrangement — a
 * `@RequiresKey()` that must be remembered — fails the other way, and the
 * failure is silent, works perfectly in every test, and is discovered by
 * somebody else.
 */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true);
