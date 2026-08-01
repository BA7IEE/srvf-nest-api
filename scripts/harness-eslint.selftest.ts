import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { ESLint } from 'eslint';
// 从**已声明的** typescript-eslint 元包取 parser / plugin。
// 原先直接 import '@typescript-eslint/parser' 与 '@typescript-eslint/eslint-plugin' 是
// 幻影依赖:两者都不在 package.json 里,只是被 pnpm 提升到 .pnpm 后偶然解析得到 ——
// 提升策略一变本自测就整个失效(而失效的自测 = 静默失去阳性对照,最坏的失败模式)。
import { parser as tsParser, plugin as tsPlugin } from 'typescript-eslint';

// Harness 3.0 P2 — eslint 执法块的**阳性对照自测**。
//
// 为什么必须有这个文件:
// 「跑 pnpm lint 全绿」既可能是「代码合规」,也可能是「选择器写错了永远匹配不到」。
// 后者是最坏的失败模式 —— 以为有防线,其实没有,而且完全静默。
// 本自测对每条执法规则喂一段**必定违规**的合成片段,断言它确实被抓到;
// 同时喂对应的**合法**片段,断言不误杀。规则失效即红。
//
// 与 scripts/harness-guards.selftest.ts 的分工:那份守护「派生/配置/流程」不变式,
// 这份守护「eslint 规则本身还有没有约束力」。两份都不依赖 DB,秒级。
//
// 运行:pnpm exec tsx scripts/harness-eslint.selftest.ts(已挂 pnpm agent:check:quick)
//
// ── 第 18 条棘轮:十项变异测试的**索引**(第五轮跨模型评审 J2)────────────────
// 十项分布在两个 selftest 里(`pnpm harness:selftest` 一次跑全),这里是唯一目录:
//
// | # | 变异 | 修复前 | 拦在哪 | 断言在哪 |
// |---|---|---|---|---|
// | M1 | 往已在基线的文件新增违规字段 | 🔴 已拦 | lint 豁免精确到类名.字段名 | 本文件 CASES |
// | M2 | 同名字段挪到另一个类 | 🔴 已拦 | 同上 | 本文件 CASES |
// | M3 | 修好却忘删基线行(陈旧行) | 🔴 已拦 | 本文件对账段 | 本文件 accountRatchet |
// | M4 | 新增违规 **+ 同 PR 加基线** | **🟢 绕过** | base-trusted 裁判单调性 | harness-guards.selftest(F3 单调性) |
// | M5 | 修 A 加 B(**总数不变**) | **🟢 绕过** | 同上 | 同上 |
// | M6 | 文件级 `/* eslint-disable */` | **🟢 绕过** | 独立 ruleId + noInlineConfig | 本文件 CASES + 接线自测 |
// | M7 | 行级 `// eslint-disable-next-line` | **🟢 绕过** | 同上 | 同上 |
// | M8 | 嵌套 null 冒充可空(三种写法) | **🟢 绕过** | 自定义规则判**顶层**类型 | 本文件 CASES |
// | M9 | 同文件重复身份 | **🟢 绕过**(Set 去重后读数相同) | Map<身份,次数> | 本文件 accountRatchet |
// | M10 | 基线格式绕过(E1–E6) | **🟢 绕过**(当时零校验) | 加载即抛 | 本文件 M10 段 |
//
// M4 / M5 为什么只能在 harness-guards.selftest 里验:它们要**两份不同的基线**
// (base 一份、head 一份)同时在场,而 lint 与本文件在 PR 的树上都只看得到 head
// 那一份 —— PR 改的正是判据本身。真实 CI 行为只能在 main 上实跑验证。
//
// ── R2 / R3(2026-08-01 整批评审 ②)——上表的**纵深遗留**,同一张索引续写 ─────
//
// | # | 变异 | 修复前(真实 `pnpm lint` 实测) | 拦在哪 | 断言在哪 |
// |---|---|---|---|---|
// | R2-1 | controller 行级 `// eslint-disable-next-line srvf/no-param-id-string` | **🟢 RC=0 零命中** | 全仓扫描拒 srvf/ 具名 disable | 本文件 R2 段 |
// | R2-2 | controller 文件级 `/* eslint-disable srvf/… */` | **🟢 RC=0** | 同上 | 同上 |
// | R2-3 | 非 .dto.ts 行级关第 18 条 | **🟢 RC=0** | 同上(noInlineConfig 刻意只到 DTO) | 同上 |
// | R2-4 | **不具名** disable(`/* eslint-disable */`)—— 不写名字照样关掉 srvf/ | **🟢 RC=0** | 扫描一并拒 | 同上 |
// | R3-1 | `@(CV['IsOptional']())` 计算属性 | **🟢 零命中** | matchDecorator 按键名判 | 本文件 CASES |
// | R3-2 | `const Opt = CV.IsOptional` namespace→局部 | **🟢 零命中** | resolveImportedName 认 MemberExpression init | 同上 |
// | R3-3 | `export { IsOptional as Opt } from 'class-validator'` 改名 re-export | **🟢 零命中** | srvf/no-decorator-realias 在**源头**拒 | 同上 |
//
// R2 为什么不做成 eslint 规则:一条 eslint 规则自己也能被 `/* eslint-disable */`
// 关掉(那正是 R2-4)。扫描必须跑在 eslint **之外**才站得住。
// R3-3 为什么不做进 decorator-identity:名字是在**另一个模块**换掉的,同文件解析看不见;
// 跨模块解析要么依赖 type checker(自测里拿不到 parserServices,阳性对照做不了),
// 要么自写模块图(第二把尺子)。所以判据换方向:不让改名这件事发生。

type Case = {
  readonly name: string;
  readonly filename: string;
  readonly code: string;
  /** 期望命中的 ruleId;null = 期望零违规(合法样例 / baseline 豁免 / 已知缺口) */
  readonly expect: string | null;
  /** 期望命中次数(默认 ≥1) */
  readonly minCount?: number;
  /**
   * **已知缺口**:这条对抗样例当前**能绕过**规则,断言的是「现状如此」而不是「这样对」。
   * 存在的意义是把缺口钉成可见事实 —— 哪天补上自定义规则,这里会红,提醒来更新。
   * 输出里单独成段计数,不混进「通过」的叙事(见 AGENTS §1「字面语法拦截」)。
   */
  readonly knownGap?: true;
};

const SYNTAX = 'no-restricted-syntax';
const TS_IMPORTS = '@typescript-eslint/no-restricted-imports';
const CORE_IMPORTS = 'no-restricted-imports';
/** 第 18 条:独立 ruleId 的自定义规则(eslint-rules/no-nullable-is-optional.mjs)。 */
const CUSTOM = 'srvf/no-nullable-is-optional';
/** `:id` 走 IdParamDto:M4 升格出来的第二条自定义规则(eslint-rules/no-param-id-string.mjs)。 */
const PARAM_ID = 'srvf/no-param-id-string';
/** 禁改名导出受守护装饰器:R3 新增的第三条自定义规则(eslint-rules/no-decorator-realias.mjs)。 */
const REALIAS = 'srvf/no-decorator-realias';

