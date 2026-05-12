import { Injectable } from '@nestjs/common';
import { ContributionRuleStatus, DictItemStatus, DictTypeStatus, Prisma } from '@prisma/client';
import { auditPlaceholder } from '../../common/audit/audit-placeholder';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { PageResultDto } from '../../common/dto/pagination.dto';
import { BizCode, type BizCodeEntry } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { notDeletedWhere } from '../../common/prisma/soft-delete.util';
import { PrismaService } from '../../database/prisma.service';
import {
  ContributionRuleQueryDto,
  ContributionRuleResponseDto,
  CreateContributionRuleDto,
  UpdateContributionRuleDto,
} from './contribution-rules.dto';
import { contributionRuleSafeSelect, type SafeContributionRule } from './contribution-rules.select';

// V2 第一阶段批次 5-A contribution_rules service。
// 详见 docs/批次5-A_贡献值规则CRUD_API前评审.md v1.1 §4。
//
// 关键约定:
// - 字典常量内部 const 化(沿 batch 3 activities / attendances 范式;不抽公共工具)
// - ACTIVE 唯一性:create / update 同事务 count + 含 NULL durationThreshold 维度(B2);
//   23002 优先;P2002 仅作并发兜底(M3)
// - PATCH 禁改 activityTypeCode / attendanceRoleCode / durationThreshold(B3 + E8;
//   由 UpdateContributionRuleDto 白名单 + ValidationPipe forbidNonWhitelisted 兜底;不开 23030)
// - softDelete 写 deletedAt + deletedByUserId(schema 已在 batch 4-A 含字段,见 E5);
//   status 不强制改 INACTIVE
// - audit hook 3 个写操作;list / detail 不 hook(E6)
// - 排序契约:(activityTypeCode ASC, attendanceRoleCode ASC, durationThreshold ASC 辅助, createdAt ASC)
//   durationThreshold NULL 顺位由 PG 默认行为决定,不作硬契约(D6 v1.1 §4.4 修订)
// - dailyCap 落库保持 null(B5);attendance 预填走 DEFAULT_DAILY_CAP=1.5 兜底(本模块不动)

const DICT_TYPE_ACTIVITY_TYPE = 'activity_type';
const DICT_TYPE_ATTENDANCE_ROLE = 'attendance_role';

type PrismaTx = Prisma.TransactionClient;

@Injectable()
export class ContributionRulesService {
  constructor(private readonly prisma: PrismaService) {}

  // ============ helpers ============

  private decimalToNumber(d: Prisma.Decimal | null): number | null {
    return d === null ? null : Number(d);
  }

  private toResponseDto(row: SafeContributionRule): ContributionRuleResponseDto {
    return {
      id: row.id,
      activityTypeCode: row.activityTypeCode,
      attendanceRoleCode: row.attendanceRoleCode,
      durationThreshold: this.decimalToNumber(row.durationThreshold),
      pointsBelow: Number(row.pointsBelow),
      pointsAbove: this.decimalToNumber(row.pointsAbove),
      dailyCap: this.decimalToNumber(row.dailyCap),
      status: row.status,
      remark: row.remark,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      createdByUserId: row.createdByUserId,
      updatedByUserId: row.updatedByUserId,
    };
  }

  private async assertDictItemValid(
    typeCode: string,
    code: string,
    biz: BizCodeEntry,
    tx?: PrismaTx,
  ): Promise<void> {
    const client = tx ?? this.prisma;
    const item = await client.dictItem.findFirst({
      where: {
        code,
        status: DictItemStatus.ACTIVE,
        deletedAt: null,
        type: {
          code: typeCode,
          status: DictTypeStatus.ACTIVE,
          deletedAt: null,
        },
      },
      select: { id: true },
    });
    if (!item) throw new BizException(biz);
  }

  // 字段语义校验(B4):pointsAbove != null 时,要求 durationThreshold != null 且 > pointsBelow。
  // 复用 create / update;不修改 dto。
  private assertPointsCombinationValid(args: {
    durationThreshold: number | null;
    pointsBelow: number;
    pointsAbove: number | null;
  }): void {
    if (args.pointsAbove === null) return;
    if (args.durationThreshold === null) {
      throw new BizException(BizCode.CONTRIBUTION_RULE_POINTS_INVALID);
    }
    if (args.pointsAbove <= args.pointsBelow) {
      throw new BizException(BizCode.CONTRIBUTION_RULE_POINTS_INVALID);
    }
  }

