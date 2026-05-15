import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiExtraModels, ApiOperation, ApiTags } from '@nestjs/swagger';
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
import { PageResultDto, PaginationQueryDto } from '../../common/dto/pagination.dto';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import {
  AttachmentResponseDto,
  CreateAttachmentDto,
  ListAttachmentsByOwnerQueryDto,
  ListAttachmentsQueryDto,
  UpdateAttachmentDto,
} from './attachments.dto';
import { AttachmentsService } from './attachments.service';

// V2.x C-7 attachments 实施 PR #6b(2026-05-15):attachments 主模块 Controller。
//
// 7 个端点(沿 D7-attachments v1.0 §5.1):
//   POST   /api/v2/attachments                创建附件元数据
//   GET    /api/v2/attachments                列表(分页;管理后台用;逐条 ownership 过滤)
//   GET    /api/v2/attachments/by-owner       按 ownerType+ownerId 列出(业务模块常用)
//   GET    /api/v2/attachments/me/uploaded    本人上传列表
//   GET    /api/v2/attachments/:id            详情
//   PATCH  /api/v2/attachments/:id            更新 description / accessLevel / tags / expireAt
//   DELETE /api/v2/attachments/:id            物理删(Q11 v1.0)
//
// **入口 Guard 统一 JwtAuthGuard**(F3 v1.0 锁;**不加** `@Roles(...)`):全部判权
//   在 Service 层 rbac.can();失败抛 30100 RBAC_FORBIDDEN(写) / 13001 ATTACHMENT_NOT_FOUND(读)。
//
// **路径顺序铁律**:`/by-owner` / `/me/uploaded` 必须放在 `/:id` 之前,避免被 :id 通配匹配。

@ApiTags('attachments')
@ApiBearerAuth()
@ApiExtraModels(AttachmentResponseDto)
@Controller('v2/attachments')
export class AttachmentsController {
  constructor(private readonly service: AttachmentsService) {}

  @Post()
  @ApiOperation({
    summary:
      '创建附件元数据(校验:ownerType 13010 / ownerId 13011 / RBAC 30100 / mime 13012 / size 13013 / PII 13015;Q14 v1.0:Provider 接通前不接受文件流)',
  })
  @ApiWrappedOkResponse(AttachmentResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ATTACHMENT_OWNER_TYPE_INVALID,
    BizCode.ATTACHMENT_OWNER_NOT_FOUND,
    BizCode.ATTACHMENT_MIME_NOT_ALLOWED,
    BizCode.ATTACHMENT_SIZE_EXCEEDED,
    BizCode.ATTACHMENT_PII_DETECTED,
  )
  create(
    @Body() dto: CreateAttachmentDto,
    @CurrentUser() user: CurrentUserPayload,
  ): Promise<AttachmentResponseDto> {
    return this.service.create(dto, user);
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

  @Get('me/uploaded')
  @ApiOperation({
    summary: '列出本人上传的附件(自动按 uploadedBy=currentUser.id 筛;不走 RBAC;沿"本人查自己"豁免)',
  })
  @ApiWrappedPageResponse(AttachmentResponseDto)
  @ApiBizErrorResponse(BizCode.BAD_REQUEST, BizCode.UNAUTHORIZED)
  listMyUploaded(
    @Query() query: PaginationQueryDto,
    @CurrentUser() user: CurrentUserPayload,
  ): Promise<PageResultDto<AttachmentResponseDto>> {
    return this.service.listMyUploaded(query, user);
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
  ): Promise<AttachmentResponseDto> {
    return this.service.delete(params.id, user);
  }
}
