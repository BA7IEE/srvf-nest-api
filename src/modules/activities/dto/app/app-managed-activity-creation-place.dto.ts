import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsDefined,
  IsIn,
  IsInt,
  IsNumber,
  IsObject,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { OmittableOnly } from '../../../../common/decorators/omittable-only.decorator';
import { PLACE_COORDINATE_SYSTEM_CODES } from '../../activity-place-coordinate-projection';

export const CREATION_PLACE_ROLES = [
  'primary',
  'meeting',
  'execution',
  'evacuation',
  'parking',
  'other',
] as const;
export const CREATION_PLACE_VISIBILITIES = ['public', 'accepted', 'staff', 'command'] as const;

export class AppCreationPlaceCoordinateDto {
  @ApiProperty({ description: '所声明坐标系中的经度', minimum: -180, maximum: 180 })
  @IsNumber({ maxDecimalPlaces: 7 })
  @Min(-180)
  @Max(180)
  longitude!: number;

  @ApiProperty({ description: '所声明坐标系中的纬度', minimum: -90, maximum: 90 })
  @IsNumber({ maxDecimalPlaces: 7 })
  @Min(-90)
  @Max(90)
  latitude!: number;

  @ApiProperty({
    description: '坐标系；兼容列仅接受 B2 安全投影',
    enum: PLACE_COORDINATE_SYSTEM_CODES,
  })
  @IsIn(PLACE_COORDINATE_SYSTEM_CODES)
  coordinateSystemCode!: (typeof PLACE_COORDINATE_SYSTEM_CODES)[number];
}

export class AppInlineCreationPlaceDto {
  @ApiProperty({ description: '地点名称', minLength: 1, maxLength: 200 })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;

  @ApiProperty({ description: '地点文字；用于对应旧地点字段', minLength: 1, maxLength: 200 })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  addressText!: string;

  @ApiPropertyOptional({ description: '地点说明', maxLength: 2000 })
  @OmittableOnly()
  @IsString()
  @MaxLength(2000)
  instruction?: string;

  @ApiPropertyOptional({
    description: '完整坐标；省略表示纯文字地点',
    type: () => AppCreationPlaceCoordinateDto,
  })
  @OmittableOnly()
  @IsObject()
  @ValidateNested()
  @Type(() => AppCreationPlaceCoordinateDto)
  coordinate?: AppCreationPlaceCoordinateDto;

  @ApiPropertyOptional({ description: '地图来源标识，不据此推断坐标系', maxLength: 64 })
  @OmittableOnly()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  providerCode?: string;

  @ApiPropertyOptional({ description: '地图来源内部地点标识', maxLength: 200 })
  @OmittableOnly()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  providerPlaceId?: string;

  @ApiProperty({ description: '是否为签到候选地点；不自动启用签到策略' })
  @IsBoolean()
  checkInEligible!: boolean;

  @ApiPropertyOptional({ description: '签到候选半径，单位米', minimum: 1, maximum: 10000 })
  @OmittableOnly()
  @IsInt()
  @Min(1)
  @Max(10000)
  radiusMeters?: number;
}

/** Preset and inline are mutually exclusive; service validates exactly one before any writes. */
export class AppActivityCreationPlaceDto {
  @ApiPropertyOptional({
    description: '场次 code；省略表示活动级地点',
    minLength: 1,
    maxLength: 64,
  })
  @OmittableOnly()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  sessionCode?: string;

  @ApiProperty({
    description: '地点用途，同一 scope 必须恰有一个 primary',
    enum: CREATION_PLACE_ROLES,
  })
  @IsIn(CREATION_PLACE_ROLES)
  roleCode!: (typeof CREATION_PLACE_ROLES)[number];

  @ApiProperty({
    description: '明确的地点可见性，不继承活动可见性',
    enum: CREATION_PLACE_VISIBILITIES,
  })
  @IsIn(CREATION_PLACE_VISIBILITIES)
  visibilityCode!: (typeof CREATION_PLACE_VISIBILITIES)[number];

  @ApiPropertyOptional({
    description: '精确预设 ID；与 inline 互斥，完整锁读复制，不允许覆盖',
    minLength: 8,
    maxLength: 64,
  })
  @OmittableOnly()
  @IsString()
  @MinLength(8)
  @MaxLength(64)
  presetId?: string;

  @ApiPropertyOptional({
    description: '内联地点；与 presetId 互斥，sourcePresetId 恒为空',
    type: () => AppInlineCreationPlaceDto,
  })
  @OmittableOnly()
  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => AppInlineCreationPlaceDto)
  inline?: AppInlineCreationPlaceDto;
}
