import { BizCode } from '../../common/exceptions/biz-code.constant';
import { ActivityCheckInPolicy, CHECK_OUT_MIN_SPAN_MS } from './activity-check-in-policy';

const HOUR = 3_600_000;
const START = new Date('2026-07-15T08:00:00.000Z');
const END = new Date('2026-07-15T12:00:00.000Z');

describe('ActivityCheckInPolicy', () => {
  const policy = new ActivityCheckInPolicy();
  const schedule = { startAt: START, endAt: END };

  it.each([
    ['check-in', 'published', true, undefined],
    ['check-out', 'published', true, undefined],
    ['check-in', 'draft', false, BizCode.ACTIVITY_NOT_PUBLISHED_PARTICIPATION_FORBIDDEN],
    ['check-out', 'draft', false, BizCode.ACTIVITY_NOT_PUBLISHED_PARTICIPATION_FORBIDDEN],
    ['check-in', 'cancelled', false, BizCode.ACTIVITY_CANCELLED_ATTENDANCE_FORBIDDEN],
    ['check-out', 'cancelled', false, BizCode.ACTIVITY_CANCELLED_ATTENDANCE_FORBIDDEN],
    ['check-in', 'completed', false, BizCode.ACTIVITY_STATUS_INVALID],
    ['check-out', 'completed', true, undefined],
  ] as const)('%s + %s 状态矩阵', (action, status, allowed, biz) => {
    const decision = policy.canWriteByStatus(action, status);
    expect(decision.allowed).toBe(allowed);
    if (!decision.allowed) expect(decision.biz).toBe(biz);
  });

  it('签到上下边界闭区间，endAt-36s 后统一时间窗外', () => {
    const earliest = new Date(START.getTime() - 2 * HOUR);
    const latest = new Date(END.getTime() - CHECK_OUT_MIN_SPAN_MS);
    expect(policy.canWriteByTime('check-in', schedule, earliest, 2)).toEqual({ allowed: true });
    expect(policy.canWriteByTime('check-in', schedule, latest, 2)).toEqual({ allowed: true });
    expect(
      policy.canWriteByTime('check-in', schedule, new Date(earliest.getTime() - 1), 2),
    ).toEqual({
      allowed: false,
      biz: BizCode.ATTENDANCE_OUTSIDE_ACTIVITY_WINDOW,
    });
    expect(policy.canWriteByTime('check-in', schedule, new Date(latest.getTime() + 1), 2)).toEqual({
      allowed: false,
      biz: BizCode.ATTENDANCE_OUTSIDE_ACTIVITY_WINDOW,
    });
  });

  it('签退上下边界闭区间，首次签退严格执行 checkInAt+36s floor', () => {
    const earliest = new Date(START.getTime() - 2 * HOUR);
    const latest = new Date(END.getTime() + 2 * HOUR);
    const checkInAt = new Date(START.getTime());
    expect(
      policy.canWriteByTime(
        'check-out',
        schedule,
        earliest,
        2,
        new Date(earliest.getTime() - CHECK_OUT_MIN_SPAN_MS),
      ),
    ).toEqual({ allowed: true });
    expect(policy.canWriteByTime('check-out', schedule, latest, 2, checkInAt)).toEqual({
      allowed: true,
    });
    expect(
      policy.canWriteByTime(
        'check-out',
        schedule,
        new Date(checkInAt.getTime() + CHECK_OUT_MIN_SPAN_MS - 1),
        2,
        checkInAt,
      ),
    ).toEqual({ allowed: false, biz: BizCode.ATTENDANCE_SERVICE_HOURS_INVALID });
    expect(
      policy.canWriteByTime(
        'check-out',
        schedule,
        new Date(checkInAt.getTime() + CHECK_OUT_MIN_SPAN_MS),
        2,
        checkInAt,
      ),
    ).toEqual({ allowed: true });
    expect(
      policy.canWriteByTime('check-out', schedule, new Date(latest.getTime() + 1), 2, checkInAt),
    ).toEqual({ allowed: false, biz: BizCode.ATTENDANCE_OUTSIDE_ACTIVITY_WINDOW });
  });

  it('短活动使签到区间为空时不会错误放行', () => {
    const short = {
      startAt: new Date('2026-07-15T08:00:00.000Z'),
      endAt: new Date('2026-07-15T08:00:20.000Z'),
    };
    expect(policy.canWriteByTime('check-in', short, short.startAt, 0)).toEqual({
      allowed: false,
      biz: BizCode.ATTENDANCE_OUTSIDE_ACTIVITY_WINDOW,
    });
  });
});
