import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { runAttendanceCorrectionJourney } from '../support/journey-attendance-correction';
import { createJourneyRuntime, type JourneyRuntime } from '../support/journey-runtime';

describe('旅程金五条③ 考勤修正全链', () => {
  let runtime: JourneyRuntime;

  beforeAll(async () => {
    // 第 7 批第 ③ 刀 —— 活动 v1.1 单一 cutover gate(合同 §16.2)。本旅程走的是
    // **结算真相链**(已结算考勤 → 冲回补记 → 重新关账,经账本 prepare / commit),
    // 那条链按定义只在闸开时存在;闸关(默认 = 今天的行为)时账本准备回 20153。
    // 故此处显式置真,**断言一字未改** —— 改的只是这条旅程声明自己跑在哪一侧闸。
    process.env.ACTIVITY_V11_WORKFLOW_ENABLED = 'true';
    runtime = await createJourneyRuntime();
  });

  afterAll(async () => {
    delete process.env.ACTIVITY_V11_WORKFLOW_ENABLED;
    await runtime.close();
  });

  it('以独立复核将已结算考勤冲回补记，并重新关账', async () => {
    const result = await runAttendanceCorrectionJourney(runtime);

    expect(result.creditedPoints).toBe('0.6');
    expect(result.dayStateVersion).toBe(2);
    expect(result.postedVersion).toBe(2);
    expect(result.activeClosureRevision).toBe(2);
    expect(result.recloseOutcome).toBe('closed');

    // 变异红证据：同一考勤对象在首单未结束时不能再开第二张更正申请。
    expect(result.duplicateOpenCorrectionCode).toBe(BizCode.CORRECTION_TARGET_ALREADY_OPEN.code);
  });
});
