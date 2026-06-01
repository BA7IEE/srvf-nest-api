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
  AttachmentResponseDto,
  ConfirmUploadDto,
  CreateAttachmentDto,
  GenerateUploadUrlDto,
  ListAttachmentsByOwnerQueryDto,
  ListAttachmentsQueryDto,
  UpdateAttachmentDto,
  UploadUrlResponseDto,
} from './attachments.dto';
import { AttachmentsService } from './attachments.service';

// V2.x C-7 attachments 实施 PR #6b(2026-05-15):attachments 主模块 Controller。
//
// 端点(沿 D7-attachments v1.0 §5.1;**本 Controller 拆分后仅承载 8 个 Admin 端点**):
//   POST   /api/admin/v1/attachments                创建附件元数据
//   GET    /api/admin/v1/attachments                列表(分页;管理后台用;逐条 ownership 过滤)
//   POST   /api/admin/v1/attachments/upload-url     申请 signed upload URL(模式 B)
//   POST   /api/admin/v1/attachments/confirm-upload 确认上传完成(模式 B)
//   GET    /api/admin/v1/attachments/by-owner       按 ownerType+ownerId 列出(业务模块常用)
//   GET    /api/admin/v1/attachments/:id            详情
//   PATCH  /api/admin/v1/attachments/:id            更新 description / accessLevel / tags / expireAt
//   DELETE /api/admin/v1/attachments/:id            物理删(Q11 v1.0)
//
// **入口 Guard 统一 JwtAuthGuard**(F3 v1.0 锁;**不加** `@Roles(...)`):全部判权
//   在 Service 层 rbac.can();失败抛 30100 RBAC_FORBIDDEN(写) / 13001 ATTACHMENT_NOT_FOUND(读)。
//
// **路径顺序铁律**:`/by-owner` / `/upload-url` / `/confirm-upload` 必须放在 `/:id` 之前,避免被 :id 通配匹配。
//
// P1-C step 2(2026-05-21):Mixed Controller 物理拆分,把原 `GET /me/uploaded`(method-level
// 挂 `Mobile - Attachments` tag 的唯一端点)迁出到 AttachmentsMeLegacyController
// (controllers/attachments-me-legacy.controller.ts),沿 docs/api-surface-policy.md §5 项 4 +
// §7 P1-C step 2;endpoint path / DTO / service / Guard / RBAC / Swagger Tag 全部 zero drift。
// 本 Controller 拆分后 class-level @ApiTags 不再与 Mobile - Attachments 同存。
@ApiTags('Admin - Attachments')
@ApiBearerAuth()
@ApiExtraModels(AttachmentResponseDto, UploadUrlResponseDto)
@Controller('admin/v1/attachments')
export class AttachmentsController {
  constructor(private readonly service: AttachmentsService) {}

  // V2.x C-7 PR #6c:从 @Req() 构造 AuditMeta 显式传给 service(沿 cert / emergency-contacts /
  // activities 范式;D6 v1.1 §11.2 / D8 拍板:不引入 cls-rs / AsyncLocalStorage)。
  // 仅 create / delete 两个写端点需要(PR #6c 边界)。
  private buildAuditMeta(req: Request): AuditMeta {
    return {
      requestId: req.id as string,
      ip: req.ip ?? null,
      ua: req.headers['user-agent'] ?? null,
    };
  }

