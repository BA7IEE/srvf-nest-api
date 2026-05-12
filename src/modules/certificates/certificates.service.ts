import { Injectable } from '@nestjs/common';
import { DictItemStatus, DictTypeStatus, Prisma } from '@prisma/client';
import { auditPlaceholder } from '../../common/audit/audit-placeholder';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode, type BizCodeEntry } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { notDeletedWhere } from '../../common/prisma/soft-delete.util';
import { PrismaService } from '../../database/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
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
// - 列表精简:不返 certNumber / verifyNote / verifiedBy / verifiedAt / attachmentKey /
//   supersededByCertId(草案 §13.1)
// - 软删走 deletedAt(草案 §9.2);列表自动过滤已软删
// - 字典校验:cert_type 必填,cert_sub_type 提供时校验;cert_status 由 service 内部写常量,不接外部
// - 状态机 4 态闭集:create→pending、verify(pending→verified)、reject(pending→rejected);
//   非闭集状态转移抛 CERTIFICATE_INVALID_STATE_TRANSITION
// - 跨 member 校验:cert.memberId !== :memberId 抛 CERTIFICATE_NOT_BELONGS_TO_MEMBER
// - audit:list / findOne / isQualified / create / update / softDelete / verify / reject 全部 hook
// - verifiedBy:取 currentUser.user.memberId(可空,Q-I2);user 无 memberId 时 verifiedBy=null
// - isInternal:DTO 不接收;service 始终写 false(本批次零本会证书 API 路径,Q-A3)
// - supersededByCertId / expireNotifyDueAt:本批次 zero API 写入

const DICT_TYPE_CERT_TYPE = 'cert_type';
const DICT_TYPE_CERT_SUB_TYPE = 'cert_sub_type';

