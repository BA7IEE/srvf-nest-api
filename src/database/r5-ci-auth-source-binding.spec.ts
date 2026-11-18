import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  r5CiInstalledRecord,
  r5CiSourceBinding,
  R5_CI_DATABASE,
  R5_CI_ROLES,
  r5CiMigrationSources,
} from '../../test/helpers/r5-ci-source-binding';
import { humanCorrectionCatalogSha256 } from '../modules/activities/human-correction-trusted-connection';
import * as migrationInventory from '../../test/helpers/migration-inventory';

const identity = {
  database: R5_CI_DATABASE,
  databaseOid: 10,
  cluster: '12345',
  roles: Object.fromEntries(Object.values(R5_CI_ROLES).map((name, i) => [name, i + 20])),
};

describe('disposable CI source binding, no database or authentication', () => {
  it('links only independently captured identities and preserves every expected field', () => {
    const built = r5CiSourceBinding(identity);
    expect(built.base.tables).toHaveLength(26);
    expect(built.supplemental.tables).toHaveLength(4);
    expect(built.base.functions).toHaveLength(204);
    expect(built.base.databaseOid).toBe(10);
    expect(JSON.stringify(built.base)).not.toContain('CI_CALLER_ROLE_OID');
    expect(built.base.functions).toEqual(built.supplemental.functions);
    expect(built.catalogSha256).toBe(humanCorrectionCatalogSha256(built.base, built.supplemental));
    expect(built.ddl).toContain('LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog');
    expect(built.ddl).toContain('materializer role has unapproved capabilities or ownership');
    expect(built.ddl).toContain(
      'materialization dependency catalog differs from fixed source pins',
    );
  });

  it('round trips the entire SQL literal including dollar-single-quote regex endings', () => {
    const built = r5CiSourceBinding(identity);
    const start = built.ddl.indexOf("expected_catalog CONSTANT jsonb := '");
    const end = built.ddl.indexOf("'::jsonb; -- R5_COMPILED_CATALOG_LITERAL", start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const literal = built.ddl.slice(start + "expected_catalog CONSTANT jsonb := '".length, end);
    expect(JSON.parse(literal.replaceAll("''", "'"))).toEqual(built.base);
    expect(built.ddl.split('expected_catalog CONSTANT jsonb :=')).toHaveLength(2);
  });

  it('rejects foreign targets, invalid or reattached identity and missing success receipts', () => {
    expect(() => r5CiSourceBinding({ ...identity, database: 'app_test' })).toThrow();
    expect(() => r5CiSourceBinding({ ...identity, databaseOid: 0 })).toThrow();
    expect(() =>
      r5CiSourceBinding({
        ...identity,
        roles: { ...identity.roles, [R5_CI_ROLES.trusted]: identity.roles[R5_CI_ROLES.untrusted] },
      }),
    ).toThrow();
    const built = r5CiSourceBinding(identity);
    expect(() =>
      r5CiInstalledRecord(identity, built, {
        installationSha256: '',
        authenticationSha256: 'a'.repeat(64),
      }),
    ).toThrow();
  });

  it.each([0, 155])(
    'rejects migration source drift at index %s before building a binding',
    (index) => {
      const scratch = mkdtempSync(join(tmpdir(), 'r5-ci-source-'));
      try {
        for (const migration of r5CiMigrationSources()) {
          const dir = join(scratch, 'prisma/migrations', migration.name);
          mkdirSync(dir, { recursive: true });
          writeFileSync(
            join(dir, 'migration.sql'),
            readFileSync(join(process.cwd(), 'prisma/migrations', migration.name, 'migration.sql')),
          );
        }
        const first = r5CiMigrationSources()[index].name;
        writeFileSync(
          join(scratch, 'prisma/migrations', first, 'migration.sql'),
          '-- replaced source',
        );
        expect(() => r5CiSourceBinding(identity, scratch)).toThrow(
          'R5_CI_MIGRATION_SOURCE_CHANGED',
        );
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    },
  );

  it('retains the complete frozen catalog and adds only the three source-pinned guards', () => {
    const frozen = JSON.parse(
      readFileSync(join(process.cwd(), 'test/fixtures/r5-ci-source-catalog.json'), 'utf8'),
    ) as { catalogs: { base: { functions: Record<string, unknown>[] } } };
    const built = r5CiSourceBinding(identity);
    const added = new Set([
      'public.team_join_milestone_immutable()',
      'public.team_join_milestone_insert_guard()',
      'public.team_join_notice_protocol_immutable()',
    ]);
    expect(built.base.functions.filter((row) => !added.has(String(row.signature)))).toEqual(
      frozen.catalogs.base.functions,
    );
    expect(r5CiMigrationSources()).toEqual(
      migrationInventory.currentMigrationInventory().migrations,
    );
    expect(built.base.functions.filter((row) => added.has(String(row.signature)))).toHaveLength(3);
  });

  it.each([
    {
      kind: 'appended public function',
      name: '20990101000000_unreviewed_catalog',
      sql: "CREATE FUNCTION public.r5_ci_unreviewed_probe() RETURNS integer LANGUAGE sql AS 'SELECT 1';\n",
      sha256: 'd3183633f0e9fcf60155c155a04c60dfd3474001ad64e66f747c40e9b028c17a',
    },
    {
      kind: 'inserted public function',
      name: '20261101000000_unreviewed_catalog',
      sql: "CREATE FUNCTION public.r5_ci_unreviewed_probe() RETURNS integer LANGUAGE sql AS 'SELECT 1';\n",
      sha256: 'd3183633f0e9fcf60155c155a04c60dfd3474001ad64e66f747c40e9b028c17a',
    },
    {
      kind: 'migration without a function',
      name: '20990101000000_unreviewed_catalog',
      sql: 'SELECT 1;\n',
      sha256: 'b4e0497804e46e0a0b0b8c31975b062152d551bac49c3c2e80932567b4085dcd',
    },
  ])('requires binding review for a registered $kind', ({ name, sql, sha256 }) => {
    const scratch = mkdtempSync(join(tmpdir(), 'r5-ci-catalog-review-'));
    try {
      cpSync(join(process.cwd(), 'prisma/migrations'), join(scratch, 'prisma/migrations'), {
        recursive: true,
      });
      const directory = join(scratch, 'prisma/migrations', name);
      mkdirSync(directory);
      writeFileSync(join(directory, 'migration.sql'), sql);
      const reviewed = [...migrationInventory.reviewedMigrationSources(), { name, sha256 }].sort(
        (a, b) => a.name.localeCompare(b.name),
      );
      const verified = migrationInventory.verifyMigrationInventory(scratch, reviewed);
      const spy = jest
        .spyOn(migrationInventory, 'currentMigrationInventory')
        .mockReturnValue(verified);
      try {
        expect(r5CiMigrationSources(scratch)).toEqual(verified.migrations);
        expect(() => r5CiSourceBinding(identity, scratch)).toThrow('R5_CI_CATALOG_REVIEW_REQUIRED');
      } finally {
        spy.mockRestore();
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
