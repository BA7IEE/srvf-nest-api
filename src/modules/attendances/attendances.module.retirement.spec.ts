import { MODULE_METADATA } from '@nestjs/common/constants';

import { AppActivityPunchesController } from './controllers/app-activity-punches.controller';
import { AppManagedActivityOnsiteOperationsController } from './controllers/app-managed-activity-onsite-operations.controller';
import { AppMyParticipationSummaryController } from './controllers/app-my-participation-summary.controller';
import { AdminMemberAttendanceController } from './controllers/admin-member-attendance.controller';
import { AttendancesModule } from './attendances.module';

function names(key: string): string[] {
  const entries = Reflect.getMetadata(key, AttendancesModule) as
    | Array<{ name?: string }>
    | undefined;
  return (entries ?? []).map((entry) => entry.name ?? '');
}

describe('new attendance workflow module composition', () => {
  it('does not register legacy sheet, GPS check-in or old attendance-record controllers', () => {
    const registered = names(MODULE_METADATA.CONTROLLERS);
    expect(registered).not.toEqual(
      expect.arrayContaining([
        'AttendanceSheetsCollectionController',
        'AttendanceSheetsResourceController',
        'AdminActivityCheckInsController',
        'AppActivityCheckInsController',
        'AppMyAttendanceRecordsController',
        'AppManagedActivityAttendancesController',
      ]),
    );
    for (const retired of [
      'AttendanceSheetsCollectionController',
      'AttendanceSheetsResourceController',
      'AdminActivityCheckInsController',
      'AppActivityCheckInsController',
      'AppMyAttendanceRecordsController',
      'AppManagedActivityAttendancesController',
    ]) {
      expect(registered).not.toContain(retired);
    }
    expect(registered).toEqual(
      expect.arrayContaining([
        AppActivityPunchesController.name,
        AppManagedActivityOnsiteOperationsController.name,
        AppMyParticipationSummaryController.name,
        AdminMemberAttendanceController.name,
      ]),
    );
  });

  it('does not instantiate retired sheet or GPS writer providers in any gate state', () => {
    const registered = names(MODULE_METADATA.PROVIDERS);
    for (const retired of [
      'AttendancesService',
      'AttendanceReviewService',
      'AttendanceReadService',
      'AttendanceAccessService',
      'AppActivityCheckInsService',
      'AppManagedActivityAttendancesService',
      'AdminActivityCheckInsService',
      'AppMyAttendanceRecordsService',
    ]) {
      expect(registered).not.toContain(retired);
    }
    expect(registered).toContain('AttendancePunchCommandService');
    expect(registered).toContain('ParticipationSummaryQueryService');
    expect(registered).toContain('ParticipationSegmentFacade');
  });
});
