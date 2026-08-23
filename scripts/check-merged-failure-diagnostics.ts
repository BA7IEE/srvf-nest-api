import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';

import * as ts from 'typescript';

// P2-8(2026-08-23):「把不同失败原因合并成一句话」类闸 —— 执行位。
//
// ⚠️ 本文件在 `harness/redzone.json` 的 selfGuard 内(`scripts/check-*.ts`)。
//    判据逻辑刻意放在这里而不是 spec 里:spec(`src/**/*.spec.ts`)不在 selfGuard,
//    任何 PR 都能顺手改松它;把**实质逻辑**放在受保护文件里,改松就必须动红区。
//    spec 侧只做薄运行器(见 `src/modules/storage/merged-failure-diagnostics.criteria.spec.ts`)。
//
//    ⚠️ 本闸落地时(P2-8)曾在 changelog 里写明「判据放 spec 是为了省红区授权」——
//    **那条理由是错的**,同日已被 P2-13 订正:`scripts/**` 整个不进 ROUTE_AUTHZ 的
//    inputDigest,省授权是空好处;而 spec 不在 selfGuard,判据任何 PR 都能改松。
//
// ─── 这条闸修的是哪一类缺陷 ────────────────────────────────────────────────
// 一个 `try` 覆盖了两个**下一步动作不同**的失败原因,`catch` 却只抛一句话。
// 运维拿到的那句话指向错误的排查方向,时间就白付了。
//
// 实例(本闸立项的由来,2026-08-20 第二阶段真机部署实测):
//   `storage-settings-bootstrap.ts` 曾把 `readFileSync()` 与 `JSON.parse()` 放进同一个
//   `try`,统一抛「config-file 不是合法 JSON」。config-file 按安全要求设 600 root:root、
//   而 runner 镜像是 USER node(uid 1000)⇒ **EACCES 被报成 JSON 语法错误**。
//   维护者在服务器上用 `python3 -m json.tool` 验出 JSON 完全合法,照着错误信息白查一轮。
//   零运行时危害,但实付了一轮排查时间。
//
// ─── 判据不是「今天这处拆开了」,而是「合回去必须红」 ──────────────────────
// 所以发现面是**结构性扫 AST**,不写死行号、不点名函数:本模块内**任何**
// 「读环境 + 解内容」合用一个 catch 的新写法都会被抓。
//
// ─── ⭐ 扫描面是按实测读数定的,不是拍脑袋 ─────────────────────────────────
// 立项时对 `src/` 全仓(991 个 .ts)实测了三种判据形状,读数如下:
//
//   | 判据形状 | 全仓命中 | 能用吗 |
//   |---|---|---|
//   | 「一个 try 里有 ≥2 个调用」 | **131** | ❌ 粗到没有意义(链式调用、spec 里的 expect 全算) |
//   | 「+ catch 丢弃 error 且只抛一句固定话」 | **15** | ❌ 仍含大量**故意**合并的路径 |
//   | 「+ 跨『环境失败』与『内容失败』两类」 | 见下 | ✅ 本闸采用 |
//
// 那 15 处里的大多数是**故意**合并且合并是对的 —— `attendance-qr-token` /
// `attendance-member-credential-token` / `attendance-offline-package-token` /
// `identity-step-up` 都是**令牌校验路径**:那里把「base64 坏了」和「签名不对」
// 分开报,等于给攻击者送一个预言机。合并在那里是**安全特性,不是缺陷**。
// ⇒ 判据必须区分这两者,否则会把安全设计误报成缺陷。第三种形状做到了:
//    令牌路径的调用**全是内容类**(Buffer.from / toString / JSON.parse),不跨类 ⇒ 恒绿。
//
// ⚠️ **本闸刻意只管 `src/modules/storage/**`。** 全仓推广不在本刀范围内(A 档微刀,
//    goal §4 明确「不做全仓同形状重构」)。第三种形状在全仓仍会命中若干处 ——
//    例如 `local-activity-frontend-fixture.ts:1995`(fetch + new URL,网络与内容跨类)
//    与 attachments 的四处(DB 取数 + locator 映射)。**它们没有被本闸管住,这是已知敞口,
//    已如实登记在 `NEXT_TASKS.md` P2-8 条目里。** 想扩面的人:先按上表重测,别照抄结论。
//
// ─── 管辖边界(刻意留的逃生门,不是漏洞)────────────────────────────────
// `catch` 只要**用到了 error 本身**(`{ cause: err }` / 打日志 / 按 `err.code` 分支),
// 就不在管辖内 —— 原因没有丢失,运维拿得到真相,本缺陷类不成立。
// 逼所有 catch 都拆 try 会把这条闸变成噪音,那是判据失效的起点。

