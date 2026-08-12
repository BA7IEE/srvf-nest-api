import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { runRecruitmentPromotionTeamJoinJourney } from '../support/journey-recruitment-team-join';
import { createJourneyRuntime, type JourneyRuntime } from '../support/journey-runtime';

describe('旅程金五条① 招募→晋升→建号→入队', () => {
  let runtime: JourneyRuntime;

  beforeAll(async () => {
    runtime = await createJourneyRuntime();
  });

  afterAll(async () => {
    await runtime.close();
  });

  it('以真实报名、审核、发号和入队动作完成志愿者到队员转换', async () => {
    const result = await runRecruitmentPromotionTeamJoinJourney(runtime);

    expect(result.applicationStatus).toBe('promoted');
    expect(result.memberNo).toMatch(/^26\d{3}$/);
    expect(result.teamJoinStatus).toBe('joined');
    expect(result.gradeCode).toBe('level-1');

    // 变异红证据：若终态幂等/状态闸失效，第二次入队会错误地再建一条有效归属。
    expect(await result.replayFinalJoin()).toBe(BizCode.TEAM_JOIN_APPLICATION_WRONG_STATE.code);
  });
});
