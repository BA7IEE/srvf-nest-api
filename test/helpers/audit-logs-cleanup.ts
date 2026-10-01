import type { INestApplication } from '@nestjs/common';
import { PrismaService } from '../../src/database/prisma.service';
import { assertConnectedTestDatabase, assertTestDatabaseUrl } from '../setup/test-db';

// V2 第一阶段批次 6 audit_logs 单表清理 helper(D6 v1.1 §12.1 / D-E 拍板)。
//
// 用途:e2e 在 beforeEach / afterEach / spec 内中间点 TRUNCATE audit_logs,
// 避免一个测试块写入的审计记录污染下一个测试块的 list 断言。
//
// 红线(D6 v1.1 §12.1):
// - 测试库**豁免** audit_logs DELETE 红线(audit_logs 在生产代码层是写入后不可删,
//   但 e2e 必须能清表)
// - 生产代码层无 trigger 限制 DELETE,红线仅由 controller 不开放 DELETE 接口实现(F10)
// - 本 helper 内部双保险:
//   (1) assertTestDatabaseUrl 强制 DATABASE_URL 含 'app_test'(沿 test/setup/test-db.ts)
//   (2) APP_ENV 必须 !== 'production'(防御性,即便测试库 URL 检查通过)
// - 命名带 test-only 含义:**仅 test/ 引用,生产代码绝不可调用**;
//   AI / 维护者发现 src/ 内 import 本 helper,应立即拒绝
//
// 物理表名:`audit_logs`(Prisma `@@map("audit_logs")`;小写带下划线)。
// E3-2 D1 起，五张 shadow 证据表中的 Attempt / Disposition 引用 audit_logs。
// D2 新增来源表与三张 mapping 证据表；清理必须在同一受控测试事务内
// 显式清子表，并逐个恢复已有 no-truncate trigger 的原始状态。
// RESTART IDENTITY 对 cuid 主键无效,留作防御。
export async function truncateAuditLogsTestOnly(app: INestApplication): Promise<void> {
  assertTestDatabaseUrl(process.env.DATABASE_URL);
  if (process.env.APP_ENV === 'production') {
    throw new Error(
      'truncateAuditLogsTestOnly 拒绝在 APP_ENV=production 下执行;此 helper 仅供 e2e 使用',
    );
  }

  const prisma = app.get(PrismaService);
  await assertConnectedTestDatabase(prisma);
  await prisma.$transaction(
    async (tx) => {
      const triggers = [
        ['ContributionShadowObservationWindow', 'csow_no_truncate'],
        ['ContributionShadowAttemptReceipt', 'csar_no_truncate'],
        ['ContributionShadowLegacySourceAnchor', 'cslsa_no_truncate'],
        ['ContributionShadowComparisonReceipt', 'cscr_no_truncate'],
        ['ContributionShadowTerminalReceipt', 'cstr_no_truncate'],
        ['ContributionShadowDispositionReceipt', 'csdr_no_truncate'],
      ] as const;
      const mappingTriggers = [
        ['ContributionShadowMappingApproval', 'csma_no_truncate'],
        ['ContributionShadowMappingApplication', 'csmap_no_truncate'],
        ['ContributionShadowMappingRegistrationReceipt', 'csmrr_no_truncate'],
      ] as const;
      const previous: Array<{ table: string; trigger: string; enabled: string }> = [];
      for (const [table, trigger] of [...triggers, ...mappingTriggers]) {
        const rows = await tx.$queryRawUnsafe<Array<{ enabled: string | null }>>(
          `SELECT t.tgenabled::text AS enabled FROM pg_class c
             JOIN pg_namespace n ON n.oid=c.relnamespace AND n.nspname='public'
             LEFT JOIN pg_trigger t ON t.tgrelid=c.oid AND t.tgname=$1 AND NOT t.tgisinternal
             WHERE c.relname=$2`,
          trigger,
          table,
        );
        if (rows.length === 0) continue;
        const enabled = rows[0].enabled;
        if (enabled === null || !['O', 'D', 'A', 'R'].includes(enabled)) {
          throw new Error('Shadow fixture no-truncate trigger missing or invalid');
        }
        await tx.$executeRawUnsafe(`ALTER TABLE "${table}" DISABLE TRIGGER "${trigger}"`);
        previous.push({ table, trigger, enabled });
      }
      const mappingPrevious = previous.filter(({ trigger }) =>
        mappingTriggers.some(([, name]) => name === trigger),
      );
      const basePrevious = previous.filter((row) => !mappingPrevious.includes(row));
      const legacyFive =
        basePrevious.length === triggers.length - 1 &&
        !basePrevious.some(({ table }) => table === 'ContributionShadowLegacySourceAnchor');
      if (basePrevious.length !== 0 && basePrevious.length !== triggers.length && !legacyFive) {
        throw new Error('Incomplete shadow fixture tables');
      }
      if (
        (mappingPrevious.length !== 0 && mappingPrevious.length !== mappingTriggers.length) ||
        (mappingPrevious.length !== 0 && basePrevious.length !== triggers.length)
      ) {
        throw new Error('Incomplete shadow mapping fixture tables');
      }
      const mappingTables = mappingPrevious.length
        ? '"ContributionShadowMappingApplication", "ContributionShadowMappingRegistrationReceipt", "ContributionShadowMappingApproval", '
        : '';
      await tx.$executeRawUnsafe(
        basePrevious.length === 0
          ? 'TRUNCATE TABLE "audit_logs" RESTART IDENTITY CASCADE'
          : basePrevious.length === triggers.length
            ? `TRUNCATE TABLE ${mappingTables}"ContributionShadowDispositionReceipt", "ContributionShadowTerminalReceipt", "ContributionShadowComparisonReceipt", "ContributionShadowLegacySourceAnchor", "ContributionShadowAttemptReceipt", "ContributionShadowObservationWindow", "audit_logs" RESTART IDENTITY CASCADE`
            : 'TRUNCATE TABLE "ContributionShadowDispositionReceipt", "ContributionShadowTerminalReceipt", "ContributionShadowComparisonReceipt", "ContributionShadowAttemptReceipt", "ContributionShadowObservationWindow", "audit_logs" RESTART IDENTITY CASCADE',
      );
      for (const { table, trigger, enabled } of previous) {
        const clause =
          enabled === 'D'
            ? 'DISABLE'
            : enabled === 'A'
              ? 'ENABLE ALWAYS'
              : enabled === 'R'
                ? 'ENABLE REPLICA'
                : 'ENABLE';
        await tx.$executeRawUnsafe(`ALTER TABLE "${table}" ${clause} TRIGGER "${trigger}"`);
        const restored = await tx.$queryRawUnsafe<Array<{ enabled: string }>>(
          `SELECT t.tgenabled::text AS enabled FROM pg_trigger t
             JOIN pg_class c ON c.oid=t.tgrelid
             JOIN pg_namespace n ON n.oid=c.relnamespace AND n.nspname='public'
             WHERE c.relname=$1 AND t.tgname=$2 AND NOT t.tgisinternal`,
          table,
          trigger,
        );
        if (restored.length !== 1 || restored[0].enabled !== enabled) {
          throw new Error('Shadow fixture trigger restoration failed');
        }
      }
    },
    { timeout: 30_000 },
  );
}
