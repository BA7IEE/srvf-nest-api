import { Injectable } from '@nestjs/common';
import { DictItemStatus, DictTypeStatus, Prisma } from '@prisma/client';
import { auditPlaceholder } from '../../common/audit/audit-placeholder';
import { maskAddress, maskName, maskPhone } from '../../common/audit/mask-pii.util';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { notDeletedWhere } from '../../common/prisma/soft-delete.util';
import { PrismaService } from '../../database/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { RbacService } from '../permissions/rbac.service';
import {
  CreateEmergencyContactDto,
  EmergencyContactResponseDto,
  UpdateEmergencyContactDto,
} from './emergency-contacts.dto';

// V2 第一阶段批次 1 emergency_contacts service。
// 详见 docs:批次1_API前评审... §3.3 / §6 / §9 + 草案 §5 / §10。
//
// 关键约定:
// - N:1 with Member,无分页(演示规模 ≤ 5 / 人,Plan §10)
// - 列表排序:priority ASC, createdAt ASC(Q-S09 决议)
// - 软删走 deletedAt(Q-S10);列表自动过滤已软删
// - relationCode 字典校验(emergency_relation type)
// - 跨 member 校验:contact 属于其他 member 时抛 EMERGENCY_CONTACT_NOT_BELONGS_TO_MEMBER
// - audit:
//   - list  → auditPlaceholder('emergency-contact.read.other', ...)  pino-only(批次 6 PR #2 未迁移,沿 F2)
//   - create / update / softDelete → AuditLogsService.log({ event: 'emergency-contact.write', ... })
//     批次 6 PR #2 迁移(D-A 修订 / D6 v1.1 §8.2),敏感字段经 maskName / maskPhone / maskAddress 打码

const EMERGENCY_RELATION_DICT_CODE = 'emergency_relation';

