import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import {
  ApiWrappedCreatedResponse,
  ApiBizErrorResponse,
  ApiWrappedArrayResponse,
  ApiWrappedOkResponse,
  ApiWrappedPageResponse,
} from '../../common/decorators/api-response.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import type { PageResultDto } from '../../common/dto/pagination.dto';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import {
  CreatePositionAssignmentDto,
  PagePositionAssignmentsQueryDto,
  PositionAssignmentPreviewResponseDto,
  PositionAssignmentResponseDto,
  PreviewPositionAssignmentDto,
} from './position-assignments.dto';
import { PositionAssignmentsService } from './position-assignments.service';

// 终态 scoped-authz PR4(2026-07-01;冻结稿 §7.3):任职(position-assignments)双轴管理面 controller(8 路由)。
// 单 controller 跨 3 根路径(组织轴 organizations/:orgId/* + 队员轴 members/:memberId/* + 扁平 position-assignments/*),
// 故 @Controller 取共同前缀 'admin/v1',各方法声明完整子路径(controller 计数 +1)。
// 判权单轨 service 层 rbac.can(position-assignment.*);入口仅全局 JwtAuthGuard,**不**挂 @Roles。
// AuthzService 动态读取任职；任命 policy 不参与 action 判权，只维护 assignment 数据合法性。

// 从 @Req() 构造 AuditMeta(沿 content-admin / activity-registrations 范式;D8 拍板不引入 ALS)。
function buildAuditMeta(req: Request): AuditMeta {
  return {
    requestId: req.id as string,
    ip: req.ip ?? null,
    ua: req.headers['user-agent'] ?? null,
  };
}

@ApiTags('Admin - Position Assignments')
@ApiBearerAuth()
@Controller('admin/v1')
export class PositionAssignmentsController {
  constructor(private readonly service: PositionAssignmentsService) {}

  // ============ 组织轴 ============

  @Get('organizations/:orgId/position-assignments')
  @ApiOperation({
    summary: '列出某组织在任职务(status=ACTIVE) [rbac: position-assignment.read.record]',
  })
  @ApiWrappedArrayResponse(PositionAssignmentResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ORGANIZATION_NOT_FOUND,
  )
  listByOrganization(
    @CurrentUser() user: CurrentUserPayload,
    @Param('orgId') orgId: string,
  ): Promise<PositionAssignmentResponseDto[]> {
    return this.service.listByOrganization(user, orgId);
  }

  @Post('organizations/:orgId/position-assignments')
  @ApiOperation({
    summary:
      '任命(校验 active 职务/规则、严格兼任交集、人数上限、归属要求、任期；锁后重算) [rbac: position-assignment.create.record]',
  })
  @ApiWrappedCreatedResponse(PositionAssignmentResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ORGANIZATION_NOT_FOUND,
    BizCode.POSITION_NOT_FOUND,
    BizCode.MEMBER_NOT_FOUND,
    BizCode.POSITION_ASSIGNMENT_TENURE_INVALID,
    BizCode.POSITION_ASSIGNMENT_RULE_NOT_MATCHED,
    BizCode.POSITION_ASSIGNMENT_MEMBERSHIP_REQUIRED,
    BizCode.POSITION_ASSIGNMENT_CONCURRENT_FORBIDDEN,
    BizCode.POSITION_ASSIGNMENT_ALREADY_EXISTS,
    BizCode.POSITION_ASSIGNMENT_SINGLE_HOLDER,
  )
  create(
    @CurrentUser() user: CurrentUserPayload,
    @Param('orgId') orgId: string,
    @Body() dto: CreatePositionAssignmentDto,
    @Req() req: Request,
  ): Promise<PositionAssignmentResponseDto> {
    return this.service.create(user, orgId, dto, buildAuditMeta(req));
  }

  // ============ 队员轴 ============

