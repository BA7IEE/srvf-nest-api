import { Injectable } from '@nestjs/common';
import {
  CertificateIssuerPolicy,
  CertificateNumberMode,
  CertificateRecognitionPolicyStatus,
  CertificateValidityMode,
  Prisma,
} from '@prisma/client';
import { addMonthsClamped, beijingDateOnly } from '../../common/datetime/date-only.util';
import { BizCode, type BizCodeEntry } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { notDeletedWhere } from '../../common/prisma/soft-delete.util';
import { assertStandardIsActive, assertStandardIsCredential } from './certificate-standard-policy';

// 证书标准库 PR-4a-1(冻结稿 §9.1 / §8.3 / §10 / §19):认定规则解析器。
//
// 它回答的唯一问题:「拿着一个 Standard 和一组申报事实,按当前(或已锁定的)认定规则,
// 最终该落成什么样的证书事实?」——机构选哪个、编号能不能空、到期日填还是算。
//
// §19 的边界,逐条:
//   - **不拥有外层事务**:所有方法接 `Prisma.TransactionClient`,由调用方开事务。
//     理由是这些解析必须与「建证 / 审核 / 发号」的写入同一事务同一快照 ——
//     单独开事务解析完再写,中间 Policy 可能已被激活成另一版。
//   - **不写 audit**:审计归各自的 service / recorder(谁写数据谁记账)。
//   - **不提供语义模糊的 `resolve()`**:四个方法各自对应一个真实业务时刻,
//     因为它们的规则来源不同 —— 建证与审核用**当前 ACTIVE** Policy,
//     改证用**该证已锁定**的 Policy(哪怕它已 RETIRED),发号则只搬运已锁定结论、
//     一律不重新判断。把这四种混成一个 resolve() 必然要靠参数开关区分,
//     而开关是漂移的开始。

/** 调用方提交的实例事实(申报或建证时的原始输入)。 */
export interface RecognitionFactsInput {
  /** ALLOWLIST 必传;FIXED 可不传(后端选唯一);FREE_TEXT 不得传 */
  recognitionIssuerId?: string | null;
  /** FREE_TEXT 必传;FIXED / ALLOWLIST 不得传(机构名由 issuer 决定) */
  issuingOrg?: string | null;
  /** 按 certNumberMode 校验 */
  certNumber?: string | null;
  /** 纯日期 YYYY-MM-DD(已由 DTO 收紧) */
  issuedAt: string;
  /** 纯日期;FIXED_MONTHS 不得传(后端算) */
  expiredAt?: string | null;
}

/** 解析后的规范化事实 —— 可直接落 Certificate 或 Claim 的标准化列。 */
export interface ResolvedRecognitionFacts {
  standardId: string;
  recognitionPolicyId: string;
  recognitionIssuerId: string | null;
  /** 审核时的机构名称快照(§5.6:实例存快照,不只存 issuer 当前名) */
  issuingOrg: string;
  certNumber: string | null;
  issuedAt: Date;
  expiredAt: Date | null;
}

interface LoadedPolicy {
  id: string;
  standardId: string;
  issuerPolicy: CertificateIssuerPolicy;
  validityMode: CertificateValidityMode;
  validityMonths: number | null;
  certNumberMode: CertificateNumberMode;
}

@Injectable()
export class CertificateRecognitionResolver {
  // ============ 公开方法(§19 四个显式入口)============

  /**
   * 管理端**新建**证书(§9.1 步骤 2-7):按 Standard 当前 ACTIVE Policy 解析。
   * Standard 必须 ACTIVE 且 CREDENTIAL;无 ACTIVE Policy → 18035。
   */
  async resolveActivePolicyForNewCertificate(
    tx: Prisma.TransactionClient,
    standardId: string,
    facts: RecognitionFactsInput,
  ): Promise<ResolvedRecognitionFacts> {
    const policy = await this.loadActivePolicyOrThrow(tx, standardId);
    return this.materializeFacts(tx, policy, facts);
  }

