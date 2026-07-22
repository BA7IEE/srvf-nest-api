import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiExtraModels, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import {
  ApiWrappedCreatedResponse,
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
  AttachmentTypeConfigResponseDto,
  CreateAttachmentTypeConfigDto,
  ListAttachmentTypeConfigsQueryDto,
  UpdateAttachmentTypeConfigDto,
  UpdateAttachmentTypeConfigStatusDto,
} from './attachment-type-configs.dto';
import { AttachmentTypeConfigsService } from './attachment-type-configs.service';

// V2.x C-7 attachments 实施 PR #3(2026-05-15):AttachmentTypeConfig 模块 Controller。
// 6 个端点(沿 D7 v1.0 §5.2.1 端点 8-12 + Q5 v1.0 拍板:增加独立 status 端点):
//   GET    /api/system/v1/attachment-type-configs              列表(分页 + status / ownerTable 过滤)
//   POST   /api/system/v1/attachment-type-configs              创建
//   GET    /api/system/v1/attachment-type-configs/:id          详情
//   PATCH  /api/system/v1/attachment-type-configs/:id          更新(仅资料字段;严禁 code / status)
//   PATCH  /api/system/v1/attachment-type-configs/:id/status   独立改 status(沿 dictionaries 范式)
//   DELETE /api/system/v1/attachment-type-configs/:id          软删 + 同步置 INACTIVE
//
// **权限标注**(P0-F PR-2B,2026-05-18;撤销 F4 v1.0 "不接 rbac.can()" 锁):
// 入口仅 JwtAuthGuard,**不**挂 `@Roles(...)`;全部判权迁移到 Service 内 `rbac.can()`,
// 失败抛 BizException(BizCode.RBAC_FORBIDDEN)(30100)。沿 PR-2A dict / org / contrib-rule 范本。
// 映射 seed 新增 4 条权限点:attachment-config.{read,create,update,delete}.type。
// (status 端点共用 attachment-config.update.type;沿 PR-2A dict-type update.* 范式)

@ApiTags('Ops - Attachment Configs')
@ApiBearerAuth()
@ApiExtraModels(AttachmentTypeConfigResponseDto)
@Controller('system/v1/attachment-type-configs')
export class AttachmentTypeConfigsController {
  constructor(private readonly service: AttachmentTypeConfigsService) {}

  // PR #6d:沿 cert / emergency-contacts / activities / attachments 范式
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
    summary:
      '列出附件类型配置(分页;可选 status / ownerTable 过滤;默认排序 createdAt DESC) [rbac: attachment-config.read.type]',
  })
  @ApiWrappedPageResponse(AttachmentTypeConfigResponseDto)
  @ApiBizErrorResponse(BizCode.BAD_REQUEST, BizCode.UNAUTHORIZED, BizCode.RBAC_FORBIDDEN)
  list(
    @CurrentUser() currentUser: CurrentUserPayload,
    @Query() query: ListAttachmentTypeConfigsQueryDto,
  ): Promise<PageResultDto<AttachmentTypeConfigResponseDto>> {
    return this.service.list(currentUser, query);
  }

  @Post()
  @ApiOperation({
    summary:
      '创建附件类型配置(code 全局唯一 / kebab-case 3-32;失败抛 13023 / 13021;status 默认 ACTIVE) [rbac: attachment-config.create.type]',
  })
  @ApiWrappedCreatedResponse(AttachmentTypeConfigResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.INVALID_ATTACHMENT_TYPE_CONFIG_CODE_FORMAT,
    BizCode.ATTACHMENT_TYPE_CONFIG_CODE_ALREADY_EXISTS,
  )
  create(
    @Body() dto: CreateAttachmentTypeConfigDto,
    @CurrentUser() currentUser: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<AttachmentTypeConfigResponseDto> {
    return this.service.create(dto, currentUser, this.buildAuditMeta(req));
  }

  @Get(':id')
  @ApiOperation({
    summary: '附件类型配置详情(不存在 / 已软删统一返 13020) [rbac: attachment-config.read.type]',
  })
  @ApiWrappedOkResponse(AttachmentTypeConfigResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ATTACHMENT_TYPE_CONFIG_NOT_FOUND,
  )
  getById(
    @CurrentUser() currentUser: CurrentUserPayload,
    @Param() params: IdParamDto,
  ): Promise<AttachmentTypeConfigResponseDto> {
    return this.service.getById(currentUser, params.id);
  }

  @Patch(':id')
  @ApiOperation({
    summary:
      '更新附件类型配置(仅 displayName / description / ownerTable / defaultMaxSizeBytes / defaultMimeWhitelist;**禁止** code / status / deletedAt / id) [rbac: attachment-config.update.type]',
  })
  @ApiWrappedOkResponse(AttachmentTypeConfigResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ATTACHMENT_TYPE_CONFIG_NOT_FOUND,
  )
  update(
    @Param() params: IdParamDto,
    @Body() dto: UpdateAttachmentTypeConfigDto,
    @CurrentUser() currentUser: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<AttachmentTypeConfigResponseDto> {
    return this.service.update(params.id, dto, currentUser, this.buildAuditMeta(req));
  }

  @Patch(':id/status')
  @ApiOperation({
    summary:
      '更新附件类型配置启停状态(沿 dictionaries 独立 status 端点范式;V2.x Slow-6:ACTIVE → INACTIVE 仍被附件引用时返 13030) [rbac: attachment-config.update.type]',
  })
  @ApiWrappedOkResponse(AttachmentTypeConfigResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ATTACHMENT_TYPE_CONFIG_NOT_FOUND,
    BizCode.ATTACHMENT_TYPE_IN_USE,
  )
  updateStatus(
    @Param() params: IdParamDto,
    @Body() dto: UpdateAttachmentTypeConfigStatusDto,
    @CurrentUser() currentUser: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<AttachmentTypeConfigResponseDto> {
    return this.service.updateStatus(params.id, dto, currentUser, this.buildAuditMeta(req));
  }

  @Delete(':id')
  @ApiOperation({
    summary:
      '软删附件类型配置(deletedAt = now() + 同步置 status=INACTIVE;V2.x Slow-6:仍被附件引用时返 13030) [rbac: attachment-config.delete.type]',
  })
  @ApiWrappedOkResponse(AttachmentTypeConfigResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ATTACHMENT_TYPE_CONFIG_NOT_FOUND,
    BizCode.ATTACHMENT_TYPE_IN_USE,
  )
  softDelete(
    @Param() params: IdParamDto,
    @CurrentUser() currentUser: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<AttachmentTypeConfigResponseDto> {
    return this.service.softDelete(params.id, currentUser, this.buildAuditMeta(req));
  }
}
