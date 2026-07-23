import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  Equals,
  IsBoolean,
  IsDateString,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';

const parseQueryBoolean = ({ value }: { value: unknown }): unknown =>
  value === true || value === 'true' ? true : value === false || value === 'false' ? false : value;

export class ActivityPublishReviewResponseDto {
  @ApiProperty()
  id!: string;
  @ApiProperty()
  activityId!: string;
  @ApiProperty({ enum: ['initial', 'change'] })
  requestType!: string;
  @ApiProperty()
  requestVersion!: number;
  @ApiProperty()
  baseRevision!: number;
  @ApiProperty({ enum: ['pending', 'approved', 'returned', 'withdrawn', 'cancelled'] })
  status!: string;
  @ApiProperty({ type: 'object', additionalProperties: true })
  snapshot!: Record<string, unknown>;
  @ApiProperty()
  directPublish!: boolean;
  @ApiProperty()
  submittedByUserId!: string;
  @ApiProperty()
  submittedAt!: Date;
  @ApiProperty({ nullable: true, type: String })
  reviewedByUserId!: string | null;
  @ApiProperty({ nullable: true, type: Date })
  reviewedAt!: Date | null;
  @ApiProperty({ nullable: true, type: String })
  reviewNote!: string | null;
  @ApiProperty()
  createdAt!: Date;
  @ApiProperty()
  updatedAt!: Date;
  @ApiProperty()
  activityTitle!: string;
  @ApiProperty()
  organizationId!: string;
  @ApiProperty({ nullable: true, type: String })
  initiatorMemberId!: string | null;
}

export class ListActivityPublishReviewsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: ['pending', 'approved', 'returned', 'withdrawn', 'cancelled'] })
  @IsOptional()
  @IsIn(['pending', 'approved', 'returned', 'withdrawn', 'cancelled'])
  status?: string;

  @ApiPropertyOptional({ enum: ['initial', 'change'] })
  @IsOptional()
  @IsIn(['initial', 'change'])
  requestType?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(8)
  @MaxLength(64)
  organizationId?: string;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @Transform(parseQueryBoolean)
  @IsBoolean()
  includeDescendants: boolean = false;

  @ApiPropertyOptional({ maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  initiatorQ?: string;

  @ApiPropertyOptional({ maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  activityQ?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  submittedFrom?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  submittedTo?: string;
}

export class ApproveActivityPublishReviewDto {
  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reviewNote?: string;

  @ApiProperty({ example: true })
  @IsBoolean()
  @Equals(true)
  requiresInsuranceConfirmed!: boolean;
}

export class ReturnActivityPublishReviewDto {
  @ApiProperty({ minLength: 1, maxLength: 500 })
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reviewNote!: string;
}
