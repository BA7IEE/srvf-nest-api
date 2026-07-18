import { Injectable } from '@nestjs/common';
import { MemberStatus, Prisma } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import type { BizCodeEntry } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { notDeletedWhere } from '../../common/prisma/soft-delete.util';
import { PrismaService } from '../../database/prisma.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { lockOrganizationTopology } from '../organizations/organization-topology-transaction';
import { OrganizationsService } from '../organizations/organizations.service';
import { RbacService } from '../permissions/rbac.service';
import { PositionAssignmentsService } from '../position-assignments/position-assignments.service';
import { SupervisionAssignmentsService } from '../supervision-assignments/supervision-assignments.service';
import {
  AnnouncementImportRequestDto,
  AnnouncementImportResultDto,
  ImportOrganizationRowDto,
  ImportOrganizationRowResultDto,
  ImportPositionRowDto,
  ImportPositionRowResultDto,
  ImportRowIssueDto,
  ImportRowStatus,
  ImportSummaryDto,
  ImportSupervisionRowDto,
  ImportSupervisionRowResultDto,
} from './announcement-import.dto';

// 终态 scoped-authz PR11(2026-07-02;冻结稿 §8.4 / §11 PR11):公告导入 preview/execute 编排 service。
//
// **决断②:绝不绕过 —— 本文件只做锚定解析 + 编排 + 逐行结果聚合。**
// 任命 5 校验 / 分管校验 / closure 维护 / audit 写入,全部只存在于 OrganizationsService /
// PositionAssignmentsService / SupervisionAssignmentsService 的 create()(见各自 transaction option 注释)。
// 本文件唯一新增的"判断逻辑"是:①code/memberNo/positionCode → id 的锚定读(单表 findFirst,
// 非业务规则)②仅本请求内可见的批内重复行哨兵 ③displayName 唯一命中辅助解析(仅 preview,决断③)。
//
// **preview / execute 共用同一个 request-wide 事务编排**:三个被复用 service 的 create() 接受本请求
// transaction client,因此同请求新建组织及其 closure/audit 对后续任命/分管真实可见。逐行 SAVEPOINT
// 保留既有 blocked/already-exists best-effort 聚合；未声明异常则整请求回滚。preview 在完整结果生成后抛
// PreviewAbort 回滚整批，execute 提交整批，二者除最终 commit/rollback 决策外没有事务拓扑分叉。
//
// **组织行处理顺序 = 请求内声明顺序,父必须先于子**:orgCodeMap 在处理 organizations[] 时逐行建立
// (外层 transaction 内未提交写对后续行真实可见);positions[] / supervisions[] 的 orgCode 解析先查
// orgCodeMap 再查当前 transaction,因此可引用同请求内更早声明的组织行。
//
// **批内重复检测(seenXxx 系列)只在本文件存在**:这不是重复业务校验,而是稳定逐行诊断 ——
// 在调用被复用 service 前给出确定的本批重复原因,避免结果依赖数据库约束错误的触发时序。
//
// **already-exists 一致性校验 + 毒丸传播(review #484 G8)**:组织行撞 ORGANIZATION_CODE_ALREADY_EXISTS
// 时不再无条件"视为就是这个组"——先核对既有组织 nodeTypeCode=group 且 parentId 与本行已解析的
// parent.id 一致,匹配才判 already-exists(幂等语义不变);不匹配(code 误撞语义不同的既有异构组织,
// 如 seed 内置真实缩写)→ 该行改判 blocked,并把 code 计入本请求的 poisonedOrgCodes——resolveOrg 是
// "先查 map 再查库",即使这里不写 orgCodeMap,后续 positions[]/supervisions[] 行经 DB 直查仍会命中
// 同一个错误组织,必须显式毒丸传播才挡得住静默挂错。从未在本请求 organizations[] 声明过的 code 不受
// 影响(直查 DB 放行——双锚设计下引用 seed 内置组织的合法路径必须原样工作)。

const DEFAULT_APPOINTMENT_SOURCE = 'announcement-2026';
const GROUP_NODE_TYPE_CODE = 'group';
const ANNOUNCEMENT_IMPORT_TRANSACTION_TIMEOUT_MS = 300_000;
type PrismaTx = Prisma.TransactionClient;

