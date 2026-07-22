import {
  HttpStatus,
  HttpCode,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import {
  ApiBizErrorResponse,
  ApiWrappedOkResponse,
  ApiWrappedPageResponse,
} from '../../common/decorators/api-response.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import type { PageResultDto } from '../../common/dto/pagination.dto';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { MemberOptionsResponseDto } from '../members/members.dto';
import {
  MembershipConflictsQueryDto,
  MembershipConflictsResponseDto,
  MembershipResponseDto,
  OrgMembersOptionsQueryDto,
  OrgMembershipsQueryDto,
  PageMembershipsQueryDto,
  TransferMembershipDto,
} from './memberships.dto';
import { MembershipsService } from './memberships.service';

// F4「D 组」memberships 扁平/组织轴增强面(2026-07-04;冻结路线图
// admin-api-fe-integration-roadmap.md §4 D 组):分页总表 / detail / 冲突诊断 / 组织轴列表 /
// 组织轴队员下拉 / transfer 迁移(唯一写端点)。`@Controller('admin/v1')` + 完整子路径跨
// memberships / organizations 两根(沿 PositionAssignmentsController 单 controller 跨根范式);
// 判权单轨 service 层 rbac.can,入口仅全局 JwtAuthGuard,不挂 @Roles。
// 既有队员轴 4 端点(members/:memberId/memberships,MembershipsController)逐字不动。
// 静态段路由(conflicts / transfer)先于 GET :id 声明(Nest 按声明序注册)。

// 从 @Req() 构造 AuditMeta(沿 role-bindings / supervision-assignments 范式;不引入 ALS)。
function buildAuditMeta(req: Request): AuditMeta {
  return {
    requestId: req.id as string,
    ip: req.ip ?? null,
    ua: req.headers['user-agent'] ?? null,
  };
}

@ApiTags('Admin - Memberships')
@ApiBearerAuth()
@Controller('admin/v1')
export class MembershipsAdminController {
  constructor(private readonly service: MembershipsService) {}

  @Get('memberships')
  @ApiOperation({
    summary:
      '分页列组织归属总表(memberId/organizationId/includeDescendants/membershipType/status/q 过滤 + expand=member,organization;缺省含 ENDED 历史) [rbac: membership.list.record]',
  })
  @ApiWrappedPageResponse(MembershipResponseDto)
  @ApiBizErrorResponse(BizCode.BAD_REQUEST, BizCode.UNAUTHORIZED, BizCode.RBAC_FORBIDDEN)
  page(
    @CurrentUser() user: CurrentUserPayload,
    @Query() query: PageMembershipsQueryDto,
  ): Promise<PageResultDto<MembershipResponseDto>> {
    return this.service.page(user, query);
  }

  @Get('memberships/conflicts')
  @ApiOperation({
    summary:
      '归属冲突只读诊断(多 ACTIVE PRIMARY / 悬空队员 / 悬空组织 / 停用组织在任归属;零写入,数据体检面) [rbac: membership.list.record]',
  })
  @ApiWrappedOkResponse(MembershipConflictsResponseDto)
  @ApiBizErrorResponse(BizCode.BAD_REQUEST, BizCode.UNAUTHORIZED, BizCode.RBAC_FORBIDDEN)
  conflicts(
    @CurrentUser() user: CurrentUserPayload,
    @Query() query: MembershipConflictsQueryDto,
  ): Promise<MembershipConflictsResponseDto> {
    return this.service.conflicts(user, query);
  }

  // F4 唯一写端点:单事务 end 旧 + create 新(受既有 partial unique 约束;audit `membership.transfer`)。
  @Post('memberships/transfer')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      '归属迁移(单事务:结束源组织对应类型 ACTIVE 归属 + 在目标组织建同类型新归属;源=目标 → 400;目标撞唯一 → 17004) [rbac: membership.transfer.record]',
  })
  @ApiWrappedOkResponse(MembershipResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.MEMBER_NOT_FOUND,
    BizCode.MEMBER_INACTIVE,
    BizCode.ORGANIZATION_NOT_FOUND,
    BizCode.ORGANIZATION_INACTIVE,
    BizCode.MEMBERSHIP_NOT_FOUND,
    BizCode.MEMBERSHIP_ALREADY_EXISTS,
  )
  transfer(
    @CurrentUser() user: CurrentUserPayload,
    @Body() dto: TransferMembershipDto,
    @Req() req: Request,
  ): Promise<MembershipResponseDto> {
    return this.service.transfer(user, dto, buildAuditMeta(req));
  }

  @Get('memberships/:id')
  @ApiOperation({
    summary: '查单条归属(detail;找不到未软删记录 → 17003) [rbac: membership.read.record]',
  })
  @ApiWrappedOkResponse(MembershipResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.MEMBERSHIP_NOT_FOUND,
  )
  findOne(
    @CurrentUser() user: CurrentUserPayload,
    @Param('id') id: string,
  ): Promise<MembershipResponseDto> {
    return this.service.findOne(user, id);
  }

  @Get('organizations/:orgId/memberships')
  @ApiOperation({
    summary:
      '组织轴列归属(分页;includeDescendants 展开后代 + membershipType/status/q 过滤 + expand=member,organization;含历史与暂停,组织成员页请传 status=ACTIVE;组织不存在 → 11001) [rbac: membership.list.record]',
  })
  @ApiWrappedPageResponse(MembershipResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ORGANIZATION_NOT_FOUND,
  )
  listForOrganization(
    @CurrentUser() user: CurrentUserPayload,
    @Param('orgId') orgId: string,
    @Query() query: OrgMembershipsQueryDto,
  ): Promise<PageResultDto<MembershipResponseDto>> {
    return this.service.listForOrganization(user, orgId, query);
  }

  @Get('organizations/:orgId/members/options')
  @ApiOperation({
    summary:
      '组织轴队员下拉(该组织±后代的可选队员;复用 F1 members/options 投影;组织不存在 → 11001) [rbac: member.read.record]',
  })
  @ApiWrappedOkResponse(MemberOptionsResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ORGANIZATION_NOT_FOUND,
  )
  orgMembersOptions(
    @CurrentUser() user: CurrentUserPayload,
    @Param('orgId') orgId: string,
    @Query() query: OrgMembersOptionsQueryDto,
  ): Promise<MemberOptionsResponseDto> {
    return this.service.orgMembersOptions(user, orgId, query);
  }
}
