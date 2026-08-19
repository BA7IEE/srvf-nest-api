import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * AC-070 判据 —— 「所有对外列表接口使用 page/pageSize;手机管理根路径保持
 * /api/app/v1/my/managed-activities;公开合同不出现 cursor」。
 *
 * 立项理由:这条要求此前**只写在注释里**(`src/common/dto/pagination.dto.ts` 顶部
 * 「禁止 limit/offset / skip/take / cursor 等变体」),没有任何执行位。也就是说
 * 新增一个 cursor 分页端点不会红 —— 与本仓「能做成机器检查的就不要只写成文字要求」相悖。
 *
 * 判据读的是**已生成的公开合同** `docs/handoff/openapi.json`,不是源码注释:
 * 该文件由 `pnpm docs:openapi:check` 重新生成后逐字节比对(CI 常驻),故不会陈旧。
 *
 * ⚠️ 判据按「缺陷会在哪一格翻面」布点,不是按「场景听起来全不全」布点:
 *   · 加一个 cursor / offset 参数        → ① 或 ④ 红
 *   · 只加 page 忘了 pageSize(或反之)  → ② 红
 *   · 新增一个分页信封却不声明分页参数    → ③ 红
 *   · 把手机管理根路径改掉                → ⑤ 红
 *   · 再给某个端点加 limit               → ④ 红(白名单是穷举的)
 */

type OpenApiSchema = {
  $ref?: string;
  allOf?: OpenApiSchema[];
  properties?: Record<string, OpenApiSchema>;
};

type OpenApiOperation = {
  parameters?: { name: string; in: string }[];
  responses?: Record<string, { content?: Record<string, { schema?: OpenApiSchema }> }>;
};

type OpenApiDocument = {
  paths: Record<string, Record<string, OpenApiOperation>>;
  components: { schemas: Record<string, OpenApiSchema> };
};

const CONTRACT_PATH = 'docs/handoff/openapi.json';

const rawContract = readFileSync(resolve(process.cwd(), CONTRACT_PATH), 'utf8');
const contract = JSON.parse(rawContract) as OpenApiDocument;

/** 合同点名禁止的分页变体。`page` / `pageSize` 是唯一合法形态。 */
const BANNED_PAGINATION_PARAMS = ['cursor', 'offset', 'skip', 'take'] as const;

/**
 * `limit` 的**穷举**例外清单:下拉选项端点返回的是有界选择器,不是分页列表信封
 * (它们没有 total/page/pageSize)。列成显式白名单而不是放宽正则 ——
 * 新增任何一个带 limit 的端点都会让 ④ 当场红,由人来判断它该不该在这里。
 *
 * 🔴 注意:这 8 个端点的有界性本身是 **AC-030 的缺口**(候选超过上限即不可达),
 *    在验收登记表里按 C 类如实留 todo,不在本条判据的射程内 —— 本条只管
 *    「对外**列表**接口的分页形态」,不替 AC-030 结案。
 */
const OPTIONS_ENDPOINTS_ALLOWED_TO_USE_LIMIT: readonly string[] = [
  'get /api/admin/v1/activities/options',
  'get /api/admin/v1/certificate-standards/options',
  'get /api/admin/v1/members/options',
  'get /api/admin/v1/organizations/options',
  'get /api/admin/v1/organizations/{orgId}/members/options',
  'get /api/admin/v1/positions/options',
  'get /api/admin/v1/users/options',
  'get /api/system/v1/roles/options',
];

/** 合同 §14 明写:手机管理根路径**保持**这一条,不得改写。 */
const MANAGED_ACTIVITIES_ROOT = '/api/app/v1/my/managed-activities';

interface OperationRef {
  readonly key: string;
  readonly parameterNames: readonly string[];
  readonly successSchema: OpenApiSchema | undefined;
}

function listOperations(): OperationRef[] {
  const found: OperationRef[] = [];
  for (const [path, methods] of Object.entries(contract.paths)) {
    for (const [method, operation] of Object.entries(methods)) {
      found.push({
        key: `${method} ${path}`,
        parameterNames: (operation.parameters ?? []).map((parameter) => parameter.name),
        successSchema: operation.responses?.['200']?.content?.['application/json']?.schema,
      });
    }
  }
  return found;
}

const operations = listOperations();

/**
 * 判断一个响应 schema 是否是分页信封(同时具备 total / page / pageSize 三个属性)。
 * 沿 `$ref` / `allOf` / `data` 下钻 —— 本仓统一响应信封把业务体裹在 `data` 里。
 */
