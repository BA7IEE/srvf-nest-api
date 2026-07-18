import { Injectable } from '@nestjs/common';
import {
  MemberStatus,
  MembershipStatus,
  MembershipType,
  OrganizationStatus,
  Prisma,
} from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import type { PageResultDto } from '../../common/dto/pagination.dto';
import { parseExpandQuery } from '../../common/dto/expand-query.util';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { notDeletedWhere } from '../../common/prisma/soft-delete.util';
import { PrismaService } from '../../database/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import type { MemberOptionsResponseDto } from '../members/members.dto';
import { MembersService } from '../members/members.service';
import { lockMemberLifecycle } from '../members/member-lifecycle-lock';
import { OrganizationsService } from '../organizations/organizations.service';
import { RbacService } from '../permissions/rbac.service';
import {
  CreateMembershipDto,
  MEMBERSHIP_EXPAND_TOKENS,
  MembershipConflictItemDto,
  MembershipConflictsQueryDto,
  MembershipConflictsResponseDto,
  MembershipExpandedMemberDto,
  MembershipExpandedOrganizationDto,
  MembershipResponseDto,
  OrgMembersOptionsQueryDto,
  OrgMembershipsQueryDto,
  PageMembershipsQueryDto,
  TransferMembershipDto,
  UpdateMembershipDto,
} from './memberships.dto';
import { MembershipTermStateMachine } from './membership-term-state-machine';

// 终态 scoped-authz PR2(2026-07-01;冻结稿 §3.1 / §7.1):组织归属(memberships)管理面。
// 沿队员轴嵌套 admin/v1/members/:memberId/memberships;判权单轨 service 层 rbac.can(0 @Roles)。
// **本表只建 + 回填 + CRUD,绝不被任何模块读作授权**(AuthzService 是 PR8)。
//
// 与旧单部门(member-departments)面的关系:旧面重指向到 PRIMARY 行做兼容;本面是终态全归属面,
// 显式承载 type / 任期 / status(PRIMARY 唯一由 partial unique 兜底,SECONDARY/TEMPORARY/SUPPORT 可并存)。
//
// 审计留痕批(2026-07-03;review #484 G5):create / end 写 audit(inline-in-transaction,沿
// position-assignments / supervision-assignments 范式;resourceType='membership';extra.viaPath='membership'
// 区分旧 member-departments 入口)。**update(PATCH)不写 audit**——沿 role-binding.update /
// supervision-assignment.update 既有先例,仅改类型 / 任期 / 原因等非建 / 终字段,不构成建 / 终事件。

const AUDIT_RESOURCE_TYPE = 'membership';

