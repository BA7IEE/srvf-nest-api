import { runOutboxDeliveryJourney } from '../support/journey-outbox-delivery';
import { createJourneyRuntime, type JourneyRuntime } from '../support/journey-runtime';

describe('旅程金五条⑤ 业务事件→outbox intent→worker', () => {
  let runtime: JourneyRuntime;

  beforeAll(async () => {
    runtime = await createJourneyRuntime();
  });

  afterAll(async () => {
    await runtime.close();
  });

  it('发布通知后由 worker 展开投递，并把暂态失败重试至 dead', async () => {
    const result = await runOutboxDeliveryJourney(runtime);

    expect(result.rootSucceeded).toBe(true);
    expect(result.successfulDeliveryStatus).toBe('sent');
    expect(result.retryAttempts).toBe(8);
    expect(result.retryStatus).toBe('dead');

    // 变异红证据：DevStub 注入 40001 后每轮须留下暂态失败，耗尽后不能假装成功。
    expect(result.transientFailureCount).toBe(8);
  });
});
