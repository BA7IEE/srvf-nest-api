import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

// Phase 2 P2-5a App /api/app/v1/my/registrations/:id 详情出参。
// 沿 docs/app-api-p2-5-registrations-review.md §8.2.2 v0.1 字段集 12 项 - §16.B.2
// memberId **不返** = **恰好 11 项**;P2-5b POST / PATCH cancel 共用本 DTO 作出参。
//
// **严禁**继承 / Pick / Omit / IntersectionType / PartialType / OmitType / Mapped Types
// admin DTO(沿 docs/code-architecture-boundary-review.md §2.2 + 评审稿 §8.1)。
// 物理隔离于 src/modules/activity-registrations/dto/app/。
//
// 允许返:reviewNote(本人 reject 解释,L1 对本人;沿 §8.1 #5)/ cancelReason(取消原因)/
// extras(用户自定义 JSON;沿 v2 Q-A13 不嵌套校验)。
//
// 明确不返:memberId(§16.B.2)/ reviewedBy(L1 admin 内部)/ cancelledByUserId(同上)/
// deletedAt(永不返)/ activity join 字段(前端拿 activityId 走 P2-4 GET /activities/:id)。
export class AppMyRegistrationDto {
  @ApiProperty({ description: '报名记录主键(cuid)', example: 'cl9z3a8b00000abcd1234efgh' })
  id!: string;

  @ApiProperty({ description: '活动外键(Activity.id;前端可拿此 id 走 P2-4 详情)' })
  activityId!: string;

  @ApiProperty({
    description: '报名状态字典 code(registration_status:pending / pass / reject / cancelled)',
    example: 'pending',
  })
  statusCode!: string;

  @ApiProperty({ description: '报名时间' })
  registeredAt!: Date;

  @ApiPropertyOptional({ description: '审核时间', nullable: true })
  reviewedAt!: Date | null;

  @ApiPropertyOptional({
    description: '审核备注 / 拒绝理由(L1 对本人;本人 reject 解释)',
    nullable: true,
  })
  reviewNote!: string | null;

  @ApiPropertyOptional({
    description: '扩展字段(用户自定义 JSON;沿 v2 Q-A13 不嵌套校验)',
    nullable: true,
    type: 'object',
    additionalProperties: true,
  })
  extras!: Record<string, unknown> | null;

  @ApiPropertyOptional({ description: '取消时间', nullable: true })
  cancelledAt!: Date | null;

  @ApiPropertyOptional({ description: '取消原因(L1 对本人)', nullable: true })
  cancelReason!: string | null;

  @ApiProperty({ description: '创建时间' })
  createdAt!: Date;

  @ApiProperty({ description: '更新时间' })
  updatedAt!: Date;
}
