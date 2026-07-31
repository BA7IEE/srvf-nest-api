import {
  CertificateIssuerPolicy,
  CertificateNumberMode,
  CertificateRecognitionPolicyStatus,
  CertificateStandardKind,
  CertificateStandardStatus,
  CertificateValidityMode,
} from '@prisma/client';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';

// 证书标准库 PR-3(冻结稿 §5.3 / §5.4 / §7.1 / §7.2):Standard 与 Policy 的
// **纯**状态机与字段组合校验。
//
// 为什么单独一个文件:这些规则是本 goal 里最容易被后续刀悄悄改松的部分
// (「先让它过」),放在纯函数里可以零 DB 单测穷举,且 service 只能调、不能绕。
// 本文件**不 import Prisma client、不碰 DB、不写 audit**(§19 边界)。

// ============ Standard 状态机(§7.1)============

// 允许:DRAFT → ACTIVE / ACTIVE → INACTIVE / INACTIVE → ACTIVE。
// **不允许**任何 → DRAFT:一旦启用过就可能被历史 Certificate 引用,退回 DRAFT
// 等于让「不可用于建证」的标准挂着历史引用,语义不可解释(§7.1 只列了三条转移)。
// 同态 → 同态也拒:状态机接口不做幂等糖,免得 UI 的重复点击被当成正常流程掩盖。
const STANDARD_ALLOWED_TRANSITIONS: ReadonlyMap<
  CertificateStandardStatus,
  ReadonlySet<CertificateStandardStatus>
  // 显式泛型:否则 TS 从首个 entry 把 Set 的元素类型窄成 `Set<"ACTIVE">`,
  // 后面 `Set<"INACTIVE">` 就不兼容了。
> = new Map<CertificateStandardStatus, ReadonlySet<CertificateStandardStatus>>([
  [CertificateStandardStatus.DRAFT, new Set([CertificateStandardStatus.ACTIVE])],
  [CertificateStandardStatus.ACTIVE, new Set([CertificateStandardStatus.INACTIVE])],
  [CertificateStandardStatus.INACTIVE, new Set([CertificateStandardStatus.ACTIVE])],
]);

export function assertStandardTransitionAllowed(
  from: CertificateStandardStatus,
  to: CertificateStandardStatus,
): void {
  if (!STANDARD_ALLOWED_TRANSITIONS.get(from)?.has(to)) {
    throw new BizException(BizCode.CERTIFICATE_STANDARD_STATE_INVALID);
  }
}

// FAMILY 只能做目录分组:不能被 Policy 认定、不能被 Claim 解析、不能被 Certificate 持有
// (D-CERT-003)。所有「要拿这个 Standard 干实事」的路径都必须先过这一关。
export function assertStandardIsCredential(kind: CertificateStandardKind): void {
  if (kind !== CertificateStandardKind.CREDENTIAL) {
    throw new BizException(BizCode.CERTIFICATE_STANDARD_KIND_INVALID);
  }
}

// 用于认定 / 建证的 Standard 必须是 ACTIVE(§7.1 INACTIVE 段:不出现在新建选项中)。
export function assertStandardIsActive(status: CertificateStandardStatus): void {
  if (status !== CertificateStandardStatus.ACTIVE) {
    throw new BizException(BizCode.CERTIFICATE_STANDARD_INACTIVE);
  }
}

// 父级约束(§5.2):父必须是 FAMILY、父子 categoryCode 必须一致。
// 「父必须是 FAMILY」用 KIND_INVALID(与 FAMILY 语义同族),
// 「category 不一致」用 PARENT_INVALID —— 两种错因前端提示不同,不合并。
export function assertParentUsable(parent: {
  kind: CertificateStandardKind;
  categoryCode: string;
  status: CertificateStandardStatus;
}): void {
  if (parent.kind !== CertificateStandardKind.FAMILY) {
    throw new BizException(BizCode.CERTIFICATE_STANDARD_KIND_INVALID);
  }
  if (parent.status === CertificateStandardStatus.DRAFT) {
    // 挂到还没启用的目录节点下会造出「子已 ACTIVE、父还 DRAFT」的悬空树。
    throw new BizException(BizCode.CERTIFICATE_STANDARD_STATE_INVALID);
  }
}

export function assertParentCategoryMatches(childCategory: string, parentCategory: string): void {
  if (childCategory !== parentCategory) {
    throw new BizException(BizCode.CERTIFICATE_STANDARD_PARENT_INVALID);
  }
}

// 目录树深度上限。真实证书目录不会有几十层;这个值的作用不是限制业务,
// 是给下面的向上遍历一个**必然终止**的界 —— 万一库里已经有一个环
// (数据订正、将来某条新路径),遍历不能变成死循环。
export const MAX_STANDARD_PARENT_DEPTH = 32;

