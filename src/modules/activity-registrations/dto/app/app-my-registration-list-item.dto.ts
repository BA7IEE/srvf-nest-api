import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

// Phase 2 P2-5a App /api/app/v1/my/registrations 列表项出参。
// 沿 docs/app-api-p2-5-registrations-review.md §8.2.1 v0.1 字段集**恰好 11 个**;
// §16.B.2 默认锁定**不返回** memberId(本人已知 via /me/account.linkedMemberId)。
//
// **严禁**继承 / Pick / Omit / IntersectionType / PartialType / OmitType / Mapped Types
// admin DTO(沿 docs/code-architecture-boundary-review.md §2.2 + 评审稿 §8.1)。
// 物理隔离于 src/modules/activity-registrations/dto/app/。
//
// 派生字段(沿 §8.2.1 join Activity):activityTitle / activityStartAt / activityEndAt /
// activityCoverImageUrl —— 前端列表展示活动概要;详情走 P2-4 GET /activities/:id。
//
// 明确不返(沿 §8.2.1 / §16.B.2):memberId / reviewedBy / cancelledByUserId / reviewNote /
// cancelReason / extras / updatedAt / deletedAt / member.memberNo / member.displayName。
export class AppMyRegistrationListItemDto {
  @ApiProperty({ description: '报名记录主键(cuid)', example: 'cl9z3a8b00000abcd1234efgh' })
  id!: string;

  @ApiProperty({ description: '活动外键(Activity.id;前端可点跳 P2-4 详情)' })
  activityId!: string;

  @ApiProperty({ description: '活动标题(join Activity.title;列表派生)', example: '梧桐山轮值演练' })
  activityTitle!: string;

  @ApiProperty({ description: '活动开始时间(join Activity.startAt;列表派生)' })
  activityStartAt!: Date;

  @ApiProperty({ description: '活动结束时间(join Activity.endAt;列表派生)' })
  activityEndAt!: Date;

  @ApiPropertyOptional({
    description: '活动封面图片 URL(join Activity.coverImageUrl;裸 URL 字符串)',
    nullable: true,
  })
  activityCoverImageUrl!: string | null;

  @ApiProperty({
    description: '报名状态字典 code(registration_status:pending / pass / reject / cancelled)',
    example: 'pending',
  })
  statusCode!: string;

  @ApiProperty({ description: '报名时间' })
  registeredAt!: Date;

  @ApiPropertyOptional({ description: '审核时间', nullable: true })
  reviewedAt!: Date | null;

  @ApiPropertyOptional({ description: '取消时间', nullable: true })
  cancelledAt!: Date | null;

  @ApiProperty({ description: '创建时间(排序参考)' })
  createdAt!: Date;
}
