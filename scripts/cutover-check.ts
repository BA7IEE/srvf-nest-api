/**
 * cutover-check.ts —— 活动 v1.1「切换前检查」(合同 §16.1 十条)的机器可核清单。
 *
 * ──────────────────────────────────────────────────────────────────────────
 * 立项理由
 *
 * 合同 §16.1 写死了开闸前的十条检查,但在本刀之前**没有任何一条是机器在核的** ——
 * 它们散落在四份合同、若干 goal 与 PR 描述里,只能靠人记得。本仓的铁律是
 * 「能做成机器检查的,就不要只写成文字要求」(维护者看不懂代码,无法当兜底审查者)。
 * 本脚本不让任何一条变绿,它只做一件事:**把「还差什么」变成一条命令可见**。
 *
 * ──────────────────────────────────────────────────────────────────────────
 * 三分型(本文件最重要的设计约束)
 *
 *   A 机器可判      能写成判据,跑一次给出真/假。**必须有正对照**(把输入弄假 ⇒ 判据必红)。
 *   B 机器可查、人判 机器只给证据,结论由人下。**不自称通过**。
 *   C 只能人判      机器无从判断,只说明「待维护者确认」+ 它需要什么证据。
 *
 * 🔴 最危险的做法是把 B/C 类做成 A 类(用一个恒真的断言假装它过了)。本仓栽过多次:
 *    「描述文本 ≠ 执行位」。因此本文件在结构上堵死这条路:
 *
 *      · 一条的分型 = 它所有子判据里**最弱**的那一类(A>B>C 取最弱)。
 *        有一件机器完全无从判断的事,整条的结论就只能由人下 —— 哪怕它另一半是硬判据。
 *      · `renderVerdict()` 只在 `kind === 'A'` 时才可能渲染成 ✅。
 *        B/C 恒渲染成「⏸ 待维护者确认」,**不许出现绿勾**。
 *      · 退出码只由 **A 类子判据**决定(无论它挂在哪一条下)。B/C 永不影响退出码 ——
 *        它们不是机器能判的,拿它们卡 CI 只会制造「永久红 ⇒ 没人看」。
 *
 * ──────────────────────────────────────────────────────────────────────────
 * 仪器纪律
 *
 * 本脚本**先自证再报数**(与 `scripts/probe-member-lock-scale.ts` 同一姿态):
 * 每跑一次 `cutover-check`,先把每条 A 类判据的输入弄假,确认它**真的会红**;
 * 任何一条正对照没按预期转红 ⇒ 立刻停止并以「仪器失效」退出,**拒绝报十行结论**。
 * 这样正对照就不是一次性的报告读数,而是每次使用时都在执法。
 *
 * 另外两条从本仓事故里抄来的:
 *   · `Tests: 0 total` = 套件没编译,**不是绿** ⇒ 验收套件判据要求 `total > 0`。
 *   · 计数不是装饰:采集器采到 0 条时判据必须红(空集恒等于空集会静默变绿)。
 *
 * ──────────────────────────────────────────────────────────────────────────
 * 跑法
 *
 *   pnpm cutover:check                              # 自证 + 十行结论(约 23s)
 *   pnpm cutover:check:selftest                     # 只跑正对照(秒级,不采数)
 *   pnpm exec tsx scripts/cutover-check.ts --json   # 机读输出
 *
 * 两条别名由维护者 2026-08-19 就 PR #1085 单独发令牌加入(package.json 在红区
 * ci-control-plane 内)。为什么是两条别名而不是让 `--selftest` 走 pnpm 参数透传:
 * 本仓有过「`pnpm test:contract -- -u` 传不进去」的教训,别名比透传可靠。
 *
 * ⚠️ 加了别名**不等于**本脚本进了执法层保护 —— 它不被任何 CI 检查链引用(见下「不接 CI」),
 *    故按 redzone 的收窄口径(「是不是裁判」)仍在自由区。**哪天把它接进 CI,同一个 PR 里
 *    必须同步把它写进 harness/redzone.json 的 selfGuard**;否则就成了「CI 依赖一个
 *    PR 可以随手改成恒 PASS 的裁判」—— 那正是该清单收窄当天被 ci-guard-coverage
 *    当场纠正过的那种判断错误。
 *
 * 退出码:0 = A 类判据全过(**不等于可以开闸** —— B/C 仍待维护者确认);
 *         1 = 有 A 类判据未过,或仪器自证失败。
 *
 * ⚠️ 本脚本**不接 CI**。十条里大半今天必不过(见 §16.1 现状),接了等于全仓永久红,
 *    而「闸红了没人消费 = 没有执法」是本仓已记录的事故形状。它是维护者开闸前手动跑的前置。
 */
import { execFileSync } from 'node:child_process';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { runCriteria } from './check-activity-workflow-gate';
import {
  parseActivityResponsibilityWorkflowEnabled,
  parseActivityV11WorkflowEnabled,
  parseAppEnv,
  parseInsuranceEnforcementEnabled,
} from '../src/config/app.config';

const ROOT = resolve(__dirname, '..');

const rel = (...p: string[]): string => join(ROOT, ...p);
const read = (p: string): string => readFileSync(rel(p), 'utf8');
const readOrNull = (p: string): string | null => (existsSync(rel(p)) ? read(p) : null);

// ── 常量:被检查的真源路径 ────────────────────────────────────────────────
const CONTRACT_DIR = 'docs/archive/reviews/activity-business-overhaul-v1.1';
const SHA256_MANIFEST = `${CONTRACT_DIR}/SRVF_活动业务文档_v1.1_SHA256.txt`;
const ACCEPTANCE_SPEC = 'src/modules/activities/activity-business-overhaul-acceptance.spec.ts';
const WORKER_SRC = 'src/modules/activities/activity-batch.worker.ts';
const SCHEMA = 'prisma/schema.prisma';
const CONFIG_SRC = 'src/config/app.config.ts';
const SWAGGER_SRC = 'src/bootstrap/apply-swagger.ts';
const OPENAPI_JSON = 'docs/handoff/openapi.json';

/**
 * ⑤-b 四端回执的落点 —— **登记制**,同 ⑦ 的 runbook:路径写死 = 判据与文档之间有一份合同,
 * 改名 / 删文件当场红,不会静默失去这道检查。
 */
const VERSION_REGISTRY = 'docs/handoff/contract-version-registry.md';

/**
 * 合同 §16.1 ⑤ **逐字点名**的五端。判据按这五个名字查行 —— 少一行必须看得见,
 * 否则「把填不出的那行删掉」就能把缺口洗成「零不一致」(空绿)。
 */
const CONTRACT_ENDS: readonly string[] = ['App', 'Admin', 'worker', '管理后台', '手机端'];

/** 登记表的两个哨兵值。用哨兵而不写版本号,免得登记表自己变成**第四处版本声明**。 */
const REGISTRY_SAME_AS_BACKEND = '同后端';
const REGISTRY_NOT_REPORTED = '未回执';

/**
 * ⑤-a 全仓扫描的白名单 —— 允许出现当前 contract version 字面量的**唯一**代码位置。
 *
 * 三处真源里只有这一处在 `.ts` 里(另两处不是 .ts,不在扫描面)。名单写死而不是
 * 「凡看着像真源的都放过」:放宽一次,第四处声明就能借同一个借口混进来。
 */
const VERSION_LITERAL_ALLOWLIST: readonly string[] = [SWAGGER_SRC];

/**
 * ⑤-a 扫描面:**只扫代码**。docs / CHANGELOG / 契约快照里出现版本号是正常的 ——
 * 那是「记述」不是「声明」,扫进来只会制造噪声,把判据淹成摆设。
 */
const VERSION_SCAN_DIRS: readonly string[] = ['src', 'scripts'];

/**
 * ⑦ 的运维 SOP 落点 —— **登记制**,不是「docs/ops 下随便哪份文件提到 worker 就算数」。
 * 写死路径的意义:判据与文档之间有一份合同,改名 = 当场红,不会静默失去这道检查。
 */
const WORKER_RUNBOOK = 'docs/ops/activity-batch-worker-runbook.md';

