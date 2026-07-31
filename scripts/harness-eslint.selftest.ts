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
  {
    name: "@Param('id') 被禁(须走 IdParamDto)",
    filename: 'src/modules/x/x.controller.ts',
    code: "export class C { m(@Param('id') id: string) {} }",
    expect: SYNTAX,
  },
  {
    name: 'baseline 内的存量 controller 暂免 @Param(id)',
    filename: 'src/modules/content/content-admin.controller.ts',
    code: "export class C { m(@Param('id') id: string) {} }",
    expect: null,
  },

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

async function main(): Promise<void> {
  // 用**同一份**执法块(eslint.harness.mjs,主配置也 import 它),但换掉解析器设置:
  // 合成片段是虚拟路径,不在任何 tsconfig 项目里,类型感知解析会直接 parsing error
  // 而让规则根本跑不到(那样「全绿」毫无意义)。harness 规则全是语法级的,不需要类型信息。
  // overrideConfigFile: true = 完全不加载项目配置文件,只用下面这份。
  const {
    harnessConfigBlocks,
    HARNESS_SYNTAX,
    IS_OPTIONAL_NULL_BASELINE,
    NULLABLE_IS_OPTIONAL_MESSAGE,
    parseIsOptionalNullBaseline,
  } = (await import('../eslint.harness.mjs')) as {
    HARNESS_SYNTAX: Record<string, { message: string }>;
    harnessConfigBlocks: unknown[];
    IS_OPTIONAL_NULL_BASELINE: Map<string, readonly string[]>;
    NULLABLE_IS_OPTIONAL_MESSAGE: string;
    parseIsOptionalNullBaseline: (text: string) => Map<string, string[]>;
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
        m.ruleId === CUSTOM,
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
      if (m.ruleId === CUSTOM) {
        coveredSelectors.add(CUSTOM);
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
  // 闭环数 = 17 条 no-restricted-syntax 选择器 + 1 条自定义规则 = 18(第 18 条改成
  // 独立 ruleId 后**总数不变**,只是它不再从 HARNESS_SYNTAX 里数出来)。
  const allIds = [...Object.keys(HARNESS_SYNTAX), CUSTOM];
  const uncovered = allIds.filter((id) => !coveredSelectors.has(id));
  if (uncovered.length === 0) {
    passed++;
    console.log(
      `✓ 规则覆盖闭环:${allIds.length}/${allIds.length} 条均有正向用例真实触发` +
        `(${allIds.length - 1} 条 no-restricted-syntax 选择器 + 1 条自定义规则)`,
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
    const { srvfEslintPlugin } = (await import('../eslint-rules/no-nullable-is-optional.mjs')) as {
      srvfEslintPlugin: unknown;
    };
    const scanner = new ESLint({
      cwd: process.cwd(),
      overrideConfigFile: true,
      allowInlineConfig: false,
      overrideConfig: [
        {
          files: ['**/*.ts'],
          plugins: { '@typescript-eslint': tsPlugin as never, srvf: srvfEslintPlugin as never },
          languageOptions: {
            parser: tsParser as never,
            ecmaVersion: 'latest',
            sourceType: 'module',
          },
          // identityOnly:把上报文案换成身份串本身,自测据此直接拿到「类名.字段名」
          rules: { [CUSTOM]: ['error', { identityOnly: true }] },
        },
      ] as never,
    });
    const results = await scanner.lintFiles(['src/**/*.ts', 'test/**/*.ts', 'prisma/**/*.ts']);
    const repoRoot = path.resolve(__dirname, '..');

    // ⚠️ 刻意**不去重**:同一身份命中多次本身就是要抓的东西之一(见 accountRatchet ①)。
    const live = new Map<string, string[]>();
    for (const r of results) {
      const ids = r.messages.filter((m) => m.ruleId === CUSTOM).map((m) => m.message);
      if (ids.length === 0) continue;
      live.set(path.relative(repoRoot, r.filePath), ids);
    }

    const problems = accountRatchet(live, IS_OPTIONAL_NULL_BASELINE);
    const total = [...live.values()].reduce((n, ids) => n + ids.length, 0);
    if (problems.length === 0) {
      passed++;
      console.log(
        `✓ 第 18 条棘轮:基线与现状逐条一致(${total} 处 / ${live.size} 文件,身份全局唯一,只减不增)`,
      );
    } else {
      failures.push(
        `✗ 第 18 条棘轮 —— 基线与现状不一致:\n${problems.join('\n')}\n` +
          '  基线是「存量欠账清单」,不是许可证:修好一条就删一行,新增一条一律不许加行。\n' +
          '  改法见 harness/is-optional-null-baseline.json 顶部 _comment。',
      );
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
        parseIsOptionalNullBaseline(typeof doc === 'string' ? doc : JSON.stringify(doc));
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
      const parsed = parseIsOptionalNullBaseline(JSON.stringify(ok));
      if (parsed.get('src/a.dto.ts')?.[0] === 'A.b') {
        passed++;
        console.log('✓ M10 反向:合法基线文档正常加载(不是「什么都拒」)');
      } else {
        failures.push('✗ M10 反向 —— 合法文档解析结果不对');
      }
    } catch (err) {
      failures.push(`✗ M10 反向 —— 合法文档被拒:${String(err)}`);
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

  // 已知缺口单独成段:不混进「通过」的叙事。
  // 防线的边界必须和防线本身一样显眼 —— 否则「31 passed」会被读成「全都管住了」。
  if (knownGaps.length > 0) {
    console.log(`\n── 已知缺口:${knownGaps.length} 条对抗样例当前**可绕过**(不假装安全)──`);
    for (const g of knownGaps) console.log(`  ⚠ ${g}`);
    console.log(
      '  成因:no-restricted-syntax 匹配的是语法树的**字面形状**,不解析 import binding、\n' +
        '        不做变量指向分析。原写法拦得住,换个名字就拦不住。\n' +
        '  定性:AGENTS §1 已把该层表述为「**字面语法拦截**」而非「机器执法」。\n' +
        '  处置:自定义规则已在**第 18 条**落地并顺手关掉了它的别名缺口\n' +
        '        (srvf/no-nullable-is-optional 解析 import binding);上面 5 条仍是\n' +
        '        no-restricted-syntax 选择器,缺口原样存在,改写它们未立项。',
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
