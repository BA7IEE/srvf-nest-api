import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  ApiBizErrorResponse,
  ApiWrappedArrayResponse,
  ApiWrappedOkResponse,
} from '../../common/decorators/api-response.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { CreateMembershipDto, MembershipResponseDto, UpdateMembershipDto } from './memberships.dto';
import { MembershipsService } from './memberships.service';

// 终态 scoped-authz PR2(2026-07-01;冻结稿 §7.1):组织归属(memberships)管理面,沿队员轴嵌套。
// 独立 controller class(与旧 member-departments 单部门端点分列;controller 计数 +1)。
//
// **权限标注**:入口仅 JwtAuthGuard,**不**挂 `@Roles(...)`;全部判权在 MembershipsService 内 rbac.can()。
// 4 码 membership.{list,set,end}.record 绑 ops-admin(沿 member-department.* 现绑;POST/PATCH 共用 set)。
// membership.read.record 已 seed(冻结稿 §4.3;为未来 GET :id 预留),本刀无端点承接。
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
  ): Promise<MembershipResponseDto> {
    return this.service.create(user, memberId, dto);
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
  ): Promise<MembershipResponseDto> {
    return this.service.end(user, memberId, id);
  }
}
