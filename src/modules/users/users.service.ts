import { Injectable } from '@nestjs/common';
import { Prisma, Role, SmsPurpose, User, UserStatus } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { PageResultDto } from '../../common/dto/pagination.dto';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { LastAdminProtectionPolicy } from '../permissions/last-admin-protection.policy';
import { RbacService } from '../permissions/rbac.service';
import { SmsCodeService } from '../sms/sms-code.service';
import { maskPhone } from '../sms/sms.constants';
import { maskOpenid } from '../wechat/wechat.constants';
import { WechatService } from '../wechat/wechat.service';
import type {
  AppMePhoneDto,
  BindMyPhoneDto,
  SendMyPhoneCodeDto,
  SendMyPhoneCodeResponseDto,
} from './dto/app/app-me-phone.dto';
import type { AppMeWechatDto, BindMyWechatDto } from './dto/app/app-me-wechat.dto';
import {
  ChangeMyPasswordDto,
  CreateUserDto,
  ListUsersQueryDto,
  ResetUserPasswordDto,
  UpdateMyProfileDto,
  UpdateUserDto,
  UpdateUserRoleDto,
  UpdateUserStatusDto,
  UserOptionItemDto,
  UserOptionsQueryDto,
  UserOptionsResponseDto,
  UserResponseDto,
} from './users.dto';
import { canChangeRole, canCreateRole, canManageUser, canViewUser } from './users.policy';
import { SafeUser, SafeUserWithMember, userAdminSelect, userSafeSelect } from './users.select';

const BCRYPT_SALT_ROUNDS = 10;

// admin/v1/me 本人身份只读投影(2026-06-14)。字段集 = User 本体身份 9 项,
// **不**含 member 业务字段 / L3(passwordHash / *token* / secret*)/ createdAt / updatedAt;
// 故**不**复用 userSafeSelect(其服务于 admin/v1/users 详情 DTO,含 createdAt/updatedAt
// 缺 memberId,字段集与本端点不一致)。lastLoginAt 为 Date,ISO 化在 controller 拼装层做。
export type AdminMeIdentity = Pick<
  User,
  | 'id'
  | 'username'
  | 'email'
  | 'nickname'
  | 'avatarKey'
  | 'role'
  | 'status'
  | 'lastLoginAt'
  | 'memberId'
