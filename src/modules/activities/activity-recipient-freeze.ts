import { DictItemStatus, DictTypeStatus, MemberStatus, type Prisma } from '@prisma/client';

import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { resolveOrganizationSubtreeMemberIds } from '../organizations/organization-audience-scope';
import { DICT_TYPE_MEMBER_AUDIENCE_TAG } from './activity-publish-review-access';

type PrismaTx = Prisma.TransactionClient;

/**
 * 活动通知的**收件人冻结**(合同 §14 第 7 批第一条「冻结收件人快照」)。
 *
 * ## 为什么要冻结
 *
 * 通知的收件人过去在**每一次算的时候**重新算。活动的人是会变的:有人退出、被撤权、
 * 标签被改、账号被软删。同一个业务事件被重放时重算,会得到**另一批人** ——
 * 于是「这条通知当初到底发给了谁」谁也说不清,审计上是个洞。
 *
 * 冻结 = 收件人集合在 intent 落库的**同一事务**里算定并盖章,之后一律读回,不重算。
 *
 * ## 存储形态(D1 要求「自行设计并给理由」)
 *
 * 🔴 **不新建表、不新增列** —— 那是 D 档,本刀不自行升档。快照拆成两半存进**既有**
 * `notification_outbox_intents`:
 *
 *   - **收件人集合**:本就是「每人一行 intent」,成员稳定标识落在既有 `destinationRef`
 *     列上(该表有 `(aggregateType, aggregateId)` 索引可回捞)。整个集合再复制进每一行
 *     是 O(N²) —— 万人活动约 2.5GB,合同 §0.4 死线正是不许把万人任务撑爆。
 *   - **计算依据 / 计算时刻 / 算法版本号 / 集合基数**:落在既有 `payload` JSON 的
 *     `recipientFreeze` 可选键上,O(1)/行。
 *
 * 代价说清楚:集合是**派生查询**而不是单行记录。所以盖章里必须带 `cohortSize` ——
 * 没有它,「回捞到 3 行」和「本该 5 行只写进去 3 行」长得一模一样。有了它,少写、
 * 多写、被后来的一批污染,三种情况都能当场看出来。
 *
 * ## 三道锁,缺一不可
 *
 * 1. **同事务**:本模块每个函数都强制收 `tx`,拿不到事务就编译不过 —— 与本仓 Outbox
 *    铁律(producer 在业务事务内同写 intent)同一处置。
 * 2. **回读优先于重算**:`freeze()` 先按 `cohortKey` 回捞既有 intent;捞到就返回**那一批**,
 *    绝不拿新算的集合覆盖。这挡住的是 `enqueue` 的 `skipDuplicates` 语义带来的
 *    **并集污染** —— 重放时新算出来的人有新的 eventKey,会被**插进去**,老的那批又还在,
 *    于是实际收件人 = 两次计算的并集,既不是第一次也不是第二次。
 * 3. **盖章确定性**:`computedAt` 取调用方**业务事件本身**的时刻(与 eventKey 同一个
 *    时间权威,#1075),不取一次新的墙钟。于是重放算出来的 payload 与库里那行**逐字节相同**,
 *    `NotificationOutboxService` 既有的 `sameIntent` 对账自然放行;哪天有人把它改成
 *    重新取墙钟,同一个 eventKey 会带着不同 payload 撞上 `sameIntent`,当场抛
 *    `NotificationOutboxInvariantError`。**这是白拿的执行位,不是注释里的约定。**
 *
 * ## 不可变
 *
 * `payload` 在 `NotificationOutboxService` 全生命周期里**只在 insert 时写一次**,此后
 * 任何路径都不 update 它(lease / prepare / sent / dead 各有自己的列)。所以盖章一旦落库
 * 就改不了。DB 层 trigger 属 D 档,本刀不建;`activity-recipient-freeze.spec.ts`
 * 里有结构判据钉住「outbox 服务不得出现写 payload 的 update」。
 *
 * ## 为什么是**纯 tx 函数**而不是 `@Injectable`
 *
 * 本模块不持 `PrismaService`、无状态、全部以调用方的 `tx` 为入参 —— 与
 * `activity-publish-review-access.ts` / `auth-session-lock` 同一范式:不产生隐式锁序,
 * 也不把事务所有权从 application service 下放。附带的好处是**不必登记进任何
 * NestJS module** ⇒ 不动 `*.module.ts` ⇒ 不惊动那份按 module 文件算摘要的执法层登记表
 * (它在红区且没有生成器,手改要维护者授权)。
 */