// 集中定义对外 select(全字段;永不含 deletedAt 软删内部状态)。
const membershipSelect = {
  id: true,
  memberId: true,
  organizationId: true,
  membershipType: true,
  status: true,
  startedAt: true,
  endedAt: true,
  reason: true,
  createdByUserId: true,
  endedByUserId: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.MemberOrganizationMembershipSelect;

type PrismaTx = Prisma.TransactionClient;

@Injectable()
export class MembershipsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rbac: RbacService,
    private readonly auditLogs: AuditLogsService,
    // F4/D 组(2026-07-04):organizations 注入仅用 queryDescendantOrgIds()(D7 只读 helper,
    // closure 仅列表数据过滤非判权);members 注入仅用 options()(F1/A1 选择器投影,组织轴 sugar 复用)。
    private readonly organizations: OrganizationsService,
    private readonly members: MembersService,
  ) {}

  // ============ helpers(自包含;沿 member-departments 范式,不抽共享类)============

  private async assertCanOrThrow(user: CurrentUserPayload, action: string): Promise<void> {
    if (!(await this.rbac.can(user, action))) {
      throw new BizException(BizCode.RBAC_FORBIDDEN);
    }
  }

  private async findMemberOrThrow(
    memberId: string,
    tx?: PrismaTx,
  ): Promise<{ id: string; status: MemberStatus }> {
    const client = tx ?? this.prisma;
    const member = await client.member.findFirst({
      where: notDeletedWhere({ id: memberId }),
      select: { id: true, status: true },
    });
    if (!member) throw new BizException(BizCode.MEMBER_NOT_FOUND);
    return member;
  }

  private async findOrganizationOrThrow(
    organizationId: string,
    tx?: PrismaTx,
  ): Promise<{ id: string; status: OrganizationStatus }> {
    const client = tx ?? this.prisma;
    const org = await client.organization.findFirst({
      where: notDeletedWhere({ id: organizationId }),
      select: { id: true, status: true },
    });
    if (!org) throw new BizException(BizCode.ORGANIZATION_NOT_FOUND);
    return org;
  }

  // P2002 兜底:两条 partial unique index(primary_active_unique / active_unique)由 migration.sql
  // 末尾手动追加,P2002 meta.target 不可靠 → 任何 P2002 直接抛 MEMBERSHIP_ALREADY_EXISTS(17004,本面新码)。
  private async runWithUniqueConstraintGuard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new BizException(BizCode.MEMBERSHIP_ALREADY_EXISTS);
      }
      throw err;
    }
  }

  // ============ GET /api/admin/v1/members/:memberId/memberships ============

  // 列某队员全部归属(主/兼/临时/支援 + 任期;含 ENDED/SUSPENDED 历史,不含软删行)。
  async list(user: CurrentUserPayload, memberId: string): Promise<MembershipResponseDto[]> {
    await this.assertCanOrThrow(user, 'membership.list.record');
    await this.findMemberOrThrow(memberId);
    return this.prisma.memberOrganizationMembership.findMany({
      where: { memberId, deletedAt: null },
      select: membershipSelect,
      orderBy: [{ startedAt: 'asc' }, { createdAt: 'asc' }],
    });
  }

  // ============ POST /api/admin/v1/members/:memberId/memberships ============

  // 新增归属(指定 membershipType)。校验 member/org 存在且 ACTIVE(沿 member-departments set 语义)。
  // PRIMARY 撞唯一 / (member,org,type) 撞唯一 → P2002 → MEMBERSHIP_ALREADY_EXISTS。
  async create(
    user: CurrentUserPayload,
    memberId: string,
    dto: CreateMembershipDto,
    meta: AuditMeta,
  ): Promise<MembershipResponseDto> {
    await this.assertCanOrThrow(user, 'membership.set.record');
    return this.prisma.$transaction(async (tx) => {
      await lockMemberLifecycle(tx, memberId);
      const member = await this.findMemberOrThrow(memberId, tx);
      if (member.status !== MemberStatus.ACTIVE) {
        throw new BizException(BizCode.MEMBER_INACTIVE);
      }
      const org = await this.findOrganizationOrThrow(dto.organizationId, tx);
      if (org.status !== OrganizationStatus.ACTIVE) {
        throw new BizException(BizCode.ORGANIZATION_INACTIVE);
      }
      const startedAt = new Date();
      MembershipTermStateMachine.assertValid(
        {
          status: MembershipStatus.ACTIVE,
          startedAt,
          endedAt: null,
        },
        startedAt,
      );
      const created = await this.runWithUniqueConstraintGuard(() =>
        tx.memberOrganizationMembership.create({
          data: {
            memberId,
            organizationId: dto.organizationId,
            membershipType: dto.membershipType,
            status: MembershipStatus.ACTIVE,
            startedAt,
            reason: dto.reason ?? null,
            createdByUserId: user.id,
          },
          select: membershipSelect,
        }),
      );

      await this.auditLogs.log({
        event: 'membership.set',
        actorUserId: user.id,
        actorRoleSnap: user.role,
        resourceType: AUDIT_RESOURCE_TYPE,
        resourceId: created.id,
        meta,
        after: {
          memberId: created.memberId,
          organizationId: created.organizationId,
          membershipType: created.membershipType,
          status: created.status,
          reason: created.reason,
        },
        extra: { viaPath: 'membership', operation: 'create', targetMemberId: memberId },
        tx,
      });

      return created;
    });
  }

  // ============ PATCH /api/admin/v1/members/:memberId/memberships/:id ============

  // 改类型 / 任期 / 原因(全可选)。不改 status(结束走 DELETE)、不改 memberId/organizationId。
  // 找不到该 member 名下未软删归属 → MEMBERSHIP_NOT_FOUND;改类型可能撞唯一 → MEMBERSHIP_ALREADY_EXISTS。
  // **不写 audit**(沿 role-binding.update / supervision-assignment.update 先例;非建/终字段变更)。
  async update(
    user: CurrentUserPayload,
    memberId: string,
    id: string,
    dto: UpdateMembershipDto,
  ): Promise<MembershipResponseDto> {
    await this.assertCanOrThrow(user, 'membership.set.record');
    return this.prisma.$transaction(async (tx) => {
      await lockMemberLifecycle(tx, memberId);
      const current = await tx.memberOrganizationMembership.findFirst({
        where: { id, memberId, deletedAt: null },
        select: { id: true, status: true, startedAt: true, endedAt: true },
      });
      if (!current) throw new BizException(BizCode.MEMBERSHIP_NOT_FOUND);

      const nextTerm = {
        status: current.status,
        startedAt: dto.startedAt !== undefined ? new Date(dto.startedAt) : current.startedAt,
        endedAt: dto.endedAt !== undefined ? new Date(dto.endedAt) : current.endedAt,
      };
      MembershipTermStateMachine.assertValid(nextTerm, new Date());

      const data: Prisma.MemberOrganizationMembershipUpdateInput = {};
      if (dto.membershipType !== undefined) data.membershipType = dto.membershipType;
      if (dto.startedAt !== undefined) data.startedAt = new Date(dto.startedAt);
      if (dto.endedAt !== undefined) data.endedAt = new Date(dto.endedAt);
      if (dto.reason !== undefined) data.reason = dto.reason;

      return this.runWithUniqueConstraintGuard(() =>
        tx.memberOrganizationMembership.update({
          where: { id },
          data,
          select: membershipSelect,
        }),
      );
    });
  }

  // ============ DELETE /api/admin/v1/members/:memberId/memberships/:id ============

  // 结束归属:status=ENDED + endedAt=now + endedByUserId(逻辑结束,保留行做历史留痕,不软删)。
  // 仅可结束该 member 名下 active 归属;否则 MEMBERSHIP_NOT_FOUND。
  async end(
    user: CurrentUserPayload,
    memberId: string,
    id: string,
    meta: AuditMeta,
  ): Promise<MembershipResponseDto> {
    await this.assertCanOrThrow(user, 'membership.end.record');
    return this.prisma.$transaction(async (tx) => {
      await lockMemberLifecycle(tx, memberId);
      const current = await tx.memberOrganizationMembership.findFirst({
        where: { id, memberId, deletedAt: null, status: MembershipStatus.ACTIVE },
        select: { id: true, status: true, startedAt: true, endedAt: true },
      });
      if (!current) throw new BizException(BizCode.MEMBERSHIP_NOT_FOUND);

      const ended = MembershipTermStateMachine.end(current, new Date());

      const updated = await tx.memberOrganizationMembership.update({
        where: { id },
        data: {
          status: ended.status,
          endedAt: ended.endedAt,
          endedByUserId: user.id,
        },
        select: membershipSelect,
      });

      await this.auditLogs.log({
        event: 'membership.end',
        actorUserId: user.id,
        actorRoleSnap: user.role,
        resourceType: AUDIT_RESOURCE_TYPE,
        resourceId: updated.id,
        meta,
        before: { status: current.status },
        after: {
          status: updated.status,
          endedAt: updated.endedAt,
          endedByUserId: updated.endedByUserId,
        },
        extra: { viaPath: 'membership', operation: 'end', targetMemberId: memberId },
        tx,
      });

      return updated;
    });
  }

  // ============ F4/D 组(2026-07-04;路线图 §4)以下为扁平/组织轴增强面 ============

  // organizationId(±includeDescendants)→ 组织 id 过滤集(undefined = 不过滤)。
  // closure 展开走 OrganizationsService.queryDescendantOrgIds(D7 只读 helper,绝不进判权路径)。
  private async buildOrgScopeIds(
    organizationId: string | undefined,
    includeDescendants: boolean | undefined,
  ): Promise<string[] | undefined> {
    if (organizationId === undefined) return undefined;
    if (includeDescendants !== true) return [organizationId];
    return this.organizations.queryDescendantOrgIds(organizationId);
  }

  // 共享查询构造(F 批小修 2026-07-05):page()/listForOrganization() 两处过滤条件同一份口径,
  // 只有 memberId 是扁平总表独有(组织轴由路径段固定 organizationId,不接受再收窄到某队员)。
  private buildMembershipsWhere(params: {
    memberId?: string;
    orgScope?: string[];
    membershipType?: MembershipType;
    status?: MembershipStatus;
    q?: string;
  }): Prisma.MemberOrganizationMembershipWhereInput {
    const where: Prisma.MemberOrganizationMembershipWhereInput = { deletedAt: null };
    if (params.memberId !== undefined) where.memberId = params.memberId;
    if (params.orgScope !== undefined) where.organizationId = { in: params.orgScope };
    if (params.membershipType !== undefined) where.membershipType = params.membershipType;
    if (params.status !== undefined) where.status = params.status;
    if (params.q !== undefined && params.q !== '') {
      const contains = { contains: params.q, mode: 'insensitive' as const };
      where.OR = [
        { member: { memberNo: contains } },
        { member: { displayName: contains } },
        { organization: { name: contains } },
        { organization: { code: contains } },
      ];
    }
    return where;
  }

  // ============ F4:GET /api/admin/v1/memberships(分页总表) ============

  // 全库归属分页(缺省含 ENDED/SUSPENDED 历史,不含软删行;status 显式过滤可收窄)。
  // q 命中队员 memberNo+displayName + 组织 name+code(relation 过滤,单查询);
  // expand=member,organization(D6 约定:缺省不展开,响应形状与队员轴端点一致)。仅展示,不判权。
  async page(
    user: CurrentUserPayload,
    query: PageMembershipsQueryDto,
  ): Promise<PageResultDto<MembershipResponseDto>> {
    await this.assertCanOrThrow(user, 'membership.list.record');
    const expand = parseExpandQuery(query.expand, MEMBERSHIP_EXPAND_TOKENS);

    const orgScope = await this.buildOrgScopeIds(query.organizationId, query.includeDescendants);
    const where = this.buildMembershipsWhere({
      memberId: query.memberId,
      orgScope,
      membershipType: query.membershipType,
      status: query.status,
      q: query.q,
    });

    const [rows, total] = await Promise.all([
      this.prisma.memberOrganizationMembership.findMany({
        where,
        select: membershipSelect,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.memberOrganizationMembership.count({ where }),
    ]);

    let items: MembershipResponseDto[] = rows;
    if (expand.size > 0) {
      items = await this.attachExpansions(items, {
        member: expand.has('member'),
        organization: expand.has('organization'),
      });
    }
    return { items, total, page: query.page, pageSize: query.pageSize };
  }

  // expand 展开(D6):按命中 token 批量取回 member / organization 摘要后逐行挂载(零 N+1)。
  private async attachExpansions(
    items: MembershipResponseDto[],
    want: { member: boolean; organization: boolean },
  ): Promise<MembershipResponseDto[]> {
    const memberMap = new Map<string, MembershipExpandedMemberDto>();
    const orgMap = new Map<string, MembershipExpandedOrganizationDto>();
    if (want.member && items.length > 0) {
      const rows = await this.prisma.member.findMany({
        where: { id: { in: [...new Set(items.map((i) => i.memberId))] } },
        select: { id: true, memberNo: true, displayName: true, gradeCode: true },
      });
      for (const r of rows) memberMap.set(r.id, r);
    }
    if (want.organization && items.length > 0) {
      const rows = await this.prisma.organization.findMany({
        where: { id: { in: [...new Set(items.map((i) => i.organizationId))] } },
        select: { id: true, name: true, code: true, nodeTypeCode: true },
      });
      for (const r of rows) orgMap.set(r.id, r);
    }
    return items.map((item) => {
      const out = { ...item };
      if (want.member) {
        const m = memberMap.get(item.memberId);
        if (m) out.member = m;
      }
      if (want.organization) {
        const o = orgMap.get(item.organizationId);
        if (o) out.organization = o;
      }
      return out;
    });
  }

  // ============ F4:GET /api/admin/v1/memberships/:id(detail) ============

  // 找不到未软删记录 → MEMBERSHIP_NOT_FOUND(17003)。`membership.read.record` 自 PR2 预埋,本端点实装(孤码 WARN 清零)。
  async findOne(user: CurrentUserPayload, id: string): Promise<MembershipResponseDto> {
    await this.assertCanOrThrow(user, 'membership.read.record');
    const row = await this.prisma.memberOrganizationMembership.findFirst({
      where: { id, deletedAt: null },
      select: membershipSelect,
    });
    if (!row) throw new BizException(BizCode.MEMBERSHIP_NOT_FOUND);
    return row;
  }

  // ============ F4:GET /api/admin/v1/memberships/conflicts(只读诊断) ============

  // 数据体检面(闭集 4 类,见 DTO 注释):多 ACTIVE PRIMARY(partial unique 之外的 legacy 兜底)/
  // 悬空队员 / 悬空组织 / 停用组织上的在任归属。四类各一次批量查询,零 N+1;零写入。
  async conflicts(
    user: CurrentUserPayload,
    query: MembershipConflictsQueryDto,
  ): Promise<MembershipConflictsResponseDto> {
    await this.assertCanOrThrow(user, 'membership.list.record');
    const orgScope = await this.buildOrgScopeIds(query.organizationId, query.includeDescendants);
    const base: Prisma.MemberOrganizationMembershipWhereInput = {
      deletedAt: null,
      status: MembershipStatus.ACTIVE,
      ...(orgScope !== undefined ? { organizationId: { in: orgScope } } : {}),
    };

    const items: MembershipConflictItemDto[] = [];

    // a. multiple_active_primary:同队员 >1 条 ACTIVE PRIMARY
    const primaryGroups = await this.prisma.memberOrganizationMembership.groupBy({
      by: ['memberId'],
      where: { ...base, membershipType: MembershipType.PRIMARY },
      _count: { _all: true },
      having: { memberId: { _count: { gt: 1 } } },
    });
    if (primaryGroups.length > 0) {
      const rows = await this.prisma.memberOrganizationMembership.findMany({
        where: {
          ...base,
          membershipType: MembershipType.PRIMARY,
          memberId: { in: primaryGroups.map((g) => g.memberId) },
        },
        select: { id: true, memberId: true },
        orderBy: [{ memberId: 'asc' }, { createdAt: 'asc' }],
      });
      const byMember = new Map<string, string[]>();
      for (const r of rows) {
        const list = byMember.get(r.memberId) ?? [];
        list.push(r.id);
        byMember.set(r.memberId, list);
      }
      for (const [memberId, membershipIds] of byMember) {
        items.push({
          type: 'multiple_active_primary',
          memberId,
          organizationId: null,
          membershipIds,
        });
      }
    }

    // b/c/d. 悬空/停用(逐行一条;各自单查询)
    const pushRows = (
      rows: Array<{ id: string; memberId: string; organizationId: string }>,
      type: MembershipConflictItemDto['type'],
    ): void => {
      for (const r of rows) {
        items.push({
          type,
          memberId: r.memberId,
          organizationId: r.organizationId,
          membershipIds: [r.id],
        });
      }
    };
    const rowSelect = { id: true, memberId: true, organizationId: true } as const;
    pushRows(
      await this.prisma.memberOrganizationMembership.findMany({
        where: { ...base, member: { deletedAt: { not: null } } },
        select: rowSelect,
        orderBy: { createdAt: 'asc' },
      }),
      'dangling_member',
    );
    pushRows(
      await this.prisma.memberOrganizationMembership.findMany({
        where: { ...base, organization: { deletedAt: { not: null } } },
        select: rowSelect,
        orderBy: { createdAt: 'asc' },
      }),
      'dangling_organization',
    );
    pushRows(
      await this.prisma.memberOrganizationMembership.findMany({
        where: {
          ...base,
          organization: { deletedAt: null, status: OrganizationStatus.INACTIVE },
        },
        select: rowSelect,
        orderBy: { createdAt: 'asc' },
      }),
      'inactive_organization',
    );

    return { items, total: items.length };
  }

  // ============ F4:GET /api/admin/v1/organizations/:orgId/memberships(组织轴分页) ============

  // 组织存在性先验(镜像 organizations/:orgId/position-assignments 嵌套资源范式;判权先于存在性)。
  // F 批小修(2026-07-05):过滤/expand 参数集与 page() 对齐(复用 buildMembershipsWhere +
  // attachExpansions 同一份口径);organizationId 由路径段固定,**默认行为不变**——缺省仍三态全返。
  async listForOrganization(
    user: CurrentUserPayload,
    orgId: string,
    query: OrgMembershipsQueryDto,
  ): Promise<PageResultDto<MembershipResponseDto>> {
    await this.assertCanOrThrow(user, 'membership.list.record');
    await this.findOrganizationOrThrow(orgId);
    const expand = parseExpandQuery(query.expand, MEMBERSHIP_EXPAND_TOKENS);
    const orgScope = await this.buildOrgScopeIds(orgId, query.includeDescendants);
    const where = this.buildMembershipsWhere({
      orgScope,
      membershipType: query.membershipType,
      status: query.status,
      q: query.q,
    });

    const [rows, total] = await Promise.all([
      this.prisma.memberOrganizationMembership.findMany({
        where,
        select: membershipSelect,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.memberOrganizationMembership.count({ where }),
    ]);

    let items: MembershipResponseDto[] = rows;
    if (expand.size > 0) {
      items = await this.attachExpansions(items, {
        member: expand.has('member'),
        organization: expand.has('organization'),
      });
    }
    return { items, total, page: query.page, pageSize: query.pageSize };
  }

  // ============ F4:GET /api/admin/v1/organizations/:orgId/members/options(组织轴队员下拉) ============

  // 组织轴 sugar:等价 GET members/options?organizationId=:orgId(F1/A1),复用 MembersService.options
  // 的同一份投影与过滤(active membership 关联 + includeDescendants);仅多一道组织存在性先验(嵌套资源范式)。
  // 判权同 F1:member.read.record(委托方法内亦判,缓存命中不放大)。
  async orgMembersOptions(
    user: CurrentUserPayload,
    orgId: string,
    query: OrgMembersOptionsQueryDto,
  ): Promise<MemberOptionsResponseDto> {
    await this.assertCanOrThrow(user, 'member.read.record');
    await this.findOrganizationOrThrow(orgId);
    return this.members.options(
      {
        q: query.q,
        organizationId: orgId,
        includeDescendants: query.includeDescendants,
        limit: query.limit,
      },
      user,
    );
  }

  // ============ F4:POST /api/admin/v1/memberships/transfer(唯一写端点) ============

  // 单事务「end 旧 + create 新」:受既有 partial unique 约束(先 end 后 create,PRIMARY 唯一槽位先释放)。
  // 校验镜像 create()/end() 同口径(member ACTIVE / 目标 org 存在且 ACTIVE / 源侧对应类型 ACTIVE 行存在);
  // **源组织不做存在性/ACTIVE 校验** —— 迁出已软删/停用组织正是 conflicts 诊断后的治理场景,源侧只认归属行。
  // 源 = 目标 → 通用 400(无迁移语义;BizCode +0,沿 goal「优先复用既有码」);
  // 目标撞同维度 ACTIVE 唯一 → P2002 → MEMBERSHIP_ALREADY_EXISTS(17004)。
  // audit:单条 `membership.transfer` 事件(第三写入口,viaPath='membership-transfer' 沿本模块
  // CLAUDE.md「新写入口取新 viaPath 值」铁律;end+create 两腿不再各写 set/end 事件 —— 一次迁移一条留痕)。
  async transfer(
    user: CurrentUserPayload,
    dto: TransferMembershipDto,
    meta: AuditMeta,
  ): Promise<MembershipResponseDto> {
    await this.assertCanOrThrow(user, 'membership.transfer.record');
    if (dto.fromOrganizationId === dto.toOrganizationId) {
      throw new BizException(BizCode.BAD_REQUEST);
    }
    return this.prisma.$transaction(async (tx) => {
      await lockMemberLifecycle(tx, dto.memberId);
      const member = await this.findMemberOrThrow(dto.memberId, tx);
      if (member.status !== MemberStatus.ACTIVE) {
        throw new BizException(BizCode.MEMBER_INACTIVE);
      }
      const toOrg = await this.findOrganizationOrThrow(dto.toOrganizationId, tx);
      if (toOrg.status !== OrganizationStatus.ACTIVE) {
        throw new BizException(BizCode.ORGANIZATION_INACTIVE);
      }

      const current = await tx.memberOrganizationMembership.findFirst({
        where: {
          memberId: dto.memberId,
          organizationId: dto.fromOrganizationId,
          membershipType: dto.membershipType,
          status: MembershipStatus.ACTIVE,
          deletedAt: null,
        },
        select: { id: true, status: true, startedAt: true, endedAt: true },
      });
      if (!current) throw new BizException(BizCode.MEMBERSHIP_NOT_FOUND);

      const now = new Date();
      const ended = MembershipTermStateMachine.end(current, now);
      await tx.memberOrganizationMembership.update({
        where: { id: current.id },
        data: { status: ended.status, endedAt: ended.endedAt, endedByUserId: user.id },
        select: { id: true },
      });

      MembershipTermStateMachine.assertValid(
        {
          status: MembershipStatus.ACTIVE,
          startedAt: now,
          endedAt: null,
        },
        now,
      );
      const created = await this.runWithUniqueConstraintGuard(() =>
        tx.memberOrganizationMembership.create({
          data: {
            memberId: dto.memberId,
            organizationId: dto.toOrganizationId,
            membershipType: dto.membershipType,
            status: MembershipStatus.ACTIVE,
            startedAt: now,
            reason: dto.reason ?? null,
            createdByUserId: user.id,
          },
          select: membershipSelect,
        }),
      );

      await this.auditLogs.log({
        event: 'membership.transfer',
        actorUserId: user.id,
        actorRoleSnap: user.role,
        resourceType: AUDIT_RESOURCE_TYPE,
        resourceId: created.id,
        meta,
        before: {
          membershipId: current.id,
          organizationId: dto.fromOrganizationId,
          status: MembershipStatus.ACTIVE,
        },
        after: {
          membershipId: created.id,
          organizationId: created.organizationId,
          membershipType: created.membershipType,
          status: created.status,
        },
        extra: {
          viaPath: 'membership-transfer',
          operation: 'transfer',
          targetMemberId: dto.memberId,
          fromOrganizationId: dto.fromOrganizationId,
          toOrganizationId: dto.toOrganizationId,
          endedMembershipId: current.id,
        },
        tx,
      });

      return created;
    });
  }
}
