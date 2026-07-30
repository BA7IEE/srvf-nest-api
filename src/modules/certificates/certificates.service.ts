import { Inject, Injectable } from '@nestjs/common';
import { CertificateSource, DictItemStatus, DictTypeStatus, Prisma } from '@prisma/client';
import { maskIdentifier } from '../../common/audit/mask-pii.util';
import { beijingDateOnly } from '../../common/datetime/date-only.util';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode, type BizCodeEntry } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { claimAtStatus } from '../../common/prisma/claim-at-status.util';
import { notDeletedWhere } from '../../common/prisma/soft-delete.util';
import { PrismaService } from '../../database/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { AuthzService } from '../authz/authz.service';
import type { ResourceRef } from '../authz/authz.types';
import { RbacService } from '../permissions/rbac.service';
import { AttachmentsService } from '../attachments/attachments.service';
import { STORAGE_PROVIDER } from '../storage/storage.constants';
import type { StorageProvider } from '../storage/storage.interface';
import { CertificateEvidenceSigner } from './certificate-evidence-signer';
import { expiryIsClientSupplied } from './certificate-standard-policy';
import { CertificateRecognitionResolver } from './certificate-recognition-resolver';
import {
  CertificateEvidenceUrlsResponseDto,
  CertificateListItemDto,
  CertificateResponseDto,
  CreateCertificateDto,
  QualificationFlagResponseDto,
  RejectCertificateDto,
  type QualificationCriterionType,
  UpdateCertificateDto,
  VerifyCertificateDto,
} from './certificates.dto';

// V2 第一阶段批次 2 certificates service。
// 详见 docs:
//   - 批次2_schema草案_certificates.md (v1.0 冻结版)
//   - 批次2_schema草案评审决议表.md (Q-S1~Q-S10)
//   - 批次2_schema草案评审决议表_v0.1.md (Q-D1~Q-D8)
//   - 批次2_API前评审_certificates.md (Q-A1~Q-A5 + Q-I1 / Q-I2)
//
// 关键约定:
// - N:1 with Member;list 无分页(演示规模 ≤ 10 / 人,Plan §4.3)
// - 列表排序:certStatusCode ASC, createdAt DESC(状态分组 + 同状态下新证书在前)
// - 列表精简:不返 certNumber / verifyNote / verifiedBy / verifiedAt /
//   supersededByCertId(草案 §13.1)
// - 软删走 deletedAt(草案 §9.2);列表自动过滤已软删
// - 字典校验:cert_type 必填,cert_sub_type 提供时校验;cert_status 由 service 内部写常量,不接外部
// - 状态机 4 态闭集:create→pending、verify(pending→verified)、reject(pending→rejected);
//   非闭集状态转移抛 CERTIFICATE_INVALID_STATE_TRANSITION
// - 跨 member 校验:cert.memberId !== :memberId 抛 CERTIFICATE_NOT_BELONGS_TO_MEMBER
// - audit:list / findOne / isQualified 查询完成后 fail-closed 落真实 audit_logs;
//   create / update / softDelete / verify / reject 继续保持事务内写审计
// - verifiedBy:取 currentUser.user.memberId(可空,Q-I2);user 无 memberId 时 verifiedBy=null
// - isInternal:DTO 不接收;service 始终写 false(本批次零本会证书 API 路径,Q-A3)
// - supersededByCertId / expireNotifyDueAt:本批次 zero API 写入

const DICT_TYPE_CERT_TYPE = 'cert_type';

const CERT_STATUS_PENDING = 'pending';
const CERT_STATUS_VERIFIED = 'verified';
// §13.5 的 TTL 与签发循环已搬进 `CertificateEvidenceSigner` —— 本文件与
// recruitment 的 Claim 取图曾各写一份,连常量都各声明了一个。
const CERT_STATUS_REJECTED = 'rejected';
// 评审 findings F3(§9.3):`expired` 不再只由 v0.47.0 的到期扫描 cron 推动 ——
// 核验一张最后有效日已过的证书必须**直接**落 expired。cron 只翻 verified 行,
// 而这里正是产出 verified 行的地方:写死 verified 等于亲手造出一个 cron next-run
// 之前一直被资质查询当有效的过期证书。
const CERT_STATUS_EXPIRED = 'expired';

// 证书标准库 PR-4a-3:「改了核心事实就回 pending」的判定改用 update 内的
// `factsTouched`(它同时决定要不要重跑认定规则解析)。拆成两处会让「什么算核心事实」
// 有两个定义,而这两处必须永远一致 —— 少了任一边都会写出「改了事实却没重新复核」。

