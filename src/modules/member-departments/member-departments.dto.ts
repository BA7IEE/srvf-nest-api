import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length } from 'class-validator';

// V2 第一阶段 member_departments 模块 DTO 集合。
// 出参显式列字段(永不含 deletedAt 软删内部状态);入参严格白名单。
// 详见 docs/v2-api-contract.md §5 / docs/v2-data-model.md §6。
//
// **绝对禁止字段**(D7-min MD-5 锁定):
// - isPrimary(一人一部门前提下冗余)
// - joinedAt / endedAt(D5 Q18 ② 不保留部门归属变更历史)
// - 进出原因(走字典 / 自由文本均不引入)
// - 跨部门角色 / 跨部门等级(默认全队统一)

// ============ 出参 ============

export class MemberDepartmentResponseDto {
  @ApiProperty({ description: '主键(cuid 代理键)', example: 'cl9z3a8b00000abcd1234efgh' })
  id!: string;

  @ApiProperty({ description: '队员外键(指向 members.id)' })
  memberId!: string;

  @ApiProperty({ description: '组织节点外键(指向 organizations.id)' })
  organizationId!: string;

  @ApiProperty({ description: '归属生效时间' })
  createdAt!: Date;

  @ApiProperty({ description: '更新时间' })
  updatedAt!: Date;
}

// ============ 入参 ============

// PUT /api/v2/members/:memberId/department 入参:仅 organizationId。
// 严格白名单:**禁止** memberId(由路径参数提供)/ id / deletedAt / 任何附加字段。
export class SetMemberDepartmentDto {
  @ApiProperty({
    description: '目标组织节点 id(必须存在且 status=ACTIVE)',
    example: 'cl9z3a8b00000abcd1234efgh',
    minLength: 8,
    maxLength: 64,
  })
  @IsString()
  @Length(8, 64)
  organizationId!: string;
}
