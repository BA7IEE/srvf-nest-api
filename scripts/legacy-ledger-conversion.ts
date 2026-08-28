/**
 * 存量考勤账本化转换 CLI(P1-28 第 7 批② A 案)—— 维护者 SOP 执行体。
 *
 * ⚠️ 本脚本不在 harness/redzone.json 的任何 selfGuard glob 内(不是裁判,是写方),
 * 判闸位在 `ActivityWorkflowGate.assertLegacyLedgerConversionAllowed()`(20159):
 * 只在「停旧写之后、开闸之前」的只读维护窗放行 —— 详见
 * docs/ops/legacy-attendance-ledger-conversion.md(SOP)与
 * docs/ai-harness/LEGACY_LEDGER_CONVERSION_DRAFT.md(施工依据)。
 *
 * 用法(需 .env 指向目标库,且该实例 ACTIVITY_WORKFLOW_READONLY=true):
 *   pnpm exec tsx scripts/legacy-ledger-conversion.ts --actor-user-id <维护者用户id> [--activity-id <id>]
 *   --activity-id 省略 = 扫全量候选活动(有 approved 考勤且无 v1.1 run 的活动)逐个转换。
 *
 * 输出:逐活动一行结论(converted / already-converted / nothing-to-convert /
 * skipped-new-chain-history)+ D1 零窗兜底与 D2 合成报名头的逐条点名;
 * 任一活动转换失败即停止(fail-closed),不吞错继续。
 */
import { NestFactory } from '@nestjs/core';

import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/database/prisma.service';
import { Role, UserStatus } from '@prisma/client';
import type { CurrentUserPayload } from '../src/common/decorators/current-user.decorator';
import { LegacyLedgerConversionService } from '../src/modules/activities/legacy-ledger-conversion.service';

interface CliArgs {
  actorUserId: string;
  activityId?: string;
}

function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = { actorUserId: '' };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--actor-user-id') args.actorUserId = argv[i + 1] ?? '';
    else if (argv[i] === '--activity-id') args.activityId = argv[i + 1];
    i += 0;
  }
  if (args.actorUserId === '') {
    console.error('用法: --actor-user-id <维护者用户id> 必填(审计归属);--activity-id 可选');
    process.exit(2);
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  try {
    const prisma = app.get(PrismaService);
    const conversion = app.get(LegacyLedgerConversionService);

    const actor = await prisma.user.findUnique({ where: { id: args.actorUserId } });
    if (actor === null) {
      console.error(`--actor-user-id ${args.actorUserId} 不存在`);
      process.exit(2);
    }
    const currentUser: CurrentUserPayload = {
      id: actor.id,
      username: actor.username,
      role: actor.role as Role,
      status: actor.status as UserStatus,
      memberId: actor.memberId,
    };
    const auditMeta = {
      requestId: `legacy-ledger-conversion:${new Date().toISOString()}`,
      ip: null,
      ua: 'legacy-ledger-conversion-cli',
    };

    const activityIds =
      args.activityId !== undefined
        ? [args.activityId]
        : (
            await prisma.attendanceSheet.findMany({
              where: { deletedAt: null, statusCode: 'approved' },
              select: { activityId: true },
              distinct: ['activityId'],
            })
          ).map((row) => row.activityId);

    console.log(`候选活动 ${activityIds.length} 个`);
    for (const activityId of activityIds) {
      const outcome = await conversion.convertActivity({ activityId, currentUser, auditMeta });
      if (outcome.status === 'converted') {
        console.log(
          `[converted] ${activityId}:批次 ${outcome.postingBatchId} / ${outcome.memberCount} 人 / ` +
            `${outcome.identityCount} 身份 / ${outcome.entryCount} 分录 / ${outcome.dayRowCount} 日行`,
        );
        for (const head of outcome.synthesizedRegistrationHeads) {
          console.log(`  [D2 合成报名头] ${head}`);
        }
        for (const fallback of outcome.fallbackSessionMappings) {
          console.log(
            `  [D1 零窗兜底] member=${fallback.memberId} record=${fallback.recordId} ` +
              `checkInAt=${fallback.checkInAt.toISOString()} -> session=${fallback.sessionId}`,
          );
        }
      } else {
        console.log(`[${outcome.status}] ${activityId}: ${outcome.detail}`);
      }
    }
    console.log('完成');
  } finally {
    await app.close();
  }
}

void main().catch((error: unknown) => {
  console.error('转换失败(fail-closed,已停止):', error);
  process.exit(1);
});
