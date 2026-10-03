import {
  acquireScratchDatabaseLease,
  type ScratchLeaseSession,
} from '../helpers/scratch-database-lease';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { shadowReconciliationManifestHash } from '../../src/modules/attendances/contribution-shadow-reconciliation-command';
import { loadTestEnv } from '../setup/load-env';
import { assertTestDatabaseUrl } from '../setup/test-db';
import { deriveWorkerTestDbName, deriveTestDbName } from '../setup/worktree-db';

const MIGRATION = '20261002170000_activity_os_r5_e3_reconciliation_signature';
const PREDECESSOR = '20260930120000_activity_os_r5_e3_shadow_mapping_proof';
const ROOT = join(process.cwd(), 'prisma');
function sql(statement: string): string {
  assertTestDatabaseUrl(process.env.DATABASE_URL);
  if (deriveTestDbName() !== deriveWorkerTestDbName(98))
    throw new Error('D3 migration requires exact w98');
  return execFileSync(
    'docker',
    [
      'exec',
      '-i',
      'u-nest-api-postgres',
      'psql',
      '--no-psqlrc',
      '-qtA',
      '-U',
      'postgres',
      '-d',
      deriveTestDbName(),
      '-v',
      'ON_ERROR_STOP=1',
    ],
    { input: statement, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
  ).trim();
}
function deploy(schema = join(ROOT, 'schema.prisma')) {
  assertTestDatabaseUrl(process.env.DATABASE_URL);
  execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy', '--schema', schema], {
    env: process.env,
    stdio: 'pipe',
  });
}
function rejected(statement: string, marker: string) {
  let message = '';
  try {
    sql(statement);
  } catch (error) {
    if (typeof error !== 'object' || error === null || !('stderr' in error)) throw error;
    message = String(error.stderr);
  }
  expect(message).toContain(marker);
}
function oldSnapshot() {
  return sql(`SELECT jsonb_build_object('user',(SELECT to_jsonb(u) FROM "User" u WHERE id='d3-legacy-human'),
    'window',(SELECT to_jsonb(w) FROM "ContributionShadowObservationWindow" w WHERE id='d3-legacy-window'),
    'audit',(SELECT to_jsonb(a) FROM audit_logs a WHERE id='d3-legacy-audit'),
    'disposition',(SELECT to_jsonb(d)-'approvalReceiptId' FROM "ContributionShadowDispositionReceipt" d WHERE id='d3-legacy-disposition'))`);
}