  /**
   * 招新 Claim **审核通过**(§8.3 步骤 3-11):与建证同一套规则,
   * 但错误码走招新域(申请人视角的提示不同)。
   */
  async resolveActivePolicyForClaimApproval(
    tx: Prisma.TransactionClient,
    standardId: string,
    facts: RecognitionFactsInput,
  ): Promise<ResolvedRecognitionFacts> {
    const policy = await this.loadActivePolicyOrThrow(
      tx,
      standardId,
      BizCode.RECRUITMENT_CERTIFICATE_POLICY_UNAVAILABLE,
    );
    return this.materializeFacts(tx, policy, facts);
  }

  /**
   * 管理端**改证**(§9.2):沿该证**已锁定**的 policyId 校验,
   * **不**换成当前 ACTIVE ——「事实修正继续沿原 policyId 校验,避免规则在录入后移动」。
   * 原 Policy 已 RETIRED 仍允许按该版本修正与复核(§9.2 倒数第 3 条)。
   */
  async validateLockedPolicyForCertificateUpdate(
    tx: Prisma.TransactionClient,
    lockedPolicyId: string,
    facts: RecognitionFactsInput,
  ): Promise<ResolvedRecognitionFacts> {
    const policy = await tx.certificateRecognitionPolicy.findFirst({
      where: notDeletedWhere({ id: lockedPolicyId }),
      select: {
        id: true,
        standardId: true,
        issuerPolicy: true,
        validityMode: true,
        validityMonths: true,
        certNumberMode: true,
      },
    });
    if (!policy) throw new BizException(BizCode.CERTIFICATE_POLICY_NOT_FOUND);
    return this.materializeFacts(tx, policy, facts);
  }

  /**
   * 发号搬运(§8.5 步骤 3):**只校验完整性,一律不重新判断规则**。
   *
   * 「发号不再锁 Standard/Policy 做新判断,只校验 Claim 已经 APPROVED 且关系完整」——
   * 这是 D-CERT-008 的落点:审核当时锁定的 Policy 就是最终依据,
   * 哪怕发号时该 Standard 已换了新 ACTIVE Policy,也绝不按新规则重算。
   * 缺任何标准化字段 → 整批 fail-closed(§22.4:不静默跳过坏 Claim)。
   */
  materializeApprovedClaimForPromotion(claim: {
    id: string;
    standardId: string | null;
    recognitionPolicyId: string | null;
    recognitionIssuerId: string | null;
    issuingOrg: string | null;
    certNumber: string | null;
    issuedAt: Date | null;
    expiredAt: Date | null;
  }): ResolvedRecognitionFacts {
    if (
      claim.standardId === null ||
      claim.recognitionPolicyId === null ||
      claim.issuingOrg === null ||
      claim.issuedAt === null
    ) {
      // DB CHECK 也拦这一条(APPROVED 完整性),这里是应用层的第二道 ——
      // 发号是批量事务,让它在这里以明确业务码整批失败,比撞 23514 好排查。
      throw new BizException(BizCode.RECRUITMENT_CERTIFICATE_STANDARD_REQUIRED);
    }
    return {
      standardId: claim.standardId,
      recognitionPolicyId: claim.recognitionPolicyId,
      recognitionIssuerId: claim.recognitionIssuerId,
      issuingOrg: claim.issuingOrg,
      certNumber: claim.certNumber,
      issuedAt: claim.issuedAt,
      expiredAt: claim.expiredAt,
    };
  }

  // ============ 内部 ============

