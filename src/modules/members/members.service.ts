import { Injectable } from '@nestjs/common';
import { DictItemStatus, DictTypeStatus, MemberStatus, Prisma } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { PageResultDto } from '../../common/dto/pagination.dto';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { notDeletedWhere } from '../../common/prisma/soft-delete.util';
import { PrismaService } from '../../database/prisma.service';
import { RbacService } from '../permissions/rbac.service';
import {
  CreateMemberDto,
  ListMembersQueryDto,
  MemberResponseDto,
  UpdateMemberDto,
  UpdateMemberStatusDto,
} from './members.dto';

// 队员等级 dict_type code(seed 内置真实值 member_grade,R13 收窄后队内分类可内置;详见 prisma/seed.ts V2_DICT_SEED)。
// 模块内常量化:Step 4 organizations 自有 'node_type';如未来需跨模块复用再抽 common。
const MEMBER_GRADE_DICT_CODE = 'member_grade';

// 集中定义对外 select。永不包含 deletedAt(软删除内部状态)。
const memberSafeSelect = {
  id: true,
  memberNo: true,
  displayName: true,
  gradeCode: true,
  status: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.MemberSelect;

type SafeMember = Prisma.MemberGetPayload<{ select: typeof memberSafeSelect }>;
type PrismaTx = Prisma.TransactionClient;

@Injectable()
export class MembersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rbac: RbacService,
  ) {}

  // ============ helpers ============

  // Slow-4 T2(2026-06-11,评审稿 §3.1 / D-S4-8):RBAC 判权(沿 P0-F assertCanOrThrow 范式)。
  // 每个 public 方法第一条语句调用——先判权后查资源,保持与原 Guard 前置语义一致。
  // `member.delete.record` 不绑 biz-admin(仅 SUPER_ADMIN 短路;D1=A 镜像)。
  private async assertCanOrThrow(user: CurrentUserPayload, action: string): Promise<void> {
    if (!(await this.rbac.can(user, action))) {
      throw new BizException(BizCode.RBAC_FORBIDDEN);
    }
  }

  // memberNo 入库前 trim(保留原大小写,与 v1 username 的 toLowerCase 不同 — 编号即身份)
  private normalizeMemberNo(raw: string): string {
    return raw.trim();
  }

  private async findMemberOrThrow(id: string, tx?: PrismaTx): Promise<SafeMember> {
    const client = tx ?? this.prisma;
    const found = await client.member.findFirst({
      where: notDeletedWhere({ id }),
      select: memberSafeSelect,
    });
    if (!found) throw new BizException(BizCode.MEMBER_NOT_FOUND);
    return found;
  }

  // gradeCode 6 项 AND 校验(对应 docs/v2-api-contract.md §4.3,与 organizations 同模式):
  //   dict_type.code = MEMBER_GRADE_DICT_CODE
  //   dict_type.status = ACTIVE
  //   dict_type.deletedAt = null
  //   dict_item.code = gradeCode
  //   dict_item.status = ACTIVE
  //   dict_item.deletedAt = null
  private async assertGradeCodeValid(gradeCode: string, tx?: PrismaTx): Promise<void> {
    const client = tx ?? this.prisma;
    const item = await client.dictItem.findFirst({
      where: {
        code: gradeCode,
        status: DictItemStatus.ACTIVE,
        deletedAt: null,
        type: {
          code: MEMBER_GRADE_DICT_CODE,
          status: DictTypeStatus.ACTIVE,
          deletedAt: null,
        },
      },
      select: { id: true },
    });
    if (!item) throw new BizException(BizCode.MEMBER_GRADE_CODE_INVALID);
  }

  // 唯一性预检查:必须 findUnique 包含软删记录(memberNo 全局唯一不复用,memberNo
  // 决议 Q2 = B-1)— 防止"软删后旧 memberNo 复活创建" 撞约束 + 防止前端拿到 P2002
  // 错误而非业务级错误码。
  private async assertMemberNoUnique(memberNo: string, tx?: PrismaTx): Promise<void> {
    const client = tx ?? this.prisma;
    const existing = await client.member.findUnique({
      where: { memberNo },
      select: { id: true },
    });
    if (existing) throw new BizException(BizCode.MEMBER_NO_ALREADY_EXISTS);
  }

  // P2002 兜底:并发场景下预检查通过但 create 撞唯一约束(沿用 v1 users.service 模式)
  private async runWithUniqueConstraintGuard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const target = (err.meta?.target as string[] | undefined) ?? [];
        if (target.includes('memberNo')) {
          throw new BizException(BizCode.MEMBER_NO_ALREADY_EXISTS);
        }
      }
      throw err;
    }
  }

  // ============ list ============

  async list(
    query: ListMembersQueryDto,
    currentUser: CurrentUserPayload,
  ): Promise<PageResultDto<MemberResponseDto>> {
    await this.assertCanOrThrow(currentUser, 'member.read.record');
    const { page, pageSize, memberNo, gradeCode, status } = query;

    const filters: Prisma.MemberWhereInput = {};
    if (memberNo !== undefined) filters.memberNo = memberNo; // 精确匹配(完整字符串相等)
    if (gradeCode !== undefined) filters.gradeCode = gradeCode;
    if (status !== undefined) filters.status = status;

    const where = notDeletedWhere(filters);

    const [items, total] = await this.prisma.$transaction([
      this.prisma.member.findMany({
        where,
        select: memberSafeSelect,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.member.count({ where }),
    ]);
    return { items, total, page, pageSize };
  }

  // ============ create ============

  async create(dto: CreateMemberDto, currentUser: CurrentUserPayload): Promise<MemberResponseDto> {
    await this.assertCanOrThrow(currentUser, 'member.create.record');
    const memberNo = this.normalizeMemberNo(dto.memberNo);

    return this.prisma.$transaction(async (tx) => {
      // 1. gradeCode 校验(若提供)— 在唯一性预检查之前,业务校验先于资源约束
      if (dto.gradeCode !== undefined) {
        await this.assertGradeCodeValid(dto.gradeCode, tx);
      }

      // 2. memberNo 唯一性预检查(包含软删)
      await this.assertMemberNoUnique(memberNo, tx);

      return this.runWithUniqueConstraintGuard(() =>
        tx.member.create({
          data: {
            memberNo,
            displayName: dto.displayName,
            gradeCode: dto.gradeCode ?? null,
          },
          select: memberSafeSelect,
        }),
      );
    });
  }

  // ============ findOne ============

  async findOne(id: string, currentUser: CurrentUserPayload): Promise<MemberResponseDto> {
    await this.assertCanOrThrow(currentUser, 'member.read.record');
    return this.findMemberOrThrow(id);
  }

  // ============ update ============

  // 仅允许 displayName / gradeCode;memberNo / status 由 DTO 白名单兜底拒绝。
  async update(
    id: string,
    dto: UpdateMemberDto,
    currentUser: CurrentUserPayload,
  ): Promise<MemberResponseDto> {
    await this.assertCanOrThrow(currentUser, 'member.update.record');
    return this.prisma.$transaction(async (tx) => {
      await this.findMemberOrThrow(id, tx);

      if (dto.gradeCode !== undefined) {
        await this.assertGradeCodeValid(dto.gradeCode, tx);
      }

      const data: Prisma.MemberUpdateInput = {};
      if (dto.displayName !== undefined) data.displayName = dto.displayName;
      if (dto.gradeCode !== undefined) data.gradeCode = dto.gradeCode;

      return tx.member.update({
        where: { id },
        data,
        select: memberSafeSelect,
      });
    });
  }

  // ============ updateStatus ============

  async updateStatus(
    id: string,
    dto: UpdateMemberStatusDto,
    currentUser: CurrentUserPayload,
  ): Promise<MemberResponseDto> {
    await this.assertCanOrThrow(currentUser, 'member.update.status');
    await this.findMemberOrThrow(id);
    return this.prisma.member.update({
      where: { id },
      data: { status: dto.status },
      select: memberSafeSelect,
    });
  }

  // ============ softDelete ============

  // 引用检查 + 软删事务原子(沿用 organizations Step 4 模式):
  //   - 有 active 部门归属(member_departments.memberId=:id, deletedAt=null)→ 拒绝
  //   - 有 v1 user 绑定(users.memberId=:id, deletedAt=null)→ 拒绝(防悬空外键)
  // 离队走 PATCH /:id/status → INACTIVE(不软删档案);软删仅"档案彻底无效"场景。
  async softDelete(id: string, currentUser: CurrentUserPayload): Promise<MemberResponseDto> {
    await this.assertCanOrThrow(currentUser, 'member.delete.record');
    return this.prisma.$transaction(async (tx) => {
      await this.findMemberOrThrow(id, tx);

      const [activeDeptCount, linkedUserCount] = await Promise.all([
        // 终态 scoped-authz PR2:重指向 active PRIMARY membership(= 旧单部门语义,行为逐字保持)。
        tx.memberOrganizationMembership.count({
          where: { memberId: id, deletedAt: null, membershipType: 'PRIMARY', status: 'ACTIVE' },
        }),
        tx.user.count({
          where: { memberId: id, deletedAt: null },
        }),
      ]);
      if (activeDeptCount > 0) {
        throw new BizException(BizCode.MEMBER_HAS_ACTIVE_DEPARTMENT);
      }
      if (linkedUserCount > 0) {
        throw new BizException(BizCode.MEMBER_HAS_LINKED_USER);
      }

      return tx.member.update({
        where: { id },
        data: { deletedAt: new Date(), status: MemberStatus.INACTIVE },
        select: memberSafeSelect,
      });
    });
  }
}
