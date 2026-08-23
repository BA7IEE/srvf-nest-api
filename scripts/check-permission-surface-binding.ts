/**
 * check-permission-surface-binding.ts —— 「权限说明 ↔ 管辖面」绑定闸(P2-13)。
 *
 * ⚠️ 本文件在 `harness/redzone.json` 的 selfGuard 内(`scripts/check-*.ts`)。
 *    判据逻辑刻意放在这里而不是 spec 里:spec(`src/**\/*.spec.ts`)不在 selfGuard,
 *    任何 PR 都能顺手改松它;把**实质逻辑**放在受保护文件里,改松就必须动红区。
 *    spec 侧只做薄运行器(见 `src/modules/permissions/permission-surface-binding.spec.ts`)。
 *    这条分工与 `scripts/check-permission-catalog-closure.ts` 逐字同款。
 *
 * ──────────────────────────────────────────────────────────────────────────
 * 立项理由:**权限码总数不变,不能证明权限说明没过期**
 *
 * 一条**已有**权限码可以长出第二、第三个消费入口,而权限码总数纹丝不动。
 * 真实事故:B7 受众标签那批加了 **3 个新端点、零个新权限码**,
 * `member.read.record` / `member.update.record` / `activity.publish.record`
 * 三条的说明当场过期,**没有任何机器发现** —— 是第三轮人工复核抓到的。
 *
 * 🔴 **本闸立项前实测过「现有判据到底拦不拦得住」**(P2-13 DoD 1,不是照抄台账断言)。
 * 变异:给 `GET /api/admin/v1/members/:id/audience-tags` 的 `@RequiresPermission`
 * 加上已有码 `org.read.node`(⇒ 该码管辖面 6→7 个端点,**零个新权限码**,
 * 说明一字未改)。四类既有判据的读数:
 *
 *   | 判据                         | 变异前 | 变异后(未重新生成) | 变异后(重新生成) |
 *   |------------------------------|--------|----------------------|--------------------|
 *   | `docs:authz:check`           | 绿     | **红**               | **绿**             |
 *   | `docs:counts:check`(码数)   | 绿     | 绿                   | 绿                 |
 *   | 四桶闭包                     | 绿     | 绿                   | 绿                 |
 *   | `docs:rbacmap:check`(持有人)| 绿     | 绿                   | 绿                 |
 *
 * 全程 `org.read.node` 的 `businessDescription` 摘要恒为 `9ed0661c…`(一字未动)。
 * ⇒ 台账那句「重新生成不碰说明,红一消,说明照旧过期」**是实测读数**:
 *   唯一会红的 `docs:authz:check` 只是「生成物与源不同步」,`pnpm docs:authz`
 *   一跑就绿,而重新生成**不碰任何说明**。缺的不是检测,是**绑定**。
 *
 * ──────────────────────────────────────────────────────────────────────────
 * 规模:说明过期是结构上必然持续发生
 *
 * 实测(`ce5fc66a`):**218 条码有端点,其中 72 条守多于一个端点**
 * (`attendance.read.sheet` 19 个 · `activity-responsibility.override.record` 18 个)。
 * ⚠️ 起草 P2-13 时是 217 / 70 —— **两周内就漂了**,这正是本闸要盯的那种漂移。
 *
 * ──────────────────────────────────────────────────────────────────────────
 * 三个口径各自的来源(刻意不同源)
 *
 *   · **码全集** = `docs-counts` 的 typed-AST 提取器扫 seed 事实闭包源文本。
 *     ⚠️ **不是** `RBAC_SEED_CATALOG` 各桶并集 —— 那只有 225/237,具名子集不自称闭包。
 *   · **管辖面** = `docs/ai-harness/ROUTE_AUTHZ.md` 的 `## Permission code surface` 节。
 *     该节由 `generate-authz-manifest.ts` 从控制器 typed-AST 生成,自身由 CI 的
 *     `docs:authz:check` 钉住新鲜度(`.github/workflows/ci.yml`)⇒ 链条闭合:
 *     控制器 → (CI 保新鲜) ROUTE_AUTHZ → 本闸。
 *   · **说明** = `permission-catalog.ts` 的 `PERMISSION_CATALOG_METADATA.businessDescription`,
 *     typed-AST 逐条读。
 *     ⚠️ **不是** `RbacPermissionSeed.description` —— 那是另一个字段(短技术标签,
 *     写进 DB);两者内容本就不同(实测 115 条零条相等),拿它们互比会红在几乎每一条上。
 *
 * ──────────────────────────────────────────────────────────────────────────
 * 判据形状:基线 = 「上次有人看过的样子」
 *
 * `harness/permission-surface-baseline.json` 每条码存
 * `{ endpoints: <个数>, surface: <端点集合摘要>, description: <说明摘要> }`。
 *
 *   · **面变了而基线没跟上 → 红**,并点名是哪条码、从几个变成几个。
 *   · 基线只能由 `--write` 推进,而 `--write` **拒绝**推进「面变了、说明摘要没变」的码 ——
 *     这条拒绝才是执行位。没有它,红一消(顺手 `--write`)说明照旧过期,
 *     就是 B7 那次 `pnpm docs:authz` 的复刻。
 *   · 确实复核过、认定说明仍准确的,用 `--acknowledge-unchanged <码,码>` 显式放行。
 *     ⚠️ 这个放行**不写进基线、也不跨面生效**:它只让本次写通过,
 *     面再变一次就要重新复核。留这个口子是因为 `attendance.read.sheet` 那种 19 个端点的码
 *     加第 20 个同类读端点时说明可能确实不用改 —— 不留口子会逼人改假文案,闸很快被绕过。
 *
 * ⚠️ 基线**不是第二份真相**:它是派生快照,权威源仍是 ROUTE_AUTHZ 与 Catalog。
 *    它也**不断言当前说明是准确的** —— 它只钉住「从今天起,面变了必须有人重看说明」。
 *
 * ──────────────────────────────────────────────────────────────────────────
 * 仪器纪律:先自证再报数
 *
 * 空基线与空现状比对**恒等** ⇒ 会静默全绿。本闸对四条扫描面各用**地板锚点**(≥200),
 * 任何一条塌了就当红处理而不是当绿。基线缺失 / 读空 / 解析失败同样是红,
 * 不是「零差异 = 全绿」。用地板锚点不用「恰 N 条」—— 后者每次加端点都要改判据,
 * 而改判据的摩擦会诱导人把数字调大了事。
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import * as ts from 'typescript';

import {
  SEED_FACTS_CLOSURE,
  extractSeedFactsPermissionCodesAst,
  readSeedFactsClosure,
} from './docs-counts';

const ROOT = resolve(__dirname, '..');

export const BASELINE_FILE = 'harness/permission-surface-baseline.json';
const ROUTE_AUTHZ_FILE = 'docs/ai-harness/ROUTE_AUTHZ.md';
const CATALOG_FILE = 'src/modules/permissions/permission-catalog.ts';
const SURFACE_HEADING = '## Permission code surface';

/**
 * 地板锚点。起草时实测(`ce5fc66a`):码全集 237、管辖面 218 行、说明 237 条、
 * 基线 242 条(= 码全集 ∪ 管辖面,后者含 5 条通配码)。
 */
