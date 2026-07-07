import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import {
  ApiBizErrorResponse,
  ApiWrappedOkResponse,
  ApiWrappedPageResponse,
} from '../../common/decorators/api-response.decorator';
import {
  CurrentUser,
  type CurrentUserPayload,
} from '../../common/decorators/current-user.decorator';
import { IdParamDto } from '../../common/dto/id-param.dto';
import { PageResultDto } from '../../common/dto/pagination.dto';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import {
  CreateMemberDto,
  GrantMemberAccountDto,
  GrantMemberAccountResponseDto,
  ListMembersQueryDto,
  MemberOptionsQueryDto,
  MemberOptionsResponseDto,
  MemberResponseDto,
  UpdateMemberDto,
  UpdateMemberStatusDto,
} from './members.dto';
import { MembersService } from './members.service';

// /api/admin/v1/members(8 接口,含 F1/A1 options 与队员账号闭环 v1 account true-up);
// 路径前缀:全局 /api(main.ts)+ 'admin/v1/members'。
// 权限(Slow-4 T2,2026-06-11,评审稿 §3.1):入口仅 JwtAuthGuard,判权下沉 service 层
// `rbac.can('member.*')`(SUPER_ADMIN 短路;biz-admin 绑 read/create/update/status);
// DELETE 走 `member.delete.record`(不绑 biz-admin,仅 SUPER_ADMIN 短路,D1=A 镜像);
// POST :id/account 走 `member.grant.account`(队员账号闭环 v1,2026-07-07;绑 **ops-admin**
// 而非 biz-admin —— 账号铸造归系统/账号面,与 user.*.account 族一致)。

@ApiTags('Admin - Members')
@ApiBearerAuth()
@Controller('admin/v1/members')
export class MembersController {
  constructor(private readonly service: MembersService) {}

  @Get()
  @ApiOperation({
    summary:
      '列出队员(分页;memberNo 精确查询 / gradeCode / status 过滤) [rbac: member.read.record]',
  })
  @ApiWrappedPageResponse(MemberResponseDto)
  @ApiBizErrorResponse(BizCode.BAD_REQUEST, BizCode.UNAUTHORIZED, BizCode.RBAC_FORBIDDEN)
  list(
    @Query() query: ListMembersQueryDto,
    @CurrentUser() currentUser: CurrentUserPayload,
  ): Promise<PageResultDto<MemberResponseDto>> {
    return this.service.list(query, currentUser);
  }

  // F1/A1(路线图 §4;D2/D3 拍板):选择器投影,必须先于 /:id 定义(specific-before-dynamic)。
  @Get('options')
  @ApiOperation({
    summary:
      '队员选择器投影(q 模糊 displayName+memberNo;limit≤100,默认 20) [rbac: member.read.record]',
  })
  @ApiWrappedOkResponse(MemberOptionsResponseDto)
  @ApiBizErrorResponse(BizCode.BAD_REQUEST, BizCode.UNAUTHORIZED, BizCode.RBAC_FORBIDDEN)
  options(
    @Query() query: MemberOptionsQueryDto,
    @CurrentUser() currentUser: CurrentUserPayload,
  ): Promise<MemberOptionsResponseDto> {
    return this.service.options(query, currentUser);
  }

  @Post()
  @ApiOperation({
    summary:
      '创建队员(memberNo 必填,全局唯一不复用;不接收任何敏感字段) [rbac: member.create.record]',
  })
  @ApiWrappedOkResponse(MemberResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.MEMBER_NO_ALREADY_EXISTS,
    BizCode.MEMBER_GRADE_CODE_INVALID,
  )
  create(
    @Body() dto: CreateMemberDto,
    @CurrentUser() currentUser: CurrentUserPayload,
  ): Promise<MemberResponseDto> {
    return this.service.create(dto, currentUser);
  }