/**
 * 回捞到的冻结批次与它自己声明的基数对不上 —— 快照残缺,不能将就。
 * 刻意不做成 `BizException`:这不是业务拒绝,是**不变量被破坏**,与
 * `NotificationOutboxInvariantError` 同一处置。
 */
export class ActivityRecipientFreezeInvariantError extends Error {
  constructor(message: string) {
    super(`ACTIVITY_RECIPIENT_FREEZE_INVARIANT: ${message}`);
    this.name = 'ActivityRecipientFreezeInvariantError';
  }
}

/** 冻结算法口径版本。口径变了必须 +1 —— 老快照要能被认出是老口径算的。 */
export const ACTIVITY_RECIPIENT_FREEZE_ALGORITHM_VERSION = 1;

/** 受众标签非空 = 按标签 OR 并集(B7 语义)。 */
export const FREEZE_BASIS_AUDIENCE_TAGS = 'audience-tags';
/** 受众标签 `[]` = 全部 ACTIVE 且未软删会员(B7 语义)。 */
export const FREEZE_BASIS_ALL_ACTIVE_MEMBERS = 'all-active-members';
/** 受众标签 `null` = legacy 广播,**刻意不冻结**(见 `freezeAudienceTags` 注释)。 */
export const FREEZE_BASIS_BROADCAST_VISIBILITY = 'broadcast-visibility';
/** 活动当前在任负责人 / 协办人等责任关系。 */
export const FREEZE_BASIS_RESPONSIBILITY = 'responsibility';
/** 报名名册(取消、改期等事件的收件人)。 */
export const FREEZE_BASIS_REGISTRATION_ROSTER = 'registration-roster';
/**
 * 组织定向(维护者 2026-08-25 拍板):受众标签 **AND** 组织子树。
 *
 * ⚠️ 这一档只在**真的按组织收窄**时出现 —— `audienceOrganizationIds` 为 `null` 或 `[]` 时
 * 依据仍是 `audience-tags` / `all-active-members`,盖章逐字节不变。否则本刀会把**存量在飞**
 * 的 intent 的 `basisKind` 改掉,重放时同一 eventKey 带着不同 payload 撞上 `sameIntent`。
 */
export const FREEZE_BASIS_AUDIENCE_ORGANIZATIONS = 'audience-organizations';

/**
 * 品牌位:`FrozenRecipientCohort` / `FrozenBroadcastAudience` **只能**由本模块造出来。
 * 调用方想绕过冻结自己拼一个对象给 producer,编译不过 —— D2.4「四个 producer 同源」
 * 靠这个在类型层生效,不靠人记得。
 *
 * ⚠️ 必须是**真实的 `Symbol()`**,不能写成 `declare const`:后者只有类型没有运行时值,
 * 拿它当计算属性键会在运行时 `ReferenceError`(本刀实测踩过)。不导出 ⇒ 外部既拿不到
 * 这个符号(symbol 按标识唯一,自己 `Symbol()` 一个是另一个),也写不出这个属性名。
 */
const FROZEN_BRAND: unique symbol = Symbol('activity-recipient-freeze');

/** 盖在每条 intent payload 上的快照头。 */
export interface RecipientFreezeStamp {
  cohortKey: string;
  algorithmVersion: number;
  basisKind: string;
  basisRef: string[];
  computedAt: string;
  cohortSize: number;
}

