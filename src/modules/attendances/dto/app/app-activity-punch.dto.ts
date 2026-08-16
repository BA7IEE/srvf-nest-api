import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNumber, IsString, Length, Max, Min } from 'class-validator';

import { OmittableOnly } from '../../../../common/decorators/omittable-only.decorator';

export class AppActivityPunchParamsDto {
  @ApiProperty({ minLength: 8, maxLength: 64, description: '活动 ID' })
  @IsString()
  @Length(8, 64)
  activityId!: string;

  @ApiProperty({ minLength: 8, maxLength: 64, description: '场次 ID' })
  @IsString()
  @Length(8, 64)
  sessionId!: string;
}

export class AppActivityPunchDto {
  @ApiProperty({ minLength: 1, maxLength: 4096, description: '从受保护二维码读取的完整扫码 token' })
  @IsString()
  @Length(1, 4096)
  qrToken!: string;

  @ApiProperty({ minLength: 1, maxLength: 128, description: '客户端生成的全局打卡防重键' })
  @IsString()
  @Length(1, 128)
  eventKey!: string;

  @ApiPropertyOptional({ minimum: -180, maximum: 180, description: 'WGS84 经度，按策略可选' })
  @OmittableOnly()
  @IsNumber({ maxDecimalPlaces: 7, allowNaN: false, allowInfinity: false })
  @Min(-180)
  @Max(180)
  longitude?: number;

  @ApiPropertyOptional({ minimum: -90, maximum: 90, description: 'WGS84 纬度，按策略可选' })
  @OmittableOnly()
  @IsNumber({ maxDecimalPlaces: 7, allowNaN: false, allowInfinity: false })
  @Min(-90)
  @Max(90)
  latitude?: number;

  @ApiPropertyOptional({ minimum: 0, maximum: 99_999_999.99, description: '定位精度(米)' })
  @OmittableOnly()
  @IsNumber({ maxDecimalPlaces: 2, allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(99_999_999.99)
  accuracy?: number;
}

export class AppActivityPunchReceiptDto {
  @ApiProperty({ description: '不可变现场事件 ID' })
  eventId!: string;

  @ApiProperty({ enum: ['check_in', 'check_out', 'early_departure_close', 'void', 'replace'] })
  eventTypeCode!: string;

  @ApiProperty({ type: Date, format: 'date-time', description: '服务端权威发生时间' })
  occurredAt!: Date;

  @ApiProperty({ enum: ['open', 'closed_valid', 'closed_zero'] })
  segmentStatusCode!: 'open' | 'closed_valid' | 'closed_zero';

  @ApiProperty({ type: Date, format: 'date-time', description: '本次响应的服务端时间' })
  serverTime!: Date;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    description: '安全距离(米，Decimal 字符串)',
  })
  distanceMeters!: string | null;

  @ApiProperty({ description: '本次是否完成位置核验' })
  geoVerified!: boolean;

  @ApiProperty({ description: '定位精度为空或超过警戒值时为 true' })
  lowAccuracy!: boolean;

  @ApiProperty({ enum: ['check_in', 'check_out'] })
  nextAllowedAction!: 'check_in' | 'check_out';
}

export class AppActivityPunchStateDto {
  @ApiProperty({ description: '当前是否存在开放服务段' })
  isPresent!: boolean;

  @ApiPropertyOptional({ nullable: true, type: Date, format: 'date-time' })
  checkInAt!: Date | null;

  @ApiPropertyOptional({ nullable: true, type: Date, format: 'date-time' })
  checkOutAllowedAt!: Date | null;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    description: '安全距离(米，Decimal 字符串)',
  })
  distanceMeters!: string | null;

  @ApiProperty()
  geoVerified!: boolean;

  @ApiProperty()
  lowAccuracy!: boolean;

  @ApiProperty({ type: Date, format: 'date-time' })
  serverTime!: Date;

  @ApiProperty({ enum: ['check_in', 'check_out'] })
  nextAllowedAction!: 'check_in' | 'check_out';
}
