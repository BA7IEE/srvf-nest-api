#!/usr/bin/env tsx
/**
 * check-codemap.ts — CODEMAP 漂移检查
 *
 * 用途:扫描 CODEMAP.md 与当前源码结构的**结构性**漂移,输出 PASS / WARN / FAIL / INFO。
 * 只读检查,不修改任何文件。已接入 CI(`pnpm docs:codemap:check` 的第二段)。
 *
 * 与 generate-codemap.ts 的分工(Harness 3.0 P4b):
 *   生成器负责「机器能算出来的数字」(体量列 / migration 计数 / e2e spec 数),
 *   新鲜度由 `--check` 逐字 diff 保证;本脚本只查**生成器管不到的结构关系** ——
 *   模块存在性双向、module-local CLAUDE.md 是否被引用、相对链接是否解析得开、
 *   god-service 阈值、prisma/CLAUDE.md 这类仍靠人手写的数字。
 *   **凡是「拿生成器输出跟生成器输入比」的检查一律删掉** —— 那种检查恒 PASS,
 *   只会制造覆盖率的错觉。
 *
 * 运行:`pnpm docs:codemap:check`
 *
 * 退出码:
 *   0 — 无 FAIL(WARN / INFO 不导致非 0)
 *   1 — 存在 FAIL(模块结构性漂移)
 *
 * 检查项:
 *   A. modules-in-codemap         — src/modules/* 是否都在 CODEMAP 表格中 (FAIL on miss)
 *   B. codemap-modules-real       — CODEMAP 模块是否真实存在 (FAIL on stale)
 *   C. claude-md-referenced       — 已存在 module-local CLAUDE.md 是否在 CODEMAP 中被引用 (WARN)
 *   D. service-loc-*              — 尺寸阈值:god-service >=700 (WARN) / large >=500 (INFO)
 *   E. referenced-paths-exist     — CODEMAP 中相对路径 markdown 链接是否存在 (WARN)
 *   F. migration-count-matches    — prisma/migrations/ 实际数 vs prisma/CLAUDE.md 声明 (FAIL on drift)
 *                                   (CODEMAP 侧已是生成物,不在此列)
 *   G. service-size-*             — 尺寸棘轮(Phase 6-A),`--service-size` 子命令,**恒 report**
 *
 * 尺寸棘轮子命令(Phase 6-A):
 *   `tsx scripts/check-codemap.ts --service-size`          基线对照报告(有发现则退出 1;
 *                                                          report 期的不阻断由 CI 侧 `|| true` 承担)
 *   `tsx scripts/check-codemap.ts --service-size --write`  重新生成基线(红区,须维护者授权)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import * as ts from 'typescript';

type Severity = 'PASS' | 'WARN' | 'FAIL' | 'INFO';

interface CheckResult {
  id: string;
  severity: Severity;
  summary: string;
  details?: string[];
}

const repoRoot = process.cwd();
const codemapRelPath = 'CODEMAP.md';
const codemapAbsPath = path.join(repoRoot, codemapRelPath);

// ---------------------------------------------------------------------------
// File loaders
// ---------------------------------------------------------------------------

function readCodemap(): string {
  if (!fs.existsSync(codemapAbsPath)) {
    return '';
  }
  return fs.readFileSync(codemapAbsPath, 'utf8');
}

function listRealModules(): string[] {
  const modulesDir = path.join(repoRoot, 'src', 'modules');
  if (!fs.existsSync(modulesDir)) return [];
  return fs
    .readdirSync(modulesDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

// Matches `wc -l` semantics: count trailing newlines, not split segments.
function countLines(content: string): number {
  const m = content.match(/\n/g);
  return m ? m.length : 0;
}

function listClaudeMdUnderDirs(parentRelDirs: string[]): string[] {
  const found: string[] = [];
  for (const parentRel of parentRelDirs) {
    const parentAbs = path.join(repoRoot, parentRel);
    if (!fs.existsSync(parentAbs)) continue;
    for (const entry of fs.readdirSync(parentAbs, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const claudeAbs = path.join(parentAbs, entry.name, 'CLAUDE.md');
      if (fs.existsSync(claudeAbs)) {
        const rel = path.relative(repoRoot, claudeAbs).split(path.sep).join('/');
        found.push(rel);
      }
    }
  }
  return found.sort();
}

// ---------------------------------------------------------------------------
// 尺寸度量口径(Phase 6-A —— 全仓唯一一套,service-loc-* 与尺寸棘轮共用)
// ---------------------------------------------------------------------------
//
// 【度量】非注释非空行(NCLOC),不是物理行。两条理由,第二条才是决定性的:
//   ① 物理行会把「注释详尽」读成「文件臃肿」。实测中位数 净/物理 ≈ 91%,
//      但离群显著:certificates.service.ts 66%(1122 物理 → 739 净)、users 75%。
//   ② **反向激励** —— 物理行棘轮下,删掉文件头的模块级铁律注释就能「达标」。
//      本仓恰恰把模块铁律写在文件头注释里,那是约束 AI 的主要载体;
//      一条会奖励「删注释」的棘轮,是在拆自己的地基。这条与 ① 无关且更硬。
//
// 剥注释用 TypeScript 自己的 scanner,不用正则:字符串里的 `//`、正则字面量里的
// `/*`、模板串里的换行,正则一律会数错,而这三种在本仓都真实存在。
//
// 【发现面】`src/**` 下的 `*.service.ts` / `*-orchestrator.ts` / `*.handlers.ts`,
// 递归、排除 `*.spec.ts`。旧口径只扫 `src/modules/<模块>/*.service.ts`(不递归、
// 只认 .service.ts),**结构上看不见**全仓最大的代码文件
// `attachment-storage-orchestrator.ts`(净 2518)与 `notification-outbox.handlers.ts`(净 1331)。
// 「最大的那个文件不在检查视野里」是旧口径的硬缺陷,不是阈值问题。
//
// 【阈值】700,**复用既有 god-service 阈值**(AGENTS/goal §0:不得另立第二套标准)。
// 换个数字就意味着仓库里同时存在两个尺寸标准(WARN 一个、棘轮一个),
// 那正是「第二套标准」本身。阈值语义随口径改为 `>=`(旧为 `>`)。

const SERVICE_SIZE_METRIC = 'non-comment-non-blank-lines';
const SERVICE_SIZE_THRESHOLD = 700;
const SERVICE_SIZE_LARGE_THRESHOLD = 500;
const SERVICE_SIZE_SUFFIXES = ['.service.ts', '-orchestrator.ts', '.handlers.ts'] as const;
const SERVICE_SIZE_ROOT = 'src';

/**
 * 非注释非空行。用 TS scanner 把注释区间抹成空格(保留换行)后数含非空白字符的行。
 *
 * 导出是为了让 scripts/harness-guards.selftest.ts 直接喂合成样例做阳性对照 ——
 * 「纯注释膨胀不得触发」这条口径必须有证据,而不是靠读代码相信。
 */
