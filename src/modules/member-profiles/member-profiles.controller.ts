import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import {
  ApiBizErrorResponse,
  ApiWrappedOkResponse,
} from '../../common/decorators/api-response.decorator';
import {
  CurrentUser,
  type CurrentUserPayload,
} from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { CreateMemberProfileDto } from './dto/create-member-profile.dto';
import { MemberProfileResponseDto } from './dto/member-profile-response.dto';
import { UpdateMemberProfileDto } from './dto/update-member-profile.dto';
import { MemberProfilesService } from './member-profiles.service';

// V2 第一阶段批次 1 member_profiles controller。
// 路径嵌套在 members/:memberId/profile 下作为 1:1 子资源(单数,沿用 member-departments 风格)。
//
// 临时权限策略(批次 1 评审 §5.1):
// - 全部 ADMIN / SUPER_ADMIN 兜底,**不开放** USER 自助路由
// - **不实装** 二次校验中间件;**不实装** 业务角色矩阵执行机制
// - 默认完整 ResponseDto(含敏感字段);ADMIN/SUPER_ADMIN 本就有权限,后续接入字段动态脱敏时再过滤
//
// memberId 为路径参数(@Param('memberId') 直接读;不通过 IdParamDto,与 member-departments 同款)。

@ApiTags('Admin - Member Profiles')
@ApiBearerAuth()
@Controller('admin/v1/members/:memberId/profile')
export class MemberProfilesController {
  constructor(private readonly service: MemberProfilesService) {}

  @Get()
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @ApiOperation({ summary: '查队员扩展档案(无则返 data: null)' })
  @ApiWrappedOkResponse(MemberProfileResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.MEMBER_NOT_FOUND,
  )
  findOne(
    @Param('memberId') memberId: string,
    @CurrentUser() currentUser: CurrentUserPayload,
  ): Promise<MemberProfileResponseDto | null> {
    return this.service.findOne(memberId, currentUser);
  }

  @Post()
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @ApiOperation({
    summary: '创建队员扩展档案(1:1;重复创建 → MEMBER_PROFILE_ALREADY_EXISTS)',
  })
  @ApiWrappedOkResponse(MemberProfileResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
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
  ): Promise<MemberProfileResponseDto> {
    return this.service.create(memberId, dto);
  }

  @Patch()
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @ApiOperation({
    summary: '部分更新队员扩展档案(全字段 optional;**禁止** id / memberId / 系统字段)',
  })
  @ApiWrappedOkResponse(MemberProfileResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
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
  ): Promise<MemberProfileResponseDto> {
    return this.service.update(memberId, dto);
  }
}
