import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  CertificateRecognitionPolicyStatus,
  CertificateStandardKind,
  CertificateStandardStatus,
  Prisma,
  RecruitmentCertificateClaimStatus,
  type Role,
} from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { maskIdentifier } from '../../common/audit/mask-pii.util';
import { beijingDateOnly } from '../../common/datetime/date-only.util';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { notDeletedWhere } from '../../common/prisma/soft-delete.util';
import { PrismaService } from '../../database/prisma.service';
import { AttachmentContentValidator } from '../attachments/attachment-content-validator';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { CertificateEvidenceSigner } from '../certificates/certificate-evidence-signer';
import { CertificateRecognitionResolver } from '../certificates/certificate-recognition-resolver';
import { RbacService } from '../permissions/rbac.service';
import { STORAGE_PROVIDER } from '../storage/storage.constants';
import type { StorageProvider } from '../storage/storage.interface';
import {
  lockActiveApplicationOrThrow,
  lockOwnActiveApplicationOrThrow,
} from './recruitment-application-lock';
import {
  assertApplicantMayMutate,
  assertClaimEvidenceReadable,
  assertClaimTransitionAllowed,
  assertClaimVersionMatches,
} from './recruitment-certificate-claim-state-machine';
import {
  CERTIFICATE_CLAIM_IMAGES_MAX,
  CERTIFICATE_CLAIM_IMAGES_MIN,
  CERTIFICATE_CLAIM_IMAGE_KEY_PREFIX,
  CERTIFICATE_CLAIM_MAX_PER_APPLICATION,
  ID_CARD_IMAGE_ALLOWED_MIME,
  ID_CARD_IMAGE_MAX_BYTES,
  RECRUITMENT_CERT_CATEGORIES,
  recruitmentStorageCleanupFailureLog,
  type RecruitmentStorageCleanupOperation,
} from './recruitment.constants';
import type { UploadedImageFile } from './recruitment-applications.service';
import { recomputeCertificateThresholds } from './recruitment-certificate-threshold-derive';
import { RecruitmentIdentityService } from './recruitment-identity.service';
import {
  ClaimStandardSummaryDto,
  RecruitmentCertificateClaimAdminDto,
  RecruitmentCertificateClaimImageUrlsResponseDto,
  RecruitmentCertificateClaimListResponseDto,
  PublicCertificateClaimDto,
  PublicCertificateClaimResultDto,
  PublicCertificateStandardOptionsResponseDto,
  ResubmitCertificateClaimDto,
  ReviewCertificateClaimDto,
  RevokeCertificateClaimReviewDto,
  SubmitCertificateClaimDto,
  WithdrawCertificateClaimDto,
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
// §15.5 的 TTL 常量已搬进 `CertificateEvidenceSigner`(证据签发唯一封装)——
// 本模块曾经有一份自己的 300,与 certificates 那份互相不知道对方存在。

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
    private readonly identity: RecruitmentIdentityService,
    private readonly contentValidator: AttachmentContentValidator,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
    // §13.5:证据签发的唯一封装,与 CertificatesService 共用同一份 —— 不写第二套。
    private readonly evidenceSigner: CertificateEvidenceSigner,
  ) {}

  private readonly logger = new Logger(RecruitmentCertificateClaimsService.name);

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
  //
  // 实现搬到 `recruitment-application-lock.ts` —— 原来这里的版本只 `SELECT id FOR UPDATE`
  // 且返回 void,调用方拿不到锁后的行,于是继续用锁**之前**的快照判定。
  // 跨模型评审把这一条同时打在四条写路径上,所以修法是把「锁 + 复读 + 判定」
  // 做成一个只能整体调用的函数,而不是在四处各补一次复读。

  // ============ §8.4 门槛派生:唯一重算入口(实现在 recruitment-certificate-threshold-derive.ts)============
  //
  // 实现搬到普通导出函数,原因与 loadProgressClaims 相同:整份报名撤销走的是
  // `RecruitmentIdentityService`,而本 service 已经注入了它 ——
  // 让 identity 反向注入本 service 会立刻成环。抽成纯函数后两边共用同一实现,
  // 「唯一写者」这条规则才真的只有一处代码。
  private recomputeCertificateThresholds(
    tx: Prisma.TransactionClient,
    applicationId: string,
    actorUserId: string | null,
    actorRoleSnap: Role | null,
    meta: AuditMeta,
    now: Date,
  ): Promise<void> {
    return recomputeCertificateThresholds(this.auditLogs, tx, applicationId, {
      actorUserId,
      actorRoleSnap,
      meta,
      now,
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
    // §15.5 / §15.9:光有 read.sensitive 不够,还要看这条申报此刻的状态。
    // 修复前这里只做「查权限 → 签全部 key」,于是已撤回和已发号的申报照样出图。
    assertClaimEvidenceReadable(claim.status);

    await this.auditLogs.log({
      event: 'recruitment-application.read.other',
      actorUserId: user.id,
      actorRoleSnap: user.role,
      resourceType: 'recruitment_application',
      resourceId: claim.applicationId,
      meta,
      // 只记条数 —— key 与 URL 一律不入审计(§15.6)。
      extra: {
        operation: 'certificate-claim-images',
        count: this.imageCountOf(claim.imageKeys),
      },
    });

    // §15.5「URL 生成前重新检查」:上面到这里之间有一次审计写的 IO 往返,
    // 申请人完全可能在这个窗口里撤回、或管理员发号把它转成 PROMOTED。
    // 所以状态、归属与权限在**签发前**再验一次 —— 审计已经落账了,
    // 这次拒签只是不发 URL,不影响「谁在什么时候试图读过」这条记录的完整性。
    await this.assertCanOrThrow(user, 'recruitment-application.read.sensitive');
    const fresh = await this.findClaimOrThrow(this.prisma, claimId);
    assertClaimEvidenceReadable(fresh.status);

    // 签发走 certificates 模块导出的**唯一**封装(§13.5:不写第二套签名逻辑)。
    const signed = await this.evidenceSigner.sign(
      CertificateEvidenceSigner.keysOf(fresh.imageKeys),
    );
    return { claimId: fresh.id, urls: signed.urls, expiresAt: signed.expiresAt };
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
      // 锁 + 复读报名:等锁期间它可能已被整份撤销(级联把本 Claim 打成 WITHDRAWN)
      // 或已发号。终态报名下不接受任何审核动作 —— 状态机随后还会再拦一次本 Claim,
      // 两道闸都在,因为它们锁的不是同一件事(一个是报名生命周期,一个是 Claim 状态机)。
      await lockActiveApplicationOrThrow(tx, pre.applicationId);
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
      await lockActiveApplicationOrThrow(tx, pre.applicationId);
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

  // ============ §8.1 公开面:申请人提交 / 重传 / 撤回 ============

  // 申请人视角出参。**与 admin 的 present() 分开两条** —— 不是重复:
  // 公开面字段集必须能独立收紧,共用一个出口迟早会让某次 admin 加字段顺手泄到公开面。
  private presentPublic(row: ClaimRow): PublicCertificateClaimDto {
    return {
      id: row.id,
      version: row.version,
      status: row.status,
      categoryHintCode: row.categoryHintCode,
      rawCertificateName: row.rawCertificateName,
      suggestedStandardId: row.suggestedStandardId,
      issuingOrg: row.issuingOrg,
      certNumberMasked: maskIdentifier(row.certNumber),
      issuedAt: row.issuedAt,
      expiredAt: row.expiredAt,
      imageCount: this.imageCountOf(row.imageKeys),
      reviewNote: row.reviewNote,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  // best-effort 删对象。日志 schema 闭集(不含 key / bucket / provider 原文)——
  // 这条不变量随 safeDeleteBlob 从 review service 迁来,断言逐字保留在本 service 的单测里。
  private async safeDeleteBlob(
    key: string,
    operation: RecruitmentStorageCleanupOperation,
  ): Promise<void> {
    try {
      await this.storage.deleteObject(key);
    } catch {
      this.logger.warn(recruitmentStorageCleanupFailureLog(operation));
    }
  }

  /**
   * 文件闸(§8.1):数量 1~3 · 单文件 ≤5MB · MIME 白名单 · 魔数与内容一致。
   * 内容校验**必须**复用 attachments 的 `AttachmentContentValidator`
   * (recruitment/CLAUDE.md 铁律:模块内不得复制 MIME 黑名单 / 签名表)。
   * 校验在**落对象之前**全部跑完 —— 任何一张不合格就一张都不落。
   */
  private assertClaimImages(files: UploadedImageFile[]): void {
    if (
      files.length < CERTIFICATE_CLAIM_IMAGES_MIN ||
      files.length > CERTIFICATE_CLAIM_IMAGES_MAX
    ) {
      throw new BizException(BizCode.BAD_REQUEST);
    }
    for (const f of files) {
      if (f.size > ID_CARD_IMAGE_MAX_BYTES || !ID_CARD_IMAGE_ALLOWED_MIME.includes(f.mimetype)) {
        throw new BizException(BizCode.BAD_REQUEST);
      }
      this.contentValidator.validateFromBuffer({ mime: f.mimetype, buffer: f.buffer });
    }
  }

  // key = 固定 namespace + 随机 id + 扩展名。**不含**类别 / cycleId / 姓名 / 原文件名(§8.1)。
  private async putClaimImages(files: UploadedImageFile[]): Promise<string[]> {
    const keys: string[] = [];
    try {
      for (const f of files) {
        const ext = f.mimetype === 'image/png' ? 'png' : 'jpg';
        const key = `${CERTIFICATE_CLAIM_IMAGE_KEY_PREFIX}/${randomUUID()}.${ext}`;
        await this.storage.putObject({ key, body: f.buffer, contentType: f.mimetype });
        keys.push(key);
      }
    } catch (err) {
      // 落一半失败 → 删本批已落的,不留孤儿对象(镜像既有 FM-B)。
      for (const k of keys) await this.safeDeleteBlob(k, 'delete-orphan-id-card-image');
      throw err;
    }
    return keys;
  }

  // 申请人可自报的事实(不含 standardId / policyId / issuerId / 审核字段)。
  // §8.1:「申请人不能提交 Policy、审核状态或标准化 issuer id」——
  // 做法是这个白名单函数,而不是在写入前逐个 delete 不该有的键。
  private applicantFacts(dto: SubmitCertificateClaimDto): {
    categoryHintCode: string;
    rawCertificateName: string | null;
    suggestedStandardId: string | null;
    issuingOrg: string | null;
    certNumber: string | null;
    issuedAt: Date | null;
    expiredAt: Date | null;
  } {
    const trimOrNull = (v: string | undefined): string | null => {
      const t = v?.trim() ?? '';
      return t === '' ? null : t;
    };
    const issuedAt = dto.issuedAt ? beijingDateOnly(new Date(dto.issuedAt)) : null;
    const expiredAt = dto.expiredAt ? beijingDateOnly(new Date(dto.expiredAt)) : null;
    // 自报阶段只做**基础**日期健全性(不晚于今天 / 区间不倒挂)。
    // 按认定规则的完整校验留到审核 —— 此刻还没有 Standard,谈不上规则。
    if (issuedAt !== null && issuedAt.getTime() > beijingDateOnly(new Date()).getTime()) {
      throw new BizException(BizCode.CERTIFICATE_ISSUED_AT_IN_FUTURE);
    }
    if (issuedAt !== null && expiredAt !== null && expiredAt.getTime() < issuedAt.getTime()) {
      throw new BizException(BizCode.CERTIFICATE_DATE_RANGE_INVALID);
    }
    return {
      categoryHintCode: dto.categoryHintCode,
      rawCertificateName: trimOrNull(dto.rawCertificateName),
      suggestedStandardId: trimOrNull(dto.suggestedStandardId),
      issuingOrg: trimOrNull(dto.issuingOrg),
      certNumber: trimOrNull(dto.certNumber),
      issuedAt,
      expiredAt,
    };
  }

  /**
   * 建议的 Standard 必须是**申请人本来就能看到的那一批**(公开选项同一过滤):
   * ACTIVE + CREDENTIAL + 招新类别。否则拒 40000。
   *
   * 为什么要校验:`suggestedStandardId` 是客户端传来的 id。不校验就等于让公开端点
   * 变成一个「猜 id 探测队内主数据是否存在」的接口,还能把 FAMILY / DRAFT 节点塞进来
   * 让审核界面出现本不该出现的选项。**注意它只是建议** —— 校验通过也不代表能过审。
   */
  private async assertSuggestedStandardSelectable(
    tx: Prisma.TransactionClient,
    standardId: string | null,
  ): Promise<void> {
    if (standardId === null) return;
    const found = await tx.certificateStandard.findFirst({
      where: notDeletedWhere({
        id: standardId,
        kind: CertificateStandardKind.CREDENTIAL,
        status: CertificateStandardStatus.ACTIVE,
        categoryCode: { in: [...RECRUITMENT_CERT_CATEGORIES] },
      }),
      select: { id: true },
    });
    if (!found) throw new BizException(BizCode.BAD_REQUEST);
  }

  /** 公开面统一的「凭证 → 报名 → 且这条 claim 属于该报名」三步(§13.3)。 */
  private async resolveOwnClaim(
    tx: Prisma.TransactionClient,
    applicationId: string,
    claimId: string,
  ): Promise<ClaimRow> {
    const claim = await tx.recruitmentCertificateClaim.findFirst({
      where: notDeletedWhere({ id: claimId }),
      select: claimSelect,
    });
    // §13.3「claimId 不能单独构成授权」:凭证解析出的报名必须与 claim 归属一致。
    // 不一致按「不存在」回,不区分「不存在」与「不是你的」—— 后者是枚举 id 的信号。
    if (!claim || claim.applicationId !== applicationId) {
      throw new BizException(BizCode.RECRUITMENT_CERTIFICATE_CLAIM_NOT_FOUND);
    }
    return claim;
  }

  async submitPublic(
    dto: SubmitCertificateClaimDto,
    files: UploadedImageFile[],
    meta: AuditMeta,
  ): Promise<PublicCertificateClaimResultDto> {
    // 顺序要紧:先跑**免费**的文件闸,再走可能消费短信码 / 调微信的凭证链
    // (沿 recruitment §4 冻结的校验顺序:免费校验先行)。
    this.assertClaimImages(files);
    const facts = this.applicantFacts(dto);
    const { app, channel } = await this.identity.resolveActiveApplicationByCredential(dto);

    // 落对象在事务外(putObject 不可回滚);失败域由 catch 兜底删本批。
    const imageKeys = await this.putClaimImages(files);
    try {
      return await this.prisma.$transaction(async (tx) => {
        // 凭证在事务外解析(要调微信 / 消费短信码),所以 `app` 是**锁前**快照。
        // 锁后必须复读状态与归属:等锁期间报名可能已被整份撤销 / 换绑 / 发号,
        // 而旧实现只锁不复读,于是能往一份已撤销的报名里插一条 SUBMITTED 申报。
        const locked = await lockOwnActiveApplicationOrThrow(tx, app, channel);
        await this.assertSuggestedStandardSelectable(tx, facts.suggestedStandardId);

        // 上限在**锁内**复查:两个并发提交都在锁外看到 9 条时,只有一个能过。
        const count = await tx.recruitmentCertificateClaim.count({
          where: notDeletedWhere({ applicationId: locked.id }),
        });
        if (count >= CERTIFICATE_CLAIM_MAX_PER_APPLICATION) {
          throw new BizException(BizCode.RECRUITMENT_CERTIFICATE_CLAIM_LIMIT);
        }

        const created = await tx.recruitmentCertificateClaim.create({
          data: {
            applicationId: locked.id,
            status: RecruitmentCertificateClaimStatus.SUBMITTED,
            ...facts,
            imageKeys,
          },
          select: claimSelect,
        });

        await this.auditLogs.log({
          event: 'recruitment-certificate-claim.submit',
          actorUserId: null, // 公开自助,无账号
          actorRoleSnap: null,
          resourceType: 'recruitment_certificate_claim',
          resourceId: created.id,
          meta,
          extra: {
            operation: 'submit',
            applicationId: locked.id,
            channel,
            categoryHintCode: facts.categoryHintCode,
            suggestedStandardProvided: facts.suggestedStandardId !== null,
            imageCount: imageKeys.length,
            certNumberProvided: facts.certNumber !== null,
          },
          tx,
        });

        // 新提交的 Claim 是 SUBMITTED,本身不贡献门槛;但重算是**幂等聚合**,
        // 调它可以让「唯一写者」这条规则没有例外 —— 例外就是漂移的入口。
        await this.recomputeCertificateThresholds(tx, locked.id, null, null, meta, new Date());

        return { claim: this.presentPublic(created), claimCount: count + 1 };
      });
    } catch (err) {
      for (const k of imageKeys) await this.safeDeleteBlob(k, 'delete-orphan-id-card-image');
      throw err;
    }
  }

  async resubmitPublic(
    claimId: string,
    dto: ResubmitCertificateClaimDto,
    files: UploadedImageFile[],
    meta: AuditMeta,
  ): Promise<PublicCertificateClaimResultDto> {
    this.assertClaimImages(files);
    const facts = this.applicantFacts(dto);
    const { app, channel } = await this.identity.resolveActiveApplicationByCredential(dto);

    const imageKeys = await this.putClaimImages(files);
    let replacedKeys: string[] = [];
    try {
      const result = await this.prisma.$transaction(async (tx) => {
        const locked = await lockOwnActiveApplicationOrThrow(tx, app, channel);
        const claim = await this.resolveOwnClaim(tx, locked.id, claimId);
        assertClaimVersionMatches(dto.version, claim.version);
        // 申请人只能改 SUBMITTED / NEEDS_INFO / REJECTED 的行 —— APPROVED 不可由申请人
        // 直接改(§8.2);要改就得管理员先撤回审核。
        assertApplicantMayMutate(claim.status);
        await this.assertSuggestedStandardSelectable(tx, facts.suggestedStandardId);

        const updated = await tx.recruitmentCertificateClaim.update({
          where: { id: claimId },
          data: {
            status: RecruitmentCertificateClaimStatus.SUBMITTED,
            ...facts,
            imageKeys,
            // 重传把上一轮的审核痕迹清掉:留着 reviewNote 会让申请人以为驳回说明
            // 还适用于这一版新材料。
            reviewedByUserId: null,
            reviewedAt: null,
            reviewNote: null,
            version: { increment: 1 },
          },
          select: claimSelect,
        });

        await this.auditLogs.log({
          event: 'recruitment-certificate-claim.submit',
          actorUserId: null,
          actorRoleSnap: null,
          resourceType: 'recruitment_certificate_claim',
          resourceId: claimId,
          meta,
          extra: {
            operation: 'resubmit',
            applicationId: locked.id,
            channel,
            categoryHintCode: facts.categoryHintCode,
            suggestedStandardProvided: facts.suggestedStandardId !== null,
            imageCount: imageKeys.length,
            replacedCount: this.imageCountOf(claim.imageKeys),
            certNumberProvided: facts.certNumber !== null,
          },
          tx,
        });

        // 重传会让一条曾经 APPROVED→(管理员撤回)→SUBMITTED 的行退出贡献,必须重算。
        await this.recomputeCertificateThresholds(tx, locked.id, null, null, meta, new Date());

        const count = await tx.recruitmentCertificateClaim.count({
          where: notDeletedWhere({ applicationId: locked.id }),
        });
        return {
          payload: { claim: this.presentPublic(updated), claimCount: count },
          replaced: this.imageKeysOf(claim.imageKeys),
        };
      });
      replacedKeys = result.replaced;
      // 事务提交后才删旧图 —— 提交前删,回滚就会让一条仍在库里的 Claim 指向已删对象。
      for (const k of replacedKeys) {
        await this.safeDeleteBlob(k, 'delete-replaced-certificate-image');
      }
      return result.payload;
    } catch (err) {
      for (const k of imageKeys) await this.safeDeleteBlob(k, 'delete-orphan-id-card-image');
      throw err;
    }
  }

  async withdrawPublic(
    claimId: string,
    dto: WithdrawCertificateClaimDto,
    meta: AuditMeta,
  ): Promise<PublicCertificateClaimResultDto> {
    const { app, channel } = await this.identity.resolveActiveApplicationByCredential(dto);

    const result = await this.prisma.$transaction(async (tx) => {
      const locked = await lockOwnActiveApplicationOrThrow(tx, app, channel);
      const claim = await this.resolveOwnClaim(tx, locked.id, claimId);
      assertClaimVersionMatches(dto.version, claim.version);
      // 状态机负责拦 PROMOTED / 已 WITHDRAWN(两个空集终态)。
      assertClaimTransitionAllowed(claim.status, RecruitmentCertificateClaimStatus.WITHDRAWN);

      const updated = await tx.recruitmentCertificateClaim.update({
        where: { id: claimId },
        data: {
          status: RecruitmentCertificateClaimStatus.WITHDRAWN,
          version: { increment: 1 },
        },
        select: claimSelect,
      });

      await this.auditLogs.log({
        event: 'recruitment-certificate-claim.submit',
        actorUserId: null,
        actorRoleSnap: null,
        resourceType: 'recruitment_certificate_claim',
        resourceId: claimId,
        meta,
        extra: {
          operation: 'withdraw',
          applicationId: locked.id,
          channel,
          previousStatus: claim.status,
          imageCount: this.imageCountOf(claim.imageKeys),
        },
        tx,
      });

      // 撤回一条已通过的证书会让门槛回落 —— 若同类别还有另一张 APPROVED,聚合仍成立。
      await this.recomputeCertificateThresholds(tx, locked.id, null, null, meta, new Date());

      const count = await tx.recruitmentCertificateClaim.count({
        where: notDeletedWhere({ applicationId: locked.id }),
      });
      return { claim: this.presentPublic(updated), claimCount: count };
    });
    // 证据清理按 §8.4「进入证据清理流程」——留存 SOP 在 PR-6,此刻不删对象:
    // 撤回后短期内仍可能需要复核「他撤的是什么」,过早删掉就再也查不回来。
    return result;
  }
}