  // ACTIVE 唯一性 service 兜底(B2):同 (activityTypeCode, attendanceRoleCode,
  // durationThreshold) 在 deletedAt IS NULL AND status='ACTIVE' 范围最多 1 条;
  // 含 durationThreshold = NULL 维度(PG partial unique 在 NULL 行为下不阻止多条 ACTIVE)。
  // excludeId 用于 update 路径排除自身。
  private async assertActiveUnique(
    args: {
      activityTypeCode: string;
      attendanceRoleCode: string;
      durationThreshold: number | null;
      excludeId?: string;
    },
    tx: PrismaTx,
  ): Promise<void> {
    const where: Prisma.ContributionRuleWhereInput = {
      activityTypeCode: args.activityTypeCode,
      attendanceRoleCode: args.attendanceRoleCode,
      durationThreshold: args.durationThreshold,
      status: ContributionRuleStatus.ACTIVE,
      deletedAt: null,
    };
    if (args.excludeId !== undefined) {
      where.NOT = { id: args.excludeId };
    }
    const count = await tx.contributionRule.count({ where });
    if (count >= 1) {
      throw new BizException(BizCode.CONTRIBUTION_RULE_ACTIVE_DUPLICATE);
    }
  }

  // ============ list ============

  async list(query: ContributionRuleQueryDto): Promise<PageResultDto<ContributionRuleResponseDto>> {
    const { page, pageSize, activityTypeCode, attendanceRoleCode, status } = query;
    const filters: Prisma.ContributionRuleWhereInput = {};
    if (activityTypeCode !== undefined) filters.activityTypeCode = activityTypeCode;
    if (attendanceRoleCode !== undefined) filters.attendanceRoleCode = attendanceRoleCode;
    if (status !== undefined) filters.status = status;
    const where = notDeletedWhere(filters);

    // 排序契约(D6 v1.1 §4.4):activityTypeCode / attendanceRoleCode / createdAt 是
    // 契约保证;durationThreshold 是辅助排序,NULL 顺位由 PG 默认行为决定,不作硬契约。
    const orderBy: Prisma.ContributionRuleOrderByWithRelationInput[] = [
      { activityTypeCode: 'asc' },
      { attendanceRoleCode: 'asc' },
      { durationThreshold: 'asc' },
      { createdAt: 'asc' },
    ];

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.contributionRule.findMany({
        where,
        select: contributionRuleSafeSelect,
        orderBy,
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.contributionRule.count({ where }),
    ]);

    return {
      items: rows.map((r) => this.toResponseDto(r)),
      total,
      page,
      pageSize,
    };
  }

  // ============ findOne ============

  async findOne(id: string): Promise<ContributionRuleResponseDto> {
    const row = await this.prisma.contributionRule.findFirst({
      where: notDeletedWhere({ id }),
      select: contributionRuleSafeSelect,
    });
    if (!row) throw new BizException(BizCode.CONTRIBUTION_RULE_NOT_FOUND);
    return this.toResponseDto(row);
  }

  // ============ create ============