/** ⑦ 合同逐字要求 worker 具备的五要素;runbook 必须逐条成节。 */
const RUNBOOK_TOPICS: readonly { key: string; label: string; pattern: RegExp }[] = [
  { key: 'start', label: '启动命令', pattern: /^#{2,}.*启动命令/m },
  { key: 'health', label: '健康检查', pattern: /^#{2,}.*健康检查/m },
  { key: 'lease', label: 'lease(租约/围栏)', pattern: /^#{2,}.*lease/im },
  { key: 'drain', label: '停机排空', pattern: /^#{2,}.*停机排空/m },
  { key: 'recover', label: '恢复 SOP', pattern: /^#{2,}.*恢复/m },
];

/**
 * ④ 的对账命令 —— 与 `.github/workflows/ci.yml` 的 docs 守护行同一批,外加授权语义图。
 * 它们全是既有生成物的**新鲜度**判据:生成器重跑一遍与仓内产物逐字节比对,不一致即红。
 */
const RECONCILE_COMMANDS: readonly { cmd: string; covers: string }[] = [
  { cmd: 'docs:openapi:check', covers: '合同快照(openapi.json)' },
  { cmd: 'docs:authz:check', covers: '权限(ROUTE_AUTHZ 授权清单)' },
  { cmd: 'gate:authz:graph:check', covers: '权限(授权语义图)' },
  { cmd: 'docs:rbacmap:check', covers: '权限(RBAC map)' },
  { cmd: 'docs:feclient:check', covers: '合同快照(前端 client 生成物)' },
  { cmd: 'docs:codemap:check', covers: '结构生成物(CODEMAP)' },
  { cmd: 'docs:counts:check', covers: '文档计数生成物' },
  { cmd: 'docs:readtax:check', covers: '恒读层预算' },
];

/** ⑧ 合同点名的四个开关。前三个是 per-instance env,第四个刻意不是(见 judgeFlagsFailFast)。 */
const INSTANCE_FLAGS: readonly {
  env: string;
  label: string;
  parse: (raw: string | undefined, env: ReturnType<typeof parseAppEnv>) => boolean;
}[] = [
  {
    env: 'ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED',
    label: '责任闭环',
    parse: parseActivityResponsibilityWorkflowEnabled,
  },
  {
    env: 'INSURANCE_ENFORCEMENT_ENABLED',
    label: '保险严格模式',
    parse: parseInsuranceEnforcementEnabled,
  },
  {
    env: 'ACTIVITY_V11_WORKFLOW_ENABLED',
    label: '活动 v1.1',
    parse: parseActivityV11WorkflowEnabled,
  },
];

// ── 分型与结论 ──────────────────────────────────────────────────────────
export type Kind = 'A' | 'B' | 'C';
export type Verdict = 'pass' | 'fail' | 'pending';

export interface Judgement {
  readonly ok: boolean;
  readonly evidence: readonly string[];
}

export interface SubCheck {
  readonly id: string;
  readonly kind: Kind;
  readonly title: string;
  readonly verdict: Verdict;
  readonly evidence: readonly string[];
}

export interface ItemResult {
  readonly no: number;
  readonly text: string;
  readonly kind: Kind;
  readonly verdict: Verdict;
  readonly subs: readonly SubCheck[];
}

const KIND_RANK: Record<Kind, number> = { A: 0, B: 1, C: 2 };

/** 一条的分型 = 子判据里最弱的那一类。见文件头「三分型」。 */
export function weakestKind(subs: readonly { kind: Kind }[]): Kind {
  return subs.reduce<Kind>((worst, s) => (KIND_RANK[s.kind] > KIND_RANK[worst] ? s.kind : worst), 'A');
}

/**
 * 一条的结论。
 * `pass` 只在**全部子判据都是 A 且都过**时出现 —— 结构上堵死「把 B/C 渲染成绿勾」。
 */
export function itemVerdict(subs: readonly SubCheck[]): Verdict {
  if (subs.some((s) => s.kind === 'A' && s.verdict === 'fail')) return 'fail';
  if (subs.every((s) => s.kind === 'A' && s.verdict === 'pass')) return 'pass';
  return 'pending';
}

// ══════════════════════════════════════════════════════════════════════════
// A 类判据(纯函数)
//
// 全部写成「输入 → 判决」的纯函数,采集与判定分离。这样正对照可以在**不落盘**的前提下
// 把输入弄假,证明判据真会红 —— 而不是只断言它当前是绿的(「真触发 ≠ 结构断言」)。
// 采集器那一侧的失真由各判据自带的**非空断言**兜底(空集恒等于空集会静默变绿)。
// ══════════════════════════════════════════════════════════════════════════

/** ①-a 四份合同与入仓冻结的 SHA256 清单逐字节一致。 */
export function judgeContractIntegrity(
  manifestText: string,
  contents: Readonly<Record<string, string>>,
): Judgement {
  const rows = manifestText
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => {
      const m = /^([0-9a-f]{64})\s+(.+)$/.exec(l);
      return m === null ? null : { sha: m[1], file: m[2] };
    });
  if (rows.some((r) => r === null)) {
    return { ok: false, evidence: ['SHA256 清单有无法解析的行 ⇒ 判据失效,先修清单'] };
  }
  const parsed = rows as { sha: string; file: string }[];
  if (parsed.length === 0) return { ok: false, evidence: ['SHA256 清单为空 ⇒ 判据无从执法'] };

  const bad: string[] = [];
  for (const { sha, file } of parsed) {
    const body = contents[file];
    if (body === undefined) {
      bad.push(`${file}:清单登记了但仓内不存在`);
      continue;
    }
    const actual = createHash('sha256').update(body, 'utf8').digest('hex');
    if (actual !== sha) bad.push(`${file}:实际 ${actual.slice(0, 12)}… ≠ 清单 ${sha.slice(0, 12)}…`);
  }
  return bad.length === 0
    ? { ok: true, evidence: [`${parsed.length} 份合同逐字节与冻结清单一致`] }
    : { ok: false, evidence: bad };
}

/**
 * ③-a 旧 migration 未修改。
 *
 * 口径:以**合同入仓那一刻**(第 0 批,SHA256 清单落盘的提交)为基线,当时已存在的
 * migration 文件在 HEAD 上必须逐字节相同、且一个都不许消失。
 *
 * 为什么不是「全历史从未被改过」:实测全历史有 1 处 —— `20260701160000_org_supervision_assignments`
 * 在 2026-07-03 被 R13 化名化合规 PR(#485)改过,那是 v1.1 立项**之前**的事。
 * 拿全历史当口径会让这条永久红,而永久红的闸没人消费 = 没有执法。
 */
export function judgeOldMigrationsUnchanged(
  baseline: ReadonlyMap<string, string>,
  head: ReadonlyMap<string, string>,
): Judgement {
  if (baseline.size === 0) {
    return { ok: false, evidence: ['基线 migration 集为空 ⇒ 采集失真,判据无从执法'] };
  }
  const bad: string[] = [];
  for (const [path, sha] of baseline) {
    const now = head.get(path);
    if (now === undefined) bad.push(`${path}:基线存在,HEAD 已删除`);
    else if (now !== sha) bad.push(`${path}:内容已变(${sha.slice(0, 8)}… → ${now.slice(0, 8)}…)`);
  }
  const added = [...head.keys()].filter((p) => !baseline.has(p));
  return bad.length === 0
    ? {
        ok: true,
        evidence: [`基线 ${baseline.size} 个 migration 文件逐字节未变、未删;基线后新增 ${added.length} 个`],
      }
    : { ok: false, evidence: bad };
}

/** ④-a 生成物对账:既有 `--check` 家族全绿(生成器重跑与仓内产物逐字节比对)。 */
export function judgeReconcile(
  results: readonly { cmd: string; covers: string; code: number; tail: string }[],
): Judgement {
  if (results.length !== RECONCILE_COMMANDS.length) {
    return { ok: false, evidence: [`只跑到 ${results.length}/${RECONCILE_COMMANDS.length} 条对账命令 ⇒ 采集不全`] };
  }
  const bad = results.filter((r) => r.code !== 0);
  return bad.length === 0
    ? { ok: true, evidence: [`${results.length} 条生成物新鲜度判据全绿:${results.map((r) => r.cmd).join(' / ')}`] }
    : { ok: false, evidence: bad.map((r) => `${r.cmd}(${r.covers})exit ${r.code}:${r.tail}`) };
}

/**
 * ⑤-a 后端自己声明的版本必须单值。
 *
 * 三处各自独立落盘:`package.json` 的 version、`apply-swagger.ts` 里**写死的**字面量、
 * 以及生成物 `openapi.json` 的 info.version。任意一处漂移,别端拿到的 contract version
 * 就与后端自称的不是同一个 —— 那是⑤这条要防的事的**本仓可见半边**。
 */
export function judgeBackendVersionSingleValued(
  pkgVersion: string,
  swaggerSrc: string,
  openapiVersion: string,
  scan: { readonly fileCount: number; readonly strays: readonly string[] },
): Judgement {
  const m = /\.setVersion\(\s*'([^']+)'\s*\)/.exec(swaggerSrc);
  if (m === null) {
    return { ok: false, evidence: [`${SWAGGER_SRC} 里找不到 .setVersion('…') ⇒ 判据失效`] };
  }
  // 防空绿:扫描面为空时「零命中」与「真的干净」长得一模一样。先钉住采集非空。
  if (scan.fileCount === 0) {
    return {
      ok: false,
      evidence: [`全仓扫描采集到 **0 个 .ts 文件**(${VERSION_SCAN_DIRS.join(' / ')})⇒ 扫描面塌了,「零第四处声明」是空绿,读数作废`],
    };
  }
  const trio = [
    { where: 'package.json#version', v: pkgVersion },
    { where: `${SWAGGER_SRC}#setVersion`, v: m[1] },
    { where: `${OPENAPI_JSON}#info.version`, v: openapiVersion },
  ];
  const distinct = new Set(trio.map((t) => t.v));
  if (distinct.size !== 1) return { ok: false, evidence: trio.map((t) => `${t.where} = ${t.v}`) };

  // 三处一致还不够:**第四处**硬编码同一个版本号才是真源唯一性真正的破口 —— 它不在
  // `release:prepare` 的同步清单里,发版后会静默过期,而在此之前没有任何闸会响。
  const version = [...distinct][0];
  if (scan.strays.length > 0) {
    return {
      ok: false,
      evidence: [
        `三处真源一致(${version}),但 ${VERSION_SCAN_DIRS.join(' / ')} 下另有 ${scan.strays.length} 处硬编码同一版本号 ⇒ 第四处声明:`,
        ...scan.strays.map((d) => `  ${d}`),
        '这些位置不会被 `pnpm release:prepare` 同步 ⇒ 下次发版即静默过期。',
        '若那确实是**别的版本命名空间**(generator / schema 版本恰好同号),把该文件登记进 VERSION_LITERAL_ALLOWLIST —— 不要放宽判据。',
      ],
    };
  }
  return {
    ok: true,
    evidence: [
      `后端三处版本声明一致:${version}(${trio.map((t) => t.where).join(' / ')})`,
      `全仓扫描 ${VERSION_SCAN_DIRS.join(' / ')} 下 ${scan.fileCount} 个 .ts:白名单(${VERSION_LITERAL_ALLOWLIST.join('、')})之外无第四处硬编码`,
    ],
  };
}

/**
 * ⑤-a 全仓扫描:除三处真源外,还有没有别处**硬编码**了当前 contract version。
 *
 * 为什么按「值等于当前版本」扫、而不是按「长得像 semver」扫:仓内本就有一批**别的**版本
 * 命名空间(`GENERATOR_VERSION = '1.0.0'`、`SCHEMA_VERSION = '1.0.0'`、`openapi: '3.0.0'` …)。
 * 按 semver 形状扫会把它们全网进来 ⇒ 噪声淹没信号 ⇒ 判据沦为摆设(本仓栽过:宽正则 = 摆设)。
 * 按**值**扫则精确:第四处声明写的必然就是当前那个版本号。
 *
 * 代价明写:当 contract version 有朝一日恰好与某个别的命名空间同号(例如双方都到 `1.0.0`),
 * 那一处会被报出来。彼时正确处置是**人看一眼再登记进白名单**,不是放宽判据。
 */
export function findStrayVersionLiterals(
  files: readonly { readonly path: string; readonly text: string }[],
  version: string,
  allowlist: readonly string[],
): string[] {
  const literal = new RegExp(`['"\`]${version.replace(/\./g, '\\.')}['"\`]`);
  const hits: string[] = [];
  for (const file of files) {
    if (allowlist.includes(file.path)) continue;
    file.text.split('\n').forEach((line, i) => {
      if (literal.test(line)) hits.push(`${file.path}:${i + 1}  ${line.trim()}`);
    });
  }
  return hits;
}

interface RegistryRow {
  readonly end: string;
  readonly declared: string;
  readonly when: string;
  readonly who: string;
}

/**
 * ⑤-b 登记表解析。只认**合同点名的五端**那几行 —— 文件里别的表格(哨兵值说明表等)
 * 天然被滤掉;而某一行被改名 / 删掉也蒙混不过去:缺行由调用方逐条点出来。
 */
export function parseRegistryRows(text: string): RegistryRow[] {
  const rows: RegistryRow[] = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('|') || !t.endsWith('|')) continue;
    const cells = t.slice(1, -1).split('|').map((c) => c.trim());
    if (cells.length !== 5) continue;
    if (!CONTRACT_ENDS.includes(cells[0])) continue;
    rows.push({ end: cells[0], declared: cells[1], when: cells[3], who: cells[4] });
  }
  return rows;
}

/**
 * ⑤-b 四端回执登记表的读数。
 *
 * **这是 B 类。** 它算得出「谁没回执 / 谁版本对不上」,但**验不了表里的话是不是真的** ——
 * 那是别的仓库的人写下的证词,不是本仓可复算的事实。所以它恒走 `eviSub` ⇒ 5b 永远是 ⏸。
 * 返回 `Judgement` 只为**让正对照能证明它真会分辨**(`ok` 既不参与退出码也不参与渲染)。
 */
export function judgeContractVersionRegistry(
  registryText: string | null,
  backendVersion: string,
): Judgement {
  if (registryText === null) {
    return { ok: false, evidence: [`登记表 ${VERSION_REGISTRY} **不存在** ⇒ 四端回执无处可填,这条彻底无从取证。`] };
  }
  const rows = parseRegistryRows(registryText);
  if (rows.length === 0) {
    return {
      ok: false,
      evidence: [`登记表 ${VERSION_REGISTRY} 解析到 **0 行** ⇒ 表被清空或表头被改坏。空表恒「零不一致」,那是空绿。`],
    };
  }
  const missing = CONTRACT_ENDS.filter((e) => !rows.some((r) => r.end === e));
  const structural: string[] = [];
  const notReported: string[] = [];
  const aligned: string[] = [];
  const mismatched: string[] = [];
  for (const r of rows) {
    if (r.declared === REGISTRY_SAME_AS_BACKEND) structural.push(r.end);
    else if (r.declared === REGISTRY_NOT_REPORTED) notReported.push(r.end);
    else if (r.declared === backendVersion) aligned.push(`${r.end}(${r.when} / ${r.who})`);
    else mismatched.push(`${r.end} 报 ${r.declared} ≠ 后端 ${backendVersion}(${r.when} / ${r.who})`);
  }
  const evidence = [
    `后端(含 worker,同仓同构建)当前 contract version:${backendVersion}`,
    `登记表 ${VERSION_REGISTRY}:合同点名 ${CONTRACT_ENDS.length} 端,解析到 ${rows.length} 行`,
  ];
  if (missing.length > 0) evidence.push(`⚠️ 缺行(合同点名却查无此端):${missing.join('、')} ⇒ 表被削,缺口可能已被洗掉`);
  if (structural.length > 0) evidence.push(`结构性对齐(同仓同构建,无需回执):${structural.join('、')}`);
  if (aligned.length > 0) evidence.push(`已回执且与后端一致:${aligned.join('、')}`);
  if (mismatched.length > 0) evidence.push(`❗版本不一致:${mismatched.join(';')}`);
  if (notReported.length > 0) evidence.push(`从未回执(无从核对):${notReported.join('、')}`);
  const ok = missing.length === 0 && mismatched.length === 0 && notReported.length === 0;
  evidence.push(
    ok
      ? '五端均已取证且一致 —— 但这仍是**证词**,不是本仓可复算的事实 ⇒ 结论由维护者拍板,判据不代劳。'
      : `需要的证据:上列各端在**自己仓里**对引入的 client 目录跑 \`grep -r contractVersion\`,` +
        `取到其编译所用契约版本,填进 ${VERSION_REGISTRY} §4 对应行(填法见该文件 §2 / §3)。`,
  );
  return { ok, evidence };
}

/**
 * ⑥-a 旧写入口已关闭(代码侧)—— 直接复用 #1084 的 C1–C7 结构判据,不重造。
 * counts 全部 > 0 是**防空绿**:某一面数字为 0 说明判据根本没扫到东西。
 */
export function judgeV11GateCriteria(
  findings: readonly { criterion: string; detail: string }[],
  counts: Readonly<Record<string, number>>,
): Judgement {
  const zero = Object.entries(counts).filter(([, n]) => n === 0);
  if (zero.length > 0) {
    return { ok: false, evidence: zero.map(([k]) => `counts.${k} = 0 ⇒ 该面没被扫到,「零 finding」是空绿`) };
  }
  return findings.length === 0
    ? {
        ok: true,
        evidence: [
          `C1–C7 零 finding;受闸写入口 v11=${counts.v11GatedEntries} / legacy=${counts.legacyGatedEntries},` +
            `读面文件 ${counts.readFiles},受闸模块 ${counts.gateDependentModules}`,
        ],
      }
    : { ok: false, evidence: findings.map((f) => `[${f.criterion}] ${f.detail}`) };
}

/** ⑦-a worker 有启动命令:某条 npm script 拉起的入口,确实取到 ActivityBatchWorker 并跑它的循环。 */
export function judgeWorkerStartCommand(
  scripts: Readonly<Record<string, string>>,
  entrySource: (name: string) => string | null,
): Judgement {
  const hits: string[] = [];
  for (const [name, body] of Object.entries(scripts)) {
    const m = /node\s+dist\/([\w./-]+)/.exec(body);
    if (m === null) continue;
    const src = entrySource(`src/${m[1]}.ts`);
    if (src === null) continue;
    if (src.includes('ActivityBatchWorker') && /\.run\(\)/.test(src)) hits.push(`pnpm ${name} → src/${m[1]}.ts`);
  }
  return hits.length > 0
    ? { ok: true, evidence: [`启动命令:${hits.join(' / ')}`] }
    : {
        ok: false,
        evidence: ['没有任何 npm start 脚本的入口实例化 ActivityBatchWorker 并调用 run() ⇒ 没有启动命令'],
      };
}

/** ⑦-b lease/fencing:schema 三列齐全,且 worker 真的在用它们。 */
export function judgeWorkerLease(schemaSrc: string, workerSrc: string): Judgement {
  const block = /model\s+ActivityBatchJob\s*\{([\s\S]*?)\n\}/.exec(schemaSrc);
  if (block === null) return { ok: false, evidence: ['schema 里找不到 model ActivityBatchJob ⇒ 判据失效'] };
  const cols = ['leaseOwner', 'leaseGeneration', 'leaseExpiresAt'];
  const missing = cols.filter((c) => !new RegExp(`^\\s*${c}\\s`, 'm').test(block[1]));
  if (missing.length > 0) {
    return { ok: false, evidence: [`ActivityBatchJob 缺 lease 列:${missing.join(', ')}`] };
  }
  const unused = cols.filter((c) => !workerSrc.includes(c));
  return unused.length === 0
    ? { ok: true, evidence: [`ActivityBatchJob 三列 lease/fencing 齐全,且 ${WORKER_SRC} 全部在用`] }
    : { ok: false, evidence: [`schema 有列但 worker 没用:${unused.join(', ')} ⇒ 租约形同虚设`] };
}

/** ⑦-e 停机排空:worker 挂在 Nest 关停钩子上,且关停路径是「停领 + 排空」而不是硬杀。 */
export function judgeWorkerGracefulDrain(workerSrc: string): Judgement {
  const hasHook = /onApplicationShutdown\s*\(/.test(workerSrc);
  const hasDrain = /stopAndDrain\s*\(/.test(workerSrc);
  const missing = [
    hasHook ? null : 'onApplicationShutdown 钩子',
    hasDrain ? null : '停领并排空的关停路径(stopAndDrain)',
  ].filter((x): x is string => x !== null);
  return missing.length === 0
    ? { ok: true, evidence: ['worker 实现 onApplicationShutdown → stopAndDrain(停领新任务并等当前轮结束)'] }
    : { ok: false, evidence: [`worker 缺:${missing.join('、')}`] };
}

/**
 * ⑦-d 运维 SOP 文档存在且逐条覆盖合同点名的五要素。
 *
 * ⚠️ 本判据判的是**那份文档在不在、有没有这五节**,不是「SOP 写得对不对」——
 * 后者不是机器能判的。渲染时必须原样这么说,不许把它读成「运维能力已就绪」。
 */
export function judgeWorkerRunbook(content: string | null): Judgement {
  if (content === null) {
    return {
      ok: false,
      evidence: [
        `${WORKER_RUNBOOK} 不存在 —— docs/ops/ 下零份 ActivityBatchWorker 运维 runbook`,
        `需覆盖:${RUNBOOK_TOPICS.map((t) => t.label).join('、')}`,
      ],
    };
  }
  const missing = RUNBOOK_TOPICS.filter((t) => !t.pattern.test(content));
  return missing.length === 0
    ? { ok: true, evidence: [`${WORKER_RUNBOOK} 五要素成节齐全(仅判「有没有这五节」,不判 SOP 内容对不对)`] }
    : { ok: false, evidence: [`${WORKER_RUNBOOK} 缺节:${missing.map((t) => t.label).join('、')}`] };
}

/**
 * ⑧-a 开关的**可一致性**(不是一致性本身 —— 那要看各实例,见 8b)。
 *
 * 两个方向:
 *   正向:三个 per-instance env 开关在 production 下必须空值即 fail-fast。
 *        有默认值 = 漏配的实例会静默取默认,「全实例一致」就没有任何执法位。
 *        这里**真调用**配置解析器,不是 grep 文本 —— 真触发 ≠ 结构断言。
 *   反向:企业微信的开关刻意**不是** env,而是 DB 表 `wecom_settings.enabled`(全实例
 *        共享同一行 ⇒ 结构上不可能不一致)。一旦有人给它加一个 per-instance 的
 *        `WECOM_*_ENABLED`,就凭空造出一个漂移面 —— 本判据当场红。
 */
export function judgeFlagsFailFast(
  flags: readonly { env: string; label: string; parse: (raw: string | undefined, e: ReturnType<typeof parseAppEnv>) => boolean }[],
  configSrc: string,
): Judgement {
  if (flags.length === 0) return { ok: false, evidence: ['开关清单为空 ⇒ 判据无从执法'] };
  const prod = parseAppEnv('production');
  const bad: string[] = [];
  for (const f of flags) {
    for (const raw of [undefined, ''] as const) {
      let threw = false;
      try {
        f.parse(raw, prod);
      } catch {
        threw = true;
      }
      if (!threw) bad.push(`${f.env}(${f.label}):production 下 ${raw === undefined ? '缺省' : '空串'}未 fail-fast`);
    }
  }
  const wecomEnv = configSrc.match(/WECOM[A-Z_]*_ENABLED/g);
  if (wecomEnv !== null) {
    bad.push(`企业微信开关出现 per-instance env:${[...new Set(wecomEnv)].join(', ')} ⇒ 新增了实例间漂移面`);
  }
  return bad.length === 0
    ? {
        ok: true,
        evidence: [
          `${flags.length} 个 env 开关在 production 下缺省/空串均 fail-fast(实调解析器,非文本判)`,
          '企业微信开关是 DB `wecom_settings.enabled`(全实例共享一行),未新增 per-instance env',
        ],
      }
    : { ok: false, evidence: bad };
}

/**
 * ⑨-a 验收套件:AC-001..072 / ADV-001..023 一条不许停在 `it.todo`。
 *
 * ⚠️ `numTodoTests > 0` 时 jest 自己是**绿的**(success=true)—— 那正是这条要抓的事:
 *    「待实现」不是「通过」。另外 `total === 0` = 套件没编译,按本仓纪律作废读数当红。
 */
export function judgeAcceptanceSuite(summary: {
  total: number;
  passed: number;
  todo: number;
  failed: number;
}): Judgement {
  if (summary.total === 0) {
    return { ok: false, evidence: ['验收套件 0 total ⇒ 套件没编译/没被选中,读数作废,按红处理'] };
  }
  const bad: string[] = [];
  if (summary.failed > 0) bad.push(`${summary.failed} 条失败`);
  if (summary.todo > 0) bad.push(`${summary.todo} 条仍是 it.todo(待实现,不是通过)`);
  return bad.length === 0
    ? { ok: true, evidence: [`验收套件 ${summary.passed}/${summary.total} 通过,零 todo 零失败`] }
    : {
        ok: false,
        evidence: [`${summary.passed} 通 / ${summary.todo} 待 / ${summary.failed} 败 / ${summary.total} 总 —— ${bad.join('、')}`],
      };
}

// ══════════════════════════════════════════════════════════════════════════
// 采集器(不纯)。判据与采集分离:判据由正对照证明,采集由各判据的非空断言兜底。
// ══════════════════════════════════════════════════════════════════════════

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

/**
 * ⑤-a 扫描面的采集:递归 `VERSION_SCAN_DIRS` 下的 `.ts`。
 *
 * **不排除 `.spec.ts`**:测试里硬编码当前版本号同样会随发版过期,同样该被看见。
 * 采集为空(0 个文件)时由 5a 的非空断言兜底 —— 见 `judgeBackendVersionSingleValued` 的调用处。
 */
function collectScannedSources(): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(rel(dir), { withFileTypes: true })) {
      const child = `${dir}/${entry.name}`;
      if (entry.isDirectory()) visit(child);
      else if (entry.name.endsWith('.ts')) out.push({ path: child, text: read(child) });
    }
  };
  for (const dir of VERSION_SCAN_DIRS) visit(dir);
  return out;
}