/**
 * 冻结稿 §5.2「禁止形成父子循环」的执行位(评审 findings H4)。
 *
 * 修复前这条不变量**零执法**:文件里只有一句「自己不能当自己的父级」,
 * 而 create 那侧写着一段安全论证 ——「parentId 只在 create 期可设、Update DTO 不含它,
 * 因此循环在结构上不可能形成」。amendments A-3 放开 DRAFT 期改 parentId 之后,
 * 那段论证的两个前提都没了,而没有任何东西接手。
 *
 * ⚠️ 记准事实,不夸大:今天通过 API **仍然**构造不出环,但那是三条互不相关的规则
 * 撞出来的涌现性质 —— 设边要求父已启用(`assertParentUsable` 拒 DRAFT 父)、
 * 子从未启用(18033)、状态机不可回 DRAFT;沿环一圈得到「首次启用时刻严格递减
 * 又必须回到自己」,矛盾。三处代码里没有一个字提到「环」。
 * 谁哪天放松「父必须非 DRAFT」(「让我在 DRAFT 期把整棵树搭完再启用」是很自然的诉求),
 * 环当场可达,而不会有任何测试变红。所以这里把它做成本地的、显式的、可单测的检查。
 *
 * 成环的真实后果也记准:后端是扁平一层查询、不做递归遍历,**不会**挂服务;
 * 后果是两节点互为子节点 ⇒ 删除守卫的子节点计数恒非零 ⇒ 谁都删不掉。
 *
 * 刻意做成纯算法 + 注入式加载器:本文件不 import Prisma client、不碰 DB(§19 边界),
 * 而这条规则因此可以用一张普通 Map 穷举单测,不需要起数据库。
 *
 * @param selfId    正在被设置 parentId 的那一行;create 期该行还不存在 → 传 null
 * @param parentId  本次要写入的父级 id
 * @param loadParentIdOf 取某行的 parentId;行不存在或已到根 → null
 */
export async function assertParentChainAcyclic(
  selfId: string | null,
  parentId: string,
  loadParentIdOf: (id: string) => Promise<string | null>,
): Promise<void> {
  const visited = new Set<string>();
  let cursor: string | null = parentId;
  let depth = 0;
  while (cursor !== null) {
    // 走到自己 = 这条边会闭合成环(depth=0 时即「自己当自己的父级」)。
    if (cursor === selfId) {
      throw new BizException(BizCode.CERTIFICATE_STANDARD_PARENT_INVALID);
    }
    // 走回访问过的节点 = 祖先链上**本来就**有环。不静默放行:
    // 往一个已经坏掉的结构上再挂东西只会让它更难修。
    if (visited.has(cursor)) {
      throw new BizException(BizCode.CERTIFICATE_STANDARD_PARENT_INVALID);
    }
    visited.add(cursor);
    if (++depth > MAX_STANDARD_PARENT_DEPTH) {
      throw new BizException(BizCode.CERTIFICATE_STANDARD_PARENT_INVALID);
    }
    cursor = await loadParentIdOf(cursor);
  }
}

// ============ Policy 状态机(§7.2)============

// 允许:DRAFT → ACTIVE / ACTIVE → RETIRED。
// **不允许** ACTIVE|RETIRED → DRAFT,也不允许 RETIRED → ACTIVE(§7.2 明列)。
// 理由:已激活的规则可能已被 pending Certificate 与 APPROVED Claim 锁定引用
// (D-CERT-008),让它回 DRAFT 再改 = 追溯改写历史审核依据。
const POLICY_ALLOWED_TRANSITIONS: ReadonlyMap<
  CertificateRecognitionPolicyStatus,
  ReadonlySet<CertificateRecognitionPolicyStatus>
> = new Map<CertificateRecognitionPolicyStatus, ReadonlySet<CertificateRecognitionPolicyStatus>>([
  [CertificateRecognitionPolicyStatus.DRAFT, new Set([CertificateRecognitionPolicyStatus.ACTIVE])],
  [
    CertificateRecognitionPolicyStatus.ACTIVE,
    new Set([CertificateRecognitionPolicyStatus.RETIRED]),
  ],
  // RETIRED 是终态:空集 = 任何转移都拒(§7.2「不可恢复为 ACTIVE」)。
  [CertificateRecognitionPolicyStatus.RETIRED, new Set<CertificateRecognitionPolicyStatus>()],
]);

