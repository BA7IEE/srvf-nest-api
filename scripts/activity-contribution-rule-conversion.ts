/** E2 first-layer CLI: fixed synthetic fixture only; never a real-rule conversion entry. */
import { UserStatus } from '@prisma/client';
import { PrismaService } from '../src/database/prisma.service';
import { RbacService } from '../src/modules/permissions/rbac.service';
import { AuditLogsService } from '../src/modules/audit-logs/audit-logs.service';
import { ActivityContributionPolicyCommand } from '../src/modules/activities/activity-contribution-policy-command';
import { ActivityContributionRuleConversionAuditRecorder } from '../src/modules/activities/activity-contribution-rule-conversion-audit-recorder';
import { ActivityContributionRuleConversionService } from '../src/modules/activities/activity-contribution-rule-conversion.service';
import { ContributionRuleConversionSourceQuery } from '../src/modules/contribution-rules/contribution-rule-conversion-source.query';
import { assertConnectedTestDatabase, assertTestDatabaseUrl } from '../test/setup/test-db';
import { loadTestEnv } from '../test/setup/load-env';

function argument(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index < 0 ? null : (process.argv[index + 1] ?? null);
}

async function main(): Promise<void> {
  const flags = process.argv.slice(2);
  if (flags.includes('--help')) {
    process.stdout.write(
      'E2 fixture-only: --actor-id <w98 fixture user> [--commit --expected-source-fingerprint <sha256>]\n',
    );
    return;
  }
  const allowed = new Set(['--actor-id', '--commit', '--expected-source-fingerprint']);
  if (
    flags.some((value, index) => value.startsWith('--') && !allowed.has(value)) ||
    !argument('--actor-id') ||
    (flags.includes('--commit') &&
      !/^[a-f0-9]{64}$/u.test(argument('--expected-source-fingerprint') ?? ''))
  ) {
    throw new Error('Invalid E2 fixture CLI arguments');
  }
  process.env.JEST_WORKER_ID = '98';
  loadTestEnv();
  assertTestDatabaseUrl(process.env.DATABASE_URL);
  const prisma = new PrismaService();
  try {
    await prisma.$connect();
    await assertConnectedTestDatabase(prisma);
    const actor = await prisma.user.findFirst({
      where: { id: argument('--actor-id')!, status: UserStatus.ACTIVE, deletedAt: null },
      select: { id: true, username: true, role: true, status: true, memberId: true },
    });
    if (!actor) throw new Error('Fixture actor is not active');
    const rbac = new RbacService(prisma);
    const commands = new ActivityContributionPolicyCommand(prisma, rbac);
    const audit = new ActivityContributionRuleConversionAuditRecorder(
      new AuditLogsService(prisma, rbac),
    );
    const service = new ActivityContributionRuleConversionService(
      prisma,
      commands,
      audit,
      new ContributionRuleConversionSourceQuery(),
    );
    const fixture = {
      activityTypeCode: 'e2_fixture_example',
      policyCode: 'e2_fixture_policy',
      policyName: 'E2 isolated fixture',
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
    if (flags.includes('--commit')) {
      const result = await service.commitFixture(
        { ...fixture, expectedSourceFingerprint: argument('--expected-source-fingerprint')! },
        actor,
        { requestId: 'e2-fixture-cli', ip: null, ua: null },
      );
      process.stdout.write(`Fixture candidate ${result.replayed ? 'replayed' : 'created'}\n`);
    } else {
      const result = await service.dryRunFixture(fixture, actor);
      process.stdout.write(
        `Fixture dry-run: sourceCount=${result.sourceCount} sourceFingerprint=${result.sourceFingerprint}\n`,
      );
    }
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `E2 fixture conversion refused: ${error instanceof Error ? error.name : 'unknown'}\n`,
  );
  process.exitCode = 1;
});
