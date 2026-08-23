/**
 * check-criteria-spec-purity.ts —— 「判据类闸的实质逻辑不得放在无保护的 spec 里」类闸。
 *
 * ⚠️ 本文件在 `harness/redzone.json` 的 selfGuard 内(`scripts/check-*.ts`)。
 *    这不是巧合,而是本闸存在的全部理由 —— 见下。
 *
 * ──────────────────────────────────────────────────────────────────────────
 * 立项理由:根因是**一条被推广过的范式**,不是谁写错了一次
 *
 * `src/**\/*.criteria.spec.ts` 这一族文件是近期各刀的**主交付物** —— 活动 v1.1
 * 单一切换闸、权限元数据决策锁、seed 单向权威、报名准入、复合锚点闭合、冻结稿
 * 台账、可写 DTO 扫描、合并失败原因。它们是「执行位」本身。
 *
 * 而 `src/**\/*.spec.ts` **不在 selfGuard**:实测八条全部 `harness:needs` 报
 * 「0 个需要授权」。⇒ 任何 PR 都能顺手把判据改成恒绿,零授权、零审批、零痕迹。
 *
 * 🔴 更要命的是,这个形态曾被当成**优点**推广:
 *
 *     「闸做成 criteria.spec + 非裁判命名 script,红区授权成本归零」
 *
 * 对判据类闸,「授权成本归零」恰恰是缺陷 —— 判据的价值就在于**改松它很麻烦**。
 *
 * ⭐ 正范式仓内本来就有,`scripts/check-permission-catalog-closure.ts` 头注逐字写着:
 * 「把实质逻辑放在受保护文件里,改松就必须动红区;spec 侧只做薄运行器」。
 * 本闸把那条正范式从「一份文件的自觉」升级成「机器执法的不变量」。
 *
 * ──────────────────────────────────────────────────────────────────────────
 * 修的是**缺陷类**不是实例
 *
 * 发现面是**结构性**的:扫 `src/` 下所有 `*.criteria.spec.ts`,不写死任何文件名。
 * 下一个人新建 `foo.criteria.spec.ts` 并把扫描逻辑写在里面时,本闸当场红并点名。
 *
 * 🔴 本闸自己也必须在 selfGuard 内 —— 否则「改松判据」这件事只是多绕一层:
 * 把本闸改成恒绿,八条判据立刻又回到无保护状态。递归的坑,只能靠落点堵。
 */
import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';

import * as ts from 'typescript';

const ROOT = path.resolve(__dirname, '..');

/** 判据类闸的命名约定 —— 发现面按后缀,不按文件名清单。 */
export const CRITERIA_SPEC_SUFFIX = '.criteria.spec.ts';

/** 扫描根。 */
export const SCAN_ROOT = 'src';

/**
 * 扫描面地板。低于它说明扫描面塌了(目录挪走 / 后缀改名 / 遍历写坏),
 * 而不是「仓库真的只剩这么几条判据」。
 *
 * ⚠️ 用地板(≥N)而不是「恰 N 条」:后者每加一条判据都要改数字,那份摩擦
 * 会诱导人把数字调大了事。同时它是一条**删除棘轮** —— 把判据整族删光
 * 会让扫描面塌到 0 ⇒ 本闸当场红,而不是「没有违规所以全绿」。
 */
export const MIN_CRITERIA_SPECS = 9;

/**
 * 禁止在判据 spec 里出现的**能力型 import**。
 *
 * 这是本闸最锋利的一条:一个薄运行器**永远不需要**读文件、遍历 AST、跑子进程。
 * 反过来,判据要自己算出结论就**必然**需要其中之一。⇒ 出现即证明「结论是在
 * 这个无保护文件里算出来的」,而不是从受保护的裁判那里 import 进来的。
 */
export const FORBIDDEN_MODULES = [
  'typescript',
  'node:fs',
  'fs',
  'node:fs/promises',
  'fs/promises',
  'node:path',
  'path',
  'node:os',
  'os',
  'node:child_process',
  'child_process',
  'node:crypto',
  'crypto',
  'glob',
  'fast-glob',
];

