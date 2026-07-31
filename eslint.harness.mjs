// @ts-check
// Harness 3.0 · P2 执法迁移 —— eslint 执法块(唯一定义处)。
//
// 单独成文件的原因:scripts/harness-eslint.selftest.ts 要 import 这份**同一份**规则做
// 阳性对照(喂必定违规的合成片段,断言确实被抓到)。若自测另起一套配置,验的就不是
// 真正生效的规则,「全绿」将毫无意义。
//
// ⚠️ flat config 对同一 ruleId 是「后块整体覆盖前块」(不是数组合并)。因此**在
//    `no-restricted-syntax` 这一个 ruleId 上**:
//   - 每个作用域块必须**显式重列完整规则集**(用 syntax(...) 组合器),
//     窄域豁免写成 filter 减掉那一条,而不是只写要加的那条;
//   - 块的先后顺序是语义的一部分,见各块注释里的排序约束。
// 违反上述任一条会让规则**静默失效**(lint 依然绿,但没有防线)——
// scripts/harness-eslint.selftest.ts 就是为了捕捉这种失效。
//
// 📌 2026-07-31(第五轮评审 J2)起,第 18 条**不再受这条约束** —— 它换成了独立
//    ruleId 的自定义规则 srvf/no-nullable-is-optional。它的 56 个基线块只碰自己
//    那一个 ruleId,与上述 17 条零交互:「重列完整规则集」这个陷阱在第 18 条上
//    **结构性消失**,不是靠注释提醒人别踩。规则体在 eslint-rules/(同在红区)。

import { readFileSync } from 'node:fs';

import {
  NULLABLE_IS_OPTIONAL_MESSAGE,
  srvfEslintPlugin,
} from './eslint-rules/no-nullable-is-optional.mjs';

// 第 18 条的 ruleId。它**不是** no-restricted-syntax 的一条选择器,而是本仓唯一的
// 自定义规则(eslint-rules/no-nullable-is-optional.mjs)。独立 ruleId 是刻意的:
// 18 条共用一个 ruleId 时,一句 `// eslint-disable-next-line no-restricted-syntax`
// 会把该行的**全部 18 条**一起关掉(第五轮评审 J2·L3 实测)。
const NULLABLE_IS_OPTIONAL_RULE = 'srvf/no-nullable-is-optional';

