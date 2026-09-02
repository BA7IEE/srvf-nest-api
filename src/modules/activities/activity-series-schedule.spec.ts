import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import {
  ACTIVITY_SERIES_TIME_ZONE,
  generateActivitySeriesOccurrenceCandidates,
  normalizeActivitySeriesSchedule,
  normalizeStoredActivitySeriesSchedule,
} from './activity-series-schedule';

function expectBadRequest(action: () => unknown): void {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(BizException);
    expect((error as BizException).biz).toBe(BizCode.BAD_REQUEST);
    return;
  }
  throw new Error('expected BAD_REQUEST');
}

describe('ActivitySeries schedule V1', () => {
  it('只接受 Asia/Shanghai 的确定性本地日期转 UTC', () => {
    const schedule = normalizeActivitySeriesSchedule({ frequencyCode: 'daily', interval: 1 });
    const candidates = generateActivitySeriesOccurrenceCandidates({
      schedule,
      localStartDate: '2099-01-01',
      localStartMinute: 9 * 60,
      durationMinutes: 120,
      effectiveFromLocalDate: '2099-01-01',
      effectiveToLocalDate: '2099-01-03',
      windowStartLocalDate: '2099-01-01',
      generationWindowDays: 3,
    });

    expect(ACTIVITY_SERIES_TIME_ZONE).toBe('Asia/Shanghai');
    expect(candidates.map((candidate) => candidate.occurrenceKey)).toEqual([
      '2099-01-01',
      '2099-01-02',
      '2099-01-03',
    ]);
    expect(candidates[0]?.startAt.toISOString()).toBe('2099-01-01T01:00:00.000Z');
    expect(candidates[0]?.endAt.toISOString()).toBe('2099-01-01T03:00:00.000Z');
  });

  it('weekly 以 anchor 所在周和 Monday=1 的 weekday 闭集计算 interval', () => {
    const schedule = normalizeActivitySeriesSchedule({
      frequencyCode: 'weekly',
      interval: 2,
      weeklyWeekdays: [1, 3],
    });
    const candidates = generateActivitySeriesOccurrenceCandidates({
      schedule,
      localStartDate: '2099-01-05', // Monday
      localStartMinute: 8 * 60,
      durationMinutes: 60,
      effectiveFromLocalDate: '2099-01-05',
      effectiveToLocalDate: '2099-02-04',
      windowStartLocalDate: '2099-01-05',
      generationWindowDays: 31,
    });

    expect(candidates.map((candidate) => candidate.localStartDate)).toEqual([
      '2099-01-05',
      '2099-01-07',
      '2099-01-19',
      '2099-01-21',
      '2099-02-02',
      '2099-02-04',
    ]);
  });

  it('monthly 缺失日期直接 skip，绝不挪到月末', () => {
    const schedule = normalizeActivitySeriesSchedule({
      frequencyCode: 'monthly',
      interval: 1,
      monthlyDay: 31,
    });
    const candidates = generateActivitySeriesOccurrenceCandidates({
      schedule,
      localStartDate: '2099-01-31',
      localStartMinute: 10 * 60,
      durationMinutes: 30,
      effectiveFromLocalDate: '2099-01-31',
      effectiveToLocalDate: '2099-03-31',
      windowStartLocalDate: '2099-01-31',
      generationWindowDays: 60,
    });

    expect(candidates.map((candidate) => candidate.localStartDate)).toEqual([
      '2099-01-31',
      '2099-03-31',
    ]);
  });

  it('拒绝未知字段、重复 weekday 与不属于该频率的规则字段', () => {
    expectBadRequest(() =>
      normalizeActivitySeriesSchedule({ frequencyCode: 'daily', interval: 1, rrule: 'FREQ=DAILY' }),
    );
    expectBadRequest(() =>
      normalizeActivitySeriesSchedule({
        frequencyCode: 'weekly',
        interval: 1,
        weeklyWeekdays: [1, 1],
      }),
    );
    expectBadRequest(() =>
      normalizeActivitySeriesSchedule({
        frequencyCode: 'monthly',
        interval: 1,
        monthlyDay: 31,
        weeklyWeekdays: [1],
      }),
    );
    expectBadRequest(() =>
      normalizeStoredActivitySeriesSchedule({
        frequencyCode: 'daily',
        interval: 1,
        weeklyWeekdayMask: 1,
        monthlyDay: null,
      }),
    );
  });
});