  async create(
    dto: CreateContributionRuleDto,
    currentUser: CurrentUserPayload,
  ): Promise<ContributionRuleResponseDto> {
    const normalizedStatus = dto.status ?? ContributionRuleStatus.ACTIVE;
    const durationThreshold = dto.durationThreshold ?? null;
    const pointsAbove = dto.pointsAbove ?? null;
    const dailyCap = dto.dailyCap ?? null;

    this.assertPointsCombinationValid({
      durationThreshold,
      pointsBelow: dto.pointsBelow,
      pointsAbove,
    });

    return this.prisma.$transaction(async (tx) => {
      await this.assertDictItemValid(
        DICT_TYPE_ACTIVITY_TYPE,
        dto.activityTypeCode,
        BizCode.CONTRIBUTION_RULE_ACTIVITY_TYPE_INVALID,
        tx,
      );
      await this.assertDictItemValid(
        DICT_TYPE_ATTENDANCE_ROLE,
        dto.attendanceRoleCode,
        BizCode.CONTRIBUTION_RULE_ROLE_CODE_INVALID,
        tx,
      );

      if (normalizedStatus === ContributionRuleStatus.ACTIVE) {
        await this.assertActiveUnique(
          {
            activityTypeCode: dto.activityTypeCode,
            attendanceRoleCode: dto.attendanceRoleCode,
            durationThreshold,
          },
          tx,
        );
      }

      const data: Prisma.ContributionRuleUncheckedCreateInput = {
        activityTypeCode: dto.activityTypeCode,
        attendanceRoleCode: dto.attendanceRoleCode,
        durationThreshold,
        pointsBelow: dto.pointsBelow,
        pointsAbove,
        dailyCap,
        status: normalizedStatus,
        remark: dto.remark ?? null,
        createdByUserId: currentUser.id,
      };

      let created: SafeContributionRule;
      try {
        created = await tx.contributionRule.create({
          data,
          select: contributionRuleSafeSelect,
        });
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          // M3:partial unique 并发兜底 → 转 23002。Prisma 6.x P2002 meta.target 不可靠
          // (沿 member-departments / member-profiles 范式),直接抛 ACTIVE_DUPLICATE。
          throw new BizException(BizCode.CONTRIBUTION_RULE_ACTIVE_DUPLICATE);
        }
        throw err;
      }

      auditPlaceholder('contribution-rule.create', {
        actorUserId: currentUser.id,
        ruleId: created.id,
        activityTypeCode: created.activityTypeCode,
        attendanceRoleCode: created.attendanceRoleCode,
        durationThreshold: this.decimalToNumber(created.durationThreshold),
        status: created.status,
      });

      return this.toResponseDto(created);
    });
  }

  // ============ update ============

  async update(
    id: string,
    dto: UpdateContributionRuleDto,
    currentUser: CurrentUserPayload,
  ): Promise<ContributionRuleResponseDto> {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.contributionRule.findFirst({
        where: notDeletedWhere({ id }),
        select: contributionRuleSafeSelect,
      });
      if (!existing) throw new BizException(BizCode.CONTRIBUTION_RULE_NOT_FOUND);

      // 字段语义校验(B4):用合并后的字段做"如果生效会怎样"的判断。
      const mergedDurationThreshold = this.decimalToNumber(existing.durationThreshold);
      const mergedPointsBelow =
        dto.pointsBelow !== undefined ? dto.pointsBelow : Number(existing.pointsBelow);
      const mergedPointsAbove =
        dto.pointsAbove === undefined
          ? this.decimalToNumber(existing.pointsAbove)
          : dto.pointsAbove;
      this.assertPointsCombinationValid({
        durationThreshold: mergedDurationThreshold,
        pointsBelow: mergedPointsBelow,
        pointsAbove: mergedPointsAbove,
      });

      // ACTIVE 唯一性兜底(B2):仅当"更新后状态为 ACTIVE"才查重。
      const nextStatus = dto.status !== undefined ? dto.status : existing.status;
      if (nextStatus === ContributionRuleStatus.ACTIVE) {
        await this.assertActiveUnique(
          {
            activityTypeCode: existing.activityTypeCode,
            attendanceRoleCode: existing.attendanceRoleCode,
            durationThreshold: this.decimalToNumber(existing.durationThreshold),
            excludeId: id,
          },
          tx,
        );
      }

      // 使用 Unchecked 输入,允许直接写标量 updatedByUserId(避免 checked input 要求 relation form)。
      const data: Prisma.ContributionRuleUncheckedUpdateInput = {
        updatedByUserId: currentUser.id,
      };
      if (dto.pointsBelow !== undefined) data.pointsBelow = dto.pointsBelow;
      if (dto.pointsAbove !== undefined) data.pointsAbove = dto.pointsAbove;
      if (dto.dailyCap !== undefined) data.dailyCap = dto.dailyCap;
      if (dto.status !== undefined) data.status = dto.status;
      if (dto.remark !== undefined) data.remark = dto.remark;

      let updated: SafeContributionRule;
      try {
        updated = await tx.contributionRule.update({
          where: { id },
          data,
          select: contributionRuleSafeSelect,
        });
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          throw new BizException(BizCode.CONTRIBUTION_RULE_ACTIVE_DUPLICATE);
        }
        throw err;
      }

      auditPlaceholder('contribution-rule.update', {
        actorUserId: currentUser.id,
        ruleId: updated.id,
        changedFields: Object.keys(dto),
      });

      return this.toResponseDto(updated);
    });
  }

  // ============ softDelete ============

  async softDelete(id: string, currentUser: CurrentUserPayload): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const existing = await tx.contributionRule.findFirst({
        where: notDeletedWhere({ id }),
        select: { id: true },
      });
      if (!existing) throw new BizException(BizCode.CONTRIBUTION_RULE_NOT_FOUND);

      // E5:schema 已在 batch 4-A 包含 deletedByUserId(prisma/schema.prisma:673);
      // 写 deletedAt + deletedByUserId;status 不强制改 INACTIVE。
      // 注意:AttendanceRecord 软删字段集与 ContributionRule 不同,5-A 不复用 / 不混淆。
      await tx.contributionRule.update({
        where: { id },
        data: {
          deletedAt: new Date(),
          deletedByUserId: currentUser.id,
        },
      });

      auditPlaceholder('contribution-rule.delete', {
        actorUserId: currentUser.id,
        ruleId: id,
      });
    });
  }
}
