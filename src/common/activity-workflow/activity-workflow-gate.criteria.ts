/**
 * 活动 v1.1 单一 cutover gate 的**结构判据实现**(合同 §16.2 的执行位)。
 *
 * 合同红线:「不能拆成多个可独立开启的开关让同一实例进入『新打卡＋旧结算』混合状态。
 * 子能力可以有 UI 灰度,但业务真相切换必须单轨。」
 *
 * **光有一个布尔变量不构成执行位** —— 必须能证明三项受控面读的是同一个值、且没有写路径绕开它。
 * 本模块就是那个证明;断言与正对照在 activity-workflow-gate.criteria.spec.ts。
 *
 * 判据放在 `src/**` 的 spec 里而不是 `scripts/`,有两个理由:
 *   1. `scripts/**` 属执法层红区,新增守卫要维护者授权 + CI 环境审批;
 *   2. 更重要的是**接线**:unit 配置按 `src/.*\.spec\.ts` 自动收集,判据天然进
 *      `pnpm test` / `agent:check:quick` / CI。本仓栽过「命令写在 package.json 却没接 CI ⇒
 *      闸红了没人消费 = 没有执法」的账,这里不再造第二条需要单独接线的路。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import * as ts from 'typescript';

export const REPO_ROOT = join(__dirname, '..', '..', '..');
const SRC = join(REPO_ROOT, 'src');

export const CONFIG_DEF_FILE = 'src/config/app.config.ts';
export const GATE_FILE = 'src/common/activity-workflow/activity-workflow.gate.ts';
/**
 * 判据自身按构造必须**指名它所禁止的东西**,否则无从检查 —— 故 C1 豁免本文件。
 * 这不是逃生门:本文件不注入 config、拿不到运行时闸值,结构上不可能成为第二个读取处。
 */
const C1_EXEMPT = ['src/common/activity-workflow/activity-workflow-gate.criteria.ts'];

/** 结算真相链 —— 合同点名「新打卡＋旧结算」的两端都在这里。 */
export const V11_DELEGATES = [
  'attendancePunchEvent',
  'evidenceSeal',
  'participantServiceSegmentRevision',
  'attendanceSettlementRun',
  'attendanceSettlementVersion',
  'settlementReviewAction',
  'participantSettlementResultRevision',
  'ledgerPostingBatch',
  'participationLedgerEntry',
  'ledgerEntryReversalClaim',
  'attendanceCorrectionRequest',
  'activitySettlementClosureRevision',
] as const;

/** 旧考勤写路径 —— 合同 §16.2 第二项点名的 ActivityCheckIn / AttendanceSheet 链。 */
export const LEGACY_DELEGATES = ['activityCheckIn', 'attendanceSheet', 'attendanceRecord'] as const;

const WRITE_METHODS = new Set([
  'create',
  'createMany',
  'createManyAndReturn',
  'upsert',
  'update',
  'updateMany',
  'delete',
  'deleteMany',
]);

export const V11_ASSERT = 'assertV11WriteAllowed';
export const LEGACY_ASSERT = 'assertLegacyWriteAllowed';
export const READ_SOURCE = 'participationReadSource';

/** C4 反向闸的看守范围:这些文件承载「恒按 approved 算」的口径,不得随闸切换。 */
export const REVERSE_GATE_MARKERS = ['team-join', 'contribution-calculator'];

export type Finding = { criterion: 'C1' | 'C2' | 'C3' | 'C4' | 'C5'; detail: string };

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

function rel(f: string): string {
  return relative(REPO_ROOT, f).split('\\').join('/');
}

/**
 * 生产代码 = src 下排除 spec。判据只对生产代码执法 —— 测试里读配置、直插夹具都是正常的。
 * `overrides` 让正对照可以在**不落盘**的前提下把某个文件替换成变异版本,
 * 从而证明「判据真会红」,而不是只断言它当前是绿的。
 */
export function collectProdFiles(): string[] {
  return walk(SRC).filter((f) => !f.endsWith('.spec.ts'));
}

type MethodInfo = {
  name: string;
  isPublic: boolean;
  writesV11: boolean;
  writesLegacy: boolean;
  callsV11Assert: boolean;
  callsLegacyAssert: boolean;
  /** 同文件内被本方法调用的其它方法(this.foo(...))。 */
  calls: Set<string>;
};