export const MIN_PERMISSION_CODES = 200;

export interface SurfaceBaselineEntry {
  /** 该码守着的端点个数。存明数是为了让基线 diff 一眼可读(维护者不读代码)。 */
  readonly endpoints: number;
  /** 端点集合摘要(排序后逐行 sha256)。 */
  readonly surface: string;
  /** `businessDescription` 摘要;通配码等没有说明的条目为 null。 */
  readonly description: string | null;
}

export type SurfaceBaseline = Readonly<Record<string, SurfaceBaselineEntry>>;

export interface SurfaceBindingFacts {
  /** typed-AST 扫出的权限码全集。 */
  readonly universe: ReadonlySet<string>;
  /** 码 → 它守着的端点集合(已排序)。 */
  readonly surface: ReadonlyMap<string, readonly string[]>;
  /** 码 → businessDescription 原文。 */
  readonly descriptions: ReadonlyMap<string, string>;
  /** 本闸追踪的码集合 = 码全集 ∪ 管辖面出现过的码。 */
  readonly tracked: readonly string[];
}

export interface SurfaceBindingReport {
  readonly facts: SurfaceBindingFacts;
  readonly baseline: SurfaceBaseline | null;
  /** 基线自身不可用(缺失 / 读空 / 解析失败)的原因;非空即红,且不再报差异。 */
  readonly baselineFailure: string | null;
  /** 面变了而基线没跟上 —— 本闸的主用途。 */
  readonly surfaceDrift: readonly SurfaceDrift[];
  /** 现在有、基线没有 —— 新码没登记。 */
  readonly missingFromBaseline: readonly string[];
  /** 基线有、现在没有 —— 码被删了而基线没跟。 */
  readonly staleInBaseline: readonly string[];
}

