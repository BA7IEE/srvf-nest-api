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
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  ApiWrappedCreatedResponse,
  ApiBizErrorResponse,
  ApiNoContentResponse,
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
import {
  CreatePositionDto,
  PositionOptionsQueryDto,
  PositionOptionsResponseDto,
  PositionQueryDto,
  PositionResponseDto,
  UpdatePositionDto,
} from './positions.dto';
import { PositionsService } from './positions.service';

// 终态 scoped-authz PR3(2026-07-01;冻结稿 §7.2):职务定义(positions)全局配置面 controller(5 路由)。
// 路径前缀:全局 /api(main.ts)+ 'admin/v1/positions'(沿 admin 面 organizations / memberships 现范式)。
// 判权单轨 service 层 rbac.can(position.*.definition);入口仅全局 JwtAuthGuard,**不**挂 @Roles。
@ApiTags('Admin - Positions')
@ApiBearerAuth()
@Controller('admin/v1/positions')
export class PositionsController {
  constructor(private readonly service: PositionsService) {}

  @Get()
  @ApiOperation({
    summary: '列出职务定义(分页 + 过滤 categoryCode / status) [rbac: position.read.definition]',
  })
  @ApiWrappedPageResponse(PositionResponseDto)
  @ApiBizErrorResponse(BizCode.BAD_REQUEST, BizCode.UNAUTHORIZED, BizCode.RBAC_FORBIDDEN)
  list(
    @CurrentUser() currentUser: CurrentUserPayload,
    @Query() query: PositionQueryDto,
  ): Promise<PageResultDto<PositionResponseDto>> {
    return this.service.list(currentUser, query);
  }

  // F1/A5(路线图 §4;D2/D3 拍板):选择器投影,必须先于 /:id 定义(specific-before-dynamic)。
  @Get('options')
  @ApiOperation({
    summary: '职务选择器投影(q 模糊 name;limit≤100,默认 20) [rbac: position.read.definition]',
  })
  @ApiWrappedOkResponse(PositionOptionsResponseDto)
  @ApiBizErrorResponse(BizCode.BAD_REQUEST, BizCode.UNAUTHORIZED, BizCode.RBAC_FORBIDDEN)
  options(
    @CurrentUser() currentUser: CurrentUserPayload,
    @Query() query: PositionOptionsQueryDto,
  ): Promise<PositionOptionsResponseDto> {
    return this.service.options(currentUser, query);
  }

  @Post()
  @ApiOperation({
    summary: '创建职务定义(code kebab 唯一) [rbac: position.create.definition]',
  })
  @ApiWrappedCreatedResponse(PositionResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.POSITION_CODE_DUPLICATE,
  )
  create(
    @CurrentUser() currentUser: CurrentUserPayload,
    @Body() dto: CreatePositionDto,
  ): Promise<PositionResponseDto> {
    return this.service.create(currentUser, dto);
  }

  @Get(':id')
  @ApiOperation({ summary: '职务定义详情(软删返 404) [rbac: position.read.definition]' })
  @ApiWrappedOkResponse(PositionResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.POSITION_NOT_FOUND,
  )
  findOne(
    @CurrentUser() currentUser: CurrentUserPayload,
    @Param() params: IdParamDto,
  ): Promise<PositionResponseDto> {
    return this.service.findOne(currentUser, params.id);
  }

  @Patch(':id')
  @ApiOperation({
    summary:
      '部分更新职务定义(白名单禁改 code,由 ValidationPipe 拦截) [rbac: position.update.definition]',
  })
  @ApiWrappedOkResponse(PositionResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.POSITION_NOT_FOUND,
  )
  update(
    @CurrentUser() currentUser: CurrentUserPayload,
    @Param() params: IdParamDto,
    @Body() dto: UpdatePositionDto,
  ): Promise<PositionResponseDto> {
    return this.service.update(currentUser, params.id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: '软删职务定义(被职务规则引用时禁删 → 32003) [rbac: position.delete.definition]',
  })
  @ApiNoContentResponse()
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.POSITION_NOT_FOUND,
    BizCode.POSITION_IN_USE,
  )
  softDelete(
    @CurrentUser() currentUser: CurrentUserPayload,
    @Param() params: IdParamDto,
  ): Promise<void> {
    return this.service.softDelete(currentUser, params.id);
  }
}