const CASES: readonly Case[] = [
  // ---- 鉴权 / 判权单轨 ----
  {
    name: '@UseGuards 被禁(Guard 全局注册)',
    filename: 'src/modules/x/x.controller.ts',
    code: '@UseGuards(JwtAuthGuard) export class C {}',
    expect: SYNTAX,
  },
  {
    name: '@Roles 被禁(判权单轨:全仓活跃 @Roles = 0)',
    filename: 'src/modules/x/x.controller.ts',
    code: 'export class C { @Roles(Role.ADMIN) m() {} }',
    expect: SYNTAX,
  },
  {
    name: 'guards/ 定义处放行 @Roles(不误杀装饰器本体)',
    filename: 'src/common/guards/roles.guard.ts',
    code: 'export class C { @Roles(Role.ADMIN) m() {} }',
    expect: null,
  },
  {
    name: "AuthGuard('local') 被禁(不引入 LocalStrategy)",
    filename: 'src/modules/x/x.controller.ts',
    code: "const g = AuthGuard('local');",
    expect: SYNTAX,
  },

  // ---- 响应 / Swagger ----
  {
    name: '裸 @ApiOkResponse 被禁',
    filename: 'src/modules/x/x.controller.ts',
    code: 'export class C { @ApiOkResponse({ type: D }) m() {} }',
    expect: SYNTAX,
  },
  {
    name: '手工包 {code,message} 被禁(全局拦截器已包)',
    filename: 'src/modules/x/x.controller.ts',
    code: "export class C { m() { return { code: 0, message: 'ok', data: 1 }; } }",
    expect: SYNTAX,
  },

  // ---- 校验 ----
  {
    name: '局部 new ValidationPipe 被禁',
    filename: 'src/modules/x/x.service.ts',
    code: 'const p = new ValidationPipe({});',
    expect: SYNTAX,
  },
  {
    name: 'bootstrap 放行 new ValidationPipe(全局注册处)',
    filename: 'src/bootstrap/apply-global-setup.ts',
    code: 'const p = new ValidationPipe({});',
    expect: null,
  },
  // 📌 `@Param('id')` 的用例已随规则升格挪到下方 PARAM_ID 段(M4)——
  //    它不再是 no-restricted-syntax 的一条选择器。

  // ---- Prisma / 软删 ----
  {
    name: 'prisma.$use 被禁(全局软删中间件)',
    filename: 'src/modules/x/x.service.ts',
    code: 'prisma.$use(async (p: any, n: any) => n(p));',
    expect: SYNTAX,
  },
  {
    name: 'prisma.$extends 被禁(client extension)',
    filename: 'src/modules/x/x.service.ts',
    code: 'const c = prisma.$extends({});',
    expect: SYNTAX,
  },
  {
    name: 'tx.<model>.delete 被禁(硬删)',
    filename: 'src/modules/x/x.service.ts',
    code: 'async function f(tx: any, id: string) { await tx.user.delete({ where: { id } }); }',
    expect: SYNTAX,
  },
  {
    name: 'this.prisma.<model>.deleteMany 被禁(硬删)',
    filename: 'src/modules/x/x.service.ts',
    code: 'export class S { prisma: any; async f() { await this.prisma.user.deleteMany({ where: {} }); } }',
    expect: SYNTAX,
  },
  {
    name: 'test 侧放行硬删(造数/清场合法)',
    filename: 'test/e2e/x.e2e-spec.ts',
    code: 'declare const prisma: any; async function f() { await prisma.user.deleteMany({}); }',
    expect: null,
  },

  // ---- 命名 / 配置 ----
  {
    name: '重定义 Prisma enum 被禁',
    filename: 'src/modules/x/x.types.ts',
    code: "export enum Role { A = 'A' }",
    expect: SYNTAX,
  },
  {
    name: '本地非 Prisma enum 放行',
    filename: 'src/modules/x/x.types.ts',
    code: "export enum SmsCredentialStatus { A = 'A' }",
    expect: null,
  },
  {
    name: '散落 process.env 被禁',
    filename: 'src/modules/x/x.service.ts',
    code: 'const a = process.env.FOO;',
    expect: SYNTAX,
  },
  {
    name: 'src/config 放行 process.env(env 归属地)',
    filename: 'src/config/x.config.ts',
    code: 'const a = process.env.FOO;',
    expect: null,
  },

  // ---- 分页 ----
  {
    name: '分页别名 limit 被禁',
    filename: 'src/modules/x/x.dto.ts',
    code: 'export class ListXQueryDto { limit?: number; }',
    expect: SYNTAX,
  },
  {
    name: 'OptionsQueryDto 结尾放行 limit(不分页候选)',
    filename: 'src/modules/x/x.dto.ts',
    code: 'export class XOptionsQueryDto { limit?: number; }',
    expect: null,
  },

  // ---- DTO 边界 ----
  {
    name: 'Mapped Types 派生 DTO 被禁',
    filename: 'src/modules/x/dto/app/app-x.dto.ts',
    code: 'export class A extends PickType(AdminXDto, [] as const) {}',
    expect: SYNTAX,
  },
  {
    name: 'App DTO 引 Admin DTO 目录被禁',
    filename: 'src/modules/x/dto/app/app-x.dto.ts',
    code: "import { AdminXDto } from '../admin/admin-x.dto';\nexport const a = AdminXDto;",
    expect: TS_IMPORTS,
  },

  // ---- 身份 / 权限不缓存 ----
  {
    name: '判权路径禁 Map 缓存',
    filename: 'src/modules/permissions/rbac.service.ts',
    code: 'export class S { private cache = new Map<string, string>(); }',
    expect: SYNTAX,
  },
  {
    name: '判权路径禁定时器',
    filename: 'src/modules/permissions/rbac.service.ts',
    code: 'setInterval(() => {}, 1000);',
    expect: SYNTAX,
  },
  {
    name: '普通业务路径放行 Map(非判权/身份)',
    filename: 'src/modules/x/x.service.ts',
    code: 'export class S { private cache = new Map<string, string>(); }',
    expect: null,
  },

  // ---- 基础设施冻结 ----
  {
    name: 'import ioredis 被禁(Redis 不引入)',
    filename: 'src/modules/x/x.service.ts',
    code: "import Redis from 'ioredis';\nexport const a = Redis;",
    expect: CORE_IMPORTS,
  },
  {
    name: 'import bullmq 被禁(queue 不引入)',
    filename: 'src/modules/x/x.service.ts',
    code: "import { Queue } from 'bullmq';\nexport const a = Queue;",
    expect: CORE_IMPORTS,
  },

  // ---- 模块结构 / 职责边界 ----
  {
    name: '跨模块深引 controllers/ 私有子目录被禁',
    filename: 'src/modules/y/y.service.ts',
    code: "import { Foo } from '../x/controllers/x.controller';\nexport const a = Foo;",
    expect: CORE_IMPORTS,
  },
  {
    name: 'Presenter 引 PrismaService 被禁(须纯函数)',
    filename: 'src/modules/x/x-presenter.ts',
    code: "import { PrismaService } from '../../database/prisma.service';\nexport const a = PrismaService;",
    expect: TS_IMPORTS,
  },

  // ---- null 契约(第 18 条 · 自定义规则)----
  {
    name: '@IsOptional() 但类型不含 | null 被禁(null 会穿过契约层)',
    filename: 'src/modules/x/x.dto.ts',
    code: 'export class D { @IsOptional() foo?: string; }',
    expect: CUSTOM,
  },
  {
    name: '真可空字段放行(@IsOptional() + `string | null`)',
    filename: 'src/modules/x/x.dto.ts',
    code: 'export class D { @IsOptional() foo?: string | null; }',
    expect: null,
  },
  {
    name: '顶层可空放行(`Array<string> | null` —— 容器可空是真可空)',
    filename: 'src/modules/x/x.dto.ts',
    code: 'export class D { @IsOptional() foo?: Array<string> | null; }',
    expect: null,
  },
  {
    name: '仅可省略字段放行(@OmittableOnly())',
    filename: 'src/modules/x/x.dto.ts',
    code: 'export class D { @OmittableOnly() foo?: string; }',
    expect: null,
  },
  {
    name: 'baseline 内已冻结的字段暂免第 18 条(PaginationQueryDto.page)',
    filename: 'src/common/dto/pagination.dto.ts',
    code: 'export class PaginationQueryDto { @IsOptional() page?: number; }',
    expect: null,
  },
  {
    name: '基线豁免绑「类名.字段名」:同名字段挪到另一个类照样红(M2)',
    filename: 'src/common/dto/pagination.dto.ts',
    code: 'export class NotFrozenDto { @IsOptional() page?: number; }',
    expect: CUSTOM,
  },
  {
    name: '基线文件内**新增**一个未冻结字段照样红(M1:基线只能缩不能涨)',
    filename: 'src/common/dto/pagination.dto.ts',
    code: 'export class PaginationQueryDto { @IsOptional() brandNewField?: string; }',
    expect: CUSTOM,
  },

  // 基线块曾经的最大陷阱:它当年要**重列该文件的完整规则集**(用 filter 减掉第 18 条
  // 再把带豁免的版本加回去),漏写一条就把其余 17 条对这 56 个文件静默关掉,
  // 而 lint 依旧全绿。换成独立 ruleId 后基线块只碰自己那一条,这个陷阱结构性消失 ——
  // 下面两条把「结构性消失」钉成可验证的事实,而不是一句注释。
  {
    name: '基线文件不因被豁免而丢掉别的规则(permissions DTO 的判权路径缓存照样红)',
    filename: 'src/modules/permissions/permissions.dto.ts',
    code: 'export class S { private cache = new Map<string, string>(); }',
    expect: SYNTAX,
  },
  {
    name: '基线文件不因被豁免而丢掉别的规则(裸 @ApiOkResponse 照样红)',
    filename: 'src/modules/activities/activities.dto.ts',
    code: 'export class C { @ApiOkResponse({ type: D }) m() {} }',
    expect: SYNTAX,
  },

  // ---- M8:嵌套 null 冒充可空(第五轮评审 FAIL —— 旧 selector 三种写法全放行)----
  // 旧判据 `:not(:has(TSNullKeyword))` 问的是「整棵子树里出现过 null 这个词吗」,
  // 于是把 null **藏进泛型参数 / 对象成员 / Promise** 就能冒充「已经可空」,
  // 而属性顶层依然不含 null —— 显式 null 照样穿过契约层。新规则只看顶层。
  {
    name: 'M8 嵌套 null:`Array<string | null>` 不算可空',
    filename: 'src/modules/x/x.dto.ts',
    code: 'export class D { @IsOptional() foo?: Array<string | null>; }',
    expect: CUSTOM,
  },
  {
    name: 'M8 嵌套 null:`{ v: string | null }` 不算可空',
    filename: 'src/modules/x/x.dto.ts',
    code: 'export class D { @IsOptional() foo?: { v: string | null }; }',
    expect: CUSTOM,
  },
  {
    name: 'M8 嵌套 null:`Promise<string | null>` 不算可空',
    filename: 'src/modules/x/x.dto.ts',
    code: 'export class D { @IsOptional() foo?: Promise<string | null>; }',
    expect: CUSTOM,
  },

  // ---- M6 / M7:inline 逃生门(第五轮评审 FAIL —— 两种写法此前都 RC=0)----
  // 修好的原因有两层,缺一不可:
  //   ① 独立 ruleId —— 关掉 `no-restricted-syntax` 不再连坐关掉第 18 条;
  //   ② DTO 范围 `linterOptions.noInlineConfig: true` —— 连**具名**关它也不行。
  // 本文件的两个 ESLint 实例一律 allowInlineConfig: false,与②同源。
  {
    name: 'M6 inline 逃生门:文件级 `/* eslint-disable no-restricted-syntax */` 关不掉第 18 条',
    filename: 'src/modules/x/x.dto.ts',
    code: '/* eslint-disable no-restricted-syntax */\nexport class D { @IsOptional() foo?: string; }',
    expect: CUSTOM,
  },
  {
    name: 'M7 inline 逃生门:行级 `// eslint-disable-next-line no-restricted-syntax` 关不掉第 18 条',
    filename: 'src/modules/x/x.dto.ts',
    code: 'export class D {\n  // eslint-disable-next-line no-restricted-syntax\n  @IsOptional() foo?: string;\n}',
    expect: CUSTOM,
  },
  {
    name: 'M6/M7 加强:连**具名**关它也不行(noInlineConfig)',
    filename: 'src/modules/x/x.dto.ts',
    code: '/* eslint-disable srvf/no-nullable-is-optional */\nexport class D { @IsOptional() foo?: string; }',
    expect: CUSTOM,
  },

  // ---- 顺手关掉的缺口:import 别名(自定义规则拿得到 scope,选择器拿不到)----
  {
    name: 'import 别名 `IsOptional as Opt` 被识破(第 18 条的别名缺口已关闭)',
    filename: 'src/modules/x/x.dto.ts',
    code: "import { IsOptional as Opt } from 'class-validator';\nexport class D { @Opt() foo?: string; }",
    expect: CUSTOM,
  },
  {
    name: '别名指向别的导入不误报(`IsString as IsOptional` 按导入原名判)',
    filename: 'src/modules/x/x.dto.ts',
    code: "import { IsString as IsOptional } from 'class-validator';\nexport class D { @IsOptional() foo?: string; }",
    expect: null,
  },

  // ---- M4 三组别名对抗样例(2026-08-01 复审点名;此前三种写法**全部**能绕过)----
  // 别名解析上一版只认「Identifier + 具名 import + 来源模块 === class-validator」,
  // 于是:namespace 中转不是 Identifier(直接 return false)、局部变量中转不是
  // ImportBinding(退回字面名 `Opt` 判不中)、re-export 的来源模块对不上(显式 return false)。
  // 三条都是**静默放行**,而自测输出与「防线完整」一模一样。
  {
    name: 'M4 别名 ①:namespace `@CV.IsOptional()` 被识破',
    filename: 'src/modules/x/x.dto.ts',
    code: "import * as CV from 'class-validator';\nexport class D { @CV.IsOptional() foo?: string; }",
    expect: CUSTOM,
  },
  {
    name: 'M4 别名 ②:局部变量中转 `const Opt = IsOptional` 被识破',
    filename: 'src/modules/x/x.dto.ts',
    code: "import { IsOptional } from 'class-validator';\nconst Opt = IsOptional;\nexport class D { @Opt() foo?: string; }",
    expect: CUSTOM,
  },
  {
    name: 'M4 别名 ③:re-export 转一手(来源模块不是 class-validator)被识破',
    filename: 'src/modules/x/x.dto.ts',
    code: "import { IsOptional } from './somewhere-reexporting';\nexport class D { @IsOptional() foo?: string; }",
    expect: CUSTOM,
  },
  {
    name: 'M4 别名反向:namespace 上取别的成员不误报(`@CV.IsString()`)',
    filename: 'src/modules/x/x.dto.ts',
    code: "import * as CV from 'class-validator';\nexport class D { @CV.IsString() foo?: string; }",
    expect: null,
  },

  // ══════════════════════════════════════════════════════════════════════════
  // R3 三组身份解析缺口 —— 两条规则**各**一组阳性对照(2026-08-01 整批评审 ②)
  //
  // 修复前实测(真实 `pnpm lint` 入口,8 个探针文件 RC=0、零命中):
  //   ⑤ 计算属性        `@(CV['IsOptional']())`      —— matchDecorator 见 computed 直接 return false
  //   ⑥ namespace→局部  `const Opt = CV.IsOptional;` —— init 不是 Identifier ⇒ 返回 null ⇒ 退回字面名 `Opt`
  //   ⑧ 改名 re-export  `export { IsOptional as Opt } from 'class-validator'` —— 名字在**另一个模块**被换掉
  //
  // ⚠️ 裸 `@CV['IsOptional']()` 是 **TS 语法错误**(装饰器语法不接受下标访问),
  //    真正能写出来的逃生门是加括号的 `@(CV['IsOptional']())` —— 探针必须用后者,
  //    否则测的是「TS 不让你这么写」,不是「规则拦不拦得住」。
  // ══════════════════════════════════════════════════════════════════════════
  {
    name: "R3 ⑤ 计算属性:`@(CV['IsOptional']())` 被识破",
    filename: 'src/modules/x/x.dto.ts',
    code: "import * as CV from 'class-validator';\nexport class D { @(CV['IsOptional']()) foo?: string; }",
    expect: CUSTOM,
  },
  {
    name: "R3 ⑤ 计算属性:`@(NC['Param']('id'))` 被识破",
    filename: 'src/modules/x/x.controller.ts',
    code: "import * as NC from '@nestjs/common';\nexport class C { m(@(NC['Param']('id')) id: string) {} }",
    expect: PARAM_ID,
  },
  {
    name: 'R3 ⑥ namespace→局部:`const Opt = CV.IsOptional` 被识破',
    filename: 'src/modules/x/x.dto.ts',
    code: "import * as CV from 'class-validator';\nconst Opt = CV.IsOptional;\nexport class D { @Opt() foo?: string; }",
    expect: CUSTOM,
  },
  {
    name: 'R3 ⑥ namespace→局部:`const P = NC.Param` 被识破',
    filename: 'src/modules/x/x.controller.ts',
    code: "import * as NC from '@nestjs/common';\nconst P = NC.Param;\nexport class C { m(@P('id') id: string) {} }",
    expect: PARAM_ID,
  },
  {
    name: 'R3 ⑧ 改名 re-export:`export { IsOptional as Opt }` 在源头即错',
    filename: 'src/modules/x/x-reexport.ts',
    code: "export { IsOptional as Opt } from 'class-validator';",
    expect: REALIAS,
  },
  {
    name: 'R3 ⑧ 改名 re-export:`export { Param as P }` 在源头即错',
    filename: 'src/modules/x/x-reexport.ts',
    code: "export { Param as P } from '@nestjs/common';",
    expect: REALIAS,
  },
  // 顺带关掉的同类写法(与 ⑥ 同一条解析路径 / 与 ⑧ 同一条导出路径)
  {
    name: 'R3 ⑦ 解构中转:`const { IsOptional: Opt } = CV` 被识破',
    filename: 'src/modules/x/x.dto.ts',
    code: "import * as CV from 'class-validator';\nconst { IsOptional: Opt } = CV;\nexport class D { @Opt() foo?: string; }",
    expect: CUSTOM,
  },
  {
    name: 'R3 ⑧b 变量改名导出:`export const Opt = IsOptional` 在源头即错',
    filename: 'src/modules/x/x-reexport.ts',
    code: "import { IsOptional } from 'class-validator';\nexport const Opt = IsOptional;",
    expect: REALIAS,
  },
  {
    name: 'R3 ⑧c 默认导出:`export default Param` 在源头即错(下游可任意命名)',
    filename: 'src/modules/x/x-reexport.ts',
    code: "import { Param } from '@nestjs/common';\nexport default Param;",
    expect: REALIAS,
  },
  {
    name: 'R3 ⑤b 动态键:`const k = "IsOptional"; @(CV[k]())` 判成命中(宁可多判不可漏判)',
    filename: 'src/modules/x/x.dto.ts',
    code: "import * as CV from 'class-validator';\nconst k = 'IsOptional';\nexport class D { @(CV[k]()) foo?: string; }",
    expect: CUSTOM,
  },
  // ---- R3 反向对照:三种「长得像但不是」的写法一律不许误杀 ----
  {
    name: "R3 反向:`@(CV['IsString']())` 不误报(计算属性按键名判,不是见 computed 就报)",
    filename: 'src/modules/x/x.dto.ts',
    code: "import * as CV from 'class-validator';\nexport class D { @(CV['IsString']()) foo?: string; }",
    expect: null,
  },
  {
    name: 'R3 反向:`const S = CV.IsString` 不误报',
    filename: 'src/modules/x/x.dto.ts',
    code: "import * as CV from 'class-validator';\nconst S = CV.IsString;\nexport class D { @S() foo?: string; }",
    expect: null,
  },
  {
    name: 'R3 反向:**同名**转发放行(`export { IsOptional } from ...` 不制造新名字)',
    filename: 'src/modules/x/x-reexport.ts',
    code: "export { IsOptional } from 'class-validator';\nexport * from '@nestjs/common';",
    expect: null,
  },
  {
    name: 'R3 反向:改名转发**别的**导出不误报(`export { IsString as S }`)',
    filename: 'src/modules/x/x-reexport.ts',
    code: "export { IsString as S } from 'class-validator';",
    expect: null,
  },
  {
    name: 'R3 反向:真可空字段仍放行(计算属性写法不改变「顶层含 null 即合法」)',
    filename: 'src/modules/x/x.dto.ts',
    code: "import * as CV from 'class-validator';\nexport class D { @(CV['IsOptional']()) foo?: string | null; }",
    expect: null,
  },

  // ---- `:id` 走 IdParamDto(M4:第 17 条升格为独立 ruleId 的自定义规则)----
  {
    name: "裸 @Param('id') 被禁(须走 IdParamDto)",
    filename: 'src/modules/x/x.controller.ts',
    code: "export class C { m(@Param('id') id: string) {} }",
    expect: PARAM_ID,
  },
  {
    name: '@Param() 整对象走 DTO 放行(本条只拦裸 `id` 键)',
    filename: 'src/modules/x/x.controller.ts',
    code: 'export class C { m(@Param() params: IdParamDto) {} }',
    expect: null,
  },
  {
    name: "@Param('memberId') 放行(本条只管 `:id`)",
    filename: 'src/modules/x/x.controller.ts',
    code: "export class C { m(@Param('memberId') memberId: string) {} }",
    expect: null,
  },
  {
    name: "非 controller 文件不判 @Param('id')(实际不可能出现,范围写死在 (l) 块)",
    filename: 'src/modules/x/x.service.ts',
    code: "export class C { m(@Param('id') id: string) {} }",
    expect: null,
  },
  {
    name: "M4 别名:`import { Param as P }` + @P('id') 被识破",
    filename: 'src/modules/x/x.controller.ts',
    code: "import { Param as P } from '@nestjs/common';\nexport class C { m(@P('id') id: string) {} }",
    expect: PARAM_ID,
  },
  {
    name: '清单内的存量身份暂免(TeamJoinCyclesController.detail.id)',
    filename: 'src/modules/team-join/team-join-cycles.controller.ts',
    code: "export class TeamJoinCyclesController { detail(@Param('id') id: string) {} }",
    expect: null,
  },
  // 这两条是「整文件豁免 → 具名豁免」升格的**全部价值**:上一版两条都是绿的。
  {
    name: '清单内文件**新增**一个裸 `:id` 照样红(清单只能缩不能涨)',
    filename: 'src/modules/team-join/team-join-cycles.controller.ts',
    code: "export class TeamJoinCyclesController { brandNewMethod(@Param('id') id: string) {} }",
    expect: PARAM_ID,
  },
  {
    name: '同名方法挪到另一个类照样红(身份绑「类名.方法名.参数名」)',
    filename: 'src/modules/team-join/team-join-cycles.controller.ts',
    code: "export class NotFrozenController { detail(@Param('id') id: string) {} }",
    expect: PARAM_ID,
  },
  {
    name: '清单内文件不因被豁免而丢掉别的规则(裸 @ApiOkResponse 照样红)',
    filename: 'src/modules/team-join/team-join-cycles.controller.ts',
    code: 'export class C { @ApiOkResponse({ type: D }) m() {} }',
    expect: SYNTAX,
  },

  // ══════════════════════════════════════════════════════════════════════════
  // 已知缺口:对抗样例(2026-07-29 跨模型评审 finding 6,实测 5/5 全部绕过)
  //
  // `no-restricted-syntax` 匹配的是**语法树的字面形状**,不做 import binding
  // 解析,也不做变量指向分析。所以下面每一条都能原样通过 lint —— 原写法拦得住,
  // 换个名字就拦不住。
  //
  // 这些用例断言的是**现状**(当前放行),不是「这样是对的」。把缺口钉成
  // 可见事实的价值有二:
  //   ① 谁都能在自测输出里看到防线的边界在哪,不会误以为它是语义级的
  //   ② 将来落地自定义规则(import binding resolution)时,这里会变红,
  //      提醒来把 knownGap 摘掉 —— 缺口关闭这件事因此不会被忘记
  // 对应 AGENTS §1 的表述:**字面语法拦截**,不是语义分析。
  //
  // ⚠️ 2026-07-31 更新(第五轮评审 J2 · L3):自定义规则已落地,但**只落在第 18 条**
  //    (srvf/no-nullable-is-optional 顺着 scope 解析 import binding,`IsOptional as Opt`
  //    已被识破,见上方正向用例)。下面 5 条仍属 `no-restricted-syntax` 的选择器,
  //    **缺口原样存在**,不因为「自定义规则这件事发生过了」就算解决 ——
  //    把 5 条一并改写成自定义规则不在本 goal 范围内,继续登记。
  // ══════════════════════════════════════════════════════════════════════════
  {
    name: '缺口:import 别名 `UseGuards as UG` 绕过',
    filename: 'src/modules/x/x.controller.ts',
    code: "import { UseGuards as UG } from '@nestjs/common';\n@UG(JwtAuthGuard) export class C {}",
    expect: null,
    knownGap: true,
  },
  {
    name: '缺口:变量中转 `const db = this.prisma; db.user.delete()` 绕过硬删',
    filename: 'src/modules/x/x.service.ts',
    code: 'export class S { prisma: any; async f(id: string) { const db = this.prisma; await db.user.delete({ where: { id } }); } }',
    expect: null,
    knownGap: true,
  },
  {
    name: '缺口:变量中转 `const p = process; p.env.X` 绕过散落 process.env',
    filename: 'src/modules/x/x.service.ts',
    code: 'const p = process;\nexport const a = p.env.SOME_KEY;',
    expect: null,
    knownGap: true,
  },
  {
    name: '缺口:间接构造 `const C = Map; new C()` 绕过判权路径缓存',
    filename: 'src/modules/authz/authz.service.ts',
    code: 'const C = Map;\nexport class S { cache = new C(); }',
    expect: null,
    knownGap: true,
  },
  {
    name: '缺口:import 别名 `PickType as PT` 绕过 Mapped Types 派生 DTO',
    filename: 'src/modules/x/dto/x.dto.ts',
    code: "import { PickType as PT } from '@nestjs/swagger';\nexport class D extends PT(Base, ['a']) {}",
    expect: null,
    knownGap: true,
  },
];

