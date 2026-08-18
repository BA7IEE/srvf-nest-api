import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsString, Length } from 'class-validator';

import { OmittableOnly } from '../../../../common/decorators/omittable-only.decorator';
import { PaginationQueryDto } from '../../../../common/dto/pagination.dto';

/**
 * 合同 §6.13「后台任务」统一读面 + §9.9 界面口径的出入参。
 *
 * 🔴 §6.13 的判权基准是 `job.activityId` + **当前责任范围**,不是 job 创建人 ——
 *    所以本文件里**没有**任何「创建人可见」的入参:调用方无从声明「这是我建的」。
 *
 * 🔴 出参刻意**不含**下列内部列(§6.1 通用合同 + B6-2 既有口径):
 *    `payload`(内部 job 载荷,含 actor / 定位 / 文件摘要)、`requestHash`、`operationKey`、
 *    `leaseOwner`(worker 实例标识)、`leaseExpiresAt` / `availableAt`(内部调度时刻)、
 *    item 的 `payloadHash` / `resultReference` / `resourceId`。
 *    lease 与重试只以 §9.9 点名的**人话状态**呈现,不透出上述任何原始列。
 *
 * ⚠️ 一处**故意的例外**,写在这里以免被当成疏漏:`itemKey` 的取值形如
 *    `identity:<participationIdentityId>`,因此参与身份 ID 会随 itemKey 出网。
 *    这是 §9.9「失败项目分页」可被操作的唯一抓手(否则只知道「有 3 项失败」),
 *    且读者已持有该活动的责任范围、本就看得到这些参与人。它不属于
 *    token / 签名 / hash / 凭证 / 坐标 任何一类。
 */
export class ListAppMyActivityBatchJobsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    minLength: 8,
    maxLength: 64,
    description: '按活动过滤;超出当前责任范围的活动恒返回空页,不泄露该活动是否存在',
  })
  @OmittableOnly()
  @IsString()
  @Length(8, 64)
  activityId?: string;
}

export const APP_MY_ACTIVITY_BATCH_JOB_ITEM_STATUSES = [
  'pending',
  'succeeded',
  'failed',
  'skipped',
] as const;

export class ListAppMyActivityBatchJobItemsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    enum: APP_MY_ACTIVITY_BATCH_JOB_ITEM_STATUSES,
    description: '按逐项状态过滤;失败项分页即 status=failed',
  })
  @OmittableOnly()
  @IsString()
  @IsIn(APP_MY_ACTIVITY_BATCH_JOB_ITEM_STATUSES)
  status?: string;
}

export class AppMyActivityBatchJobParamsDto {
  @ApiProperty({ minLength: 8, maxLength: 64, description: '后台批任务 ID' })
  @IsString()
  @Length(8, 64)
  jobId!: string;
}

export class AppMyActivityBatchJobActivityDto {
  @ApiProperty({ description: '活动 ID' })
  id!: string;

  @ApiProperty({ description: '活动标题' })
  title!: string;

  @ApiProperty({ description: '活动状态' })
  statusCode!: string;
}

export class AppMyActivityBatchJobCreatorDto {
  @ApiProperty({ description: '创建人队员 ID' })
  memberId!: string;

  @ApiProperty({ description: '创建人编号' })
  memberNo!: string;

  @ApiProperty({ description: '创建人显示名' })
  displayName!: string;
}

export class AppMyActivityBatchJobListItemDto {
  @ApiProperty({ description: '后台批任务 ID' })
  jobId!: string;

  @ApiProperty({
    enum: [
      'settlement_prepare',
      'bulk_proxy',
      'import_preview',
      'import_execute',
      'export',
      'notification_expand',
      'reconciliation',
    ],
    description: '任务类型(§3.27 七值闭集)',
  })
  jobTypeCode!: string;

  @ApiProperty({ type: AppMyActivityBatchJobActivityDto })
  activity!: AppMyActivityBatchJobActivityDto;

  @ApiProperty({
    type: AppMyActivityBatchJobCreatorDto,
    nullable: true,
    description: '创建人;历史任务或系统入队的任务为 null',
  })
  createdBy!: AppMyActivityBatchJobCreatorDto | null;

  @ApiProperty({
    enum: ['pending', 'processing', 'succeeded', 'partial_failed', 'failed', 'cancelled', 'dead'],
    description: '任务状态(§3.27 七值闭集)',
  })
  statusCode!: string;

  @ApiProperty({ minimum: 0, description: '总数' })
  total!: number;

  @ApiProperty({ minimum: 0, description: '成功' })
  succeeded!: number;

  @ApiProperty({ minimum: 0, description: '失败' })
  failed!: number;

  @ApiProperty({ minimum: 0, description: '跳过' })
  skipped!: number;

  @ApiProperty({
    description: '§9.9 lease 人话状态;只描述占用与否,不透出 worker 实例标识与调度时刻',
  })
  leaseStateText!: string;

  @ApiProperty({ description: '§9.9 重试人话状态;不透出内部退避时刻' })
  retryStateText!: string;

  @ApiProperty({ description: '任务创建时间', format: 'date-time' })
  createdAt!: string;

  @ApiProperty({ nullable: true, description: '开始执行时间', format: 'date-time' })
  startedAt!: string | null;

  @ApiProperty({ nullable: true, description: '结束时间', format: 'date-time' })
  completedAt!: string | null;
}

export class AppMyActivityBatchJobDetailDto extends AppMyActivityBatchJobListItemDto {
  @ApiProperty({ description: '当前是否允许重试失败项(需仍在责任范围内且存在失败项)' })
  retryFailedAllowed!: boolean;

  @ApiProperty({ description: '当前是否允许取消(已完成 / 已提交 / 已取消的任务不可取消)' })
  cancelAllowed!: boolean;
}

export class AppMyActivityBatchJobItemDto {
  @ApiProperty({ description: '逐项 ID' })
  itemId!: string;

  @ApiProperty({ description: '逐项防重键' })
  itemKey!: string;

  @ApiProperty({ description: '逐项状态' })
  statusCode!: string;

  @ApiProperty({ minimum: 0, description: '已尝试次数' })
  attempts!: number;

  @ApiProperty({ nullable: true, description: '错误编码;不含堆栈与 SQL(§3.27)' })
  lastErrorCode!: string | null;

  @ApiProperty({ nullable: true, description: '已脱敏的可展示文案(§3.27)' })
  safeMessage!: string | null;
}
