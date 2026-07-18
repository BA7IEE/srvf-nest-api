import { Body, Controller, Get, Param, Patch, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import {
  ApiBizErrorResponse,
  ApiWrappedOkResponse,
} from '../../common/decorators/api-response.decorator';
import {
  CurrentUser,
  type CurrentUserPayload,
} from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { CreateMemberProfileDto } from './dto/create-member-profile.dto';
import { MemberProfileResponseDto } from './dto/member-profile-response.dto';
import { UpdateMemberProfileDto } from './dto/update-member-profile.dto';
import { MemberProfilesService } from './member-profiles.service';

function buildAuditMeta(req: Request): AuditMeta {
  return {
    requestId: req.id as string,
    ip: req.ip ?? null,
    ua: req.headers['user-agent'] ?? null,
  };
}

// V2 第一阶段批次 1 member_profiles controller。
// 路径嵌套在 members/:memberId/profile 下作为 1:1 子资源(单数,沿用 member-departments 风格)。
//
// 权限(Slow-4 T2,2026-06-11,评审稿 §3.2;取代批次 1 临时 @Roles 兜底;第三轮 review §F&A-3 敏感分级):
// - 入口仅 JwtAuthGuard,判权下沉 service 层 `rbac.can('member-profile.*')`
//   (SUPER_ADMIN 短路;biz-admin 绑全部 4 码);**不开放** USER 自助路由(沿批次 1)
// - 敏感分级(§F&A-3,镜像 recruitment-application.read.sensitive):入口码仍是 member-profile.read.record;
//   无更严的 member-profile.read.sensitive 者,documentNumber / mobile 在全部 3 出口(findOne / create / update
//   回显)均掩码,持 sensitive 码见明文(掩码是值变换,DTO 字段名/类型不变)
//
// memberId 为路径参数(@Param('memberId') 直接读;不通过 IdParamDto,与 member-departments 同款)。

@ApiTags('Admin - Member Profiles')
@ApiBearerAuth()
@Controller('admin/v1/members/:memberId/profile')
export class MemberProfilesController {
  constructor(private readonly service: MemberProfilesService) {}

  @Get()
  @ApiOperation({
    summary:
      '查队员扩展档案(无则返 data: null;documentNumber / mobile 默认掩码,持 member-profile.read.sensitive 见明文) [rbac: member-profile.read.record]',
  })
  @ApiWrappedOkResponse(MemberProfileResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.MEMBER_NOT_FOUND,
  )
  findOne(
    @Param('memberId') memberId: string,
    @CurrentUser() currentUser: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<MemberProfileResponseDto | null> {
    return this.service.findOne(memberId, currentUser, buildAuditMeta(req));
  }

  @Post()
  @ApiOperation({
    summary:
      '创建队员扩展档案(1:1;重复创建 → MEMBER_PROFILE_ALREADY_EXISTS;回显 documentNumber / mobile 默认掩码,持 member-profile.read.sensitive 见明文) [rbac: member-profile.create.record]',
  })
  @ApiWrappedOkResponse(MemberProfileResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.MEMBER_NOT_FOUND,
    BizCode.MEMBER_PROFILE_ALREADY_EXISTS,
    BizCode.MEMBER_PROFILE_GENDER_CODE_INVALID,
    BizCode.MEMBER_PROFILE_DOCUMENT_TYPE_CODE_INVALID,
    BizCode.MEMBER_PROFILE_POLITICAL_STATUS_CODE_INVALID,
    BizCode.MEMBER_PROFILE_BLOOD_TYPE_CODE_INVALID,
    BizCode.MEMBER_PROFILE_WORK_NATURE_CODE_INVALID,
  )
  create(
    @Param('memberId') memberId: string,
    @Body() dto: CreateMemberProfileDto,
    @CurrentUser() currentUser: CurrentUserPayload,
  ): Promise<MemberProfileResponseDto> {
    return this.service.create(memberId, dto, currentUser);
  }

  @Patch()
  @ApiOperation({
    summary:
      '部分更新队员扩展档案(全字段 optional;**禁止** id / memberId / 系统字段;回显 documentNumber / mobile 默认掩码,持 member-profile.read.sensitive 见明文) [rbac: member-profile.update.record]',
  })
  @ApiWrappedOkResponse(MemberProfileResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.MEMBER_NOT_FOUND,
    BizCode.MEMBER_PROFILE_NOT_FOUND,
    BizCode.MEMBER_PROFILE_GENDER_CODE_INVALID,
    BizCode.MEMBER_PROFILE_DOCUMENT_TYPE_CODE_INVALID,
    BizCode.MEMBER_PROFILE_POLITICAL_STATUS_CODE_INVALID,
    BizCode.MEMBER_PROFILE_BLOOD_TYPE_CODE_INVALID,
    BizCode.MEMBER_PROFILE_WORK_NATURE_CODE_INVALID,
  )
  update(
    @Param('memberId') memberId: string,
    @Body() dto: UpdateMemberProfileDto,
    @CurrentUser() currentUser: CurrentUserPayload,
  ): Promise<MemberProfileResponseDto> {
    return this.service.update(memberId, dto, currentUser);
  }
}