  @Get(':id')
  @ApiOperation({ summary: '队员详情(返回 memberNo) [rbac: member.read.record]' })
  @ApiWrappedOkResponse(MemberResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.MEMBER_NOT_FOUND,
  )
  findOne(
    @Param() params: IdParamDto,
    @CurrentUser() currentUser: CurrentUserPayload,
  ): Promise<MemberResponseDto> {
    return this.service.findOne(params.id, currentUser);
  }

  @Patch(':id')
  @ApiOperation({
    summary:
      '更新队员(displayName / gradeCode;**禁止改 memberNo / status**) [rbac: member.update.record]',
  })
  @ApiWrappedOkResponse(MemberResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.MEMBER_NOT_FOUND,
    BizCode.MEMBER_GRADE_CODE_INVALID,
  )
  update(
    @Param() params: IdParamDto,
    @Body() dto: UpdateMemberDto,
    @CurrentUser() currentUser: CurrentUserPayload,
  ): Promise<MemberResponseDto> {
    return this.service.update(params.id, dto, currentUser);
  }

  @Patch(':id/status')
  @ApiOperation({
    summary: '切换队员 status(ACTIVE↔INACTIVE);不自动解除部门归属 [rbac: member.update.status]',
  })
  @ApiWrappedOkResponse(MemberResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.MEMBER_NOT_FOUND,
  )
  updateStatus(
    @Param() params: IdParamDto,
    @Body() dto: UpdateMemberStatusDto,
    @CurrentUser() currentUser: CurrentUserPayload,
  ): Promise<MemberResponseDto> {
    return this.service.updateStatus(params.id, dto, currentUser);
  }

  @Delete(':id')
  @ApiOperation({
    summary:
      '软删队员(码不绑 biz-admin,仅 SUPER_ADMIN 短路;有 active 部门归属 / 绑定 user 则拒绝;非常规离队入口) [rbac: member.delete.record]',
  })
  @ApiWrappedOkResponse(MemberResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.MEMBER_NOT_FOUND,
    BizCode.MEMBER_HAS_ACTIVE_DEPARTMENT,
    BizCode.MEMBER_HAS_LINKED_USER,
  )
  softDelete(
    @Param() params: IdParamDto,
    @CurrentUser() currentUser: CurrentUserPayload,
  ): Promise<MemberResponseDto> {
    return this.service.softDelete(params.id, currentUser);
  }

  // 队员账号闭环 v1(MVP,2026-07-07):给已存在队员开通"手机验证码登录"账号(不设密码)。
  // 以后想设密码走既有"手机验证码找回/设置密码"(auth/v1/password-reset,队员自己手机号收码)。
  @Post(':id/account')
  @ApiOperation({
    summary:
      '给已存在队员开通登录账号(手机验证码登录,不设密码;队员已有绑定账号则拒绝) [rbac: member.grant.account]',
  })
  @ApiWrappedOkResponse(GrantMemberAccountResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.MEMBER_NOT_FOUND,
    BizCode.MEMBER_INACTIVE,
    BizCode.MEMBER_HAS_LINKED_USER,
    BizCode.USERNAME_ALREADY_EXISTS,
    BizCode.PHONE_ALREADY_BOUND,
  )
  grantAccount(
    @Param() params: IdParamDto,
    @Body() dto: GrantMemberAccountDto,
    @CurrentUser() currentUser: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<GrantMemberAccountResponseDto> {
    return this.service.grantAccount(params.id, dto, currentUser, this.buildAuditMeta(req));
  }

  // 沿 users.controller.ts / emergency-contacts.controller.ts 范式:从 @Req() 显式构造
  // AuditMeta 传给 service(D6 v1.1 §11.2 / D8 拍板;不引入 cls-rs / AsyncLocalStorage)。
  private buildAuditMeta(req: Request): AuditMeta {
    return {
      requestId: req.id as string,
      ip: req.ip ?? null,
      ua: req.headers['user-agent'] ?? null,
    };
  }
}