const CERT_STATUS_PENDING = 'pending';
const CERT_STATUS_VERIFIED = 'verified';
const CERT_STATUS_REJECTED = 'rejected';
// CERT_STATUS_EXPIRED 由后台任务推动,本批次 service 不主动写入

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
  attachmentKey: true,
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
  ) {}

  // ============ helpers ============

  private async findMemberOrThrow(memberId: string, tx?: PrismaTx): Promise<{ id: string }> {
    const client = tx ?? this.prisma;
    const m = await client.member.findFirst({
      where: notDeletedWhere({ id: memberId }),
      select: { id: true },
    });
    if (!m) throw new BizException(BizCode.MEMBER_NOT_FOUND);
    return m;
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
  // certificates 字段全部非敏感(Q4 矩阵未勾选),不打码;但 Date 字段必须 toISOString 避免
  // Prisma InputJsonValue 拒绝 Date 对象(D6 v1.1 §R5)。
  // 不含 id / memberId / createdAt / updatedAt(audit_logs 自带 resourceId / createdAt / actorUser)。
  private toCertSnapshot(c: SafeCertificate): Record<string, unknown> {
    return {
      certTypeCode: c.certTypeCode,
      certSubTypeCode: c.certSubTypeCode,
      issuingOrg: c.issuingOrg,
      certNumber: c.certNumber,
      issuedAt: c.issuedAt.toISOString(),
      expiredAt: c.expiredAt ? c.expiredAt.toISOString() : null,
      certStatusCode: c.certStatusCode,
      verifiedBy: c.verifiedBy,
      verifiedAt: c.verifiedAt ? c.verifiedAt.toISOString() : null,
      verifyNote: c.verifyNote,
      attachmentKey: c.attachmentKey,
      isInternal: c.isInternal,
      supersededByCertId: c.supersededByCertId,
    };
  }

  // 把 ISO 8601 字符串规范化为 UTC 00:00:00.000(纯日期语义,B 路径)。
  // 草案 §6 决议:不落 @db.Date,业务层统一规范化处理。
  private normalizeDateOnly(input: string): Date {
    const d = new Date(input);
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
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

  async list(memberId: string, currentUser: CurrentUserPayload): Promise<CertificateListItemDto[]> {
    await this.findMemberOrThrow(memberId);

    const items = await this.prisma.certificate.findMany({
      where: notDeletedWhere({ memberId }),
      select: certificateListItemSelect,
      orderBy: [{ certStatusCode: 'asc' }, { createdAt: 'desc' }],
    });

    auditPlaceholder('certificate.read.other', {
      operatorUserId: currentUser.id,
      targetMemberId: memberId,
      certificateIds: items.map((i) => i.id),
      operation: 'list',
    });

    return items;
  }

  // ============ findOne ============

  async findOne(
    memberId: string,
    certificateId: string,
    currentUser: CurrentUserPayload,
  ): Promise<CertificateResponseDto> {
    await this.findMemberOrThrow(memberId);

    const cert = await this.prisma.certificate.findFirst({
      where: notDeletedWhere({ id: certificateId }),
      select: certificateSafeSelect,
    });
    if (!cert) throw new BizException(BizCode.CERTIFICATE_NOT_FOUND);
    if (cert.memberId !== memberId) {
      throw new BizException(BizCode.CERTIFICATE_NOT_BELONGS_TO_MEMBER);
    }

    auditPlaceholder('certificate.read.other', {
      operatorUserId: currentUser.id,
      targetMemberId: memberId,
      certificateId,
      operation: 'detail',
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

      const data: Prisma.CertificateUncheckedCreateInput = {
        memberId,
        certTypeCode: dto.certTypeCode,
        issuingOrg: dto.issuingOrg,
        issuedAt: this.normalizeDateOnly(dto.issuedAt),
        certStatusCode: CERT_STATUS_PENDING,
        isInternal: false, // Q-A3:本批次 API 永远 false
      };
      if (dto.certSubTypeCode !== undefined) data.certSubTypeCode = dto.certSubTypeCode;
      if (dto.certNumber !== undefined) data.certNumber = dto.certNumber;
      if (dto.expiredAt !== undefined) data.expiredAt = this.normalizeDateOnly(dto.expiredAt);

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
  // supersededByCertId / attachmentKey / expireNotifyDueAt(由 forbidNonWhitelisted 兜底)。
  // hook B5 不含 verify / reject / softDelete / expire(各有独立 hook)。
  async update(
    memberId: string,
    certificateId: string,
    dto: UpdateCertificateDto,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<CertificateResponseDto> {
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

      const data: Prisma.CertificateUpdateInput = {};
      if (dto.certTypeCode !== undefined) data.certTypeCode = dto.certTypeCode;
      if (dto.certSubTypeCode !== undefined) data.certSubTypeCode = dto.certSubTypeCode;
      if (dto.issuingOrg !== undefined) data.issuingOrg = dto.issuingOrg;
      if (dto.certNumber !== undefined) data.certNumber = dto.certNumber;
      if (dto.issuedAt !== undefined) data.issuedAt = this.normalizeDateOnly(dto.issuedAt);
      if (dto.expiredAt !== undefined) data.expiredAt = this.normalizeDateOnly(dto.expiredAt);

      const updated = await tx.certificate.update({
        where: { id: before.id },
        data,
        select: certificateSafeSelect,
      });

      await this.auditLogs.log({
        event: 'certificate.update',
        actorUserId: currentUser.id,
        actorRoleSnap: currentUser.role,
        resourceType: 'certificate',
        resourceId: before.id,
        meta: auditMeta,
        before: this.toCertSnapshot(before),
        after: this.toCertSnapshot(updated),
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
    return this.prisma.$transaction(async (tx) => {
      await this.findMemberOrThrow(memberId, tx);
      const before = await this.findCertificateInMemberOrThrow(memberId, certificateId, tx);

      if (before.certStatusCode !== CERT_STATUS_PENDING) {
        throw new BizException(BizCode.CERTIFICATE_INVALID_STATE_TRANSITION);
      }

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
        before: { status: before.certStatusCode },
        after: { status: updated.certStatusCode, verifyNote: updated.verifyNote },
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
    return this.prisma.$transaction(async (tx) => {
      await this.findMemberOrThrow(memberId, tx);
      const before = await this.findCertificateInMemberOrThrow(memberId, certificateId, tx);

      if (before.certStatusCode !== CERT_STATUS_PENDING) {
        throw new BizException(BizCode.CERTIFICATE_INVALID_STATE_TRANSITION);
      }

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
        before: { status: before.certStatusCode },
        after: { status: updated.certStatusCode, verifyNote: updated.verifyNote },
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
  ): Promise<QualificationFlagResponseDto> {
    await this.findMemberOrThrow(memberId);
    await this.assertDictItemValid(
      DICT_TYPE_CERT_TYPE,
      certTypeCode,
      BizCode.CERTIFICATE_TYPE_CODE_INVALID,
    );

    const now = new Date();
    const found = await this.prisma.certificate.findFirst({
      where: notDeletedWhere({
        memberId,
        certTypeCode,
        certStatusCode: CERT_STATUS_VERIFIED,
        OR: [{ expiredAt: null }, { expiredAt: { gt: now } }],
      }),
      select: { id: true },
    });

    const qualified = found !== null;

    auditPlaceholder('certificate.read.qualification-flag', {
      operatorUserId: currentUser.id,
      targetMemberId: memberId,
      certTypeCode,
      qualified,
    });

    return {
      memberId,
      certTypeCode,
      qualified,
    };
  }
}
