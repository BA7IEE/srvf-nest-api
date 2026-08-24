/**
 * 角色权限集变更预览的响应体构造(P1-32 PR 4b;冻结稿 §9.3)。
 *
 * ──────────────────────────────────────────────────────────────────────────
 * 🔴 **纯函数,零 DB,零判定**
 *
 * 本文件**不回答「这次变更能不能过」** —— 那个问题只有一个答案来源:
 * `RolePermissionsService.replaceRolePermissionSet()`(4a 落地的唯一写原语)。
 * 预览与真 `PUT` 走的是**同一次调用**,差别只有一个参数(`commitMeta === null` ⇒ 零写入)。
 *
 * 本文件只做两件搬运:
 *   ① 把原语算出来的 delta 摆成响应形状(排序、条数、版本号预测);
 *   ② 把原语抛出来的 `BizException` 摆成 `blockingIssues[0]`(冻结稿逐字「deny/blocked
 *      作为 200 数据返回」)。
 *
 * ⚠️ **②「搬运」这个词是本文件全部的设计约束**:它读 `error.biz` 的三个字段,
 *    **不做任何 code → 语义的映射、不分类、不重写文案**。一旦这里出现
 *    「哪些码算 blocking、哪些算 warning」之类的判断,那就是第二份真相 ——
 *    「预览说能过、真 PUT 拒绝」正是这样长出来的,而它**没有任何症状**。
 *
 * 纯函数的好处不是省一次查询,而是**判据可以直接跑它并断言真实响应体**
 * (`scripts/check-role-permission-read-preview.ts` import 本文件)——
 * 沿 PR 2 的 `permission-catalog.presenter.ts` 同一范式。
 */
import type { BizCodeEntry } from '../../common/exceptions/biz-code.constant';
import { PERMISSION_CATALOG_METADATA } from './permission-catalog';
import type {
  RolePermissionDiffItemDto,
  RolePermissionPreviewOutcomeDto,
  RolePermissionPreviewResponseDto,
} from './role-permissions.dto';

/**
 * 唯一写原语算出来的这次变更的全貌。
 *
 * 🔴 **`PUT` 与 `preview` 拿到的是同一个对象** —— `PUT` 用它写 audit(`addedCodes` /
 *    `removedCodes` / `resultCodes` / 两个 revision),`preview` 用它渲染响应。
 *    定义放在 presenter 这边而不是 service 里,是为了让「渲染层不许自己算」这件事在
 *    import 方向上就成立:presenter 只**收**结论,不认识 Prisma 也不认识请求上下文。
 */
export interface RolePermissionSetDelta {
  /** 目标集合与现状相同 ⇒ 真提交时不写、不 +1、不留痕。 */
  readonly noOp: boolean;
  readonly addedCodes: readonly string[];
  readonly removedCodes: readonly string[];
  /** 提交后该角色会持有的权限码全集。 */
  readonly resultCodes: readonly string[];
  /** 既在现状又在目标里、这次不动的条数。 */
  readonly unchangedCount: number;
  /** 锁内读到的当前版本号。 */
  readonly fromRevision: number;
  /**
   * 版本号。
   * · `PUT`     = 库里 `increment` 之后的**真值**;
   * · `preview` = `fromRevision + (noOp ? 0 : 1)` 的**预测值**(没有写库,拿不到真值)。
   */
  readonly toRevision: number;
}

const sortedCodes = (codes: readonly string[]): string[] => [...codes].sort();

/**
 * 权限码 → 目录里的中文名与风险等级。
 *
 * ⚠️ 目录里没有该码时返 `null` 而**不是**跳过这一条:跳过会让「差集里少了一条」
 *    变成零症状,而差集是这个端点的全部价值。
 *    (今天这条分支只在历史脏数据上可达 —— 运行时造不出目录外的 Permission 行,
 *    `POST /permissions` 对闭包外的码返 30106。)
 */
export function describePermissionCode(code: string): RolePermissionDiffItemDto {
  const meta = PERMISSION_CATALOG_METADATA[code];
  return {
    code,
    displayName: meta === undefined ? null : meta.displayName,
    riskLevel: meta === undefined ? null : meta.riskLevel,
  };
}

const describeAll = (codes: readonly string[]): RolePermissionDiffItemDto[] =>
  sortedCodes(codes).map(describePermissionCode);

/** delta → 预览结论。 */
export function buildPreviewOutcome(
  delta: RolePermissionSetDelta,
): RolePermissionPreviewOutcomeDto {
  return {
    noOp: delta.noOp,
    currentRevision: delta.fromRevision,
    nextRevision: delta.toRevision,
    added: describeAll(delta.addedCodes),
    removed: describeAll(delta.removedCodes),
    unchangedCount: delta.unchangedCount,
    resultCodes: sortedCodes(delta.resultCodes),
  };
}

/** 判定通过 —— `valid: true`,零 blocking。 */
export function buildRolePermissionPreview(
  delta: RolePermissionSetDelta,
): RolePermissionPreviewResponseDto {
  return { valid: true, blockingIssues: [], outcome: buildPreviewOutcome(delta) };
}

/**
 * 判定拦下 —— 把 `PUT` 会抛的那个 `BizException` 原样摆成数据。
 *
 * 🔴 三个字段全部**直接取自** `error.biz`,一个都不重写:`bizCode` / `message` /
 *    `httpStatus` 与 `PUT` 的错误响应逐字相同。这条「原样搬运」是
 *    「预览说能过 ⟺ PUT 会过」能成立的另一半。
 *
 * ⚠️ 恒**只有一条**。写路径 fail-fast,第一道闸拦下就不跑后面的;
 *    要凑齐多条就得在锁外另跑一遍判定 —— 那就是第二份真相。
 */
export function buildBlockedRolePermissionPreview(
  biz: BizCodeEntry,
): RolePermissionPreviewResponseDto {
  return {
    valid: false,
    blockingIssues: [{ bizCode: biz.code, message: biz.message, httpStatus: biz.httpStatus }],
    outcome: null,
  };
}
