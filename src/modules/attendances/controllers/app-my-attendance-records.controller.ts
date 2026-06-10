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
import { PageResultDto } from '../../../common/dto/pagination.dto';
import { BizCode } from '../../../common/exceptions/biz-code.constant';
import { AppMyAttendanceRecordsService } from '../app-my-attendance-records.service';
import { AppMyAttendanceRecordDto } from '../dto/app/app-my-attendance-record.dto';
import { ListAppMyAttendanceRecordsQueryDto } from '../dto/app/list-app-my-attendance-records-query.dto';

// Phase 2 P2-6 App /api/app/v1/my/attendance-records Mobile Controller(1 endpoint)。
// 沿 docs/app-api-p2-6-attendance-records-review.md §7.2 + D-P2-6-3:
//   - **新建** @Controller('app/v1/my');物理路径 src/modules/attendances/controllers/
//   - 与 AppMyRegistrationsController('app/v1/my') 共享前缀;NestJS 允许多 controller
//     共享前缀,endpoint path 不重叠(此处 /attendance-records vs /registrations / /activities)
//   - **不**挂 @Roles(沿 P2-2 / P2-3 / P2-4 / P2-5 范式;App 不用 Role 短路);
//     ADMIN 兼队员可用走 AppIdentityResolver(D-P2-6-13 self perspective)
//   - **不**挂 @Public(全部要登录);依赖全局 JwtAuthGuard
//   - **不**挂限流装饰器(沿 default throttler)
//   - App 自助端点只落本 controller(`app/v1/my`);**不**混入 Admin controller(沿 D-P2-6-15;
//     原 `/v2/users/me/attendance-records` legacy controller 已于 Route B Phase 4d2 删除)
//
// 准入沿 §8.1 / §8.2:canUseApp=false → 403 FORBIDDEN(member 未关联 / INACTIVE / 软删 /
// Admin 无 member);**不**沿 D-P2-3-1 admin-without-member 例外(沿 D-P2-6-12)。
// 全部前置在薄壳 AppMyAttendanceRecordsService 内统一做。
//
// 数据范围沿评审稿 §4 过滤铁律:where 永远含 memberId = currentUser.memberId
// (由 thin-wrap AttendancesService.listMyRecords 现状保证;**禁止** role 短路 /
// 接收 query memberId,DTO 严格白名单已挡)。
//
// 派生字段沿 §5.1 + §7.4:5 个 activity* 字段通过 AppMy service 内 2 次 IN 批量自查
// 派生(sheet IN + activity IN);**0** attendances.service.ts 改动。
@ApiTags('Mobile - My Attendance')
@ApiBearerAuth()
@Controller('app/v1/my')
export class AppMyAttendanceRecordsController {
  constructor(private readonly appMyAttendanceRecords: AppMyAttendanceRecordsService) {}

  // ============ GET /api/app/v1/my/attendance-records(P2-6)============

  @Get('attendance-records')
  @ApiOperation({
    summary:
      '我的考勤记录列表(仅 approved Sheet 内 records;分页 + 可选 activityId 过滤;含 activity 派生字段) [auth]',
  })
  @ApiWrappedPageResponse(AppMyAttendanceRecordDto)
  @ApiBizErrorResponse(BizCode.BAD_REQUEST, BizCode.UNAUTHORIZED, BizCode.FORBIDDEN)
  listMyAttendanceRecords(
    @CurrentUser() currentUser: CurrentUserPayload,
    @Query() query: ListAppMyAttendanceRecordsQueryDto,
  ): Promise<PageResultDto<AppMyAttendanceRecordDto>> {
    return this.appMyAttendanceRecords.listMyAttendanceRecords(query, currentUser);
  }
}
