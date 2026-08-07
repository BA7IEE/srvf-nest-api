import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { OmittableOnly } from '../../../../common/decorators/omittable-only.decorator';
import { PaginationQueryDto } from '../../../../common/dto/pagination.dto';

// App 内部活动目录；独立于旧 /available（后者仍只给公开报名、未结束活动）。
export class AppActivityDirectoryQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: '标题关键词', maxLength: 100 })
  @OmittableOnly()
  @IsString()
  @MaxLength(100)
  q?: string;

  @ApiPropertyOptional({ description: '活动类型 code', maxLength: 64 })
  @OmittableOnly()
  @IsString()
  @MaxLength(64)
  type?: string;

  @ApiPropertyOptional({ description: '按活动重叠的 UTC 自然日过滤', example: '2099-10-01' })
  @OmittableOnly()
  @IsDateString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  date?: string;

  @ApiPropertyOptional({ description: '承办组织 id', minLength: 8, maxLength: 64 })
  @OmittableOnly()
  @IsString()
  @MinLength(8)
  @MaxLength(64)
  organization?: string;
}

export class AppActivityDirectoryListItemDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  title!: string;

  @ApiProperty()
  activityTypeCode!: string;

  @ApiProperty({ enum: ['published'] })
  statusCode!: 'published';

  @ApiProperty()
  startAt!: Date;

  @ApiProperty()
  endAt!: Date;

  @ApiProperty()
  location!: string;

  @ApiPropertyOptional({ nullable: true })
  registrationMode!: string | null;

  @ApiProperty()
  createdAt!: Date;
}