// ===================== Harness 3.0 · P2 执法迁移 =====================
// 规则语义零放宽,只换执法方式。message 三段式 = 规则一句话 + AGENTS 出处 + 正确做法。
// key 即「载体 id」,供 AGENTS §1/§2 表的「载体」列引用(AL-8/AL-9 自证的落点)。
const HARNESS_SYNTAX = {
  'no-use-guards': {
    selector: "Decorator[expression.callee.name='UseGuards']",
    message:
      'Guard 全局注册,禁在 controller/handler 上 @UseGuards。[AGENTS §1 鉴权] 正确做法:JwtAuthGuard/RolesGuard 已在 app.module.ts 以 APP_GUARD 全局注册;公开接口标 @Public(),业务判权写在 Service 内 rbac.can()。细则 docs/reference/auth-jwt-refresh.md。',
  },
  'no-roles-decorator': {
    selector: "Decorator[expression.callee.name='Roles']",
    message:
      '判权单轨:全仓活跃 @Roles = 0,禁给任何端点重新挂 @Roles 入口判权。[AGENTS §1 鉴权 + §2 判权单轨] 正确做法:入口仅全局 JwtAuthGuard,判权写在 Service 内 rbac.can(权限码) 并抛 RBAC_FORBIDDEN(30100)。RolesGuard 保留为防御性兜底,不删也不用。',
  },
  'no-bare-api-ok-response': {
    selector: "Decorator[expression.callee.name='ApiOkResponse']",
    message:
      '禁裸 @ApiOkResponse:响应被全局 ResponseInterceptor 包成 {code,message,data},裸装饰器会让 OpenAPI 契约与实际响应不符。[AGENTS §1 Swagger] 正确做法:用 @ApiWrappedOkResponse / @ApiWrappedPageResponse(src/common/decorators/api-response.decorator.ts)。细则 docs/reference/swagger.md。',
  },
  'no-local-validation-pipe': {
    selector: "NewExpression[callee.name='ValidationPipe']",
    message:
      '禁局部 new ValidationPipe:全局 ValidationPipe(whitelist + forbidNonWhitelisted + transform)已在 src/bootstrap/apply-global-setup.ts 注册,局部重复=两套白名单语义。[AGENTS §1 校验] 正确做法:改 DTO,不改管道。',
  },
  'no-prisma-middleware': {
    selector: "CallExpression[callee.property.name='$use']",
    message:
      '禁 Prisma 中间件 $use:全局软删中间件是永久禁止项(会让 findUnique 唯一性预检查失效)。[AGENTS §1 软删除 + §2 永久铁律] 正确做法:每处查询显式带 notDeletedWhere。细则 docs/reference/soft-delete-transactions.md。',
  },
  'no-prisma-client-extension': {
    selector: "CallExpression[callee.property.name='$extends']",
    message:
      '禁 Prisma client extension($extends):与全局软删中间件同源风险——把过滤语义藏进 client,审计时看不见。[AGENTS §2 永久铁律] 正确做法:显式 where + notDeletedWhere。',
  },
  'no-hard-delete-tx': {
    selector:
      "CallExpression[callee.property.name=/^(delete|deleteMany)$/][callee.object.object.name=/^(prisma|tx)$/]",
    message:
      '禁硬删:业务数据一律软删。[AGENTS §1 软删除] 正确做法:update({ data: { deletedAt: new Date() } }),读侧统一带 notDeletedWhere。确属关联表/会话表物理清理(已冻结 6 处)须在 PR 说明并加 `// eslint-disable-next-line no-restricted-syntax -- <原因>`。细则 docs/reference/soft-delete-transactions.md。',
  },
  'no-hard-delete-this-prisma': {
    selector:
      "CallExpression[callee.property.name=/^(delete|deleteMany)$/][callee.object.object.property.name='prisma']",
    message:
      '禁硬删:业务数据一律软删。[AGENTS §1 软删除] 正确做法:update({ data: { deletedAt: new Date() } }),读侧统一带 notDeletedWhere。确属关联表/会话表物理清理(已冻结 6 处)须在 PR 说明并加 `// eslint-disable-next-line no-restricted-syntax -- <原因>`。',
  },
  'no-prisma-enum-redefine': {
    selector:
      "TSEnumDeclaration[id.name=/^(Role|UserStatus|DictTypeStatus|DictItemStatus|OrganizationStatus|PositionCategory|PolicyStatus|AssignmentStatus|SupervisionScopeMode|SupervisionStatus|MemberStatus|MembershipType|MembershipStatus|ContributionRuleStatus|PrincipalType|BindingScopeType|BindingStatus|PolicyScopeMode|AttachmentAccessLevel|AttachmentTypeConfigStatus|AttachmentMimeConfigStatus|StorageProviderType|StorageMimePolicyMode|SmsProviderType|SmsPurpose|SmsSendStatus|WechatProviderType|RealnameProviderType)$/]",
    message:
      '该名字是 prisma/schema.prisma 已定义的 enum,禁在 TS 侧重定义(会静默漂移)。[AGENTS §1 命名] 正确做法:import { X } from "@prisma/client"。名单由 pnpm harness:guard 从 schema 同步;本地新 enum 请另起名(如 XxxCredentialStatus)。',
  },
  'no-manual-response-wrap': {
    selector:
      "ReturnStatement > ObjectExpression:has(Property[key.name='code']):has(Property[key.name='message'])",
    message:
      '禁手工包 {code,message,...}:全局 ResponseInterceptor 已统一包装,再包一层会变成 data.code。[AGENTS §1 响应格式] 正确做法:只 return 业务 data;错误一律 throw new BizException(BizCode.X)。细则 docs/reference/response-pagination-errors.md。',
  },
  'no-mapped-type-dto': {
    selector: "CallExpression[callee.name=/^(PickType|OmitType|PartialType|IntersectionType)$/]",
    message:
      '禁 Swagger Mapped Types 派生 DTO:派生让 App/Admin 出参隐式联动,一次 Admin 加字段就可能把 L3 泄到 App。[AGENTS §1 DTO 边界 + §2 D-6] 正确做法:显式重写字段(本仓 DTO 全部显式声明,零 Mapped Type)。细则 docs/reference/naming-dto-validation.md。',
  },
  'no-local-strategy': {
    selector: "CallExpression[callee.name='AuthGuard'][arguments.0.value='local']",
    message:
      "不引入 LocalStrategy / AuthGuard('local')。[AGENTS §2 永久铁律] 正确做法:登录在 AuthService 内显式校验凭据、签发 JWT,由 JwtStrategy 单轨消费。",
  },
  'no-pagination-alias': {
    selector:
      "ClassDeclaration:not([id.name=/OptionsQueryDto$/]) > ClassBody > PropertyDefinition[key.name=/^(limit|offset|cursor|skip|take)$/]",
    message:
      '分页入参固定 page / pageSize,禁 limit / offset / cursor / skip / take 变体。[AGENTS §1 响应格式] 正确做法:extends PaginationQueryDto(src/common/dto/pagination.dto.ts)。唯一例外:不分页的下拉候选 DTO,类名须以 OptionsQueryDto 结尾。',
  },
  'no-process-env': {
    selector: "MemberExpression[object.name='process'][property.name='env']",
    message:
      '禁散落 process.env(含 NODE_ENV)。[AGENTS §1 配置归属] 正确做法:在 src/config/*.config.ts 解析 + production fail-fast,业务侧用 ConfigService.get<XConfig>("x");业务判断只用 APP_ENV。细则 docs/reference/config-env.md。',
  },
  'no-identity-cache': {
    selector: "PropertyDefinition[value.callee.name=/^(Map|WeakMap)$/]",
    message:
      '判权/身份路径禁跨请求 Map/WeakMap 缓存。[AGENTS §2 身份/权限不缓存] 正确做法:RbacService 每次判权直读 PostgreSQL 当前 GLOBAL 权限,JwtStrategy.validate 每请求查库;性能问题走索引,不走缓存(TTL = 「改了权限没生效」的正确性链)。',
  },
  'no-identity-timer': {
    selector: "CallExpression[callee.name=/^(setInterval|setTimeout)$/]",
    message:
      '判权/身份路径禁定时器(TTL / 失效链的入口)。[AGENTS §2 身份/权限不缓存] 正确做法:不缓存,不定时刷新。',
  },
  'no-param-id-string': {
    selector: "Decorator[expression.callee.name='Param'][expression.arguments.0.value='id']",
    message:
      "`:id` 一律走 IdParamDto:@Param('id') id: string 绕过 DTO 白名单,长度/类型全不校验。[AGENTS §1 校验] 正确做法:@Param() params: IdParamDto(src/common/dto/id-param.dto.ts),取 params.id。存量 19 个 controller 已在 LEGACY_PARAM_ID_CONTROLLERS 冻结(只减不增),新文件一律禁止。",
  },
};

