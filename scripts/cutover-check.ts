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

/**
 * ⭐ **签字登记表** —— B/C 类子判据「由人下结论」的唯一落点。
 *
 * 在本刀之前,「下结论」这件事**物理上不存在**:`eviSub()` 把 `verdict` 硬编码成
 * `'pending'`,签一百次也不会变 ⇒ 这道闸设计成了「永远开不了」。
 *
 * 🔴 但**不是「签了就过」** —— 那等于把闸拆了。四种结局:
 *   ① 签了且与机器读数一致        ⇒ ☑ 已签字确认
 *   ② 签了但与机器读数矛盾        ⇒ ❌ 红(并卡退出码)
 *   ③ 没签                        ⇒ ⏸ 待维护者确认(现状)
 *   ④ 签了一条闸里不存在 / 不接受签字的编号 ⇒ ❌ 红
 *
 * 路径写死 = 判据与文档之间有一份合同(同 ⑤-b 登记表与 ⑦ runbook):改名 / 删文件当场红,
 * 不会静默失去这道检查。
 */
const SIGNOFF_REGISTRY = 'docs/ai-harness/CUTOVER_SIGNOFF.md';

/** 结论的**闭集**。写别的词(「大概可以」「基本认可」)⇒ 红 —— 模糊结论不是结论。 */
export const SIGNOFF_CONCLUSIONS: readonly string[] = ['认可', '不认可'];

/** ①-b 那份复核报告 —— 1b 的对拍锚点(报告被改动 / 删除 ⇒ 那次签字所依据的东西已不在)。 */
const REVIEW_REPORT = 'SRVF_活动业务文档_系统性对抗性复核报告_v1.0.md';

/**
 * 可对拍读数的**闭集**。
 *
 * 🔴 为什么要闭集:签字里写 `` `migration-totl` = `99` ``(打错一个字母)时,若判据只是
 * 「查得到就比,查不到就跳过」,这条对拍会**静默失效** —— 本仓 2026-08-26 一天内两次
 * 栽在这个形状(#1184 豁免名单指着已删文件 / #1195 腐烂检测改恒返回空照样全绿)。
 * ⇒ 键不在闭集**即红**,方向是 fail-closed。
 */
export const SIGNOFF_READING_KEYS = [
  'migration-total',
  'backend-contract-version',
  'contract-registry-rows',
  'contract-version-mismatch-count',
  'review-report-sha256-12',
  // ── 2026-08-26 第二批签字新增(6b / 7c / 8b / 4b 各自的锚)────────────────
  // 加键的判别式只有一条:**这条签字若将来不再成立,是哪个仓内读数会先变?**
  // 答不出那个读数的,老老实实写「无 —— 理由」,不要凑一个看着像对拍的东西。
  'gate-read-files',
  'gate-settlement-read-faces',
  'instance-env-flag-count',
  'worker-lease-columns',
  'worker-runbook-sha256-12',
  'seed-sha256-12',
] as const;
export type SignoffReadingKey = (typeof SIGNOFF_READING_KEYS)[number];

/**
 * 读数里**必须非零**的那些键(计数型)。
 *
 * 🔴 为什么单列一张表:本仓纪律是「计数不是装饰,采集器采到 0 条时判据必须红」。
 * 若采集器坏了恒返回 0,而签字里也写着 0,`signoffEntryDefects` 逐字相等 ⇒ **全绿**
 * —— 那就是把对拍锚在一个坏掉的仪器上,比没有对拍更糟。
 *
 * ⚠️ `contract-version-mismatch-count` **刻意不在这里**:它的正确值本来就是 0
 * (五端零不一致),把它算进「必须非零」会把正确状态判成红。
 */
export const SIGNOFF_NONZERO_COUNT_KEYS: readonly SignoffReadingKey[] = [
  'migration-total',
  'contract-registry-rows',
  'gate-read-files',
  'gate-settlement-read-faces',
  'instance-env-flag-count',
  'worker-lease-columns',
];

/** 读数里必须是 12 位十六进制摘要的那些键(采不到时会退化成「(文件不存在)」)。 */
export const SIGNOFF_DIGEST_KEYS: readonly SignoffReadingKey[] = [
  'review-report-sha256-12',
  'worker-runbook-sha256-12',
  'seed-sha256-12',
];

/**
 * 仪器自证:机器现读本身不能是退化值。
 *
 * 这条**先于**逐条验签字跑 —— 读数坏掉时,「签字与机器读数一致」这句话没有意义。
 */
export function judgeSignoffReadings(
  readings: Readonly<Record<string, string>>,
  nonZero: readonly string[] = SIGNOFF_NONZERO_COUNT_KEYS,
  digests: readonly string[] = SIGNOFF_DIGEST_KEYS,
  allKeys: readonly string[] = SIGNOFF_READING_KEYS,
): Judgement {
  const bad: string[] = [];
  for (const k of allKeys) {
    const v = readings[k];
    if (v === undefined || v.trim().length === 0) bad.push(`读数「${k}」缺失或为空 ⇒ 采集器没采到`);
  }
  for (const k of nonZero) {
    const v = readings[k];
    if (v === undefined) continue;
    if (!/^\d+$/.test(v) || Number(v) === 0) {
      bad.push(`读数「${k}」= ${v} —— 计数型读数为 0 / 非数字 ⇒ 采集器失真,拿它对拍等于把签字锚在坏仪器上`);
    }
  }
  for (const k of digests) {
    const v = readings[k];
    if (v === undefined) continue;
    if (!/^[0-9a-f]{12}$/.test(v)) bad.push(`读数「${k}」= ${v} —— 不是 12 位摘要 ⇒ 被锚的文件读不到`);
  }
  return bad.length === 0
    ? { ok: true, evidence: [`${allKeys.length} 个可对拍读数全部非退化(计数非 0、摘要成形)`] }
    : { ok: false, evidence: bad };
}

/**
 * 闸里全部子判据编号的**闭集**。签了闭集外的编号 ⇒ 红(§防腐 ④)。
 *
 * ⚠️ 这份清单与 `buildItems()` 真正产出的编号由 `assertSubIdsClosed()` 每次运行时对拍 ——
 *    加一条子判据却忘了登记进来,当场红。手写清单没有自证 = 装了个没验过的报警器。
 */
