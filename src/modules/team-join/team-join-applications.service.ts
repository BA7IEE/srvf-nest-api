import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { PageResultDto } from '../../common/dto/pagination.dto';
import type { PaginationQueryDto } from '../../common/dto/pagination.dto';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import {
  lockMembersForWrite,
  runMemberLinearizedTransaction,
} from '../../common/prisma/member-advisory-lock.util';
import { PrismaService } from '../../database/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { RbacService } from '../permissions/rbac.service';
import {
  APP_STATUS_APPROVED,
  APP_STATUS_JOINING,
  APP_STATUS_PENDING_EVALUATION,
  APP_STATUS_REJECTED,
  ELIM_STAGE_EVALUATION,
  ELIM_STAGE_GATE_TIMEOUT,
  type GateCode,
  type GateMark,
  type GateMarks,
  allGeneralGatesSatisfied,
  beijingDayNumber,
  isExtendableGate,
} from './team-join.constants';
import {
  TEAM_JOIN_APPLICATION_INCLUDE,
  type TeamJoinApplicationRow,
  buildAdminDto,
  computeContribution,
} from './team-join-progress';
import type {
  EvaluateTeamJoinApplicationDto,
  MarkGateDto,
  TeamJoinApplicationAdminDto,
} from './team-join.dto';

// 招新三期(入队)T2(2026-06-19):入队申请 admin surface 逻辑(评审稿 §3.2 / §4)。
// 标 gate(幂等;末次全过 + 贡献值≥5 自动推进 pending_evaluation)/ 综合评估(单一人工闸)/
// list+detail / 贡献值只读汇总(approved sheet,checkInAt < cutoff)。一键入队(joined)在 T4。
// 行查询 include + admin presenter(buildAdminDto)抽至 team-join-progress.ts,admin/enrollment 共用。

const AUDIT_RESOURCE_TYPE = 'team_join_application';

