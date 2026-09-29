import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiExtraModels, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import {
  ApiBizErrorResponse,
  ApiWrappedCreatedResponse,
  ApiWrappedOkResponse,
  ApiWrappedPageResponse,
} from '../../../common/decorators/api-response.decorator';
import {
  CurrentUser,
  type CurrentUserPayload,
} from '../../../common/decorators/current-user.decorator';
import { RequiresPermission } from '../../../common/decorators/route-authz.decorator';
import { IdParamDto } from '../../../common/dto/id-param.dto';
import { PageResultDto } from '../../../common/dto/pagination.dto';
import { BizCode } from '../../../common/exceptions/biz-code.constant';
import { ActivityContributionPolicyService } from '../activity-contribution-policy.service';
import { ActivityContributionPolicyCatalogueQueryService } from '../activity-contribution-policy-catalogue-query.service';
import {
  SystemListContributionPoliciesQueryDto,
  SystemListContributionPolicyVersionsQueryDto,
  SystemContributionPolicyResponseDto,
  SystemContributionPolicyVersionSummaryDto,
  SystemContributionPolicyVersionResponseDto,
  ContributionPolicyVersionParamDto,
} from '../dto/system/contribution-policy.dto';
import {
  SystemCreateContributionPolicyDto,
  SystemCreateContributionPolicyVersionDto,
  SystemActivateContributionPolicyVersionDto,
  SystemRetireContributionPolicyVersionDto,
  SystemContributionPolicyCommandResponseDto,
} from '../dto/system/contribution-policy-command.dto';

@ApiTags('System - Contribution Policies')
@ApiBearerAuth()
@ApiExtraModels(
  PageResultDto,
  SystemContributionPolicyResponseDto,
  SystemContributionPolicyVersionSummaryDto,
)
@Controller('system/v1/contribution-policies')
export class SystemContributionPoliciesController {
  constructor(
    private readonly service: ActivityContributionPolicyService,
    private readonly queries: ActivityContributionPolicyCatalogueQueryService,
  ) {}

  @Get('')
  @RequiresPermission('contribution-policy.read.catalog', {
    require: 'all',
    engine: 'rbac-global',
  })
  @ApiOperation({ summary: '分页查询贡献政策 [rbac: contribution-policy.read.catalog]' })
  @ApiWrappedPageResponse(SystemContributionPolicyResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.PRINCIPAL_KIND_FORBIDDEN,
    BizCode.ACTIVITY_CONTRIBUTION_POLICY_NOT_FOUND,
    BizCode.ACTIVITY_CONTRIBUTION_POLICY_RECEIPT_INVALID,
  )
  list(
    @Query() query: SystemListContributionPoliciesQueryDto,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return this.queries.list(query, user);
  }

  @Get(':id')
  @RequiresPermission('contribution-policy.read.catalog', {
    require: 'all',
    engine: 'rbac-global',
  })
  @ApiOperation({ summary: '查看贡献政策 [rbac: contribution-policy.read.catalog]' })
  @ApiWrappedOkResponse(SystemContributionPolicyResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.PRINCIPAL_KIND_FORBIDDEN,
    BizCode.ACTIVITY_CONTRIBUTION_POLICY_NOT_FOUND,
    BizCode.ACTIVITY_CONTRIBUTION_POLICY_RECEIPT_INVALID,
  )
  get(@Param() params: IdParamDto, @CurrentUser() user: CurrentUserPayload) {
    return this.queries.get(params.id, user);
  }

  @Get(':id/versions')
  @RequiresPermission('contribution-policy.read.catalog', {
    require: 'all',
    engine: 'rbac-global',
  })
  @ApiOperation({ summary: '分页查询贡献政策版本 [rbac: contribution-policy.read.catalog]' })
  @ApiWrappedPageResponse(SystemContributionPolicyVersionSummaryDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.PRINCIPAL_KIND_FORBIDDEN,
    BizCode.ACTIVITY_CONTRIBUTION_POLICY_NOT_FOUND,
    BizCode.ACTIVITY_CONTRIBUTION_POLICY_RECEIPT_INVALID,
  )
  listVersions(
    @Param() params: IdParamDto,
    @Query() query: SystemListContributionPolicyVersionsQueryDto,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return this.queries.listVersions(params.id, query, user);
  }