const syntax = (...ids) => ['error', ...ids.map((id) => HARNESS_SYNTAX[id])];

// 全仓通用集(src / test / prisma 都判)
const BASE = [
  'no-use-guards',
  'no-roles-decorator',
  'no-bare-api-ok-response',
  'no-local-validation-pipe',
  'no-prisma-middleware',
  'no-prisma-client-extension',
  'no-prisma-enum-redefine',
  'no-manual-response-wrap',
  'no-mapped-type-dto',
  'no-local-strategy',
  'no-pagination-alias',
  // 第 18 条不在这里 —— 它是独立 ruleId 的自定义规则,接线见下方
  // `srvf/harness:nullable-is-optional` 块。
];

// src 业务代码 = 通用集 + 禁 process.env + 禁硬删
// (硬删只判 src:test 造数/清场硬删实测 209 处合法,prisma/seed 亦然)
const SRC = [...BASE, 'no-process-env', 'no-hard-delete-tx', 'no-hard-delete-this-prisma'];

// BASELINE:存量 71 处 @Param('id') 所在的 19 个 controller。只减不增;
// 某文件清零后删掉对应行,规则自动对该文件生效。清零全部后整块删除。
const LEGACY_PARAM_ID_CONTROLLERS = [
  'src/modules/certificates/certificates.controller.ts',
  'src/modules/content/content-admin.controller.ts',
  'src/modules/content/content-app.controller.ts',
  'src/modules/content/content-public.controller.ts',
  'src/modules/emergency-contacts/emergency-contacts.controller.ts',
  'src/modules/insurances/controllers/app-me-insurances.controller.ts',
  'src/modules/insurances/team-insurance-policies.controller.ts',
  'src/modules/member-departments/memberships-admin.controller.ts',
  'src/modules/member-departments/memberships.controller.ts',
  'src/modules/notifications/notification-admin.controller.ts',
  'src/modules/notifications/notification-app.controller.ts',
  'src/modules/position-assignments/position-assignments.controller.ts',
  'src/modules/recruitment/recruitment-applications.admin.controller.ts',
  'src/modules/recruitment/recruitment-cycles.controller.ts',
  'src/modules/role-bindings/role-bindings.controller.ts',
  'src/modules/supervision-assignments/supervision-assignments.controller.ts',
  'src/modules/team-join/team-join-applications.admin.controller.ts',
  'src/modules/team-join/team-join-applications.app.controller.ts',
  'src/modules/team-join/team-join-cycles.controller.ts',
];