export const ALL_SUB_IDS: readonly string[] = [
  '1a', '1b',
  '2a', '2b',
  '3a', '3b',
  '4a', '4b',
  '5a', '5b',
  '6a', '6b',
  '7a', '7b', '7c', '7d', '7e',
  '8a', '8b',
  '9a', '9b',
  '10a', '10b',
];

/**
 * **可签**的子判据 = B/C 类。A 类是机器判的,人签不动 ——
 * 签 A 类编号 ⇒ 红,否则「用一张签字把 9a 的 13 条 todo 抹平」就成立了。
 */
export const SIGNABLE_SUB_IDS: readonly string[] = [
  '1b', '2a', '2b', '3b', '4b', '5b', '6b', '7c', '8b', '9b', '10a', '10b',
];

// ── 分型与结论 ──────────────────────────────────────────────────────────
export type Kind = 'A' | 'B' | 'C';
/**
 * `signed` / `conflict` 是本刀新增的两格。
 *
 * ⚠️ 它们**不破坏**原有不变量「B/C 永不渲染成 ✅ 通过」:`signed` 渲染成 **☑ 已签字确认**,
 *    与机器判出来的 ✅ 视觉上分得开 —— 谁下的结论必须一眼看得出来。
 */
export type Verdict = 'pass' | 'fail' | 'pending' | 'signed' | 'conflict';

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
  // 签字与机器读数矛盾 = 机器**证明了**这份签字不成立 ⇒ 整条红,不许藏进「待确认」。
  if (subs.some((s) => s.verdict === 'conflict')) return 'conflict';
  if (subs.every((s) => s.kind === 'A' && s.verdict === 'pass')) return 'pass';
  // 全部子判据要么是机器判过的 A 类,要么已由维护者签字 ⇒ 这一条到此为止了。
  if (subs.every((s) => (s.kind === 'A' && s.verdict === 'pass') || s.verdict === 'signed')) {
    return 'signed';
  }
  return 'pending';
}

// ══════════════════════════════════════════════════════════════════════════
// 签字登记表:解析 / 逐条验 / 与机器读数对拍(全是纯函数,好让正对照能喂假输入)
// ══════════════════════════════════════════════════════════════════════════

/** 一条签字的「对拍」字段。`none` = 声明无可对拍读数(必须写明为什么)。 */
export type Crosscheck =
  | { readonly kind: 'none'; readonly raw: string; readonly note: string }
  | { readonly kind: 'has'; readonly raw: string; readonly pairs: readonly { key: string; value: string }[] }
  | { readonly kind: 'unknown'; readonly raw: string };

export interface SignoffEntry {
  readonly id: string;
  readonly title: string;
  readonly conclusion: string;
  readonly reason: string;
  readonly signer: string;
  readonly date: string;
  readonly basis: string;
  readonly crosscheck: Crosscheck;
}

export interface SignoffRegistry {
  /** 登记表自报的签字条数。`null` = 声明行缺失 / 被改坏 ⇒ 判据失去输入,按红处理。 */
  readonly declaredCount: number | null;
  readonly entries: readonly SignoffEntry[];
}

/** `YYYY-MM-DD` 且是**真实存在的日历日**。`new Date('2026-02-30')` 会静默回卷成 3 月 2 日。 */
export function isCalendarDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** 解析「对拍」字段。`有 —— \`key\` = \`value\`;…` / `无 —— <理由>`。 */
export function parseCrosscheck(raw: string): Crosscheck {
  const t = raw.trim();
  if (t.startsWith('无')) return { kind: 'none', raw, note: t.slice(1).replace(/^\s*(——|--)\s*/, '').trim() };
  if (!t.startsWith('有')) return { kind: 'unknown', raw };
  const pairs: { key: string; value: string }[] = [];
  for (const m of t.matchAll(/`([^`]+)`\s*=\s*`([^`]*)`/g)) pairs.push({ key: m[1].trim(), value: m[2].trim() });
  return { kind: 'has', raw, pairs };
}

/**
 * 解析签字登记表。
 *
 * 只认 `### <编号> — <标题>` 这一种块头,编号形如 `5b` —— 豁免登记那一节用 `### AC-054 …`,
 * 形状不同,天然不会被误收进签字集合。
 */
export function parseSignoffRegistry(text: string | null): SignoffRegistry | null {
  if (text === null) return null;
  // ⚠️ 括号必须转义:本仓中文正文里的「(」是**半角** `(` —— 不转义就成了捕获组,
  //    正则会去匹配「签字条数机器核对:4 条」(不带括号),**永远匹配不上**。
  //    (本刀写第一版时就踩了这个,读数直接变成「声明行缺失」。)
  const countLine = /^\*\*签字条数\(机器核对\)[:：](\d+) 条\*\*$/m.exec(text);
  const entries: SignoffEntry[] = [];
  let cur: { id: string; title: string; fields: Record<string, string> } | null = null;
  const flush = (): void => {
    if (cur === null) return;
    const f = cur.fields;
    entries.push({
      id: cur.id,
      title: cur.title,
      conclusion: f['结论'] ?? '',
      reason: f['理由'] ?? '',
      signer: f['签字人'] ?? '',
      date: f['日期'] ?? '',
      basis: f['依据'] ?? '',
      crosscheck: parseCrosscheck(f['对拍'] ?? ''),
    });
    cur = null;
  };
  // ⚠️ **围栏内的代码块不算签字。** §2 的填法模板本身长得就像一条签字 ——
  //    第一版没跳围栏,那份模板被当成第五条签字收了进来,当场撞上「同一编号签了两次」。
  //    (这是判据在替我抓错,不是判据坏了;但正确的解析语义就该跳围栏,故在此修。)
  //    误把真签字写进围栏时也不会静默丢失:声明条数与解析条数对不上 ⇒ 红。
  let inFence = false;
  for (const line of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const head = /^###\s+(\d{1,2}[a-z])\s+—\s*(.*)$/.exec(line.trim());
    if (head !== null) {
      flush();
      cur = { id: head[1], title: head[2].trim(), fields: {} };
      continue;
    }
    if (/^#{1,3}\s/.test(line.trim())) {
      flush();
      continue;
    }
    const field = /^-\s+\*\*(结论|理由|签字人|日期|依据|对拍)\*\*\s*[:：]\s*(.*)$/.exec(line.trim());
    if (field !== null && cur !== null) cur.fields[field[1]] = field[2].trim();
  }
  flush();
  return { declaredCount: countLine === null ? null : Number(countLine[1]), entries };
}