export function measureNcloc(content: string): number {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    /* skipTrivia */ false,
    ts.LanguageVariant.Standard,
    content,
  );
  const chars = [...content];
  let token = scanner.scan();
  while (token !== ts.SyntaxKind.EndOfFileToken) {
    if (
      token === ts.SyntaxKind.SingleLineCommentTrivia ||
      token === ts.SyntaxKind.MultiLineCommentTrivia
    ) {
      for (let i = scanner.getTokenStart(); i < scanner.getTokenEnd(); i++) {
        if (chars[i] !== '\n' && chars[i] !== '\r') chars[i] = ' ';
      }
    }
    token = scanner.scan();
  }
  let count = 0;
  for (const line of chars.join('').split('\n')) {
    if (line.trim().length > 0) count++;
  }
  return count;
}

/** 发现面判据:导出供 selftest 钉住「orchestrator / handlers 也算数」。 */
export function isSizedUnit(relPath: string): boolean {
  if (!relPath.startsWith(`${SERVICE_SIZE_ROOT}/`)) return false;
  if (relPath.endsWith('.spec.ts')) return false;
  return SERVICE_SIZE_SUFFIXES.some((s) => relPath.endsWith(s));
}

export interface ServiceEntry {
  relPath: string;
  module: string;
  basename: string;
  /** 判据值:非注释非空行。 */
  loc: number;
  /** **仅供人看**的物理行(wc -l 语义),从不参与任何判定,也不写进基线。 */
  physicalLoc: number;
}

/** `src/modules/<mod>/…` → `<mod>`;其余取前两段(如 `src/database`)作归属。 */
function domainOf(relPath: string): string {
  const m = /^src\/modules\/([^/]+)\//.exec(relPath);
  if (m) return m[1];
  return relPath.split('/').slice(0, 2).join('/');
}

function walkFiles(absDir: string, out: string[]): void {
  for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
    const abs = path.join(absDir, entry.name);
    if (entry.isDirectory()) walkFiles(abs, out);
    else if (entry.isFile()) out.push(abs);
  }
}

