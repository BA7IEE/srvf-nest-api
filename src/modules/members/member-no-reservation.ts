import type { Prisma } from '@prisma/client';

/**
 * 队员编号「已烧号」台账的唯一写入口(2026-08-22;维护者拍板方案 A)。
 *
 * ===== 这条铁律此前是破的 =====
 *
 * 仓内多处写着「memberNo 一旦发放就永久占用,即使队员被删也不复用」,而它此前**只靠
 * Member 表兑现** —— `assertMemberNoUnique` 用**含软删**的 `findUnique` 查 Member。
 * 软删场景够用(行还在),但 `correctIdentity`(#1127)是**原地 update**:
 * `A001` 订正成 `A999` 之后,库里**再没有任何行持有 `A001`** ⇒ 下一个人建档时唯一性
 * 预检通过 ⇒ **`A001` 被重新发出去**。
 *
 * 为什么这不是洁癖:`memberNo` 同时是**登录识别锚** —— `auth.service` 先按 username 查,
 * 未命中再按 memberNo 兜底查,且刻意保留原大小写(「编号即身份」)。号被复用意味着
 * 曾经用 `A001` 登录的是甲、现在是乙;而这个号还印在证书上、写在通讯录里、队员自己
 * 记着 —— **系统外的世界不知道这个号被订正过**。
 *
 * ===== 谁真正在执法 =====
 *
 * ⭐ 拦住复用的是 `MemberNoReservation.memberNo` 上的 **DB 唯一约束**,不是应用层预检。
 *    `assertMemberNoUnique` 只是把 P2002 提前翻成业务错误码,好让前端拿到 20xxx 而不是 500。
 *    这个分工是刻意的,因为**并不是每条写路径都过预检**:招新发号(`recruitment-promotion`)
 *    从不调 `assertMemberNoUnique` —— 它从 `RecruitmentCycle.memberNoSeq` 取号,靠 P2002
 *    兜底转 28042(整批回滚不跳号)。本函数一插,它就自动被同一条约束管住,零改判逻辑。
 *
 * ⚠️ 必须与建档 / 发号 / 订正**同一个事务**。分开写会留一个崩溃窗口:member 已落库、
 *    台账还没写,进程此刻挂掉,这个号就变成一个「不在台账里」的活号。
 *
 * ===== 明确不做 =====
 *
 * ❌ 无 `status` 列、无软删、无释放 / 恢复入口 —— 号烧了就是烧了(维护者拍板)。
 *    加一个 status 列就等于把「永不复用」偷偷降级成「默认不复用」。将来真要释放,另行立项。
 */

/**
 * 烧号缘由。**溯源注脚而已** —— 全仓没有任何判定读它,
 * 所以刻意以 String 落库、不建字典、不加 CHECK。
 * 一旦哪天有判定要读它,那就该在同一刀里把它升成 enum,而不是继续当自由串用。
 */
export type MemberNoBurnReason =
  /** 管理员建档(members.service.create) */
  | 'created'
  /** 招新发号(recruitment-promotion,批量与单人共用建档内核) */
  | 'promoted'
  /** 身份订正**改出来的新号**;旧号那行原样留在台账里不动 —— 那正是铁律的执行位 */
  | 'corrected'
  /** 本地前端联调夹具(仅 app_local_frontend* 库) */
  | 'local-fixture'
  /** migration 存量回填(只由 SQL 写,此处列出以便类型覆盖全部取值) */
  | 'backfill';

export interface BurnMemberNoParams {
  memberNo: string;
  /**
   * 这个号**当时**发给了谁。可空是因为归属只是附带溯源事实,占号才是台账的职责。
   * ⚠️ 订正时传的是**被订正的那个队员**(新号归他);旧号那行的 memberId 保持原值不改。
   */
  memberId: string | null;
  reason: MemberNoBurnReason;
  /**
   * 烧号时刻,**必须由调用方显式给**。
   * 台账列刻意没有 `@default(now())`:有默认值时漏传就悄悄吃库时钟,
   * 而「写用库时钟、判用应用时钟」在本仓是一整类缺陷;无默认值 ⇒ 漏传变成编译错误。
   */
  now: Date;
}

/**
 * 把一个 memberNo 记进台账 = 永久烧掉它。
 *
 * 撞已烧号时抛 Prisma `P2002`,由调用方既有的兜底翻译成业务码:
 * - members 域:`MemberAccessService.runWithUniqueConstraintGuard` → `MEMBER_NO_ALREADY_EXISTS`
 * - 招新域:`promote` / `promoteSingle` 的 catch → `RECRUITMENT_APPLICATION_NOT_PROMOTABLE`(28042)
 */
export async function burnMemberNo(
  tx: Prisma.TransactionClient,
  params: BurnMemberNoParams,
): Promise<void> {
  await tx.memberNoReservation.create({
    data: {
      memberNo: params.memberNo,
      memberId: params.memberId,
      reservedAt: params.now,
      reason: params.reason,
    },
    select: { id: true },
  });
}

/**
 * 这个号是不是**已经烧过**了(台账命中即为真)。
 *
 * 与「Member 表含软删命中」是**两个独立的理由**,任一成立即拒:
 * 前者覆盖「号还挂在某个队员身上(哪怕是软删的)」,
 * 后者覆盖「号曾经发出去过、现在已经不挂在任何人身上」—— 订正腾出来的号正是这一类。
 */
export async function isMemberNoBurned(
  tx: Prisma.TransactionClient,
  memberNo: string,
): Promise<boolean> {
  const hit = await tx.memberNoReservation.findUnique({
    where: { memberNo },
    select: { id: true },
  });
  return hit !== null;
}
