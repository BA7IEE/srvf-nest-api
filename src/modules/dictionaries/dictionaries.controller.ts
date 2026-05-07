import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import {
  ApiBizErrorResponse,
  ApiWrappedArrayResponse,
  ApiWrappedOkResponse,
  ApiWrappedPageResponse,
} from '../../common/decorators/api-response.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
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

// ============ /api/v2/dict-types ============

@ApiTags('dictionaries')
@ApiBearerAuth()
@Controller('v2/dict-types')
export class DictTypesController {
  constructor(private readonly service: DictionariesService) {}

  @Get()
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @ApiOperation({ summary: '列出字典类型(分页)' })
  @ApiWrappedPageResponse(DictTypeResponseDto)
  @ApiBizErrorResponse(BizCode.BAD_REQUEST, BizCode.UNAUTHORIZED, BizCode.FORBIDDEN)
  list(@Query() query: ListDictTypesQueryDto): Promise<PageResultDto<DictTypeResponseDto>> {
    return this.service.listDictTypes(query);
  }

  @Post()
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @ApiOperation({ summary: '创建字典类型' })
  @ApiWrappedOkResponse(DictTypeResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.DICT_TYPE_CODE_ALREADY_EXISTS,
  )
  create(@Body() dto: CreateDictTypeDto): Promise<DictTypeResponseDto> {
    return this.service.createDictType(dto);
  }

  @Get(':id')
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @ApiOperation({ summary: '字典类型详情' })
  @ApiWrappedOkResponse(DictTypeResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.DICT_TYPE_NOT_FOUND,
  )
  findOne(@Param() params: IdParamDto): Promise<DictTypeResponseDto> {
    return this.service.findDictTypeById(params.id);
  }

  @Patch(':id')
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @ApiOperation({ summary: '更新字典类型(label / sortOrder;禁止改 code)' })
  @ApiWrappedOkResponse(DictTypeResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.DICT_TYPE_NOT_FOUND,
  )
  update(
    @Param() params: IdParamDto,
    @Body() dto: UpdateDictTypeDto,
  ): Promise<DictTypeResponseDto> {
    return this.service.updateDictType(params.id, dto);
  }

  @Patch(':id/status')
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @ApiOperation({ summary: '启停字典类型(只改 status)' })
  @ApiWrappedOkResponse(DictTypeResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.DICT_TYPE_NOT_FOUND,
  )
  updateStatus(
    @Param() params: IdParamDto,
    @Body() dto: UpdateDictTypeStatusDto,
  ): Promise<DictTypeResponseDto> {
    return this.service.updateDictTypeStatus(params.id, dto);
  }

  @Delete(':id')
  @Roles(Role.SUPER_ADMIN)
  @ApiOperation({
    summary: '软删字典类型(SUPER_ADMIN 专属;有 dict_items / organizations / members 引用则拒绝)',
  })
  @ApiWrappedOkResponse(DictTypeResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.DICT_TYPE_NOT_FOUND,
    BizCode.DICT_TYPE_IN_USE,
  )
  softDelete(@Param() params: IdParamDto): Promise<DictTypeResponseDto> {
    return this.service.softDeleteDictType(params.id);
  }
}

// ============ /api/v2/dict-items ============

@ApiTags('dictionaries')
@ApiBearerAuth()
@Controller('v2/dict-items')
export class DictItemsController {
  constructor(private readonly service: DictionariesService) {}

  @Get()
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @ApiOperation({ summary: '列出字典项(分页;typeId 必填)' })
  @ApiWrappedPageResponse(DictItemResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.DICT_TYPE_NOT_FOUND,
  )
  list(@Query() query: ListDictItemsQueryDto): Promise<PageResultDto<DictItemResponseDto>> {
    return this.service.listDictItems(query);
  }

  @Post()
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @ApiOperation({ summary: '创建字典项' })
  @ApiWrappedOkResponse(DictItemResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.DICT_TYPE_NOT_FOUND,
    BizCode.DICT_ITEM_NOT_FOUND,
    BizCode.DICT_ITEM_CODE_ALREADY_EXISTS,
    BizCode.DICT_ITEM_PARENT_TYPE_MISMATCH,
    BizCode.DICT_ITEM_PARENT_CYCLE,
  )
  create(@Body() dto: CreateDictItemDto): Promise<DictItemResponseDto> {
    return this.service.createDictItem(dto);
  }

  // /tree 必须在 /:id 之前定义(specific-before-dynamic):NestJS / Express
  // 路由匹配 first-match,避免 'tree' 被当作 :id 路径参数。
  @Get('tree')
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @ApiOperation({ summary: '字典项树形(按 typeId 过滤;深度无限制)' })
  @ApiWrappedArrayResponse(DictItemTreeNodeDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.DICT_TYPE_NOT_FOUND,
  )
  tree(@Query() query: DictItemTreeQueryDto): Promise<DictItemTreeNodeDto[]> {
    return this.service.getDictItemTree(query.typeId, query.status);
  }

  @Get(':id')
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @ApiOperation({ summary: '字典项详情' })
  @ApiWrappedOkResponse(DictItemResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.DICT_ITEM_NOT_FOUND,
  )
  findOne(@Param() params: IdParamDto): Promise<DictItemResponseDto> {
    return this.service.findDictItemById(params.id);
  }

  @Patch(':id')
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @ApiOperation({ summary: '更新字典项(label / sortOrder;禁止改 typeId / code / parentId)' })
  @ApiWrappedOkResponse(DictItemResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.DICT_ITEM_NOT_FOUND,
  )
  update(
    @Param() params: IdParamDto,
    @Body() dto: UpdateDictItemDto,
  ): Promise<DictItemResponseDto> {
    return this.service.updateDictItem(params.id, dto);
  }

  @Patch(':id/status')
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @ApiOperation({ summary: '启停字典项(只改 status)' })
  @ApiWrappedOkResponse(DictItemResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.DICT_ITEM_NOT_FOUND,
  )
  updateStatus(
    @Param() params: IdParamDto,
    @Body() dto: UpdateDictItemStatusDto,
  ): Promise<DictItemResponseDto> {
    return this.service.updateDictItemStatus(params.id, dto);
  }

  @Delete(':id')
  @Roles(Role.SUPER_ADMIN)
  @ApiOperation({
    summary: '软删字典项(SUPER_ADMIN 专属;有子节点 / organizations / members 引用则拒绝)',
  })
  @ApiWrappedOkResponse(DictItemResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.DICT_ITEM_NOT_FOUND,
    BizCode.DICT_ITEM_IN_USE,
  )
  softDelete(@Param() params: IdParamDto): Promise<DictItemResponseDto> {
    return this.service.softDeleteDictItem(params.id);
  }
}
