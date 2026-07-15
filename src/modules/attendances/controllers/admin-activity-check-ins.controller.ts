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
import type { PageResultDto } from '../../../common/dto/pagination.dto';
import { BizCode } from '../../../common/exceptions/biz-code.constant';
import { AdminActivityCheckInsService } from '../admin-activity-check-ins.service';
import {
  AdminActivityCheckInListItemDto,
  AttendanceSheetDraftDto,
  ListActivityCheckInsQueryDto,
} from '../activity-check-ins.dto';
import { ActivityIdParamDto } from '../attendances.dto';

@ApiTags('Admin - Attendances')
@ApiBearerAuth()
@Controller('admin/v1/activities/:activityId')
export class AdminActivityCheckInsController {
  constructor(private readonly checkIns: AdminActivityCheckInsService) {}

  @Get('check-ins')
  @ApiOperation({
    summary: '分页查看活动 GPS 打卡证据 [rbac: attendance.read.sheet]',
  })
  @ApiWrappedPageResponse(AdminActivityCheckInListItemDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ACTIVITY_NOT_FOUND,
  )
  list(
    @Param() { activityId }: ActivityIdParamDto,
    @Query() query: ListActivityCheckInsQueryDto,
    @CurrentUser() currentUser: CurrentUserPayload,
  ): Promise<PageResultDto<AdminActivityCheckInListItemDto>> {
    return this.checkIns.list(activityId, query, currentUser);
  }

  @Get('attendance-sheet-draft')
  @ApiOperation({
    summary: '生成活动考勤提交草稿（只读不落库） [rbac: attendance.read.sheet]',
  })
  @ApiWrappedOkResponse(AttendanceSheetDraftDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ACTIVITY_NOT_FOUND,
  )
  attendanceSheetDraft(
    @Param() { activityId }: ActivityIdParamDto,
    @CurrentUser() currentUser: CurrentUserPayload,
  ): Promise<AttendanceSheetDraftDto> {
    return this.checkIns.attendanceSheetDraft(activityId, currentUser);
  }
}
