import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ACTIVITY_PHASE_VALUES, type ActivityPhase } from '../../activity-phase';

// Phase 2 P2-4b App /api/app/v1/activities/:id 详情出参。
// 原 v0.1 13 字段；2026-07-15 additive 增 phase / genderRequirementCode /
// requiresInsurance / passCount，当前恰好 17 个。
// **严禁**继承 / Pick / Omit / Mapped Types Admin DTO(沿 Phase 0.7 §2.2 +
// 评审稿 §5.4)。物理隔离于 src/modules/activities/dto/app/。
//
// 排除字段(沿 §5.2 v0.1 锁定,App 详情端永不返):
//   - registrationSchema / galleryImageUrls / content
//   - locationLongitude / locationLatitude / updatedAt
//   - organizationId / isPublicRegistration
//   - deletedAt / publishedBy / publishedAt / cancelledBy / cancelledAt / cancelReason
//
// 详情 vs 列表:在原 List 11 项基础上追加 description / registrationNotes，
// 再 additive 追加上述 4 字段。
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

  @ApiProperty({
    description: '按当前时间派生的阶段(upcoming / ongoing / ended)',
    enum: ACTIVITY_PHASE_VALUES,
  })
  phase!: ActivityPhase;

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
    description: '性别限制字典 code(typeCode=gender_requirement;NULL = 无限制)',
    nullable: true,
    type: String,
  })
  genderRequirementCode!: string | null;

  @ApiProperty({ description: '是否要求保险' })
  requiresInsurance!: boolean;

  @ApiProperty({ description: '已审核通过报名数(statusCode=pass,未软删)' })
  passCount!: number;

  @ApiPropertyOptional({
    description: '封面图片 URL(裸 URL 字符串,非 signed URL)',
    nullable: true,
  })
  coverImageUrl!: string | null;

  @ApiProperty({ description: '创建时间' })
  createdAt!: Date;
}
