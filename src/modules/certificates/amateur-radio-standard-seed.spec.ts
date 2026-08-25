import {
  CertificateStandardKind,
  CertificateStandardStatus,
  CertificateValidityMode,
} from '@prisma/client';

import { AMATEUR_RADIO_CERTIFICATE_SEED_CATALOG, V2_DICT_SEED } from '../../../prisma/seed';
import { BizException } from '../../common/exceptions/biz.exception';
import { ExpiryReminderService } from '../notifications/expiry-reminder.service';
import { CertificateRecognitionResolver } from './certificate-recognition-resolver';

// 首批证书标准(业余无线电台操作技术能力验证证书 A / B / C,2026-08-25 维护者拍板)的
// 「**终身有效**」自证。
//
// 立项时的 DoD 原话是「『终身有效』必须有实测证据,不能只是填了个值」——
// 光断言 `validityMode === PERMANENT` 只证明**填对了枚举**,证明不了
// 「这三个标准签出的证书不会被到期提醒骚扰」。这条链要三段都合上:
//
//   ① seed 事实      三条认定规则都是 PERMANENT 且 validityMonths 为 NULL
//   ② 签出的实例     PERMANENT ⇒ Certificate.expiredAt 恒 NULL(客户端想传都会被拒)
//   ③ 提醒的目标集   两条扫描都用 `expiredAt` 的**区间比较**定义目标集,
//                    SQL 三值逻辑下 NULL 恒不满足 ⇒ 结构上进不了目标集
//
// ③ 的 DB 侧读数已经在仓内:`test/e2e/notifications-expiry-reminder.e2e-spec.ts` 的
// `perpetualCertificate`(`expiredAt: null` 且 `certStatusCode: 'verified'`)——
// 同一夹具里另有三张有到期日的证书,而 `runOnce` 返回
// `certificateReminderCandidates: 1` / `certificateExpiryCandidates: 1`,
// 且该行跑完仍是 `expireNotifyDueAt === null` / `certStatusCode === 'verified'`。
// 本文件补的是**不连库也能跑**的那一半:直接抓住扫描谓词本身。
describe('首批证书标准 · 业余无线电台操作技术能力验证证书 A/B/C · 终身有效自证', () => {
  const catalog = AMATEUR_RADIO_CERTIFICATE_SEED_CATALOG;

  // ==========================================================================
  // ① seed 事实
  // ==========================================================================
  describe('① seed 事实', () => {
    it('1 个 FAMILY + 3 个 CREDENTIAL,全部挂在字典 cert_type 的 comm 下', () => {
      expect(catalog.categoryCode).toBe('comm');
      expect(catalog.family.code).toBe('amateur_radio_operator');
      expect(catalog.credentials.map((c) => c.code)).toEqual([
        'amateur_radio_operator_a',
        'amateur_radio_operator_b',
        'amateur_radio_operator_c',
      ]);
    });

    it('认定规则取 PERMANENT,且 validityMonths 必须留空', () => {
      expect(catalog.policy.validityMode).toBe(CertificateValidityMode.PERMANENT);
      // `assertValidityCombination` 只允许 FIXED_MONTHS 带月数;留一个「不生效但存着」的
      // 月数,下一个人一定会以为它生效。
      expect(catalog.policy.validityMonths).toBeNull();
    });

    it('三个 CREDENTIAL 各建一条 version=1 的规则(A/B/C 之间无先后依赖)', () => {
      // 维护者拍板不建前置条件链:B 类 / C 类的门槛卡的是**电台执照**持有时长,
      // 本仓没有「电台执照」这个概念,系统只记录「有什么证」。
      // ⇒ 三条规则同形、同版本号,seed 里也没有任何跨 credential 的引用。
      expect(catalog.policy.version).toBe(1);
      expect(new Set(catalog.credentials.map((c) => c.sortOrder)).size).toBe(3);
    });

    // ⭐ 这一格闭的是一条**没有 FK 的引用**:`CertificateStandard.levelCode` 只是个字符串,
    // 字典里漏了对应项 seed 照样成功、DB 照样收下,直到某天有人 PATCH 这个标准才吃 400
    // (`assertDictItemValid` → CERTIFICATE_SUB_TYPE_CODE_INVALID)。零症状,所以必须有判据。
    describe('levelCode ↔ cert_sub_type 字典闭合(两者之间没有外键)', () => {
      const certSubType = V2_DICT_SEED.find((entry) => entry.type.code === 'cert_sub_type');
      // 一律先落成 `Set<string>`:`V2_DICT_SEED` 是 `as const`,直接 new Set 会被窄成
      // 168 个字面量的联合,`has('随便一个没登记的 code')` 变成**编译错误**而不是运行时 false
      // —— 那样阳性对照根本写不出来(判据必须能表达「不该命中的那一格」)。
      const seededCodes: ReadonlySet<string> = new Set<string>(
        (certSubType?.items ?? []).map((item) => item.code),
      );

      it('先验仪器:cert_sub_type 字典条目存在且非空', () => {
        expect(certSubType).toBeDefined();
        expect(seededCodes.size).toBeGreaterThan(0);
      });

      it('三个 CREDENTIAL 的 levelCode 都是同一份 seed 里真实存在的 cert_sub_type 项', () => {
        // 逐条断言到「code → levelCode」这一对上,失败时直接看得出是哪一级漏了。
        const pairs = catalog.credentials.map((c) => [c.code, c.levelCode] as const);
        expect(pairs).toEqual([
          ['amateur_radio_operator_a', 'amateur_radio_a'],
          ['amateur_radio_operator_b', 'amateur_radio_b'],
          ['amateur_radio_operator_c', 'amateur_radio_c'],
        ]);
        for (const [, levelCode] of pairs) {
          expect(seededCodes.has(levelCode)).toBe(true);
        }
      });

      it('A/B/C 三级各不相同(分级是短波功率权限,合并任意两级都是错的)', () => {
        // A 不可用短波 / B <15W / C ≤1000W(工信部令第 67 号第三十条)。
        expect(new Set(catalog.credentials.map((c) => c.levelCode)).size).toBe(3);
      });

      it('阳性对照:字典里没登记的 levelCode 必须判不命中', () => {
        expect(seededCodes.has('amateur_radio_d')).toBe(false);
      });
    });
  });

  // ==========================================================================
  // ② PERMANENT ⇒ 实例 expiredAt 恒 NULL
  // ==========================================================================
  describe('② 按这三条规则签出的证书,到期日恒为 NULL', () => {
    const STANDARD_ID = 'std-amateur-radio-a';
    const POLICY_ID = 'pol-amateur-radio-a-v1';

    function txFor(validityMode: CertificateValidityMode, validityMonths: number | null) {
      return {
        certificateStandard: {
          findFirst: jest.fn().mockResolvedValue({
            id: STANDARD_ID,
            kind: CertificateStandardKind.CREDENTIAL,
            status: CertificateStandardStatus.ACTIVE,
          }),
        },
        certificateRecognitionPolicy: {
          findFirst: jest.fn().mockResolvedValue({
            id: POLICY_ID,
            standardId: STANDARD_ID,
            issuerPolicy: catalog.policy.issuerPolicy,
            validityMode,
            validityMonths,
            certNumberMode: catalog.policy.certNumberMode,
          }),
        },
      };
    }

    const seededTx = () => txFor(catalog.policy.validityMode, catalog.policy.validityMonths);

    // 固定的过去日期,不取 new Date() —— 夹具里的「今天」会随墙钟漂移,
    // 而 Resolver 有一条「签发日不得晚于今天」的闸,浮动日期迟早把它踩红。
    const ISSUED_AT = '2025-06-01';

    it('不传到期日 → expiredAt = null(FREE_TEXT 的机构名走自由文本)', async () => {
      const resolver = new CertificateRecognitionResolver();
      const resolved = await resolver.resolveActivePolicyForNewCertificate(
        seededTx() as never,
        STANDARD_ID,
        { issuingOrg: '广东省无线电监测站', issuedAt: ISSUED_AT },
      );

      expect(resolved.expiredAt).toBeNull();
      expect(resolved.recognitionPolicyId).toBe(POLICY_ID);
      // FREE_TEXT:不落 issuer 外键,机构名存自由文本快照。
      expect(resolved.recognitionIssuerId).toBeNull();
      expect(resolved.issuingOrg).toBe('广东省无线电监测站');
      // certNumberMode = OPTIONAL:没有编号也能建证,空值归一为 NULL。
      expect(resolved.certNumber).toBeNull();
    });

    it('客户端硬塞一个到期日 → 直接拒,不静默忽略', async () => {
      const resolver = new CertificateRecognitionResolver();
      await expect(
        resolver.resolveActivePolicyForNewCertificate(seededTx() as never, STANDARD_ID, {
          issuingOrg: '广东省无线电监测站',
          issuedAt: ISSUED_AT,
          expiredAt: '2099-12-31',
        }),
      ).rejects.toBeInstanceOf(BizException);
    });

    // 阳性对照:换一档就该算出非空到期日。没有这条,上面两条可能只是
    // 「resolver 恒返回 null」而不是「PERMANENT 才返回 null」。
    it('阳性对照:同一夹具换成 FIXED_MONTHS(24) → expiredAt 非空', async () => {
      const resolver = new CertificateRecognitionResolver();
      const resolved = await resolver.resolveActivePolicyForNewCertificate(
        txFor(CertificateValidityMode.FIXED_MONTHS, 24) as never,
        STANDARD_ID,
        { issuingOrg: '广东省无线电监测站', issuedAt: ISSUED_AT },
      );
      expect(resolved.expiredAt).not.toBeNull();
    });
  });

  // ==========================================================================
  // ③ expiredAt = NULL 的证书进不了到期提醒的目标集
  // ==========================================================================
  describe('③ 到期提醒的目标集不含 expiredAt = NULL 的证书', () => {
    /** Prisma 的区间比较算子;这几个落到 SQL 都是 `col <op> $n`。 */
    const RANGE_OPS = ['gt', 'gte', 'lt', 'lte'] as const;

    /**
     * 判定「一行 `expiredAt = NULL` 是否**可能**落进这个 where」。
     *
     * 只认识区间比较这一种形状。任何没见过的形状(OR / NOT / in / 显式 null / 不筛)
     * 一律 **throw** —— 判据宁可当场红,也不能在谓词形状变了之后继续给出上一版结论。
     * 这正是本判据的执行位:将来谁把提醒扫描改成
     * `OR: [{ expiredAt: null }, …]`(certificates.service 的「有效证书」查询就是这么写的),
     * 这条 spec 会立刻红,而不是安静地继续宣称「终身证书不会被提醒」。
     */
    function nullExpiredAtCanMatch(where: Record<string, unknown>): boolean {
      for (const branch of ['OR', 'AND', 'NOT'] as const) {
        if (branch in where) {
          throw new Error(
            `到期提醒的证书扫描新增了 ${branch} 分支;` +
              '本判据只覆盖「expiredAt 单维区间比较」这一种形状,请重新论证终身证书是否仍在目标集之外。',
          );
        }
      }
      const predicate = (where as { expiredAt?: unknown }).expiredAt;
      if (predicate === undefined) {
        throw new Error('到期提醒的证书扫描不再按 expiredAt 过滤 —— 目标集已变成「所有证书」。');
      }
      // `expiredAt: null` 会被 Prisma 编译成 `IS NULL`,那才是真的把终身证书扫进来。
      if (predicate === null) return true;
      if (typeof predicate !== 'object') {
        throw new Error(`无法识别的 expiredAt 谓词:${JSON.stringify(predicate)}`);
      }
      const ops = Object.keys(predicate);
      const unknown = ops.filter((op) => !RANGE_OPS.includes(op as (typeof RANGE_OPS)[number]));
      if (unknown.length > 0) {
        throw new Error(`expiredAt 谓词出现未覆盖的算子:${unknown.join(', ')}`);
      }
      // 全是区间比较:SQL 三值逻辑下 `NULL <op> x` 求值为 NULL 而非 TRUE,
      // WHERE 只收 TRUE ⇒ 该行不进结果集。
      return false;
    }

    function buildExpiryReminder() {
      const certificateWheres: Array<Record<string, unknown>> = [];
      const prisma = {
        activity: { findMany: jest.fn().mockResolvedValue([]) },
        certificate: {
          findMany: jest.fn((args: { where: Record<string, unknown> }) => {
            certificateWheres.push(args.where);
            return Promise.resolve([]);
          }),
        },
        memberInsurance: { findMany: jest.fn().mockResolvedValue([]) },
        teamInsurancePolicy: { findMany: jest.fn().mockResolvedValue([]) },
        $transaction: jest.fn(),
      };
      const service = new ExpiryReminderService(
        prisma as never,
        { log: jest.fn().mockResolvedValue(undefined) } as never,
        { enqueue: jest.fn().mockResolvedValue({ id: 'intent' }) } as never,
      );
      return { service, certificateWheres };
    }

    it('提醒扫描与自动过期扫描都按 expiredAt 区间取候选 ⇒ NULL 恒不命中', async () => {
      const { service, certificateWheres } = buildExpiryReminder();

      const summary = await service.runOnce(new Date('2026-08-25T01:00:00.000Z'));

      // 先验仪器:没抓到谓词就不是「没有问题」,是判据失去了输入。
      expect(certificateWheres).toHaveLength(2);
      expect(summary.certificateReminderCandidates).toBe(0);
      expect(summary.certificateExpiryCandidates).toBe(0);

      for (const where of certificateWheres) {
        expect(nullExpiredAtCanMatch(where)).toBe(false);
      }
    });

    it('阳性对照:换成会把 NULL 扫进来的谓词,判据必须报 true / 抛错', () => {
      expect(nullExpiredAtCanMatch({ expiredAt: null })).toBe(true);
      expect(() => nullExpiredAtCanMatch({ OR: [{ expiredAt: null }] })).toThrow(/OR/);
      expect(() => nullExpiredAtCanMatch({ deletedAt: null })).toThrow(/所有证书/);
      expect(() => nullExpiredAtCanMatch({ expiredAt: { in: [] } })).toThrow(/未覆盖的算子/);
    });
  });
});
