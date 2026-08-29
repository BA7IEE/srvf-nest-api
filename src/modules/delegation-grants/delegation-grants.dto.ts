import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { BindingScopeType, DelegationGrantStatus } from '@prisma/client';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsDateString,
  IsIn,
  IsString,
  Length,
} from 'class-validator';

import { OmittableOnly } from '../../common/decorators/omittable-only.decorator';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';

/** Delegated v1 禁止 SELF；机器代人时 SELF 没有安全语义。 */
export const DELEGATION_GRANT_SCOPE_TYPES = [
  BindingScopeType.GLOBAL,
  BindingScopeType.ORGANIZATION,
  BindingScopeType.ORGANIZATION_TREE,
  BindingScopeType.ACTIVITY,
  BindingScopeType.RESOURCE,
] as const;

export class CreateDelegationGrantDto {
  @ApiProperty({ description: '被授权的 ServicePrincipal.id' })
  @IsString()
  @Length(8, 64)
  servicePrincipalId!: string;

  @ApiProperty({ description: '被代表的固定 User.id；只能由控制面管理员设置' })
  @IsString()
  @Length(8, 64)
  subjectUserId!: string;

  @ApiProperty({
    description:
      'Grant allowlist；每一项都必须同时开放 servicePrincipalAllowed 与 delegatedAccessAllowed',
    type: [String],
    minItems: 1,
    maxItems: 100,
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ArrayUnique()
  @IsString({ each: true })
  @Length(3, 128, { each: true })
  permissionCodes!: string[];

  @ApiProperty({ enum: DELEGATION_GRANT_SCOPE_TYPES })
  @IsIn(DELEGATION_GRANT_SCOPE_TYPES)
  scopeType!: (typeof DELEGATION_GRANT_SCOPE_TYPES)[number];

  @ApiPropertyOptional({ description: '组织 / 组织树范围的根组织 ID' })
  @OmittableOnly()
  @IsString()
  @Length(8, 64)
  scopeOrgId?: string;

  @ApiPropertyOptional({ description: '活动范围的 Activity.id' })
  @OmittableOnly()
  @IsString()
  @Length(8, 64)
  scopeActivityId?: string;

  @ApiPropertyOptional({ description: '资源范围的资源类型' })
  @OmittableOnly()
  @IsString()
  @Length(1, 64)
  scopeResourceType?: string;

  @ApiPropertyOptional({ description: '资源范围的资源 ID' })
  @OmittableOnly()
  @IsString()
  @Length(8, 64)
  scopeResourceId?: string;

  @ApiPropertyOptional({ description: '生效起点；省略时为当前时间', format: 'date-time' })
  @OmittableOnly()
  @IsDateString()
  startedAt?: string;

  @ApiPropertyOptional({ description: '生效终点；必须晚于 startedAt', format: 'date-time' })
  @OmittableOnly()
  @IsDateString()
  endedAt?: string;
}

export class ListDelegationGrantsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: DelegationGrantStatus, description: '按状态过滤（默认含历史）' })
  @OmittableOnly()
  @IsIn(Object.values(DelegationGrantStatus))
  status?: DelegationGrantStatus;
}

export class RevokeDelegationGrantDto {
  @ApiPropertyOptional({ description: '撤销原因（可省略；一旦提供不得为空）', maxLength: 512 })
  @OmittableOnly()
  @IsString()
  @Length(1, 512)
  reason?: string;
}

export class DelegationGrantResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() servicePrincipalId!: string;
  @ApiProperty() subjectUserId!: string;
  @ApiProperty({ enum: DelegationGrantStatus }) status!: DelegationGrantStatus;
  @ApiProperty({ enum: BindingScopeType }) scopeType!: BindingScopeType;
  @ApiProperty({ nullable: true }) scopeOrgId!: string | null;
  @ApiProperty({ nullable: true }) scopeActivityId!: string | null;
  @ApiProperty({ nullable: true }) scopeResourceType!: string | null;
  @ApiProperty({ nullable: true }) scopeResourceId!: string | null;
  @ApiProperty({ type: [String] }) permissionCodes!: string[];
  @ApiProperty() startedAt!: Date;
  @ApiProperty({ nullable: true }) endedAt!: Date | null;
  @ApiProperty() createdByUserId!: string;
  @ApiProperty() createdAt!: Date;
  @ApiProperty({ nullable: true }) revokedAt!: Date | null;
  @ApiProperty({ nullable: true }) revokedByUserId!: string | null;
  @ApiProperty({ nullable: true }) revokeReason!: string | null;
}
