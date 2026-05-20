import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

// Phase 2 P2-5a App /api/app/v1/my/activities 汇总列表项出参。
// 沿 docs/app-api-p2-5-registrations-review.md §8.2.3 v0.1 字段集**恰好 11 个**;
// 语义:"我已建立 registration 关系的活动汇总",每个活动一行,含本人在该活动的
// **最新有效** registration 摘要(派生取值优先级 active > reject > cancelled;沿 §11.2)。
//
// **严禁**继承 / Pick / Omit / IntersectionType / PartialType / OmitType / Mapped Types
// admin DTO(沿 docs/code-architecture-boundary-review.md §2.2 + 评审稿 §8.1)。
// 物理隔离于 src/modules/activities/dto/app/。
//
// 不返(沿 §8.2.3 + 评审稿 §14.14 风险表):
//   - capacity / registrationDeadline / description / content / genderRequirementCode /
//     isPublicRegistration / organizationId / registrationSchema / galleryImageUrls /
//     locationLongitude / locationLatitude / publishedBy* / cancelledBy* / registrationNotes
//   - 出勤摘要 / 证书摘要(留 P2-6 / P2-7;不夹带)
//   - myRegistrationCount(同活动多条历史 registration 数量;沿 §11 决议不返)
//   - deletedAt(永不返)
//
// 关键铁律:活动 statusCode **可包含全部 4 态**(`draft` / `published` / `cancelled` / `completed`);
// 因为本人可能在活动 published 时报名后,活动被管理员 cancelled / completed,该 registration
// 仍是有意义的"我的活动"关系(沿 §11.1 + §11.7)。
export class AppMyActivityListItemDto {
  @ApiProperty({
    description: '活动主键(Activity.id;**不是** registration id;前端可点跳 P2-4 详情)',
    example: 'cl9z3a8b00000abcd1234efgh',
  })
  activityId!: string;

  @ApiProperty({ description: '活动标题', example: '梧桐山轮值演练' })
  title!: string;

  @ApiProperty({
    description: '活动类型字典 code(typeCode=activity_type)',
    example: 'training',
  })
  activityTypeCode!: string;

  @ApiProperty({
    description: '活动状态字典 code(可包含 draft / published / cancelled / completed 全 4 态)',
    example: 'published',
  })
  statusCode!: string;

  @ApiProperty({ description: '活动开始时间(ISO 8601)' })
  startAt!: Date;

  @ApiProperty({ description: '活动结束时间(ISO 8601)' })
  endAt!: Date;

  @ApiProperty({ description: '活动地点(自由文本)', example: '梧桐山东门' })
  location!: string;

  @ApiPropertyOptional({
    description: '封面图片 URL(裸 URL 字符串,非 signed URL)',
    nullable: true,
  })
  coverImageUrl!: string | null;

  @ApiProperty({
    description: '我在该活动的最新有效 registration id(派生取值:active > reject > cancelled)',
  })
  myRegistrationId!: string;

  @ApiProperty({
    description: '我在该活动的报名状态字典 code(派生;active > reject > cancelled 取值规则)',
    example: 'pending',
  })
  myRegistrationStatusCode!: string;

  @ApiProperty({ description: '我在该活动的最新报名时间(派生)' })
  myRegisteredAt!: Date;
}
