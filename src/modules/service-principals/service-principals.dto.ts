import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsString, Length, MaxLength } from 'class-validator';

import { OmittableOnly } from '../../common/decorators/omittable-only.decorator';

import { PaginationQueryDto } from '../../common/dto/pagination.dto';

/** 规格书 §35:ServicePrincipal 控制面 8 端点的 DTO。 */

export class CreateServicePrincipalDto {
  @ApiProperty({ minLength: 2, maxLength: 64 })
  @IsString()
  @Length(2, 64)
  name!: string;

  @ApiPropertyOptional({ maxLength: 512 })
  @OmittableOnly()
  @IsString()
  @MaxLength(512)
  description?: string;

  @ApiPropertyOptional()
  @OmittableOnly()
  @IsString()
  ownerOrganizationId?: string;
}

export class UpdateServicePrincipalDto {
  @ApiPropertyOptional({ minLength: 2, maxLength: 64 })
  @OmittableOnly()
  @IsString()
  @Length(2, 64)
  name?: string;

  @ApiPropertyOptional({ maxLength: 512 })
  @OmittableOnly()
  @IsString()
  @MaxLength(512)
  description?: string;

  @ApiPropertyOptional()
  @OmittableOnly()
  @IsString()
  ownerOrganizationId?: string;
}

export class UpdateServicePrincipalStatusDto {
  @ApiProperty({ enum: ['ACTIVE', 'SUSPENDED'] })
  @IsIn(['ACTIVE', 'SUSPENDED'])
  status!: 'ACTIVE' | 'SUSPENDED';
}

export class ListServicePrincipalsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: ['ACTIVE', 'SUSPENDED'], description: '按状态过滤' })
  @OmittableOnly()
  @IsIn(['ACTIVE', 'SUSPENDED'])
  status?: 'ACTIVE' | 'SUSPENDED';
}

// ---- 响应 ----

export class ServicePrincipalResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() clientId!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ nullable: true }) description!: string | null;
  @ApiProperty({ enum: ['ACTIVE', 'SUSPENDED'] }) status!: string;
  @ApiProperty({ nullable: true }) ownerOrganizationId!: string | null;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
}

export class ServicePrincipalCredentialResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() createdAt!: Date;
  @ApiProperty({ nullable: true }) expiresAt!: Date | null;
  @ApiProperty({ nullable: true }) revokedAt!: Date | null;
  @ApiProperty({ nullable: true }) lastUsedAt!: Date | null;
}

export class ServicePrincipalCredentialCreatedDto {
  @ApiProperty() id!: string;
  @ApiProperty() createdAt!: Date;
  @ApiProperty({
    description:
      '原始 Client Secret —— 仅在本次创建响应中出现一次;列表/详情/日志/审计永不返回。外部系统必须立即保存到其 Secret Manager。',
  })
  clientSecret!: string;
}
