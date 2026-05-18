import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  ApiBizErrorResponse,
  ApiWrappedArrayResponse,
  ApiWrappedOkResponse,
  ApiWrappedPageResponse,
} from '../../common/decorators/api-response.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { IdParamDto } from '../../common/dto/id-param.dto';
import { PageResultDto } from '../../common/dto/pagination.dto';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import {
  CreateDictItemDto,
  CreateDictTypeDto,
  DictItemResponseDto,
  DictItemTreeNodeDto,
  DictItemTreeQueryDto,
  DictTypeResponseDto,
  ListDictItemsQueryDto,
  ListDictTypesQueryDto,
  UpdateDictItemDto,
  UpdateDictItemStatusDto,
  UpdateDictTypeDto,
  UpdateDictTypeStatusDto,
} from './dictionaries.dto';
import { DictionariesService } from './dictionaries.service';

// 单文件双 @Controller 类,严格遵守 baseline §5.1 / CLAUDE.md §2 业务模块 4 文件铁律。
// 路径前缀:全局 /api(main.ts) + 'v2/dict-types' / 'v2/dict-items'。
//
// **权限标注**(P0-F PR-2A,2026-05-18):入口仅 JwtAuthGuard,**不**挂 `@Roles(...)`;
// 全部判权迁移到 DictionariesService 内 `rbac.can()`,失败抛
// BizException(BizCode.RBAC_FORBIDDEN)(30100)。沿 PR-1 attachments F3 v1.0 范本。
// 映射 seed 新增 8 条权限点:dict.{read,create,update,delete}.{type,item}。
// D3=A:dict-type / dict-item softDelete 从 v1 仅 SUPER_ADMIN 放宽至 ops-admin 可调
// (sub-protection 仍在 service 内:DICT_TYPE_IN_USE / DICT_ITEM_IN_USE 引用检查)。

// ============ /api/v2/dict-types ============

@ApiTags('dictionaries')
@ApiBearerAuth()
@Controller('v2/dict-types')
export class DictTypesController {
  constructor(private readonly service: DictionariesService) {}

  @Get()
  @ApiOperation({ summary: '列出字典类型(分页)' })
  @ApiWrappedPageResponse(DictTypeResponseDto)
  @ApiBizErrorResponse(BizCode.BAD_REQUEST, BizCode.UNAUTHORIZED, BizCode.RBAC_FORBIDDEN)
  list(
    @CurrentUser() user: CurrentUserPayload,
    @Query() query: ListDictTypesQueryDto,
  ): Promise<PageResultDto<DictTypeResponseDto>> {
    return this.service.listDictTypes(user, query);
  }

  @Post()
  @ApiOperation({ summary: '创建字典类型' })
  @ApiWrappedOkResponse(DictTypeResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.DICT_TYPE_CODE_ALREADY_EXISTS,
  )
  create(
    @CurrentUser() user: CurrentUserPayload,
    @Body() dto: CreateDictTypeDto,
  ): Promise<DictTypeResponseDto> {
    return this.service.createDictType(user, dto);
  }

  @Get(':id')
  @ApiOperation({ summary: '字典类型详情' })
  @ApiWrappedOkResponse(DictTypeResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.DICT_TYPE_NOT_FOUND,
  )
  findOne(
    @CurrentUser() user: CurrentUserPayload,
    @Param() params: IdParamDto,
  ): Promise<DictTypeResponseDto> {
    return this.service.findDictTypeById(user, params.id);
  }

  @Patch(':id')
  @ApiOperation({ summary: '更新字典类型(label / sortOrder;禁止改 code)' })
  @ApiWrappedOkResponse(DictTypeResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.DICT_TYPE_NOT_FOUND,
  )
  update(
    @CurrentUser() user: CurrentUserPayload,
    @Param() params: IdParamDto,
    @Body() dto: UpdateDictTypeDto,
  ): Promise<DictTypeResponseDto> {
    return this.service.updateDictType(user, params.id, dto);
  }

  @Patch(':id/status')
  @ApiOperation({ summary: '启停字典类型(只改 status)' })
  @ApiWrappedOkResponse(DictTypeResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.DICT_TYPE_NOT_FOUND,
  )
  updateStatus(
    @CurrentUser() user: CurrentUserPayload,
    @Param() params: IdParamDto,
    @Body() dto: UpdateDictTypeStatusDto,
  ): Promise<DictTypeResponseDto> {
    return this.service.updateDictTypeStatus(user, params.id, dto);
  }

