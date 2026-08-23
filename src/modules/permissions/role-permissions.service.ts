import { Injectable } from '@nestjs/common';
import { Role } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { notDeletedWhere } from '../../common/prisma/soft-delete.util';
import { PrismaService } from '../../database/prisma.service';
import type { AuditLogEvent, AuditMeta } from '../audit-logs/audit-logs.types';
import { writeConfigAudit } from './config-audit.util';
import { permissionSelect } from './permissions.select';
import { isProtectedRoleCode } from './protected-role-codes';
import { RbacService } from './rbac.service';
import { RbacRoleDetailResponseDto } from './rbac-roles.dto';
import { rbacRoleSelect } from './rbac-roles.select';
import { AssignRolePermissionsDto, ReplaceRolePermissionsDto } from './role-permissions.dto';
import {
  isControlPlanePermissionCode,
  isReservedSuperAdminOnlyPermissionCode,
} from './role-delegation.policy';

// V2.x C-6 RBAC 实施 PR #4:RolePermission 关联表业务逻辑。
// 沿 D7 v1.1 §5.1 端点 10-11 + §6.1 + 用户拍板。
//
// 3 个端点:
//   POST   /api/system/v1/roles/:id/permissions       批量授权(幂等;入参 permissionCodes[])
//   DELETE /api/system/v1/roles/:id/permissions/:permissionId  撤权(精确;路径 permissionId)
//   PUT    /api/system/v1/roles/:id/permissions       整集替换(P1-32 PR 4a;带 expectedRevision)
//
// 🔴 **三条端点、一条写原语**(P1-32 PR 4a,2026-08-23):
//    `replaceRolePermissionSet()` 是**唯一**会改写 role_permissions 的地方,
//    `assign()` / `revoke()` / `replace()` 全部经它落库。
//    留两条写路径就是「一侧有闸、另一侧裸奔」—— 那是本仓反复吃亏的形态
//    (E-B1 #1115、E-B2 的授撤不对称都是同族),所以旧 POST / DELETE 的内部改造
//    **必须与新 PUT 同刀**,不能推到下一刀。
//
// 🔴 **行锁与版本号不是给现状补的洞,是 `PUT` 这个新语义自带的必需品**:
//    旧 `POST`(加码)与 `DELETE`(减码)在语义上**可交换** —— 两个管理员同时各加一条码,
//    结果是两条都在,谁的改动都没丢。整集替换**不是**:它是「读现状 → 算目标 → 整体写回」,
//    两个并发替换会后写覆盖先写,先写那次的改动**静默消失**而两边都拿到 200。
//    ⇒ 别把本刀读成「原来一直有并发 bug」;是新语义把窗口带进来,同一刀把它焊死。
//
// 出参统一返 RbacRoleDetailResponseDto(沿 PR #3 rbac-roles 详情接口):
// - 调用者一次拿到该角色当前完整 permissions 列表,前端"保存当前选中"语义友好
// - 与 GET /api/system/v1/roles/:id 形成一致的 detail 输出契约
//
// **30003 vs 30005**(沿 PR #3 RbacRole 范式):
// - role 不存在 → 30003
// - role 已软删 → 30005(GET-like 操作披露)
//   注:授权 / 撤权属于写操作,
//      严格按 docs/reference/soft-delete-transactions.md §10 信息泄漏防御应统一 30003;
//        但 D7 §6.1 决议"运营管理员管 role_permissions",意味着调用者本来就掌握角色明细;
//        披露"角色已软删"无信息泄漏风险(管理者已知角色 id 存在),沿 detail 接口语义返 30005,
//        让前端能精确提示"该角色已删除,请先恢复或重建"。
//
// **30001 / 30011 区分**:
// - permission code / id 不存在 → 30001 PERMISSION_NOT_FOUND
// - (roleId, permissionId) 关系不存在(撤权时)→ 30011 ROLE_PERMISSION_NOT_FOUND

