import {
  JOURNEY_2_KNOWN_GAP,
  JOURNEY_2_REVIEW_TRIGGER,
  runActivityRegistrationCheckInJourney,
} from '../support/journey-activity-registration-checkin';
import { createJourneyRuntime, type JourneyRuntime } from '../support/journey-runtime';

/**
 * Activity OS 无 AI 业务 Journey 的当前基线入口。
 *
 * 结构判据 `src/ai-dependency-boundary.criteria.spec.ts` 负责证明核心没有 AI 依赖；本 spec
 * 则在真实 Nest 启动中证明现有 Activity 金路径无需 AI Runtime 即可完成。随着模板、发布、
 * 时长、贡献、成果与更正的正式链路逐条落地，应在这里或同级 Journey 扩展对应的手工路径。
 */
describe('Activity OS 无 AI 业务 Journey（当前基线入口）', () => {
  let runtime: JourneyRuntime;

  beforeAll(async () => {
    runtime = await createJourneyRuntime();
  });

  afterAll(async () => {
    await runtime.close();
  });

  it('无 AI Runtime 时仍可经真实 HTTP 创建、发布、报名、审批并签到', async () => {
    const result = await runActivityRegistrationCheckInJourney(runtime);

    expect(result.checkInRegistrationId).toBe(result.registrationId);
    expect(result.replayCheckInId).toBe(result.checkInId);
    expect(result.checkInCount).toBe(1);
    // 当前生产链尚无 AttendancePunchEvent 写入口；明确保留具名缺口，不把未落地结算伪装成绿。
    expect(result.knownGap).toBe(JOURNEY_2_KNOWN_GAP);
    expect(result.reviewTrigger).toBe(JOURNEY_2_REVIEW_TRIGGER);
  });
});
