import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { PageResultDto } from '../../common/dto/pagination.dto';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import { AuthzService } from '../authz/authz.service';
import { RbacService } from '../permissions/rbac.service';
import { AppIdentityResolver } from '../users/app-identity.resolver';
import type { AdminParticipationLedgerEntryDto } from './dto/admin/admin-participation-ledger.dto';
import type { ListAdminMemberParticipationLedgerQueryDto } from './dto/admin/admin-settlement-read.dto';
import type {
  AppParticipationLedgerEntryDto,
  ListAppMyParticipationLedgerQueryDto,
} from './dto/app/app-participation-ledger.dto';
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
// ⑨b 把三个 HTTP 读面接进本类；Controller 只能调用这里的公开方法，不能自己访问
// `ParticipationLedgerEntry` 或再写一份 `$queryRaw`。这样 `committed` 不是某个 endpoint
// "记得加的筛选"，而是唯一数据访问层无法关闭的结构条件。
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

/**
 * 账本读面权限口径（维护者 2026-08-06 显式决定，**不是**合同推导）：合同 §6.11 未规定
 * 读权限码。账本由考勤数据推算，能看原始考勤即可推出账本，故 Admin 两条账本轴复用
 * `attendance.read.sheet`。影响：该码绑定较广，通用管理角色及多个只读角色的持码者现在
 * 都能看贡献值账本；若日后要收紧，必须另立权限码并连带三处 seed spec。
 *
 * App self 端点仍只按当前登录身份解析 member，不因这个 Admin 决定取得跨主体读取能力。
 */
const LEDGER_READ_ACTION = 'attendance.read.sheet';

