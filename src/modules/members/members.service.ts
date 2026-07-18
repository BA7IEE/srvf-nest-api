import { Injectable } from '@nestjs/common';
import {
  AssignmentStatus,
  BindingStatus,
  DictItemStatus,
  DictTypeStatus,
  MemberStatus,
  MembershipStatus,
  MembershipType,
  PrincipalType,
  Prisma,
  Role,
  SupervisionStatus,
  UserStatus,
} from '@prisma/client';
import { randomBytes } from 'node:crypto';
import * as bcrypt from 'bcryptjs';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { PageResultDto } from '../../common/dto/pagination.dto';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { notDeletedWhere } from '../../common/prisma/soft-delete.util';
import { PrismaService } from '../../database/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { MembershipTermStateMachine } from '../member-departments/membership-term-state-machine';
import { AuthzService } from '../authz/authz.service';
import type { ResourceRef } from '../authz/authz.types';
import { OrganizationsService } from '../organizations/organizations.service';
import { LastAdminProtectionPolicy } from '../permissions/last-admin-protection.policy';
import { RbacService } from '../permissions/rbac.service';
import { maskPhone } from '../sms/sms.constants';
import {
  BindMemberAccountDto,
  BulkGrantAccountResultItemDto,
  BulkGrantMemberAccountsDto,
  BulkGrantMemberAccountsResponseDto,
  BulkGrantSummaryDto,
  CreateMemberDto,
  GrantMemberAccountDto,
  GrantMemberAccountResponseDto,
  ListMembersQueryDto,
  MemberOffboardResponseDto,
  MemberOptionItemDto,
  MemberOptionsQueryDto,
  MemberOptionsResponseDto,
  MemberResponseDto,
  UpdateMemberAccountStatusDto,
  UpdateMemberDto,
  UpdateMemberStatusDto,
} from './members.dto';
import {
  lockLinkedUserLifecycle,
  lockMemberLifecycle,
  lockLiveUserLifecycle,
} from './member-lifecycle-lock';

// 队员账号闭环 v1(MVP,2026-07-07):BCRYPT_SALT_ROUNDS 与 users.service / recruitment-promotion.service
// 同值(各模块级声明,沿既有惯例)。
const BCRYPT_SALT_ROUNDS = 10;

// 队员等级 dict_type code(seed 内置真实值 member_grade,R13 收窄后队内分类可内置;详见 prisma/seed.ts V2_DICT_SEED)。
// 模块内常量化:Step 4 organizations 自有 'node_type';如未来需跨模块复用再抽 common。
const MEMBER_GRADE_DICT_CODE = 'member_grade';

