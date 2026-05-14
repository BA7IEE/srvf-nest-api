import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';

// V2.x C-6 RBAC 实施 PR #2:permissions 模块 DTO 集合。
// 沿 D7 v1.1 §5.2.1(CreatePermissionDto)+ §4.2(Permission schema)。
//
// **code 格式校验铁律(D2 v1.0 锁定 + 30008 实装方式)**:
// - DTO 层只做基础字符串 + 长度校验(@IsString + @MinLength(5) + @MaxLength(80))
// - **不在 DTO 写 @Matches**,把格式校验留给 Service 层显式 regex 检查 + 抛
//   BizException(BizCode.INVALID_PERMISSION_CODE_FORMAT)(30008),让本 BizCode
//   真正可触发并被 e2e 覆盖
// - 若放在 DTO @Matches,失败时 ValidationPipe 走通用 BAD_REQUEST(40000),
//   30008 永远不会被触发,违背"实装"语义
//
// **PATCH 字段白名单(纵深防御铁律,沿 baseline §4.2 + CLAUDE.md §11)**:
// - UpdatePermissionDto 仅允许 description(且可空)
// - 严禁 code / module / action / resourceType / id / createdAt / updatedAt;
//   code 是业务标识不可改;module/action/resourceType 改了等于改语义,需走 DELETE+POST

// ============ 出参 ============

export class PermissionResponseDto {
  @ApiProperty({ description: '主键(cuid)', example: 'cl9z3a8b00000abcd1234efgh' })
  id!: string;

  @ApiProperty({
    description:
      '权限点 code,格式 <module>.<action>.<resource_type>[.<scope>](D2 v1.2;kebab-case 3-4 段,scope 可选)',
    example: 'attachment.upload.cert.self',
  })
  code!: string;

  @ApiProperty({ description: '模块名(冗余存储,后台 UI 按 module 分组)', example: 'attachment' })
  module!: string;

  @ApiProperty({ description: '动作', example: 'upload' })
  action!: string;

  @ApiProperty({ description: '资源类型', example: 'cert' })
  resourceType!: string;

  @ApiPropertyOptional({ description: '描述(可空;运营录入)' })
  description?: string | null;

  @ApiProperty({ description: '创建时间' })
  createdAt!: Date;

  @ApiProperty({ description: '更新时间' })
  updatedAt!: Date;
}

// ============ 入参 ============

export class CreatePermissionDto {
  @ApiProperty({
    description:
      'code,格式 <module>.<action>.<resource_type>[.<scope>](D2 v1.2 锁定 kebab-case;3-4 段点分隔,scope 可选;详见 service 层 regex 校验 / 失败抛 30008)',
    example: 'attachment.upload.cert.self',
    minLength: 1,
    maxLength: 80,
  })
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  code!: string;

  @ApiProperty({ description: '模块名', example: 'attachment', maxLength: 64 })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  module!: string;

  @ApiProperty({ description: '动作', example: 'upload', maxLength: 64 })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  action!: string;

  @ApiProperty({ description: '资源类型', example: 'cert', maxLength: 64 })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  resourceType!: string;

  @ApiPropertyOptional({ description: '描述(可空)', maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}

// PATCH 仅允许 description;严禁 code / module / action / resourceType / id 等敏感字段
// (沿 baseline §4.2 / CLAUDE.md §11 纵深防御)。
export class UpdatePermissionDto {
  @ApiPropertyOptional({ description: '描述(可空)', maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}

export class ListPermissionsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: '按 module 过滤(精确匹配)', example: 'attachment' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  module?: string;

  @ApiPropertyOptional({ description: '按 resourceType 过滤(精确匹配)', example: 'cert' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  resourceType?: string;
}