/** 一条签字自身的缺陷清单(空 = 这条签字成立)。 */
export function signoffEntryDefects(
  e: SignoffEntry,
  readings: Readonly<Record<string, string>>,
): string[] {
  const out: string[] = [];
  const required: readonly [string, string][] = [
    ['结论', e.conclusion],
    ['理由', e.reason],
    ['签字人', e.signer],
    ['日期', e.date],
    ['依据', e.basis],
    ['对拍', e.crosscheck.raw],
  ];
  for (const [label, v] of required) if (v.trim().length === 0) out.push(`必填项「${label}」为空`);
  if (e.conclusion.trim().length > 0 && !SIGNOFF_CONCLUSIONS.includes(e.conclusion.trim())) {
    out.push(`结论「${e.conclusion}」不在闭集(${SIGNOFF_CONCLUSIONS.join(' / ')})—— 模糊结论不是结论`);
  }
  if (e.date.trim().length > 0 && !isCalendarDate(e.date.trim())) {
    out.push(`日期「${e.date}」不是合法日历日(YYYY-MM-DD)`);
  }
  const cc = e.crosscheck;
  if (cc.kind === 'unknown') {
    if (cc.raw.trim().length > 0) out.push(`「对拍」既不是「有」也不是「无」:${cc.raw}`);
  } else if (cc.kind === 'none') {
    if (cc.note.length === 0) out.push('「对拍」写了「无」却没写为什么无 —— 不许静默地把对拍取消掉');
  } else {
    if (cc.pairs.length === 0) out.push('「对拍」写了「有」却一个读数都没给');
    for (const p of cc.pairs) {
      const actual = readings[p.key];
      if (actual === undefined) {
        out.push(`对拍读数键「${p.key}」不在闭集 ⇒ 这条对拍永远不会被计算(键改名即静默失效)`);
      } else if (actual !== p.value) {
        out.push(`❗签字与机器读数矛盾:「${p.key}」签字当时记 ${p.value},机器现读 ${actual}`);
      }
    }
  }
  return out;
}

export interface SignoffState {
  /** 登记表整体的完整性判决(A 类:参与退出码)。 */
  readonly integrity: Judgement;
  /** 编号 → 该条签字的缺陷(空数组 = 成立)。只含闸里认得的可签编号。 */
  readonly byId: ReadonlyMap<string, { entry: SignoffEntry; defects: readonly string[] }>;
}

/**
 * 逐条验签字 + 出整体完整性判决。
 *
 * 🔴 判据形状刻意是 **fail-closed**:登记表不存在 / 声明行读不到 / 声明条数与解析条数不符,
 *    一律红。空表恒「零腐烂」是空绿 —— 那正是本仓已两次栽过的形状。
 */