  @Delete(':id')
  @ApiOperation({
    summary:
      '软删字典类型(P0-F PR-2A D3=A 放宽:ops-admin 可调;有 dict_items / organizations / members 引用则拒绝)',
  })
  @ApiWrappedOkResponse(DictTypeResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.DICT_TYPE_NOT_FOUND,
    BizCode.DICT_TYPE_IN_USE,
  )
  softDelete(
    @CurrentUser() user: CurrentUserPayload,
    @Param() params: IdParamDto,
  ): Promise<DictTypeResponseDto> {
    return this.service.softDeleteDictType(user, params.id);
  }
}

// ============ /api/v2/dict-items ============

@ApiTags('dictionaries')
@ApiBearerAuth()
@Controller('v2/dict-items')
export class DictItemsController {
  constructor(private readonly service: DictionariesService) {}

  @Get()
  @ApiOperation({ summary: '列出字典项(分页;typeId 必填)' })
  @ApiWrappedPageResponse(DictItemResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.DICT_TYPE_NOT_FOUND,
  )
  list(
    @CurrentUser() user: CurrentUserPayload,
    @Query() query: ListDictItemsQueryDto,
  ): Promise<PageResultDto<DictItemResponseDto>> {
    return this.service.listDictItems(user, query);
  }

  @Post()
  @ApiOperation({ summary: '创建字典项' })
  @ApiWrappedOkResponse(DictItemResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.DICT_TYPE_NOT_FOUND,
    BizCode.DICT_ITEM_NOT_FOUND,
    BizCode.DICT_ITEM_CODE_ALREADY_EXISTS,
    BizCode.DICT_ITEM_PARENT_TYPE_MISMATCH,
    BizCode.DICT_ITEM_PARENT_CYCLE,
  )
  create(
    @CurrentUser() user: CurrentUserPayload,
    @Body() dto: CreateDictItemDto,
  ): Promise<DictItemResponseDto> {
    return this.service.createDictItem(user, dto);
  }

  // /tree 必须在 /:id 之前定义(specific-before-dynamic):NestJS / Express
  // 路由匹配 first-match,避免 'tree' 被当作 :id 路径参数。
  @Get('tree')
  @ApiOperation({ summary: '字典项树形(按 typeId 过滤;深度无限制)' })
  @ApiWrappedArrayResponse(DictItemTreeNodeDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.DICT_TYPE_NOT_FOUND,
  )
  tree(
    @CurrentUser() user: CurrentUserPayload,
    @Query() query: DictItemTreeQueryDto,
  ): Promise<DictItemTreeNodeDto[]> {
    return this.service.getDictItemTree(user, query.typeId, query.status);
  }

  @Get(':id')
  @ApiOperation({ summary: '字典项详情' })
  @ApiWrappedOkResponse(DictItemResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.DICT_ITEM_NOT_FOUND,
  )
  findOne(
    @CurrentUser() user: CurrentUserPayload,
    @Param() params: IdParamDto,
  ): Promise<DictItemResponseDto> {
    return this.service.findDictItemById(user, params.id);
  }

  @Patch(':id')
  @ApiOperation({ summary: '更新字典项(label / sortOrder;禁止改 typeId / code / parentId)' })
  @ApiWrappedOkResponse(DictItemResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.DICT_ITEM_NOT_FOUND,
  )
  update(
    @CurrentUser() user: CurrentUserPayload,
    @Param() params: IdParamDto,
    @Body() dto: UpdateDictItemDto,
  ): Promise<DictItemResponseDto> {
    return this.service.updateDictItem(user, params.id, dto);
  }

  @Patch(':id/status')
  @ApiOperation({ summary: '启停字典项(只改 status)' })
  @ApiWrappedOkResponse(DictItemResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.DICT_ITEM_NOT_FOUND,
  )
  updateStatus(
    @CurrentUser() user: CurrentUserPayload,
    @Param() params: IdParamDto,
    @Body() dto: UpdateDictItemStatusDto,
  ): Promise<DictItemResponseDto> {
    return this.service.updateDictItemStatus(user, params.id, dto);
  }

  @Delete(':id')
  @ApiOperation({
    summary:
      '软删字典项(P0-F PR-2A D3=A 放宽:ops-admin 可调;有子节点 / organizations / members 引用则拒绝)',
  })
  @ApiWrappedOkResponse(DictItemResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.DICT_ITEM_NOT_FOUND,
    BizCode.DICT_ITEM_IN_USE,
  )
  softDelete(
    @CurrentUser() user: CurrentUserPayload,
    @Param() params: IdParamDto,
  ): Promise<DictItemResponseDto> {
    return this.service.softDeleteDictItem(user, params.id);
  }
}
