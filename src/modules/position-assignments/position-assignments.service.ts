import { Injectable } from '@nestjs/common';
import { AssignmentStatus, PolicyStatus, Prisma } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import type { PageResultDto } from '../../common/dto/pagination.dto';
import { parseExpandQuery } from '../../common/dto/expand-query.util';
import { BizCode, type BizCodeEntry } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { notDeletedWhere } from '../../common/prisma/soft-delete.util';
import { PrismaService } from '../../database/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { RbacService } from '../permissions/rbac.service';
import {
  CreatePositionAssignmentDto,
  POSITION_ASSIGNMENT_EXPAND_TOKENS,
  PagePositionAssignmentsQueryDto,
  PositionAssignmentExpandedMemberDto,
  PositionAssignmentExpandedOrganizationDto,
  PositionAssignmentExpandedPositionDto,
  PositionAssignmentPreviewResponseDto,
  PositionAssignmentResponseDto,
  PositionAssignmentViolationDto,
  PreviewPositionAssignmentDto,
} from './position-assignments.dto';
import {
  positionAssignmentSafeSelect,
  type SafePositionAssignment,
} from './position-assignments.select';

// 终态 scoped-authz PR4(2026-07-01;冻结稿 §3.4 / §7.3 / §4.3 / R2):任职(position-assignments)管理面 service。
// 判权单轨 service 层 rbac.can(0 @Roles;沿 memberships / positions 范式)。任命 / 撤销写 audit(inline,
// 沿 content 范式;resourceType='position_assignment')。
//
// **本表自身 CRUD/校验逻辑不读角色/权限表(单向)**;但 **PR8 起 AuthzService 会读本表**做 3b 职务推导 grant 的
// 输入之一(review #484 G6 true-up:此前"绝不被判权路径读"措辞已过时)——任职生命周期(建/撤/过期)变化
// 直接联动授权结果,不是"与判权无关"。
// 任命校验(create)读 organization_closure(求 O 的祖先集)+ member_organization_memberships(active 判定)
// **纯属任命业务合法性(requireMembership),绝非判权** —— closure 本身不进 rbac.can/AuthzService。

const AUDIT_RESOURCE_TYPE = 'position_assignment';

type PrismaTx = Prisma.TransactionClient;

// 终态 scoped-authz PR11(2026-07-02;冻结稿 §8.4 / §11 PR11):dry-run 沙箱哨兵。
// create() 走满全部 5 校验 + 真实 insert + audit 写入后,若 options.dryRun,在事务提交前抛本类型强制
// 整个事务(含 audit)一并回滚,catch 后原样返回"本应创建"的响应体 —— 零新写入且零校验逻辑分叉,
// 供 announcement-import 预览零写入复用同一份真实校验(而非另起一套校验)。仅本文件内使用,不导出。
class DryRunAbort<T> extends Error {
  constructor(public readonly value: T) {
    super('DRY_RUN_ABORT');
  }
}