// ── 第 18 条的存量基线:唯一机读源 = harness/is-optional-null-baseline.json ──────
//
// 为什么从本文件抽成独立 JSON(第五轮评审 J2 · L1):base-trusted 裁判要读
// **PR head 上的**这份清单,做「HEAD ⊆ BASE」的单调性比较 —— 而它的铁律是
// **只 parse 不执行**。基线埋在 .mjs 里时,裁判只有两条路:import 它
// (= 在有 secrets 的进程里执行 PR 代码,pull_request_target 的经典事故形态),
// 或正则抠它(= 第二把尺子,读数迟早和真尺子不一样)。两条都不可接受。
// 换成 JSON,「读 PR 的判据」就退化成一次纯粹的反序列化。
//
// 为什么键是「类名.字段名」而不是行号:行号一改基线就变噪音;而 `description`
// 这类字段名在同一文件的多个 DTO 类里各出现一次,只写字段名**区分不开**
// 「已冻结的那个」和「新加的那个」—— 而后者正是棘轮要拦的东西。
//
// 只减不增,三道执行位各管一段 —— 少任何一道棘轮都会退化成单向:
//   · 往**已在基线的文件**新增违规字段 → `pnpm lint` 当场红(豁免精确到类名.字段名)
//   · 修好一个存量却忘了删基线行     → `pnpm harness:selftest` 当场红(陈旧行 = 基线在说谎)
//   · **同一个 PR 里新增违规 + 顺手把它加进基线** → base-trusted 裁判硬拦
//     (前两道都拦不住这一种:lint 看的是 PR 自己的基线,自然放行)
const BASELINE_PATH = 'harness/is-optional-null-baseline.json';

