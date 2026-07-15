import { Role, UserStatus } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import type { AuthzService } from '../authz/authz.service';
import type { AuthzDecision } from '../authz/authz.types';
import type { RbacService } from '../permissions/rbac.service';
import { AdminActivityCheckInsService } from './admin-activity-check-ins.service';
import type { ActivityCheckInQueryService } from './activity-check-in-query.service';
import type {
  AdminActivityCheckInListItemDto,
  AttendanceSheetDraftDto,
} from './activity-check-ins.dto';

const ACTIVITY_ID = 'activity-0001';
const CURRENT_USER: CurrentUserPayload = {
  id: 'user-0001',
  username: 'admin',
  role: Role.ADMIN,
  status: UserStatus.ACTIVE,
  memberId: null,
};
const PAGE_QUERY = { page: 2, pageSize: 10 };

const PAGE_RESULT = {
  items: [] as AdminActivityCheckInListItemDto[],
  total: 0,
  page: 2,
  pageSize: 10,
};
const DRAFT_RESULT: AttendanceSheetDraftDto = {
  activityId: ACTIVITY_ID,
  records: [],
  flags: [],
  absentRegistrations: [],
};

describe('AdminActivityCheckInsService', () => {
  let authz: { explain: jest.Mock<Promise<AuthzDecision>, unknown[]> };
  let rbac: { can: jest.Mock<Promise<boolean>, unknown[]> };
  let query: {
    list: jest.Mock;
    attendanceSheetDraft: jest.Mock;
  };
  let service: AdminActivityCheckInsService;

  beforeEach(() => {
    authz = {
      explain: jest
        .fn<Promise<AuthzDecision>, unknown[]>()
        .mockResolvedValue({ allow: true, reason: 'matched' }),
    };
    rbac = { can: jest.fn<Promise<boolean>, unknown[]>().mockResolvedValue(true) };
    query = {
      list: jest.fn().mockResolvedValue(PAGE_RESULT),
      attendanceSheetDraft: jest.fn().mockResolvedValue(DRAFT_RESULT),
    };
    service = new AdminActivityCheckInsService(
      authz as unknown as AuthzService,
      rbac as unknown as RbacService,
      query as unknown as ActivityCheckInQueryService,
    );
  });

  it('allow：list 使用 activity ref 判权后原样委托 QueryService', async () => {
    await expect(service.list(ACTIVITY_ID, PAGE_QUERY, CURRENT_USER)).resolves.toBe(PAGE_RESULT);

    expect(authz.explain).toHaveBeenCalledWith(CURRENT_USER, 'attendance.read.sheet', {
      type: 'activity',
      id: ACTIVITY_ID,
    });
    expect(rbac.can).not.toHaveBeenCalled();
    expect(query.list).toHaveBeenCalledWith(ACTIVITY_ID, PAGE_QUERY);
  });

  it('allow：attendance-sheet-draft 使用同一 activity ref 后原样委托 QueryService', async () => {
    await expect(service.attendanceSheetDraft(ACTIVITY_ID, CURRENT_USER)).resolves.toBe(
      DRAFT_RESULT,
    );

    expect(authz.explain).toHaveBeenCalledWith(CURRENT_USER, 'attendance.read.sheet', {
      type: 'activity',
      id: ACTIVITY_ID,
    });
    expect(rbac.can).not.toHaveBeenCalled();
    expect(query.attendanceSheetDraft).toHaveBeenCalledWith(ACTIVITY_ID);
  });

  it('resource_not_found + 持全局码：允许 QueryService 执行真实 activity 存在性检查', async () => {
    authz.explain.mockResolvedValue({ allow: false, reason: 'resource_not_found' });
    rbac.can.mockResolvedValue(true);

    await expect(service.list(ACTIVITY_ID, PAGE_QUERY, CURRENT_USER)).resolves.toBe(PAGE_RESULT);

    expect(rbac.can).toHaveBeenCalledWith(CURRENT_USER, 'attendance.read.sheet');
    expect(query.list).toHaveBeenCalledWith(ACTIVITY_ID, PAGE_QUERY);
  });

  it('resource_not_found + 无全局码：拒绝且不触发业务查询', async () => {
    authz.explain.mockResolvedValue({ allow: false, reason: 'resource_not_found' });
    rbac.can.mockResolvedValue(false);

    await expect(service.attendanceSheetDraft(ACTIVITY_ID, CURRENT_USER)).rejects.toEqual(
      new BizException(BizCode.RBAC_FORBIDDEN),
    );

    expect(rbac.can).toHaveBeenCalledWith(CURRENT_USER, 'attendance.read.sheet');
    expect(query.attendanceSheetDraft).not.toHaveBeenCalled();
  });

  it('其它 deny reason：直接拒绝，不回退全局码也不触发业务查询', async () => {
    authz.explain.mockResolvedValue({ allow: false, reason: 'out_of_scope' });

    await expect(service.list(ACTIVITY_ID, PAGE_QUERY, CURRENT_USER)).rejects.toEqual(
      new BizException(BizCode.RBAC_FORBIDDEN),
    );

    expect(rbac.can).not.toHaveBeenCalled();
    expect(query.list).not.toHaveBeenCalled();
  });
});
