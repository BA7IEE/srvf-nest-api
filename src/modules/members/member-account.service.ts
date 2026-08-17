import {
  BCRYPT_SALT_ROUNDS,
  MemberAccessService,
  auditCtx,
  type PrismaTx,
} from './member-access.service';
import { Injectable } from '@nestjs/common';
import { MemberStatus, Role, UserStatus } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import * as bcrypt from 'bcryptjs';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { notDeletedWhere } from '../../common/prisma/soft-delete.util';
import { PrismaService } from '../../database/prisma.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { lockAuthSessionUser } from '../auth/auth-session-lock';
import { AuthzService } from '../authz/authz.service';
import { LastAdminProtectionPolicy } from '../permissions/last-admin-protection.policy';
// T4(D-WC-10):撤销原语归 users(见该文件头注「为什么落在 users 而不是 wecom」)。
// 纯 tx 函数,与既有 `auth/auth-session-lock` 同型 —— 不注入 UsersService、不产生模块环。
import { revokeActiveWecomIdentityInTx } from '../users/wecom-identity-revoke';
import {
  BindMemberAccountDto,
  BulkGrantAccountResultItemDto,
  BulkGrantMemberAccountsDto,
  BulkGrantMemberAccountsResponseDto,
  BulkGrantSummaryDto,
  GrantMemberAccountDto,
  GrantMemberAccountResponseDto,
  MemberResponseDto,
  UpdateMemberAccountStatusDto,
} from './members.dto';
import {
  lockLinkedUserLifecycle,
  lockMemberLifecycle,
  lockLiveUserLifecycle,
} from './member-lifecycle-lock';
import { MemberAuditRecorder } from './member-audit-recorder';
import { attachAccountInfo } from './members.presenter';

/*
 * 队员**账号生命周期族**(Phase 6-B 第三域第五刀,§3.2)。
 *
 * 六个入口 + 两个内核:开通(单个 / 批量)· 绑定 · 解绑 · 重开 · 状态变更,
 * 外加用户名生成与 grant 内核。它们共享同一组不变量:
 * 一个 Member 至多一个活跃 User、用户名按 memberNo 派生且冲突时递增、
 * 每次变更都落 audit,且账号状态与 Member 状态不得互相漂移。
 *
 * ⚠️ grantAccountCore / offboardCore 这类 "Core" 后缀是**被调用方**约定:
 * 调用方已持锁,Core 自己不再取锁。挪动调用位置会静默破坏锁序,
 * 且不会有任何编译错或单测失败 —— 锁序台账在主 service 文件头(单点)。
 *
 * ⚠️ 判权与 Member 回读经 this.members(主 service 的共享前置),
 * 调用点仍在本类各方法体内 —— 不接受「上游已判过」的入参。
 */
@Injectable()
export class MemberAccountService {
  constructor(
    private readonly prisma: PrismaService,
    // 多段共用的判权 / Member 回读 / 唯一约束翻译:调用点仍在本类各方法体内。
    private readonly access: MemberAccessService,
    private readonly auditRecorder: MemberAuditRecorder,
    private readonly authz: AuthzService,
    private readonly lastAdminProtection: LastAdminProtectionPolicy,
  ) {}