/**
 * 棘轮对账(纯函数,便于喂合成数据做阳性对照)。
 *
 * 判据是**身份唯一性**,不是集合相等:每条基线身份必须**恰好**命中 1 个 AST 节点。
 *   · 0 个  = 陈旧基线(已修好却没删行)—— 基线在说谎,拒;
 *   · ≥2 个 = 身份不唯一 —— **一行基线会同时豁免多个真实字段**,拒。
 *
 * 第二条是第五轮评审新抓到的(J2 · L4):旧实现把命中集塞进 `new Set(...)`,
 * 同一个 `类名.字段名` 命中 2 次与命中 1 次读数完全相同,于是「多豁免了一个字段」
 * 这件事在对账层面**完全不可见**。集合语义换成计数语义才看得见。
 *
 * @param live     现实命中(**不去重**:重复本身就是要抓的东西)
 * @param baseline 冻结清单
 */
export function accountRatchet(
  live: ReadonlyMap<string, readonly string[]>,
  baseline: ReadonlyMap<string, readonly string[]>,
): string[] {
  const problems: string[] = [];

  // ① 身份唯一性
  for (const [file, ids] of live) {
    const counts = new Map<string, number>();
    for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
    const dup = [...counts].filter(([, n]) => n > 1);
    if (dup.length > 0) {
      problems.push(
        `  ${file} —— 身份不唯一(一行基线会同时豁免多个字段):${dup
          .map(([id, n]) => `${id}×${n}`)
          .join(', ')}`,
      );
    }
    // 匿名类 / computed key:身份不可寻址 ⇒ 永远进不了基线,只能真修。
    // 规则侧已保证它们不被豁免,这里把它报出来,免得有人以为「加进基线就完事」。
    const unnamed = [...counts.keys()].filter(
      (id) => id.includes('(anonymous)') || id.includes('(computed)'),
    );
    if (unnamed.length > 0) {
      problems.push(
        `  ${file} —— 身份不可具名(匿名类 / computed key,无法进基线,只能真修):${unnamed.join(', ')}`,
      );
    }
  }

  // ② 基线里有、现实中没有 → 陈旧行(必须删,否则基线永远缩不下去)
  for (const [file, frozen] of baseline) {
    const actual = new Set(live.get(file) ?? []);
    const stale = frozen.filter((f) => !actual.has(f));
    if (stale.length > 0) {
      problems.push(`  ${file} —— 已修好但基线行还在(删掉这几行):${stale.join(', ')}`);
    }
  }

  // ③ 现实中有、基线里没有 → 新增违规未登记。
  //    正常情况下 lint 已经先红了;这里兜住「有人往基线块里加了整文件通配」那类绕过。
  for (const [file, ids] of live) {
    const frozen = new Set(baseline.get(file) ?? []);
    const added = [...new Set(ids)].filter((f) => !frozen.has(f));
    if (added.length > 0) {
      problems.push(`  ${file} —— 新增违规未登记(基线只能缩不能涨):${added.join(', ')}`);
    }
  }

  return problems;
}