const emergencyContactSafeSelect = {
  id: true,
  memberId: true,
  contactName: true,
  relationCode: true,
  phonePrimary: true,
  phoneBackup: true,
  address: true,
  priority: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.EmergencyContactSelect;

type SafeEmergencyContact = Prisma.EmergencyContactGetPayload<{
  select: typeof emergencyContactSafeSelect;
}>;

type PrismaTx = Prisma.TransactionClient;

@Injectable()
export class EmergencyContactsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogs: AuditLogsService,
    private readonly rbac: RbacService,
  ) {}

  // ============ helpers ============

  // Slow-4 T2(2026-06-11,评审稿 §3.3 / D-S4-8):RBAC 判权(沿 P0-F assertCanOrThrow 范式)。
  // 每个 public 方法第一条语句调用——先判权后查资源,保持与原 Guard 前置语义一致。
  private async assertCanOrThrow(user: CurrentUserPayload, action: string): Promise<void> {
    if (!(await this.rbac.can(user, action))) {
      throw new BizException(BizCode.RBAC_FORBIDDEN);
    }
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

  // 校验 emergency_relation 字典 code(同 members.assertGradeCodeValid 模式)。
  private async assertRelationCodeValid(relationCode: string, tx?: PrismaTx): Promise<void> {
    const client = tx ?? this.prisma;
    const item = await client.dictItem.findFirst({
      where: {
        code: relationCode,
        status: DictItemStatus.ACTIVE,
        deletedAt: null,
        type: {
          code: EMERGENCY_RELATION_DICT_CODE,
          status: DictTypeStatus.ACTIVE,
          deletedAt: null,
        },
      },
      select: { id: true },
    });
    if (!item) throw new BizException(BizCode.EMERGENCY_CONTACT_RELATION_CODE_INVALID);
  }

  // 找 contact + 校验归属(memberId 匹配 + notDeleted)。
  // 找不到 → EMERGENCY_CONTACT_NOT_FOUND;找到但 memberId 不匹配 → EMERGENCY_CONTACT_NOT_BELONGS_TO_MEMBER。
  //
  // V2 批次 6 PR #2 修订:select 由 { id, memberId } 扩展为 emergencyContactSafeSelect(全字段),
  // 让 update / softDelete 不再额外查一次拿 before 数据(D6 v1.1 §8.2)。
  // 调用方仅取 cert.id / cert.memberId 的语义兼容(返回类型是超集)。
  private async findContactInMemberOrThrow(
    memberId: string,
    contactId: string,
    tx?: PrismaTx,
  ): Promise<SafeEmergencyContact> {
    const client = tx ?? this.prisma;
    const contact = await client.emergencyContact.findFirst({
      where: notDeletedWhere({ id: contactId }),
      select: emergencyContactSafeSelect,
    });
    if (!contact) throw new BizException(BizCode.EMERGENCY_CONTACT_NOT_FOUND);
    if (contact.memberId !== memberId) {
      throw new BizException(BizCode.EMERGENCY_CONTACT_NOT_BELONGS_TO_MEMBER);
    }
    return contact;
  }

  // 把完整 EmergencyContact 转成"打码后可入 audit context"的 snapshot(D6 v1.1 §7.3)。
  // 敏感字段:contactName / phonePrimary / phoneBackup / address;非敏感:relationCode / priority。
  // 不含 id / memberId / createdAt / updatedAt(audit_logs 自带 resourceId / createdAt / actorUser)。
  private toMaskedContactSnapshot(c: SafeEmergencyContact): Record<string, unknown> {
    return {
      contactName: maskName(c.contactName),
      relationCode: c.relationCode,
      phonePrimary: maskPhone(c.phonePrimary),
      phoneBackup: maskPhone(c.phoneBackup),
      address: maskAddress(c.address),
      priority: c.priority,
    };
  }

  // ============ list ============

  // 决策:返完整数组(无分页;演示规模 ≤ 5 / 人)。排序 priority ASC, createdAt ASC。
  // hook A5 emergency-contact.read.other:本批次仅 ADMIN/SUPER_ADMIN 路由,记一次"看他人"。
  // 注:本调用是 pino-only 占位(批次 6 PR #2 未迁移,沿 F2)。
  async list(
    memberId: string,
    currentUser: CurrentUserPayload,
  ): Promise<EmergencyContactResponseDto[]> {
    await this.assertCanOrThrow(currentUser, 'emergency-contact.read.record');
    await this.findMemberOrThrow(memberId);

    const items = await this.prisma.emergencyContact.findMany({
      where: notDeletedWhere({ memberId }),
      select: emergencyContactSafeSelect,
      orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
    });

    auditPlaceholder('emergency-contact.read.other', {
      operatorUserId: currentUser.id,
      targetMemberId: memberId,
      contactIds: items.map((i) => i.id),
    });

    return items;
  }

  // ============ create ============

  async create(
    memberId: string,
    dto: CreateEmergencyContactDto,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<EmergencyContactResponseDto> {
    await this.assertCanOrThrow(currentUser, 'emergency-contact.create.record');
    return this.prisma.$transaction(async (tx) => {
      await this.findMemberOrThrow(memberId, tx);
      await this.assertRelationCodeValid(dto.relationCode, tx);

      const created = await tx.emergencyContact.create({
        data: {
          memberId,
          contactName: dto.contactName,
          relationCode: dto.relationCode,
          phonePrimary: dto.phonePrimary,
          phoneBackup: dto.phoneBackup,
          address: dto.address,
          // priority schema 默认 0(@default(0));undefined 时直接交给 default
          ...(dto.priority !== undefined && { priority: dto.priority }),
        },
        select: emergencyContactSafeSelect,
      });

      await this.auditLogs.log({
        event: 'emergency-contact.write',
        actorUserId: currentUser.id,
        actorRoleSnap: currentUser.role,
        resourceType: 'emergency_contact',
        resourceId: created.id,
        meta: auditMeta,
        after: this.toMaskedContactSnapshot(created),
        extra: { targetMemberId: memberId, operation: 'create' },
        tx,
      });

      return created;
    });
  }

  // ============ update ============

  async update(
    memberId: string,
    contactId: string,
    dto: UpdateEmergencyContactDto,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<EmergencyContactResponseDto> {
    await this.assertCanOrThrow(currentUser, 'emergency-contact.update.record');
    return this.prisma.$transaction(async (tx) => {
      await this.findMemberOrThrow(memberId, tx);
      const before = await this.findContactInMemberOrThrow(memberId, contactId, tx);

      if (dto.relationCode !== undefined) {
        await this.assertRelationCodeValid(dto.relationCode, tx);
      }

      const data: Prisma.EmergencyContactUpdateInput = {};
      if (dto.contactName !== undefined) data.contactName = dto.contactName;
      if (dto.relationCode !== undefined) data.relationCode = dto.relationCode;
      if (dto.phonePrimary !== undefined) data.phonePrimary = dto.phonePrimary;
      if (dto.phoneBackup !== undefined) data.phoneBackup = dto.phoneBackup;
      if (dto.address !== undefined) data.address = dto.address;
      if (dto.priority !== undefined) data.priority = dto.priority;

      const updated = await tx.emergencyContact.update({
        where: { id: before.id },
        data,
        select: emergencyContactSafeSelect,
      });

      await this.auditLogs.log({
        event: 'emergency-contact.write',
        actorUserId: currentUser.id,
        actorRoleSnap: currentUser.role,
        resourceType: 'emergency_contact',
        resourceId: before.id,
        meta: auditMeta,
        before: this.toMaskedContactSnapshot(before),
        after: this.toMaskedContactSnapshot(updated),
        extra: { targetMemberId: memberId, operation: 'update' },
        tx,
      });

      return updated;
    });
  }

  // ============ softDelete ============

  // 软删 = update({ deletedAt: now });不物理删除(baseline §10)。
  // 已软删的再删 → EMERGENCY_CONTACT_NOT_FOUND(notDeleted 过滤已挡)。
  async softDelete(
    memberId: string,
    contactId: string,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<EmergencyContactResponseDto> {
    await this.assertCanOrThrow(currentUser, 'emergency-contact.delete.record');
    return this.prisma.$transaction(async (tx) => {
      await this.findMemberOrThrow(memberId, tx);
      const before = await this.findContactInMemberOrThrow(memberId, contactId, tx);

      const removed = await tx.emergencyContact.update({
        where: { id: before.id },
        data: { deletedAt: new Date() },
        select: emergencyContactSafeSelect,
      });

      await this.auditLogs.log({
        event: 'emergency-contact.write',
        actorUserId: currentUser.id,
        actorRoleSnap: currentUser.role,
        resourceType: 'emergency_contact',
        resourceId: before.id,
        meta: auditMeta,
        before: this.toMaskedContactSnapshot(before),
        extra: { targetMemberId: memberId, operation: 'softDelete' },
        tx,
      });

      return removed;
    });
  }
}
