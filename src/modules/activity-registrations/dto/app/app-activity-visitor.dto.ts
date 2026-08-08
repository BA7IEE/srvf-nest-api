import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Length } from 'class-validator';
import { PaginationQueryDto } from '../../../../common/dto/pagination.dto';

export class AppManagedActivityVisitorActivityParamsDto {
  @ApiProperty({ description: '活动 id', minLength: 8, maxLength: 64 })
  @IsString()
  @Length(8, 64)
  activityId!: string;
}

export class AppManagedActivityVisitorsQueryDto extends PaginationQueryDto {}

export class CreateAppManagedActivityVisitorDto {
  @ApiProperty({ description: '所属场次 id', minLength: 8, maxLength: 64 })
  @IsString()
  @Length(8, 64)
  sessionId!: string;

  @ApiProperty({ description: '访客姓名' })
  @IsString()
  name!: string;

  @ApiPropertyOptional({ description: '访客单位', nullable: true })
  @IsOptional()
  @IsString()
  organization?: string | null;

  @ApiPropertyOptional({ description: '邀请该访客的现存队员 id；仅创建时校验', nullable: true })
  @IsOptional()
  @IsString()
  @Length(8, 64)
  invitedByMemberId?: string | null;

  @ApiPropertyOptional({ description: '访客备注', nullable: true })
  @IsOptional()
  @IsString()
  note?: string | null;
}

export class AppActivityVisitorDto {
  @ApiProperty({ description: '访客 id' })
  visitorId!: string;

  @ApiProperty({ description: '活动 id' })
  activityId!: string;

  @ApiProperty({ description: '场次 id' })
  sessionId!: string;

  @ApiProperty({ description: '访客姓名' })
  name!: string;

  @ApiPropertyOptional({ description: '访客单位', nullable: true })
  organization!: string | null;

  @ApiPropertyOptional({ description: '邀请该访客的队员 id', nullable: true })
  invitedByMemberId!: string | null;

  @ApiPropertyOptional({ description: '访客备注', nullable: true })
  note!: string | null;

  @ApiProperty({ description: '创建时间' })
  createdAt!: Date;
}
