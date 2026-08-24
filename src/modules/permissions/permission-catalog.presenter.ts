/**
 * 权限目录只读投影(P1-32 PR 2)—— `GET /api/system/v1/permissions/catalog` 的响应体构造。
 *
 * ──────────────────────────────────────────────────────────────────────────
 * 🔴 **纯函数,零 DB**
 *
 * 目录是**代码事实**不是运行时数据:权限码的定义与元数据都在
 * [`permission-catalog.ts`](permission-catalog.ts)(红区,改它要过人闸)。
 * 所以本投影不查库、不接收任何请求上下文 —— 好处不是省一次查询,而是
 * **判据可以直接跑它并断言真实响应体**:`scripts/check-role-classification.ts`
 * import 本函数,对着它产出的 payload 逐条查中文说明、查条目数地板。
 * 换成查库版就只能在 e2e 里验,而 e2e 验不到「未来某天说明字段被删掉」这类形状。
 *
 * ⚠️ 别把它改成读 `Permission` 表 —— 那张表由 seed 从同一份定义 upsert 而来,
 *    多绕一层不会更真,反而让判据失去可执行性。「运行时 DB 行 == 清单」这条
 *    另有执行位:`test/e2e/seed-permission-catalog-runtime.e2e-spec.ts`。
 *
 * ──────────────────────────────────────────────────────────────────────────
 * 全集从哪来:两份**互相咬合**的事实,不是一份
 *
 *   ① `PERMISSION_CATALOG_METADATA` —— 中文名 / 说明 / 分类 / 风险 / 授予策略(PR 0 落地);
 *   ② 各 `*_PERMISSION_SEED` 数组 —— `module` / `action` / `resourceType`(权限码定义本体)。
 *
 * ⚠️ **不要改用 `ALL_PERMISSION_SEED` 当 ② 的全集** —— 它是**具名子集不是闭包**
 * (实测只装 rbac/PR-2A/PR-2B/user/audit/sms/wechat/wecom/realname/authz/announcement-import/
 * meta/member-account/notification-replay,不含 attachment / member / activity / 招新 / 保险……)。
 * 这里按导出名后缀 `_PERMISSION_SEED` 反射取并集,实测 237 = 元数据条目数,两向零差集。
 * 反射会不会漏掉「将来某个不叫这个后缀的新数组」?会 —— 所以判据对这条做**双向集合相等**
 * 并带地板锚点:漏一条就当场红并点名,不会静默缩水。
 */
import * as catalogModule from './permission-catalog';
import {
  PERMISSION_CATALOG_GROUPS,
  PERMISSION_CATALOG_METADATA,
  PERMISSION_CATALOG_SECTIONS,
} from './permission-catalog';
import type { RbacPermissionSeed } from './permission-catalog';
import {
  PermissionCatalogGroupDto,
  PermissionCatalogItemDto,
  PermissionCatalogResponseDto,
  PermissionCatalogSectionDto,
} from './permissions.dto';

/** 权限码定义(module / action / resourceType)的导出名后缀约定。 */
const SEED_ARRAY_SUFFIX = '_PERMISSION_SEED';

/**
 * 权限码 → 定义。按导出名后缀反射各 `*_PERMISSION_SEED` 数组取并集。
 *
 * 聚合数组(`PR_2A_PERMISSION_SEED` 等)是对子数组的 spread,同一个 code 会重复出现 ——
 * 重复项指向同一个对象,后写覆盖先写不改变任何值。判据另断言「同码不同定义」为空。
 */
function buildSeedIndex(): ReadonlyMap<string, RbacPermissionSeed> {
  const index = new Map<string, RbacPermissionSeed>();
  for (const [exportName, exported] of Object.entries(catalogModule)) {
    if (!exportName.endsWith(SEED_ARRAY_SUFFIX)) continue;
    if (!Array.isArray(exported)) continue;
    for (const entry of exported as ReadonlyArray<RbacPermissionSeed>) {
      index.set(entry.code, entry);
    }
  }
  return index;
}

