import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

// Phase 2 P2-4a App /api/app/v1/activities/available 列表出参。
// 沿 docs/app-api-p2-4-activities-review.md §4.1 v0.1 字段集**恰好 11 个**;
// **严禁**继承 / Pick / Omit / Mapped Types Admin DTO(沿 Phase 0.7 §2.2 +
// 评审稿 §4.3)。物理隔离于 src/modules/activities/dto/app/。
//
// 排除字段(沿 §4.2 v0.1 锁定 17 项,App 浏览端永不返):
//   - description / organizationId / genderRequirementCode / isPublicRegistration
//   - registrationNotes / registrationSchema / galleryImageUrls / content
//   - locationLongitude / locationLatitude / updatedAt
//   - deletedAt / publishedBy / publishedAt / cancelledBy / cancelledAt / cancelReason
export class AppAvailableActivityListItemDto {
  @ApiProperty({ description: '活动主键(cuid)', example: 'cl9z3a8b00000abcd1234efgh' })
  id!: string;

  @ApiProperty({ description: '活动标题', example: '梧桐山轮值演练' })
  title!: string;

  @ApiProperty({
    description: '活动类型字典 code(typeCode=activity_type)',
    example: 'training',
  })
  activityTypeCode!: string;

  @ApiProperty({
    description: '活动状态字典 code(App 视角恒为 published;字段保留便于前端泛化)',
    example: 'published',
  })
  statusCode!: string;

  @ApiProperty({ description: '开始时间(ISO 8601)' })
  startAt!: Date;

  @ApiProperty({ description: '结束时间(ISO 8601)' })
  endAt!: Date;

  @ApiProperty({ description: '活动地点(自由文本)', example: '梧桐山东门' })
  location!: string;

  @ApiPropertyOptional({
    description: '名额上限(NULL = 不限名额)',
    nullable: true,
    example: 30,
  })
  capacity!: number | null;

  @ApiPropertyOptional({
    description: '报名截止时间(ISO 8601;NULL = 不限)',
    nullable: true,
  })
  registrationDeadline!: Date | null;

  @ApiPropertyOptional({
    description: '封面图片 URL(裸 URL 字符串,非 signed URL)',
    nullable: true,
  })
  coverImageUrl!: string | null;

  @ApiProperty({ description: '创建时间(排序参考)' })
  createdAt!: Date;
}
