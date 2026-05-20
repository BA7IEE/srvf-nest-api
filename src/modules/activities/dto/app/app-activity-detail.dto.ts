import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

// Phase 2 P2-4b App /api/app/v1/activities/:id 详情出参。
// 沿 docs/app-api-p2-4-activities-review.md §5.1 v0.1 字段集**恰好 13 个**;
// **严禁**继承 / Pick / Omit / Mapped Types Admin DTO(沿 Phase 0.7 §2.2 +
// 评审稿 §5.4)。物理隔离于 src/modules/activities/dto/app/。
//
// 排除字段(沿 §5.2 v0.1 锁定,App 详情端永不返):
//   - registrationSchema / galleryImageUrls / content
//   - locationLongitude / locationLatitude / updatedAt
//   - organizationId / genderRequirementCode / isPublicRegistration
//   - deletedAt / publishedBy / publishedAt / cancelledBy / cancelledAt / cancelReason
//
// 详情 vs 列表:在 List 11 项基础上追加 description + registrationNotes 共 13 项;
// statusCode 由 service where 子句锁定 `published`,字段保留便于前端泛化。
export class AppActivityDetailDto {
  @ApiProperty({ description: '活动主键(cuid)', example: 'cl9z3a8b00000abcd1234efgh' })
  id!: string;

  @ApiProperty({ description: '活动标题', example: '梧桐山轮值演练' })
  title!: string;

  @ApiPropertyOptional({
    description: '活动描述 / 摘要(纯文本;富正文 content 字段不返)',
    nullable: true,
  })
  description!: string | null;

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
    description: '报名须知 / 注意事项(自由文本)',
    nullable: true,
  })
  registrationNotes!: string | null;

  @ApiPropertyOptional({
    description: '封面图片 URL(裸 URL 字符串,非 signed URL)',
    nullable: true,
  })
  coverImageUrl!: string | null;

  @ApiProperty({ description: '创建时间' })
  createdAt!: Date;
}
