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
/**
 * 已登记的 jest 测试根。**每加一个 jest 配置就是加一个测试根**,必须在这里登记并写清
 * 该根的闸位姿态 —— C6 用它比对真实目录,漏登即红。
 */
export const DECLARED_TEST_CONFIGS: Record<string, string> = {
  // 单元:不起 Nest、不连库 ⇒ 不经判闸位,无需姿态声明。
  'jest-unit.config.ts': 'unit —— 不起 Nest,无闸位姿态',
  // 契约快照:只比 OpenAPI 形状,不驱动写路径。
  'jest-contract.config.ts': 'contract —— 只比契约形状,不驱动写路径',
  // e2e:22 个走结算真相链的 spec 已逐个声明闸开;其余跑默认(闸关)。
  'jest-e2e.config.ts': 'e2e —— 22 个 spec 声明闸开,其余默认闸关',
  // 旅程金五条:独立 project,被 e2e 配置的 testPathIgnorePatterns **显式排除**
  // ⇒ 必须单独跑、单独复核。其中「考勤修正全链」走结算真相链,已声明闸开;另 4 条默认闸关。
  'jest-journeys.config.ts': 'journeys —— 考勤修正全链声明闸开,另 4 条默认闸关',
};

export const REVERSE_GATE_MARKERS = ['team-join', 'contribution-calculator'];

/** production-like 下空值即 fail-fast 的启动点(仓库内可见的两处)。 */
export const SMOKE_WORKFLOW_FILE = ['.github', 'workflows', 'docker-smoke.yml'].join('/');
export const ENV_EXAMPLE_FILE = '.env.example';

export type Finding = {
  criterion: 'C1' | 'C2' | 'C3' | 'C4' | 'C5' | 'C6' | 'C7';
  detail: string;
};

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
  /** C6:已登记的 jest 测试根数量。 */
  declaredTestRoots: number;
  /** C7:production-like 下空值即 fail-fast 的配置项数量。 */
  productionRequiredEnv: number;
};

/**
 * 跑全部四条判据。
 *
 * @param overrides 把 repo 相对路径映射成替换后的源码 —— 正对照专用。
 * @param declaredTestConfigs 覆盖 C6 的测试根清单 —— 正对照专用(真实目录不可变,只能从清单侧证伪)。
 */