class PreviewAbort extends Error {
  constructor(public readonly value: AnnouncementImportResultDto) {
    super('ANNOUNCEMENT_IMPORT_PREVIEW_ABORT');
  }
}

interface OrgAnchor {
  id: string;
  nodeTypeCode: string;
}

type MemberAnchorResult =
  | { kind: 'resolved'; memberId: string }
  | { kind: 'needs-manual'; issue: ImportRowIssueDto; suggestedMemberNo?: string }
  | { kind: 'blocked'; issue: ImportRowIssueDto };

function fromBizCode(entry: BizCodeEntry): ImportRowIssueDto {
  return { bizCode: entry.code, message: entry.message };
}

function fromBizException(err: BizException): ImportRowIssueDto {
  return { bizCode: err.biz.code, message: err.biz.message };
}

function synthetic(message: string): ImportRowIssueDto {
  return { bizCode: null, message };
}

function summarize(rows: ReadonlyArray<{ status: ImportRowStatus }>): ImportSummaryDto {
  const summary: ImportSummaryDto = {
    total: rows.length,
    ok: 0,
    blocked: 0,
    alreadyExists: 0,
    needsManual: 0,
  };
  for (const r of rows) {
    if (r.status === 'ok') summary.ok += 1;
    else if (r.status === 'blocked') summary.blocked += 1;
    else if (r.status === 'already-exists') summary.alreadyExists += 1;
    else summary.needsManual += 1;
  }
  return summary;
}