export interface SurfaceDrift {
  readonly code: string;
  readonly baselineEndpoints: number;
  readonly currentEndpoints: number;
  /** 说明摘要是否也跟着动了。false = 面变了而说明没改,本闸的靶心。 */
  readonly descriptionChanged: boolean;
}

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf-8');
}

function sha256(input: string): string {
  return 'sha256:' + createHash('sha256').update(input).digest('hex');
}

/** 端点集合摘要:排序去重后逐行拼接再摘要,与顺序无关。 */
export function surfaceDigest(endpoints: readonly string[]): string {
  return sha256([...new Set(endpoints)].sort().join('\n'));
}

// ───────────────────────────── 管辖面(ROUTE_AUTHZ) ─────────────────────────────

/**
 * 解析 `## Permission code surface` 节。
 *
 * ⚠️ 只读不改:该节的生成逻辑是本闸的**尺子**,改它等于改尺子(P2-13 §6 明确不做)。
 * ⚠️ 节头找不到 / 表格一行都没解析出来 ⇒ 抛错,不返回空 Map。
 *    返回空 Map 会让「空 ∩ 空」静默全绿,那是仓内踩过的假绿形状。
 */
export function parseCodeSurface(markdown: string): Map<string, string[]> {
  const start = markdown.indexOf('\n' + SURFACE_HEADING + '\n');
  if (start < 0) {
    throw new Error(
      `${ROUTE_AUTHZ_FILE} 里找不到 \`${SURFACE_HEADING}\` 节 —— 指纹源没了,拒绝报结论`,
    );
  }
  const rest = markdown.slice(start + SURFACE_HEADING.length + 2);
  const end = rest.indexOf('\n## ');
  const section = end < 0 ? rest : rest.slice(0, end);

  const surface = new Map<string, string[]>();
  for (const match of section.matchAll(/^\| `([^`]+)` \| (\d+) \| (.+) \|$/gm)) {
    const code = match[1];
    const endpoints = match[3]
      .split(' · ')
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
    if (Number(match[2]) !== endpoints.length) {
      throw new Error(
        `${ROUTE_AUTHZ_FILE} 的 \`${code}\` 行端点数(${match[2]})与实际列出的(${endpoints.length})对不上 —— 指纹源自相矛盾,拒绝报结论`,
      );
    }
    surface.set(code, endpoints.sort());
  }
  if (surface.size === 0) {
    throw new Error(
      `${ROUTE_AUTHZ_FILE} 的 \`${SURFACE_HEADING}\` 节一行都没解析出来 —— 多半是表格形态变了;拒绝按「零差异」报绿`,
    );
  }
  return surface;
}

// ───────────────────────────── 说明(permission-catalog) ─────────────────────────────

/**
 * typed-AST 读 `PERMISSION_CATALOG_METADATA` 每条码的 `businessDescription`。
 *
 * ⚠️ 只认字面量(`'…'` / 反引号无插值)。读到非字面量形态 ⇒ 抛错并点名,
 *    **不静默跳过** —— 提取器少认一种写法会让说明侧静默缩水,而缩水后
 *    「面变了但说明摘要也变了」恒不成立,判据会往红的方向失真且没人知道为什么。
 */
export function extractBusinessDescriptions(source: string): Map<string, string> {
  const sf = ts.createSourceFile('catalog.ts', source, ts.ScriptTarget.Latest, true);
  const descriptions = new Map<string, string>();
  const malformed: string[] = [];

  const declaration = findMetadataObject(sf);
  if (declaration === null) {
    throw new Error(`${CATALOG_FILE} 里找不到 PERMISSION_CATALOG_METADATA 对象字面量`);
  }

  for (const property of declaration.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const code = propertyName(property.name);
    if (code === null) continue;
    if (!ts.isObjectLiteralExpression(property.initializer)) continue;

    for (const field of property.initializer.properties) {
      if (!ts.isPropertyAssignment(field)) continue;
      if (propertyName(field.name) !== 'businessDescription') continue;
      const initializer = field.initializer;
      if (ts.isStringLiteral(initializer) || ts.isNoSubstitutionTemplateLiteral(initializer)) {
        descriptions.set(code, initializer.text);
      } else {
        malformed.push(code);
      }
    }
  }

  if (malformed.length > 0) {
    throw new Error(
      `businessDescription 必须是字面量,以下 ${malformed.length} 条不是(拼接 / 模板插值 / 变量都不接受):\n  ` +
        malformed.sort().join('\n  '),
    );
  }
  return descriptions;
}

