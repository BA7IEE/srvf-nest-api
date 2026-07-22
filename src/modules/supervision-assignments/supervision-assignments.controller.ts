import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
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
  CreateSupervisionAssignmentDto,
  OrganizationSupervisorDto,
  PageSupervisionAssignmentsQueryDto,
  SupervisionAssignmentResponseDto,
  SupervisionCoveragePreviewDto,
  SupervisionCoveragePreviewResponseDto,
  SupervisionScopeEntryDto,
  UpdateSupervisionAssignmentDto,
} from './supervision-assignments.dto';
import { SupervisionAssignmentsService } from './supervision-assignments.service';

// 终态 scoped-authz PR5(2026-07-01;冻结稿 §7.4):分管(supervision-assignments)管理面 controller(6 路由)。
// 单 controller 跨 3 根路径(扁平 supervision-assignments/* + 队员轴 members/:memberId/supervision-scope +
// 组织轴 organizations/:orgId/supervisors),故 @Controller 取共同前缀 'admin/v1',各方法声明完整子路径(controller 计数 +1)。
// 判权单轨 service 层 rbac.can(supervision-assignment.*);入口仅全局 JwtAuthGuard,**不**挂 @Roles。
// **分管 = 数据 + 展示,绝不进判权路径**(判权是 PR8)。

// 从 @Req() 构造 AuditMeta(沿 position-assignments / content 范式;D8 拍板不引入 ALS)。
function buildAuditMeta(req: Request): AuditMeta {
  return {
    requestId: req.id as string,
    ip: req.ip ?? null,
    ua: req.headers['user-agent'] ?? null,
  };
}

@ApiTags('Admin - Supervision Assignments')
@ApiBearerAuth()
@Controller('admin/v1')
export class SupervisionAssignmentsController {
  constructor(private readonly service: SupervisionAssignmentsService) {}

  // ============ 扁平:列 / 建 ============

  @Get('supervision-assignments')
  @ApiOperation({
    summary: '列出当前在任分管(status=ACTIVE) [rbac: supervision-assignment.read.record]',
  })
  @ApiWrappedArrayResponse(SupervisionAssignmentResponseDto)
  @ApiBizErrorResponse(BizCode.BAD_REQUEST, BizCode.UNAUTHORIZED, BizCode.RBAC_FORBIDDEN)
  list(@CurrentUser() user: CurrentUserPayload): Promise<SupervisionAssignmentResponseDto[]> {
    return this.service.list(user);
  }

  // F5/E2(路线图 §4;D9 同型):/page 兄弟路由 —— 旧 bare 数组端点逐字不动。
  // 静态段路由(page / coverage-preview)须先于下方 GET :id 声明(Nest 按声明序注册)。
  @Get('supervision-assignments/page')
  @ApiOperation({
    summary:
      '分页分管总表(supervisorMemberId/organizationId+includeDescendants/scopeMode/status/q 过滤 + expand=supervisor,organization;缺省含 REVOKED 历史) [rbac: supervision-assignment.read.record]',
  })
  @ApiWrappedPageResponse(SupervisionAssignmentResponseDto)
  @ApiBizErrorResponse(BizCode.BAD_REQUEST, BizCode.UNAUTHORIZED, BizCode.RBAC_FORBIDDEN)
  page(
    @CurrentUser() user: CurrentUserPayload,
    @Query() query: PageSupervisionAssignmentsQueryDto,
  ): Promise<PageResultDto<SupervisionAssignmentResponseDto>> {
    return this.service.page(user, query);
  }

