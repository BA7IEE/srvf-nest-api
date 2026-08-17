import { Injectable } from '@nestjs/common';
import { MemberStatus, Prisma } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { notDeletedWhere } from '../../common/prisma/soft-delete.util';
import { PrismaService } from '../../database/prisma.service';
import {} from '../insurances/insurance-requirement.service';
import { RbacService } from '../permissions/rbac.service';
import { AuthzService } from '../authz/authz.service';
import type { ResourceRef } from '../authz/authz.types';
import { type ActivityQualificationTarget } from './activity-qualification-evaluator.service';
import {} from './activity-registrations.dto';

export const REGISTRATION_STATUS_PENDING = 'pending';
export const REGISTRATION_STATUS_PASS = 'pass';
export const REGISTRATION_STATUS_CANCELLED = 'cancelled';
export const REGISTRATION_STATUS_WAITLISTED = 'waitlisted';

export const registrationSafeSelect = {
  id: true,
  activityId: true,
  activityPositionId: true,
  memberId: true,
  statusCode: true,
  registeredAt: true,
  reviewedBy: true,
  reviewedAt: true,
  reviewNote: true,
  extras: true,
  cancelledByUserId: true,
  cancelledAt: true,
  cancelReason: true,
  createdAt: true,
  updatedAt: true,
  currentRevision: true,
} as const satisfies Prisma.ActivityRegistrationSelect;

export type RegistrationFullRow = Prisma.ActivityRegistrationGetPayload<{
  select: typeof registrationSafeSelect;
}>;
export type PrismaTx = Prisma.TransactionClient;
export type RegistrationAuthorization = 'authz' | 'managed';

export type LockedLegacyRegistrationHead = {
  id: string;
  statusCode: string;
  currentRevision: number;
  deletedAt: Date | null;
};

export type ReviewQualificationContext = {
  registrationRevisionId: string | null;
  targets: ActivityQualificationTarget[];
  identityIdBySession: Map<string, string>;
  identityCount: number;
  preferenceCount: number;
};

/*
 * 报名路径的**共享准入层**(Phase 6-B 第三域第二刀,§3.2)。
 *
 * 承载 create / 审批 / 读侧 / 队员端**多段共用**的前置:判权、managed 面校验、
 * Activity 与 Registration 的回读、报名写路径的 Activity 聚合根锁、参与证据守卫。
 * 抽出来的直接理由与 attendances 同域第一刀一致:被抽出的族若还要 import 回主 service
 * 就是循环依赖,所以共用前置必须先降为共享底座。
 *
 * ⚠️ 做成 @Injectable 而非模块级纯函数是**刻意**的:这些方法要吃 authz / rbac / prisma。
 * 若改成纯函数、把判权**结果**当入参传给各族,就把「同一方法体内的数据流」变成「跨类入参」——
 * 漏传一个实参 = 一条判权凭空消失,而全仓单测可以零红(6-B 第三域实测)。
 * 注入式则每族的判权调用仍在**它自己的方法体内**,漏调是显式的少一行。
 *
 * ⚠️ lockActivityForRegistrationCreate 的语义随身迁来:**任何写 surface 都必须取**。
 * 把它挂在判权分支上会让另一条 surface 对 Activity 与 Registration 裸奔(并发审计 S7 同形)。
 */
