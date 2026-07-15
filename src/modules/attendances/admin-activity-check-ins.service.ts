import { Injectable } from '@nestjs/common';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import type { PageResultDto } from '../../common/dto/pagination.dto';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { AuthzService } from '../authz/authz.service';
import { RbacService } from '../permissions/rbac.service';
import { ActivityCheckInQueryService } from './activity-check-in-query.service';
import {
  AdminActivityCheckInListItemDto,
  AttendanceSheetDraftDto,
  ListActivityCheckInsQueryDto,
} from './activity-check-ins.dto';

const ATTENDANCE_READ_SHEET_ACTION = 'attendance.read.sheet';

// Admin application boundary：集中编排 activity ref 授权；QueryService 只负责只读取数与聚合。
@Injectable()
export class AdminActivityCheckInsService {
  constructor(
    private readonly authz: AuthzService,
    private readonly rbac: RbacService,
    private readonly query: ActivityCheckInQueryService,
  ) {}

  private async assertCanReadActivity(
    activityId: string,
    currentUser: CurrentUserPayload,
  ): Promise<void> {
    const decision = await this.authz.explain(currentUser, ATTENDANCE_READ_SHEET_ACTION, {
      type: 'activity',
      id: activityId,
    });
    if (decision.allow) return;
    if (
      decision.reason === 'resource_not_found' &&
      (await this.rbac.can(currentUser, ATTENDANCE_READ_SHEET_ACTION))
    ) {
      return;
    }
    throw new BizException(BizCode.RBAC_FORBIDDEN);
  }

  async list(
    activityId: string,
    query: ListActivityCheckInsQueryDto,
    currentUser: CurrentUserPayload,
  ): Promise<PageResultDto<AdminActivityCheckInListItemDto>> {
    await this.assertCanReadActivity(activityId, currentUser);
    return this.query.list(activityId, query);
  }

  async attendanceSheetDraft(
    activityId: string,
    currentUser: CurrentUserPayload,
  ): Promise<AttendanceSheetDraftDto> {
    await this.assertCanReadActivity(activityId, currentUser);
    return this.query.attendanceSheetDraft(activityId);
  }
}
