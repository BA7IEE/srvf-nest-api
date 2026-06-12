import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiExtraModels, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import {
  ApiBizErrorResponse,
  ApiWrappedOkResponse,
  ApiWrappedPageResponse,
} from '../../../common/decorators/api-response.decorator';
import {
  CurrentUser,
  type CurrentUserPayload,
} from '../../../common/decorators/current-user.decorator';
import { PageResultDto } from '../../../common/dto/pagination.dto';
import { BizCode } from '../../../common/exceptions/biz-code.constant';
import type { AuditMeta } from '../../audit-logs/audit-logs.types';
import { AppMeInsurancesService } from '../app-me-insurances.service';
import { AppMyInsuranceDto } from '../dto/app/app-my-insurance.dto';
import { CreateAppMeInsuranceDto } from '../dto/app/create-app-me-insurance.dto';
import { ListAppMeInsurancesQueryDto } from '../dto/app/list-app-me-insurances-query.dto';
import { UpdateAppMeInsuranceDto } from '../dto/app/update-app-me-insurance.dto';

// 保险模块 T2:App 自助自购保险 Mobile Controller(2026-06-13;4 endpoint)。
// 冻结评审稿 docs/archive/reviews/insurance-module-review.md §3.2 端点 1-4 / E-14 / D-INS-3:
//   - **新建** @Controller('app/v1/me/insurances');与既有 'app/v1/me'(users 模块,
//     全字面段)无路由遮蔽;物理路径 src/modules/insurances/controllers/(沿 P2-7 范式)
//   - **不**挂 @Roles(App 不用 Role 短路)/ **不**挂 @Public(全部要登录,依赖全局
//     JwtAuthGuard)/ **不**挂限流装饰器(沿 default throttler)/ **不接 RBAC**(goal 禁区)
//   - 准入:canUseApp=false → 403(memberId=null / member 软删 / member.status!=ACTIVE
//     统一 403);self-scope 锁 currentUser.memberId,防 IDOR(校验全部前置在 service)
//   - 自报即可,v1 无核验(D-INS-5);无 :id 详情端点(goal 列举即 list/create/update/delete)
@ApiTags('Mobile - My Insurances')
@ApiBearerAuth()
@ApiExtraModels(AppMyInsuranceDto, PageResultDto)
@Controller('app/v1/me/insurances')
export class AppMeInsurancesController {
  constructor(private readonly service: AppMeInsurancesService) {}

  // 沿 V2 批次 6 PR #2 范式:从 @Req() 构造 AuditMeta 显式传给 service(写操作)。
  private buildAuditMeta(req: Request): AuditMeta {
    return {
      requestId: req.id as string,
      ip: req.ip ?? null,
      ua: req.headers['user-agent'] ?? null,
    };
  }

  @Get()
  @ApiOperation({
    summary: '我的自购保险分页列表(仅本人;软删不可见;createdAt desc) [auth]',
  })
  @ApiWrappedPageResponse(AppMyInsuranceDto)
  @ApiBizErrorResponse(BizCode.BAD_REQUEST, BizCode.UNAUTHORIZED, BizCode.FORBIDDEN)
  list(
    @Query() query: ListAppMeInsurancesQueryDto,
    @CurrentUser() currentUser: CurrentUserPayload,
  ): Promise<PageResultDto<AppMyInsuranceDto>> {
    return this.service.listMy(query, currentUser);
  }

  @Post()
  @ApiOperation({
    summary:
      '新增自购保险(自报即可,无核验;保险公司/保单号/到期必填,起保可选;起保 ≤ 到期否则 26010) [auth]',
  })
  @ApiWrappedOkResponse(AppMyInsuranceDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.INSURANCE_COVERAGE_DATE_RANGE_INVALID,
  )
  create(
    @Body() dto: CreateAppMeInsuranceDto,
    @CurrentUser() currentUser: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<AppMyInsuranceDto> {
    return this.service.createMy(dto, currentUser, this.buildAuditMeta(req));
  }

  @Patch(':id')
  @ApiOperation({
    summary:
      '部分更新自购保险(仅本人;他人/不存在/已删统一 26001 防侧信道;终态起保 ≤ 到期否则 26010) [auth]',
  })
  @ApiWrappedOkResponse(AppMyInsuranceDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.MEMBER_INSURANCE_NOT_FOUND,
    BizCode.INSURANCE_COVERAGE_DATE_RANGE_INVALID,
  )
  update(
    @Param('id') id: string,
    @Body() dto: UpdateAppMeInsuranceDto,
    @CurrentUser() currentUser: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<AppMyInsuranceDto> {
    return this.service.updateMy(id, dto, currentUser, this.buildAuditMeta(req));
  }

  @Delete(':id')
  @ApiOperation({
    summary: '删除自购保险(软删;仅本人;他人/不存在/已删统一 26001 防侧信道) [auth]',
  })
  @ApiWrappedOkResponse(AppMyInsuranceDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.MEMBER_INSURANCE_NOT_FOUND,
  )
  softDelete(
    @Param('id') id: string,
    @CurrentUser() currentUser: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<AppMyInsuranceDto> {
    return this.service.softDeleteMy(id, currentUser, this.buildAuditMeta(req));
  }
}
