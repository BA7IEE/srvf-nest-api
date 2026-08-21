/**
 * check-ops-required.ts —— 「生产必填项必须在部署 runbook 里有条目」类闸。
 *
 * ⚠️ 本文件在 `harness/redzone.json` 的 selfGuard 内(`scripts/check-*.ts`)。
 *    命名不是随意的:CI 跑的是 PR 分支上的守卫脚本,不锁住裁判,任何违规 PR 都可以
 *    顺手把它改成恒 PASS、检查名不变、CI 照绿。改名到 `check-*` 之外 = 自己摘掉保护。
 *
 * ──────────────────────────────────────────────────────────────────────────
 * 立项理由(第七轮评审包 F,F-01 + F-02)
 *
 * 实测:`app.config.ts` 在 production / smoke 下 fail-fast 必填 12 个环境变量,
 * 其中 **7 条**在两份部署 runbook 里一个字都没有;三个常驻 worker 类分布在
 * 2 个 worker 进程里,而两份 runbook **零提部署方式** —— 真机上因此从未部署过
 * worker(`docker ps -a` 只有 srvf-api / srvf-postgres)。
 *
 * 这两件事同形:**代码这边硬性要求,文档那边没有对应条目**,而唯一的发现方式
 * 是真机上撞一次(env 缺失撞 fail-fast,worker 缺失甚至不报错 —— 只是消息永远不发)。
 * 本仓铁律是「能做成机器检查的,就不要只写成文字要求」⇒ 把它变成一条判据。
 *
 * ──────────────────────────────────────────────────────────────────────────
 * 两条断言(**都动态发现,不写死名单**)
 *
 *   (a) 环境变量:凡 `app.config.ts` 在 production / smoke 守卫下 `throw` 点名的
 *       环境变量,**必须至少在一份部署 runbook 中出现**。
 *   (b) 常驻进程:凡 `package.json` 里形如 `start:*-worker` 的脚本,
 *       **必须至少在一份部署 runbook 中出现**。
 *
 * 🔴 为什么必须动态发现:写死 7 条名单的判据,下次新增第 13 个必填变量时**看不见它** ——
 *    那正是本刀要修的缺陷本身(文档漏一条,没有任何人会知道)。
 *
 * ──────────────────────────────────────────────────────────────────────────
 * 发现口径(a):为什么不是 grep 中文错误消息
 *
 * 起草 goal 用的探针是 `grep "X 不能为空"`。那是**措辞耦合** —— 下一条必填项写成
 * 「必须显式设置」就静默漏掉,判据全绿。本文件改用 typed-AST:
 *
 *   1. 解析 `src/config/app.config.ts`,遍历 AST,记录每个 `throw` 是否落在
 *      **production 守卫**的 then 分支内(守卫 = 条件里出现 `isProductionLike(`
 *      或 `env === 'production'` / `env === 'smoke'`;两种形状实测都在用)。
 *   2. 从守卫内 throw 的消息字面量里抽出 `SCREAMING_SNAKE` 形状的 token。
 *   3. 只保留**确实被当环境变量读**的 token —— 即 `src/` 里存在
 *      `process.env.<TOKEN>`。这一步是假阳性过滤器:消息里的 `JIT` / `STRICT`
 *      之类枚举值天然被形状规则挡掉,而万一有别的全大写常量混进来,
 *      「它得真的是个 env 读点」把它挡在门外。
 *
 * ⇒ 换措辞不影响发现;新增一条 production 必填项**自动进入扫描面**。
 *
 * ──────────────────────────────────────────────────────────────────────────
 * 仪器纪律:先自证再报数
 *
 * 空集恒等于空集会静默变绿 —— 采集器采到 0 条时判据必须红。本文件在报结论之前
 * 先自证扫描面非空,用**地板锚点**(≥N)而不是「恰 N 条」:后者每次新增必填项
 * 都要改判据,改判据的摩擦会诱导人把数字调大了事。
 *
 *   · 发现的 production 必填环境变量 >= MIN_REQUIRED_ENV_VARS
 *   · 发现的 worker 启动脚本         >= MIN_WORKER_SCRIPTS
 *   · 每份 runbook 都存在且非空
 *
 * 任何一条不满足 ⇒ 以「仪器失效」退出,**拒绝报结论**。
 *
 * ──────────────────────────────────────────────────────────────────────────
 * 跑法
 *
 *   pnpm ops:required:check                                  # 结论 + 退出码(CI 走这条)
 *   pnpm exec tsx scripts/check-ops-required.ts --json        # 机读输出
 *
 * 退出码:0 = 两条断言全过;1 = 有缺口,或仪器自证失败。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import * as ts from 'typescript';

const ROOT = path.resolve(__dirname, '..');

/** 必填项的事实源:production / smoke fail-fast 的唯一实现处。 */
const CONFIG_FILE = 'src/config/app.config.ts';
/** 常驻进程的事实源。 */
const PACKAGE_FILE = 'package.json';
/** 部署 runbook —— 「必填项该有条目」的落点。命中任意一份即算已登记。 */
const RUNBOOKS = [
  'docs/ops/server-deployment-runbook.md',
  'docs/ops/server-deployment-runbook-stage2.md',
] as const;

