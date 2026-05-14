import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiExtraModels, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import {
  ApiBizErrorResponse,
  ApiWrappedOkResponse,
  ApiWrappedPageResponse,
} from '../../common/decorators/api-response.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { IdParamDto } from '../../common/dto/id-param.dto';
import { PageResultDto } from '../../common/dto/pagination.dto';
import { BizCode } from '../../common/exceptions/biz-code.constant';
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
// **权限标注**(F4 v1.0 锁):全部使用 @Roles(Role.SUPER_ADMIN, Role.ADMIN);**不接 rbac.can()**。

@ApiTags('attachment-configs')
@ApiBearerAuth()
@ApiExtraModels(AttachmentSizeLimitConfigResponseDto, AttachmentSizeLimitConfigTypeConfigSummaryDto)
@Controller('v2/attachment-size-limit-configs')
export class AttachmentSizeLimitConfigsController {
  constructor(private readonly service: AttachmentSizeLimitConfigsService) {}

  @Get()
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @ApiOperation({
    summary: '列出附件尺寸限制配置(分页;可选 typeConfigId 过滤;默认排序 createdAt DESC)',
  })
  @ApiWrappedPageResponse(AttachmentSizeLimitConfigResponseDto)
  @ApiBizErrorResponse(BizCode.BAD_REQUEST, BizCode.UNAUTHORIZED, BizCode.FORBIDDEN)
  list(
    @Query() query: ListAttachmentSizeLimitConfigsQueryDto,
  ): Promise<PageResultDto<AttachmentSizeLimitConfigResponseDto>> {
    return this.service.list(query);
  }

  @Post()
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @ApiOperation({
    summary:
      '创建附件尺寸限制配置(1:1 与 typeConfig;typeConfigId 不存在 → 13020;重复 → 13027;含软删历史)',
  })
  @ApiWrappedOkResponse(AttachmentSizeLimitConfigResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.ATTACHMENT_TYPE_CONFIG_NOT_FOUND,
    BizCode.ATTACHMENT_SIZE_LIMIT_CONFIG_ALREADY_EXISTS,
  )
  create(
    @Body() dto: CreateAttachmentSizeLimitConfigDto,
  ): Promise<AttachmentSizeLimitConfigResponseDto> {
    return this.service.create(dto);
  }

  @Get(':id')
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @ApiOperation({ summary: '附件尺寸限制配置详情(不存在 / 已软删统一返 13026)' })
  @ApiWrappedOkResponse(AttachmentSizeLimitConfigResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.ATTACHMENT_SIZE_LIMIT_CONFIG_NOT_FOUND,
  )
  getById(@Param() params: IdParamDto): Promise<AttachmentSizeLimitConfigResponseDto> {
    return this.service.getById(params.id);
  }

  @Patch(':id')
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @ApiOperation({
    summary:
      '更新附件尺寸限制配置(仅 maxSizeBytes / remark;**禁止** typeConfigId(Q4 PR #4)/ deletedAt / id;Q5 v1.0:maxSizeBytes 不允许 null)',
  })
  @ApiWrappedOkResponse(AttachmentSizeLimitConfigResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.ATTACHMENT_SIZE_LIMIT_CONFIG_NOT_FOUND,
  )
  update(
    @Param() params: IdParamDto,
    @Body() dto: UpdateAttachmentSizeLimitConfigDto,
  ): Promise<AttachmentSizeLimitConfigResponseDto> {
    return this.service.update(params.id, dto);
  }

  @Delete(':id')
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @ApiOperation({
    summary:
      '软删附件尺寸限制配置(deletedAt = now();本表无 status 字段不需要同步置;Q2 v1.0:不查 attachments 主表跨表引用)',
  })
  @ApiWrappedOkResponse(AttachmentSizeLimitConfigResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.ATTACHMENT_SIZE_LIMIT_CONFIG_NOT_FOUND,
  )
  softDelete(@Param() params: IdParamDto): Promise<AttachmentSizeLimitConfigResponseDto> {
    return this.service.softDelete(params.id);
  }
}
