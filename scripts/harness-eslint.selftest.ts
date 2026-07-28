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
  /** 期望命中的 ruleId;null = 期望零违规(合法样例 / baseline 豁免) */
  readonly expect: string | null;
  /** 期望命中次数(默认 ≥1) */
  readonly minCount?: number;
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
];

async function main(): Promise<void> {
  // 用**同一份**执法块(eslint.harness.mjs,主配置也 import 它),但换掉解析器设置:
  // 合成片段是虚拟路径,不在任何 tsconfig 项目里,类型感知解析会直接 parsing error
  // 而让规则根本跑不到(那样「全绿」毫无意义)。harness 规则全是语法级的,不需要类型信息。
  // overrideConfigFile: true = 完全不加载项目配置文件,只用下面这份。
  const { harnessConfigBlocks } = (await import('../eslint.harness.mjs')) as {
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

  for (const c of CASES) {
    const results = await eslint.lintText(c.code, { filePath: c.filename });
    const messages = results.flatMap((r) => r.messages);
    const harnessHits = messages.filter(
      (m) => m.ruleId === SYNTAX || m.ruleId === TS_IMPORTS || m.ruleId === CORE_IMPORTS,
    );

    if (c.expect === null) {
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

  for (const f of failures) console.error(f);
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    console.error(
      '\n⚠️ eslint 执法规则失效或误杀。常见原因:flat config 同 ruleId 后块整体覆盖前块' +
        '(见 eslint.config.mjs 内 harnessConfigBlocks 的排序注释),或 selector 写法漂移。',
    );
    process.exit(1);
  }
}

void main();
