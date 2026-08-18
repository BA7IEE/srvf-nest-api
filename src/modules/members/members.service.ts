import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import {
  AssignmentStatus,
  BindingStatus,
  DictItemStatus,
  DictTypeStatus,
  MemberStatus,
  MembershipStatus,
  PrincipalType,
  Prisma,
  Role,
  SupervisionStatus,
  UserStatus,
} from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { PageResultDto } from '../../common/dto/pagination.dto';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { runMemberLinearizedTransaction } from '../../common/prisma/member-advisory-lock.util';
import appConfig from '../../config/app.config';
import { PrismaService } from '../../database/prisma.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { ActivityMemberOffboardImpactService } from '../activities/activity-member-offboard-impact.service';
import { lockAuthSessionUser } from '../auth/auth-session-lock';
import { MembershipTermStateMachine } from '../member-departments/membership-term-state-machine';
import { AuthzService } from '../authz/authz.service';
import type { VisibleOrganizationScope } from '../authz/authz.service';
import { LastAdminProtectionPolicy } from '../permissions/last-admin-protection.policy';
import { RbacService } from '../permissions/rbac.service';
import { assertEnrollmentIdentityChangeAllowed } from '../team-join/team-join-enrollment-invariant';
// T4(D-WC-10):撤销原语归 users(见该文件头注「为什么落在 users 而不是 wecom」)。
// 纯 tx 函数,与既有 `auth/auth-session-lock` 同型 —— 不注入 UsersService、不产生模块环。
import {
  CreateMemberDto,
  ListMembersQueryDto,
  MemberAudienceTagDto,
  MemberAudienceTagsResponseDto,
  MemberOffboardResponseDto,
  MemberOffboardImpactResponseDto,
  MemberOptionsQueryDto,
  MemberOptionsResponseDto,
  MemberResponseDto,
  ReplaceMemberAudienceTagsDto,
  UpdateMemberDto,
  UpdateMemberStatusDto,
} from './members.dto';
import { lockMemberLifecycle } from './member-lifecycle-lock';
import { MemberAccessService, auditCtx, type PrismaTx } from './member-access.service';
import { MemberAccountService } from './member-account.service';
import { MemberAuditRecorder } from './member-audit-recorder';
import { MembersQueryService, memberSafeSelect } from './members-query.service';
import { attachAccountInfo } from './members.presenter';
import { assertGradeCodeValid, normalizeMemberNo } from './members.policy';

// 队员账号闭环 v1(MVP,2026-07-07):BCRYPT_SALT_ROUNDS 与 users.service / recruitment-promotion.service
// 同值(各模块级声明,沿既有惯例)。

// 对外 select 与其行类型已随第一刀移入 `members-query.service.ts`(§3.2 select strategy),
// 写路径回读 import 复用同一份,不另起第二份投影。

type AudienceTag = MemberAudienceTagDto & { id: string };

// 第二刀:六个 audit 事件共用的调用者上下文(actor 快照 + 资源定位 + 请求 meta)。
// payload 组装归 `member-audit-recorder.ts`,事务与调用顺序仍归本 service。

@Injectable()
export class MembersService {
  constructor(
    // 第三域第五刀:多段共用前置 + 账号族实现持有者;本 service 保留同名薄委托作为唯一入口。
    private readonly access: MemberAccessService,
    private readonly accounts: MemberAccountService,
    private readonly prisma: PrismaService,
    private readonly rbac: RbacService,
    private readonly authz: AuthzService,
    private readonly lastAdminProtection: LastAdminProtectionPolicy,
    private readonly auditRecorder: MemberAuditRecorder,
    private readonly activityOffboardImpact: ActivityMemberOffboardImpactService,
    private readonly query: MembersQueryService,
    @Inject(appConfig.KEY)
    private readonly config: ConfigType<typeof appConfig>,
  ) {}

  // ============ helpers ============

