import { Body, Controller, Delete, Get, Param, Patch, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import {
  ApiBizErrorResponse,
  ApiWrappedArrayResponse,
  ApiWrappedOkResponse,
} from '../../common/decorators/api-response.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { CreateMembershipDto, MembershipResponseDto, UpdateMembershipDto } from './memberships.dto';
import { MembershipsService } from './memberships.service';

// 终态 scoped-authz PR2(2026-07-01;冻结稿 §7.1):组织归属(memberships)管理面,沿队员轴嵌套。
// 独立 controller class(与旧 member-departments 单部门端点分列;controller 计数 +1)。
//
// **权限标注**:入口仅 JwtAuthGuard,**不**挂 `@Roles(...)`;全部判权在 MembershipsService 内 rbac.can()。
// 4 码 membership.{list,set,end}.record 绑 ops-admin(沿 member-department.* 现绑;POST/PATCH 共用 set)。
// membership.read.record 已 seed(冻结稿 §4.3;为未来 GET :id 预留),本刀无端点承接。

// 从 @Req() 构造 AuditMeta(沿 position-assignments / content-admin 范式;D8 拍板不引入 ALS)。
function buildAuditMeta(req: Request): AuditMeta {
  return {
    requestId: req.id as string,
    ip: req.ip ?? null,
    ua: req.headers['user-agent'] ?? null,
  };
}

@ApiTags('Admin - Member Memberships')
@ApiBearerAuth()
@Controller('admin/v1/members/:memberId/memberships')
export class MembershipsController {
  constructor(private readonly service: MembershipsService) {}

  @Get()
  @ApiOperation({
    summary: '列出队员全部组织归属(主/兼/临时/支援 + 任期;含历史) [rbac: membership.list.record]',
  })
  @ApiWrappedArrayResponse(MembershipResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.MEMBER_NOT_FOUND,
  )
  list(
    @CurrentUser() user: CurrentUserPayload,
    @Param('memberId') memberId: string,
  ): Promise<MembershipResponseDto[]> {
    return this.service.list(user, memberId);
  }

  @Post()
  @ApiOperation({
    summary: '新增队员归属(指定 membershipType) [rbac: membership.set.record]',
  })
  @ApiWrappedOkResponse(MembershipResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.MEMBER_NOT_FOUND,
    BizCode.ORGANIZATION_NOT_FOUND,
    BizCode.MEMBER_INACTIVE,
    BizCode.ORGANIZATION_INACTIVE,
    BizCode.MEMBERSHIP_ALREADY_EXISTS,
  )
  create(
    @CurrentUser() user: CurrentUserPayload,
    @Param('memberId') memberId: string,
    @Body() dto: CreateMembershipDto,
    @Req() req: Request,
  ): Promise<MembershipResponseDto> {
    return this.service.create(user, memberId, dto, buildAuditMeta(req));
  }

  @Patch(':id')
  @ApiOperation({
    summary: '改归属类型 / 任期 / 原因(不改 status) [rbac: membership.set.record]',
  })
  @ApiWrappedOkResponse(MembershipResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.MEMBERSHIP_NOT_FOUND,
    BizCode.MEMBERSHIP_ALREADY_EXISTS,
  )
  update(
    @CurrentUser() user: CurrentUserPayload,
    @Param('memberId') memberId: string,
    @Param('id') id: string,
    @Body() dto: UpdateMembershipDto,
  ): Promise<MembershipResponseDto> {
    return this.service.update(user, memberId, id, dto);
  }

  @Delete(':id')
  @ApiOperation({
    summary: '结束队员归属(status=ENDED + endedAt,保留留痕) [rbac: membership.end.record]',
  })
  @ApiWrappedOkResponse(MembershipResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.MEMBERSHIP_NOT_FOUND,
  )
  end(
    @CurrentUser() user: CurrentUserPayload,
    @Param('memberId') memberId: string,
    @Param('id') id: string,
    @Req() req: Request,
  ): Promise<MembershipResponseDto> {
    return this.service.end(user, memberId, id, buildAuditMeta(req));
  }
}
