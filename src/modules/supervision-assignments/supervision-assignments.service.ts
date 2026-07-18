import { Injectable } from '@nestjs/common';
import {
  MemberStatus,
  OrganizationStatus,
  Prisma,
  SupervisionScopeMode,
  SupervisionStatus,
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
import { lockMemberLifecycle } from '../members/member-lifecycle-lock';
import { RbacService } from '../permissions/rbac.service';
import {
  CreateSupervisionAssignmentDto,
  OrganizationSupervisorDto,
  PageSupervisionAssignmentsQueryDto,
  SUPERVISION_EXPAND_TOKENS,
  SupervisionAssignmentResponseDto,
  SupervisionCoveragePreviewDto,
  SupervisionCoveragePreviewResponseDto,
  SupervisionExpandedOrganizationDto,
  SupervisionExpandedSupervisorDto,
  SupervisionScopeEntryDto,
  UpdateSupervisionAssignmentDto,
} from './supervision-assignments.dto';
import {
  supervisionAssignmentSafeSelect,
  type SafeSupervisionAssignment,
} from './supervision-assignments.select';

// 终态 scoped-authz PR5(2026-07-01;冻结稿 §3.5 / §7.4 / §4.3 / R5):分管(supervision-assignments)管理面 service。
// 判权单轨 service 层 rbac.can(0 @Roles;沿 position-assignments / memberships 范式)。建 / 撤销写 audit(inline,
// 沿 content / position-assignment 范式;resourceType='supervision_assignment')。
//
// **分管 = 与职务正交的独立范围监督关系**:create 绝不要求 supervisor 持任何职务/领导头衔,运营自由指派。
// **本表自身 CRUD/校验逻辑不读角色/权限表(单向)**;但 **PR8 起 AuthzService 会读本表**把分管推导成只读监督
//   scope 的输入之一(review #484 G6 true-up:此前"绝不被判权路径读"措辞已过时)——分管建立/撤销直接联动
//   授权结果,不是"与判权无关"。分管范围展开(supervision-scope)/ 被谁分管(supervisors)读 organization_closure
//   **仅作展示/报表**(TREE 求后代集 / inherited 求祖先集),**绝非判权** —— closure 本身不进 rbac.can/AuthzService。

const AUDIT_RESOURCE_TYPE = 'supervision_assignment';

type PrismaTx = Prisma.TransactionClient;

// 终态 scoped-authz PR11(2026-07-02;冻结稿 §8.4 / §11 PR11):dry-run 沙箱哨兵,镜像
// position-assignments.service.ts 同名类(不共享,沿模块自包含范式)。create() 走满全部校验 + 真实
// insert + audit 写入后,若 options.dryRun,在事务提交前抛本类型强制整个事务(含 audit)一并回滚,
// catch 后原样返回"本应创建"的响应体 —— 供 announcement-import 预览零写入复用同一份真实校验。
class DryRunAbort<T> extends Error {
  constructor(public readonly value: T) {
    super('DRY_RUN_ABORT');
  }
}

@Injectable()
export class SupervisionAssignmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rbac: RbacService,
    private readonly auditLogs: AuditLogsService,
  ) {}

  // ============ helpers(自包含;沿 position-assignments / memberships 范式,不抽共享类)============

  private async assertCanOrThrow(user: CurrentUserPayload, action: string): Promise<void> {
    if (!(await this.rbac.can(user, action))) {
      throw new BizException(BizCode.RBAC_FORBIDDEN);
    }
  }

  private toResponseDto(row: SafeSupervisionAssignment) {
    return {
      id: row.id,
      supervisorMemberId: row.supervisorMemberId,
      organizationId: row.organizationId,
      scopeMode: row.scopeMode,
      status: row.status,
      startedAt: row.startedAt,
      endedAt: row.endedAt,
      appointedByUserId: row.appointedByUserId,
      revokedByUserId: row.revokedByUserId,
      note: row.note,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private async findMemberOrThrow(
    memberId: string,
    tx: PrismaTx,
  ): Promise<{ id: string; status: MemberStatus }> {
    const member = await tx.member.findFirst({
      where: notDeletedWhere({ id: memberId }),
      select: { id: true, status: true },
    });
    if (!member) throw new BizException(BizCode.MEMBER_NOT_FOUND);
    return member;
  }

  private async findOrganizationOrThrow(
    organizationId: string,
    tx: PrismaTx,
  ): Promise<{ id: string; status: OrganizationStatus }> {
    const org = await tx.organization.findFirst({
      where: notDeletedWhere({ id: organizationId }),
      select: { id: true, status: true },
    });
    if (!org) throw new BizException(BizCode.ORGANIZATION_NOT_FOUND);
    return org;
  }

  // ============ GET /api/admin/v1/supervision-assignments ============

  // 列当前在任分管(status=ACTIVE;不含历史)。分管数少(组织树数百节点封顶),平铺列表即可。
  async list(user: CurrentUserPayload) {
    await this.assertCanOrThrow(user, 'supervision-assignment.read.record');
    const rows = await this.prisma.organizationSupervisionAssignment.findMany({
      where: { status: SupervisionStatus.ACTIVE, deletedAt: null },
      select: supervisionAssignmentSafeSelect,
      orderBy: [{ startedAt: 'asc' }, { createdAt: 'asc' }],
    });
    return rows.map((r) => this.toResponseDto(r));
  }

  // ============ POST /api/admin/v1/supervision-assignments ============

  // 建分管。校验(各自独立 BizCode):
  //   0. 存在性 + active:supervisor(MEMBER_NOT_FOUND / MEMBER_INACTIVE)/ org(ORGANIZATION_NOT_FOUND / ORGANIZATION_INACTIVE)
  //   1. 任期:endedAt 有值须 > startedAt(TENURE_INVALID)
  //   2. 防重:同人对同组织已有 active(ALREADY_EXISTS;partial unique 兜底)
  // **不校验 supervisor 是否持职务**(分管与职务正交);scopeMode 非法由 DTO @IsEnum → 400。
  async create(
    user: CurrentUserPayload,
    dto: CreateSupervisionAssignmentDto,
    meta: AuditMeta,
    options?: { dryRun?: boolean },
  ) {
    await this.assertCanOrThrow(user, 'supervision-assignment.create.record');

    // 任期校验(纯输入,不触库先做)。
    const startedAt = new Date(dto.startedAt);
    const endedAt = dto.endedAt !== undefined ? new Date(dto.endedAt) : null;
    if (endedAt !== null && endedAt.getTime() <= startedAt.getTime()) {
      throw new BizException(BizCode.SUPERVISION_ASSIGNMENT_TENURE_INVALID);
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        await lockMemberLifecycle(tx, dto.supervisorMemberId);
        const supervisor = await this.findMemberOrThrow(dto.supervisorMemberId, tx);
        if (supervisor.status !== MemberStatus.ACTIVE) {
          throw new BizException(BizCode.MEMBER_INACTIVE);
        }
        const org = await this.findOrganizationOrThrow(dto.organizationId, tx);
        if (org.status !== OrganizationStatus.ACTIVE) {
          throw new BizException(BizCode.ORGANIZATION_INACTIVE);
        }

        // 防重:同人对同组织已有 active(service 预检 + partial unique 兜底)。
        const dup = await tx.organizationSupervisionAssignment.count({
          where: {
            supervisorMemberId: dto.supervisorMemberId,
            organizationId: dto.organizationId,
            status: SupervisionStatus.ACTIVE,
            deletedAt: null,
          },
        });
        if (dup > 0) throw new BizException(BizCode.SUPERVISION_ALREADY_EXISTS);

        const created = await this.runWithUniqueGuard(() =>
          tx.organizationSupervisionAssignment.create({
            data: {
              supervisorMemberId: dto.supervisorMemberId,
              organizationId: dto.organizationId,
              scopeMode: dto.scopeMode ?? SupervisionScopeMode.TREE,
              status: SupervisionStatus.ACTIVE,
              startedAt,
              endedAt,
              appointedByUserId: user.id,
              note: dto.note ?? null,
            },
            select: supervisionAssignmentSafeSelect,
          }),
        );

        await this.auditLogs.log({
          event: 'supervision-assignment.create',
          actorUserId: user.id,
          actorRoleSnap: user.role,
          resourceType: AUDIT_RESOURCE_TYPE,
          resourceId: created.id,
          meta,
          after: {
            supervisorMemberId: created.supervisorMemberId,
            organizationId: created.organizationId,
            scopeMode: created.scopeMode,
            status: created.status,
            startedAt: created.startedAt,
            endedAt: created.endedAt,
          },
          extra: {
            operation: 'create',
            organizationId: created.organizationId,
            supervisorMemberId: created.supervisorMemberId,
          },
          tx,
        });

        const result = this.toResponseDto(created);
        if (options?.dryRun) throw new DryRunAbort(result);
        return result;
      });
    } catch (err) {
      if (err instanceof DryRunAbort) return err.value as ReturnType<typeof this.toResponseDto>;
      throw err;
    }
  }

  // ============ GET /api/admin/v1/members/:memberId/supervision-scope ============

  // 某分管人的分管范围:每条 active 分管 → 一条 scope 项;TREE 经 organization_closure 展开为「该组织 + 全部后代」,
  // EXACT 仅该节点。**展示/报表读 closure,绝非判权**(closure 不进 rbac.can/AuthzService)。
  async getSupervisionScope(
    user: CurrentUserPayload,
    memberId: string,
  ): Promise<SupervisionScopeEntryDto[]> {
    await this.assertCanOrThrow(user, 'supervision-assignment.read.record');
    await this.findMemberOrThrow(memberId, this.prisma);

    const sups = await this.prisma.organizationSupervisionAssignment.findMany({
      where: { supervisorMemberId: memberId, status: SupervisionStatus.ACTIVE, deletedAt: null },
      select: { id: true, organizationId: true, scopeMode: true },
      orderBy: [{ startedAt: 'asc' }, { createdAt: 'asc' }],
    });

    // TREE 分管统一一次性求后代集(closure.ancestorId=root → descendantId 含 depth-0 自身)。
    const treeRootIds = sups
      .filter((s) => s.scopeMode === SupervisionScopeMode.TREE)
      .map((s) => s.organizationId);
    const descByRoot = new Map<string, string[]>();
    if (treeRootIds.length > 0) {
      const closureRows = await this.prisma.organizationClosure.findMany({
        where: { ancestorId: { in: treeRootIds } },
        select: { ancestorId: true, descendantId: true },
      });
      for (const row of closureRows) {
        const arr = descByRoot.get(row.ancestorId);
        if (arr) arr.push(row.descendantId);
        else descByRoot.set(row.ancestorId, [row.descendantId]);
      }
    }

    return sups.map((s) => ({
      supervisionAssignmentId: s.id,
      organizationId: s.organizationId,
      scopeMode: s.scopeMode,
      expandedOrganizationIds:
        s.scopeMode === SupervisionScopeMode.TREE
          ? (descByRoot.get(s.organizationId) ?? [s.organizationId])
          : [s.organizationId],
    }));
  }

  // ============ GET /api/admin/v1/organizations/:orgId/supervisors ============

  // 某组织被谁分管:直接分管(该组织本身有 active 分管,任意 scopeMode)+ 继承分管(某祖先有 active TREE 分管而覆盖本组织)。
  // 读 organization_closure 求祖先集(descendantId=orgId → ancestorId,含 depth-0 自身)。**展示读 closure,绝非判权**。
  async getSupervisors(
    user: CurrentUserPayload,
    orgId: string,
  ): Promise<OrganizationSupervisorDto[]> {
    await this.assertCanOrThrow(user, 'supervision-assignment.read.record');
    await this.findOrganizationOrThrow(orgId, this.prisma);

    const ancestorRows = await this.prisma.organizationClosure.findMany({
      where: { descendantId: orgId },
      select: { ancestorId: true },
    });
    const ancestorIds = ancestorRows.map((r) => r.ancestorId);
    // closure 应含 depth-0 自身;缺失(如 closure 未维护)时兜底把 orgId 纳入,保证直接分管必列。
    const scopeIds = ancestorIds.includes(orgId) ? ancestorIds : [orgId, ...ancestorIds];

    const sups = await this.prisma.organizationSupervisionAssignment.findMany({
      where: {
        organizationId: { in: scopeIds },
        status: SupervisionStatus.ACTIVE,
        deletedAt: null,
      },
      select: supervisionAssignmentSafeSelect,
      orderBy: [{ startedAt: 'asc' }, { createdAt: 'asc' }],
    });

    // DIRECT(本组织,任意 scopeMode)排前;INHERITED(祖先且 scopeMode=TREE)排后。祖先 EXACT 不覆盖本组织。
    const direct = sups
      .filter((s) => s.organizationId === orgId)
      .map((s) => ({ coverage: 'DIRECT' as const, supervisionAssignment: this.toResponseDto(s) }));
    const inherited = sups
      .filter((s) => s.organizationId !== orgId && s.scopeMode === SupervisionScopeMode.TREE)
      .map((s) => ({
        coverage: 'INHERITED' as const,
        supervisionAssignment: this.toResponseDto(s),
      }));
    return [...direct, ...inherited];
  }

  // ============ PATCH /api/admin/v1/supervision-assignments/:id ============

  // 改 scopeMode / 任期 / note(全可选)。不改 supervisor / organization / status(撤销走 revoke)。
  // 找不到未软删记录 → NOT_FOUND;endedAt(新旧综合)须 > startedAt(新旧综合)→ TENURE_INVALID。
  async update(user: CurrentUserPayload, id: string, dto: UpdateSupervisionAssignmentDto) {
    await this.assertCanOrThrow(user, 'supervision-assignment.update.record');
    return this.prisma.$transaction(async (tx) => {
      const current = await tx.organizationSupervisionAssignment.findFirst({
        where: notDeletedWhere({ id }),
        select: { id: true, startedAt: true, endedAt: true },
      });
      if (!current) throw new BizException(BizCode.SUPERVISION_ASSIGNMENT_NOT_FOUND);

      // 任期综合校验:以入参覆盖现值后判定 endedAt > startedAt。
      const effectiveStartedAt =
        dto.startedAt !== undefined ? new Date(dto.startedAt) : current.startedAt;
      const effectiveEndedAt = dto.endedAt !== undefined ? new Date(dto.endedAt) : current.endedAt;
      if (effectiveEndedAt !== null && effectiveEndedAt.getTime() <= effectiveStartedAt.getTime()) {
        throw new BizException(BizCode.SUPERVISION_ASSIGNMENT_TENURE_INVALID);
      }

      const data: Prisma.OrganizationSupervisionAssignmentUpdateInput = {};
      if (dto.scopeMode !== undefined) data.scopeMode = dto.scopeMode;
      if (dto.startedAt !== undefined) data.startedAt = new Date(dto.startedAt);
      if (dto.endedAt !== undefined) data.endedAt = new Date(dto.endedAt);
      if (dto.note !== undefined) data.note = dto.note;

      const updated = await tx.organizationSupervisionAssignment.update({
        where: { id },
        data,
        select: supervisionAssignmentSafeSelect,
      });
      return this.toResponseDto(updated);
    });
  }

  // ============ POST /api/admin/v1/supervision-assignments/:id/revoke ============

  // 撤销:仅可撤 active 分管 → status=REVOKED + revokedByUserId + endedAt=now(保留行做历史,不软删)。
  async revoke(user: CurrentUserPayload, id: string, meta: AuditMeta) {
    await this.assertCanOrThrow(user, 'supervision-assignment.revoke.record');
    return this.prisma.$transaction(async (tx) => {
      const current = await tx.organizationSupervisionAssignment.findFirst({
        where: notDeletedWhere({ id }),
        select: { id: true, status: true, supervisorMemberId: true },
      });
      if (!current) throw new BizException(BizCode.SUPERVISION_ASSIGNMENT_NOT_FOUND);
      if (current.status !== SupervisionStatus.ACTIVE) {
        throw new BizException(BizCode.SUPERVISION_ASSIGNMENT_ALREADY_ENDED);
      }

      const updated = await tx.organizationSupervisionAssignment.update({
        where: { id },
        data: {
          status: SupervisionStatus.REVOKED,
          revokedByUserId: user.id,
          endedAt: new Date(),
        },
        select: supervisionAssignmentSafeSelect,
      });

      await this.auditLogs.log({
        event: 'supervision-assignment.revoke',
        actorUserId: user.id,
        actorRoleSnap: user.role,
        resourceType: AUDIT_RESOURCE_TYPE,
        resourceId: updated.id,
        meta,
        before: { status: current.status },
        after: {
          status: updated.status,
          endedAt: updated.endedAt,
          revokedByUserId: updated.revokedByUserId,
        },
        extra: { operation: 'revoke', supervisorMemberId: updated.supervisorMemberId },
        tx,
      });

      return this.toResponseDto(updated);
    });
  }

  // ============ F5/E2(2026-07-04;路线图 §4)以下为分页总表 / detail / 覆盖预演增强面 ============

  // ============ GET /api/admin/v1/supervision-assignments/page(D9 同型) ============

  // 分页总表(旧 bare 数组端点〔仅 ACTIVE〕逐字不动的兄弟路由;本总表缺省含 REVOKED 历史,status 过滤收窄)。
  // includeDescendants 直读 organization_closure(沿本 service scope/supervisors 既有直读范式;
  // 仅列表数据过滤,绝不进判权路径)。expand=supervisor,organization(D6:缺省不展开,批量取回零 N+1)。
  async page(
    user: CurrentUserPayload,
    query: PageSupervisionAssignmentsQueryDto,
  ): Promise<PageResultDto<SupervisionAssignmentResponseDto>> {
    await this.assertCanOrThrow(user, 'supervision-assignment.read.record');
    const expand = parseExpandQuery(query.expand, SUPERVISION_EXPAND_TOKENS);

    const where: Prisma.OrganizationSupervisionAssignmentWhereInput = { deletedAt: null };
    if (query.supervisorMemberId !== undefined) where.supervisorMemberId = query.supervisorMemberId;
    if (query.scopeMode !== undefined) where.scopeMode = query.scopeMode;
    if (query.status !== undefined) where.status = query.status;
    if (query.organizationId !== undefined) {
      if (query.includeDescendants === true) {
        const rows = await this.prisma.organizationClosure.findMany({
          where: { ancestorId: query.organizationId },
          select: { descendantId: true },
        });
        where.organizationId = { in: rows.map((r) => r.descendantId) };
      } else {
        where.organizationId = query.organizationId;
      }
    }
    if (query.q !== undefined && query.q !== '') {
      const contains = { contains: query.q, mode: 'insensitive' as const };
      where.OR = [
        { supervisor: { memberNo: contains } },
        { supervisor: { displayName: contains } },
        { organization: { name: contains } },
        { organization: { code: contains } },
      ];
    }

    const [rows, total] = await Promise.all([
      this.prisma.organizationSupervisionAssignment.findMany({
        where,
        select: supervisionAssignmentSafeSelect,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.organizationSupervisionAssignment.count({ where }),
    ]);

    let items: SupervisionAssignmentResponseDto[] = rows.map((r) => this.toResponseDto(r));
    if (expand.size > 0) {
      items = await this.attachExpansions(items, {
        supervisor: expand.has('supervisor'),
        organization: expand.has('organization'),
      });
    }
    return { items, total, page: query.page, pageSize: query.pageSize };
  }

  // expand 展开(D6):按命中 token 批量取回摘要后逐行挂载(零 N+1)。
  private async attachExpansions(
    items: SupervisionAssignmentResponseDto[],
    want: { supervisor: boolean; organization: boolean },
  ): Promise<SupervisionAssignmentResponseDto[]> {
    const supervisorMap = new Map<string, SupervisionExpandedSupervisorDto>();
    const orgMap = new Map<string, SupervisionExpandedOrganizationDto>();
    if (items.length > 0) {
      if (want.supervisor) {
        const rows = await this.prisma.member.findMany({
          where: { id: { in: [...new Set(items.map((i) => i.supervisorMemberId))] } },
          select: { id: true, memberNo: true, displayName: true, gradeCode: true },
        });
        for (const r of rows) supervisorMap.set(r.id, r);
      }
      if (want.organization) {
        const rows = await this.prisma.organization.findMany({
          where: { id: { in: [...new Set(items.map((i) => i.organizationId))] } },
          select: { id: true, name: true, code: true, nodeTypeCode: true },
        });
        for (const r of rows) orgMap.set(r.id, r);
      }
    }
    return items.map((item) => {
      const out = { ...item };
      if (want.supervisor) {
        const s = supervisorMap.get(item.supervisorMemberId);
        if (s) out.supervisor = s;
      }
      if (want.organization) {
        const o = orgMap.get(item.organizationId);
        if (o) out.organization = o;
      }
      return out;
    });
  }

  // ============ GET /api/admin/v1/supervision-assignments/:id(detail) ============

  // 此前只有列表 / PATCH / revoke;找不到未软删记录 → 33001。同读码。
  async findOne(user: CurrentUserPayload, id: string): Promise<SupervisionAssignmentResponseDto> {
    await this.assertCanOrThrow(user, 'supervision-assignment.read.record');
    const row = await this.prisma.organizationSupervisionAssignment.findFirst({
      where: notDeletedWhere({ id }),
      select: supervisionAssignmentSafeSelect,
    });
    if (!row) throw new BizException(BizCode.SUPERVISION_ASSIGNMENT_NOT_FOUND);
    return this.toResponseDto(row);
  }

  // ============ POST /api/admin/v1/supervision-assignments/coverage-preview ============

  // dry-run 覆盖预演:「这条分管建下去会覆盖哪些组织」——EXACT=[organizationId];TREE=closure 展开
  // (该组织 + 全部后代,含自身;沿 getSupervisionScope 同一展开口径)。**纯展示读 closure,绝非判权;
  // 零写入**(建前给运营看清覆盖面;不校验 supervisor —— 分管与职务正交,覆盖面只由 org × scopeMode 决定)。
  async coveragePreview(
    user: CurrentUserPayload,
    dto: SupervisionCoveragePreviewDto,
  ): Promise<SupervisionCoveragePreviewResponseDto> {
    await this.assertCanOrThrow(user, 'supervision-assignment.read.record');
    await this.findOrganizationOrThrow(dto.organizationId, this.prisma);
    const scopeMode = dto.scopeMode ?? SupervisionScopeMode.TREE;
    if (scopeMode === SupervisionScopeMode.EXACT) {
      return {
        organizationId: dto.organizationId,
        scopeMode,
        expandedOrganizationIds: [dto.organizationId],
      };
    }
    const rows = await this.prisma.organizationClosure.findMany({
      where: { ancestorId: dto.organizationId },
      select: { descendantId: true },
    });
    const ids = rows.map((r) => r.descendantId);
    return {
      organizationId: dto.organizationId,
      scopeMode,
      // closure 缺 depth-0 自身时兜底纳入(镜像 getSupervisors 的 scopeIds 兜底口径)
      expandedOrganizationIds: ids.includes(dto.organizationId)
        ? ids
        : [dto.organizationId, ...ids],
    };
  }

  // ============ P2002 兜底 ============

  // partial unique organization_supervision_assignments_active_unique 由 migration.sql 末尾手写,
  // P2002 meta.target 不可靠 → 任何 P2002 直接抛 ALREADY_EXISTS(33002;并发下防重底线)。
  private async runWithUniqueGuard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new BizException(BizCode.SUPERVISION_ALREADY_EXISTS);
      }
      throw err;
    }
  }
}
