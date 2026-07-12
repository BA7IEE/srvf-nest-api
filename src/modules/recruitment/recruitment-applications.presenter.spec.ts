import {
  APP_STATUS_MANUAL,
  APP_STATUS_REJECTED,
  APP_STATUS_VERIFIED,
  APP_STATUS_WITHDRAWN,
} from './recruitment.constants';
import {
  buildAdminCertificateSummaries,
  buildRecruitmentDeferResult,
  toRecruitmentSubmitResult,
} from './recruitment-applications.presenter';

describe('buildAdminCertificateSummaries', () => {
  it('A6:按 images/review/issuance 类别并集输出稳定摘要,无来源时空数组', () => {
    expect(buildAdminCertificateSummaries(null, null, null)).toEqual([]);
    expect(
      buildAdminCertificateSummaries(
        { first_aid: ['a.png', 'b.png'] },
        {
          first_aid: {
            status: 'approved',
            at: '2026-07-13T00:00:00.000Z',
            by: 'admin-1',
            note: '清晰',
          },
          bsafe: {
            status: 'rejected',
            at: '2026-07-12T00:00:00.000Z',
            by: 'admin-2',
          },
        },
        {
          first_aid: { issuingOrg: '深圳市红十字会', issuedAt: '2026-07-01' },
        },
      ),
    ).toEqual([
      {
        category: 'bsafe',
        imageCount: 0,
        issuingOrg: null,
        issuedAt: null,
        reviewStatus: 'rejected',
        reviewedAt: '2026-07-12T00:00:00.000Z',
        reviewedBy: 'admin-2',
        reviewNote: null,
      },
      {
        category: 'first_aid',
        imageCount: 2,
        issuingOrg: '深圳市红十字会',
        issuedAt: '2026-07-01',
        reviewStatus: 'approved',
        reviewedAt: '2026-07-13T00:00:00.000Z',
        reviewedBy: 'admin-1',
        reviewNote: '清晰',
      },
    ]);
  });
});

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
