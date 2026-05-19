import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiExtraModels, ApiOperation, ApiTags } from '@nestjs/swagger';
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
  AttachmentSizeLimitConfigResponseDto,
  AttachmentSizeLimitConfigTypeConfigSummaryDto,
  CreateAttachmentSizeLimitConfigDto,
  ListAttachmentSizeLimitConfigsQueryDto,
  UpdateAttachmentSizeLimitConfigDto,
} from './attachment-size-limit-configs.dto';
import { AttachmentSizeLimitConfigsService } from './attachment-size-limit-configs.service';

// V2.x C-7 attachments 实施 PR #5(2026-05-15):AttachmentSizeLimitConfig 模块 Controller。
// **5 个端点**(Q1 v1.0:本表无 status 字段,无独立 status 端点):
//   GET    /api/v2/attachment-size-limit-configs              列表(分页 + typeConfigId 过滤)
//   POST   /api/v2/attachment-size-limit-configs              创建(1:1 与 typeConfig)
//   GET    /api/v2/attachment-size-limit-configs/:id          详情
//   PATCH  /api/v2/attachment-size-limit-configs/:id          更新(仅 maxSizeBytes / remark)
//   DELETE /api/v2/attachment-size-limit-configs/:id          软删
//
// **权限标注**(P0-F PR-2B,2026-05-18;撤销 F4 v1.0 "不接 rbac.can()" 锁):
// 入口仅 JwtAuthGuard,**不**挂 `@Roles(...)`;全部判权迁移到 Service 内 `rbac.can()`,
// 失败抛 BizException(BizCode.RBAC_FORBIDDEN)(30100)。沿 PR-2A 范本。
// 映射 seed 新增 4 条权限点:attachment-config.{read,create,update,delete}.size-limit。
// (本表无 status 端点;5 端点共用 4 个 permission code)

@ApiTags('Ops - Attachment Configs')
@ApiBearerAuth()
@ApiExtraModels(AttachmentSizeLimitConfigResponseDto, AttachmentSizeLimitConfigTypeConfigSummaryDto)
@Controller('v2/attachment-size-limit-configs')
export class AttachmentSizeLimitConfigsController {
  constructor(private readonly service: AttachmentSizeLimitConfigsService) {}

  // PR #6d:沿 type-configs / mime-configs.controller / cert / emergency 范式
  // (D6 v1.1 §11.2 / D8 锁:不引入 cls-rs / AsyncLocalStorage)。
  private buildAuditMeta(req: Request): AuditMeta {
    return {
      requestId: req.id as string,
      ip: req.ip ?? null,
      ua: req.headers['user-agent'] ?? null,
    };
  }

  @Get()
  @ApiOperation({
    summary: '列出附件尺寸限制配置(分页;可选 typeConfigId 过滤;默认排序 createdAt DESC)',
  })
  @ApiWrappedPageResponse(AttachmentSizeLimitConfigResponseDto)
  @ApiBizErrorResponse(BizCode.BAD_REQUEST, BizCode.UNAUTHORIZED, BizCode.RBAC_FORBIDDEN)
  list(
    @CurrentUser() currentUser: CurrentUserPayload,
    @Query() query: ListAttachmentSizeLimitConfigsQueryDto,
  ): Promise<PageResultDto<AttachmentSizeLimitConfigResponseDto>> {
    return this.service.list(currentUser, query);
  }

  @Post()
  @ApiOperation({
    summary:
      '创建附件尺寸限制配置(1:1 与 typeConfig;typeConfigId 不存在 → 13020;重复 → 13027;含软删历史)',
  })
  @ApiWrappedOkResponse(AttachmentSizeLimitConfigResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ATTACHMENT_TYPE_CONFIG_NOT_FOUND,
    BizCode.ATTACHMENT_SIZE_LIMIT_CONFIG_ALREADY_EXISTS,
  )
  create(
    @Body() dto: CreateAttachmentSizeLimitConfigDto,
    @CurrentUser() currentUser: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<AttachmentSizeLimitConfigResponseDto> {
    return this.service.create(dto, currentUser, this.buildAuditMeta(req));
  }

  @Get(':id')
  @ApiOperation({ summary: '附件尺寸限制配置详情(不存在 / 已软删统一返 13026)' })
  @ApiWrappedOkResponse(AttachmentSizeLimitConfigResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ATTACHMENT_SIZE_LIMIT_CONFIG_NOT_FOUND,
  )
  getById(
    @CurrentUser() currentUser: CurrentUserPayload,
    @Param() params: IdParamDto,
  ): Promise<AttachmentSizeLimitConfigResponseDto> {
    return this.service.getById(currentUser, params.id);
  }

  @Patch(':id')
  @ApiOperation({
    summary:
      '更新附件尺寸限制配置(仅 maxSizeBytes / remark;**禁止** typeConfigId(Q4 PR #4)/ deletedAt / id;Q5 v1.0:maxSizeBytes 不允许 null)',
  })
  @ApiWrappedOkResponse(AttachmentSizeLimitConfigResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ATTACHMENT_SIZE_LIMIT_CONFIG_NOT_FOUND,
  )
  update(
    @Param() params: IdParamDto,
    @Body() dto: UpdateAttachmentSizeLimitConfigDto,
    @CurrentUser() currentUser: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<AttachmentSizeLimitConfigResponseDto> {
    return this.service.update(params.id, dto, currentUser, this.buildAuditMeta(req));
  }

  @Delete(':id')
  @ApiOperation({
    summary:
      '软删附件尺寸限制配置(deletedAt = now();本表无 status 字段不需要同步置;V2.x Slow-6:同 type 仍被附件引用时返 13032)',
  })
  @ApiWrappedOkResponse(AttachmentSizeLimitConfigResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ATTACHMENT_SIZE_LIMIT_CONFIG_NOT_FOUND,
    BizCode.ATTACHMENT_SIZE_LIMIT_CONFIG_IN_USE,
  )
  softDelete(
    @Param() params: IdParamDto,
    @CurrentUser() currentUser: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<AttachmentSizeLimitConfigResponseDto> {
    return this.service.softDelete(params.id, currentUser, this.buildAuditMeta(req));
  }
}
