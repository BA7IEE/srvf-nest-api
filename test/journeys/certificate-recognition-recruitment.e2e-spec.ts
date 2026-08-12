import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { runCertificateRecognitionJourney } from '../support/journey-certificate-recognition';
import { createJourneyRuntime, type JourneyRuntime } from '../support/journey-runtime';

describe('旅程金五条④ 证书标准→认定规则→招新申报→发号', () => {
  let runtime: JourneyRuntime;

  beforeAll(async () => {
    runtime = await createJourneyRuntime();
  });

  afterAll(async () => {
    await runtime.close();
  });

  it('以真实标准、规则、申报、审核和发号动作生成锁定来源的正式证书', async () => {
    const result = await runCertificateRecognitionJourney(runtime);

    expect(result.certificateStatus).toBe('verified');
    expect(result.certificateNumber).toBe('J4-FA-001');
    expect(result.certificateStandardId).toBeTruthy();
    expect(result.certificatePolicyId).toBeTruthy();

    // 变异红证据：已发号后的重审先被“报名已终态”闸拒绝；若放开会破坏一申报一正式证书。
    expect(await result.replayClaimReview()).toBe(BizCode.RECRUITMENT_APPLICATION_WRONG_STATE.code);
  });
});
