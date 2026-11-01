import { Prisma } from '@prisma/client';
import { nativeLaunchRawInput } from './activity-native-launch.fixture';
import {
  assertR5PrepareStorageReadiness,
  assertR5NoPolicyBranch,
  assertR5ReadClosureCatalog,
  R5_PREPARE_STORAGE_COLUMNS,
  type R5FixedActorAssignmentFact,
  type R5PrepareStorageReadiness,
} from './r5-setmat-preparation-readiness';
import { R5_SETMAT_CALLER } from './r5-setmat-observation';
import { assertR5TableManifest, R5_SETMAT_TABLES } from './r5-setmat-manifest';
import { validateR5SetmatOwnedConfig, type R5SetmatOwnedConfig } from './r5-setmat-owned-fixture';

describe('R5 safety fixture configuration pure checks (NO DATABASE)', () => {
  const config: R5SetmatOwnedConfig = {
    schema: 'srvf-r5-setmat-safety/v1',
    databaseOid: 42,
    creatorUserId: 'creator',
    reviewerUserId: 'a',
    finalReviewerUserId: 'b',
    organizationId: 'org',
    expectedCatalogPath: '/pure-fixture/expected.json',
    expectedCatalogSha256: 'a'.repeat(64),
    boundPreflightBodySha256: 'b'.repeat(64),
    catalogQueryPath: '/pure-fixture/query.sql',
    catalogQuerySha256: 'c'.repeat(64),
    outputDirectory: '/pure-fixture/results',
  };
  it('accepts only the explicit existing identity configuration without opening files', () => {
    expect(validateR5SetmatOwnedConfig(config)).toBe(config);
  });
  it.each([1971161, 1713092, 0, -1, 1.5, NaN])('rejects unsafe target OID %s', (databaseOid) => {
    expect(() => validateR5SetmatOwnedConfig({ ...config, databaseOid })).toThrow();
  });
  it('rejects A/B aliasing and unpinned catalog metadata', () => {
    expect(() => validateR5SetmatOwnedConfig({ ...config, reviewerUserId: 'b' })).toThrow();
    expect(() =>
      validateR5SetmatOwnedConfig({ ...config, expectedCatalogSha256: 'current' }),
    ).toThrow();
    expect(() => validateR5SetmatOwnedConfig({ ...config, outputDirectory: 'relative' })).toThrow();
  });
  it('uses an independent participant without changing the real source operator user', () => {
    let n = 0;
    const source = {
      activityId: 'activity',
      sessionId: 'session',
      positionId: 'position',
      startsAt: new Date('2026-01-01T00:00:00Z'),
      endsAt: new Date('2026-01-01T00:00:36Z'),
    };
    const raw = nativeLaunchRawInput(
      source,
      { id: 'actual-creator-user', memberId: 'fresh-participant-member' },
      1,
      (label) => label + '_' + ++n,
      new Date('2026-01-01T00:01:00Z'),
    );
    expect(raw.people[0].memberId).toBe('fresh-participant-member');
    expect(raw.events.every((event) => event.operatorUserId === 'actual-creator-user')).toBe(true);
    expect(raw.identities[0].memberId).toBe('fresh-participant-member');
  });
  it('freezes exact names from candidate models plus the approved SQL relations', () => {
    const wanted = [
      ...Prisma.dmmf.datamodel.models.map((model) => model.dbName ?? model.name),
      '_prisma_migrations',
      'CorrectionApprovedInputItem',
      'CorrectionWritePhase',
    ].sort();
    expect(R5_SETMAT_TABLES).toEqual(wanted);
  });
  it('rejects missing, substituted, extra and duplicated tables without a numeric table-count gate', () => {
    expect(() => assertR5TableManifest(R5_SETMAT_TABLES)).not.toThrow();
    expect(() => assertR5TableManifest(R5_SETMAT_TABLES.slice(1))).toThrow();
    expect(() => assertR5TableManifest(['unreviewed', ...R5_SETMAT_TABLES.slice(1)])).toThrow();
    expect(() => assertR5TableManifest([...R5_SETMAT_TABLES, 'unreviewed'])).toThrow();
    expect(() => assertR5TableManifest([...R5_SETMAT_TABLES, R5_SETMAT_TABLES[0]])).toThrow();
  });
  const readiness: R5PrepareStorageReadiness = {
    role: R5_SETMAT_CALLER,
    roleOid: '1789091',
    table: 'public.storage_objects',
    tableExists: true,
    schemaUsage: true,
    tableSelect: false,
    rls: false,
    forceRls: false,
    columns: R5_PREPARE_STORAGE_COLUMNS.map((name) => ({ name, select: true })),
  };
  it('accepts the six actual query column privileges without demanding full-table SELECT', () => {
    expect(() => assertR5PrepareStorageReadiness(readiness)).not.toThrow();
  });
  it.each(R5_PREPARE_STORAGE_COLUMNS)(
    'rejects missing existing-caller SELECT(%s) before fixture writes',
    (missing) => {
      expect(() =>
        assertR5PrepareStorageReadiness({
          ...readiness,
          columns: readiness.columns.map((row) => ({ ...row, select: row.name !== missing })),
        }),
      ).toThrow('permission decision required before fixture writes');
    },
  );
  it('rejects admin identity even when all reads are available', () => {
    expect(() => assertR5PrepareStorageReadiness({ ...readiness, role: 'postgres' })).toThrow();
  });
  it('rejects missing table/schema access, unknown RLS, incomplete or aliased column sets', () => {
    expect(() => assertR5PrepareStorageReadiness({ ...readiness, tableExists: false })).toThrow();
    expect(() => assertR5PrepareStorageReadiness({ ...readiness, schemaUsage: false })).toThrow();
    expect(() => assertR5PrepareStorageReadiness({ ...readiness, rls: true })).toThrow();
    expect(() => assertR5PrepareStorageReadiness({ ...readiness, forceRls: true })).toThrow();
    expect(() =>
      assertR5PrepareStorageReadiness({ ...readiness, columns: readiness.columns.slice(1) }),
    ).toThrow();
    expect(() =>
      assertR5PrepareStorageReadiness({
        ...readiness,
        columns: [...readiness.columns.slice(1), readiness.columns[1]],
      }),
    ).toThrow();
  });

  const zeroAssignments: R5FixedActorAssignmentFact[] = ['creator', 'A', 'B'].map((label) => ({
    label,
    actorExists: true,
    memberLinkExists: true,
    nonSoftDeletedAssignmentCount: 0,
  }));
  it('requires all three exact actors to retain the zero-assignment prerequisite', () => {
    expect(() => assertR5NoPolicyBranch(zeroAssignments)).not.toThrow();
  });
  it.each(['creator', 'A', 'B'])('stops if %s acquires any nondeleted assignment', (label) => {
    expect(() =>
      assertR5NoPolicyBranch(
        zeroAssignments.map((fact) => ({
          ...fact,
          nonSoftDeletedAssignmentCount: fact.label === label ? 1 : 0,
        })),
      ),
    ).toThrow('stop without adding policy privileges');
  });
  it('rejects absent actors, member links, omitted/duplicated actors and uncertain counts', () => {
    for (const changed of [
      zeroAssignments.slice(1),
      [...zeroAssignments.slice(1), zeroAssignments[1]],
      zeroAssignments.map((fact) => ({ ...fact, actorExists: false })),
      zeroAssignments.map((fact) => ({ ...fact, memberLinkExists: false })),
      zeroAssignments.map((fact) => ({ ...fact, nonSoftDeletedAssignmentCount: -1 })),
      zeroAssignments.map((fact) => ({ ...fact, nonSoftDeletedAssignmentCount: Number.NaN })),
    ]) {
      expect(() => assertR5NoPolicyBranch(changed)).toThrow();
    }
  });
  const readDependencyTables = ['storage_objects', 'User', 'organization_position_assignments'];
  it('requires the new read closure pins before fixture creation', () => {
    expect(() =>
      assertR5ReadClosureCatalog({ tables: readDependencyTables.map((name) => ({ name })) }),
    ).not.toThrow();
    expect(() =>
      assertR5ReadClosureCatalog({ tables: [{ name: 'CorrectionWritePhase' }] }),
    ).toThrow();
  });
  it.each(readDependencyTables)('rejects the old binding when the %s pin is missing', (missing) => {
    expect(() =>
      assertR5ReadClosureCatalog({
        tables: readDependencyTables.filter((name) => name !== missing).map((name) => ({ name })),
      }),
    ).toThrow('new source-qualified caller-read dependency pin missing');
  });
  it('rejects duplicate read closure rows', () => {
    expect(() =>
      assertR5ReadClosureCatalog({
        tables: [...readDependencyTables, readDependencyTables[0]].map((name) => ({ name })),
      }),
    ).toThrow();
  });
});
