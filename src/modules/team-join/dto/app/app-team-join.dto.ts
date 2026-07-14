import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsString, MaxLength } from 'class-validator';

import {
  TEAM_JOIN_DEFAULT_MAX_TARGET_ORGS,
  TEAM_JOIN_MAX_TARGET_ORGS,
} from '../../team-join.constants';
import { GateStatusDto } from '../../team-join.dto';

// 招新三期(入队)T3(2026-06-19):App 自助面 DTO(评审稿 §3.2)。
// dto/app/ 隔离(沿 insurances 范式);self-scope,**永不返回 L3**;候选部门数组 ≥1。

const ORG_ID_MAX = 64;
// 候选目标部门入参(发起 / 改候选共用校验:≥1 且每个 orgId 字符串;存在+ACTIVE 由 service 校验)
class TargetOrganizationsInput {
  @ApiProperty({
    type: [String],
    minItems: 1,
    maxItems: TEAM_JOIN_MAX_TARGET_ORGS,
    description: `候选目标部门 orgId(1..${TEAM_JOIN_MAX_TARGET_ORGS};每个须存在且 ACTIVE、属于本轮开放清单,去重后数量不得超过轮有效上限)`,
  })
  @IsArray()
  @ArrayMinSize(1, { message: '至少选择一个目标部门' })
  @ArrayMaxSize(TEAM_JOIN_MAX_TARGET_ORGS)
  @IsString({ each: true })
  @MaxLength(ORG_ID_MAX, { each: true })
  targetOrganizationIds!: string[];
}

export class CreateAppTeamJoinApplicationDto extends TargetOrganizationsInput {}

export class UpdateAppTeamJoinTargetsDto extends TargetOrganizationsInput {}

// 自助进度出参(self;无 L3;gate 实况 + 实时贡献值)
export class AppTeamJoinApplicationDto {
  @ApiProperty() id!: string;
  @ApiProperty() cycleId!: string;
  @ApiProperty() cycleName!: string;
  @ApiProperty() cycleYear!: number;
  @ApiProperty({ description: 'joining/pending_evaluation/approved/joined/rejected' })
  statusCode!: string;
  @ApiProperty({ type: [String], description: '候选目标部门 orgId' })
  targetOrganizationIds!: string[];
  @ApiProperty({ type: [String], description: '本轮开放部门清单(空=全部 ACTIVE 部门)' })
  openOrganizationIds!: string[];
  @ApiProperty({
    minimum: 1,
    maximum: TEAM_JOIN_MAX_TARGET_ORGS,
    description: `本轮候选部门数有效上限(未配置时默认 ${TEAM_JOIN_DEFAULT_MAX_TARGET_ORGS};旧轮存值超过硬上限 ${TEAM_JOIN_MAX_TARGET_ORGS} 时按 ${TEAM_JOIN_MAX_TARGET_ORGS} 回显)`,
  })
  maxTargetOrgs!: number;
  @ApiPropertyOptional({ description: '最终选定部门(一键入队后)', nullable: true })
  selectedOrganizationId!: string | null;
  @ApiProperty({ type: [GateStatusDto], description: '各 gate 实况(8 通用 + 4 专业队)' })
  gates!: GateStatusDto[];
  @ApiProperty({ description: '8 通用门槛是否全满足(contribution 另算)' })
  generalGatesSatisfied!: boolean;
  @ApiProperty({ description: '贡献值汇总(approved sheet,截至入队年 3-31)' })
  contributionPoints!: string;
  @ApiProperty({ description: '贡献值是否 ≥5' })
  contributionSatisfied!: boolean;
  @ApiPropertyOptional({ description: '综合评估备注', nullable: true })
  evaluationNote!: string | null;
  @ApiPropertyOptional({ description: '淘汰环节(rejected 时)', nullable: true })
  eliminationStage!: string | null;
  @ApiProperty() createdAt!: Date;
}