export interface FrozenRecipientCohort {
  readonly [FROZEN_BRAND]: 'cohort';
  readonly cohortKey: string;
  readonly memberIds: readonly string[];
  readonly stamp: RecipientFreezeStamp;
  /** true = 本次是从既有 intent 回读的冻结集合,没有重算。 */
  readonly reused: boolean;
}

export interface FrozenBroadcastAudience {
  readonly [FROZEN_BRAND]: 'broadcast';
  readonly stamp: RecipientFreezeStamp;
}

export type FrozenAudience = FrozenRecipientCohort | FrozenBroadcastAudience;

export function isFrozenCohort(audience: FrozenAudience): audience is FrozenRecipientCohort {
  return audience.stamp.basisKind !== FREEZE_BASIS_BROADCAST_VISIBILITY;
}

interface FreezeRequest {
  /**
   * 冻结批次的稳定业务键。必须与 producer 的 eventKey 同粒度 —— 写粗了会把两个
   * 该分开通知的事件并成一批,写细了(比如掺进墙钟)每次重放都成新批次,冻结失效。
   */
  cohortKey: string;
  aggregateType: string;
  /**
   * 这批 intent 落在哪些聚合上。多数事件是一个(活动),但**候补递补**是每条报名一个
   * 聚合 —— 回捞得按 `aggregateId IN (...)` 一次查完,不能每人一次查。
   */
  aggregateIds: readonly string[];
  basisKind: string;
  basisRef: string[];
  /** 业务事件时刻。**不是**在这里新取的墙钟 —— 见文件头第 3 条。 */
  at: Date;
  /**
   * 候选集合的**惰性**求值器。
   *
   * ⚠️ 刻意不是一个已经算好的数组:回捞到冻结批次时它**根本不会被调用** ——
   * 「不重算」得是字面意义上的一次查询都不发,而不是「算了但把结果丢掉」。
   * 后者在读数上分不出来,也白白付了万人活动那次全表扫描的钱。
   */
  candidateMemberIds: () => Promise<readonly string[]> | readonly string[];
}

/**
 * 受众标签 → 冻结收件人(B7 语义,合同 AC-066)。
 *
 * ⚠️ **口径不重造**:`null` / `[]` / 非空三分支逐字沿用 B7 既有语义
 * (见 `src/modules/activities/CLAUDE.md`)。本刀之前这段解析在
 * `activity-publish-review.service.ts` 与 `activity-status-command.service.ts`
 * 里**各有一份拷贝** —— 那正是「一个 producer 一套算法」的实例,现已收敛到这里。
 *
 * `null`(legacy 广播)**刻意不冻结**:广播的收件人语义就是「此刻能看见它的人」,
 * 没有集合可冻。把它改成逐人展开是**行为变更**(对外从一条广播变成 N 条定向),
 * 需要维护者拍板,不在本刀 —— 但它仍然要走本函数,拿到一个显式的
 * `broadcast-visibility` 盖章:**「不冻结」必须是这里做出的决定,不能是某个
 * producer 悄悄漏掉冻结。**
 *
 * ## 组织定向(维护者 2026-08-25 拍板)
 *
 * `audienceOrganizationIds` 与 `audienceTagCodes` 是**两个正交的收窄维度**,取**交集**:
 * 「在这些组织(含下级)里」**且**「有这些标签」才收得到。三分支:
 *   - `null` / `[]` ⇒ 组织维度**不设限**,盖章与本刀之前逐字节相同(见常量注释)。
 *   - 非空 ⇒ 走 `organization_closure` 真子树展开,再与标签结果求交。
 */