  // `missingPolicyBiz` 显式标注为 BizCodeEntry —— 若靠默认值推导,类型会被窄成
  // CERTIFICATE_ACTIVE_POLICY_MISSING 的字面量类型,招新侧传 28062 就通不过。
  private async loadActivePolicyOrThrow(
    tx: Prisma.TransactionClient,
    standardId: string,
    missingPolicyBiz: BizCodeEntry = BizCode.CERTIFICATE_ACTIVE_POLICY_MISSING,
  ): Promise<LoadedPolicy> {
    const standard = await tx.certificateStandard.findFirst({
      where: notDeletedWhere({ id: standardId }),
      select: { id: true, kind: true, status: true },
    });
    if (!standard) throw new BizException(BizCode.CERTIFICATE_STANDARD_NOT_FOUND);
    // FAMILY 不可被认定 / 不可持有(D-CERT-003);DRAFT / INACTIVE 不可用于建证(§7.1)。
    assertStandardIsCredential(standard.kind);
    assertStandardIsActive(standard.status);

    const policy = await tx.certificateRecognitionPolicy.findFirst({
      where: notDeletedWhere({ standardId, status: CertificateRecognitionPolicyStatus.ACTIVE }),
      select: {
        id: true,
        standardId: true,
        issuerPolicy: true,
        validityMode: true,
        validityMonths: true,
        certNumberMode: true,
      },
    });
    // §11.2:Standard 可以「已收录、暂无 ACTIVE Policy」—— 那种标准可被检索、
    // 可被申请人建议,但不能建证也不能过审。
    if (!policy) throw new BizException(missingPolicyBiz);
    return policy;
  }

  /** 机构 + 编号 + 日期三段解析,顺序固定(§8.3 步骤 5-11)。 */
  private async materializeFacts(
    tx: Prisma.TransactionClient,
    policy: LoadedPolicy,
    facts: RecognitionFactsInput,
  ): Promise<ResolvedRecognitionFacts> {
    const issuer = await this.resolveIssuer(tx, policy, facts);
    const certNumber = this.resolveCertNumber(policy.certNumberMode, facts.certNumber);
    const { issuedAt, expiredAt } = this.resolveDates(policy, facts);

    return {
      standardId: policy.standardId,
      recognitionPolicyId: policy.id,
      recognitionIssuerId: issuer.id,
      issuingOrg: issuer.name,
      certNumber,
      issuedAt,
      expiredAt,
    };
  }

  /**
   * §5.4 三种机构策略:
   *   FIXED     恰好 1 个 issuer,实例可不传 → 后端选唯一
   *   ALLOWLIST 必须传 recognitionIssuerId,且该 issuer 属于本 Policy 且未软删
   *   FREE_TEXT 必须传 issuingOrg 自由文本,不得传 issuerId
   *
   * 实例认可**靠 issuer id 不靠机构文字**(D-CERT-021)——
   * 中文机构名匹配不可靠,让客户端提交文字再去匹配等于把认可范围交给字符串比较。
   */
  private async resolveIssuer(
    tx: Prisma.TransactionClient,
    policy: LoadedPolicy,
    facts: RecognitionFactsInput,
  ): Promise<{ id: string | null; name: string }> {
    const issuerId = facts.recognitionIssuerId ?? null;
    const freeText = facts.issuingOrg?.trim() ?? '';

    if (policy.issuerPolicy === CertificateIssuerPolicy.FREE_TEXT) {
      if (issuerId !== null || freeText === '') {
        throw new BizException(BizCode.CERTIFICATE_ISSUER_CONFIG_INVALID);
      }
      return { id: null, name: freeText };
    }

    // FIXED / ALLOWLIST 都不接受自由文本 —— 否则 issuerId 与文字双义(§5.4 末段)。
    if (freeText !== '') throw new BizException(BizCode.CERTIFICATE_ISSUER_CONFIG_INVALID);

    if (policy.issuerPolicy === CertificateIssuerPolicy.FIXED && issuerId === null) {
      const only = await tx.certificateRecognitionIssuer.findMany({
        where: { policyId: policy.id, deletedAt: null },
        select: { id: true, name: true },
        take: 2,
      });
      // 恰好 1 才自动选;0 或 ≥2 说明 Policy 配置已漂移(激活时校验过,但软删可能事后破坏)。
      if (only.length !== 1) throw new BizException(BizCode.CERTIFICATE_ISSUER_CONFIG_INVALID);
      return { id: only[0].id, name: only[0].name };
    }

    if (issuerId === null) throw new BizException(BizCode.CERTIFICATE_ISSUER_NOT_ALLOWED);

    // 必须属于**本 Policy** 且未软删。复合 FK 在 DB 层也拦,但这里给明确业务码。
    const issuer = await tx.certificateRecognitionIssuer.findFirst({
      where: { id: issuerId, policyId: policy.id, deletedAt: null },
      select: { id: true, name: true },
    });
    if (!issuer) throw new BizException(BizCode.CERTIFICATE_ISSUER_NOT_ALLOWED);
    return { id: issuer.id, name: issuer.name };
  }