// 集中定义对外 select。永不包含 deletedAt(软删除内部状态)。
const memberSafeSelect = {
  id: true,
  memberNo: true,
  displayName: true,
  gradeCode: true,
  status: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.MemberSelect;

type SafeMember = Prisma.MemberGetPayload<{ select: typeof memberSafeSelect }>;
type PrismaTx = Prisma.TransactionClient;

@Injectable()
export class MembersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rbac: RbacService,
    private readonly authz: AuthzService,
    private readonly lastAdminProtection: LastAdminProtectionPolicy,
    private readonly organizations: OrganizationsService,
    private readonly auditLogs: AuditLogsService,
  ) {}

  // ============ helpers ============

  // v0.49 部门数据范围:带 member ref 的点动作走三源 scoped authz。资源不存在时仅原本持有
  // GLOBAL RBAC 码者回退到既有业务 NOT_FOUND；scoped 调用者统一 30100，避免跨范围枚举。
  private async assertCanOrThrow(
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

  // memberNo 入库前 trim(保留原大小写,与 v1 username 的 toLowerCase 不同 — 编号即身份)
  private normalizeMemberNo(raw: string): string {
    return raw.trim();
  }

  private async findMemberOrThrow(id: string, tx?: PrismaTx): Promise<SafeMember> {
    const client = tx ?? this.prisma;
    const found = await client.member.findFirst({
      where: notDeletedWhere({ id }),
      select: memberSafeSelect,
    });
    if (!found) throw new BizException(BizCode.MEMBER_NOT_FOUND);
    return found;
  }

  // gradeCode 6 项 AND 校验(对应 docs/v2-api-contract.md §4.3,与 organizations 同模式):
  //   dict_type.code = MEMBER_GRADE_DICT_CODE
  //   dict_type.status = ACTIVE
  //   dict_type.deletedAt = null
  //   dict_item.code = gradeCode
  //   dict_item.status = ACTIVE
  //   dict_item.deletedAt = null
  private async assertGradeCodeValid(gradeCode: string, tx?: PrismaTx): Promise<void> {
    const client = tx ?? this.prisma;
    const item = await client.dictItem.findFirst({
      where: {
        code: gradeCode,
        status: DictItemStatus.ACTIVE,
        deletedAt: null,
        type: {
          code: MEMBER_GRADE_DICT_CODE,
          status: DictTypeStatus.ACTIVE,
          deletedAt: null,
        },
      },
      select: { id: true },
    });
    if (!item) throw new BizException(BizCode.MEMBER_GRADE_CODE_INVALID);
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

  // P2002 兜底:并发场景下预检查通过但 create 撞唯一约束(沿用 v1 users.service 模式)。
  // 队员账号闭环 v1:补 username / phone / memberId 三个 User 侧唯一约束目标(grantAccount 专用;
  // memberNo 目标服务本模块既有 create())。memberId 分支收尾补齐(2026-07-07,元核验 P3):
  // 两个管理员并发对同一队员开号时,输家的 INSERT 同时违反 username(=memberNo 两者相同)与
  // memberId 两个唯一约束,DB 只报其一且不保证是哪个 —— 未映射的一侧会裸 500;语义同
  // grantAccount 第 462-466 行 existingLink 预检查(该 memberId 槽位已被占用)。
  private async runWithUniqueConstraintGuard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const target = (err.meta?.target as string[] | undefined) ?? [];
        if (target.includes('memberNo')) {
          throw new BizException(BizCode.MEMBER_NO_ALREADY_EXISTS);
        }
        if (target.includes('username')) {
          throw new BizException(BizCode.USERNAME_ALREADY_EXISTS);
        }
        if (target.includes('phone')) {
          throw new BizException(BizCode.PHONE_ALREADY_BOUND);
        }
        // 队员账号闭环 v2(评审稿 §1.2 E-4):memberId 的唯一约束自本迁移起是手写
        // partial unique index(`User_memberId_active_key`),不再是 schema 声明的
        // `@unique`。本仓 position-assignments/supervision-assignments 已验证:手写
        // partial index 的 P2002 `meta.target` 不可靠(可能是列名,也可能是索引字面量
        // 名)。两条 OR 分支任一命中即映射同一 BizCode,不影响其余分支与既有"不含已
        // 映射键 → 原样上抛"单测契约。
        if (target.includes('memberId') || target.includes('User_memberId_active_key')) {
          throw new BizException(BizCode.MEMBER_HAS_LINKED_USER);
        }
      }
      throw err;
    }
  }

  // 队员账号闭环 v2(评审稿 §1.2 E-7):username 结构性冲突。User.username 仍是全量
  // @unique(不在本次改造范围,AGENTS §10"不复用"永久铁律),故一旦某 memberNo 曾经
  // 创建过账号(即使已软删,或曾 unbind 成悬空 memberId=null),那条历史/悬空行永久
  // 占用其 username——早期按 count(memberId) 推算"代际"曾在"grant → unbind → 再
  // grant"路径下失灵:unbind 只断链不软删,断链后 count(memberId) 归零而误判"从未
  // 开过号"重取裸 memberNo,100% 撞上那条仍占位的悬空行(队员账号闭环 v2 收尾修复)。
  //
  // 改为直接探测:已用代码验证 login-sms 完全按 phone 解析账号、从不读 username
  // (auth/login-sms.service.ts resolveActiveUserByPhone),故安全地从裸 memberNo 起
  // 依次尝试 `${memberNo}-2`、`${memberNo}-3`……直到找到第一个未被任何 User(含软删、
  // 含悬空 memberId=null)占用的 username 为止——不依赖 memberId,天然覆盖历史行/悬空行
  // 两类占用来源。
  private async computeNextUsername(memberNo: string, tx: PrismaTx): Promise<string> {
    let candidate = memberNo;
    let generation = 2;
    while (await tx.user.findUnique({ where: { username: candidate }, select: { id: true } })) {
      candidate = `${memberNo}-${generation}`;
      generation += 1;
    }
    return candidate;
  }

  // ============ 队员账号闭环 v1:hasAccount / accountStatus 批量计算(避免 N+1)============

  // 队员账号闭环 v1:User.memberId 曾是 @unique(每 member 至多 1 条历史 User,含软删)。
  // 队员账号闭环 v2(评审稿 §1.2 E-6):改 partial unique 后,reopen 可让同一 memberId
  // 同时存在 1 条软删历史行 + 1 条 live 行,查询显式收窄 `deletedAt: null`——hasAccount
  // 语义随之从"槽位是否被任何行占用过"收窄为"当前是否有 live 绑定",与 grantAccount()
  // 的 MEMBER_HAS_LINKED_USER 判定(同样只查 live)口径一致。
  private async loadLinkedUsersByMemberIds(
    memberIds: string[],
    tx?: PrismaTx,
  ): Promise<Map<string, { id: string; status: UserStatus }>> {
    if (memberIds.length === 0) return new Map();
    const client = tx ?? this.prisma;
    const users = await client.user.findMany({
      where: { memberId: { in: memberIds }, deletedAt: null },
      select: { id: true, memberId: true, status: true },
    });
    return new Map(users.map((u) => [u.memberId as string, { id: u.id, status: u.status }]));
  }

  private attachAccountInfo(
    member: SafeMember,
    linked: { id: string; status: UserStatus } | undefined,
  ): MemberResponseDto {
    return {
      ...member,
      hasAccount: linked !== undefined,
      accountStatus: linked?.status ?? null,
      userId: linked?.id ?? null,
    };
  }

  // 单条查询版(findOne / update / updateStatus / softDelete 共用;list 走批量版避免 N+1)。
  // 队员账号闭环 v2(评审稿 §1.2 E-6):同 loadLinkedUsersByMemberIds,显式收窄 live。
  private async findLinkedUser(
    memberId: string,
    tx?: PrismaTx,
  ): Promise<{ id: string; status: UserStatus } | undefined> {
    const client = tx ?? this.prisma;
    const user = await client.user.findFirst({
      where: { memberId, deletedAt: null },
      select: { id: true, status: true },
    });
    return user ?? undefined;
  }

  // ============ list ============

  // v0.49:成员列表的 organizationId 用户过滤与授权组织集合取交集。成员归属严格只认
  // active PRIMARY，SECONDARY/TEMPORARY/SUPPORT 均不得扩大可见范围。
  private async buildOrganizationScopeFilter(
    currentUser: CurrentUserPayload,
    organizationId: string | undefined,
    includeDescendants: boolean | undefined,
  ): Promise<Prisma.MemberWhereInput | undefined> {
    const authScope = await this.authz.getVisibleOrganizationScope(
      currentUser,
      'member.read.record',
    );
    if (!authScope.hasPermission) {
      throw new BizException(BizCode.RBAC_FORBIDDEN);
    }

    const requestedOrgIds =
      organizationId === undefined
        ? undefined
        : includeDescendants
          ? await this.organizations.queryDescendantOrgIds(organizationId)
          : [organizationId];

    if (authScope.global && requestedOrgIds === undefined) return undefined;
    const orgIds = authScope.global
      ? (requestedOrgIds ?? [])
      : requestedOrgIds === undefined
        ? authScope.organizationIds
        : requestedOrgIds.filter((id) => authScope.organizationIds.includes(id));

    return {
      memberOrganizationMemberships: {
        some: {
          ...MembershipTermStateMachine.effectiveWhere(new Date()),
          organizationId: { in: orgIds },
          membershipType: MembershipType.PRIMARY,
        },
      },
    };
  }

  async list(
    query: ListMembersQueryDto,
    currentUser: CurrentUserPayload,
  ): Promise<PageResultDto<MemberResponseDto>> {
    const {
      page,
      pageSize,
      memberNo,
      gradeCode,
      status,
      q,
      organizationId,
      includeDescendants,
      hasAccount,
    } = query;

    const filters: Prisma.MemberWhereInput = {};
    if (memberNo !== undefined) filters.memberNo = memberNo; // 精确匹配(完整字符串相等)
    if (gradeCode !== undefined) filters.gradeCode = gradeCode;
    if (status !== undefined) filters.status = status;
    if (q !== undefined) {
      filters.OR = [
        { displayName: { contains: q, mode: 'insensitive' } },
        { memberNo: { contains: q, mode: 'insensitive' } },
      ];
    }
    const orgScope = await this.buildOrganizationScopeFilter(
      currentUser,
      organizationId,
      includeDescendants,
    );
    if (orgScope !== undefined) Object.assign(filters, orgScope);
    // 队员账号闭环 v1:hasAccount 经 users 反向关联过滤。
    // 队员账号闭环 v2(评审稿 §1.2 E-1/E-2/E-6):User.memberId 改一对多(partial unique),
    // 关系过滤语法从一对一 `is`/`isNot` 改一对多 `some`/`none`;reopen 落地后同一 memberId
    // 可能有多条软删历史行,显式收窄 `deletedAt: null`——hasAccount 语义与 findLinkedUser /
    // loadLinkedUsersByMemberIds(同一收窄)、grantAccount 的 existingLink(D-2 仅 live)保持一致。
    if (hasAccount === true) filters.users = { some: { deletedAt: null } };
    if (hasAccount === false) filters.users = { none: { deletedAt: null } };

    const where = notDeletedWhere(filters);

    const [items, total] = await this.prisma.$transaction([
      this.prisma.member.findMany({
        where,
        select: memberSafeSelect,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.member.count({ where }),
    ]);

    const linkedByMemberId = await this.loadLinkedUsersByMemberIds(items.map((m) => m.id));
    return {
      items: items.map((m) => this.attachAccountInfo(m, linkedByMemberId.get(m.id))),
      total,
      page,
      pageSize,
    };
  }

  // ============ F1/A1 选择器(路线图 §4;D2/D3 拍板)============

  // options = list 的轻量投影;复用 member.read.record(D2,不新增权限码)。
  async options(
    query: MemberOptionsQueryDto,
    currentUser: CurrentUserPayload,
  ): Promise<MemberOptionsResponseDto> {
    const { q, organizationId, includeDescendants, limit } = query;

    const filters: Prisma.MemberWhereInput = {};
    if (q !== undefined) {
      filters.OR = [
        { displayName: { contains: q, mode: 'insensitive' } },
        { memberNo: { contains: q, mode: 'insensitive' } },
      ];
    }
    const orgScope = await this.buildOrganizationScopeFilter(
      currentUser,
      organizationId,
      includeDescendants,
    );
    if (orgScope !== undefined) Object.assign(filters, orgScope);

    const rows = await this.prisma.member.findMany({
      where: notDeletedWhere(filters),
      select: memberSafeSelect,
      orderBy: { createdAt: 'desc' },
      take: limit ?? 20,
    });

    const items: MemberOptionItemDto[] = rows.map((r) => ({
      id: r.id,
      label: r.displayName,
      memberNo: r.memberNo,
      gradeCode: r.gradeCode,
    }));
    return { items };
  }

  // ============ create ============

  async create(dto: CreateMemberDto, currentUser: CurrentUserPayload): Promise<MemberResponseDto> {
    await this.assertCanOrThrow(currentUser, 'member.create.record');
    const memberNo = this.normalizeMemberNo(dto.memberNo);

    return this.prisma.$transaction(async (tx) => {
      // 1. gradeCode 校验(若提供)— 在唯一性预检查之前,业务校验先于资源约束
      if (dto.gradeCode !== undefined) {
        await this.assertGradeCodeValid(dto.gradeCode, tx);
      }

      // 2. memberNo 唯一性预检查(包含软删)
      await this.assertMemberNoUnique(memberNo, tx);

      const created = await this.runWithUniqueConstraintGuard(() =>
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
      return this.attachAccountInfo(created, undefined);
    });
  }

  // ============ findOne ============

  async findOne(id: string, currentUser: CurrentUserPayload): Promise<MemberResponseDto> {
    await this.assertCanOrThrow(currentUser, 'member.read.record', { type: 'member', id });
    const member = await this.findMemberOrThrow(id);
    const linked = await this.findLinkedUser(id);
    return this.attachAccountInfo(member, linked);
  }

  // ============ update ============

  // 仅允许 displayName / gradeCode;memberNo / status 由 DTO 白名单兜底拒绝。
  async update(
    id: string,
    dto: UpdateMemberDto,
    currentUser: CurrentUserPayload,
  ): Promise<MemberResponseDto> {
    await this.assertCanOrThrow(currentUser, 'member.update.record', { type: 'member', id });
    return this.prisma.$transaction(async (tx) => {
      await this.findMemberOrThrow(id, tx);

      if (dto.gradeCode !== undefined) {
        await this.assertGradeCodeValid(dto.gradeCode, tx);
      }

      const data: Prisma.MemberUpdateInput = {};
      if (dto.displayName !== undefined) data.displayName = dto.displayName;
      if (dto.gradeCode !== undefined) data.gradeCode = dto.gradeCode;

      const updated = await tx.member.update({
        where: { id },
        data,
        select: memberSafeSelect,
      });
      const linked = await this.findLinkedUser(id, tx);
      return this.attachAccountInfo(updated, linked);
    });
  }

  // ============ updateStatus ============

  async updateStatus(
    id: string,
    dto: UpdateMemberStatusDto,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<MemberResponseDto> {
    await this.assertCanOrThrow(currentUser, 'member.update.status', { type: 'member', id });
    if (dto.status === MemberStatus.INACTIVE) {
      const result = await this.offboardCore(id, currentUser, auditMeta);
      return result.member;
    }

    return this.prisma.$transaction(async (tx) => {
      await lockMemberLifecycle(tx, id);
      await this.findMemberOrThrow(id, tx);
      const updated = await tx.member.update({
        where: { id },
        data: { status: MemberStatus.ACTIVE },
        select: memberSafeSelect,
      });
      const linked = await this.findLinkedUser(id, tx);
      return this.attachAccountInfo(updated, linked);
    });
  }

  // ============ softDelete ============

  // 引用检查 + 软删事务原子(沿用 organizations Step 4 模式):
  //   - 有 active 部门归属(member_departments.memberId=:id, deletedAt=null)→ 拒绝
  //   - 有 v1 user 绑定(users.memberId=:id, deletedAt=null)→ 拒绝(防悬空外键)
  // 离队走 PATCH /:id/status → INACTIVE(不软删档案);软删仅"档案彻底无效"场景。
  async softDelete(id: string, currentUser: CurrentUserPayload): Promise<MemberResponseDto> {
    await this.assertCanOrThrow(currentUser, 'member.delete.record', { type: 'member', id });
    return this.prisma.$transaction(async (tx) => {
      await this.findMemberOrThrow(id, tx);

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
      const linked = await this.findLinkedUser(id, tx);
      return this.attachAccountInfo(updated, linked);
    });
  }

  // ============ 队员账号闭环 v1(MVP)：grantAccount ============

  // POST /:id/account:给已存在队员开通"手机验证码登录"账号(不设密码)。
  // 建号镜像 recruitment-promotion.service.ts:125-188 先例:随机不可用 passwordHash +
  // username=memberNo + role=USER;不复用 UsersService(防环 + 零漂移,沿 promote 同一先例)。
  //
  // 校验顺序(先业务后唯一性,与本模块 create() 同口径):
  //   1. member 存在且未软删 → 否则 MEMBER_NOT_FOUND
  //   2. member.status === ACTIVE → 否则 MEMBER_INACTIVE
  //   3. 该 memberId 槽位无 live 关联(队员账号闭环 v2:User.memberId 已改 partial unique
  //      WHERE deletedAt IS NULL,槽位仅在 live 时占用;历史软删行不再阻塞——这是对 v1
  //      唯一有意的行为变更,评审稿 D-2)→ 否则 MEMBER_HAS_LINKED_USER
  //   4. username(=memberNo)唯一性预检查含软删占用(沿 AGENTS §10 不复用范式)→ 否则 USERNAME_ALREADY_EXISTS
  //   5. phone 唯一性预检查含软删占用 → 否则 PHONE_ALREADY_BOUND
  async grantAccount(
    id: string,
    dto: GrantMemberAccountDto,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<GrantMemberAccountResponseDto> {
    await this.assertCanOrThrow(currentUser, 'member.grant.account', { type: 'member', id });
    return this.grantAccountCore(id, dto.phone, currentUser, auditMeta);
  }

  // 队员账号闭环 v2(评审稿 §1.2 E-11):从 grantAccount() 抽出的核心逻辑(校验 + 创建 +
  // audit,不含权限检查),供单条端点与 bulkGrantAccounts() 批量循环共用——批量场景下
  // 权限只需在循环外检查一次,每行仍各自独立开一个事务(E-10,故本方法自己调用
  // `this.prisma.$transaction`,不接受调用方传入的 tx)。
  private async grantAccountCore(
    id: string,
    phone: string,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<GrantMemberAccountResponseDto> {
    return this.prisma.$transaction(async (tx) => {
      await lockMemberLifecycle(tx, id);
      const member = await tx.member.findFirst({
        where: notDeletedWhere({ id }),
        select: { id: true, memberNo: true, status: true },
      });
      if (!member) throw new BizException(BizCode.MEMBER_NOT_FOUND);
      if (member.status !== MemberStatus.ACTIVE) {
        throw new BizException(BizCode.MEMBER_INACTIVE);
      }

      const existingLink = await tx.user.findFirst({
        where: { memberId: id, deletedAt: null },
        select: { id: true },
      });
      if (existingLink) throw new BizException(BizCode.MEMBER_HAS_LINKED_USER);

      // 队员账号闭环 v2(评审稿 §1.2 E-7):该 memberNo 曾有历史行/悬空行(即使已软删
      // 或已 unbind)时,裸 memberNo 这个 username 被占用,探测式自动后缀化;首次开号
      // (v1 常见路径)逐字不变,仍是裸 memberNo。
      const username = await this.computeNextUsername(member.memberNo, tx);

      const existingUsername = await tx.user.findUnique({
        where: { username },
        select: { id: true },
      });
      if (existingUsername) throw new BizException(BizCode.USERNAME_ALREADY_EXISTS);

      const existingPhone = await tx.user.findUnique({
        where: { phone },
        select: { id: true },
      });
      if (existingPhone) throw new BizException(BizCode.PHONE_ALREADY_BOUND);

      // 随机不可用口令(镜像 recruitment-promotion.service.ts:122-127;SMS 登录无密码可强制,
      // v1 不设初始密码入参)。
      const passwordHash = await bcrypt.hash(
        randomBytes(48).toString('base64'),
        BCRYPT_SALT_ROUNDS,
      );
      const now = new Date();

      const created = await this.runWithUniqueConstraintGuard(() =>
        tx.user.create({
          data: {
            username,
            phone,
            phoneVerifiedAt: now, // 管理员背书,非用户自证短信验证
            passwordHash,
            role: Role.USER,
            memberId: id,
          },
          select: { id: true, username: true, phone: true, phoneVerifiedAt: true, role: true },
        }),
      );

      await this.auditLogs.log({
        event: 'member.account-granted',
        actorUserId: currentUser.id,
        actorRoleSnap: currentUser.role,
        resourceType: 'member',
        resourceId: id,
        meta: auditMeta,
        extra: { memberId: id, userId: created.id, phone: maskPhone(phone) },
        tx,
      });

      return {
        userId: created.id,
        username: created.username,
        phone: created.phone as string,
        phoneVerifiedAt: created.phoneVerifiedAt as Date,
        role: created.role,
        memberId: id,
      };
    });
  }

  // ============ 队员账号闭环 v2:bindAccount ============

  // POST /:id/account/bind:认领一个已存在、live 且未绑定任何队员(memberId=null)的悬空
  // 账号(如 POST admin/v1/users 建的)到本队员。账号保留其原有登录方式(密码 / openid /
  // phone),不改 username / passwordHash,不强制手机号。
  //
  // 校验顺序(评审稿 §5):
  //   1. member 存在且未软删 → 否则 MEMBER_NOT_FOUND
  //   2. member.status === ACTIVE → 否则 MEMBER_INACTIVE
  //   3. 本队员无 live 关联账号 → 否则 MEMBER_HAS_LINKED_USER
  //   4. 目标 userId 存在且未软删 → 否则 USER_NOT_FOUND(跨实体引用复用被引用方 NOT_FOUND,
  //      沿 position-assignments/supervision-assignments 既有范式)
  //   5. 目标账号 memberId === null(未被他人绑定)→ 否则 MEMBER_ACCOUNT_TARGET_ALREADY_LINKED
  async bindAccount(
    id: string,
    dto: BindMemberAccountDto,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<MemberResponseDto> {
    await this.assertCanOrThrow(currentUser, 'member.bind.account', { type: 'member', id });

    return this.prisma.$transaction(async (tx) => {
      await lockMemberLifecycle(tx, id);
      const member = await this.findMemberOrThrow(id, tx);
      if (member.status !== MemberStatus.ACTIVE) {
        throw new BizException(BizCode.MEMBER_INACTIVE);
      }

      const existingLink = await tx.user.findFirst({
        where: { memberId: id, deletedAt: null },
        select: { id: true },
      });
      if (existingLink) throw new BizException(BizCode.MEMBER_HAS_LINKED_USER);

      const target = await tx.user.findFirst({
        where: notDeletedWhere({ id: dto.userId }),
        select: { id: true, memberId: true, status: true, role: true },
      });
      if (!target) throw new BizException(BizCode.USER_NOT_FOUND);
      await lockLiveUserLifecycle(tx, target.id);
      const lockedTarget = await tx.user.findFirst({
        where: notDeletedWhere({ id: target.id }),
        select: { id: true, memberId: true, status: true, role: true },
      });
      if (!lockedTarget) throw new BizException(BizCode.USER_NOT_FOUND);
      if (lockedTarget.memberId !== null) {
        throw new BizException(BizCode.MEMBER_ACCOUNT_TARGET_ALREADY_LINKED);
      }
      // 第三轮 review 护栏收口(§F&A-1/A-4):只认领 role=USER 且 status=ACTIVE 的悬空账号。
      // 否则可把特权账号(ADMIN/SUPER_ADMIN)经队员轴挂到队员,此后经 updateAccountStatus /
      // reopenAccount 停用/软删它,绕过用户轴 assertNotLastSuperAdmin + assertCanManageUser
      // 两道刻意写死的护栏(报告 §F&A-1 攻击序列)。role 先于 status 判,诊断更精确。
      if (lockedTarget.role !== Role.USER) {
        throw new BizException(BizCode.MEMBER_ACCOUNT_TARGET_ROLE_NOT_ALLOWED);
      }
      if (lockedTarget.status !== UserStatus.ACTIVE) {
        throw new BizException(BizCode.MEMBER_ACCOUNT_TARGET_NOT_ACTIVE);
      }

      const updated = await this.runWithUniqueConstraintGuard(() =>
        tx.user.update({
          where: { id: dto.userId },
          data: { memberId: id },
          select: { id: true, status: true },
        }),
      );

      await this.auditLogs.log({
        event: 'member.account-bound',
        actorUserId: currentUser.id,
        actorRoleSnap: currentUser.role,
        resourceType: 'member',
        resourceId: id,
        meta: auditMeta,
        extra: { memberId: id, userId: updated.id },
        tx,
      });

      return this.attachAccountInfo(member, { id: updated.id, status: updated.status });
    });
  }

  // ============ 队员账号闭环 v2:unbindAccount ============

  // POST /:id/account/unbind:只断链(置 memberId=null),不顺手停用/软删账号(D-4 维护者
  // 定稿)。账号回到"悬空 ACTIVE"(= bindAccount 的逆);要停用/删除走既有用户管理端点。
  async unbindAccount(
    id: string,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<MemberResponseDto> {
    await this.assertCanOrThrow(currentUser, 'member.bind.account', { type: 'member', id });

    return this.prisma.$transaction(async (tx) => {
      await lockMemberLifecycle(tx, id);
      const member = await this.findMemberOrThrow(id, tx);

      await lockLinkedUserLifecycle(tx, id);
      const linked = await tx.user.findFirst({
        where: { memberId: id, deletedAt: null },
        select: { id: true },
      });
      if (!linked) throw new BizException(BizCode.MEMBER_HAS_NO_LINKED_USER);

      await tx.user.update({
        where: { id: linked.id },
        data: { memberId: null },
      });

      await this.auditLogs.log({
        event: 'member.account-unbound',
        actorUserId: currentUser.id,
        actorRoleSnap: currentUser.role,
        resourceType: 'member',
        resourceId: id,
        meta: auditMeta,
        extra: { memberId: id, userId: linked.id },
        tx,
      });

      return this.attachAccountInfo(member, undefined);
    });
  }

  // ============ 队员账号闭环 v2:reopenAccount ============

  // POST /:id/account/reopen:"账号打错了"一步修复——软删旧号(deletedAt + status=
  // DISABLED)+ 开新号(新手机号),单事务原子;靠 User.memberId 的 partial unique
  // 根改造让新号取到released 槽位。
  //
  // username 结构性冲突(评审稿 §1.2 E-7):User.username 仍是全量 @unique(不在本次
  // 改造范围,AGENTS §10"不复用"永久铁律),旧行软删后仍永久占用其 username——若新行
  // 沿用同一 memberNo 会 100% 撞车。已用代码验证 login-sms 完全按 phone 解析账号、
  // 从不读 username,故重开时安全地用 `${memberNo}-{generation}` 后缀化(第 1 次
  // grant 仍是裸 memberNo,v1 行为逐字不变;仅第 2 次起 reopen 才出现后缀)。
  //
  // 校验顺序(评审稿 §5):
  //   1. member 存在且未软删 → 否则 MEMBER_NOT_FOUND
  //   2. member.status === ACTIVE → 否则 MEMBER_INACTIVE
  //   3. member 有 live 关联账号 → 否则 MEMBER_HAS_NO_LINKED_USER(无账号可重开,应走开号)
  //   4. 新 username 唯一性预检查(理论恒过,防御性保留,沿 grantAccount 同款)
  //   5. phone 唯一性预检查含软删占用(与旧行同手机号会在此命中 PHONE_ALREADY_BOUND——
  //      phone 同样不在本次改造范围,这是有意行为而非缺陷)
  async reopenAccount(
    id: string,
    dto: GrantMemberAccountDto,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<GrantMemberAccountResponseDto> {
    await this.assertCanOrThrow(currentUser, 'member.grant.account', { type: 'member', id });

    return this.prisma.$transaction(async (tx) => {
      await this.lastAdminProtection.acquireOpsAdminInvariantLock(tx);
      await lockMemberLifecycle(tx, id);
      const member = await tx.member.findFirst({
        where: notDeletedWhere({ id }),
        select: { id: true, memberNo: true, status: true },
      });
      if (!member) throw new BizException(BizCode.MEMBER_NOT_FOUND);
      if (member.status !== MemberStatus.ACTIVE) {
        throw new BizException(BizCode.MEMBER_INACTIVE);
      }

      await lockLinkedUserLifecycle(tx, id);
      const oldLink = await tx.user.findFirst({
        where: { memberId: id, deletedAt: null },
        select: { id: true, role: true },
      });
      if (!oldLink) throw new BizException(BizCode.MEMBER_HAS_NO_LINKED_USER);
      // 第三轮 review 护栏收口(§F&A-1):reopen 会软删旧号——若旧号经用户轴 updateRole 提权为
      // 非 USER(如 ADMIN),软删它会绕过用户轴 last-SA / manage-user 护栏。非 USER 一律拒,
      // 提示走用户管理端点。
      if (oldLink.role !== Role.USER) {
        throw new BizException(BizCode.MEMBER_ACCOUNT_ROLE_NOT_MANAGEABLE);
      }

      // 复用探测式 computeNextUsername:此刻 oldLink 仍 live(软删滞后到下方发生),
      // 其占用的 username 仍未释放,故探测必然跳过该值取到更高代际(-2/-3/...);
      // 裸 memberNo 分支不会在 reopen 路径触发(oldLink 存在本身就证明 memberNo 或
      // 某代际后缀已被占用)。
      const newUsername = await this.computeNextUsername(member.memberNo, tx);

      const existingUsername = await tx.user.findUnique({
        where: { username: newUsername },
        select: { id: true },
      });
      if (existingUsername) throw new BizException(BizCode.USERNAME_ALREADY_EXISTS);

      const existingPhone = await tx.user.findUnique({
        where: { phone: dto.phone },
        select: { id: true },
      });
      if (existingPhone) throw new BizException(BizCode.PHONE_ALREADY_BOUND);

      // 先软删旧行释放 partial unique 槽位,再建新行——顺序不可颠倒(先建会与仍
      // live 的旧行同时违反 partial unique)。
      await this.lastAdminProtection.assertCanDeactivateOpsAdminUser(tx, oldLink.id);
      await tx.user.update({
        where: { id: oldLink.id },
        data: { deletedAt: new Date(), status: UserStatus.DISABLED },
      });

      const passwordHash = await bcrypt.hash(
        randomBytes(48).toString('base64'),
        BCRYPT_SALT_ROUNDS,
      );
      const now = new Date();

      const created = await this.runWithUniqueConstraintGuard(() =>
        tx.user.create({
          data: {
            username: newUsername,
            phone: dto.phone,
            phoneVerifiedAt: now,
            passwordHash,
            role: Role.USER,
            memberId: id,
          },
          select: { id: true, username: true, phone: true, phoneVerifiedAt: true, role: true },
        }),
      );

      await this.auditLogs.log({
        event: 'member.account-reopened',
        actorUserId: currentUser.id,
        actorRoleSnap: currentUser.role,
        resourceType: 'member',
        resourceId: id,
        meta: auditMeta,
        extra: {
          memberId: id,
          oldUserId: oldLink.id,
          newUserId: created.id,
          phone: maskPhone(dto.phone),
        },
        tx,
      });

      return {
        userId: created.id,
        username: created.username,
        phone: created.phone as string,
        phoneVerifiedAt: created.phoneVerifiedAt as Date,
        role: created.role,
        memberId: id,
      };
    });
  }

  // ============ 队员账号闭环 v2:updateAccountStatus ============

  // PATCH /:id/account/status:队员面直接启停关联账号。判权复用 user.update.status
  // (D-6,不新增权限码)。不复用 UsersService.updateStatus()(该服务 exports 未包含
  // UsersService,沿既有模块边界;本模块对 User 表写入的既定范式就是直连 prisma,
  // 不经 UsersService,镜像 grantAccount"不复用 UsersService,防环 + 零漂移"先例),
  // 改为直连 prisma 显式复刻其唯一必要副作用:禁用时撤销该 user 全部未撤销未过期
  // refresh token(revokedReason='admin-disable',AGENTS §9 联动撤销场景 4 的第二条
  // 触发路径);不做"最后一个 SUPER_ADMIN 保护":队员轴只管理 role=USER 的关联账号——下方
  // 前置校验 linked.role===USER 拒非 USER(bind 亦只认领 role=USER+ACTIVE 悬空账号,
  // grant/reopen 恒建 role=USER),故非 USER(含唯一能触发 last-SA 保护的 SUPER_ADMIN)在
  // 到达这里前已被挡下(第三轮 review §F&A-1 收口;原注释"bind/grant/reopen 恒 role=USER"
  // 的前提对 bind 不成立——bind 挂的是既有任意角色账号,故以前置校验替代该失效前提);
  // 仅当置 DISABLED 时做自我保护检查(镜像 UsersService.updateStatus,
  // 防管理员通过队员轴误禁自己绑定的账号)。第七刀补齐本入口的结构化审计:
  // user status 写、refresh 撤销与 member.account.status-change 必须同事务提交 / 回滚。
  async updateAccountStatus(
    id: string,
    dto: UpdateMemberAccountStatusDto,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<MemberResponseDto> {
    await this.assertCanOrThrow(currentUser, 'user.update.status', { type: 'member', id });

    return this.prisma.$transaction(async (tx) => {
      if (dto.status === UserStatus.DISABLED) {
        await this.lastAdminProtection.acquireOpsAdminInvariantLock(tx);
      }
      await lockMemberLifecycle(tx, id);
      const member = await this.findMemberOrThrow(id, tx);

      await lockLinkedUserLifecycle(tx, id);
      const linked = await tx.user.findFirst({
        where: { memberId: id, deletedAt: null },
        select: { id: true, status: true, role: true },
      });
      if (!linked) throw new BizException(BizCode.MEMBER_HAS_NO_LINKED_USER);

      // 第三轮 review 护栏收口(§F&A-1):队员轴只启停 role=USER 的关联账号。若该账号经用户轴
      // updateRole 被提权(如提为 ADMIN),停用它会绕过用户轴 assertCanManageUser /
      // assertNotLastSuperAdmin——非 USER 一律拒,提示走用户管理端点。前置于自我保护检查:
      // "此账号不归本轴管理"是更根本的判定。
      if (linked.role !== Role.USER) {
        throw new BizException(BizCode.MEMBER_ACCOUNT_ROLE_NOT_MANAGEABLE);
      }

      if (dto.status === UserStatus.ACTIVE && member.status !== MemberStatus.ACTIVE) {
        throw new BizException(BizCode.MEMBER_INACTIVE);
      }

      if (dto.status === UserStatus.DISABLED) {
        if (linked.id === currentUser.id) {
          throw new BizException(BizCode.CANNOT_OPERATE_SELF);
        }
        await this.lastAdminProtection.assertCanDeactivateOpsAdminUser(tx, linked.id);
      }

      const updated = await tx.user.update({
        where: { id: linked.id },
        data: { status: dto.status },
        select: { id: true, status: true },
      });

      let refreshTokensRevoked = 0;
      if (dto.status === UserStatus.DISABLED) {
        const revoked = await tx.refreshToken.updateMany({
          where: { userId: linked.id, revokedAt: null, expiresAt: { gt: new Date() } },
          data: { revokedAt: new Date(), revokedReason: 'admin-disable' },
        });
        refreshTokensRevoked = revoked.count;
      }

      await this.auditLogs.log({
        event: 'member.account.status-change',
        actorUserId: currentUser.id,
        actorRoleSnap: currentUser.role,
        resourceType: 'member',
        resourceId: id,
        meta: auditMeta,
        before: { status: linked.status },
        after: { status: updated.status },
        extra: { linkedUserId: updated.id, refreshTokensRevoked },
        tx,
      });

      return this.attachAccountInfo(member, { id: updated.id, status: updated.status });
    });
  }

  // ============ 队员账号闭环 v2:bulkGrantAccounts ============

  // POST members/accounts/bulk-grant:批量开号,镜像 announcement-import 批模式。
  // 权限只在循环外检查一次;逐行调用 grantAccountCore(各自独立 $transaction,E-10)——
  // 单行失败(BizException)不影响其余行,记 blocked + 原因继续;非 BizException 的
  // 意外错误原样上抛,不吞入批量结果(与既有 P2002 兜底"未映射 target 原样上抛"同一原则)。
  async bulkGrantAccounts(
    dto: BulkGrantMemberAccountsDto,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<BulkGrantMemberAccountsResponseDto> {
    const scope = await this.authz.getVisibleOrganizationScope(currentUser, 'member.grant.account');
    if (!scope.hasPermission) {
      throw new BizException(BizCode.RBAC_FORBIDDEN);
    }

    const items: BulkGrantAccountResultItemDto[] = [];
    for (const item of dto.items) {
      try {
        await this.assertCanOrThrow(currentUser, 'member.grant.account', {
          type: 'member',
          id: item.memberId,
        });
        const result = await this.grantAccountCore(
          item.memberId,
          item.phone,
          currentUser,
          auditMeta,
        );
        items.push({
          memberId: item.memberId,
          status: 'ok',
          userId: result.userId,
          reason: null,
        });
      } catch (err) {
        if (!(err instanceof BizException)) throw err;
        items.push({
          memberId: item.memberId,
          status: 'blocked',
          userId: null,
          reason: err.biz.message,
        });
      }
    }

    const summary: BulkGrantSummaryDto = {
      total: items.length,
      ok: items.filter((i) => i.status === 'ok').length,
      blocked: items.filter((i) => i.status === 'blocked').length,
    };

    return { items, summary };
  }

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
  async offboard(
    id: string,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<MemberOffboardResponseDto> {
    await this.assertCanOrThrow(currentUser, 'member.offboard.record', { type: 'member', id });
    return this.offboardCore(id, currentUser, auditMeta);
  }

  private async offboardCore(
    id: string,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<MemberOffboardResponseDto> {
    return this.prisma.$transaction(async (tx) => {
      await this.lastAdminProtection.acquireOpsAdminInvariantLock(tx);
      await lockMemberLifecycle(tx, id);
      // 守卫:member 存在(不存在 / 软删 → 15001)。
      const member = await this.findMemberOrThrow(id, tx);

      // linked live 账号(含 role 用于护栏)。
      await lockLinkedUserLifecycle(tx, id);
      const linked = await tx.user.findFirst({
        where: { memberId: id, deletedAt: null },
        select: { id: true, status: true, role: true },
      });
      if (linked) {
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

      // ② END 全部 ACTIVE memberships(全类型)。Member 行锁下逐条走同一状态机，
      // 未来任期撤销取 endedAt=startedAt，避免 endedAt 早于 startedAt。
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
      await this.auditLogs.log({
        event: 'member.offboard',
        actorUserId: currentUser.id,
        actorRoleSnap: currentUser.role,
        resourceType: 'member',
        resourceId: id,
        meta: auditMeta,
        extra: {
          memberDeactivated,
          membershipsEnded: endedMemberships.count,
          accountDisabled,
          refreshTokensRevoked,
          linkedUserId: linked?.id ?? null,
          positionAssignmentsRevoked: revokedPositionAssignments.count,
          supervisionsRevoked: revokedSupervisions.count,
          roleBindingsEnded: endedRoleBindings.count,
          residualActivePositionAssignments,
          residualActiveSupervisions,
        },
        tx,
      });

      // 回读 member(INACTIVE 后)+ 账号信息,组装响应。
      const after = await this.findMemberOrThrow(id, tx);
      return {
        member: this.attachAccountInfo(
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
