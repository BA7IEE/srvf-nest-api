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
  CreateOrganizationDto,
  ListOrganizationsQueryDto,
  OrganizationResponseDto,
  OrganizationTreeNodeDto,
  OrganizationTreeQueryDto,
  UpdateOrganizationDto,
  UpdateOrganizationStatusDto,
} from './organizations.dto';
import { OrganizationsService } from './organizations.service';

// /api/v2/organizations(7 接口);路径前缀:全局 /api(main.ts)+ 'v2/organizations'。

@ApiTags('organizations')
@ApiBearerAuth()
@Controller('v2/organizations')
export class OrganizationsController {
  constructor(private readonly service: OrganizationsService) {}

  @Get()
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @ApiOperation({ summary: '列出组织节点(分页;parentId=null 过滤根节点)' })
  @ApiWrappedPageResponse(OrganizationResponseDto)
  @ApiBizErrorResponse(BizCode.BAD_REQUEST, BizCode.UNAUTHORIZED, BizCode.FORBIDDEN)
  list(@Query() query: ListOrganizationsQueryDto): Promise<PageResultDto<OrganizationResponseDto>> {
    return this.service.list(query);
  }

  // /tree 必须**先于** /:id 定义(specific-before-dynamic;沿用 dictionaries 经验)。
  @Get('tree')
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @ApiOperation({ summary: '组织树形(从根开始嵌套;深度无限制)' })
  @ApiWrappedArrayResponse(OrganizationTreeNodeDto)
  @ApiBizErrorResponse(BizCode.BAD_REQUEST, BizCode.UNAUTHORIZED, BizCode.FORBIDDEN)
  tree(@Query() query: OrganizationTreeQueryDto): Promise<OrganizationTreeNodeDto[]> {
    return this.service.getTree(query);
  }

  @Post()
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @ApiOperation({
    summary: '创建组织节点(parentId 不传 = 根节点;V2 第一阶段单根上限 1)',
  })
  @ApiWrappedOkResponse(OrganizationResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.ORGANIZATION_PARENT_NOT_FOUND,
    BizCode.ORGANIZATION_NODE_TYPE_INVALID,
    BizCode.ORGANIZATION_PARENT_CYCLE,
    BizCode.ORGANIZATION_ROOT_ALREADY_EXISTS,
  )
  create(@Body() dto: CreateOrganizationDto): Promise<OrganizationResponseDto> {
    return this.service.create(dto);
  }

  @Get(':id')
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @ApiOperation({ summary: '组织节点详情' })
  @ApiWrappedOkResponse(OrganizationResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.ORGANIZATION_NOT_FOUND,
  )
  findOne(@Param() params: IdParamDto): Promise<OrganizationResponseDto> {
    return this.service.findOne(params.id);
  }

  @Patch(':id')
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @ApiOperation({
    summary: '更新组织节点(name / sortOrder / nodeTypeCode;**禁止改 parentId**)',
  })
  @ApiWrappedOkResponse(OrganizationResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.ORGANIZATION_NOT_FOUND,
    BizCode.ORGANIZATION_NODE_TYPE_INVALID,
    BizCode.ORGANIZATION_PARENT_CHANGE_FORBIDDEN,
  )
  update(
    @Param() params: IdParamDto,
    @Body() dto: UpdateOrganizationDto,
  ): Promise<OrganizationResponseDto> {
    return this.service.update(params.id, dto);
  }

  @Patch(':id/status')
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @ApiOperation({
    summary: '启停组织节点(只改 status;停用唯一活跃根 → LAST_ROOT_PROTECTED)',
  })
  @ApiWrappedOkResponse(OrganizationResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.ORGANIZATION_NOT_FOUND,
    BizCode.LAST_ROOT_ORGANIZATION_PROTECTED,
  )
  updateStatus(
    @Param() params: IdParamDto,
    @Body() dto: UpdateOrganizationStatusDto,
  ): Promise<OrganizationResponseDto> {
    return this.service.updateStatus(params.id, dto);
  }

  @Delete(':id')
  @Roles(Role.SUPER_ADMIN)
  @ApiOperation({
    summary: '软删组织节点(SUPER_ADMIN 专属;有子节点 / 成员归属 / 唯一活跃根则拒绝)',
  })
  @ApiWrappedOkResponse(OrganizationResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.ORGANIZATION_NOT_FOUND,
    BizCode.ORGANIZATION_HAS_CHILDREN,
    BizCode.ORGANIZATION_HAS_MEMBERS,
    BizCode.LAST_ROOT_ORGANIZATION_PROTECTED,
  )
  softDelete(@Param() params: IdParamDto): Promise<OrganizationResponseDto> {
    return this.service.softDelete(params.id);
  }
}