function isPageEnvelope(schema: OpenApiSchema | undefined, depth = 0): boolean {
  if (schema === undefined || depth > 6) return false;
  if (schema.$ref !== undefined) {
    const name = schema.$ref.split('/').pop();
    if (name === undefined) return false;
    return isPageEnvelope(contract.components.schemas[name], depth + 1);
  }
  if (schema.allOf !== undefined) {
    return schema.allOf.some((member) => isPageEnvelope(member, depth + 1));
  }
  const properties = schema.properties;
  if (properties === undefined) return false;
  if (
    properties.total !== undefined &&
    properties.page !== undefined &&
    properties.pageSize !== undefined
  ) {
    return true;
  }
  return isPageEnvelope(properties.data, depth + 1);
}

describe('AC-070 对外列表分页契约(公开合同 docs/handoff/openapi.json)', () => {
  it('判据自身先自证:合同真的解析出了成规模的 operation(防空集恒真)', () => {
    // 空集会让下面每一条 `filter(...) → []` 断言恒真 —— 先把这个失效形状堵死。
    expect(operations.length).toBeGreaterThan(400);
    expect(Object.keys(contract.components.schemas).length).toBeGreaterThan(100);
  });

  it('① 合同里没有任何 operation 声明 cursor / offset / skip / take 参数', () => {
    const offenders = operations.flatMap((operation) =>
      operation.parameterNames
        .filter((name) => BANNED_PAGINATION_PARAMS.some((banned) => name.toLowerCase() === banned))
        .map((name) => `${operation.key} → ${name}`),
    );
    expect({ 声明了禁用分页参数的端点: offenders }).toEqual({ 声明了禁用分页参数的端点: [] });
  });

  it('② page 与 pageSize 恒成对出现 —— 只声明其一即红', () => {
    const unpaired = operations
      .filter((operation) => {
        const hasPage = operation.parameterNames.includes('page');
        const hasPageSize = operation.parameterNames.includes('pageSize');
        return hasPage !== hasPageSize;
      })
      .map((operation) => `${operation.key} → ${operation.parameterNames.join(',')}`);
    expect({ page_pageSize未成对的端点: unpaired }).toEqual({ page_pageSize未成对的端点: [] });
  });

  it('③ 每个返回分页信封的端点都声明了 page 与 pageSize', () => {
    const pagedOperations = operations.filter((operation) =>
      isPageEnvelope(operation.successSchema),
    );
    // 反向:探测器若因 schema 结构变化而全体失灵,本条会退化成恒真 —— 先钉住非空。
    expect(pagedOperations.length).toBeGreaterThan(50);

    const missing = pagedOperations
      .filter(
        (operation) =>
          !operation.parameterNames.includes('page') ||
          !operation.parameterNames.includes('pageSize'),
      )
      .map((operation) => operation.key);
    expect({ 分页信封却没声明分页参数的端点: missing }).toEqual({
      分页信封却没声明分页参数的端点: [],
    });
  });

  it('④ 只有穷举白名单里的下拉选项端点可以用 limit', () => {
    const usingLimit = operations
      .filter((operation) => operation.parameterNames.includes('limit'))
      .map((operation) => operation.key)
      .sort();
    expect(usingLimit).toEqual([...OPTIONS_ENDPOINTS_ALLOWED_TO_USE_LIMIT].sort());

    // 白名单里的端点必须**确实不是**分页信封 —— 否则它就该走 page/pageSize,
    // 白名单会变成给分页列表开的后门。
    const disguisedPagedOptions = operations
      .filter(
        (operation) =>
          OPTIONS_ENDPOINTS_ALLOWED_TO_USE_LIMIT.includes(operation.key) &&
          isPageEnvelope(operation.successSchema),
      )
      .map((operation) => operation.key);
    expect({ 白名单里其实是分页信封的端点: disguisedPagedOptions }).toEqual({
      白名单里其实是分页信封的端点: [],
    });
  });

  it('⑤ 公开合同全文零 cursor(合同 §14 逐字要求)', () => {
    // 按**原始文本**比,不按解析后的参数名比:描述、schema 名、example 里出现同样算数。
    expect(rawContract).not.toContain('cursor');
    expect(rawContract).not.toContain('Cursor');
  });

  it('⑥ 手机管理根路径保持 /api/app/v1/my/managed-activities', () => {
    const managedRoutes = Object.keys(contract.paths).filter((path) =>
      path.startsWith(`${MANAGED_ACTIVITIES_ROOT}/`),
    );
    // 两边都钉:前缀存在(不是被改名后恒空),且根路径本身也在合同里。
    expect(managedRoutes.length).toBeGreaterThan(0);
    expect(Object.keys(contract.paths)).toContain(MANAGED_ACTIVITIES_ROOT);

    // 反向:不得出现同义改写的第二个手机管理根(managed-activity / my-managed 等)。
    const rivalRoots = Object.keys(contract.paths).filter(
      (path) =>
        /\/api\/app\/v1\/my\/[a-z-]*managed[a-z-]*/u.test(path) &&
        !path.startsWith(MANAGED_ACTIVITIES_ROOT),
    );
    expect({ 与手机管理根并存的第二个根: rivalRoots }).toEqual({ 与手机管理根并存的第二个根: [] });
  });
});