export function judgeSignoffRegistry(
  registry: SignoffRegistry | null,
  readings: Readonly<Record<string, string>>,
  allSubIds: readonly string[] = ALL_SUB_IDS,
  signableSubIds: readonly string[] = SIGNABLE_SUB_IDS,
): SignoffState {
  const byId = new Map<string, { entry: SignoffEntry; defects: readonly string[] }>();
  if (registry === null) {
    return {
      integrity: {
        ok: false,
        evidence: [
          `签字登记表 ${SIGNOFF_REGISTRY} **不存在** ⇒ 签字无处可落,这道闸退回「永远开不了」的状态。`,
        ],
      },
      byId,
    };
  }
  const bad: string[] = [];
  if (registry.declaredCount === null) {
    bad.push('登记表缺「**签字条数(机器核对):N 条**」声明行 ⇒ 表被清空 / 少一条都看不见,拒绝当绿');
  } else if (registry.declaredCount !== registry.entries.length) {
    bad.push(
      `声明 ${registry.declaredCount} 条签字,实际解析到 ${registry.entries.length} 条 ` +
        '⇒ 有签字被删 / 块头被改坏 / 解析塌了,读数作废',
    );
  }
  const seen = new Set<string>();
  for (const e of registry.entries) {
    if (seen.has(e.id)) {
      bad.push(`${e.id}:同一编号签了两次 ⇒ 哪一条作数无从判断`);
      continue;
    }
    seen.add(e.id);
    if (!allSubIds.includes(e.id)) {
      bad.push(`${e.id}:闸里根本没有这条子判据 ⇒ 这份签字签的是一个不存在的东西(名单腐烂)`);
      continue;
    }
    if (!signableSubIds.includes(e.id)) {
      bad.push(`${e.id}:这是 A 类(机器可判)子判据,**不接受签字** —— 人签不动机器的结论`);
      continue;
    }
    const defects = signoffEntryDefects(e, readings);
    byId.set(e.id, { entry: e, defects });
    bad.push(...defects.map((d) => `${e.id}:${d}`));
  }
  return {
    integrity:
      bad.length === 0
        ? {
            ok: true,
            evidence: [
              `签字 ${registry.entries.length} 条:编号全部真实且可签、六项齐全、` +
                '对拍读数逐条与机器现读一致',
            ],
          }
        : { ok: false, evidence: bad },
    byId,
  };
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
 * ⑥-a 旧写入口已关闭(代码侧)—— 直接复用 #1084 的结构判据,不重造。
 * ⚠️ 2026-08-26 订正:判据族已由 C1–C7 扩到 **C1–C8**(C8 于 #1165 加入),此处原文点名 C1–C7 已过期。
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
          `C1–C8 零 finding;受闸写入口 v11=${counts.v11GatedEntries} / legacy=${counts.legacyGatedEntries},` +
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

/**
 * 签字可对拍的**机器现读**。
 *
 * 每一条都是「本仓此刻可复算的事实」,不含任何时间量、不含别的仓库的证词:
 *
 * | 键 | 读的是什么 | 它一变说明什么 |
 * |---|---|---|
 * | `migration-total` | `prisma/migrations/` 下的目录数 | 新落了一条 migration ⇒ ③-b「经审查」的覆盖面变了,得重签 |
 * | `backend-contract-version` | `package.json#version` | 后端发过版 ⇒ ⑤-b「五端同一版本」的前提变了,得重签 |
 * | `contract-registry-rows` | 契约版本登记表解析出的行数 | 有人删了一行 ⇒ 缺口被洗掉 |
 * | `contract-version-mismatch-count` | 登记表里与后端版本**不一致**的端数 | 0 → N ⇒ 五端不再对齐,而签字还在 |
 * | `review-report-sha256-12` | ①-b 那份复核报告的内容摘要 | 报告被改 / 被删 ⇒ 那次签字依据的东西已不在 |
 * | `gate-read-files` | C3 文件粒度:接了读面闸的生产文件数 | 多 / 少一个读面 ⇒ ⑥-b 签的那个「闭包」不再是同一个集合 |
 * | `gate-settlement-read-faces` | C8 函数粒度:被判为「对外产出结算量」的读面数 | 冒出第 N+1 处结算量读面 ⇒ ⑥-b 得重签 |
 * | `instance-env-flag-count` | 合同 §16.1 ⑧ 点名的 per-instance env 开关数 | 3 → 4 ⇒ 实例间漂移面变大,⑧-b 的「已知晓」覆盖不到新那个 |
 * | `worker-lease-columns` | `ActivityBatchJob` 上**且被 worker 真用到**的 lease 列数 | 少一列 ⇒ ⑦-c 签字接受的那个「lease 恢复代偿」机制变了 |
 * | `worker-runbook-sha256-12` | ⑦-d 那份 runbook 的内容摘要 | runbook 被改 ⇒ ⑦-c 签字写进去的那份「明确不设 + 四个盲区」已不是原样 |
 * | `seed-sha256-12` | `prisma/seed.ts` 的内容摘要 | 字典 seed 变了 ⇒ ④-b 签的「接受当前状态」里的那个「当前」已经不是了 |
 *
 * ⚠️ 后六个键**只锚身份,不锚正确性** —— 它们回答「你签字时看的那个东西还是不是那个」,
 * 回答不了「那个东西对不对」。别把它们读成「已核对」。
 */
function collectSignoffReadings(pkgVersion: string): Record<SignoffReadingKey, string> {
  const migrationDirs = readdirSync(rel('prisma/migrations'), { withFileTypes: true }).filter((e) =>
    e.isDirectory(),
  ).length;
  const registryText = readOrNull(VERSION_REGISTRY);
  const rows = registryText === null ? [] : parseRegistryRows(registryText);
  const mismatched = rows.filter(
    (r) =>
      r.declared !== REGISTRY_SAME_AS_BACKEND &&
      r.declared !== REGISTRY_NOT_REPORTED &&
      r.declared !== pkgVersion,
  );
  const report = readOrNull(`${CONTRACT_DIR}/${REVIEW_REPORT}`);
  const digest12 = (body: string | null): string =>
    body === null ? '(文件不存在)' : createHash('sha256').update(body, 'utf8').digest('hex').slice(0, 12);

  // ⑥-b 的两个锚:C3 / C8 的**现算**闭包大小。runCriteria() 在 buildItems 里还会再跑一次 ——
  // 刻意不共享:采集与判定分离是本文件的基本姿态,读数这一侧不该依赖那一侧的执行顺序。
  const criteriaCounts = runCriteria().counts;

  // ⑦-c 的锚之一:schema 上声明**且** worker 真的在用的 lease 列数。
  // 与 judgeWorkerLease 同一份列名清单 —— 那边判「齐不齐」,这边报「几列」。
  const schemaText = read(SCHEMA);
  const workerText = read(WORKER_SRC);
  const jobBlock = /model\s+ActivityBatchJob\s*\{([\s\S]*?)\n\}/.exec(schemaText);
  const leaseColumns = ['leaseOwner', 'leaseGeneration', 'leaseExpiresAt'].filter(
    (c) =>
      jobBlock !== null && new RegExp(`^\\s*${c}\\s`, 'm').test(jobBlock[1]) && workerText.includes(c),
  ).length;

  return {
    'migration-total': String(migrationDirs),
    'backend-contract-version': pkgVersion,
    'contract-registry-rows': String(rows.length),
    'contract-version-mismatch-count': String(mismatched.length),
    'review-report-sha256-12': digest12(report),
    'gate-read-files': String(criteriaCounts.readFiles),
    'gate-settlement-read-faces': String(criteriaCounts.settlementReadFaces),
    'instance-env-flag-count': String(INSTANCE_FLAGS.length),
    'worker-lease-columns': String(leaseColumns),
    'worker-runbook-sha256-12': digest12(readOrNull(WORKER_RUNBOOK)),
    'seed-sha256-12': digest12(readOrNull('prisma/seed.ts')),
  };
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
      desc: 'C1–C8 有 finding ⇒ 必红',
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
    // ════════════════════════════════════════════════════════════════════
    // 签字机制的变异对拍(S 系列)
    //
    // 🔴 「签了就过」等于把闸拆了。下面每一条各自弄假**一个维度**,证明这套机制
    //    真的分辨得出来。⚠️ **每条各自成一个控制项**(不是塞进一个断言里)——
    //    塞一起的话第一条红了后面的**从未被执行**,而这在基线全绿时完全看不出来
    //    (`docs/ai-harness/TOOL_TRAPS.md` §6.1;控制项数组是逐条独立跑并逐条报的)。
    // 🔴 只断言「当前登记表是干净的」是不够的:把腐烂检测改成恒返回空**照样全绿**
    //    —— 本仓 2026-08-26 当日实测(#1195)。故每条都是**喂假输入 ⇒ 必须红**。
    // ════════════════════════════════════════════════════════════════════
    ...signoffControls(),
  ];
}

/** S 系列夹具:一条结构完整、对拍全对的签字。 */
const SIGNOFF_FIXTURE_READINGS: Readonly<Record<string, string>> = {
  'migration-total': '99',
  'backend-contract-version': '7.7.7',
};

function signoffBlock(fields: Partial<Record<string, string>> = {}, id = '5b'): string {
  const f: Record<string, string> = {
    结论: '认可',
    理由: '夹具理由',
    签字人: '维护者',
    日期: '2026-08-26',
    依据: '夹具依据',
    对拍: '有 —— `migration-total` = `99`',
    ...fields,
  };
  return [
    `### ${id} — 夹具标题`,
    '',
    ...['结论', '理由', '签字人', '日期', '依据', '对拍'].map((k) => `- **${k}**:${f[k]}`),
    '',
  ].join('\n');
}

function signoffDoc(blocks: readonly string[], declared = blocks.length): string {
  return ['# 夹具', '', `**签字条数(机器核对):${declared} 条**`, '', ...blocks].join('\n');
}

/** 把登记表文本喂进整条链(解析 → 逐条验 → 完整性判决),返回可被正对照直接用的 Judgement。 */
function runSignoff(text: string | null): Judgement {
  return judgeSignoffRegistry(parseSignoffRegistry(text), SIGNOFF_FIXTURE_READINGS).integrity;
}

function signoffControls(): Control[] {
  return [
    {
      id: 'S1',
      desc: '签了一条闸里根本不存在的编号 ⇒ 必红(名单腐烂)',
      must: 'red',
      run: () => runSignoff(signoffDoc([signoffBlock({}, '9z')])),
    },
    {
      id: 'S2',
      desc: '签了一条 A 类(机器可判)编号 ⇒ 必红(人签不动机器的结论)',
      must: 'red',
      run: () => runSignoff(signoffDoc([signoffBlock({}, '9a')])),
    },
    {
      id: 'S3',
      desc: '缺必填项(理由为空)⇒ 必红',
      must: 'red',
      run: () => runSignoff(signoffDoc([signoffBlock({ 理由: '' })])),
    },
    {
      id: 'S4',
      desc: '日期形状对但不是合法日历日(2026-02-30)⇒ 必红',
      must: 'red',
      run: () => runSignoff(signoffDoc([signoffBlock({ 日期: '2026-02-30' })])),
    },
    {
      id: 'S5',
      desc: '结论不在闭集(「大概可以」)⇒ 必红(模糊结论不是结论)',
      must: 'red',
      run: () => runSignoff(signoffDoc([signoffBlock({ 结论: '大概可以' })])),
    },
    {
      id: 'S6',
      desc: '🔴 签字与机器读数矛盾(签字记 98,机器读 99)⇒ 必红 —— 本机制的灵魂',
      must: 'red',
      run: () => runSignoff(signoffDoc([signoffBlock({ 对拍: '有 —— `migration-total` = `98`' })])),
    },
    {
      id: 'S7',
      desc: '对拍读数键不在闭集(打错一个字母)⇒ 必红(否则这条对拍静默失效)',
      must: 'red',
      run: () => runSignoff(signoffDoc([signoffBlock({ 对拍: '有 —— `migration-totl` = `99`' })])),
    },
    {
      id: 'S8',
      desc: '对拍写「有」却一个读数都没给 ⇒ 必红',
      must: 'red',
      run: () => runSignoff(signoffDoc([signoffBlock({ 对拍: '有' })])),
    },
    {
      id: 'S9',
      desc: '对拍写「无」却没写为什么无 ⇒ 必红(不许静默取消对拍)',
      must: 'red',
      run: () => runSignoff(signoffDoc([signoffBlock({ 对拍: '无' })])),
    },
    {
      id: 'S10',
      desc: '同一编号签了两次 ⇒ 必红(哪一条作数无从判断)',
      must: 'red',
      run: () => runSignoff(signoffDoc([signoffBlock(), signoffBlock()], 2)),
    },
    {
      id: 'S11',
      desc: '删掉一条签字但声明条数没跟着改 ⇒ 必红(少一条不许静默)',
      must: 'red',
      run: () => runSignoff(signoffDoc([signoffBlock()], 2)),
    },
    {
      id: 'S12',
      desc: '块头被改坏 ⇒ 解析塌成 0 条 ⇒ 必红(空表恒「零腐烂」是空绿)',
      must: 'red',
      run: () => runSignoff(signoffDoc([signoffBlock().replace('### 5b —', '#### 5b -')], 1)),
    },
    {
      id: 'S13',
      desc: '「签字条数」声明行被删 ⇒ 必红(判据失去输入 ≠ 通过)',
      must: 'red',
      run: () =>
        runSignoff(signoffDoc([signoffBlock()]).replace(/^\*\*签字条数.*$/m, '(声明行被删)')),
    },
    {
      id: 'S14',
      desc: '登记表整个不存在 ⇒ 必红(签字无处可落 = 闸退回「永远开不了」)',
      must: 'red',
      run: () => runSignoff(null),
    },
    {
      id: 'S15',
      desc: '结构完整、对拍全对 ⇒ 必绿(证明它不是恒红)',
      must: 'green',
      run: () => runSignoff(signoffDoc([signoffBlock()])),
    },
    {
      // 实测踩过:§2 的填法模板长得就是一条签字,不跳围栏就会被当成真签字收进来。
      id: 'S15′',
      desc: '``` 围栏内的填法模板不算签字 ⇒ 必绿(条数不受模板影响)',
      must: 'green',
      run: () =>
        runSignoff(signoffDoc([signoffBlock(), ['```md', signoffBlock(), '```', ''].join('\n')], 1)),
    },
    {
      id: 'S15″',
      desc: '把一条真签字误写进围栏 ⇒ 必红(不许静默丢失)',
      must: 'red',
      run: () => runSignoff(signoffDoc([['```md', signoffBlock(), '```', ''].join('\n')], 1)),
    },
    {
      id: 'S16',
      desc: '一条签字都没有(声明 0 条、解析 0 条)⇒ 必绿 —— 「没签」是 ⏸ 不是红',
      must: 'green',
      run: () => runSignoff(signoffDoc([], 0)),
    },
    {
      // 「签了就过」这条路必须在**渲染侧**也堵死:conflict 不许被渲染成 ☑/⏸。
      id: 'S17',
      desc: '渲染侧:矛盾的签字必须渲染成 ❌,不许藏进「待维护者确认」',
      must: 'red',
      run: () => {
        const conflicted: SubCheck = { id: '5b', kind: 'B', title: 't', verdict: 'conflict', evidence: [] };
        const okA: SubCheck = { id: '5a', kind: 'A', title: 't', verdict: 'pass', evidence: [] };
        const renderedSub = renderVerdict('B', 'conflict');
        const renderedItem = renderVerdict('B', itemVerdict([okA, conflicted]));
        return {
          ok: !(renderedSub.startsWith('❌') && renderedItem.startsWith('❌')),
          evidence: [`子判据渲染成「${renderedSub}」,整条渲染成「${renderedItem}」`],
        };
      },
    },
    {
      // 反向:签过字且成立的 B 类,**不许**渲染成机器判的 ✅,必须是 ☑。
      id: 'S18',
      desc: '渲染侧:B/C 签过字渲染成 ☑ 而不是 ✅(谁下的结论必须一眼看得出来)',
      must: 'green',
      run: () => {
        const b = renderVerdict('B', 'signed');
        const a = renderVerdict('A', 'pass');
        return {
          ok: b.startsWith('☑') && a.startsWith('✅') && !b.includes('✅'),
          evidence: [`B 签字渲染「${b}」,A 机判渲染「${a}」`],
        };
      },
    },
    {
      // 编号闭集自证:手写清单漏一条**不产生坏链接**,必须双向比才看得见。
      id: 'S19',
      desc: '编号闭集:ALL_SUB_IDS 漏登记一条 ⇒ 必红(双向比,不是「至少包含」)',
      must: 'red',
      run: () => {
        const fake: ItemResult = {
          no: 1,
          text: 't',
          kind: 'A',
          verdict: 'pass',
          subs: [{ id: '11z', kind: 'A', title: 't', verdict: 'pass', evidence: [] }],
        };
        const problems = assertSubIdsClosed([fake]);
        return { ok: problems.length === 0, evidence: problems.length > 0 ? problems : ['(零 problem)'] };
      },
    },
    // ── R 系列:被对拍的**机器现读**本身不能是退化值 ────────────────────────
    //
    // 🔴 这是「对拍」这套机制最后一个能静默失效的地方:采集器坏了恒返回 0,而签字里
    //    也写着 0 ⇒ 逐字相等 ⇒ 全绿。签字看起来在守,实际锚在一个坏仪器上。
    //    S 系列全都假定读数是真的;R 系列专门验那个假定。
    {
      id: 'R1',
      desc: '计数型读数退化成 0 ⇒ 必红(空集恒等于空集会静默变绿)',
      must: 'red',
      run: () =>
        judgeSignoffReadings({
          ...Object.fromEntries(SIGNOFF_READING_KEYS.map((k) => [k, '1'])),
          ...Object.fromEntries(SIGNOFF_DIGEST_KEYS.map((k) => [k, 'a1b2c3d4e5f6'])),
          'gate-settlement-read-faces': '0',
        }),
    },
    {
      id: 'R2',
      desc: '摘要型读数退化成「(文件不存在)」⇒ 必红(被锚的文件没了,签字却还在)',
      must: 'red',
      run: () =>
        judgeSignoffReadings({
          ...Object.fromEntries(SIGNOFF_READING_KEYS.map((k) => [k, '1'])),
          ...Object.fromEntries(SIGNOFF_DIGEST_KEYS.map((k) => [k, 'a1b2c3d4e5f6'])),
          'worker-runbook-sha256-12': '(文件不存在)',
        }),
    },
    {
      id: 'R3',
      desc: '读数键整个缺失 ⇒ 必红(判据失去输入 ≠ 通过)',
      must: 'red',
      run: () =>
        judgeSignoffReadings({
          ...Object.fromEntries(SIGNOFF_READING_KEYS.filter((k) => k !== 'seed-sha256-12').map((k) => [k, '1'])),
          ...Object.fromEntries(
            SIGNOFF_DIGEST_KEYS.filter((k) => k !== 'seed-sha256-12').map((k) => [k, 'a1b2c3d4e5f6']),
          ),
        }),
    },
    {
      id: 'R4',
      desc: '反向:一份形状正常的读数 ⇒ 必绿(证明 R 系列不是恒红)',
      must: 'green',
      run: () =>
        judgeSignoffReadings({
          ...Object.fromEntries(SIGNOFF_READING_KEYS.map((k) => [k, '1'])),
          ...Object.fromEntries(SIGNOFF_DIGEST_KEYS.map((k) => [k, 'a1b2c3d4e5f6'])),
          // 这一个的正确值本来就是 0 —— 它必须**不**被「必须非零」误伤。
          'contract-version-mismatch-count': '0',
        }),
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

/**
 * B/C 子判据:机器只出证据,**结论由人在签字登记表里下**。
 *
 * 本刀之前这里硬编码 `verdict: 'pending'` ⇒ 签字这件事物理上不存在。现在三分:
 * 没签 ⇒ `pending`(现状不变);签了且成立 ⇒ `signed`;签了但有缺陷 / 与机器读数矛盾 ⇒ `conflict`。
 *
 * ⚠️ 签字的**证据行**由机器追加在原证据之后,不覆盖原证据 —— 维护者当时看到的读数
 *    与他签的字必须同屏可见,否则「他到底看着什么签的」下一个人无从复核。
 */
function eviSub(id: string, kind: 'B' | 'C', title: string, evidence: string[]): SubCheck {
  return { id, kind, title, verdict: 'pending', evidence };
}

/**
 * 把签字盖到一条 B/C 子判据上(纯函数,好让正对照能喂假签字)。
 *
 * ⚠️ 签字的证据行**追加**在机器证据之后,不覆盖它 —— 维护者当时看到的读数与他签的字
 *    必须同屏可见,否则「他到底看着什么签的」下一个人无从复核。
 */
export function applySignoff(s: SubCheck, signoff: SignoffState): SubCheck {
  if (s.kind === 'A') return s;
  const signed = signoff.byId.get(s.id);
  if (signed === undefined) return s;
  const e = signed.entry;
  const lines = [
    ...s.evidence,
    `───── 维护者签字(${SIGNOFF_REGISTRY})─────`,
    `结论:${e.conclusion} · 签字人:${e.signer} · 日期:${e.date}`,
    `理由:${e.reason}`,
    `依据:${e.basis}`,
    `对拍:${e.crosscheck.raw}`,
  ];
  return signed.defects.length === 0
    ? { ...s, verdict: 'signed', evidence: lines }
    : { ...s, verdict: 'conflict', evidence: [...lines, ...signed.defects.map((d) => `❌ ${d}`)] };
}

function buildItems(signoff: SignoffState): ItemResult[] {
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
          '⚠️ 本刀**未做**那两份登记表,已登记为 docs/ai-harness/NEXT_TASKS.md 的 P2-23;签字只锚住 seed 的**身份**(seed-sha256-12),锚不住 audit events —— 后者连一个可摘要的落点都没有。',
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
          '旧写入口已关闭(代码侧):复用 #1084 的 C1–C8 结构判据',
          judgeV11GateCriteria(criteria.findings, criteria.counts as unknown as Record<string, number>),
        ),
        eviSub('6b', 'B', '「旧读者清单全部切新账本」', [
          `C3(文件粒度)扫到并确认接闸的读面文件:${criteria.counts.readFiles} 个(它们都经 participationReadSource() 问闸)。`,
          // ⚠️ 2026-08-26 订正:本条原文写的是「C1–C7」,而 C8 是 2026-08-24(#1165)加的,
          //    它恰恰就是「这几个是不是全部」那一半 —— 原文因此低报了闸的实际覆盖面。
          `C8(函数粒度,**结构性发现面**)判定为「对外产出结算量」的读面:${criteria.counts.settlementReadFaces} 个,` +
            '逐个要求问闸;发现面是 collectProdFiles() 现取 + AST 判「select 里有没有 serviceHours / contributionPoints」,' +
            '**不是硬编码文件名** ⇒ 新冒出第 5 处会自动进入看守。',
          '⇒ 机器能证明的比原文多:在「读 attendanceRecord 的结算列并对外产出」这个口径内,**闭包是机器现算的**。',
          '⚠️ 但机器仍证明不了的是**口径本身**:「旧读者」是否只等于这个口径(还是应含任何读 ActivityCheckIn / ' +
            'AttendanceSheet 的地方、含 $queryRaw 裸列名),要由维护者定;口径定错时 C8 会**对定义外的读者结构性失明**。',
          '需要的证据:维护者认可的「旧读者」口径 + 一份与 C8 发现面**双向比对**的登记表(漏登记一个真读者 ⇒ 红)。',
          '⚠️ 本刀**未做**这份登记表,理由已登记在 docs/ai-harness/NEXT_TASKS.md 的 P2-22(要动红区 scripts/check-*.ts 才能把 C8 的**名字**导出来,不只是计数)。',
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
          '合同 §16.4 给了两条路:(i) gate 切为拒绝新写;(ii) 部署只读维护镜像。维护者 2026-08-26 拍板走 (i),用现成的闸、不建镜像。',
          '(i) 已落地为闸的**第三态** ACTIVITY_WORKFLOW_READONLY=true:两个写方向一起拒(具名码 20158 / 503),读面取数逐字不变(§16.5 要求即使只读也可查询导出)。',
          '   ⭐ 它解的是二值闸解不了的那一格:上线后把 ACTIVITY_V11_WORKFLOW_ENABLED 关掉会**重新放开旧考勤写**,而 §16.4 第 5 条禁止「切回旧表写入」。',
          '   判据:src/common/activity-workflow/activity-workflow-readonly.spec.ts —— 四态穷举无混合态 + 只读位纯减法 + 关态行为逐字不变,每维各自成 it。',
          '🔴 **边界**:只读态继承闸本身的范围 = **结算真相链**,报名 / 活动编辑 / 通知 / 用户管理照常可写 ⇒ **不是全站只读**。',
          '   为什么只冻一半(维护者 2026-08-26 拍板,原话):「出问题最可能出在结算(并发 / 关账 / 更正 / 账本最复杂);而报名、查数据这些**不产生新账**,冻它们没有止血作用,只是让人用不了。随时可以再加『全站只读』,反过来很难。」',
          '   怎么用:上线后发现结算在**持续产生错账**时,按下它立刻止血,而系统其余部分照常。',
          '(ii) 仓内仍**没有**只读维护镜像或部署侧产物,也没有全站级 READ_ONLY / MAINTENANCE_MODE。',
        ]),
        eviSub('10b', 'C', '「准备可部署的只读维护版本」', [
          '这条要的是**部署侧产物**(可部署的镜像 / 部署配置),不是仓库里的一行代码 ⇒ 仓库无从判断。',
          '需要的证据:可部署的只读维护版本产物(镜像 tag 或部署配置)+ 一次演练记录(合同原文特意写明:不许只写「必要时只读」)。',
        ]),
      ],
    },
  ];

  return items.map((it, i) => {
    // 签字统一在这里盖上去(单一落点),`eviSub` 那边保持「机器只出证据」不变。
    const subs = it.subs.map((s) => applySignoff(s, signoff));
    return {
      no: i + 1,
      text: it.text,
      kind: weakestKind(subs),
      verdict: itemVerdict(subs),
      subs,
    };
  });
}

