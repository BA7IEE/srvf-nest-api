import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../database/prisma.service';
import { decimalToHundredths, fromHundredths } from './ledger-day-allocation';

// ===== 活动改造 v1.1 第 2 批第五刀:账本读面(合同 §3.22)=====
//
// 🔴 §3.22 逐字:「准备中和 ready 分录**必须对所有正常读面不可见**。只允许通过
//    `batch.statusCode='committed'` join 后读取。」
//
// ## 为什么要有这个类(而不是让各读面自己写 where)
//
// 「不可见」是一条**否定性**要求 —— 它无法靠"某处写对了"来保证,只能靠
// **所有读面都不自己写 SQL**。所以本类是账本的**唯一**读入口:每个方法都
// 无条件 join `LedgerPostingBatch` 并钉死 `statusCode = 'committed'`,
// 调用方拿不到"要不要过滤"这个开关(没有 includeUncommitted 之类的参数)。
//
// ⇒ 判据是可变红的:把任一处的 `b."statusCode" = 'committed'` 去掉,
//   `test/e2e/activity-ledger-posting.e2e-spec.ts` ③「commit 前查不到」当场红。
//
// ⚠️ 本刀**零端点**(整条流程入口留到第 2 批收尾),所以此刻本类的调用方只有 e2e ——
//    与前四刀「零调用方是预期状态」同源。它先存在,是为了让收尾那一刀**没有理由**
//    另写一份直查 `ParticipationLedgerEntry` 的 SQL。
//
// ⚠️ 本类**只读**,不进事务、不写库;方法签名收 `tx` 是为了让调用方能在自己的事务里
//    读到一致快照(如关账校验),不是为了写。

/** 一条已生效的账本分录(对外投影;不含内部指针如 requestHash / operationKey)。 */
export interface CommittedLedgerEntryView {
  entryKey: string;
  postingBatchId: string;
  memberId: string;
  activityId: string;
  sessionId: string;
  participationIdentityId: string;
  resultRevisionId: string;
  /** `YYYY-MM-DD`(北京自然日,§3.21)。 */
  ledgerDate: string;
  entryTypeCode: string;
  serviceHoursDelta: number;
  recognizedPointsDelta: number;
  creditedPointsDelta: number;
  cappedOutPointsDelta: number;
}

export interface MemberDayContributionView {
  memberId: string;
  ledgerDate: string;
  serviceHours: number;
  creditedPoints: number;
}

type PrismaLike = Pick<Prisma.TransactionClient, '$queryRaw'>;

@Injectable()
export class LedgerQueryService {
  constructor(private readonly prisma: PrismaService) {}

  /** 某活动下**已生效**的全部分录(按队员、日期、类型稳定排序)。 */
  async listCommittedEntriesForActivity(
    activityId: string,
    client?: PrismaLike,
  ): Promise<CommittedLedgerEntryView[]> {
    const rows = await (client ?? this.prisma).$queryRaw<Array<RawEntryRow>>`
      SELECT e."entryKey", e."postingBatchId", e."memberId", e."activityId", e."sessionId",
             e."participationIdentityId", e."resultRevisionId",
             to_char(e."ledgerDate", 'YYYY-MM-DD') AS "ledgerDate",
             e."entryTypeCode",
             e."serviceHoursDelta"::text AS "serviceHoursDelta",
             e."recognizedPointsDelta"::text AS "recognizedPointsDelta",
             e."creditedPointsDelta"::text AS "creditedPointsDelta",
             e."cappedOutPointsDelta"::text AS "cappedOutPointsDelta"
      FROM "ParticipationLedgerEntry" e
      JOIN "LedgerPostingBatch" b ON b.id = e."postingBatchId"
      WHERE e."activityId" = ${activityId}
        AND b."statusCode" = 'committed'
      ORDER BY e."memberId" ASC, e."ledgerDate" ASC, e."entryTypeCode" ASC
    `;
    return rows.map(toEntryView);
  }