function findMetadataObject(sf: ts.SourceFile): ts.ObjectLiteralExpression | null {
  let found: ts.ObjectLiteralExpression | null = null;
  const visit = (node: ts.Node): void => {
    if (
      found === null &&
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'PERMISSION_CATALOG_METADATA' &&
      node.initializer !== undefined
    ) {
      found = unwrapObjectLiteral(node.initializer);
    }
    node.forEachChild(visit);
  };
  visit(sf);
  return found;
}

/** 剥掉 `Object.freeze(...)` / `as const` 之类的包裹,拿到里面的对象字面量。 */
function unwrapObjectLiteral(node: ts.Expression): ts.ObjectLiteralExpression | null {
  if (ts.isObjectLiteralExpression(node)) return node;
  if (ts.isCallExpression(node) && node.arguments.length > 0)
    return unwrapObjectLiteral(node.arguments[0]);
  if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node))
    return unwrapObjectLiteral(node.expression);
  if (ts.isParenthesizedExpression(node)) return unwrapObjectLiteral(node.expression);
  return null;
}

function propertyName(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return null;
}

// ───────────────────────────── 事实收集 ─────────────────────────────

export function collectFacts(): SurfaceBindingFacts {
  const universe = extractSeedFactsPermissionCodesAst(readSeedFactsClosure(SEED_FACTS_CLOSURE));
  const surface = parseCodeSurface(read(ROUTE_AUTHZ_FILE));
  const descriptions = extractBusinessDescriptions(read(CATALOG_FILE));
  const tracked = [...new Set([...universe, ...surface.keys()])].sort();
  return { universe, surface, descriptions, tracked };
}

/**
 * 自证:任何一条扫描面塌了就拒绝报结论。
 *
 * 返回失败原因清单;非空即「仪器失效」,调用方必须当红处理而不是当绿。
 */
export function selfCheck(facts: SurfaceBindingFacts): string[] {
  const failures: string[] = [];
  const floor = (label: string, size: number): void => {
    if (size < MIN_PERMISSION_CODES) {
      failures.push(`${label}只扫到 ${size} 条(地板锚点 ≥${MIN_PERMISSION_CODES})—— 扫描面塌了`);
    }
  };
  floor('权限码全集', facts.universe.size);
  floor('管辖面(ROUTE_AUTHZ code surface)', facts.surface.size);
  floor('权限说明(businessDescription)', facts.descriptions.size);
  floor('追踪码集合', facts.tracked.length);

  const describedButUnknown = [...facts.descriptions.keys()].filter(
    (code) => !facts.universe.has(code),
  );
  if (describedButUnknown.length > 0) {
    failures.push(
      `以下 ${describedButUnknown.length} 条有说明却不在权限码全集里 —— 两侧口径漂了:\n  ` +
        describedButUnknown.sort().join('\n  '),
    );
  }
  return failures;
}

/** 按当前事实算出该写进基线的样子。 */
export function computeEntries(facts: SurfaceBindingFacts): Record<string, SurfaceBaselineEntry> {
  const entries: Record<string, SurfaceBaselineEntry> = {};
  for (const code of facts.tracked) {
    const endpoints = facts.surface.get(code) ?? [];
    const description = facts.descriptions.get(code);
    entries[code] = {
      endpoints: endpoints.length,
      surface: surfaceDigest(endpoints),
      description: description === undefined ? null : sha256(description),
    };
  }
  return entries;
}

// ───────────────────────────── 基线读写 ─────────────────────────────

/**
 * 读基线。
 *
 * ⚠️ 缺失 / 读空 / 解析失败 / 条目数低于地板锚点 —— 一律返回失败原因,**不返回空对象**。
 *    空基线与空现状比对恒等 ⇒ 会静默全绿,仓内踩过这个形状(P2-13 DoD 3 第三条变异)。
 */
