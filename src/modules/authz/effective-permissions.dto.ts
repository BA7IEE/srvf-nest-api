import { ApiProperty } from '@nestjs/swagger';

// v0.49 System surface:只暴露前端按钮所需的有效 permission code 并集,不返回 role/binding/scope 内部明细。
export class EffectivePermissionsResponseDto {
  @ApiProperty({
    description:
      '当前用户从直接 RoleBinding、职务策略和分管关系获得的全部当前有效权限码；去重并按字典序排序',
    type: [String],
    example: ['attachment.view.member', 'member.read.record'],
  })
  permissions!: string[];
}
