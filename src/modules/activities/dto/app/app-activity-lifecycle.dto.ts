import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsString, MaxLength, MinLength } from 'class-validator';
import { OmittableOnly } from '../../../../common/decorators/omittable-only.decorator';

// App 生命周期命令 DTO 与 Admin cancel DTO 物理隔离。取消的 strongConfirmed 是
// App 高影响操作的显式确认，不改变既有 Admin cancel 的请求契约。
export class AppManagedActivityCancelCommandDto {
  @ApiProperty({ description: '取消原因', maxLength: 500 })
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason!: string;

  @ApiProperty({ description: '强确认；只能由服务层接受 true', example: true })
  @IsBoolean()
  strongConfirmed!: boolean;

  @ApiProperty({ description: '客户端幂等操作标识', minLength: 8, maxLength: 128 })
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  operationKey!: string;
}

export class AppManagedActivityTerminateCommandDto {
  @ApiProperty({ description: '提前终止原因', maxLength: 500 })
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason!: string;

  @ApiProperty({ description: '客户端幂等操作标识', minLength: 8, maxLength: 128 })
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  operationKey!: string;
}

// 归档 / 撤销归档命令(2026-08-25 拍板)。
//
// ⚠️ 刻意**没有** strongConfirmed:取消是不可逆的(报名、二维码、通知全线联动),归档是
// 可撤销的纯可见性动作 —— 给它加强确认会让「强确认」这个信号贬值(什么都要强确认 =
// 强确认什么都不代表)。operationKey 仍然要:归档会写状态,重复提交必须防重。
export class AppManagedActivityArchiveCommandDto {
  @ApiPropertyOptional({ description: '归档说明', maxLength: 500 })
  @OmittableOnly()
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason?: string;

  @ApiProperty({ description: '客户端幂等操作标识', minLength: 8, maxLength: 128 })
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  operationKey!: string;
}

export class AppManagedActivityUnarchiveCommandDto {
  @ApiPropertyOptional({ description: '撤销归档说明', maxLength: 500 })
  @OmittableOnly()
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason?: string;

  @ApiProperty({ description: '客户端幂等操作标识', minLength: 8, maxLength: 128 })
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  operationKey!: string;
}

export class AppActivityArchiveResultDto {
  @ApiProperty({ description: '活动主键' })
  activityId!: string;

  @ApiProperty({
    description: '动作完成后的活动状态。归档恒为 archived;撤销归档为归档前冻下来的来源状态',
    enum: ['archived', 'draft', 'published', 'completed', 'terminated'],
  })
  statusCode!: string;

  @ApiProperty({ description: '服务端生成的动作发生时间(ISO 8601)' })
  occurredAt!: Date;

  @ApiPropertyOptional({
    description: '归档走的是哪一套开工条件;撤销归档恒为 null',
    enum: ['stale_draft', 'settled'],
    nullable: true,
  })
  reasonCode!: 'stale_draft' | 'settled' | null;

  @ApiPropertyOptional({
    description: '归档前的活动状态。撤销归档后仍保留(留痕不清空)',
    nullable: true,
  })
  archivedFromStatusCode!: string | null;
}

// clone 刻意没有 operationKey：合同 §10.3 的幂等闭集不含 clone，且 Activity 没有
// 对应存储列；缺口 #15 仅登记，不伪造半套幂等语义。
export class AppManagedActivityCloneCommandDto {
  @ApiPropertyOptional({ description: '新草稿标题；未传时由服务端从源标题生成', maxLength: 200 })
  @OmittableOnly()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title?: string;

  @ApiPropertyOptional({
    description: '目标发起组织；未传时复用源活动组织',
    minLength: 8,
    maxLength: 64,
  })
  @OmittableOnly()
  @IsString()
  @MinLength(8)
  @MaxLength(64)
  organizationId?: string;
}

export class AppActivityLifecycleResultDto {
  @ApiProperty({ description: '活动主键' })
  activityId!: string;

  @ApiProperty({ enum: ['cancelled', 'terminated'] })
  statusCode!: 'cancelled' | 'terminated';

  @ApiProperty({ description: '服务端生成的生命周期发生时间(ISO 8601)' })
  occurredAt!: Date;

  @ApiPropertyOptional({ description: '原因', nullable: true })
  reason!: string | null;
}

export class AppManagedActivityCloneResultDto {
  @ApiProperty({ description: '新建 draft 活动主键' })
  activityId!: string;
}

export class AppEvidenceSealResultDto {
  @ApiProperty()
  sealId!: string;

  @ApiProperty()
  activityId!: string;

  @ApiProperty()
  sealRevision!: number;

  @ApiProperty()
  evidenceRevision!: number;

  @ApiProperty()
  populationRevision!: number;

  @ApiProperty()
  workflowRevision!: number;

  @ApiProperty()
  allWindowsClosedAt!: Date;

  @ApiProperty()
  openSegmentCount!: number;

  @ApiProperty()
  manualReviewPendingCount!: number;

  @ApiProperty()
  populationCountDistinct!: number;

  @ApiProperty({ type: 'object', additionalProperties: { type: 'number' } })
  populationCountBySession!: Record<string, number>;

  @ApiProperty()
  contentHash!: string;

  @ApiProperty()
  sealedAt!: Date;

  @ApiProperty()
  supersededSealCount!: number;
}
