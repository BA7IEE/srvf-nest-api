import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import {
  buildActivitySeriesRequestHash,
  normalizeCreateActivitySeriesCommand,
  normalizeSetActivitySeriesStatusCommand,
  toActivitySeriesRevisionHashPayload,
  type CreateActivitySeriesCommand,
} from './activity-series-command';

const COMMAND: CreateActivitySeriesCommand = {
  code: 'a7-series-command',
  templateVersionId: 'template-a7-command-0001',
  frequencyCode: 'weekly',
  interval: 2,
  weeklyWeekdays: [3, 1],
  timeZone: 'Asia/Shanghai',
  localStartDate: '2099-01-05',
  localStartMinute: 9 * 60,
  durationMinutes: 120,
  title: 'A7 命令规范化',
  organizationId: 'organization-a7-command-0001',
  location: '集合点',
  registrationDeadlineOffsetMinutes: 60,
  effectiveFromLocalDate: '2099-01-05',
  effectiveToLocalDate: '2099-03-31',
  generationWindowDays: 31,
  operationKey: 'a7-command-operation-0001',
};

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

describe('ActivitySeries command normalization', () => {
  it('规范化周期输入，并为同一 canonical payload 计算稳定 requestHash', () => {
    const input = normalizeCreateActivitySeriesCommand(COMMAND);
    const payload = {
      code: input.code,
      revision: toActivitySeriesRevisionHashPayload(input),
    };

    expect(input.schedule.weeklyWeekdays).toEqual([1, 3]);
    expect(input.schedule.weeklyWeekdayMask).toBe(5);
    expect(
      buildActivitySeriesRequestHash(
        'create_series',
        'user-a7-command-0001',
        input.operationKey,
        payload,
      ),
    ).toBe(
      buildActivitySeriesRequestHash(
        'create_series',
        'user-a7-command-0001',
        input.operationKey,
        payload,
      ),
    );
    expect(
      buildActivitySeriesRequestHash('create_series', 'user-a7-command-0001', input.operationKey, {
        ...payload,
        code: 'another-series',
      }),
    ).not.toBe(
      buildActivitySeriesRequestHash(
        'create_series',
        'user-a7-command-0001',
        input.operationKey,
        payload,
      ),
    );
  });

  it('拒绝未知字段、非固定时区与非法状态', () => {
    expectBadRequest(() =>
      normalizeCreateActivitySeriesCommand({ ...COMMAND, timeZone: 'Asia/Tokyo' } as never),
    );
    expectBadRequest(() =>
      normalizeCreateActivitySeriesCommand({ ...COMMAND, unexpected: true } as never),
    );
    expectBadRequest(() =>
      normalizeSetActivitySeriesStatusCommand({
        seriesId: 'series-a7-command-0001',
        statusCode: 'paused-again' as never,
        operationKey: 'a7-status-operation-0001',
      }),
    );
  });
});
