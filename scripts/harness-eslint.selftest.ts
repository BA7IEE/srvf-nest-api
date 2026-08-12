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
// ── R4(2026-08-01 整批评审 ③)—— disable 之外的**第二种** inline 语法 ──────────
//
// R2 关的是 `eslint-disable` 家族。ESLint 还有一种**完全不同的语法**能把规则关掉:
// **规则配置注释** `/* eslint <rule>: <config> */`。它不含 "disable" 三个字,
// R2 的正则一个都匹配不到 —— 修复前四组变异在真实 `pnpm lint` 下全部 **RC=0 零命中**。
//
// | # | 变异(写进真实 controller 跑正式 lint) | 带注释 | 去掉注释 | 拦在哪 | 断言在哪 |
// |---|---|---|---|---|---|
// | R4-1 | `/* eslint srvf/no-param-id-string: "off" */` | **🟢 RC=0 零命中** | 🔴 RC=1 | 全仓扫描拒规则配置注释 | 本文件 R4 段 |
// | R4-2 | 同上但写成 `: 0` | **🟢 RC=0** | 🔴 RC=1 | 同上 | 同上 |
// | R4-3 | 同上但写成 `: ["off"]` | **🟢 RC=0** | 🔴 RC=1 | 同上 | 同上 |
// | R4-4 | `/* eslint no-restricted-syntax: "off" */`(关第 18 条那一族) | **🟢 RC=0** | 🔴 RC=1 | 同上 | 同上 |
//
// 判据为什么是「拒**一切**规则配置注释」而不是「只拒点名 srvf/ 与 no-restricted-syntax 的」:
//   ① 规则名白名单自己就是下一个逃生门 —— 落地第四条执法规则却忘了往名单里加,
//      缺口静默重开(和 R2 里「把 noInlineConfig 扩到第二类文件」是同一个错误的两种写法);
//   ② 配置注释还能把规则**降级**(`: "warn"`),不只是关掉。降级同样是改判据;
//   ③ 全仓实测**零命中**(唯一以 `eslint` 开头的注释是 selftest 自己的一句散文,
//      而它是 **Line** 注释)—— 这条同样是零代价的。
//
// ⚠️ 只判 **Block** 注释:ESLint 的规则配置注释**只认块注释**,`// eslint x: "off"`
//    对 ESLint 什么都不做。把它也报成逃生门就是误杀 —— 而误杀会逼下一个人来把整条扫描删掉。
//    锚点照抄 ESLint 自己的判据(块注释 + 指令词恰为 `eslint`),松一点误报,紧一点漏报。
//
// R2 为什么不做成 eslint 规则:一条 eslint 规则自己也能被 `/* eslint-disable */`
// 关掉(那正是 R2-4)。扫描必须跑在 eslint **之外**才站得住。R4 更是如此 ——
// 规则配置注释能直接把那条规则本身配成 off。
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
/** 测试禁「近未来」日期字面量:INC-18 新增的第四条自定义规则(eslint-rules/no-near-future-date.mjs)。 */
const NEAR_FUTURE = 'srvf/no-near-future-date';
/** 通知模块受众判定唯一入口:T5A 挂账的第五条自定义规则(eslint-rules/no-audience-primitive-import.mjs)。 */
const AUDIENCE_IMPORT = 'srvf/no-audience-primitive-import';
/** R8:声明 canonical policy 与 T1/T2 字面断言闭环；不确定路径诚实落 T3。 */
const AUTHZ_DECLARATION_CLOSURE = 'srvf/authz-declaration-closure';

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

  // ---- INC-18:测试禁「近未来」日期字面量(第四条自定义规则)----
  // 阳性样本刻意用 2089-12-31:它落在 (today, 2090-01-01) 区间内直到 2089 年,
  // 阳性对照自身不会成为一颗「几年后自测开始误绿」的炸弹。判据的逐边界钉死
  // (today/today+1/地板/假日期/闰日/去重)在下方「INC-18 判据期望值表」——
  // 那边时钟注入固定 today,不依赖跑测当天。
  {
    name: 'INC-18 ①:e2e 里的近未来 ISO 时间戳被抓',
    filename: 'test/e2e/x.e2e-spec.ts',
    code: "const d = new Date('2089-12-31T08:00:00.000Z');\nexport default d;",
    expect: NEAR_FUTURE,
  },
  {
    name: 'INC-18 ②:模板字符串里的近未来日期同样被抓',
    filename: 'test/e2e/x.e2e-spec.ts',
    code: 'export const q = `endAt=2089-06-01T00:00:00Z`;',
    expect: NEAR_FUTURE,
  },
  {
    name: 'INC-18 ③:src 里的 *.spec.ts 单测同在辖区(2026-09 引信正是在 src 单测里扫出的)',
    filename: 'src/modules/x/x.service.spec.ts',
    code: "const d = '2089-12-31';\nexport default d;",
    expect: NEAR_FUTURE,
  },
  {
    name: 'INC-18 反向:2099 远未来平移惯例放行',
    filename: 'test/e2e/x.e2e-spec.ts',
    code: "const d = new Date('2099-08-01T00:00:00.000Z');\nexport default d;",
    expect: null,
  },
  {
    name: 'INC-18 反向:历史日期放行(已爆的炸弹测试自己会红,轮不到本规则)',
    filename: 'test/e2e/x.e2e-spec.ts',
    code: "const d = new Date('2020-01-01T00:00:00.000Z');\nexport default d;",
    expect: null,
  },
  {
    name: 'INC-18 反向:src 业务文件不在辖区(DTO example 是业务语义,动之即撞契约快照)',
    filename: 'src/modules/x/x.dto.ts',
    code: "export const EXAMPLE_DATE = '2089-12-31';",
    expect: null,
  },

  // ---- T5A 挂账:通知模块受众判定唯一入口(第五条自定义规则)----
  // 白名单是 eslint.harness.mjs 的 allow 选项(常驻设计位,非棘轮欠账);
  // 这里的正/反例喂的是**真实生效的 harnessConfigBlocks**,连 allow 一起验。
  {
    name: 'AUD ①:通知模块内直接 import 受众原语被抓(新通道自写判定 = D-WC-19 要防的漂移)',
    filename: 'src/modules/notifications/notification-newchan-dispatch.service.ts',
    code: "import { canSeeContent } from '../content/content.visibility';\nexport const x = canSeeContent;",
    expect: AUDIENCE_IMPORT,
  },
  {
    name: 'AUD ②:改名转发 `export { canSeeContent as see } from …` 在源头即错(R3 同型绕过路径)',
    filename: 'src/modules/notifications/reexport.ts',
    code: "export { canSeeContent as see } from '../content/content.visibility';",
    expect: AUDIENCE_IMPORT,
  },
  {
    name: 'AUD ③:`export * from …` 连名字都不点也被抓',
    filename: 'src/modules/notifications/reexport-all.ts',
    code: "export * from '../content/content.visibility';",
    expect: AUDIENCE_IMPORT,
  },
  {
    name: 'AUD ④:`import type` 同样被抓(类型层引用也是对原语形状的耦合)',
    filename: 'src/modules/notifications/typed.ts',
    code: "import type { CallerVisibilityContext } from '../content/content.visibility';\nexport type T = CallerVisibilityContext;",
    expect: AUDIENCE_IMPORT,
  },
  {
    name: 'AUD 反向:判定服务本体在白名单内放行',
    filename: 'src/modules/notifications/notification-recipient-authorization.service.ts',
    code: "import { canSeeContent } from '../content/content.visibility';\nexport const x = canSeeContent;",
    expect: null,
  },
  {
    name: 'AUD 反向:读侧 read.service 在白名单内放行(isManagement 恒求值,T5A 明确不并入)',
    filename: 'src/modules/notifications/notification-read.service.ts',
    code: "import { buildVisibilityWhere } from '../content/content.visibility';\nexport const x = buildVisibilityWhere;",
    expect: null,
  },
  {
    name: 'AUD 反向:content 模块消费自家原语不在辖区',
    filename: 'src/modules/content/content.service.ts',
    code: "import { canSeeContent } from './content.visibility';\nexport const x = canSeeContent;",
    expect: null,
  },
  {
    name: 'AUD 反向:同目录同名前缀文件不误配(other-content.visibility 不是那个原语文件)',
    filename: 'src/modules/notifications/other.ts',
    code: "import { y } from '../content/other-content.visibility';\nexport const x = y;",
    expect: null,
  },
  {
    name: 'AUD 反向:模块内 spec 引原语做对拍放行(visibility-reuse parity spec 是守护不是漂移;首跑 CI 冷 lint 实抓)',
    filename: 'src/modules/notifications/notification.visibility-reuse.spec.ts',
    code: "import { canSeeContent } from '../content/content.visibility';\nexport const x = canSeeContent;",
    expect: null,
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
  /**
   * 'named-srvf' = 具名关掉 srvf/ 规则;'unscoped' = 不具名(把 srvf/ 一并关掉);
   * 'rule-config' = 规则配置注释 `/* eslint x: "off" *\/`(R4,与 disable 是两种语法)
   */
  readonly kind: 'named-srvf' | 'unscoped' | 'rule-config';
  readonly text: string;
}