/** 只允许这三个顶层键。多一个都拒 —— 防「加个 allowGlob: true 就放宽」那类演化。 */
const BASELINE_TOP_KEYS = new Set(['_comment', 'version', 'entries']);
/** glob 元字符:任何一个混进 file,一条具名豁免就变成整片豁免。 */
const BASELINE_GLOB_META_RE = /[*?[\]{}!()+@|]/;
/** `类名.字段名` —— 恰好一个点,两侧都是合法 JS 标识符。 */
const BASELINE_SYMBOL_RE = /^[A-Za-z_$][A-Za-z0-9_$]*\.[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * 解析并**严格校验**基线文档,返回 `Map<file, symbol[]>`。
 *
 * 六条格式约束(E1–E6)违反任一条 → **加载即抛**,不是警告。
 * 理由:一个格式松散的棘轮文件等于没有棘轮 —— 光是让 `src/**` 这样一条
 * glob 混进 entries,就能把整个目录静默豁免掉,而 lint 依旧全绿。
 * 抛在加载期意味着 `pnpm lint` 本身起不来,响亮地坏,好过静默地坏。
 *
 * 导出是为了让 scripts/harness-eslint.selftest.ts 直接喂畸形文档做**阳性对照** ——
 * 六条约束逐条都要有一个「这样写会被拒」的证据,而不是靠读代码相信。
 *
 * @param {string} text
 * @returns {Map<string, string[]>}
 */
function parseIsOptionalNullBaseline(text) {
  const fail = (code, msg) => {
    throw new Error(`[${BASELINE_PATH}] ${code} ${msg}`);
  };

  let doc;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    fail('E0', `不是合法 JSON:${String(err)}`);
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) fail('E0', '顶层必须是对象');
  for (const k of Object.keys(doc)) {
    if (!BASELINE_TOP_KEYS.has(k)) fail('E0', `未知顶层键 ${JSON.stringify(k)}`);
  }
  if (doc.version !== 1) fail('E0', `version 必须是 1,实际 ${JSON.stringify(doc.version)}`);
  if (!Array.isArray(doc.entries)) fail('E0', 'entries 必须是数组');

  /** @type {Map<string, string[]>} */
  const byFile = new Map();
  const seen = new Set();
  /** @type {{ file: string, symbol: string } | null} */
  let prev = null;

  for (let i = 0; i < doc.entries.length; i++) {
    const entry = doc.entries[i];
    const at = `entries[${i}]`;
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      fail('E0', `${at} 必须是对象`);
    }
    const keys = Object.keys(entry).sort();
    if (keys.length !== 2 || keys[0] !== 'file' || keys[1] !== 'symbol') {
      fail('E0', `${at} 只能有 file 与 symbol 两个键,实际 [${keys.join(', ')}]`);
    }
    const { file, symbol } = entry;
    if (typeof file !== 'string' || typeof symbol !== 'string') {
      fail('E0', `${at} file / symbol 必须是字符串`);
    }

    // E1 精确 .ts 路径(.d.ts 里不可能有装饰器,出现即是写错了)
    if (!file.endsWith('.ts') || file.endsWith('.d.ts')) {
      fail('E1', `${at} file 必须是精确的 .ts 源文件路径:${JSON.stringify(file)}`);
    }
    // E2 禁 glob 元字符 —— 一个 `*` 就能把一条具名豁免膨胀成整片豁免
    if (BASELINE_GLOB_META_RE.test(file)) {
      fail('E2', `${at} file 禁含 glob 元字符(豁免必须逐文件具名):${JSON.stringify(file)}`);
    }
    // E3 禁 `..` / 绝对路径 / 反斜杠 / 空段 —— 全是「豁免逃出仓库范围」的形状
    if (
      file.startsWith('/') ||
      /^[A-Za-z]:/.test(file) ||
      file.includes('\\') ||
      file.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')
    ) {
      fail(
        'E3',
        `${at} file 必须是仓库内的相对 POSIX 路径(禁 ../ 绝对路径 反斜杠 空段):${JSON.stringify(file)}`,
      );
    }
    // E4 symbol 必须是「类名.字段名」 —— 只写字段名区分不开同文件的多个 DTO 类
    if (!BASELINE_SYMBOL_RE.test(symbol)) {
      fail('E4', `${at} symbol 必须是「类名.字段名」:${JSON.stringify(symbol)}`);
    }
    // E5 (file, symbol) 全局唯一 —— 重复行会让「删一条」看起来像已经删干净
    const key = `${file} ${symbol}`;
    if (seen.has(key)) fail('E5', `${at} 重复条目:${file} ${symbol}`);
    seen.add(key);
    // E6 按 (file, symbol) 严格升序 —— 排序稳定,diff 里「加了一行」才一眼可见
    if (prev !== null && !(prev.file < file || (prev.file === file && prev.symbol < symbol))) {
      fail('E6', `${at} 未按 (file, symbol) 严格升序:${prev.file} ${prev.symbol} → ${file} ${symbol}`);
    }
    prev = { file, symbol };

    const list = byFile.get(file);
    if (list) list.push(symbol);
    else byFile.set(file, [symbol]);
  }

  return byFile;
}

const IS_OPTIONAL_NULL_BASELINE = parseIsOptionalNullBaseline(
  readFileSync(new URL(`./${BASELINE_PATH}`, import.meta.url), 'utf-8'),
);

