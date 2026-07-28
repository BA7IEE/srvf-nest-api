/**
 * generate-openapi.ts — 离线生成 docs/handoff/openapi.json(Harness 3.0 P4d)
 *
 * 取代 `curl http://localhost:3000/api/docs-json -o docs/handoff/openapi.json`。
 *
 * 为什么换掉 curl 版:
 *   契约文件是**前后端交接的字段真相**(见 docs/handoff/README.md),改契约必须同 PR
 *   刷新。但旧命令要求「先手动把服务器跑起来」,于是每次刷新都踩同一串坑:
 *     - :3000 被另一个 worktree 的旧 server 占着 → curl 到的是**别的分支的契约**,
 *       而且悄无声息(HTTP 200,JSON 合法)。这是最坏的一类:错误结果长得像正确结果。
 *     - 绕开的办法是临时改端口跑 :3005,于是"刷新契约"变成一套要背的口诀。
 *   本脚本在进程内建 Nest 应用、直接调 SwaggerModule.createDocument,**不监听任何端口**,
 *   因此不存在"连错服务器"这件事。
 *
 * 与真身的一致性:
 *   复用 src/bootstrap/apply-swagger.ts 的同一个 DocumentBuilder 配置 —— 不在本脚本里
 *   另抄一份 tag / version / bearer 设置(抄一份就是第二个真源,必然漂移)。
 *   做法是把 SwaggerModule.setup 的注册结果截获:applySwagger 内部先 createDocument
 *   再 setup,这里用同一份 app 实例走同一条路径,拿到 setup 时传入的 document。
 *
 * 依赖:需要能加载 AppModule(读 `.env`)。**不需要数据库连接**:
 *   `Test.createTestingModule(...).compile()` 只构建依赖图并构造 provider,
 *   **不调 `app.init()`** —— 而 `PrismaService` 是在 `onModuleInit` 里连库的,
 *   那个钩子只在 init 时跑。所以本命令能在 CI 的 fast job(无 Postgres)里跑。
 *
 *   曾试 `NestFactory.create(AppModule, { preview: true })`(官方的"只看图不实例化"模式),
 *   它在本仓解析不了依赖图:`SmsSettingsService` 的第 0 个构造参数在 preview 下为
 *   undefined 而直接抛 UndefinedDependencyException。留此记录以免下次再试一遍。
 *
 * 模式:
 *   (无参)    写入 docs/handoff/openapi.json
 *   --check   生成到内存并与磁盘逐字比对,不一致 exit 1(契约漂移门)
 *
 * ⚠️ 本文件在 harness/redzone.json selfGuard 内(scripts/generate-*.ts)。
 */

import * as fs from 'fs';
import * as path from 'path';
import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SwaggerModule } from '@nestjs/swagger';
import { Test } from '@nestjs/testing';
import type { AppConfig } from '../src/config/app.config';

// ⚠️ AppModule 必须**动态** import(见 buildDocument):ES import 会被提升到文件顶部,
// 那样 config 校验会在下面这些默认值写进 process.env 之前就跑,直接 fail-fast。

/**
 * 文档生成用的最小环境。本仓没有 `.env`(只有 `.env.example` 与 `.env.test`),
 * 而 config 层对缺失值是 fail-fast 的 —— 生成一份 OpenAPI 不该要求先配好一套真环境。
 *
 * 这些值**只在本进程内存在**、只为让 config 校验过关:全程零数据库连接
 * (不调 app.init(),PrismaService.onModuleInit 不跑),也零对外请求。
 * 已存在的同名环境变量一律不覆盖 —— 谁想用自己的环境生成,直接设好再跑即可。
 *
 * 刻意用一眼可辨的假值,避免任何"这看着像真凭据"的误会。
 */
const DOC_ENV: Record<string, string> = {
  APP_ENV: 'development',
  NODE_ENV: 'development',
  ENABLE_SWAGGER: 'true',
  DATABASE_URL: 'postgresql://openapi-generator:not-a-real-password@127.0.0.1:1/never-connected',
  JWT_SECRET: 'openapi-generator-placeholder-not-a-real-secret',
  APP_PORT: '3000',
  JWT_REFRESH_EXPIRES_IN: '7d',
  JWT_EXPIRES_IN: '15m',
};
for (const [k, v] of Object.entries(DOC_ENV)) if (!process.env[k]) process.env[k] = v;

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'docs', 'handoff', 'openapi.json');