  private assertAudienceTagsHttpEnabled(): void {
    if (!this.config.activityAudienceTags.httpEnabled) {
      throw new BizException(BizCode.SERVICE_UNAVAILABLE);
    }
  }

  private sortAudienceTags(tags: AudienceTag[]): AudienceTag[] {
    return [...tags].sort(
      (left, right) => left.sortOrder - right.sortOrder || left.code.localeCompare(right.code),
    );
  }

  private toAudienceTagDto(tag: AudienceTag): MemberAudienceTagDto {
    return {
      code: tag.code,
      label: tag.label,
      status: tag.status,
      sortOrder: tag.sortOrder,
    };
  }

  private async resolveActiveAudienceTags(
    tx: PrismaTx,
    tagCodes: string[],
  ): Promise<AudienceTag[]> {
    if (tagCodes.length === 0) return [];
    const type = await tx.dictType.findFirst({
      where: {
        code: 'member_audience_tag',
        status: DictTypeStatus.ACTIVE,
        deletedAt: null,
      },
      select: { id: true },
    });
    if (!type) throw new BizException(BizCode.BAD_REQUEST);
    const items = await tx.dictItem.findMany({
      where: {
        typeId: type.id,
        code: { in: tagCodes },
        status: DictItemStatus.ACTIVE,
        deletedAt: null,
      },
      select: { id: true, code: true, label: true, status: true, sortOrder: true },
    });
    if (items.length !== tagCodes.length) throw new BizException(BizCode.BAD_REQUEST);
    return this.sortAudienceTags(items);
  }

  async getAudienceTags(
    id: string,
    currentUser: CurrentUserPayload,
  ): Promise<MemberAudienceTagsResponseDto> {
    await this.access.assertCanOrThrow(currentUser, 'member.read.record', { type: 'member', id });
    this.assertAudienceTagsHttpEnabled();
    await this.access.findMemberOrThrow(id);
    const assignments = await this.prisma.memberAudienceTagAssignment.findMany({
      where: { memberId: id, revokedAt: null },
      select: {
        dictItem: { select: { id: true, code: true, label: true, status: true, sortOrder: true } },
      },
    });
    const tags = this.sortAudienceTags(assignments.map((assignment) => assignment.dictItem));
    return { memberId: id, tags: tags.map((tag) => this.toAudienceTagDto(tag)) };
  }

