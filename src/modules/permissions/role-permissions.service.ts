import { Injectable } from '@nestjs/common';
import { Role } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { notDeletedWhere } from '../../common/prisma/soft-delete.util';
import { PrismaService } from '../../database/prisma.service';
import { RolePermissionImpactQueryService } from './role-permission-impact-query.service';
import { RolePermissionStepUpProofService } from '../../common/security/role-permission-step-up-proof';
import {
  requiresStepUpForChange,
  rolePermissionSetPayloadHash,
} from './role-permission-step-up.policy';
import type { AuditLogEvent, AuditMeta } from '../audit-logs/audit-logs.types';
import { writeConfigAudit } from './config-audit.util';
import { permissionSelect } from './permissions.select';
import { isProtectedRoleCode } from './protected-role-codes';
import { RbacService } from './rbac.service';
import { RbacRoleDetailResponseDto } from './rbac-roles.dto';
import { rbacRoleSelect } from './rbac-roles.select';
import { rolePermissionEditPolicy, withRoleClassification } from './role-classification';
import { lockRbacRoleLifecycle } from './rbac-role-lifecycle-lock';
import {
  buildBlockedRolePermissionPreview,
  buildRolePermissionPreview,
} from './role-permission-preview.presenter';
import type { RolePermissionSetDelta } from './role-permission-preview.presenter';
import {
  ReplaceRolePermissionsDto,
  RolePermissionPreviewResponseDto,
  RolePermissionSetResponseDto,
} from './role-permissions.dto';
import {
  isControlPlanePermissionCode,
  isReservedSuperAdminOnlyPermissionCode,
} from './role-delegation.policy';
import { ServicePrincipalRoleEligibilityPolicy } from './service-principal-role-eligibility.policy';

// V2.x C-6 RBAC 实施 PR #4:RolePermission 关联表业务逻辑。
// 沿 D7 v1.1 §5.1 端点 10-11 + §6.1 + 用户拍板。
//
// 3 个端点(1 写 + 2 读;**P1-32 PR 8〔2026-08-24〕退役了两条旧增量端点**):
//   PUT    /api/system/v1/roles/:id/permissions       整集替换(P1-32 PR 4a;带 expectedRevision)
//   GET    /api/system/v1/roles/:id/permissions       取当前权限集(P1-32 PR 4b;冻结稿 §9.2)
//   POST   /api/system/v1/roles/:id/permissions/preview  变更预览(P1-32 PR 4b;冻结稿 §9.3)
//
// 🔴 **「会发生什么」这个问题全仓只有一处答案**(P1-32 PR 4b,2026-08-24):
//    `preview` 与 `PUT` 都只调 `runReplaceSet()`,唯一差别是最后一个参数
//    (`AuditMeta` = 真写 / `null` = dry-run 零写入)。preview 若自己再算一遍,
//    「预览说能过、真提交拒绝」(或反过来)**没有任何症状** —— 那正是 4a 刚把三条写路径
//    并成一条原语要消灭的缺陷家族,不能在读面上原地重建一份。
//    执行位:`scripts/check-role-permission-read-preview.ts`(selfGuard 内)+ 薄运行器。
//
// 🔴 **一条写原语**(P1-32 PR 4a,2026-08-23;PR 8 后成为唯一):
//    `replaceRolePermissionSet()` 是**唯一**会改写 role_permissions 的地方。
//    4a 时有三个公开入口(`assign` / `revoke` / `replace`)共用它;
//    **PR 8 退役了前两条**,现在只剩 `replace()`(真写)与 `previewReplace()`(dry-run)。
//    留两条写路径就是「一侧有闸、另一侧裸奔」—— 那是本仓反复吃亏的形态
//    (E-B1 #1115、E-B2 的授撤不对称都是同族)。**写面收成一条,那个形态在本模块结构上消失。**
//
// 🔴 **行锁与版本号不是给现状补的洞,是 `PUT` 这个语义自带的必需品**:
//    已退役的 `POST`(加码)与 `DELETE`(减码)在语义上**可交换** —— 两个管理员同时各加一条码,
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
// **30001**:permission code 不存在 → 30001 PERMISSION_NOT_FOUND(整批拒绝,不部分成功)。
// ⚠️ `30011 ROLE_PERMISSION_NOT_FOUND` 曾是 `revoke()` 专属(撤一条不存在的映射),
//    随 PR 8 一并失去唯一抛出点。**码本体保留在 BizCode 表里**(段位不回收,避免号段复用
//    让历史日志改变含义),但**全仓已无 throw 点** —— 登记见 `NEXT_TASKS` P1-32 PR 8 条目。

