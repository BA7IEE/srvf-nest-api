import { AsyncLocalStorage } from 'node:async_hooks';

export type RouteAuthzMode =
  | 'PUBLIC'
  | 'LOGIN_ONLY'
  | 'LOGIN_SCOPED'
  | 'RESPONSIBILITY_SCOPED'
  | 'RBAC';

export type RouteAuthzEngine = 'rbac-global' | 'authz-scoped';
export type RouteAuthzAdmission = 'app-member';
export type RouteAuthzRequire = 'all' | 'any';

// Predicate names are a registry, not free-form labels. Each name belongs to
// the domain owning its implementation; adding one requires a maintainer
// decision so a declaration cannot silently invent a second predicate.
export const AUTHZ_VISIBILITY_PREDICATES = [
  'activity-visibility',
  'app-activity-catalog',
  'content-visibility',
] as const;

export type AuthzVisibilityPredicate = (typeof AUTHZ_VISIBILITY_PREDICATES)[number];
export type RouteAuthzScope =
  | 'self'
  | 'responsibility'
  | 'org-scope'
  | `visibility:${AuthzVisibilityPredicate}`;

export interface RouteAuthzCodeDeclaration {
  code: string;
  scope: string | null;
}

interface CanonicalRouteAuthzCodeDeclaration {
  code: string;
  scope: RouteAuthzScope | null;
}

// Each decorator contributes one fragment. The normalizer below is the only
// place allowed to give the combined fragments their manifest semantics.
export interface RouteAuthzDeclarationFragment {
  admission?: RouteAuthzAdmission;
  mode?: Exclude<RouteAuthzMode, 'PUBLIC'>;
  codes?: readonly RouteAuthzCodeDeclaration[];
  require?: RouteAuthzRequire;
  scopes?: readonly string[];
  engine?: RouteAuthzEngine;
}

export interface RouteAuthzNormalizationInput {
  isPublic: boolean;
  fragments: readonly RouteAuthzDeclarationFragment[];
}

// Matches the manifest JSON shape exactly. `null` is deliberate: it keeps
// every policy axis explicit and makes semantic diffs deterministic.
export interface CanonicalRouteAuthzDeclaration {
  admission: RouteAuthzAdmission | null;
  mode: RouteAuthzMode;
  codes: CanonicalRouteAuthzCodeDeclaration[];
  require: RouteAuthzRequire;
  scopes: RouteAuthzScope[];
  engine: RouteAuthzEngine | null;
}

// This is the single source for both the runtime ALS markers and the R8
// harness registry. The manifest generator writes the JSON projection under
// harness/ so production code never depends on a build-time artifact.
export interface AuthzAssertionPatternDefinition {
  id: string;
  runtimeMarker: string | null;
  callShapes: string[];
  requiredOutcomes: string[];
  axes: string[];
  staticMatchers: AuthzAssertionStaticMatcher[];
}

// The static matcher is deliberately data, not a second parser embedded in
// R8.  The manifest generator projects this same registry for the ESLint rule,
// while runtimeMarker remains the production ALS projection.  A pattern must
// name both the receiver type and the observable consequence before static
// analysis may count it as an authorization assertion.
export interface AuthzAssertionStaticMatcher {
  receiverTypes: string[];
  methods: string[];
  actionArgument: number | null;
  outcome:
    | 'boolean-deny-branch'
    | 'query-filter-pushdown'
    | 'app-admission-branch'
    | 'throwing-assertion';
}

