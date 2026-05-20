import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  ApiBizErrorResponse,
  ApiWrappedOkResponse,
  ApiWrappedPageResponse,
} from '../../../common/decorators/api-response.decorator';
import {
  CurrentUser,
  type CurrentUserPayload,
} from '../../../common/decorators/current-user.decorator';
import { IdParamDto } from '../../../common/dto/id-param.dto';
import { PageResultDto } from '../../../common/dto/pagination.dto';
import { BizCode } from '../../../common/exceptions/biz-code.constant';
import { AppMyActivityListItemDto } from '../../activities/dto/app/app-my-activity-list-item.dto';
import { ListAppMyActivitiesQueryDto } from '../../activities/dto/app/list-app-my-activities-query.dto';
import { AppMyRegistrationsService } from '../app-my-registrations.service';
import { AppMyRegistrationListItemDto } from '../dto/app/app-my-registration-list-item.dto';
import { AppMyRegistrationDto } from '../dto/app/app-my-registration.dto';
import { ListAppMyRegistrationsQueryDto } from '../dto/app/list-app-my-registrations-query.dto';

// Phase 2 P2-5a App /api/app/v1/my/* registrations Mobile Controller(只读 3 endpoint)。
// 沿 docs/app-api-p2-5-registrations-review.md §6.1 + §6.4 + D-P2-5-5:
//   - **新建** @Controller('app/v1/my');物理路径 src/modules/activity-registrations/controllers/
//   - 5 endpoint 都挂此 controller(本 PR 只实施 3 个只读;P2-5b 实施 2 个写)
//   - **不**挂 @Roles(沿 P2-2 / P2-3 / P2-4 范式;App 不用 Role 短路);ADMIN 兼队员
//     可用走 AppIdentityResolver(§7.5 + D-5.2 self perspective)
//   - **不**挂 @Public(全部要登录);依赖全局 JwtAuthGuard
//   - **不**挂限流装饰器(沿 default throttler;§6.1)
//   - **不**追加方法到既有 ActivityRegistrationsMeController(D-P2-5-5;旧 path 逐字不变)
//
// 准入沿 §7.1 / §7.3:canUseApp=false → 403 FORBIDDEN(member 未关联 / INACTIVE / 软删 /
// Admin 无 member);**不**沿 D-P2-3-1 admin-without-member 例外(沿 §7.4)。
// 全部前置在薄壳 AppMyRegistrationsService 内统一做。
//
// 数据范围沿 §7.6 / §11.6:where 永远含 memberId = currentUser.memberId(由 thin-wrap
// ActivityRegistrationsService.listMy / findMy 现状保证;**禁止** role 短路)。
@ApiTags('Mobile - My Registrations')
@ApiBearerAuth()
@Controller('app/v1/my')
export class AppMyRegistrationsController {
  constructor(private readonly appMyRegistrations: AppMyRegistrationsService) {}

  // ============ GET /api/app/v1/my/registrations(P2-5a)============

  @Get('registrations')
  @ApiOperation({
    summary: '我的报名列表(分页 + 可选 statusCode 过滤;sensitive admin 字段不返)',
  })
  @ApiWrappedPageResponse(AppMyRegistrationListItemDto)
  @ApiBizErrorResponse(BizCode.BAD_REQUEST, BizCode.UNAUTHORIZED, BizCode.FORBIDDEN)
  listMy(
    @CurrentUser() currentUser: CurrentUserPayload,
    @Query() query: ListAppMyRegistrationsQueryDto,
  ): Promise<PageResultDto<AppMyRegistrationListItemDto>> {
    return this.appMyRegistrations.listMyForApp(query, currentUser);
  }

  // ============ GET /api/app/v1/my/registrations/:id(P2-5a)============

  @Get('registrations/:id')
  @ApiOperation({
    summary: '我的报名详情(owner 校验:memberId !== currentUser.memberId 统一返 404 防侧信道)',
  })
  @ApiWrappedOkResponse(AppMyRegistrationDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.ACTIVITY_REGISTRATION_NOT_FOUND,
  )
  findMy(
    @CurrentUser() currentUser: CurrentUserPayload,
    @Param() { id }: IdParamDto,
  ): Promise<AppMyRegistrationDto> {
    return this.appMyRegistrations.findMyForApp(id, currentUser);
  }

  // ============ GET /api/app/v1/my/activities(P2-5a)============

  @Get('activities')
  @ApiTags('Mobile - My Activities')
  @ApiOperation({
    summary:
      '我已建立 registration 关系的活动汇总(分页 + 可选 registrationStatusCode 过滤;每活动一行,含本人最新有效 registration 摘要)',
  })
  @ApiWrappedPageResponse(AppMyActivityListItemDto)
  @ApiBizErrorResponse(BizCode.BAD_REQUEST, BizCode.UNAUTHORIZED, BizCode.FORBIDDEN)
  listMyActivities(
    @CurrentUser() currentUser: CurrentUserPayload,
    @Query() query: ListAppMyActivitiesQueryDto,
  ): Promise<PageResultDto<AppMyActivityListItemDto>> {
    return this.appMyRegistrations.listMyActivitiesForApp(query, currentUser);
  }
}