function analyzeFile(fileName: string, text: string): Map<string, MethodInfo> {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const methods = new Map<string, MethodInfo>();

  const visitClass = (cls: ts.ClassDeclaration): void => {
    for (const member of cls.members) {
      if (!ts.isMethodDeclaration(member) || member.name === undefined) continue;
      const name = member.name.getText(source);
      const mods = ts.getModifiers(member) ?? [];
      const isPublic = !mods.some(
        (m) => m.kind === ts.SyntaxKind.PrivateKeyword || m.kind === ts.SyntaxKind.ProtectedKeyword,
      );
      const info: MethodInfo = {
        name,
        isPublic,
        writesV11: false,
        writesLegacy: false,
        callsV11Assert: false,
        callsLegacyAssert: false,
        calls: new Set(),
      };

      const scan = (node: ts.Node): void => {
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
          const callee = node.expression;
          const fnName = callee.name.getText(source);
          // <anything>.<delegate>.<writeMethod>(...)
          if (WRITE_METHODS.has(fnName) && ts.isPropertyAccessExpression(callee.expression)) {
            const delegate = callee.expression.name.getText(source);
            if ((V11_DELEGATES as readonly string[]).includes(delegate)) info.writesV11 = true;
            if ((LEGACY_DELEGATES as readonly string[]).includes(delegate))
              info.writesLegacy = true;
          }
          if (fnName === V11_ASSERT) info.callsV11Assert = true;
          if (fnName === LEGACY_ASSERT) info.callsLegacyAssert = true;
          // this.foo(...) —— 文件内调用图
          if (callee.expression.kind === ts.SyntaxKind.ThisKeyword) info.calls.add(fnName);
        }
        ts.forEachChild(node, scan);
      };
      if (member.body) ts.forEachChild(member.body, scan);
      methods.set(name, info);
    }
  };

  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node)) visitClass(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return methods;
}