@Injectable()
export class ActivityRegistrationAccessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rbac: RbacService,
    private readonly authz: AuthzService,
  ) {}

  // Slow-4 T3(2026-06-11,评审稿 §3.6 / D-S4-8)起点;终态 scoped-authz PR12(2026-07-02;
  // 冻结稿 §11 + 决断①②)升级:判权走 authz.explain,ref 矩阵——
  //   - list / exportCsv(嵌套 :activityId)传 {type:'activity', id: activityId} 父 ref
  //   - approve / reject / cancelAdmin 传 {type:'activity_registration', id}(点动作)
  //   - create(代报名)无 ref(GLOBAL-only)
  //   - listAllForAdmin 通过 getVisibleOrganizationScope 下推活动所属组织范围
  //   - listForMemberAdmin 传 {type:'member', id: memberId}(成员主归属点授权)
  // NOT_FOUND 回退沿 PR9 范式:resource_not_found 时退回 rbac.can 全局码判定——持码者 return
  // (交回调用方后续 findActivityOrThrow / findRegistrationOrThrow 抛既有 NOT_FOUND,「先判权后查
  // 资源」行为锁不变),无码者 30100 防枚举。管理端 8 端点第一条语句调用;list / exportCsv 共用 read
  // (D4=A 判例)。App 自助端点(createMy/listMy/findMy/cancelMy)不走本 helper,self-scope 不变。
  async assertCanOrThrow(
    user: CurrentUserPayload,
    action: string,
    ref?: ResourceRef,
  ): Promise<void> {
    const decision = await this.authz.explain(user, action, ref);
    if (decision.allow) return;
    if (ref && decision.reason === 'resource_not_found' && (await this.rbac.can(user, action))) {
      return;
    }
    throw new BizException(BizCode.RBAC_FORBIDDEN);
  }

  async assertManagedRegistrationAccess(
    activityId: string,
    currentUser: CurrentUserPayload,
    tx?: PrismaTx,
  ): Promise<void> {
    if (!currentUser.memberId) {
      throw new BizException(BizCode.RBAC_FORBIDDEN);
    }
    const activity = await (tx ?? this.prisma).activity.findFirst({
      where: {
        id: activityId,
        deletedAt: null,
        responsibilityAssignments: {
          some: {
            memberId: currentUser.memberId,
            status: 'active',
            canManageRegistrations: true,
          },
        },
      },
      select: { id: true },
    });
    if (!activity) {
      throw new BizException(BizCode.RBAC_FORBIDDEN);
    }
  }

  // 找 activity 并校验存在(创建报名 / 列表 / 导出 / capacity 复核共用)。
  // 保险 T3:select 扩展 requiresInsurance / startAt / endAt 三字段供报名门槛断言复用
  // (不另发查询;评审稿 insurance-module-review.md §4 第 3 条),既有调用方语义不变(返回超集)。
  async findActivityOrThrow(
    activityId: string,
    tx?: PrismaTx,
  ): Promise<{
    id: string;
    statusCode: string;
    isPublicRegistration: boolean;
    capacity: number | null;
    requiresInsurance: boolean;
    startAt: Date;
    endAt: Date;
    registrationDeadline: Date | null;
    genderRequirementCode: string | null;
  }> {
    const client = tx ?? this.prisma;
    const act = await client.activity.findFirst({
      where: notDeletedWhere({ id: activityId }),
      select: {
        id: true,
        statusCode: true,
        isPublicRegistration: true,
        capacity: true,
        requiresInsurance: true,
        startAt: true,
        endAt: true,
        // 活动闭环硬化(2026-06-21):报名截止闸取数(assertActivityRegistrable 读;
        // approve 不读,既有调用方零回归,返回超集)。
        registrationDeadline: true,
        genderRequirementCode: true,
      },
    });
    if (!act) throw new BizException(BizCode.ACTIVITY_NOT_FOUND);
    return act;
  }

  // 找 registration 并校验存在(管理端 approve / reject / cancel 共用)。
  async findRegistrationOrThrow(
    activityId: string,
    id: string,
    tx?: PrismaTx,
  ): Promise<RegistrationFullRow> {
    const client = tx ?? this.prisma;
    const reg = await client.activityRegistration.findFirst({
      where: notDeletedWhere({ id }),
      select: registrationSafeSelect,
    });
    if (!reg || reg.activityId !== activityId) {
      // 跨 activity 访问统一抛 ACTIVITY_REGISTRATION_NOT_FOUND → 404
      // (避免存在性泄漏)
      throw new BizException(BizCode.ACTIVITY_REGISTRATION_NOT_FOUND);
    }
    return reg;
  }

  // 找队员端 USER 的 memberId(必须绑定,否则视作"无队员身份")。
  async resolveUserMemberIdOrThrow(userId: string, tx?: PrismaTx): Promise<string> {
    const client = tx ?? this.prisma;
    const u = await client.user.findFirst({
      where: notDeletedWhere({ id: userId }),
      select: { memberId: true },
    });
    if (!u || u.memberId === null) {
      // 用户未关联队员:沿 v2 通用语义,返 MEMBER_NOT_FOUND(15001)。
      throw new BizException(BizCode.MEMBER_NOT_FOUND);
    }
    return u.memberId;
  }

  // 无锁预读只负责稳定错误优先级；真正防 offboard 竞态的排他锁必须在写入前再次取得。
  // create 的最终锁刻意放在 insurance source 锁之后：team source 的全仓既有顺序是
  // Policy → Coverage → Member，若这里先锁 Member 会与 team coverage writer 形成反向边。
  async assertMemberActiveSnapshot(memberId: string, tx: PrismaTx): Promise<void> {
    const member = await tx.member.findUnique({
      where: { id: memberId },
      select: { status: true, deletedAt: true },
    });
    if (!member || member.deletedAt !== null) {
      throw new BizException(BizCode.MEMBER_NOT_FOUND);
    }
    if (member.status !== MemberStatus.ACTIVE) {
      throw new BizException(BizCode.MEMBER_INACTIVE);
    }
  }

  // registration create 与 approve / pass cancel / 岗位写侧统一使用 Activity 聚合锁。
  // 锁必须先于 Activity / ActivityPosition / passCount 基线读取，避免 create 使用陈旧容量
  // 落入 waitlisted，或在岗位软删提交后继续插入指向已删岗位的 active registration。
  async lockActivityForRegistrationCreate(activityId: string, tx: PrismaTx): Promise<void> {
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM "Activity"
      WHERE id = ${activityId} AND "deletedAt" IS NULL
      FOR UPDATE
    `;
    if (locked.length === 0) {
      throw new BizException(BizCode.ACTIVITY_NOT_FOUND);
    }
  }

  // 参与域生命周期收口⑦(v0.40.0):已有参与证据的报名禁取消守卫。cancelAdmin + cancelMy 两路共用。
  // 直连 prisma 查 AttendanceRecord / ActivityCheckIn 的 registrationId 反向引用(未软删)
  // ——**不引 attendances service**(防跨模块环:attendances → activity-registration 是既有单向依赖,
  // 反向会成环)。任一存在即拒;
  // 不做贡献值回滚(贡献值属考勤域;撤销参与先走考勤面处理记录,报名取消自然解锁)。
  async assertNoParticipationEvidence(registrationId: string, tx: PrismaTx): Promise<void> {
    const attendanceCount = await tx.attendanceRecord.count({
      where: { registrationId, deletedAt: null },
    });
    if (attendanceCount > 0) {
      throw new BizException(BizCode.ACTIVITY_REGISTRATION_HAS_ATTENDANCE);
    }
    const checkInCount = await tx.activityCheckIn.count({
      where: { registrationId, deletedAt: null },
    });
    if (checkInCount > 0) {
      throw new BizException(BizCode.ACTIVITY_REGISTRATION_HAS_ATTENDANCE);
    }
  }
}
