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
import { decimalToHundredths, fromHundredths, hundredthsToDecimal } from './ledger-day-allocation';

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

/**
 * 队员账本口径的两轴小计(第 7 批第 ②-a 刀)。
 *
 * 值是 `Prisma.Decimal` 字符串,与 participation-summary 既有的 `totalServiceHours` /
 * `contributionPoints` **同一种渲染**(`Decimal.toString()`),以免同一张卡片上两个数
 * 一个写 `6`、一个写 `6.00`。
 *
 * 🔴 空集恒为 `'0'`,**不是** `null`、不是缺字段(§6.1 通用合同禁 undefined/null/'' 混义)。
 */
export interface MemberLedgerTotalsView {
  /** 服务时长小计。 */
  serviceHours: string;
  /** 贡献值小计(credited 口径,即封顶**后**的分)。 */
  creditedPoints: string;
}

/**
 * 一个队员的「已生效 / 在途」四个数 —— 各读面直接照抄进各自 DTO 的形状。
 *
 * 故意做成**扁平**而不是 `{committed:{...}, inFlight:{...}}`:读面 DTO 有 Admin / App 两份
 * 物理独立的类(D-6),扁平四个 string 字段两边可以逐字相同,嵌套则要再各造两个类。
 */
export interface MemberLedgerTotalsBreakdown {
  committedServiceHours: string;
  committedContributionPoints: string;
  inFlightServiceHours: string;
  inFlightContributionPoints: string;
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

  // ===== 第 7 批第 ②-a 刀:「已生效 / 在途」两轴小计(只加显示,不动任何既有取数)=====
  //
  // ## 为什么这里可以读 preparing / ready,而 §3.22 说「必须不可见」
  //
  // §3.22 逐字管的是**分录**:「准备中和 ready **分录**必须对所有正常读面不可见。
  // 只允许通过 `batch.statusCode='committed'` join 后读取。」下面这个方法**不返回任何分录**
  // —— 没有 entryKey、没有 ledgerDate、没有逐条金额,拿不到任何可枚举的行,只有一个标量小计。
  // 分录级不可见性因此**一寸未让**:上面三条 list* 方法仍是全仓唯一的分录出口,仍钉死 committed。
  //
  // 而「要有一个在途数字」是维护者 2026-08-19 的拍板(活文档 NEXT_TASKS P1-28:「须同时给出
  // 『已生效 / 在途』两个口径,**数字不合并、但让人看得见**」)。按根规则文件 §0 的权威源顺序,
  // 当前事实(活文档)高于 `docs/archive/**` 里的合同稿 —— archive 是历史证据不是当前事实。
  // 两者在本刀的交集就是:**给标量,不给分录**。
  //
  // ⚠️ 与 AC-054(「页面和统计只能看见 0% 或 100% 的正式结果,看不到半批生效」)的关系:
  //    AC-054 约束的是**正式结果**的原子性。已生效那一轴仍然只有 0%/100%(commit 是一个事务),
  //    本刀一个字没碰。在途那一轴按定义**不是**正式结果,故不在 AC-054 的措辞内。
  //    诚实说明:批次停在 `preparing` 时分录是逐条 INSERT 的,故在途小计在准备期间会**逐步长大**
  //    —— 那是「在途正在准备」的真实进度,不是「半批生效」。

  /**
   * 某队员**已生效**(committed)的两轴小计。
   *
   * 🔴 本方法**没有第四条 committed SQL**:它把既有的 `sumCommittedByDayForMember` 折一次。
   *    理由是本刀红线 ——「已生效」必须复用既有 committed-only 取数,而不是另开一份「我也记得
   *    过滤 committed」的查询。后者一旦有人改错,两份口径会各说各话,而本文件那条
   *    「committed 字面量恰三处」的结构判据也会跟着失去含义。
   */
  /**
   * 「已生效 / 在途」四个数一次取齐 —— **全部读面共用这一个入口**。
   *
   * 🔴 「7 个端点口径一致」因此是**结构性**的,不是三个 controller 各自记得调同一对方法:
   *    算这四个数的地方全仓只有这一处,想让某个端点用另一套算法必须先新写一个方法。
   *    正对照钉在 `test/e2e/activity-batch7-in-flight-display.e2e-spec.ts`
   *    ——同一个队员同时打 App 面与两条 Admin 面,四个值整包相等。
   */
  async loadMemberLedgerTotals(
    memberId: string,
    client?: PrismaLike,
  ): Promise<MemberLedgerTotalsBreakdown> {
    const [committed, inFlight] = await Promise.all([
      this.sumCommittedTotalsForMember(memberId, client),
      this.sumInFlightTotalsForMember(memberId, client),
    ]);
    return {
      committedServiceHours: committed.serviceHours,
      committedContributionPoints: committed.creditedPoints,
      inFlightServiceHours: inFlight.serviceHours,
      inFlightContributionPoints: inFlight.creditedPoints,
    };
  }

