import { ApiExtraModels, ApiProperty, getSchemaPath } from '@nestjs/swagger';

export class AppActivityEndingConfirmedSummaryDto {
  @ApiProperty({ description: '现行正式成果 ID' })
  id!: string;
  @ApiProperty({ description: '正式成果修订', minimum: 1 })
  revision!: number;
  @ApiProperty({ description: '正式成果自身采用的历史指标集版本 ID' })
  metricSetVersionId!: string;
  @ApiProperty({ description: '既有正式确认时间', format: 'date-time' })
  confirmedAt!: string;
  @ApiProperty({ description: '正式指标值数量', minimum: 1, maximum: 100 })
  valueCount!: number;
}

export class AppActivityEndingDraftSummaryDto {
  @ApiProperty({ description: '有效草稿 ID' })
  id!: string;
  @ApiProperty({ description: '草稿修订', minimum: 1 })
  revision!: number;
  @ApiProperty({ description: '初次草稿或正式更正草稿', enum: ['initial', 'correction'] })
  kind!: 'initial' | 'correction';
  @ApiProperty({
    description: '更正基于的现行正式修订，初次草稿为 null',
    type: Number,
    nullable: true,
  })
  baseConfirmedRevision!: number | null;
}

export class AppActivityEndingNoticeDto {
  @ApiProperty({
    description: '事实提示，不构成业务阻断或操作授权',
    enum: [
      'metric_selection_unconfigured',
      'formal_outcome_missing',
      'initial_draft_pending',
      'correction_pending',
    ],
  })
  code!:
    | 'metric_selection_unconfigured'
    | 'formal_outcome_missing'
    | 'initial_draft_pending'
    | 'correction_pending';
  @ApiProperty({
    description: '既有功能标识，进入后仍须独立判权',
    enum: ['metric_selection', 'outcome_history'],
  })
  target!: 'metric_selection' | 'outcome_history';
}

@ApiExtraModels(AppActivityEndingConfirmedSummaryDto, AppActivityEndingDraftSummaryDto)
export class AppActivityEndingWorkbenchDto {
  @ApiProperty({ description: '活动 ID' })
  activityId!: string;
  @ApiProperty({
    description: '既有活动状态',
    enum: ['draft', 'published', 'completed', 'cancelled', 'terminated', 'archived'],
  })
  activityStatusCode!: string;
  @ApiProperty({
    description: '当前指标选择状态',
    enum: ['unconfigured', 'not_required', 'required'],
  })
  metricRequirementCode!: 'unconfigured' | 'not_required' | 'required';
  @ApiProperty({ description: '当前指标选择修订', minimum: 0 })
  metricSelectionRevision!: number;
  @ApiProperty({ description: '当前选择的指标集版本 ID', type: String, nullable: true })
  selectedMetricSetVersionId!: string | null;
  @ApiProperty({
    description: '现行唯一正式成果摘要，无正式成果为 null',
    oneOf: [
      { $ref: getSchemaPath(AppActivityEndingConfirmedSummaryDto) },
      { type: 'object', nullable: true, enum: [null] },
    ],
    nullable: true,
  })
  currentConfirmed!: AppActivityEndingConfirmedSummaryDto | null;
  @ApiProperty({
    description: '当前有效草稿，取消或非 draft 为 null',
    oneOf: [
      { $ref: getSchemaPath(AppActivityEndingDraftSummaryDto) },
      { type: 'object', nullable: true, enum: [null] },
    ],
    nullable: true,
  })
  pendingDraft!: AppActivityEndingDraftSummaryDto | null;
  @ApiProperty({
    description: '固定顺序事实提示，不表示操作可用',
    type: [AppActivityEndingNoticeDto],
    maxItems: 3,
  })
  notices!: AppActivityEndingNoticeDto[];
}
