import { AsyncLocalStorage } from 'node:async_hooks';

export type RouteAuthzMode =
  | 'PUBLIC'
  | 'LOGIN_ONLY'
  | 'LOGIN_SCOPED'
  | 'RESPONSIBILITY_SCOPED'
  | 'RBAC';

// Which engine decides access.
//
// `none` is a *declared absence*, not a missing declaration: the endpoint's
// access decision is carried by the scopes / admission axes (self-by-construction,
// a responsibility policy, app admission) rather than by an engine, so no engine
// assertion is owed. It exists because the vocabulary previously could not say
// this — `@LoginScoped` fills in `authz-scoped` for anything that does not name an
// engine, which made every LOGIN_SCOPED route claim the scoped-authz engine
// whether or not it uses it.
//
// Distinct from `null` on the canonical declaration: `null` means the mode
// implies no engine at all (PUBLIC / LOGIN_ONLY), while `none` is a positive
// statement by the author about a route that does have a judging surface.
export const ROUTE_AUTHZ_ENGINES = ['rbac-global', 'authz-scoped', 'none'] as const;
export type RouteAuthzEngine = (typeof ROUTE_AUTHZ_ENGINES)[number];

/**
 * The vocabulary as a runtime check, so parsers validate against this list
 * instead of restating it. A second copy would be free to drift, and the
 * declaration parser is exactly where drift decides whether a declaration is
 * readable at all.
 */
export function isRouteAuthzEngine(value: string): value is RouteAuthzEngine {
  return (ROUTE_AUTHZ_ENGINES as readonly string[]).includes(value);
}
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
  staticMatchers: AuthzAssertionMatcher[];
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

// The second matcher shape. Every family above proves "an authorization
// decision happened" by naming a call and its consequence. This one proves the
// opposite kind of statement — "impersonation is not expressible" — by
// describing the handler's *input surface* rather than any call in it. The two
// kinds are deliberately not merged: a call matcher answers "was judgement
// exercised", this answers "was there anything to judge". Keeping them separate
// interfaces makes the illegal combination (a receiver type with a structural
// outcome, or a decorator list with a deny-branch outcome) unrepresentable.
//
// It stays data for the same reason the call matchers do: R8 owns the single
// traversal, this owns the vocabulary it traverses with.
//
// The judgement is a *negative* one, so its correctness rests entirely on
// exhaustiveness — one unlisted way of reaching the handler is one endpoint
// wrongly stamped safe. Hence classification is a whitelist on both sides and
// anything falling through is a T3 candidate, never a pass. In particular
// `callerControlled` lists only the decorators whose carried names R8 can
// actually enumerate (a decorator argument, or a DTO whose fields expand);
// `@Req` / `@Headers` / `@Session` are deliberately absent from BOTH lists —
// they hand the handler the whole request, so there is no name set to check and
// no honest way to call them safe.
export interface AuthzSubjectInputMatcher {
  outcome: 'no-caller-controlled-subject';
  // Framework-injected caller identity. Safe because the caller cannot choose it.
  identityParameterDecorators: string[];
  // Caller-supplied input whose carried names R8 can enumerate.
  callerControlledParameterDecorators: string[];
  // Names that may denote a *subject* rather than a resource. Conservative by
  // construction: bare `id` is included because at the parameter surface there
  // is nothing distinguishing a resource id from a subject id, and this family
  // must never be the reason an IDOR surface is stamped closed. Extending this
  // list requires naming the reason in the same PR.
  subjectIdentifierNames: string[];
}

export type AuthzAssertionMatcher = AuthzAssertionStaticMatcher | AuthzSubjectInputMatcher;

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
  // `scope: self` closes by construction, not by assertion. The other families
  // prove a judgement was made; here the intersection of resource and identity
  // is a where-clause, not a call, so there is no call to observe — and no
  // runtime marker to emit, which is why runtimeMarker stays null.
  //
  // NOTE for the ALS work: null here means "this axis emits nothing", NOT "these
  // endpoints are unobservable". Their service chains still call
  // AppIdentityResolver.resolve / assertCanUseAppOrThrow, so the admission axis
  // is observed as usual. ALS must decide what to observe from an endpoint's own
  // properties and must NOT gate observation on R8's tier — moving these routes
  // out of T3 would otherwise silently stop observing them.
  {
    id: 'self-by-construction',
    runtimeMarker: null,
    callShapes: ['handler exposes no caller-controlled subject input'],
    requiredOutcomes: ['no-caller-controlled-subject'],
    axes: ['scopes'],
    staticMatchers: [
      {
        outcome: 'no-caller-controlled-subject',
        identityParameterDecorators: ['CurrentUser'],
        callerControlledParameterDecorators: ['Param', 'Query', 'Body'],
        subjectIdentifierNames: [
          // Bare resource id — cannot be told apart from a subject id at the
          // parameter surface, so it is refused rather than guessed.
          'id',
          'ids',
          // Direct subject handles.
          'userId',
          'userIds',
          'userNo',
          'memberId',
          'memberIds',
          'memberNo',
          'accountId',
          'principalId',
          'subjectId',
          // Roles that resolve to a person on the resource.
          'ownerId',
          'creatorId',
          'operatorId',
          'actorId',
          'applicantId',
          'recipientMemberId',
          'publisherId',
          // Login / contact handles that select a person without an id.
          'openid',
          'openId',
          'unionid',
          'unionId',
          'username',
          'email',
          'phone',
          'mobile',
        ],
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
