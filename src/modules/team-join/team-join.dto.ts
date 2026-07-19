import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Max,
  Min,
  MinLength,
} from 'class-validator';

import { PaginationQueryDto } from '../../common/dto/pagination.dto';
import {
  ALL_GATE_CODES,
  TEAM_JOIN_DEFAULT_MAX_TARGET_ORGS,
  TEAM_JOIN_MAX_TARGET_ORGS,
} from './team-join.constants';

// 招新三期(入队)T2(2026-06-19):team-join DTO 集合(评审稿 §3.2)。
// admin 面 = 入队轮 CRUD + 报名 list/detail + 标 gate + 综合评估;app 自助面 DTO 在 T3 追加。

const NAME_MAX = 100;
const NOTE_MAX = 500;
const CODE_MAX = 64;
const OPEN_ORGANIZATION_IDS_MAX = 64;

// 入队申请列表 query(分页 + 可选 cycleId / statusCode 过滤;白名单进 DTO,
// 否则全局 forbidNonWhitelisted 拒额外 query 参数)
export class ListTeamJoinApplicationsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: '按入队轮过滤' })
  @IsOptional()
  @IsString()
  @MaxLength(CODE_MAX)
  cycleId?: string;

  @ApiPropertyOptional({
    description: '按状态过滤(joining/pending_evaluation/approved/joined/rejected)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  statusCode?: string;
}

// ============ admin 入队轮 ============

export class CreateTeamJoinCycleDto {
  @ApiProperty({ description: '入队年份(贡献值 cutoff = {year}-03-31 北京日界)' })
  @IsInt()
  @Min(2000)
  year!: number;

  @ApiProperty({ description: '轮次名(如「2026 年度入队」)' })
  @IsString()
  @MinLength(1)
  @MaxLength(NAME_MAX)
  name!: string;

  @ApiPropertyOptional({
    default: false,
    description: '本轮 final join 是否要求保险(single enforcement gate 开启后生效)',
  })
  @IsOptional()
  @IsBoolean()
  requiresInsurance?: boolean;

  @ApiPropertyOptional({
    type: [String],
    nullable: true,
    maxItems: OPEN_ORGANIZATION_IDS_MAX,
    description: '本轮开放候选部门 orgId 清单(最多 64 项;null/空=全部 ACTIVE 部门)',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(OPEN_ORGANIZATION_IDS_MAX)
  @IsString({ each: true })
  @MaxLength(CODE_MAX, { each: true })
  openOrganizationIds?: string[] | null;

  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    minimum: 1,
    maximum: TEAM_JOIN_MAX_TARGET_ORGS,
    description: `本轮候选部门数上限(null=默认 ${TEAM_JOIN_DEFAULT_MAX_TARGET_ORGS})`,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(TEAM_JOIN_MAX_TARGET_ORGS)
  maxTargetOrgs?: number | null;
}

export class UpdateTeamJoinCycleDto {
  @ApiPropertyOptional({ description: '状态(open / closed;开新 open 轮要求当前无其它 open 轮)' })
  @IsOptional()
  @IsString()
  @MaxLength(16)
  statusCode?: string;

  @ApiPropertyOptional({ description: '轮次名' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(NAME_MAX)
  name?: string;

  @ApiPropertyOptional({
    description: '本轮 final join 是否要求保险(single enforcement gate 开启后生效)',
  })
  @IsOptional()
  @IsBoolean()
  requiresInsurance?: boolean;

  @ApiPropertyOptional({
    type: [String],
    nullable: true,
    maxItems: OPEN_ORGANIZATION_IDS_MAX,
    description: '本轮开放候选部门 orgId 清单(最多 64 项;null/空=全部 ACTIVE 部门)',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(OPEN_ORGANIZATION_IDS_MAX)
  @IsString({ each: true })
  @MaxLength(CODE_MAX, { each: true })
  openOrganizationIds?: string[] | null;

  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    minimum: 1,
    maximum: TEAM_JOIN_MAX_TARGET_ORGS,
    description: `本轮候选部门数上限(null=默认 ${TEAM_JOIN_DEFAULT_MAX_TARGET_ORGS})`,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(TEAM_JOIN_MAX_TARGET_ORGS)
  maxTargetOrgs?: number | null;
}

export class TeamJoinCycleResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() year!: number;
  @ApiProperty() name!: string;
  @ApiProperty() statusCode!: string;
  @ApiProperty() requiresInsurance!: boolean;
  @ApiPropertyOptional({ nullable: true }) openedAt!: Date | null;
  @ApiPropertyOptional({ nullable: true }) closedAt!: Date | null;
  @ApiPropertyOptional({ type: [String], nullable: true }) openOrganizationIds!: string[] | null;
  @ApiPropertyOptional({ type: Number, nullable: true }) maxTargetOrgs!: number | null;
  @ApiProperty() createdAt!: Date;
}

// ============ admin 标 gate(评审稿 §4.1/§4.2;幂等;仅 joining/pending_evaluation 态)============

export class MarkGateDto {
  @ApiProperty({
    description: 'gate code(8 通用 + 4 专业队)',
    enum: ALL_GATE_CODES as unknown as string[],
  })
  @IsString()
  @IsIn(ALL_GATE_CODES, { message: 'gate code 非法' })
  gateCode!: string;

  @ApiProperty({ description: 'true=通过;false=未通过(记录失败,不满足)' })
  @IsBoolean()
  passed!: boolean;

  @ApiProperty({ description: '实际完成日(ISO;算有效期)' })
  @IsDateString()
  completionDate!: string;

  @ApiPropertyOptional({
    description: '延长期(ISO;仅 dept-assessment 可设;超本轮仍认。非可延 gate 传则忽略)',
  })
  @IsOptional()
  @IsDateString()
  extendedUntil?: string;
}

// ============ admin 综合评估 / 淘汰(单一人工闸;评审稿 §4.5)============

export class EvaluateTeamJoinApplicationDto {
  @ApiProperty({
    description:
      'true=综合评估通过(pending_evaluation→approved 待入队);false=不通过/淘汰(→rejected;joining 态 false=门槛超期人工淘汰)',
  })
  @IsBoolean()
  approved!: boolean;

  @ApiPropertyOptional({ description: '综合评估备注' })
  @IsOptional()
  @IsString()
  @MaxLength(NOTE_MAX)
  note?: string;

  @ApiPropertyOptional({
    description: '综合评估延长期(ISO;自本版起 approved 资格不随轮关闭失效,该字段仅存档)',
  })
  @IsOptional()
  @IsDateString()
  evaluationExtendedUntil?: string;
}

// ============ admin 一键入队(T4;志愿者 → 队员;评审稿 §4.5)============

export class JoinTeamJoinApplicationDto {
  @ApiProperty({
    description:
      '最终选定目标部门 orgId(须在候选 targetOrganizationIds 中且 ACTIVE;若为专业队则对应 team-* gate 须已过)',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  organizationId!: string;
}

// ============ admin 报名出参 ============

// 单个 gate 实况(service 派生:是否标记 / 通过 / 在有效期内满足)
export class GateStatusDto {
  @ApiProperty() code!: string;
  @ApiProperty({ description: '是否专业队 gate(条件性,不计入通用 8 自动推进)' })
  professional!: boolean;
  @ApiProperty({ description: '是否已标记' }) marked!: boolean;
  @ApiPropertyOptional({ nullable: true }) passed!: boolean | null;
  @ApiProperty({ description: '是否满足(passed + 在有效期内)' }) satisfied!: boolean;
  @ApiPropertyOptional({ nullable: true }) completionDate!: string | null;
  @ApiPropertyOptional({ nullable: true }) extendedUntil!: string | null;
}

export class TeamJoinApplicationAdminDto {
  @ApiProperty() id!: string;
  @ApiProperty() cycleId!: string;
  @ApiProperty() memberId!: string;
  @ApiPropertyOptional({ description: '队员永久编号', nullable: true }) memberNo!: string | null;
  @ApiPropertyOptional({ description: '队员称呼', nullable: true }) memberDisplayName!:
    | string
    | null;
  @ApiProperty() statusCode!: string;
  @ApiProperty({ type: [String], description: '候选目标部门 orgId(可多)' })
  targetOrganizationIds!: string[];
  @ApiPropertyOptional({ description: '最终选定部门(一键入队时 admin 定;T4)', nullable: true })
  selectedOrganizationId!: string | null;
  @ApiProperty({ type: [GateStatusDto], description: '各 gate 实况(8 通用 + 4 专业队)' })
  gates!: GateStatusDto[];
  @ApiProperty({ description: '8 通用门槛是否全满足(contribution 另算)' })
  generalGatesSatisfied!: boolean;
  @ApiPropertyOptional({
    description: '贡献值汇总(approved sheet,截至入队年 3-31;仅详情计算,列表为 null)',
    nullable: true,
  })
  contributionPoints!: string | null;
  @ApiPropertyOptional({ description: '贡献值是否 ≥5(详情计算;列表为 null)', nullable: true })
  contributionSatisfied!: boolean | null;
  @ApiPropertyOptional({ nullable: true }) evaluationNote!: string | null;
  @ApiPropertyOptional({ nullable: true }) evaluatedAt!: Date | null;
  @ApiPropertyOptional({
    description: '综合评估延长期(自本版起 approved 资格不随轮关闭失效,该字段仅存档)',
    nullable: true,
  })
  evaluationExtendedUntil!: Date | null;
  @ApiPropertyOptional({ nullable: true }) eliminationStage!: string | null;
  @ApiPropertyOptional({ nullable: true }) joinedAt!: Date | null;
  @ApiProperty() createdAt!: Date;
}
