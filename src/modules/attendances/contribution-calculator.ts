import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

// V2 第一阶段批次 4-B D14 contribution prefill 计算器(单一职责)。
// 沿 PR #176 / PR #177 characterization 锁定的现状行为,从 `AttendancesService` 中
// 极小抽出(仅"搬家",不动算法);事务边界由调用方保持(继续在
// `AttendancesService.submit(...)` 的 `this.prisma.$transaction(...)` 内调用)。
//
// 详见 docs:
//   - 批次4_贡献值业务规则前评审决议表 v1.0(D5 候选 B 终审 / D11 历史项已由 D2-a 撤销 / D14 5.B 预填)
//   - 批次4_贡献值业务规则_API草案 v1.0(D-A8)
//   - 批次4_贡献值业务规则_schema草案评审决议表 v1.0(D-S11)
//
// **职责边界**:
// - ✅ ContributionRule 查表 + 档位 / cap 计算
// - ❌ 不写 audit / 不动 Activity / 不创建 Sheet / Record / 不做 dict 校验
// - ❌ 不做时间重叠校验 / 不做 serviceHours normalization
// - ❌ 不持有 PrismaService(沿调用方 tx,事务边界一致)

type PrismaTx = Prisma.TransactionClient;

// 计算器入参的最小结构性约束:只声明计算真正读的 2 个字段。
// 其余字段经泛型 T 整体透传(沿 service 原 normalized record 范式),
// 避免把 NormalizedRecord 类型从 service 大规模导出(沿迁移要求第 5 条)。
type PrefillRecordLike = {
  roleCode: string;
  serviceHours: number;
};

@Injectable()
export class ContributionCalculator {
  // 批次 4-B D14 5.B 预填(沿 D-S4 / D-A8 / 业务规则文档 §4)。
  // 输入:normalized records + activityTypeCode;
  // 输出:applied records(contributionPoints 必由规则计算;无匹配规则保守为 0)。
  //
  // 规则匹配维度:
  //   (activityTypeCode, attendanceRoleCode) WHERE deletedAt IS NULL AND status='ACTIVE'
  //   合法状态下每个 pair 恰有 0 或 1 条；若数据库漂移返回多条，立即 fail-closed，绝不选首条/末条。
  // 服务时长档位(若规则 durationThreshold 非 null):
  //   record.serviceHours <= rule.durationThreshold → 取 rule.pointsBelow
  //   record.serviceHours >  rule.durationThreshold → 取 rule.pointsAbove ?? pointsBelow
  // 服务时长无档位(rule.durationThreshold === null):
  //   直接取 rule.pointsBelow(pointsAbove 不参与)
  // 每日封顶(活动闭环硬化 2026-06-21):本计算器不再 per-record 钳制;预填 = candidatePoints 原始规则分。
  //   全局每日上限改落汇总处(team-join `computeContribution`:按北京日分组封顶
  //   GLOBAL_DAILY_CONTRIBUTION_CAP=3);ContributionRule.dailyCap 列保留但本计算器不再读。
  //
  // 无匹配规则:contributionPoints = 0(不抛错;沿 D-S11 22048 不开)。
  async applyContributionRulePrefill<T extends PrefillRecordLike>(
    records: T[],
    activityTypeCode: string,
    tx: PrismaTx,
  ): Promise<Array<T & { contributionPoints: number }>> {
    const rolesNeedingPrefill = [...new Set(records.map((record) => record.roleCode))];
    const candidates =
      rolesNeedingPrefill.length === 0
        ? []
        : await tx.contributionRule.findMany({
            where: {
              activityTypeCode,
              attendanceRoleCode: { in: rolesNeedingPrefill },
              status: 'ACTIVE',
              deletedAt: null,
            },
            select: {
              attendanceRoleCode: true,
              durationThreshold: true,
              pointsBelow: true,
              pointsAbove: true,
            },
          });
    const candidateByRole = new Map<string, (typeof candidates)[number]>();
    for (const candidate of candidates) {
      if (candidateByRole.has(candidate.attendanceRoleCode)) {
        throw new Error(
          `ContributionRule ACTIVE pair invariant violated: ${activityTypeCode} × ${candidate.attendanceRoleCode}`,
        );
      }
      candidateByRole.set(candidate.attendanceRoleCode, candidate);
    }

    const result: Array<T & { contributionPoints: number }> = [];
    for (const r of records) {
      const points = this.computePrefilledPoints(candidateByRole.get(r.roleCode), r.serviceHours);
      result.push({ ...r, contributionPoints: points });
    }
    return result;
  }

  private computePrefilledPoints(
    chosen:
      | {
          durationThreshold: Prisma.Decimal | null;
          pointsBelow: Prisma.Decimal;
          pointsAbove: Prisma.Decimal | null;
        }
      | undefined,
    serviceHours: number,
  ): number {
    if (!chosen) {
      return 0;
    }
    const threshold = chosen.durationThreshold;
    let candidatePoints: number;
    if (threshold === null) {
      candidatePoints = Number(chosen.pointsBelow);
    } else if (serviceHours <= Number(threshold)) {
      candidatePoints = Number(chosen.pointsBelow);
    } else {
      candidatePoints =
        chosen.pointsAbove !== null ? Number(chosen.pointsAbove) : Number(chosen.pointsBelow);
    }
    // 活动闭环硬化(2026-06-21):去掉每条记录的 dailyCap 钳制,预填回归原始规则分。
    // 全局每日封顶改落汇总处 team-join computeContribution(按北京日分组封顶),不再 per-record MIN。
    // 保留 2 位小数(对齐 Decimal(5,2))。
    return Math.round(candidatePoints * 100) / 100;
  }
}