/**
 * 数字字面量的上限。0 / 1 是**结构性**取值(空 / 非空 / 恰一条),不是可调的旋钮;
 * ≥2 的字面量则是阈值或地板锚点 —— 那正是「把判据改松」最省事的下手处
 * (`toBeGreaterThan(80)` 改成 `toBeGreaterThan(2)`,diff 一个字符,没人看得见)。
 *
 * ⇒ 阈值必须以**具名常量**的形式住在受保护的裁判里,spec 只许引用名字。
 */
export const MAX_INLINE_NUMBER = 1;

/** 允许携带 block 体回调的测试框架钩子 —— 它们是 jest 的接线,不是判定逻辑。 */
export const TEST_CALLBACK_HOSTS = [
  'describe',
  'it',
  'test',
  'beforeAll',
  'beforeEach',
  'afterAll',
  'afterEach',
];

export interface PurityViolation {
  /** 相对仓库根的路径。 */
  file: string;
  /** 1-based 行号。 */
  line: number;
  /** 规则名(稳定标识,变异对拍按它比对)。 */
  rule: string;
  /** 人话说明 —— 直接告诉人「搬哪去」。 */
  detail: string;
}

export interface PurityReport {
  /** 扫到的判据 spec(相对路径,已排序)。 */
  scanned: string[];
  violations: PurityViolation[];
}

// ============================================================================
// 发现面:结构性遍历,不写死文件名
// ============================================================================

export function findCriteriaSpecs(root: string = ROOT): string[] {
  const out: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = path.posix.join(dir, entry.name);
      if (entry.isDirectory()) visit(rel);
      else if (entry.name.endsWith(CRITERIA_SPEC_SUFFIX)) out.push(rel);
    }
  };
  visit(SCAN_ROOT);
  return out.sort();
}

// ============================================================================
// 判定:typed-AST,不用正则
// ============================================================================

function isTestCallbackArgument(node: ts.Node): boolean {
  const parent = node.parent;
  if (parent === undefined || !ts.isCallExpression(parent)) return false;
  if (!parent.arguments.includes(node as ts.Expression)) return false;

  // `it(...)` / `describe.each(...)(...)` / `it.only(...)` 都要认。
  let callee: ts.Expression = parent.expression;
  while (ts.isCallExpression(callee)) callee = callee.expression;
  while (ts.isPropertyAccessExpression(callee)) callee = callee.expression;
  return ts.isIdentifier(callee) && TEST_CALLBACK_HOSTS.includes(callee.text);
}