// ⚠️ 本文件从 `src/modules/storage/` 搬进 `scripts/` 时,这里的层级从三级变一级。
const ROOT = path.resolve(__dirname, '..');
const SURFACE_REL = 'src/modules/storage';

// ============================================================================
// 失败分类词表
//
// 分类依据是**下一步动作**,不是「会不会抛」:
//   environment —— 失败 ⇒ 去查权限 / 属主 / 路径 / 网络(东西没拿到)
//   content     —— 失败 ⇒ 去改内容(东西拿到了但不对)
//   neutral     —— 纯计算 / 结构调用,自己不构成一个需要单独文案的失败原因
//
// ⚠️ 词表按**调用名最后一段**匹配(`JSON.parse` → `parse`)。在一个模块的窄面上够用;
//    想扩面到全仓的人必须先把这条精度重估一遍(`parse` 也可能是 `path.parse`)。
// ============================================================================

const ENVIRONMENT_FAILURE_CALLEES = new Set([
  // node:fs —— 拿不到文件
  'readFileSync',
  'writeFileSync',
  'appendFileSync',
  'statSync',
  'lstatSync',
  'existsSync',
  'readdirSync',
  'mkdirSync',
  'rmSync',
  'rmdirSync',
  'unlinkSync',
  'openSync',
  'closeSync',
  'accessSync',
  'realpathSync',
  'copyFileSync',
  'renameSync',
  'chmodSync',
  'chownSync',
  'readFile',
  'writeFile',
  'appendFile',
  'readdir',
  'stat',
  'lstat',
  'access',
  'mkdir',
  'unlink',
  'rm',
  'copyFile',
  'rename',
  'chmod',
  'chown',
  'open',
  // 网络 —— 拿不到响应
  'fetch',
  'fetchImpl',
  'request',
]);

const CONTENT_FAILURE_CALLEES = new Set([
  // 解码 / 解析 —— 拿到了但内容不对
  'parse',
  'from',
  'toString',
  'URL',
  'URLSearchParams',
  'decodeURIComponent',
  'decodeURI',
  'base64urlDecode',
  'stringify',
]);

const NEUTRAL_CALLEES = new Set([
  // 纯计算 / 路径拼接 / 集合操作 —— 不构成独立的失败原因
  'resolve',
  'join',
  'cwd',
  'basename',
  'dirname',
  'extname',
  'normalize',
  'at',
  'sort',
  'map',
  'filter',
  'includes',
  'indexOf',
  'find',
  'some',
  'every',
  'values',
  'keys',
  'entries',
  'push',
  'slice',
  'split',
  'trim',
  'replace',
  'isArray',
  'isFile',
  'isDirectory',
  'test',
  'match',
  'concat',
  'startsWith',
  'endsWith',
  'padStart',
  'padEnd',
  'toLowerCase',
  'toUpperCase',
  'Set',
  'Map',
  'Error',
  'Number',
  'String',
  'Boolean',
  'Date',
]);

export type FailureKind = 'environment' | 'content' | 'neutral' | 'unclassified';