  @Get(':id/versions/:versionId')
  @RequiresPermission('contribution-policy.read.catalog', {
    require: 'all',
    engine: 'rbac-global',
  })
  @ApiOperation({ summary: '查看贡献政策版本 [rbac: contribution-policy.read.catalog]' })
  @ApiWrappedOkResponse(SystemContributionPolicyVersionResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.PRINCIPAL_KIND_FORBIDDEN,
    BizCode.ACTIVITY_CONTRIBUTION_POLICY_NOT_FOUND,
    BizCode.ACTIVITY_CONTRIBUTION_POLICY_RECEIPT_INVALID,
  )
  getVersion(
    @Param() params: ContributionPolicyVersionParamDto,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return this.queries.getVersion(params.id, params.versionId, user);
  }

  @Post('')
  @RequiresPermission('contribution-policy.manage.version', {
    require: 'all',
    engine: 'rbac-global',
  })
  @ApiOperation({ summary: '创建贡献政策 [rbac: contribution-policy.manage.version]' })
  @ApiWrappedCreatedResponse(SystemContributionPolicyCommandResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.PRINCIPAL_KIND_FORBIDDEN,
    BizCode.ACTIVITY_CONTRIBUTION_POLICY_INVALID,
    BizCode.ACTIVITY_CONTRIBUTION_POLICY_NOT_FOUND,
    BizCode.ACTIVITY_CONTRIBUTION_POLICY_CODE_EXISTS,
    BizCode.ACTIVITY_CONTRIBUTION_POLICY_STALE,
    BizCode.ACTIVITY_CONTRIBUTION_POLICY_STATUS_INVALID,
    BizCode.ACTIVITY_CONTRIBUTION_POLICY_COMMAND_CONFLICT,
    BizCode.ACTIVITY_CONTRIBUTION_POLICY_RECEIPT_INVALID,
    BizCode.ACTIVITY_CONTRIBUTION_POLICY_VERSION_LIMIT,
  )
  createPolicy(
    @Body() input: SystemCreateContributionPolicyDto,
    @CurrentUser() user: CurrentUserPayload,
    @Req() req: Request,
  ) {
    return this.service.createPolicy(input, user, {
      requestId: typeof req.id === 'string' ? req.id : '',
      ip: req.ip ?? null,
      ua: req.headers['user-agent'] ?? null,
    });
  }

  @Post(':id/versions')
  @RequiresPermission('contribution-policy.manage.version', {
    require: 'all',
    engine: 'rbac-global',
  })
  @ApiOperation({ summary: '创建贡献政策版本 [rbac: contribution-policy.manage.version]' })
  @ApiWrappedCreatedResponse(SystemContributionPolicyCommandResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.PRINCIPAL_KIND_FORBIDDEN,
    BizCode.ACTIVITY_CONTRIBUTION_POLICY_INVALID,
    BizCode.ACTIVITY_CONTRIBUTION_POLICY_NOT_FOUND,
    BizCode.ACTIVITY_CONTRIBUTION_POLICY_CODE_EXISTS,
    BizCode.ACTIVITY_CONTRIBUTION_POLICY_STALE,
    BizCode.ACTIVITY_CONTRIBUTION_POLICY_STATUS_INVALID,
    BizCode.ACTIVITY_CONTRIBUTION_POLICY_COMMAND_CONFLICT,
    BizCode.ACTIVITY_CONTRIBUTION_POLICY_RECEIPT_INVALID,
    BizCode.ACTIVITY_CONTRIBUTION_POLICY_VERSION_LIMIT,
  )
  createVersion(
    @Param() params: IdParamDto,
    @Body() input: SystemCreateContributionPolicyVersionDto,
    @CurrentUser() user: CurrentUserPayload,
    @Req() req: Request,
  ) {
    return this.service.createVersion(params.id, input, user, {
      requestId: typeof req.id === 'string' ? req.id : '',
      ip: req.ip ?? null,
      ua: req.headers['user-agent'] ?? null,
    });
  }