export const AUTHZ_ASSERTION_PATTERNS: readonly AuthzAssertionPatternDefinition[] = [
  {
    id: 'rbac-can',
    runtimeMarker: 'rbac.can',
    callShapes: ['RbacService.can(action)'],
    requiredOutcomes: ['throw', 'early-return', 'guard'],
    axes: ['codes'],
    staticMatchers: [
      {
        receiverTypes: ['RbacService'],
        methods: ['can'],
        actionArgument: 1,
        outcome: 'boolean-deny-branch',
      },
    ],
  },
  {
    id: 'authz-can-explain',
    runtimeMarker: 'authz.can|explain',
    callShapes: ['AuthzService.can(action, ref)', 'AuthzService.explain(action, ref)'],
    requiredOutcomes: ['deny-to-BizCode', 'early-return', 'guard'],
    axes: ['codes', 'engine'],
    staticMatchers: [
      {
        receiverTypes: ['AuthzService'],
        methods: ['can', 'explain'],
        actionArgument: 1,
        outcome: 'boolean-deny-branch',
      },
    ],
  },
  {
    id: 'visible-organization-scope',
    runtimeMarker: null,
    callShapes: ['AuthzService.getVisibleOrganizationScope(action)'],
    requiredOutcomes: ['query-filter-pushdown'],
    axes: ['scopes'],
    staticMatchers: [
      {
        receiverTypes: ['AuthzService'],
        methods: ['getVisibleOrganizationScope'],
        actionArgument: 1,
        outcome: 'query-filter-pushdown',
      },
    ],
  },
  {
    id: 'app-identity-resolve',
    runtimeMarker: 'AppIdentityResolver.resolve',
    callShapes: ['AppIdentityResolver.resolve(currentUser)'],
    requiredOutcomes: ['app-admission-branch'],
    axes: ['admission'],
    staticMatchers: [
      {
        receiverTypes: ['AppIdentityResolver'],
        methods: ['resolve'],
        actionArgument: null,
        outcome: 'app-admission-branch',
      },
    ],
  },
  {
    id: 'responsibility-check',
    runtimeMarker: null,
    callShapes: ['registered responsibility policy check'],
    requiredOutcomes: ['throw', 'early-return', 'guard'],
    axes: ['scopes'],
    staticMatchers: [
      {
        receiverTypes: ['ActivityResponsibilityPolicy'],
        methods: ['assertOwner', 'assertOwnerOrOverride', 'assertInitiatorOrOverride'],
        actionArgument: null,
        outcome: 'throwing-assertion',
      },
    ],
  },
];

function oneOrThrow<T extends string>(values: readonly T[], label: string): T | undefined {
  const distinct = [...new Set(values)];
  if (distinct.length > 1) {
    throw new Error(`Route authorization declaration has multiple ${label}`);
  }
  return distinct[0];
}

function nonBlank(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`Route authorization declaration has blank ${label}`);
  return trimmed;
}

const registeredVisibilityPredicates = new Set<string>(AUTHZ_VISIBILITY_PREDICATES);

function canonicalScope(value: string, label: string): RouteAuthzScope {
  const scope = nonBlank(value, label);
  if (scope === 'self' || scope === 'responsibility' || scope === 'org-scope') return scope;
  if (scope === 'visibility') {
    throw new Error('Route authorization declaration must name a visibility predicate');
  }
  if (scope === 'organization' || scope === 'visibility:organization') {
    throw new Error(
      'Route authorization declaration must use org-scope for organization visibility',
    );
  }
  if (scope.startsWith('visibility:')) {
    const predicate = scope.slice('visibility:'.length);
    if (predicate === 'visibility') {
      throw new Error(
        'Route authorization declaration cannot use self-referential visibility predicate',
      );
    }
    if (!registeredVisibilityPredicates.has(predicate)) {
      throw new Error(
        `Route authorization declaration has unregistered visibility predicate: ${predicate}`,
      );
    }
    return scope as RouteAuthzScope;
  }
  throw new Error(`Route authorization declaration has unsupported scope: ${scope}`);
}