  @Post()
  @ApiOperation({
    summary:
      '创建附件元数据(校验:ownerType 13010 / ownerId 13011 / RBAC 30100 / 系统级 MIME 黑名单 13033 / mime 白名单未命中 13012 / size 13013 / PII 13015;V2.x L-1:系统级黑名单与白名单未命中拆码)',
  })
  @ApiWrappedOkResponse(AttachmentResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ATTACHMENT_OWNER_TYPE_INVALID,
    BizCode.ATTACHMENT_OWNER_NOT_FOUND,
    BizCode.ATTACHMENT_SYSTEM_MIME_BLOCKED,
    BizCode.ATTACHMENT_MIME_NOT_ALLOWED,
    BizCode.ATTACHMENT_SIZE_EXCEEDED,
    BizCode.ATTACHMENT_PII_DETECTED,
  )
  create(
    @Body() dto: CreateAttachmentDto,
    @CurrentUser() user: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<AttachmentResponseDto> {
    return this.service.create(dto, user, this.buildAuditMeta(req));
  }

  @Get()
  @ApiOperation({
    summary:
      '列出附件(分页;可选 ownerType / ownerId / uploadedBy / mime / accessLevel / tags 过滤;tags OR 语义;total 按可见数量返;默认排序 createdAt DESC)',
  })
  @ApiWrappedPageResponse(AttachmentResponseDto)
  @ApiBizErrorResponse(BizCode.BAD_REQUEST, BizCode.UNAUTHORIZED)
  list(
    @Query() query: ListAttachmentsQueryDto,
    @CurrentUser() user: CurrentUserPayload,
  ): Promise<PageResultDto<AttachmentResponseDto>> {
    return this.service.list(query, user);
  }

  // V2.x C-7.5 PR #10:upload-url + confirm-upload(沿评审 §8.1 / §8.2 / §8.3 / §8.4)
  // 路径顺序铁律:字面段优先,必须放在 `:id` 之前(沿 §8.2)
  @Post('upload-url')
  @ApiOperation({
    summary:
      '申请 signed upload URL(模式 B;校验 ownerType/ownerId/mime/size/PII/RBAC;系统级 MIME 黑名单 → 13033 / 白名单未命中 → 13012;返 uploadUrl + uploadToken;不落库;不审计;沿 §8.3 v1.0 + V2.x L-1)',
  })
  @ApiWrappedOkResponse(UploadUrlResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ATTACHMENT_OWNER_TYPE_INVALID,
    BizCode.ATTACHMENT_OWNER_NOT_FOUND,
    BizCode.ATTACHMENT_SYSTEM_MIME_BLOCKED,
    BizCode.ATTACHMENT_MIME_NOT_ALLOWED,
    BizCode.ATTACHMENT_SIZE_EXCEEDED,
    BizCode.ATTACHMENT_PII_DETECTED,
  )
  createUploadUrl(
    @Body() dto: GenerateUploadUrlDto,
    @CurrentUser() user: CurrentUserPayload,
  ): Promise<UploadUrlResponseDto> {
    return this.service.createUploadUrl(dto, user);
  }

  @Post('confirm-upload')
  @ApiOperation({
    summary:
      '确认上传完成(模式 B;验 uploadToken + headObject + size 一致 → 落库 + audit attachment.upload;沿 §8.4 v1.0)',
  })
  @ApiWrappedOkResponse(AttachmentResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ATTACHMENT_NOT_FOUND,
    BizCode.ATTACHMENT_SIZE_EXCEEDED,
  )
  confirmUpload(
    @Body() dto: ConfirmUploadDto,
    @CurrentUser() user: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<AttachmentResponseDto> {
    return this.service.confirmUpload(dto, user, this.buildAuditMeta(req));
  }

  @Get('by-owner')
  @ApiOperation({
    summary:
      '按 ownerType + ownerId 列出某业务对象的全部附件(业务模块常用入口;ownerType / ownerId 必填;逐条 ownership 过滤)',
  })
  @ApiWrappedPageResponse(AttachmentResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.ATTACHMENT_OWNER_TYPE_INVALID,
    BizCode.ATTACHMENT_OWNER_NOT_FOUND,
  )
  listByOwner(
    @Query() query: ListAttachmentsByOwnerQueryDto,
    @CurrentUser() user: CurrentUserPayload,
  ): Promise<PageResultDto<AttachmentResponseDto>> {
    return this.service.listByOwner(query, user);
  }

  @Get(':id')
  @ApiOperation({
    summary: '附件详情(不存在 / 无权统一返 13001;Q13 v1.0 信息泄漏防御)',
  })
  @ApiWrappedOkResponse(AttachmentResponseDto)
  @ApiBizErrorResponse(BizCode.BAD_REQUEST, BizCode.UNAUTHORIZED, BizCode.ATTACHMENT_NOT_FOUND)
  getById(
    @Param() params: IdParamDto,
    @CurrentUser() user: CurrentUserPayload,
  ): Promise<AttachmentResponseDto> {
    return this.service.getById(params.id, user);
  }

  @Patch(':id')
  @ApiOperation({
    summary:
      '更新附件元数据(仅 description / accessLevel / tags / expireAt;不存在返 13001;无权返 30100;PII 命中返 13015)',
  })
  @ApiWrappedOkResponse(AttachmentResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ATTACHMENT_NOT_FOUND,
    BizCode.ATTACHMENT_PII_DETECTED,
  )
  update(
    @Param() params: IdParamDto,
    @Body() dto: UpdateAttachmentDto,
    @CurrentUser() user: CurrentUserPayload,
  ): Promise<AttachmentResponseDto> {
    return this.service.update(params.id, dto, user);
  }

  @Delete(':id')
  @ApiOperation({
    summary: '物理删附件(Q11 v1.0:不查跨表引用;Provider 文件删除 Q15 挂起待 Provider 评审)',
  })
  @ApiWrappedOkResponse(AttachmentResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ATTACHMENT_NOT_FOUND,
  )
  delete(
    @Param() params: IdParamDto,
    @CurrentUser() user: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<AttachmentResponseDto> {
    return this.service.delete(params.id, user, this.buildAuditMeta(req));
  }
}