export async function freezeAudienceTags(
  tx: PrismaTx,
  input: {
    activityId: string;
    audienceTagCodes: string[] | null;
    /** 维护者 2026-08-25 拍板的组织定向;`null` / `[]` = 该维度不设限。 */
    audienceOrganizationIds?: string[] | null;
    at: Date;
  },
): Promise<FrozenAudience> {
  const cohortKey = `activity-publish-audience:${input.activityId}:${input.at.toISOString()}`;
  if (input.audienceTagCodes === null) {
    return {
      [FROZEN_BRAND]: 'broadcast',
      stamp: {
        cohortKey,
        algorithmVersion: ACTIVITY_RECIPIENT_FREEZE_ALGORITHM_VERSION,
        basisKind: FREEZE_BASIS_BROADCAST_VISIBILITY,
        basisRef: [],
        computedAt: input.at.toISOString(),
        cohortSize: 0,
      },
    };
  }
  const audienceTagCodes = input.audienceTagCodes;
  const organizationIds = input.audienceOrganizationIds ?? [];
  // 「按组织收窄」= 非空数组。`[]` 与 `null` 同为「不设限」,刻意不让空数组塌成空收件人集
  // —— 那会把「没勾组织」误读成「谁都不发」。
  const scopedByOrganization = organizationIds.length > 0;
  return freeze(tx, {
    cohortKey,
    aggregateType: 'activity',
    aggregateIds: [input.activityId],
    basisKind: scopedByOrganization
      ? FREEZE_BASIS_AUDIENCE_ORGANIZATIONS
      : audienceTagCodes.length === 0
        ? FREEZE_BASIS_ALL_ACTIVE_MEMBERS
        : FREEZE_BASIS_AUDIENCE_TAGS,
    // 不收窄时 basisRef 逐字节沿用旧值(裸标签码);收窄时两个维度都要能对账,故加前缀区分
    // —— 否则组织 id 与标签码混在一个数组里,事后没人分得清哪个是哪个。
    basisRef: scopedByOrganization
      ? [
          ...audienceTagCodes.map((code) => `tag:${code}`),
          ...organizationIds.map((id) => `org:${id}`),
        ].sort()
      : [...audienceTagCodes].sort(),
    at: input.at,
    candidateMemberIds: () =>
      resolveAudienceRecipientMemberIds(tx, audienceTagCodes, organizationIds, input.at),
  });
}

/**
 * 责任关系(负责人 / 协办人)→ 冻结收件人。
 *
 * `memberIds` 里的 `null` 会被滤掉而不是抛错:「活动没有在任 owner」是先于本刀
 * 存在的数据形态,通知缺席从来不该把一笔已经算清楚的业务挡回去 ——
 * 与四个 producer 既有处置逐字一致。
 */
export function freezeResponsibility(
  tx: PrismaTx,
  input: {
    cohortKey: string;
    aggregateType: string;
    aggregateIds: readonly string[];
    basisRef: string[];
    memberIds: readonly (string | null)[];
    at: Date;
  },
): Promise<FrozenRecipientCohort> {
  return freeze(tx, {
    cohortKey: input.cohortKey,
    aggregateType: input.aggregateType,
    aggregateIds: input.aggregateIds,
    basisKind: FREEZE_BASIS_RESPONSIBILITY,
    basisRef: [...input.basisRef].sort(),
    at: input.at,
    candidateMemberIds: () => input.memberIds.filter((id): id is string => id !== null),
  });
}

/** 报名名册(取消、改期、候补递补等)→ 冻结收件人。 */
export function freezeRegistrationRoster(
  tx: PrismaTx,
  input: {
    cohortKey: string;
    aggregateType: string;
    aggregateIds: readonly string[];
    basisRef: string[];
    memberIds: readonly string[];
    at: Date;
  },
): Promise<FrozenRecipientCohort> {
  return freeze(tx, {
    cohortKey: input.cohortKey,
    aggregateType: input.aggregateType,
    aggregateIds: input.aggregateIds,
    basisKind: FREEZE_BASIS_REGISTRATION_ROSTER,
    basisRef: [...input.basisRef].sort(),
    at: input.at,
    candidateMemberIds: () => input.memberIds,
  });
}

/**
 * 冻结本体:**先回捞,捞不到才用候选集**。
 *
 * 回捞按 `(aggregateType, aggregateId)` 走既有索引,再按盖章里的 `cohortKey` 过滤 ——
 * 不是按 eventKey 前缀 like,那条路没有索引。
 */
