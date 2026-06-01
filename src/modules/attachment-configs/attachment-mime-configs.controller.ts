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
  AttachmentMimeConfigResponseDto,
  AttachmentMimeConfigTypeConfigSummaryDto,
  CreateAttachmentMimeConfigDto,
  ListAttachmentMimeConfigsQueryDto,
  UpdateAttachmentMimeConfigDto,
  UpdateAttachmentMimeConfigStatusDto,
} from './attachment-mime-configs.dto';
import { AttachmentMimeConfigsService } from './attachment-mime-configs.service';

// V2.x C-7 attachments 实施 PR #4(2026-05-15):AttachmentMimeConfig 模块 Controller。
// 6 个端点(沿 D7 v1.0 §5.2.2 + PR #3 type config 范式 + Q5 v1.0 独立 status 端点):
//   GET    /api/v2/attachment-mime-configs              列表(分页 + typeConfigId / status / mime 过滤)
//   POST   /api/v2/attachment-mime-configs              创建
//   GET    /api/v2/attachment-mime-configs/:id          详情
//   PATCH  /api/v2/attachment-mime-configs/:id          更新(仅 remark)
//   PATCH  /api/v2/attachment-mime-configs/:id/status   独立改 status
//   DELETE /api/v2/attachment-mime-configs/:id          软删 + 同步置 INACTIVE
//
// **权限标注**(P0-F PR-2B,2026-05-18;撤销 F4 v1.0 "不接 rbac.can()" 锁):
// 入口仅 JwtAuthGuard,**不**挂 `@Roles(...)`;全部判权迁移到 Service 内 `rbac.can()`,
// 失败抛 BizException(BizCode.RBAC_FORBIDDEN)(30100)。沿 PR-2A dict / org / contrib-rule 范本。
// 映射 seed 新增 4 条权限点:attachment-config.{read,create,update,delete}.mime。
// (status 端点共用 attachment-config.update.mime;沿 PR-2A dict-item update.* 范式)

@ApiTags('Ops - Attachment Configs')
@ApiBearerAuth()
@ApiExtraModels(AttachmentMimeConfigResponseDto, AttachmentMimeConfigTypeConfigSummaryDto)
@Controller(['v2/attachment-mime-configs', 'system/v1/attachment-mime-configs'])
export class AttachmentMimeConfigsController {
  constructor(private readonly service: AttachmentMimeConfigsService) {}

  // PR #6d:沿 type-configs.controller / cert / emergency 范式(D6 v1.1 §11.2 / D8 锁)。
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
      '列出附件 MIME 配置(分页;可选 typeConfigId / status / mime 过滤;默认排序 createdAt DESC)',
  })
  @ApiWrappedPageResponse(AttachmentMimeConfigResponseDto)
  @ApiBizErrorResponse(BizCode.BAD_REQUEST, BizCode.UNAUTHORIZED, BizCode.RBAC_FORBIDDEN)
  list(
    @CurrentUser() currentUser: CurrentUserPayload,
    @Query() query: ListAttachmentMimeConfigsQueryDto,
  ): Promise<PageResultDto<AttachmentMimeConfigResponseDto>> {
    return this.service.list(currentUser, query);
  }

  @Post()
  @ApiOperation({
    summary:
      '创建附件 MIME 配置(typeConfigId 不存在 → 13020;mime 格式不合法 → 13025;(typeConfigId, mime) 重复 → 13024;含软删历史)',
  })
  @ApiWrappedOkResponse(AttachmentMimeConfigResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ATTACHMENT_TYPE_CONFIG_NOT_FOUND,
    BizCode.INVALID_ATTACHMENT_MIME_FORMAT,
    BizCode.ATTACHMENT_MIME_CONFIG_DUPLICATE,
  )
  create(
    @Body() dto: CreateAttachmentMimeConfigDto,
    @CurrentUser() currentUser: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<AttachmentMimeConfigResponseDto> {
    return this.service.create(dto, currentUser, this.buildAuditMeta(req));
  }

  @Get(':id')
  @ApiOperation({ summary: '附件 MIME 配置详情(不存在 / 已软删统一返 13022)' })
  @ApiWrappedOkResponse(AttachmentMimeConfigResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ATTACHMENT_MIME_CONFIG_NOT_FOUND,
  )
  getById(
    @CurrentUser() currentUser: CurrentUserPayload,
    @Param() params: IdParamDto,
  ): Promise<AttachmentMimeConfigResponseDto> {
    return this.service.getById(currentUser, params.id);
  }

  @Patch(':id')
  @ApiOperation({
    summary:
      '更新附件 MIME 配置(仅 remark;**禁止** mime(Q3 v1.0)/ typeConfigId(Q4 v1.0)/ status / deletedAt / id)',
  })
  @ApiWrappedOkResponse(AttachmentMimeConfigResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ATTACHMENT_MIME_CONFIG_NOT_FOUND,
  )
  update(
    @Param() params: IdParamDto,
    @Body() dto: UpdateAttachmentMimeConfigDto,
    @CurrentUser() currentUser: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<AttachmentMimeConfigResponseDto> {
    return this.service.update(params.id, dto, currentUser, this.buildAuditMeta(req));
  }

  @Patch(':id/status')
  @ApiOperation({
    summary:
      '更新附件 MIME 配置启停状态(沿 PR #3 type config status 端点范式;V2.x Slow-6:ACTIVE → INACTIVE 仍被附件引用时返 13031)',
  })
  @ApiWrappedOkResponse(AttachmentMimeConfigResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ATTACHMENT_MIME_CONFIG_NOT_FOUND,
    BizCode.ATTACHMENT_MIME_CONFIG_IN_USE,
  )
  updateStatus(
    @Param() params: IdParamDto,
    @Body() dto: UpdateAttachmentMimeConfigStatusDto,
    @CurrentUser() currentUser: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<AttachmentMimeConfigResponseDto> {
    return this.service.updateStatus(params.id, dto, currentUser, this.buildAuditMeta(req));
  }

  @Delete(':id')
  @ApiOperation({
    summary:
      '软删附件 MIME 配置(deletedAt = now() + 同步置 status=INACTIVE;V2.x Slow-6:仍被附件引用时返 13031)',
  })
  @ApiWrappedOkResponse(AttachmentMimeConfigResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ATTACHMENT_MIME_CONFIG_NOT_FOUND,
    BizCode.ATTACHMENT_MIME_CONFIG_IN_USE,
  )
  softDelete(
    @Param() params: IdParamDto,
    @CurrentUser() currentUser: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<AttachmentMimeConfigResponseDto> {
    return this.service.softDelete(params.id, currentUser, this.buildAuditMeta(req));
  }
}