export function classify(callee: string): FailureKind {
  if (ENVIRONMENT_FAILURE_CALLEES.has(callee)) return 'environment';
  if (CONTENT_FAILURE_CALLEES.has(callee)) return 'content';
  if (NEUTRAL_CALLEES.has(callee)) return 'neutral';
  return 'unclassified';
}

// ============================================================================
// 扫描器
// ============================================================================

export interface DiagnosticCatch {
  readonly file: string;
  readonly line: number;
  /** `throw new X(...)` 里 `new X(...)` 的原文,用于报错时指认现场。 */
  readonly thrown: string;
  readonly callees: readonly string[];
  readonly environment: readonly string[];
  readonly content: readonly string[];
  readonly unclassified: readonly string[];
}

export function listSurfaceFiles(): string[] {
  const out: string[] = [];
  const visit = (rel: string): void => {
    for (const entry of readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
      const child = path.posix.join(rel, entry.name);
      if (entry.isDirectory()) visit(child);
      else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) out.push(child);
    }
  };
  visit(SURFACE_REL);
  return out.sort();
}

/**
 * 收集 try 块里的**失败源**:所有 call / new 表达式。
 *
 * ⚠️ **刻意不做「链式折叠」**(不把 `a().b()` 收成一个)。折叠会把
 *    `readFileSync(p).toString()` 里的 `readFileSync` 折没,环境类失败就此隐身 ——
 *    那正是本闸要抓的东西。宁可多分类几个名字,不能让被测的那一类消失。
 *
 * 不下钻两处:嵌套函数体(它的 throw 不归这个 catch 管)、嵌套 try(它自己有 handler)。
 */
function collectCallees(block: ts.Node, sf: ts.SourceFile): string[] {
  const names: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isClassExpression(node)
    )
      return;
    if (ts.isTryStatement(node)) return;
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      names.push(calleeName(node, sf));
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(block, visit);
  return names;
}

function calleeName(node: ts.CallExpression | ts.NewExpression, sf: ts.SourceFile): string {
  const expression = node.expression;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.getText(sf);
  if (ts.isIdentifier(expression)) return expression.getText(sf);
  return '<computed>';
}

/**
 * `catch` 是不是「丢弃 error + 只抛一句固定话」。
 *
 * 两个条件都必须成立才进管辖:
 *   (a) 没有绑定 error,或绑了但**一次都没引用** —— 引用了就说明原因被带走了;
 *   (b) 块体恰好一条语句,且是 `throw new X(...)` —— 多条语句 / 有分支 / 不抛,
 *       都说明它不是「合并成一句话」。
 */
function isSingleFixedDiagnostic(
  clause: ts.CatchClause,
  sf: ts.SourceFile,
): { ok: false } | { ok: true; thrown: string } {
  const bound = clause.variableDeclaration?.name;
  if (bound) {
    if (!ts.isIdentifier(bound)) return { ok: false };
    let referenced = false;
    const scan = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && node.text === bound.text && node !== bound) referenced = true;
      ts.forEachChild(node, scan);
    };
    scan(clause.block);
    if (referenced) return { ok: false };
  }
  const statements = clause.block.statements.filter((s) => !ts.isEmptyStatement(s));
  if (statements.length !== 1) return { ok: false };
  const only = statements[0];
  if (!ts.isThrowStatement(only)) return { ok: false };
  const thrown = only.expression;
  if (!thrown || !ts.isNewExpression(thrown)) return { ok: false };
  return { ok: true, thrown: thrown.getText(sf).replace(/\s+/g, ' ') };
}

