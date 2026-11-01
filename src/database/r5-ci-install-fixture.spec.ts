import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');
const roles = read('test/fixtures/r5-ci-sealed-roles.sql');
const probe = read('test/fixtures/r5-ci-default-closed.sql');
const roleNames = [
  'r5_boundary_owner_h7c6',
  'r5_boundary_caller_h7c6',
  'r5_mat_writer_20261029_q1',
  'r5_human_queue_login_20261030_q1',
  'r5_untrusted_caller_login_20261030_q1',
];
const code = (text: string) => text.replace(/--[^\n]*/g, '');
function job(path: string, name: string): string {
  const source = read(path);
  const marker = `\n  ${name}:\n`;
  const from = source.indexOf(marker);
  if (from < 0) throw new Error('expected workflow job absent');
  const tail = source.slice(from + marker.length);
  const next = tail.search(/\n {2}[a-z][a-z-]*:\n/);
  return next < 0 ? tail : tail.slice(0, next);
}

describe('disposable CI R5 installation fixture contract (no database)', () => {
  it('creates exactly the five source roles, sealed without privilege flags or a password', () => {
    const statements = [...code(roles).matchAll(/CREATE ROLE "([a-z0-9_]+)" ([^;]+);/g)];
    expect(statements.map((x) => x[1])).toEqual(roleNames);
    for (const [, name, attributes] of statements) {
      for (const required of [
        'NOLOGIN',
        'NOSUPERUSER',
        'NOCREATEDB',
        'NOCREATEROLE',
        'NOREPLICATION',
        'NOBYPASSRLS',
        'PASSWORD NULL',
      ])
        expect(attributes).toContain(required);
      expect(attributes.split(' ')).toContain(name === roleNames[3] ? 'INHERIT' : 'NOINHERIT');
    }
    expect(code(roles)).not.toMatch(/\b(?:LOGIN|ALTER ROLE|CREATE USER|DELETE|TRUNCATE)\b/);
  });
  it('refuses wrong/nonempty targets or preexisting identities before the first CREATE', () => {
    expect(roles).toContain("current_database() NOT IN ('app_test', 'app_smoke')");
    expect(roles).toContain("n.nspname='public'");
    expect(roles).toContain('FROM pg_catalog.pg_roles');
    expect(roles.indexOf("USING ERRCODE='42501'")).toBeLessThan(roles.indexOf('CREATE ROLE'));
  });
  it('has only the original two memberships, without admin or an inverse P edge', () => {
    const grants = [
      ...code(roles).matchAll(/GRANT "([a-z0-9_]+)" TO "([a-z0-9_]+)" WITH ([^;]+);/g),
    ];
    expect(grants).toHaveLength(6);
    expect(new Set(grants.map((x) => `${x[1]}->${x[2]}`))).toEqual(
      new Set([`${roleNames[1]}->${roleNames[3]}`, `${roleNames[1]}->${roleNames[4]}`]),
    );
    expect(grants.map((x) => x[3])).toEqual([
      'INHERIT TRUE',
      'SET TRUE',
      'ADMIN FALSE',
      'INHERIT FALSE',
      'SET TRUE',
      'ADMIN FALSE',
    ]);
    expect(roles).toContain('GRANT CONNECT ON DATABASE :"DBNAME"');
    expect(code(roles)).not.toMatch(/GRANT (?:SELECT|INSERT|UPDATE|DELETE|ALL|EXECUTE|CREATE)/);
  });
  it('executes the real NULL guard read-only and fails if it accepts or returns another error', () => {
    expect(probe).toContain('BEGIN READ ONLY;');
    expect(probe).toContain('SET LOCAL ROLE "r5_boundary_caller_h7c6";');
    expect(probe).toContain('PERFORM public.r5_correction_boundary_preflight();');
    expect(probe).toContain("WHEN SQLSTATE '55000'");
    expect(probe).toContain("SQLERRM <> 'materialization catalog pins are not bound'");
    expect(probe).toContain("ERRCODE='XX000'");
    expect(probe.trim()).toMatch(/ROLLBACK;$/);
    expect(code(probe)).not.toMatch(/\b(?:CREATE|ALTER|GRANT|INSERT|UPDATE|DELETE|TRUNCATE)\b/);
  });
  it.each([
    ['.github/workflows/ci.yml', 'slow'],
    ['.github/workflows/ci.yml', 'journeys'],
    ['.github/workflows/nightly-e2e-leaks.yml', 'e2e-leaks'],
  ])('%s %s installs sealed roles before deploy and the default-refusal probe', (path, name) => {
    const source = job(path, name);
    const start = source.indexOf('- name: Install sealed R5 CI roles');
    const bootstrap = source.slice(start, source.indexOf('\n      - name:', start + 1));
    expect(start).toBeGreaterThan(source.indexOf('run: pnpm db:test:init'));
    expect(bootstrap).toContain('test "$GITHUB_ACTIONS" = true');
    expect(bootstrap).toContain('-d app_test < test/fixtures/r5-ci-sealed-roles.sql');
    expect(bootstrap.indexOf('r5-ci-sealed-roles.sql')).toBeLessThan(
      bootstrap.indexOf('pnpm prisma:deploy'),
    );
    expect(bootstrap.indexOf('pnpm prisma:deploy')).toBeLessThan(
      bootstrap.indexOf('r5-ci-default-closed.sql'),
    );
  });
  it('the existing smoke job installs roles after database creation and checks the unchanged guard before seed', () => {
    const source = job('.github/workflows/docker-smoke.yml', 'docker-smoke');
    const positions = [
      'Create app_smoke database',
      'Install sealed R5 CI roles',
      'Apply migrations to app_smoke',
      'Verify R5 default preflight refuses',
      'Seed super admin',
    ].map((name) => source.indexOf(name));
    expect(positions.every((value) => value >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(source).toContain('-d app_smoke < test/fixtures/r5-ci-sealed-roles.sql');
    expect(source).toContain('-d app_smoke < test/fixtures/r5-ci-default-closed.sql');
  });
  it('never makes role creation an application migration, deployment entrypoint or login enable', () => {
    const migration = read(
      'prisma/migrations/20261031223000_r5_correction_set_materialization/migration.sql',
    );
    expect(code(migration)).not.toMatch(/\bCREATE ROLE\b|r5-ci-sealed-roles/);
    expect(read('.github/workflows/ci.yml')).toContain('name: Lint / Typecheck / E2E');
    expect(read('.github/workflows/ci.yml')).toContain('name: Docker image build');
    expect(read('Dockerfile')).not.toContain('r5-ci-sealed-roles');
    expect(read('src/main.ts')).not.toContain('r5-ci-sealed-roles');
  });
});