/**
 * 命中种类 → 给人读的标签。**必须是全覆盖的表,不能写成三元**:
 * R4 落地时这里原本是 `kind === 'named-srvf' ? A : B` 的二元三元,新增的 'rule-config'
 * 于是被渲染成「不具名 disable」—— 抓是抓到了,但报告在说另一件事,会把下一个人送去
 * 改错的东西。判据本身对、消息撒谎,是最难发现的一种坏。
 * 下面 `assertEveryKindHasLabel` 是它的执行位:新增 kind 却忘了配标签,自测直接红。
 */
const ESCAPE_KIND_LABEL: Record<DisableEscape['kind'], string> = {
  'named-srvf': '具名关掉 srvf/ 规则',
  unscoped: '不具名 disable(把 srvf/ 一并关掉)',
  'rule-config': '规则配置注释(`/* eslint x: "off" *\\/`,关掉或降级都算)',
};

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
 * ESLint 的**规则配置**指令词恰好是 `eslint`(后面不接 `-`)—— `eslint-disable` /
 * `eslint-enable` / `eslint-env` 都是别的指令,不归本条。
 */
const RULE_CONFIG_DIRECTIVE_RE = /^\s*eslint(?![\w-])/;

/**
 * 判一条注释:是不是规则配置注释(R4)。纯函数,自测直接喂合成注释。
 *
 * @param commentType AST 注释节点的 `type`:'Block' | 'Line'。**必须传** ——
 *   ESLint 只在块注释里认规则配置,行注释里的同样文字什么都不做,报它就是误杀。
 * @param commentValue 注释体(不含 `//` 与 `/* *\/` 定界符)
 */
export function classifyRuleConfigComment(
  commentType: string,
  commentValue: string,
): DisableEscape['kind'] | null {
  if (commentType !== 'Block') return null;
  return RULE_CONFIG_DIRECTIVE_RE.test(commentValue) ? 'rule-config' : null;
}

/**
 * 扫一个文件的**全部注释**。解析用的是与 `pnpm lint` 同一个 parser(typescript-eslint),
 * 不是手写的注释切分器 —— 手写切分器迟早在模板串 / 正则字面量 / JSX 上与真实解析漂移,
 * 而漂移的方向恰好是漏报。
 */
export function scanFileForDisableEscapes(file: string, text: string): DisableEscape[] {
  // 便宜的预筛:没有这个词就一定没有指令,省掉整棵 AST。不会漏报。
  // ⚠️ 预筛词是 `eslint` 而**不是** `eslint-disable`:R4 的规则配置注释里根本没有
  // "disable" 三个字,按旧预筛剪枝会让新判据永远匹配不到 —— 那正是最坏的静默失效。
  if (!text.includes('eslint')) return [];
  let comments: Array<{ type?: string; value: string; loc?: { start: { line: number } } }>;
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
    ) => {
      ast: {
        comments?: Array<{ type?: string; value: string; loc?: { start: { line: number } } }>;
      };
    };
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
    const kind =
      classifyDisableComment(c.value) ?? classifyRuleConfigComment(c.type ?? '', c.value);
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

/**
 * 按显式路径清单扫描。全仓扫描与 R4 真触发探针共用**同一条**读盘 → 解析 → 判定链,
 * 两者只在「文件清单从哪来」上不同 —— 探针因此测得到真实链路,而不是另写一份判据。
 */