/** `git ls-tree -r <rev> -- prisma/migrations` → path → blob sha。 */
function migrationBlobs(rev: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of git(['ls-tree', '-r', rev, '--', 'prisma/migrations']).split('\n')) {
    const m = /^\d+\s+blob\s+([0-9a-f]+)\t(.+)$/.exec(line);
    if (m !== null) out.set(m[2], m[1]);
  }
  return out;
}

/**
 * HEAD 侧的 blob 图 **加上工作区未提交的改动**。
 *
 * 只读 `ls-tree HEAD` 会漏掉一整类:老 migration 已经被改了、只是还没提交 —— 那时判据
 * 照样全绿。开闸前检查如果只看已提交的东西,就等于默认「手上没动过」,而那正是要核的事。
 * 脏文件塞一个哨兵值进去:它必然 ≠ 基线 blob sha,于是由同一个(已被正对照证明过的)判据报红。
 */
function migrationBlobsWithWorktree(): Map<string, string> {
  return mergeWorktreeDirt(migrationBlobs('HEAD'), git(['status', '--porcelain', '--', 'prisma/migrations']));
}

/**
 * 把 `git status --porcelain` 的脏文件并进 blob 图(纯函数,好让正对照能弄假)。
 * porcelain 行形如 ` M path` / `?? path` / `R  old -> new`;重命名取 `old` 那一侧
 * —— 老 migration 被改名同样是「旧 migration 被动过」。
 */