/**
 * 截获 applySwagger 内部 createDocument 出来的那份 document。
 *
 * 不直接在这里 `SwaggerModule.createDocument(app, myConfig)` —— 那样就要在本文件里
 * 复制一份 DocumentBuilder 配置(标题 / 版本 / 30 多个 tag),变成第二个真源。
 * 改用打桩 SwaggerModule.setup:applySwagger 走完自己的流程后必然调它,
 * 第三个参数就是我们要的 document。
 */
function captureDocument(
  app: INestApplication,
  appCfg: AppConfig,
  applySwagger: (a: INestApplication, c: AppConfig) => void,
): object {
  const originalSetup = SwaggerModule.setup;
  let captured: object | null = null;
  try {
    (SwaggerModule as unknown as { setup: unknown }).setup = (
      _pathName: string,
      _app: INestApplication,
      doc: object,
    ): void => {
      captured = doc;
      // 刻意不转调 originalSetup:setup 会往 app 上挂 /docs 路由与静态资源,
      // 对"只想要 JSON"的场景是纯副作用。
    };
    applySwagger(app, appCfg);
  } finally {
    (SwaggerModule as unknown as { setup: unknown }).setup = originalSetup;
  }
  if (captured === null) {
    throw new Error(
      'applySwagger 未调用 SwaggerModule.setup —— 多半是 appCfg.swaggerEnabled=false。' +
        '请确认 .env 里 ENABLE_SWAGGER=true,或临时设 ENABLE_SWAGGER=true 再跑。',
    );
  }
  return captured;
}

async function buildDocument(): Promise<object> {
  // compile() 构造 provider 但不跑生命周期钩子;下面刻意**不调 app.init()**,
  // PrismaService 的 onModuleInit 因此不会执行 → 全程零数据库连接。
  const { AppModule } = await import('../src/app.module');
  const { applySwagger } = await import('../src/bootstrap/apply-swagger');
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  app.useLogger(false);
  try {
    // main.ts 里 setGlobalPrefix('/api') 影响 document 里所有 path,必须一致,
    // 否则生成出来的契约路径全少一层 /api,而且看不出错。
    app.setGlobalPrefix('api');

    const appCfg = app.get(ConfigService).get<AppConfig>('app');
    if (!appCfg) throw new Error('app.config 未加载,generate-openapi 中止');
    return captureDocument(app, { ...appCfg, swaggerEnabled: true }, applySwagger);
  } finally {
    await app.close();
  }
}

/** 与既有 openapi.json 相同的序列化形态(2 空格缩进 + 末尾换行)。 */
function serialize(doc: object): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

async function main(): Promise<void> {
  const check = process.argv.includes('--check');
  const next = serialize(await buildDocument());

  if (!check) {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    const prev = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
    fs.writeFileSync(OUT, next, 'utf8');
    console.log(
      prev === next
        ? 'docs/handoff/openapi.json 已是最新,无改动'
        : `docs/handoff/openapi.json 已更新(${prev.length} → ${next.length} 字符)`,
    );
    return;
  }

  if (!fs.existsSync(OUT)) {
    console.error('✗ docs/handoff/openapi.json 不存在 —— 跑 `pnpm docs:openapi` 生成');
    process.exit(1);
  }
  const prev = fs.readFileSync(OUT, 'utf8');
  if (prev === next) {
    console.log('✓ docs/handoff/openapi.json 与当前代码一致');
    return;
  }

  // 1.4MB 的 JSON 逐行 diff 没有可读性;报告"哪些路径变了"才是人能用的信息。
  const paths = (s: string): Set<string> => {
    try {
      return new Set(Object.keys((JSON.parse(s) as { paths?: object }).paths ?? {}));
    } catch {
      return new Set();
    }
  };
  const before = paths(prev);
  const after = paths(next);
  const added = [...after].filter((p) => !before.has(p));
  const removed = [...before].filter((p) => !after.has(p));

  console.error('✗ docs/handoff/openapi.json 与当前代码不一致 —— 跑 `pnpm docs:openapi` 刷新');
  console.error('  (改契约必须同 PR 更新交接文档 —— 见 docs/handoff/README.md 反漂铁律)\n');
  if (added.length) console.error(`  新增路径 ${added.length}:\n${added.map((p) => `    + ${p}`).join('\n')}`);
  if (removed.length)
    console.error(`  消失路径 ${removed.length}:\n${removed.map((p) => `    - ${p}`).join('\n')}`);
  if (!added.length && !removed.length)
    console.error('  路径集合相同,差异在 schema / 响应体内部(字段增删或类型变化)。');
  process.exit(1);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