const FORBIDDEN_IMPORT_PATHS = [
  {
    name: 'passport-local',
    message:
      '不引入 LocalStrategy。[AGENTS §2 永久铁律] 正确做法:登录在 AuthService 内显式校验凭据 + JwtStrategy 单轨。',
  },
  {
    name: '@nestjs/mapped-types',
    message:
      '禁 Mapped Types 派生 DTO。[AGENTS §1 DTO 边界] 正确做法:显式重写字段,保持 App / Admin DTO 物理隔离。',
  },
  {
    name: '@nestjs/cache-manager',
    message:
      '不引入缓存层。[AGENTS §2 身份/权限不缓存 + 基础设施冻结] 身份与权限必须每请求直读 PostgreSQL;任何 TTL 都会制造「改了权限没生效」的正确性链。',
  },
  {
    name: 'cache-manager',
    message:
      '不引入缓存层。[AGENTS §2 身份/权限不缓存 + 基础设施冻结] 身份与权限必须每请求直读 PostgreSQL。',
  },
  {
    name: 'ioredis',
    message:
      'Redis 不引入(改锁需 D 档评审)。[AGENTS §2 基础设施冻结] 正确做法:异步派发走既有 notification_outbox 表 + cron(全仓恰 2 个)。',
  },
  { name: 'redis', message: 'Redis 不引入(改锁需 D 档评审)。[AGENTS §2 基础设施冻结]' },
  {
    name: 'bullmq',
    message: 'queue 不引入(改锁需 D 档评审)。[AGENTS §2 基础设施冻结] 正确做法:outbox 表 + cron。',
  },
  {
    name: 'bull',
    message: 'queue 不引入(改锁需 D 档评审)。[AGENTS §2 基础设施冻结] 正确做法:outbox 表 + cron。',
  },
  {
    name: '@nestjs/bull',
    message: 'queue 不引入(改锁需 D 档评审)。[AGENTS §2 基础设施冻结] 正确做法:outbox 表 + cron。',
  },
];

const FORBIDDEN_IMPORT_PATTERNS = [
  {
    // ⚠ group 匹配的是 import 说明符字面量(不是解析后的绝对路径),必须写相对形态。
    group: [
      '../*/controllers/*',
      '../*/strategies/*',
      '../*/providers/*',
      '../../*/controllers/*',
      '../../*/strategies/*',
      '../../*/providers/*',
      '**/modules/*/controllers/*',
      '**/modules/*/strategies/*',
      '**/modules/*/providers/*',
    ],
    message:
      '禁跨模块深引另一模块的 controllers/ · strategies/ · providers/ 私有子目录(grab-bag)。[AGENTS §1 模块结构] 正确做法:只经对方 *.service.ts / *.module.ts / *.types.ts / *.constants.ts 公开面交互。',
  },
];

