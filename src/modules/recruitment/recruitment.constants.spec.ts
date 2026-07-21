import {
  beijingDateKey,
  MEMBER_PROFILE_DOC_TYPE_ID_CARD,
  toMemberProfileDocumentTypeCode,
} from './recruitment.constants';

// 招新可用性收口 F1(2026-07-11;评审稿 recruitment-usability-closeout-review.md §2.5/E-U-1):
// OCR 日封顶计数键的北京自然日(固定 UTC+8)派生 —— 锁定跨日边界(UTC 16:00 = 北京次日 00:00)。
describe('beijingDateKey · 北京自然日 key(UTC+8 固定日界)', () => {
  it('UTC 当日 15:59:59.999(北京 23:59:59)→ 仍是当日', () => {
    expect(beijingDateKey(new Date('2026-07-11T15:59:59.999Z'))).toBe('2026-07-11');
  });

  it('UTC 当日 16:00:00(北京次日 00:00)→ 翻到次日', () => {
    expect(beijingDateKey(new Date('2026-07-11T16:00:00.000Z'))).toBe('2026-07-12');
  });

  it('UTC 凌晨(北京同日上午)→ 当日;月/日两位数补零', () => {
    expect(beijingDateKey(new Date('2026-01-02T00:00:00.000Z'))).toBe('2026-01-02');
  });

  it('跨年边界:UTC 12-31 16:00 → 北京 01-01', () => {
    expect(beijingDateKey(new Date('2025-12-31T16:00:00.000Z'))).toBe('2026-01-01');
  });
});

describe('toMemberProfileDocumentTypeCode · 招新→队员档案边界', () => {
  it('mainland_id 只在建档边界映射为 document_type 字典真值 id_card', () => {
    expect(toMemberProfileDocumentTypeCode('mainland_id')).toBe(MEMBER_PROFILE_DOC_TYPE_ID_CARD);
  });

  it.each(['passport', 'hk_macau_permit', 'taiwan_permit', 'foreigner_permit', 'other'])(
    '其他招新白名单码 %s 与档案字典同值，保持不变',
    (code) => {
      expect(toMemberProfileDocumentTypeCode(code)).toBe(code);
    },
  );
});
