/**
 * 「这次角色权限集变更要不要二次验证」—— 纯策略,零 DB,零 DI(P1-32 PR 5;冻结稿 §12.1)。
 *
 * ──────────────────────────────────────────────────────────────────────────
 * 🔴 **不新造风险分级体系** —— 五条触发条件全部锚在**既有字段 / 既有执法谓词**上
 *
 * 权限目录(PR 1 / PR 0)已经为 237 条码逐条定了 `riskLevel` / `riskTags` / `grantPolicy`,
 * 控制面闸(PR 3a)已经在用 `isControlPlanePermissionCode()` 执法。再定义一套
 * 「哪些算高风险」就是**第二份真相**:两套分级第一天一定一致,此后任一侧调整都没有症状。
 *
 * ⇒ 触发 step-up 的判据(冻结稿 §12.1 逐条对照):
 *
 *   ① `riskLevel === 'CRITICAL'`                 ← §12.1「增加或移除 CRITICAL 权限」
 *   ② `riskTags` 命中 CONTROL_PLANE / CREDENTIAL / FINAL_APPROVAL / LEDGER
 *                                                  ← §12.1 中间四条,逐字同名
 *   ③ `isControlPlanePermissionCode(code)`        ← PR 3a 正在执法的控制面谓词
 *                                                  (7 条 SA-only 保留码 ∪ `rbac.*` ∪ `role-binding.*`)
 *   ④ `grantPolicy === 'SUPER_ADMIN_ONLY'`        ← §12.1「修改 SUPER_ADMIN_ONLY 权限映射」
 *   ⑤ **在 seed 闭包里、却查不到目录元数据 ⇒ 按高风险处理**(fail-close;见下)
 *
 * ⚠️ ③ 与 ①②④ 有交集,这是**刻意的冗余不是重复判定**:①②④ 读的是目录元数据(会随
 *    分类调整而变),③ 读的是**正在拦截授码的那个谓词**。两者任一单独放宽都不会让
 *    高风险码溜过去 —— 这正是「与」变「或」的价值。
 *
 * 🔴 **⑤ 的边界要写清楚 —— 「目录里查不到」是两件事,别混成一件**:
 *
 *   · **在 seed 闭包里但没有元数据** ⇒ 那是**目录漏登记**,fail-close(按高风险)。
 *     「查不到就当低风险」在这一档是一条**零症状**的放行路:新码进了闭包却漏挂元数据,
 *     step-up 就对它悄悄失效。
 *     ⚠️ 这一档**今天是空集** —— PR 1/2 的判据钉住「闭包 ↔ 元数据双向集合相等」,
 *     本文件的判据也独立复核一次(见 `check-role-permission-impact.ts` 的 `catalog-closure-gap`)。
 *   · **压根不在 seed 闭包里** ⇒ 它**不是这个系统拥有的权限码**,风险由另一条不变量管
 *     (`POST /permissions` 对闭包外的码返 `30106`;seed 只造闭包内的码)。
 *     对它要求二次验证是**无意义加重**:那条变更真提交时会因 `30001` 整批拒绝,
 *     而在此之前先弹一个二次验证框,只会让人以为「验证过就能加」。
 *     ⚠️ 这一档在**测试夹具**里大量存在(直写 Prisma 造的合成码),把它判成高风险
 *     会让「低风险普通变更不被无意义加重」这条 DoD 在最常见的路径上当场失效。
 *
 * ──────────────────────────────────────────────────────────────────────────
 * 🔴 判据对象是**差集**(added ∪ removed),不是目标全集
 *
 * 「这次变更动了什么」才是要二次验证的东西。判全集会把「这个角色早就有一条 CRITICAL 码、
 * 这次只改了个无关的低风险码」也拖进 step-up —— 那正是 DoD 第三条
 * 「低风险普通变更不被无意义加重」要防的。
 *
 * ⚠️ 撤销高风险码**同样触发**:把 `attendance.final-approve.*` 从一个角色撤掉会让一批人
 *    当场失去终审能力,damage 方向相反但同属「高风险变更」。授、撤不对称在这里没有理由。
 *
 * ──────────────────────────────────────────────────────────────────────────
 * ⚠️ **本刀刻意不做**:冻结稿 §12.1 最后一条
 *    「修改拥有大量当前有效绑定的角色,可先作为警告,**阈值需业务拍板后再决定是否强制**」。
 *    冻结稿自己就把它挂起在拍板上,凭空定一个阈值等于替维护者拍板;
 *    而且那会让 step-up 的必要性依赖 impact 读数(一个可能是 PARTIAL 的下界)——
 *    用不确定的数去决定一道安全闸,是把两个问题绑成一个。
 */