@Injectable()
export class RolePermissionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rbac: RbacService,
  ) {}

  // ============ helpers ============

  // P0-F PR-1:RBAC 元接口判权(沿 attachments F5 v1.0 范本)。
  private async assertCanOrThrow(user: CurrentUserPayload, action: string): Promise<void> {
    if (!(await this.rbac.can(user, action))) {
      throw new BizException(BizCode.RBAC_FORBIDDEN);
    }
  }

  // 第一档安全收口 D2:role-permission 分级闸 —— 控制面权限码
  // (7 条 SA-only 保留码 + rbac.* + role-binding.*)的角色映射不得被随意改动。
  //
  // 这组保留码在 seed 中有意不绑 biz-admin / ops-admin;
  // assign() 原先只判 `rbac.role-permission.create`,未阻止持 ops-admin 者把保留码
  // 自授给某角色再绑到自己身上,间接获得 SA-only 能力(授权越权洞)。
  //
  // 🔴 **本方法是授、撤两侧共用的唯一闸**(第六轮评审 E-B2,2026-08-21)。
  //    E-B2 前 revoke() 一个控制面判定都没有:非 SA 授不了控制面码,却可以**撤** ——
  //    包括把某个角色的 rbac.* / role-binding.* 权限撤空。damage 方向相反但同属
  //    「控制面权限映射被非 SA 改动」,和授码是同一条不变量的两条腿。
  //    这与刚修完的 E-B1(#1115)同属一个缺陷家族:**一侧有闸、另一侧没有**。
  //    机器执法见同目录 role-permissions-control-plane-gate.spec.ts —— 该判据动态现取
  //    本类所有会改写 rolePermission 映射的公开方法,逐个要求能到达本闸,漏一个即红。
  //    (共用 ≠ 两侧判定全等:保留码在授侧对 SUPER_ADMIN 也拒,见下面第 2 层。)
  //
  // 🔴 **两层口径,别混成一层**(P1-32 PR 3a,2026-08-23):
  //
  //   第 1 层 · 非 SUPER_ADMIN → 控制面码一律拒(`30103`)。授、撤两侧同口径,
  //     语义**一字未变**(E-B2 收口后就是这样)。
  //
  //   第 2 层 · 那 7 条 SA-only 保留码,**授码侧连 SUPER_ADMIN 也拒**(`30109`)。
  //     沿维护者 2026-08-22 拍板②「一条都不该进任何角色」:把保留码写进某角色的
  //     role_permissions,就是让**持有该角色的非 SA** 永久拥有 SA-only 能力 ——
  //     由谁按下按钮不改变结果。SA 依然能用 SA 身份直接做那些操作(走身份短路,
  //     根本不查 role_permissions),所以关掉的是「沉淀成角色常驻权限」这条路,
  //     **不是削 SA 的权**。
  //
  //   ⚠️ **第 2 层只覆盖保留码,不覆盖 `rbac.*` / `role-binding.*` 前缀族。**
  //      前缀族里有 `rbac.permission.read`、`role-binding.read.record` 这类纯只读码,
  //      拍板②说的是「7 条保留码」,没说过要禁掉它们;把 SA 也拦住会当场取消
  //      「SUPER_ADMIN 建一个 RBAC 只读观察员角色」这个能力,并打掉
  //      rbac-multi-instance-consistency e2e 赖以证明「权限解析直读 DB」的那条授权。
  //      (起草本刀时我把两者当成一回事,CI 上那条 e2e 是发现它的唯一信号。)
  //
  //   ⚠️ **撤码侧刻意没有第 2 层**:seed 出来的角色本就不含保留码
  //      (P1-32 PR 0 实测交集为 0),保留 SA 可撤是给**历史脏数据**留唯一清理路。
  //      两侧不同**不是漏改** —— 收死之后最后一条清理入口就没了。
  //
  // 设计:在权限码(已去重)字符串层面拦截;命中即整批拒绝(不部分写入),
  // 与 30001 整批拒绝语义一致。assign() 收 codes,故能**早于** Permission 存在性查询
  // 拦下 —— 即便保留码尚未 seed,也拿拒绝码(fail-close,不退化成 30001 泄漏存在性)。
  private assertControlPlaneCodesOrThrow(
    user: CurrentUserPayload,
    uniqueCodes: string[],
    direction: 'grant' | 'revoke',
  ): void {
    // 第 1 层:非 SA 碰控制面码即拒(两侧同口径,行为未变)。
    if (user.role !== Role.SUPER_ADMIN) {
      if (uniqueCodes.some(isControlPlanePermissionCode)) {
        throw new BizException(BizCode.PERMISSION_RESERVED_SUPER_ADMIN_ONLY);
      }
      return;
    }
    // 第 2 层:SA 也不得把保留码沉淀成角色常驻权限(仅授码侧)。
    if (direction === 'grant' && uniqueCodes.some(isReservedSuperAdminOnlyPermissionCode)) {
      throw new BizException(BizCode.RESERVED_PERMISSION_NOT_ROLE_GRANTABLE);
    }
  }

  // 沿 PR #3 rbac-roles 范式:区分不存在(30003)vs 已软删(30005);
  // 写操作(授权/撤权)沿 D7 §6.1 决议管理者已知角色明细 → 披露 30005 不构成信息泄漏。
  //
  // P1-32 PR 3a(2026-08-23)起本 helper 还是**系统内置角色只读**闸的落点:
  // 内置角色的权限映射由 seed 定义(org-readonly / group-readonly 更是从正职角色**派生**的),
  // 运行时增删要么被下次 seed 覆盖,要么造出与派生链打架的第二份真相 ⇒ 一律 30108,
  // **SUPER_ADMIN 也拒**(与角色删除保护 30104 同语义)。
  //
  // 闸放在这里而不是 assign()/revoke() 各写一遍:两条写路径本来就都要先取这一行,
  // 收在同一个 helper 里,新增写方法只要照抄这一句就同时拿到三件事(存在 / 未软删 / 可改)。
  private async assertRoleMutableOrThrow(roleId: string): Promise<void> {
    const raw = await this.prisma.rbacRole.findUnique({
      where: { id: roleId },
      select: { id: true, code: true, deletedAt: true },
    });
    this.assertRoleRowMutableOrThrow(raw);
  }

  // 上面那个 helper 的**判定本体**,拆出来的唯一理由:替换原语必须在**取到行锁之后**
  // 用**事务客户端 `tx`** 复读同一行再判一次(P1-32 PR 4a)。
  //
  // 🔴 为什么不能直接在事务里调 `assertRoleMutableOrThrow`:它用的是 `this.prisma`,
  //    那是**另一条连接**,查询跑在事务外 —— 读到的是别人已提交的世界,而不是本事务
  //    锁住的那一行。「锁前读 + 锁后用」等于没锁(wecom-settings S1 就是这么破的)。
  //
  // 三个拒绝码与拆分前逐字一致;闸仍锚在共享谓词 `isProtectedRoleCode()` 上
  // (可达性判据跟 `this.<x>()` 传递闭包,两跳照样认得出)。
  private assertRoleRowMutableOrThrow<T extends { code: string; deletedAt: Date | null }>(
    row: T | null,
  ): T {
    if (!row) throw new BizException(BizCode.ROLE_NOT_FOUND);
    if (row.deletedAt !== null) throw new BizException(BizCode.ROLE_DELETED);
    if (isProtectedRoleCode(row.code)) {
      throw new BizException(BizCode.PROTECTED_ROLE_PERMISSION_CHANGE_FORBIDDEN);
    }
    return row;
  }

  // 查角色详情(含 permissions 数组),复用 rbac-roles.service 同形态;
  // 但这里不抛 30005(已通过 assertRoleMutableOrThrow 拦掉),只查活跃角色。
  private async buildDetailResponse(roleId: string): Promise<RbacRoleDetailResponseDto> {
    const role = await this.prisma.rbacRole.findFirst({
      where: notDeletedWhere({ id: roleId }),
      select: rbacRoleSelect,
    });
    if (!role) throw new BizException(BizCode.ROLE_NOT_FOUND);

    const rolePermissions = await this.prisma.rolePermission.findMany({
      where: { roleId },
      select: { permission: { select: permissionSelect } },
      orderBy: { createdAt: 'asc' },
    });
    return {
      ...role,
      permissions: rolePermissions.map((rp) => rp.permission),
    };
  }

  // ============ 唯一写原语(P1-32 PR 4a)============

  /**
   * 🔴 **唯一**会改写 `role_permissions` 的地方 —— 三条公开写路径全部经它落库。
   *
   * 一次调用做完 6 件事,全在**同一个事务**里:
   *   ① `SELECT … FOR UPDATE` 锁**角色行**;
   *   ② 锁后复读角色行(存在 / 未软删 / 非内置)与 `permissionRevision`;
   *   ③ `expectedRevision` 比对(不符 → 30111);
   *   ④ 算差集 → 相同则 no-op(不写、不 +1、不留痕);
   *   ⑤ 按**方向**过控制面闸(增走 grant / 减走 revoke),再删增写;
   *   ⑥ `permissionRevision + 1` 与 audit。
   *
   * ⚠️ **锁的是角色行,不是权限行**。锁 `role_permissions` 的行只能挡住「改同一条映射」,
   *    挡不住「A 删了 x 加了 y、B 删了 y 加了 z」这类**并发替换交错** ——
   *    整集替换的临界区是「这个角色的权限集」,临界区的看门人只能是角色行。
   *
   * ⚠️ 差集必须在**锁内**算:锁外算出来的 added/removed 是基于可能已过期的现状,
   *    照它写回去就是把别人刚提交的改动悄悄回滚。
   *
   * 🔴 **为什么入参是「意图」不是「目标全集」**(这一条别改回去):
   *    旧 `POST` / `DELETE` 是**增量**语义 —— 「加这几条」「减这一条」,其余一律不动。
   *    若让它们在锁**外**先读一遍现状、算出目标全集再交进来,那份快照会在锁等待期间过期,
   *    于是「减掉 x」就顺手把别人刚加的 y 一起抹掉 —— 本刀本来是来消灭丢更新的,
   *    那样写反而给两条旧路径**各造一个新的**。所以增量意图必须原样传进来,
   *    由原语在**锁内**与真实现状合成目标集。
   *    `PUT` 的 `set` 相反:调用者的全集**就是**权威,它的过期风险由 `expectedRevision` 兜。
   *
   * @param audit 由调用方按入口构造事件与 extra —— 旧 POST / DELETE 的 audit 形状被
   *              `permissions-config-audit-characterization` B1/B2 逐字钉着,统一原语
   *              **不等于**统一事件名,那两处必须原样保留。
   */
  private async replaceRolePermissionSet(
    user: CurrentUserPayload,
    roleId: string,
    input: {
      /**
       * 写意图(码已去重):
       * - `set`    整集替换 —— 提交后权限集**恰好**是 `codes`(PUT)
       * - `add`    并入 —— 目标 = 锁内现状 ∪ `codes`(POST,增量语义不变)
       * - `remove` 摘除 —— 目标 = 锁内现状 \ `codes`(DELETE,增量语义不变)
       */
      intent: { kind: 'set' | 'add' | 'remove'; codes: string[] };
      /** 乐观并发期望值;`null` = 不做版本校验(旧 POST / DELETE 的既有语义,契约不变)。 */
      expectedRevision: number | null;
      audit: (delta: {
        addedCodes: string[];
        removedCodes: string[];
        resultCodes: string[];
        fromRevision: number;
        toRevision: number;
      }) => { event: AuditLogEvent; extra: Record<string, unknown> };
    },
    meta: AuditMeta,
  ): Promise<RbacRoleDetailResponseDto> {
    // 1. 事务外快检:角色存在 / 未软删 / 非内置(→ 30003 / 30005 / 30108)。
    //    事务内还会**再判一次**(见 helper 头部);这里先判是为了在开事务前就给出稳定错误码。
    await this.assertRoleMutableOrThrow(roleId);

    // 2. 意图里的码 → Permission 行;**任一 code 不存在 → 30001**(整批拒绝,不部分成功)。
    const intentPerms = await this.prisma.permission.findMany({
      where: { code: { in: input.intent.codes } },
      select: { id: true, code: true },
    });
    if (intentPerms.length !== input.intent.codes.length) {
      throw new BizException(BizCode.PERMISSION_NOT_FOUND);
    }

    await this.prisma.$transaction(async (tx) => {
      // 3. 🔴 角色行锁 —— 并发替换在这里排队。表名是 @@map 后的物理名 "roles"。
      await tx.$queryRaw`SELECT id FROM "roles" WHERE id = ${roleId} FOR UPDATE`;

      // 4. 锁后复读:锁等待期间前一个写者可能已软删角色 / 已把 revision +1。
      const locked = this.assertRoleRowMutableOrThrow(
        await tx.rbacRole.findUnique({
          where: { id: roleId },
          select: { code: true, deletedAt: true, permissionRevision: true },
        }),
      );

      // 5. 乐观并发:期望值与锁内真值不符 → 整批拒绝,一个字节都不写。
      if (input.expectedRevision !== null && input.expectedRevision !== locked.permissionRevision) {
        throw new BizException(BizCode.ROLE_PERMISSION_REVISION_CONFLICT);
      }

      // 6. 锁内取现状 → 与意图合成目标集 → 按 **permissionId 集合**算差集
      //    (比集合不比计数:计数相等会掩盖「换掉一条」这种内容互换)。
      const current = await tx.rolePermission.findMany({
        where: { roleId },
        select: { permissionId: true, permission: { select: { code: true } } },
      });
      const currentCodeById = new Map(
        current.map((row) => [row.permissionId, row.permission.code]),
      );
      const targetCodeById = new Map<string, string>(
        input.intent.kind === 'set' ? [] : currentCodeById,
      );
      for (const perm of intentPerms) {
        if (input.intent.kind === 'remove') targetCodeById.delete(perm.id);
        else targetCodeById.set(perm.id, perm.code);
      }
      const addedIds = [...targetCodeById.keys()].filter((id) => !currentCodeById.has(id));
      const removedIds = [...currentCodeById.keys()].filter((id) => !targetCodeById.has(id));

      // 7. no-op:目标集合与现状**相同** → 不写、不 +1、不产生 audit。
      //    (空转不是变更,给它记一条 audit 等于往审计流里灌噪声;`updatedAt` 同理不动。)
      if (addedIds.length === 0 && removedIds.length === 0) return;

      // 8. D2 分级闸,**按方向各判各的**:进来的码走 grant、出去的码走 revoke。
      //    没动的码不判 —— 判了会把「这次没碰它」误伤成越权(非 SA 改自定义角色里
      //    早就存在的 rbac.* 之外的码时会当场炸)。反过来任何**真的**改动都落在差集里,
      //    所以按差集判**不比**按全集判弱。两个方向的口径差(SA 撤得动保留码、授不动)
      //    由 `assertControlPlaneCodesOrThrow` 自己承担,这里不复刻判定。
      const addedCodes = addedIds.map((id) => targetCodeById.get(id) as string);
      const removedCodes = removedIds.map((id) => currentCodeById.get(id) as string);
      this.assertControlPlaneCodesOrThrow(user, addedCodes, 'grant');
      this.assertControlPlaneCodesOrThrow(user, removedCodes, 'revoke');

      if (removedIds.length > 0) {
        // eslint-disable-next-line no-restricted-syntax -- 角色-权限关联表(纯连接表),解绑即物理删除
        await tx.rolePermission.deleteMany({
          where: { roleId, permissionId: { in: removedIds } },
        });
      }
      if (addedIds.length > 0) {
        await tx.rolePermission.createMany({
          data: addedIds.map((permissionId) => ({ roleId, permissionId })),
          skipDuplicates: true,
        });
      }

      // 9. revision +1 —— 与映射写入**同一事务**,要么一起生效要么一起回滚。
      //    顺带把角色行的 `updatedAt` 也带上了(@updatedAt),这是**刻意接受**的:
      //    权限集是这个角色的配置,改了它说这个角色变了并不冤。
      const bumped = await tx.rbacRole.update({
        where: { id: roleId },
        data: { permissionRevision: { increment: 1 } },
        select: { permissionRevision: true },
      });

      const { event, extra } = input.audit({
        addedCodes,
        removedCodes,
        resultCodes: [...targetCodeById.values()],
        fromRevision: locked.permissionRevision,
        toRevision: bumped.permissionRevision,
      });
      await writeConfigAudit(tx, {
        event,
        actor: user,
        resourceType: 'role_permission',
        resourceId: roleId,
        meta,
        extra,
      });
    });

    // 10. 返回该角色当前完整 detail(含最新 permissions 与 permissionRevision)
    return this.buildDetailResponse(roleId);
  }

  // ============ 3 端点 ============

  async assign(
    user: CurrentUserPayload,
    roleId: string,
    dto: AssignRolePermissionsDto,
    meta: AuditMeta,
  ): Promise<RbacRoleDetailResponseDto> {
    await this.assertCanOrThrow(user, 'rbac.role-permission.create');
    // 1. role 必须存在 + 未软删 + 不是系统内置角色(内置角色只读 → 30108)
    await this.assertRoleMutableOrThrow(roleId);

    //    去重处理:即使 DTO 重复传同一 code 也能正常工作
    const uniqueCodes = Array.from(new Set(dto.permissionCodes));

    // 2. D2 分级闸:控制面权限码不得沉淀成任何角色的常驻权限(SUPER_ADMIN 也拒;
    //    早于 Permission 存在性查询;命中即整批拒绝)
    this.assertControlPlaneCodesOrThrow(user, uniqueCodes, 'grant');

    // 3. 交给唯一写原语。**增量意图**(`add`)原样传进去,由它在锁内与真实现状合成目标集 ——
    //    绝不能在这里先读一遍现状算并集,那份快照会在锁等待期间过期,
    //    等于给 POST 造一个它本来没有的丢更新窗口(见原语头部「为什么入参是意图」)。
    //    幂等仍然成立:已存在的码合进去之后不在差集里,不写、不 +1、不留痕。
    //
    //    `expectedRevision: null` —— POST 的对外契约里没有版本号字段,不能凭空给它加一道
    //    「不带版本号就拒」的闸(那是破坏性变更)。它仍然拿到行锁带来的串行化,
    //    只是不做乐观校验。
    return this.replaceRolePermissionSet(
      user,
      roleId,
      {
        intent: { kind: 'add', codes: uniqueCodes },
        expectedRevision: null,
        // audit 形状**逐字**保持 PR #4 原样(characterization B1 钉着 operation /
        // permissionCodes / requestedCount 三项):记的是**这次请求要的码**,不是差集。
        audit: () => ({
          event: 'role-permission.grant',
          extra: {
            operation: 'grant',
            permissionCodes: uniqueCodes,
            requestedCount: uniqueCodes.length,
          },
        }),
      },
      meta,
    );
  }

  async revoke(
    user: CurrentUserPayload,
    roleId: string,
    permissionId: string,
    meta: AuditMeta,
  ): Promise<RbacRoleDetailResponseDto> {
    await this.assertCanOrThrow(user, 'rbac.role-permission.delete');
    // 1. role 必须存在 + 未软删 + 不是系统内置角色(内置角色只读 → 30108)
    await this.assertRoleMutableOrThrow(roleId);

    // 2. permission 必须存在(顺带取 code —— 分级闸判的是码,不是 id)
    const perm = await this.prisma.permission.findUnique({
      where: { id: permissionId },
      select: { id: true, code: true },
    });
    if (!perm) throw new BizException(BizCode.PERMISSION_NOT_FOUND);

    // 3. D2 分级闸:非 SUPER_ADMIN 不得撤销控制面权限码;SA 仍可撤(清理历史脏数据)。
    //    与 assign() 复用**同一个** assertControlPlaneCodesOrThrow,不另造判定;
    //    差别只在 direction —— 见该 helper 头部对「为什么两侧不对称」的说明。
    //    ⚠️ 与 assign 的唯一次序差:assign 的入参本来就是 codes,可在存在性查询前拦;
    //    revoke 的路径参数是 permissionId,不查库拿不到 code,只能先查后判。这不是漏拦 ——
    //    permissionId 不存在时本就无绑定可撤,先返 30001 不缩小闸的覆盖面。
    this.assertControlPlaneCodesOrThrow(user, [perm.code], 'revoke');

    // 4. 关系必须存在(不存在 → 30011)。沿既有"先查再操作"范式,契约一字不变。
    const existing = await this.prisma.rolePermission.findUnique({
      where: { roleId_permissionId: { roleId, permissionId } },
      select: { id: true },
    });
    if (!existing) {
      throw new BizException(BizCode.ROLE_PERMISSION_NOT_FOUND);
    }

    // 5. 交给唯一写原语。同样是**增量意图**(`remove`):只摘这一条,其余锁内现状原样保留 ——
    //    若在这里把"现状减一条"算成目标全集交进去,并发时会把别人刚授的码一起抹掉。
    //    ⚠️ 上面那次存在性检查在锁**外**,理论上存在"检查后、取锁前被别人撤掉"的窗口:
    //       那种情况下差集为空 → no-op(200 + 当前 detail),而不是 P2025 500。
    //       这是**改善**,不是漏判 —— 目标状态("这条没了")已经达成。
    return this.replaceRolePermissionSet(
      user,
      roleId,
      {
        intent: { kind: 'remove', codes: [perm.code] },
        expectedRevision: null,
        // audit 形状**逐字**保持 PR #4 原样(characterization B2 钉着 operation / permissionId)。
        audit: () => ({
          event: 'role-permission.revoke',
          extra: { operation: 'revoke', permissionId },
        }),
      },
      meta,
    );
  }

  /**
   * P1-32 PR 4a:整集替换(`PUT /api/system/v1/roles/:id/permissions`)。
   *
   * 与 POST / DELETE 的差别只有两处,其余(角色三态闸、控制面两层闸、单事务 audit)完全同源:
   *   - 语义是 `set` 而不是增量 —— 提交后该角色的权限**恰好**是 `permissionCodes`;
   *   - `expectedRevision` **必填** —— 整集替换是读-改-写,不带版本号就是允许后写覆盖先写。
   *
   * 判权要**两个**码:一次替换可能同时授与撤,只拿 `create` 就能撤权、只拿 `delete`
   * 就能授权,都是把另一半闸绕过去。
   */
  async replace(
    user: CurrentUserPayload,
    roleId: string,
    dto: ReplaceRolePermissionsDto,
    meta: AuditMeta,
  ): Promise<RbacRoleDetailResponseDto> {
    await this.assertCanOrThrow(user, 'rbac.role-permission.create');
    await this.assertCanOrThrow(user, 'rbac.role-permission.delete');
    // 1. role 必须存在 + 未软删 + 不是系统内置角色(内置角色只读 → 30108)
    await this.assertRoleMutableOrThrow(roleId);

    const uniqueCodes = Array.from(new Set(dto.permissionCodes));

    // 2. D2 分级闸(授码方向,判**目标全集**)—— 与 assign() 完全同一句,连次序都一样:
    //    入参本来就是 codes,所以能**早于** Permission 存在性查询拦下,
    //    保留码即便尚未 seed 也拿拒绝码而非 30001(fail-close,不泄漏存在性)。
    //    这是 PR 3a 明文写下的刻意设计,新入口照抄,不重新发明。
    //
    //    ⚠️ **判全集而不是判差集,是一个有代价的保守选择,写下来免得后来者当 bug 修**:
    //    整集替换的语义是「我主张这个角色应当恰好持有这些码」,主张里含控制面码 ——
    //    哪怕它本来就在 —— 也是一次主张。于是**非 SA 对「已含控制面码的自定义角色」用不了 PUT**
    //    (保留它触第 1 层、去掉它触撤码方向),得退回 POST / DELETE 逐条改。
    //    代价接受,理由:① 这类角色只可能由 SA 亲手造出来,极少;② 判差集虽然更好用,
    //    但那是**放宽**,而 goal 对本刀的要求是两层闸「原样保留」,不是顺手调松。
    //    ③ 原语内部仍会按**差集**判增、减两个方向 —— 那一道才是真正兜住所有写路径的闸,
    //    这里这一道只是更早、更严的前置。
    this.assertControlPlaneCodesOrThrow(user, uniqueCodes, 'grant');

    // 3. 唯一写原语:行锁 → 锁后复读 revision → 冲突判定 → 差集 → 写 → +1 → audit。
    return this.replaceRolePermissionSet(
      user,
      roleId,
      {
        intent: { kind: 'set', codes: uniqueCodes },
        expectedRevision: dto.expectedRevision,
        audit: (delta) => ({
          event: 'role-permission.replace',
          extra: {
            operation: 'replace',
            addedCodes: delta.addedCodes,
            removedCodes: delta.removedCodes,
            resultCodes: delta.resultCodes,
            fromRevision: delta.fromRevision,
            toRevision: delta.toRevision,
          },
        }),
      },
      meta,
    );
  }
}
