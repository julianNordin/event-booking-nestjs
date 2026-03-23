import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { Reflector } from '@nestjs/core';

import { API_KEY_HEADER, OrganiserIdentity, securityConfig } from '../../config/security.config';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { ORGANISER_REQUEST_KEY } from '../decorators/organiser.decorator';
import { UnauthorizedError } from '../errors/domain-error';

interface GuardedRequest {
  headers: Record<string, string | string[] | undefined>;
  [ORGANISER_REQUEST_KEY]?: OrganiserIdentity;
}

/**
 * Fail-closed API key authentication.
 *
 * Registered as a global `APP_GUARD`, so every route requires a key unless it
 * is marked `@Public()`. A new endpoint added without thinking about auth is
 * therefore unreachable rather than unprotected — the failure is loud, immediate
 * and impossible to ship past a single manual test.
 *
 * `getAllAndOverride` checks the handler first and then the controller, so a
 * whole controller can be opened up and one method inside it closed again.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(securityConfig.KEY)
    private readonly security: ConfigType<typeof securityConfig>,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic === true) {
      return true;
    }

    const request = context.switchToHttp().getRequest<GuardedRequest>();
    const presented = request.headers[API_KEY_HEADER];

    if (typeof presented !== 'string' || presented === '') {
      throw new UnauthorizedError(`an ${API_KEY_HEADER} header is required for this operation`);
    }

    const organiser = this.security.organisersByKey.get(presented);

    if (organiser === undefined) {
      // Deliberately the same message as a missing key. Distinguishing
      // "no key" from "wrong key" tells someone probing the API whether a
      // string they found somewhere is a real key, which is the one thing they
      // wanted to know.
      throw new UnauthorizedError(`an ${API_KEY_HEADER} header is required for this operation`);
    }

    // The one place that knows where @Organiser() reads from.
    request[ORGANISER_REQUEST_KEY] = organiser;

    return true;
  }
}