// ══════════════════════════════════════════════════════════════════════════════
// R2 · inline 逃生门:机器**拒绝**任何指向 srvf/ 规则的 disable 指令
//
// 修复前实测(2026-08-01,真实 `pnpm lint` 入口,RC=0、零警告):
//   · controller 里 `// eslint-disable-next-line srvf/no-param-id-string` —— **有效**
//   · controller 里 `/* eslint-disable srvf/no-param-id-string */`(文件级)—— **有效**
//   · 非 .dto.ts 里 `// eslint-disable-next-line srvf/no-nullable-is-optional` —— **有效**
//   只有 `*.dto.ts` 被 `linterOptions.noInlineConfig` 盖住 —— 那条刻意只配到 DTO。
//
// 为什么不是「把 noInlineConfig 扩到 controller」:
//   ① 那只是把范围从「第一类文件」扩到「第二类文件」,第三类文件落地时又是一个洞 ——
//      而洞是静默的(lint 依旧 RC=0)。判据必须绑在**规则身份**上,不是文件名形状上。
//   ② `noInlineConfig` 是**整块**语义:一旦某个范围打开它,该范围内所有正当的具名
//      豁免(src/ 现有 7 处硬删豁免,AGENTS §1 明文允许)会一起被打死。
//      「治误伤开出漏放洞」的反面同样成立:一次误伤会让下一个人来把整条 linterOptions 删掉。
//
// 所以判据换成一次**源码扫描**,拒两类写法:
//   A. 任何 disable 指令里出现 `srvf/` 开头的规则名 —— 想具名关掉执法规则,不许;
//   B. 任何**不具名**的 disable 指令(`/* eslint-disable */`、光秃秃的
//      `// eslint-disable-next-line`)—— 它把 srvf/ 规则一并关掉,只是没写出名字。
//      漏掉 B 等于只关了正门:A 的绕过写法就是「别写规则名」。
//   全仓实测 A=0 / B=0,既有 7 处具名非 srvf 豁免全部放行 —— 这条是零代价的。
//
// ⚠️ 为什么扫描而不是再写一条 eslint 规则:一条 eslint 规则**自己也能被 disable**
//    (`/* eslint-disable */` 会把它连同别的一起关掉,而那正是 B 类)。
//    扫描跑在 eslint 之外,不受 inline config 语义支配 —— 这是它唯一能站住的位置。
//
// ⚠️ 判据落在**注释节点**上,不是 raw 文本 grep:本文件自己的 CASES 里就带着
//    `'/* eslint-disable srvf/... */'` 这样的字符串字面量(合成片段),
//    raw grep 会把自测本身报成违规,然后必然催生一条 allowlist —— 而 allowlist
//    就是下一个逃生门。走注释节点则天然区分「注释」与「字符串里的字」,不需要豁免名单。
// ══════════════════════════════════════════════════════════════════════════════

/** 一条被拒的 inline 指令。 */
export interface DisableEscape {
  readonly file: string;
  readonly line: number;
  /** 'named-srvf' = 具名关掉 srvf/ 规则;'unscoped' = 不具名(把 srvf/ 一并关掉) */
  readonly kind: 'named-srvf' | 'unscoped';
  readonly text: string;
}

/**
 * eslint 的 disable 指令必须**出现在注释开头**(`/* prettier-ignore eslint-disable *\/`
 * 不是指令)。锚在行首正是照抄 eslint 自己的判据 —— 松一点会误报,紧一点会漏报。
 */
const DISABLE_DIRECTIVE_RE = /^\s*(eslint-disable(?:-next-line|-line)?)(?![\w-])([\s\S]*)$/;

/**
 * 判一条注释文本:是不是被拒的 disable 指令。纯函数,自测直接喂合成注释。
 *
 * @param commentValue 注释体(不含 `//` 与 `/* *\/` 定界符)
 */
export function classifyDisableComment(commentValue: string): DisableEscape['kind'] | null {
  const m = DISABLE_DIRECTIVE_RE.exec(commentValue);
  if (!m) return null;
  // eslint 的「描述分隔符」是前后带空白的 `--`,其后是给人看的理由,不是规则名。
  const ruleList = m[2].split(/\s-{2,}\s/)[0] ?? '';
  const rules = ruleList
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  if (rules.length === 0) return 'unscoped';
  return rules.some((r) => r.startsWith('srvf/')) ? 'named-srvf' : null;
}

