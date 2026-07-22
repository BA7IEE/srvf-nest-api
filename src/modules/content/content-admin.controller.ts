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
  Put,
  Query,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiExtraModels, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import {
  ApiWrappedCreatedResponse,
  ApiBizErrorResponse,
  ApiWrappedNullResponse,
  ApiWrappedOkResponse,
  ApiWrappedPageResponse,
} from '../../common/decorators/api-response.decorator';
import {
  CurrentUser,
  type CurrentUserPayload,
} from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { AttachmentResponseDto, UploadUrlResponseDto } from '../attachments/attachments.dto';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import {
  ContentAdminDetailDto,
  ContentAdminListItemDto,
  ContentAttachmentConfirmDto,
  ContentAttachmentDto,
  ContentAttachmentUploadUrlDto,
  CreateContentDto,
  ListContentAdminQueryDto,
  SetContentCoverDto,
  UpdateContentDto,
} from './content.dto';
import { ContentService } from './content.service';

// CMS 内容发布模块(第 28 模块)T2(2026-06-21):content admin surface(评审稿 §8 端点 1-12)。
// 入口仅 JwtAuthGuard(全局),**不**挂 @Roles;判权全在 service rbac.can()(R 模式)。
// 附件端点(upload-url/confirm/删/封面)挂本 controller;写路径附件 RBAC 由 AttachmentsService 强制
// (attachment.{upload,delete}.content-*),confirm 仅 JWT + token 校验(无静态可绑码 → [auth])。

function buildAuditMeta(req: Request): AuditMeta {
  return {
    requestId: req.id as string,
    ip: req.ip ?? null,
    ua: req.headers['user-agent'] ?? null,
  };
}

@ApiTags('Admin - Content')
@ApiBearerAuth()
@ApiExtraModels(
  ContentAdminDetailDto,
  ContentAdminListItemDto,
  ContentAttachmentDto,
  UploadUrlResponseDto,
  AttachmentResponseDto,
)
@Controller('admin/v1/contents')
export class ContentAdminController {
  constructor(private readonly service: ContentService) {}