export function readBaseline(): { baseline: SurfaceBaseline | null; failure: string | null } {
  let raw: string;
  try {
    raw = read(BASELINE_FILE);
  } catch {
    return {
      baseline: null,
      failure: `基线文件 ${BASELINE_FILE} 读不到 —— 被删了或路径变了。这是红,不是「零差异」`,
    };
  }
  if (raw.trim().length === 0) {
    return { baseline: null, failure: `基线文件 ${BASELINE_FILE} 是空的 —— 这是红,不是「零差异」` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      baseline: null,
      failure: `基线文件 ${BASELINE_FILE} 解析失败:${(error as Error).message}`,
    };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { baseline: null, failure: `基线文件 ${BASELINE_FILE} 不是对象` };
  }

  const document = parsed as { codes?: unknown };
  const codes = document.codes;
  if (codes === null || typeof codes !== 'object' || Array.isArray(codes)) {
    return { baseline: null, failure: `基线文件 ${BASELINE_FILE} 缺 \`codes\` 对象` };
  }

  const baseline = codes as SurfaceBaseline;
  const size = Object.keys(baseline).length;
  if (size < MIN_PERMISSION_CODES) {
    return {
      baseline: null,
      failure: `基线只有 ${size} 条(地板锚点 ≥${MIN_PERMISSION_CODES})—— 被清空或截断了,拒绝按「零差异」报绿`,
    };
  }
  return { baseline, failure: null };
}

// ───────────────────────────── 判据 ─────────────────────────────

export function analyzeSurfaceBinding(): SurfaceBindingReport {
  const facts = collectFacts();
  const { baseline, failure } = readBaseline();
  if (baseline === null) {
    return {
      facts,
      baseline: null,
      baselineFailure: failure,
      surfaceDrift: [],
      missingFromBaseline: [],
      staleInBaseline: [],
    };
  }

  const current = computeEntries(facts);
  const surfaceDrift: SurfaceDrift[] = [];
  const missingFromBaseline: string[] = [];

  for (const code of facts.tracked) {
    const now = current[code];
    const before = baseline[code];
    if (before === undefined) {
      missingFromBaseline.push(code);
      continue;
    }
    if (before.surface !== now.surface) {
      surfaceDrift.push({
        code,
        baselineEndpoints: before.endpoints,
        currentEndpoints: now.endpoints,
        descriptionChanged: before.description !== now.description,
      });
    }
  }

  const trackedSet = new Set(facts.tracked);
  const staleInBaseline = Object.keys(baseline)
    .filter((code) => !trackedSet.has(code))
    .sort();

  return {
    facts,
    baseline,
    baselineFailure: null,
    surfaceDrift,
    missingFromBaseline: missingFromBaseline.sort(),
    staleInBaseline,
  };
}

/** 把报告渲染成失败行;空数组即全绿。 */
export function formatFailures(report: SurfaceBindingReport): string[] {
  const failures: string[] = [];

  for (const failure of selfCheck(report.facts)) {
    failures.push(`✗ 仪器自证失败:${failure}`);
  }
  if (report.baselineFailure !== null) {
    failures.push(`✗ ${report.baselineFailure}`);
    return failures;
  }

  const stale = report.surfaceDrift.filter((drift) => !drift.descriptionChanged);
  const revisited = report.surfaceDrift.filter((drift) => drift.descriptionChanged);

  if (stale.length > 0) {
    failures.push(
      `✗ 以下 ${stale.length} 条码的**管辖面变了而说明没改** —— 说明多半已过期,请逐条复核 businessDescription:\n` +
        stale
          .map(
            (drift) =>
              `    ${drift.code}:端点 ${drift.baselineEndpoints} → ${drift.currentEndpoints}(说明一字未动)`,
          )
          .join('\n') +
        `\n  改完说明后跑:pnpm exec tsx scripts/check-permission-surface-binding.ts --write` +
        `\n  若逐条复核后认定说明仍然准确,显式放行:--write --acknowledge-unchanged ${stale
          .map((drift) => drift.code)
          .join(',')}`,
    );
  }
  if (revisited.length > 0) {
    failures.push(
      `✗ 以下 ${revisited.length} 条码的管辖面变了、说明也改了,但基线还没推进:\n` +
        revisited
          .map(
            (drift) =>
              `    ${drift.code}:端点 ${drift.baselineEndpoints} → ${drift.currentEndpoints}(说明已改)`,
          )
          .join('\n') +
        `\n  跑:pnpm exec tsx scripts/check-permission-surface-binding.ts --write`,
    );
  }
  if (report.missingFromBaseline.length > 0) {
    failures.push(
      `✗ 以下 ${report.missingFromBaseline.length} 条码在基线里没有登记(新码要连同说明一起进基线):\n    ` +
        report.missingFromBaseline.join('\n    ') +
        `\n  跑:pnpm exec tsx scripts/check-permission-surface-binding.ts --write`,
    );
  }
  if (report.staleInBaseline.length > 0) {
    failures.push(
      `✗ 以下 ${report.staleInBaseline.length} 条码已不存在,但基线里还留着:\n    ` +
        report.staleInBaseline.join('\n    ') +
        `\n  跑:pnpm exec tsx scripts/check-permission-surface-binding.ts --write`,
    );
  }
  return failures;
}