/** 把「体内含受控写」沿文件内调用图向上传播到公开入口。 */
function propagate(methods: Map<string, MethodInfo>): void {
  for (let i = 0; i <= methods.size; i += 1) {
    let changed = false;
    for (const info of methods.values()) {
      for (const callee of info.calls) {
        const target = methods.get(callee);
        if (target === undefined) continue;
        if (target.writesV11 && !info.writesV11) {
          info.writesV11 = true;
          changed = true;
        }
        if (target.writesLegacy && !info.writesLegacy) {
          info.writesLegacy = true;
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
}

export type Counts = {
  v11GatedEntries: number;
  legacyGatedEntries: number;
  v11Files: number;
  legacyFiles: number;
  readFiles: number;
  /** C5:providers 里含受闸 service、因而必须 import 闸模块的模块数。 */
  gateDependentModules: number;
};

/**
 * 跑全部四条判据。
 *
 * @param overrides 把 repo 相对路径映射成替换后的源码 —— 正对照专用。
 */
export function runCriteria(overrides: Record<string, string> = {}): {
  findings: Finding[];
  counts: Counts;
} {
  const findings: Finding[] = [];
  const files = collectProdFiles();
  const readSource = (f: string): string => overrides[rel(f)] ?? readFileSync(f, 'utf8');

  // ── C1:单一真源 ──
  // 按 **AST 节点**判而不是裸文本:注释不是节点,故 biz-code 里「为什么这么设计」的说明
  // 不会误报;真正的读取(标识符 / 字符串字面量)一个也漏不掉。本仓栽过「结构断言 grep
  // 到了自己文件头的散文」,这里从判法上根除那一类假阳。
  for (const file of files) {
    const r = rel(file);
    if (r === CONFIG_DEF_FILE || r === GATE_FILE || C1_EXEMPT.includes(r)) continue;
    const source = ts.createSourceFile(r, readSource(file), ts.ScriptTarget.Latest, true);
    const hits = new Set<string>();
    const scanC1 = (node: ts.Node): void => {
      if (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) {
        const t = ts.isIdentifier(node) ? node.text : node.text;
        if (t === 'ACTIVITY_V11_WORKFLOW_ENABLED' || t === 'activityV11Workflow') hits.add(t);
      }
      ts.forEachChild(node, scanC1);
    };
    ts.forEachChild(source, scanC1);
    for (const token of hits) {
      findings.push({
        criterion: 'C1',
        detail: `${r} 直接引用了 ${token} —— 闸位只允许由 ${GATE_FILE} 读取;各读各的配置正是合同 §16.2 禁止的「拆成多个开关」。`,
      });
    }
  }

  // ── C2:无漏网写路径 ──
  const counts: Counts = {
    v11GatedEntries: 0,
    legacyGatedEntries: 0,
    v11Files: 0,
    legacyFiles: 0,
    readFiles: 0,
    gateDependentModules: 0,
  };
  for (const file of files) {
    const r = rel(file);
    if (r === GATE_FILE) continue;
    const text = readSource(file);
    const touchesAny = [...V11_DELEGATES, ...LEGACY_DELEGATES].some((d) => text.includes(`.${d}.`));
    if (!touchesAny) continue;

    const methods = analyzeFile(r, text);
    propagate(methods);

    for (const info of methods.values()) {
      if (!info.isPublic) continue;
      if (info.writesV11) {
        if (info.callsV11Assert) counts.v11GatedEntries += 1;
        else
          findings.push({
            criterion: 'C2',
            detail: `${r} 的公开入口 ${info.name}() 可达「结算真相链」写,却没有调 ${V11_ASSERT}() —— 闸关时这条写路径会绕过 cutover gate。`,
          });
      }
      if (info.writesLegacy) {
        if (info.callsLegacyAssert) counts.legacyGatedEntries += 1;
        else
          findings.push({
            criterion: 'C2',
            detail: `${r} 的公开入口 ${info.name}() 可达旧考勤写,却没有调 ${LEGACY_ASSERT}() —— 闸开时这条写路径会绕过 cutover gate。`,
          });
      }
    }
  }

  // ── C3:三项受控面确实在闸上 ──
  for (const file of files) {
    if (rel(file) === GATE_FILE) continue;
    const text = readSource(file);
    if (text.includes(`${V11_ASSERT}(`)) counts.v11Files += 1;
    if (text.includes(`${LEGACY_ASSERT}(`)) counts.legacyFiles += 1;
    if (text.includes(`${READ_SOURCE}(`)) counts.readFiles += 1;
  }
  if (counts.v11Files === 0)
    findings.push({
      criterion: 'C3',
      detail: `没有任何生产代码调用 ${V11_ASSERT}() —— 新写路径这一项没有接上闸。`,
    });
  if (counts.legacyFiles === 0)
    findings.push({
      criterion: 'C3',
      detail: `没有任何生产代码调用 ${LEGACY_ASSERT}() —— 旧写路径这一项没有接上闸。`,
    });
  if (counts.readFiles === 0)
    findings.push({
      criterion: 'C3',
      detail: `没有任何生产代码调用 ${READ_SOURCE}() —— 统计读面这一项没有接上闸。`,
    });

  // ── C5:受闸 service 所在模块必须能注入到闸 ──
  //
  // 🔴 这条守的是一整类**单测抓不到**的缺陷:漏 import 时所有 unit spec 照样全绿,
  //    只有真正起 Nest 的地方才会在 `createApplicationContext` 处炸。本仓实测踩到:
  //    两个 worker 进程各建独立 application context,`ActivityBatchWorkerModule` 的
  //    providers 里有账本 prepare / commit,却没 import 闸模块 ⇒ 整个 worker 起不来。
  //
  // 受闸 service 的清单**不硬编码**,而是从「谁调了闸」现场推出来 —— 将来给新 service
  // 接闸,它自动进入本条判据的看守范围,不需要有人记得来改清单。
  const gateDependentClasses = new Set<string>();
  for (const file of files) {
    const r = rel(file);
    if (r === GATE_FILE) continue;
    const text = readSource(file);
    if (
      !text.includes(`${V11_ASSERT}(`) &&
      !text.includes(`${LEGACY_ASSERT}(`) &&
      !text.includes(`${READ_SOURCE}(`)
    )
      continue;
    const src = ts.createSourceFile(r, text, ts.ScriptTarget.Latest, true);
    const collect = (node: ts.Node): void => {
      if (ts.isClassDeclaration(node) && node.name !== undefined)
        gateDependentClasses.add(node.name.text);
      ts.forEachChild(node, collect);
    };
    ts.forEachChild(src, collect);
  }

  for (const file of files) {
    const r = rel(file);
    if (!r.endsWith('.module.ts')) continue;
    const text = readSource(file);
    const src = ts.createSourceFile(r, text, ts.ScriptTarget.Latest, true);

    // 只看 @Module({ providers: [...] }) 里出现的标识符 —— 注释里提一嘴不算(app.module 就是这种)。
    const provided = new Set<string>();
    const scanModule = (node: ts.Node): void => {
      if (ts.isPropertyAssignment(node) && node.name.getText(src) === 'providers') {
        const ids = (n: ts.Node): void => {
          if (ts.isIdentifier(n)) provided.add(n.text);
          ts.forEachChild(n, ids);
        };
        ts.forEachChild(node.initializer, ids);
      }
      ts.forEachChild(node, scanModule);
    };
    ts.forEachChild(src, scanModule);

    const needsGate = [...provided].filter((n) => gateDependentClasses.has(n));
    if (needsGate.length === 0) continue;
    counts.gateDependentModules += 1;
    if (!text.includes('ActivityWorkflowModule')) {
      findings.push({
        criterion: 'C5',
        detail: `${r} 的 providers 含受闸 service(${needsGate.sort().join(', ')}),却没有 import ActivityWorkflowModule —— 该模块建出的注入图起不来(单测不会红,只有真起 Nest 才炸)。`,
      });
    }
  }

  // ── C4:反向闸(刻意的不一致) ──
  for (const file of files) {
    const r = rel(file);
    if (!REVERSE_GATE_MARKERS.some((g) => r.includes(g))) continue;
    const text = readSource(file);
    for (const token of [V11_ASSERT, LEGACY_ASSERT, READ_SOURCE, 'ActivityWorkflowGate']) {
      if (text.includes(token)) {
        findings.push({
          criterion: 'C4',
          detail: `${r} 引用了闸(${token})—— 维护者已拍板入队门槛与 computeCappedContribution 恒按 approved 算,不随 v1.1 闸切换;这条不一致是刻意的。`,
        });
      }
    }
  }

  return { findings, counts };
}