async function freeze(tx: PrismaTx, request: FreezeRequest): Promise<FrozenRecipientCohort> {
  const frozen = await readFrozenCohort(tx, request);
  if (frozen !== null) return frozen;

  const memberIds = [...new Set(await request.candidateMemberIds())].sort();
  return {
    [FROZEN_BRAND]: 'cohort',
    cohortKey: request.cohortKey,
    memberIds,
    stamp: {
      cohortKey: request.cohortKey,
      algorithmVersion: ACTIVITY_RECIPIENT_FREEZE_ALGORITHM_VERSION,
      basisKind: request.basisKind,
      basisRef: request.basisRef,
      computedAt: request.at.toISOString(),
      cohortSize: memberIds.length,
    },
    reused: false,
  };
}

/**
 * 回捞既有冻结批次。
 *
 * ⚠️ 回捞到的行数与盖章里的 `cohortSize` **必须相等**,否则说明上一次只写进去一半
 * (或有人事后补插了行)。这种情况下**抛错而不是将就** —— 一个残缺的快照被当成
 * 完整快照返回,等于让「当初发给了谁」这个问题永久失去答案。
 */
async function readFrozenCohort(
  tx: PrismaTx,
  request: FreezeRequest,
): Promise<FrozenRecipientCohort | null> {
  if (request.aggregateIds.length === 0) return null;
  const rows = await tx.notificationOutboxIntent.findMany({
    where: {
      aggregateType: request.aggregateType,
      aggregateId: { in: [...request.aggregateIds] },
      destinationType: 'member',
    },
    select: { destinationRef: true, payload: true },
  });
  const matched: { destinationRef: string; stamp: RecipientFreezeStamp }[] = [];
  for (const row of rows) {
    const stamp = readRecipientFreezeStamp(row.payload);
    if (stamp?.cohortKey === request.cohortKey) {
      matched.push({ destinationRef: row.destinationRef, stamp });
    }
  }
  const first = matched[0];
  if (first === undefined) return null;

  const stamp = first.stamp;
  const memberIds = [...new Set(matched.map((row) => row.destinationRef))].sort();
  if (memberIds.length !== stamp.cohortSize) {
    throw new ActivityRecipientFreezeInvariantError(
      `cohortKey=${request.cohortKey} froze ${stamp.cohortSize} recipients but ${memberIds.length} intents survive`,
    );
  }
  return {
    [FROZEN_BRAND]: 'cohort',
    cohortKey: request.cohortKey,
    memberIds,
    stamp,
    reused: true,
  };
}

/**
 * B7 受众标签语义(`src/modules/activities/CLAUDE.md`):
 * `[]` = 全部 ACTIVE 且未软删的 Member;非空 = 按 ACTIVE、未软删的
 * `member_audience_tag` 标签 OR 并集去重。
 *
 * ⚠️ **本函数的函数体在组织定向那一刀里刻意一行未动**。架构债棘轮的
 * `callSiteId = hash(file + AST 路径 + 判别符)`,而 AST 路径对函数是**按名字**取的
 * (`Function(resolveAudienceMemberIds)/…`)—— 把这两条既有的 identity-org 跨域读
 * 抽进另一个函数,它们的身份就变了,棘轮会把**搬家**报成「新增代码债」。
 * 本刀实测踩过:一版抽出 `resolveTaggedMemberIds` 后,棘轮点名 5 条,其中 3 条是位移不是新增。
 * 组织维度的收窄因此做在**调用方** `resolveAudienceRecipientMemberIds` 里,不动这里。
 */