>;

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogs: AuditLogsService,
    private readonly rbac: RbacService,
    private readonly lastAdminProtection: LastAdminProtectionPolicy,
    private readonly smsCode: SmsCodeService,
    private readonly wechat: WechatService,
  ) {}

  // ============ helpers ============

  // P0-F PR-3B(2026-05-18):RBAC 业务模块判权(沿 PR-1 permissions.service.ts:41-45 字面范式)。
  // 失败统一抛 BizException(BizCode.RBAC_FORBIDDEN)(30100);RbacService.can 内部已实现
  // SUPER_ADMIN 短路 + cache + ownership(.self),users 8 端点粗粒度无 resource。
  // service 内业务护栏(canViewUser / canManageUser / canCreateRole / canChangeRole / assertNotSelf /
  // LastAdminProtectionPolicy)在 assertCanOrThrow 之后保留并执行,**不挪动**。
  private async assertCanOrThrow(user: CurrentUserPayload, action: string): Promise<void> {
    if (!(await this.rbac.can(user, action))) {
      throw new BizException(BizCode.RBAC_FORBIDDEN);
    }
  }

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

  // 队员账号闭环 v1(2026-07-07):同上,但叠加 memberId + member 摘要(userAdminSelect)。
  // 仅供 admin findOne() 详情端点使用;findByIdOrThrow 保持不变(App 自助等其余 10 处调用方
  // 零影响)。
  private async findByIdWithMemberOrThrow(id: string): Promise<SafeUserWithMember> {
    const user = await this.prisma.user.findFirst({
      where: this.notDeletedWhere({ id }),
      select: userAdminSelect,
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

  // ============ /api/admin/v1/me(Admin 自视角只读身份;2026-06-14)============
  // 任意登录用户取本人 User 身份(对齐 rbac/me/permissions 准入:入口仅 JwtAuthGuard,
  // service 内**不**做 rbac.can() / role 判定——只返本人无越权面)。复用 notDeletedWhere
  // 读路径;并发软删窗口返 null,由 AdminMeController 兜底为 UNAUTHORIZED(逐字镜像
  // app-me.controller.ts 范式)。**不读 / 不写任何 member 业务字段**;字段集 = AdminMeIdentity 9 项。
  getMyAdminIdentity(currentUser: CurrentUserPayload): Promise<AdminMeIdentity | null> {
    return this.prisma.user.findFirst({
      where: this.notDeletedWhere({ id: currentUser.id }),
      select: {
        id: true,
        username: true,
        email: true,
        nickname: true,
        avatarKey: true,
        role: true,
        status: true,
        lastLoginAt: true,
        memberId: true,
      },
    });
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

  // canViewUser 可见范围求交:role 入参必须落在调用者可见角色集内,否则该过滤条件下
  // 恒空结果(不报错、不放宽 —— 沿本方法既有可见性裁剪红线,F1 新增过滤严禁绕过)。
  private effectiveVisibleRoles(currentUser: CurrentUserPayload, role?: Role): Role[] {
    const visibleRoles = (Object.values(Role) as Role[]).filter((r) =>
      canViewUser(currentUser.role, r),
    );
    if (role === undefined) return visibleRoles;
    return visibleRoles.includes(role) ? [role] : [];
  }

  private buildSearchOr(q: string): Prisma.UserWhereInput['OR'] {
    return [
      { username: { contains: q, mode: 'insensitive' } },
      { nickname: { contains: q, mode: 'insensitive' } },
      { email: { contains: q, mode: 'insensitive' } },
      { phone: { contains: q, mode: 'insensitive' } },
    ];
  }

  async list(
    currentUser: CurrentUserPayload,
    query: ListUsersQueryDto,
  ): Promise<PageResultDto<UserResponseDto>> {
    await this.assertCanOrThrow(currentUser, 'user.read.account');
    const { page, pageSize, q, role, status, memberId } = query;
    const where: Prisma.UserWhereInput = this.notDeletedWhere({});

    // 列表可见范围由 users.policy.canViewUser 统一定义:
    //   SUPER_ADMIN 可看 SUPER_ADMIN/ADMIN/USER,ADMIN 仅可看 USER。
    // 把允许看到的角色压成 IN 子句喂给 Prisma,避免在 service 里再写一次角色 if-else。
    const visibleRoles = this.effectiveVisibleRoles(currentUser, role);
    if (visibleRoles.length === 0 && role === undefined) {
      // defensive,Guard 已拦截非 SUPER_ADMIN/ADMIN
      throw new BizException(BizCode.FORBIDDEN);
    }
    where.role = { in: visibleRoles };
    if (status !== undefined) where.status = status;
    if (memberId !== undefined) where.memberId = memberId;
    if (q !== undefined) where.OR = this.buildSearchOr(q);

    const [items, total] = await this.prisma.$transaction([
      // 队员账号闭环 v1(2026-07-07):list 走 userAdminSelect,additive 暴露
      // memberId + member 摘要(见 users.select.ts 顶部注释)。
      this.prisma.user.findMany({
        where,
        select: userAdminSelect,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.user.count({ where }),
    ]);

    return { items, total, page, pageSize };
  }

  // ============ F1/A2 选择器(路线图 §4;D2/D3 拍板)============

  // options = list 的轻量投影;复用 user.read.account(D2,不新增权限码);
  // canViewUser 可见性裁剪同 list 保留(防止 ADMIN 经选择器枚举到不可见角色的账号)。
  async options(
    currentUser: CurrentUserPayload,
    query: UserOptionsQueryDto,
  ): Promise<UserOptionsResponseDto> {
    await this.assertCanOrThrow(currentUser, 'user.read.account');
    const { q, limit } = query;
    const where: Prisma.UserWhereInput = this.notDeletedWhere({
      role: { in: this.effectiveVisibleRoles(currentUser) },
    });
    if (q !== undefined) where.OR = this.buildSearchOr(q);

    const rows = await this.prisma.user.findMany({
      where,
      select: { id: true, username: true, nickname: true },
      orderBy: { createdAt: 'desc' },
      take: limit ?? 20,
    });

    const items: UserOptionItemDto[] = rows.map((r) => ({
      id: r.id,
      label: r.nickname ?? r.username,
      username: r.username,
    }));
    return { items };
  }

  // ============ admin: create ============

  async create(currentUser: CurrentUserPayload, dto: CreateUserDto): Promise<UserResponseDto> {
    await this.assertCanOrThrow(currentUser, 'user.create.account');
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
    await this.assertCanOrThrow(currentUser, 'user.read.account');
    const target = await this.findRawByIdOrThrow(id);
    // 详情查看走 canViewUser(V1.3-1):与管理类操作的 canManageUser 在语义上拆开。
    this.assertCanViewUser(currentUser, target);
    // 队员账号闭环 v1(2026-07-07):详情走 userAdminSelect,additive 暴露
    // memberId + member 摘要(见 findByIdWithMemberOrThrow 注释)。
    return this.findByIdWithMemberOrThrow(id);
  }

  // ============ admin: update profile ============

  async update(
    currentUser: CurrentUserPayload,
    id: string,
    dto: UpdateUserDto,
  ): Promise<UserResponseDto> {
    await this.assertCanOrThrow(currentUser, 'user.update.account');
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
    await this.assertCanOrThrow(currentUser, 'user.reset.password');
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
    auditMeta: AuditMeta,
  ): Promise<UserResponseDto> {
    // P0-F PR-3B D1=A:user.update.role 不绑 ops-admin;仅 SUPER_ADMIN 经 RbacService 短路通过。
    // RBAC 通过后仍走 service 内 4 项业务护栏(assertNotSelf + assertCanManageUser +
    // canChangeRole 永禁升 SA + LastAdminProtectionPolicy 降级时);全部保留不动。
    await this.assertCanOrThrow(currentUser, 'user.update.role');
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
        await this.lastAdminProtection.assertCanRemoveSuperAdmin(tx, id);
      }
      const updated = await tx.user.update({
        where: { id },
        data: { role: dto.role },
        select: userSafeSelect,
      });

      await this.auditLogs.log({
        event: 'user.role.update',
        actorUserId: currentUser.id,
        actorRoleSnap: currentUser.role,
        resourceType: 'user',
        resourceId: id,
        meta: auditMeta,
        before: { role: target.role },
        after: { role: updated.role },
        tx,
      });

      return updated;
    });
  }

  // ============ admin: update status ============

  async updateStatus(
    currentUser: CurrentUserPayload,
    id: string,
    dto: UpdateUserStatusDto,
    auditMeta: AuditMeta,
  ): Promise<UserResponseDto> {
    await this.assertCanOrThrow(currentUser, 'user.update.status');
    const target = await this.findRawByIdOrThrow(id);
    this.assertCanManageUser(currentUser, target);

    // 自我保护:仅当改成 DISABLED 时拦截(防止把自己禁用后无人能再启用)
    if (dto.status === UserStatus.DISABLED) {
      this.assertNotSelf(currentUser, id);
    }

    // 最后一个保护:目标当前是 SUPER_ADMIN 且新 status === DISABLED
    return this.prisma.$transaction(async (tx) => {
      if (target.role === Role.SUPER_ADMIN && dto.status === UserStatus.DISABLED) {
        await this.lastAdminProtection.assertCanRemoveSuperAdmin(tx, id);
      }
      if (dto.status === UserStatus.DISABLED) {
        await this.lastAdminProtection.assertCanDeactivateOpsAdminUser(tx, id);
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
      // 第六刀已补 in-tx audit(2026-07-13;推翻 D-PR3-2 的“不写 audit”挂起决定)。
      if (dto.status === UserStatus.DISABLED) {
        await tx.refreshToken.updateMany({
          where: { userId: id, revokedAt: null, expiresAt: { gt: new Date() } },
          data: { revokedAt: new Date(), revokedReason: 'admin-disable' },
        });
      }

      await this.auditLogs.log({
        event: 'user.status.update',
        actorUserId: currentUser.id,
        actorRoleSnap: currentUser.role,
        resourceType: 'user',
        resourceId: id,
        meta: auditMeta,
        before: { status: target.status },
        after: { status: updated.status },
        tx,
      });

      return updated;
    });
  }

  // ============ admin: soft delete ============

  async softDelete(
    currentUser: CurrentUserPayload,
    id: string,
    auditMeta: AuditMeta,
  ): Promise<UserResponseDto> {
    await this.assertCanOrThrow(currentUser, 'user.delete.account');
    this.assertNotSelf(currentUser, id);

    const target = await this.findRawByIdOrThrow(id);
    this.assertCanManageUser(currentUser, target);

    // 删除走 update,而非 prisma.user.delete()(§7.8)
    return this.prisma.$transaction(async (tx) => {
      if (target.role === Role.SUPER_ADMIN) {
        await this.lastAdminProtection.assertCanRemoveSuperAdmin(tx, id);
      }
      await this.lastAdminProtection.assertCanDeactivateOpsAdminUser(tx, id);
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
      // 第六刀已补 in-tx audit(2026-07-13;推翻 D-PR3-2 的“不写 audit”挂起决定)。
      await tx.refreshToken.updateMany({
        where: { userId: id, revokedAt: null, expiresAt: { gt: new Date() } },
        data: { revokedAt: new Date(), revokedReason: 'admin-delete' },
      });

      await this.auditLogs.log({
        event: 'user.soft-delete',
        actorUserId: currentUser.id,
        actorRoleSnap: currentUser.role,
        resourceType: 'user',
        resourceId: id,
        meta: auditMeta,
        before: { deleted: false, status: target.status },
        after: { deleted: true, status: updated.status },
        tx,
      });

      return updated;
    });
  }

  // ============ SMS T3:me/phone 绑定 + admin 清除(2026-06-10) ============
  // 冻结评审稿 docs/archive/reviews/sms-verification-infra-review.md §3.2 ⑤-⑦ / §7 / E-5~E-8 / E-19。
  // 准入:me/phone 两方法沿 PUT /me/password 账号级豁免先例(E-5),**不**强约 canUseApp;
  // User.phone 是账号级身份字段(非 member-domain),Admin 无 member 也需绑定;
  // 豁免仅限这两个端点,禁止外溢。

  // POST /api/app/v1/me/phone/send-code(⑤)。
  // 占用预检必须 findUnique(**含软删占用**,E-7,沿 §7.8 username/email 不复用范式);
  // 含本人已绑同号(不提供"重新验证当前号"语义,省一次短信资费)。
  // 间隔 / 日限 / 通道 / 发送 / 落日志在 SmsCodeService.issue(E-30 边界)。
  async sendMyPhoneBindCode(
    currentUser: CurrentUserPayload,
    dto: SendMyPhoneCodeDto,
    ip: string | null,
  ): Promise<SendMyPhoneCodeResponseDto> {
    const occupied = await this.prisma.user.findUnique({
      where: { phone: dto.phone },
      select: { id: true },
    });
    if (occupied !== null) {
      throw new BizException(BizCode.PHONE_ALREADY_BOUND);
    }
    return this.smsCode.issue({
      phone: dto.phone,
      purpose: SmsPurpose.PHONE_BIND,
      userId: currentUser.id,
      ip,
    });
  }

  // PUT /api/app/v1/me/phone(⑥):验码绑定 / 换绑一体(§7)。
  // 流程:占用复查 → 取本人 before.phone → 验码即消费(独立于绑定事务,见
  // SmsCodeService.verifyAndConsume 注释)→ 事务内 update + audit(bind/rebind 按 before 区分)。
  // P2002 兜底竞态:落库撞 User_phone_key → PHONE_ALREADY_BOUND(沿 §5 数组判断铁律)。
  async bindMyPhone(
    currentUser: CurrentUserPayload,
    dto: BindMyPhoneDto,
    auditMeta: AuditMeta,
  ): Promise<AppMePhoneDto> {
    const occupied = await this.prisma.user.findUnique({
      where: { phone: dto.phone },
      select: { id: true },
    });
    if (occupied !== null) {
      throw new BizException(BizCode.PHONE_ALREADY_BOUND);
    }

    const me = await this.prisma.user.findFirst({
      where: this.notDeletedWhere({ id: currentUser.id }),
      select: { id: true, phone: true },
    });
    if (!me) throw new BizException(BizCode.USER_NOT_FOUND);

    const { codeId } = await this.smsCode.verifyAndConsume({
      phone: dto.phone,
      purpose: SmsPurpose.PHONE_BIND,
      code: dto.code,
      userId: currentUser.id,
    });

    try {
      const updated = await this.prisma.$transaction(async (tx) => {
        const row = await tx.user.update({
          where: { id: currentUser.id },
          data: { phone: dto.phone, phoneVerifiedAt: new Date() },
          select: { phone: true, phoneVerifiedAt: true },
        });

        // audit detail 手机号一律掩码(E-21/E-24);禁明文码 / codeHash / 完整号码
        await this.auditLogs.log({
          event: me.phone === null ? 'phone.bind.self' : 'phone.rebind.self',
          actorUserId: currentUser.id,
          actorRoleSnap: currentUser.role,
          resourceType: 'user',
          resourceId: currentUser.id,
          meta: auditMeta,
          ...(me.phone === null ? {} : { before: { phone: maskPhone(me.phone) } }),
          after: { phone: maskPhone(dto.phone) },
          extra: { codeId },
          tx,
        });

        return row;
      });

      return {
        phone: updated.phone,
        phoneVerifiedAt: updated.phoneVerifiedAt?.toISOString() ?? null,
      };
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002' &&
        Array.isArray(err.meta?.target) &&
        (err.meta.target as string[]).includes('phone')
      ) {
        throw new BizException(BizCode.PHONE_ALREADY_BOUND);
      }
      throw err;
    }
  }

  // ============ 微信小程序登录 T3:me/wechat 查询/换绑 + admin 清除(2026-06-12) ============
  // 冻结评审稿 docs/archive/reviews/wechat-mini-login-review.md §4.4 / E-13/E-18/E-19/E-20。
  // 准入:me/wechat 两方法沿 me/phone 账号级豁免先例(E-18),**不**强约 canUseApp;
  // User.openid 是账号级身份字段,Admin 无 member 也需绑定;豁免仅限这两个端点,禁止外溢。
  // openid 纪律:响应仅掩码回显(maskOpenid);audit 一律掩码;不入 pino 日志。

  // GET /api/app/v1/me/wechat(⑦):绑定状态查询。
  async getMyWechat(currentUser: CurrentUserPayload): Promise<AppMeWechatDto> {
    const me = await this.prisma.user.findFirst({
      where: this.notDeletedWhere({ id: currentUser.id }),
      select: { openid: true },
    });
    if (!me) throw new BizException(BizCode.USER_NOT_FOUND);
    return {
      bound: me.openid !== null,
      openidMasked: me.openid === null ? null : maskOpenid(me.openid),
    };
  }

  // PUT /api/app/v1/me/wechat(⑧):已登录绑定 / 换绑一体(评审稿 §4.4;JWT 已证身份,
  // 无需再验手机,D-W3)。流程:code2session → 占用检查(=本人幂等返当前状态不写 audit;
  // 他人 → 25002)→ 事务 update + audit wechat.{bind,rebind}.self(viaPath='me')。
  // P2002 兜底竞态:落库撞 User_openid_key → WECHAT_ALREADY_BOUND(沿 §5 数组判断铁律)。
  async bindMyWechat(
    currentUser: CurrentUserPayload,
    dto: BindMyWechatDto,
    auditMeta: AuditMeta,
  ): Promise<AppMeWechatDto> {
    const { openid } = await this.wechat.code2session(dto.code);

    const me = await this.prisma.user.findFirst({
      where: this.notDeletedWhere({ id: currentUser.id }),
      select: { id: true, openid: true },
    });
    if (!me) throw new BizException(BizCode.USER_NOT_FOUND);

    const occupied = await this.prisma.user.findUnique({
      where: { openid },
      select: { id: true },
    });
    if (occupied !== null) {
      if (occupied.id === currentUser.id) {
        // 幂等:同 openid 重复绑定,无状态变化不写 audit
        return { bound: true, openidMasked: maskOpenid(openid) };
      }
      throw new BizException(BizCode.WECHAT_ALREADY_BOUND);
    }

    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.user.update({
          where: { id: currentUser.id },
          data: { openid },
          select: { id: true },
        });

        // audit detail openid 一律掩码(E-23);禁 wx code / 完整 openid / session_key
        await this.auditLogs.log({
          event: me.openid === null ? 'wechat.bind.self' : 'wechat.rebind.self',
          actorUserId: currentUser.id,
          actorRoleSnap: currentUser.role,
          resourceType: 'user',
          resourceId: currentUser.id,
          meta: auditMeta,
          ...(me.openid === null ? {} : { before: { openid: maskOpenid(me.openid) } }),
          after: { openid: maskOpenid(openid) },
          extra: { viaPath: 'me' },
          tx,
        });
      });

      return { bound: true, openidMasked: maskOpenid(openid) };
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002' &&
        Array.isArray(err.meta?.target) &&
        (err.meta.target as string[]).includes('openid')
      ) {
        throw new BizException(BizCode.WECHAT_ALREADY_BOUND);
      }
      throw err;
    }
  }

  // DELETE /api/admin/v1/users/:id/wechat(⑨):管理员清除绑定(解除绑定唯一路径,D-W3;
  // 逐行镜像 clearUserPhone E-20)。rbac.can('user.wechat.clear')(绑 ops-admin)+
  // assertCanManageUser 既有护栏;软删用户统一 USER_NOT_FOUND(沿 §7.8);
  // **幂等**:目标无 openid → 200 不报错,且仅实际清除时写 audit。
  async clearUserWechat(
    currentUser: CurrentUserPayload,
    id: string,
    auditMeta: AuditMeta,
  ): Promise<UserResponseDto> {
    await this.assertCanOrThrow(currentUser, 'user.wechat.clear');

    const target = await this.prisma.user.findFirst({
      where: this.notDeletedWhere({ id }),
      select: { id: true, role: true, status: true, openid: true },
    });
    if (!target) throw new BizException(BizCode.USER_NOT_FOUND);
    this.assertCanManageUser(currentUser, target);

    if (target.openid === null) {
      return this.findByIdOrThrow(id);
    }

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.user.update({
        where: { id },
        data: { openid: null },
        select: userSafeSelect,
      });

      await this.auditLogs.log({
        event: 'wechat.clear.by-admin',
        actorUserId: currentUser.id,
        actorRoleSnap: currentUser.role,
        resourceType: 'user',
        resourceId: id,
        meta: auditMeta,
        before: { openid: maskOpenid(target.openid as string) },
        tx,
      });

      return updated;
    });
  }

  // DELETE /api/admin/v1/users/:id/phone(⑦):管理员清除绑定(解除绑定唯一路径,§7)。
  // rbac.can('user.phone.clear')(绑 ops-admin,评审稿 E-3)+ assertCanManageUser 既有护栏;
  // 软删用户统一 USER_NOT_FOUND(沿 §7.8);**幂等**(E-19):目标无 phone → 200 不报错,
  // 且仅实际清除时写 audit。
  async clearUserPhone(
    currentUser: CurrentUserPayload,
    id: string,
    auditMeta: AuditMeta,
  ): Promise<UserResponseDto> {
    await this.assertCanOrThrow(currentUser, 'user.phone.clear');

    const target = await this.prisma.user.findFirst({
      where: this.notDeletedWhere({ id }),
      select: { id: true, role: true, status: true, phone: true },
    });
    if (!target) throw new BizException(BizCode.USER_NOT_FOUND);
    this.assertCanManageUser(currentUser, target);

    if (target.phone === null) {
      return this.findByIdOrThrow(id);
    }

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.user.update({
        where: { id },
        data: { phone: null, phoneVerifiedAt: null },
        select: userSafeSelect,
      });

      await this.auditLogs.log({
        event: 'phone.clear.by-admin',
        actorUserId: currentUser.id,
        actorRoleSnap: currentUser.role,
        resourceType: 'user',
        resourceId: id,
        meta: auditMeta,
        before: { phone: maskPhone(target.phone as string) },
        tx,
      });

      return updated;
    });
  }
}
