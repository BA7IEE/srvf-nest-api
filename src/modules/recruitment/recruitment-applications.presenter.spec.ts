import {
  APP_STATUS_MANUAL,
  APP_STATUS_REJECTED,
  APP_STATUS_VERIFIED,
  APP_STATUS_WITHDRAWN,
} from './recruitment.constants';
import {
  buildRecruitmentDeferResult,
  toRecruitmentSubmitResult,
} from './recruitment-applications.presenter';

// 证书标准库 PR-4b:`buildAdminCertificateSummaries` 随三个证书 JSON 列一起退役,
// 本组随之删除。它守的「按类别并集输出稳定摘要」不再有对应行为 ——
// 一证一行下不存在「类别并集」这个概念。
// 管理端读证书申报的等价覆盖在 test/e2e/recruitment-certificate-claims.e2e-spec.ts
// (列表 / 详情 / 敏感分级 / 授权不只靠 claimId)。

describe('recruitment public meeting info gate', () => {
  const cycle = {
    name: '2026 招新',
    meetingInfo: '周六见面会',
    qqGroup: '123456',
    notifyTemplate: { verified: '欢迎' },
  } as never;

  function app(statusCode: string, tempNo: string | null) {
    return { statusCode, tempNo } as never;
  }

  it('刀A1 verified + tempNo → submit 结果可见三字段', () => {
    const dto = toRecruitmentSubmitResult(app(APP_STATUS_VERIFIED, 'T26001'), cycle);
    expect(dto.meetingInfo).toBe('周六见面会');
    expect(dto.qqGroup).toBe('123456');
    expect(dto.notifyTemplate).toEqual({ verified: '欢迎' });
  });

  it.each([
    ['manual', APP_STATUS_MANUAL, null],
    ['rejected-old-tempNo', APP_STATUS_REJECTED, 'T26002'],
    ['withdrawn-old-tempNo', APP_STATUS_WITHDRAWN, 'T26003'],
  ])('刀A1 %s → submit 三字段恒 null', (_name, statusCode, tempNo) => {
    const dto = toRecruitmentSubmitResult(app(statusCode, tempNo), cycle);
    expect(dto.meetingInfo).toBeNull();
    expect(dto.qqGroup).toBeNull();
    expect(dto.notifyTemplate).toBeNull();
  });

  it.each(['retake', 'confirm', 'retry'] as const)('刀A1 延迟分流 %s → 三字段恒 null', (kind) => {
    const dto = buildRecruitmentDeferResult(kind, null, cycle, new Map());
    expect(dto.meetingInfo).toBeNull();
    expect(dto.qqGroup).toBeNull();
    expect(dto.notifyTemplate).toBeNull();
  });
});