  /**
   * §5.3 编号规则:
   *   REQUIRED  trim 后必须非空
   *   OPTIONAL  空字符串归一为 NULL
   *   NONE      必须为 NULL;**客户端传值直接拒**(不静默丢弃 ——
   *             静默丢弃会让运营以为编号存下来了)
   */
  private resolveCertNumber(
    mode: CertificateNumberMode,
    raw: string | null | undefined,
  ): string | null {
    const trimmed = raw?.trim() ?? '';
    if (mode === CertificateNumberMode.NONE) {
      if (trimmed !== '') throw new BizException(BizCode.CERTIFICATE_NUMBER_NOT_ALLOWED);
      return null;
    }
    if (mode === CertificateNumberMode.REQUIRED) {
      if (trimmed === '') throw new BizException(BizCode.CERTIFICATE_NUMBER_REQUIRED);
      return trimmed;
    }
    return trimmed === '' ? null : trimmed;
  }

  /**
   * §10.3 / §10.4 日期:
   *   issuedAt <= today(北京日历日)
   *   PERMANENT         expiredAt 必须空
   *   FIXED_MONTHS      客户端不得传;后端 addMonthsClamped 自然月 + 月底夹取
   *   EXPLICIT_REQUIRED expiredAt 必填
   *   EXPLICIT_OPTIONAL expiredAt 可空(空 = 终身)
   *   expiredAt >= issuedAt(相等合法 = 当天有效一天)
   *
   * 入参是纯 YYYY-MM-DD(DTO 已收紧),这里用 `beijingDateOnly(new Date(s))`
   * 统一归一 —— 与 normalizeDateOnly 同一日界,不是第二套算法(§19)。
   */
  private resolveDates(
    policy: LoadedPolicy,
    facts: RecognitionFactsInput,
  ): { issuedAt: Date; expiredAt: Date | null } {
    const issuedAt = beijingDateOnly(new Date(facts.issuedAt));
    const today = beijingDateOnly(new Date());
    if (issuedAt.getTime() > today.getTime()) {
      throw new BizException(BizCode.CERTIFICATE_ISSUED_AT_IN_FUTURE);
    }

    const rawExpired = facts.expiredAt ?? null;
    const provided = rawExpired !== null && rawExpired !== '';

    switch (policy.validityMode) {
      case CertificateValidityMode.PERMANENT:
        if (provided) throw new BizException(BizCode.CERTIFICATE_VALIDITY_INVALID);
        return { issuedAt, expiredAt: null };

      case CertificateValidityMode.FIXED_MONTHS: {
        // 客户端传了也拒,而不是「忽略客户端值改用算出来的」——
        // 忽略会让前端以为自己填的生效了。
        if (provided) throw new BizException(BizCode.CERTIFICATE_VALIDITY_INVALID);
        if (policy.validityMonths === null) {
          throw new BizException(BizCode.CERTIFICATE_VALIDITY_INVALID);
        }
        return { issuedAt, expiredAt: addMonthsClamped(issuedAt, policy.validityMonths) };
      }

      case CertificateValidityMode.EXPLICIT_REQUIRED: {
        if (!provided) throw new BizException(BizCode.CERTIFICATE_VALIDITY_INVALID);
        const expiredAt = beijingDateOnly(new Date(rawExpired));
        this.assertRange(issuedAt, expiredAt);
        return { issuedAt, expiredAt };
      }

      case CertificateValidityMode.EXPLICIT_OPTIONAL: {
        if (!provided) return { issuedAt, expiredAt: null };
        const expiredAt = beijingDateOnly(new Date(rawExpired));
        this.assertRange(issuedAt, expiredAt);
        return { issuedAt, expiredAt };
      }
    }
  }

  private assertRange(issuedAt: Date, expiredAt: Date): void {
    if (expiredAt.getTime() < issuedAt.getTime()) {
      throw new BizException(BizCode.CERTIFICATE_DATE_RANGE_INVALID);
    }
  }
}