function listServiceFiles(): ServiceEntry[] {
  const rootAbs = path.join(repoRoot, SERVICE_SIZE_ROOT);
  if (!fs.existsSync(rootAbs)) return [];
  const abss: string[] = [];
  walkFiles(rootAbs, abss);
  const out: ServiceEntry[] = [];
  for (const abs of abss) {
    const relPath = path.relative(repoRoot, abs).split(path.sep).join('/');
    if (!isSizedUnit(relPath)) continue;
    const content = fs.readFileSync(abs, 'utf8');
    out.push({
      relPath,
      module: domainOf(relPath),
      basename: path.basename(relPath),
      loc: measureNcloc(content),
      physicalLoc: countLines(content),
    });
  }
  return out.sort((a, b) => b.loc - a.loc || a.relPath.localeCompare(b.relPath));
}

// Count migration directories under prisma/migrations/ (matches `ls -d prisma/migrations/*/`;
// 只数子目录,忽略 migration_lock.toml 文件)。
function countMigrationDirs(): number {
  const migrationsDir = path.join(repoRoot, 'prisma', 'migrations');
  if (!fs.existsSync(migrationsDir)) return 0;
  return fs.readdirSync(migrationsDir, { withFileTypes: true }).filter((d) => d.isDirectory())
    .length;
}

function readRepoFile(relPath: string): string {
  const abs = path.join(repoRoot, relPath);
  return fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '';
}

// ---------------------------------------------------------------------------
// CODEMAP parsers
// ---------------------------------------------------------------------------

const MODULES_SECTION_RE = /^##\s+src\/modules\//;
const ANY_SECTION_RE = /^##\s+/;
const MODULE_ROW_RE = /^\|\s*`([a-z0-9-]+)\/`/;
const MD_LINK_RE = /\[[^\]]*\]\(([^)]+)\)/g;
// 形如 "12 个 migration"(CODEMAP.md `migrations/` 行 + prisma/CLAUDE.md 累计行共用此措辞)。
const MIGRATION_COUNT_RE = /(\d+)\s*个\s*migration/;

function* iterModulesSection(codemap: string): Generator<string> {
  const lines = codemap.split('\n');
  let inside = false;
  for (const line of lines) {
    if (MODULES_SECTION_RE.test(line)) {
      inside = true;
      continue;
    }
    if (inside && ANY_SECTION_RE.test(line)) return;
    if (inside) yield line;
  }
}

function parseCodemapModules(codemap: string): string[] {
  const out: string[] = [];
  for (const line of iterModulesSection(codemap)) {
    const m = MODULE_ROW_RE.exec(line);
    if (m) out.push(m[1]);
  }
  return out;
}