export function mergeWorktreeDirt(base: Map<string, string>, porcelain: string): Map<string, string> {
  const out = new Map(base);
  for (const line of porcelain.split('\n')) {
    if (line.length < 4) continue;
    const status = line.slice(0, 2).trim();
    const path = line.slice(3).trim().split(' -> ')[0].replace(/^"|"$/g, '');
    if (path.length > 0) out.set(path, `worktree-dirty(${status})`);
  }
  return out;
}

/**
 * ③ 的基线 = 合同入仓那一提交(SHA256 清单**被新增**的那一次)。
 * 动态解析而不是写死 SHA:写死会在任何一次历史重写后指向虚空,且读的人无从验证它是哪一刀。
 */
function resolveBaselineCommit(): { sha: string; date: string; subject: string } | null {
  const lines = git(['log', '--diff-filter=A', '--format=%H\t%ad\t%s', '--date=short', '--', SHA256_MANIFEST])
    .split('\n')
    .filter((l) => l.trim().length > 0);
  const oldest = lines.at(-1);
  if (oldest === undefined) return null;
  const [sha, date, subject] = oldest.split('\t');
  return { sha, date, subject };
}

function collectReconcile(): { cmd: string; covers: string; code: number; tail: string }[] {
  return RECONCILE_COMMANDS.map(({ cmd, covers }) => {
    const r = spawnSync('pnpm', [cmd], { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    const text = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split('\n').slice(-3).join(' | ');
    return { cmd, covers, code: r.status ?? 1, tail: text.slice(0, 300) };
  });
}

function collectAcceptance(): { total: number; passed: number; todo: number; failed: number } {
  const dir = mkdtempSync(join(tmpdir(), 'srvf-cutover-'));
  const out = join(dir, 'acceptance.json');
  try {
    spawnSync(
      'pnpm',
      ['exec', 'jest', '--config', 'test/jest-unit.config.ts', '--json', '--silent', '--outputFile', out, ACCEPTANCE_SPEC],
      { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    );
    if (!existsSync(out)) return { total: 0, passed: 0, todo: 0, failed: 0 };
    const r = JSON.parse(readFileSync(out, 'utf8')) as {
      numTotalTests: number;
      numPassedTests: number;
      numTodoTests: number;
      numFailedTests: number;
    };
    return { total: r.numTotalTests, passed: r.numPassedTests, todo: r.numTodoTests, failed: r.numFailedTests };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** ②-b 的证据:本 worktree 的红区授权令牌(只增不减、无过期、per-worktree ⇒ 开闸前必须是空的)。 */
function collectGrants(): string[] {
  const r = spawnSync('pnpm', ['harness:grant', '--list'], { cwd: ROOT, encoding: 'utf8' });
  return `${r.stdout ?? ''}`
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('>') && !l.startsWith('用法'));
}

// ══════════════════════════════════════════════════════════════════════════
// 正对照(仪器自证)
//
// 每条 A 类判据都必须能被**弄假 ⇒ 转红**。做不出正对照的,按纪律就不是 A 类。
// `must: 'red'` = 喂假输入必须判红;`must: 'green'` = 喂修好的输入必须判绿
// (对今天真实状态本就是红的那几条,只有双向都验过,才知道它不是「恒红」)。
// ══════════════════════════════════════════════════════════════════════════

interface Control {
  readonly id: string;
  readonly desc: string;
  readonly must: 'red' | 'green';
  readonly run: () => Judgement;
}

const GOOD_RUNBOOK = RUNBOOK_TOPICS.map((t) => `## ${t.label}\n正文\n`).join('\n');

/** 5a 系列夹具:一个「扫描面正常、无第四处声明」的干净读数。 */
const CLEAN_SCAN = { fileCount: 1, strays: [] as readonly string[] };

/**
 * 5b 系列夹具:一张**结构合法**的登记表,四个外部端统一报 `declared`。
 * 由 `CONTRACT_ENDS` 生成而非手抄五行 —— 合同点名的端将来若增删,夹具自动跟上,
 * 不会出现「判据认六端、夹具只有五端」这种自己骗自己的对照。
 */
function registryFixture(declared: string): string {
  return ['| 端 | 所用契约版本 | 取证方式 | 填报日期 | 填报人 |', '|---|---|---|---|---|']
    .concat(
      CONTRACT_ENDS.map((end) =>
        end === 'worker'
          ? `| ${end} | ${REGISTRY_SAME_AS_BACKEND} | 同仓同构建 | — | — |`
          : `| ${end} | ${declared} | client 戳 | 2026-08-20 | 维护者 |`,
      ),
    )
    .join('\n');
}

export function positiveControls(): Control[] {
  const realSchema = read(SCHEMA);
  const realWorker = read(WORKER_SRC);
  const realSwagger = read(SWAGGER_SRC);
  const realConfig = read(CONFIG_SRC);
  const manifest = read(SHA256_MANIFEST);
  const goodDocs: Record<string, string> = {};
  for (const line of manifest.split('\n')) {
    const m = /^[0-9a-f]{64}\s+(.+)$/.exec(line.trim());
    if (m !== null) goodDocs[m[1]] = read(`${CONTRACT_DIR}/${m[1]}`);
  }
  const firstDoc = Object.keys(goodDocs)[0];

  return [
    {
      id: '1a',
      desc: '把一份合同的正文改一个字符 ⇒ SHA256 对不上',
      must: 'red',
      run: () => judgeContractIntegrity(manifest, { ...goodDocs, [firstDoc]: `${goodDocs[firstDoc]}x` }),
    },
    {
      id: '1a′',
      desc: '清单登记的文件从仓里消失 ⇒ 必红',
      must: 'red',
      run: () => {
        const missing = { ...goodDocs };
        delete missing[firstDoc];
        return judgeContractIntegrity(manifest, missing);
      },
    },
    {
      id: '3a',
      desc: '基线里的一个 migration 内容变了 ⇒ 必红',
      must: 'red',
      run: () =>
        judgeOldMigrationsUnchanged(
          new Map([['prisma/migrations/x/migration.sql', 'aaa']]),
          new Map([['prisma/migrations/x/migration.sql', 'bbb']]),
        ),
    },
    {
      id: '3a′',
      desc: '基线里的一个 migration 被删了 ⇒ 必红',
      must: 'red',
      run: () => judgeOldMigrationsUnchanged(new Map([['prisma/migrations/x/migration.sql', 'aaa']]), new Map()),
    },
    {
      id: '3a″',
      desc: '基线集为空(采集失真)⇒ 必红,不许空集恒等于空集地变绿',
      must: 'red',
      run: () => judgeOldMigrationsUnchanged(new Map(), new Map()),
    },
    {
      // 工作区脏:老 migration 已被改、只是还没提交。只读 `ls-tree HEAD` 的版本对这一类全盲。
      id: '3a⁗',
      desc: '老 migration 被改了但没提交(工作区脏)⇒ 必红',
      must: 'red',
      run: () => {
        const base = new Map([['prisma/migrations/20250101_x/migration.sql', 'aaa']]);
        const head = mergeWorktreeDirt(base, ' M prisma/migrations/20250101_x/migration.sql\n');
        return judgeOldMigrationsUnchanged(base, head);
      },
    },
    {
      // 同一类的另一侧:老 migration 被**改名**(porcelain 的 `R  old -> new` 形态)。
      id: '3a⁗′',
      desc: '老 migration 被改名 ⇒ 必红(取 old 那一侧)',
      must: 'red',
      run: () => {
        const base = new Map([['prisma/migrations/20250101_x/migration.sql', 'aaa']]);
        const head = mergeWorktreeDirt(base, 'R  prisma/migrations/20250101_x/migration.sql -> prisma/migrations/20250101_y/migration.sql\n');
        return judgeOldMigrationsUnchanged(base, head);
      },
    },
    {
      // 端到端正对照(**真实 git 历史**,不是喂进去的假 Map):其余 3a 系列只证明判据,
      // 证明不了采集器 —— ls-tree 解析写错、路径前缀取错,判据照样绿。
      // 这里拿仓内真实存在的那一处历史修改当靶子:`20260701160000_org_supervision_assignments`
      // 在 #470(2026-07-01)建立,又在 #485(2026-07-03,R13 化名化合规)被改过。
      // 以 #470 那个提交当基线跑一遍,判据必须红并点名它 —— 采集器与判据合起来才算被证过。
      id: '3a‴',
      desc: '端到端:以 46dca8ab 为基线跑真实 git 数据 ⇒ 必红并点名那条被改过的 migration',
      must: 'red',
      run: () => {
        let base: Map<string, string>;
        try {
          base = migrationBlobs('46dca8ab');
        } catch {
          return { ok: true, evidence: ['历史提交 46dca8ab 不可达(浅克隆?)⇒ 故意判绿,让自证报失效'] };
        }
        const j = judgeOldMigrationsUnchanged(base, migrationBlobs('HEAD'));
        // 不只要求「红」,还要求红在**那一条**上 —— 否则随便哪种失真都能冒充命中。
        return j.evidence.some((e) => e.includes('20260701160000_org_supervision_assignments'))
          ? j
          : { ok: true, evidence: ['红了但不是红在预期那条上 ⇒ 故意判绿,让自证报失效'] };
      },
    },
    {
      id: '4a',
      desc: '任一条对账命令非 0 ⇒ 必红',
      must: 'red',
      run: () =>
        judgeReconcile(
          RECONCILE_COMMANDS.map((c, i) => ({ ...c, code: i === 0 ? 1 : 0, tail: i === 0 ? '快照漂移' : '' })),
        ),
    },
    {
      id: '4a′',
      desc: '少跑了一条对账命令 ⇒ 必红(采集不全不许当全绿)',
      must: 'red',
      run: () => judgeReconcile(RECONCILE_COMMANDS.slice(1).map((c) => ({ ...c, code: 0, tail: '' }))),
    },
    // 5a 系列的夹具**刻意不使用仓内当前版本号** —— 否则夹具自己就是「第四处硬编码」,
    // 会被 5a 新增的全仓扫描扫出来(判据把自己判红)。7.7.x 与仓内任何版本命名空间都不撞。
    {
      id: '5a',
      desc: 'swagger 里的版本字面量与 package.json 漂移 ⇒ 必红',
      must: 'red',
      run: () => judgeBackendVersionSingleValued('7.7.7', "  .setVersion('7.7.6')\n", '7.7.7', CLEAN_SCAN),
    },
    {
      id: '5a′',
      desc: '三处一致且全仓无第四处 ⇒ 必绿(证明它不是恒红)',
      must: 'green',
      run: () => judgeBackendVersionSingleValued('7.7.7', "  .setVersion('7.7.7')\n", '7.7.7', CLEAN_SCAN),
    },
    {
      id: '5a″',
      desc: '三处一致、但仓内另有一处硬编码同一版本号 ⇒ 必红(第四处声明)',
      must: 'red',
      run: () =>
        judgeBackendVersionSingleValued('7.7.7', "  .setVersion('7.7.7')\n", '7.7.7', {
          fileCount: 1,
          strays: ["src/somewhere.ts:12  const V = '7.7.7';"],
        }),
    },
    {
      id: '5a‴',
      desc: '扫描面塌成 0 个文件 ⇒ 必红(零命中与真干净长得一样,不许当绿)',
      must: 'red',
      run: () => judgeBackendVersionSingleValued('7.7.7', "  .setVersion('7.7.7')\n", '7.7.7', { fileCount: 0, strays: [] }),
    },
    {
      id: '5a⁗',
      desc: '扫描器三合一:命中白名单外的、跳过白名单内的、不误伤别的版本命名空间',
      must: 'red',
      run: () => {
        const hits = findStrayVersionLiterals(
          [
            { path: 'src/stray.ts', text: "const V = '7.7.7';" },
            { path: 'src/allowed.ts', text: "const V = '7.7.7';" },
            { path: 'src/other-namespace.ts', text: "const GENERATOR_VERSION = '1.0.0';" },
          ],
          '7.7.7',
          ['src/allowed.ts'],
        );
        // 只有「恰好扫出 stray 那一处」才算判据健全 ⇒ 此时 ok=false ⇒ 必红。
        const exact = hits.length === 1 && hits[0].startsWith('src/stray.ts:1');
        return { ok: !exact, evidence: [`扫描命中 ${hits.length} 处:${hits.join(' | ') || '(无)'}`] };
      },
    },
    {
      id: '5b',
      desc: '登记表**不存在** ⇒ 必红(要说出「无处可填」,不许静默)',
      must: 'red',
      run: () => judgeContractVersionRegistry(null, '7.7.7'),
    },
    {
      id: '5b′',
      desc: '登记表在、但一行都解析不出 ⇒ 必红(空表恒「零不一致」是空绿)',
      must: 'red',
      run: () => judgeContractVersionRegistry('# 标题\n\n正文里没有登记表。\n', '7.7.7'),
    },
    {
      id: '5b″',
      desc: '五端齐全且版本全部对得上 ⇒ 必绿(证明它不是恒红)',
      must: 'green',
      run: () => judgeContractVersionRegistry(registryFixture('7.7.7'), '7.7.7'),
    },
    {
      id: '5b‴',
      desc: '某端报的版本与后端不一致 ⇒ 必红(「点名」这个能力真的在)',
      must: 'red',
      run: () => judgeContractVersionRegistry(registryFixture('7.7.6'), '7.7.7'),
    },
    {
      id: '5b⁗',
      desc: '删掉合同点名的某一端那行 ⇒ 必红(不许靠删行把缺口洗成零不一致)',
      must: 'red',
      run: () =>
        judgeContractVersionRegistry(
          registryFixture('7.7.7')
            .split('\n')
            .filter((l) => !l.startsWith('| 手机端 '))
            .join('\n'),
          '7.7.7',
        ),
    },
    {
      id: '6a',
      desc: 'C1–C7 有 finding ⇒ 必红',
      must: 'red',
      run: () =>
        judgeV11GateCriteria([{ criterion: 'C2', detail: 'selfPunch 绕开闸' }], {
          v11GatedEntries: 1,
          legacyGatedEntries: 1,
          readFiles: 1,
          gateDependentModules: 1,
        }),
    },
    {
      id: '6a′',
      desc: '零 finding 但某一面 counts=0(判据没扫到东西)⇒ 必红',
      must: 'red',
      run: () => judgeV11GateCriteria([], { v11GatedEntries: 0, legacyGatedEntries: 3, readFiles: 2, gateDependentModules: 4 }),
    },
    {
      id: '7a',
      desc: '没有任何入口拉起 ActivityBatchWorker ⇒ 必红',
      must: 'red',
      run: () => judgeWorkerStartCommand({ 'start:x': 'node dist/x' }, () => 'export function noop() {}'),
    },
    {
      id: '7a′',
      desc: '入口里有 worker 且 run() ⇒ 必绿',
      must: 'green',
      run: () =>
        judgeWorkerStartCommand({ 'start:x': 'node dist/x' }, () => 'new ActivityBatchWorker(); void w.run();'),
    },
    {
      // ⚠️ 变异必须落在 **ActivityBatchJob 那个 model 块内**:仓内另有 StorageObjectOperation
      // 也带三列同名 lease,且在文件里更靠前。第一版控制项按全文件首个 `leaseGeneration` 改,
      // 改到的是那个无关 model —— 判据当然不红,自证当场把这条控制项判成失效。
      // (这正是「正对照」要防的事:没红不等于判据坏了,也可能是变异根本没打中。)
      id: '7b',
      desc: 'ActivityBatchJob 抽掉一列 lease ⇒ 必红',
      must: 'red',
      run: () => {
        const block = /model\s+ActivityBatchJob\s*\{([\s\S]*?)\n\}/.exec(realSchema);
        if (block === null) return { ok: true, evidence: ['变异没打中(找不到 model 块)⇒ 故意判绿,让自证报失效'] };
        const mutated = block[0].replace(/^(\s*)leaseGeneration(\s)/m, '$1leaseGenerationX$2');
        if (mutated === block[0]) return { ok: true, evidence: ['变异没打中(列名没换)⇒ 故意判绿,让自证报失效'] };
        return judgeWorkerLease(realSchema.replace(block[0], mutated), realWorker);
      },
    },
    {
      id: '7b′',
      desc: 'schema 有列但 worker 不用它 ⇒ 必红(租约形同虚设)',
      must: 'red',
      run: () => judgeWorkerLease(realSchema, 'export class W {}'),
    },
    {
      id: '7d',
      desc: 'runbook 不存在 ⇒ 必红',
      must: 'red',
      run: () => judgeWorkerRunbook(null),
    },
    {
      id: '7d′',
      desc: 'runbook 少一节(停机排空)⇒ 必红并点名缺哪节',
      must: 'red',
      run: () => judgeWorkerRunbook(GOOD_RUNBOOK.replace('## 停机排空', '## 别的')),
    },
    {
      id: '7d″',
      desc: '五节齐全 ⇒ 必绿(证明它不是恒红)',
      must: 'green',
      run: () => judgeWorkerRunbook(GOOD_RUNBOOK),
    },
    {
      id: '7e',
      desc: 'worker 没有 onApplicationShutdown ⇒ 必红',
      must: 'red',
      run: () => judgeWorkerGracefulDrain(realWorker.replace(/onApplicationShutdown\s*\(/g, 'notAHook(')),
    },
    {
      id: '8a',
      desc: '某个开关在 production 下缺省不 fail-fast(有默认值)⇒ 必红',
      must: 'red',
      run: () => judgeFlagsFailFast([{ env: 'FAKE_ENABLED', label: '假开关', parse: () => false }], realConfig),
    },
    {
      id: '8a′',
      desc: '给企业微信加一个 per-instance env 开关 ⇒ 反向闸必红',
      must: 'red',
      run: () => judgeFlagsFailFast(INSTANCE_FLAGS, `${realConfig}\nprocess.env.WECOM_LOGIN_ENABLED;\n`),
    },
    {
      id: '8a″',
      desc: '开关清单为空 ⇒ 必红(空清单不许当全过)',
      must: 'red',
      run: () => judgeFlagsFailFast([], realConfig),
    },
    {
      id: '9a',
      desc: '还有 it.todo ⇒ 必红(jest 自己此时是绿的,这正是要抓的事)',
      must: 'red',
      run: () => judgeAcceptanceSuite({ total: 102, passed: 60, todo: 42, failed: 0 }),
    },
    {
      id: '9a′',
      desc: 'Tests: 0 total ⇒ 必红(套件没编译不是绿)',
      must: 'red',
      run: () => judgeAcceptanceSuite({ total: 0, passed: 0, todo: 0, failed: 0 }),
    },
    {
      id: '9a″',
      desc: '零 todo 零失败 ⇒ 必绿(证明它不是恒红)',
      must: 'green',
      run: () => judgeAcceptanceSuite({ total: 95, passed: 95, todo: 0, failed: 0 }),
    },
  ];
}

/**
 * 合同 §16.1 十条**逐字**原文(不改写、不合并、不断句)。
 * 本数组由脚本从合同正文机械抽取生成,并由 `assertContractTextVerbatim()` 在每次运行时
 * 回查合同 —— 抄错一个字、或合同被改动,当场停在「仪器失效」,不往下报十行。
 */
const CONTRACT_ITEMS: readonly string[] = [
  'v1.1四份文档已入仓并通过不同模型复核。',
  'goal、预检、维护者授权和所有红区写集明确。',
  '新schema migrations经审查，旧migration未修改。',
  '所有新权限、字典、Audit events和合同快照生成并对账。',
  'App、Admin、worker、管理后台和手机端支持同一contract version。',
  '旧ActivityCheckIn／AttendanceSheet正式写入口已关闭；旧读者清单全部切新账本。',
  '`ActivityBatchWorker`有启动命令、健康检查、lease、停机排空和恢复SOP。',
  '责任闭环、保险严格模式、企业微信和活动v1.1开关全实例一致。',
  'AC-001..072、ADV-001..023及规模测试通过。',
  '准备可部署的只读维护版本，而不是只写“必要时只读”。',
];

const DEV_DOC = `${CONTRACT_DIR}/SRVF_活动业务全流程改造_详细开发文档_v1.1.md`;

/** 仪器自证之一:十条原文必须逐字出现在合同正文里。抄错/合同漂移 ⇒ 停,不往下报。 */
function assertContractTextVerbatim(): string[] {
  const body = read(DEV_DOC);
  return CONTRACT_ITEMS.filter((t) => !body.includes(t)).map((t) => `原文对不上合同:「${t}」`);
}

// ══════════════════════════════════════════════════════════════════════════
// 十条组装
// ══════════════════════════════════════════════════════════════════════════

function sub(id: string, kind: Kind, title: string, j: Judgement): SubCheck {
  return { id, kind, title, verdict: kind === 'A' ? (j.ok ? 'pass' : 'fail') : 'pending', evidence: j.evidence };
}

/** B/C 子判据:机器只出证据,恒 `pending`,永不影响退出码。 */
function eviSub(id: string, kind: 'B' | 'C', title: string, evidence: string[]): SubCheck {
  return { id, kind, title, verdict: 'pending', evidence };
}

function buildItems(): ItemResult[] {
  // ── 采集 ──
  const pkg = JSON.parse(read('package.json')) as { version: string; scripts: Record<string, string> };
  const manifest = read(SHA256_MANIFEST);
  const docs: Record<string, string> = {};
  const manifestFiles: string[] = [];
  for (const line of manifest.split('\n')) {
    const m = /^[0-9a-f]{64}\s+(.+)$/.exec(line.trim());
    if (m !== null) {
      manifestFiles.push(m[1]);
      const body = readOrNull(`${CONTRACT_DIR}/${m[1]}`);
      if (body !== null) docs[m[1]] = body;
    }
  }
  const baseline = resolveBaselineCommit();
  const baseBlobs = baseline === null ? new Map<string, string>() : migrationBlobs(baseline.sha);
  const headBlobs = migrationBlobsWithWorktree();
  const newMigrations = [...headBlobs.keys()]
    .filter((p) => !baseBlobs.has(p))
    .map((p) => p.replace('prisma/migrations/', '').replace('/migration.sql', ''));
  const criteria = runCriteria();
  const acceptance = collectAcceptance();
  const reconcile = collectReconcile();
  const openapiVersion = (JSON.parse(read(OPENAPI_JSON)) as { info: { version: string } }).info.version;
  const grants = collectGrants();

  // 合同目录里不在 SHA256 清单内的 .md = 非合同附件(复核产物等),①-b 的证据面。
  const attachments = git(['ls-files', '--', `${CONTRACT_DIR}/*.md`])
    .split('\n')
    .map((p) => p.replace(`${CONTRACT_DIR}/`, ''))
    .filter((p) => p.endsWith('.md') && !manifestFiles.includes(p) && p !== 'README.md');

  const items: { text: string; subs: SubCheck[] }[] = [
    // ① v1.1四份文档已入仓并通过不同模型复核
    {
      text: CONTRACT_ITEMS[0],
      subs: [
        sub('1a', 'A', '四份合同已入仓,且与入仓冻结的 SHA256 清单逐字节一致', judgeContractIntegrity(manifest, docs)),
        eviSub('1b', 'C', '「通过不同模型复核」', [
          attachments.length === 0
            ? '合同目录下没有任何非合同附件(复核产物)'
            : `合同目录下的非合同附件:${attachments.join('、')}`,
          ...attachments.flatMap((f) => {
            const head = (readOrNull(`${CONTRACT_DIR}/${f}`) ?? '').split('\n').slice(0, 12);
            return head.filter((l) => /复核对象|复核日期/.test(l)).map((l) => `  ${f}:${l.replace(/^>\s*/, '').trim()}`);
          }),
          '机器无从判断「不同模型」与「通过」—— 复核产物既未署模型,也不是机器可核的对象。',
          '需要的证据:针对 v1.1 **四份**文档、由**不同模型**出具的复核结论(含模型标识与结论),并说明其与上列附件的关系。',
        ]),
      ],
    },
    // ② goal、预检、维护者授权和所有红区写集明确
    {
      text: CONTRACT_ITEMS[1],
      subs: [
        eviSub('2a', 'B', '本 worktree 的红区授权令牌(只增不减、无过期、per-worktree)', [
          ...(grants.length === 0 ? ['(读不到 harness:grant --list 输出)'] : grants),
          '开闸前这里应当是「当前无红区授权」——留着的令牌等于一扇没关的门。',
          '⚠️ 令牌是 per-worktree 的:本条只证明**这个** worktree,别的 worktree 要各自跑一遍。',
        ]),
        eviSub('2b', 'C', '「goal、预检、维护者授权和所有红区写集明确」', [
          '这是对**开发过程**的要求(每一刀有 goal、开工前跑过预检、授权由维护者亲发、写集事先声明),',
          '发生在历史里,不是仓库当前状态的函数 ⇒ 机器无从判断。',
          '需要的证据:逐刀的 goal 文本 + 预检读数 + 授权记录 + 写集声明(本仓落点:PR 描述、changelog.d/、docs/ai-harness/NEXT_TASKS.md)。',
        ]),
      ],
    },
    // ③ 新schema migrations经审查，旧migration未修改
    {
      text: CONTRACT_ITEMS[2],
      subs: [
        sub(
          '3a',
          'A',
          `旧 migration 未修改(基线 = 合同入仓提交${baseline === null ? '(解析失败)' : ` ${baseline.sha.slice(0, 8)} ${baseline.date}`})`,
          baseline === null
            ? { ok: false, evidence: ['解析不到合同入仓提交 ⇒ 判据失效,拒绝当绿'] }
            : judgeOldMigrationsUnchanged(baseBlobs, headBlobs),
        ),
        eviSub('3b', 'C', '「新 schema migrations 经审查」', [
          newMigrations.length === 0
            ? '基线后没有新增 migration。'
            : `基线后新增 ${newMigrations.length} 个:${newMigrations.join('、')}`,
          '「经审查」是人的行为,机器只能列出待审对象,判不了它审过没有。',
          '需要的证据:上列每个 migration 的维护者审查留痕(D 档拍板出处 / PR 评审记录)。',
        ]),
      ],
    },
    // ④ 所有新权限、字典、Audit events和合同快照生成并对账
    {
      text: CONTRACT_ITEMS[3],
      subs: [
        sub('4a', 'A', '权限与合同快照类生成物:重跑生成器与仓内产物逐字节对账', judgeReconcile(reconcile)),
        eviSub('4b', 'C', '「字典、Audit events」的对账', [
          '生成物链条覆盖的是**权限**(ROUTE_AUTHZ / RBAC map / 授权语义图)与**合同快照**(openapi.json / 前端 client)。',
          '字典与 Audit events **没有生成物、也没有登记表**:字典 seed 在 prisma/seed.ts,audit 事件无枚举登记 ⇒ 无对账判据。',
          '需要的证据:v1.1 新增的字典项与 Audit event 清单,逐条与 seed / 代码核对(或先把它们做成登记表,这条才可能升为 A 类)。',
        ]),
      ],
    },
    // ⑤ App、Admin、worker、管理后台和手机端支持同一contract version
    {
      text: CONTRACT_ITEMS[4],
      subs: [
        sub(
          '5a',
          'A',
          '后端 contract version 单值:三处真源一致,且全仓无第四处硬编码',
          ((files) =>
            judgeBackendVersionSingleValued(pkg.version, read(SWAGGER_SRC), openapiVersion, {
              fileCount: files.length,
              strays: findStrayVersionLiterals(files, pkg.version, VERSION_LITERAL_ALLOWLIST),
            }))(collectScannedSources()),
        ),
        eviSub(
          '5b',
          'B',
          '五端支持同一 contract version(登记表读数)',
          judgeContractVersionRegistry(readOrNull(VERSION_REGISTRY), pkg.version).evidence.slice(),
        ),
      ],
    },
    // ⑥ 旧ActivityCheckIn／AttendanceSheet正式写入口已关闭；旧读者清单全部切新账本
    {
      text: CONTRACT_ITEMS[5],
      subs: [
        sub(
          '6a',
          'A',
          '旧写入口已关闭(代码侧):复用 #1084 的 C1–C7 结构判据',
          judgeV11GateCriteria(criteria.findings, criteria.counts as unknown as Record<string, number>),
        ),
        eviSub('6b', 'B', '「旧读者清单全部切新账本」', [
          `C1–C7 扫到并确认接闸的读面文件:${criteria.counts.readFiles} 个(它们都经 participationReadSource() 问闸)。`,
          '但仓内**没有一份「旧读者清单」登记表** ⇒ 机器能证明「这几个接了闸」,证明不了「这几个就是全部」。',
          '需要的证据:维护者认可的旧读者清单,逐条核对是否已切新账本;后续卡点见 docs/ai-harness/NEXT_TASKS.md。',
        ]),
      ],
    },
    // ⑦ ActivityBatchWorker有启动命令、健康检查、lease、停机排空和恢复SOP
    {
      text: CONTRACT_ITEMS[6],
      subs: [
        sub('7a', 'A', '有启动命令', judgeWorkerStartCommand(pkg.scripts, (p) => readOrNull(p))),
        sub('7b', 'A', '有 lease(租约 / 围栏)', judgeWorkerLease(read(SCHEMA), read(WORKER_SRC))),
        sub('7e', 'A', '有停机排空', judgeWorkerGracefulDrain(read(WORKER_SRC))),
        sub('7d', 'A', `有运维 SOP 文档(登记路径 ${WORKER_RUNBOOK},须五要素成节)`, judgeWorkerRunbook(readOrNull(WORKER_RUNBOOK))),
        eviSub('7c', 'B', '有健康检查', [
          'src/modules/health 是 **HTTP 进程**的 /health;worker 跑在 headless application context 里,不经 HTTP ⇒ 那个端点不覆盖它。',
          'worker 侧现有的存活性代偿是 lease 过期后由下一轮重新领取(见 7b),那是**恢复**机制,不等于健康检查。',
          '需要的证据:维护者确认 worker 健康检查的形态(心跳表 / 外部进程探针 / 明确接受由 lease 恢复代偿),并写进 7d 的 runbook。',
        ]),
      ],
    },
    // ⑧ 责任闭环、保险严格模式、企业微信和活动v1.1开关全实例一致
    {
      text: CONTRACT_ITEMS[7],
      subs: [
        sub('8a', 'A', '开关具备「可一致」的执行位:production 下空值即 fail-fast + 企业微信不得新增 per-instance env', judgeFlagsFailFast(INSTANCE_FLAGS, read(CONFIG_SRC))),
        eviSub('8b', 'B', '「全实例一致」本身', [
          ...INSTANCE_FLAGS.map((f) => `${f.env}(${f.label})本进程读到:${process.env[f.env] ?? '(未设置)'}`),
          '企业微信(wecom_settings.enabled)是 DB 单点,全实例共享同一行 ⇒ 结构上不会不一致。',
          '⚠️ 上面三行**只是本进程**。集群里别的实例设了什么,仓库看不见。',
          '需要的证据:每个实例的 env 快照(或部署配置的单一来源),证明三个开关取值相同。',
        ]),
      ],
    },
    // ⑨ AC-001..072、ADV-001..023及规模测试通过
    {
      text: CONTRACT_ITEMS[8],
      subs: [
        sub('9a', 'A', 'AC / ADV 验收套件零 todo 零失败(实跑 jest,不看文本)', judgeAcceptanceSuite(acceptance)),
        eviSub('9b', 'B', '「规模测试通过」', [
          '合同 §13.7 的口径:固定 fixture 构造 30、500、2000、10000 四档规模。',
          '仓内已有的规模探针:scripts/probe-member-lock-scale.ts(第 0 批 10000 member lock 短事务原型;手动跑,刻意不进 CI —— 性能读数与机器规格强相关,挂 CI 会造假红)。',
          '仓内**没有**「规模测试通过」的登记位或留痕读数 ⇒ 机器判不了这条。',
          '需要的证据:四档规模的复现命令与读数留痕(合同 §14 要求「规模门达到本批要求并保存复现命令」)。',
        ]),
      ],
    },
    // ⑩ 准备可部署的只读维护版本，而不是只写"必要时只读"
    {
      text: CONTRACT_ITEMS[9],
      subs: [
        eviSub('10a', 'B', '仓内现成的「只读」机制', [
          '合同 §16.4 给了两条路:(i) gate 切为拒绝新写;(ii) 部署只读维护镜像。',
          '(i) 已有执行位:ACTIVITY_V11_WORKFLOW_ENABLED=false 拒绝 v1.1 新写(#1084);但它只覆盖结算真相链,不是全站只读。',
          '(ii) 仓内**没有**全局只读 / 维护模式配置项(无 READ_ONLY / MAINTENANCE_MODE 之类)。',
        ]),
        eviSub('10b', 'C', '「准备可部署的只读维护版本」', [
          '这条要的是**部署侧产物**(可部署的镜像 / 部署配置),不是仓库里的一行代码 ⇒ 仓库无从判断。',
          '需要的证据:可部署的只读维护版本产物(镜像 tag 或部署配置)+ 一次演练记录(合同原文特意写明:不许只写「必要时只读」)。',
        ]),
      ],
    },
  ];

  return items.map((it, i) => ({
    no: i + 1,
    text: it.text,
    kind: weakestKind(it.subs),
    verdict: itemVerdict(it.subs),
    subs: it.subs,
  }));
}

// ══════════════════════════════════════════════════════════════════════════
// 渲染
// ══════════════════════════════════════════════════════════════════════════

const CIRCLED = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩'];
const KIND_LABEL: Record<Kind, string> = {
  A: 'A 机器可判',
  B: 'B 机器可查·人判定',
  C: 'C 只能人判',
};

/**
 * 结论渲染的**唯一**落点(别处不许另判)。两条不对称的规则:
 *
 *   · `fail` 恒渲染成 ❌ —— 不分分型。一条 A 类子判据判死,机器就**证明了这条不成立**,
 *     哪怕它整条的分型是 B/C。第一版在这里写成「非 A 类一律 ⏸」,结果 ⑦(缺 runbook)
 *     与 ⑨(42 条 todo)在摘要里显示成「待维护者确认」—— 把硬未过藏进了待确认,
 *     方向反了但同样是失真。
 *   · `pass` 只在 `kind === 'A'` 时才可能出现(`itemVerdict()` 已在构造上保证),
 *     这里再挡一道:B/C **永远不会**渲染成绿勾。
 */
function renderVerdict(kind: Kind, verdict: Verdict): string {
  if (verdict === 'fail') return '❌ 未过';
  if (verdict === 'pass' && kind === 'A') return '✅ 通过';
  return '⏸ 待维护者确认';
}

function oneLiner(item: ItemResult): string {
  const failed = item.subs.filter((s) => s.kind === 'A' && s.verdict === 'fail');
  if (failed.length > 0) return `${failed.map((s) => s.id).join('/')} 未过:${failed[0].evidence[0]}`;
  const passedA = item.subs.filter((s) => s.kind === 'A');
  const pending = item.subs.filter((s) => s.kind !== 'A');
  const left = passedA.length > 0 ? `A 类 ${passedA.map((s) => s.id).join('/')} 已过` : '无 A 类判据';
  return pending.length === 0 ? left : `${left};待人确认:${pending.map((s) => `${s.id}(${s.kind})`).join('、')}`;
}

function renderControls(controls: readonly { id: string; desc: string; must: 'red' | 'green'; got: boolean }[]): string[] {
  return controls.map((c) => `  ${c.got ? '✓' : '✗'} ${c.id.padEnd(5)} ${c.must === 'red' ? '弄假⇒必红' : '修好⇒必绿'}  ${c.desc}`);
}

function renderItems(items: readonly ItemResult[]): string[] {
  const out: string[] = [];
  for (const it of items) {
    out.push('');
    out.push(`${CIRCLED[it.no - 1]} [${KIND_LABEL[it.kind]}] ${renderVerdict(it.kind, it.verdict)}`);
    out.push(`   合同原文:${it.text}`);
    for (const s of it.subs) {
      out.push(`   ${s.kind} ${s.id.padEnd(4)} ${renderVerdict(s.kind, s.verdict)}  ${s.title}`);
      for (const e of s.evidence) out.push(`        · ${e}`);
    }
  }
  return out;
}

function renderSummary(items: readonly ItemResult[]): string[] {
  return items.map(
    (it) => `${CIRCLED[it.no - 1]} ${it.kind}  ${renderVerdict(it.kind, it.verdict)}  ${oneLiner(it)}`,
  );
}

// ══════════════════════════════════════════════════════════════════════════
// 入口
// ══════════════════════════════════════════════════════════════════════════

function main(): void {
  const argv = process.argv.slice(2);
  const wantJson = argv.includes('--json');
  const selftestOnly = argv.includes('--selftest');
  const log = (s = ''): void => {
    if (!wantJson) console.log(s);
  };

  log('══════════════════════════════════════════════════════════════════════');
  log('SRVF 活动 v1.1 —— 切换前检查(合同 §16.1 十条)');
  log('══════════════════════════════════════════════════════════════════════');
  log(`HEAD:${git(['rev-parse', '--short', 'HEAD']).trim()}   分支:${git(['rev-parse', '--abbrev-ref', 'HEAD']).trim()}`);
  log('');
  log('[自证] 报数之前先证明判据不是恒真的(正对照 + 原文回查)');

  // ── 自证 ①:十条原文逐字对得上合同 ──
  const textErrors = assertContractTextVerbatim();
  // ── 自证 ②:每条 A 类判据弄假必红 / 修好必绿 ──
  const controls = positiveControls().map((c) => {
    const j = c.run();
    return { id: c.id, desc: c.desc, must: c.must, got: c.must === 'red' ? !j.ok : j.ok };
  });
  const badControls = controls.filter((c) => !c.got);

  for (const line of renderControls(controls)) log(line);
  log(`  ${textErrors.length === 0 ? '✓' : '✗'} 原文    十条逐字取自合同 §16.1(${CONTRACT_ITEMS.length} 条回查)`);
  for (const e of textErrors) log(`        · ${e}`);
  log('');
  log(`  自证结果:正对照 ${controls.length - badControls.length}/${controls.length} 按预期,原文回查 ${textErrors.length === 0 ? '通过' : '失败'}`);

  if (badControls.length > 0 || textErrors.length > 0) {
    log('');
    log('✗ 仪器失效 —— 判据自己没有按预期反应,拒绝报十行结论(读数作废,先修仪器)。');
    if (wantJson) {
      console.log(JSON.stringify({ instrumentOk: false, badControls, textErrors }, null, 2));
    }
    process.exit(1);
  }
  if (selftestOnly) {
    log('');
    log('✓ 仪器自证通过(--selftest 只跑到这里,未采数)。');
    if (wantJson) console.log(JSON.stringify({ instrumentOk: true, controls }, null, 2));
    return;
  }

  // ── 采数并报十行 ──
  log('');
  log('[采数] 跑生成物对账(8 条)与验收套件…');
  const items = buildItems();

  log('');
  log('══════════════════════════════════════════════════════════════════════');
  log('逐条详情');
  log('══════════════════════════════════════════════════════════════════════');
  for (const line of renderItems(items)) log(line);

  log('');
  log('══════════════════════════════════════════════════════════════════════');
  log('十行摘要(编号 / 分型 / 结论 / 证据或卡点)');
  log('══════════════════════════════════════════════════════════════════════');
  for (const line of renderSummary(items)) log(line);

  const aSubs = items.flatMap((i) => i.subs).filter((s) => s.kind === 'A');
  const aFailed = aSubs.filter((s) => s.verdict === 'fail');
  const pendingItems = items.filter((i) => i.verdict === 'pending');

  log('');
  log('══════════════════════════════════════════════════════════════════════');
  log(`A 类子判据:${aSubs.length - aFailed.length}/${aSubs.length} 过`);
  if (aFailed.length > 0) {
    log(`❌ 未过(硬,卡开闸):${aFailed.map((s) => s.id).join('、')}`);
    for (const s of aFailed) log(`     ${s.id} ${s.title} —— ${s.evidence[0]}`);
  }
  log(`⏸ 待维护者确认:${pendingItems.length} 条(${pendingItems.map((i) => CIRCLED[i.no - 1]).join('')})`);
  log('');
  if (aFailed.length > 0) {
    log('结论:有 A 类判据未过 ⇒ **尚不可开闸**。');
  } else {
    log('结论:A 类判据全过。**这不等于可以开闸** —— B/C 类仍须维护者逐条确认后才拍板。');
  }
  log('══════════════════════════════════════════════════════════════════════');

  if (wantJson) {
    console.log(JSON.stringify({ instrumentOk: true, items, aTotal: aSubs.length, aFailed: aFailed.map((s) => s.id) }, null, 2));
  }
  process.exit(aFailed.length > 0 ? 1 : 0);
}

main();