  @Post()
  @ApiOperation({ summary: '新建内容草稿(create → draft) [rbac: content.create.record]' })
  @ApiWrappedCreatedResponse(ContentAdminDetailDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.CONTENT_TYPE_INVALID,
    BizCode.CONTENT_VISIBLE_ORG_INVALID,
  )
  create(
    @Body() dto: CreateContentDto,
    @CurrentUser() user: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<ContentAdminDetailDto> {
    return this.service.create(dto, user, buildAuditMeta(req));
  }

  @Get()
  @ApiOperation({
    summary:
      '内容分页列表(status/type/visibility/keyword/tags/pinned 过滤;admin 见全部状态全可见档) [rbac: content.read.record]',
  })
  @ApiWrappedPageResponse(ContentAdminListItemDto)
  @ApiBizErrorResponse(BizCode.UNAUTHORIZED, BizCode.RBAC_FORBIDDEN)
  list(@Query() query: ListContentAdminQueryDto, @CurrentUser() user: CurrentUserPayload) {
    return this.service.list(query, user);
  }

  @Get(':id')
  @ApiOperation({
    summary:
      '内容详情(含附件签名 URL + 正文占位改写 + viewCount〔不自增〕) [rbac: content.read.record]',
  })
  @ApiWrappedOkResponse(ContentAdminDetailDto)
  @ApiBizErrorResponse(BizCode.UNAUTHORIZED, BizCode.RBAC_FORBIDDEN, BizCode.CONTENT_NOT_FOUND)
  detail(
    @Param('id') id: string,
    @CurrentUser() user: CurrentUserPayload,
  ): Promise<ContentAdminDetailDto> {
    return this.service.detail(id, user);
  }

  @Patch(':id')
  @ApiOperation({
    summary: '更新内容(draft/published 可改,archived 冻结 → 29030) [rbac: content.update.record]',
  })
  @ApiWrappedOkResponse(ContentAdminDetailDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.CONTENT_NOT_FOUND,
    BizCode.CONTENT_TYPE_INVALID,
    BizCode.CONTENT_VISIBLE_ORG_INVALID,
    BizCode.CONTENT_INVALID_STATUS_TRANSITION,
  )
  update(
    @Param('id') id: string,
    @Body() dto: UpdateContentDto,
    @CurrentUser() user: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<ContentAdminDetailDto> {
    return this.service.update(id, dto, user, buildAuditMeta(req));
  }

  @Delete(':id')
  @ApiOperation({ summary: '软删内容(任意态) [rbac: content.delete.record]' })
  @ApiWrappedNullResponse()
  @ApiBizErrorResponse(BizCode.UNAUTHORIZED, BizCode.RBAC_FORBIDDEN, BizCode.CONTENT_NOT_FOUND)
  @HttpCode(HttpStatus.OK)
  async remove(
    @Param('id') id: string,
    @CurrentUser() user: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<null> {
    await this.service.softDelete(id, user, buildAuditMeta(req));
    return null;
  }

  @Post(':id/publish')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '发布内容(draft → published,置 publishedAt) [rbac: content.publish.record]',
  })
  @ApiWrappedOkResponse(ContentAdminDetailDto)
  @ApiBizErrorResponse(
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.CONTENT_NOT_FOUND,
    BizCode.CONTENT_INVALID_STATUS_TRANSITION,
  )
  publish(
    @Param('id') id: string,
    @CurrentUser() user: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<ContentAdminDetailDto> {
    return this.service.publish(id, user, buildAuditMeta(req));
  }

  @Post(':id/unpublish')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '撤回内容(published → draft,保留 publishedAt) [rbac: content.publish.record]',
  })
  @ApiWrappedOkResponse(ContentAdminDetailDto)
  @ApiBizErrorResponse(
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.CONTENT_NOT_FOUND,
    BizCode.CONTENT_INVALID_STATUS_TRANSITION,
  )
  unpublish(
    @Param('id') id: string,
    @CurrentUser() user: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<ContentAdminDetailDto> {
    return this.service.unpublish(id, user, buildAuditMeta(req));
  }

  @Post(':id/archive')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '归档内容(published → archived,终态不可逆) [rbac: content.publish.record]',
  })
  @ApiWrappedOkResponse(ContentAdminDetailDto)
  @ApiBizErrorResponse(
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.CONTENT_NOT_FOUND,
    BizCode.CONTENT_INVALID_STATUS_TRANSITION,
  )
  archive(
    @Param('id') id: string,
    @CurrentUser() user: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<ContentAdminDetailDto> {
    return this.service.archive(id, user, buildAuditMeta(req));
  }

  @Post(':id/attachments/upload-url')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      '取附件上传 URL(kind=image|file;先验内容存在;附件写权由 AttachmentsService 判) [rbac: attachment.upload.*]',
  })
  @ApiWrappedOkResponse(UploadUrlResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.CONTENT_NOT_FOUND,
    BizCode.ATTACHMENT_OWNER_TYPE_INVALID,
    BizCode.ATTACHMENT_MIME_NOT_ALLOWED,
    BizCode.ATTACHMENT_SIZE_EXCEEDED,
    BizCode.ATTACHMENT_PII_DETECTED,
    BizCode.ATTACHMENT_SYSTEM_MIME_BLOCKED,
  )
  uploadUrl(
    @Param('id') id: string,
    @Body() dto: ContentAttachmentUploadUrlDto,
    @CurrentUser() user: CurrentUserPayload,
  ): Promise<UploadUrlResponseDto> {
    return this.service.createAttachmentUploadUrl(id, dto, user);
  }

  @Post(':id/attachments/confirm')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      '确认附件上传(token 校验 + headObject;落 Attachment 行 + audit attachment.upload) [auth]',
  })
  @ApiWrappedOkResponse(AttachmentResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.CONTENT_NOT_FOUND,
    BizCode.ATTACHMENT_NOT_FOUND,
    BizCode.ATTACHMENT_SIZE_EXCEEDED,
    BizCode.ATTACHMENT_OWNER_NOT_FOUND,
  )
  confirm(
    @Param('id') id: string,
    @Body() dto: ContentAttachmentConfirmDto,
    @CurrentUser() user: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<AttachmentResponseDto> {
    return this.service.confirmAttachmentUpload(id, dto, user, buildAuditMeta(req));
  }

  @Delete(':id/attachments/:attachmentId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      '删内容附件(先验归属本文章,再物理删 + audit attachment.delete) [rbac: attachment.delete.*]',
  })
  @ApiWrappedNullResponse()
  @ApiBizErrorResponse(BizCode.UNAUTHORIZED, BizCode.RBAC_FORBIDDEN, BizCode.CONTENT_NOT_FOUND)
  async removeAttachment(
    @Param('id') id: string,
    @Param('attachmentId') attachmentId: string,
    @CurrentUser() user: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<null> {
    await this.service.deleteAttachment(id, attachmentId, user, buildAuditMeta(req));
    return null;
  }

  @Put(':id/cover')
  @ApiOperation({
    summary:
      '设 / 清封面({attachmentId|null};非本文章 content-image 附件 → 404) [rbac: content.update.record]',
  })
  @ApiWrappedOkResponse(ContentAdminDetailDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.CONTENT_NOT_FOUND,
  )
  setCover(
    @Param('id') id: string,
    @Body() dto: SetContentCoverDto,
    @CurrentUser() user: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<ContentAdminDetailDto> {
    return this.service.setCover(id, dto, user, buildAuditMeta(req));
  }
}
