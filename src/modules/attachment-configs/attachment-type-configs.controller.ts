import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiExtraModels, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
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
import { Roles } from '../../common/decorators/roles.decorator';
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
//   GET    /api/v2/attachment-type-configs              列表(分页 + status / ownerTable 过滤)
//   POST   /api/v2/attachment-type-configs              创建
//   GET    /api/v2/attachment-type-configs/:id          详情
//   PATCH  /api/v2/attachment-type-configs/:id          更新(仅资料字段;严禁 code / status)
//   PATCH  /api/v2/attachment-type-configs/:id/status   独立改 status(沿 dictionaries 范式)
//   DELETE /api/v2/attachment-type-configs/:id          软删 + 同步置 INACTIVE
//
// **权限标注**(F4 v1.0 锁):全部使用 @Roles(Role.SUPER_ADMIN, Role.ADMIN);**不接 rbac.can()**
//(配置三表是系统配置 / 运维能力,不为其单设 rbac.config.* 权限点;详见 D7 v1.0 §5.2 + §16 F4)。

@ApiTags('attachment-configs')
@ApiBearerAuth()
@ApiExtraModels(AttachmentTypeConfigResponseDto)
@Controller('v2/attachment-type-configs')
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
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @ApiOperation({
    summary: '列出附件类型配置(分页;可选 status / ownerTable 过滤;默认排序 createdAt DESC)',
  })
  @ApiWrappedPageResponse(AttachmentTypeConfigResponseDto)
  @ApiBizErrorResponse(BizCode.BAD_REQUEST, BizCode.UNAUTHORIZED, BizCode.FORBIDDEN)
  list(
    @Query() query: ListAttachmentTypeConfigsQueryDto,
  ): Promise<PageResultDto<AttachmentTypeConfigResponseDto>> {
    return this.service.list(query);
  }

  @Post()
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @ApiOperation({
    summary:
      '创建附件类型配置(code 全局唯一 / kebab-case 3-32;失败抛 13023 / 13021;status 默认 ACTIVE)',
  })
  @ApiWrappedOkResponse(AttachmentTypeConfigResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
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
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @ApiOperation({ summary: '附件类型配置详情(不存在 / 已软删统一返 13020)' })
  @ApiWrappedOkResponse(AttachmentTypeConfigResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.ATTACHMENT_TYPE_CONFIG_NOT_FOUND,
  )
  getById(@Param() params: IdParamDto): Promise<AttachmentTypeConfigResponseDto> {
    return this.service.getById(params.id);
  }

  @Patch(':id')
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @ApiOperation({
    summary:
      '更新附件类型配置(仅 displayName / description / ownerTable / defaultMaxSizeBytes / defaultMimeWhitelist;**禁止** code / status / deletedAt / id)',
  })
  @ApiWrappedOkResponse(AttachmentTypeConfigResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
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
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @ApiOperation({ summary: '更新附件类型配置启停状态(沿 dictionaries 独立 status 端点范式)' })
  @ApiWrappedOkResponse(AttachmentTypeConfigResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.ATTACHMENT_TYPE_CONFIG_NOT_FOUND,
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
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @ApiOperation({
    summary: '软删附件类型配置(deletedAt = now() + 同步置 status=INACTIVE;Q7 v1.0:不查跨表引用)',
  })
  @ApiWrappedOkResponse(AttachmentTypeConfigResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.ATTACHMENT_TYPE_CONFIG_NOT_FOUND,
  )
  softDelete(
    @Param() params: IdParamDto,
    @CurrentUser() currentUser: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<AttachmentTypeConfigResponseDto> {
    return this.service.softDelete(params.id, currentUser, this.buildAuditMeta(req));
  }
}