export function analyzeSource(file: string, text: string): PurityViolation[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const violations: PurityViolation[] = [];

  const at = (node: ts.Node): number =>
    source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;

  const flag = (node: ts.Node, rule: string, detail: string): void => {
    violations.push({ file, line: at(node), rule, detail });
  };

  const visit = (node: ts.Node): void => {
    // ── R1 能力型 import ────────────────────────────────────────────────
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const spec = node.moduleSpecifier.text;
      if (FORBIDDEN_MODULES.includes(spec)) {
        flag(
          node,
          'capability-import',
          `判据 spec 不得 import '${spec}' —— 薄运行器不需要扫描 / 遍历 AST 的能力,` +
            `出现它就说明结论是在这个**无保护**文件里算出来的。` +
            `把扫描逻辑搬进 scripts/check-*.ts,spec 只 import 它导出的结论。`,
        );
      }
    }

    // ── R2 正则 ────────────────────────────────────────────────────────
    if (ts.isRegularExpressionLiteral(node)) {
      flag(
        node,
        'regex-literal',
        '判据 spec 不得含正则字面量 —— 正则就是判定口径本身,' +
          '改一个字符即可让判据放行。搬进 scripts/check-*.ts 并具名导出。',
      );
    }
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'RegExp') {
      flag(node, 'regex-literal', '判据 spec 不得 `new RegExp(...)`(同上,判定口径必须住在受保护文件里)。');
    }

    // ── R3 内联阈值 ────────────────────────────────────────────────────
    if (ts.isNumericLiteral(node) && Number(node.text) > MAX_INLINE_NUMBER) {
      flag(
        node,
        'inline-threshold',
        `判据 spec 不得含 ≥${MAX_INLINE_NUMBER + 1} 的数字字面量(此处 ${node.text})——` +
          '阈值 / 地板锚点是判据的强度旋钮,必须以具名常量住在 scripts/check-*.ts 里;' +
          'spec 只许写 `expect(x).toBeGreaterThanOrEqual(MIN_FOO)`。',
      );
    }

    // ── R4 控制流 ──────────────────────────────────────────────────────
    if (
      ts.isIfStatement(node) ||
      ts.isForStatement(node) ||
      ts.isForOfStatement(node) ||
      ts.isForInStatement(node) ||
      ts.isWhileStatement(node) ||
      ts.isDoStatement(node) ||
      ts.isSwitchStatement(node) ||
      ts.isTryStatement(node) ||
      ts.isThrowStatement(node) ||
      ts.isConditionalExpression(node)
    ) {
      flag(
        node,
        'control-flow',
        '判据 spec 不得含分支 / 循环 / try / throw —— 有分支就有「哪条路算红」的判定,' +
          '那是裁判的活。搬进 scripts/check-*.ts,让它返回一个已经算好的结论数组。',
      );
    }

    // ── R5 本地判定逻辑 ────────────────────────────────────────────────
    if (ts.isFunctionDeclaration(node)) {
      flag(
        node,
        'local-logic',
        '判据 spec 不得声明函数 —— 函数体里就是判定逻辑。搬进 scripts/check-*.ts 并具名导出。',
      );
    }
    if (
      (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
      node.body !== undefined &&
      ts.isBlock(node.body) &&
      !isTestCallbackArgument(node)
    ) {
      flag(
        node,
        'local-logic',
        '判据 spec 里只有 describe / it / before* / after* 的回调可以带 {} 函数体;' +
          '其余带块体的函数是判定逻辑,搬进 scripts/check-*.ts。',
      );
    }

    ts.forEachChild(node, visit);
  };

  visit(source);
  return violations.sort((a, b) => a.line - b.line || a.rule.localeCompare(b.rule));
}

export function analyzeCriteriaSpecPurity(root: string = ROOT): PurityReport {
  const scanned = findCriteriaSpecs(root);
  const violations: PurityViolation[] = [];
  for (const file of scanned) {
    violations.push(...analyzeSource(file, readFileSync(path.join(root, file), 'utf8')));
  }
  return { scanned, violations };
}

// ============================================================================
// 自证:先证明仪器没瞎,再报数
// ============================================================================

/**
 * 假阳性对照:**纯薄运行器**的标准形态。本闸若在这上面报违规,它就没法用了 ——
 * 会把正确形态也判成违规,逼着人把闸关掉。
 */
export const CONTROL_PURE_RUNNER = [
  "import { MIN_FOO, analyzeFoo, selfCheck } from '../../scripts/check-foo';",
  '',
  "describe('foo', () => {",
  '  const report = analyzeFoo();',
  '',
  "  it('self-proves', () => {",
  '    expect(selfCheck(report)).toEqual([]);',
  '    expect(report.scanned.length).toBeGreaterThanOrEqual(MIN_FOO);',
  '  });',
  '',
  "  it('has no violation', () => {",
  '    expect(report.violations.map((v) => v.file)).toEqual([]);',
  '  });',
  '});',
].join('\n');

/**
 * 真阳性对照:把判定逻辑写回 spec 的形态 —— 五条规则各命中一次。
 * 这一条是本闸「未来唯一要干的活」的样本。
 */