  /** 某队员**已生效**的全部分录。 */
  async listCommittedEntriesForMember(
    memberId: string,
    client?: PrismaLike,
  ): Promise<CommittedLedgerEntryView[]> {
    const rows = await (client ?? this.prisma).$queryRaw<Array<RawEntryRow>>`
      SELECT e."entryKey", e."postingBatchId", e."memberId", e."activityId", e."sessionId",
             e."participationIdentityId", e."resultRevisionId",
             to_char(e."ledgerDate", 'YYYY-MM-DD') AS "ledgerDate",
             e."entryTypeCode",
             e."serviceHoursDelta"::text AS "serviceHoursDelta",
             e."recognizedPointsDelta"::text AS "recognizedPointsDelta",
             e."creditedPointsDelta"::text AS "creditedPointsDelta",
             e."cappedOutPointsDelta"::text AS "cappedOutPointsDelta"
      FROM "ParticipationLedgerEntry" e
      JOIN "LedgerPostingBatch" b ON b.id = e."postingBatchId"
      WHERE e."memberId" = ${memberId}
        AND b."statusCode" = 'committed'
      ORDER BY e."ledgerDate" ASC, e."activityId" ASC, e."entryTypeCode" ASC
    `;
    return rows.map(toEntryView);
  }

  /**
   * 某队员按**北京自然日**汇总的已生效服务时长与贡献值。
   *
   * ⚠️ 这一份**直接从分录求和**,不读 `MemberContributionDayState.committedCreditedPoints`
   *    那个物化列。两者应当恒等 —— 让读面走分录、让物化列只服务于生效时的上限判定,
   *    等于给"物化列漂了"留了一条可发现的路(e2e ⑥ 正面比对两者相等)。
   */
  async sumCommittedByDayForMember(
    memberId: string,
    client?: PrismaLike,
  ): Promise<MemberDayContributionView[]> {
    const rows = await (client ?? this.prisma).$queryRaw<
      Array<{ memberId: string; ledgerDate: string; serviceHours: string; creditedPoints: string }>
    >`
      SELECT e."memberId",
             to_char(e."ledgerDate", 'YYYY-MM-DD') AS "ledgerDate",
             SUM(e."serviceHoursDelta")::text AS "serviceHours",
             SUM(e."creditedPointsDelta")::text AS "creditedPoints"
      FROM "ParticipationLedgerEntry" e
      JOIN "LedgerPostingBatch" b ON b.id = e."postingBatchId"
      WHERE e."memberId" = ${memberId}
        AND b."statusCode" = 'committed'
      GROUP BY e."memberId", e."ledgerDate"
      ORDER BY e."ledgerDate" ASC
    `;
    return rows.map((row) => ({
      memberId: row.memberId,
      ledgerDate: row.ledgerDate,
      serviceHours: fromHundredths(decimalToHundredths(row.serviceHours)),
      creditedPoints: fromHundredths(decimalToHundredths(row.creditedPoints)),
    }));
  }
}

interface RawEntryRow {
  entryKey: string;
  postingBatchId: string;
  memberId: string;
  activityId: string;
  sessionId: string;
  participationIdentityId: string;
  resultRevisionId: string;
  ledgerDate: string;
  entryTypeCode: string;
  serviceHoursDelta: string;
  recognizedPointsDelta: string;
  creditedPointsDelta: string;
  cappedOutPointsDelta: string;
}

function toEntryView(row: RawEntryRow): CommittedLedgerEntryView {
  return {
    entryKey: row.entryKey,
    postingBatchId: row.postingBatchId,
    memberId: row.memberId,
    activityId: row.activityId,
    sessionId: row.sessionId,
    participationIdentityId: row.participationIdentityId,
    resultRevisionId: row.resultRevisionId,
    ledgerDate: row.ledgerDate,
    entryTypeCode: row.entryTypeCode,
    serviceHoursDelta: fromHundredths(decimalToHundredths(row.serviceHoursDelta)),
    recognizedPointsDelta: fromHundredths(decimalToHundredths(row.recognizedPointsDelta)),
    creditedPointsDelta: fromHundredths(decimalToHundredths(row.creditedPointsDelta)),
    cappedOutPointsDelta: fromHundredths(decimalToHundredths(row.cappedOutPointsDelta)),
  };
}
