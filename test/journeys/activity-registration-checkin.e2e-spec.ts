import { Logger } from '@nestjs/common';

import {
  JOURNEY_2_KNOWN_GAP,
  JOURNEY_2_REVIEW_TRIGGER,
  runActivityRegistrationCheckInJourney,
} from '../support/journey-activity-registration-checkin';
import { createJourneyRuntime, type JourneyRuntime } from '../support/journey-runtime';

describe('旅程金五条② 活动报名审批签到（当前真实部分链）', () => {
  let runtime: JourneyRuntime;
  let log: jest.SpyInstance;

  beforeAll(async () => {
    // createJourneyRuntime 走与生产相同的 Nest bootstrap；借此同时验证 report Guard 在启动时盘点。
    log = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    runtime = await createJourneyRuntime();
  });

  afterAll(async () => {
    await runtime.close();
    log.mockRestore();
  });

  it('经真实 HTTP 留下 ActivityCheckIn 证据，并登记结算账本的具名缺口', async () => {
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'authz_declaration_inventory',
        mode: 'report',
        totalUndeclaredRouteCount: 387,
      }),
      'Route authorization declaration inventory',
    );

    const result = await runActivityRegistrationCheckInJourney(runtime);

    expect(result.checkInRegistrationId).toBe(result.registrationId);
    expect(result.replayCheckInId).toBe(result.checkInId);
    expect(result.checkInCount).toBe(1);
    expect(result.knownGap).toBe(JOURNEY_2_KNOWN_GAP);
    expect(result.reviewTrigger).toBe(JOURNEY_2_REVIEW_TRIGGER);

    // 变异红证据：若合法重试不再返回同一 ActivityCheckIn，或一报名可生成多条证据，id/count
    // 任一断言都会变红；该探针不通过 Prisma 伪造 punch 或结算事实。
  });
});