export function scanSource(sourceText: string, file: string): DiagnosticCatch[] {
  const sf = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true);
  const found: DiagnosticCatch[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isTryStatement(node) && node.catchClause) {
      const shape = isSingleFixedDiagnostic(node.catchClause, sf);
      if (shape.ok) {
        const callees = collectCallees(node.tryBlock, sf);
        found.push({
          file,
          line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
          thrown: shape.thrown,
          callees,
          environment: callees.filter((c) => classify(c) === 'environment'),
          content: callees.filter((c) => classify(c) === 'content'),
          unclassified: callees.filter((c) => classify(c) === 'unclassified'),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);
  return found;
}

/** 违规 = 一个 catch 同时盖住了「环境类」与「内容类」两种失败。 */
export function isMergedDiagnostic(block: DiagnosticCatch): boolean {
  return block.environment.length > 0 && block.content.length > 0;
}

export function describeViolation(block: DiagnosticCatch): string {
  return (
    `${block.file}:${block.line}\n` +
    `    环境类失败:${block.environment.join(' / ') || '—'}\n` +
    `    内容类失败:${block.content.join(' / ') || '—'}\n` +
    `    却只抛一句:${block.thrown}\n` +
    `    ⇒ 这两类失败的下一步动作不同,必须拆成两个 try / 两句话。`
  );
}

// ============================================================================

export const surfaceFiles = listSurfaceFiles();
export const blocks = surfaceFiles.flatMap((file) =>
  scanSource(readFileSync(path.join(ROOT, file), 'utf8'), file),
);

// 内联样本:判据的正 / 反对照。**跟着判据一起活**,不靠某次手工变异的记忆。
export const FIXTURE_MERGED = `
  function load(p: string) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(p, 'utf8')) as unknown;
    } catch {
      throw new BootstrapError('config-file 不是合法 JSON');
    }
    return parsed;
  }
`;

export const FIXTURE_SPLIT = `
  function load(p: string) {
    let raw: string;
    try {
      raw = readFileSync(p, 'utf8');
    } catch {
      throw new BootstrapError('无法读取 config-file(检查权限 / 属主 / 路径)');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      throw new BootstrapError('config-file 不是合法 JSON');
    }
    return parsed;
  }
`;

export const FIXTURE_SINGLE_CAUSE = `
  function target(u: string) {
    let parsed: URL;
    try {
      parsed = new URL(u);
    } catch {
      throw new BootstrapError('databaseUrl 必须是合法 PostgreSQL URL');
    }
    return parsed;
  }
`;

export const FIXTURE_ERROR_CARRIED = `
  function load(p: string) {
    try {
      return JSON.parse(readFileSync(p, 'utf8')) as unknown;
    } catch (error) {
      throw new BootstrapError('config-file 读取或解析失败', { cause: error });
    }
  }
`;

// ============================================================================
// 地板锚点 + 结论
//
// 这些原先以字面量写在 `merged-failure-diagnostics.criteria.spec.ts` 里 ——
// 而 spec 不在 selfGuard,`toBeGreaterThanOrEqual(15)` 可以被任何 PR 改成 `(0)`,
// 零授权零痕迹。搬进受保护文件并具名。
// ============================================================================

/** 扫描面文件数地板。低于它说明目录挪走了 / 遍历写坏了。 */
export const MIN_SURFACE_FILES = 15;

/** 管辖内 catch 数地板。找不到任何在管辖内的 catch ⇒ 主断言恒绿。 */
export const MIN_JUDGED_CATCHES = 4;

/** 扫描面必须包含的具名文件(地板,不是全集)。 */
export const REQUIRED_SURFACE_FILES = [
  'src/modules/storage/storage-settings-bootstrap.ts',
  'src/modules/storage/upload-token.util.ts',
];

/** 分类器词表锚点:认错任何一边,主断言都会静默变绿。 */
export const CLASSIFIER_ANCHORS: [string, FailureKind][] = [
  ['readFileSync', 'environment'],
  ['parse', 'content'],
  ['URL', 'content'],
  ['from', 'content'],
];

export interface MergedDiagnosticsReport {
  surfaceFiles: string[];
  blocks: DiagnosticCatch[];
  /** 违规:一个 catch 同时盖住「环境类」与「内容类」。 */
  violations: string[];
  /** 词表不认识的调用(只对 ≥2 个失败源的 catch 要求分类)。 */
  classificationGaps: string[];
  /** 定点回归锚:P2-8 那处的两句话。 */
  bootstrapReadFailure?: DiagnosticCatch;
  bootstrapParseFailure?: DiagnosticCatch;
  /** 反面样本:真实的 `new URL()` 现场 —— 必须**被扫到且判绿**。 */
  realUrlSite?: DiagnosticCatch;
}

export function analyzeMergedDiagnostics(): MergedDiagnosticsReport {
  const bootstrap = blocks.filter((b) => b.file.endsWith('storage-settings-bootstrap.ts'));

  return {
    surfaceFiles,
    blocks,
    violations: blocks.filter(isMergedDiagnostic).map(describeViolation),
    // 词表不认识的调用不许静默放行 —— 那正是「至少一处」型判据失明的起点。
    // 只对 ≥2 个失败源的 catch 要求分类:单源 catch 无论如何都跨不了类。
    classificationGaps: blocks
      .filter((b) => b.callees.length >= 2 && b.unclassified.length > 0)
      .map((b) => `${b.file}:${b.line} 未分类:${b.unclassified.join(' / ')}`),
    bootstrapReadFailure: bootstrap.find((b) => b.environment.includes('readFileSync')),
    bootstrapParseFailure: bootstrap.find((b) => b.content.includes('parse')),
    realUrlSite: bootstrap.find((b) => b.content.includes('URL')),
  };
}

/**
 * 自证:先证明仪器没瞎,再报数。
 *
 * 「扫描面为空 ⇒ 零违规 ⇒ 全绿」是本仓已登记的假绿形状。全部用**地板锚点**
 * (至少多少 / 至少含谁),不写「恰好 N 条」—— 写死数量的自证会在下次加文件时
 * 过期,然后被人顺手改大,判据就此失去意义。
 *
 * ⭐ 四条内联样本的正 / 反对照也在这里跑:判据自己的变异对拍**跟着判据一起活**,
 * 不靠某次手工变异的记忆。
 */
export function selfCheck(report: MergedDiagnosticsReport): string[] {
  const problems: string[] = [];

  if (report.surfaceFiles.length < MIN_SURFACE_FILES) {
    problems.push(
      `扫描面塌了:只扫到 ${report.surfaceFiles.length} 个文件,地板是 ${MIN_SURFACE_FILES}。`,
    );
  }
  for (const required of REQUIRED_SURFACE_FILES) {
    if (!report.surfaceFiles.includes(required)) problems.push(`扫描面缺具名文件:${required}`);
  }
  if (report.blocks.length < MIN_JUDGED_CATCHES) {
    problems.push(
      `管辖内的 catch 只有 ${report.blocks.length} 个,地板是 ${MIN_JUDGED_CATCHES} —— 主断言会恒绿。`,
    );
  }
  if (!report.blocks.some((b) => b.file.endsWith('storage-settings-bootstrap.ts'))) {
    problems.push('bootstrap 文件里一个管辖内的 catch 都没扫到 —— 判据失明了。');
  }
  for (const [callee, expected] of CLASSIFIER_ANCHORS) {
    const actual = classify(callee);
    if (actual !== expected) {
      problems.push(`分类器认错了:${callee} 被判成 ${actual},应为 ${expected}。`);
    }
  }

  // ⭐ 正对照:修复前的合并形态必须红。
  const [merged] = scanSource(FIXTURE_MERGED, 'fixture-merged.ts');
  if (
    merged === undefined ||
    merged.environment.join() !== 'readFileSync' ||
    merged.content.join() !== 'parse' ||
    !isMergedDiagnostic(merged)
  ) {
    problems.push('正对照失败:修复前的「读 + 解」合并形态没被判红 —— 判据不会红了。');
  }

  // 反对照①:拆成两个 try 之后必须绿(修法本身)。
  const split = scanSource(FIXTURE_SPLIT, 'fixture-split.ts');
  if (split.length !== 2 || split.some(isMergedDiagnostic)) {
    problems.push('反对照失败:拆开后的正确形态仍被判红 —— 判据会把修法本身报成违规。');
  }

  // ⭐ 反对照②:单一失败原因的 catch 必须绿(`new URL()` 假阳性对照)。
  //    没有这一条,判据会把「只有一个失败原因」的 catch 一起误伤。
  const [single] = scanSource(FIXTURE_SINGLE_CAUSE, 'fixture-single.ts');
  if (
    single === undefined ||
    single.environment.length !== 0 ||
    single.content.join() !== 'URL' ||
    isMergedDiagnostic(single)
  ) {
    problems.push('假阳性对照失败:单一失败原因的 catch 被误判 —— 判据不可用。');
  }

  // 反对照③:catch 带上 error ⇒ 原因没丢 ⇒ 不在管辖内(刻意留的逃生门)。
  if (scanSource(FIXTURE_ERROR_CARRIED, 'fixture-carried.ts').length !== 0) {
    problems.push('逃生门失效:带 { cause: error } 的 catch 被拉进了管辖 —— 会逼所有 catch 拆 try。');
  }

  // 反面样本不能靠「没扫到」蒙混过关 —— 必须证明它**被扫到了且判绿**。
  if (report.realUrlSite === undefined) {
    problems.push('真实的 `new URL()` 现场没被扫到 —— 反面样本靠「没扫到」蒙混过关了。');
  } else if (isMergedDiagnostic(report.realUrlSite)) {
    problems.push('真实的 `new URL()` 现场被误判成违规。');
  }

  return problems;
}

/**
 * 定点回归锚:P2-8 这处**具体**的修法不许被回退。
 *
 * 类闸管「不许合并」,这一条管「这处确实拆成了两句**不同**的话」——
 * 类闸对「拆开了但两句话写成一样」是失明的。
 */
export function pinnedDiagnosticsRegressions(report: MergedDiagnosticsReport): string[] {
  const problems: string[] = [];
  const read = report.bootstrapReadFailure;
  const parse = report.bootstrapParseFailure;

  if (read === undefined) problems.push('bootstrap 里找不到「读失败」那个 catch。');
  if (parse === undefined) problems.push('bootstrap 里找不到「解析失败」那个 catch。');
  if (read === undefined || parse === undefined) return problems;

  if (read === parse) problems.push('读失败与解析失败又被合回同一个 catch 了。');
  // 读失败那句必须指向**下一步动作**(查权限/属主/路径),不是只描述现象。
  if (!read.thrown.includes('无法读取 config-file')) {
    problems.push(`读失败那句不再是「无法读取 config-file」:${read.thrown}`);
  }
  if (!read.thrown.includes('权限')) {
    problems.push(`读失败那句不再指向下一步动作(查权限 / 属主 / 路径):${read.thrown}`);
  }
  if (!parse.thrown.includes('不是合法 JSON')) {
    problems.push(`解析失败那句不再是「不是合法 JSON」:${parse.thrown}`);
  }
  if (read.thrown === parse.thrown) {
    problems.push('两句话写成一样了 —— 拆了 try 却没拆文案,等于没拆。');
  }

  return problems;
}

function main(): void {
  const report = analyzeMergedDiagnostics();
  const problems = [...selfCheck(report), ...pinnedDiagnosticsRegressions(report)];

  for (const problem of problems) console.error(`🔴 ${problem}`);
  for (const violation of report.violations) console.error(`🔴 合并了失败原因:\n${violation}`);
  for (const gap of report.classificationGaps) console.error(`🔴 ${gap}`);

  const broken = problems.length + report.violations.length + report.classificationGaps.length;
  if (broken === 0) {
    console.log(
      `✓ storage 模块内没有合并失败原因的 catch(扫描 ${report.surfaceFiles.length} 文件 / ` +
        `${report.blocks.length} 个管辖内 catch)。`,
    );
  }
  process.exit(broken === 0 ? 0 : 1);
}

if (require.main === module) main();
