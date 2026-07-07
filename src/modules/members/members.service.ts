import { Injectable } from '@nestjs/common';
import {
  DictItemStatus,
  DictTypeStatus,
  MemberStatus,
  Prisma,
  Role,
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
import { OrganizationsService } from '../organizations/organizations.service';
import { RbacService } from '../permissions/rbac.service';
import { maskPhone } from '../sms/sms.constants';
import {
  CreateMemberDto,
  GrantMemberAccountDto,
  GrantMemberAccountResponseDto,
  ListMembersQueryDto,
  MemberOptionItemDto,
  MemberOptionsQueryDto,
  MemberOptionsResponseDto,
  MemberResponseDto,
  UpdateMemberDto,
  UpdateMemberStatusDto,
} from './members.dto';

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
    private readonly organizations: OrganizationsService,
    private readonly auditLogs: AuditLogsService,
  ) {}

  // ============ helpers ============

  // Slow-4 T2(2026-06-11,评审稿 §3.1 / D-S4-8):RBAC 判权(沿 P0-F assertCanOrThrow 范式)。
  // 每个 public 方法第一条语句调用——先判权后查资源,保持与原 Guard 前置语义一致。
  // `member.delete.record` 不绑 biz-admin(仅 SUPER_ADMIN 短路;D1=A 镜像)。
  private async assertCanOrThrow(user: CurrentUserPayload, action: string): Promise<void> {
    if (!(await this.rbac.can(user, action))) {
      throw new BizException(BizCode.RBAC_FORBIDDEN);
    }
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
  // 队员账号闭环 v1:补 username / phone 两个 User 侧唯一约束目标(grantAccount 专用;
  // memberNo 目标服务本模块既有 create())。
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
      }
      throw err;
    }
  }

  // ============ 队员账号闭环 v1:hasAccount / accountStatus 批量计算(避免 N+1)============

  // User.memberId 已 @unique:每个 member 至多关联 1 条 User(含软删,槽位一旦占用不可二次占用,
  // 沿 DB 约束现实;故 hasAccount 语义 = "该 memberId 槽位是否已被占用"而非"当前是否可登录" ——
  // 与 grantAccount() 的 MEMBER_HAS_LINKED_USER 判定同一份查询基准,语义自洽。
  private async loadLinkedUsersByMemberIds(
    memberIds: string[],
    tx?: PrismaTx,
  ): Promise<Map<string, { id: string; status: UserStatus }>> {
    if (memberIds.length === 0) return new Map();
    const client = tx ?? this.prisma;
    const users = await client.user.findMany({
      where: { memberId: { in: memberIds } },
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
  private async findLinkedUser(
    memberId: string,
    tx?: PrismaTx,
  ): Promise<{ id: string; status: UserStatus } | undefined> {
    const client = tx ?? this.prisma;
    const user = await client.user.findFirst({
      where: { memberId },
      select: { id: true, status: true },
    });
    return user ?? undefined;
  }

  // ============ list ============

  // F1/A1(D7):organizationId 经 memberOrganizationMemberships 关联过滤(active,任意
  // membershipType 均计入;沿 position-assignments requireMembership 校验同口径)。
  // includeDescendants=true 时展开 organizationId 及其全部后代(D7 helper,closure 非判权)。
  private async buildOrganizationScopeFilter(
    organizationId: string | undefined,
    includeDescendants: boolean | undefined,
  ): Promise<Prisma.MemberWhereInput | undefined> {
    if (organizationId === undefined) return undefined;
    const orgIds = includeDescendants
      ? await this.organizations.queryDescendantOrgIds(organizationId)
      : [organizationId];
    return {
      memberOrganizationMemberships: {
        some: { organizationId: { in: orgIds }, status: 'ACTIVE', deletedAt: null },
      },
    };
  }

  async list(
    query: ListMembersQueryDto,
    currentUser: CurrentUserPayload,
  ): Promise<PageResultDto<MemberResponseDto>> {
    await this.assertCanOrThrow(currentUser, 'member.read.record');
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
    const orgScope = await this.buildOrganizationScopeFilter(organizationId, includeDescendants);
    if (orgScope !== undefined) Object.assign(filters, orgScope);
    // 队员账号闭环 v1:hasAccount 经 user 反向关联过滤(User.memberId 已 @unique 一对一)。
    if (hasAccount === true) filters.user = { isNot: null };
    if (hasAccount === false) filters.user = { is: null };

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
    await this.assertCanOrThrow(currentUser, 'member.read.record');
    const { q, organizationId, includeDescendants, limit } = query;

    const filters: Prisma.MemberWhereInput = {};
    if (q !== undefined) {
      filters.OR = [
        { displayName: { contains: q, mode: 'insensitive' } },
        { memberNo: { contains: q, mode: 'insensitive' } },
      ];
    }
    const orgScope = await this.buildOrganizationScopeFilter(organizationId, includeDescendants);
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
    await this.assertCanOrThrow(currentUser, 'member.read.record');
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
    await this.assertCanOrThrow(currentUser, 'member.update.record');
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
  ): Promise<MemberResponseDto> {
    await this.assertCanOrThrow(currentUser, 'member.update.status');
    await this.findMemberOrThrow(id);
    const updated = await this.prisma.member.update({
      where: { id },
      data: { status: dto.status },
      select: memberSafeSelect,
    });
    const linked = await this.findLinkedUser(id);
    return this.attachAccountInfo(updated, linked);
  }

  // ============ softDelete ============

  // 引用检查 + 软删事务原子(沿用 organizations Step 4 模式):
  //   - 有 active 部门归属(member_departments.memberId=:id, deletedAt=null)→ 拒绝
  //   - 有 v1 user 绑定(users.memberId=:id, deletedAt=null)→ 拒绝(防悬空外键)
  // 离队走 PATCH /:id/status → INACTIVE(不软删档案);软删仅"档案彻底无效"场景。
  async softDelete(id: string, currentUser: CurrentUserPayload): Promise<MemberResponseDto> {
    await this.assertCanOrThrow(currentUser, 'member.delete.record');
    return this.prisma.$transaction(async (tx) => {
      await this.findMemberOrThrow(id, tx);

      const [activeDeptCount, linkedUserCount] = await Promise.all([
        // 终态 scoped-authz PR2:重指向 active PRIMARY membership(= 旧单部门语义,行为逐字保持)。
        tx.memberOrganizationMembership.count({
          where: { memberId: id, deletedAt: null, membershipType: 'PRIMARY', status: 'ACTIVE' },
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
  //   3. 该 memberId 槽位未被占用(User.memberId 已 @unique,含软删 —— 槽位一旦占用
  //      永不可二次占用,DB 约束现实;故检查含软删,而非仅 deletedAt: null)→ 否则 MEMBER_HAS_LINKED_USER
  //   4. username(=memberNo)唯一性预检查含软删占用(沿 AGENTS §10 不复用范式)→ 否则 USERNAME_ALREADY_EXISTS
  //   5. phone 唯一性预检查含软删占用 → 否则 PHONE_ALREADY_BOUND
  async grantAccount(
    id: string,
    dto: GrantMemberAccountDto,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<GrantMemberAccountResponseDto> {
    await this.assertCanOrThrow(currentUser, 'member.grant.account');

    return this.prisma.$transaction(async (tx) => {
      const member = await tx.member.findFirst({
        where: notDeletedWhere({ id }),
        select: { id: true, memberNo: true, status: true },
      });
      if (!member) throw new BizException(BizCode.MEMBER_NOT_FOUND);
      if (member.status !== MemberStatus.ACTIVE) {
        throw new BizException(BizCode.MEMBER_INACTIVE);
      }

      const existingLink = await tx.user.findFirst({
        where: { memberId: id },
        select: { id: true },
      });
      if (existingLink) throw new BizException(BizCode.MEMBER_HAS_LINKED_USER);

      const existingUsername = await tx.user.findUnique({
        where: { username: member.memberNo },
        select: { id: true },
      });
      if (existingUsername) throw new BizException(BizCode.USERNAME_ALREADY_EXISTS);

      const existingPhone = await tx.user.findUnique({
        where: { phone: dto.phone },
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
            username: member.memberNo,
            phone: dto.phone,
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
        extra: { memberId: id, userId: created.id, phone: maskPhone(dto.phone) },
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
}
