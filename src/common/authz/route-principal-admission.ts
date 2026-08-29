import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';

import {
  effectiveAllowedPrincipalKinds,
  normalizeRouteAuthzDeclaration,
  type RouteAuthzDeclarationFragment,
  type RoutePrincipalKind,
} from './authz-context';
import { ROUTE_AUTHZ_DECLARATION_KEY } from '../decorators/route-authz.decorator';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

/**
 * Reads the same normalized route declaration consumed by AuthzDeclarationGuard.
 * `null` means undeclared; specialized guards stay inactive and let the later
 * declaration guard fail closed.
 */
export function routePrincipalKinds(
  reflector: Reflector,
  context: ExecutionContext,
): readonly RoutePrincipalKind[] | null {
  const targets = [context.getHandler(), context.getClass()];
  const isPublic = reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets) === true;
  const fragments = targets.flatMap(
    (target) =>
      (Reflect.getMetadata(ROUTE_AUTHZ_DECLARATION_KEY, target) as
        | RouteAuthzDeclarationFragment[]
        | undefined) ?? [],
  );
  const declaration = normalizeRouteAuthzDeclaration({ isPublic, fragments });
  return declaration === null ? null : effectiveAllowedPrincipalKinds(declaration);
}