  // 队员账号闭环 v2(评审稿 §1.2 E-7):username 结构性冲突。User.username 仍是全量
  // @unique(不在本次改造范围,reference/soft-delete-transactions"不复用"铁律),故一旦某 memberNo 曾经
  // 创建过账号(即使已软删,或曾 unbind 成悬空 memberId=null),那条历史/悬空行永久
  // 占用其 username——早期按 count(memberId) 推算"代际"曾在"grant → unbind → 再
  // grant"路径下失灵:unbind 只断链不软删,断链后 count(memberId) 归零而误判"从未
  // 开过号"重取裸 memberNo,100% 撞上那条仍占位的悬空行(队员账号闭环 v2 收尾修复)。
  //
  // 改为直接探测:已用代码验证 login-sms 完全按 phone 解析账号、从不读 username
  // (auth/login-sms.service.ts resolveActiveUserByPhone),故安全地从裸 memberNo 起
  // 依次尝试 `${memberNo}-2`、`${memberNo}-3`……直到找到第一个未被任何 User(含软删、
  // 含悬空 memberId=null)占用的 username 为止——不依赖 memberId,天然覆盖历史行/悬空行
  // 两类占用来源。
  private async computeNextUsername(memberNo: string, tx: PrismaTx): Promise<string> {
    let candidate = memberNo;
    let generation = 2;
    while (await tx.user.findUnique({ where: { username: candidate }, select: { id: true } })) {
      candidate = `${memberNo}-${generation}`;
      generation += 1;
    }
    return candidate;
  }

