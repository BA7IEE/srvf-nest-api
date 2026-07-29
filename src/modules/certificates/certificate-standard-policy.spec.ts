import {
  CertificateIssuerPolicy,
  CertificateNumberMode,
  CertificateRecognitionPolicyStatus,
  CertificateStandardKind,
  CertificateStandardStatus,
  CertificateValidityMode,
} from '@prisma/client';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import {
  assertIssuerCountMatchesPolicy,
  assertParentCategoryMatches,
  assertParentUsable,
  assertPolicyIsDraft,
  assertPolicyTransitionAllowed,
  assertStandardIsActive,
  assertStandardIsCredential,
  assertStandardTransitionAllowed,
  assertValidityCombination,
  isKnownNumberMode,
  normalizeIssuerName,
} from './certificate-standard-policy';

// 证书标准库 PR-3:Standard / Policy 纯规则的**穷举**单测。
//
// 为什么穷举而不是抽样:这些是本 goal 里最容易在后续刀被悄悄放松的判断
// (「先让它过」)。状态机两张表各 3×3 / 3×3 全枚举后,任何人放开一格都会红。
// 全部零 DB、零 mock。

const ALL_STANDARD_STATUSES = [
  CertificateStandardStatus.DRAFT,
  CertificateStandardStatus.ACTIVE,
  CertificateStandardStatus.INACTIVE,
] as const;

const ALL_POLICY_STATUSES = [
  CertificateRecognitionPolicyStatus.DRAFT,
  CertificateRecognitionPolicyStatus.ACTIVE,
  CertificateRecognitionPolicyStatus.RETIRED,
] as const;

function expectBiz(fn: () => void, code: number): void {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(BizException);
    expect((err as BizException).biz.code).toBe(code);
    return;
  }
  throw new Error(`期望抛 BizCode ${code},但没有抛`);
}

