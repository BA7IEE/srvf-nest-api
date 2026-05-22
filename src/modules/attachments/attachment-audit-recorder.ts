import { Injectable } from '@nestjs/common';
import type { AttachmentAccessLevel, Prisma, Role } from '@prisma/client';

import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';

// Attachment audit assembly 单一职责类(沿 PR #202 14 audit-shape + rollback
// characterization cases 锁定的现状逐字抽出)。
//
// 与 attendances/attendance-audit-recorder.ts (PR #185) +
// activity-registrations/activity-registration-audit-recorder.ts (PR #198) +
// activities/activity-audit-recorder.ts (PR #201) 范式一致:
// - `@Injectable()` 仅注入 `AuditLogsService`;**不**持有 `PrismaService`
// - `tx: PrismaTx` 由调用方($transaction 内)透传给 `auditLogs.log({ ..., tx })`;
//   事务边界仍由 `AttachmentsService` 持有,audit 写失败仍由 Prisma `$transaction`
//   隐式回滚(沿 D-S7 红线 + PR #202 D1/D2/D3 audit-failure-rollback cases)
//
// **职责边界(严守"搬家不优化")**:
// - ✅ snapshot 组装(`toAttachmentAuditSnapshot`,沿 service 原 13 字段输出零变化)
// - ✅ `AuditLogsService.log()` payload assembly(3 处写路径,3 个 method 分组)
// - ❌ 不开事务 / 不读 DB / 不写业务表
// - ❌ 不做 RBAC / dictionary / mime / size / PII 校验
// - ❌ 不接触 Provider(generateUploadUrl / headObject / deleteObject 等)
// - ❌ 不改 audit event 名 / `resourceType` / `actorUserId` / `actorRoleSnap` / `meta` /
//      `before` / `after` / `extra` 字段名 / 字段值;沿 PR #202 audit-characterization
//      锁定的 3 路径形状逐字保留:
//        - `attachment.upload` ×2(create / confirmUpload 共用,extra.uploadVia 区分;
//          沿 batch3 草案 §20.2 A1 + audit-logs.types.ts:29 有意设计)
//        - `attachment.delete` ×1
//
// 注意:service 侧没有 toResponseDto 用 audit snapshot helper 的依赖(toResponseDto 直接
// spread row);因此本 recorder 不需要在 service 内保留 audit snapshot 副本。
// `toAttachmentAuditSnapshot` 完整迁入本 recorder,service 内不再保留。

type PrismaTx = Prisma.TransactionClient;

const ATTACHMENT_RESOURCE_TYPE = 'attachment';
const ATTACHMENT_UPLOAD_EVENT = 'attachment.upload';
const ATTACHMENT_DELETE_EVENT = 'attachment.delete';

// 最小结构性输入类型(沿 PR #198 / #201 范式;TypeScript structural typing 允许调用方
// 传入更大的 payload 类型,如 service 内 `SafeAttachment` 含 id / createdAt / updatedAt
// 等额外字段)。本类型只声明 `toAttachmentAuditSnapshot` 实际读取的 13 字段子集,
// 避免 service ↔ recorder 双向 import 类型。
type AuditAttachmentSnapshotInput = {
  key: string;
  originalName: string;
  mime: string;
  size: number;
  uploadedBy: string;
  uploadedAt: Date;
  ownerType: string;
  ownerId: string;
  description: string | null;
  accessLevel: AttachmentAccessLevel | null;
  tags: string[];
  originalUploaderName: string | null;
  expireAt: Date | null;
};

@Injectable()
export class AttachmentAuditRecorder {
  constructor(private readonly auditLogs: AuditLogsService) {}

  // ============ snapshot helper(private;沿 service `toAttachmentAuditSnapshot` 字面值零变化) ============

  // 沿 service 原 `toAttachmentAuditSnapshot` 13 字段输出零变化(沿 PR #6c Q3 audit
  // snapshot 字段集 = `attachmentSelect` 剔除 `id` / `createdAt` / `updatedAt`;
  // Date 字段经 `toISOString()`;`tags` / `accessLevel` 透传;沿 D6 §R5 Prisma
  // InputJsonValue 拒绝 Date 对象)。
  // 字段全部非敏感(D7 §9.4 / §9.2;身份证号在 PII 检测 Service 层已拒);不打码。
  private toAttachmentAuditSnapshot(row: AuditAttachmentSnapshotInput): Record<string, unknown> {
    return {
      key: row.key,
      originalName: row.originalName,
      mime: row.mime,
      size: row.size,
      uploadedBy: row.uploadedBy,
      uploadedAt: row.uploadedAt.toISOString(),
      ownerType: row.ownerType,
      ownerId: row.ownerId,
      description: row.description,
      accessLevel: row.accessLevel,
      tags: row.tags,
      originalUploaderName: row.originalUploaderName,
      expireAt: row.expireAt ? row.expireAt.toISOString() : null,
    };
  }