async function resolveAudienceMemberIds(
  tx: PrismaTx,
  audienceTagCodes: string[],
): Promise<string[]> {
  if (audienceTagCodes.length === 0) {
    const members = await tx.member.findMany({
      where: { status: MemberStatus.ACTIVE, deletedAt: null },
      select: { id: true },
    });
    return members.map((member) => member.id).sort();
  }
  const tagIds = await resolveActiveAudienceTagIds(tx, audienceTagCodes);
  const assignments = await tx.memberAudienceTagAssignment.findMany({
    where: {
      dictItemId: { in: tagIds },
      revokedAt: null,
      member: { status: MemberStatus.ACTIVE, deletedAt: null },
    },
    select: { memberId: true },
  });
  return [...new Set(assignments.map((assignment) => assignment.memberId))].sort();
}

/**
 * 受众标签 **AND** 组织子树(维护者 2026-08-25 拍板)。
 *
 * 两个维度各自算全,再求**交集** —— 刻意不是把组织条件塞进上面两条 where:
 *   ① 交集这件事收敛到**一处**、一眼可读,也只有一处可以被变异对拍打中;
 *   ② 塞进 where 要在两个分支各写一遍,漏一支就变成「标签分支是交集、全员分支是并集」,
 *      而那种半对的实现在只测一支的用例里完全看不出来。
 *
 * 组织子树与「有效任职」的口径**不在本模块解释** —— 走 `identity-org` 域属主导出的
 * tx 原语 `resolveOrganizationSubtreeMemberIds`。活动域直接读组织三表是跨域读,
 * 架构债棘轮会判「新增代码债」;更重要的是,组织树怎么展开本来就该由组织域说了算。
 */
async function resolveAudienceRecipientMemberIds(
  tx: PrismaTx,
  audienceTagCodes: string[],
  audienceOrganizationIds: string[],
  at: Date,
): Promise<string[]> {
  const taggedMemberIds = await resolveAudienceMemberIds(tx, audienceTagCodes);
  if (audienceOrganizationIds.length === 0) return taggedMemberIds;
  const organizationMemberIds = await resolveOrganizationSubtreeMemberIds(
    tx,
    audienceOrganizationIds,
    at,
  );
  // ⬇⬇ 交集(AND)。改成并集即「在组织但没标签」「有标签但不在组织」两类人都会收到 ——
  //     `activity-recipient-freeze.spec.ts` 的两条反向用例正钉在这一行上。
  return taggedMemberIds.filter((memberId) => organizationMemberIds.has(memberId));
}

async function resolveActiveAudienceTagIds(
  tx: PrismaTx,
  audienceTagCodes: string[],
): Promise<string[]> {
  if (audienceTagCodes.length === 0) return [];
  const type = await tx.dictType.findFirst({
    where: {
      code: DICT_TYPE_MEMBER_AUDIENCE_TAG,
      status: DictTypeStatus.ACTIVE,
      deletedAt: null,
    },
    select: { id: true },
  });
  if (!type) throw new BizException(BizCode.BAD_REQUEST);
  const tags = await tx.dictItem.findMany({
    where: {
      typeId: type.id,
      code: { in: audienceTagCodes },
      status: DictItemStatus.ACTIVE,
      deletedAt: null,
    },
    select: { id: true },
  });
  if (tags.length !== audienceTagCodes.length) throw new BizException(BizCode.BAD_REQUEST);
  return tags.map((tag) => tag.id);
}

/** 从一条 intent 的 payload 里读出快照头;没盖章的老行返回 `null`。 */
export function readRecipientFreezeStamp(payload: unknown): RecipientFreezeStamp | null {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const raw = (payload as Record<string, unknown>).recipientFreeze;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (
    typeof record.cohortKey !== 'string' ||
    typeof record.algorithmVersion !== 'number' ||
    typeof record.basisKind !== 'string' ||
    !Array.isArray(record.basisRef) ||
    typeof record.computedAt !== 'string' ||
    typeof record.cohortSize !== 'number'
  ) {
    return null;
  }
  return {
    cohortKey: record.cohortKey,
    algorithmVersion: record.algorithmVersion,
    basisKind: record.basisKind,
    basisRef: record.basisRef.filter((item): item is string => typeof item === 'string'),
    computedAt: record.computedAt,
    cohortSize: record.cohortSize,
  };
}
