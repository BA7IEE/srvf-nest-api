import { Inject, Injectable } from '@nestjs/common';
import {
  CertificateRecognitionPolicyStatus,
  CertificateStandardKind,
  CertificateStandardStatus,
  Prisma,
  RecruitmentCertificateClaimStatus,
  type Role,
} from '@prisma/client';
import { maskIdentifier } from '../../common/audit/mask-pii.util';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { notDeletedWhere } from '../../common/prisma/soft-delete.util';
import { PrismaService } from '../../database/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { CertificateRecognitionResolver } from '../certificates/certificate-recognition-resolver';
import { RbacService } from '../permissions/rbac.service';
import { STORAGE_PROVIDER } from '../storage/storage.constants';
import type { StorageProvider } from '../storage/storage.interface';
import {
  assertClaimTransitionAllowed,
  assertClaimVersionMatches,
  deriveSatisfiedCertificateCategories,
  recalcApplicationStatusForThresholds,
} from './recruitment-certificate-claim-state-machine';
import {
  CERTIFICATE_THRESHOLD_BY_CATEGORY,
  RECRUITMENT_CERT_CATEGORIES,
  allThresholdsComplete,
  type ThresholdMarks,
} from './recruitment.constants';
import {
  ClaimStandardSummaryDto,
  RecruitmentCertificateClaimAdminDto,
  RecruitmentCertificateClaimImageUrlsResponseDto,
  RecruitmentCertificateClaimListResponseDto,
  PublicCertificateStandardOptionsResponseDto,
  ReviewCertificateClaimDto,
  RevokeCertificateClaimReviewDto,
} from './recruitment-certificate-claims.dto';

// 证书标准库 PR-4a-1(冻结稿 §8.2 / §8.3 / §13.4 / §15.4):招新证书申报**管理端** service。
//
// 本刀是**纯新增**:只读 + 审核 Claim 行,不碰旧 `certificateImages` JSON 写路径,
// 也不接门槛派生。理由是 §21 约束 2「不双写」——
// 门槛一旦在这里派生,就会和仍然在线的人工 `markThreshold` 形成两个真相源。
// 门槛派生 + `markThreshold` 拒写 + 旧 JSON 停写,三者必须在 4a-2 一次原子切换。
//
// 判权沿招新域既有 GLOBAL 语义(`rbac.can`),不是 Certificate 实例的 scoped Authz
// (Recruitment 尚未接入 AuthzService)。
//
// §15.5:证据 URL TTL ≤ 300s;`Cache-Control: no-store` 由 controller 设置;
// URL 不写 audit、不写 log、不进 contract snapshot 示例。
const CLAIM_IMAGE_SIGNED_URL_TTL_SECONDS = 300;

// 派生门槛标记的 `by` 位。人工标记那三项写的是操作人 User.id;这两项没有「标记人」——
// 它是审核结论的投影。写一个显式常量而不是塞审核员 id:塞审核员会让人误以为
// 那是一次人工标记,从而误以为可以人工撤销。
const DERIVED_THRESHOLD_ACTOR = 'system:certificate-claim-derived';

const claimSelect = {
  id: true,
  applicationId: true,
  version: true,
  status: true,
  categoryHintCode: true,
  rawCertificateName: true,
  suggestedStandardId: true,
  standardId: true,
  recognitionPolicyId: true,
  recognitionIssuerId: true,
  issuingOrg: true,
  certNumber: true,
  issuedAt: true,
  expiredAt: true,
  imageKeys: true,
  reviewedByUserId: true,
  reviewedAt: true,
  reviewNote: true,
  promotedAt: true,
  createdAt: true,
  updatedAt: true,
  suggestedStandard: {
    select: { id: true, code: true, name: true, categoryCode: true, levelCode: true },
  },
  standard: {
    select: { id: true, code: true, name: true, categoryCode: true, levelCode: true },
  },
} as const satisfies Prisma.RecruitmentCertificateClaimSelect;

type ClaimRow = Prisma.RecruitmentCertificateClaimGetPayload<{ select: typeof claimSelect }>;