/**
 * 自证:`ALL_SUB_IDS` / `SIGNABLE_SUB_IDS` 两份手写清单必须与 `buildItems()` 真正产出的
 * 编号**双向相等**。
 *
 * 🔴 少登记一条**不产生任何坏链接** —— 那条编号会静默变成「签了也没人认」或反过来
 *    「A 类编号也能被签」。这与本仓 README 清单那次是同一个形状,故必须双向比。
 */
export function assertSubIdsClosed(items: readonly ItemResult[]): string[] {
  const actual = items.flatMap((i) => i.subs);
  const actualIds = actual.map((s) => s.id);
  const actualSignable = actual.filter((s) => s.kind !== 'A').map((s) => s.id);
  const problems: string[] = [];
  const diff = (a: readonly string[], b: readonly string[]): string[] => a.filter((x) => !b.includes(x));
  const missing = diff(actualIds, ALL_SUB_IDS);
  const stale = diff(ALL_SUB_IDS, actualIds);
  if (missing.length > 0) problems.push(`ALL_SUB_IDS 漏登记:${missing.join('、')}`);
  if (stale.length > 0) problems.push(`ALL_SUB_IDS 里有闸中已不存在的编号:${stale.join('、')}`);
  const sMissing = diff(actualSignable, SIGNABLE_SUB_IDS);
  const sStale = diff(SIGNABLE_SUB_IDS, actualSignable);
  if (sMissing.length > 0) problems.push(`SIGNABLE_SUB_IDS 漏登记 B/C 编号:${sMissing.join('、')}`);
  if (sStale.length > 0) problems.push(`SIGNABLE_SUB_IDS 里有非 B/C 或已不存在的编号:${sStale.join('、')}`);
  return problems;
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
 *   · 本刀新增的 `signed` 渲染成 **☑ 已签字确认**,与机器判出来的 ✅ 视觉上分得开 ——
 *     「谁下的这个结论」必须一眼看得出来,不许让人签的字冒充机器判的。
 *   · `conflict` 渲染成 ❌:签字与机器读数矛盾时,机器**证明了**这份签字不成立。
 */
function renderVerdict(kind: Kind, verdict: Verdict): string {
  if (verdict === 'fail') return '❌ 未过';
  if (verdict === 'conflict') return '❌ 签字与机器读数矛盾';
  if (verdict === 'pass' && kind === 'A') return '✅ 通过';
  if (verdict === 'signed') return '☑ 已签字确认';
  return '⏸ 待维护者确认';
}

function oneLiner(item: ItemResult): string {
  const failed = item.subs.filter((s) => s.kind === 'A' && s.verdict === 'fail');
  if (failed.length > 0) return `${failed.map((s) => s.id).join('/')} 未过:${failed[0].evidence[0]}`;
  const conflicts = item.subs.filter((s) => s.verdict === 'conflict');
  if (conflicts.length > 0) {
    const first = conflicts[0].evidence.filter((e) => e.startsWith('❌'))[0] ?? '签字有缺陷';
    return `${conflicts.map((s) => s.id).join('/')} 签字不成立:${first}`;
  }
  const passedA = item.subs.filter((s) => s.kind === 'A');
  const signed = item.subs.filter((s) => s.verdict === 'signed');
  const pending = item.subs.filter((s) => s.kind !== 'A' && s.verdict === 'pending');
  const left = passedA.length > 0 ? `A 类 ${passedA.map((s) => s.id).join('/')} 已过` : '无 A 类判据';
  const parts = [left];
  if (signed.length > 0) {
    parts.push(`已签字:${signed.map((s) => `${s.id}(${s.kind})`).join('、')}`);
  }
  if (pending.length > 0) {
    parts.push(`待人确认:${pending.map((s) => `${s.id}(${s.kind})`).join('、')}`);
  }
  return parts.join(';');
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
  const pkgVersion = (JSON.parse(read('package.json')) as { version: string }).version;
  const signoffReadings = collectSignoffReadings(pkgVersion);
  // 🔴 先验仪器:读数退化时,「签字与机器读数一致」这句话没有意义(0 == 0 是空绿)。
  const readingsSane = judgeSignoffReadings(signoffReadings);
  const signoff = judgeSignoffRegistry(parseSignoffRegistry(readOrNull(SIGNOFF_REGISTRY)), signoffReadings);
  const items = buildItems(signoff);
  const idProblems = assertSubIdsClosed(items);

  log('');
  log('══════════════════════════════════════════════════════════════════════');
  log(`签字登记(${SIGNOFF_REGISTRY})`);
  log('══════════════════════════════════════════════════════════════════════');
  log('  机器现读(签字里的对拍值必须与这些逐字相等):');
  for (const key of SIGNOFF_READING_KEYS) log(`    ${key.padEnd(32)} = ${signoffReadings[key]}`);
  log('');
  log(`  ${readingsSane.ok ? '✓' : '✗'} 机器现读非退化(先验仪器,再谈「一致」)`);
  for (const e of readingsSane.evidence) log(`      · ${e}`);
  log('');
  log(`  ${signoff.integrity.ok && idProblems.length === 0 ? '✓' : '✗'} 签字登记表完整性`);
  for (const e of signoff.integrity.evidence) log(`      · ${e}`);
  for (const p of idProblems) log(`      · 编号闭集自证:${p}`);

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

  const allSubs = items.flatMap((i) => i.subs);
  const aSubs = allSubs.filter((s) => s.kind === 'A');
  const aFailed = aSubs.filter((s) => s.verdict === 'fail');
  const conflicts = allSubs.filter((s) => s.verdict === 'conflict');
  const signedSubs = allSubs.filter((s) => s.verdict === 'signed');
  const pendingItems = items.filter((i) => i.verdict === 'pending');
  const signedItems = items.filter((i) => i.verdict === 'signed');
  // 退出码 = A 类判据 ∪ 签字登记表自身的缺陷。后者也是**机器完全可判**的:
  // 「签了不存在的编号」「签字与机器读数矛盾」都不需要人来下结论 ⇒ 拿它卡退出码不制造永久红。
  const signoffBad = !signoff.integrity.ok || idProblems.length > 0 || !readingsSane.ok;

  log('');
  log('══════════════════════════════════════════════════════════════════════');
  log(`A 类子判据:${aSubs.length - aFailed.length}/${aSubs.length} 过`);
  if (aFailed.length > 0) {
    log(`❌ 未过(硬,卡开闸):${aFailed.map((s) => s.id).join('、')}`);
    for (const s of aFailed) log(`     ${s.id} ${s.title} —— ${s.evidence[0]}`);
  }
  if (conflicts.length > 0) {
    log(`❌ 签字不成立(硬,卡开闸):${conflicts.map((s) => s.id).join('、')}`);
  }
  log(
    `☑ 已签字确认:${signedSubs.length} 条子判据` +
      `(${signedSubs.map((s) => s.id).join('、') || '—'});整条收口 ${signedItems.length} 条` +
      `(${signedItems.map((i) => CIRCLED[i.no - 1]).join('') || '—'})`,
  );
  log(`⏸ 待维护者确认:${pendingItems.length} 条(${pendingItems.map((i) => CIRCLED[i.no - 1]).join('') || '—'})`);
  log('');
  if (aFailed.length > 0 || signoffBad) {
    log('结论:有 A 类判据未过或签字登记表有缺陷 ⇒ **尚不可开闸**。');
  } else if (pendingItems.length > 0) {
    log('结论:A 类判据全过。**这不等于可以开闸** —— 仍有未签字的 B/C 类待维护者逐条确认。');
  } else {
    log('结论:A 类判据全过,且 B/C 类已逐条签字并与机器读数一致 ⇒ 十条到此为止。');
  }
  log('══════════════════════════════════════════════════════════════════════');

  if (wantJson) {
    console.log(
      JSON.stringify(
        {
          instrumentOk: true,
          items,
          aTotal: aSubs.length,
          aFailed: aFailed.map((s) => s.id),
          signoffReadings,
          signoffOk: !signoffBad,
          signed: signedSubs.map((s) => s.id),
          conflicts: conflicts.map((s) => s.id),
        },
        null,
        2,
      ),
    );
  }
  process.exit(aFailed.length > 0 || signoffBad ? 1 : 0);
}

main();