const harnessConfigBlocks = [
  // (a) test / prisma:通用集(不判 process.env / 硬删 —— e2e 造数清场与 seed 合法)
  {
    name: 'srvf/harness:test-prisma',
    files: ['test/**/*.ts', 'prisma/**/*.ts'],
    rules: {
      'no-restricted-syntax': syntax(...BASE),
      'no-restricted-imports': ['error', { paths: FORBIDDEN_IMPORT_PATHS }],
    },
  },

  // (b) src 业务代码:通用集 + 禁 process.env + 禁硬删 + 禁跨模块深引私有子目录
  {
    name: 'srvf/harness:src',
    files: ['src/**/*.ts'],
    rules: {
      'no-restricted-syntax': syntax(...SRC),
      'no-restricted-imports': [
        'error',
        { paths: FORBIDDEN_IMPORT_PATHS, patterns: FORBIDDEN_IMPORT_PATTERNS },
      ],
    },
  },

  // (c) src 内单测:可直连另一模块 providers 做桩、可 new ValidationPipe 验 DTO
  {
    name: 'srvf/harness:src-spec',
    files: ['src/**/*.spec.ts'],
    rules: {
      'no-restricted-imports': ['error', { paths: FORBIDDEN_IMPORT_PATHS }],
      'no-restricted-syntax': syntax(...SRC.filter((k) => k !== 'no-local-validation-pipe')),
    },
  },

  // (d) 配置 / 启动 / 一次性 CLI:env 的唯一合法读取点(实测越界 0 处)
  {
    name: 'srvf/harness:config-bootstrap',
    files: [
      'src/config/**/*.ts',
      'src/bootstrap/**/*.ts',
      'src/modules/storage/storage-settings-bootstrap.ts',
      'src/local-activity-frontend-fixture.cli.ts',
    ],
    rules: {
      // 去掉 no-process-env(本目录就是 env 归属地);
      // bootstrap 是全局 ValidationPipe 的注册处,去掉 no-local-validation-pipe
      'no-restricted-syntax': syntax(...BASE.filter((k) => k !== 'no-local-validation-pipe')),
    },
  },

  // (e) Guard / 装饰器 / 全局注册处:允许出现被禁装饰器的「定义」与注释样例
  {
    name: 'srvf/harness:guard-definitions',
    files: ['src/common/decorators/**/*.ts', 'src/common/guards/**/*.ts', 'src/app.module.ts'],
    rules: {
      'no-restricted-syntax': syntax(
        ...SRC.filter(
          (k) => !['no-use-guards', 'no-roles-decorator', 'no-bare-api-ok-response'].includes(k),
        ),
      ),
    },
  },

  // (f) controller:额外禁 @Param('id')
  {
    name: 'srvf/harness:controller',
    files: ['src/**/*.controller.ts'],
    rules: { 'no-restricted-syntax': syntax(...SRC, 'no-param-id-string') },
  },

  // (g) BASELINE:19 个存量 controller 暂免 no-param-id-string
  {
    name: 'srvf/harness:controller-param-id-baseline',
    files: LEGACY_PARAM_ID_CONTROLLERS,
    rules: { 'no-restricted-syntax': syntax(...SRC) },
  },

  // (h) 判权 / 身份路径:额外禁缓存与定时器
  //     ⚠ 必须放在 (f)/(g) 之后 —— flat config 同 ruleId 后块整体覆盖前块,
  //     若放前面,permissions/*.controller.ts 会丢掉本块的两条选择器。
  {
    name: 'srvf/harness:no-identity-cache',
    files: ['src/modules/permissions/**/*.ts', 'src/modules/auth/strategies/**/*.ts'],
    ignores: ['src/**/*.spec.ts'],
    rules: {
      'no-restricted-syntax': syntax(
        ...SRC,
        'no-param-id-string',
        'no-identity-cache',
        'no-identity-timer',
      ),
    },
  },

  // (i) App DTO 边界:用 @typescript-eslint/no-restricted-imports —— 与核心规则
  //     不同 ruleId,故可与 (b) 的核心 no-restricted-imports 同时生效。
  {
    name: 'srvf/harness:app-dto-boundary',
    files: ['src/**/dto/app/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              // Admin 专属 DTO 目录:整目录禁引(零存量)
              group: ['../admin/*', '**/dto/admin/*'],
              message:
                'App DTO 禁引 Admin DTO。[AGENTS §1 DTO 边界 + §2 D-6] 正确做法:在 dto/app/ 内显式重写字段;只允许从 common/dto(PaginationQueryDto)与 *.constants / *.types 取值。',
            },
            {
              // 模块平铺 *.dto.ts(管理面 DTO 的实际落点):
              // 常量 / 枚举值数组可引,**类不可引**(类复用 = 隐式契约联动)
              group: ['../../*.dto', '../../../*/*.dto'],
              importNamePattern: '^[A-Z].*Dto$',
              message:
                'App DTO 禁复用管理面 DTO 类(类复用 = Admin 加字段自动漏进 App 出参)。[AGENTS §1 DTO 边界 + §2 D-6] 正确做法:在 dto/app/ 内显式重写该结构;常量 / 枚举值数组可以继续从 *.dto / *.constants 引。',
            },
          ],
        },
      ],
    },
  },

  // (j) Presenter / Policy / StateMachine 纯函数化:不碰 DB
  {
    name: 'srvf/harness:service-boundary',
    files: ['src/**/*.policy.ts', 'src/**/*presenter*.ts', 'src/**/*state-machine*.ts'],
    ignores: [
      'src/**/*.spec.ts',
      // BASELINE(唯一存量,待拍板):RoleDelegationPolicy 注入 PrismaService 作
      // TransactionClient 默认值并自行查 roleBinding/user。只冻结不放宽。
      'src/modules/permissions/role-delegation.policy.ts',
    ],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/database/prisma.service', '**/prisma.service'],
              message:
                'Presenter / Policy / StateMachine 不碰 DB,必须是纯函数(入参即全部依赖)。[AGENTS §2 D-7 六类职责边界] 正确做法:由调用方 Service 取数后传入;需要落库的判定放回 Service。',
            },
          ],
        },
      ],
    },
  },
  // (k) 第 18 条:独立 ruleId 的自定义规则(eslint-rules/no-nullable-is-optional.mjs)。
  //     与前面 17 条**不共用** `no-restricted-syntax`,所以:
  //       · 一句 `eslint-disable-next-line no-restricted-syntax` 不再把它连坐关掉;
  //       · 下面的基线块只需写这一条,不必重列全部规则集(前面 (g)/(h) 那种
  //         「漏写一条就静默关掉其余若干条」的排序陷阱在这条上**结构性消失**)。
  //     默认对全仓生效(含 test / prisma —— 两处实测零违规,所以是白拿的)。
  {
    name: 'srvf/harness:nullable-is-optional',
    files: ['src/**/*.ts', 'test/**/*.ts', 'prisma/**/*.ts'],
    plugins: { srvf: srvfEslintPlugin },
    rules: { [NULLABLE_IS_OPTIONAL_RULE]: 'error' },
  },

  // (l) DTO 范围关掉 inline 逃生门(第五轮评审 J2 · L3)。
  //     实测:`/* eslint-disable */`(文件级)与 `// eslint-disable-next-line`(行级)
  //     两种写法此前都能让一个新违规字段通过 lint,RC=0 —— 棘轮的第一道执行位
  //     等于可以被违规者本人一行注释关掉。
  //
  //     ⚠️ 范围**刻意只到 DTO**:src/ 现有 7 处 inline disable 全在 service /
  //     orchestrator(硬删的具名豁免,AGENTS §1 明文允许的正当用法),扩到全仓
  //     会把它们一起打死 —— 「治误伤开出漏放洞」的反面同样成立,一次误伤会让
  //     下一个人来把整条 linterOptions 删掉。实测 DTO 范围内既有 inline config 为 0,
  //     所以这条是零代价的。代价写在明处:**非 .dto.ts 文件里的第 18 条仍可被
  //     inline 关掉**(当前全仓实测 0 处真装饰器落在该范围外)。
  {
    name: 'srvf/harness:dto-no-inline-config',
    files: ['**/*.dto.ts', 'src/**/dto/**/*.ts'],
    linterOptions: { noInlineConfig: true },
  },
];

