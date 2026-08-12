import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { runAttendanceCorrectionJourney } from '../support/journey-attendance-correction';
import { createJourneyRuntime, type JourneyRuntime } from '../support/journey-runtime';

describe('旅程金五条③ 考勤修正全链', () => {
  let runtime: JourneyRuntime;

  beforeAll(async () => {
    runtime = await createJourneyRuntime();
  });

  afterAll(async () => {
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