/** 模块加载时算一次:输入全是 frozen 常量,结果恒定。 */
const SEED_INDEX = buildSeedIndex();

/** 权限码 → 定义。判据与投影共用同一份,不各建一份索引。 */
export function permissionSeedIndex(): ReadonlyMap<string, RbacPermissionSeed> {
  return SEED_INDEX;
}

function bySortOrderThenCode<T extends { sortOrder: number; code: string }>(a: T, b: T): number {
  if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
  return a.code < b.code ? -1 : a.code > b.code ? 1 : 0;
}

/**
 * 构造完整目录响应体。
 *
 * 形状沿冻结稿 §9.1 的 `PermissionCatalogResponseDto` —— 两级分组(业务区 → 分组 → 条目),
 * 一次返回全部条目、**不分页**(例外已登记进
 * [`response-pagination-errors.md`](../../../docs/reference/response-pagination-errors.md) §4)。
 *
 * ⚠️ 冻结稿 §9.1 建议里的 `catalogVersion` / `catalogHash` **本期不出** ——
 *    前者仓内没有任何事实源(硬造一个手维护的数字 = 又一份会静默漂移的真相),
 *    后者的用途是给 §9.3 的 preview 绑版本,而 preview 属 PR 4b/5,那时再加是 additive。
 *    同理 §9.1 条目里的 `technicalDescription` / `replacementCodes`:PR 0 刻意一条都没出
 *    (见 `PermissionCatalogMetadata` 头注),这里没有东西可返。
 */
export function buildPermissionCatalog(): PermissionCatalogResponseDto {
  const itemsByGroup = new Map<string, PermissionCatalogItemDto[]>();
  let totalItems = 0;

  for (const [code, meta] of Object.entries(PERMISSION_CATALOG_METADATA)) {
    const seed = SEED_INDEX.get(code);
    // 缺定义的码不静默丢弃 —— 丢弃会让「元数据有、定义没了」变成零症状。
    // 判据对这条做双向集合相等;运行时取空串而不是 undefined,保持契约字段稳定。
    const item: PermissionCatalogItemDto = {
      code,
      displayName: meta.displayName,
      businessDescription: meta.businessDescription,
      module: seed?.module ?? '',
      action: seed?.action ?? '',
      resourceType: seed?.resourceType ?? '',
      sectionCode: meta.sectionCode,
      groupCode: meta.groupCode,
      sortOrder: meta.sortOrder,
      riskLevel: meta.riskLevel,
      riskTags: [...meta.riskTags],
      grantPolicy: meta.grantPolicy,
      status: meta.status,
      uiVisibility: meta.uiVisibility,
    };
    const bucket = itemsByGroup.get(meta.groupCode);
    if (bucket === undefined) itemsByGroup.set(meta.groupCode, [item]);
    else bucket.push(item);
    totalItems += 1;
  }

  const groupsBySection = new Map<string, PermissionCatalogGroupDto[]>();
  for (const group of [...PERMISSION_CATALOG_GROUPS].sort(bySortOrderThenCode)) {
    const groupDto: PermissionCatalogGroupDto = {
      code: group.code,
      displayName: group.displayName,
      sortOrder: group.sortOrder,
      items: (itemsByGroup.get(group.code) ?? []).sort(bySortOrderThenCode),
    };
    const bucket = groupsBySection.get(group.sectionCode);
    if (bucket === undefined) groupsBySection.set(group.sectionCode, [groupDto]);
    else bucket.push(groupDto);
  }

  const sections: PermissionCatalogSectionDto[] = [...PERMISSION_CATALOG_SECTIONS]
    .sort(bySortOrderThenCode)
    .map((section) => ({
      code: section.code,
      displayName: section.displayName,
      sortOrder: section.sortOrder,
      groups: groupsBySection.get(section.code) ?? [],
    }));

  return { totalItems, sections };
}
