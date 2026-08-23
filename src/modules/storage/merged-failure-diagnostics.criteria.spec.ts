import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';

import * as ts from 'typescript';

// P2-8(2026-08-23):「把不同失败原因合并成一句话」类闸 —— 执行位。
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

const ROOT = path.resolve(__dirname, '../../..');
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

type FailureKind = 'environment' | 'content' | 'neutral' | 'unclassified';

function classify(callee: string): FailureKind {
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

function listSurfaceFiles(): string[] {
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

function describeViolation(block: DiagnosticCatch): string {
  return (
    `${block.file}:${block.line}\n` +
    `    环境类失败:${block.environment.join(' / ') || '—'}\n` +
    `    内容类失败:${block.content.join(' / ') || '—'}\n` +
    `    却只抛一句:${block.thrown}\n` +
    `    ⇒ 这两类失败的下一步动作不同,必须拆成两个 try / 两句话。`
  );
}

// ============================================================================

const surfaceFiles = listSurfaceFiles();
const blocks = surfaceFiles.flatMap((file) =>
  scanSource(readFileSync(path.join(ROOT, file), 'utf8'), file),
);

// 内联样本:判据的正 / 反对照。**跟着判据一起活**,不靠某次手工变异的记忆。
const FIXTURE_MERGED = `
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

const FIXTURE_SPLIT = `
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

const FIXTURE_SINGLE_CAUSE = `
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

const FIXTURE_ERROR_CARRIED = `
  function load(p: string) {
    try {
      return JSON.parse(readFileSync(p, 'utf8')) as unknown;
    } catch (error) {
      throw new BootstrapError('config-file 读取或解析失败', { cause: error });
    }
  }
`;

describe('merged failure diagnostics (storage module)', () => {
  // ==========================================================================
  // 自证:先证明仪器没瞎,再报数
  //
  // 「扫描面为空 ⇒ 零违规 ⇒ 全绿」是本仓已登记的假绿形状。下面用**地板锚点**
  // (至少多少 / 至少含谁),不写「恰好 N 条」—— 写死数量的自证会在下次加文件时
  // 过期,然后被人顺手改大,判据就此失去意义。
  // ==========================================================================

  it('scans a non-empty surface that includes the bootstrap file', () => {
    expect(surfaceFiles.length).toBeGreaterThanOrEqual(15);
    expect(surfaceFiles).toContain('src/modules/storage/storage-settings-bootstrap.ts');
    expect(surfaceFiles).toContain('src/modules/storage/upload-token.util.ts');
  });

  it('actually finds single-fixed-diagnostic catches to judge', () => {
    // 找不到任何在管辖内的 catch ⇒ 主断言恒绿。这条把那种失明钉死。
    expect(blocks.length).toBeGreaterThanOrEqual(4);
    expect(blocks.some((b) => b.file.endsWith('storage-settings-bootstrap.ts'))).toBe(true);
  });

  it('classifies the two vocabularies the judge depends on', () => {
    // 分类器认错了任何一边,主断言都会静默变绿。
    expect(classify('readFileSync')).toBe('environment');
    expect(classify('parse')).toBe('content');
    expect(classify('URL')).toBe('content');
    expect(classify('from')).toBe('content');
  });

  // ==========================================================================
  // ⭐ 正 / 反对照:判据自己的变异对拍,内联在闸里,不会随时间腐烂
  // ==========================================================================

  it('is RED on the pre-fix merged shape (positive control)', () => {
    const [merged] = scanSource(FIXTURE_MERGED, 'fixture-merged.ts');
    expect(merged).toBeDefined();
    expect(merged.environment).toEqual(['readFileSync']);
    expect(merged.content).toEqual(['parse']);
    expect(isMergedDiagnostic(merged)).toBe(true);
  });

  it('is GREEN once the two causes are split (the fix itself)', () => {
    const split = scanSource(FIXTURE_SPLIT, 'fixture-split.ts');
    expect(split).toHaveLength(2);
    expect(split.every((b) => !isMergedDiagnostic(b))).toBe(true);
  });

  it('is GREEN on a single-cause catch — the `new URL()` false-positive control', () => {
    // ⭐ 没有这一条,判据会把「只有一个失败原因」的 catch 一起误伤。
    //    台账点名 `new URL()` 那处形状相同但**不构成本缺陷**,它就是这条闸的反面样本。
    const [single] = scanSource(FIXTURE_SINGLE_CAUSE, 'fixture-single.ts');
    expect(single).toBeDefined();
    expect(single.environment).toEqual([]);
    expect(single.content).toEqual(['URL']);
    expect(isMergedDiagnostic(single)).toBe(false);
  });

  it('is GREEN when the catch carries the error (documented escape hatch)', () => {
    // 带上 cause ⇒ 原因没丢 ⇒ 不在管辖内。这是刻意留的门,不是漏判。
    expect(scanSource(FIXTURE_ERROR_CARRIED, 'fixture-carried.ts')).toHaveLength(0);
  });

  it('keeps the real `new URL()` site in jurisdiction and green', () => {
    // 反面样本不能靠「没扫到」蒙混过关 —— 必须证明它**被扫到了且判绿**。
    const urlSite = blocks.find(
      (b) => b.file.endsWith('storage-settings-bootstrap.ts') && b.content.includes('URL'),
    );
    expect(urlSite).toBeDefined();
    expect(isMergedDiagnostic(urlSite as DiagnosticCatch)).toBe(false);
  });

  // ==========================================================================
  // 主断言
  // ==========================================================================

  it('has no catch that merges an environment failure with a content failure', () => {
    const violations = blocks.filter(isMergedDiagnostic);
    expect(violations.map(describeViolation).join('\n\n')).toBe('');
  });

  it('leaves no failure source unclassified in multi-source catches', () => {
    // 词表不认识的调用不许静默放行 —— 那正是「至少一处」型判据失明的起点。
    // 只对 ≥2 个失败源的 catch 要求分类:单源 catch 无论如何都跨不了类。
    const gaps = blocks
      .filter((b) => b.callees.length >= 2 && b.unclassified.length > 0)
      .map((b) => `${b.file}:${b.line} 未分类:${b.unclassified.join(' / ')}`);
    expect(gaps.join('\n')).toBe('');
  });

  // ==========================================================================
  // 定点回归锚:P2-8 这处**具体**的修法不许被回退
  //
  // 上面的类闸管「不许合并」,这一条管「这处确实拆成了两句**不同**的话」——
  // 类闸对「拆开了但两句话写成一样」是失明的。
  // ==========================================================================

  it('reports read failure and parse failure as two different messages', () => {
    const bootstrap = blocks.filter((b) => b.file.endsWith('storage-settings-bootstrap.ts'));
    const readFailure = bootstrap.find((b) => b.environment.includes('readFileSync'));
    const parseFailure = bootstrap.find((b) => b.content.includes('parse'));

    expect(readFailure).toBeDefined();
    expect(parseFailure).toBeDefined();
    expect(readFailure).not.toBe(parseFailure);

    // 读失败那句必须指向**下一步动作**(查权限/属主/路径),不是只描述现象。
    expect((readFailure as DiagnosticCatch).thrown).toContain('无法读取 config-file');
    expect((readFailure as DiagnosticCatch).thrown).toContain('权限');
    expect((parseFailure as DiagnosticCatch).thrown).toContain('不是合法 JSON');
    expect((readFailure as DiagnosticCatch).thrown).not.toBe(
      (parseFailure as DiagnosticCatch).thrown,
    );
  });
});