  async replaceAudienceTags(
    id: string,
    dto: ReplaceMemberAudienceTagsDto,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<MemberAudienceTagsResponseDto> {
    await this.access.assertCanOrThrow(currentUser, 'member.update.record', {
      type: 'member',
      id,
    });
    this.assertAudienceTagsHttpEnabled();
    return runMemberLinearizedTransaction(this.prisma, async (tx) => {
      await lockMemberLifecycle(tx, id);
      await this.access.findMemberOrThrow(id, tx);
      const existing = await tx.memberAudienceTagAssignment.findMany({
        where: { memberId: id, revokedAt: null },
        select: {
          id: true,
          dictItem: {
            select: { id: true, code: true, label: true, status: true, sortOrder: true },
          },
        },
      });
      const beforeTags = this.sortAudienceTags(existing.map((assignment) => assignment.dictItem));
      const desiredTags = await this.resolveActiveAudienceTags(tx, dto.tagCodes);
      const desiredCodes = new Set(desiredTags.map((tag) => tag.code));
      const existingCodes = new Set(beforeTags.map((tag) => tag.code));
      const revokeIds = existing
        .filter((assignment) => !desiredCodes.has(assignment.dictItem.code))
        .map((assignment) => assignment.id);
      const additions = desiredTags.filter((tag) => !existingCodes.has(tag.code));
      const now = new Date();
      if (revokeIds.length > 0) {
        await tx.memberAudienceTagAssignment.updateMany({
          where: { id: { in: revokeIds } },
          data: { revokedAt: now },
        });
      }
      if (additions.length > 0) {
        await tx.memberAudienceTagAssignment.createMany({
          data: additions.map((tag) => ({ memberId: id, dictItemId: tag.id })),
        });
      }
      const beforeTagCodes = beforeTags.map((tag) => tag.code).sort();
      const afterTagCodes = desiredTags.map((tag) => tag.code).sort();
      await this.auditRecorder.audienceTagsUpdated(tx, auditCtx(id, currentUser, auditMeta), {
        beforeTagCodes,
        afterTagCodes,
        addedTagCodes: afterTagCodes.filter((code) => !existingCodes.has(code)),
        removedTagCodes: beforeTagCodes.filter((code) => !desiredCodes.has(code)),
      });
      return {
        memberId: id,
        tags: desiredTags.map((tag) => this.toAudienceTagDto(tag)),
      };
    });
  }

  // 唯一性预检查:必须 findUnique 包含软删记录(memberNo 全局唯一不复用,memberNo
  // 决议 Q2 = B-1)— 防止"软删后旧 memberNo 复活创建" 撞约束 + 防止前端拿到 P2002
  // 错误而非业务级错误码。
  private async assertMemberNoUnique(memberNo: string, tx?: PrismaTx): Promise<void> {
    const client = tx ?? this.prisma;
    const existing = await client.member.findUnique({
      where: { memberNo },
      select: { id: true },
    });
    if (existing) throw new BizException(BizCode.MEMBER_NO_ALREADY_EXISTS);
  }

  // ============ 队员账号闭环 v1:hasAccount / accountStatus 批量计算(避免 N+1)============

  // 队员账号闭环 v1:User.memberId 曾是 @unique(每 member 至多 1 条历史 User,含软删)。
  // 队员账号闭环 v2(评审稿 §1.2 E-6):改 partial unique 后,reopen 可让同一 memberId
  // 同时存在 1 条软删历史行 + 1 条 live 行,查询显式收窄 `deletedAt: null`——hasAccount
  // 语义随之从"槽位是否被任何行占用过"收窄为"当前是否有 live 绑定",与 grantAccount()
  // 的 MEMBER_HAS_LINKED_USER 判定(同样只查 live)口径一致。
  // ============ list ============

  // v0.49 部门数据范围的**判权腿**:解析该 action 的可见组织集合,无有效码即 30100。
  // 第一刀边界:这一步(以及它抛的 RBAC_FORBIDDEN)留在 application service —— QueryService
  // 只接收算好的 scope 作入参,不得自己调 rbac / authz(docs/architecture-boundary.md §3.2)。
  // 有效持码但组织集合为空 ⇒ hasPermission=true,交由 filter 腿产出空列表(既有行为)。
  private async resolveMemberReadScope(
    currentUser: CurrentUserPayload,
  ): Promise<VisibleOrganizationScope> {
    const authScope = await this.authz.getVisibleOrganizationScope(
      currentUser,
      'member.read.record',
    );
    if (!authScope.hasPermission) {
      throw new BizException(BizCode.RBAC_FORBIDDEN);
    }
    return authScope;
  }

  async list(
    query: ListMembersQueryDto,
    currentUser: CurrentUserPayload,
  ): Promise<PageResultDto<MemberResponseDto>> {
    const authScope = await this.resolveMemberReadScope(currentUser);
    const { items, total } = await this.query.list(query, authScope);
    const linkedByMemberId = await this.query.loadLinkedUsersByMemberIds(items.map((m) => m.id));
    return {
      items: items.map((m) => attachAccountInfo(m, linkedByMemberId.get(m.id))),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  // ============ F1/A1 选择器(路线图 §4;D2/D3 拍板)============

  // options = list 的轻量投影;复用 member.read.record(D2,不新增权限码)。
  async options(
    query: MemberOptionsQueryDto,
    currentUser: CurrentUserPayload,
  ): Promise<MemberOptionsResponseDto> {
    const authScope = await this.resolveMemberReadScope(currentUser);
    return this.query.options(query, authScope);
  }

  // ============ create ============

  async create(dto: CreateMemberDto, currentUser: CurrentUserPayload): Promise<MemberResponseDto> {
    await this.access.assertCanOrThrow(currentUser, 'member.create.record');
    const memberNo = normalizeMemberNo(dto.memberNo);

    return this.prisma.$transaction(async (tx) => {
      // 1. gradeCode 校验(若提供)— 在唯一性预检查之前,业务校验先于资源约束
      if (dto.gradeCode !== undefined) {
        await assertGradeCodeValid(tx, dto.gradeCode);
      }

      // 2. memberNo 唯一性预检查(包含软删)
      await this.assertMemberNoUnique(memberNo, tx);

      const created = await this.access.runWithUniqueConstraintGuard(() =>
        tx.member.create({
          data: {
            memberNo,
            displayName: dto.displayName,
            gradeCode: dto.gradeCode ?? null,
          },
          select: memberSafeSelect,
        }),
      );
      // 新建 member.id 刚生成,不可能已有关联 User(队员账号闭环 v1;免一次多余查询)。
      return attachAccountInfo(created, undefined);
    });
  }

  // ============ findOne ============

  async findOne(id: string, currentUser: CurrentUserPayload): Promise<MemberResponseDto> {
    await this.access.assertCanOrThrow(currentUser, 'member.read.record', { type: 'member', id });
    const member = await this.access.findMemberOrThrow(id);
    const linked = await this.query.findLinkedUser(id);
    return attachAccountInfo(member, linked);
  }

  // ============ update ============

  // 仅允许 displayName / gradeCode;memberNo / status 由 DTO 白名单兜底拒绝。
  async update(
    id: string,
    dto: UpdateMemberDto,
    currentUser: CurrentUserPayload,
  ): Promise<MemberResponseDto> {
    await this.access.assertCanOrThrow(currentUser, 'member.update.record', { type: 'member', id });
    // M3:本事务内会取队员线性化键 ⇒ 必须显式 ReadCommitted + 有界锁等待(见 util 注释)。
    return runMemberLinearizedTransaction(this.prisma, async (tx) => {
      // M2 唯一 transition:改级别是把「未入队志愿者」翻掉的最短路径,live 申请会就地 frozen。
      // 闸按 `dto.gradeCode !== undefined` 触发(不比对新旧值)—— 这是刻意的过近似:
      // 「把 volunteer 改写成 volunteer」这种空写也会被拦,代价为零,换来的是判定不依赖
      // 一次锁前读。真正的放行条件在闸内按 member 键复读后判定。
      if (dto.gradeCode !== undefined) {
        await assertEnrollmentIdentityChangeAllowed(tx, id, new Date());
      }
      await this.access.findMemberOrThrow(id, tx);

      if (dto.gradeCode !== undefined) {
        await assertGradeCodeValid(tx, dto.gradeCode);
      }

      const data: Prisma.MemberUpdateInput = {};
      if (dto.displayName !== undefined) data.displayName = dto.displayName;
      if (dto.gradeCode !== undefined) data.gradeCode = dto.gradeCode;

      const updated = await tx.member.update({
        where: { id },
        data,
        select: memberSafeSelect,
      });
      const linked = await this.query.findLinkedUser(id, tx);
      return attachAccountInfo(updated, linked);
    });
  }

  // ============ updateStatus ============

  async updateStatus(
    id: string,
    dto: UpdateMemberStatusDto,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<MemberResponseDto> {
    await this.access.assertCanOrThrow(currentUser, 'member.update.status', { type: 'member', id });
    if (dto.status === MemberStatus.INACTIVE) {
      const result = await this.offboardCore(id, currentUser, auditMeta);
      return result.member;
    }

    return this.prisma.$transaction(async (tx) => {
      await lockMemberLifecycle(tx, id);
      await this.access.findMemberOrThrow(id, tx);
      const updated = await tx.member.update({
        where: { id },
        data: { status: MemberStatus.ACTIVE },
        select: memberSafeSelect,
      });
      const linked = await this.query.findLinkedUser(id, tx);
      return attachAccountInfo(updated, linked);
    });
  }

  // ============ softDelete ============

  // 引用检查 + 软删事务原子(沿用 organizations Step 4 模式):
  //   - 有 active 部门归属(member_departments.memberId=:id, deletedAt=null)→ 拒绝
  //   - 有 v1 user 绑定(users.memberId=:id, deletedAt=null)→ 拒绝(防悬空外键)
  // 离队走 PATCH /:id/status → INACTIVE(不软删档案);软删仅"档案彻底无效"场景。
  async softDelete(id: string, currentUser: CurrentUserPayload): Promise<MemberResponseDto> {
    await this.access.assertCanOrThrow(currentUser, 'member.delete.record', { type: 'member', id });
    return this.prisma.$transaction(async (tx) => {
      await this.access.findMemberOrThrow(id, tx);

      const [activeDeptCount, linkedUserCount] = await Promise.all([
        // 终态 scoped-authz PR2:重指向 active PRIMARY membership(= 旧单部门语义,行为逐字保持)。
        tx.memberOrganizationMembership.count({
          where: {
            ...MembershipTermStateMachine.effectiveWhere(new Date()),
            memberId: id,
            membershipType: 'PRIMARY',
          },
        }),
        tx.user.count({
          where: { memberId: id, deletedAt: null },
        }),
      ]);
      if (activeDeptCount > 0) {
        throw new BizException(BizCode.MEMBER_HAS_ACTIVE_DEPARTMENT);
      }
      if (linkedUserCount > 0) {
        throw new BizException(BizCode.MEMBER_HAS_LINKED_USER);
      }

      const updated = await tx.member.update({
        where: { id },
        data: { deletedAt: new Date(), status: MemberStatus.INACTIVE },
        select: memberSafeSelect,
      });
      const linked = await this.query.findLinkedUser(id, tx);
      return attachAccountInfo(updated, linked);
    });
  }

  // ============ 队员账号闭环 v1(MVP)：grantAccount ============

  // ============ 队员账号闭环 v2:bindAccount ============

  // ============ 队员账号闭环 v2:unbindAccount ============

  // ============ 队员账号闭环 v2:reopenAccount ============

  // ============ 队员账号闭环 v2:updateAccountStatus ============

  // ============ 队员账号闭环 v2:bulkGrantAccounts ============

  // ============ 参与域生命周期收口⑤:一键离队编排(member offboard)============

  // POST admin/v1/members/:id/offboard:单事务关闭队员身份与全部当前授权来源。
  // **直连 prisma、不复用 member-departments/members 其它 service 方法**(Prisma 嵌套交互事务不支持 +
  // 防环,镜像 team-join-enrollment.service 一键入队先例)。事务腿:
  //   ① member.status=INACTIVE(已 INACTIVE → skip,幂等);
  //   ② END 该队员**全部** ACTIVE memberships(全类型 PRIMARY/SECONDARY/TEMPORARY/SUPPORT,
  //      status=ENDED + endedAt + endedByUserId;无 active → 0 条,幂等);
  //   ③ 若有 linked live User(role=USER)且非 DISABLED → status=DISABLED + 撤销全部未撤销未过期
  //      refresh(revokedReason='admin-disable',镜像 updateAccountStatus 唯一必要副作用);无 linked
  //      账号 → 跳过账号腿正常完成;
  //   ④ REVOKE active 任职与分管，并 END+软删 USER/MEMBER/active assignment 主体的 active RoleBinding；
  //   ⑤ 写 **1 条**伞 audit `member.offboard`(resourceType='member',extra 记各腿实际发生计数)。
  // 守卫(复用现成码,0 新 BizCode):member 不存在 → 15001;linked 账号 role≠USER → 15036
  // (先走用户轴处理,堵经队员轴绕过 last-SA / manage-user 护栏的提权,沿第三轮 review §F&A-1);
  // linked 是操作者本人 → CANNOT_OPERATE_SELF。Member 行锁是跨实例 lifecycle 线性化点；所有可重新引入
  // 账号/任职/分管/直接绑定的写路径先取同一锁，因此提交后不会残留旧授权来源。
  // 幂等:已 INACTIVE / 已 DISABLED / 无 active 归属重跑返 200,各腿 skip、extra 计数如实。

  // ============ 账号生命周期:薄委托(Phase 6-B 第三域第五刀)============
  //
  // 实现已迁至 member-account.service.ts(仅"搬家":判权 / 锁序 / 用户名派生 /
  // 末位管理员保护 / 审计逐字不变)。本 service 仍是本模块**唯一**对外入口。

  async grantAccount(...args: Parameters<MemberAccountService['grantAccount']>) {
    return this.accounts.grantAccount(...args);
  }

  async bindAccount(...args: Parameters<MemberAccountService['bindAccount']>) {
    return this.accounts.bindAccount(...args);
  }

  async unbindAccount(...args: Parameters<MemberAccountService['unbindAccount']>) {
    return this.accounts.unbindAccount(...args);
  }

  async reopenAccount(...args: Parameters<MemberAccountService['reopenAccount']>) {
    return this.accounts.reopenAccount(...args);
  }

  async updateAccountStatus(...args: Parameters<MemberAccountService['updateAccountStatus']>) {
    return this.accounts.updateAccountStatus(...args);
  }

  async bulkGrantAccounts(...args: Parameters<MemberAccountService['bulkGrantAccounts']>) {
    return this.accounts.bulkGrantAccounts(...args);
  }

  async offboard(
    id: string,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<MemberOffboardResponseDto> {
    await this.access.assertCanOrThrow(currentUser, 'member.offboard.record', {
      type: 'member',
      id,
    });
    return this.offboardCore(id, currentUser, auditMeta);
  }

  async getOffboardImpact(
    id: string,
    currentUser: CurrentUserPayload,
  ): Promise<MemberOffboardImpactResponseDto> {
    await this.access.assertCanOrThrow(currentUser, 'member.offboard.record', {
      type: 'member',
      id,
    });
    await this.access.findMemberOrThrow(id);
    return this.activityOffboardImpact.getImpact(id);
  }

  private async offboardCore(
    id: string,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<MemberOffboardResponseDto> {
    // M3:本事务内会取队员线性化键 ⇒ 必须显式 ReadCommitted + 有界锁等待(见 util 注释)。
    return runMemberLinearizedTransaction(this.prisma, async (tx) => {
      await this.lastAdminProtection.acquireOpsAdminInvariantLock(tx);
      // M2 唯一 transition:离队会结束全部 ACTIVE 归属(含 VOL 任期),该队员名下的 live
      // 申请随即 frozen。按拍板拒绝而不是顺手终结 —— 管理员应先一键入队或综合评估淘汰。
      // 位置在 ops-admin 全局 invariant 锁之后、Member 行锁之前(锁序见闸内注释)。
      await assertEnrollmentIdentityChangeAllowed(tx, id, new Date());
      await lockMemberLifecycle(tx, id);
      // 守卫:member 存在(不存在 / 软删 → 15001)。
      const member = await this.access.findMemberOrThrow(id, tx);
      // PR-F:Member lifecycle lock 是离队与活动责任移交的共同线性化点。预检端点仅供展示；
      // 真正的阻断必须在锁后、任何业务写与 audit 之前重新计算。
      const impact = await this.activityOffboardImpact.getImpact(id, tx);
      if (
        impact.draftInitiatedActivities.length > 0 ||
        impact.blockingReasons.includes('active-owner-handoff-required')
      ) {
        throw new BizException(BizCode.MEMBER_OFFBOARD_ACTIVITY_HANDOFF_REQUIRED);
      }
      if (impact.futureRegistrations.length > 0) {
        throw new BizException(BizCode.MEMBER_OFFBOARD_REGISTRATION_CLEANUP_REQUIRED);
      }

      // linked live 账号(含 role 用于护栏)。
      let linked = await tx.user.findFirst({
        where: { memberId: id, deletedAt: null },
        select: { id: true, status: true, role: true },
      });
      if (linked) {
        if (!(await lockAuthSessionUser(tx, linked.id))) {
          throw new BizException(BizCode.MEMBER_HAS_NO_LINKED_USER);
        }
        const lockedLinked = await tx.user.findFirst({
          where: { id: linked.id, memberId: id, deletedAt: null },
          select: { id: true, status: true, role: true },
        });
        if (!lockedLinked) throw new BizException(BizCode.MEMBER_HAS_NO_LINKED_USER);
        linked = lockedLinked;
        // 护栏(§F&A-1):队员轴只停 role=USER 的关联账号;非 USER(含 ADMIN/SUPER_ADMIN)一律拒,
        // 提示走用户管理端点(否则经离队旁路可停用特权账号,绕过用户轴 last-SA / manage-user 护栏)。
        if (linked.role !== Role.USER) {
          throw new BizException(BizCode.MEMBER_ACCOUNT_ROLE_NOT_MANAGEABLE);
        }
        // 自我保护:不允许离队会停用自己绑定的账号。
        if (linked.id === currentUser.id) {
          throw new BizException(BizCode.CANNOT_OPERATE_SELF);
        }
      }

      const now = new Date();

      // linked live 账号仅在当前仍启用时会进入停用腿；幂等 skip 不取锁。
      if (linked && linked.status !== UserStatus.DISABLED) {
        await this.lastAdminProtection.assertCanDeactivateOpsAdminUser(tx, linked.id);
      }

      // ① member INACTIVE(幂等 skip)。
      const memberDeactivated = member.status === MemberStatus.ACTIVE;
      if (memberDeactivated) {
        await tx.member.update({ where: { id }, data: { status: MemberStatus.INACTIVE } });
      }

      // ② END 全部 ACTIVE memberships(全类型)。Member 行锁下逐条走同一状态机；
      // ACTIVE 恒为已开始且无 endedAt，故统一以当前时刻结束。
      const activeMemberships = await tx.memberOrganizationMembership.findMany({
        where: { memberId: id, status: MembershipStatus.ACTIVE, deletedAt: null },
        select: { id: true, status: true, startedAt: true, endedAt: true },
      });
      for (const membership of activeMemberships) {
        const ended = MembershipTermStateMachine.end(membership, now);
        await tx.memberOrganizationMembership.update({
          where: { id: membership.id },
          data: {
            status: ended.status,
            endedAt: ended.endedAt,
            endedByUserId: currentUser.id,
          },
        });
      }
      const endedMemberships = { count: activeMemberships.length };

      // ③ 停用 linked 账号 + 撤 refresh(幂等 skip:无 linked / 已 DISABLED)。
      let accountDisabled = false;
      let refreshTokensRevoked = 0;
      if (linked && linked.status !== UserStatus.DISABLED) {
        await tx.user.update({ where: { id: linked.id }, data: { status: UserStatus.DISABLED } });
        const revoked = await tx.refreshToken.updateMany({
          where: { userId: linked.id, revokedAt: null, expiresAt: { gt: now } },
          data: { revokedAt: now, revokedReason: 'admin-disable' },
        });
        accountDisabled = true;
        refreshTokensRevoked = revoked.count;
      }

      // ④ 关闭全部当前授权来源。先锁后枚举 assignment ids，令 POSITION_ASSIGNMENT 主体绑定与
      // 底层任职在同一事务终止；历史行全部保留。
      const activeAssignments = await tx.organizationPositionAssignment.findMany({
        where: { memberId: id, status: AssignmentStatus.ACTIVE, deletedAt: null },
        select: { id: true },
      });
      const activeAssignmentIds = activeAssignments.map(({ id: assignmentId }) => assignmentId);

      const revokedPositionAssignments = await tx.organizationPositionAssignment.updateMany({
        where: {
          id: { in: activeAssignmentIds },
          status: AssignmentStatus.ACTIVE,
          deletedAt: null,
        },
        data: {
          status: AssignmentStatus.REVOKED,
          revokedByUserId: currentUser.id,
          endedAt: now,
        },
      });
      const revokedSupervisions = await tx.organizationSupervisionAssignment.updateMany({
        where: {
          supervisorMemberId: id,
          status: SupervisionStatus.ACTIVE,
          deletedAt: null,
        },
        data: {
          status: SupervisionStatus.REVOKED,
          revokedByUserId: currentUser.id,
          endedAt: now,
        },
      });
      const endedActivityResponsibilities = await tx.activityResponsibilityAssignment.updateMany({
        where: { memberId: id, status: 'active' },
        data: {
          status: 'revoked',
          endedAt: now,
          endedByUserId: currentUser.id,
        },
      });

      const principalOr: Prisma.RoleBindingWhereInput[] = [
        { principalType: PrincipalType.MEMBER, principalId: id },
      ];
      if (linked) {
        principalOr.push({ principalType: PrincipalType.USER, principalId: linked.id });
      }
      if (activeAssignmentIds.length > 0) {
        principalOr.push({
          principalType: PrincipalType.POSITION_ASSIGNMENT,
          principalId: { in: activeAssignmentIds },
        });
      }
      const endedRoleBindings = await tx.roleBinding.updateMany({
        where: {
          OR: principalOr,
          status: BindingStatus.ACTIVE,
          deletedAt: null,
        },
        data: { status: BindingStatus.ENDED, endedAt: now, deletedAt: now },
      });

      // 锁后残留探针：响应字段保持兼容，终态应恒为 0。
      const [residualActivePositionAssignments, residualActiveSupervisions] = await Promise.all([
        tx.organizationPositionAssignment.count({
          where: { memberId: id, status: 'ACTIVE', deletedAt: null },
        }),
        tx.organizationSupervisionAssignment.count({
          where: { supervisorMemberId: id, status: 'ACTIVE', deletedAt: null },
        }),
      ]);

      // ④ 伞 audit(一条 member.offboard,extra 记各腿实际发生计数)。
      await this.auditRecorder.offboard(tx, auditCtx(id, currentUser, auditMeta), {
        memberDeactivated,
        membershipsEnded: endedMemberships.count,
        accountDisabled,
        refreshTokensRevoked,
        linkedUserId: linked?.id ?? null,
        positionAssignmentsRevoked: revokedPositionAssignments.count,
        supervisionsRevoked: revokedSupervisions.count,
        activityResponsibilitiesEnded: endedActivityResponsibilities.count,
        roleBindingsEnded: endedRoleBindings.count,
        residualActivePositionAssignments,
        residualActiveSupervisions,
      });

      // 回读 member(INACTIVE 后)+ 账号信息,组装响应。
      const after = await this.access.findMemberOrThrow(id, tx);
      return {
        member: attachAccountInfo(
          after,
          linked ? { id: linked.id, status: UserStatus.DISABLED } : undefined,
        ),
        memberDeactivated,
        membershipsEnded: endedMemberships.count,
        accountDisabled,
        refreshTokensRevoked,
        linkedUserId: linked?.id ?? null,
        residualActivePositionAssignments,
        residualActiveSupervisions,
      };
    });
  }
}