describe('D3 nonempty 135→136 upgrade, additive checksums and default-closed DB surface (w98)', () => {
  let scratchLease: ScratchLeaseSession | undefined;
  const original = { worker: process.env.JEST_WORKER_ID, url: process.env.DATABASE_URL };
  let originalFacts: string;
  beforeAll(async () => {
    scratchLease = await acquireScratchDatabaseLease();
    process.env.JEST_WORKER_ID = '98';
    loadTestEnv();
    assertTestDatabaseUrl(process.env.DATABASE_URL);
    await scratchLease.dropDatabase();
    await scratchLease.createDatabase();
    const temporary = mkdtempSync(join(tmpdir(), 'srvf-d3-upgrade-'));
    try {
      mkdirSync(join(temporary, 'migrations'));
      copyFileSync(join(ROOT, 'schema.prisma'), join(temporary, 'schema.prisma'));
      copyFileSync(
        join(ROOT, 'migrations', 'migration_lock.toml'),
        join(temporary, 'migrations', 'migration_lock.toml'),
      );
      const names = readdirSync(join(ROOT, 'migrations'), { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name <= PREDECESSOR)
        .map((entry) => entry.name)
        .sort();
      expect(names).toHaveLength(135);
      expect(names.at(-1)).toBe(PREDECESSOR);
      for (const name of names)
        cpSync(join(ROOT, 'migrations', name), join(temporary, 'migrations', name), {
          recursive: true,
          force: false,
          errorOnExist: true,
        });
      deploy(join(temporary, 'schema.prisma'));
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
    sql(`BEGIN;
      INSERT INTO "User" (id,username,"passwordHash","updatedAt") VALUES ('d3-legacy-human','d3-legacy-human','fixture',CURRENT_TIMESTAMP);
      INSERT INTO "ContributionShadowObservationWindow" (id,"startsAt","endsAt","registeredByUserId","deploymentDigest","configDigest","signedMappingVersion","hashAlgorithmCode","canonicalVersion")
        VALUES ('d3-legacy-window','2099-01-01','2099-01-02','d3-legacy-human',repeat('a',64),repeat('b',64),'d3-legacy-v1','sha256',1);
      INSERT INTO audit_logs (id,"createdAt","resourceType","resourceId",event,context)
        VALUES ('d3-legacy-audit','2099-01-01 01:00','attendance_sheet','d3-legacy-sheet','attendance-sheet.submit','{"extra":{"operation":"submit"}}');
      INSERT INTO "ContributionShadowDispositionReceipt" (id,"windowId","auditLogId",revision,"decisionCode","signedByUserId","evidenceHash","hashAlgorithmCode","canonicalVersion")
        VALUES ('d3-legacy-disposition','d3-legacy-window','d3-legacy-audit',1,'unresolved','d3-legacy-human',repeat('c',64),'sha256',1);
      COMMIT;`);
    originalFacts = oldSnapshot();
    deploy();
  }, 120_000);
  afterAll(async () => {
    try {
      if (scratchLease) await scratchLease.dropDatabase();
    } finally {
      if (original.worker === undefined) delete process.env.JEST_WORKER_ID;
      else process.env.JEST_WORKER_ID = original.worker;
      if (original.url === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = original.url;
      await scratchLease?.release();
    }
  });
  it('preserves all nonempty old facts and does not manufacture approved evidence', () => {
    expect(oldSnapshot()).toBe(originalFacts);
    expect(sql('SELECT count(*) FROM "ContributionShadowWindowRegistrationReceipt"')).toBe('0');
    expect(sql('SELECT count(*) FROM "ContributionShadowDispositionApprovalReceipt"')).toBe('0');
    expect(
      sql('SELECT "approvalReceiptId" IS NULL FROM "ContributionShadowDispositionReceipt"'),
    ).toBe('t');
    const summary = JSON.parse(sql(`SELECT csd3_read_summary_fn('d3-legacy-window')`)) as unknown;
    expect(summary).toMatchObject({
      candidateCount: 1,
      rawMissingStartCount: 1,
      rawUnresolvedCount: 1,
      notApplicableCount: 0,
      netUnresolvedCount: 1,
    });
  });
  it('contains exactly 136 successful files with every installed checksum matching disk', () => {
    const names = readdirSync(join(ROOT, 'migrations'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(names).toHaveLength(136);
    expect(names[134]).toBe(PREDECESSOR);
    expect(names[135]).toBe(MIGRATION);
    expect(
      sql(
        'SELECT migration_name || chr(9) || checksum FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name',
      ).split('\n'),
    ).toEqual(
      names.map(
        (name) =>
          name +
          '\t' +
          createHash('sha256')
            .update(readFileSync(join(ROOT, 'migrations', name, 'migration.sql')))
            .digest('hex'),
      ),
    );
  });
  it('keeps current authority off and exposes no D3 private executor to PUBLIC', () => {
    expect(sql('SELECT csd3_authority_fn() IS NULL')).toBe('t');
    expect(
      sql(`SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace,
      LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl
      WHERE n.nspname='public' AND p.proname IN ('csd3_register_fn','csd3_candidate_evidence_fn','csd3_read_candidates_fn','csd3_read_candidate_fn','csd3_read_summary_fn')
        AND acl.grantee=0 AND acl.privilege_type='EXECUTE'`),
    ).toBe('0');
    rejected(
      `SELECT csd3_register_fn('{}'::jsonb,'d3-legacy-human','forged',NULL,'forged-audit')`,
      'authority',
    );
  });
  it.each([
    'ContributionShadowWindowRegistrationReceipt',
    'ContributionShadowDispositionApprovalReceipt',
  ])('rejects unapproved insertion and truncation of %s', (table) => {
    rejected(`INSERT INTO "${table}" (id) VALUES ('forged')`, 'authority');
    rejected(`TRUNCATE TABLE "${table}" CASCADE`, 'append-only');
  });
  it('retains the historical unresolved-only branch and does not accept free-hash not_applicable', () => {
    rejected(
      `INSERT INTO "ContributionShadowDispositionReceipt" (id,"windowId","auditLogId",revision,"previousDispositionId","decisionCode","signedByUserId","evidenceHash","hashAlgorithmCode","canonicalVersion")
      VALUES ('d3-legacy-forged','d3-legacy-window','d3-legacy-audit',2,'d3-legacy-disposition','not_applicable','d3-legacy-human',repeat('d',64),'sha256',1)`,
      'requires signed decision proof',
    );
    sql(`BEGIN; INSERT INTO "ContributionShadowDispositionReceipt" (id,"windowId","auditLogId",revision,"previousDispositionId","decisionCode","signedByUserId","evidenceHash","hashAlgorithmCode","canonicalVersion")
      VALUES ('d3-legacy-revision','d3-legacy-window','d3-legacy-audit',2,'d3-legacy-disposition','unresolved','d3-legacy-human',repeat('d',64),'sha256',1); ROLLBACK;`);
    expect(oldSnapshot()).toBe(originalFacts);
  });
  it('matches SQL/app canonical manifest hashing and rejects unknown fields without connecting the CLI', () => {
    const manifest = {
      schemaVersion: 1 as const,
      operation: 'register_window' as const,
      commandKey: 'fixture-command',
      approvalReference: 'D3-FIXTURE',
      windowId: 'fixture-window',
      startsAt: '2099-01-01T00:00:00.000Z',
      endsAt: '2099-01-02T00:00:00.000Z',
      deploymentDigest: 'a'.repeat(64),
      configDigest: 'b'.repeat(64),
      signedMappingVersion: 'fixture-v1',
    };
    expect(sql(`SELECT csd3_manifest_hash_fn('${JSON.stringify(manifest)}'::jsonb)`)).toBe(
      shadowReconciliationManifestHash(manifest),
    );
    rejected(
      `SELECT csd3_manifest_hash_fn('${JSON.stringify({ ...manifest, actorUserId: 'forged' })}'::jsonb)`,
      'manifest',
    );
  });
});
