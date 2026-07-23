import { ApiProperty } from '@nestjs/swagger';
import type { AppAccessReason } from './app-access-reason';

// Phase 2 P2-1 App /me/capabilities 出参。沿 docs/app-api-phase-2-review.md §4.2 冻结结构。
// 铁律(§4.3):
// 1) 字段集是 product-level capability map,**不是** RBAC permission code 列表
// 2) capability **不是授权证明**;后端写端点必须重新做四维校验(沿 D-5.3 + Phase 0.7 §3.2)
// 3) ADMIN / SUPER_ADMIN **不扩大** AppSelf capability(沿 D-5.2)
// 4) canUseApp=false → 所有业务 capability 强制 false
// 5) reason 是展示字符串,**不**绑定 BizCode 段位
// 6) tasks 命名空间仍预留；managed 已由活动责任闭环 PR-6 实装
// **严禁**继承 / Pick / Omit Admin DTO。

export class AppCapabilityAccountDto {
  @ApiProperty({ description: '是否可使用 App 队员功能', example: true })
  canUseApp!: boolean;

  @ApiProperty({
    description: 'App 不可用原因(展示字符串;非 BizCode)',
    enum: ['MEMBER_NOT_LINKED', 'MEMBER_INACTIVE', 'MEMBER_DELETED'],
    nullable: true,
    example: null,
  })
  reason!: AppAccessReason | null;

  @ApiProperty({ description: '本人是否可改昵称 / 头像(后端二次校验)', example: true })
  canEditProfile!: boolean;

  @ApiProperty({ description: '本人是否可改密码(后端二次校验)', example: true })
  canChangePassword!: boolean;
}

export class AppCapabilityActivitiesDto {
  @ApiProperty({ description: '是否可查看可参加活动列表', example: true })
  canViewAvailableActivities!: boolean;

  @ApiProperty({ description: '是否可报名活动', example: true })
  canRegisterActivity!: boolean;

  @ApiProperty({ description: '是否可取消本人报名', example: true })
  canCancelOwnRegistration!: boolean;

  @ApiProperty({ description: '当前正式队员是否可发起活动', example: true })
  canInitiateActivity!: boolean;

  @ApiProperty({
    description: '是否持有至少一条有效发布审核 grant（仅入口提示）',
    example: false,
  })
  canDirectPublishOwnActivity!: boolean;
}

export class AppCapabilityAttendanceDto {
  @ApiProperty({ description: '是否可查看本人考勤记录', example: true })
  canViewOwnAttendance!: boolean;
}

export class AppCapabilityCertificatesDto {
  @ApiProperty({ description: '是否可查看本人证书', example: true })
  canViewOwnCertificates!: boolean;
}

export class AppCapabilityTasksDto {
  @ApiProperty({ description: '是否可查看待办(预留;当前恒 false)', example: false })
  canViewTasks!: boolean;
}

export class AppCapabilityManagedDto {
  @ApiProperty({ description: '是否可查看我发起或承担责任的活动', example: true })
  canViewManagedActivities!: boolean;

  @ApiProperty({ description: '是否存在可管理报名的 active 活动责任', example: false })
  canManageManagedRegistrations!: boolean;

  @ApiProperty({ description: '是否存在可提交考勤的 active 活动责任', example: false })
  canSubmitManagedAttendance!: boolean;

  @ApiProperty({ description: '是否持有有效活动发布审核角色', example: false })
  canReviewActivityPublication!: boolean;

  @ApiProperty({ description: '是否持有有效考勤一审角色', example: false })
  canFirstReviewAttendance!: boolean;

  @ApiProperty({ description: '是否持有有效考勤终审角色', example: false })
  canFinalReviewAttendance!: boolean;
}

export class AppCapabilityResponseDto {
  @ApiProperty({ description: '账号 / 准入 capability', type: AppCapabilityAccountDto })
  account!: AppCapabilityAccountDto;

  @ApiProperty({ description: '活动 capability', type: AppCapabilityActivitiesDto })
  activities!: AppCapabilityActivitiesDto;

  @ApiProperty({ description: '考勤 capability', type: AppCapabilityAttendanceDto })
  attendance!: AppCapabilityAttendanceDto;

  @ApiProperty({ description: '证书 capability', type: AppCapabilityCertificatesDto })
  certificates!: AppCapabilityCertificatesDto;

  @ApiProperty({ description: '待办 capability(预留;全 false)', type: AppCapabilityTasksDto })
  tasks!: AppCapabilityTasksDto;

  @ApiProperty({
    description: '管理范围 capability',
    type: AppCapabilityManagedDto,
  })
  managed!: AppCapabilityManagedDto;
}