// (m) BASELINE 块:每个存量文件一块,把**该文件已冻结的那些字段**从第 18 条里挖掉。
//     豁免是规则的 `exempt` 选项,精确到 `类名.字段名` —— 所以往一个已在基线里的
//     文件**新增**一个违规字段依然会红,同名字段挪到另一个类里也会红。
//     这就是「基线只能缩不能涨」在 lint 侧的执行位。
//
//     ⚠️ 必须放在 (k) 之后:flat config 同 ruleId 后块整体覆盖前块。
//     不再需要「重列完整规则集」—— 本块只碰 srvf/no-nullable-is-optional 这一个
//     ruleId,`no-restricted-syntax` 的 17 条完全不受影响(换独立 ruleId 的直接收益)。
const isOptionalNullBaselineBlocks = [...IS_OPTIONAL_NULL_BASELINE.entries()].map(
  ([file, exempt]) => ({
    name: `srvf/harness:is-optional-null-baseline:${file}`,
    files: [file],
    rules: { [NULLABLE_IS_OPTIONAL_RULE]: ['error', { exempt }] },
  }),
);

harnessConfigBlocks.push(...isOptionalNullBaselineBlocks);

export {
  HARNESS_SYNTAX,
  IS_OPTIONAL_NULL_BASELINE,
  NULLABLE_IS_OPTIONAL_MESSAGE,
  NULLABLE_IS_OPTIONAL_RULE,
  harnessConfigBlocks,
  parseIsOptionalNullBaseline,
};
