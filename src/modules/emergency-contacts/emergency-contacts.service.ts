import { Injectable } from '@nestjs/common';
import { DictItemStatus, DictTypeStatus, Prisma } from '@prisma/client';
import { auditPlaceholder } from '../../common/audit/audit-placeholder';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { notDeletedWhere } from '../../common/prisma/soft-delete.util';
import { PrismaService } from '../../database/prisma.service';
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
// - audit:list / create / update / softDelete 均调 hook(A5 / A6)

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

type PrismaTx = Prisma.TransactionClient;

@Injectable()
export class EmergencyContactsService {
  constructor(private readonly prisma: PrismaService) {}

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
  private async findContactInMemberOrThrow(
    memberId: string,
    contactId: string,
    tx?: PrismaTx,
  ): Promise<{ id: string; memberId: string }> {
    const client = tx ?? this.prisma;
    const contact = await client.emergencyContact.findFirst({
      where: notDeletedWhere({ id: contactId }),
      select: { id: true, memberId: true },
    });
    if (!contact) throw new BizException(BizCode.EMERGENCY_CONTACT_NOT_FOUND);
    if (contact.memberId !== memberId) {
      throw new BizException(BizCode.EMERGENCY_CONTACT_NOT_BELONGS_TO_MEMBER);
    }
    return contact;
  }

  // ============ list ============

  // 决策:返完整数组(无分页;演示规模 ≤ 5 / 人)。排序 priority ASC, createdAt ASC。
  // hook A5 emergency-contact.read.other:本批次仅 ADMIN/SUPER_ADMIN 路由,记一次"看他人"。
  async list(
    memberId: string,
    currentUser: CurrentUserPayload,
  ): Promise<EmergencyContactResponseDto[]> {
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
  ): Promise<EmergencyContactResponseDto> {
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

      auditPlaceholder('emergency-contact.write', {
        operatorUserId: currentUser.id,
        targetMemberId: memberId,
        operation: 'create',
        contactId: created.id,
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
  ): Promise<EmergencyContactResponseDto> {
    return this.prisma.$transaction(async (tx) => {
      await this.findMemberOrThrow(memberId, tx);
      const contact = await this.findContactInMemberOrThrow(memberId, contactId, tx);

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
        where: { id: contact.id },
        data,
        select: emergencyContactSafeSelect,
      });

      auditPlaceholder('emergency-contact.write', {
        operatorUserId: currentUser.id,
        targetMemberId: memberId,
        operation: 'update',
        contactId: contact.id,
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
  ): Promise<EmergencyContactResponseDto> {
    return this.prisma.$transaction(async (tx) => {
      await this.findMemberOrThrow(memberId, tx);
      const contact = await this.findContactInMemberOrThrow(memberId, contactId, tx);

      const removed = await tx.emergencyContact.update({
        where: { id: contact.id },
        data: { deletedAt: new Date() },
        select: emergencyContactSafeSelect,
      });

      auditPlaceholder('emergency-contact.write', {
        operatorUserId: currentUser.id,
        targetMemberId: memberId,
        operation: 'softDelete',
        contactId: contact.id,
      });

      return removed;
    });
  }
}
