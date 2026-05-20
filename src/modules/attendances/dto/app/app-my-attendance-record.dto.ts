import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

// Phase 2 P2-6 App /api/app/v1/my/attendance-records 列表项出参。
// 沿 docs/app-api-p2-6-attendance-records-review.md §5.1 v0.1 字段集**恰好 14 项**;
// §5.2 默认锁定**不返回** sheetId / memberId / member 嵌套 / registrationId / updatedAt。
//
// **严禁**继承 / Pick / Omit / IntersectionType / PartialType / OmitType / Mapped Types
// admin `AttendanceRecordResponseDto`(沿 D-P2-6-4 + Phase 0.6 §1.3 + Phase 0.7 §2.2)。
// 物理隔离于 src/modules/attendances/dto/app/。
//
// 派生字段(沿 §5.1 join Activity):activityId / activityTitle / activityStartAt /
// activityEndAt / activityCoverImageUrl —— 前端列表展示活动概要;详情走
// P2-4 GET /activities/:id。
//
// 字段语义:
// - `serviceHours`:Decimal 序列化为 string(沿 admin DTO 现状)
// - `contributionPoints`:Decimal 序列化为 string | null(沿 admin DTO 现状)
// - `note`:L1 对本人可见(沿评审稿 §5.1 D-P2-6-8 + Phase 0.6 §2.14 / §2.16)
// - `activityCoverImageUrl`:`Activity.coverImageUrl` 裸 URL 字符串(非 signed URL,
//   `Activity.coverImageUrl` 在 schema 中即为裸字符串;沿 §13 R12)
//
// 绝对禁止返回(沿 §5.3 snapshot 触发即拒合并):
// - L3 凭据:passwordHash / refreshToken / tokenHash / accessToken
// - L2 member 字段:member.mobile / member.documentNumber / member.medicalNotes
// - Sheet 级 admin 字段:submitterUserId / reviewerUserId / reviewNote /
//   finalReviewerUserId / finalReviewNote / previousSnapshot / version
// - audit context:requestId / ip / ua
//
// 明确不返(沿 §5.2 默认锁定):
// - sheetId(App 不暴露 sheet 内部结构;前端跳转用 activityId)
// - memberId(本人已知 via /me/account.linkedMemberId)
// - member 嵌套(AppSelf scope 下所有 record 都属 currentUser,冗余)
// - registrationId(内部跨表关联键,App 无业务用途)
// - updatedAt(admin housekeeping)
// - activityName / activityCode / activityStatus(评审稿未列入派生集;
//   Prisma 实际字段名为 `title` / `activityTypeCode` / `statusCode`,
//   若需扩展必须另立 v0.2 评审稿)
export class AppMyAttendanceRecordDto {
  @ApiProperty({ description: '考勤记录主键(cuid)', example: 'cl9z3a8b00000abcd1234efgh' })
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
    description: '考勤角色字典 code(attendance_role)',
    example: 'member',
  })
  roleCode!: string;

  @ApiProperty({ description: '签到时间' })
  checkInAt!: Date;

  @ApiProperty({ description: '签退时间' })
  checkOutAt!: Date;

  @ApiProperty({
    description: '服务时长(小时;Decimal(5,2) 序列化为 string)',
    example: '4.50',
  })
  serviceHours!: string;

  @ApiProperty({
    description: '考勤明细状态字典 code(attendance_status;3 态闭集)',
    example: 'normal',
  })
  attendanceStatusCode!: string;

  @ApiPropertyOptional({ description: '备注(本人对自己被备注可见)', nullable: true })
  note!: string | null;

  @ApiPropertyOptional({
    description: '贡献值(本人完整可见;Decimal 序列化为 string;终审通过后由规则预填或 APD 手填)',
    nullable: true,
    example: '2.50',
  })
  contributionPoints!: string | null;

  @ApiProperty({ description: '创建时间(排序参考)' })
  createdAt!: Date;
}
