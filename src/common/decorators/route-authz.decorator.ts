import 'reflect-metadata';

import type {
  RouteAuthzAdmission,
  RouteAuthzCodeDeclaration,
  RouteAuthzDeclarationFragment,
  RouteAuthzEngine,
  RoutePrincipalKind,
  RouteAuthzRequire,
} from '../authz/authz-context';

export const ROUTE_AUTHZ_DECLARATION_KEY = 'routeAuthzDeclaration';

export interface RouteAuthzOptions {
  admission?: RouteAuthzAdmission;
  require?: RouteAuthzRequire;
  scopes?: readonly string[];
  engine?: RouteAuthzEngine;
  allowedPrincipalKinds?: readonly RoutePrincipalKind[];
}

export type RouteAuthzPermissionCode =
  | string
  | { readonly code: string; readonly scope?: string | null };

type RouteAuthzDecorator = MethodDecorator & ClassDecorator;

function metadataTargetOf(target: object, descriptor?: PropertyDescriptor): object {
  const decorated: unknown = descriptor?.value;
  return typeof decorated === 'function' ? decorated : target;
}

function appendRouteAuthzDeclaration(fragment: RouteAuthzDeclarationFragment): RouteAuthzDecorator {
  return (target: object, _propertyKey?: string | symbol, descriptor?: PropertyDescriptor) => {
    const metadataTarget = metadataTargetOf(target, descriptor);
    const current = Reflect.getOwnMetadata(ROUTE_AUTHZ_DECLARATION_KEY, metadataTarget) as unknown;
    const existing = Array.isArray(current)
      ? current.filter(
          (item): item is RouteAuthzDeclarationFragment =>
            typeof item === 'object' && item !== null,
        )
      : [];
    Reflect.defineMetadata(ROUTE_AUTHZ_DECLARATION_KEY, [...existing, fragment], metadataTarget);
  };
}

function scopedOptions(options: RouteAuthzOptions, extraScope: string): RouteAuthzOptions {
  return {
    ...options,
    scopes: [...new Set([...(options.scopes ?? []), extraScope])],
  };
}

function isRouteAuthzOptions(
  value: RouteAuthzPermissionCode | RouteAuthzOptions,
): value is RouteAuthzOptions {
  return typeof value === 'object' && value !== null && !Object.hasOwn(value, 'code');
}

function normalizePermissionCode(value: RouteAuthzPermissionCode): RouteAuthzCodeDeclaration {
  if (typeof value === 'string') return { code: value, scope: null };
  return { code: value.code, scope: value.scope ?? null };
}

// Five declaration families. They only declare a policy shape; access checks
// remain exclusively in RbacService/AuthzService and AppIdentityResolver.
export const LoginOnly = (options: RouteAuthzOptions = {}): RouteAuthzDecorator =>
  appendRouteAuthzDeclaration({ ...options, mode: 'LOGIN_ONLY' });

export function LoginScoped(ruleName: string, options?: RouteAuthzOptions): RouteAuthzDecorator;
export function LoginScoped(options: RouteAuthzOptions): RouteAuthzDecorator;
export function LoginScoped(
  ruleNameOrOptions: string | RouteAuthzOptions,
  optionalOptions: RouteAuthzOptions = {},
): RouteAuthzDecorator {
  const hasRuleName = typeof ruleNameOrOptions === 'string';
  const options = hasRuleName ? optionalOptions : ruleNameOrOptions;
  return appendRouteAuthzDeclaration({
    ...(hasRuleName ? scopedOptions(options, `visibility:${ruleNameOrOptions}`) : options),
    mode: 'LOGIN_SCOPED',
    engine: options.engine ?? 'authz-scoped',
  });
}

export const ResponsibilityScoped = (options: RouteAuthzOptions = {}): RouteAuthzDecorator =>
  appendRouteAuthzDeclaration({
    ...scopedOptions(options, 'responsibility'),
    mode: 'RESPONSIBILITY_SCOPED',
    engine: options.engine ?? 'authz-scoped',
  });

export const RequiresPermission = (
  ...codesAndOptions: Array<RouteAuthzPermissionCode | RouteAuthzOptions>
): RouteAuthzDecorator => {
  const options = codesAndOptions.filter(isRouteAuthzOptions);
  if (options.length > 1) throw new Error('RequiresPermission accepts at most one options object');
  const codes = codesAndOptions.filter(
    (value): value is RouteAuthzPermissionCode => !isRouteAuthzOptions(value),
  );
  if (codes.length === 0)
    throw new Error('RequiresPermission requires at least one permission code');
  return appendRouteAuthzDeclaration({
    ...(options[0] ?? {}),
    codes: codes.map(normalizePermissionCode),
  });
};