/**
 * 扫一个文件的**全部注释**。解析用的是与 `pnpm lint` 同一个 parser(typescript-eslint),
 * 不是手写的注释切分器 —— 手写切分器迟早在模板串 / 正则字面量 / JSX 上与真实解析漂移,
 * 而漂移的方向恰好是漏报。
 */
export function scanFileForDisableEscapes(file: string, text: string): DisableEscape[] {
  // 便宜的预筛:没有这个词就一定没有指令,省掉整棵 AST。不会漏报。
  if (!text.includes('eslint-disable')) return [];
  let comments: Array<{ value: string; loc?: { start: { line: number } } }>;
  try {
    // typescript-eslint 元包只暴露 `parseForESLint`(没有裸 `parse`)——
    // 用它正是为了和 `pnpm lint` 共用**同一个** parser 版本,不引第二个解析器。
    //
    // ⚠️ 元包把它的类型窄化成了「只收 code 一个参数」,而运行时**是**收第二个
    // options 的(@typescript-eslint/parser 的真实签名)。这里显式把函数 cast 成
    // 真实签名,而不是把整个调用 `as unknown as` 掉 —— 后者会连返回值一起变成
    // 「我说它是什么就是什么」,options 写错了也没人吭声。
    const parseForESLint = tsParser.parseForESLint as unknown as (
      code: string,
      options: Record<string, unknown>,
    ) => { ast: { comments?: Array<{ value: string; loc?: { start: { line: number } } }> } };
    const { ast } = parseForESLint(text, {
      comment: true,
      loc: true,
      range: true,
      // 合成片段与 .mjs 都要能解析;不做类型感知(本扫描是纯语法级的)。
      ecmaFeatures: { jsx: true },
    });
    comments = ast.comments ?? [];
  } catch (err) {
    // 解析不了就**响亮地坏**:静默跳过等于给「写一个 parser 噎得住的文件」开后门。
    throw new Error(`扫描 inline 逃生门时解析失败:${file}\n  ${String(err)}`);
  }
  const found: DisableEscape[] = [];
  for (const c of comments) {
    const kind = classifyDisableComment(c.value);
    if (kind === null) continue;
    found.push({
      file,
      line: c.loc?.start.line ?? 0,
      kind,
      text: c.value.trim().slice(0, 120),
    });
  }
  return found;
}

/**
 * 扫描范围 = 一切**可能被 eslint 解释**的源文件类型。
 *
 * 刻意按扩展名而不是按 `pnpm lint` 当前的三条 glob:那三条 glob 是 PR 可以改的,
 * 而「把文件挪出 lint 范围」本身就是一种绕过。按扩展名扫是它的超集,
 * 新增第四类目录时不需要记得回来改这里(「未来第三类文件」正是本条要防的形状)。
 */
const SCANNED_SOURCE_EXT = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs']);

