import {
  HttpStatus,
  HttpCode,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
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
// 本 Controller 为 `@Controller('admin/v1/attachments')`,class-level @ApiTags = 'Admin - Attachments'。
// 历史 mobile-like `GET /me/uploaded`(原 `Mobile - Attachments` tag 唯一端点)已于 Route B Phase 4e
// 删除,未建 App 替代;`listMyUploaded` service 保留为未来 `app/v1/my/attachments` building block
// (沿 docs/api-surface-migration-plan.md §3.3 / §6 Phase 4)。
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
      '创建附件元数据(先落 durable storage intent,按 pinned locator 校验对象,再将 Attachment + audit + storage available 原子提交;存储状态不确定返 13034;其余校验:ownerType 13010 / ownerId 13011 / RBAC 30100 / MIME 13033或13012 / size 13013 / key 13014 / PII 13015) [rbac: attachment.upload.*]',
  })
  @ApiWrappedCreatedResponse(AttachmentResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ATTACHMENT_OWNER_TYPE_INVALID,
    BizCode.ATTACHMENT_OWNER_NOT_FOUND,
    BizCode.ATTACHMENT_SYSTEM_MIME_BLOCKED,
    BizCode.ATTACHMENT_MIME_NOT_ALLOWED,
    BizCode.ATTACHMENT_SIZE_EXCEEDED,
    BizCode.ATTACHMENT_KEY_INVALID,
    BizCode.ATTACHMENT_PII_DETECTED,
    BizCode.ATTACHMENT_STORAGE_OPERATION_PENDING,
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
      '列出附件(分页;可选 ownerType / ownerId / uploadedBy / mime / accessLevel / tags 过滤;tags OR 语义;total 按可见数量返;默认排序 createdAt DESC) [rbac: attachment.view.*]',
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
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      '申请 signed upload URL(模式 B;先预写 durable storage intent,再按 pinned locator 签 URL;尚不创建 Attachment/不写业务 audit;存储状态不确定返 13034) [rbac: attachment.upload.*]',
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
    BizCode.ATTACHMENT_STORAGE_OPERATION_PENDING,
  )
  createUploadUrl(
    @Body() dto: GenerateUploadUrlDto,
    @CurrentUser() user: CurrentUserPayload,
  ): Promise<UploadUrlResponseDto> {
    return this.service.createUploadUrl(dto, user);
  }

  @Post('confirm-upload')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      '确认上传完成(模式 B;验 uploadToken,按 intent 的 pinned locator 校验 HEAD/size/文件签名,再原子提交 Attachment + audit + available;同 token 幂等;不确定态返 13034) [rbac: attachment.upload.*]',
  })
  @ApiWrappedOkResponse(AttachmentResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ATTACHMENT_NOT_FOUND,
    BizCode.ATTACHMENT_OWNER_NOT_FOUND, // F10(#399):owner 软删窗口复校(与 create/upload-url 对齐)
    BizCode.ATTACHMENT_SIZE_EXCEEDED,
    BizCode.ATTACHMENT_SYSTEM_MIME_BLOCKED,
    BizCode.ATTACHMENT_CONTENT_TYPE_MISMATCH,
    BizCode.ATTACHMENT_STORAGE_OPERATION_PENDING,
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
      '按 ownerType + ownerId 列出某业务对象的全部附件(业务模块常用入口;ownerType / ownerId 必填;逐条 ownership 过滤) [rbac: attachment.view.*]',
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
    summary: '附件详情(不存在 / 无权统一返 13001;Q13 v1.0 信息泄漏防御) [rbac: attachment.view.*]',
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
      '更新附件元数据(仅 description / accessLevel / tags / expireAt;不存在返 13001;无权返 30100;PII 命中返 13015) [rbac: attachment.update.*]',
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
    summary:
      '删除附件(先提交 delete intent 并隐藏普通读取;Provider 删除后须 HEAD absent,再原子硬删 Attachment + 写 audit;未完成返 13034;原 actor 24h 内可幂等重放最小响应) [rbac: attachment.delete.*]',
  })
  @ApiWrappedOkResponse(AttachmentResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ATTACHMENT_NOT_FOUND,
    BizCode.ATTACHMENT_STORAGE_OPERATION_PENDING,
  )
  delete(
    @Param() params: IdParamDto,
    @CurrentUser() user: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<AttachmentResponseDto> {
    return this.service.delete(params.id, user, this.buildAuditMeta(req));
  }
}