export function runCriteria(
  overrides: Record<string, string> = {},
  declaredTestConfigs?: Record<string, string>,
): {
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
    declaredTestRoots: 0,
    productionRequiredEnv: 0,
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

  // ── C6:测试根清单 —— 防「整个目录从没被扫到」 ──
  //
  // 🔴 这条是**事故倒逼**加的,而且事故是 CI 撞出来的、判据没抓到:
  //    闸位落地后我按「跑一遍看谁红」来定哪些 spec 需要声明闸开侧,
  //    但扫描面只覆盖了 `test/e2e/` —— 而 `jest-e2e.config.ts` 的 testPathIgnorePatterns
  //    **显式排除** `test/journeys/`,它是独立 jest project(`pnpm test:journeys`)。
  //    于是金五条③那条走结算真相链的旅程整个没被考虑,直到 CI 红。
  //
  // C1–C5 全在 `src/**` 上判,**结构上看不见测试目录** —— 那是它们的盲区,不是疏忽。
  // 本条把「有没有哪个测试根没被纳入闸位姿态复核」变成静态可判:
  // 新增任何 jest 配置(= 新增一个测试根)都会红,逼加的人回答「这个根要不要声明闸位姿态」。
  //
  // 注意它守的是**清单完整性**,不是「每个 spec 姿态正确」—— 后者只有真跑才知道
  // (翻转对照:把声明设成相反值重跑,看是不是真因 20153 而红)。
  const actualConfigs = readdirSync(join(REPO_ROOT, 'test')).filter(
    (f) => f.startsWith('jest-') && f.endsWith('.config.ts'),
  );
  const declaredConfigs = declaredTestConfigs ?? DECLARED_TEST_CONFIGS;
  counts.declaredTestRoots = Object.keys(declaredConfigs).length;
  for (const cfg of actualConfigs) {
    if (!(cfg in declaredConfigs)) {
      findings.push({
        criterion: 'C6',
        detail: `test/${cfg} 是一个未登记的测试根 —— 闸位姿态复核从没覆盖过它。请跑一遍该 project 确认哪些 spec 需要声明闸开侧,再登记进 DECLARED_TEST_CONFIGS。(本仓栽过:test/journeys/ 被 e2e 配置显式排除,整条走结算真相链的旅程直到 CI 才红。)`,
      });
    }
  }
  for (const declared of Object.keys(declaredConfigs)) {
    if (!actualConfigs.includes(declared)) {
      findings.push({
        criterion: 'C6',
        detail: `test/${declared} 已登记但不存在 —— 清单与真源脱节,请更新 DECLARED_TEST_CONFIGS。`,
      });
    }
  }

  // ── C7:production-like 启动点必须显式设置每一个 fail-fast 配置项 ──
  //
  // 🔴 又一次**判据定义域之外**的缺口(与 C6 同源,两次都是 CI 撞出来的):
  //    本刀的配置项照 P3 范式在 production / smoke 下**空值抛错拒启**(这是对的),
  //    但 smoke workflow 一处也没设它 ⇒ 容器起不来,报的还是「App not ready after 60s」
  //    —— **完全不提是哪个 env 缺了**。(本仓教训:闸的失败消息说错方向比不说更费人。)
  //
  // 必填清单**从 app.config.ts 反推**,不手写:凡是被 `isProductionLike(env)` 或
  // `env === 'production'` 守着的 `throw`,其消息里点名的 env 变量即为必填;
  // 再与 `process.env.X` 实读取交集,滤掉消息里的枚举值之类的假 token(如 JIT / STRICT)。
  //
  // ⚠️ 覆盖边界要说准,别夸大:本条只能守**仓库内**的 production-like 启动点 ——
  //    smoke workflow 的 `docker run`,以及字段权威源 `.env.example`
  //    (deployment.md 明确:生产用一份**不入仓、逐项审核**的 env-file)。
  //    **真实生产启动在维护者自己的环境里,判据结构上看不见。**
  const configText = readSource(join(SRC, 'config', 'app.config.ts'));
  const configAst = ts.createSourceFile(CONFIG_DEF_FILE, configText, ts.ScriptTarget.Latest, true);
  const thrownTokens = new Set<string>();
  const collectRequired = (node: ts.Node): void => {
    if (ts.isIfStatement(node)) {
      const cond = node.expression.getText(configAst);
      if (cond.includes('isProductionLike(') || cond.includes("env === 'production'")) {
        const scan = (n: ts.Node): void => {
          if (ts.isThrowStatement(n))
            for (const m of n.getText(configAst).matchAll(/[A-Z][A-Z0-9_]{4,}/g))
              thrownTokens.add(m[0]);
          ts.forEachChild(n, scan);
        };
        scan(node.thenStatement);
      }
    }
    ts.forEachChild(node, collectRequired);
  };
  ts.forEachChild(configAst, collectRequired);
  const requiredEnv = [...thrownTokens]
    .filter((t) => configText.includes(`process.env.${t}`))
    .sort();
  counts.productionRequiredEnv = requiredEnv.length;

  const smokeText =
    overrides[SMOKE_WORKFLOW_FILE] ?? readFileSync(join(REPO_ROOT, SMOKE_WORKFLOW_FILE), 'utf8');
  const envExampleText =
    overrides[ENV_EXAMPLE_FILE] ?? readFileSync(join(REPO_ROOT, ENV_EXAMPLE_FILE), 'utf8');
  // production-like 启动块数 = `APP_ENV=production` 注入次数;每个必填项都要在每块里设。
  const startupBlocks = (smokeText.match(/-e APP_ENV=production/g) ?? []).length;

  for (const name of requiredEnv) {
    const inSmoke = (smokeText.match(new RegExp(`-e ${name}=`, 'g')) ?? []).length;
    if (startupBlocks > 0 && inSmoke < startupBlocks) {
      findings.push({
        criterion: 'C7',
        detail: `${name} 在 production-like 下空值即拒启,但 ${SMOKE_WORKFLOW_FILE} 的 ${startupBlocks} 个启动块里只设了 ${inSmoke} 处 —— 容器会起不来,且报错只说「App not ready」不点名是谁缺了。`,
      });
    }
    if (!new RegExp(`^${name}=`, 'm').test(envExampleText)) {
      findings.push({
        criterion: 'C7',
        detail: `${name} 在 production-like 下空值即拒启,却不在 ${ENV_EXAMPLE_FILE} 里 —— 而 deployment.md 明确以它为字段权威源,维护者照它做生产 env-file 会漏掉这一项、容器起不来。`,
      });
    }
  }

  // ── C7-b:测试里**自己组装 production-like 配置**的地方,同样要设满必填项 ──
  //
  // 第三次现形(前两次:测试根、运行时 env)。`insurance-config-fail-fast` 为了验
  // 「production 下空值拒启」会自建一份 production 环境;新增一个必填项后,
  // 它**先撞上新项**才走到自己要断言的那一项 —— 断言指向的错都变了。
  //
  // 组装点**靠发现而不是硬编码**:凡 `test/**` 里把 APP_ENV 赋成 production / smoke 的文件
  // 都算。将来再冒出第 2 个这样的 spec,本条自动把它纳入看守,不需要有人记得来改清单。
  // 判定按「本文件设了」∪「.env.test 提供了」—— 后者是测试进程的既有底座。
  const envTestText = overrides['.env.test'] ?? readFileSync(join(REPO_ROOT, '.env.test'), 'utf8');
  const assemblers: string[] = [];
  const scanTestDir = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) scanTestDir(full);
      else if (full.endsWith('.ts')) {
        const rel_ = rel(full);
        const text = overrides[rel_] ?? readFileSync(full, 'utf8');
        if (/process\.env\.APP_ENV\s*=\s*'(production|smoke)'/.test(text)) assemblers.push(rel_);
      }
    }
  };
  scanTestDir(join(REPO_ROOT, 'test'));

  for (const assembler of assemblers) {
    const text = overrides[assembler] ?? readFileSync(join(REPO_ROOT, assembler), 'utf8');
    for (const name of requiredEnv) {
      const setHere = new RegExp(`process\\.env\\.${name}\\s*=`).test(text);
      const fromEnvTest = new RegExp(`^${name}=`, 'm').test(envTestText);
      if (!setHere && !fromEnvTest) {
        findings.push({
          criterion: 'C7',
          detail: `${assembler} 自建 production-like 配置,但既没设 ${name}、.env.test 也没提供 —— 装配会**先**因这一项抛错,该 spec 原本要断言的那个错根本走不到(断言指向的错被顶替)。`,
        });
      }
    }
  }

  return { findings, counts };
}