@Injectable()
export class RecruitmentCertificateClaimsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rbac: RbacService,
    private readonly auditLogs: AuditLogsService,
    private readonly resolver: CertificateRecognitionResolver,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
  ) {}

  // ============ helpers ============

  private async assertCanOrThrow(user: CurrentUserPayload, action: string): Promise<void> {
    if (!(await this.rbac.can(user, action))) {
      throw new BizException(BizCode.RBAC_FORBIDDEN);
    }
  }

  private imageCountOf(imageKeys: Prisma.JsonValue | null): number {
    return Array.isArray(imageKeys) ? imageKeys.length : 0;
  }

  private imageKeysOf(imageKeys: Prisma.JsonValue | null): string[] {
    return Array.isArray(imageKeys)
      ? imageKeys.filter((k): k is string => typeof k === 'string')
      : [];
  }

  private toStandardSummary(
    s: {
      id: string;
      code: string;
      name: string;
      categoryCode: string;
      levelCode: string | null;
    } | null,
  ): ClaimStandardSummaryDto | null {
    return s === null
      ? null
      : {
          id: s.id,
          code: s.code,
          name: s.name,
          categoryCode: s.categoryCode,
          levelCode: s.levelCode,
        };
  }

  // §15.4 敏感分级出口。**唯一**出口 —— 所有返 ClaimAdminDto 的方法都必须经它。
  // `imageKeys` 在这里被剥掉:出参只留计数(D-CERT-024)。
  private present(row: ClaimRow, sensitive: boolean): RecruitmentCertificateClaimAdminDto {
    return {
      id: row.id,
      applicationId: row.applicationId,
      version: row.version,
      status: row.status,
      categoryHintCode: row.categoryHintCode,
      rawCertificateName: row.rawCertificateName,
      suggestedStandard: this.toStandardSummary(row.suggestedStandard),
      standard: this.toStandardSummary(row.standard),
      recognitionPolicyId: row.recognitionPolicyId,
      recognitionIssuerId: row.recognitionIssuerId,
      issuingOrg: row.issuingOrg,
      certNumberMasked: maskIdentifier(row.certNumber),
      certNumberFull: sensitive ? row.certNumber : null,
      issuedAt: row.issuedAt,
      expiredAt: row.expiredAt,
      imageCount: this.imageCountOf(row.imageKeys),
      reviewedByUserId: sensitive ? row.reviewedByUserId : null,
      reviewedAt: row.reviewedAt,
      reviewNote: sensitive ? row.reviewNote : null,
      promotedAt: row.promotedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  /**
   * §15.4:「Claim detail 的授权不能只靠 claimId」。
   * 所以这里必须连带确认它挂在一个**真实且未软删**的报名上 ——
   * 只按 claimId 查到行就返回,等于让一个泄露出去的 claimId 变成万能钥匙。
   */
  private async findClaimOrThrow(tx: Prisma.TransactionClient, claimId: string): Promise<ClaimRow> {
    const claim = await tx.recruitmentCertificateClaim.findFirst({
      where: notDeletedWhere({ id: claimId }),
      select: claimSelect,
    });
    if (!claim) throw new BizException(BizCode.RECRUITMENT_CERTIFICATE_CLAIM_NOT_FOUND);
    const app = await tx.recruitmentApplication.findFirst({
      where: notDeletedWhere({ id: claim.applicationId }),
      select: { id: true },
    });
    // 报名已软删 → 按「申报不存在」统一口径返回,不泄露「claim 在但报名没了」。
    if (!app) throw new BizException(BizCode.RECRUITMENT_CERTIFICATE_CLAIM_NOT_FOUND);
    return claim;
  }

  // §8.3 固定锁序第 1 步:RecruitmentApplication。
  // 所有 Claim review / revoke / 整份撤销都必须沿同一前缀锁序,
  // 避免与发号和 Policy 切换形成死锁(§8.3 明列)。
  private async lockApplication(
    tx: Prisma.TransactionClient,
    applicationId: string,
  ): Promise<void> {
    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM "recruitment_applications" WHERE "id" = ${applicationId} FOR UPDATE`,
    );
  }

  // ============ §8.4 门槛派生:唯一重算入口 ============

  /**
   * 证书标准库 PR-4a-2:把 `redCross` / `bsafe` 两个门槛重算成
   * 「该报名当前全部未软删 Claim」的聚合投影,并按需推进 / 回退报名状态。
   *
   * **本方法是这两个门槛的唯一写者。** 所有会改变 Claim 状态的路径
   * (提交 / 重传 / 撤回 / 审核 / 撤回审核 / 整份撤销 / 发号)都必须在**同一事务**、
   * **持有报名行锁之后**调它一次。少调一次,派生就会静默落后于事实。
   *
   * 为什么必须是「重算聚合」而不是「这次审核的结论直接写」——§8.4 第一条推论:
   * 两张急救证里拒掉一张,聚合仍看得见另一张已通过的证书;而逐次覆写的标记
   * 记不住「还有另一张」,会把已满足的门槛错误清掉。
   *
   * 门槛值仍物化在 `thresholdMarks` JSON 里(所有既有读侧因此逐字不变),
   * 但它对这两个 code 是**投影而不是事实源** —— 人工标记入口已在
   * `markThreshold` 与两个 DTO 上被拒(28063 + 契约层 @IsIn)。
   */
  private async recomputeCertificateThresholds(
    tx: Prisma.TransactionClient,
    applicationId: string,
    actorUserId: string | null,
    actorRoleSnap: Role | null,
    meta: AuditMeta,
    now: Date,
  ): Promise<void> {
    const app = await tx.recruitmentApplication.findFirst({
      where: notDeletedWhere({ id: applicationId }),
      select: {
        id: true,
        statusCode: true,
        thresholdMarks: true,
        evaluatedByUserId: true,
        evaluatedAt: true,
        evaluationNote: true,
      },
    });
    // 报名不存在 / 已软删 → 无门槛可算。调用方各自已校验过存在性,这里只是不越权抛错。
    if (!app) return;

    // 只取聚合需要的两个字段。**categoryCode 取自已解析的 Standard**,
    // 不是申请人填的 categoryHintCode —— 提示只是提示,门槛只认审核结论(D-CERT-016)。
    const claims = await tx.recruitmentCertificateClaim.findMany({
      where: notDeletedWhere({ applicationId }),
      select: { status: true, standard: { select: { categoryCode: true } } },
    });
    const satisfied = deriveSatisfiedCertificateCategories(
      claims.map((c) => ({ status: c.status, categoryCode: c.standard?.categoryCode ?? null })),
    );

    const marks: ThresholdMarks = { ...((app.thresholdMarks as ThresholdMarks | null) ?? {}) };
    for (const category of RECRUITMENT_CERT_CATEGORIES) {
      const code = CERTIFICATE_THRESHOLD_BY_CATEGORY[category];
      if (satisfied.has(category)) {
        // 已有标记就保留原 at/by(不因为每次重算都刷新完成时刻 —— 那会让
        // 「什么时候满足的」这个事实随任意一次无关重算漂移)。
        if (marks[code] == null) {
          marks[code] = { at: now.toISOString(), by: DERIVED_THRESHOLD_ACTOR };
        }
      } else {
        delete marks[code];
      }
    }

    const { nextStatus, mustClearEvaluation } = recalcApplicationStatusForThresholds(
      app.statusCode,
      allThresholdsComplete(marks),
    );

    const data: Prisma.RecruitmentApplicationUncheckedUpdateInput = {
      thresholdMarks: marks as Prisma.InputJsonValue,
      statusCode: nextStatus,
    };
    // §8.4:从 publicity 掉回 verified 必须**同步清空**评定字段。
    // 保留「已评定通过」却把状态退回,等于让一份未达门槛的报名带着通过痕迹留在库里。
    if (mustClearEvaluation) {
      data.evaluatedByUserId = null;
      data.evaluatedAt = null;
      data.evaluationNote = null;
    }

    const changed =
      nextStatus !== app.statusCode ||
      JSON.stringify(marks) !== JSON.stringify(app.thresholdMarks ?? {}) ||
      mustClearEvaluation;
    if (!changed) return;

    await tx.recruitmentApplication.update({ where: { id: applicationId }, data });

    await this.auditLogs.log({
      event: 'recruitment-application.threshold-recompute',
      actorUserId,
      actorRoleSnap,
      resourceType: 'recruitment_application',
      resourceId: applicationId,
      meta,
      before: { statusCode: app.statusCode },
      after: { statusCode: nextStatus },
      extra: {
        operation: 'derive-certificate-thresholds',
        // 只记「哪些证书门槛现在成立」与是否清了评定 —— 不记 Claim 明细,更不记编号 / key。
        satisfiedCategories: [...satisfied].sort(),
        evaluationCleared: mustClearEvaluation,
      },
      tx,
    });
  }

  // ============ 读 ============

  async listByApplication(
    user: CurrentUserPayload,
    applicationId: string,
    meta: AuditMeta,
  ): Promise<RecruitmentCertificateClaimListResponseDto> {
    await this.assertCanOrThrow(user, 'recruitment-application.read.record');
    const sensitive = await this.rbac.can(user, 'recruitment-application.read.sensitive');

    const app = await this.prisma.recruitmentApplication.findFirst({
      where: notDeletedWhere({ id: applicationId }),
      select: { id: true },
    });
    if (!app) throw new BizException(BizCode.RECRUITMENT_APPLICATION_NOT_FOUND);

    const rows = await this.prisma.recruitmentCertificateClaim.findMany({
      where: notDeletedWhere({ applicationId }),
      select: claimSelect,
      orderBy: [{ createdAt: 'asc' }],
    });

    await this.auditLogs.log({
      event: 'recruitment-application.read.other',
      actorUserId: user.id,
      actorRoleSnap: user.role,
      resourceType: 'recruitment_application',
      resourceId: applicationId,
      meta,
      extra: {
        operation: 'certificate-claims',
        count: rows.length,
        maskLevel: sensitive ? 'plain' : 'masked',
      },
    });

    return { items: rows.map((r) => this.present(r, sensitive)) };
  }

  async findOne(
    user: CurrentUserPayload,
    claimId: string,
    meta: AuditMeta,
  ): Promise<RecruitmentCertificateClaimAdminDto> {
    await this.assertCanOrThrow(user, 'recruitment-application.read.record');
    const sensitive = await this.rbac.can(user, 'recruitment-application.read.sensitive');
    const claim = await this.findClaimOrThrow(this.prisma, claimId);

    await this.auditLogs.log({
      event: 'recruitment-application.read.other',
      actorUserId: user.id,
      actorRoleSnap: user.role,
      resourceType: 'recruitment_application',
      resourceId: claim.applicationId,
      meta,
      extra: {
        operation: 'certificate-claim-detail',
        maskLevel: sensitive ? 'plain' : 'masked',
      },
    });

    return this.present(claim, sensitive);
  }

  /**
   * §13.4 / §15.5:证据图短 TTL signed-URL。要 `read.sensitive`(图是 L3)。
   * 只返 URL 不返 key;URL 不写 audit(只记条数)。
   */
  async getImageUrls(
    user: CurrentUserPayload,
    claimId: string,
    meta: AuditMeta,
  ): Promise<RecruitmentCertificateClaimImageUrlsResponseDto> {
    await this.assertCanOrThrow(user, 'recruitment-application.read.sensitive');
    const claim = await this.findClaimOrThrow(this.prisma, claimId);
    const keys = this.imageKeysOf(claim.imageKeys);

    await this.auditLogs.log({
      event: 'recruitment-application.read.other',
      actorUserId: user.id,
      actorRoleSnap: user.role,
      resourceType: 'recruitment_application',
      resourceId: claim.applicationId,
      meta,
      // 只记条数 —— key 与 URL 一律不入审计(§15.6)。
      extra: { operation: 'certificate-claim-images', count: keys.length },
    });

    const urls: string[] = [];
    for (const key of keys) {
      const r = await this.storage.generateDownloadUrl({
        key,
        expiresIn: CLAIM_IMAGE_SIGNED_URL_TTL_SECONDS,
      });
      urls.push(r.url);
    }

    return {
      claimId: claim.id,
      urls,
      expiresAt: new Date(Date.now() + CLAIM_IMAGE_SIGNED_URL_TTL_SECONDS * 1000),
    };
  }

  // ============ 公开面:证书标准选项(§13.3)============

  /**
   * 申请人侧选择器。**公开端点,无判权**(@Public + recruitment throttler),
   * 所以出参只给 §13.3 逐字列出的六个字段 —— 不带 Policy 细节
   * (机构名单、有效期月数、编号规则属队内主数据 L1,§15.1 默认不公开管理细节)。
   *
   * 只返 ACTIVE CREDENTIAL,且按 `RECRUITMENT_CERT_CATEGORIES` 过滤:
   * 招新只收急救与 BSAFE 两类,把全库标准倒给申请人只会让他们选错。
   *
   * `currentlyRecognized=false` 是刻意保留的一档:标准已收录但暂无 ACTIVE Policy,
   * 申请人可以选它作建议(比让他填自由文本可归类得多),但后台不得据此直接通过。
   */
  async listPublicStandardOptions(): Promise<PublicCertificateStandardOptionsResponseDto> {
    const rows = await this.prisma.certificateStandard.findMany({
      where: notDeletedWhere({
        kind: CertificateStandardKind.CREDENTIAL,
        status: CertificateStandardStatus.ACTIVE,
        categoryCode: { in: [...RECRUITMENT_CERT_CATEGORIES] },
      }),
      select: {
        id: true,
        code: true,
        name: true,
        categoryCode: true,
        levelCode: true,
        // 只取「有没有 ACTIVE Policy」,不取规则内容 —— 一次查回,不做 N+1。
        policies: {
          where: { status: CertificateRecognitionPolicyStatus.ACTIVE, deletedAt: null },
          take: 1,
          select: { id: true },
        },
      },
      orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
    });

    return {
      items: rows.map((r) => ({
        id: r.id,
        code: r.code,
        name: r.name,
        categoryCode: r.categoryCode,
        levelCode: r.levelCode,
        currentlyRecognized: r.policies.length > 0,
      })),
    };
  }

  // ============ 审核(§8.3)============

  /**
   * 三种 decision 共用一条事务与固定锁序:
   *   RecruitmentApplication → Claim → Standard → Active Policy → Issuer
   *
   * ⚠️ 本刀**不重算门槛**:门槛派生要与 `markThreshold` 拒写、旧 JSON 停写
   * 一起在 4a-2 原子上线,否则会和仍在线的人工标记形成两个真相源(§21 约束 2)。
   */
  async review(
    user: CurrentUserPayload,
    claimId: string,
    dto: ReviewCertificateClaimDto,
    meta: AuditMeta,
  ): Promise<RecruitmentCertificateClaimAdminDto> {
    await this.assertCanOrThrow(user, 'recruitment-application.review.certificate');
    const sensitive = await this.rbac.can(user, 'recruitment-application.read.sensitive');

    return this.prisma.$transaction(async (tx) => {
      const pre = await this.findClaimOrThrow(tx, claimId);
      await this.lockApplication(tx, pre.applicationId);
      // 锁后复读:等锁期间申请人可能重传过(version 变),或别人已审过。
      const claim = await this.findClaimOrThrow(tx, claimId);
      assertClaimVersionMatches(dto.version, claim.version);

      const target =
        dto.decision === 'APPROVE'
          ? RecruitmentCertificateClaimStatus.APPROVED
          : dto.decision === 'REJECT'
            ? RecruitmentCertificateClaimStatus.REJECTED
            : RecruitmentCertificateClaimStatus.NEEDS_INFO;
      assertClaimTransitionAllowed(claim.status, target);

      const data: Prisma.RecruitmentCertificateClaimUncheckedUpdateInput = {
        status: target,
        reviewedByUserId: user.id,
        reviewedAt: new Date(),
        // version 自增:审核本身也是一次变更,让并发的申请人重传撞 CAS。
        version: { increment: 1 },
      };

      if (dto.decision === 'APPROVE') {
        // §8.3 第 3 步:必须解析到具体 Standard —— 「不确定」不能过审(D-CERT-014/015)。
        if (dto.standardId === undefined) {
          throw new BizException(BizCode.RECRUITMENT_CERTIFICATE_STANDARD_REQUIRED);
        }
        if (dto.issuedAt === undefined) {
          throw new BizException(BizCode.CERTIFICATE_VALIDITY_INVALID);
        }
        // 步骤 4-11 全在 Resolver 内(当前 ACTIVE Policy + 机构 + 编号 + 日期)。
        const resolved = await this.resolver.resolveActivePolicyForClaimApproval(
          tx,
          dto.standardId,
          {
            recognitionIssuerId: dto.recognitionIssuerId ?? null,
            issuingOrg: dto.issuingOrg ?? null,
            certNumber: dto.certNumber ?? null,
            issuedAt: dto.issuedAt,
            expiredAt: dto.expiredAt ?? null,
          },
        );
        data.standardId = resolved.standardId;
        data.recognitionPolicyId = resolved.recognitionPolicyId;
        data.recognitionIssuerId = resolved.recognitionIssuerId;
        data.issuingOrg = resolved.issuingOrg;
        data.certNumber = resolved.certNumber;
        data.issuedAt = resolved.issuedAt;
        data.expiredAt = resolved.expiredAt;
        if (dto.note !== undefined) data.reviewNote = dto.note;
      } else {
        // §8.3:REJECT 与 NEEDS_INFO 的 note 必填(申请人进度可见)。
        if (dto.note === undefined) throw new BizException(BizCode.BAD_REQUEST);
        data.reviewNote = dto.note;
        // NEEDS_INFO 保留图片与原始事实、**不锁定** Standard/Policy(§8.3)。
        // REJECT 清除标准化结论 —— 不允许保留伪造的 APPROVED 痕迹。
        if (dto.decision === 'REJECT') {
          data.standardId = null;
          data.recognitionPolicyId = null;
          data.recognitionIssuerId = null;
        }
      }

      const updated = await tx.recruitmentCertificateClaim.update({
        where: { id: claimId },
        data,
        select: claimSelect,
      });

      // §17 Claim 审计只含闭集字段;**不含**完整编号 / 图片 key / 备注全文 / 申请人 PII。
      await this.auditLogs.log({
        event: 'recruitment-certificate-claim.review',
        actorUserId: user.id,
        actorRoleSnap: user.role,
        resourceType: 'recruitment_certificate_claim',
        resourceId: claimId,
        meta,
        extra: {
          operation:
            dto.decision === 'APPROVE'
              ? 'approve'
              : dto.decision === 'REJECT'
                ? 'reject'
                : 'needs-info',
          applicationId: claim.applicationId,
          decision: dto.decision,
          standardId: updated.standardId,
          policyId: updated.recognitionPolicyId,
          issuerProvided: updated.recognitionIssuerId !== null,
          imageCount: this.imageCountOf(updated.imageKeys),
          certNumberProvided: updated.certNumber !== null,
          expiredAtProvided: updated.expiredAt !== null,
        },
        tx,
      });

      // §8.4:Claim 状态一变,证书门槛与报名状态必须在**同一事务**重算。
      // 放在审计之后:审计记的是「这次审核做了什么」,重算记的是「门槛因此变成什么」,
      // 两条各自独立可读,不合并成一条。
      await this.recomputeCertificateThresholds(
        tx,
        claim.applicationId,
        user.id,
        user.role,
        meta,
        new Date(),
      );

      return this.present(updated, sensitive);
    });
  }

  /**
   * §8.2 末段「撤回审核」:APPROVED → SUBMITTED。
   * 必须清空 resolved Standard / Policy / issuer 与审核字段,并写高价值审计。
   * 报名已 promoted 的不可撤(那时 Claim 已是 PROMOTED,状态机自然拦住)。
   *
   * ⚠️ 本刀同样不重算门槛(见 review 的说明)。
   */
  async revokeReview(
    user: CurrentUserPayload,
    claimId: string,
    dto: RevokeCertificateClaimReviewDto,
    meta: AuditMeta,
  ): Promise<RecruitmentCertificateClaimAdminDto> {
    await this.assertCanOrThrow(user, 'recruitment-application.review.certificate');
    const sensitive = await this.rbac.can(user, 'recruitment-application.read.sensitive');

    return this.prisma.$transaction(async (tx) => {
      const pre = await this.findClaimOrThrow(tx, claimId);
      await this.lockApplication(tx, pre.applicationId);
      const claim = await this.findClaimOrThrow(tx, claimId);
      assertClaimVersionMatches(dto.version, claim.version);
      assertClaimTransitionAllowed(claim.status, RecruitmentCertificateClaimStatus.SUBMITTED);

      const updated = await tx.recruitmentCertificateClaim.update({
        where: { id: claimId },
        data: {
          status: RecruitmentCertificateClaimStatus.SUBMITTED,
          standardId: null,
          recognitionPolicyId: null,
          recognitionIssuerId: null,
          reviewedByUserId: user.id,
          reviewedAt: new Date(),
          reviewNote: dto.note,
          version: { increment: 1 },
        },
        select: claimSelect,
      });

      await this.auditLogs.log({
        event: 'recruitment-certificate-claim.review-revoke',
        actorUserId: user.id,
        actorRoleSnap: user.role,
        resourceType: 'recruitment_certificate_claim',
        resourceId: claimId,
        meta,
        extra: {
          operation: 'revoke-approval',
          applicationId: claim.applicationId,
          // 撤回前锁定的是哪一版规则 —— 事后复原判断依据要靠它。
          revokedStandardId: claim.standardId,
          revokedPolicyId: claim.recognitionPolicyId,
          imageCount: this.imageCountOf(updated.imageKeys),
        },
        tx,
      });

      // 撤回审核会让该 Claim 不再贡献门槛 —— 重算是**聚合**,所以同类别若还有
      // 另一张 APPROVED 的证书,门槛依然成立(§8.4 第一条推论)。
      await this.recomputeCertificateThresholds(
        tx,
        claim.applicationId,
        user.id,
        user.role,
        meta,
        new Date(),
      );

      return this.present(updated, sensitive);
    });
  }
}