  // POST /:id/account:给已存在队员开通"手机验证码登录"账号(不设密码)。
  // 建号镜像 recruitment-promotion.service.ts:125-188 先例:随机不可用 passwordHash +
  // username=memberNo + role=USER;不复用 UsersService(防环 + 零漂移,沿 promote 同一先例)。
  //
  // 校验顺序(先业务后唯一性,与本模块 create() 同口径):
  //   1. member 存在且未软删 → 否则 MEMBER_NOT_FOUND
  //   2. member.status === ACTIVE → 否则 MEMBER_INACTIVE
  //   3. 该 memberId 槽位无 live 关联(队员账号闭环 v2:User.memberId 已改 partial unique
  //      WHERE deletedAt IS NULL,槽位仅在 live 时占用;历史软删行不再阻塞——这是对 v1
  //      唯一有意的行为变更,评审稿 D-2)→ 否则 MEMBER_HAS_LINKED_USER
  //   4. username(=memberNo)唯一性预检查含软删占用(沿 reference/soft-delete-transactions 不复用范式)→ 否则 USERNAME_ALREADY_EXISTS
  //   5. phone 唯一性预检查含软删占用 → 否则 PHONE_ALREADY_BOUND
  async grantAccount(
    id: string,
    dto: GrantMemberAccountDto,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<GrantMemberAccountResponseDto> {
    await this.access.assertCanOrThrow(currentUser, 'member.grant.account', { type: 'member', id });
    return this.grantAccountCore(id, dto.phone, currentUser, auditMeta);
  }

  // 队员账号闭环 v2(评审稿 §1.2 E-11):从 grantAccount() 抽出的核心逻辑(校验 + 创建 +
  // audit,不含权限检查),供单条端点与 bulkGrantAccounts() 批量循环共用——批量场景下
  // 权限只需在循环外检查一次,每行仍各自独立开一个事务(E-10,故本方法自己调用
  // `this.prisma.$transaction`,不接受调用方传入的 tx)。
  private async grantAccountCore(
    id: string,
    phone: string,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<GrantMemberAccountResponseDto> {
    return this.prisma.$transaction(async (tx) => {
      await lockMemberLifecycle(tx, id);
      const member = await tx.member.findFirst({
        where: notDeletedWhere({ id }),
        select: { id: true, memberNo: true, status: true },
      });
      if (!member) throw new BizException(BizCode.MEMBER_NOT_FOUND);
      if (member.status !== MemberStatus.ACTIVE) {
        throw new BizException(BizCode.MEMBER_INACTIVE);
      }

      const existingLink = await tx.user.findFirst({
        where: { memberId: id, deletedAt: null },
        select: { id: true },
      });
      if (existingLink) throw new BizException(BizCode.MEMBER_HAS_LINKED_USER);

      // 队员账号闭环 v2(评审稿 §1.2 E-7):该 memberNo 曾有历史行/悬空行(即使已软删
      // 或已 unbind)时,裸 memberNo 这个 username 被占用,探测式自动后缀化;首次开号
      // (v1 常见路径)逐字不变,仍是裸 memberNo。
      const username = await this.computeNextUsername(member.memberNo, tx);

      const existingUsername = await tx.user.findUnique({
        where: { username },
        select: { id: true },
      });
      if (existingUsername) throw new BizException(BizCode.USERNAME_ALREADY_EXISTS);

      const existingPhone = await tx.user.findUnique({
        where: { phone },
        select: { id: true },
      });
      if (existingPhone) throw new BizException(BizCode.PHONE_ALREADY_BOUND);

      // 随机不可用口令(镜像 recruitment-promotion.service.ts:122-127;SMS 登录无密码可强制,
      // v1 不设初始密码入参)。
      const passwordHash = await bcrypt.hash(
        randomBytes(48).toString('base64'),
        BCRYPT_SALT_ROUNDS,
      );
      const now = new Date();

      const created = await this.access.runWithUniqueConstraintGuard(() =>
        tx.user.create({
          data: {
            username,
            phone,
            phoneVerifiedAt: now, // 管理员背书,非用户自证短信验证
            passwordHash,
            role: Role.USER,
            memberId: id,
          },
          select: { id: true, username: true, phone: true, phoneVerifiedAt: true, role: true },
        }),
      );

      await this.auditRecorder.accountGranted(tx, auditCtx(id, currentUser, auditMeta), {
        userId: created.id,
        phone,
      });

      return {
        userId: created.id,
        username: created.username,
        phone: created.phone as string,
        phoneVerifiedAt: created.phoneVerifiedAt as Date,
        role: created.role,
        memberId: id,
      };
    });
  }

  // POST /:id/account/bind:认领一个已存在、live 且未绑定任何队员(memberId=null)的悬空
  // 账号(如 POST admin/v1/users 建的)到本队员。账号保留其原有登录方式(密码 / openid /
  // phone),不改 username / passwordHash,不强制手机号。
  //
  // 校验顺序(评审稿 §5):
  //   1. member 存在且未软删 → 否则 MEMBER_NOT_FOUND
  //   2. member.status === ACTIVE → 否则 MEMBER_INACTIVE
  //   3. 本队员无 live 关联账号 → 否则 MEMBER_HAS_LINKED_USER
  //   4. 目标 userId 存在且未软删 → 否则 USER_NOT_FOUND(跨实体引用复用被引用方 NOT_FOUND,
  //      沿 position-assignments/supervision-assignments 既有范式)
  //   5. 目标账号 memberId === null(未被他人绑定)→ 否则 MEMBER_ACCOUNT_TARGET_ALREADY_LINKED
  async bindAccount(
    id: string,
    dto: BindMemberAccountDto,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<MemberResponseDto> {
    await this.access.assertCanOrThrow(currentUser, 'member.bind.account', { type: 'member', id });

    return this.prisma.$transaction(async (tx) => {
      await lockMemberLifecycle(tx, id);
      const member = await this.access.findMemberOrThrow(id, tx);
      if (member.status !== MemberStatus.ACTIVE) {
        throw new BizException(BizCode.MEMBER_INACTIVE);
      }

      const existingLink = await tx.user.findFirst({
        where: { memberId: id, deletedAt: null },
        select: { id: true },
      });
      if (existingLink) throw new BizException(BizCode.MEMBER_HAS_LINKED_USER);

      const target = await tx.user.findFirst({
        where: notDeletedWhere({ id: dto.userId }),
        select: { id: true, memberId: true, status: true, role: true },
      });
      if (!target) throw new BizException(BizCode.USER_NOT_FOUND);
      await lockLiveUserLifecycle(tx, target.id);
      const lockedTarget = await tx.user.findFirst({
        where: notDeletedWhere({ id: target.id }),
        select: { id: true, memberId: true, status: true, role: true },
      });
      if (!lockedTarget) throw new BizException(BizCode.USER_NOT_FOUND);
      if (lockedTarget.memberId !== null) {
        throw new BizException(BizCode.MEMBER_ACCOUNT_TARGET_ALREADY_LINKED);
      }
      // 第三轮 review 护栏收口(§F&A-1/A-4):只认领 role=USER 且 status=ACTIVE 的悬空账号。
      // 否则可把特权账号(ADMIN/SUPER_ADMIN)经队员轴挂到队员,此后经 updateAccountStatus /
      // reopenAccount 停用/软删它,绕过用户轴 assertNotLastSuperAdmin + assertCanManageUser
      // 两道刻意写死的护栏(报告 §F&A-1 攻击序列)。role 先于 status 判,诊断更精确。
      if (lockedTarget.role !== Role.USER) {
        throw new BizException(BizCode.MEMBER_ACCOUNT_TARGET_ROLE_NOT_ALLOWED);
      }
      if (lockedTarget.status !== UserStatus.ACTIVE) {
        throw new BizException(BizCode.MEMBER_ACCOUNT_TARGET_NOT_ACTIVE);
      }

      const updated = await this.access.runWithUniqueConstraintGuard(() =>
        tx.user.update({
          where: { id: dto.userId },
          data: { memberId: id },
          select: { id: true, status: true },
        }),
      );

      await this.auditRecorder.accountBound(tx, auditCtx(id, currentUser, auditMeta), {
        userId: updated.id,
      });

      return attachAccountInfo(member, { id: updated.id, status: updated.status });
    });
  }

  // POST /:id/account/unbind:只断链(置 memberId=null),不顺手停用/软删账号(D-4 维护者
  // 定稿)。账号回到"悬空 ACTIVE"(= bindAccount 的逆);要停用/删除走既有用户管理端点。
  async unbindAccount(
    id: string,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<MemberResponseDto> {
    await this.access.assertCanOrThrow(currentUser, 'member.bind.account', { type: 'member', id });

    return this.prisma.$transaction(async (tx) => {
      await lockMemberLifecycle(tx, id);
      const member = await this.access.findMemberOrThrow(id, tx);

      await lockLinkedUserLifecycle(tx, id);
      const linked = await tx.user.findFirst({
        where: { memberId: id, deletedAt: null },
        select: { id: true },
      });
      if (!linked) throw new BizException(BizCode.MEMBER_HAS_NO_LINKED_USER);

      await tx.user.update({
        where: { id: linked.id },
        data: { memberId: null },
      });

      await this.auditRecorder.accountUnbound(tx, auditCtx(id, currentUser, auditMeta), {
        userId: linked.id,
      });

      return attachAccountInfo(member, undefined);
    });
  }

  // POST /:id/account/reopen:"账号打错了"一步修复——软删旧号(deletedAt + status=
  // DISABLED)+ 开新号(新手机号),单事务原子;靠 User.memberId 的 partial unique
  // 根改造让新号取到released 槽位。
  //
  // username 结构性冲突(评审稿 §1.2 E-7):User.username 仍是全量 @unique(不在本次
  // 改造范围,reference/soft-delete-transactions"不复用"铁律),旧行软删后仍永久占用其 username——若新行
  // 沿用同一 memberNo 会 100% 撞车。已用代码验证 login-sms 完全按 phone 解析账号、
  // 从不读 username,故重开时安全地用 `${memberNo}-{generation}` 后缀化(第 1 次
  // grant 仍是裸 memberNo,v1 行为逐字不变;仅第 2 次起 reopen 才出现后缀)。
  //
  // 校验顺序(评审稿 §5):
  //   1. member 存在且未软删 → 否则 MEMBER_NOT_FOUND
  //   2. member.status === ACTIVE → 否则 MEMBER_INACTIVE
  //   3. member 有 live 关联账号 → 否则 MEMBER_HAS_NO_LINKED_USER(无账号可重开,应走开号)
  //   4. 新 username 唯一性预检查(理论恒过,防御性保留,沿 grantAccount 同款)
  //   5. phone 唯一性预检查含软删占用(与旧行同手机号会在此命中 PHONE_ALREADY_BOUND——
  //      phone 同样不在本次改造范围,这是有意行为而非缺陷)
  async reopenAccount(
    id: string,
    dto: GrantMemberAccountDto,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<GrantMemberAccountResponseDto> {
    await this.access.assertCanOrThrow(currentUser, 'member.grant.account', { type: 'member', id });

    return this.prisma.$transaction(async (tx) => {
      await this.lastAdminProtection.acquireOpsAdminInvariantLock(tx);
      await lockMemberLifecycle(tx, id);
      const member = await tx.member.findFirst({
        where: notDeletedWhere({ id }),
        select: { id: true, memberNo: true, status: true },
      });
      if (!member) throw new BizException(BizCode.MEMBER_NOT_FOUND);
      if (member.status !== MemberStatus.ACTIVE) {
        throw new BizException(BizCode.MEMBER_INACTIVE);
      }

      const oldLink = await tx.user.findFirst({
        where: { memberId: id, deletedAt: null },
        select: { id: true, role: true },
      });
      if (!oldLink) throw new BizException(BizCode.MEMBER_HAS_NO_LINKED_USER);
      if (!(await lockAuthSessionUser(tx, oldLink.id))) {
        throw new BizException(BizCode.MEMBER_HAS_NO_LINKED_USER);
      }
      const lockedOldLink = await tx.user.findFirst({
        where: { id: oldLink.id, memberId: id, deletedAt: null },
        select: { id: true, role: true },
      });
      if (!lockedOldLink) throw new BizException(BizCode.MEMBER_HAS_NO_LINKED_USER);
      // 第三轮 review 护栏收口(§F&A-1):必须基于 User 锁后快照判断角色，避免并发
      // updateRole 后仍按旧 USER 快照软删特权账号。
      if (lockedOldLink.role !== Role.USER) {
        throw new BizException(BizCode.MEMBER_ACCOUNT_ROLE_NOT_MANAGEABLE);
      }

      // 复用探测式 computeNextUsername:此刻 oldLink 仍 live(软删滞后到下方发生),
      // 其占用的 username 仍未释放,故探测必然跳过该值取到更高代际(-2/-3/...);
      // 裸 memberNo 分支不会在 reopen 路径触发(oldLink 存在本身就证明 memberNo 或
      // 某代际后缀已被占用)。
      const newUsername = await this.computeNextUsername(member.memberNo, tx);

      const existingUsername = await tx.user.findUnique({
        where: { username: newUsername },
        select: { id: true },
      });
      if (existingUsername) throw new BizException(BizCode.USERNAME_ALREADY_EXISTS);

      const existingPhone = await tx.user.findUnique({
        where: { phone: dto.phone },
        select: { id: true },
      });
      if (existingPhone) throw new BizException(BizCode.PHONE_ALREADY_BOUND);

      // 先软删旧行释放 partial unique 槽位,再建新行——顺序不可颠倒(先建会与仍
      // live 的旧行同时违反 partial unique)。
      await this.lastAdminProtection.assertCanDeactivateOpsAdminUser(tx, lockedOldLink.id);
      const revokedAt = new Date();
      await tx.user.update({
        where: { id: lockedOldLink.id },
        data: { deletedAt: revokedAt, status: UserStatus.DISABLED },
      });

      // 企业微信 T4(2026-08-02,D-WC-10):重开 = 旧 User **代际终止**(它已被软删,不会回来),
      // 同事务撤销其 active 企业微信身份。新号**不继承**任何 WecomIdentity ——
      // 身份是"这个账号是谁"的凭据,不是可随账号迁移的属性;新号要用企业微信登录,
      // 得由本人重走一遍绑定(与 D-WC-9「无本人裸解绑、转移只能是清除+重绑」同一形状)。
      // 位置在 refresh 撤销**之前**:锁序 §9.1 固定 `User → WecomIdentity → RefreshToken / Audit`。
      const wecomRevocation = await revokeActiveWecomIdentityInTx(tx, {
        userId: lockedOldLink.id,
        revokedByUserId: currentUser.id,
        revokedAt,
      });

      await tx.refreshToken.updateMany({
        where: { userId: lockedOldLink.id, revokedAt: null, expiresAt: { gt: revokedAt } },
        data: { revokedAt, revokedReason: 'member-account-reopen' },
      });

      const passwordHash = await bcrypt.hash(
        randomBytes(48).toString('base64'),
        BCRYPT_SALT_ROUNDS,
      );
      const now = new Date();

      const created = await this.access.runWithUniqueConstraintGuard(() =>
        tx.user.create({
          data: {
            username: newUsername,
            phone: dto.phone,
            phoneVerifiedAt: now,
            passwordHash,
            role: Role.USER,
            memberId: id,
          },
          select: { id: true, username: true, phone: true, phoneVerifiedAt: true, role: true },
        }),
      );

      await this.auditRecorder.accountReopened(tx, auditCtx(id, currentUser, auditMeta), {
        oldUserId: lockedOldLink.id,
        newUserId: created.id,
        phone: dto.phone,
        // T4 / 冻结稿 §11.3 末条:恒写数值(含 0),与 refreshTokensRevoked 同型。
        wecomIdentitiesRevoked: wecomRevocation.count,
      });

      return {
        userId: created.id,
        username: created.username,
        phone: created.phone as string,
        phoneVerifiedAt: created.phoneVerifiedAt as Date,
        role: created.role,
        memberId: id,
      };
    });
  }

  // PATCH /:id/account/status:队员面直接启停关联账号。判权复用 user.update.status
  // (D-6,不新增权限码)。不复用 UsersService.updateStatus()(该服务 exports 未包含
  // UsersService,沿既有模块边界;本模块对 User 表写入的既定范式就是直连 prisma,
  // 不经 UsersService,镜像 grantAccount"不复用 UsersService,防环 + 零漂移"先例),
  // 改为直连 prisma 显式复刻其唯一必要副作用:禁用时撤销该 user 全部未撤销未过期
  // refresh token(revokedReason='admin-disable',auth-jwt-refresh 联动撤销场景的第二条
  // 触发路径);不做"最后一个 SUPER_ADMIN 保护":队员轴只管理 role=USER 的关联账号——下方
  // 前置校验 linked.role===USER 拒非 USER(bind 亦只认领 role=USER+ACTIVE 悬空账号,
  // grant/reopen 恒建 role=USER),故非 USER(含唯一能触发 last-SA 保护的 SUPER_ADMIN)在
  // 到达这里前已被挡下(第三轮 review §F&A-1 收口;原注释"bind/grant/reopen 恒 role=USER"
  // 的前提对 bind 不成立——bind 挂的是既有任意角色账号,故以前置校验替代该失效前提);
  // 仅当置 DISABLED 时做自我保护检查(镜像 UsersService.updateStatus,
  // 防管理员通过队员轴误禁自己绑定的账号)。第七刀补齐本入口的结构化审计:
  // user status 写、refresh 撤销与 member.account.status-change 必须同事务提交 / 回滚。
  async updateAccountStatus(
    id: string,
    dto: UpdateMemberAccountStatusDto,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<MemberResponseDto> {
    await this.access.assertCanOrThrow(currentUser, 'user.update.status', { type: 'member', id });

    return this.prisma.$transaction(async (tx) => {
      if (dto.status === UserStatus.DISABLED) {
        await this.lastAdminProtection.acquireOpsAdminInvariantLock(tx);
      }
      await lockMemberLifecycle(tx, id);
      const member = await this.access.findMemberOrThrow(id, tx);

      const linked = await tx.user.findFirst({
        where: { memberId: id, deletedAt: null },
        select: { id: true, status: true, role: true },
      });
      if (!linked) throw new BizException(BizCode.MEMBER_HAS_NO_LINKED_USER);
      if (!(await lockAuthSessionUser(tx, linked.id))) {
        throw new BizException(BizCode.MEMBER_HAS_NO_LINKED_USER);
      }
      const lockedLinked = await tx.user.findFirst({
        where: { id: linked.id, memberId: id, deletedAt: null },
        select: { id: true, status: true, role: true },
      });
      if (!lockedLinked) throw new BizException(BizCode.MEMBER_HAS_NO_LINKED_USER);

      // 第三轮 review 护栏收口(§F&A-1):队员轴只启停 role=USER 的关联账号。若该账号经用户轴
      // updateRole 被提权(如提为 ADMIN),停用它会绕过用户轴 assertCanManageUser /
      // assertNotLastSuperAdmin——非 USER 一律拒,提示走用户管理端点。前置于自我保护检查:
      // "此账号不归本轴管理"是更根本的判定。
      if (lockedLinked.role !== Role.USER) {
        throw new BizException(BizCode.MEMBER_ACCOUNT_ROLE_NOT_MANAGEABLE);
      }

      if (dto.status === UserStatus.ACTIVE && member.status !== MemberStatus.ACTIVE) {
        throw new BizException(BizCode.MEMBER_INACTIVE);
      }

      if (dto.status === UserStatus.DISABLED) {
        if (lockedLinked.id === currentUser.id) {
          throw new BizException(BizCode.CANNOT_OPERATE_SELF);
        }
        await this.lastAdminProtection.assertCanDeactivateOpsAdminUser(tx, lockedLinked.id);
      }

      const updated = await tx.user.update({
        where: { id: lockedLinked.id },
        data: { status: dto.status },
        select: { id: true, status: true },
      });

      let refreshTokensRevoked = 0;
      if (dto.status === UserStatus.DISABLED) {
        const revoked = await tx.refreshToken.updateMany({
          where: { userId: lockedLinked.id, revokedAt: null, expiresAt: { gt: new Date() } },
          data: { revokedAt: new Date(), revokedReason: 'admin-disable' },
        });
        refreshTokensRevoked = revoked.count;
      }

      await this.auditRecorder.accountStatusChanged(tx, auditCtx(id, currentUser, auditMeta), {
        beforeStatus: lockedLinked.status,
        afterStatus: updated.status,
        linkedUserId: updated.id,
        refreshTokensRevoked,
      });

      return attachAccountInfo(member, { id: updated.id, status: updated.status });
    });
  }

  // POST members/accounts/bulk-grant:批量开号,镜像 announcement-import 批模式。
  // 权限只在循环外检查一次;逐行调用 grantAccountCore(各自独立 $transaction,E-10)——
  // 单行失败(BizException)不影响其余行,记 blocked + 原因继续;非 BizException 的
  // 意外错误原样上抛,不吞入批量结果(与既有 P2002 兜底"未映射 target 原样上抛"同一原则)。
  async bulkGrantAccounts(
    dto: BulkGrantMemberAccountsDto,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<BulkGrantMemberAccountsResponseDto> {
    const scope = await this.authz.getVisibleOrganizationScope(currentUser, 'member.grant.account');
    if (!scope.hasPermission) {
      throw new BizException(BizCode.RBAC_FORBIDDEN);
    }

    const items: BulkGrantAccountResultItemDto[] = [];
    for (const item of dto.items) {
      try {
        await this.access.assertCanOrThrow(currentUser, 'member.grant.account', {
          type: 'member',
          id: item.memberId,
        });
        const result = await this.grantAccountCore(
          item.memberId,
          item.phone,
          currentUser,
          auditMeta,
        );
        items.push({
          memberId: item.memberId,
          status: 'ok',
          userId: result.userId,
          reason: null,
        });
      } catch (err) {
        if (!(err instanceof BizException)) throw err;
        items.push({
          memberId: item.memberId,
          status: 'blocked',
          userId: null,
          reason: err.biz.message,
        });
      }
    }

    const summary: BulkGrantSummaryDto = {
      total: items.length,
      ok: items.filter((i) => i.status === 'ok').length,
      blocked: items.filter((i) => i.status === 'blocked').length,
    };

    return { items, summary };
  }
}