function canonicalCodes(
  fragments: readonly RouteAuthzDeclarationFragment[],
): CanonicalRouteAuthzCodeDeclaration[] {
  const seen = new Set<string>();
  const result: CanonicalRouteAuthzCodeDeclaration[] = [];
  for (const fragment of fragments) {
    for (const declared of fragment.codes ?? []) {
      const code = nonBlank(declared.code, 'permission code');
      const scope =
        declared.scope === null ? null : canonicalScope(declared.scope, 'permission scope');
      const key = `${code}\u0000${scope ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({ code, scope });
    }
  }
  return result.sort((left, right) => {
    const codeOrder = left.code.localeCompare(right.code);
    if (codeOrder !== 0) return codeOrder;
    return (left.scope ?? '').localeCompare(right.scope ?? '');
  });
}

export function normalizeRouteAuthzDeclaration(
  input: RouteAuthzNormalizationInput,
): CanonicalRouteAuthzDeclaration | null {
  if (input.isPublic) {
    if (input.fragments.length > 0) {
      throw new Error('Public route cannot combine with another authorization declaration');
    }
    return {
      admission: null,
      mode: 'PUBLIC',
      codes: [],
      require: 'all',
      scopes: [],
      engine: null,
    };
  }

  if (input.fragments.length === 0) return null;

  const admission = oneOrThrow(
    input.fragments.flatMap((fragment) => (fragment.admission ? [fragment.admission] : [])),
    'admission declarations',
  );
  const explicitMode = oneOrThrow(
    input.fragments.flatMap((fragment) => (fragment.mode ? [fragment.mode] : [])),
    'modes',
  );
  const codes = canonicalCodes(input.fragments);
  const require = oneOrThrow(
    input.fragments.flatMap((fragment) => (fragment.require ? [fragment.require] : [])),
    'require declarations',
  );
  const explicitEngine = oneOrThrow(
    input.fragments.flatMap((fragment) => (fragment.engine ? [fragment.engine] : [])),
    'engines',
  );
  const scopes = [
    ...new Set(
      input.fragments.flatMap((fragment) =>
        (fragment.scopes ?? []).map((scope) => canonicalScope(scope, 'scope')),
      ),
    ),
  ].sort((left, right) => left.localeCompare(right));

  const mode = explicitMode ?? (codes.length > 0 ? 'RBAC' : undefined);
  if (!mode) {
    throw new Error('Route authorization declaration requires a mode or permission code');
  }

  const engine =
    explicitEngine ??
    (codes.length > 0
      ? 'rbac-global'
      : mode === 'LOGIN_SCOPED' || mode === 'RESPONSIBILITY_SCOPED'
        ? 'authz-scoped'
        : null);

  const hasOrgScope =
    scopes.includes('org-scope') || codes.some((declaration) => declaration.scope === 'org-scope');
  if (hasOrgScope && engine !== 'authz-scoped') {
    throw new Error('Route authorization declaration with org-scope requires authz-scoped engine');
  }

  return {
    admission: admission ?? null,
    mode,
    codes,
    require: require ?? 'all',
    scopes,
    engine,
  };
}

const runtimeAssertionPatterns = new Set(
  AUTHZ_ASSERTION_PATTERNS.filter((pattern) => pattern.runtimeMarker !== null).map(
    (pattern) => pattern.id,
  ),
);

export interface AuthzAssertionObservation {
  pattern: string;
  codes: string[];
  hasResourceRef: boolean;
}

export interface AuthzRequestObservation {
  declaration: CanonicalRouteAuthzDeclaration;
  assertions: AuthzAssertionObservation[];
}

export interface AuthzObservationGap {
  missingAdmission: boolean;
  missingCodes: string[];
  engine: RouteAuthzEngine | null;
}

const requestAuthzContext = new AsyncLocalStorage<AuthzRequestObservation>();

export function beginAuthzRequestObservation(
  declaration: CanonicalRouteAuthzDeclaration,
): AuthzRequestObservation {
  const observation: AuthzRequestObservation = { declaration, assertions: [] };
  // Guard runs before the handler. enterWith preserves this request-local
  // context through the handler's asynchronous service chain.
  requestAuthzContext.enterWith(observation);
  return observation;
}

export function recordAuthzAssertion(input: {
  pattern: string;
  codes?: readonly string[];
  resourceRef?: unknown;
}): void {
  if (!runtimeAssertionPatterns.has(input.pattern)) return;
  const observation = requestAuthzContext.getStore();
  if (!observation) return;

  const codes = [...new Set((input.codes ?? []).map((code) => code.trim()).filter(Boolean))].sort(
    (left, right) => left.localeCompare(right),
  );
  const hasResourceRef = input.resourceRef !== undefined;
  const duplicate = observation.assertions.some(
    (assertion) =>
      assertion.pattern === input.pattern &&
      assertion.codes.join('\u0000') === codes.join('\u0000') &&
      assertion.hasResourceRef === hasResourceRef,
  );
  if (duplicate) return;

  observation.assertions.push({
    pattern: input.pattern,
    codes,
    // Retain only its presence. Resource values must not survive in the
    // request observation or appear in logs.
    hasResourceRef,
  });
}

export function findAuthzObservationGap(
  observation: AuthzRequestObservation,
): AuthzObservationGap | null {
  const { declaration } = observation;
  if (declaration.mode === 'PUBLIC') return null;

  const missingAdmission =
    declaration.admission === 'app-member' &&
    !observation.assertions.some((assertion) => assertion.pattern === 'app-identity-resolve');

  const expectedPattern =
    declaration.engine === 'authz-scoped'
      ? 'authz-can-explain'
      : declaration.engine === 'rbac-global'
        ? 'rbac-can'
        : null;
  const observedCodes = new Set(
    observation.assertions
      .filter((assertion) => assertion.pattern === expectedPattern)
      .flatMap((assertion) => assertion.codes),
  );
  const declaredCodes = declaration.codes.map((item) => item.code);
  const missingCodes =
    declaration.require === 'any'
      ? declaredCodes.some((code) => observedCodes.has(code))
        ? []
        : declaredCodes
      : declaredCodes.filter((code) => !observedCodes.has(code));

  if (!missingAdmission && missingCodes.length === 0) return null;
  return { missingAdmission, missingCodes, engine: declaration.engine };
}