import { createHash } from 'node:crypto';

import { PERMISSION_CATALOG_METADATA } from './permission-catalog';
import type { PermissionCatalogMetadata, PermissionRiskTag } from './permission-catalog';
import { isControlPlanePermissionCode } from './role-delegation.policy';
import { SEED_PERMISSION_CODE_SET } from './seed-permission-codes';

/**
 * 触发 step-up 的风险性质标签。**取自 `PERMISSION_RISK_TAGS` 的既有取值**,
 * 与冻结稿 §12.1 中间四条逐字对应;这里只是**选了哪几个**,没有新造标签。
 */
export const STEP_UP_TRIGGERING_RISK_TAGS: readonly PermissionRiskTag[] = [
  'CONTROL_PLANE',
  'CREDENTIAL',
  'FINAL_APPROVAL',
  'LEDGER',
];

/** 触发 step-up 的风险等级。 */
export const STEP_UP_TRIGGERING_RISK_LEVEL = 'CRITICAL';

/** 触发 step-up 的授予策略。 */
export const STEP_UP_TRIGGERING_GRANT_POLICY = 'SUPER_ADMIN_ONLY';

/**
 * 判定本体 —— **参数化的纯谓词**,不读任何全局表。
 *
 * 🔴 拆出来是为了让判据能**直接驱动那两档「查不到」**:
 *    `(meta=undefined, inSeedClosure=true)` 与 `(meta=undefined, inSeedClosure=false)`
 *    结论相反,而前者今天是空集、在真数据上根本构造不出来。
 *    不拆的话,那条 fail-close 分支**永远测不到**,等于没有。
 */
export function isStepUpTriggeringCode(
  code: string,
  meta: PermissionCatalogMetadata | undefined,
  inSeedClosure: boolean,
): boolean {
  if (isControlPlanePermissionCode(code)) return true;
  // 「查不到」的两档:闭包内缺元数据 = 目录漏登记 ⇒ 拦;闭包外 = 不是本系统的码 ⇒ 不加重。
  if (meta === undefined) return inSeedClosure;
  if (meta.riskLevel === STEP_UP_TRIGGERING_RISK_LEVEL) return true;
  if (meta.grantPolicy === STEP_UP_TRIGGERING_GRANT_POLICY) return true;
  return meta.riskTags.some((tag) => STEP_UP_TRIGGERING_RISK_TAGS.includes(tag));
}

/** 单条权限码:改动它要不要二次验证(上面那个谓词接上两张真表)。 */
export function isStepUpTriggeringPermissionCode(code: string): boolean {
  return isStepUpTriggeringCode(
    code,
    PERMISSION_CATALOG_METADATA[code],
    SEED_PERMISSION_CODE_SET.has(code),
  );
}

/**
 * 这次变更(差集)要不要二次验证。
 *
 * ⚠️ 入参是**差集**:`added ∪ removed`。空差集(no-op)恒为 `false` ——
 *    什么都没改却要求二次验证,是纯粹的无意义加重。
 */
export function requiresStepUpForChange(
  addedCodes: readonly string[],
  removedCodes: readonly string[],
): boolean {
  return [...addedCodes, ...removedCodes].some(isStepUpTriggeringPermissionCode);
}

/**
 * 目标权限码集合的**规范化指纹** —— step-up proof 的「payload」那一维。
 *
 * 🔴 **先规范化再哈希**:去重 + 升序。理由是"同一次提交"必须映射到同一个哈希 ——
 *    `['a','b']` 与 `['b','a','a']` 落库后**是同一个权限集**(service 侧本来就先
 *    `Array.from(new Set(...))`),把它们算成两个 payload 会让前端 preview 拿到的 proof
 *    在 PUT 时莫名失效,而失效原因无从解释。
 *    反过来,**任何真正不同的目标集合**(多一条 / 少一条 / 换一条)都必然落到不同的哈希上。
 *
 * ⚠️ 用 `JSON.stringify` 的数组形态而不是 `join(',')`:权限码里不会有逗号,但
 *    「今天不会有」不是不变量。JSON 的转义规则把分隔符歧义从根上去掉了。
 */
export function rolePermissionSetPayloadHash(permissionCodes: readonly string[]): string {
  const canonical = JSON.stringify([...new Set(permissionCodes)].sort());
  return createHash('sha256').update(canonical).digest('base64url');
}