describe('certificate-standard-policy(纯规则)', () => {
  // ============ Standard 状态机(§7.1)============
  describe('assertStandardTransitionAllowed — 3×3 全枚举', () => {
    // 只有这三条允许(§7.1);其余 6 格全拒,含同态→同态。
    const ALLOWED = new Set(['DRAFT>ACTIVE', 'ACTIVE>INACTIVE', 'INACTIVE>ACTIVE']);

    for (const from of ALL_STANDARD_STATUSES) {
      for (const to of ALL_STANDARD_STATUSES) {
        const key = `${from}>${to}`;
        const allowed = ALLOWED.has(key);
        it(`${key} → ${allowed ? '放行' : '拒(18034)'}`, () => {
          if (allowed) {
            expect(() => assertStandardTransitionAllowed(from, to)).not.toThrow();
          } else {
            expectBiz(() => assertStandardTransitionAllowed(from, to), 18034);
          }
        });
      }
    }

    it('任何状态都不能回 DRAFT(启用过就可能被历史证书引用)', () => {
      for (const from of ALL_STANDARD_STATUSES) {
        expectBiz(
          () => assertStandardTransitionAllowed(from, CertificateStandardStatus.DRAFT),
          18034,
        );
      }
    });
  });

  // ============ Policy 状态机(§7.2)============
  describe('assertPolicyTransitionAllowed — 3×3 全枚举', () => {
    const ALLOWED = new Set(['DRAFT>ACTIVE', 'ACTIVE>RETIRED']);

    for (const from of ALL_POLICY_STATUSES) {
      for (const to of ALL_POLICY_STATUSES) {
        const key = `${from}>${to}`;
        const allowed = ALLOWED.has(key);
        it(`${key} → ${allowed ? '放行' : '拒(18037)'}`, () => {
          if (allowed) {
            expect(() => assertPolicyTransitionAllowed(from, to)).not.toThrow();
          } else {
            expectBiz(() => assertPolicyTransitionAllowed(from, to), 18037);
          }
        });
      }
    }

    it('RETIRED 是终态:不可恢复为 ACTIVE(§7.2 明列)', () => {
      expectBiz(
        () =>
          assertPolicyTransitionAllowed(
            CertificateRecognitionPolicyStatus.RETIRED,
            CertificateRecognitionPolicyStatus.ACTIVE,
          ),
        18037,
      );
    });

    it('ACTIVE→ACTIVE 被拒 —— 这正是「并发激活只有一个成功」的落点', () => {
      expectBiz(
        () =>
          assertPolicyTransitionAllowed(
            CertificateRecognitionPolicyStatus.ACTIVE,
            CertificateRecognitionPolicyStatus.ACTIVE,
          ),
        18037,
      );
    });
  });

  describe('assertPolicyIsDraft', () => {
    it('DRAFT 放行', () => {
      expect(() => assertPolicyIsDraft(CertificateRecognitionPolicyStatus.DRAFT)).not.toThrow();
    });
    it('ACTIVE / RETIRED 均拒 18036(D-CERT-007 永久不可修改)', () => {
      expectBiz(() => assertPolicyIsDraft(CertificateRecognitionPolicyStatus.ACTIVE), 18036);
      expectBiz(() => assertPolicyIsDraft(CertificateRecognitionPolicyStatus.RETIRED), 18036);
    });
  });

  // ============ kind / status 闸(D-CERT-003)============
  describe('assertStandardIsCredential', () => {
    it('CREDENTIAL 放行', () => {
      expect(() => assertStandardIsCredential(CertificateStandardKind.CREDENTIAL)).not.toThrow();
    });
    it('FAMILY 拒 18012(不可被认定 / 不可持有)', () => {
      expectBiz(() => assertStandardIsCredential(CertificateStandardKind.FAMILY), 18012);
    });
  });

  describe('assertStandardIsActive', () => {
    it('ACTIVE 放行;DRAFT / INACTIVE 拒 18031', () => {
      expect(() => assertStandardIsActive(CertificateStandardStatus.ACTIVE)).not.toThrow();
      expectBiz(() => assertStandardIsActive(CertificateStandardStatus.DRAFT), 18031);
      expectBiz(() => assertStandardIsActive(CertificateStandardStatus.INACTIVE), 18031);
    });
  });

  // ============ 父级约束(§5.2)============
  describe('assertParentUsable / assertParentCategoryMatches', () => {
    it('父为 ACTIVE FAMILY → 放行', () => {
      expect(() =>
        assertParentUsable({
          kind: CertificateStandardKind.FAMILY,
          categoryCode: 'bsafe',
          status: CertificateStandardStatus.ACTIVE,
        }),
      ).not.toThrow();
    });

    it('父是 CREDENTIAL → 拒 18012(父节点必须是 FAMILY)', () => {
      expectBiz(
        () =>
          assertParentUsable({
            kind: CertificateStandardKind.CREDENTIAL,
            categoryCode: 'bsafe',
            status: CertificateStandardStatus.ACTIVE,
          }),
        18012,
      );
    });

    it('父还是 DRAFT → 拒 18034(避免子已启用而父悬空)', () => {
      expectBiz(
        () =>
          assertParentUsable({
            kind: CertificateStandardKind.FAMILY,
            categoryCode: 'bsafe',
            status: CertificateStandardStatus.DRAFT,
          }),
        18034,
      );
    });

    it('父子 categoryCode 不一致 → 拒 18019', () => {
      expect(() => assertParentCategoryMatches('bsafe', 'bsafe')).not.toThrow();
      expectBiz(() => assertParentCategoryMatches('first_aid', 'bsafe'), 18019);
    });
  });

  // ============ 有效期组合(§5.3 表)============
  describe('assertValidityCombination — 四模式 × 有无月数', () => {
    it('FIXED_MONTHS 必须有 1..600 的月数', () => {
      expect(() =>
        assertValidityCombination(CertificateValidityMode.FIXED_MONTHS, 24),
      ).not.toThrow();
      expect(() =>
        assertValidityCombination(CertificateValidityMode.FIXED_MONTHS, 1),
      ).not.toThrow();
      expect(() =>
        assertValidityCombination(CertificateValidityMode.FIXED_MONTHS, 600),
      ).not.toThrow();
    });

    it('FIXED_MONTHS 缺月数 / 越界 / 非整数 → 拒 18015', () => {
      expectBiz(() => assertValidityCombination(CertificateValidityMode.FIXED_MONTHS, null), 18015);
      expectBiz(
        () => assertValidityCombination(CertificateValidityMode.FIXED_MONTHS, undefined),
        18015,
      );
      expectBiz(() => assertValidityCombination(CertificateValidityMode.FIXED_MONTHS, 0), 18015);
      expectBiz(() => assertValidityCombination(CertificateValidityMode.FIXED_MONTHS, 601), 18015);
      expectBiz(() => assertValidityCombination(CertificateValidityMode.FIXED_MONTHS, 1.5), 18015);
      expectBiz(() => assertValidityCombination(CertificateValidityMode.FIXED_MONTHS, -12), 18015);
    });

    // 其余三种模式:validityMonths 必须为空 —— 留着一个「不生效但存着」的月数,
    // 下一个人一定会以为它生效。
    for (const mode of [
      CertificateValidityMode.PERMANENT,
      CertificateValidityMode.EXPLICIT_REQUIRED,
      CertificateValidityMode.EXPLICIT_OPTIONAL,
    ] as const) {
      it(`${mode} 不带月数放行;带月数拒 18015`, () => {
        expect(() => assertValidityCombination(mode, null)).not.toThrow();
        expect(() => assertValidityCombination(mode, undefined)).not.toThrow();
        expectBiz(() => assertValidityCombination(mode, 24), 18015);
      });
    }
  });

  // ============ issuer 数量(§5.4 表)============
  describe('assertIssuerCountMatchesPolicy', () => {
    it('FIXED 恰好 1', () => {
      expect(() => assertIssuerCountMatchesPolicy(CertificateIssuerPolicy.FIXED, 1)).not.toThrow();
      expectBiz(() => assertIssuerCountMatchesPolicy(CertificateIssuerPolicy.FIXED, 0), 18013);
      expectBiz(() => assertIssuerCountMatchesPolicy(CertificateIssuerPolicy.FIXED, 2), 18013);
    });

    it('ALLOWLIST ≥1', () => {
      expect(() =>
        assertIssuerCountMatchesPolicy(CertificateIssuerPolicy.ALLOWLIST, 1),
      ).not.toThrow();
      expect(() =>
        assertIssuerCountMatchesPolicy(CertificateIssuerPolicy.ALLOWLIST, 7),
      ).not.toThrow();
      expectBiz(() => assertIssuerCountMatchesPolicy(CertificateIssuerPolicy.ALLOWLIST, 0), 18013);
    });

    it('FREE_TEXT 恰好 0(不让 issuerId 与自由文本双义)', () => {
      expect(() =>
        assertIssuerCountMatchesPolicy(CertificateIssuerPolicy.FREE_TEXT, 0),
      ).not.toThrow();
      expectBiz(() => assertIssuerCountMatchesPolicy(CertificateIssuerPolicy.FREE_TEXT, 1), 18013);
    });
  });

  // ============ certNumberMode 闭集 ============
  describe('isKnownNumberMode', () => {
    it('三个取值全认', () => {
      for (const m of [
        CertificateNumberMode.REQUIRED,
        CertificateNumberMode.OPTIONAL,
        CertificateNumberMode.NONE,
      ] as const) {
        expect(isKnownNumberMode(m)).toBe(true);
      }
    });

    it('未知取值不认(将来枚举扩容时这里会提醒补规则)', () => {
      expect(isKnownNumberMode('SOMETHING_NEW' as CertificateNumberMode)).toBe(false);
    });
  });

  // ============ 机构名归一(§5.4)============
  describe('normalizeIssuerName', () => {
    it('trim + 连续空白折叠 + ASCII 大小写归一', () => {
      expect(normalizeIssuerName('  Red   Cross  ')).toBe('red cross');
      expect(normalizeIssuerName('AHA')).toBe('aha');
      expect(normalizeIssuerName('Shenzhen\t\nCenter')).toBe('shenzhen center');
    });

    it('**不**删除中文法律名称后缀 —— 去掉「有限公司」会把两家不同机构折成一个', () => {
      expect(normalizeIssuerName('深圳市急救中心')).toBe('深圳市急救中心');
      expect(normalizeIssuerName('某某培训有限公司')).toBe('某某培训有限公司');
      expect(normalizeIssuerName('深圳市急救中心')).not.toBe(normalizeIssuerName('深圳市急救'));
    });

    it('大小写 / 空白不同但语义同名 → 归一后相等(DRAFT 内去重靠它)', () => {
      expect(normalizeIssuerName('Red Cross')).toBe(normalizeIssuerName('  red   CROSS '));
    });

    it('不做模糊匹配:近似名不相等', () => {
      expect(normalizeIssuerName('Red Cross')).not.toBe(normalizeIssuerName('Red Crescent'));
    });
  });

  // ============ BizCode 号位自证 ============
  it('本刀新增码号位与 §18 一致(防手抄漂移)', () => {
    expect(BizCode.CERTIFICATE_STANDARD_NOT_FOUND.code).toBe(18002);
    expect(BizCode.CERTIFICATE_STANDARD_CODE_EXISTS.code).toBe(18003);
    expect(BizCode.CERTIFICATE_POLICY_NOT_FOUND.code).toBe(18004);
    expect(BizCode.CERTIFICATE_STANDARD_KIND_INVALID.code).toBe(18012);
    expect(BizCode.CERTIFICATE_ISSUER_CONFIG_INVALID.code).toBe(18013);
    expect(BizCode.CERTIFICATE_VALIDITY_INVALID.code).toBe(18015);
    expect(BizCode.CERTIFICATE_STANDARD_PARENT_INVALID.code).toBe(18019);
    expect(BizCode.CERTIFICATE_STANDARD_INACTIVE.code).toBe(18031);
    expect(BizCode.CERTIFICATE_STANDARD_IN_USE.code).toBe(18032);
    expect(BizCode.CERTIFICATE_STANDARD_IMMUTABLE.code).toBe(18033);
    expect(BizCode.CERTIFICATE_STANDARD_STATE_INVALID.code).toBe(18034);
    expect(BizCode.CERTIFICATE_POLICY_IMMUTABLE.code).toBe(18036);
    expect(BizCode.CERTIFICATE_POLICY_STATE_INVALID.code).toBe(18037);
    expect(BizCode.CERTIFICATE_POLICY_VERSION_CONFLICT.code).toBe(18039);
    expect(BizCode.CERTIFICATE_POLICY_ACTIVE_CONFLICT.code).toBe(18040);
  });
});
