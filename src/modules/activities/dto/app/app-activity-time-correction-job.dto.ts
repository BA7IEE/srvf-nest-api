import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { AppActivityTimeCorrectionParamsDto } from './app-activity-time-correction.dto';

export class AppActivityTimeCorrectionJobParamsDto extends AppActivityTimeCorrectionParamsDto {
  @ApiProperty({ minLength: 8, maxLength: 64 })
  @IsString()
  @MinLength(8)
  @MaxLength(64)
  jobId!: string;
}

/** A whole correction is one publication unit. No provisional facts or internal
 * actor/source hashes, lease identifiers or error details leave this surface. */
export class AppActivityTimeCorrectionJobDto {
  @ApiProperty() jobId!: string;
  @ApiProperty() correctionApplicationId!: string;
  @ApiProperty() postingBatchId!: string;
  @ApiProperty({ enum: ['queued', 'executing', 'verifying', 'failed', 'applied'] })
  stage!: 'queued' | 'executing' | 'verifying' | 'failed' | 'applied';
  @ApiProperty({ description: '仅权威业务结果已提交时为 true' }) applied!: boolean;
  @ApiProperty({ enum: [0, 1], description: '整次更正统一发布；提交前始终为 0' })
  completedUnits!: number;
  @ApiProperty({ enum: [1] }) totalUnits!: number;
  @ApiProperty({ description: '本次更正增量段数，不表示已生效进度' }) segmentCount!: number;
  @ApiProperty({ description: '受保护的执行／恢复围栏轮次，不表示业务提交次数' }) attempt!: number;
  @ApiProperty({ description: '仅已独立确认未生效且旧 worker 已失效时允许人工重试' })
  retryAllowed!: boolean;
}
