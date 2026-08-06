import { Prisma } from '@prisma/client';
import { BizCode, type BizCodeEntry } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import type { PrismaService } from '../../database/prisma.service';
import type { ActivityDraftAuditRecorder } from './activity-draft-audit-recorder';
import { ActivityDraftService } from './activity-draft.service';

/**
 * §3.2/§3.3 的 DB 约束仍是最后一道防线（并发、绕过前置校验等）。这里直接用真实 Prisma
 * Error 类型锁定防线的出口，避免未来把 P2002/P2004 原样漏到 HTTP 层。
 */
describe('ActivityDraftService Prisma constraint normalization', () => {
  const service = new ActivityDraftService({} as PrismaService, {} as ActivityDraftAuditRecorder);
  const rethrow = (error: unknown, target: 'session' | 'position') =>
    (
      service as unknown as {
        rethrowConstraint(error: unknown, target: 'session' | 'position'): never;
      }
    ).rethrowConstraint(error, target);

  const prismaError = (code: string, marker: string) =>
    new Prisma.PrismaClientKnownRequestError(`constraint ${marker}`, {
      code,
      clientVersion: 'test',
      meta: { database_error: marker },
    });

  const expectBiz = (error: unknown, target: 'session' | 'position', biz: BizCodeEntry) => {
    try {
      rethrow(error, target);
      throw new Error('expected rethrowConstraint to throw');
    } catch (actual) {
      expect(actual).toEqual(new BizException(biz));
    }
  };

  it.each([
    [
      'activity_session_activity_code_live_unique',
      'session',
      BizCode.ACTIVITY_SESSION_CODE_ALREADY_EXISTS,
    ],
    [
      'activity_session_activity_name_live_unique',
      'session',
      BizCode.ACTIVITY_SESSION_NAME_ALREADY_EXISTS,
    ],
    [
      'activity_session_position_session_code_live_unique',
      'position',
      BizCode.ACTIVITY_SESSION_POSITION_CODE_ALREADY_EXISTS,
    ],
    [
      'activity_session_position_session_name_live_unique',
      'position',
      BizCode.ACTIVITY_SESSION_POSITION_NAME_ALREADY_EXISTS,
    ],
  ] as const)('maps P2002 %s to the stable %s domain code', (marker, target, biz) => {
    expectBiz(prismaError('P2002', marker), target, biz);
  });

  it.each([
    ['activity_session_capacity_positive_check', BizCode.ACTIVITY_SESSION_CAPACITY_INVALID],
    ['activity_session_time_range_check', BizCode.ACTIVITY_SESSION_TIME_RANGE_INVALID],
    ['activity_session_checkin_window_check', BizCode.ACTIVITY_SESSION_WINDOW_INVALID],
    ['activity_session_checkout_window_check', BizCode.ACTIVITY_SESSION_WINDOW_INVALID],
    ['activity_session_preparation_start_check', BizCode.ACTIVITY_SESSION_WINDOW_INVALID],
    ['activity_session_coordinate_pair_check', BizCode.ACTIVITY_SESSION_LOCATION_POLICY_INVALID],
    ['activity_session_location_policy_check', BizCode.ACTIVITY_SESSION_LOCATION_POLICY_INVALID],
    [
      'activity_session_location_policy_source_check',
      BizCode.ACTIVITY_SESSION_LOCATION_POLICY_INVALID,
    ],
    ['activity_session_grace_minutes_range_check', BizCode.ACTIVITY_SESSION_WINDOW_INVALID],
  ] as const)('maps session P2004 CHECK %s without exposing Prisma', (marker, biz) => {
    expectBiz(prismaError('P2004', marker), 'session', biz);
  });

  it.each([
    [
      'activity_session_position_capacity_positive_check',
      BizCode.ACTIVITY_SESSION_POSITION_CAPACITY_INVALID,
    ],
    [
      'activity_session_position_time_pair_check',
      BizCode.ACTIVITY_SESSION_POSITION_TIME_RANGE_INVALID,
    ],
    [
      'activity_session_position_location_policy_check',
      BizCode.ACTIVITY_SESSION_POSITION_LOCATION_POLICY_INVALID,
    ],
  ] as const)('maps position P2004 CHECK %s without exposing Prisma', (marker, biz) => {
    expectBiz(prismaError('P2004', marker), 'position', biz);
  });

  it('maps PostgreSQL 23514 text retained by Prisma unknown-request errors', () => {
    expectBiz(
      new Prisma.PrismaClientUnknownRequestError(
        'new row violates check constraint "activity_session_capacity_positive_check"',
        { clientVersion: 'test' },
      ),
      'session',
      BizCode.ACTIVITY_SESSION_CAPACITY_INVALID,
    );
  });

  it('maps foreign-key defensive failures to hidden ACTIVITY_NOT_FOUND', () => {
    expectBiz(
      prismaError('P2003', 'ActivitySessionPosition_activityId_sessionId_fkey'),
      'position',
      BizCode.ACTIVITY_NOT_FOUND,
    );
  });
});
