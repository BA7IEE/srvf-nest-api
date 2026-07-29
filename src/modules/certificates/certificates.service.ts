import { Injectable } from '@nestjs/common';
import { DictItemStatus, DictTypeStatus, Prisma } from '@prisma/client';
import { maskIdentifier } from '../../common/audit/mask-pii.util';
import { beijingDateOnly, normalizeDateOnly } from '../../common/datetime/date-only.util';
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
import {
  CertificateListItemDto,
  CertificateResponseDto,
  CreateCertificateDto,
  QualificationFlagResponseDto,
  RejectCertificateDto,
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
const DICT_TYPE_CERT_SUB_TYPE = 'cert_sub_type';

const CERT_STATUS_PENDING = 'pending';
const CERT_STATUS_VERIFIED = 'verified';
const CERT_STATUS_REJECTED = 'rejected';
// CERT_STATUS_EXPIRED 由 v0.47.0 ExpiryReminderService 到期扫描推动,本 service 不主动写入

const CERTIFICATE_CORE_FIELDS = [
  'certTypeCode',
  'certSubTypeCode',
  'issuingOrg',
  'certNumber',
  'issuedAt',
  'expiredAt',
] as const satisfies readonly (keyof UpdateCertificateDto)[];

// 详情 / 写操作返回的完整 select(永不含 deletedAt 软删内部状态、永不含 expireNotifyDueAt
// hook 字段);必须与 CertificateResponseDto 同步维护。
const certificateSafeSelect = {
  id: true,
  memberId: true,
  certTypeCode: true,
  certSubTypeCode: true,
  issuingOrg: true,
  certNumber: true,
  issuedAt: true,
  expiredAt: true,
  certStatusCode: true,
  verifiedBy: true,
  verifiedAt: true,
  verifyNote: true,
  isInternal: true,
  supersededByCertId: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.CertificateSelect;

// 列表 select:精简(草案 §13.1)。
// 必须与 CertificateListItemDto 同步维护。
const certificateListItemSelect = {
  id: true,
  memberId: true,
  certTypeCode: true,
  certSubTypeCode: true,
  issuingOrg: true,
  issuedAt: true,
  expiredAt: true,
  certStatusCode: true,
  isInternal: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.CertificateSelect;

type SafeCertificate = Prisma.CertificateGetPayload<{ select: typeof certificateSafeSelect }>;

type PrismaTx = Prisma.TransactionClient;

@Injectable()
export class CertificatesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogs: AuditLogsService,
    private readonly rbac: RbacService,
    private readonly authz: AuthzService,
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
  // 两侧都按北京日历日比较:入参已经过 normalizeDateOnly,是「北京日的 UTC 零点」,
  // 所以基准也必须是 date-only 的 today,不能拿当下瞬间去比(§10.1 expiredAt =
  // 最后有效日;用时间戳比会让最后有效日当天在北京 08:00 后被算成过期)。
  // `expiredAt === issuedAt` 合法:当天发证当天到期,仍是有效一天。
  private assertDateSemantics(issuedAt: Date, expiredAt: Date | null): void {
    const today = beijingDateOnly(new Date());
    if (issuedAt.getTime() > today.getTime()) {
      throw new BizException(BizCode.CERTIFICATE_ISSUED_AT_IN_FUTURE);
    }
    if (expiredAt !== null && expiredAt.getTime() < issuedAt.getTime()) {
      throw new BizException(BizCode.CERTIFICATE_DATE_RANGE_INVALID);
    }
  }

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
      certTypeCode: c.certTypeCode,
      certSubTypeCode: c.certSubTypeCode,
      issuingOrg: c.issuingOrg,
      certNumber: maskIdentifier(c.certNumber),
      issuedAt: c.issuedAt.toISOString(),
      expiredAt: c.expiredAt ? c.expiredAt.toISOString() : null,
      certStatusCode: c.certStatusCode,
      verifiedBy: c.verifiedBy,
      verifiedAt: c.verifiedAt ? c.verifiedAt.toISOString() : null,
      verifyNoteProvided: this.isVerifyNoteProvided(c.verifyNote),
      verifyNoteChanged,
      isInternal: c.isInternal,
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
    await this.assertCanOrThrow(currentUser, 'certificate.read.record', {
      type: 'certificate',
      id: certificateId,
    });
    await this.findMemberOrThrow(memberId);

    const cert = await this.prisma.certificate.findFirst({
      where: notDeletedWhere({ id: certificateId }),
      select: certificateSafeSelect,
    });
    if (!cert) throw new BizException(BizCode.CERTIFICATE_NOT_FOUND);
    if (cert.memberId !== memberId) {
      throw new BizException(BizCode.CERTIFICATE_NOT_BELONGS_TO_MEMBER);
    }

    await this.auditLogs.log({
      event: 'certificate.read.other',
      actorUserId: currentUser.id,
      actorRoleSnap: currentUser.role,
      resourceType: 'certificate',
      resourceId: cert.id,
      meta: auditMeta,
      extra: { operation: 'detail' },
    });

    return cert;
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
    await this.assertCanOrThrow(currentUser, 'certificate.create.record', {
      type: 'member',
      id: memberId,
    });
    return this.prisma.$transaction(async (tx) => {
      await this.findMemberOrThrow(memberId, tx);

      await this.assertDictItemValid(
        DICT_TYPE_CERT_TYPE,
        dto.certTypeCode,
        BizCode.CERTIFICATE_TYPE_CODE_INVALID,
        tx,
      );
      if (dto.certSubTypeCode !== undefined) {
        await this.assertDictItemValid(
          DICT_TYPE_CERT_SUB_TYPE,
          dto.certSubTypeCode,
          BizCode.CERTIFICATE_SUB_TYPE_CODE_INVALID,
          tx,
        );
      }

      const issuedAt = normalizeDateOnly(dto.issuedAt);
      const expiredAt = dto.expiredAt !== undefined ? normalizeDateOnly(dto.expiredAt) : null;
      this.assertDateSemantics(issuedAt, expiredAt);

      const data: Prisma.CertificateUncheckedCreateInput = {
        memberId,
        certTypeCode: dto.certTypeCode,
        issuingOrg: dto.issuingOrg,
        issuedAt,
        certStatusCode: CERT_STATUS_PENDING,
        isInternal: false, // Q-A3:本批次 API 永远 false
      };
      if (dto.certSubTypeCode !== undefined) data.certSubTypeCode = dto.certSubTypeCode;
      if (dto.certNumber !== undefined) data.certNumber = dto.certNumber;
      if (expiredAt !== null) data.expiredAt = expiredAt;

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

      return created;
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
    await this.assertCanOrThrow(currentUser, 'certificate.update.record', {
      type: 'certificate',
      id: certificateId,
    });
    return this.prisma.$transaction(async (tx) => {
      await this.findMemberOrThrow(memberId, tx);
      const before = await this.findCertificateInMemberOrThrow(memberId, certificateId, tx);

      if (dto.certTypeCode !== undefined) {
        await this.assertDictItemValid(
          DICT_TYPE_CERT_TYPE,
          dto.certTypeCode,
          BizCode.CERTIFICATE_TYPE_CODE_INVALID,
          tx,
        );
      }
      if (dto.certSubTypeCode !== undefined) {
        await this.assertDictItemValid(
          DICT_TYPE_CERT_SUB_TYPE,
          dto.certSubTypeCode,
          BizCode.CERTIFICATE_SUB_TYPE_CODE_INVALID,
          tx,
        );
      }

      const data: Prisma.CertificateUncheckedUpdateInput = {};
      if (dto.certTypeCode !== undefined) data.certTypeCode = dto.certTypeCode;
      if (dto.certSubTypeCode !== undefined) data.certSubTypeCode = dto.certSubTypeCode;
      if (dto.issuingOrg !== undefined) data.issuingOrg = dto.issuingOrg;
      if (dto.certNumber !== undefined) data.certNumber = dto.certNumber;
      if (dto.issuedAt !== undefined) data.issuedAt = normalizeDateOnly(dto.issuedAt);
      if (dto.expiredAt !== undefined) data.expiredAt = normalizeDateOnly(dto.expiredAt);

      await claimAtStatus(tx, {
        target: 'certificate',
        id: before.id,
        expectedStatus: before.certStatusCode,
        invalidStatusBiz: BizCode.CERTIFICATE_INVALID_STATE_TRANSITION,
      });
      const lockedBefore = await this.findCertificateInMemberOrThrow(memberId, certificateId, tx);

      // §10.3 校验用「本次写入后的最终值」,而不是只看本次传了什么:
      // 只改 expiredAt 时也必须和库内 issuedAt 比,否则能写出 expiredAt < issuedAt。
      // 取 lockedBefore(行锁之后)而非 before,避免并发改动下用过期基准放行。
      const effectiveIssuedAt =
        dto.issuedAt !== undefined ? normalizeDateOnly(dto.issuedAt) : lockedBefore.issuedAt;
      const effectiveExpiredAt =
        dto.expiredAt !== undefined ? normalizeDateOnly(dto.expiredAt) : lockedBefore.expiredAt;
      this.assertDateSemantics(effectiveIssuedAt, effectiveExpiredAt);

      // §9.2:`expiredAt` 最终值变化时清空 `expireNotifyDueAt`,让到期提醒按新日期
      // 重新计算(该标记是 at-most-once 的已提醒水印,不清会永久错过新窗口)。
      // 只在真的变化时清 —— 传了同值不算变化,不无谓抹掉已发提醒的事实。
      if ((effectiveExpiredAt?.getTime() ?? null) !== (lockedBefore.expiredAt?.getTime() ?? null)) {
        data.expireNotifyDueAt = null;
      }

      const coreFieldEdited = CERTIFICATE_CORE_FIELDS.some((field) => dto[field] !== undefined);
      if (coreFieldEdited && lockedBefore.certStatusCode !== CERT_STATUS_PENDING) {
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

      return updated;
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
    await this.assertCanOrThrow(currentUser, 'certificate.delete.record', {
      type: 'certificate',
      id: certificateId,
    });
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

      return removed;
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
    await this.assertCanOrThrow(currentUser, 'certificate.verify.record', {
      type: 'certificate',
      id: certificateId,
    });
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
          certStatusCode: CERT_STATUS_VERIFIED,
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

      return updated;
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
    await this.assertCanOrThrow(currentUser, 'certificate.reject.record', {
      type: 'certificate',
      id: certificateId,
    });
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

      return updated;
    });
  }

  // ============ isQualified (qualification-flag) ============

  // 草案 §9.3 / Q-S9:已核验 + 未过期 + 未软删 = qualified=true;
  // 已失效 / 已拒绝 / 已软删 / 不存在 → qualified=false。
  // 只返布尔 + 摘要(草案 §13.2 强约束)。
  async isQualified(
    memberId: string,
    certTypeCode: string,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<QualificationFlagResponseDto> {
    await this.assertCanOrThrow(currentUser, 'certificate.read.record', {
      type: 'member',
      id: memberId,
    });
    await this.findMemberOrThrow(memberId);
    await this.assertDictItemValid(
      DICT_TYPE_CERT_TYPE,
      certTypeCode,
      BizCode.CERTIFICATE_TYPE_CODE_INVALID,
    );

    // 冻结稿 §10.5 有效资质 = status=verified AND 未软删 AND
    //   (expiredAt IS NULL OR expiredAt >= today),today = 北京日历日。
    //
    // 必须同时查状态与日期(D-CERT-020):不能只信持久状态 —— cron 每天 09:00 才翻态,
    // 在它跑之前已过期的证书状态仍是 verified。反过来也不能拿时间戳比 `expiredAt`:
    // 它存的是北京日的 UTC 零点,与 now 比会在最后有效日的北京 08:00 后误判为过期。
    const today = beijingDateOnly(new Date());
    const found = await this.prisma.certificate.findFirst({
      where: notDeletedWhere({
        memberId,
        certTypeCode,
        certStatusCode: CERT_STATUS_VERIFIED,
        OR: [{ expiredAt: null }, { expiredAt: { gte: today } }],
      }),
      select: { id: true },
    });

    const qualified = found !== null;

    await this.auditLogs.log({
      event: 'certificate.read.qualification-flag',
      actorUserId: currentUser.id,
      actorRoleSnap: currentUser.role,
      resourceType: 'member',
      resourceId: memberId,
      meta: auditMeta,
      extra: { operation: 'qualification-flag', filterFields: ['certTypeCode'] },
    });

    return {
      memberId,
      certTypeCode,
      qualified,
    };
  }
}