@Injectable()
export class PositionAssignmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rbac: RbacService,
    private readonly auditLogs: AuditLogsService,
  ) {}

  // ============ helpers(自包含;沿 memberships / positions 范式,不抽共享类)============

  private async assertCanOrThrow(user: CurrentUserPayload, action: string): Promise<void> {
    if (!(await this.rbac.can(user, action))) {
      throw new BizException(BizCode.RBAC_FORBIDDEN);
    }
  }

  private toResponseDto(row: SafePositionAssignment) {
    return {
      id: row.id,
      organizationId: row.organizationId,
      positionId: row.positionId,
      memberId: row.memberId,
      status: row.status,
      startedAt: row.startedAt,
      endedAt: row.endedAt,
      appointedByUserId: row.appointedByUserId,
      revokedByUserId: row.revokedByUserId,
      appointmentSource: row.appointmentSource,
      isConcurrent: row.isConcurrent,
      note: row.note,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private async findMemberOrThrow(memberId: string, tx: PrismaTx): Promise<{ id: string }> {
    const member = await tx.member.findFirst({
      where: notDeletedWhere({ id: memberId }),
      select: { id: true },
    });
    if (!member) throw new BizException(BizCode.MEMBER_NOT_FOUND);
    return member;
  }

  private async findOrganizationOrThrow(
    organizationId: string,
    tx: PrismaTx,
  ): Promise<{ id: string; nodeTypeCode: string }> {
    const org = await tx.organization.findFirst({
      where: notDeletedWhere({ id: organizationId }),
      select: { id: true, nodeTypeCode: true },
    });
    if (!org) throw new BizException(BizCode.ORGANIZATION_NOT_FOUND);
    return org;
  }

  private async findPositionOrThrow(
    positionId: string,
    tx: PrismaTx,
  ): Promise<{ id: string; allowMultiple: boolean; allowConcurrent: boolean }> {
    const position = await tx.organizationPosition.findFirst({
      where: notDeletedWhere({ id: positionId }),
      select: { id: true, allowMultiple: true, allowConcurrent: true },
    });
    if (!position) throw new BizException(BizCode.POSITION_NOT_FOUND);
    return position;
  }

  // ============ GET /api/admin/v1/organizations/:orgId/position-assignments ============

  // 组织轴:列某组织当前"在任"职务(status=ACTIVE;不含历史)。
  async listByOrganization(user: CurrentUserPayload, organizationId: string) {
    await this.assertCanOrThrow(user, 'position-assignment.read.record');
    await this.findOrganizationOrThrow(organizationId, this.prisma);
    const rows = await this.prisma.organizationPositionAssignment.findMany({
      where: { organizationId, status: AssignmentStatus.ACTIVE, deletedAt: null },
      select: positionAssignmentSafeSelect,
      orderBy: [{ startedAt: 'asc' }, { createdAt: 'asc' }],
    });
    return rows.map((r) => this.toResponseDto(r));
  }

  // ============ GET /api/admin/v1/members/:memberId/position-assignments ============

  // 队员轴:列某队员全部任职(含 ENDED / REVOKED 历史;不含软删行)。
  async listByMember(user: CurrentUserPayload, memberId: string) {
    await this.assertCanOrThrow(user, 'position-assignment.read.record');
    await this.findMemberOrThrow(memberId, this.prisma);
    const rows = await this.prisma.organizationPositionAssignment.findMany({
      where: { memberId, deletedAt: null },
      select: positionAssignmentSafeSelect,
      orderBy: [{ startedAt: 'asc' }, { createdAt: 'asc' }],
    });
    return rows.map((r) => this.toResponseDto(r));
  }

  // ============ POST /api/admin/v1/organizations/:orgId/position-assignments ============

  // 任命。校验顺序(各自独立 BizCode,便于精确定位失败):
  //   0. 存在性:org / position / member(NOT_FOUND)
  //   1. 任期:endedAt 有值须 > startedAt(TENURE_INVALID)
  //   2. 职务适配:org.nodeType × position 须有 active OrganizationPositionRule(RULE_NOT_MATCHED)
  //   3. requireMembership(匹配规则要求时):member 须在本组织 O 或其任一祖先有 active membership(MEMBERSHIP_REQUIRED)
  //   4. 兼任:position.allowConcurrent=false 时,member 不得已有其它 active 任职(CONCURRENT_FORBIDDEN)
  //   5. 防重:同人同组织同职务已有 active(ALREADY_EXISTS;partial unique 兜底)
  //   6. 单人独占:position.allowMultiple=false 时,(org,position) 已有 active 在任者(SINGLE_HOLDER)
  async create(
    user: CurrentUserPayload,
    organizationId: string,
    dto: CreatePositionAssignmentDto,
    meta: AuditMeta,
    options?: { dryRun?: boolean },
  ) {
    await this.assertCanOrThrow(user, 'position-assignment.create.record');

    // 任期校验(纯输入,不触库先做)。
    const startedAt = new Date(dto.startedAt);
    const endedAt = dto.endedAt !== undefined ? new Date(dto.endedAt) : null;
    if (endedAt !== null && endedAt.getTime() <= startedAt.getTime()) {
      throw new BizException(BizCode.POSITION_ASSIGNMENT_TENURE_INVALID);
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        const org = await this.findOrganizationOrThrow(organizationId, tx);
        const position = await this.findPositionOrThrow(dto.positionId, tx);
        await this.findMemberOrThrow(dto.memberId, tx);

        // 2. 职务适配 + 取 requireMembership(同一条规则)。(nodeTypeCode, positionId) 普通唯一 → 至多 1 active。
        const rule = await tx.organizationPositionRule.findFirst({
          where: {
            nodeTypeCode: org.nodeTypeCode,
            positionId: position.id,
            status: PolicyStatus.ACTIVE,
            deletedAt: null,
          },
          select: { requireMembership: true },
        });
        if (!rule) throw new BizException(BizCode.POSITION_ASSIGNMENT_RULE_NOT_MATCHED);

        // 3. requireMembership(冻结稿 R8 + goal「重要说明」BD-4 解读:本组织 O 或其任一祖先有 active membership)。
        //    读 organization_closure(descendantId=O → 祖先集,含 depth-0 自身)+ memberships active 判定。
        //    **纯任命业务合法性,绝非判权;closure 不进 rbac.can / AuthzService**。
        if (rule.requireMembership) {
          const ancestorRows = await tx.organizationClosure.findMany({
            where: { descendantId: organizationId },
            select: { ancestorId: true },
          });
          const scopeOrgIds = ancestorRows.map((r) => r.ancestorId);
          const membership = await tx.memberOrganizationMembership.findFirst({
            where: {
              memberId: dto.memberId,
              status: 'ACTIVE',
              deletedAt: null,
              organizationId: { in: scopeOrgIds },
            },
            select: { id: true },
          });
          if (!membership) throw new BizException(BizCode.POSITION_ASSIGNMENT_MEMBERSHIP_REQUIRED);
        }

        // 4. 兼任:position.allowConcurrent=false → member 不得已有其它 active 任职(多数职务 true,允许兼任如副队长甲)。
        if (!position.allowConcurrent) {
          const otherActive = await tx.organizationPositionAssignment.count({
            where: { memberId: dto.memberId, status: AssignmentStatus.ACTIVE, deletedAt: null },
          });
          if (otherActive > 0) {
            throw new BizException(BizCode.POSITION_ASSIGNMENT_CONCURRENT_FORBIDDEN);
          }
        }

        // 5. 防重:同人同组织同职务已有 active(service 预检 + partial unique 兜底)。
        const dup = await tx.organizationPositionAssignment.count({
          where: {
            organizationId,
            positionId: position.id,
            memberId: dto.memberId,
            status: AssignmentStatus.ACTIVE,
            deletedAt: null,
          },
        });
        if (dup > 0) throw new BizException(BizCode.POSITION_ASSIGNMENT_ALREADY_EXISTS);

        // 6. 单人独占:position.allowMultiple=false → (org,position) 不得有第二条 active(此人已在步骤 5 排除)。
        if (!position.allowMultiple) {
          const holders = await tx.organizationPositionAssignment.count({
            where: {
              organizationId,
              positionId: position.id,
              status: AssignmentStatus.ACTIVE,
              deletedAt: null,
            },
          });
          if (holders > 0) throw new BizException(BizCode.POSITION_ASSIGNMENT_SINGLE_HOLDER);
        }

        const created = await this.runWithUniqueGuard(() =>
          tx.organizationPositionAssignment.create({
            data: {
              organizationId,
              positionId: position.id,
              memberId: dto.memberId,
              status: AssignmentStatus.ACTIVE,
              startedAt,
              endedAt,
              appointedByUserId: user.id,
              appointmentSource: dto.appointmentSource ?? null,
              isConcurrent: dto.isConcurrent ?? false,
              note: dto.note ?? null,
            },
            select: positionAssignmentSafeSelect,
          }),
        );

        await this.auditLogs.log({
          event: 'position-assignment.create',
          actorUserId: user.id,
          actorRoleSnap: user.role,
          resourceType: AUDIT_RESOURCE_TYPE,
          resourceId: created.id,
          meta,
          after: {
            organizationId: created.organizationId,
            positionId: created.positionId,
            memberId: created.memberId,
            status: created.status,
            startedAt: created.startedAt,
            endedAt: created.endedAt,
            isConcurrent: created.isConcurrent,
          },
          extra: {
            operation: 'create',
            organizationId: created.organizationId,
            targetMemberId: created.memberId,
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

  // ============ POST /api/admin/v1/position-assignments/:id/revoke ============

  // 撤销:仅可撤 active 任职 → status=REVOKED + revokedByUserId + endedAt=now(保留行做历史,不软删)。
  async revoke(user: CurrentUserPayload, id: string, meta: AuditMeta) {
    await this.assertCanOrThrow(user, 'position-assignment.revoke.record');
    return this.prisma.$transaction(async (tx) => {
      const current = await tx.organizationPositionAssignment.findFirst({
        where: notDeletedWhere({ id }),
        select: { id: true, status: true, memberId: true },
      });
      if (!current) throw new BizException(BizCode.POSITION_ASSIGNMENT_NOT_FOUND);
      if (current.status !== AssignmentStatus.ACTIVE) {
        throw new BizException(BizCode.POSITION_ASSIGNMENT_ALREADY_ENDED);
      }

      const updated = await tx.organizationPositionAssignment.update({
        where: { id },
        data: {
          status: AssignmentStatus.REVOKED,
          revokedByUserId: user.id,
          endedAt: new Date(),
        },
        select: positionAssignmentSafeSelect,
      });

      await this.auditLogs.log({
        event: 'position-assignment.revoke',
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
        extra: { operation: 'revoke', targetMemberId: updated.memberId },
        tx,
      });

      return this.toResponseDto(updated);
    });
  }

  // ============ GET /api/admin/v1/position-assignments/:id/history ============

  // 任职变更/历史链:以 :id 锚定 (org, position, member) 三元组,返回其全部非软删行(ACTIVE / ENDED / REVOKED),
  // 按任期起排序 —— 该"人-坑"上的历次任命succession(撤销后仍可查)。
  async history(user: CurrentUserPayload, id: string) {
    await this.assertCanOrThrow(user, 'position-assignment.read.history');
    const anchor = await this.prisma.organizationPositionAssignment.findFirst({
      where: notDeletedWhere({ id }),
      select: { organizationId: true, positionId: true, memberId: true },
    });
    if (!anchor) throw new BizException(BizCode.POSITION_ASSIGNMENT_NOT_FOUND);

    const rows = await this.prisma.organizationPositionAssignment.findMany({
      where: {
        organizationId: anchor.organizationId,
        positionId: anchor.positionId,
        memberId: anchor.memberId,
        deletedAt: null,
      },
      select: positionAssignmentSafeSelect,
      orderBy: [{ startedAt: 'asc' }, { createdAt: 'asc' }],
    });
    return rows.map((r) => this.toResponseDto(r));
  }

  // ============ F5/E1(2026-07-04;路线图 §4)以下为全局总表 / detail / preview 增强面 ============

  // ============ GET /api/admin/v1/position-assignments(全局分页总表) ============

  // 跨组织跨队员横扫(缺省含 REVOKED 历史 —— 总表口径,与组织轴「仅 ACTIVE」刻意不同;status 过滤收窄)。
  // includeDescendants 直读 organization_closure(沿本 service create() requireMembership 既有直读范式;
  // 仅列表数据过滤,绝不进判权路径)。q 命中队员/职务/组织(relation 过滤单查询);
  // expand=member,position,organization(D6:缺省不展开,响应形状与既有端点一致,批量取回零 N+1)。
  async page(
    user: CurrentUserPayload,
    query: PagePositionAssignmentsQueryDto,
  ): Promise<PageResultDto<PositionAssignmentResponseDto>> {
    await this.assertCanOrThrow(user, 'position-assignment.read.record');
    const expand = parseExpandQuery(query.expand, POSITION_ASSIGNMENT_EXPAND_TOKENS);

    const where: Prisma.OrganizationPositionAssignmentWhereInput = { deletedAt: null };
    if (query.memberId !== undefined) where.memberId = query.memberId;
    if (query.positionId !== undefined) where.positionId = query.positionId;
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
        { member: { memberNo: contains } },
        { member: { displayName: contains } },
        { position: { code: contains } },
        { position: { name: contains } },
        { organization: { name: contains } },
        { organization: { code: contains } },
      ];
    }

    const [rows, total] = await Promise.all([
      this.prisma.organizationPositionAssignment.findMany({
        where,
        select: positionAssignmentSafeSelect,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.organizationPositionAssignment.count({ where }),
    ]);

    let items: PositionAssignmentResponseDto[] = rows.map((r) => this.toResponseDto(r));
    if (expand.size > 0) {
      items = await this.attachExpansions(items, {
        member: expand.has('member'),
        position: expand.has('position'),
        organization: expand.has('organization'),
      });
    }
    return { items, total, page: query.page, pageSize: query.pageSize };
  }

  // expand 展开(D6):按命中 token 批量取回摘要后逐行挂载(零 N+1)。
  private async attachExpansions(
    items: PositionAssignmentResponseDto[],
    want: { member: boolean; position: boolean; organization: boolean },
  ): Promise<PositionAssignmentResponseDto[]> {
    const memberMap = new Map<string, PositionAssignmentExpandedMemberDto>();
    const positionMap = new Map<string, PositionAssignmentExpandedPositionDto>();
    const orgMap = new Map<string, PositionAssignmentExpandedOrganizationDto>();
    if (items.length > 0) {
      if (want.member) {
        const rows = await this.prisma.member.findMany({
          where: { id: { in: [...new Set(items.map((i) => i.memberId))] } },
          select: { id: true, memberNo: true, displayName: true, gradeCode: true },
        });
        for (const r of rows) memberMap.set(r.id, r);
      }
      if (want.position) {
        const rows = await this.prisma.organizationPosition.findMany({
          where: { id: { in: [...new Set(items.map((i) => i.positionId))] } },
          select: { id: true, code: true, name: true, categoryCode: true },
        });
        for (const r of rows) positionMap.set(r.id, r);
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
      if (want.member) {
        const m = memberMap.get(item.memberId);
        if (m) out.member = m;
      }
      if (want.position) {
        const p = positionMap.get(item.positionId);
        if (p) out.position = p;
      }
      if (want.organization) {
        const o = orgMap.get(item.organizationId);
        if (o) out.organization = o;
      }
      return out;
    });
  }

  // ============ GET /api/admin/v1/position-assignments/:id(detail) ============

  // 此前只有 :id/history 与 :id/revoke;找不到未软删记录 → 32020。同读码。
  async findOne(user: CurrentUserPayload, id: string): Promise<PositionAssignmentResponseDto> {
    await this.assertCanOrThrow(user, 'position-assignment.read.record');
    const row = await this.prisma.organizationPositionAssignment.findFirst({
      where: notDeletedWhere({ id }),
      select: positionAssignmentSafeSelect,
    });
    if (!row) throw new BizException(BizCode.POSITION_ASSIGNMENT_NOT_FOUND);
    return this.toResponseDto(row);
  }

  // ============ POST /api/admin/v1/position-assignments/preview(dry-run 任命预检) ============

  // 逐项收集全部违规(区别于 create() 的 first-failure 抛错):任期 / 存在性(org/position/member)/
  // 任命 5 校验(职务适配 32022 / requireMembership 32025 / 兼任 32024 / 防重 32021 / 单人独占 32023)。
  // **校验逐项镜像 create() 编号 0-6 的同一批查询**(那边在事务内 first-failure 抛,这边只读逐项收集;
  // 改 create 校验时必须同步本方法 —— e2e 双向矩阵为锁)。刻意**不**复用 create(dryRun) 沙箱:
  //   ① dryRun 只能报第一个违规,preview 契约要 violations[] 全量;② dryRun 走 create.record 码,
  //   goal 拍板 preview 复用 read 码(dry-run 只读;可见面 = 持 read 码本可 list 到的任职行,无越面泄露);
  //   ③ 沙箱含真实 insert+audit+回滚,纯预检不必付事务成本。零写入。
  async preview(
    user: CurrentUserPayload,
    dto: PreviewPositionAssignmentDto,
  ): Promise<PositionAssignmentPreviewResponseDto> {
    await this.assertCanOrThrow(user, 'position-assignment.read.record');
    const violations: PositionAssignmentViolationDto[] = [];
    const push = (biz: BizCodeEntry): void => {
      violations.push({ bizCode: biz.code, message: biz.message });
    };

    // 1. 任期(镜像 create 步骤 1;纯输入)
    const startedAt = new Date(dto.startedAt);
    const endedAt = dto.endedAt !== undefined ? new Date(dto.endedAt) : null;
    if (endedAt !== null && endedAt.getTime() <= startedAt.getTime()) {
      push(BizCode.POSITION_ASSIGNMENT_TENURE_INVALID);
    }

    // 0. 存在性(镜像 create 步骤 0;缺任一硬前提则后续业务校验判不了,就此返回)
    const [org, position, member] = await Promise.all([
      this.prisma.organization.findFirst({
        where: notDeletedWhere({ id: dto.organizationId }),
        select: { id: true, nodeTypeCode: true },
      }),
      this.prisma.organizationPosition.findFirst({
        where: notDeletedWhere({ id: dto.positionId }),
        select: { id: true, allowMultiple: true, allowConcurrent: true },
      }),
      this.prisma.member.findFirst({
        where: notDeletedWhere({ id: dto.memberId }),
        select: { id: true },
      }),
    ]);
    if (!org) push(BizCode.ORGANIZATION_NOT_FOUND);
    if (!position) push(BizCode.POSITION_NOT_FOUND);
    if (!member) push(BizCode.MEMBER_NOT_FOUND);
    if (!org || !position || !member) {
      return { valid: false, violations };
    }

    // 2. 职务适配(镜像 create 步骤 2)
    const rule = await this.prisma.organizationPositionRule.findFirst({
      where: {
        nodeTypeCode: org.nodeTypeCode,
        positionId: position.id,
        status: PolicyStatus.ACTIVE,
        deletedAt: null,
      },
      select: { requireMembership: true },
    });
    if (!rule) push(BizCode.POSITION_ASSIGNMENT_RULE_NOT_MATCHED);

    // 3. requireMembership(镜像 create 步骤 3;规则缺席时判不了,跳过)
    if (rule?.requireMembership) {
      const ancestorRows = await this.prisma.organizationClosure.findMany({
        where: { descendantId: dto.organizationId },
        select: { ancestorId: true },
      });
      const membership = await this.prisma.memberOrganizationMembership.findFirst({
        where: {
          memberId: dto.memberId,
          status: 'ACTIVE',
          deletedAt: null,
          organizationId: { in: ancestorRows.map((r) => r.ancestorId) },
        },
        select: { id: true },
      });
      if (!membership) push(BizCode.POSITION_ASSIGNMENT_MEMBERSHIP_REQUIRED);
    }

    // 4. 兼任(镜像 create 步骤 4)
    if (!position.allowConcurrent) {
      const otherActive = await this.prisma.organizationPositionAssignment.count({
        where: { memberId: dto.memberId, status: AssignmentStatus.ACTIVE, deletedAt: null },
      });
      if (otherActive > 0) push(BizCode.POSITION_ASSIGNMENT_CONCURRENT_FORBIDDEN);
    }

    // 5. 防重(镜像 create 步骤 5)
    const dup = await this.prisma.organizationPositionAssignment.count({
      where: {
        organizationId: dto.organizationId,
        positionId: position.id,
        memberId: dto.memberId,
        status: AssignmentStatus.ACTIVE,
        deletedAt: null,
      },
    });
    if (dup > 0) push(BizCode.POSITION_ASSIGNMENT_ALREADY_EXISTS);

    // 6. 单人独占(镜像 create 步骤 6;此人已由步骤 5 报重,这里报"坑已有他人")
    if (!position.allowMultiple && dup === 0) {
      const holders = await this.prisma.organizationPositionAssignment.count({
        where: {
          organizationId: dto.organizationId,
          positionId: position.id,
          status: AssignmentStatus.ACTIVE,
          deletedAt: null,
        },
      });
      if (holders > 0) push(BizCode.POSITION_ASSIGNMENT_SINGLE_HOLDER);
    }

    return { valid: violations.length === 0, violations };
  }

  // ============ P2002 兜底 ============

  // partial unique organization_position_assignments_active_unique 由 migration.sql 末尾手写,
  // P2002 meta.target 不可靠 → 任何 P2002 直接抛 ALREADY_EXISTS(32021;并发下防重底线)。
  private async runWithUniqueGuard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new BizException(BizCode.POSITION_ASSIGNMENT_ALREADY_EXISTS);
      }
      throw err;
    }
  }
}