export function assertPolicyTransitionAllowed(
  from: CertificateRecognitionPolicyStatus,
  to: CertificateRecognitionPolicyStatus,
): void {
  if (!POLICY_ALLOWED_TRANSITIONS.get(from)?.has(to)) {
    throw new BizException(BizCode.CERTIFICATE_POLICY_STATE_INVALID);
  }
}

// 只有 DRAFT 的规则可以改内容 / 可以软删(§7.2:ACTIVE 与 RETIRED「所有规则只读」)。
export function assertPolicyIsDraft(status: CertificateRecognitionPolicyStatus): void {
  if (status !== CertificateRecognitionPolicyStatus.DRAFT) {
    throw new BizException(BizCode.CERTIFICATE_POLICY_IMMUTABLE);
  }
}

// ============ Policy 字段组合(§5.3 表)============

// | validityMode        | validityMonths | 实例到期日        |
// | PERMANENT           | NULL           | 必须 NULL         |
// | FIXED_MONTHS        | 1..600         | 后端算,客户端不传 |
// | EXPLICIT_REQUIRED   | NULL           | 必填              |
// | EXPLICIT_OPTIONAL   | NULL           | 可空,空即终身     |
//
// 只有 FIXED_MONTHS 用 validityMonths;其余三种传了就是配置错误 ——
// 留着一个「不生效但存着」的月数,下一个人一定会以为它生效。
export function assertValidityCombination(
  validityMode: CertificateValidityMode,
  validityMonths: number | null | undefined,
): void {
  const months = validityMonths ?? null;
  if (validityMode === CertificateValidityMode.FIXED_MONTHS) {
    if (months === null || !Number.isInteger(months) || months < 1 || months > 600) {
      throw new BizException(BizCode.CERTIFICATE_VALIDITY_INVALID);
    }
    return;
  }
  if (months !== null) {
    throw new BizException(BizCode.CERTIFICATE_VALIDITY_INVALID);
  }
}

// ============ issuer 集合(§5.4 表)============

// | issuerPolicy | issuer 数量 |
// | FIXED        | 恰好 1      |
// | ALLOWLIST    | ≥ 1         |
// | FREE_TEXT    | 恰好 0      |
//
// FREE_TEXT 必须 0 而不是「可以有」:第一版刻意不让 FREE_TEXT 同时维护建议机构,
// 否则 issuerId 与自由文本双义,实例侧无法判断以哪个为准(§5.4 末段)。
export function assertIssuerCountMatchesPolicy(
  issuerPolicy: CertificateIssuerPolicy,
  issuerCount: number,
): void {
  const ok =
    issuerPolicy === CertificateIssuerPolicy.FIXED
      ? issuerCount === 1
      : issuerPolicy === CertificateIssuerPolicy.ALLOWLIST
        ? issuerCount >= 1
        : issuerCount === 0;
  if (!ok) throw new BizException(BizCode.CERTIFICATE_ISSUER_CONFIG_INVALID);
}

/**
 * 到期日是否由**客户端**提供。
 *
 * `PERMANENT`(恒空)与 `FIXED_MONTHS`(后端按 issuedAt 算)属于**派生型**:
 * 客户端传了直接拒(§10.4「不静默忽略」)。两种 EXPLICIT 才是客户端提供的。
 *
 * 为什么 PATCH 需要这个判断:「不传 expiredAt = 保持库内现值」这句话对派生型规则
 * 不能照字面执行 —— 把库内那个**后端自己算出来的**值回传给 Resolver,会被
 * 「客户端不得传」那条规则拒成 18016。派生型的「保持现值」正确做法是**不传**,
 * 让规则按同一个 issuedAt 重新派生出同一个值。
 */
export function expiryIsClientSupplied(mode: CertificateValidityMode): boolean {
  return (
    mode === CertificateValidityMode.EXPLICIT_REQUIRED ||
    mode === CertificateValidityMode.EXPLICIT_OPTIONAL
  );
}

// certNumberMode 无跨字段组合约束(三种取值都自洽),此处仅做闭集兜底,
// 供将来新增取值时有一处集中的地方。
export function isKnownNumberMode(mode: CertificateNumberMode): boolean {
  return (
    mode === CertificateNumberMode.REQUIRED ||
    mode === CertificateNumberMode.OPTIONAL ||
    mode === CertificateNumberMode.NONE
  );
}

// ============ 机构名归一(§5.4)============

// 只用于**同一 DRAFT Policy 内部去重**,不做模糊匹配、不参与实例认可
// (实例认可靠 issuer id,D-CERT-021)。
//
// 规则(§5.4 逐条):trim → 连续空白折叠为单空格 → ASCII 大小写归一 →
// **不删除中文法律名称**(不去「有限公司」「中心」这类后缀,那会把两家不同机构折成一个)。
export function normalizeIssuerName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}
