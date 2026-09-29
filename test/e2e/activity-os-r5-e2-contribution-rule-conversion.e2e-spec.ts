import type { INestApplication } from '@nestjs/common';
import { Role } from '@prisma/client';
import { execFileSync } from 'node:child_process';
import type { CurrentUserPayload } from '../../src/common/decorators/current-user.decorator';
import { PrismaService } from '../../src/database/prisma.service';
import { ActivityContributionRuleConversionService } from '../../src/modules/activities/activity-contribution-rule-conversion.service';
import { CONTRIBUTION_POLICY_PERMISSION_SEED } from '../../src/modules/permissions/permission-catalog';
import { createTestUser } from '../fixtures/users.fixture';
import { loadTestEnv } from '../setup/load-env';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';
import {
  assertConnectedTestDatabase,
  assertTestDatabaseUrl,
  dropWorkerDatabase,
} from '../setup/test-db';
import { deriveTestDbName } from '../setup/worktree-db';

// The capability is deliberately restricted to w98; CI workers must use that fixture too.
const USE_DEDICATED_W98 = true;
const meta = { requestId: 'e2-fixture-e2e', ip: null, ua: null };

describe('E2 isolated fixture conversion', () => {
  const previous = { worker: process.env.JEST_WORKER_ID, url: process.env.DATABASE_URL };
  let app: INestApplication;
  let db: PrismaService;
  let service: ActivityContributionRuleConversionService;
  let actor: CurrentUserPayload;

  beforeAll(async () => {
    if (USE_DEDICATED_W98) {
      process.env.JEST_WORKER_ID = '98';
      loadTestEnv();
      assertTestDatabaseUrl(process.env.DATABASE_URL);
      dropWorkerDatabase('98');
      execFileSync(
        'docker',
        ['exec', 'u-nest-api-postgres', 'createdb', '-U', 'postgres', deriveTestDbName()],
        { stdio: 'pipe' },
      );
    }
    assertTestDatabaseUrl(process.env.DATABASE_URL);
    execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
      env: process.env,
      stdio: 'pipe',
    });
    app = await createTestApp();
    db = app.get(PrismaService);
    service = app.get(ActivityContributionRuleConversionService);
    await assertConnectedTestDatabase(db);
    await resetDb(app);
    for (const permission of CONTRIBUTION_POLICY_PERMISSION_SEED) {
      await db.permission.upsert({
        where: { code: permission.code },
        create: { ...permission },
        update: {},
      });
    }
    actor = await createTestUser(app, { username: 'e2_fixture_actor', role: Role.USER });
    const role = await db.rbacRole.create({
      data: { code: 'e2_fixture_role', displayName: 'E2 fixture role' },
    });
    const permission = await db.permission.findUniqueOrThrow({
      where: { code: 'contribution-policy.manage.version' },
    });
    await db.rolePermission.create({ data: { roleId: role.id, permissionId: permission.id } });
    await db.roleBinding.create({
      data: {
        principalType: 'USER',
        principalId: actor.id,
        roleId: role.id,
        scopeType: 'GLOBAL',
      },
    });
    await db.contributionRule.create({
      data: {
        activityTypeCode: 'e2_fixture_example',
        attendanceRoleCode: 'volunteer',
        durationThreshold: '4.00',
        pointsBelow: '1.00',
        pointsAbove: null,
      },
    });
  }, 120000);

  afterAll(async () => {
    if (app) await app.close();
    if (USE_DEDICATED_W98) {
      try {
        dropWorkerDatabase('98');
      } finally {
        if (previous.worker === undefined) delete process.env.JEST_WORKER_ID;
        else process.env.JEST_WORKER_ID = previous.worker;
        if (previous.url === undefined) delete process.env.DATABASE_URL;
        else process.env.DATABASE_URL = previous.url;
      }
    }
  }, 120000);

  const input = {
    activityTypeCode: 'e2_fixture_example',
    policyCode: 'e2_fixture_policy',
    policyName: 'E2 fixture policy',
    effectiveFrom: '2026-09-25T00:00:00.000Z',
    mapping: {
      activityTypeCode: 'e2_fixture_example',
      timeCategoryCode: 'volunteer_service' as const,
      defaultResult: { recognizedPoints: '0.00', explanationCode: 'fixture_no_rule' },
      roleMappings: [
        {
          sourceRoleCode: 'volunteer',
          targetRoleCode: 'volunteer',
          belowExplanationCode: 'fixture_below',
          aboveExplanationCode: 'fixture_above',
        },
      ],
    },
  };

  it('dry-runs, commits one draft and one source receipt, then replays without new audit', async () => {
    const dryRun = await service.dryRunFixture(input, actor);
    expect(dryRun.sourceCount).toBe(1);
    expect(dryRun.sourceFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    const first = await service.commitFixture(
      { ...input, expectedSourceFingerprint: dryRun.sourceFingerprint },
      actor,
      meta,
    );
    expect(first.replayed).toBe(false);
    expect(await db.contributionRuleConversionReceipt.count()).toBe(1);
    const version = await db.contributionPolicyVersion.findUniqueOrThrow({
      where: { id: first.versionId },
    });
    expect(version.statusCode).toBe('draft');
    const auditCount = await db.auditLog.count({
      where: { event: 'activity.contribution-rule.conversion' },
    });
    expect(auditCount).toBe(1);
    await expect(
      service.commitFixture(
        { ...input, expectedSourceFingerprint: dryRun.sourceFingerprint },
        actor,
        meta,
      ),
    ).resolves.toEqual({ ...first, replayed: true });
    expect(await db.contributionRuleConversionReceipt.count()).toBe(1);
    expect(
      await db.auditLog.count({ where: { event: 'activity.contribution-rule.conversion' } }),
    ).toBe(auditCount);
  });

  it('never converts a real directory type or an altered source revision', async () => {
    await expect(
      service.dryRunFixture(
        {
          ...input,
          activityTypeCode: 'rescue_mission',
          mapping: { ...input.mapping, activityTypeCode: 'rescue_mission' },
        },
        actor,
      ),
    ).rejects.toThrow();
    const before = await db.contributionRuleConversionReceipt.count();
    await expect(
      service.commitFixture({ ...input, expectedSourceFingerprint: 'f'.repeat(64) }, actor, meta),
    ).rejects.toThrow();
    expect(await db.contributionRuleConversionReceipt.count()).toBe(before);
  });
});
