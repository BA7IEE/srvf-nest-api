import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
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

export class AdminSimplePlaceCoordinateDto {
  @ApiProperty({ description: '声明坐标系中的经度', minimum: -180, maximum: 180 })
  @IsNumber({ maxDecimalPlaces: 7 })
  @Min(-180)
  @Max(180)
  longitude!: number;
  @ApiProperty({ description: '声明坐标系中的纬度', minimum: -90, maximum: 90 })
  @IsNumber({ maxDecimalPlaces: 7 })
  @Min(-90)
  @Max(90)
  latitude!: number;
  @ApiProperty({ description: '明确坐标系，不自动转换', enum: ['wgs84', 'gcj02', 'bd09'] })
  @IsIn(['wgs84', 'gcj02', 'bd09'])
  coordinateSystemCode!: 'wgs84' | 'gcj02' | 'bd09';
}

export class AdminSimpleInlinePlaceDto {
  @ApiProperty({ description: '地点名称', minLength: 1, maxLength: 200 })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;
  @ApiProperty({ description: '地点文字，同步活动和唯一场次', minLength: 1, maxLength: 200 })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  addressText!: string;
  @ApiPropertyOptional({ description: '有界地点说明', maxLength: 2000 })
  @OmittableOnly()
  @IsString()
  @MaxLength(2000)
  instruction?: string;
  @ApiPropertyOptional({
    description: '明确坐标，省略为纯文字地点',
    type: () => AdminSimplePlaceCoordinateDto,
  })
  @OmittableOnly()
  @IsObject()
  @ValidateNested()
  @Type(() => AdminSimplePlaceCoordinateDto)
  coordinate?: AdminSimplePlaceCoordinateDto;
  @ApiPropertyOptional({ description: '地图来源标识', maxLength: 64 })
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
  @ApiProperty({ description: '签到候选地点，不自动启用定位策略' })
  @IsBoolean()
  checkInEligible!: boolean;
  @ApiPropertyOptional({ description: '签到候选半径（米）', minimum: 1, maximum: 10000 })
  @OmittableOnly()
  @IsInt()
  @Min(1)
  @Max(10000)
  radiusMeters?: number;
}

/** Only activity-scoped inputs. The same snapshots are applied to the sole session. */
export class AdminSimpleActivityPlaceDto {
  @ApiProperty({
    description: '地点用途；恰有一个 primary，每种用途至多一个',
    enum: ['primary', 'meeting', 'execution', 'evacuation', 'parking', 'other'],
  })
  @IsIn(['primary', 'meeting', 'execution', 'evacuation', 'parking', 'other'])
  roleCode!: 'primary' | 'meeting' | 'execution' | 'evacuation' | 'parking' | 'other';
  @ApiProperty({ description: '明确可见性', enum: ['public', 'accepted', 'staff', 'command'] })
  @IsIn(['public', 'accepted', 'staff', 'command'])
  visibilityCode!: 'public' | 'accepted' | 'staff' | 'command';
  @ApiPropertyOptional({
    description: '精确预设 ID，与 inline 恰选一个',
    minLength: 8,
    maxLength: 64,
  })
  @OmittableOnly()
  @IsString()
  @MinLength(8)
  @MaxLength(64)
  presetId?: string;
  @ApiPropertyOptional({
    description: '完整本地地点，与 presetId 恰选一个',
    type: () => AdminSimpleInlinePlaceDto,
  })
  @OmittableOnly()
  @IsObject()
  @ValidateNested()
  @Type(() => AdminSimpleInlinePlaceDto)
  inline?: AdminSimpleInlinePlaceDto;
}
