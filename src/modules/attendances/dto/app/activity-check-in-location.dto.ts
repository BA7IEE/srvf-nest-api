import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNumber, IsOptional, IsString, Length, Max, Min } from 'class-validator';

export class AppActivityCheckInActivityIdParamDto {
  @ApiProperty({
    description: '活动 Activity.id',
    minLength: 8,
    maxLength: 64,
  })
  @IsString()
  @Length(8, 64)
  activityId!: string;
}

// 原始坐标只允许进入 evidence 表；刻意不在 OpenAPI 添加固定坐标 example。
export class ActivityCheckInLocationDto {
  @ApiProperty({
    description: '当前位置经度(WGS84 十进制度数；最多 7 位小数)',
    minimum: -180,
    maximum: 180,
  })
  @IsNumber({ maxDecimalPlaces: 7, allowNaN: false, allowInfinity: false })
  @Min(-180)
  @Max(180)
  longitude!: number;

  @ApiProperty({
    description: '当前位置纬度(WGS84 十进制度数；最多 7 位小数)',
    minimum: -90,
    maximum: 90,
  })
  @IsNumber({ maxDecimalPlaces: 7, allowNaN: false, allowInfinity: false })
  @Min(-90)
  @Max(90)
  latitude!: number;

  @ApiPropertyOptional({
    description: '定位精度(米；仅作证据，不参与 geofence 半径缩放；最多 2 位小数)',
    minimum: 0,
    maximum: 99_999_999.99,
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2, allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(99_999_999.99)
  accuracy?: number;
}