@Injectable()
export class TeamJoinApplicationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rbac: RbacService,
    private readonly auditLogs: AuditLogsService,
  ) {}

  private async assertCanOrThrow(user: CurrentUserPayload, action: string): Promise<void> {
    if (!(await this.rbac.can(user, action))) {
      throw new BizException(BizCode.RBAC_FORBIDDEN);
    }
  }

  private async findOrThrow(
    id: string,
    client: PrismaService | Prisma.TransactionClient,
  ): Promise<TeamJoinApplicationRow> {
    const row = await client.teamJoinApplication.findFirst({
      where: { id, deletedAt: null },
      include: TEAM_JOIN_APPLICATION_INCLUDE,
    });
    if (!row) {
      throw new BizException(BizCode.TEAM_JOIN_APPLICATION_NOT_FOUND);
    }
    return row;
  }

  /**
   * 「先取队员键、再锁申请行」的**唯一入口**(M1;并发复审 P1)。markGate / evaluate 共用。
   *
   * 为什么必须取 member 键:两者都按 `computeContribution` 的读数做状态迁移,而贡献值是
   * **跨 Sheet 的 member 聚合** —— attendances 的 finalApprove / reopen 正是在同一把键下改它。
   * 缺键时是教科书式 write skew:evaluate 读到「≥5 满足」的同时 reopen 把某张 Sheet 撤出
   * approved,提交后留下一条 approved 却欠贡献的申请;markGate 侧则是拿旧读数把行按回
   * `joining`,而 finalApprove 的里程碑快照恰好扫不到它 —— 两边都没插,通知永久丢失。
   *
   * 为什么顺序必须是 member 在前:final join 的锁图是 `member 键 → Application FOR UPDATE`
   * (见 team-join-enrollment.service 步骤 0 与本目录 CLAUDE.md)。反过来写 —— 先锁 Application
   * 行、再取 member 键 —— 就与 final join 恰好反向:终审持键等行锁、本事务持行锁等键,
   * 稳定 40P01。**这不是风格问题,是死锁**。
   *
   * memberId 是不可变列(全仓无改写入口),所以锁前读它是安全的;仍在锁后复核一次,
   * 万一不一致就 fail-closed —— 说明上面那把键锁错了人,继续下去等于没锁。
   *
   * 取到 FOR UPDATE 之后,行的状态由本事务独占,`findOrThrow` 的复读即 authoritative ——
   * 因此这里**不再**需要 `claimAtStatus`(它的「与锁前读数一致」断言在没有锁前状态读的
   * 流程里没有对象;保留它只会变成一句永真的死代码)。
   */
  private async lockMemberThenApplication(
    tx: Prisma.TransactionClient,
    id: string,
  ): Promise<TeamJoinApplicationRow> {
    const preview = await tx.teamJoinApplication.findFirst({
      where: { id, deletedAt: null },
      select: { memberId: true },
    });
    if (!preview) throw new BizException(BizCode.TEAM_JOIN_APPLICATION_NOT_FOUND);
    await lockMembersForWrite(tx, [preview.memberId]);

    const lockedRows = await tx.$queryRaw<Array<{ id: string; memberId: string }>>(Prisma.sql`
      SELECT "id", "memberId"
      FROM "team_join_applications"
      WHERE "id" = ${id}
        AND "deletedAt" IS NULL
      FOR UPDATE
    `);
    const locked = lockedRows[0];
    if (!locked) throw new BizException(BizCode.TEAM_JOIN_APPLICATION_NOT_FOUND);
    if (locked.memberId !== preview.memberId) {
      throw new BizException(BizCode.TEAM_JOIN_APPLICATION_WRONG_STATE);
    }
    return this.findOrThrow(id, tx);
  }

  // ============ admin 列表(可按 cycleId / statusCode 过滤;贡献值列表不算 = null)============
  async listForAdmin(
    query: PaginationQueryDto,
    filters: { cycleId?: string; statusCode?: string },
    user: CurrentUserPayload,
  ): Promise<PageResultDto<TeamJoinApplicationAdminDto>> {
    await this.assertCanOrThrow(user, 'team-join-application.read.record');
    const where: Prisma.TeamJoinApplicationWhereInput = { deletedAt: null };
    if (filters.cycleId !== undefined) where.cycleId = filters.cycleId;
    if (filters.statusCode !== undefined) where.statusCode = filters.statusCode;
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.teamJoinApplication.findMany({
        where,
        include: TEAM_JOIN_APPLICATION_INCLUDE,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.teamJoinApplication.count({ where }),
    ]);
    return {
      items: rows.map((r) => buildAdminDto(r, null, new Date())),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  // ============ admin 详情(含实时贡献值汇总)============
  async detailForAdmin(id: string, user: CurrentUserPayload): Promise<TeamJoinApplicationAdminDto> {
    await this.assertCanOrThrow(user, 'team-join-application.read.record');
    const row = await this.findOrThrow(id, this.prisma);
    const contribution = await computeContribution(this.prisma, row.memberId, row.cycle.year);
    return buildAdminDto(row, contribution, new Date());
  }

  // ============ 标 gate(幂等;仅 joining/pending_evaluation 态;末次自动推进)============
  async markGate(
    id: string,
    dto: MarkGateDto,
    user: CurrentUserPayload,
    meta: AuditMeta,
    now: Date,
  ): Promise<TeamJoinApplicationAdminDto> {
    await this.assertCanOrThrow(user, 'team-join-application.mark.gate');
    // M3:本事务内会取队员线性化键 ⇒ 必须显式 ReadCommitted + 有界锁等待(见 util 注释)。
    return runMemberLinearizedTransaction(this.prisma, async (tx) => {
      // M1:member 键 → Application FOR UPDATE → 复读复核,与 final join 同序(见方法注释)。
      const row = await this.lockMemberThenApplication(tx, id);
      // 仅 joining / pending_evaluation 可标(approved/joined/rejected 后门槛锁死)
      if (
        row.statusCode !== APP_STATUS_JOINING &&
        row.statusCode !== APP_STATUS_PENDING_EVALUATION
      ) {
        throw new BizException(BizCode.TEAM_JOIN_APPLICATION_WRONG_STATE);
      }
      const code = dto.gateCode as GateCode; // DTO @IsIn 已校验 ∈ ALL_GATE_CODES
      // 十项收口刀A(28243):完成日不得晚于今天(北京日口径,允许"今天"拒"明天")——此前填未来
      // 日期会立即判满足并当场自动推进(years 类 gate 还把有效期虚推更远);extendedUntil 本义即
      // 未来日期(延长期),不受此闸。与 isGateSatisfied 的本轮边界共用 beijingDayNumber 同口径。
      if (beijingDayNumber(new Date(dto.completionDate)) > beijingDayNumber(now)) {
        throw new BizException(BizCode.TEAM_JOIN_GATE_COMPLETION_IN_FUTURE);
      }
      const marks: GateMarks = { ...((row.gateMarks as GateMarks | null) ?? {}) };
      const mark: GateMark = {
        at: now.toISOString(),
        by: user.id,
        passed: dto.passed,
        completionDate: new Date(dto.completionDate).toISOString(),
      };
      // 延长期仅 dept-assessment 可设;非可延 gate 传则忽略(评审稿 §4.2)
      if (dto.extendedUntil !== undefined && isExtendableGate(code)) {
        mark.extendedUntil = new Date(dto.extendedUntil).toISOString();
      }
      marks[code] = mark;

      // 单一真相源自动推进:8 通用全满足 + 贡献值≥5 → pending_evaluation;否则回退 joining
      const generalSatisfied = allGeneralGatesSatisfied(marks, row.cycle.openedAt, now);
      const contribution = await computeContribution(tx, row.memberId, row.cycle.year);
      const nextStatus =
        generalSatisfied && contribution.satisfied
          ? APP_STATUS_PENDING_EVALUATION
          : APP_STATUS_JOINING;

      const updated = await tx.teamJoinApplication.update({
        where: { id },
        data: { gateMarks: marks as Prisma.InputJsonValue, statusCode: nextStatus },
        include: TEAM_JOIN_APPLICATION_INCLUDE,
      });
      await this.auditLogs.log({
        event: 'team-join-application.mark-gate',
        actorUserId: user.id,
        actorRoleSnap: user.role,
        resourceType: AUDIT_RESOURCE_TYPE,
        resourceId: id,
        meta,
        before: { statusCode: row.statusCode },
        after: { statusCode: nextStatus },
        extra: {
          gateCode: code,
          passed: dto.passed,
          generalGatesSatisfied: generalSatisfied,
          contributionSatisfied: contribution.satisfied,
        },
        tx,
      });
      return buildAdminDto(updated, contribution, now);
    });
  }

  // ============ 综合评估 / 淘汰(单一人工闸;评审稿 §4.5)============
  // pending_evaluation:approved→approved(待入队)/ 否→rejected(evaluation);
  // joining:仅 approved=false 淘汰(gate-timeout);approved=true→28240(门槛未齐);其余态→28240。
  async evaluate(
    id: string,
    dto: EvaluateTeamJoinApplicationDto,
    user: CurrentUserPayload,
    meta: AuditMeta,
    now: Date,
  ): Promise<TeamJoinApplicationAdminDto> {
    await this.assertCanOrThrow(user, 'team-join-application.evaluate.assessment');
    // M3:本事务内会取队员线性化键 ⇒ 必须显式 ReadCommitted + 有界锁等待(见 util 注释)。
    return runMemberLinearizedTransaction(this.prisma, async (tx) => {
      // M1:member 键 → Application FOR UPDATE → 复读复核,与 final join 同序(见方法注释)。
      // 状态判定全部落在锁后的这一行上,不再有「锁前读一次、锁后再断言一致」的两段式。
      const lockedRow = await this.lockMemberThenApplication(tx, id);
      if (
        lockedRow.statusCode !== APP_STATUS_PENDING_EVALUATION &&
        lockedRow.statusCode !== APP_STATUS_JOINING
      ) {
        throw new BizException(BizCode.TEAM_JOIN_APPLICATION_WRONG_STATE);
      }

      // Preserve the public injectable effective-time contract while refusing a pre-lock instant:
      // production uses the time observed after lock acquisition, and a caller-supplied future
      // effective time remains authoritative (also fail-safe across a backward wall-clock jump).
      const evaluationNow = new Date(Math.max(now.getTime(), Date.now()));
      let nextStatus: string;
      let eliminationStage: string | null = null;
      if (lockedRow.statusCode === APP_STATUS_PENDING_EVALUATION) {
        if (dto.approved) {
          // 锁后 authoritative 重校验：等待期间 gate 延长期和贡献事实都可能变化。
          const marks = (lockedRow.gateMarks as GateMarks | null) ?? null;
          const generalSatisfied = allGeneralGatesSatisfied(
            marks,
            lockedRow.cycle.openedAt,
            evaluationNow,
          );
          const contribution = await computeContribution(
            tx,
            lockedRow.memberId,
            lockedRow.cycle.year,
          );
          if (!generalSatisfied || !contribution.satisfied) {
            throw new BizException(BizCode.TEAM_JOIN_APPLICATION_WRONG_STATE);
          }
          nextStatus = APP_STATUS_APPROVED;
        } else {
          nextStatus = APP_STATUS_REJECTED;
          eliminationStage = ELIM_STAGE_EVALUATION;
        }
      } else if (lockedRow.statusCode === APP_STATUS_JOINING) {
        if (dto.approved) {
          throw new BizException(BizCode.TEAM_JOIN_APPLICATION_WRONG_STATE);
        }
        nextStatus = APP_STATUS_REJECTED;
        eliminationStage = ELIM_STAGE_GATE_TIMEOUT;
      } else {
        throw new BizException(BizCode.TEAM_JOIN_APPLICATION_WRONG_STATE);
      }

      const data: Prisma.TeamJoinApplicationUpdateInput = {
        statusCode: nextStatus,
        evaluatedByUserId: user.id,
        evaluatedAt: evaluationNow,
      };
      if (dto.note !== undefined) data.evaluationNote = dto.note;
      if (eliminationStage) data.eliminationStage = eliminationStage;
      if (nextStatus === APP_STATUS_APPROVED && dto.evaluationExtendedUntil !== undefined) {
        data.evaluationExtendedUntil = new Date(dto.evaluationExtendedUntil);
      }
      const updated = await tx.teamJoinApplication.update({
        where: { id },
        data,
        include: TEAM_JOIN_APPLICATION_INCLUDE,
      });
      await this.auditLogs.log({
        event: 'team-join-application.evaluate',
        actorUserId: user.id,
        actorRoleSnap: user.role,
        resourceType: AUDIT_RESOURCE_TYPE,
        resourceId: id,
        meta,
        before: { statusCode: lockedRow.statusCode },
        after: { statusCode: nextStatus },
        extra: { approved: dto.approved, eliminationStage },
        tx,
      });
      return buildAdminDto(updated, null, evaluationNow);
    });
  }
}
