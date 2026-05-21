import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

// V2 第一阶段批次 4-B D14 contribution prefill 计算器(单一职责)。
// 沿 PR #176 / PR #177 characterization 锁定的现状行为,从 `AttendancesService` 中
// 极小抽出(仅"搬家",不动算法);事务边界由调用方保持(继续在
// `AttendancesService.submit(...)` 的 `this.prisma.$transaction(...)` 内调用)。
//
// 详见 docs:
//   - 批次4_贡献值业务规则前评审决议表 v1.0(D5 候选 B 终审 / D11 推动 / D14 5.B 预填)
//   - 批次4_贡献值业务规则_API草案 v1.0(D-A8)
//   - 批次4_贡献值业务规则_schema草案评审决议表 v1.0(D-S11)
//
// **职责边界(严守"搬家不优化")**:
// - ✅ 三态分发 + ContributionRule 查表 + 档位 / cap 计算
// - ❌ 不写 audit / 不动 Activity / 不创建 Sheet / Record / 不做 dict 校验
// - ❌ 不做时间重叠校验 / 不做 serviceHours normalization
// - ❌ 不持有 PrismaService(沿调用方 tx,事务边界一致)

type PrismaTx = Prisma.TransactionClient;

// 计算器入参的最小结构性约束:只声明 prefill 真正读 / 写的 3 个字段。
// 其余字段经泛型 T 整体透传(沿 service 原 normalized record 范式),
// 避免把 NormalizedRecord 类型从 service 大规模导出(沿迁移要求第 5 条)。
type PrefillRecordLike = {
  roleCode: string;
  serviceHours: number;
  contributionPoints?: number | null;
};

@Injectable()
export class ContributionCalculator {
  // 默认日上限 1.5(沿 Q-OPEN-7 锁定;ContributionRule.dailyCap === null 时兜底)。
  private readonly DEFAULT_DAILY_CAP = 1.5;

  // 批次 4-B D14 5.B 预填(沿 D-S4 / D-A8 / 业务规则文档 §4)。
  // 输入:normalized records + activityTypeCode;
  // 输出:applied records(contributionPoints 已按规则预填或保持调用方传入值)。
  //
  // 入参三态处理(沿 D-A8 + v0.6 契约小修复):
  //   undefined → 走预填(匹配规则取值;无匹配规则 → null)
  //   null      → 调用方显式清空,跳过预填,保持 null(APD 在 approve 前现场填入)
  //   number    → 调用方已传值,不覆盖
  //
  // 规则匹配维度:
  //   (activityTypeCode, attendanceRoleCode, durationThreshold) WHERE deletedAt IS NULL AND status='ACTIVE'
  // 服务时长档位(若规则 durationThreshold 非 null):
  //   record.serviceHours <= rule.durationThreshold → 取 rule.pointsBelow
  //   record.serviceHours >  rule.durationThreshold → 取 rule.pointsAbove ?? pointsBelow
  // 服务时长无档位(rule.durationThreshold === null):
  //   直接取 rule.pointsBelow(pointsAbove 不参与)
  // 每日上限:rule.dailyCap 兜底 1.5(沿 Q-OPEN-7 / D-S3);
  //   预填值 = MIN(candidatePoints, effectiveDailyCap)。
  //
  // NULL durationThreshold 选取(沿 §3.1 复核报告):
  //   ORDER BY createdAt ASC LIMIT 1(明确,不随机)。
  //
  // 无匹配规则:保持 contributionPoints = null(不抛错;沿 D-S11 22048 不开)。
  async applyContributionRulePrefill<T extends PrefillRecordLike>(
    records: T[],
    activityTypeCode: string,
    tx: PrismaTx,
  ): Promise<T[]> {
    const result: T[] = [];
    for (const r of records) {
      // 显式 null = 跳过预填(v0.6 契约小修复);number = 已传值,不覆盖
      if (r.contributionPoints !== undefined) {
        result.push(r);
        continue;
      }
      // undefined = 走预填
      const points = await this.computePrefilledPoints(
        activityTypeCode,
        r.roleCode,
        r.serviceHours,
        tx,
      );
      result.push({ ...r, contributionPoints: points });
    }
    return result;
  }

  private async computePrefilledPoints(
    activityTypeCode: string,
    attendanceRoleCode: string,
    serviceHours: number,
    tx: PrismaTx,
  ): Promise<number | null> {
    const candidates = await tx.contributionRule.findMany({
      where: {
        activityTypeCode,
        attendanceRoleCode,
        status: 'ACTIVE',
        deletedAt: null,
      },
      select: {
        durationThreshold: true,
        pointsBelow: true,
        pointsAbove: true,
        dailyCap: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'asc' },
    });
    if (candidates.length === 0) {
      return null;
    }
    // 优先匹配 record.serviceHours 落入档位的规则;若多条候选(同维度多规则)按 createdAt ASC 取首条。
    // 实际唯一约束(partial unique)已限制非 NULL durationThreshold 唯一;NULL 档位可能多条,沿 §3.1 复核取首条。
    let chosen: (typeof candidates)[number] | null = null;
    for (const rule of candidates) {
      if (rule.durationThreshold === null) {
        // NULL 档位:无服务时长阈值,优先取首条;若 chosen 未设则赋值
        if (chosen === null) chosen = rule;
        continue;
      }
      // 非 NULL 档位:按 durationThreshold 匹配;首条匹配即取
      if (chosen === null) chosen = rule;
    }
    if (chosen === null) {
      chosen = candidates[0];
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
    const effectiveCap =
      chosen.dailyCap !== null ? Number(chosen.dailyCap) : this.DEFAULT_DAILY_CAP;
    const finalPoints = Math.min(candidatePoints, effectiveCap);
    // 保留 2 位小数(对齐 Decimal(5,2))
    return Math.round(finalPoints * 100) / 100;
  }
}
