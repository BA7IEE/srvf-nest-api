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
  // 自定义 ESLint 规则已拍板另立 goal,本批不做。
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

async function main(): Promise<void> {
  // 用**同一份**执法块(eslint.harness.mjs,主配置也 import 它),但换掉解析器设置:
  // 合成片段是虚拟路径,不在任何 tsconfig 项目里,类型感知解析会直接 parsing error
  // 而让规则根本跑不到(那样「全绿」毫无意义)。harness 规则全是语法级的,不需要类型信息。
  // overrideConfigFile: true = 完全不加载项目配置文件,只用下面这份。
  const { harnessConfigBlocks, HARNESS_SYNTAX } = (await import('../eslint.harness.mjs')) as {
    HARNESS_SYNTAX: Record<string, { message: string }>;
    harnessConfigBlocks: unknown[];
  };
  const eslint = new ESLint({
    cwd: process.cwd(),
    overrideConfigFile: true,
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
      (m) => m.ruleId === SYNTAX || m.ruleId === TS_IMPORTS || m.ruleId === CORE_IMPORTS,
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

  // 覆盖率闭环:每条选择器都必须至少被一个正向用例真实触发过
  const allIds = Object.keys(HARNESS_SYNTAX);
  const uncovered = allIds.filter((id) => !coveredSelectors.has(id));
  if (uncovered.length === 0) {
    passed++;
    console.log(`✓ 选择器覆盖闭环:${allIds.length}/${allIds.length} 条均有正向用例真实触发`);
  } else {
    failures.push(
      `✗ 选择器覆盖闭环 — ${uncovered.length} 条选择器没有任何正向用例:${uncovered.join(', ')}\n` +
        '  没有阳性对照的规则 = 写错了也永远不会有人知道(INC-06 就是这么静默失效的)。' +
        '请为每条新增选择器补一个「必定违规」的用例。',
    );
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

  // 已知缺口单独成段:不混进「通过」的叙事。
  // 防线的边界必须和防线本身一样显眼 —— 否则「31 passed」会被读成「全都管住了」。
  if (knownGaps.length > 0) {
    console.log(`\n── 已知缺口:${knownGaps.length} 条对抗样例当前**可绕过**(不假装安全)──`);
    for (const g of knownGaps) console.log(`  ⚠ ${g}`);
    console.log(
      '  成因:no-restricted-syntax 匹配的是语法树的**字面形状**,不解析 import binding、\n' +
        '        不做变量指向分析。原写法拦得住,换个名字就拦不住。\n' +
        '  定性:AGENTS §1 已把该层表述为「**字面语法拦截**」而非「机器执法」。\n' +
        '  处置:自定义 ESLint 规则(import binding resolution)已拍板另立 goal,本批不做。',
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