function extractRelativeLinks(codemap: string): string[] {
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  // Reset state for safety in case the regex was reused.
  MD_LINK_RE.lastIndex = 0;
  while ((m = MD_LINK_RE.exec(codemap)) !== null) {
    let target = m[1].trim();
    if (target === '') continue;
    if (/^https?:\/\//i.test(target)) continue;
    if (target.startsWith('#')) continue;
    if (target.startsWith('mailto:')) continue;
    const hashIdx = target.indexOf('#');
    if (hashIdx >= 0) target = target.slice(0, hashIdx);
    if (target === '') continue;
    seen.add(target);
  }
  return [...seen].sort();
}

// 从一份文档内容里抽取声明的 migration 数(取首个 "N 个 migration");无声明返回 null。
function parseDeclaredMigrationCount(content: string): number | null {
  const m = MIGRATION_COUNT_RE.exec(content);
  return m ? parseInt(m[1], 10) : null;
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

function checkModulesInCodemap(real: string[], declared: string[]): CheckResult {
  const declaredSet = new Set(declared);
  const missing = real.filter((m) => !declaredSet.has(m));
  if (missing.length === 0) {
    return {
      id: 'modules-in-codemap',
      severity: 'PASS',
      summary: `${real.length}/${real.length} present`,
    };
  }
  return {
    id: 'modules-in-codemap',
    severity: 'FAIL',
    summary: `${missing.length} real module(s) missing from CODEMAP`,
    details: missing.map((m) => `src/modules/${m}/ (exists on disk, not in CODEMAP)`),
  };
}

function checkCodemapModulesReal(real: string[], declared: string[]): CheckResult {
  const realSet = new Set(real);
  const stale = declared.filter((m) => !realSet.has(m));
  if (stale.length === 0) {
    return {
      id: 'codemap-modules-real',
      severity: 'PASS',
      summary: `${declared.length}/${declared.length} exist`,
    };
  }
  return {
    id: 'codemap-modules-real',
    severity: 'FAIL',
    summary: `${stale.length} stale module(s) in CODEMAP`,
    details: stale.map((m) => `src/modules/${m}/ (in CODEMAP, not on disk)`),
  };
}

function checkClaudeMdReferenced(claudeMdPaths: string[], codemap: string): CheckResult {
  const unreferenced = claudeMdPaths.filter((p) => !codemap.includes(p));
  if (claudeMdPaths.length === 0) {
    return {
      id: 'claude-md-referenced',
      severity: 'PASS',
      summary: 'no module-local CLAUDE.md to check',
    };
  }
  if (unreferenced.length === 0) {
    return {
      id: 'claude-md-referenced',
      severity: 'PASS',
      summary: `${claudeMdPaths.length}/${claudeMdPaths.length} referenced`,
    };
  }
  return {
    id: 'claude-md-referenced',
    severity: 'WARN',
    summary: `${unreferenced.length} unreferenced (of ${claudeMdPaths.length})`,
    details: unreferenced,
  };
}

function checkServiceLoc(services: ServiceEntry[]): CheckResult[] {
  const results: CheckResult[] = [];

  const god = services.filter((s) => s.loc >= SERVICE_SIZE_THRESHOLD);
  const large = services.filter(
    (s) => s.loc >= SERVICE_SIZE_LARGE_THRESHOLD && s.loc < SERVICE_SIZE_THRESHOLD,
  );

  if (god.length === 0) {
    results.push({
      id: 'service-loc-godservice',
      severity: 'PASS',
      summary: `no unit reaches ${SERVICE_SIZE_THRESHOLD} ${SERVICE_SIZE_METRIC}`,
    });
  } else {
    results.push({
      id: 'service-loc-godservice',
      severity: 'WARN',
      summary: `${god.length} god-service candidate(s) (>= ${SERVICE_SIZE_THRESHOLD} ${SERVICE_SIZE_METRIC})`,
      details: god.map((s) => `${s.relPath}: ${s.loc} (physical ${s.physicalLoc})`),
    });
  }

  if (large.length > 0) {
    results.push({
      id: 'service-loc-large',
      severity: 'INFO',
      summary: `${large.length} large unit(s) (${SERVICE_SIZE_LARGE_THRESHOLD} <= metric < ${SERVICE_SIZE_THRESHOLD})`,
      details: large.map((s) => `${s.relPath}: ${s.loc} (physical ${s.physicalLoc})`),
    });
  }

  // 原 `service-loc-declared-drift`(比对 CODEMAP 声明 LOC 与磁盘实际)已于 Harness 3.0
  // P4b 删除:体量列与模块行的 `service NNNNL` 现由 scripts/generate-codemap.ts 写入,
  // 再拿它跟磁盘比对就是拿生成器的输出跟生成器的输入比 —— **恒 PASS 的自证**。
  // 新鲜度改由 `pnpm docs:codemap:check`(重新生成并逐字 diff)承担。
  // 保留在本函数里的两项(godservice / large)读的是磁盘真源、不读文档,不是自证。
  return results;
}

// ---------------------------------------------------------------------------
// 尺寸棘轮(Phase 6-A)—— **恒 report**,本刀不转 blocking
// ---------------------------------------------------------------------------
//
// 判据三条(v4 §11 Phase 6「具名基线只增即红」):
//   ① 基线内文件:度量值**只减不增**,涨了就报(附 当前 vs 基线 vs 增量);
//   ② 基线外新文件越过阈值:报,并提示入册须走授权 ——
//      否则「把巨无霸拆成两个次巨无霸」可以静默入册,棘轮等于没有;
//   ③ 拆分识别:基线文件变小 / 消失,而**同域**冒出新的超阈值文件时并列显示,
//      让人一眼分得清「真拆分」还是「机械切分」。**不自动放行也不自动拒绝** ——
//      这是刻意的:自动判定拆分质量需要语义理解,机器给不出,给了就是假判据。
//
// 为什么此刻不进 harness/ratchet-registry.json(三条结构原因,实测 2026-08-15):
//   ① 注册表的 `rule` 字段必须是**真实 ESLint 规则名**:eslint.harness.mjs 末尾
//      按注册表遍历,为基线里每个文件生成 `rules: { [rule]: ['error', { exempt }] }`。
//      「文件多大」没有对应的 ESLint 规则;随便指一条现有 srvf 规则,
//      副作用是**真的把这 31 个源文件从那条规则里豁免掉**。
//   ② `entries[].symbol` 必须匹配 BASELINE_SYMBOL_SHAPES 三种形状之一
//      (`类名.字段名` / `类名.方法名.参数名` / 日期串)。文件路径一种都不匹配 ⇒
//      parseRatchetBaseline **加载期直接抛**,`pnpm lint` 本身起不来。
//   ③ 修 ①② 必须改 eslint.harness.mjs 与 redzone-trusted-judge.mjs 两个红区执法文件,
//      而它们正是本刀禁区(「Phase 0-5 的任何执法实现」)。
//   另:裁判侧只比 `(file, symbol)` 集合、**不认数值** —— 数值若编进 symbol,
//   合法的「变小」也会造出新 key 而硬失败,语义正好反了。正确形状是
//   **身份=文件、数值=属性**,与 v4 终审【九】「count 永不作为最终棘轮身份」同向。
//   ⇒ 本刀不登记;如何让注册表容纳非 ESLint 型棘轮,列进转 blocking 的 Exit Criteria。

const SERVICE_SIZE_SCHEMA_VERSION = 1;
const SERVICE_SIZE_GENERATOR_VERSION = 1;
const serviceSizeBaselineRelPath = 'harness/service-size-baseline.json';

interface ServiceSizeBaselineEntry {
  file: string;
  /** 判据值:非注释非空行。 */
  loc: number;
  domain: string;
}

export interface ServiceSizeBaseline {
  _comment?: string;
  schemaVersion: number;
  generatorVersion: number;
  metric: string;
  threshold: number;
  inputDigest: string;
  entries: ServiceSizeBaselineEntry[];
}

const SERVICE_SIZE_BASELINE_COMMENT = [
  '大 service 尺寸棘轮的具名基线(Phase 6-A,v4 §11 Phase 6)。**生成物,勿手改** ——',
  '改基线值请跑 pnpm harness:servicesize:write(本文件在红区 selfGuard,须维护者授权)。',
  '',
  `loc = ${SERVICE_SIZE_METRIC}(非注释非空行,TS scanner 剥注释后统计),不是物理行:`,
  '物理行棘轮会奖励「删掉文件头的模块级铁律注释」,而那是本仓约束 AI 的主要载体。',
  `阈值 ${SERVICE_SIZE_THRESHOLD} 复用既有 god-service 阈值(不另立第二套尺寸标准)。`,
  '',
  '判据:① 基线内文件只减不增;② 基线外文件达到阈值须走授权入册(防「拆成两个次巨无霸」静默入册);',
  '③ 同域「基线文件变小 + 新超阈值文件」并列显示,人判是否真拆分。',
  '**本刀恒 report,不阻断任何 PR**;转 blocking 的 Exit Criteria 见 docs/ai-harness/SERVICE_SIZE_RATCHET.md。',
  '',
  'inputDigest 只摄入口径本身(度量/阈值/发现面/生成器版本),**刻意不摄入 src/** 内容** ——',
  '摄入源码会让基线在每个业务 PR 都「过期」,噪声淹没信号;而「基线值 vs 磁盘」本就由判据本身回答。',
  '无时间戳、无 git SHA(v4 §9 勘误①)。',
].join('\n');

/**
 * 口径指纹。**只摄入口径本身**(度量名 / 阈值 / 发现面后缀 / 根目录 / 生成器版本),
 * 刻意**不摄入 `src/**` 的内容**。
 *
 * 理由(实测教训):摄入源码内容的 digest 会在任何一个 service 被改动时变化 ——
 * 而那正是最频繁的日常改动,于是基线每个业务 PR 都"过期"一次,
 * 噪声淹没信号;更要命的是「基线值与磁盘是否一致」本来就由棘轮判据本身回答,
 * 再用 digest 查一遍是重复且更弱的判据。
 * 这里的 digest 回答的是另一个问题:**基线是不是用当前这套口径算出来的**。
 * 口径一改(阈值/度量/发现面),digest 必变 ⇒ 基线必须重生成。
 *
 * 无时间戳、无 git SHA(v4 §9 / 勘误①:派生生成物不得含二者,否则字节比对恒假红且自引用)。
 */
export function serviceSizeInputDigest(): string {
  const descriptor = JSON.stringify({
    metric: SERVICE_SIZE_METRIC,
    threshold: SERVICE_SIZE_THRESHOLD,
    root: SERVICE_SIZE_ROOT,
    suffixes: [...SERVICE_SIZE_SUFFIXES].sort(),
    generatorVersion: SERVICE_SIZE_GENERATOR_VERSION,
  });
  return `sha256:${crypto.createHash('sha256').update(descriptor).digest('hex')}`;
}

function buildServiceSizeBaseline(units: ServiceEntry[]): ServiceSizeBaseline {
  return {
    _comment: SERVICE_SIZE_BASELINE_COMMENT,
    schemaVersion: SERVICE_SIZE_SCHEMA_VERSION,
    generatorVersion: SERVICE_SIZE_GENERATOR_VERSION,
    metric: SERVICE_SIZE_METRIC,
    threshold: SERVICE_SIZE_THRESHOLD,
    inputDigest: serviceSizeInputDigest(),
    entries: units
      .filter((u) => u.loc >= SERVICE_SIZE_THRESHOLD)
      .map((u) => ({ file: u.relPath, loc: u.loc, domain: u.module }))
      .sort((a, b) => a.file.localeCompare(b.file)),
  };
}

export function parseServiceSizeBaseline(text: string): ServiceSizeBaseline {
  const doc = JSON.parse(text) as Partial<ServiceSizeBaseline>;
  if (doc === null || typeof doc !== 'object' || !Array.isArray(doc.entries)) {
    throw new Error(`${serviceSizeBaselineRelPath} 结构不对(缺 entries 数组)`);
  }
  for (const e of doc.entries) {
    if (typeof e?.file !== 'string' || typeof e?.loc !== 'number') {
      throw new Error(`${serviceSizeBaselineRelPath} 有条目缺 file / loc`);
    }
  }
  return doc as ServiceSizeBaseline;
}

/**
 * 棘轮判据。导出供 selftest 喂合成基线做阳性对照(增长必报 / 缩小不报 /
 * 新文件超阈值必报 / 纯注释膨胀不报)。
 */
export function checkServiceSize(
  units: ServiceEntry[],
  baseline: ServiceSizeBaseline,
): CheckResult[] {
  const results: CheckResult[] = [];
  const current = new Map(units.map((u) => [u.relPath, u]));
  const based = new Map(baseline.entries.map((e) => [e.file, e]));

  if (baseline.inputDigest !== serviceSizeInputDigest()) {
    results.push({
      id: 'service-size-digest',
      severity: 'WARN',
      summary: '基线的 inputDigest 与当前口径不符 —— 口径已变,基线须重新生成',
      details: [
        `基线:${baseline.inputDigest}`,
        `当前:${serviceSizeInputDigest()}`,
        `重新生成:pnpm harness:servicesize:write(红区,须 pnpm harness:grant 授权)`,
      ],
    });
  }

  /** 变小或消失的基线文件。`delta` 是减少量;消失时 `delta` 即基线值。 */
  interface Receded {
    file: string;
    domain: string;
    delta: number;
    vanished: boolean;
  }
  const grown: string[] = [];
  const receded: Receded[] = [];
  for (const e of baseline.entries) {
    const now = current.get(e.file);
    if (!now) {
      receded.push({ file: e.file, domain: e.domain, delta: e.loc, vanished: true });
      continue;
    }
    if (now.loc > e.loc) {
      grown.push(`${e.file}: 当前 ${now.loc} vs 基线 ${e.loc}(+${now.loc - e.loc})[域 ${e.domain}]`);
    } else if (now.loc < e.loc) {
      receded.push({ file: e.file, domain: e.domain, delta: e.loc - now.loc, vanished: false });
    }
  }

  const newAbove = units.filter(
    (u) => u.loc >= SERVICE_SIZE_THRESHOLD && !based.has(u.relPath),
  );

  results.push(
    grown.length === 0
      ? {
          id: 'service-size-ratchet',
          severity: 'PASS',
          summary: `${baseline.entries.length} 个基线文件全部只减不增`,
        }
      : {
          id: 'service-size-ratchet',
          severity: 'WARN',
          summary: `${grown.length} 个基线文件变大了(棘轮 report 期不阻断)`,
          details: grown,
        },
  );

  if (newAbove.length > 0) {
    results.push({
      id: 'service-size-new-above-threshold',
      severity: 'WARN',
      summary: `${newAbove.length} 个基线外文件达到阈值 ${SERVICE_SIZE_THRESHOLD}`,
      details: [
        ...newAbove.map((u) => `${u.relPath}: ${u.loc}(物理 ${u.physicalLoc})[域 ${u.module}]`),
        '',
        '如确需入基线:须维护者授权改 harness/service-size-baseline.json 并在 PR 里写明理由。',
        '这道提示专防「把巨无霸拆成两个次巨无霸后静默入册」。',
      ],
    });
  }

  // ③ 拆分识别:同域内「基线文件变小/消失」与「新的超阈值文件」并列显示。
  const splitDomains = new Map<string, { before: string[]; after: string[] }>();
  for (const e of receded) {
    const slot = splitDomains.get(e.domain) ?? { before: [], after: [] };
    slot.before.push(
      e.vanished ? `${e.file}: 已消失(基线 ${e.delta})` : `${e.file}: 减少 ${e.delta}`,
    );
    splitDomains.set(e.domain, slot);
  }
  for (const u of newAbove) {
    const slot = splitDomains.get(u.module);
    if (!slot) continue; // 同域没有变小的基线文件 ⇒ 不是拆分,已由上面那条覆盖
    slot.after.push(`${u.relPath}: ${u.loc}`);
  }
  const splits = [...splitDomains.entries()].filter(([, v]) => v.after.length > 0);
  if (splits.length > 0) {
    results.push({
      id: 'service-size-possible-split',
      severity: 'INFO',
      summary: `${splits.length} 个域同时出现「基线文件变小」与「新超阈值文件」`,
      details: [
        ...splits.flatMap(([domain, v]) => [
          `[域 ${domain}] 变小/消失:`,
          ...v.before.map((s) => `    ${s}`),
          `[域 ${domain}] 新增超阈值:`,
          ...v.after.map((s) => `    ${s}`),
        ]),
        '',
        '这可能是真拆分,也可能是机械切分。**本检查不自动放行也不自动拒绝** ——',
        '判断拆得对不对需要语义理解,机器给不出;请人看一眼。',
      ],
    });
  }

  if (receded.length > 0) {
    const vanished = receded.filter((e) => e.vanished);
    results.push({
      id: 'service-size-progress',
      severity: 'INFO',
      summary: `${receded.length - vanished.length} 个基线文件变小、${vanished.length} 个已消失`,
      details: [
        ...receded.map((e) =>
          e.vanished ? `${e.file}: 已消失(基线 ${e.delta})` : `${e.file}: 减少 ${e.delta}`,
        ),
        '',
        `基线值可随之下调(棘轮只降不升):pnpm harness:servicesize:write`,
      ],
    });
  }

  return results;
}

/**
 * `--service-size` 子命令。
 *
 * 退出码**有意义**:发现「基线内增长」或「基线外超阈值」时退出 1。
 * report 期的不阻断由 **CI 侧的 `|| true` 单点承担**(Phase 0 翻闸范式:
 * 「在既有 required job 内把该步骤从报告翻为失败」)——
 * 于是转 blocking = 删掉那一个 `|| true`,一行,且**不可能只做一半**。
 *
 * 为什么不在脚本里也恒退出 0:两处都做「不阻断」,翻闸就要改两处;
 * 只改一处的人会得到一个「看起来翻了、其实没翻」的闸 ——
 * 「描述文本 ≠ 执行位」这一类事故本仓一天栽过四次。
 */
function runServiceSize(write: boolean): void {
  const units = listServiceFiles();
  const baselineAbs = path.join(repoRoot, serviceSizeBaselineRelPath);

  if (write) {
    const doc = buildServiceSizeBaseline(units);
    fs.writeFileSync(baselineAbs, `${JSON.stringify(doc, null, 2)}\n`);
    console.log(`✓ 已写入 ${serviceSizeBaselineRelPath}(${doc.entries.length} 条,阈值 ${doc.threshold})`);
    return;
  }

  console.log(`尺寸棘轮(Phase 6-A · report 期,恒不阻断)`);
  console.log(`  度量:${SERVICE_SIZE_METRIC}   阈值:${SERVICE_SIZE_THRESHOLD}`);
  console.log(`  发现面:${SERVICE_SIZE_ROOT}/** 下的 ${SERVICE_SIZE_SUFFIXES.join(' / ')}(排除 *.spec.ts)`);
  console.log('');

  if (!fs.existsSync(baselineAbs)) {
    console.log(`[WARN] service-size-baseline-missing (${serviceSizeBaselineRelPath} 不存在)`);
    console.log('');
    console.log('Summary: 0 FAIL, 1 WARN, 0 INFO, 0 PASS');
    return;
  }

  let results: CheckResult[];
  try {
    results = checkServiceSize(units, parseServiceSizeBaseline(fs.readFileSync(baselineAbs, 'utf8')));
  } catch (err) {
    console.log(`[WARN] service-size-baseline-unreadable (${String(err)})`);
    console.log('');
    console.log('Summary: 0 FAIL, 1 WARN, 0 INFO, 0 PASS');
    return;
  }

  for (const r of results) printResult(r);
  printSummary(results);

  const breached = results.some(
    (r) =>
      r.severity === 'WARN' &&
      (r.id === 'service-size-ratchet' || r.id === 'service-size-new-above-threshold'),
  );
  if (breached) {
    console.log('');
    console.log('⚠️ 尺寸棘轮有发现。**report 期不阻断**(CI 侧该步骤带 `|| true`)。');
    console.log('   转 blocking 的 Exit Criteria 见 docs/ai-harness/SERVICE_SIZE_RATCHET.md。');
    process.exitCode = 1;
  }
}

function checkReferencedPathsExist(codemap: string): CheckResult {
  const targets = extractRelativeLinks(codemap);
  const missing: string[] = [];
  for (const target of targets) {
    const abs = path.join(repoRoot, target);
    if (!fs.existsSync(abs)) missing.push(target);
  }
  if (missing.length === 0) {
    return {
      id: 'referenced-paths-exist',
      severity: 'PASS',
      summary: `${targets.length} relative link(s) all resolve`,
    };
  }
  return {
    id: 'referenced-paths-exist',
    severity: 'WARN',
    summary: `${missing.length} broken relative link(s) (of ${targets.length})`,
    details: missing,
  };
}

interface MigrationDocDecl {
  label: string;
  declared: number | null;
}

// prisma/migrations/ 实际目录数为权威;校验各文档声明与之一致。承接 #249/#252 漂移教训:
// CODEMAP.md 与 prisma/CLAUDE.md 的 migration 计数曾与实际不符,且此前无自动校验抓得到。
//
// Harness 3.0 P4b 起 **CODEMAP.md 从本检查移出** —— 那一行由 generate-codemap.ts 写入,
// 再校一遍是拿生成器输出跟生成器输入比(恒 PASS 的自证);其新鲜度归 `docs:codemap:check`。
// prisma/CLAUDE.md 仍是人手维护的数字,**必须留在这里**。
function checkMigrationCount(actual: number, sources: MigrationDocDecl[]): CheckResult {
  const issues: string[] = [];
  for (const s of sources) {
    if (s.declared === null) {
      issues.push(`${s.label}: 未找到 "N 个 migration" 声明(实际 ${actual});请同步该文档`);
    } else if (s.declared !== actual) {
      issues.push(`${s.label}: 声明 ${s.declared},实际 prisma/migrations/ 有 ${actual} 个`);
    }
  }
  if (issues.length === 0) {
    return {
      id: 'migration-count-matches',
      severity: 'PASS',
      summary: `${actual} migration(s);prisma/CLAUDE.md 声明一致`,
    };
  }
  return {
    id: 'migration-count-matches',
    severity: 'FAIL',
    summary: `${issues.length} migration 计数漂移(prisma/migrations/ 实际 ${actual} 个)`,
    details: issues,
  };
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function printResult(r: CheckResult): void {
  console.log(`[${r.severity}] ${r.id} (${r.summary})`);
  if (r.details && r.details.length > 0) {
    for (const d of r.details) {
      console.log(`  - ${d}`);
    }
  }
}

function printSummary(results: CheckResult[]): void {
  const tally = { PASS: 0, WARN: 0, FAIL: 0, INFO: 0 };
  for (const r of results) tally[r.severity]++;
  console.log('');
  console.log(
    `Summary: ${tally.FAIL} FAIL, ${tally.WARN} WARN, ${tally.INFO} INFO, ${tally.PASS} PASS`,
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  const argv = process.argv.slice(2);
  if (argv.includes('--service-size')) {
    runServiceSize(argv.includes('--write'));
    return; // 不阻断由 CI 侧的 `|| true` 单点承担,见 runServiceSize 上方注释
  }

  if (!fs.existsSync(codemapAbsPath)) {
    console.log(`[FAIL] codemap-exists (CODEMAP.md not found at ${codemapAbsPath})`);
    console.log('');
    console.log('Summary: 1 FAIL, 0 WARN, 0 INFO, 0 PASS');
    process.exitCode = 1;
    return;
  }

  const codemap = readCodemap();
  const realModules = listRealModules();
  const declaredModules = parseCodemapModules(codemap);
  const claudeMdPaths = listClaudeMdUnderDirs(['src/modules', 'src/common']);
  const services = listServiceFiles();
  const actualMigrations = countMigrationDirs();
  const migrationSources: MigrationDocDecl[] = [
    // CODEMAP.md 不在此列:见 checkMigrationCount 上方注释(生成物,自证无意义)
    {
      label: 'prisma/CLAUDE.md',
      declared: parseDeclaredMigrationCount(readRepoFile('prisma/CLAUDE.md')),
    },
  ];

  const results: CheckResult[] = [
    checkModulesInCodemap(realModules, declaredModules),
    checkCodemapModulesReal(realModules, declaredModules),
    checkClaudeMdReferenced(claudeMdPaths, codemap),
    ...checkServiceLoc(services),
    checkReferencedPathsExist(codemap),
    checkMigrationCount(actualMigrations, migrationSources),
  ];

  for (const r of results) printResult(r);
  printSummary(results);

  const hasFail = results.some((r) => r.severity === 'FAIL');
  process.exitCode = hasFail ? 1 : 0;
}

// 供 selftest 以 import 方式复用度量与棘轮判据;直跑(pnpm docs:codemap:check /
// pnpm harness:servicesize)才执行 main。少了这道守卫,import 会顺带跑一遍全部检查。
if (require.main === module) main();