@Injectable()
export class RolePermissionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rbac: RbacService,
    private readonly impactQuery: RolePermissionImpactQueryService,
    private readonly servicePrincipalRoleEligibility: ServicePrincipalRoleEligibilityPolicy,
    // P1-32 PR 5:配置变更 proof 的签发与验签**归本域自有**(见该 service 头注)。
    // 🔴 刻意**不注入 `IdentityStepUpService`**:`permissions`(platform-access)依赖
    //    `auth`(identity-org)是架构反向 —— domain-map 的 allowedEdges 里没有那条边。
    //    反过来接:auth 的 step-up 端点验完因子后**委托本域签发**,本域自己验。
    private readonly stepUpProof: RolePermissionStepUpProofService,
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
  // 〔历史〕已退役的 assign() 原先只判 `rbac.role-permission.create`,未阻止持 ops-admin 者把保留码
  // 自授给某角色再绑到自己身上,间接获得 SA-only 能力(授权越权洞)。
  //
  // 🔴 **本方法是授、撤两侧共用的唯一闸**(第六轮评审 E-B2,2026-08-21)。
  //    〔历史〕E-B2 前已退役的 revoke() 一个控制面判定都没有:非 SA 授不了控制面码,却可以**撤** ——
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
  // 与 30001 整批拒绝语义一致。入口收的就是 codes,故能**早于** Permission 存在性查询
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

  /**
   * 🔴 高风险变更的二次验证闸(P1-32 PR 5;冻结稿 §12)。
   *
   * ──────────────────────────────────────────────────────────────────────
   * **落点:`runReplaceSet()`,不是写原语。** 这决定了它的射程。
   *
   * · 管辖 `PUT` 与 `preview` —— 两者共用 `runReplaceSet()`,所以本闸在
   *   **两侧同时生效**:preview 就是 PUT 的真 dry-run。
   *   ⚠️ 这也是为什么高风险变更**不带 proof 时 preview 直接 `valid:false`**
   *   (`blockingIssues[0].bizCode=30112`)而不是 `valid:true + requiresStepUp:true`——
   *   冻结稿 §9.3 的示例写于 PR 4b 之前,照抄它就等于亲手造出「预览说能过、真提交拒」,
   *   而那正是 4b 那条同源判据(`check-role-permission-read-preview.ts`)定义的缺陷。
   *   **同源优先于示例保真**,这是有意偏离。
   *
   * · ⭐ **旧增量端点的旁路已随 P1-32 PR 8 消失**(2026-08-24)。PR 5 交付时
   *   `assign()` / `revoke()` 走同一条写原语但**不经** `runReplaceSet()` ⇒ 持
   *   `rbac.role-permission.create` 的人可用 `POST /roles/:id/permissions` 加一条
   *   CRITICAL 码而不触二次验证。**那两个方法与它们的端点已删** ⇒ 本模块写面只剩
   *   `replace()` 与 `previewReplace()`,**两者都在本闸内,不存在绕过它的写路径**。
   *   〔历史记录〕当年收口它的另一条路是给 `AssignRolePermissionsDto` 也加 proof 字段并改原语判定 = 行为破坏,
   *   超出本刀;冻结稿 PR 8 本来就要退役那两条端点。
   *   ⇒ 射程由 `scripts/check-role-permission-impact.ts` 的 `stepup-scope-*` 规则**登记并钉住**:
   *   有人扩大或收窄都得显式改登记,PR 8 删掉旧端点时该判据会红并要求重看。
   *
   * ──────────────────────────────────────────────────────────────────────
   * ⚠️ **差集在锁外算,这是安全的,理由要写下来免得后人当 bug 修**:
   *    本闸取的现状是**未加锁**的一次读。它之所以不会与锁内真相分家,是因为
   *    `set` 语义**必带 `expectedRevision`**,而 `permissionRevision` 在每次非空转的
   *    替换里都 +1(原语第 9 步)。⇒ 锁内 revision 与 `expectedRevision` 相等
   *    ⟺ 期间没有人改过这个角色的权限集 ⟺ 锁外读到的现状就是锁内那一份。
   *    不相等的那条路径整批返 30111,请求本来就失败,不存在"按错误差集放行"。
   *
   * ⚠️ **要不要拦的判断在闸内部,不在调用点** —— 调用点必须是无条件语句。
   *    把它写成 `if (isHighRisk) this.assertStepUp...` 会让「dry-run 时跳过」
   *    只需要一个 `if`,而射程断言照样全绿(4b 判据的 `conditional-gate` 同款理由)。
   */
  private async assertStepUpProofOrThrow(
    user: CurrentUserPayload,
    roleId: string,
    dto: ReplaceRolePermissionsDto,
    uniqueCodes: string[],
  ): Promise<void> {
    const current = await this.prisma.rolePermission.findMany({
      where: { roleId },
      select: { permission: { select: { code: true } } },
    });
    const currentCodes = current.map((row) => row.permission.code);
    const currentSet = new Set(currentCodes);
    const targetSet = new Set(uniqueCodes);
    const addedCodes = uniqueCodes.filter((code) => !currentSet.has(code));
    const removedCodes = currentCodes.filter((code) => !targetSet.has(code));

    // ⭐ DoD 第三条「低风险普通变更不被无意义加重」的落点:差集里没有高风险码就**到此为止** ——
    //    不看 proof、不要求 proof、不产生任何额外拒绝。
    //    ⚠️ 上面那次差集查询是**无条件**的(要先知道改了什么才能判风险),这条早返回省的是
    //    「验签」那一段,不是那次查询。写清楚免得后来者以为低风险路径零查询。
    if (!requiresStepUpForChange(addedCodes, removedCodes)) return;

    const stepUpToken = dto.stepUpToken;
    if (stepUpToken === undefined || stepUpToken.length === 0) {
      throw new BizException(BizCode.ROLE_PERMISSION_STEP_UP_REQUIRED);
    }

    // 三元组逐项参与验签:换角色 / 换版本号 / 改一个字节的权限码,任一条都让 proof 失效(10008)。
    // ⚠️ 这里**不读 User** —— proof 不绑凭证快照(理由与实测读数见 proof service 头注:
    //    「改密码即刻踢人」在这条链上本来就不存在,绑它只是让假保证看起来是真的),
    //    而且读 `User` 是 platform-access → identity-org 的跨域读,架构上不成立。
    this.stepUpProof.verify(user.id, stepUpToken, {
      roleId,
      expectedRevision: dto.expectedRevision,
      payloadHash: rolePermissionSetPayloadHash(uniqueCodes),
    });
  }

  // 沿 PR #3 rbac-roles 范式:区分不存在(30003)vs 已软删(30005);
  // 写操作(授权/撤权)沿 D7 §6.1 决议管理者已知角色明细 → 披露 30005 不构成信息泄漏。
  //
  // P1-32 PR 3a(2026-08-23)起本 helper 还是**系统内置角色只读**闸的落点:
  // 内置角色的权限映射由 seed 定义(org-readonly / group-readonly 更是从正职角色**派生**的),
  // 运行时增删要么被下次 seed 覆盖,要么造出与派生链打架的第二份真相 ⇒ 一律 30108,
  // **SUPER_ADMIN 也拒**(与角色删除保护 30104 同语义)。
  //
  // 闸放在这里而不是各公开入口各写一遍:所有写路径本来就都要先取这一行,
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
      ...withRoleClassification(role),
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
   *    〔历史,PR 8 后已无增量入口 —— **留着是为了别再犯**〕已退役的 `POST` / `DELETE`
   *    是**增量**语义 —— 「加这几条」「减这一条」,其余一律不动。若让它们在锁**外**先读
   *    一遍现状、算出目标全集再交进来,那份快照会在锁等待期间过期,于是「减掉 x」就顺手把
   *    别人刚加的 y 一起抹掉 —— 4a 本来是来消灭丢更新的,那样写反而给两条旧路径**各造一个新的**。
   *    `PUT` 的 `set` 相反:调用者的全集**就是**权威,它的过期风险由 `expectedRevision` 兜
   *    ⇒ PR 8 之后入参收成 `targetCodes` 一个数组。
   *
   * 🔴 **P1-32 PR 4b(2026-08-24):`commit === null` = dry-run。**
   *    `POST /roles/:id/permissions/preview` 走的就是本方法,**判定一行都没有重写** ——
   *    同一把角色行锁、同一个事务、同一批闸、同一份差集,只在「写库」那一步前停下并把
   *    delta 交回去。⇒ 「预览说能过」与「此刻 PUT 会过」是**同一段代码的同一次执行**,
   *    结构上不可能分家。
   *    ⚠️ 别把 dry-run 的出口往前挪:它必须排在**方向闸之后**(第 8 步),
   *    否则预览会对「非 SA 撤控制面码」这类情形报能过,而真提交 30103 —— 那正是本刀要消灭的形状。
   *    ⚠️ 也别把它改成「锁外算一遍」省掉行锁:锁外读到的现状可能已过期,
   *    算出来的差集就是一份看起来对、实际上属于另一个时刻的结论。
   *
   * @param input.commit 落库意图。传对象 = 真写(旧行为逐字不变);传 `null` = dry-run。
   *                     `audit` 由调用方按入口构造事件与 extra。⚠️ P1-32 PR 8 之前
   *                     `role-permission.grant` / `.revoke` 两个事件由已退役的 POST / DELETE 产出,
   *                     被 `permissions-config-audit-characterization` B1/B2 逐字钉着;
   *                     退役后写面只剩 `role-permission.replace` 一个事件。
   */
  private async replaceRolePermissionSet(
    user: CurrentUserPayload,
    roleId: string,
    input: {
      /**
       * 目标权限码全集(已去重)—— 提交后该角色的权限**恰好**是这些码。
       *
       * ⚠️ P1-32 PR 8 之前这里是一个三态「意图」(`set` / `add` / `remove`),因为旧
       *    `POST` / `DELETE` 是**增量**语义,必须把「加这几条 / 减这一条」原样传进来、
       *    由原语在**锁内**与真实现状合成目标集(锁外合成会把别人刚提交的改动抹掉)。
       *    两条旧端点已随 PR 8 退役 ⇒ 只剩 `set` 一种,三态收成一个数组。
       *    🔴 **若将来再加回增量语义,必须把「意图」这个形状一起加回来** ——
       *    别在调用方先读现状算目标集再传进来,那正是当年要避开的丢更新窗口。
       */
      targetCodes: string[];
      /** 乐观并发期望值(`PUT` / `preview` 必填,DTO 侧 `@IsInt() @Min(0)`)。 */
      expectedRevision: number;
      commit: {
        audit: (delta: RolePermissionSetDelta) => {
          event: AuditLogEvent;
          extra: Record<string, unknown>;
        };
        meta: AuditMeta;
      } | null;
    },
  ): Promise<RolePermissionSetDelta> {
    // 1. 事务外快检:角色存在 / 未软删 / 非内置(→ 30003 / 30005 / 30108)。
    //    事务内还会**再判一次**(见 helper 头部);这里先判是为了在开事务前就给出稳定错误码。
    await this.assertRoleMutableOrThrow(roleId);

    // 2. 意图里的码 → Permission 行;**任一 code 不存在 → 30001**(整批拒绝,不部分成功)。
    const intentPerms = await this.prisma.permission.findMany({
      where: { code: { in: input.targetCodes } },
      select: { id: true, code: true },
    });
    if (intentPerms.length !== input.targetCodes.length) {
      throw new BizException(BizCode.PERMISSION_NOT_FOUND);
    }

    return this.prisma.$transaction(async (tx): Promise<RolePermissionSetDelta> => {
      // 3. 🔴 角色行锁 —— 并发替换在这里排队。表名是 @@map 后的物理名 "roles"。
      await lockRbacRoleLifecycle(tx, roleId);

      // 4. 锁后复读:锁等待期间前一个写者可能已软删角色 / 已把 revision +1。
      const locked = this.assertRoleRowMutableOrThrow(
        await tx.rbacRole.findUnique({
          where: { id: roleId },
          select: { code: true, deletedAt: true, permissionRevision: true },
        }),
      );

      // 5. 乐观并发:期望值与锁内真值不符 → 整批拒绝,一个字节都不写。
      if (input.expectedRevision !== locked.permissionRevision) {
        throw new BizException(BizCode.ROLE_PERMISSION_REVISION_CONFLICT);
      }

      // 6. 锁内取现状 → 与目标集比 → 按 **permissionId 集合**算差集
      //    (比集合不比计数:计数相等会掩盖「换掉一条」这种内容互换)。
      const current = await tx.rolePermission.findMany({
        where: { roleId },
        select: { permissionId: true, permission: { select: { code: true } } },
      });
      const currentCodeById = new Map(
        current.map((row) => [row.permissionId, row.permission.code]),
      );
      const targetCodeById = new Map<string, string>();
      for (const perm of intentPerms) targetCodeById.set(perm.id, perm.code);
      const addedIds = [...targetCodeById.keys()].filter((id) => !currentCodeById.has(id));
      const removedIds = [...currentCodeById.keys()].filter((id) => !targetCodeById.has(id));
      // 差集的码形态。**从第 8 步提到这里**(P1-32 PR 4b),纯位置调整:
      // no-op 分支现在也要产出 delta(`resultCodes` / `unchangedCount`),而那两项就在这几行里。
      const addedCodes = addedIds.map((id) => targetCodeById.get(id) as string);
      const removedCodes = removedIds.map((id) => currentCodeById.get(id) as string);
      const resultCodes = [...targetCodeById.values()];
      const unchangedCount = targetCodeById.size - addedIds.length;

      // C2:若任意未软删 ServicePrincipal Binding 已指向本 Role，目标**最终集**必须全部合格。
      // 必须排在 no-op 之前：历史脏集不能因「这次没改」被静默当作有效配置回显。
      await this.servicePrincipalRoleEligibility.assertFinalPermissionSetEligibleForBoundServicePrincipals(
        tx,
        { roleId, targetPermissionCodes: resultCodes },
      );

      // 7. no-op:目标集合与现状**相同** → 不写、不 +1、不产生 audit。
      //    (空转不是变更,给它记一条 audit 等于往审计流里灌噪声;`updatedAt` 同理不动。)
      if (addedIds.length === 0 && removedIds.length === 0) {
        return {
          noOp: true,
          addedCodes: [],
          removedCodes: [],
          resultCodes,
          unchangedCount,
          fromRevision: locked.permissionRevision,
          toRevision: locked.permissionRevision,
        };
      }

      // 8. D2 分级闸,**按方向各判各的**:进来的码走 grant、出去的码走 revoke。
      //    没动的码不判 —— 判了会把「这次没碰它」误伤成越权(非 SA 改自定义角色里
      //    早就存在的 rbac.* 之外的码时会当场炸)。反过来任何**真的**改动都落在差集里,
      //    所以按差集判**不比**按全集判弱。两个方向的口径差(SA 撤得动保留码、授不动)
      //    由 `assertControlPlaneCodesOrThrow` 自己承担,这里不复刻判定。
      this.assertControlPlaneCodesOrThrow(user, addedCodes, 'grant');
      this.assertControlPlaneCodesOrThrow(user, removedCodes, 'revoke');

      // 8.5 🔴 dry-run 出口(P1-32 PR 4b)—— 判定到这里**已经全部跑完**:
      //     判权、角色三态、码存在性、行锁、revision 冲突、差集、两个方向的控制面闸。
      //     preview 与 PUT 的差别到此为止,后面全是写库。
      //     `toRevision` 是**预测值**(+1);没写库拿不到真值,DTO 里已写明它是预测不是承诺。
      if (input.commit === null) {
        return {
          noOp: false,
          addedCodes,
          removedCodes,
          resultCodes,
          unchangedCount,
          fromRevision: locked.permissionRevision,
          toRevision: locked.permissionRevision + 1,
        };
      }

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

      const delta: RolePermissionSetDelta = {
        noOp: false,
        addedCodes,
        removedCodes,
        resultCodes,
        unchangedCount,
        fromRevision: locked.permissionRevision,
        toRevision: bumped.permissionRevision,
      };
      const { event, extra } = input.commit.audit(delta);
      await writeConfigAudit(tx, {
        event,
        actor: user,
        resourceType: 'role_permission',
        resourceId: roleId,
        meta: input.commit.meta,
        extra,
      });
      return delta;
    });
  }

  // ============ 唯一的「整集替换」判定序列(P1-32 PR 4b)============

  /**
   * 🔴 **`PUT` 与 `preview` 的唯一共同入口。**
   *
   * 冻结稿 §1.7 结尾逐字写着「这套 **preview + create 复用同一校验器**的范式,
   * 应直接复用于新的角色权限集管理」(仓内活样本:`role-bindings.service.preview()`)。
   * 本方法就是那个「同一校验器」——`replace()` 与 `previewReplace()` 的方法体各只有一句
   * 调用它,**两侧一行判定都没有自己写**。
   *
   * ⚠️ 为什么不让 `previewReplace()` 自己照抄这四句:照抄出来的两份第一天一定相同,
   *    而此后任一侧加一道闸、改一个码、调一次次序,另一侧都不会有任何症状 ——
   *    「预览说能过、真 PUT 拒绝」就是这么长出来的。判据
   *    `scripts/check-role-permission-read-preview.ts` 把「两个公开方法各只有一句委托」
   *    钉成不变量,照抄回去当场红。
   *
   * @param commitMeta `null` = dry-run(preview):走完全部判定后**零写入**。
   *                   非 `null` = 真写。⭐ **这是 preview 与 `PUT` 的全部差别。**
   */
  private async runReplaceSet(
    user: CurrentUserPayload,
    roleId: string,
    dto: ReplaceRolePermissionsDto,
    commitMeta: AuditMeta | null,
  ): Promise<RolePermissionSetDelta> {
    await this.assertCanOrThrow(user, 'rbac.role-permission.create');
    await this.assertCanOrThrow(user, 'rbac.role-permission.delete');
    // 1. role 必须存在 + 未软删 + 不是系统内置角色(内置角色只读 → 30108)
    await this.assertRoleMutableOrThrow(roleId);

    const uniqueCodes = Array.from(new Set(dto.permissionCodes));

    // 2. D2 分级闸(授码方向,判**目标全集**)—— 沿用已退役 assign() 的那一句,连次序都一样:
    //    入参本来就是 codes,所以能**早于** Permission 存在性查询拦下,
    //    保留码即便尚未 seed 也拿拒绝码而非 30001(fail-close,不泄漏存在性)。
    //    这是 PR 3a 明文写下的刻意设计,新入口照抄,不重新发明。
    //
    //    ⚠️ **判全集而不是判差集,是一个有代价的保守选择,写下来免得后来者当 bug 修**:
    //    整集替换的语义是「我主张这个角色应当恰好持有这些码」,主张里含控制面码 ——
    //    哪怕它本来就在 —— 也是一次主张。于是**非 SA 对「已含控制面码的自定义角色」用不了 PUT**
    //    (保留它触第 1 层、去掉它触撤码方向)。⚠️ P1-32 PR 8 退役 POST / DELETE 之后
    //    **「退回逐条改」这条退路也没有了** —— 这类角色只能由 SUPER_ADMIN 改。
    //    代价接受,理由:① 这类角色只可能由 SA 亲手造出来,极少;② 判差集虽然更好用,
    //    但那是**放宽**,而 goal 对本刀的要求是两层闸「原样保留」,不是顺手调松。
    //    ③ 原语内部仍会按**差集**判增、减两个方向 —— 那一道才是真正兜住所有写路径的闸,
    //    这里这一道只是更早、更严的前置。
    this.assertControlPlaneCodesOrThrow(user, uniqueCodes, 'grant');

    // 2.5 P1-32 PR 5:高风险变更要二次验证。**无条件调用**,要不要真拦由闸内部按差集决定。
    //     ⇒ `PUT` 与 `preview` 在这一道上完全同源:preview 不带 proof 的高风险变更返
    //     `valid:false` + 30112,而不是"说能过、真提交拒"。
    await this.assertStepUpProofOrThrow(user, roleId, dto, uniqueCodes);

    // 3. 唯一写原语:行锁 → 锁后复读 revision → 冲突判定 → 差集 → 两方向闸 →(commit 才写)。
    return this.replaceRolePermissionSet(user, roleId, {
      targetCodes: uniqueCodes,
      expectedRevision: dto.expectedRevision,
      commit:
        commitMeta === null
          ? null
          : {
              meta: commitMeta,
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
    });
  }

  // ============ 写 / 读端点 ============

  /**
   * P1-32 PR 4a:整集替换(`PUT /api/system/v1/roles/:id/permissions`)。
   *
   * ⭐ P1-32 PR 8 起它是**唯一的真写入口**(preview 是它的 dry-run 孪生)。
   * 与已退役的 POST / DELETE 的差别只有两处,其余(角色三态闸、控制面两层闸、单事务 audit)完全同源:
   *   - 语义是 `set` 而不是增量 —— 提交后该角色的权限**恰好**是 `permissionCodes`;
   *   - `expectedRevision` **必填** —— 整集替换是读-改-写,不带版本号就是允许后写覆盖先写。
   *
   * 判权要**两个**码:一次替换可能同时授与撤,只拿 `create` 就能撤权、只拿 `delete`
   * 就能授权,都是把另一半闸绕过去。
   *
   * ⚠️ P1-32 PR 4b 起判定序列搬进 `runReplaceSet()`(与 `previewReplace()` 共用)——
   *    **本方法体里只剩一句委托是刻意的**,不是没写完。见 `runReplaceSet` 头注。
   */
  async replace(
    user: CurrentUserPayload,
    roleId: string,
    dto: ReplaceRolePermissionsDto,
    meta: AuditMeta,
  ): Promise<RbacRoleDetailResponseDto> {
    await this.runReplaceSet(user, roleId, dto, meta);
    return this.buildDetailResponse(roleId);
  }

  // ============ P1-32 PR 4b:读 / 预览面(零写路径改动)============

  /**
   * `POST /api/system/v1/roles/:id/permissions/preview` —— 变更预览(冻结稿 §9.3)。
   *
   * 🔴 **判定与 `PUT` 是同一次执行**:同一个 `runReplaceSet()`,唯一差别是 `commitMeta = null`
   *    ⇒ 走完全部判定后零写入。所以「预览说能过」与「此刻 PUT 会过」**结构上等价**,
   *    不靠任何断言、也不可能因为「有人只改了一侧」而分家。
   *
   * 🔴 **`catch` 只搬运不判断**:冻结稿 §9.3 要求「deny/blocked 作为 200 数据返回」,
   *    这里把 `PUT` 会抛的那个 `BizException` 原样摆进 `blockingIssues[0]`(code / message /
   *    httpStatus 三个字段直接取自 `error.biz`)。**一个 code → 语义的映射表都没有** ——
   *    有映射表就有「哪些算 blocking」的判断,那就是第二份真相。
   *    (同款范式:`role-bindings.service.preview()` 的 `collect()`,controller 的 summary
   *    逐字写着「deny 是数据」;冻结稿 §1.7 结尾点名要复用的就是它。)
   *
   * ⚠️ 非 `BizException` 一律**原样抛出**:那是 500 级故障(连库失败、锁超时……),
   *    把它也渲染成 `valid:false` 等于告诉前端「你的入参有问题」,那是撒谎。
   *
   * ⚠️ 预览**不是授权证明**(冻结稿 §2.8)。它只回答「按当前库里的事实,这次变更此刻可行吗」;
   *    真提交时原语会在锁内重算一遍,期间被改过就返 30111。
   */
  async previewReplace(
    user: CurrentUserPayload,
    roleId: string,
    dto: ReplaceRolePermissionsDto,
  ): Promise<RolePermissionPreviewResponseDto> {
    try {
      const delta = await this.runReplaceSet(user, roleId, dto, null);
      // 影响面在**锁释放之后**才查(P1-32 PR 5):它是给人看的参考读数,
      // 塞进临界区只会延长持锁时间,而生产事务有 5s 预算。
      // ⚠️ `requiresStepUp` 用的是**锁内**算出来的差集(权威的那一份);
      //    闸里那次用的是锁外读 —— 两者在成功路径上必然相等(见闸头注对 revision 的论证)。
      return buildRolePermissionPreview(
        delta,
        await this.impactQuery.summarize(roleId),
        requiresStepUpForChange(delta.addedCodes, delta.removedCodes),
      );
    } catch (error) {
      if (error instanceof BizException) return buildBlockedRolePermissionPreview(error.biz);
      throw error;
    }
  }

  /**
   * `GET /api/system/v1/roles/:id/permissions` —— 取角色当前权限集(冻结稿 §9.2)。
   *
   * 判权复用 **`rbac.role.read`**,零新增权限码:`GET /roles/:id` 拿同一条码,
   * 而它**今天就已经返回完整 `permissions[]`** ⇒ 本端点的暴露面 ⊆ 既有暴露面。
   *
   * 🔴 **刻意不过 `assertRoleMutableOrThrow`** —— 那道 helper 会对 15 个内建角色抛 30108。
   *    内建角色的权限集**必须读得到**(前端要把编辑器置灰并列出它到底带了什么),
   *    「能不能改」由 `editPolicy` 以数据形态回答,不是靠让读操作失败来表达。
   *    ⇒ 这里只判「存在 / 未软删」两态,与 `rbac-roles.service.findOne()` 同口径(30003 / 30005)。
   */
  async findPermissionSet(
    user: CurrentUserPayload,
    roleId: string,
  ): Promise<RolePermissionSetResponseDto> {
    await this.assertCanOrThrow(user, 'rbac.role.read');

    // 用 findUnique(**不带** notDeletedWhere)才能区分 30003 / 30005;
    // 沿 rbac-roles.service 的 findByIdForDetailOrThrow 范式,不复述理由。
    const role = await this.prisma.rbacRole.findUnique({
      where: { id: roleId },
      select: {
        id: true,
        code: true,
        displayName: true,
        permissionRevision: true,
        deletedAt: true,
      },
    });
    if (!role) throw new BizException(BizCode.ROLE_NOT_FOUND);
    if (role.deletedAt !== null) throw new BizException(BizCode.ROLE_DELETED);

    const rolePermissions = await this.prisma.rolePermission.findMany({
      where: { roleId },
      select: { permission: { select: { code: true } } },
    });
    // 服务端排序(冻结稿 §9.3 对入参写的是「服务端排序、去重」,读面同口径):
    // 前端要拿它与目录的勾选状态做集合比对,顺序稳定才不会每次都 diff 出假变化。
    const permissionCodes = rolePermissions.map((rp) => rp.permission.code).sort();

    return {
      role: withRoleClassification({
        id: role.id,
        code: role.code,
        displayName: role.displayName,
      }),
      permissionRevision: role.permissionRevision,
      permissionCodes,
      editPolicy: rolePermissionEditPolicy(role.code),
    };
  }
}
