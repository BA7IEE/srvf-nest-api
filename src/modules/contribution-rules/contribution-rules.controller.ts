import {
  Body,
  Controller,
  Delete,
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
  ApiNoContentResponse,
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
  ContributionRuleQueryDto,
  ContributionRuleResponseDto,
  CreateContributionRuleDto,
  UpdateContributionRuleDto,
} from './contribution-rules.dto';
import { ContributionRulesService } from './contribution-rules.service';

// V2 第一阶段批次 5-A contribution_rules controller(5 路由)。
// 路径前缀:全局 /api(main.ts)+ 'system/v1/contribution-rules'(决议 E1;Route B 终态)。
//
// **权限标注**(P0-F PR-2A,2026-05-18):入口仅 JwtAuthGuard,**不**挂 `@Roles(...)`;
// 全部判权迁移到 ContributionRulesService 内 `rbac.can()`,失败抛
// BizException(BizCode.RBAC_FORBIDDEN)(30100)。沿 PR-1 attachments F3 v1.0 范本。
// 映射 seed 新增 4 条权限点:contribution.{read,create,update,delete}.rule。
// APD 部门部长 / 副部长专属权限留 5-B 独立批次(F3)。

@ApiTags('Ops - Contribution Rules')
@ApiBearerAuth()
@Controller('system/v1/contribution-rules')
export class ContributionRulesController {
  constructor(private readonly service: ContributionRulesService) {}

  // V2 批次 6 PR #3:从 @Req() 构造 AuditMeta 显式传给 service(D6 v1.1 §11.2 / D8 拍板;
  // 不引入 cls-rs / AsyncLocalStorage)。仅供本 controller 写操作内部复用。
  private buildAuditMeta(req: Request): AuditMeta {
    return {
      requestId: req.id as string,
      ip: req.ip ?? null,
      ua: req.headers['user-agent'] ?? null,
    };
  }

  @Get()
  @ApiOperation({
    summary:
      '列出贡献值规则(分页 + 过滤 activityTypeCode / attendanceRoleCode / status;沿基础稳定排序) [rbac: contribution.read.rule]',
  })
  @ApiWrappedPageResponse(ContributionRuleResponseDto)
  @ApiBizErrorResponse(BizCode.BAD_REQUEST, BizCode.UNAUTHORIZED, BizCode.RBAC_FORBIDDEN)
  list(
    @CurrentUser() currentUser: CurrentUserPayload,
    @Query() query: ContributionRuleQueryDto,
  ): Promise<PageResultDto<ContributionRuleResponseDto>> {
    return this.service.list(currentUser, query);
  }

  @Post()
  @ApiOperation({
    summary:
      '创建贡献值规则(字典校验 + 字段语义 + ACTIVE 唯一性兜底含 NULL durationThreshold) [rbac: contribution.create.rule]',
  })
  @ApiWrappedCreatedResponse(ContributionRuleResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.CONTRIBUTION_RULE_ACTIVE_DUPLICATE,
    BizCode.CONTRIBUTION_RULE_POINTS_INVALID,
    BizCode.CONTRIBUTION_RULE_ACTIVITY_TYPE_INVALID,
    BizCode.CONTRIBUTION_RULE_ROLE_CODE_INVALID,
  )
  create(
    @Body() dto: CreateContributionRuleDto,
    @CurrentUser() currentUser: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<ContributionRuleResponseDto> {
    return this.service.create(dto, currentUser, this.buildAuditMeta(req));
  }

  @Get(':id')
  @ApiOperation({ summary: '贡献值规则详情(含软删返 404) [rbac: contribution.read.rule]' })
  @ApiWrappedOkResponse(ContributionRuleResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.CONTRIBUTION_RULE_NOT_FOUND,
  )
  findOne(
    @CurrentUser() currentUser: CurrentUserPayload,
    @Param() params: IdParamDto,
  ): Promise<ContributionRuleResponseDto> {
    return this.service.findOne(currentUser, params.id);
  }

  @Patch(':id')
  @ApiOperation({
    summary:
      '部分更新贡献值规则(白名单仅 pointsBelow / pointsAbove / status / remark;禁改 activityTypeCode / attendanceRoleCode / durationThreshold,由 ValidationPipe 拦截抛 40000) [rbac: contribution.update.rule]',
  })
  @ApiWrappedOkResponse(ContributionRuleResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.CONTRIBUTION_RULE_NOT_FOUND,
    BizCode.CONTRIBUTION_RULE_ACTIVE_DUPLICATE,
    BizCode.CONTRIBUTION_RULE_POINTS_INVALID,
  )
  update(
    @Param() params: IdParamDto,
    @Body() dto: UpdateContributionRuleDto,
    @CurrentUser() currentUser: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<ContributionRuleResponseDto> {
    return this.service.update(params.id, dto, currentUser, this.buildAuditMeta(req));
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary:
      '软删贡献值规则(写 deletedAt + deletedByUserId;不强制改 status;删完该维度 attendance 预填走 22048 不抛错路径) [rbac: contribution.delete.rule]',
  })
  @ApiNoContentResponse()
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.CONTRIBUTION_RULE_NOT_FOUND,
  )
  softDelete(
    @Param() params: IdParamDto,
    @CurrentUser() currentUser: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<void> {
    return this.service.softDelete(params.id, currentUser, this.buildAuditMeta(req));
  }
}
