import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { notDeletedWhere } from '../../common/prisma/soft-delete.util';

// V2 第一阶段批次 3B R16 / Q-S15 时间不重叠校验(单一职责)。
// 沿 PR #176 / PR #177 / PR #179 characterization 锁定的现状行为,从 `AttendancesService` 中
// 极小抽出(仅"搬家",不动算法);事务边界由调用方保持(继续在
// `AttendancesService.submit(...)` / `edit(...)` 的 `this.prisma.$transaction(...)` 内调用)。
//
// **职责边界(严守"搬家不优化")**:
// - ✅ 同 batch 内 per-memberId 的内部重叠 pre-DB 校验
// - ✅ 跨 Sheet / 跨 Activity 全局 [start, end) 左闭右开重叠校验(带 excludeSheetId)
// - ❌ 不写 audit / 不动 Activity / 不创建 Sheet / Record / 不做 dict 校验
// - ❌ 不做 serviceHours normalization / 不做 contribution prefill / 不处理状态机
// - ❌ 不持有 PrismaService(沿调用方 tx,事务边界一致)

type PrismaTx = Prisma.TransactionClient;

// Policy 入参的最小结构性约束:internal 校验只读 memberId / checkInAt / checkOutAt 3 个字段。
// 通过泛型 T 整体透传,避免把 service 内 NormalizedRecord 类型大规模导出。
type OverlapRecordLike = {
  memberId: string;
  checkInAt: Date;
  checkOutAt: Date;
};

@Injectable()
export class TimeOverlapPolicy {
  // finding #7:同一 member 的重叠检查与后续写入必须在事务内串行。
  // 去重排序后用一条 SQL 批量取 PostgreSQL transaction advisory lock，查询次数不随成员数增长；
  // SQL 内 ORDER BY 保证跨 batch 取锁顺序一致，避免反向取锁死锁。
  async lockMembersForOverlapCheck(memberIds: readonly string[], tx: PrismaTx): Promise<void> {
    const orderedIds = [...new Set(memberIds)].sort();
    if (orderedIds.length === 0) return;
    await tx.$queryRaw<Array<{ locked: string }>>(
      Prisma.sql`
        SELECT pg_advisory_xact_lock(hashtext(member_id))::text AS locked
        FROM (VALUES ${Prisma.join(orderedIds.map((memberId) => Prisma.sql`(${memberId})`))})
          AS member_ids(member_id)
        ORDER BY member_id
      `,
    );
  }

  // 时间不重叠校验(R16 / Q-S15):同 memberId × [checkInAt, checkOutAt) 左闭右开
  // 跨 Sheet / 跨 Activity 全局,deletedAt IS NULL。
  // excludeSheetId:edit 时排除旧 Sheet 的 records(因为它们将被替换)。
  async assertNoTimeOverlap(
    memberId: string,
    checkInAt: Date,
    checkOutAt: Date,
    excludeSheetId: string | undefined,
    tx: PrismaTx,
  ): Promise<void> {
    const conflicts = await tx.attendanceRecord.findMany({
      where: notDeletedWhere({
        memberId,
        ...(excludeSheetId !== undefined ? { sheetId: { not: excludeSheetId } } : {}),
        AND: [{ checkInAt: { lt: checkOutAt } }, { checkOutAt: { gt: checkInAt } }],
      }),
      select: { id: true },
      take: 1,
    });
    if (conflicts.length > 0) {
      throw new BizException(BizCode.ATTENDANCE_TIME_OVERLAP);
    }
  }

  // F4:一次查询覆盖整批 records，避免每条 record 各发一次 findMany。
  async assertNoTimeOverlapForRecords(
    records: readonly OverlapRecordLike[],
    excludeSheetId: string | undefined,
    tx: PrismaTx,
  ): Promise<void> {
    if (records.length === 0) return;
    const conflict = await tx.attendanceRecord.findFirst({
      where: notDeletedWhere({
        ...(excludeSheetId !== undefined ? { sheetId: { not: excludeSheetId } } : {}),
        OR: records.map((record) => ({
          memberId: record.memberId,
          checkInAt: { lt: record.checkOutAt },
          checkOutAt: { gt: record.checkInAt },
        })),
      }),
      select: { id: true },
    });
    if (conflict) {
      throw new BizException(BizCode.ATTENDANCE_TIME_OVERLAP);
    }
  }

  // 同一 records 数组内自检不重叠(R16:同 batch 也不能内部冲突)。
  assertNoInternalOverlap<T extends OverlapRecordLike>(records: T[]): void {
    const byMember = new Map<string, Array<{ start: number; end: number }>>();
    for (const r of records) {
      const arr = byMember.get(r.memberId) ?? [];
      const start = r.checkInAt.getTime();
      const end = r.checkOutAt.getTime();
      for (const e of arr) {
        if (start < e.end && end > e.start) {
          throw new BizException(BizCode.ATTENDANCE_TIME_OVERLAP);
        }
      }
      arr.push({ start, end });
      byMember.set(r.memberId, arr);
    }
  }
}