  // 显式 @HttpCode(200):dry-run 展示读(沿 authz/explain 决断②范式)。
  @Post('supervision-assignments/coverage-preview')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      '覆盖范围预演(dry-run:某待建分管将覆盖哪些组织;EXACT=[该节点] / TREE=closure 展开含后代;零写入,展示读非判权) [rbac: supervision-assignment.read.record]',
  })
  @ApiWrappedOkResponse(SupervisionCoveragePreviewResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ORGANIZATION_NOT_FOUND,
  )
  coveragePreview(
    @CurrentUser() user: CurrentUserPayload,
    @Body() dto: SupervisionCoveragePreviewDto,
  ): Promise<SupervisionCoveragePreviewResponseDto> {
    return this.service.coveragePreview(user, dto);
  }

  @Get('supervision-assignments/:id')
  @ApiOperation({
    summary:
      '查单条分管(detail;找不到未软删记录 → 33001) [rbac: supervision-assignment.read.record]',
  })
  @ApiWrappedOkResponse(SupervisionAssignmentResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.SUPERVISION_ASSIGNMENT_NOT_FOUND,
  )
  findOne(
    @CurrentUser() user: CurrentUserPayload,
    @Param('id') id: string,
  ): Promise<SupervisionAssignmentResponseDto> {
    return this.service.findOne(user, id);
  }

  @Post('supervision-assignments')
  @ApiOperation({
    summary:
      '建分管(supervisor × org × scopeMode + 任期;与职务正交,不要求 supervisor 持职务) [rbac: supervision-assignment.create.record]',
  })
  @ApiWrappedCreatedResponse(SupervisionAssignmentResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.MEMBER_NOT_FOUND,
    BizCode.MEMBER_INACTIVE,
    BizCode.ORGANIZATION_NOT_FOUND,
    BizCode.ORGANIZATION_INACTIVE,
    BizCode.SUPERVISION_ASSIGNMENT_TENURE_INVALID,
    BizCode.SUPERVISION_ALREADY_EXISTS,
  )
  create(
    @CurrentUser() user: CurrentUserPayload,
    @Body() dto: CreateSupervisionAssignmentDto,
    @Req() req: Request,
  ): Promise<SupervisionAssignmentResponseDto> {
    return this.service.create(user, dto, buildAuditMeta(req));
  }

  // ============ 队员轴:分管范围 ============

  @Get('members/:memberId/supervision-scope')
  @ApiOperation({
    summary:
      '某分管人的分管范围(TREE 经 closure 展开含全部后代 / EXACT 仅该节点;展示读非判权) [rbac: supervision-assignment.read.record]',
  })
  @ApiWrappedArrayResponse(SupervisionScopeEntryDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.MEMBER_NOT_FOUND,
  )
  supervisionScope(
    @CurrentUser() user: CurrentUserPayload,
    @Param('memberId') memberId: string,
  ): Promise<SupervisionScopeEntryDto[]> {
    return this.service.getSupervisionScope(user, memberId);
  }

  // ============ 组织轴:被谁分管 ============

  @Get('organizations/:orgId/supervisors')
  @ApiOperation({
    summary:
      '某组织被谁分管(直接分管 + 祖先 TREE 继承覆盖,标 coverage;展示读 closure 非判权) [rbac: supervision-assignment.read.record]',
  })
  @ApiWrappedArrayResponse(OrganizationSupervisorDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ORGANIZATION_NOT_FOUND,
  )
  supervisors(
    @CurrentUser() user: CurrentUserPayload,
    @Param('orgId') orgId: string,
  ): Promise<OrganizationSupervisorDto[]> {
    return this.service.getSupervisors(user, orgId);
  }

  // ============ 扁平:改 / 撤销 ============

  @Patch('supervision-assignments/:id')
  @ApiOperation({
    summary:
      '改分管(scopeMode / 任期 / note;不可改 supervisor/organization) [rbac: supervision-assignment.update.record]',
  })
  @ApiWrappedOkResponse(SupervisionAssignmentResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.SUPERVISION_ASSIGNMENT_NOT_FOUND,
    BizCode.SUPERVISION_ASSIGNMENT_TENURE_INVALID,
  )
  update(
    @CurrentUser() user: CurrentUserPayload,
    @Param('id') id: string,
    @Body() dto: UpdateSupervisionAssignmentDto,
  ): Promise<SupervisionAssignmentResponseDto> {
    return this.service.update(user, id, dto);
  }

  @Post('supervision-assignments/:id/revoke')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      '撤销分管(status=REVOKED + 撤销人 + endedAt) [rbac: supervision-assignment.revoke.record]',
  })
  @ApiWrappedOkResponse(SupervisionAssignmentResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.SUPERVISION_ASSIGNMENT_NOT_FOUND,
    BizCode.SUPERVISION_ASSIGNMENT_ALREADY_ENDED,
  )
  revoke(
    @CurrentUser() user: CurrentUserPayload,
    @Param('id') id: string,
    @Req() req: Request,
  ): Promise<SupervisionAssignmentResponseDto> {
    return this.service.revoke(user, id, buildAuditMeta(req));
  }
}