export function scanPathsForDisableEscapes(
  repoRoot: string,
  relPaths: readonly string[],
): DisableEscape[] {
  const found: DisableEscape[] = [];
  for (const rel of relPaths) {
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
  return scanPathsForDisableEscapes(repoRoot, files);
}

async function main(): Promise<void> {
  // 用**同一份**执法块(eslint.harness.mjs,主配置也 import 它),但换掉解析器设置:
  // 合成片段是虚拟路径,不在任何 tsconfig 项目里,类型感知解析会直接 parsing error
  // 而让规则根本跑不到(那样「全绿」毫无意义)。harness 规则全是语法级的,不需要类型信息。
  // overrideConfigFile: true = 完全不加载项目配置文件,只用下面这份。
  const {
    harnessConfigBlocks,
    HARNESS_SYNTAX,
    AUTHZ_DECLARATION_CLOSURE_RULE,
    NULLABLE_IS_OPTIONAL_MESSAGE,
    PARAM_ID_STRING_MESSAGE,
    RATCHET_BASELINES,
    RATCHET_REGISTRY,
    parseRatchetBaseline,
    parseRatchetRegistry,
    srvfEslintPlugin,
  } = (await import('../eslint.harness.mjs')) as {
    HARNESS_SYNTAX: Record<string, { message: string }>;
    AUTHZ_DECLARATION_CLOSURE_RULE: string;
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
  const { scanRouteAuthzClosure } =
    (await import('../eslint-rules/authz-declaration-closure.mjs')) as {
      scanRouteAuthzClosure: (options?: {
        rootDir?: string;
        entries?: unknown[];
        cacheKey?: string;
      }) => Array<{
        tier: string;
        closure: string;
        missing: string[];
      }>;
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
    Object.entries(HARNESS_SYNTAX).map(([id, def]) => [def.message, id]),
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
        m.ruleId === REALIAS ||
        m.ruleId === NEAR_FUTURE ||
        m.ruleId === AUDIENCE_IMPORT ||
        m.ruleId === AUTHZ_DECLARATION_CLOSURE,
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
      if (
        m.ruleId === CUSTOM ||
        m.ruleId === PARAM_ID ||
        m.ruleId === REALIAS ||
        m.ruleId === NEAR_FUTURE ||
        m.ruleId === AUDIENCE_IMPORT ||
        m.ruleId === AUTHZ_DECLARATION_CLOSURE
      ) {
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
          harnessHits.length === 0
            ? '零违规(规则可能已失效!)'
            : harnessHits.map((m) => m.ruleId ?? '?').join(',')
        }`,
      );
    }
  }

  // ── R8:声明↔实现闭环 —— 用真实规则、真实文件验证边界 ─────────────────────
  //
  // 这里故意不重写一份 AST 检查器。探针直接喂已经挂到 eslint.harness.mjs 的
  // srvf/authz-declaration-closure，并用它导出的同一个 scanner 核对分类结果。
  // 否则「rule 绿」和「首扫报告绿」可以各自用不同语义，正好重演 R8 要消灭的
  // 两把尺子问题。
  {
    type ProbePolicy = {
      admission: string | null;
      mode: string;
      codes: Array<{ code: string; scope: string | null }>;
      require: 'all' | 'any';
      scopes: string[];
      engine: string | null;
    };
    type R8Probe = {
      name: string;
      source: string;
      policy: ProbePolicy;
      tier: string;
      closure: string;
      diagnostic?: string;
    };
    const repoRoot = path.resolve(__dirname, '..');
    const probeRel = 'src/__harness-authz-r8-probe.controller.ts';
    const probeAbs = path.join(repoRoot, probeRel);
    const entryOf = (name: string, policy: ProbePolicy) => [
      {
        routeKey: `GET /api/harness/r8/${name}`,
        controller: 'HarnessAuthzR8ProbeController',
        handler: 'run',
        legacy: 'auth',
        policy,
      },
    ];
    const controller = (body: string) =>
      `${body}\n\nexport class HarnessAuthzR8ProbeController {\n` +
      '  constructor(private readonly service: HarnessAuthzR8ProbeService) {}\n\n' +
      '  async run(user: unknown): Promise<unknown> {\n' +
      '    const invoke = this.service.authorize.bind(this.service);\n' +
      '    return invoke(user);\n' +
      '  }\n' +
      '}\n';
    const probes: readonly R8Probe[] = [
      {
        name: 'alias-and-one-layer-intermediate',
        source: controller(
          'class RbacService {\n' +
            '  async can(_user: unknown, _action: string): Promise<boolean> {\n' +
            '    return true;\n' +
            '  }\n' +
            '}\n\n' +
            'class HarnessAuthzR8ProbeService {\n' +
            '  constructor(private readonly rbac: RbacService) {}\n\n' +
            '  async authorize(user: unknown): Promise<string> {\n' +
            "    const action = 'probe.alias.read';\n" +
            '    const forwardedAction = action;\n' +
            '    const can = this.rbac.can.bind(this.rbac);\n' +
            '    if (!(await can(user, forwardedAction))) {\n' +
            "      throw new Error('forbidden');\n" +
            '    }\n' +
            "    return 'ok';\n" +
            '  }\n' +
            '}',
        ),
        policy: {
          admission: null,
          mode: 'RBAC',
          codes: [{ code: 'probe.alias.read', scope: null }],
          require: 'all',
          scopes: [],
          engine: 'rbac-global',
        },
        tier: 'T2',
        closure: 'closed',
      },
      {
        name: 'authz-can-explain-positive',
        source: controller(
          'class AuthzService {\n' +
            '  async can(_user: unknown, _action: string, _ref: unknown): Promise<boolean> {\n' +
            '    return true;\n' +
            '  }\n' +
            '}\n\n' +
            'class HarnessAuthzR8ProbeService {\n' +
            '  constructor(private readonly authz: AuthzService) {}\n\n' +
            '  async authorize(user: unknown): Promise<string> {\n' +
            "    const action = 'probe.authz.read';\n" +
            "    if (!(await this.authz.can(user, action, { type: 'probe', id: '1' }))) {\n" +
            "      throw new Error('forbidden');\n" +
            '    }\n' +
            "    return 'ok';\n" +
            '  }\n' +
            '}',
        ),
        policy: {
          admission: null,
          mode: 'RBAC',
          codes: [{ code: 'probe.authz.read', scope: null }],
          require: 'all',
          scopes: [],
          engine: 'authz-scoped',
        },
        tier: 'T2',
        closure: 'closed',
      },
      {
        name: 'visible-scope-positive',
        source: controller(
          'class AuthzService {\n' +
            '  async can(_user: unknown, _action: string, _ref: unknown): Promise<boolean> {\n' +
            '    return true;\n' +
            '  }\n\n' +
            '  async getVisibleOrganizationScope(_user: unknown, _action: string) {\n' +
            "    return { organizationIds: ['org-1'] };\n" +
            '  }\n' +
            '}\n\n' +
            'class HarnessAuthzR8ProbeService {\n' +
            '  constructor(private readonly authz: AuthzService) {}\n\n' +
            '  async authorize(user: unknown): Promise<unknown> {\n' +
            "    if (!(await this.authz.can(user, 'probe.visible.read', { type: 'probe', id: '1' }))) {\n" +
            "      throw new Error('forbidden');\n" +
            '    }\n' +
            "    const scope = await this.authz.getVisibleOrganizationScope(user, 'probe.visible.read');\n" +
            '    return { where: { organizationId: { in: scope.organizationIds } } };\n' +
            '  }\n' +
            '}',
        ),
        policy: {
          admission: null,
          mode: 'RBAC',
          codes: [{ code: 'probe.visible.read', scope: null }],
          require: 'all',
          scopes: ['org-scope'],
          engine: 'authz-scoped',
        },
        tier: 'T2',
        closure: 'closed',
      },
      {
        name: 'app-identity-positive',
        source: controller(
          'class AppIdentityResolver {\n' +
            '  async resolve(_user: unknown): Promise<{ canUseApp: boolean }> {\n' +
            '    return { canUseApp: true };\n' +
            '  }\n' +
            '}\n\n' +
            'class HarnessAuthzR8ProbeService {\n' +
            '  constructor(private readonly identity: AppIdentityResolver) {}\n\n' +
            '  async authorize(user: unknown): Promise<string> {\n' +
            '    const identity = await this.identity.resolve(user);\n' +
            '    if (!identity.canUseApp) {\n' +
            "      throw new Error('app-member-required');\n" +
            '    }\n' +
            "    return 'ok';\n" +
            '  }\n' +
            '}',
        ),
        policy: {
          admission: 'app-member',
          mode: 'LOGIN_ONLY',
          codes: [],
          require: 'all',
          scopes: [],
          engine: null,
        },
        tier: 'T2',
        closure: 'closed',
      },
      {
        name: 'responsibility-positive',
        source: controller(
          'class AuthzService {\n' +
            '  async can(_user: unknown, _action: string, _ref: unknown): Promise<boolean> {\n' +
            '    return true;\n' +
            '  }\n' +
            '}\n\n' +
            'class ActivityResponsibilityPolicy {\n' +
            '  async assertOwner(_tx: unknown, _activityId: string, _user: unknown): Promise<void> {}\n' +
            '}\n\n' +
            'class HarnessAuthzR8ProbeService {\n' +
            '  constructor(\n' +
            '    private readonly authz: AuthzService,\n' +
            '    private readonly responsibility: ActivityResponsibilityPolicy,\n' +
            '  ) {}\n\n' +
            '  async authorize(user: unknown): Promise<string> {\n' +
            "    if (!(await this.authz.can(user, 'probe.responsibility.read', { type: 'probe', id: '1' }))) {\n" +
            "      throw new Error('forbidden');\n" +
            '    }\n' +
            "    await this.responsibility.assertOwner({}, 'activity-1', user);\n" +
            "    return 'ok';\n" +
            '  }\n' +
            '}',
        ),
        policy: {
          admission: null,
          mode: 'RESPONSIBILITY_SCOPED',
          codes: [],
          require: 'all',
          scopes: ['responsibility'],
          engine: 'authz-scoped',
        },
        tier: 'T2',
        closure: 'closed',
      },
      {
        name: 'registered-call-without-outcome-is-t3',
        source: controller(
          'class RbacService {\n' +
            '  async can(_user: unknown, _action: string): Promise<boolean> {\n' +
            '    return true;\n' +
            '  }\n' +
            '}\n\n' +
            'class HarnessAuthzR8ProbeService {\n' +
            '  constructor(private readonly rbac: RbacService) {}\n\n' +
            '  async authorize(user: unknown): Promise<string> {\n' +
            "    await this.rbac.can(user, 'probe.no-outcome.read');\n" +
            "    return 'side-effect-would-have-run';\n" +
            '  }\n' +
            '}',
        ),
        policy: {
          admission: null,
          mode: 'RBAC',
          codes: [{ code: 'probe.no-outcome.read', scope: null }],
          require: 'all',
          scopes: [],
          engine: 'rbac-global',
        },
        tier: 'T3',
        closure: 'candidate',
        diagnostic: 'probe.no-outcome.read',
      },
      {
        name: 'authz-call-without-outcome-is-t3',
        source: controller(
          'class AuthzService {\n' +
            '  async can(_user: unknown, _action: string, _ref: unknown): Promise<boolean> {\n' +
            '    return true;\n' +
            '  }\n' +
            '}\n\n' +
            'class HarnessAuthzR8ProbeService {\n' +
            '  constructor(private readonly authz: AuthzService) {}\n\n' +
            '  async authorize(user: unknown): Promise<string> {\n' +
            "    await this.authz.can(user, 'probe.authz.no-outcome', { type: 'probe', id: '1' });\n" +
            "    return 'side-effect-would-have-run';\n" +
            '  }\n' +
            '}',
        ),
        policy: {
          admission: null,
          mode: 'RBAC',
          codes: [{ code: 'probe.authz.no-outcome', scope: null }],
          require: 'all',
          scopes: [],
          engine: 'authz-scoped',
        },
        tier: 'T3',
        closure: 'candidate',
        diagnostic: 'probe.authz.no-outcome',
      },
      {
        name: 'visibility-call-without-filter-pushdown-is-mismatch',
        source: controller(
          'class AuthzService {\n' +
            '  async can(_user: unknown, _action: string, _ref: unknown): Promise<boolean> {\n' +
            '    return true;\n' +
            '  }\n\n' +
            '  async getVisibleOrganizationScope(_user: unknown, _action: string) {\n' +
            "    return { organizationIds: ['org-1'] };\n" +
            '  }\n' +
            '}\n\n' +
            'class HarnessAuthzR8ProbeService {\n' +
            '  constructor(private readonly authz: AuthzService) {}\n\n' +
            '  async authorize(user: unknown): Promise<unknown> {\n' +
            "    if (!(await this.authz.can(user, 'probe.visibility.no-pushdown', { type: 'probe', id: '1' }))) {\n" +
            "      throw new Error('forbidden');\n" +
            '    }\n' +
            "    return this.authz.getVisibleOrganizationScope(user, 'probe.visibility.no-pushdown');\n" +
            '  }\n' +
            '}',
        ),
        policy: {
          admission: null,
          mode: 'RBAC',
          codes: [{ code: 'probe.visibility.no-pushdown', scope: null }],
          require: 'all',
          scopes: ['org-scope'],
          engine: 'authz-scoped',
        },
        tier: 'T2',
        closure: 'mismatch',
        diagnostic: 'scope org-scope',
      },
      {
        name: 'app-identity-call-without-deny-branch-is-t3',
        source: controller(
          'class AppIdentityResolver {\n' +
            '  async resolve(_user: unknown): Promise<{ canUseApp: boolean }> {\n' +
            '    return { canUseApp: true };\n' +
            '  }\n' +
            '}\n\n' +
            'class HarnessAuthzR8ProbeService {\n' +
            '  constructor(private readonly identity: AppIdentityResolver) {}\n\n' +
            '  async authorize(user: unknown): Promise<string> {\n' +
            '    await this.identity.resolve(user);\n' +
            "    return 'side-effect-would-have-run';\n" +
            '  }\n' +
            '}',
        ),
        policy: {
          admission: 'app-member',
          mode: 'LOGIN_ONLY',
          codes: [],
          require: 'all',
          scopes: [],
          engine: null,
        },
        tier: 'T3',
        closure: 'candidate',
        diagnostic: 'admission app-member',
      },
      {
        name: 'unregistered-responsibility-call-is-not-an-assertion',
        source: controller(
          'class AuthzService {\n' +
            '  async can(_user: unknown, _action: string, _ref: unknown): Promise<boolean> {\n' +
            '    return true;\n' +
            '  }\n' +
            '}\n\n' +
            'class ActivityResponsibilityPolicy {\n' +
            '  async checkCollaborator(_activityId: string, _user: unknown): Promise<boolean> {\n' +
            '    return true;\n' +
            '  }\n' +
            '}\n\n' +
            'class HarnessAuthzR8ProbeService {\n' +
            '  constructor(\n' +
            '    private readonly authz: AuthzService,\n' +
            '    private readonly responsibility: ActivityResponsibilityPolicy,\n' +
            '  ) {}\n\n' +
            '  async authorize(user: unknown): Promise<string> {\n' +
            "    if (!(await this.authz.can(user, 'probe.responsibility.unregistered', { type: 'probe', id: '1' }))) {\n" +
            "      throw new Error('forbidden');\n" +
            '    }\n' +
            "    await this.responsibility.checkCollaborator('activity-1', user);\n" +
            "    return 'side-effect-would-have-run';\n" +
            '  }\n' +
            '}',
        ),
        policy: {
          admission: null,
          mode: 'RESPONSIBILITY_SCOPED',
          codes: [],
          require: 'all',
          scopes: ['responsibility'],
          engine: 'authz-scoped',
        },
        tier: 'T2',
        closure: 'mismatch',
        diagnostic: 'scope responsibility',
      },
      {
        name: 'require-any-still-needs-every-declared-or-branch',
        source: controller(
          'class RbacService {\n' +
            '  async can(_user: unknown, _action: string): Promise<boolean> {\n' +
            '    return true;\n' +
            '  }\n' +
            '}\n\n' +
            'class HarnessAuthzR8ProbeService {\n' +
            '  constructor(private readonly rbac: RbacService) {}\n\n' +
            '  async authorize(user: unknown): Promise<string> {\n' +
            "    if (!(await this.rbac.can(user, 'probe.any.one'))) {\n" +
            "      throw new Error('forbidden');\n" +
            '    }\n' +
            "    return 'ok';\n" +
            '  }\n' +
            '}',
        ),
        policy: {
          admission: null,
          mode: 'RBAC',
          codes: [
            { code: 'probe.any.one', scope: null },
            { code: 'probe.any.two', scope: null },
          ],
          require: 'any',
          scopes: [],
          engine: 'rbac-global',
        },
        tier: 'T2',
        closure: 'mismatch',
        diagnostic: 'probe.any.two',
      },
    ];

    let r8Ok = true;
    try {
      for (const [index, probe] of probes.entries()) {
        fs.writeFileSync(probeAbs, probe.source);
        const entries = entryOf(probe.name, probe.policy);
        const cacheKey = `r8-selftest-${index}`;
        const scanner = new ESLint({
          cwd: repoRoot,
          overrideConfigFile: true,
          allowInlineConfig: false,
          overrideConfig: [
            {
              languageOptions: {
                parser: tsParser as never,
                ecmaVersion: 'latest',
                sourceType: 'module',
              },
            },
            {
              files: [probeRel],
              plugins: { srvf: srvfEslintPlugin as never },
              rules: {
                [AUTHZ_DECLARATION_CLOSURE_RULE]: ['warn', { entries, cacheKey }],
              },
            },
          ] as never,
        });
        const linted = await scanner.lintFiles([probeRel]);
        const messages = linted.flatMap((result) => result.messages);
        const diagnostics = messages.filter(
          (message) => message.ruleId === AUTHZ_DECLARATION_CLOSURE_RULE,
        );
        const records = scanRouteAuthzClosure({
          rootDir: repoRoot,
          entries,
          cacheKey,
        });
        const record = records[0];
        const expectedDiagnostic = probe.diagnostic;
        const diagnosticOk =
          expectedDiagnostic === undefined
            ? diagnostics.length === 0
            : diagnostics.length === 1 && diagnostics[0].message.includes(expectedDiagnostic);
        if (
          record === undefined ||
          record.tier !== probe.tier ||
          record.closure !== probe.closure ||
          !diagnosticOk
        ) {
          r8Ok = false;
          failures.push(
            `✗ R8 ${probe.name} —— 期望 ${probe.tier}/${probe.closure}` +
              `${expectedDiagnostic === undefined ? ' 且零 warning' : ` 且 warning 含 ${expectedDiagnostic}`}，` +
              `实际 ${record?.tier ?? '无记录'}/${record?.closure ?? '无记录'}，` +
              `warning=${diagnostics.map((item) => item.message).join(' | ') || '0'}`,
          );
        }
      }
    } finally {
      fs.rmSync(probeAbs, { force: true });
    }
    if (r8Ok) {
      coveredSelectors.add(AUTHZ_DECLARATION_CLOSURE);
      passed++;
      console.log(
        '✓ R8 真触发:别名 + 一层 service 中转、五类已登记断言模式的逐轴闭环、' +
          '无后果调用与 require:any 漏 OR 分支均按预期出数',
      );
    }

    const full = scanRouteAuthzClosure({
      rootDir: repoRoot,
      cacheKey: 'r8-full-repository-scan',
    });
    const distribution = full.reduce<Record<string, number>>((counts, record) => {
      const key = `${record.tier}/${record.closure}`;
      counts[key] = (counts[key] ?? 0) + 1;
      return counts;
    }, {});
    const total = Object.values(distribution).reduce((sum, count) => sum + count, 0);
    if (full.length === 0 || total !== full.length) {
      failures.push(`✗ R8 全仓首扫出数异常 —— entries=${full.length},分类合计=${total}`);
    } else {
      passed++;
      console.log(
        `✓ R8 全仓首扫(report-only):可判 T1=${(distribution['T1/closed'] ?? 0) + (distribution['T1/mismatch'] ?? 0)}` +
          `(closed=${distribution['T1/closed'] ?? 0}, mismatch=${distribution['T1/mismatch'] ?? 0})，` +
          `T2=${(distribution['T2/closed'] ?? 0) + (distribution['T2/mismatch'] ?? 0)}` +
          `(closed=${distribution['T2/closed'] ?? 0}, mismatch=${distribution['T2/mismatch'] ?? 0})；` +
          `T3 candidate=${distribution['T3/candidate'] ?? 0}；` +
          `N/A=${distribution['N/A/not-applicable'] ?? 0}；总计=${full.length}`,
      );
    }

    const packageJson = JSON.parse(
      fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf-8'),
    ) as { scripts?: Record<string, unknown> };
    const reportScript = packageJson.scripts?.['lint:authz:report'];
    if (
      typeof reportScript === 'string' &&
      reportScript.includes('SRVF_AUTHZ_R8_REPORT=1') &&
      reportScript.includes('eslint')
    ) {
      passed++;
      console.log('✓ R8 report 接线:lint:authz:report 显式开启 warning 扫描，不污染普通 lint');
    } else {
      failures.push(
        '✗ R8 report 接线缺失 —— package.json 必须提供 lint:authz:report，' +
          '以 SRVF_AUTHZ_R8_REPORT=1 运行 eslint；普通 lint 的 --max-warnings=0 不能承载 report-only 候选。',
      );
    }
  }

  // 覆盖率闭环:每条规则都必须至少被一个正向用例真实触发过。
  // 当前闭环数 = 16 条 no-restricted-syntax 选择器 + 6 条自定义规则 = 22。
  // 具体数值仍从 plugin 实时枚举，不手写第二份名单；R8 加入后若忘了正向探针，
  // 本段会直接把它列为 uncovered。
  //
  // ⚠️ 名单从 `srvfEslintPlugin.rules` **数出来**,不在这里手写第二份:
  //    手写一份就会出现「新增了第 N 条规则、忘了加进名单」⇒ 它从此没有阳性对照,
  //    而「写错了永远匹配不到」的自测输出与「防线完整」一模一样(INC-06 同源)。
  //    数出来之后,新增规则不补正向用例 = 本条当场红,不需要谁记得。
  const CUSTOM_RULES = Object.keys(srvfEslintPlugin.rules).map((name) => `srvf/${name}`);
  for (const literal of [
    CUSTOM,
    PARAM_ID,
    REALIAS,
    NEAR_FUTURE,
    AUDIENCE_IMPORT,
    AUTHZ_DECLARATION_CLOSURE,
  ]) {
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
        'no-nullable-is-optional': (await import('../eslint-rules/no-nullable-is-optional.mjs'))
          .noNullableIsOptional,
        'no-param-id-string': (await import('../eslint-rules/no-param-id-string.mjs'))
          .noParamIdString,
        'no-near-future-date': (await import('../eslint-rules/no-near-future-date.mjs'))
          .noNearFutureDate,
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

  // ── INC-18 判据期望值表:nearFutureDatesIn 是纯函数,时钟注入固定 today ────────
  // 不是断言「规则报了点什么」,是把 (today, 2090-01-01) 区间的每条边逐一钉死。
  // 时钟必须注入:判据表若依赖跑测当天,这段自测就成了它要抓的那种东西。
  {
    const { FAR_FUTURE_FLOOR, beijingTodayISO, nearFutureDatesIn } =
      (await import('../eslint-rules/no-near-future-date.mjs')) as {
        FAR_FUTURE_FLOOR: string;
        beijingTodayISO: (now?: Date) => string;
        nearFutureDatesIn: (text: string, todayISO: string) => string[];
      };
    const T = '2026-08-02';
    const table: ReadonlyArray<readonly [string, string, string[]]> = [
      ['today 本身排除(次日即史料,不制造随墙钟抖动的裁决)', "'2026-08-02'", []],
      ['today+1 命中(最短引信)', "'2026-08-03'", ['2026-08-03']],
      ['远未来地板 2090-01-01 排除(2099 平移惯例)', "'2090-01-01'", []],
      ['2089-12-31 命中(区间内最后一天)', "'2089-12-31'", ['2089-12-31']],
      ['假日期 2027-02-30 排除(Date.UTC 静默进位靠 round-trip 识破)', "'2027-02-30'", []],
      ['非闰年 2027-02-29 排除', "'2027-02-29'", []],
      ['闰年 2028-02-29 命中', "'2028-02-29'", ['2028-02-29']],
      [
        '重复去重且升序',
        "'2033-05-01' + '2031-01-02' + '2033-05-01'",
        ['2031-01-02', '2033-05-01'],
      ],
      ['长数字串里不误配(前后有数字即非独立日期)', "'12026-08-031'", []],
    ];
    let tableOk = true;
    for (const [tname, text, want] of table) {
      const got = nearFutureDatesIn(text, T);
      if (JSON.stringify(got) !== JSON.stringify(want)) {
        tableOk = false;
        failures.push(
          `✗ INC-18 判据表:${tname} —— 期望 ${JSON.stringify(want)},实际 ${JSON.stringify(got)}`,
        );
      }
    }
    if (FAR_FUTURE_FLOOR !== '2090-01-01') {
      tableOk = false;
      failures.push(`✗ INC-18 判据表:FAR_FUTURE_FLOOR 漂移为 ${FAR_FUTURE_FLOOR}`);
    }
    if (
      beijingTodayISO(new Date('2026-08-01T15:59:59.000Z')) !== '2026-08-01' ||
      beijingTodayISO(new Date('2026-08-01T16:00:00.000Z')) !== '2026-08-02'
    ) {
      tableOk = false;
      failures.push('✗ INC-18 判据表:beijingTodayISO 北京日界漂移(UTC 16:00 应翻日)');
    }
    if (tableOk) {
      passed++;
      console.log(`✓ INC-18 判据期望值表:${table.length} 条边界 + 地板常量 + 北京日界`);
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
      [
        '混在别的规则里夹带 srvf/',
        ' eslint-disable-next-line no-restricted-syntax, srvf/no-param-id-string',
      ],
      ['带 -- 理由也照拦', ' eslint-disable-next-line srvf/no-param-id-string -- 有正当理由'],
      ['不具名(文件级)—— 它把 srvf/ 一并关掉,只是没写名字', ' eslint-disable '],
      ['不具名(行级)', ' eslint-disable-next-line'],
      ['不具名 + 理由', ' eslint-disable-next-line -- 就想关掉'],
    ];
    const NEGATIVE: ReadonlyArray<readonly [string, string]> = [
      [
        '具名关非 srvf/ 规则(AGENTS §1 明文允许的硬删豁免)',
        ' eslint-disable-next-line no-restricted-syntax -- 关联表物理清理',
      ],
      [
        '具名关 @typescript-eslint 规则',
        ' eslint-disable-next-line @typescript-eslint/no-unused-vars',
      ],
      ['只是提到这个词的普通注释', ' 见上文关于 eslint-disable 的说明'],
      [
        '指令不在注释开头 ⇒ eslint 自己也不认',
        ' prettier-ignore eslint-disable srvf/no-param-id-string',
      ],
      ['eslint-enable 不是 disable', ' eslint-enable srvf/no-param-id-string'],
      ['前缀相同但不是指令', ' eslint-disabled-by-design srvf/no-param-id-string'],
    ];
    // R4:规则配置注释的合成对照。判据带 Block/Line 这一维 —— 行注释里的同样文字
    // 对 ESLint 什么都不做,报它是误杀。
    const CONFIG_POSITIVE: ReadonlyArray<readonly [string, string]> = [
      ['具名关 srvf/ 规则', ' eslint srvf/no-param-id-string: "off" '],
      ['数字 0 形态', ' eslint srvf/no-nullable-is-optional: 0 '],
      ['数组形态', ' eslint srvf/no-decorator-realias: ["off"] '],
      ['关第 18 条那一族', ' eslint no-restricted-syntax: "off" '],
      ['降级成 warn —— 同样是改判据,不只是关掉', ' eslint srvf/no-param-id-string: "warn" '],
      ['不留空格紧贴定界符', 'eslint srvf/no-param-id-string:"off"'],
      ['夹在别的规则里', ' eslint no-console: "off", srvf/no-param-id-string: "off" '],
    ];
    const CONFIG_NEGATIVE: ReadonlyArray<readonly [string, string, string]> = [
      ['行注释里的同样文字 ⇒ ESLint 自己也不认', 'Line', ' eslint srvf/no-param-id-string: "off"'],
      ['eslint-enable 不是配置注释', 'Block', ' eslint-enable srvf/no-param-id-string'],
      ['eslint-disable 归 R2 不归 R4(避免同一条被两处判)', 'Block', ' eslint-disable '],
      ['eslint-env 是别的指令', 'Block', ' eslint-env node '],
      ['以 eslint 开头的散文(全仓唯一一处,且是行注释)', 'Line', ' eslint 的「描述分隔符」是 `--`'],
      ['普通散文提到这个词', 'Block', ' 见上文关于 eslint 的说明'],
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
    for (const [name, comment] of CONFIG_POSITIVE) {
      if (classifyRuleConfigComment('Block', comment) === null) {
        scannerOk = false;
        failures.push(
          `✗ R4 扫描器阳性对照失效 —— 「${name}」没被识别为规则配置注释:${comment.trim()}`,
        );
      }
    }
    for (const [name, type, comment] of CONFIG_NEGATIVE) {
      const verdict = classifyRuleConfigComment(type, comment);
      if (verdict !== null) {
        scannerOk = false;
        failures.push(
          `✗ R4 扫描器误杀 —— 「${name}」被判成 ${verdict}:${comment.trim()}\n` +
            '  误杀会逼下一个人来把整条扫描删掉,后果比漏放更久。',
        );
      }
    }
    // 预筛回归:R4 的注释里没有 "disable" 三个字,旧预筛(text.includes('eslint-disable'))
    // 会把整棵 AST 剪掉、判据永远匹配不到。这条钉住那个剪枝。
    const configInRealFile = scanFileForDisableEscapes(
      '<synthetic>',
      '/* eslint srvf/no-param-id-string: "off" */\nexport const x = 1;\n',
    );
    if (configInRealFile.length !== 1 || configInRealFile[0].kind !== 'rule-config') {
      scannerOk = false;
      failures.push(
        '✗ R4 扫描器端到端失效 —— 不含 "eslint-disable" 字样的规则配置注释没被抓到\n' +
          "  常见成因:scanFileForDisableEscapes 的便宜预筛还写着 `text.includes('eslint-disable')`。",
      );
    }
    // 报告口径的执行位:两套分类器**实际吐得出**的每一种 kind 都必须在标签表里有词条。
    // 本文件在 scripts/tsconfig.json 的 exclude 内(见该文件注释),Record 的穷尽性拿不到
    // typecheck 兜底 —— 所以这层必须是运行时断言,不能只靠类型。
    const emittedKinds = new Set<DisableEscape['kind']>(
      [
        ...POSITIVE.map(([, c]) => classifyDisableComment(c)),
        ...CONFIG_POSITIVE.map(([, c]) => classifyRuleConfigComment('Block', c)),
      ].filter((k): k is DisableEscape['kind'] => k !== null),
    );
    // 刻意放宽成「键可能缺失」的视图:Record 的类型保证在**本文件**拿不到 typecheck 兜底
    // (见 scripts/tsconfig.json 的 exclude),所以这里要的是真运行时查表,不是类型断言。
    const escapeKindLabels: Record<string, string | undefined> = ESCAPE_KIND_LABEL;
    for (const kind of emittedKinds) {
      if (escapeKindLabels[kind] === undefined) {
        scannerOk = false;
        failures.push(
          `✗ R2/R4 报告口径缺词条 —— kind='${kind}' 在 ESCAPE_KIND_LABEL 里没有标签。\n` +
            '  后果不是漏放而是**误报成别的种类**:抓得到,但报告把人送去改错的东西。',
        );
      }
    }
    if (scannerOk) {
      passed++;
      console.log(
        `✓ R2/R4 扫描器阳性对照:${POSITIVE.length + CONFIG_POSITIVE.length} 条逃生门全抓到、` +
          `${NEGATIVE.length + CONFIG_NEGATIVE.length} 条正当写法全放行、` +
          `${emittedKinds.size} 种命中各有报告标签`,
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
                `    ${e.file}:${e.line}  [${ESCAPE_KIND_LABEL[e.kind]}]\n` + `      ${e.text}`,
            )
            .join('\n') +
          '\n  srvf/ 三条规则是执法体,不接受行内关闭:能被违规者本人一行注释关掉的防线不是防线。\n' +
          '  规则配置注释(`/* eslint x: "off" *\/`,R4)同样拒 —— 它是与 disable 并列的第二种语法,\n' +
          '  能把规则关掉、也能把它降级成 warn,而两者都是在改判据本身。\n' +
          '  正确做法:把违规真的改掉;确属存量,走对应棘轮的具名基线(harness/ratchet-registry.json)。\n' +
          '  不具名 disable 同样拒 —— 它关掉的规则集合里就包含 srvf/,只是没写出名字。',
      );
    }
  }

  // ── R4:四组变异必须写进**真实文件**、跑**正式 lint 入口** + 同一条扫描链 ────
  //
  // 为什么不能只测纯函数:纯函数绿只证明「这个正则认得出这串字」,不证明
  //   ① 这串字在真实 lint 下**确实**能把规则关掉(缺口是真的,不是我想象的);
  //   ② 违规本身**确实**会被抓到(否则 RC=0 可能只是「压根没违规」——
  //      那样「带注释 RC=0」这条断言就成了自我实现的谎话);
  //   ③ 扫描在**真实文件**上抓得到(而不是只在合成字符串上)。
  // 三条各自独立,缺任何一条这段就退化成结构断言。
  {
    const repoRoot = path.resolve(__dirname, '..');
    const probeRel = 'src/__harness-rule-config-probe.controller.ts';
    const probeAbs = path.join(repoRoot, probeRel);
    // 两段探针体都必须是 prettier-clean 的:否则「带注释 RC=0」会被格式违规顶成 RC=1,
    // 断言测的就成了排版而不是逃生门。
    const paramBody =
      "import { Param } from '@nestjs/common';\n" +
      '\n' +
      'export class HarnessRuleConfigProbeController {\n' +
      "  m(@Param('id') id: string): string {\n" +
      '    return id;\n' +
      '  }\n' +
      '}\n';
    const wrapBody =
      'export class HarnessRuleConfigWrapProbe {\n' +
      '  m(): { code: number; message: string; data: number } {\n' +
      "    return { code: 0, message: 'ok', data: 1 };\n" +
      '  }\n' +
      '}\n';
    const MUTATIONS: ReadonlyArray<readonly [string, string, string, string]> = [
      [
        'R4-1 `: "off"`',
        '/* eslint srvf/no-param-id-string: "off" */\n',
        paramBody,
        PARAM_ID_STRING_MESSAGE,
      ],
      [
        'R4-2 `: 0`',
        '/* eslint srvf/no-param-id-string: 0 */\n',
        paramBody,
        PARAM_ID_STRING_MESSAGE,
      ],
      [
        'R4-3 `: ["off"]`',
        '/* eslint srvf/no-param-id-string: ["off"] */\n',
        paramBody,
        PARAM_ID_STRING_MESSAGE,
      ],
      [
        'R4-4 `no-restricted-syntax: "off"`',
        '/* eslint no-restricted-syntax: "off" */\n',
        wrapBody,
        HARNESS_SYNTAX['no-manual-response-wrap'].message,
      ],
    ];
    const runLint = (): { status: number | null; stdout: string } => {
      const r = spawnSync(
        path.join(repoRoot, 'node_modules/.bin/eslint'),
        ['--max-warnings', '0', '--format', 'json', probeRel],
        { cwd: repoRoot, encoding: 'utf-8' },
      );
      return { status: r.status, stdout: typeof r.stdout === 'string' ? r.stdout : '' };
    };
    let mutationsOk = true;
    for (const [name, directive, body, expectedMessage] of MUTATIONS) {
      try {
        // ① 带配置注释 ⇒ 正式 lint 放行(缺口实证)
        fs.writeFileSync(probeAbs, directive + body);
        const muted = runLint();
        // ③ 同一条扫描链在真实文件上抓到它
        const scanned = scanPathsForDisableEscapes(repoRoot, [probeRel]);
        // ② 去掉注释 ⇒ 同一份代码被真实 lint 抓到(证明违规是真的)
        fs.writeFileSync(probeAbs, body);
        const bare = runLint();

        if (bare.status === 0 || !bare.stdout.includes(expectedMessage)) {
          mutationsOk = false;
          failures.push(
            `✗ ${name} —— 去掉配置注释后正式 lint **没有**抓到违规(exit=${String(bare.status)})。\n` +
              '  含义:探针体本身不再违规(规则改了 / 探针写法漂移),于是「带注释 RC=0」\n' +
              '  这条断言变成自我实现的谎话 —— 它证明的不是逃生门,而是「本来就没东西可抓」。',
          );
        }
        if (muted.status !== 0) {
          // 缺口被关掉是**好消息**,但必须来把这段文字改掉,否则索引表开始说谎。
          mutationsOk = false;
          failures.push(
            `✗ ${name} —— 带配置注释时正式 lint 竟然报错了(exit=${String(muted.status)})。\n` +
              '  若这是因为 inline config 已被全局关掉:那是好消息,请同步改上面 R4 索引表\n' +
              '  的「修复前」列与本段断言,别让文档继续描述一个已不存在的缺口。',
          );
        }
        if (scanned.length !== 1 || scanned[0].kind !== 'rule-config') {
          mutationsOk = false;
          failures.push(
            `✗ ${name} —— 全仓同款扫描链在真实文件上**没抓到**规则配置注释` +
              `(命中 ${scanned.length} 条:${scanned.map((e) => e.kind).join(',') || '无'})。`,
          );
        }
      } finally {
        // 必须清掉:留在 src/ 会让 pnpm lint 永远红(响亮地坏,好过静默地坏)
        fs.rmSync(probeAbs, { force: true });
      }
    }
    if (mutationsOk) {
      passed++;
      console.log(
        `✓ R4 真触发:${MUTATIONS.length} 组规则配置注释变异在真实文件上` +
          '「正式 lint 全放行 / 去掉注释即红 / 扫描全抓到」',
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