@Injectable()
export class AnnouncementImportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rbac: RbacService,
    private readonly organizations: OrganizationsService,
    private readonly positionAssignments: PositionAssignmentsService,
    private readonly supervisionAssignments: SupervisionAssignmentsService,
  ) {}

  private async assertCanOrThrow(user: CurrentUserPayload, action: string): Promise<void> {
    if (!(await this.rbac.can(user, action))) {
      throw new BizException(BizCode.RBAC_FORBIDDEN);
    }
  }

  // ============ POST /api/admin/v1/announcement-import/preview ============

  async preview(
    user: CurrentUserPayload,
    dto: AnnouncementImportRequestDto,
    meta: AuditMeta,
  ): Promise<AnnouncementImportResultDto> {
    await this.assertCanOrThrow(user, 'announcement-import.preview.record');
    return this.run(user, dto, meta, true);
  }

  // ============ POST /api/admin/v1/announcement-import/execute ============

  async execute(
    user: CurrentUserPayload,
    dto: AnnouncementImportRequestDto,
    meta: AuditMeta,
  ): Promise<AnnouncementImportResultDto> {
    await this.assertCanOrThrow(user, 'announcement-import.execute.record');
    return this.run(user, dto, meta, false);
  }

  // ============ 编排主流程 ============

  private async run(
    user: CurrentUserPayload,
    dto: AnnouncementImportRequestDto,
    meta: AuditMeta,
    dryRun: boolean,
  ): Promise<AnnouncementImportResultDto> {
    const organizationRows = dto.organizations ?? [];
    const positionRows = dto.positions ?? [];
    const supervisionRows = dto.supervisions ?? [];
    if (
      organizationRows.length === 0 &&
      positionRows.length === 0 &&
      supervisionRows.length === 0
    ) {
      throw new BizException(BizCode.BAD_REQUEST);
    }

    try {
      return await this.prisma.$transaction(
        async (tx) => {
          const result = await this.runInTransaction(
            user,
            organizationRows,
            positionRows,
            supervisionRows,
            meta,
            dryRun,
            tx,
          );
          if (dryRun) throw new PreviewAbort(result);
          return result;
        },
        { timeout: ANNOUNCEMENT_IMPORT_TRANSACTION_TIMEOUT_MS },
      );
    } catch (err) {
      if (err instanceof PreviewAbort) return err.value;
      throw err;
    }
  }

  private async runInTransaction(
    user: CurrentUserPayload,
    organizationRows: ImportOrganizationRowDto[],
    positionRows: ImportPositionRowDto[],
    supervisionRows: ImportSupervisionRowDto[],
    meta: AuditMeta,
    dryRun: boolean,
    tx: PrismaTx,
  ): Promise<AnnouncementImportResultDto> {
    // parentCode/orgCode 解析也是 topology SQL；因此必须在 request-wide transaction
    // 入口取锁，不能等到随后 OrganizationsService.create() 内才首次取锁。
    await lockOrganizationTopology(tx);

    // organizations[] 必须先于 positions[]/supervisions[] 处理完毕,后两者才能引用本批新建组织。
    const orgCodeMap = new Map<string, OrgAnchor>();
    const seenOrgCodes = new Set<string>();
    // 本请求内因 already-exists 锚点冲突改判 blocked 的组织 code(毒丸集;review #484 G8)——
    // positions[]/supervisions[] 引用这些 code 的行一律随之 blocked,不落库。
    const poisonedOrgCodes = new Set<string>();
    const organizations: ImportOrganizationRowResultDto[] = [];
    for (const row of organizationRows) {
      organizations.push(
        await this.processRowInSavepoint(tx, () =>
          this.processOrganizationRow(
            user,
            row,
            orgCodeMap,
            seenOrgCodes,
            poisonedOrgCodes,
            meta,
            tx,
          ),
        ),
      );
    }

    const seenPositionKeys = new Set<string>();
    const positions: ImportPositionRowResultDto[] = [];
    for (const row of positionRows) {
      positions.push(
        await this.processRowInSavepoint(tx, () =>
          this.processPositionRow(
            user,
            row,
            orgCodeMap,
            poisonedOrgCodes,
            seenPositionKeys,
            meta,
            dryRun,
            tx,
          ),
        ),
      );
    }

    const seenSupervisionKeys = new Set<string>();
    const supervisions: ImportSupervisionRowResultDto[] = [];
    for (const row of supervisionRows) {
      supervisions.push(
        await this.processRowInSavepoint(tx, () =>
          this.processSupervisionRow(
            user,
            row,
            orgCodeMap,
            poisonedOrgCodes,
            seenSupervisionKeys,
            meta,
            dryRun,
            tx,
          ),
        ),
      );
    }

    return {
      organizations,
      positions,
      supervisions,
      summary: summarize([...organizations, ...positions, ...supervisions]),
    };
  }

  private async processRowInSavepoint<T extends { status: ImportRowStatus }>(
    tx: PrismaTx,
    operation: () => Promise<T>,
  ): Promise<T> {
    await tx.$executeRaw(Prisma.sql`SAVEPOINT announcement_import_row`);
    let result: T;
    try {
      result = await operation();
    } catch (err) {
      await tx.$executeRaw(Prisma.sql`ROLLBACK TO SAVEPOINT announcement_import_row`);
      await tx.$executeRaw(Prisma.sql`RELEASE SAVEPOINT announcement_import_row`);
      throw err;
    }

    if (result.status === 'ok') {
      await tx.$executeRaw(Prisma.sql`RELEASE SAVEPOINT announcement_import_row`);
    } else {
      await tx.$executeRaw(Prisma.sql`ROLLBACK TO SAVEPOINT announcement_import_row`);
      await tx.$executeRaw(Prisma.sql`RELEASE SAVEPOINT announcement_import_row`);
    }
    return result;
  }

  // ============ 锚定解析(只读;非业务校验)============

  private async resolveOrg(
    code: string,
    orgCodeMap: Map<string, OrgAnchor>,
    tx: PrismaTx,
  ): Promise<OrgAnchor | null> {
    const cached = orgCodeMap.get(code);
    if (cached) return cached;
    return tx.organization.findFirst({
      where: notDeletedWhere({ code }),
      select: { id: true, nodeTypeCode: true },
    });
  }

  // 双锚铁律(R7,决断③):memberNo 给了就唯一确认;execute 不接受仅姓名行;preview 对仅姓名行做
  // displayName 唯一命中辅助解析(仍需人工确认,绝不据此自动落库)。
  private async resolveMemberAnchor(
    memberNo: string | undefined,
    displayName: string | undefined,
    dryRun: boolean,
    tx: PrismaTx,
  ): Promise<MemberAnchorResult> {
    if (memberNo) {
      const member = await tx.member.findFirst({
        where: notDeletedWhere({ memberNo }),
        select: { id: true, status: true },
      });
      if (!member) return { kind: 'blocked', issue: fromBizCode(BizCode.MEMBER_NOT_FOUND) };
      if (member.status !== MemberStatus.ACTIVE) {
        return { kind: 'blocked', issue: fromBizCode(BizCode.MEMBER_INACTIVE) };
      }
      return { kind: 'resolved', memberId: member.id };
    }

    if (!dryRun) {
      return {
        kind: 'blocked',
        issue: synthetic(
          'execute 要求 memberNo(双锚铁律 R7,不接受仅姓名行);请先 preview 确认后回填 memberNo',
        ),
      };
    }

    if (!displayName) {
      return { kind: 'blocked', issue: synthetic('缺 memberNo 与 displayName,无法解析队员身份') };
    }

    const matches = await tx.member.findMany({
      where: notDeletedWhere({ displayName, status: MemberStatus.ACTIVE }),
      select: { memberNo: true },
      take: 2,
    });
    if (matches.length === 0) {
      return {
        kind: 'needs-manual',
        issue: synthetic(`姓名"${displayName}"未命中任何 active 队员,需人工指定 memberNo`),
      };
    }
    if (matches.length > 1) {
      return {
        kind: 'needs-manual',
        issue: synthetic(`姓名"${displayName}"命中多个 active 队员,需人工指定 memberNo`),
      };
    }
    return {
      kind: 'needs-manual',
      issue: synthetic(
        `姓名"${displayName}"唯一命中 active 队员,建议 memberNo=${matches[0].memberNo},请确认后回填`,
      ),
      suggestedMemberNo: matches[0].memberNo,
    };
  }

  // ============ 组织行(nodeType 恒为 'group';决断①)============

  private async processOrganizationRow(
    user: CurrentUserPayload,
    row: ImportOrganizationRowDto,
    orgCodeMap: Map<string, OrgAnchor>,
    seenCodes: Set<string>,
    poisonedOrgCodes: Set<string>,
    meta: AuditMeta,
    tx: PrismaTx,
  ): Promise<ImportOrganizationRowResultDto> {
    if (!row.code || !row.parentCode || !row.name) {
      return {
        row,
        status: 'blocked',
        reasons: [synthetic('组织行缺 code / parentCode / name(均必填)')],
      };
    }
    if (seenCodes.has(row.code)) {
      return {
        row,
        status: 'blocked',
        reasons: [synthetic(`code=${row.code} 在本请求内重复出现`)],
      };
    }
    seenCodes.add(row.code);

    const parent = await this.resolveOrg(row.parentCode, orgCodeMap, tx);
    if (!parent) {
      return {
        row,
        status: 'blocked',
        reasons: [
          synthetic(`parentCode=${row.parentCode} 未找到(既非已有组织,亦非本请求更早声明的组织行)`),
        ],
      };
    }

    try {
      const created = await this.organizations.create(
        user,
        {
          name: row.name,
          code: row.code,
          parentId: parent.id,
          nodeTypeCode: GROUP_NODE_TYPE_CODE,
          establishmentStatusCode: row.establishmentStatusCode,
          groupFunctionCode: row.groupFunctionCode,
          sortOrder: row.sortOrder,
        },
        meta,
        { transaction: tx },
      );
      orgCodeMap.set(row.code, { id: created.id, nodeTypeCode: GROUP_NODE_TYPE_CODE });
      return { row, status: 'ok', reasons: [], organizationId: created.id };
    } catch (err) {
      if (!(err instanceof BizException)) throw err;
      if (err.biz.code === BizCode.ORGANIZATION_CODE_ALREADY_EXISTS.code) {
        // 幂等(决断⑤,已收窄见 review #484 G8):code 已被占用 → 先核对锚点一致性(nodeType=group
        // 且父级 = 本行已解析的 parent.id)才"视为就是这个组"。名称/设立状态/组功能差异不纳入比对
        // (名称漂移合法;锚 = 类型 + 父级)。
        const existing = await tx.organization.findFirst({
          where: notDeletedWhere({ code: row.code }),
          select: { id: true, nodeTypeCode: true, parentId: true },
        });
        if (
          existing &&
          existing.nodeTypeCode === GROUP_NODE_TYPE_CODE &&
          existing.parentId === parent.id
        ) {
          orgCodeMap.set(row.code, { id: existing.id, nodeTypeCode: existing.nodeTypeCode });
          return {
            row,
            status: 'already-exists',
            reasons: [fromBizException(err)],
            organizationId: existing.id,
          };
        }
        if (existing) {
          // 锚点不一致:code 撞了语义不同的既有组织(如 seed 内置真实缩写)。不复用、改判 blocked,
          // 并把 code 打入毒丸集阻断同请求内 positions[]/supervisions[] 行静默挂错(见 processPositionRow
          // / processSupervisionRow 的 poisonedOrgCodes 拦截)。
          poisonedOrgCodes.add(row.code);
          return {
            row,
            status: 'blocked',
            reasons: [
              synthetic(
                `code=${row.code} 撞既有异构组织:期望 nodeType=${GROUP_NODE_TYPE_CODE}/parentId=${parent.id},` +
                  `实际 nodeType=${existing.nodeTypeCode}/parentId=${existing.parentId ?? 'null'}`,
              ),
            ],
          };
        }
      }
      return { row, status: 'blocked', reasons: [fromBizException(err)] };
    }
  }

  // ============ 任命行 ============

  private async processPositionRow(
    user: CurrentUserPayload,
    row: ImportPositionRowDto,
    orgCodeMap: Map<string, OrgAnchor>,
    poisonedOrgCodes: ReadonlySet<string>,
    seenKeys: Set<string>,
    meta: AuditMeta,
    dryRun: boolean,
    tx: PrismaTx,
  ): Promise<ImportPositionRowResultDto> {
    const missing: string[] = [];
    if (!row.orgCode) missing.push('orgCode');
    if (!row.positionCode) missing.push('positionCode');
    if (!row.startedAt) missing.push('startedAt');
    if (missing.length > 0) {
      return { row, status: 'blocked', reasons: [synthetic(`缺必填字段:${missing.join(', ')}`)] };
    }
    // 毒丸传播(review #484 G8):orgCode 对应的组织行本请求内因锚点冲突已判 blocked——resolveOrg
    // 的 DB 直查仍会命中该异构既有组织,必须在此显式拦截,不能让本行静默挂到错误组织上。
    if (poisonedOrgCodes.has(row.orgCode!)) {
      return {
        row,
        status: 'blocked',
        reasons: [
          synthetic(
            `orgCode=${row.orgCode} 对应的组织行在本请求内锚点冲突已判 blocked,本行随之阻断`,
          ),
        ],
      };
    }

    const anchor = await this.resolveMemberAnchor(row.memberNo, row.displayName, dryRun, tx);
    if (anchor.kind === 'needs-manual') {
      return {
        row,
        status: 'needs-manual',
        reasons: [anchor.issue],
        suggestedMemberNo: anchor.suggestedMemberNo ?? null,
      };
    }
    if (anchor.kind === 'blocked') {
      return { row, status: 'blocked', reasons: [anchor.issue] };
    }

    const dedupeKey = `${anchor.memberId}::${row.orgCode}::${row.positionCode}`;
    if (seenKeys.has(dedupeKey)) {
      return {
        row,
        status: 'blocked',
        reasons: [synthetic('该 (队员, 组织, 职务) 组合在本请求内重复出现')],
      };
    }
    seenKeys.add(dedupeKey);

    const org = await this.resolveOrg(row.orgCode!, orgCodeMap, tx);
    if (!org) {
      return { row, status: 'blocked', reasons: [fromBizCode(BizCode.ORGANIZATION_NOT_FOUND)] };
    }

    const position = await tx.organizationPosition.findFirst({
      where: notDeletedWhere({ code: row.positionCode }),
      select: { id: true },
    });
    if (!position) {
      return { row, status: 'blocked', reasons: [fromBizCode(BizCode.POSITION_NOT_FOUND)] };
    }

    try {
      const created = await this.positionAssignments.create(
        user,
        org.id,
        {
          positionId: position.id,
          memberId: anchor.memberId,
          startedAt: row.startedAt!,
          endedAt: row.endedAt,
          isConcurrent: row.isConcurrent,
          note: row.note,
          appointmentSource: row.appointmentSource ?? DEFAULT_APPOINTMENT_SOURCE,
        },
        meta,
        { transaction: tx },
      );
      return { row, status: 'ok', reasons: [], positionAssignmentId: created.id };
    } catch (err) {
      if (!(err instanceof BizException)) throw err;
      if (err.biz.code === BizCode.POSITION_ASSIGNMENT_ALREADY_EXISTS.code) {
        return { row, status: 'already-exists', reasons: [fromBizException(err)] };
      }
      return { row, status: 'blocked', reasons: [fromBizException(err)] };
    }
  }

  // ============ 分管行 ============

  private async processSupervisionRow(
    user: CurrentUserPayload,
    row: ImportSupervisionRowDto,
    orgCodeMap: Map<string, OrgAnchor>,
    poisonedOrgCodes: ReadonlySet<string>,
    seenKeys: Set<string>,
    meta: AuditMeta,
    dryRun: boolean,
    tx: PrismaTx,
  ): Promise<ImportSupervisionRowResultDto> {
    const missing: string[] = [];
    if (!row.orgCode) missing.push('orgCode');
    if (!row.startedAt) missing.push('startedAt');
    if (missing.length > 0) {
      return { row, status: 'blocked', reasons: [synthetic(`缺必填字段:${missing.join(', ')}`)] };
    }
    // 毒丸传播(review #484 G8):同 processPositionRow——orgCode 对应的组织行本请求内因锚点冲突
    // 已判 blocked,本行随之阻断,不能经 resolveOrg 的 DB 直查静默挂到错误组织上。
    if (poisonedOrgCodes.has(row.orgCode!)) {
      return {
        row,
        status: 'blocked',
        reasons: [
          synthetic(
            `orgCode=${row.orgCode} 对应的组织行在本请求内锚点冲突已判 blocked,本行随之阻断`,
          ),
        ],
      };
    }

    const anchor = await this.resolveMemberAnchor(
      row.supervisorMemberNo,
      row.displayName,
      dryRun,
      tx,
    );
    if (anchor.kind === 'needs-manual') {
      return {
        row,
        status: 'needs-manual',
        reasons: [anchor.issue],
        suggestedMemberNo: anchor.suggestedMemberNo ?? null,
      };
    }
    if (anchor.kind === 'blocked') {
      return { row, status: 'blocked', reasons: [anchor.issue] };
    }

    const dedupeKey = `${anchor.memberId}::${row.orgCode}`;
    if (seenKeys.has(dedupeKey)) {
      return {
        row,
        status: 'blocked',
        reasons: [synthetic('该 (分管人, 组织) 组合在本请求内重复出现')],
      };
    }
    seenKeys.add(dedupeKey);

    const org = await this.resolveOrg(row.orgCode!, orgCodeMap, tx);
    if (!org) {
      return { row, status: 'blocked', reasons: [fromBizCode(BizCode.ORGANIZATION_NOT_FOUND)] };
    }

    try {
      const created = await this.supervisionAssignments.create(
        user,
        {
          supervisorMemberId: anchor.memberId,
          organizationId: org.id,
          scopeMode: row.scopeMode,
          startedAt: row.startedAt!,
          endedAt: row.endedAt,
          note: row.note,
        },
        meta,
        { transaction: tx },
      );
      return { row, status: 'ok', reasons: [], supervisionAssignmentId: created.id };
    } catch (err) {
      if (!(err instanceof BizException)) throw err;
      if (err.biz.code === BizCode.SUPERVISION_ALREADY_EXISTS.code) {
        return { row, status: 'already-exists', reasons: [fromBizException(err)] };
      }
      return { row, status: 'blocked', reasons: [fromBizException(err)] };
    }
  }
}
