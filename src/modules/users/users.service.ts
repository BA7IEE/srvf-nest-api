import { Injectable } from '@nestjs/common';
import { Prisma, Role, User, UserStatus } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { PageResultDto, PaginationQueryDto } from '../../common/dto/pagination.dto';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import {
  ChangeMyPasswordDto,
  CreateUserDto,
  ResetUserPasswordDto,
  UpdateMyProfileDto,
  UpdateUserDto,
  UpdateUserRoleDto,
  UpdateUserStatusDto,
  UserResponseDto,
} from './users.dto';
import { canChangeRole, canCreateRole, canManageUser, canViewUser } from './users.policy';
import { SafeUser, userSafeSelect } from './users.select';

const BCRYPT_SALT_ROUNDS = 10;

type PrismaTx = Prisma.TransactionClient;

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogs: AuditLogsService,
  ) {}

  // ============ helpers ============

  // 软删除显式过滤(详见 §7.8):所有非"管理员看回收站"查询经此过滤
  private notDeletedWhere<T extends Prisma.UserWhereInput>(
    where: T = {} as T,
  ): T & { deletedAt: null } {
    return { ...where, deletedAt: null };
  }

  private hashPassword(plain: string): Promise<string> {
    return bcrypt.hash(plain, BCRYPT_SALT_ROUNDS);
  }

  // email 归一化:trim + lowercase;空字符串视为清空(入库 null);undefined 表示不更新
  private normalizeEmail(raw: string | undefined): string | null | undefined {
    if (raw === undefined) return undefined;
    const trimmed = raw.trim().toLowerCase();
    return trimmed === '' ? null : trimmed;
  }

  private normalizeUsername(raw: string): string {
    return raw.trim().toLowerCase();
  }

  // 双层校验(§7.11):Guard 已通过 + Service 再按当前/目标角色校验。
  // 策略判定集中在 users.policy.ts;此处仅负责把布尔结果转成统一 BizException。
  private assertCanManageUser(
    currentUser: CurrentUserPayload,
    targetUser: Pick<User, 'role'>,
  ): void {
    if (!canManageUser(currentUser.role, targetUser.role)) {
      throw new BizException(BizCode.FORBIDDEN_ROLE_OPERATION);
    }
  }

  // 详情可见性(V1.3-1):查看类操作走 canViewUser,与"修改类"的
  // canManageUser 拆开。当前两者判定相同,但语义不同——若未来"可见但不可改"
  // 策略分化,只需改 policy 函数本身,不必改调用点。
  private assertCanViewUser(currentUser: CurrentUserPayload, targetUser: Pick<User, 'role'>): void {
    if (!canViewUser(currentUser.role, targetUser.role)) {
      throw new BizException(BizCode.FORBIDDEN_ROLE_OPERATION);
    }
  }

  private assertNotSelf(currentUser: CurrentUserPayload, targetId: string): void {
    if (currentUser.id === targetId) {
      throw new BizException(BizCode.CANNOT_OPERATE_SELF);
    }
  }

  // 最后一个 SUPER_ADMIN 保护:必须在调用方 transaction 内运行(§12 + §13)。
  // 排除目标用户自身后,剩余活跃 super admin 必须 ≥ 1。
  private async assertNotLastSuperAdmin(tx: PrismaTx, userIdAffected: string): Promise<void> {
    const remaining = await tx.user.count({
      where: {
        role: Role.SUPER_ADMIN,
        status: UserStatus.ACTIVE,
        deletedAt: null,
        id: { not: userIdAffected },
      },
    });
    if (remaining === 0) {
      throw new BizException(BizCode.LAST_SUPER_ADMIN_PROTECTED);
    }
  }

  // P2002 唯一约束兜底转换。预检查应该已经拦住绝大多数,这层处理并发场景。
  private async runWithUniqueConstraintGuard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const target = (err.meta?.target as string[] | undefined) ?? [];
        if (target.includes('username')) throw new BizException(BizCode.USERNAME_ALREADY_EXISTS);
        if (target.includes('email')) throw new BizException(BizCode.EMAIL_ALREADY_EXISTS);
      }
      throw err;
    }
  }

  // 唯一性预检查:**必须用 findUnique**(包含软删记录),禁止 findFirst+notDeletedWhere
  // (§7.8 — 软删后 username/email 不复用)。
  private async checkUniqueOrThrow(
    username: string | undefined,
    email: string | null | undefined,
    excludeId?: string,
  ): Promise<void> {
    if (username !== undefined) {
      const existing = await this.prisma.user.findUnique({
        where: { username },
        select: { id: true },
      });
      if (existing && existing.id !== excludeId) {
        throw new BizException(BizCode.USERNAME_ALREADY_EXISTS);
      }
    }
    if (email !== undefined && email !== null) {
      const existing = await this.prisma.user.findUnique({
        where: { email },
        select: { id: true },
      });
      if (existing && existing.id !== excludeId) {
        throw new BizException(BizCode.EMAIL_ALREADY_EXISTS);
      }
    }
  }

  // 业务详情查询:findFirst + notDeletedWhere,找不到/已软删统一抛 USER_NOT_FOUND。
  private async findByIdOrThrow(id: string): Promise<SafeUser> {
    const user = await this.prisma.user.findFirst({
      where: this.notDeletedWhere({ id }),
      select: userSafeSelect,
    });
    if (!user) throw new BizException(BizCode.USER_NOT_FOUND);
    return user;
  }

  // 同上,但只返回管理校验所需字段(role/status),少一次完整 select 拷贝。
  private async findRawByIdOrThrow(id: string): Promise<Pick<User, 'id' | 'role' | 'status'>> {
    const user = await this.prisma.user.findFirst({
      where: this.notDeletedWhere({ id }),
      select: { id: true, role: true, status: true },
    });
    if (!user) throw new BizException(BizCode.USER_NOT_FOUND);
    return user;
  }

  // ============ /me ============

  findMe(currentUser: CurrentUserPayload): Promise<UserResponseDto> {
    return this.findByIdOrThrow(currentUser.id);
  }

  async updateMyProfile(
    currentUser: CurrentUserPayload,
    dto: UpdateMyProfileDto,
  ): Promise<UserResponseDto> {
    // 纵深防御:JwtStrategy.validate 已保证 currentUser 存在且未软删,
    // 这里再次显式检查避免极端 race(管理员刚刚软删该用户的窗口)。
    await this.findByIdOrThrow(currentUser.id);
    return this.prisma.user.update({
      where: { id: currentUser.id },
      data: {
        nickname: dto.nickname,
        avatarKey: dto.avatarKey,
      },
      select: userSafeSelect,
    });
  }

  // ============ /me/password(P0-D PR-3 本人自助改密)============
  // 沿 docs/first-release-p0d-change-my-password-review.md §5.2 流程顺序:
  //   1. findFirst(notDeletedWhere) 拿当前 passwordHash;找不到 → USER_NOT_FOUND
  //   2. bcrypt.compare(dto.oldPassword, user.passwordHash);失败 → OLD_PASSWORD_INVALID
  //   3. 严格 === 比较 oldPassword / newPassword(密码大小写敏感、空白显著,不 trim / toLowerCase);
  //      相同 → NEW_PASSWORD_SAME_AS_OLD
  //   4. bcrypt.hash(newPassword) → tx.user.update + auditLogs.log 原子(D-4 决议)
  //   5. 返回 userSafeSelect(永不含 passwordHash)
  //
  // 严禁(沿评审稿 §4 / §5.5 / §5.7):
  //   - 调换步骤 2 与 3(timing oracle:先比较会泄漏"新密码是否等于旧密码"信息)
  //   - 主动吊销旧 token / 修改 lastLoginAt / 写 password 明文或 hash 到 audit
  //   - 经其他接口(PATCH /me)夹带改密
  async changeMyPassword(
    currentUser: CurrentUserPayload,
    dto: ChangeMyPasswordDto,
    auditMeta: AuditMeta,
  ): Promise<UserResponseDto> {
    // 1. 取 passwordHash 走原生 findFirst(userSafeSelect 不含 passwordHash;
    //    本接口必须读 hash 做 bcrypt.compare,故单独 select)。
    const user = await this.prisma.user.findFirst({
      where: this.notDeletedWhere({ id: currentUser.id }),
      select: { id: true, passwordHash: true },
    });
    if (!user) throw new BizException(BizCode.USER_NOT_FOUND);

    // 2. bcrypt.compare 完整跑完(评审稿 §5.5:禁止"先比对 oldPassword === newPassword
    //    跳过 bcrypt"的优化,避免泄漏"newPassword 与 oldPassword 是否相同"信息)。
    const oldPasswordOk = await bcrypt.compare(dto.oldPassword, user.passwordHash);
    if (!oldPasswordOk) throw new BizException(BizCode.OLD_PASSWORD_INVALID);

    // 3. 严格 === 比较;不 trim / toLowerCase(评审稿 §5.2 步骤 4)。
    if (dto.oldPassword === dto.newPassword) {
      throw new BizException(BizCode.NEW_PASSWORD_SAME_AS_OLD);
    }

    // 4. 哈希新密码;在事务内 update + 撤销 refresh + audit log 原子(沿 P0-E PR-3 §7.1)。
    const passwordHash = await this.hashPassword(dto.newPassword);

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.user.update({
        where: { id: currentUser.id },
        data: { passwordHash },
        select: userSafeSelect,
      });

      // P0-E PR-3(2026-05-18):本人改密后**主动撤销**该 user 全部未过期且未撤销的 refresh token
      // (沿评审稿 §7.1 + CLAUDE.md §9 P0-E 子节)。access token 仍不主动吊销(沿 D-4),
      // 由 JWT_EXPIRES_IN=15m 自然过期 + JwtStrategy 每请求查库阻断 DISABLED / 软删用户。
      // e2e users-change-my-password.e2e-spec.ts §7.5 反向锁定断言(改密后旧 access 仍可调 /me)
      // 继续保留。
      const refreshRevoke = await tx.refreshToken.updateMany({
        where: { userId: currentUser.id, revokedAt: null, expiresAt: { gt: new Date() } },
        data: { revokedAt: new Date(), revokedReason: 'self-password-change' },
      });

      await this.auditLogs.log({
        event: 'password.change.self',
        actorUserId: currentUser.id,
        actorRoleSnap: currentUser.role,
        resourceType: 'user',
        resourceId: currentUser.id,
        meta: auditMeta,
        // 评审稿 §5.6 / §7.6:audit 字段不含 oldPassword / newPassword / passwordHash
        // 任何明文或 hash。P0-E PR-3 extra 加 refreshTokensRevoked: count(沿 §9 / §5.9
        // audit extra 允许字段)。
        extra: { refreshTokensRevoked: refreshRevoke.count },
        tx,
      });

      return updated;
    });
  }

  // ============ admin: list ============

  async list(
    currentUser: CurrentUserPayload,
    query: PaginationQueryDto,
  ): Promise<PageResultDto<UserResponseDto>> {
    const { page, pageSize } = query;
    const where: Prisma.UserWhereInput = this.notDeletedWhere({});

    // 列表可见范围由 users.policy.canViewUser 统一定义:
    //   SUPER_ADMIN 可看 SUPER_ADMIN/ADMIN/USER,ADMIN 仅可看 USER。
    // 把允许看到的角色压成 IN 子句喂给 Prisma,避免在 service 里再写一次角色 if-else。
    const visibleRoles = (Object.values(Role) as Role[]).filter((r) =>
      canViewUser(currentUser.role, r),
    );
    if (visibleRoles.length === 0) {
      // defensive,Guard 已拦截非 SUPER_ADMIN/ADMIN
      throw new BizException(BizCode.FORBIDDEN);
    }
    where.role = { in: visibleRoles };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        where,
        select: userSafeSelect,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.user.count({ where }),
    ]);

    return { items, total, page, pageSize };
  }

  // ============ admin: create ============

  async create(currentUser: CurrentUserPayload, dto: CreateUserDto): Promise<UserResponseDto> {
    // role 透传安全(§7.11):策略集中在 users.policy.canCreateRole。
    const targetRole = dto.role ?? Role.USER;
    if (!canCreateRole(currentUser.role, targetRole)) {
      throw new BizException(BizCode.FORBIDDEN_ROLE_OPERATION);
    }

    const username = this.normalizeUsername(dto.username);
    const email = this.normalizeEmail(dto.email);

    // 唯一性预检查(包含软删):findUnique
    await this.checkUniqueOrThrow(username, email);

    const passwordHash = await this.hashPassword(dto.password);

    return this.runWithUniqueConstraintGuard(() =>
      this.prisma.user.create({
        data: {
          username,
          email,
          passwordHash,
          nickname: dto.nickname,
          avatarKey: dto.avatarKey,
          role: targetRole,
        },
        select: userSafeSelect,
      }),
    );
  }

  // ============ admin: read ============

  async findOne(currentUser: CurrentUserPayload, id: string): Promise<UserResponseDto> {
    const target = await this.findRawByIdOrThrow(id);
    // 详情查看走 canViewUser(V1.3-1):与管理类操作的 canManageUser 在语义上拆开。
    this.assertCanViewUser(currentUser, target);
    return this.findByIdOrThrow(id);
  }

  // ============ admin: update profile ============

  async update(
    currentUser: CurrentUserPayload,
    id: string,
    dto: UpdateUserDto,
  ): Promise<UserResponseDto> {
    const target = await this.findRawByIdOrThrow(id);
    this.assertCanManageUser(currentUser, target);

    const data: Prisma.UserUpdateInput = {};
    if (dto.nickname !== undefined) data.nickname = dto.nickname;
    if (dto.avatarKey !== undefined) data.avatarKey = dto.avatarKey;
    if (dto.email !== undefined) {
      const normalized = this.normalizeEmail(dto.email);
      data.email = normalized;
      if (normalized !== null) {
        await this.checkUniqueOrThrow(undefined, normalized, id);
      }
    }

    return this.runWithUniqueConstraintGuard(() =>
      this.prisma.user.update({
        where: { id },
        data,
        select: userSafeSelect,
      }),
    );
  }

  // ============ admin: reset password ============

  async resetPassword(
    currentUser: CurrentUserPayload,
    id: string,
    dto: ResetUserPasswordDto,
    auditMeta: AuditMeta,
  ): Promise<UserResponseDto> {
    const target = await this.findRawByIdOrThrow(id);
    this.assertCanManageUser(currentUser, target);

    // 管理员重置密码后:
    //   - access token v1 仍不主动吊销(沿 §7.7 + D-4;access ≤ 15m 自然过期);
    //     如需立即阻断,管理员同步把目标 status 改 DISABLED。
    //   - P0-E PR-3(2026-05-18):**主动撤销**目标 user 全部 refresh token
    //     (revokedReason='admin-password-reset';沿评审稿 §7.2 + §9 联动撤销 4 场景)。
    //   - P0-E PR-3 同步补 audit 'password.reset.by-admin'(隐含范围扩展;沿评审稿 §3.8
    //     D-8 + §5.9;管理员重置之前从未写 audit,本 PR 顺手补对称)。
    const passwordHash = await this.hashPassword(dto.newPassword);

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.user.update({
        where: { id },
        data: { passwordHash },
        select: userSafeSelect,
      });

      const refreshRevoke = await tx.refreshToken.updateMany({
        where: { userId: id, revokedAt: null, expiresAt: { gt: new Date() } },
        data: { revokedAt: new Date(), revokedReason: 'admin-password-reset' },
      });

      await this.auditLogs.log({
        event: 'password.reset.by-admin',
        actorUserId: currentUser.id,
        actorRoleSnap: currentUser.role,
        resourceType: 'user',
        resourceId: id,
        meta: auditMeta,
        extra: { refreshTokensRevoked: refreshRevoke.count },
        tx,
      });

      return updated;
    });
  }

  // ============ admin: update role ============

  async updateRole(
    currentUser: CurrentUserPayload,
    id: string,
    dto: UpdateUserRoleDto,
  ): Promise<UserResponseDto> {
    // 自我保护(§7.11):自改 role 永远拦
    this.assertNotSelf(currentUser, id);

    const target = await this.findRawByIdOrThrow(id);
    this.assertCanManageUser(currentUser, target);

    // 改角色策略集中在 users.policy.canChangeRole(禁止把任何人设成 SUPER_ADMIN)。
    if (!canChangeRole(currentUser.role, dto.role)) {
      throw new BizException(BizCode.FORBIDDEN_ROLE_OPERATION);
    }

    // 最后一个保护:目标当前是 SUPER_ADMIN 且新 role 不是 SUPER_ADMIN(降级)
    return this.prisma.$transaction(async (tx) => {
      if (target.role === Role.SUPER_ADMIN && dto.role !== Role.SUPER_ADMIN) {
        await this.assertNotLastSuperAdmin(tx, id);
      }
      return tx.user.update({
        where: { id },
        data: { role: dto.role },
        select: userSafeSelect,
      });
    });
  }

  // ============ admin: update status ============

  async updateStatus(
    currentUser: CurrentUserPayload,
    id: string,
    dto: UpdateUserStatusDto,
  ): Promise<UserResponseDto> {
    const target = await this.findRawByIdOrThrow(id);
    this.assertCanManageUser(currentUser, target);

    // 自我保护:仅当改成 DISABLED 时拦截(防止把自己禁用后无人能再启用)
    if (dto.status === UserStatus.DISABLED) {
      this.assertNotSelf(currentUser, id);
    }

    // 最后一个保护:目标当前是 SUPER_ADMIN 且新 status === DISABLED
    return this.prisma.$transaction(async (tx) => {
      if (target.role === Role.SUPER_ADMIN && dto.status === UserStatus.DISABLED) {
        await this.assertNotLastSuperAdmin(tx, id);
      }
      const updated = await tx.user.update({
        where: { id },
        data: { status: dto.status },
        select: userSafeSelect,
      });

      // P0-E PR-3(2026-05-18):用户被 DISABLED 时**主动撤销**目标 user 全部 refresh token
      // (revokedReason='admin-disable';沿评审稿 §7.3 + §9 联动撤销 4 场景之一)。
      // 仅当 dto.status === DISABLED 时撤销;ACTIVE → ACTIVE 不动 refresh(沿评审稿 §7.5);
      // access token 由 JwtStrategy 每请求查库即时阻断(沿现状)。
      // 本 PR 范围:**不**为 status 改动写 audit(沿评审稿 D-PR3-2 用户拍板 §7.3 不补 audit;
      // 仅撤销 refresh,audit 由独立 PR 处理)。
      if (dto.status === UserStatus.DISABLED) {
        await tx.refreshToken.updateMany({
          where: { userId: id, revokedAt: null, expiresAt: { gt: new Date() } },
          data: { revokedAt: new Date(), revokedReason: 'admin-disable' },
        });
      }

      return updated;
    });
  }

  // ============ admin: soft delete ============

  async softDelete(currentUser: CurrentUserPayload, id: string): Promise<UserResponseDto> {
    this.assertNotSelf(currentUser, id);

    const target = await this.findRawByIdOrThrow(id);
    this.assertCanManageUser(currentUser, target);

    // 删除走 update,而非 prisma.user.delete()(§7.8)
    return this.prisma.$transaction(async (tx) => {
      if (target.role === Role.SUPER_ADMIN) {
        await this.assertNotLastSuperAdmin(tx, id);
      }
      const updated = await tx.user.update({
        where: { id },
        data: {
          deletedAt: new Date(),
          status: UserStatus.DISABLED,
        },
        select: userSafeSelect,
      });

      // P0-E PR-3(2026-05-18):用户被软删时**主动撤销**目标 user 全部 refresh token
      // (revokedReason='admin-delete';沿评审稿 §7.4 + §9 联动撤销 4 场景之一)。
      // access token 由 JwtStrategy 每请求查库即时阻断(deletedAt != null;沿现状)。
      // 本 PR 范围:**不**为软删写 audit(沿 D-PR3-2 用户拍板;仅撤销 refresh)。
      await tx.refreshToken.updateMany({
        where: { userId: id, revokedAt: null, expiresAt: { gt: new Date() } },
        data: { revokedAt: new Date(), revokedReason: 'admin-delete' },
      });

      return updated;
    });
  }
}