/** 全仓扫描(git 跟踪的文件,天然排除 node_modules / dist)。 */
export function scanRepoForDisableEscapes(repoRoot: string): DisableEscape[] {
  const listed = spawnSync('git', ['ls-files', '-z'], {
    cwd: repoRoot,
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (listed.status !== 0) {
    throw new Error(`git ls-files 失败(RC=${String(listed.status)}):${listed.stderr ?? ''}`);
  }
  const files = listed.stdout.split('\0').filter((f) => f !== '');
  const found: DisableEscape[] = [];
  for (const rel of files) {
    if (!SCANNED_SOURCE_EXT.has(path.extname(rel))) continue;
    const abs = path.join(repoRoot, rel);
    let text: string;
    try {
      text = fs.readFileSync(abs, 'utf-8');
    } catch {
      continue; // 已删除 / 符号链接失效:git 清单与工作树的正常偏差
    }
    found.push(...scanFileForDisableEscapes(rel, text));
  }
  return found;
}

async function main(): Promise<void> {
  // 用**同一份**执法块(eslint.harness.mjs,主配置也 import 它),但换掉解析器设置:
  // 合成片段是虚拟路径,不在任何 tsconfig 项目里,类型感知解析会直接 parsing error
  // 而让规则根本跑不到(那样「全绿」毫无意义)。harness 规则全是语法级的,不需要类型信息。
  // overrideConfigFile: true = 完全不加载项目配置文件,只用下面这份。
  const {
    harnessConfigBlocks,
    HARNESS_SYNTAX,
    NULLABLE_IS_OPTIONAL_MESSAGE,
    PARAM_ID_STRING_MESSAGE,
    RATCHET_BASELINES,
    RATCHET_REGISTRY,
    parseRatchetBaseline,
    parseRatchetRegistry,
    srvfEslintPlugin,
  } = (await import('../eslint.harness.mjs')) as {
    HARNESS_SYNTAX: Record<string, { message: string }>;
    harnessConfigBlocks: unknown[];
    NULLABLE_IS_OPTIONAL_MESSAGE: string;
    PARAM_ID_STRING_MESSAGE: string;
    srvfEslintPlugin: { rules: Record<string, unknown> };
    RATCHET_BASELINES: Map<string, Map<string, readonly string[]>>;
    RATCHET_REGISTRY: ReadonlyArray<{
      id: string;
      baseline: string;
      rule: string;
      symbolShape: string;
      why: string;
    }>;
    parseRatchetBaseline: (
      text: string,
      options?: { path?: string; symbolShape?: string },
    ) => Map<string, string[]>;
    parseRatchetRegistry: (text: string) => unknown[];
  };
  const eslint = new ESLint({
    cwd: process.cwd(),
    overrideConfigFile: true,
    // ⚠️ 与 DTO 范围的 `linterOptions.noInlineConfig: true` 同源(第五轮评审 J2 · L3)。
    // 自测实例若允许 inline config,合成片段里的 `/* eslint-disable */` 会真的生效,
    // M6/M7 两条用例就会「通过」—— 通过的是逃生门,不是防线。
    allowInlineConfig: false,
    overrideConfig: [
      {
        plugins: { '@typescript-eslint': tsPlugin as never },
        languageOptions: {
          parser: tsParser as never,
          ecmaVersion: 'latest',
          sourceType: 'module',
        },
      },
      ...harnessConfigBlocks,
    ] as never,
  });
  let passed = 0;
  const failures: string[] = [];
  const knownGaps: string[] = [];

  // ── review P2-2:把「17 条选择器」和「用例」绑死 ─────────────────────────────
  // 原先断言的是 eslint 的 **ruleId**(`no-restricted-syntax`),不是**哪一条选择器**
  // 命中。当时 17 条选择器恰好各有一例,但那是**巧合,没有任何机制保证** ——
  // 加第 18 条规则却不加正向用例,它从此没有阳性对照,而阳性对照正是防
  // 「选择器写错了永远匹配不到」的唯一手段(INC-06 就是这么静默失效的)。
  //
  // 做法:每条选择器的 message 是唯一的,拿命中消息反查是哪条选择器 ——
  // 顺带把断言从「有 harness 规则响了」升级成「**是这一条**响了」,
  // misattribution(A 的用例被 B 抓到)也一并堵上。
  const messageToId = new Map<string, string>(
    Object.entries(HARNESS_SYNTAX).map(([id, def]) => [
      def.message,
      id,
    ]),
  );
  const coveredSelectors = new Set<string>();

  for (const c of CASES) {
    const results = await eslint.lintText(c.code, { filePath: c.filename });
    const messages = results.flatMap((r) => r.messages);
    const harnessHits = messages.filter(
      (m) =>
        m.ruleId === SYNTAX ||
        m.ruleId === TS_IMPORTS ||
        m.ruleId === CORE_IMPORTS ||
        m.ruleId === CUSTOM ||
        m.ruleId === PARAM_ID ||
        m.ruleId === REALIAS,
    );

    if (c.expect === null) {
      if (c.knownGap) {
        // 断言的是「现状:能绕过」。若哪天它**被拦住了**,说明缺口已关闭 ——
        // 那是好消息,但必须来把 knownGap 摘掉,否则这段文字就开始说谎。
        if (harnessHits.length === 0) {
          knownGaps.push(c.name);
          console.log(`⚠ ${c.name}`);
        } else {
          failures.push(
            `✗ ${c.name} — 该缺口似乎已被拦住(命中 ${harnessHits
              .map((m) => m.ruleId ?? '?')
              .join(',')})。\n` +
              '  这是好事,但请把该用例的 knownGap 摘掉并改成正向断言 —— ' +
              '否则自测输出会继续把已关闭的缺口报成「已知缺口」。',
          );
        }
        continue;
      }
      if (harnessHits.length === 0) {
        passed++;
        console.log(`✓ ${c.name}`);
      } else {
        failures.push(
          `✗ ${c.name} — 期望零违规,实际命中 ${harnessHits.map((m) => m.ruleId ?? '?').join(',')}`,
        );
      }
      continue;
    }

    const wanted = harnessHits.filter((m) => m.ruleId === c.expect);
    for (const m of wanted) {
      // 自定义规则本身就是独立 ruleId,不必再靠 message 反查是哪条
      if (m.ruleId === CUSTOM || m.ruleId === PARAM_ID || m.ruleId === REALIAS) {
        coveredSelectors.add(m.ruleId);
        continue;
      }
      const id = messageToId.get(m.message);
      if (id) coveredSelectors.add(id);
    }
    if (wanted.length >= (c.minCount ?? 1)) {
      passed++;
      console.log(`✓ ${c.name}`);
    } else {
      failures.push(
        `✗ ${c.name} — 期望命中 ${c.expect},实际 ${
          harnessHits.length === 0 ? '零违规(规则可能已失效!)' : harnessHits.map((m) => m.ruleId ?? '?').join(',')
        }`,
      );
    }
  }

  // 覆盖率闭环:每条规则都必须至少被一个正向用例真实触发过。
  // 闭环数 = 16 条 no-restricted-syntax 选择器 + 3 条自定义规则 = 19
  // (M4 把第 17 条 `@Param('id')` 升格成独立 ruleId 时总数仍是 18,只是它不再从
  //  HARNESS_SYNTAX 里数出来;R3 新增 srvf/no-decorator-realias 才把总数推到 19。
  //
  // ⚠️ 名单从 `srvfEslintPlugin.rules` **数出来**,不在这里手写第二份:
  //    手写一份就会出现「新增了第 N 条规则、忘了加进名单」⇒ 它从此没有阳性对照,
  //    而「写错了永远匹配不到」的自测输出与「防线完整」一模一样(INC-06 同源)。
  //    数出来之后,新增规则不补正向用例 = 本条当场红,不需要谁记得。
  const CUSTOM_RULES = Object.keys(srvfEslintPlugin.rules).map((name) => `srvf/${name}`);
  for (const literal of [CUSTOM, PARAM_ID, REALIAS]) {
    if (!CUSTOM_RULES.includes(literal)) {
      failures.push(
        `✗ 覆盖闭环名单漂移 —— 本文件的常量 ${literal} 不在 srvfEslintPlugin.rules 里。\n` +
          '  含义:规则被改名 / 摘掉了,而用例还在按旧 ruleId 断言(断言永远命中不了)。',
      );
    }
  }
  const allIds = [...Object.keys(HARNESS_SYNTAX), ...CUSTOM_RULES];
  const uncovered = allIds.filter((id) => !coveredSelectors.has(id));
  if (uncovered.length === 0) {
    passed++;
    console.log(
      `✓ 规则覆盖闭环:${allIds.length}/${allIds.length} 条均有正向用例真实触发` +
        `(${allIds.length - CUSTOM_RULES.length} 条 no-restricted-syntax 选择器 + ` +
        `${CUSTOM_RULES.length} 条自定义规则)`,
    );
  } else {
    failures.push(
      `✗ 规则覆盖闭环 — ${uncovered.length} 条规则没有任何正向用例:${uncovered.join(', ')}\n` +
        '  没有阳性对照的规则 = 写错了也永远不会有人知道(INC-06 就是这么静默失效的)。' +
        '请为每条新增规则补一个「必定违规」的用例。',
    );
  }

  // ── 第 18 条棘轮:基线**只减不增** ───────────────────────────────────────────
  //
  // 三道执行位各管一段,少任何一道棘轮都退化成单向:
  //   · 「**新增**违规」          → `pnpm lint`(豁免精确到 `类名.字段名`,
  //                                 往基线文件里加一个新字段照样红);
  //   · 「**修好了却忘删基线行**」→ 本段。lint **拦不到** —— 一条用不上的豁免
  //                                 静默无害,于是基线永远停在 641,棘轮只剩单向;
  //   · 「**同一个 PR 新增违规 + 顺手加基线**」→ base-trusted 裁判的单调性比较
  //     (.github/workflows/redzone-trusted-judge.mjs)。前两道都拦不住这一种:
  //     lint 读的是 PR 自己的基线,自然放行;本段读的也是 PR 自己的基线,同样放行。
  //
  // 判据用的是**规则本身**(同一个 rule module,identityOnly 模式让它直接吐出
  // `类名.字段名`),不是抄一份等价的 AST 遍历 —— 原先那份「报告行号 → 反查 AST
  // 取名」的平行实现已删除。「两把刻错的尺子读数相同」是本仓 2026-07-29 跨模型
  // 评审的原话,不再重蹈。
  {
    const repoRoot = path.resolve(__dirname, '..');
    const srvfPlugin = {
      rules: {
        'no-nullable-is-optional': (
          await import('../eslint-rules/no-nullable-is-optional.mjs')
        ).noNullableIsOptional,
        'no-param-id-string': (await import('../eslint-rules/no-param-id-string.mjs'))
          .noParamIdString,
      },
    };

    // ⚠️ **按注册表遍历**,不写死任何一条棘轮:加一条棘轮 = 注册表加一行,
    //    本段自动开始对账。上一版只对第 18 条对账,于是第二条棘轮落地时默认无人核对。
    for (const ratchet of RATCHET_REGISTRY) {
      const scanner = new ESLint({
        cwd: process.cwd(),
        overrideConfigFile: true,
        allowInlineConfig: false,
        overrideConfig: [
          {
            files: ['**/*.ts'],
            plugins: { '@typescript-eslint': tsPlugin as never, srvf: srvfPlugin as never },
            languageOptions: {
              parser: tsParser as never,
              ecmaVersion: 'latest',
              sourceType: 'module',
            },
            // identityOnly:把上报文案换成身份串本身,自测据此直接拿到身份
            rules: { [ratchet.rule]: ['error', { identityOnly: true }] },
          },
        ] as never,
      });
      const results = await scanner.lintFiles(['src/**/*.ts', 'test/**/*.ts', 'prisma/**/*.ts']);

      // ⚠️ 刻意**不去重**:同一身份命中多次本身就是要抓的东西之一(见 accountRatchet ①)。
      const live = new Map<string, string[]>();
      for (const r of results) {
        const ids = r.messages.filter((m) => m.ruleId === ratchet.rule).map((m) => m.message);
        if (ids.length === 0) continue;
        live.set(path.relative(repoRoot, r.filePath), ids);
      }

      const baseline = RATCHET_BASELINES.get(ratchet.id);
      if (!baseline) {
        failures.push(`✗ 棘轮 ${ratchet.id} —— 注册表登记了它,但基线没加载出来`);
        continue;
      }
      const problems = accountRatchet(live, baseline);
      const total = [...live.values()].reduce((n, ids) => n + ids.length, 0);
      if (problems.length === 0) {
        passed++;
        console.log(
          `✓ 棘轮 ${ratchet.id}(${ratchet.rule}):基线与现状逐条一致` +
            `(${total} 处 / ${live.size} 文件,身份全局唯一,只减不增)`,
        );
      } else {
        failures.push(
          `✗ 棘轮 ${ratchet.id} —— 基线与现状不一致:\n${problems.join('\n')}\n` +
            '  基线是「存量欠账清单」,不是许可证:修好一条就删一行,新增一条一律不许加行。\n' +
            `  改法见 ${ratchet.baseline} 顶部 _comment。`,
        );
      }
    }

    // ── M3 / M9:对账逻辑本身的阳性对照(故意喂坏数据,断言它确实会红)──────────
    // 不是推断「代码看起来会拦」,是真的喂进去看它拦不拦。
    const mutation = (name: string, live_: Map<string, string[]>, want: string): void => {
      const got = accountRatchet(live_, new Map([['x.dto.ts', ['D.a']]]));
      if (got.some((p) => p.includes(want))) {
        passed++;
        console.log(`✓ ${name}`);
      } else {
        failures.push(`✗ ${name} —— 期望对账报出「${want}」,实际:${got.join(' | ') || '(无问题)'}`);
      }
    };
    mutation(
      'M3 变异:修好了却没删基线行 → 陈旧行被抓',
      new Map([['x.dto.ts', []]]),
      '已修好但基线行还在',
    );
    mutation(
      'M1 变异(对账侧兜底):新增违规未登记 → 被抓',
      new Map([['x.dto.ts', ['D.a', 'D.newField']]]),
      '新增违规未登记',
    );
    // M9 —— 第五轮评审 FAIL。旧实现把命中集塞进 `new Set(...)`,
    // 于是同一个 `类名.字段名` 命中 2 次和命中 1 次**读数完全相同**:
    // 一条基线行会同时豁免掉两个真实字段,而对账全绿。改成 Map<身份, 次数> 后,
    // 判据变成「每个身份恰好命中 1 个 AST 节点」:0 个 = 陈旧,≥2 个 = 身份不唯一。
    mutation(
      'M9 变异:同文件重复身份(一行基线豁免两个字段)→ 被抓',
      new Map([['x.dto.ts', ['D.a', 'D.a']]]),
      '身份不唯一',
    );
    mutation(
      'M9 变异:身份不可具名(匿名类 / computed key)→ 被抓',
      new Map([['x.dto.ts', ['D.a', '(anonymous).foo']]]),
      '身份不可具名',
    );
  }

  // ── M10:基线 JSON 的六条格式约束,逐条阳性对照 ───────────────────────────────
  //
  // 为什么必须逐条验:一个格式松散的棘轮文件等于没有棘轮。
  // 光是让 `src/**` 这样一条 glob 混进 entries,就能把整个目录静默豁免掉,
  // 而 `pnpm lint` 依旧全绿 —— 防线还在,只是它现在什么都不管。
  // 加载期抛错(而不是 warn)意味着 lint 本身起不来:响亮地坏,好过静默地坏。
  {
    const ok = { version: 1, entries: [{ file: 'src/a.dto.ts', symbol: 'A.b' }] };
    const rejects = (name: string, code: string, doc: unknown): void => {
      let thrown: string | null = null;
      try {
        parseRatchetBaseline(typeof doc === 'string' ? doc : JSON.stringify(doc), {
          path: 'harness/is-optional-null-baseline.json',
          symbolShape: 'class-field',
        });
      } catch (err) {
        thrown = String(err);
      }
      if (thrown === null) {
        failures.push(
          `✗ ${name} —— 期望加载即抛(${code}),实际**通过了**。\n` +
            '  含义:基线文件的这条格式约束形同虚设,棘轮可以被绕过。',
        );
      } else if (!thrown.includes(`] ${code} `)) {
        failures.push(`✗ ${name} —— 抛了,但不是 ${code}:${thrown}`);
      } else {
        passed++;
        console.log(`✓ ${name}`);
      }
    };

    rejects('M10·E1 非 .ts 路径被拒', 'E1', {
      ...ok,
      entries: [{ file: 'src/a.json', symbol: 'A.b' }],
    });
    rejects('M10·E2 glob 元字符被拒(`src/**/*.dto.ts` 想整片豁免)', 'E2', {
      ...ok,
      entries: [{ file: 'src/**/*.dto.ts', symbol: 'A.b' }],
    });
    rejects('M10·E3 `../` 逃出仓库被拒', 'E3', {
      ...ok,
      entries: [{ file: '../elsewhere/a.dto.ts', symbol: 'A.b' }],
    });
    rejects('M10·E3 绝对路径被拒', 'E3', {
      ...ok,
      entries: [{ file: '/etc/a.dto.ts', symbol: 'A.b' }],
    });
    rejects('M10·E3 反斜杠路径被拒', 'E3', {
      ...ok,
      entries: [{ file: 'src\\a.dto.ts', symbol: 'A.b' }],
    });
    rejects('M10·E4 symbol 不是「类名.字段名」被拒', 'E4', {
      ...ok,
      entries: [{ file: 'src/a.dto.ts', symbol: 'onlyField' }],
    });
    rejects('M10·E5 重复条目被拒', 'E5', {
      ...ok,
      entries: [
        { file: 'src/a.dto.ts', symbol: 'A.b' },
        { file: 'src/a.dto.ts', symbol: 'A.b' },
      ],
    });
    rejects('M10·E6 未按 (file, symbol) 严格升序被拒', 'E6', {
      ...ok,
      entries: [
        { file: 'src/b.dto.ts', symbol: 'B.a' },
        { file: 'src/a.dto.ts', symbol: 'A.b' },
      ],
    });
    rejects('M10·E0 未知顶层键被拒(防「加个 allowGlob 就放宽」)', 'E0', {
      ...ok,
      allowGlob: true,
    });
    rejects('M10·E0 version 漂移被拒', 'E0', { ...ok, version: 2 });
    rejects('M10·E0 entries 元素多带一个键被拒', 'E0', {
      ...ok,
      entries: [{ file: 'src/a.dto.ts', symbol: 'A.b', note: 'why not' }],
    });

    // 反向:合法文档必须**通过**(否则上面全绿只是因为它什么都拒)
    try {
      const parsed = parseRatchetBaseline(JSON.stringify(ok), { symbolShape: 'class-field' });
      if (parsed.get('src/a.dto.ts')?.[0] === 'A.b') {
        passed++;
        console.log('✓ M10 反向:合法基线文档正常加载(不是「什么都拒」)');
      } else {
        failures.push('✗ M10 反向 —— 合法文档解析结果不对');
      }
    } catch (err) {
      failures.push(`✗ M10 反向 —— 合法文档被拒:${String(err)}`);
    }

    // ── symbolShape:身份粒度必须按棘轮而定,且**不可互串**(M4)────────────────
    // 两条棘轮的身份精度不同(`类名.字段名` vs `类名.方法名.参数名`)。
    // 若解析器把两种形状都放行,一条 `Class.field` 就能冒充 param 棘轮的身份 ——
    // 而它匹配不到任何真实节点,于是变成一行永远陈旧、却看起来「已登记」的豁免。
    {
      // ⚠️ 这条必须用 param 棘轮的 shape 去解析(上面的 rejects 固定用 class-field),
      // 否则验的是另一条棘轮,断言看着绿其实什么都没证明。
      let thrown: string | null = null;
      try {
        parseRatchetBaseline(
          JSON.stringify({ version: 1, entries: [{ file: 'src/a.controller.ts', symbol: 'A.b' }] }),
          { path: 'harness/legacy-param-id-baseline.json', symbolShape: 'class-method-param' },
        );
      } catch (err) {
        thrown = String(err);
      }
      if (thrown !== null && thrown.includes('] E4 ')) {
        passed++;
        console.log('✓ M4·E4 param 棘轮拒收「类名.字段名」(粒度不够)');
      } else {
        failures.push(
          '✗ M4·E4 param 棘轮拒收「类名.字段名」—— 期望 E4,实际:' + (thrown ?? '(通过了)'),
        );
      }
    }
    try {
      const parsed = parseRatchetBaseline(
        JSON.stringify({
          version: 1,
          entries: [{ file: 'src/a.controller.ts', symbol: 'AController.detail.id' }],
        }),
        { symbolShape: 'class-method-param' },
      );
      if (parsed.get('src/a.controller.ts')?.[0] === 'AController.detail.id') {
        passed++;
        console.log('✓ M4 反向:param 棘轮的三段式身份正常加载');
      } else {
        failures.push('✗ M4 反向 —— param 棘轮合法文档解析结果不对');
      }
    } catch (err) {
      failures.push(`✗ M4 反向 —— param 棘轮合法文档被拒:${String(err)}`);
    }
    rejects('M4·E4 null 棘轮拒收三段式身份(反向,防两种形状互串)', 'E4', {
      ...ok,
      entries: [{ file: 'src/a.dto.ts', symbol: 'A.b.c' }],
    });
  }

  // ── 注册表本身的格式约束:它是「有哪些棘轮」的唯一真相源 ─────────────────────
  //
  // 为什么要逐条验:一条写歪的注册行会让某条棘轮**静默退出**保护范围 ——
  // lint 不吭声(它只按注册表加载得到的东西执法),裁判也不吭声(它遍历同一份表)。
  // 与基线文件同理:加载即抛,响亮地坏好过静默地坏。
  {
    const okRegistry = {
      version: 1,
      ratchets: [
        {
          id: 'x',
          baseline: 'harness/x.json',
          rule: 'srvf/x',
          symbolShape: 'class-field',
          why: 'w',
        },
      ],
    };
    const rejectsRegistry = (name: string, doc: unknown): void => {
      let thrown: string | null = null;
      try {
        parseRatchetRegistry(typeof doc === 'string' ? doc : JSON.stringify(doc));
      } catch (err) {
        thrown = String(err);
      }
      if (thrown === null) {
        failures.push(
          `✗ ${name} —— 期望加载即抛,实际**通过了**。\n` +
            '  含义:注册表可以被写歪,而写歪意味着某条棘轮静默退出单调性保护。',
        );
      } else {
        passed++;
        console.log(`✓ ${name}`);
      }
    };
    rejectsRegistry('M4·注册表 非法 JSON 被拒', '{oops');
    rejectsRegistry('M4·注册表 ratchets 为空数组被拒(清空 = 全仓棘轮集体退保)', {
      ...okRegistry,
      ratchets: [],
    });
    rejectsRegistry('M4·注册表 缺 baseline 字段被拒', {
      ...okRegistry,
      ratchets: [{ id: 'x', rule: 'srvf/x', symbolShape: 'class-field', why: 'w' }],
    });
    rejectsRegistry('M4·注册表 未知 symbolShape 被拒', {
      ...okRegistry,
      ratchets: [{ ...okRegistry.ratchets[0], symbolShape: 'whatever' }],
    });
    rejectsRegistry('M4·注册表 id 重复被拒', {
      ...okRegistry,
      ratchets: [okRegistry.ratchets[0], okRegistry.ratchets[0]],
    });
    rejectsRegistry('M4·注册表 baseline 逃出 harness/ 被拒', {
      ...okRegistry,
      ratchets: [{ ...okRegistry.ratchets[0], baseline: '../elsewhere.json' }],
    });
    rejectsRegistry('M4·注册表 未知顶层键被拒', { ...okRegistry, allowAnything: true });

    // 真实注册表必须至少登记这两条 —— 少一条就等于某条棘轮悄悄退出了保护。
    const registeredIds = RATCHET_REGISTRY.map((r) => r.id).sort();
    if (
      registeredIds.includes('is-optional-null') &&
      registeredIds.includes('legacy-param-id') &&
      RATCHET_BASELINES.size === RATCHET_REGISTRY.length
    ) {
      passed++;
      console.log(
        `✓ M4 注册表:${RATCHET_REGISTRY.length} 条棘轮全部登记且基线可加载(${registeredIds.join(', ')})`,
      );
    } else {
      failures.push(
        `✗ M4 注册表 —— 登记不全:ratchets=[${registeredIds.join(', ')}], baselines=${RATCHET_BASELINES.size}`,
      );
    }
  }

  // ── F2:接线自测(走 `pnpm lint` 的正式入口,不 import eslint.harness.mjs)──────
  //
  // 为什么必须另起一条:上面每一条用例用的都是**本文件自己 new 出来的** ESLint
  // 实例,配置直接来自 import 进来的 harnessConfigBlocks。它证明的是「规则本身
  // 写对了」,**不是「规则真的接在 pnpm lint 上」** —— 这两件事可以分开坏。
  //
  // 实测(2026-07-29):把 eslint.config.mjs 里那一行 `...harnessConfigBlocks`
  // 删掉,同一个违规文件从 exit 1 变成 exit 0、零违规,17 条铁律对真实 lint
  // 全部静默失效 —— 而上面 31 条用例**一条都不会红**。这正是 INC-06 的形态:
  // 以为有防线,其实没有,且完全静默。
  //
  // 做法:往 src/ 写一个必定违规的临时文件,用**仓库自己的 eslint 二进制 +
  // 默认配置解析**(即 `pnpm lint` 走的那条路)去 lint 它,断言非零退出且
  // 命中的正是 harness 的那条 message。
  // 临时文件必须落在 src/ 内:eslint.config.mjs 的 parserOptions.project 只含
  // src / test / prisma,放到别处 eslint 会因「文件不在任何 TS project 内」直接
  // 报错 —— 那样断言测的就是另一件事了。
  {
    const repoRoot = path.resolve(__dirname, '..');
    const probeRel = 'src/__harness-lint-wiring-probe.ts';
    const probeAbs = path.join(repoRoot, probeRel);
    // 违反 no-manual-response-wrap:ReturnStatement > ObjectExpression 同时含 code 与 message
    const probeCode =
      'export class HarnessLintWiringProbe {\n' +
      '  m() {\n' +
      "    return { code: 0, message: 'ok', data: 1 };\n" +
      '  }\n' +
      '}\n';
    const expectedMessage = HARNESS_SYNTAX['no-manual-response-wrap'].message;
    try {
      fs.writeFileSync(probeAbs, probeCode);
      const r = spawnSync(
        path.join(repoRoot, 'node_modules/.bin/eslint'),
        ['--max-warnings', '0', '--format', 'json', probeRel],
        { cwd: repoRoot, encoding: 'utf-8' },
      );
      const hit =
        r.status !== 0 && typeof r.stdout === 'string' && r.stdout.includes(expectedMessage);
      if (hit) {
        passed++;
        console.log('✓ 接线自测:正式 lint 入口确实在执行 harness 执法块(删接线即红)');
      } else {
        failures.push(
          `✗ 接线自测 — 正式 lint 入口没抓到必定违规的探针文件(exit=${String(r.status)})。\n` +
            '  含义:eslint.harness.mjs 里的规则也许还在,但它没有接到 eslint.config.mjs 上,\n' +
            '  `pnpm lint` 因此对 17 条铁律全部放行。检查 eslint.config.mjs 末尾的 `...harnessConfigBlocks`。',
        );
      }
    } finally {
      // 必须清掉:留在 src/ 会让 pnpm lint 永远红(响亮地坏,好过静默地坏)
      fs.rmSync(probeAbs, { force: true });
    }
  }

  // ── M6 / M7:inline 逃生门必须走**正式 lint 入口**验证 ────────────────────────
  //
  // ⚠️ 这一段不能省,原因很绕但很致命:本文件自己 new 出来的两个 ESLint 实例都设了
  //    `allowInlineConfig: false`。于是即使 eslint.config 侧的
  //    `linterOptions.noInlineConfig` **根本没接上**,上面 M6/M7 三条用例也照样全绿 ——
  //    绿的是自测实例的构造参数,不是仓库的真实防线。
  //    只有拿仓库自己的 eslint 二进制 + 默认配置解析去跑,才证明得了真实 lint 关掉了
  //    inline 逃生门。这正是 F2 接线自测同源的教训:规则写对 ≠ 规则接上。
  //
  // 探针必须叫 *.dto.ts:noInlineConfig 的作用域刻意只到 DTO(src/ 现有 7 处
  // inline disable 全在 service / orchestrator 的硬删具名豁免上,扩到全仓会误伤,
  // 而一次误伤会让下一个人来把整条 linterOptions 删掉)。
  {
    const repoRoot = path.resolve(__dirname, '..');
    const probeRel = 'src/__harness-inline-config-probe.dto.ts';
    const probeAbs = path.join(repoRoot, probeRel);
    const probeCode =
      "import { IsOptional } from 'class-validator';\n" +
      '\n' +
      '/* eslint-disable srvf/no-nullable-is-optional */\n' +
      'export class HarnessInlineConfigProbeDto {\n' +
      '  // eslint-disable-next-line srvf/no-nullable-is-optional\n' +
      '  @IsOptional()\n' +
      '  probe?: string;\n' +
      '}\n';
    try {
      fs.writeFileSync(probeAbs, probeCode);
      const r = spawnSync(
        path.join(repoRoot, 'node_modules/.bin/eslint'),
        ['--max-warnings', '0', '--format', 'json', probeRel],
        { cwd: repoRoot, encoding: 'utf-8' },
      );
      const hit =
        r.status !== 0 &&
        typeof r.stdout === 'string' &&
        r.stdout.includes(NULLABLE_IS_OPTIONAL_MESSAGE);
      if (hit) {
        passed++;
        console.log(
          '✓ M6/M7 接线自测:正式 lint 入口下,文件级与行级 eslint-disable 都关不掉第 18 条',
        );
      } else {
        failures.push(
          `✗ M6/M7 接线自测 — 正式 lint 入口放过了带 inline disable 的违规 DTO(exit=${String(r.status)})。\n` +
            '  含义:DTO 范围的 `linterOptions.noInlineConfig: true` 没生效(或作用域没覆盖 *.dto.ts),\n' +
            '  棘轮的第一道执行位可以被违规者本人一行注释关掉。\n' +
            '  检查 eslint.harness.mjs 的 `srvf/harness:dto-no-inline-config` 块。',
        );
      }
    } finally {
      fs.rmSync(probeAbs, { force: true });
    }
  }

  // ── R2:inline 逃生门扫描 —— 先证扫描器自己有效,再扫全仓 ─────────────────────
  //
  // 顺序不能反。「全仓 0 命中」既可能是真干净,也可能是扫描器写错了永远匹配不到 ——
  // 后者是最坏的失败模式(以为有防线,其实没有,而且完全静默,和 INC-06 同源)。
  // 所以先喂必定违规的合成注释断言它确实抓到,再喂正当写法断言它不误杀。
  {
    const POSITIVE: ReadonlyArray<readonly [string, string]> = [
      ['行级具名关 srvf/ 规则', ' eslint-disable-next-line srvf/no-param-id-string'],
      ['文件级具名关 srvf/ 规则', ' eslint-disable srvf/no-nullable-is-optional '],
      ['行内具名关 srvf/ 规则', ' eslint-disable-line srvf/no-nullable-is-optional'],
      ['混在别的规则里夹带 srvf/', ' eslint-disable-next-line no-restricted-syntax, srvf/no-param-id-string'],
      ['带 -- 理由也照拦', ' eslint-disable-next-line srvf/no-param-id-string -- 有正当理由'],
      ['不具名(文件级)—— 它把 srvf/ 一并关掉,只是没写名字', ' eslint-disable '],
      ['不具名(行级)', ' eslint-disable-next-line'],
      ['不具名 + 理由', ' eslint-disable-next-line -- 就想关掉'],
    ];
    const NEGATIVE: ReadonlyArray<readonly [string, string]> = [
      ['具名关非 srvf/ 规则(AGENTS §1 明文允许的硬删豁免)', ' eslint-disable-next-line no-restricted-syntax -- 关联表物理清理'],
      ['具名关 @typescript-eslint 规则', ' eslint-disable-next-line @typescript-eslint/no-unused-vars'],
      ['只是提到这个词的普通注释', ' 见上文关于 eslint-disable 的说明'],
      ['指令不在注释开头 ⇒ eslint 自己也不认', ' prettier-ignore eslint-disable srvf/no-param-id-string'],
      ['eslint-enable 不是 disable', ' eslint-enable srvf/no-param-id-string'],
      ['前缀相同但不是指令', ' eslint-disabled-by-design srvf/no-param-id-string'],
    ];
    let scannerOk = true;
    for (const [name, comment] of POSITIVE) {
      if (classifyDisableComment(comment) === null) {
        scannerOk = false;
        failures.push(`✗ R2 扫描器阳性对照失效 —— 「${name}」没被识别为逃生门:${comment.trim()}`);
      }
    }
    for (const [name, comment] of NEGATIVE) {
      const verdict = classifyDisableComment(comment);
      if (verdict !== null) {
        scannerOk = false;
        failures.push(
          `✗ R2 扫描器误杀 —— 「${name}」被判成 ${verdict}:${comment.trim()}\n` +
            '  误杀会逼下一个人来把整条扫描删掉,后果比漏放更久。',
        );
      }
    }
    // 端到端:字符串字面量里的同一段文字**不算**违规(否则本文件自己就会被报出来,
    // 然后必然催生一条 allowlist —— 而 allowlist 就是下一个逃生门)。
    const literalOnly = scanFileForDisableEscapes(
      '<synthetic>',
      "export const sample = '/* eslint-disable srvf/no-nullable-is-optional */';\n",
    );
    const realComment = scanFileForDisableEscapes(
      '<synthetic>',
      '// eslint-disable-next-line srvf/no-param-id-string\nexport const x = 1;\n',
    );
    if (literalOnly.length !== 0) {
      scannerOk = false;
      failures.push('✗ R2 扫描器把**字符串字面量**报成了逃生门 —— 判据必须落在注释节点上');
    }
    if (realComment.length !== 1 || realComment[0].kind !== 'named-srvf') {
      scannerOk = false;
      failures.push('✗ R2 扫描器端到端失效 —— 真实注释里的 srvf/ disable 没被抓到');
    }
    if (scannerOk) {
      passed++;
      console.log(
        `✓ R2 扫描器阳性对照:${POSITIVE.length} 条逃生门全抓到、${NEGATIVE.length} 条正当写法全放行`,
      );
    }

    const escapes = scanRepoForDisableEscapes(path.resolve(__dirname, '..'));
    if (escapes.length === 0) {
      passed++;
      console.log('✓ R2 全仓扫描:0 处指向 srvf/ 的 disable、0 处不具名 disable');
    } else {
      failures.push(
        `✗ R2 全仓扫描 —— ${escapes.length} 处 inline 逃生门:\n` +
          escapes
            .map(
              (e) =>
                `    ${e.file}:${e.line}  [${e.kind === 'named-srvf' ? '具名关掉 srvf/ 规则' : '不具名 disable(把 srvf/ 一并关掉)'}]\n` +
                `      ${e.text}`,
            )
            .join('\n') +
          '\n  srvf/ 三条规则是执法体,不接受行内关闭:能被违规者本人一行注释关掉的防线不是防线。\n' +
          '  正确做法:把违规真的改掉;确属存量,走对应棘轮的具名基线(harness/ratchet-registry.json)。\n' +
          '  不具名 disable 同样拒 —— 它关掉的规则集合里就包含 srvf/,只是没写出名字。',
      );
    }
  }

  // 已知缺口单独成段:不混进「通过」的叙事。
  // 防线的边界必须和防线本身一样显眼 —— 否则「31 passed」会被读成「全都管住了」。
  if (knownGaps.length > 0) {
    console.log(`\n── 已知缺口:${knownGaps.length} 条对抗样例当前**可绕过**(不假装安全)──`);
    for (const g of knownGaps) console.log(`  ⚠ ${g}`);
    console.log(
      '  成因:no-restricted-syntax 匹配的是语法树的**字面形状**,不解析 import binding、\n' +
        '        不做变量指向分析。原写法拦得住,换个名字就拦不住。\n' +
        '  定性:AGENTS §1 已把该层表述为「**字面语法拦截**」而非「机器执法」。\n' +
        '  处置:**三条自定义规则**(srvf/no-nullable-is-optional、srvf/no-param-id-string、\n' +
        '        srvf/no-decorator-realias)已把「换个名字就绕过」这一类关到底:\n' +
        '        前两条共用 eslint-rules/decorator-identity.mjs 看穿别名 / namespace /\n' +
        '        局部中转 / 同名 re-export / **计算属性** / **解构中转**(M4 + R3,各有正向用例),\n' +
        '        第三条从源头禁掉**改名导出**——跨文件换名字因此根本发生不了。\n' +
        '        上面 5 条仍是 no-restricted-syntax 选择器,缺口原样存在,改写它们未立项。',
    );
  }

  for (const f of failures) console.error(f);
  console.log(`\n${passed} passed, ${failures.length} failed, ${knownGaps.length} known gaps`);
  if (failures.length > 0) {
    console.error(
      '\n⚠️ eslint 执法规则失效或误杀。常见原因:flat config 同 ruleId 后块整体覆盖前块' +
        '(见 eslint.config.mjs 内 harnessConfigBlocks 的排序注释),或 selector 写法漂移。',
    );
    process.exit(1);
  }
}

void main();