// ───────────────────────────── --write ─────────────────────────────

export interface WriteResult {
  readonly written: boolean;
  /** 拒绝写的原因;非空即没写。 */
  readonly refusals: readonly string[];
}

/**
 * 推进基线。
 *
 * 🔴 **拒绝推进「面变了、说明摘要没变」的码** —— 这条拒绝是本闸的执行位。
 *    没有它,红一消(顺手 `--write`)说明照旧过期,与 B7 那次 `pnpm docs:authz` 同形。
 */
export function writeBaseline(acknowledgeUnchanged: readonly string[]): WriteResult {
  const facts = collectFacts();
  const selfFailures = selfCheck(facts);
  if (selfFailures.length > 0) {
    return { written: false, refusals: selfFailures.map((line) => `仪器自证失败:${line}`) };
  }

  const acknowledged = new Set(acknowledgeUnchanged);
  const unknown = [...acknowledged].filter((code) => !facts.tracked.includes(code));
  if (unknown.length > 0) {
    return {
      written: false,
      refusals: [`--acknowledge-unchanged 里有不存在的码:${unknown.sort().join(', ')}`],
    };
  }

  const { baseline } = readBaseline();
  const current = computeEntries(facts);

  const refusals: string[] = [];
  if (baseline !== null) {
    for (const code of facts.tracked) {
      const before = baseline[code];
      if (before === undefined) continue;
      const now = current[code];
      if (before.surface === now.surface) continue;
      if (before.description !== now.description) continue;
      if (acknowledged.has(code)) continue;
      refusals.push(
        `${code}:端点 ${before.endpoints} → ${now.endpoints},但 businessDescription 一字未动`,
      );
    }
  }
  if (refusals.length > 0) {
    return {
      written: false,
      refusals: [
        `拒绝推进基线 —— 以下 ${refusals.length} 条码的管辖面变了而说明没改:\n    ` +
          refusals.join('\n    ') +
          `\n  要么改 businessDescription,要么逐条复核后显式放行:` +
          `\n    --write --acknowledge-unchanged ${refusals
            .map((line) => line.split(':')[0])
            .join(',')}`,
      ],
    };
  }

  const document = {
    _comment:
      '权限说明 ↔ 管辖面绑定基线(P2-13)。派生快照,不是真相源 —— 权威源是 ROUTE_AUTHZ 的 ' +
      '`## Permission code surface` 节与 permission-catalog.ts 的 businessDescription。' +
      '它不断言当前说明准确,只钉住「面变了必须有人重看说明」。' +
      '推进方式:pnpm exec tsx scripts/check-permission-surface-binding.ts --write',
    version: 1,
    codes: current,
  };
  writeFileSync(join(ROOT, BASELINE_FILE), JSON.stringify(document, null, 2) + '\n', 'utf-8');
  return { written: true, refusals: [] };
}

// ───────────────────────────── CLI ─────────────────────────────

/** CLI:`pnpm exec tsx scripts/check-permission-surface-binding.ts [--write]`。退出码 0 / 1。 */
function main(argv: readonly string[]): number {
  if (argv.includes('--write')) {
    const flagIndex = argv.indexOf('--acknowledge-unchanged');
    const acknowledged =
      flagIndex >= 0 && argv[flagIndex + 1] !== undefined
        ? argv[flagIndex + 1]
            .split(',')
            .map((code) => code.trim())
            .filter((code) => code.length > 0)
        : [];
    const result = writeBaseline(acknowledged);
    if (!result.written) {
      for (const refusal of result.refusals) process.stderr.write(`✗ ${refusal}\n`);
      return 1;
    }
    process.stdout.write(`✓ 已推进 ${BASELINE_FILE}\n`);
    return 0;
  }

  let failures: string[];
  try {
    failures = formatFailures(analyzeSurfaceBinding());
  } catch (error) {
    process.stderr.write(`✗ ${(error as Error).message}\n`);
    return 1;
  }
  if (failures.length > 0) {
    for (const failure of failures) process.stderr.write(`${failure}\n`);
    return 1;
  }
  process.stdout.write('✓ 权限说明 ↔ 管辖面绑定:无漂移\n');
  return 0;
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}
