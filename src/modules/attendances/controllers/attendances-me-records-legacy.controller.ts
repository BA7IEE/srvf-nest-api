import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import {
  ApiBizErrorResponse,
  ApiWrappedPageResponse,
} from '../../../common/decorators/api-response.decorator';
import {
  CurrentUser,
  type CurrentUserPayload,
} from '../../../common/decorators/current-user.decorator';
import { Roles } from '../../../common/decorators/roles.decorator';
import { PageResultDto } from '../../../common/dto/pagination.dto';
import { BizCode } from '../../../common/exceptions/biz-code.constant';
import { AttendanceRecordResponseDto, MyAttendanceRecordsQueryDto } from '../attendances.dto';
import { AttendancesService } from '../attendances.service';

// P1-C step 4(2026-05-26)Mixed Controller 物理拆分:
//   把 attendances.controller.ts 中同文件第三 class
//   `AttendanceRecordsMeController` 物理迁出到独立 Controller 文件。
//   沿 docs/api-surface-policy.md §5 项 2 + §6 项 6 + §7 P1-C step 4;P1-B
//   characterization spec 已在 test/e2e/attendances-me-records-legacy.e2e-spec.ts
//   中锁定现状行为(沿 §7 P1-B 当前状态)。
//
// 拆分硬约束(沿 docs/api-surface-policy.md §8 P1 禁止事项):
//   ❌ 不改 endpoint path(@Controller('v2/users/me/attendance-records') zero drift)
//   ❌ 不改 DTO 字段(沿用既有 MyAttendanceRecordsQueryDto / AttendanceRecordResponseDto)
//   ❌ 不改 service 行为(委托 AttendancesService.listMyRecords)
//   ❌ 不改 Guard / RBAC / @Roles(USER, ADMIN, SUPER_ADMIN)
//   ❌ 不改 Swagger tag(class-level `Mobile - Attendance` 沿用)
//   ❌ 不改 OpenAPI snapshot(class name `AttendanceRecordsMeController` 与 method
//     name `listMyRecords` zero drift,operationId 不漂)
//
// 端点(path 与 HTTP method 与拆分前 zero drift):
//   GET /api/v2/users/me/attendance-records — USER 自己的已通过考勤记录(approved-only)
//
// 本端点为纯读路径,无 audit 写入,不引用 buildAuditMeta;Admin 两 class 仍在
// attendances.controller.ts 顶部使用模块级 buildAuditMeta(沿 PR #173 范式:
// "物理拆分零跨文件耦合",audit helper 不跨文件共享)。

@ApiTags('Mobile - Attendance')
@ApiBearerAuth()
@Controller('v2/users/me/attendance-records')
export class AttendanceRecordsMeController {
  constructor(private readonly service: AttendancesService) {}

  @Get()
  @Roles(Role.USER, Role.ADMIN, Role.SUPER_ADMIN)
  @ApiOperation({
    summary:
      '我的考勤记录(仅 approved Sheet 内 records;Q-A14 / R29 / R33;分页 + 可选 activityId 过滤)',
  })
  @ApiWrappedPageResponse(AttendanceRecordResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.MEMBER_NOT_FOUND,
  )
  listMyRecords(
    @Query() query: MyAttendanceRecordsQueryDto,
    @CurrentUser() currentUser: CurrentUserPayload,
  ): Promise<PageResultDto<AttendanceRecordResponseDto>> {
    return this.service.listMyRecords(query, currentUser);
  }
}
