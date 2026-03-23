import { createParamDecorator, ExecutionContext } from '@nestjs/common';

import { OrganiserIdentity } from '../../config/security.config';

/** Where the guard leaves the identity it resolved, for this decorator to read. */
export const ORGANISER_REQUEST_KEY = 'organiser';

interface RequestWithOrganiser {
  [ORGANISER_REQUEST_KEY]?: OrganiserIdentity;
}

/**
 * The organiser whose key authorised this request.
 *
 * A parameter decorator rather than a helper the controller calls, so the
 * handler signature says what it needs and the controller never reaches into
 * the request object to find it. The guard put it there; this is the only
 * thing that knows that.
 *
 * Undefined on a `@Public()` route, by construction — nobody presented a key.
 */
export const Organiser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): OrganiserIdentity | undefined =>
    context.switchToHttp().getRequest<RequestWithOrganiser>()[ORGANISER_REQUEST_KEY],
);
