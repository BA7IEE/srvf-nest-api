import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  ApiBizErrorResponse,
  ApiWrappedPageResponse,
} from '../../../common/decorators/api-response.decorator';
import {
  CurrentUser,
  type CurrentUserPayload,
} from '../../../common/decorators/current-user.decorator';
import { PageResultDto, PaginationQueryDto } from '../../../common/dto/pagination.dto';
import { BizCode } from '../../../common/exceptions/biz-code.constant';
import { BizException } from '../../../common/exceptions/biz.exception';
import { AppIdentityResolver } from '../../users/app-identity.resolver';
import { AppActivitiesService } from '../app-activities.service';
import { AppAvailableActivityListItemDto } from '../dto/app/app-available-activity-list-item.dto';

// Phase 2 P2-4a App /api/app/v1/activities/* Mobile Controller(列表 only)。
// 沿 docs/app-api-p2-4-activities-review.md §1 + §6.1 + §11.3:
//   - JwtAuthGuard 全局生效;未挂 @Roles(沿 §6.1 + §8.4 复用既有基础设施)
//   - canUseApp=false 统一 FORBIDDEN(40300;沿 §6.1 P2-4 不新增 BizCode)
//   - 不沿 P2-3 admin-without-member 例外:Admin 无 member 关联看"可参加活动"无意义(§6.2)
//   - scope 隐式 self-perspective(每个 member 看到的 published 活动池相同;沿 §6.5)
//   - 旧 /api/v2/activities* 行为**逐字不变**(沿 §11.4 + 风险表 13.12)
//
// **D-P2-4-5 = split(v0.1 锁定)**:本 Controller 当前仅 list method;
// `GET /:id` 详情归 P2-4b 独立 PR(沿 §12.2);**禁止**在本 PR 顺手追加。
@ApiTags('Mobile - Activities')
@ApiBearerAuth()
@Controller('app/v1/activities')
export class AppActivitiesController {
  constructor(
    private readonly appIdentity: AppIdentityResolver,
    private readonly appActivities: AppActivitiesService,
  ) {}

  @Get('available')
  @ApiOperation({
    summary: 'App 视角可参加活动列表(分页;仅 statusCode=published 且未软删)',
  })
  @ApiWrappedPageResponse(AppAvailableActivityListItemDto)
  @ApiBizErrorResponse(BizCode.BAD_REQUEST, BizCode.UNAUTHORIZED, BizCode.FORBIDDEN)
  async listAvailable(
    @CurrentUser() currentUser: CurrentUserPayload,
    @Query() query: PaginationQueryDto,
  ): Promise<PageResultDto<AppAvailableActivityListItemDto>> {
    // 沿评审稿 §6.1:canUseApp=false → FORBIDDEN(覆盖 member 未关联 / INACTIVE / 软删三种 reason)。
    // 不沿 P2-3 admin-without-member 例外(沿 §6.2);Admin 无 member 同走 FORBIDDEN。
    const access = await this.appIdentity.resolve(currentUser);
    if (!access.canUseApp || access.member === null) {
      throw new BizException(BizCode.FORBIDDEN);
    }

    return this.appActivities.listAvailableForMember(access.member.id, query);
  }
}