/**
 * 地板锚点(不是「恰 N 条」)。起草时实测:必填环境变量 12 条、worker 脚本 2 条。
 * 取略低于实测值的地板 —— 它要挡的是「扫描面塌成 0 / 塌掉一半」这种仪器失效,
 * 不是替代断言本身。真删掉一条必填项时应当改这里,那是该有的摩擦。
 */
const MIN_REQUIRED_ENV_VARS = 10;
const MIN_WORKER_SCRIPTS = 2;

/** `start:<name>-worker` —— 常驻 worker 进程的启动脚本命名约定。 */
const WORKER_SCRIPT_PATTERN = /^start:.*-worker$/;
/** SCREAMING_SNAKE:至少一个下划线,挡掉 `JIT` / `STRICT` / `CIDR` 这类裸枚举值。 */
const ENV_TOKEN_PATTERN = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g;

function read(relative: string): string {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8');
}

/** 条件表达式是不是「现在是 production / smoke」守卫。两种形状实测都在用。 */
function isProductionGuard(condition: ts.Expression): boolean {
  const text = condition.getText();
  if (text.includes('!')) return false; // 取反守卫的 then 分支是非生产,不算
  return (
    text.includes('isProductionLike(') ||
    /\benv\s*===\s*['"](?:production|smoke)['"]/.test(text)
  );
}

/**
 * 采集 production 守卫内 `throw` 点名的环境变量。
 *
 * 走 then 分支时把 `guarded` 置真并向下传递(嵌套 if 照样算);else 分支不继承 ——
 * 它是守卫的否定,那里的 throw 与 production 必填无关。
 */
function collectGuardedEnvTokens(source: ts.SourceFile): Set<string> {
  const tokens = new Set<string>();

  const visit = (node: ts.Node, guarded: boolean): void => {
    if (ts.isIfStatement(node)) {
      const nowGuarded = guarded || isProductionGuard(node.expression);
      visit(node.expression, guarded);
      visit(node.thenStatement, nowGuarded);
      if (node.elseStatement) visit(node.elseStatement, guarded);
      return;
    }
    if (guarded && ts.isThrowStatement(node)) {
      for (const match of node.getText().matchAll(ENV_TOKEN_PATTERN)) tokens.add(match[0]);
    }
    node.forEachChild((child) => visit(child, guarded));
  };

  visit(source, false);
  return tokens;
}

/** 假阳性过滤器:token 得真的是个环境变量读点(`src/` 里有 `process.env.<TOKEN>`)。 */
function buildEnvReadIndex(): Set<string> {
  const names = new Set<string>();
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.ts')) continue;
      const text = fs.readFileSync(full, 'utf8');
      for (const match of text.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) names.add(match[1]);
      for (const match of text.matchAll(/process\.env\[['"]([A-Z][A-Z0-9_]*)['"]\]/g))
        names.add(match[1]);
    }
  };
  walk(path.join(ROOT, 'src'));
  return names;
}

interface WorkerScript {
  /** package.json 里的脚本名,例如 `start:notification-outbox-worker`。 */
  script: string;
  /** 脚本命令里的构建物入口,例如 `dist/notification-outbox-worker`。 */
  entry: string | null;
}

function collectWorkerScripts(): WorkerScript[] {
  const pkg = JSON.parse(read(PACKAGE_FILE)) as { scripts?: Record<string, string> };
  return Object.entries(pkg.scripts ?? {})
    .filter(([name]) => WORKER_SCRIPT_PATTERN.test(name))
    .map(([script, command]) => ({
      script,
      entry: /(dist\/[A-Za-z0-9._-]+)/.exec(command)?.[1] ?? null,
    }))
    .sort((a, b) => a.script.localeCompare(b.script));
}

function main(): void {
  const asJson = process.argv.includes('--json');
  const runbooks = RUNBOOKS.map((relative) => ({ relative, text: read(relative) }));

  const envRead = buildEnvReadIndex();
  const requiredEnvVars = [...collectGuardedEnvTokens(
    ts.createSourceFile(CONFIG_FILE, read(CONFIG_FILE), ts.ScriptTarget.Latest, true),
  )]
    .filter((token) => envRead.has(token))
    .sort();
  const workerScripts = collectWorkerScripts();

  // ── 自证:先证明扫描面非空,再报结论 ──────────────────────────────────
  const instrumentFailures: string[] = [];
  if (requiredEnvVars.length < MIN_REQUIRED_ENV_VARS) {
    instrumentFailures.push(
      `production 必填环境变量只发现 ${requiredEnvVars.length} 条 (< 地板 ${MIN_REQUIRED_ENV_VARS}) —— ` +
        `扫描面塌了,${CONFIG_FILE} 的守卫形状可能已变`,
    );
  }
  if (workerScripts.length < MIN_WORKER_SCRIPTS) {
    instrumentFailures.push(
      `worker 启动脚本只发现 ${workerScripts.length} 条 (< 地板 ${MIN_WORKER_SCRIPTS}) —— ` +
        `${PACKAGE_FILE} 的 start:*-worker 命名约定可能已变`,
    );
  }
  for (const { relative, text } of runbooks) {
    if (text.trim().length === 0) instrumentFailures.push(`runbook 为空:${relative}`);
  }
  if (instrumentFailures.length > 0) {
    console.error('🔴 仪器失效 —— 拒绝报结论:');
    for (const failure of instrumentFailures) console.error(`  · ${failure}`);
    process.exit(1);
  }

  // ── 断言 ────────────────────────────────────────────────────────────
  const documented = (needle: string): string[] =>
    runbooks.filter(({ text }) => text.includes(needle)).map(({ relative }) => relative);

  const missingEnvVars = requiredEnvVars.filter((name) => documented(name).length === 0);
  const missingWorkers = workerScripts.filter(
    ({ script, entry }) =>
      documented(script).length === 0 && (entry === null || documented(entry).length === 0),
  );

  if (asJson) {
    console.log(
      JSON.stringify(
        { requiredEnvVars, workerScripts, missingEnvVars, missingWorkers },
        null,
        2,
      ),
    );
  } else {
    console.log(
      `扫描面:production / smoke 必填环境变量 ${requiredEnvVars.length} 条` +
        ` · worker 启动脚本 ${workerScripts.length} 条 · 部署 runbook ${runbooks.length} 份`,
    );
    if (missingEnvVars.length === 0 && missingWorkers.length === 0) {
      console.log('✓ 每一条必填环境变量与 worker 启动脚本都在部署 runbook 里有条目。');
    }
    for (const name of missingEnvVars) {
      console.error(
        `🔴 必填环境变量未登记:${name}` +
          `(${CONFIG_FILE} 在 production / smoke 下缺它即拒启,但两份部署 runbook 都没提)`,
      );
    }
    for (const { script, entry } of missingWorkers) {
      console.error(
        `🔴 常驻 worker 未登记:${script}` +
          `(部署 runbook 里既没有脚本名也没有${entry === null ? '构建物入口' : ` ${entry}`})`,
      );
    }
    if (missingEnvVars.length > 0 || missingWorkers.length > 0) {
      console.error(
        `\n补进这两份任意一份即可:${RUNBOOKS.join(' 或 ')}` +
          '\n(判据只核「有没有条目」,核不了「写得对不对」—— 那仍然要人读。)',
      );
    }
  }

  process.exit(missingEnvVars.length + missingWorkers.length === 0 ? 0 : 1);
}

main();
