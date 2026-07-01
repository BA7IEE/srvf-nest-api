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
import {
  CreatePositionRuleDto,
  PositionRuleQueryDto,
  PositionRuleResponseDto,
  UpdatePositionRuleDto,
} from './position-rules.dto';
import { PositionRulesService } from './position-rules.service';

// 终态 scoped-authz PR3(2026-07-01;冻结稿 §7.2):职务规则(position-rules)全局配置面 controller(4 路由)。
// 路径前缀:全局 /api(main.ts)+ 'admin/v1/position-rules'。判权单轨 service 层 rbac.can(position-rule.*.record);
// 入口仅全局 JwtAuthGuard,**不**挂 @Roles。GET :id 冻结稿 §7.2 未列(runner 定不实装)。
@ApiTags('Admin - Position Rules')
@ApiBearerAuth()
@Controller('admin/v1/position-rules')
export class PositionRulesController {
  constructor(private readonly service: PositionRulesService) {}

  @Get()
  @ApiOperation({
    summary:
      '列出职务规则(分页 + 过滤 nodeTypeCode / positionId / status) [rbac: position-rule.read.record]',
  })
  @ApiWrappedPageResponse(PositionRuleResponseDto)
  @ApiBizErrorResponse(BizCode.BAD_REQUEST, BizCode.UNAUTHORIZED, BizCode.RBAC_FORBIDDEN)
  list(
    @CurrentUser() currentUser: CurrentUserPayload,
    @Query() query: PositionRuleQueryDto,
  ): Promise<PageResultDto<PositionRuleResponseDto>> {
    return this.service.list(currentUser, query);
  }

  @Post()
  @ApiOperation({
    summary:
      '创建职务规则(校验 nodeTypeCode 字典有效 + positionId 存在;(nodeType,position) 唯一) [rbac: position-rule.create.record]',
  })
  @ApiWrappedOkResponse(PositionRuleResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.POSITION_NOT_FOUND,
    BizCode.POSITION_RULE_ALREADY_EXISTS,
    BizCode.POSITION_RULE_NODE_TYPE_INVALID,
  )
  create(
    @CurrentUser() currentUser: CurrentUserPayload,
    @Body() dto: CreatePositionRuleDto,
  ): Promise<PositionRuleResponseDto> {
    return this.service.create(currentUser, dto);
  }

  @Patch(':id')
  @ApiOperation({
    summary:
      '部分更新职务规则(白名单禁改 nodeTypeCode / positionId,由 ValidationPipe 拦截) [rbac: position-rule.update.record]',
  })
  @ApiWrappedOkResponse(PositionRuleResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.POSITION_RULE_NOT_FOUND,
  )
  update(
    @CurrentUser() currentUser: CurrentUserPayload,
    @Param() params: IdParamDto,
    @Body() dto: UpdatePositionRuleDto,
  ): Promise<PositionRuleResponseDto> {
    return this.service.update(currentUser, params.id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '软删职务规则 [rbac: position-rule.delete.record]' })
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.POSITION_RULE_NOT_FOUND,
  )
  softDelete(
    @CurrentUser() currentUser: CurrentUserPayload,
    @Param() params: IdParamDto,
  ): Promise<void> {
    return this.service.softDelete(currentUser, params.id);
  }
}