export const CONTROL_IMPURE_RUNNER = [
  "import { readFileSync } from 'node:fs';",
  '',
  'function scan(text) {',
  '  return text.split(/\\bTODO\\b/).length;',
  '}',
  '',
  "describe('foo', () => {",
  "  it('has no violation', () => {",
  "    const text = readFileSync('x', 'utf8');",
  '    if (scan(text) === 0) throw new Error("empty");',
  '    expect(scan(text)).toBeGreaterThan(80);',
  '  });',
  '});',
].join('\n');

/** 本闸命中的全部规则名 —— 变异对拍与自证按它比对。 */
export const ALL_RULES = [
  'capability-import',
  'control-flow',
  'inline-threshold',
  'local-logic',
  'regex-literal',
];

export function selfCheck(report: PurityReport): string[] {
  const problems: string[] = [];

  if (report.scanned.length < MIN_CRITERIA_SPECS) {
    problems.push(
      `扫描面塌了:只扫到 ${report.scanned.length} 个 ${CRITERIA_SPEC_SUFFIX},` +
        `地板是 ${MIN_CRITERIA_SPECS}。「判据失去输入 ≠ 通过」——` +
        '要么目录挪走了,要么后缀被改名绕开了本闸。',
    );
  }
  if (!report.scanned.every((f) => f.startsWith(`${SCAN_ROOT}/`))) {
    problems.push('扫描面越界:出现了不在 src/ 下的条目,遍历写坏了。');
  }

  // 仪器自检:两条对照必须一正一反。放在 selfCheck 里,`--check` 与 spec 都会跑到。
  const pure = analyzeSource('control-pure.criteria.spec.ts', CONTROL_PURE_RUNNER);
  if (pure.length > 0) {
    problems.push(
      `假阳性对照失败:纯薄运行器被判成违规(${pure.map((v) => v.rule).join(' / ')})——` +
        '本闸会把正确形态也报成违规,不可用。',
    );
  }
  const impure = analyzeSource('control-impure.criteria.spec.ts', CONTROL_IMPURE_RUNNER);
  const hit = [...new Set(impure.map((v) => v.rule))].sort();
  const missed = ALL_RULES.filter((r) => !hit.includes(r));
  if (missed.length > 0) {
    problems.push(`真阳性对照失败:这些规则一条都没命中 —— ${missed.join(' / ')}(规则被改瞎了)。`);
  }

  return problems;
}

// ============================================================================
// CLI
// ============================================================================

function main(): void {
  const report = analyzeCriteriaSpecPurity();
  const problems = selfCheck(report);

  for (const problem of problems) console.error(`🔴 自证失败:${problem}`);

  console.log(`扫描面:${report.scanned.length} 个 ${CRITERIA_SPEC_SUFFIX}`);
  for (const file of report.scanned) {
    const own = report.violations.filter((v) => v.file === file);
    console.log(`  ${own.length === 0 ? '✓' : '✗'} ${file}${own.length === 0 ? '' : ` (${own.length})`}`);
  }

  for (const v of report.violations) {
    console.error(`🔴 ${v.file}:${v.line} [${v.rule}] ${v.detail}`);
  }

  const broken = problems.length + report.violations.length;
  if (broken === 0) {
    console.log('✓ 判据 spec 全部是薄运行器 —— 实质逻辑都在 selfGuard 内。');
  } else {
    console.error(
      '\n修法:把扫描面定义 / 阈值 / 正则 / AST 遍历 / 分支搬进 `scripts/check-*.ts`' +
        '(在 selfGuard 内,改松要过红区人闸),spec 侧只留 `import` + `expect`。' +
        '\n⚠️ 不要把逻辑搬去 `scripts/` 下**别的名字** —— selfGuard 的 glob 钉在文件名上' +
        '(`check-*` / `generate-*` / `replay-*` / `*.selftest.*`),' +
        '\n   放成 `scripts/foo.ts` 一样是零保护(本仓已发生过:`scripts/frozen-drafts-ledger.ts`)。',
    );
  }
  process.exit(broken === 0 ? 0 : 1);
}

if (require.main === module) main();