  async sumCommittedTotalsForMember(
    memberId: string,
    client?: PrismaLike,
  ): Promise<MemberLedgerTotalsView> {
    return foldDayTotals(await this.sumCommittedByDayForMember(memberId, client));
  }

  /**
   * 某队员**在途**的两轴小计 —— 已终审、批次停在 `preparing`/`ready`、尚未入账的部分。
   *
   * 🔴 与 committed 那一轴**互不相交是结构性的**,不靠约定:一条分录只有一个 `postingBatchId`,
   *    一个批次只有一个 `statusCode`,而 `'committed'` 与 `('preparing','ready')` 不相交
   *    ⇒ 同一条分录不可能同时落进两个小计。
   *
   * ⚠️ 「在途」**不等于**「已审批考勤里还没入账的全部」:批次要到终审才存在,所以
   *    「考勤已审批、但结算还没走到终审」的那一段**两个小计都不计**。它仍然落在既有四个数字
   *    (approved 考勤口径)里 —— 这正是本刀不合并数字的原因,推导见 PR 说明。
   *
   * 状态字面量直接写死在 SQL 里、**不收状态入参** —— 收了就等于给调用方一个
   * `includeUncommitted` 开关,那正是 #949 明确堵死的形状。
   */
  async sumInFlightTotalsForMember(
    memberId: string,
    client?: PrismaLike,
  ): Promise<MemberLedgerTotalsView> {
    const rows = await (client ?? this.prisma).$queryRaw<
      Array<{ serviceHours: string; creditedPoints: string }>
    >`
      SELECT COALESCE(SUM(e."serviceHoursDelta"), 0)::text AS "serviceHours",
             COALESCE(SUM(e."creditedPointsDelta"), 0)::text AS "creditedPoints"
      FROM "ParticipationLedgerEntry" e
      JOIN "LedgerPostingBatch" b ON b.id = e."postingBatchId"
      WHERE e."memberId" = ${memberId}
        AND b."statusCode" IN ('preparing', 'ready')
    `;
    const row = rows[0];
    // 聚合查询恒返一行;驱动层万一给了空数组,也必须是 0 而不是 undefined。
    if (row === undefined) return { ...EMPTY_LEDGER_TOTALS };
    return {
      serviceHours: toTotalsString(row.serviceHours),
      creditedPoints: toTotalsString(row.creditedPoints),
    };
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

/** 空集的两轴小计 —— 恒返 `'0'`,不返 null、不缺字段。 */
const EMPTY_LEDGER_TOTALS: MemberLedgerTotalsView = { serviceHours: '0', creditedPoints: '0' };

/** 与既有四个数字同一种渲染:`Decimal.toString()`(PG 的 `6.00` 渲染成 `6`)。 */
function toTotalsString(raw: string): string {
  return new Prisma.Decimal(raw).toString();
}

/**
 * 按日行 → 两轴小计。**整数分累加**,不用浮点 —— `sumCommittedByDayForMember` 返回的是
 * `number`(已除以 100),几百天直接 `+=` 会在末位漂出 `5.000000000000001` 这种字符串。
 */
function foldDayTotals(days: readonly MemberDayContributionView[]): MemberLedgerTotalsView {
  let serviceHundredths = 0;
  let creditedHundredths = 0;
  for (const day of days) {
    serviceHundredths += decimalToHundredths(day.serviceHours);
    creditedHundredths += decimalToHundredths(day.creditedPoints);
  }
  return {
    serviceHours: hundredthsToDecimal(serviceHundredths).toString(),
    creditedPoints: hundredthsToDecimal(creditedHundredths).toString(),
  };
}