@Injectable()
export class LedgerQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authz: AuthzService,
    private readonly rbac: RbacService,
    private readonly appIdentity: AppIdentityResolver,
  ) {}

  /** App self surface：memberId 只从当前登录身份解析，调用方没有可传入的主体参数。 */
  async listForCurrentMember(
    query: ListAppMyParticipationLedgerQueryDto,
    currentUser: CurrentUserPayload,
  ): Promise<PageResultDto<AppParticipationLedgerEntryDto>> {
    const access = await this.appIdentity.resolve(currentUser);
    if (!access.canUseApp || access.member === null) {
      throw new BizException(BizCode.FORBIDDEN);
    }
    const page = await this.listCommittedEntriesForMemberPage(access.member.id, {
      page: query.page,
      pageSize: query.pageSize,
      ...(query.activityId === undefined ? {} : { activityId: query.activityId }),
    });
    return {
      ...page,
      items: page.items.map((entry) => this.toAppEntry(entry)),
    };
  }

  /** Admin member axis：先按 member resource 判权，再查主体，保持无权时不存在/存在同一拒绝。 */
  async listForAdminMember(
    memberId: string,
    query: ListAdminMemberParticipationLedgerQueryDto,
    currentUser: CurrentUserPayload,
  ): Promise<PageResultDto<AdminParticipationLedgerEntryDto>> {
    await this.assertCanReadMember(currentUser, memberId);
    const member = await this.prisma.member.findFirst({
      where: { id: memberId, deletedAt: null },
      select: { id: true },
    });
    if (member === null) throw new BizException(BizCode.MEMBER_NOT_FOUND);

    const page = await this.listCommittedEntriesForMemberPage(memberId, {
      page: query.page,
      pageSize: query.pageSize,
      ...(query.dateFrom === undefined ? {} : { dateFrom: query.dateFrom }),
      ...(query.dateTo === undefined ? {} : { dateTo: query.dateTo }),
    });
    return { ...page, items: page.items.map((entry) => this.toAdminEntry(entry)) };
  }

  /** Admin activity axis：带 activity resource 的既有 attendance.read.sheet 判权。 */
  async listForAdminActivity(
    activityId: string,
    query: { page: number; pageSize: number },
    currentUser: CurrentUserPayload,
  ): Promise<PageResultDto<AdminParticipationLedgerEntryDto>> {
    await this.assertCanReadActivity(currentUser, activityId);
    const activity = await this.prisma.activity.findFirst({
      where: { id: activityId, deletedAt: null },
      select: { id: true },
    });
    if (activity === null) throw new BizException(BizCode.ACTIVITY_NOT_FOUND);

    const page = await this.listCommittedEntriesForActivityPage(activityId, query);
    return { ...page, items: page.items.map((entry) => this.toAdminEntry(entry)) };
  }

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

  /** 活动轴分页读取；`committed` join 与无分页读取同源且没有 bypass 开关。 */
  async listCommittedEntriesForActivityPage(
    activityId: string,
    query: { page: number; pageSize: number },
  ): Promise<PageResultDto<CommittedLedgerEntryView>> {
    const offset = (query.page - 1) * query.pageSize;
    const [rows, countRows] = await Promise.all([
      this.prisma.$queryRaw<Array<RawEntryRow>>(Prisma.sql`
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
        ORDER BY e."memberId" ASC, e."ledgerDate" ASC, e."entryTypeCode" ASC, e."entryKey" ASC
        LIMIT ${query.pageSize} OFFSET ${offset}
      `),
      this.prisma.$queryRaw<Array<{ total: number }>>(Prisma.sql`
        SELECT COUNT(*)::int AS "total"
        FROM "ParticipationLedgerEntry" e
        JOIN "LedgerPostingBatch" b ON b.id = e."postingBatchId"
        WHERE e."activityId" = ${activityId}
          AND b."statusCode" = 'committed'
      `),
    ]);
    return {
      items: rows.map(toEntryView),
      total: countRows[0]?.total ?? 0,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  /** 队员轴分页读取；可选 activity/date 过滤仍只能在 committed join 之后取数。 */
  async listCommittedEntriesForMemberPage(
    memberId: string,
    query: {
      page: number;
      pageSize: number;
      activityId?: string;
      dateFrom?: string;
      dateTo?: string;
    },
  ): Promise<PageResultDto<CommittedLedgerEntryView>> {
    const offset = (query.page - 1) * query.pageSize;
    const activityFilter =
      query.activityId === undefined
        ? Prisma.empty
        : Prisma.sql`AND e."activityId" = ${query.activityId}`;
    const dateFromFilter =
      query.dateFrom === undefined
        ? Prisma.empty
        : Prisma.sql`AND e."ledgerDate" >= ${toLedgerDate(query.dateFrom)}`;
    const dateToFilter =
      query.dateTo === undefined
        ? Prisma.empty
        : Prisma.sql`AND e."ledgerDate" <= ${toLedgerDate(query.dateTo)}`;
    const [rows, countRows] = await Promise.all([
      this.prisma.$queryRaw<Array<RawEntryRow>>(Prisma.sql`
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
          ${activityFilter}
          ${dateFromFilter}
          ${dateToFilter}
        ORDER BY e."ledgerDate" ASC, e."activityId" ASC, e."entryTypeCode" ASC, e."entryKey" ASC
        LIMIT ${query.pageSize} OFFSET ${offset}
      `),
      this.prisma.$queryRaw<Array<{ total: number }>>(Prisma.sql`
        SELECT COUNT(*)::int AS "total"
        FROM "ParticipationLedgerEntry" e
        JOIN "LedgerPostingBatch" b ON b.id = e."postingBatchId"
        WHERE e."memberId" = ${memberId}
          AND b."statusCode" = 'committed'
          ${activityFilter}
          ${dateFromFilter}
          ${dateToFilter}
      `),
    ]);
    return {
      items: rows.map(toEntryView),
      total: countRows[0]?.total ?? 0,
      page: query.page,
      pageSize: query.pageSize,
    };
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

  private async assertCanReadActivity(
    currentUser: CurrentUserPayload,
    activityId: string,
  ): Promise<void> {
    const action = LEDGER_READ_ACTION;
    const decision = await this.authz.explain(currentUser, action, {
      type: 'activity',
      id: activityId,
    });
    if (decision.allow) return;
    if (decision.reason === 'resource_not_found' && (await this.rbac.can(currentUser, action))) {
      return;
    }
    throw new BizException(BizCode.RBAC_FORBIDDEN);
  }

  private async assertCanReadMember(
    currentUser: CurrentUserPayload,
    memberId: string,
  ): Promise<void> {
    const action = LEDGER_READ_ACTION;
    const decision = await this.authz.explain(currentUser, action, {
      type: 'member',
      id: memberId,
    });
    if (decision.allow) return;
    if (decision.reason === 'resource_not_found' && (await this.rbac.can(currentUser, action))) {
      return;
    }
    throw new BizException(BizCode.RBAC_FORBIDDEN);
  }

  private toAdminEntry(entry: CommittedLedgerEntryView): AdminParticipationLedgerEntryDto {
    return { ...entry };
  }

  private toAppEntry(entry: CommittedLedgerEntryView): AppParticipationLedgerEntryDto {
    return {
      entryKey: entry.entryKey,
      activityId: entry.activityId,
      sessionId: entry.sessionId,
      participationIdentityId: entry.participationIdentityId,
      ledgerDate: entry.ledgerDate,
      entryTypeCode: entry.entryTypeCode,
      serviceHoursDelta: entry.serviceHoursDelta,
      recognizedPointsDelta: entry.recognizedPointsDelta,
      creditedPointsDelta: entry.creditedPointsDelta,
      cappedOutPointsDelta: entry.cappedOutPointsDelta,
    };
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

function toLedgerDate(value: string): Date {
  return new Date(`${value.slice(0, 10)}T00:00:00.000Z`);
}