  @Post(':id/versions/:versionId/activate')
  @HttpCode(HttpStatus.OK)
  @RequiresPermission('contribution-policy.manage.version', {
    require: 'all',
    engine: 'rbac-global',
  })
  @ApiOperation({ summary: '激活贡献政策版本 [rbac: contribution-policy.manage.version]' })
  @ApiWrappedOkResponse(SystemContributionPolicyCommandResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.PRINCIPAL_KIND_FORBIDDEN,
    BizCode.ACTIVITY_CONTRIBUTION_POLICY_INVALID,
    BizCode.ACTIVITY_CONTRIBUTION_POLICY_NOT_FOUND,
    BizCode.ACTIVITY_CONTRIBUTION_POLICY_CODE_EXISTS,
    BizCode.ACTIVITY_CONTRIBUTION_POLICY_STALE,
    BizCode.ACTIVITY_CONTRIBUTION_POLICY_STATUS_INVALID,
    BizCode.ACTIVITY_CONTRIBUTION_POLICY_COMMAND_CONFLICT,
    BizCode.ACTIVITY_CONTRIBUTION_POLICY_RECEIPT_INVALID,
    BizCode.ACTIVITY_CONTRIBUTION_POLICY_VERSION_LIMIT,
  )
  activate(
    @Param() params: ContributionPolicyVersionParamDto,
    @Body() input: SystemActivateContributionPolicyVersionDto,
    @CurrentUser() user: CurrentUserPayload,
    @Req() req: Request,
  ) {
    return this.service.transition('activate', params.id, params.versionId, input, user, {
      requestId: typeof req.id === 'string' ? req.id : '',
      ip: req.ip ?? null,
      ua: req.headers['user-agent'] ?? null,
    });
  }

  @Post(':id/versions/:versionId/retire')
  @HttpCode(HttpStatus.OK)
  @RequiresPermission('contribution-policy.manage.version', {
    require: 'all',
    engine: 'rbac-global',
  })
  @ApiOperation({ summary: '退役贡献政策版本 [rbac: contribution-policy.manage.version]' })
  @ApiWrappedOkResponse(SystemContributionPolicyCommandResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.PRINCIPAL_KIND_FORBIDDEN,
    BizCode.ACTIVITY_CONTRIBUTION_POLICY_INVALID,
    BizCode.ACTIVITY_CONTRIBUTION_POLICY_NOT_FOUND,
    BizCode.ACTIVITY_CONTRIBUTION_POLICY_CODE_EXISTS,
    BizCode.ACTIVITY_CONTRIBUTION_POLICY_STALE,
    BizCode.ACTIVITY_CONTRIBUTION_POLICY_STATUS_INVALID,
    BizCode.ACTIVITY_CONTRIBUTION_POLICY_COMMAND_CONFLICT,
    BizCode.ACTIVITY_CONTRIBUTION_POLICY_RECEIPT_INVALID,
    BizCode.ACTIVITY_CONTRIBUTION_POLICY_VERSION_LIMIT,
  )
  retire(
    @Param() params: ContributionPolicyVersionParamDto,
    @Body() input: SystemRetireContributionPolicyVersionDto,
    @CurrentUser() user: CurrentUserPayload,
    @Req() req: Request,
  ) {
    return this.service.transition('retire', params.id, params.versionId, input, user, {
      requestId: typeof req.id === 'string' ? req.id : '',
      ip: req.ip ?? null,
      ua: req.headers['user-agent'] ?? null,
    });
  }
}