  @Get('members/:memberId/position-assignments')
  @ApiOperation({
    summary: '列出某队员任职(含 ENDED / REVOKED 历史) [rbac: position-assignment.read.record]',
  })
  @ApiWrappedArrayResponse(PositionAssignmentResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.MEMBER_NOT_FOUND,
  )
  listByMember(
    @CurrentUser() user: CurrentUserPayload,
    @Param('memberId') memberId: string,
  ): Promise<PositionAssignmentResponseDto[]> {
    return this.service.listByMember(user, memberId);
  }

  // ============ F5/E1(路线图 §4):扁平总表 / 预检 / detail ============

  @Get('position-assignments')
  @ApiOperation({
    summary:
      '全局分页任职总表(organizationId+includeDescendants/memberId/positionId/status/q 过滤 + expand=member,position,organization;缺省含 REVOKED 历史) [rbac: position-assignment.read.record]',
  })
  @ApiWrappedPageResponse(PositionAssignmentResponseDto)
  @ApiBizErrorResponse(BizCode.BAD_REQUEST, BizCode.UNAUTHORIZED, BizCode.RBAC_FORBIDDEN)
  page(
    @CurrentUser() user: CurrentUserPayload,
    @Query() query: PagePositionAssignmentsQueryDto,
  ): Promise<PageResultDto<PositionAssignmentResponseDto>> {
    return this.service.page(user, query);
  }

  // 显式 @HttpCode(200):dry-run 诊断读,violations 是数据不是错误(沿 authz/explain 决断②范式)。
  @Post('position-assignments/preview')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      '预检任命(dry-run:任期 + 存在性/member ACTIVE + active 配置/归属/兼任/人数上限全量收集；只读时点建议) [rbac: position-assignment.read.record]',
  })
  @ApiWrappedOkResponse(PositionAssignmentPreviewResponseDto)
  @ApiBizErrorResponse(BizCode.BAD_REQUEST, BizCode.UNAUTHORIZED, BizCode.RBAC_FORBIDDEN)
  preview(
    @CurrentUser() user: CurrentUserPayload,
    @Body() dto: PreviewPositionAssignmentDto,
  ): Promise<PositionAssignmentPreviewResponseDto> {
    return this.service.preview(user, dto);
  }

  @Get('position-assignments/:id')
  @ApiOperation({
    summary: '查单条任职(detail;找不到未软删记录 → 32020) [rbac: position-assignment.read.record]',
  })
  @ApiWrappedOkResponse(PositionAssignmentResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.POSITION_ASSIGNMENT_NOT_FOUND,
  )
  findOne(
    @CurrentUser() user: CurrentUserPayload,
    @Param('id') id: string,
  ): Promise<PositionAssignmentResponseDto> {
    return this.service.findOne(user, id);
  }

  // ============ 扁平:撤销 + 历史 ============

  @Post('position-assignments/:id/revoke')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      '撤销任职(status=REVOKED + 撤销人 + endedAt；required/minCount 不阻断) [rbac: position-assignment.revoke.record]',
  })
  @ApiWrappedOkResponse(PositionAssignmentResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.POSITION_ASSIGNMENT_NOT_FOUND,
    BizCode.POSITION_ASSIGNMENT_ALREADY_ENDED,
  )
  revoke(
    @CurrentUser() user: CurrentUserPayload,
    @Param('id') id: string,
    @Req() req: Request,
  ): Promise<PositionAssignmentResponseDto> {
    return this.service.revoke(user, id, buildAuditMeta(req));
  }

  @Get('position-assignments/:id/history')
  @ApiOperation({
    summary:
      '任职变更/历史链(以 :id 锚定人-组织-职务三元组) [rbac: position-assignment.read.history]',
  })
  @ApiWrappedArrayResponse(PositionAssignmentResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.POSITION_ASSIGNMENT_NOT_FOUND,
  )
  history(
    @CurrentUser() user: CurrentUserPayload,
    @Param('id') id: string,
  ): Promise<PositionAssignmentResponseDto[]> {
    return this.service.history(user, id);
  }
}