  // ============ logUpload(legacy direct create 路径;沿 PR #202 A1 / A2) ============
  // event: 'attachment.upload'
  // before absent;after = toAttachmentAuditSnapshot(created)
  // extra 8 字段:{ operation: 'upload', attachmentType, ownerType, ownerId, mime, size, scope, ownerTable }
  // 注:`attachmentType` 与 `ownerType` 同值(都来自 created.ownerType),沿现状两个字段都保留。
  async logUpload(args: {
    created: AuditAttachmentSnapshotInput & { id: string };
    actorUserId: string;
    actorRoleSnap: Role;
    scope: 'self' | 'other' | null;
    ownerTable: string;
    auditMeta: AuditMeta;
    tx: PrismaTx;
  }): Promise<void> {
    await this.auditLogs.log({
      event: ATTACHMENT_UPLOAD_EVENT,
      actorUserId: args.actorUserId,
      actorRoleSnap: args.actorRoleSnap,
      resourceType: ATTACHMENT_RESOURCE_TYPE,
      resourceId: args.created.id,
      meta: args.auditMeta,
      after: this.toAttachmentAuditSnapshot(args.created),
      extra: {
        operation: 'upload',
        attachmentType: args.created.ownerType,
        ownerType: args.created.ownerType,
        ownerId: args.created.ownerId,
        mime: args.created.mime,
        size: args.created.size,
        scope: args.scope,
        ownerTable: args.ownerTable,
      },
      tx: args.tx,
    });
  }

  // ============ logUploadConfirmed(PR #10 confirm-upload 路径;沿 PR #202 B1) ============
  // event: 'attachment.upload'(**与 logUpload 共用** 同 event;extra.uploadVia='direct' 区分;
  //   沿 batch3 草案 §20.2 A1 + audit-logs.types.ts:29 有意设计)
  // before absent;after = toAttachmentAuditSnapshot(created)
  // extra 10 字段 = logUpload 8 + uploadConfirmedAt + uploadVia:'direct'
  // 注:`uploadConfirmedAt` 在 recorder 内部 `new Date().toISOString()` 即时生成,
  //     与 service 原行为字面值零变化(沿 service line 849 现状);PR #202 B1 用
  //     `expect.any(String)` 锁形不锁值,recorder 抽离后仍 PASS。
  async logUploadConfirmed(args: {
    created: AuditAttachmentSnapshotInput & { id: string };
    actorUserId: string;
    actorRoleSnap: Role;
    scope: 'self' | 'other' | null;
    ownerTable: string;
    auditMeta: AuditMeta;
    tx: PrismaTx;
  }): Promise<void> {
    await this.auditLogs.log({
      event: ATTACHMENT_UPLOAD_EVENT,
      actorUserId: args.actorUserId,
      actorRoleSnap: args.actorRoleSnap,
      resourceType: ATTACHMENT_RESOURCE_TYPE,
      resourceId: args.created.id,
      meta: args.auditMeta,
      after: this.toAttachmentAuditSnapshot(args.created),
      extra: {
        operation: 'upload',
        attachmentType: args.created.ownerType,
        ownerType: args.created.ownerType,
        ownerId: args.created.ownerId,
        mime: args.created.mime,
        size: args.created.size,
        scope: args.scope,
        ownerTable: args.ownerTable,
        uploadConfirmedAt: new Date().toISOString(),
        uploadVia: 'direct',
      },
      tx: args.tx,
    });
  }

  // ============ logDelete(沿 PR #202 C1 / C2) ============
  // event: 'attachment.delete'
  // before = toAttachmentAuditSnapshot(row);after absent(物理删后无 after)
  // extra 8 字段:{ operation: 'delete', attachmentType, ownerType, ownerId, mime, size, scope, deletedByPath }
  // 注:`deletedByPath ∈ {'owner', 'admin'}` 由 service 计算后传入(`user.id === row.uploadedBy ? 'owner' : 'admin'`);
  //     recorder 不复算业务决策,保持纯 audit assembly 职责。
  async logDelete(args: {
    attachmentId: string;
    before: AuditAttachmentSnapshotInput;
    actorUserId: string;
    actorRoleSnap: Role;
    scope: 'self' | 'other' | null;
    deletedByPath: 'owner' | 'admin';
    auditMeta: AuditMeta;
    tx: PrismaTx;
  }): Promise<void> {
    await this.auditLogs.log({
      event: ATTACHMENT_DELETE_EVENT,
      actorUserId: args.actorUserId,
      actorRoleSnap: args.actorRoleSnap,
      resourceType: ATTACHMENT_RESOURCE_TYPE,
      resourceId: args.attachmentId,
      meta: args.auditMeta,
      before: this.toAttachmentAuditSnapshot(args.before),
      extra: {
        operation: 'delete',
        attachmentType: args.before.ownerType,
        ownerType: args.before.ownerType,
        ownerId: args.before.ownerId,
        mime: args.before.mime,
        size: args.before.size,
        scope: args.scope,
        deletedByPath: args.deletedByPath,
      },
      tx: args.tx,
    });
  }
}
