import {
  LoginOnly,
  LoginScoped,
  RequiresPermission,
  ResponsibilityScoped,
  ROUTE_AUTHZ_DECLARATION_KEY,
} from '../decorators/route-authz.decorator';
import {
  beginAuthzRequestObservation,
  findAuthzObservationGap,
  normalizeRouteAuthzDeclaration,
  recordAuthzAssertion,
  type RouteAuthzDeclarationFragment,
} from './authz-context';

type Decorate = (target: object, propertyKey: string, descriptor: PropertyDescriptor) => void;

function fragmentsFrom(decorate: Decorate): RouteAuthzDeclarationFragment[] {
  class TestController {
    handler(this: void): void {}
  }

  const descriptor = Object.getOwnPropertyDescriptor(TestController.prototype, 'handler');
  if (!descriptor) throw new Error('test handler descriptor missing');
  decorate(TestController.prototype, 'handler', descriptor);
  const metadataTarget: unknown = descriptor.value;
  if (typeof metadataTarget !== 'function') throw new Error('test handler missing');
  const metadata = Reflect.getOwnMetadata(ROUTE_AUTHZ_DECLARATION_KEY, metadataTarget) as unknown;
  if (!Array.isArray(metadata)) return [];
  return metadata.filter(
    (item): item is RouteAuthzDeclarationFragment => typeof item === 'object' && item !== null,
  );
}

describe('route authorization declaration normalizer', () => {
  it('normalizes @Public into the canonical manifest form', () => {
    expect(
      normalizeRouteAuthzDeclaration({
        isPublic: true,
        fragments: [],
      }),
    ).toEqual({
      admission: null,
      mode: 'PUBLIC',
      codes: [],
      require: 'all',
      scopes: [],
      engine: null,
    });
  });

  it('merges admission, code-bound scopes and endpoint scopes deterministically', () => {
    expect(
      normalizeRouteAuthzDeclaration({
        isPublic: false,
        fragments: [
          {
            mode: 'LOGIN_SCOPED',
            admission: 'app-member',
            scopes: ['visibility:activity-visibility', 'self'],
            engine: 'authz-scoped',
          },
          {
            codes: [
              { code: 'activity.read', scope: 'self' },
              { code: 'attendance.read', scope: null },
              { code: 'activity.read', scope: 'self' },
            ],
            require: 'all',
          },
        ],
      }),
    ).toEqual({
      admission: 'app-member',
      mode: 'LOGIN_SCOPED',
      codes: [
        { code: 'activity.read', scope: 'self' },
        { code: 'attendance.read', scope: null },
      ],
      require: 'all',
      scopes: ['self', 'visibility:activity-visibility'],
      engine: 'authz-scoped',
    });
  });

  it.each([
    ['bare visibility', 'visibility', 'must name a visibility predicate'],
    ['self-referential visibility predicate', 'visibility:visibility', 'cannot use self-referential'],
    ['unregistered visibility predicate', 'visibility:unregistered', 'unregistered visibility predicate'],
    ['legacy organization scope', 'organization', 'must use org-scope'],
    ['legacy organization visibility', 'visibility:organization', 'must use org-scope'],
  ])('rejects %s', (_name, scope, message) => {
    expect(() =>
      normalizeRouteAuthzDeclaration({
        isPublic: false,
        fragments: [{ mode: 'LOGIN_SCOPED', scopes: [scope], engine: 'authz-scoped' }],
      }),
    ).toThrow(message);
  });

  it('accepts org-scope with the authz-scoped engine', () => {
    expect(
      normalizeRouteAuthzDeclaration({
        isPublic: false,
        fragments: [{ mode: 'LOGIN_SCOPED', scopes: ['org-scope'], engine: 'authz-scoped' }],
      }),
    ).toEqual(
      expect.objectContaining({
        scopes: ['org-scope'],
        engine: 'authz-scoped',
      }),
    );
  });

  it.each([
    ['endpoint scope', { scopes: ['org-scope'] }],
    ['code-bound scope', { codes: [{ code: 'organization.read', scope: 'org-scope' }] }],
  ])('rejects %s with a non-authz engine', (_name, fragment) => {
    expect(() =>
      normalizeRouteAuthzDeclaration({
        isPublic: false,
        fragments: [{ mode: 'RBAC', engine: 'rbac-global', ...fragment }],
      }),
    ).toThrow('org-scope requires authz-scoped engine');
  });

  it('rejects contradictory declaration fragments', () => {
    expect(() =>
      normalizeRouteAuthzDeclaration({
        isPublic: false,
        fragments: [{ mode: 'LOGIN_ONLY' }, { mode: 'RBAC' }],
      }),
    ).toThrow('multiple modes');
  });

  it('keeps only registered ALS assertions and never retains a resource value', () => {
    const declaration = normalizeRouteAuthzDeclaration({
      isPublic: false,
      fragments: [
        {
          admission: 'app-member',
          mode: 'RBAC',
          codes: [
            { code: 'activity.read', scope: null },
            { code: 'attendance.read', scope: null },
          ],
          engine: 'rbac-global',
        },
      ],
    });
    if (!declaration) throw new Error('test declaration missing');

    const observation = beginAuthzRequestObservation(declaration);
    recordAuthzAssertion({ pattern: 'unregistered-pattern', codes: ['activity.read'] });
    recordAuthzAssertion({
      pattern: 'rbac-can',
      codes: ['activity.read', 'attendance.read'],
      resourceRef: { id: 'not-retained' },
    });
    recordAuthzAssertion({ pattern: 'app-identity-resolve' });

    expect(observation.assertions).toEqual([
      {
        pattern: 'rbac-can',
        codes: ['activity.read', 'attendance.read'],
        hasResourceRef: true,
      },
      {
        pattern: 'app-identity-resolve',
        codes: [],
        hasResourceRef: false,
      },
    ]);
    expect(findAuthzObservationGap(observation)).toBeNull();
  });

  it.each([
    ['LoginOnly', () => LoginOnly()],
    ['LoginScoped', () => LoginScoped('activity-visibility')],
    ['LoginScoped with an explicit scope kind', () => LoginScoped({ scopes: ['org-scope'] })],
    ['ResponsibilityScoped', () => ResponsibilityScoped()],
    ['RequiresPermission', () => RequiresPermission('activity.read')],
  ])('%s writes a declaration fragment', (_name, createDecorator) => {
    expect(
      fragmentsFrom((target, propertyKey, descriptor) =>
        createDecorator()(target, propertyKey, descriptor),
      ),
    ).toHaveLength(1);
  });
});