// 详情 / 写操作返回的完整 select(永不含 deletedAt 软删内部状态、永不含 expireNotifyDueAt
// hook 字段);必须与 CertificateResponseDto 同步维护。
//
// 证书标准库 PR-4b:四个重复事实列已 DROP(certTypeCode / certSubTypeCode /
// isInternal / imageKeys)。类别、等级、内部属性只有一个权威 —— CertificateStandard,
// 读侧要用就 join;`evidenceAvailable` 改判 sourceClaim 的证据(§13.5)。
const certificateSafeSelect = {
  id: true,
  memberId: true,
  issuingOrg: true,
  certNumber: true,
  issuedAt: true,
  expiredAt: true,
  certStatusCode: true,
  verifiedBy: true,
  verifiedAt: true,
  verifyNote: true,
  supersededByCertId: true,
  // 证书标准库 PR-4a-3:update 的「沿已锁定 policyId 校验」需要这三列作基准。
  standardId: true,
  recognitionPolicyId: true,
  recognitionIssuerId: true,
  sourceCode: true,
  // PR-4b:证据判定改看 sourceClaim —— RECRUITMENT 来源的 evidence 在 Claim 上,
  // ADMIN 来源在 ownerType=certificate 的 Attachment 上(§13.5 的 evidence-urls 走 PR-5)。
  // 这里只取「有没有」,不取 key。
  sourceClaim: { select: { imageKeys: true } },
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.CertificateSelect;

// 列表 select:精简(草案 §13.1)。
// 必须与 CertificateListItemDto 同步维护。
const certificateListItemSelect = {
  id: true,
  memberId: true,
  issuingOrg: true,
  issuedAt: true,
  expiredAt: true,
  certStatusCode: true,
  // PR-4b:列表也改带 standardId(前端靠它显示「哪个标准」),旧三列已 DROP。
  standardId: true,
  sourceCode: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.CertificateSelect;

type SafeCertificate = Prisma.CertificateGetPayload<{ select: typeof certificateSafeSelect }>;

type PrismaTx = Prisma.TransactionClient;

// PR-4b:证据来源从实例侧 `Certificate.imageKeys` 改为 `sourceClaim.imageKeys`(§13.5)。
// 只判「有没有」,不解析内容也不外传 key。
// ADMIN 来源的证据是 ownerType=certificate 的 Attachment,判定与取图都归 PR-5 的
// evidence-urls 端点 —— 本布尔此刻只覆盖 RECRUITMENT 来源,不假装覆盖两种。
function hasEvidence(sourceClaim: { imageKeys: Prisma.JsonValue } | null): boolean {
  const keys = sourceClaim?.imageKeys ?? null;
  return Array.isArray(keys) && keys.length > 0;
}

// 证书标准库 PR-1 · 冻结稿 §15.3 敏感分级的**唯一出口**。
//
// 6 个返 `CertificateResponseDto` 的方法(findOne / create / update / softDelete /
// verify / reject)必须全部经过它 —— 少接一条路径,那条路径就会把 L2 明文漏出去。
// 出参形状由 TypeScript 兜底:`CertificateResponseDto` 不再有 `certNumber`,
// 直接 `return cert` 会编译失败,漏接不可能静默通过。
//
// 普通 `certificate.read.record`:编号只给掩码、审核备注与审核人 id 恒 null。
// 另持 scoped `certificate.read.sensitive`:明文编号 + 备注 + 审核人 id。
// `sourceClaim` / `certNumber` 原值一律不进出参(前者含 object key)。
function presentCertificate(cert: SafeCertificate, sensitive: boolean): CertificateResponseDto {
  const { certNumber, sourceClaim, ...rest } = cert;
  return {
    ...rest,
    certNumberMasked: maskIdentifier(certNumber),
    certNumberFull: sensitive ? certNumber : null,
    verifyNote: sensitive ? cert.verifyNote : null,
    verifiedBy: sensitive ? cert.verifiedBy : null,
    evidenceAvailable: hasEvidence(sourceClaim),
  };
}

// Date(北京日历日 UTC 零点)→ 纯 YYYY-MM-DD。Resolver 的入参契约是纯日期字符串,
// 而 update 的基准值来自库内 Date —— 少了这层就会把 ISO datetime 塞进去,
// 而那正是 PR-1 收紧掉的东西(时区能偷偷改天)。
function toDateOnlyString(d: Date | null): string | null {
  return d === null ? null : d.toISOString().slice(0, 10);
}

@Injectable()
export class CertificatesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogs: AuditLogsService,
    private readonly rbac: RbacService,
    private readonly authz: AuthzService,
    // 证书标准库 PR-4a-3(§19):与招新 Claim 审核共用同一套认定规则解析,
    // 不在建证侧复制第二套机构 / 编号 / 日期算法。
    private readonly recognitionResolver: CertificateRecognitionResolver,
    // 证书标准库 PR-5(§13.5):RECRUITMENT 来源的证据 key 在 Claim 上,直接短 TTL 签;
    // ADMIN 来源**必须**经 AttachmentsService 的可读性 + pinned ledger 路径,
    // 不允许业务模块自己拼 URL(§13.5 实现约束)。
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
    private readonly attachments: AttachmentsService,
    // §13.5:证据签发的唯一封装,与招新 Claim 取图共用同一份。
    private readonly evidenceSigner: CertificateEvidenceSigner,
  ) {}

  // ============ helpers ============

  private async assertCanOrThrow(
    user: CurrentUserPayload,
    action: string,
    ref: ResourceRef,
  ): Promise<void> {
    const decision = await this.authz.explain(user, action, ref);
    if (decision.allow) return;
    if (decision.reason === 'resource_not_found' && (await this.rbac.can(user, action))) return;
    throw new BizException(BizCode.RBAC_FORBIDDEN);
  }

  // §15.3:明文闸。入口码仍是 `certificate.read.record`(由各方法的写/读 gate 把守),
  // 本闸只决定「同一次响应里给不给明文」,无权时降级为掩码而不是 403。
  //
  // ref 与该方法自己的 gate 用同一个 —— create 用 member ref(证书此刻在事务内尚未
  // 对其他连接可见,拿 certificate ref 会解析不到而误判无权),其余用 certificate ref。
  // 一律在事务外先算,避免在事务中间引入跨连接可见性问题。
  private async canReadSensitive(user: CurrentUserPayload, ref: ResourceRef): Promise<boolean> {
    return this.authz.can(user, 'certificate.read.sensitive', ref);
  }

  private async findMemberOrThrow(memberId: string, tx?: PrismaTx): Promise<{ id: string }> {
    const client = tx ?? this.prisma;
    const m = await client.member.findFirst({
      where: notDeletedWhere({ id: memberId }),
      select: { id: true },
    });
    if (!m) throw new BizException(BizCode.MEMBER_NOT_FOUND);
    return m;
  }

  // 冻结稿 §10.3 基础校验(证书标准库 PR-1)。
  //
  //   issuedAt  <= today
  //   expiredAt IS NULL OR expiredAt >= issuedAt
  //
  // 证书标准库 PR-4a-3:PR-1 的 `assertDateSemantics` 退役 —— 它的两条判断
  // (issuedAt 不晚于今天 18018 / expiredAt 不早于 issuedAt 18017)已经在
  // `CertificateRecognitionResolver.resolveDates` + `assertRange` 里,
  // 而且那里还多了按 validityMode 的规则校验。留两份日期算法就是 §19 明令要避免的
  // 「第二套日期算法」—— 两份迟早会在某一次改动里分叉。
  //
  // 行为等价性由既有 e2e 保证:那几条用例逐字未改,只是现在打在 Resolver 上。

  // 通用字典 code 校验(对齐 member-profiles.assertDictItemValid 模式)。
  private async assertDictItemValid(
    typeCode: string,
    code: string,
    biz: BizCodeEntry,
    tx?: PrismaTx,
  ): Promise<void> {
    const client = tx ?? this.prisma;
    const item = await client.dictItem.findFirst({
      where: {
        code,
        status: DictItemStatus.ACTIVE,
        deletedAt: null,
        type: {
          code: typeCode,
          status: DictTypeStatus.ACTIVE,
          deletedAt: null,
        },
      },
      select: { id: true },
    });
    if (!item) throw new BizException(biz);
  }

  // 找 cert + 校验归属 + notDeleted。返回 status 给状态机用。
  //
  // V2 批次 6 PR #2 修订:select 扩展为 certificateSafeSelect(全字段),让
  // update / softDelete / verify / reject 不再额外查一次拿 before 数据(D6 v1.1 §8.2)。
  // 调用方仅取 cert.id / cert.memberId / cert.certStatusCode 的语义兼容(返回类型是超集)。
  private async findCertificateInMemberOrThrow(
    memberId: string,
    certificateId: string,
    tx?: PrismaTx,
  ): Promise<SafeCertificate> {
    const client = tx ?? this.prisma;
    const cert = await client.certificate.findFirst({
      where: notDeletedWhere({ id: certificateId }),
      select: certificateSafeSelect,
    });
    if (!cert) throw new BizException(BizCode.CERTIFICATE_NOT_FOUND);
    if (cert.memberId !== memberId) {
      throw new BizException(BizCode.CERTIFICATE_NOT_BELONGS_TO_MEMBER);
    }
    return cert;
  }

  // 把完整 Certificate 转成"JSON-safe 可入 audit context"的 snapshot(D6 v1.1 §8.2)。
  // certNumber 仅写通用标识符掩码；verifyNote 自由文本不入不可变审计，只留是否提供及
  // 本次是否变化。Date 字段必须 toISOString，避免 Prisma InputJsonValue 拒绝 Date。
  // 不含 id / memberId / createdAt / updatedAt(audit_logs 自带 resourceId / createdAt / actorUser)。
  private toCertSnapshot(c: SafeCertificate, verifyNoteChanged = false): Record<string, unknown> {
    return {
      // PR-4b:类别 / 等级 / 内部属性的实例侧副本已 DROP —— 审计改记 standardId 引用。
      standardId: c.standardId,
      recognitionPolicyId: c.recognitionPolicyId,
      sourceCode: c.sourceCode,
      issuingOrg: c.issuingOrg,
      certNumber: maskIdentifier(c.certNumber),
      issuedAt: c.issuedAt.toISOString(),
      expiredAt: c.expiredAt ? c.expiredAt.toISOString() : null,
      certStatusCode: c.certStatusCode,
      verifiedBy: c.verifiedBy,
      verifiedAt: c.verifiedAt ? c.verifiedAt.toISOString() : null,
      verifyNoteProvided: this.isVerifyNoteProvided(c.verifyNote),
      verifyNoteChanged,
      supersededByCertId: c.supersededByCertId,
    };
  }

  private toVerifyNoteAuditState(
    status: string,
    verifyNote: string | null,
    verifyNoteChanged: boolean,
  ): Record<string, unknown> {
    return {
      status,
      verifyNoteProvided: this.isVerifyNoteProvided(verifyNote),
      verifyNoteChanged,
    };
  }

  private isVerifyNoteProvided(verifyNote: string | null): boolean {
    return verifyNote !== null && verifyNote !== '';
  }

  // Q-I2 决议:取 currentUser 关联的 user.memberId 作为 verifiedBy;
  // SUPER_ADMIN 默认 memberId=null 时返 null,不卡核验流程。
  // 审计 hook 仍记 currentUser.id 完整保留 user 维度。
  private async getVerifierMemberId(userId: string, tx: PrismaTx): Promise<string | null> {
    const u = await tx.user.findFirst({
      where: notDeletedWhere({ id: userId }),
      select: { memberId: true },
    });
    return u?.memberId ?? null;
  }

  // ============ list ============

  async list(
    memberId: string,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<CertificateListItemDto[]> {
    await this.assertCanOrThrow(currentUser, 'certificate.read.record', {
      type: 'member',
      id: memberId,
    });
    await this.findMemberOrThrow(memberId);

    const items = await this.prisma.certificate.findMany({
      where: notDeletedWhere({ memberId }),
      select: certificateListItemSelect,
      orderBy: [{ certStatusCode: 'asc' }, { createdAt: 'desc' }],
    });

    await this.auditLogs.log({
      event: 'certificate.read.other',
      actorUserId: currentUser.id,
      actorRoleSnap: currentUser.role,
      resourceType: 'member',
      resourceId: memberId,
      meta: auditMeta,
      extra: { operation: 'list', count: items.length },
    });

    return items;
  }

  // ============ findOne ============

  async findOne(
    memberId: string,
    certificateId: string,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<CertificateResponseDto> {
    const ref: ResourceRef = { type: 'certificate', id: certificateId };
    await this.assertCanOrThrow(currentUser, 'certificate.read.record', ref);
    await this.findMemberOrThrow(memberId);

    const cert = await this.prisma.certificate.findFirst({
      where: notDeletedWhere({ id: certificateId }),
      select: certificateSafeSelect,
    });
    if (!cert) throw new BizException(BizCode.CERTIFICATE_NOT_FOUND);
    if (cert.memberId !== memberId) {
      throw new BizException(BizCode.CERTIFICATE_NOT_BELONGS_TO_MEMBER);
    }

    const sensitive = await this.canReadSensitive(currentUser, ref);

    await this.auditLogs.log({
      event: 'certificate.read.other',
      actorUserId: currentUser.id,
      actorRoleSnap: currentUser.role,
      resourceType: 'certificate',
      resourceId: cert.id,
      meta: auditMeta,
      // maskLevel 沿 member-profiles §F&A-3 惯例:记「这次给了明文还是掩码」,
      // 便于事后追「谁看过完整编号」;不记编号本身(§15.6)。
      extra: { operation: 'detail', maskLevel: sensitive ? 'plain' : 'masked' },
    });

    return presentCertificate(cert, sensitive);
  }

  // ============ create ============

  // service 写 certStatusCode='pending' / isInternal=false(Q-A3 决议)。
  // hook B4:含拒绝→重新提交的"新建"路径(用户视角是重新提交,业务实际是 POST 新记录;
  // 旧拒绝记录由调用方软删,本方法不处理)。
  async create(
    memberId: string,
    dto: CreateCertificateDto,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<CertificateResponseDto> {
    const ref: ResourceRef = { type: 'member', id: memberId };
    await this.assertCanOrThrow(currentUser, 'certificate.create.record', ref);
    const sensitive = await this.canReadSensitive(currentUser, ref);
    return this.prisma.$transaction(async (tx) => {
      await this.findMemberOrThrow(memberId, tx);

      // 证书标准库 PR-4a-3(§9.1 步骤 2-7):按 Standard 当前 ACTIVE Policy 解析机构 /
      // 编号 / 日期。**不再校验两个字典 code** —— 类别与等级现在是 Standard 的属性,
      // 由 PR-3 的 Standard 管理面在建标准时校验过一次,建证时不必也不该再猜。
      //
      // 日期语义(不晚于今天 / 区间不倒挂 / 按 validityMode)全在 Resolver 内,
      // 与招新审核共用同一实现(§19)—— 所以这里不再单独调 assertDateSemantics。
      const resolved = await this.recognitionResolver.resolveActivePolicyForNewCertificate(
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

      const data: Prisma.CertificateUncheckedCreateInput = {
        memberId,
        // PR-4b:四个重复事实列已 DROP —— 类别 / 等级 / 内部属性只有一个权威
        // (CertificateStandard),读侧 join 即得;实例侧不再有任何副本。
        standardId: resolved.standardId,
        recognitionPolicyId: resolved.recognitionPolicyId,
        recognitionIssuerId: resolved.recognitionIssuerId,
        sourceCode: CertificateSource.ADMIN,
        issuingOrg: resolved.issuingOrg,
        certNumber: resolved.certNumber,
        issuedAt: resolved.issuedAt,
        expiredAt: resolved.expiredAt,
        certStatusCode: CERT_STATUS_PENDING,
      };

      const created = await tx.certificate.create({
        data,
        select: certificateSafeSelect,
      });

      await this.auditLogs.log({
        event: 'certificate.create',
        actorUserId: currentUser.id,
        actorRoleSnap: currentUser.role,
        resourceType: 'certificate',
        resourceId: created.id,
        meta: auditMeta,
        after: this.toCertSnapshot(created),
        extra: { targetMemberId: memberId, operation: 'create' },
        tx,
      });

      return presentCertificate(created, sensitive);
    });
  }

  // ============ update ============

  // PATCH 接受 6 字段(Q-A4:含 issuedAt / expiredAt 资料修正)。
  // **绝对不接收** certStatusCode / verifiedBy / verifiedAt / verifyNote / isInternal /
  // supersededByCertId / expireNotifyDueAt(由 forbidNonWhitelisted 兜底)。
  // hook B5 不含 verify / reject / softDelete / expire(各有独立 hook)。
  async update(
    memberId: string,
    certificateId: string,
    dto: UpdateCertificateDto,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<CertificateResponseDto> {
    const ref: ResourceRef = { type: 'certificate', id: certificateId };
    await this.assertCanOrThrow(currentUser, 'certificate.update.record', ref);
    const sensitive = await this.canReadSensitive(currentUser, ref);
    return this.prisma.$transaction(async (tx) => {
      await this.findMemberOrThrow(memberId, tx);
      const before = await this.findCertificateInMemberOrThrow(memberId, certificateId, tx);

      const data: Prisma.CertificateUncheckedUpdateInput = {};

      await claimAtStatus(tx, {
        target: 'certificate',
        id: before.id,
        expectedStatus: before.certStatusCode,
        invalidStatusBiz: BizCode.CERTIFICATE_INVALID_STATE_TRANSITION,
      });
      const lockedBefore = await this.findCertificateInMemberOrThrow(memberId, certificateId, tx);

      // 证书标准库 PR-4a-3(§9.2):Standard 只在 pending 态可改(纠正选错的标准)。
      // 非 pending 传它 → 18033(身份字段不可改)。这条依赖行状态,DTO 表达不了,
      // 所以必须在**行锁之后**判 —— 锁前判会被并发的 verify 抢在中间。
      const changingStandard =
        dto.standardId !== undefined && dto.standardId !== lockedBefore.standardId;
      if (changingStandard && lockedBefore.certStatusCode !== CERT_STATUS_PENDING) {
        throw new BizException(BizCode.CERTIFICATE_STANDARD_IMMUTABLE);
      }

      // §9.2 两条规则的分岔点:
      //   改 Standard  → 重选**当前 ACTIVE** Policy 并完整重校验(换标准就是换规则);
      //   只改事实      → 继续沿该证**已锁定**的 policyId 校验,避免规则在录入后移动
      //                  (原 Policy 已 RETIRED 仍允许按该版本修正与复核)。
      // 校验用「本次写入后的最终值」而不是只看本次传了什么:只改 expiredAt 时
      // 也必须和库内 issuedAt 比,否则能写出 expiredAt < issuedAt。
      // 基准取 lockedBefore(行锁之后),避免并发改动下用过期基准放行。
      const factsTouched =
        dto.standardId !== undefined ||
        dto.recognitionIssuerId !== undefined ||
        dto.issuingOrg !== undefined ||
        dto.certNumber !== undefined ||
        dto.issuedAt !== undefined ||
        dto.expiredAt !== undefined;

      let effectiveExpiredAt = lockedBefore.expiredAt;
      // R6:决定「要不要打回 pending」的不是「客户端提到了哪些字段」,
      // 而是「Resolver 算出的最终值与库内值比,到底变没变」。见下方赋值处。
      let factsActuallyChanged = false;
      if (factsTouched) {
        // 「不传 expiredAt = 保持库内现值」对**派生型**规则(PERMANENT / FIXED_MONTHS)
        // 不能照字面执行:把库内那个后端自己算出来的值回传给 Resolver,会被
        // 「客户端不得传到期日」拒成 18016。派生型的「保持现值」= 不传,
        // 让规则按同一个 issuedAt 重新派生出同一个值。
        //
        // 所以要先知道**已锁定规则**的 validityMode。换标准那一支不需要:
        // 它本来就传 null,新规则爱怎么派生怎么派生。
        const lockedPolicy = changingStandard
          ? null
          : await tx.certificateRecognitionPolicy.findFirst({
              where: notDeletedWhere({ id: lockedBefore.recognitionPolicyId ?? '' }),
              select: { validityMode: true },
            });
        const keepStoredExpiry =
          lockedPolicy !== null && expiryIsClientSupplied(lockedPolicy.validityMode);
        // PATCH 语义:没传的字段**保持库内现值**。机构这一对尤其要小心 ——
        // 只改 expiredAt 时若把 issuingOrg 当 null 传给 Resolver,FREE_TEXT 规则会
        // 立刻以 18013 拒掉一次本来合法的日期修正。所以两个机构入参各自回落到库内值,
        // 显式传了哪一个就清掉另一个(它们互斥,由 issuerPolicy 决定用哪个)。
        const issuerExplicit =
          dto.recognitionIssuerId !== undefined || dto.issuingOrg !== undefined;
        const facts = {
          recognitionIssuerId: issuerExplicit
            ? (dto.recognitionIssuerId ?? null)
            : lockedBefore.recognitionIssuerId,
          issuingOrg: issuerExplicit
            ? (dto.issuingOrg ?? null)
            : // 库内 issuerId 为空 = FREE_TEXT 谱系,机构名就是那一列;
              // 有 issuerId 时机构名由 issuer 决定,不能再当自由文本回传(否则 18013)。
              lockedBefore.recognitionIssuerId === null
              ? lockedBefore.issuingOrg
              : null,
          // ⚠️ 三态判定必须用 `!== undefined` 而不是 `??`:
          // `??` 把**显式传来的 null** 当成「没传」,于是 `certNumber: null`
          // 清不掉编号(OPTIONAL 规则下改回无编号是合法诉求),
          // 而 `expiredAt: null` 也清不成终身有效。
          certNumber: dto.certNumber !== undefined ? dto.certNumber : lockedBefore.certNumber,
          // issuedAt 在库内 NOT NULL,DTO 侧已用 @ValidateIf 拒掉显式 null。
          issuedAt: dto.issuedAt ?? (toDateOnlyString(lockedBefore.issuedAt) as string),
          expiredAt:
            dto.expiredAt !== undefined
              ? // 显式传了(含 null = 清成终身有效)
                dto.expiredAt
              : changingStandard
                ? // 换标准 = 换规则,旧到期日不再由新 Policy 背书,一律重算/重填。
                  null
                : keepStoredExpiry
                  ? // 没传 + EXPLICIT 规则 → **保持库内现值**。
                    //
                    // 修复前这一格写的是 `dto.standardId !== undefined ? null : ...` ——
                    // 判的是「传没传 standardId」而不是「换没换 standardId」。
                    // 于是前端提交完整表单(带上原样的 standardId)却不带 expiredAt 时,
                    // 一张有到期日的证书会被**静默清成终身有效**。
                    toDateOnlyString(lockedBefore.expiredAt)
                  : // 没传 + 派生型规则 → 不传,让规则重新派生(见上方 keepStoredExpiry)。
                    null,
        };
        const resolved = changingStandard
          ? await this.recognitionResolver.resolveActivePolicyForNewCertificate(
              tx,
              dto.standardId as string,
              facts,
            )
          : await this.recognitionResolver.validateLockedPolicyForCertificateUpdate(
              tx,
              // 已锁定 policyId 必存在:PR-4b 会把它收紧为 NOT NULL,在此之前
              // 存量行理论上可能为空 —— 那种行按「无生效认定规则」拒改,不猜。
              lockedBefore.recognitionPolicyId ??
                (() => {
                  throw new BizException(BizCode.CERTIFICATE_ACTIVE_POLICY_MISSING);
                })(),
              facts,
            );
        data.standardId = resolved.standardId;
        data.recognitionPolicyId = resolved.recognitionPolicyId;
        data.recognitionIssuerId = resolved.recognitionIssuerId;
        data.issuingOrg = resolved.issuingOrg;
        data.certNumber = resolved.certNumber;
        data.issuedAt = resolved.issuedAt;
        data.expiredAt = resolved.expiredAt;
        // PR-4b:certTypeCode 已 DROP,过渡期的回填随之删除 ——
        // 类别只有一个权威(Standard),读侧 join 即得。
        effectiveExpiredAt = resolved.expiredAt;

        // R6:逐字段比对**最终值**与锁后库内值。
        //
        // 修复前判据是 `factsTouched`(字段在不在请求体里),后果是前端按惯例
        // 提交整张表单 —— 哪怕一个字都没改 —— 也会把一张 verified 证书打回 pending
        // 重审。管理端表单几乎都是「回填 + 整体提交」,所以这不是边角情况而是常态。
        factsActuallyChanged =
          resolved.standardId !== lockedBefore.standardId ||
          resolved.recognitionPolicyId !== lockedBefore.recognitionPolicyId ||
          resolved.recognitionIssuerId !== lockedBefore.recognitionIssuerId ||
          resolved.issuingOrg !== lockedBefore.issuingOrg ||
          resolved.certNumber !== lockedBefore.certNumber ||
          resolved.issuedAt.getTime() !== lockedBefore.issuedAt.getTime() ||
          (resolved.expiredAt?.getTime() ?? null) !== (lockedBefore.expiredAt?.getTime() ?? null);
      }

      // §9.2:`expiredAt` 最终值变化时清空 `expireNotifyDueAt`,让到期提醒按新日期
      // 重新计算(该标记是 at-most-once 的已提醒水印,不清会永久错过新窗口)。
      // 只在真的变化时清 —— 传了同值不算变化,不无谓抹掉已发提醒的事实。
      if ((effectiveExpiredAt?.getTime() ?? null) !== (lockedBefore.expiredAt?.getTime() ?? null)) {
        data.expireNotifyDueAt = null;
      }

      // §9.2:verified / expired / rejected 改核心事实后重回 pending(要重新复核)。
      // 判据是「事实**真的**变了」而不是「请求体里出现过这些字段」——
      // 后者会让一次无变化的整表单提交把已核验证书打回重审。
      if (factsActuallyChanged && lockedBefore.certStatusCode !== CERT_STATUS_PENDING) {
        data.certStatusCode = CERT_STATUS_PENDING;
        data.verifiedBy = null;
        data.verifiedAt = null;
        data.verifyNote = null;
      }
      const updated = await tx.certificate.update({
        where: { id: lockedBefore.id },
        data,
        select: certificateSafeSelect,
      });

      await this.auditLogs.log({
        event: 'certificate.update',
        actorUserId: currentUser.id,
        actorRoleSnap: currentUser.role,
        resourceType: 'certificate',
        resourceId: lockedBefore.id,
        meta: auditMeta,
        before: this.toCertSnapshot(lockedBefore),
        after: this.toCertSnapshot(updated, lockedBefore.verifyNote !== updated.verifyNote),
        extra: { targetMemberId: memberId, operation: 'update' },
        tx,
      });

      return presentCertificate(updated, sensitive);
    });
  }

  // ============ softDelete ============

  // Q-A5 决议:softDelete 用独立 hook certificate.delete,不复用 update。
  // 软删 = update({ deletedAt: now });不物理删除(草案 §9.2 / R12)。
  async softDelete(
    memberId: string,
    certificateId: string,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<CertificateResponseDto> {
    const ref: ResourceRef = { type: 'certificate', id: certificateId };
    await this.assertCanOrThrow(currentUser, 'certificate.delete.record', ref);
    const sensitive = await this.canReadSensitive(currentUser, ref);
    return this.prisma.$transaction(async (tx) => {
      await this.findMemberOrThrow(memberId, tx);
      const before = await this.findCertificateInMemberOrThrow(memberId, certificateId, tx);

      const removed = await tx.certificate.update({
        where: { id: before.id },
        data: { deletedAt: new Date() },
        select: certificateSafeSelect,
      });

      await this.auditLogs.log({
        event: 'certificate.delete',
        actorUserId: currentUser.id,
        actorRoleSnap: currentUser.role,
        resourceType: 'certificate',
        resourceId: before.id,
        meta: auditMeta,
        before: this.toCertSnapshot(before),
        extra: {
          targetMemberId: memberId,
          operation: 'softDelete',
          priorStatusCode: before.certStatusCode,
        },
        tx,
      });

      return presentCertificate(removed, sensitive);
    });
  }

  // ============ verify ============

  // 状态机:pending → verified;非 pending 抛 CERTIFICATE_INVALID_STATE_TRANSITION(409)。
  // 写入字段:certStatusCode='verified' / verifiedBy=user.memberId(可空,Q-I2)/
  //          verifiedAt=now / verifyNote=dto.verifyNote ?? null。
  async verify(
    memberId: string,
    certificateId: string,
    dto: VerifyCertificateDto,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<CertificateResponseDto> {
    const ref: ResourceRef = { type: 'certificate', id: certificateId };
    await this.assertCanOrThrow(currentUser, 'certificate.verify.record', ref);
    const sensitive = await this.canReadSensitive(currentUser, ref);
    return this.prisma.$transaction(async (tx) => {
      await this.findMemberOrThrow(memberId, tx);
      const before = await this.findCertificateInMemberOrThrow(memberId, certificateId, tx);

      if (before.certStatusCode !== CERT_STATUS_PENDING) {
        throw new BizException(BizCode.CERTIFICATE_INVALID_STATE_TRANSITION);
      }

      await claimAtStatus(tx, {
        target: 'certificate',
        id: before.id,
        expectedStatus: before.certStatusCode,
        invalidStatusBiz: BizCode.CERTIFICATE_INVALID_STATE_TRANSITION,
      });
      const verifierMemberId = await this.getVerifierMemberId(currentUser.id, tx);

      // §9.3:核验的落点状态由**到期日**决定,不是无条件 verified。
      //
      // 修复前这里写死 `verified`,理由是「expired 由每天 09:00 的到期扫描 cron 推动」。
      // 但那条 cron 只处理**已经是 verified** 的行,而这里正在把一张最后有效日
      // 早于今天的证书写成 verified —— 它会一直被资质查询当作有效,直到次日 09:00。
      // 发号路径(§8.5 第 8 步)早就按同一规则分流了,管理端核验没跟上。
      const today = beijingDateOnly(new Date());
      const alreadyExpired =
        before.expiredAt !== null && before.expiredAt.getTime() < today.getTime();

      const updated = await tx.certificate.update({
        where: { id: before.id },
        data: {
          certStatusCode: alreadyExpired ? CERT_STATUS_EXPIRED : CERT_STATUS_VERIFIED,
          verifiedBy: verifierMemberId,
          verifiedAt: new Date(),
          verifyNote: dto.verifyNote ?? null,
        },
        select: certificateSafeSelect,
      });

      // verify/reject 的 before/after 仅状态相关字段(D6 v1.1 §8.2),非完整快照
      await this.auditLogs.log({
        event: 'certificate.verify',
        actorUserId: currentUser.id,
        actorRoleSnap: currentUser.role,
        resourceType: 'certificate',
        resourceId: before.id,
        meta: auditMeta,
        before: this.toVerifyNoteAuditState(before.certStatusCode, before.verifyNote, false),
        after: this.toVerifyNoteAuditState(
          updated.certStatusCode,
          updated.verifyNote,
          before.verifyNote !== updated.verifyNote,
        ),
        extra: { targetMemberId: memberId, verifierMemberId },
        tx,
      });

      return presentCertificate(updated, sensitive);
    });
  }

  // ============ reject ============

  // 状态机:pending → rejected;非 pending 抛 CERTIFICATE_INVALID_STATE_TRANSITION。
  // verifyNote 必填(DTO 严格)。
  async reject(
    memberId: string,
    certificateId: string,
    dto: RejectCertificateDto,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<CertificateResponseDto> {
    const ref: ResourceRef = { type: 'certificate', id: certificateId };
    await this.assertCanOrThrow(currentUser, 'certificate.reject.record', ref);
    const sensitive = await this.canReadSensitive(currentUser, ref);
    return this.prisma.$transaction(async (tx) => {
      await this.findMemberOrThrow(memberId, tx);
      const before = await this.findCertificateInMemberOrThrow(memberId, certificateId, tx);

      if (before.certStatusCode !== CERT_STATUS_PENDING) {
        throw new BizException(BizCode.CERTIFICATE_INVALID_STATE_TRANSITION);
      }

      await claimAtStatus(tx, {
        target: 'certificate',
        id: before.id,
        expectedStatus: before.certStatusCode,
        invalidStatusBiz: BizCode.CERTIFICATE_INVALID_STATE_TRANSITION,
      });
      const verifierMemberId = await this.getVerifierMemberId(currentUser.id, tx);

      const updated = await tx.certificate.update({
        where: { id: before.id },
        data: {
          certStatusCode: CERT_STATUS_REJECTED,
          verifiedBy: verifierMemberId,
          verifiedAt: new Date(),
          verifyNote: dto.verifyNote,
        },
        select: certificateSafeSelect,
      });

      // verify/reject 的 before/after 仅状态相关字段(D6 v1.1 §8.2),非完整快照
      await this.auditLogs.log({
        event: 'certificate.reject',
        actorUserId: currentUser.id,
        actorRoleSnap: currentUser.role,
        resourceType: 'certificate',
        resourceId: before.id,
        meta: auditMeta,
        before: this.toVerifyNoteAuditState(before.certStatusCode, before.verifyNote, false),
        after: this.toVerifyNoteAuditState(
          updated.certStatusCode,
          updated.verifyNote,
          before.verifyNote !== updated.verifyNote,
        ),
        extra: { targetMemberId: memberId, verifierMemberId },
        tx,
      });

      return presentCertificate(updated, sensitive);
    });
  }

  // ============ isQualified (qualification-flag) ============

  // 草案 §9.3 / Q-S9:已核验 + 未过期 + 未软删 = qualified=true;
  // 已失效 / 已拒绝 / 已软删 / 不存在 → qualified=false。
  // 只返布尔 + 摘要(草案 §13.2 强约束)。
  async isQualified(
    memberId: string,
    criterionType: QualificationCriterionType,
    criterionCode: string,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<QualificationFlagResponseDto> {
    await this.assertCanOrThrow(currentUser, 'certificate.read.record', {
      type: 'member',
      id: memberId,
    });
    await this.findMemberOrThrow(memberId);

    // §12 两级判据各自校验 code 存在,不存在直接 400 —— 不静默返 `qualified: false`。
    // 拼错的 code 和「确实没有这张证」是两件完全不同的事,而后者会被调用方
    // (岗位资格、活动门槛)当成「这个人不合格」写进业务结论。
    if (criterionType === 'category') {
      await this.assertDictItemValid(
        DICT_TYPE_CERT_TYPE,
        criterionCode,
        BizCode.CERTIFICATE_TYPE_CODE_INVALID,
      );
    } else {
      // §12:「历史 Certificate 不要求 Standard 当前 ACTIVE」——
      // 所以这里只校验**存在且未软删**,不校验 status。
      // 校验 ACTIVE 会让「标准停用后,存量持证人一夜之间全部不合格」,
      // 而停用标准的本意是「不再新发」,不是「追溯作废」。
      const std = await this.prisma.certificateStandard.findFirst({
        where: notDeletedWhere({ code: criterionCode }),
        select: { id: true },
      });
      if (!std) throw new BizException(BizCode.CERTIFICATE_STANDARD_NOT_FOUND);
    }

    // 冻结稿 §10.5 有效资质 = status=verified AND 未软删 AND
    //   (expiredAt IS NULL OR expiredAt >= today),today = 北京日历日。
    //
    // 必须同时查状态与日期(D-CERT-020):不能只信持久状态 —— cron 每天 09:00 才翻态,
    // 在它跑之前已过期的证书状态仍是 verified。反过来也不能拿时间戳比 `expiredAt`:
    // 它存的是北京日的 UTC 零点,与 now 比会在最后有效日的北京 08:00 后误判为过期。
    // 证书标准库 PR-4b:类别过滤从实例列改为经关联走 `standard.categoryCode`
    // (实例侧 certTypeCode 已 DROP)。**端点契约不变** —— query 参数仍叫 certTypeCode,
    // 值域仍是 cert_type 字典 code;换的只是它落到哪一列上。
    //
    // ⚠️ 这一格与 App 列表过滤同属本刀最险的一类:`notDeletedWhere(...)` 的入参是
    // 宽类型,旧写法 `certTypeCode` 在列删掉之后**依然编译通过**,只会在真实查询时炸。
    // 而这是 §10.5 的资质判定 —— 全系统最关键的一次读。行为锁必须在 e2e。
    const today = beijingDateOnly(new Date());
    const found = await this.prisma.certificate.findFirst({
      where: notDeletedWhere({
        memberId,
        // §12:分类级按 `Standard.categoryCode`,标准级按 `Standard.code`。
        // 两级都经关联走 Standard —— 实例侧没有任何类别副本(PR-4b 已 DROP)。
        standard:
          criterionType === 'category' ? { categoryCode: criterionCode } : { code: criterionCode },
        certStatusCode: CERT_STATUS_VERIFIED,
        OR: [{ expiredAt: null }, { expiredAt: { gte: today } }],
      }),
      // §12 四级稳定排序:
      //   ① 永久有效优先   → `expiredAt` NULLS FIRST
      //   ② expiredAt 较晚 → 同一 clause 的 DESC
      //   ③ issuedAt 较晚
      //   ④ id 字典序      → 兜底,保证**完全**确定(前三级可能全部并列)
      //
      // 第 ④ 级不是凑数:少了它,两张同日发放、同日到期的证书谁被选中取决于
      // PostgreSQL 的物理行序,同一次查询在 VACUUM 前后可能返回不同的
      // `matchedCertificateId` —— 那正是「稳定顺序」这四个字要排除的东西。
      orderBy: [
        { expiredAt: { sort: 'desc', nulls: 'first' } },
        { issuedAt: 'desc' },
        { id: 'asc' },
      ],
      select: { id: true, expiredAt: true },
    });

    await this.auditLogs.log({
      event: 'certificate.read.qualification-flag',
      actorUserId: currentUser.id,
      actorRoleSnap: currentUser.role,
      resourceType: 'member',
      resourceId: memberId,
      meta: auditMeta,
      extra: {
        operation: 'qualification-flag',
        filterFields: ['criterionType', 'criterionCode'],
      },
    });

    return {
      memberId,
      criterionType,
      criterionCode,
      qualified: found !== null,
      matchedCertificateId: found?.id ?? null,
      expiredAt: found?.expiredAt ?? null,
    };
  }
  // ============ 证据读取(§13.5)============

  /**
   * 取某张证书的证据短 TTL signed-URL。
   *
   * 判权是**两道**(维护者 2026-07-30 拍板走方案 A):
   *   ① 本方法入口要 scoped `certificate.read.sensitive` —— 证据图是 L3(§15.1);
   *   ② ADMIN 来源再经 `AttachmentsService.listByOwner`,它自带 `attachment.view` RBAC。
   *
   * 为什么不给 attachments 加一个 certificate 专用 trusted 方法:
   * `listOwnerAttachmentsTrusted` 的注释里明写「仅限 content-* owner;其余 owner 的读
   * **必须**走 attachment.view RBAC」,并且点名了 certificate。在那道护栏上开口
   * 换来的只是省一个权限码,代价是把一条明确的安全边界改成有例外的边界。
   * 所以 ADMIN 来源的读者需要同时持 `certificate.read.sensitive` 与 `attachment.view`。
   *
   * §13.5 的其余约束:TTL ≤300s(Cache-Control: no-store 由 controller 设)、
   * 签 URL 前重查权限与归属、已软删证书不签、provider/ledger 不确定即 fail-closed
   * 不回退裸 key。
   */
  async getEvidenceUrls(
    memberId: string,
    certificateId: string,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<CertificateEvidenceUrlsResponseDto> {
    const ref: ResourceRef = { type: 'certificate', id: certificateId };
    // 入口即敏感码 —— 不是「先给列表再按码降级」,证据没有降级档。
    await this.assertCanOrThrow(currentUser, 'certificate.read.sensitive', ref);
    await this.findMemberOrThrow(memberId);
    // 归属复查:软删的证书在这里就 404(findCertificateInMemberOrThrow 带 notDeleted)。
    const cert = await this.findCertificateInMemberOrThrow(memberId, certificateId);

    // 审计先落账再签 URL(fail-closed;与既有敏感读同款)。
    // extra 只记来源与条数 —— key 与 URL 一律不入(§15.6)。
    const claimKeys = CertificateEvidenceSigner.keysOf(cert.sourceClaim?.imageKeys);
    await this.auditLogs.log({
      event: 'certificate.read.other',
      actorUserId: currentUser.id,
      actorRoleSnap: currentUser.role,
      resourceType: 'certificate',
      resourceId: certificateId,
      meta: auditMeta,
      extra: {
        operation: 'evidence-urls',
        targetMemberId: memberId,
        sourceCode: cert.sourceCode,
      },
    });

    if (cert.sourceCode === CertificateSource.RECRUITMENT) {
      const signed = await this.evidenceSigner.sign(claimKeys);
      return {
        certificateId,
        sourceCode: cert.sourceCode,
        urls: signed.urls,
        expiresAt: signed.expiresAt,
      };
    }

    // ADMIN 来源:整段交给 attachments —— 它负责 attachment.view 判权、可读性过滤与
    // pinned ledger 解析。`accessUrl` 为 null 的项**直接丢掉**而不是回退裸 key:
    // §13.5「provider 或 ledger 状态不确定时 fail-closed 返回不可读」。
    const page = await this.attachments.listByOwner(
      { ownerType: 'certificate', ownerId: certificateId, page: 1, pageSize: 100 },
      currentUser,
    );
    return {
      certificateId,
      sourceCode: cert.sourceCode,
      urls: page.items
        .map((a) => a.accessUrl)
        .filter((u): u is string => typeof u === 'string' && u.length > 0),
      // TTL 由 attachments 侧决定,本端点不假称一个自己没算的过期时刻。
      expiresAt: null,
    };
  }
}
