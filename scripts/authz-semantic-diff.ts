/**
 * authz-semantic-diff.ts — R14 授权语义 diff(Gate L4 / 架构治理 Phase 5 刀 5-1)
 *
 * 管什么:ROUTE_AUTHZ manifest 的 base↔head 语义比对。**降级不得作为普通 manifest
 * 更新静默通过** —— 权限保护等级被放宽,必须由维护者在 harness-review 环境点批。
 *
 * 为什么比对生成物而不是 AST:manifest 是 canonical form(v4 勘误批次七) ——
 * 装饰器只是表面语法,`normalizeRouteAuthzDeclaration` 是唯一 normalizer,Guard /
 * R8 / ALS / 本比较器**共用它的输出**。本文件因此不含第二套组合语义解释,
 * 只消费已归一化的 JSON;这也让裁判无需 AST、无需依赖。
 *
 * ── 双运行时(这条约束决定了本文件的写法,别随手破坏)────────────────────────
 * 权威裁判必须是 **base-trusted** 的:跑 base 分支上的判据,PR 改不了裁判
 * (redzone-trusted.yml 的同款理由 —— 自考自评的门不是门)。而那个 workflow 用
 * `pull_request_target` 触发,三条禁令之一是**绝不装依赖**,所以它跑不了 tsx。
 *
 * 解法不是「再写一份 .mjs 裁判」—— 那就有了两份语义,而 parity≠correctness 是本仓
 * 已记录的教训。解法是**同一个文件两个运行时都能跑**:
 *   本地 / Fast checks : tsx scripts/authz-semantic-diff.ts …
 *   trusted 裁判        : node --experimental-strip-types scripts/authz-semantic-diff.ts …
 * 代价是本文件必须满足:
 *   ① 零依赖(只用 node: 内置模块,不 import 仓内任何 TS)
 *   ② erasable-syntax-only(禁 enum / namespace / 参数属性 / 装饰器)
 *   ③ 不用 __dirname 也不用 import.meta(两个运行时的模块制式不同,只有一个能用)
 *      —— 路径一律来自 CLI 参数或 process.cwd()
 *
 * ── 四态语义(v4 终审【十一】)──────────────────────────────────────────────
 * 只有机器能**证明授权集合包含关系**时才自动定向:
 *   EQUIVALENT   授权集合不变
 *   NARROWER     收紧(head ⊆ base)—— 放行,但**恒可见**:升级同样改变前端可见
 *                行为(原本可用的端点新增 403),不允许悄悄发生
 *   BROADER      放宽(head ⊇ base)= 降级 —— 须 fragment 申报 + 环境审批
 *   INCOMPARABLE 证明不了任一方向 —— 同降级处置(保守)
 *
 * 各轴独立判定后按格 join:同向合并,反向(NARROWER×BROADER)= INCOMPARABLE,
 * 任一轴 INCOMPARABLE = 整端点 INCOMPARABLE。即「复合变更无法唯一分解 ⇒ 保守」。
 *
 * ⚠️ fragment 是**申报载体,不构成批准**(DECISIONS 第 10 条)。本脚本只判「申报是否
 * 完整」;真正的批准是 GitHub Environment 上的人工点批,由 workflow 消费本脚本输出的
 * approvalRequired 触发。两者缺一不可,且都不是本 PR 能自己改绿的东西。
 *
 * 用法:
 *   tsx scripts/authz-semantic-diff.ts --base origin/main          # 本地/CI 快速反馈
 *   node --experimental-strip-types scripts/authz-semantic-diff.ts \
 *        --base-manifest <file> --head-manifest <file> \
 *        [--fragment-file <file>]… [--graph <file>] [--json <out>]  # trusted 裁判
 *   tsx scripts/authz-semantic-diff.ts --validate-graph            # 只校验蕴含图
 *
 * 退出码:0 = 无阻断项;1 = 有阻断项(申报缺失/申报落空/图非法/manifest 不可解析)。
 * approvalRequired 与退出码**正交** —— 申报齐全时脚本绿,但环境审批仍必须过。
 *
 * ⚠️ 本文件在 harness/redzone.json 的 selfGuard 内(scripts/*-semantic-diff.ts)。
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const MANIFEST_DOC = 'docs/ai-harness/ROUTE_AUTHZ.md';
const MANIFEST_OPEN = '<!-- route-authz-manifest-json';
const MANIFEST_CLOSE = '-->';
const GRAPH_FILE = 'harness/authz-implication-graph.json';
const RBAC_MAP = 'docs/ai-harness/RBAC_MAP.md';
const FRAGMENT_DIR = 'changelog.d';
const FRAGMENT_MARKER = 'authz-downgrade';

/** 本比较器能读懂的 manifest schema。不匹配即 fail-closed(§9 第 3 条)。 */
const SUPPORTED_MANIFEST_SCHEMA = '1.0.0';
const SUPPORTED_GRAPH_SCHEMA = '1.0.0';

/**
 * 蕴含图 ↔ seed 绑定矩阵一致性核对**是否已实现**。
 *
 * ── 这是一道「到期闸」,不是一个开关 ────────────────────────────────────────
 * v4 §7 的 R14 Exit Criteria 要求「蕴含图与 seed 绑定矩阵做一致性核对,声明边与现实
 * 矛盾即告警」。Phase 5 **没做**它 —— 理由是初始边集为空(维护者拍板),这条核对当前
 * 真空;而实现它需要解析 `prisma/seed.ts` 的角色→码矩阵(TS AST),会破坏本文件
 * 「零依赖 / tsx 与裸 node 双运行时」这条地基,而那条地基是 base-trusted 裁判能与本地
 * **共用同一份判据**的前提 —— 比这条核对更根本。
 *
 * 但「本次未做」不能只写在报告里等人记得。沿本仓既有范式:**「此刻不存在」型判据
 * 必须写明到期条件**。到期条件就是「有人往蕴含图里加第一条边」——
 * 边集一旦非空,`validateGraph` 立即红,要求先补核对。
 *
 * ⚠️ 把本常量改成 `true` **必须同时真的实现**并导出 `crossCheckSeedBindings`,
 * 且从 `validateGraph` 调用它。`scripts/harness-guards.selftest.ts` 有结构断言守着
 * 这一点 —— 只翻标志位不实现,自测当场红。本文件在 selfGuard 内,翻它还要过红区人闸。
 */
const SEED_CROSS_CHECK_IMPLEMENTED = false;

export type Mode = 'PUBLIC' | 'LOGIN_ONLY' | 'LOGIN_SCOPED' | 'RESPONSIBILITY_SCOPED' | 'RBAC';

export interface PolicyCode {
  readonly code: string;
  readonly scope: string | null;
}

export interface Policy {
  readonly admission: string | null;
  readonly mode: Mode;
  readonly codes: readonly PolicyCode[];
  readonly require: 'all' | 'any';
  readonly scopes: readonly string[];
  readonly engine: string | null;
  /** Absent in v1.0 manifests means the compatibility default USER. */
  readonly allowedPrincipalKinds?: readonly string[];
}

export interface ManifestEntry {
  readonly routeKey: string;
  readonly controller: string;
  readonly handler: string;
  readonly policy: Policy;
}

export interface Manifest {
  readonly schemaVersion: string;
  readonly generatorVersion: string;
  readonly entries: readonly ManifestEntry[];
}

export type Relation = 'EQUIVALENT' | 'NARROWER' | 'BROADER' | 'INCOMPARABLE';
export type Verdict = Relation | 'ADDED' | 'REMOVED';

export interface AxisResult {
  readonly axis: string;
  readonly relation: Relation;
  readonly detail: string;
}

export interface EndpointDiff {
  readonly routeKey: string;
  readonly verdict: Verdict;
  readonly controller: string;
  readonly handler: string;
  readonly axes: readonly AxisResult[];
  readonly basePolicy: Policy | null;
  readonly headPolicy: Policy | null;
}

export interface Declaration {
  readonly route: string;
  readonly reason: string;
  readonly impact: string;
  readonly migration: string;
  readonly file: string;
  readonly line: number;
}

export interface Finding {
  readonly rule: string;
  readonly layer: string;
  readonly location: string;
  readonly fact: string;
  readonly basis: string;
  readonly remedy: string;
}

// ──────────────────────────────────────────────────────────────────────────
// manifest 解析
// ──────────────────────────────────────────────────────────────────────────

/**
 * 从 ROUTE_AUTHZ.md 里抠出机读 manifest。
 *
 * 为什么不直接读一个 .json:manifest 由 generate-authz-manifest.ts 内嵌在文档里,
 * 文档整体已有逐字新鲜度守护(docs:authz:check)。再落一份 .json 就是第二个真相源。
 */
export function extractManifest(document: string, sourceLabel: string): Manifest {
  const open = document.indexOf(MANIFEST_OPEN);
  if (open < 0) {
    throw new Error(
      sourceLabel + ' 里找不到 ' + MANIFEST_OPEN + ' 块 —— manifest 结构变了或文件不是 ROUTE_AUTHZ',
    );
  }
  const bodyStart = open + MANIFEST_OPEN.length;
  const close = document.indexOf(MANIFEST_CLOSE, bodyStart);
  if (close < 0) {
    throw new Error(sourceLabel + ' 的 manifest 块没有闭合注释');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(document.slice(bodyStart, close));
  } catch (error) {
    throw new Error(
      sourceLabel +
        ' 的 manifest 块不是合法 JSON: ' +
        (error instanceof Error ? error.message : String(error)),
    );
  }
  const manifest = parsed as Manifest;
  if (!manifest || !Array.isArray(manifest.entries)) {
    throw new Error(sourceLabel + ' 的 manifest 缺少 entries 数组');
  }
  if (manifest.schemaVersion !== SUPPORTED_MANIFEST_SCHEMA) {
    // §9 第 3 条:旧 generator 遇新 schemaVersion 恒 fail-closed,不猜。
    throw new Error(
      sourceLabel +
        ' 的 manifest schemaVersion=' +
        String(manifest.schemaVersion) +
        ',本比较器只支持 ' +
        SUPPORTED_MANIFEST_SCHEMA +
        ' —— 无法验证 ≠ 通过,拒绝放行',
    );
  }
  return manifest;
}

// ──────────────────────────────────────────────────────────────────────────
// 权限蕴含图
// ──────────────────────────────────────────────────────────────────────────

export interface ImplicationGraph {
  readonly schemaVersion: string;
  readonly edges: ReadonlyArray<{ readonly from: string; readonly to: string }>;
}

/** 自反传递闭包。空边集 ⇒ 只剩自反 ⇒ 任何换码都不可比(即拍板的默认立场)。 */
export function buildClosure(graph: ImplicationGraph): Map<string, Set<string>> {
  const direct = new Map<string, Set<string>>();
  for (const edge of graph.edges) {
    const outs = direct.get(edge.from) ?? new Set<string>();
    outs.add(edge.to);
    direct.set(edge.from, outs);
  }
  const closure = new Map<string, Set<string>>();
  for (const node of direct.keys()) {
    const seen = new Set<string>([node]);
    const stack = [node];
    while (stack.length > 0) {
      const current = stack.pop() as string;
      for (const next of direct.get(current) ?? []) {
        if (seen.has(next)) continue;
        seen.add(next);
        stack.push(next);
      }
    }
    closure.set(node, seen);
  }
  return closure;
}

/** a ⇒* b(自反:任何码蕴含它自己)。 */
function reaches(closure: Map<string, Set<string>>, from: string, to: string): boolean {
  if (from === to) return true;
  return closure.get(from)?.has(to) === true;
}

/**
 * 蕴含图结构校验。空边集时全部为真空通过,但**闸是接好的** ——
 * 维护者加第一条边的那一刻它就开始判,不是加完边才想起来补检查。
 */
export function validateGraph(
  graph: ImplicationGraph,
  codeUniverse: ReadonlySet<string>,
): Finding[] {
  const findings: Finding[] = [];
  const push = (fact: string, remedy: string): void => {
    findings.push({
      rule: 'R14',
      layer: 'L4 Authorization Contract',
      location: GRAPH_FILE,
      fact,
      basis: '权限蕴含图元规范(harness/authz-implication-graph.json#_comment)+ v4 勘误㉖',
      remedy,
    });
  };
  if (graph.schemaVersion !== SUPPORTED_GRAPH_SCHEMA) {
    push(
      '蕴含图 schemaVersion=' +
        String(graph.schemaVersion) +
        ',本比较器只支持 ' +
        SUPPORTED_GRAPH_SCHEMA,
      '升级比较器或回退登记表版本;版本不匹配恒 fail-closed(§9 第 3 条),不猜语义',
    );
    return findings;
  }
  if (!Array.isArray(graph.edges)) {
    push('蕴含图缺少 edges 数组', '补 "edges": [];空集是合法且已拍板的默认立场');
    return findings;
  }
  // ── 到期闸:加第一条边 ⇒ 必须先补 seed 一致性核对 ────────────────────────
  // 「本次未做」写在报告里会被忘记,写成执行位不会。到期条件 = 边集非空。
  if (graph.edges.length > 0 && !SEED_CROSS_CHECK_IMPLEMENTED) {
    push(
      '蕴含图已有 ' +
        graph.edges.length +
        ' 条边,但「蕴含图 ↔ seed 绑定矩阵一致性核对」尚未实现(v4 §7 R14 Exit Criteria)',
      '加蕴含图边前须先补一致性核对:核对声明边与 seed 现实是否矛盾,矛盾即告警。' +
        '**接法不得破坏比较器的零依赖 / 双运行时地基** —— 那是 base-trusted 裁判' +
        '与本地共用同一份判据的前提(解析 prisma/seed.ts 需要 TS AST,不能直接塞进本文件;' +
        '可行方向是另出一支只在 Fast checks 跑的检查器,把核对结果落成登记表字段)。' +
        '实现后把 SEED_CROSS_CHECK_IMPLEMENTED 置 true 并导出 crossCheckSeedBindings;' +
        '⚠️ 只翻标志位不实现会被 harness-guards.selftest 的结构断言当场抓到。',
    );
    return findings;
  }
  const seen = new Set<string>();
  for (const edge of graph.edges) {
    const label = String(edge?.from) + ' ⇒ ' + String(edge?.to);
    if (typeof edge?.from !== 'string' || typeof edge?.to !== 'string' || !edge.from || !edge.to) {
      push(
        '边 ' + label + ' 的 from/to 不是非空字符串',
        '按 { "from": "<码>", "to": "<码>" } 书写',
      );
      continue;
    }
    if (edge.from === edge.to) {
      push('边 ' + label + ' 是自环', '删掉:自反性是比较器内建的,不需要也不允许显式声明');
      continue;
    }
    if (seen.has(label)) {
      push('边 ' + label + ' 重复声明', '删掉重复项');
      continue;
    }
    seen.add(label);
    for (const code of [edge.from, edge.to]) {
      if (!codeUniverse.has(code)) {
        push(
          '边 ' + label + ' 引用了不存在的权限码 ' + code,
          '权限码全集见 ' + RBAC_MAP + ';打错的码会静默退化成「无路径」,所以这里必须硬红',
        );
      }
    }
  }
  // 成环 = 一组码互相蕴含 = 它们是等价类,应当合并而不是绕圈;放任成环会让
  // 「A 换 B」和「B 换 A」同时判成收紧,两个方向都不需要审批 —— 那是个真窟窿。
  const closure = buildClosure(graph);
  for (const [from, tos] of closure) {
    for (const to of tos) {
      if (to !== from && reaches(closure, to, from)) {
        push(
          '蕴含图成环:' + from + ' 与 ' + to + ' 互相可达',
          '环内的码互相蕴含即等价,应合并为同一个码或删掉其中一条边;' +
            '否则两个方向的换码都会被判成收紧,双向绕过审批',
        );
        return findings;
      }
    }
  }
  return findings;
}

/**
 * 权限码全集(RBAC_MAP 的派生表)。
 *
 * 二次判据:解析出的条数必须等于标题里自报的条数 —— 否则说明 RBAC_MAP 的表格形态
 * 漂了而正则还在「成功」地少抓几条,那种失败会安静地把打错的码放行。
 */
export function parseCodeUniverse(rbacMap: string): Set<string> {
  const start = rbacMap.indexOf('### 权限码全集');
  if (start < 0) throw new Error(RBAC_MAP + ' 里找不到「### 权限码全集」小节');
  const rest = rbacMap.slice(start);
  const nextHeading = rest.indexOf('\n###', 1);
  const section = nextHeading > 0 ? rest.slice(0, nextHeading) : rest;
  const declared = /###\s*权限码全集[（(](\d+)\s*条/.exec(section);
  const codes = new Set<string>();
  for (const match of section.matchAll(/`([a-z][a-z0-9-]*(?:\.[a-z0-9-]+)+)`/g)) {
    codes.add(match[1]);
  }
  if (declared && Number(declared[1]) !== codes.size) {
    throw new Error(
      RBAC_MAP +
        ' 权限码全集自报 ' +
        declared[1] +
        ' 条,实际解析到 ' +
        codes.size +
        ' 条 —— 表格形态与解析器已经不一致,拒绝在不确定的码全集上判边',
    );
  }
  return codes;
}

// ──────────────────────────────────────────────────────────────────────────
// 四态比较器
// ──────────────────────────────────────────────────────────────────────────

/** 格 join:同向合并;反向 = 不可比;任一不可比 = 不可比。 */
export function join(left: Relation, right: Relation): Relation {
  if (left === right) return left;
  if (left === 'EQUIVALENT') return right;
  if (right === 'EQUIVALENT') return left;
  return 'INCOMPARABLE';
}

/**
 * mode 强弱格。
 *
 *   PUBLIC(0) < LOGIN_ONLY(1) < { LOGIN_SCOPED, RESPONSIBILITY_SCOPED, RBAC }(2)
 *
 * 第 2 层三者**互不可比** —— 「持码」「在可见范围内」「负有职责」是三种不同的准入
 * 条件,持有者集合互不包含。层级可比是因为高层恒 = 登录 + 一个额外条件,必是低层子集。
 */
const MODE_LEVEL: Record<Mode, number> = {
  PUBLIC: 0,
  LOGIN_ONLY: 1,
  LOGIN_SCOPED: 2,
  RESPONSIBILITY_SCOPED: 2,
  RBAC: 2,
};

export function compareMode(base: Mode, head: Mode): AxisResult {
  const detail = base + ' → ' + head;
  if (base === head) return { axis: 'mode', relation: 'EQUIVALENT', detail };
  const baseLevel = MODE_LEVEL[base];
  const headLevel = MODE_LEVEL[head];
  if (baseLevel === undefined || headLevel === undefined) {
    return { axis: 'mode', relation: 'INCOMPARABLE', detail: detail + '(存在未知 mode)' };
  }
  if (headLevel > baseLevel) return { axis: 'mode', relation: 'NARROWER', detail };
  if (headLevel < baseLevel) return { axis: 'mode', relation: 'BROADER', detail };
  return {
    axis: 'mode',
    relation: 'INCOMPARABLE',
    detail: detail + '(同层不同模式,持有者集合互不包含)',
  };
}

export function compareAdmission(base: string | null, head: string | null): AxisResult {
  const detail = (base ?? '-') + ' → ' + (head ?? '-');
  if (base === head) return { axis: 'admission', relation: 'EQUIVALENT', detail };
  if (base === null) return { axis: 'admission', relation: 'NARROWER', detail };
  if (head === null) return { axis: 'admission', relation: 'BROADER', detail };
  return { axis: 'admission', relation: 'INCOMPARABLE', detail };
}

function effectivePrincipalKinds(policy: Policy): readonly string[] {
  if (policy.mode === 'PUBLIC') return ['PUBLIC'];
  return policy.allowedPrincipalKinds ?? ['USER'];
}

/** A smaller accepted-principal set is narrower; disjoint sets are incomparable. */
export function comparePrincipalKinds(base: Policy, head: Policy): AxisResult {
  const baseKinds = effectivePrincipalKinds(base);
  const headKinds = effectivePrincipalKinds(head);
  const detail = baseKinds.join('+') + ' → ' + headKinds.join('+');

  // PUBLIC admits requests without an authenticated principal. Moving from it
  // to any authenticated kind is a strict narrowing; the reverse is broader.
  if (base.mode === 'PUBLIC' && head.mode !== 'PUBLIC') {
    return { axis: 'principalKinds', relation: 'NARROWER', detail };
  }
  if (base.mode !== 'PUBLIC' && head.mode === 'PUBLIC') {
    return { axis: 'principalKinds', relation: 'BROADER', detail };
  }

  const baseSet = new Set(baseKinds);
  const headSet = new Set(headKinds);
  const headSubset = headKinds.every((kind) => baseSet.has(kind));
  const baseSubset = baseKinds.every((kind) => headSet.has(kind));
  if (headSubset && baseSubset) {
    return { axis: 'principalKinds', relation: 'EQUIVALENT', detail };
  }
  if (headSubset) return { axis: 'principalKinds', relation: 'NARROWER', detail };
  if (baseSubset) return { axis: 'principalKinds', relation: 'BROADER', detail };
  return { axis: 'principalKinds', relation: 'INCOMPARABLE', detail };
}

/**
 * 「满足 from 是否**保证**满足 to」。require 语义在这里分派 —— 这是 v4 勘误㉕
 * 点名的那个错误来源:`any` 集与 `all` 集的增减方向是**相反的**。
 */
export function impliesCodeCondition(
  from: readonly PolicyCode[],
  fromRequire: 'all' | 'any',
  to: readonly PolicyCode[],
  toRequire: 'all' | 'any',
  closure: Map<string, Set<string>>,
): boolean {
  if (to.length === 0) return true; // 无要求,人人满足
  if (from.length === 0) return false; // 无要求推不出有要求
  const fromCodes = from.map((entry) => entry.code);
  const toCodes = to.map((entry) => entry.code);
  if (fromRequire === 'all' && toRequire === 'all') {
    // 持有 from 全部 ⇒ 必须能覆盖 to 的每一条
    return toCodes.every((t) => fromCodes.some((f) => reaches(closure, f, t)));
  }
  if (fromRequire === 'all' && toRequire === 'any') {
    // 持有 from 全部 ⇒ 只要能覆盖 to 的任意一条
    return toCodes.some((t) => fromCodes.some((f) => reaches(closure, f, t)));
  }
  if (fromRequire === 'any' && toRequire === 'all') {
    // 只持有 from 中任意一条 ⇒ 那一条必须单独覆盖 to 全部
    return fromCodes.every((f) => toCodes.every((t) => reaches(closure, f, t)));
  }
  // any → any:from 的每条进门路都必须落进 to 的某条进门路
  return fromCodes.every((f) => toCodes.some((t) => reaches(closure, f, t)));
}

/** 码绑定 scope 的方向:无 scope 比有 scope 宽。 */
function compareBoundScopes(base: readonly PolicyCode[], head: readonly PolicyCode[]): Relation {
  const headScopes = new Map<string, string | null>();
  for (const entry of head) headScopes.set(entry.code, entry.scope);
  let relation: Relation = 'EQUIVALENT';
  for (const entry of base) {
    if (!headScopes.has(entry.code)) continue; // 只在两边都出现的码上比 scope
    const headScope = headScopes.get(entry.code) ?? null;
    if (entry.scope === headScope) continue;
    if (entry.scope === null) relation = join(relation, 'NARROWER');
    else if (headScope === null) relation = join(relation, 'BROADER');
    else relation = join(relation, 'INCOMPARABLE');
  }
  return relation;
}

export function compareCodes(
  base: Policy,
  head: Policy,
  closure: Map<string, Set<string>>,
): AxisResult {
  const label = (policy: Policy): string =>
    policy.codes.length === 0
      ? '-'
      : policy.require +
        ':[' +
        policy.codes
          .map((entry) => entry.code + (entry.scope === null ? '' : '@' + entry.scope))
          .join(', ') +
        ']';
  const detail = label(base) + ' → ' + label(head);
  const headImpliesBase = impliesCodeCondition(
    head.codes,
    head.require,
    base.codes,
    base.require,
    closure,
  );
  const baseImpliesHead = impliesCodeCondition(
    base.codes,
    base.require,
    head.codes,
    head.require,
    closure,
  );
  let relation: Relation;
  if (headImpliesBase && baseImpliesHead) relation = 'EQUIVALENT';
  else if (headImpliesBase) relation = 'NARROWER';
  else if (baseImpliesHead) relation = 'BROADER';
  else relation = 'INCOMPARABLE';
  return {
    axis: 'codes',
    relation: join(relation, compareBoundScopes(base.codes, head.codes)),
    detail,
  };
}

export function compareScopes(base: readonly string[], head: readonly string[]): AxisResult {
  const baseSet = new Set(base);
  const headSet = new Set(head);
  const detail =
    (base.length ? base.join('+') : '-') + ' → ' + (head.length ? head.join('+') : '-');
  const headHasAllBase = [...baseSet].every((scope) => headSet.has(scope));
  const baseHasAllHead = [...headSet].every((scope) => baseSet.has(scope));
  if (headHasAllBase && baseHasAllHead) return { axis: 'scopes', relation: 'EQUIVALENT', detail };
  if (headHasAllBase) return { axis: 'scopes', relation: 'NARROWER', detail };
  if (baseHasAllHead) return { axis: 'scopes', relation: 'BROADER', detail };
  return { axis: 'scopes', relation: 'INCOMPARABLE', detail };
}

/** 该侧是否存在需要 engine 去判的东西。engine=null ⟺ 无判定面(实测 498/498 成立)。 */
function hasJudgingSurface(policy: Policy): boolean {
  return policy.codes.length > 0 || policy.scopes.length > 0;
}

/**
 * engine 轴。
 *
 * v4:「engine 变化恒 INCOMPARABLE」,理由写明是 **rbac-global ↔ authz-scoped**
 * 改变了「谁能通过」的判定方式 —— 三源 scoped grant 与 GLOBAL 单轨的持有者集合互不包含。
 *
 * ⚠️ 本实现把该规则**限定在它讲得通的地方**:engine 只作用于 codes/scopes 的判定。
 * 某一侧没有任何 codes/scopes 时(实测即 PUBLIC/LOGIN_ONLY,engine 恒 null),那一侧的
 * 准入完全由 admission+mode 决定,engine 是惰性的,拿它去逼出 INCOMPARABLE 只会让
 * 「LOGIN_ONLY → RBAC」这种**纯收紧**也要人工审批。误伤会摧毁守护的可信度,而这里的
 * 放宽是可证的:无判定面的一侧其准入集合与 engine 取值无关。
 * 两侧都有判定面且 engine 不同 ⇒ 仍恒 INCOMPARABLE(v4 原意的场景)。
 * 此处对 v4 字面表述的收敛已在收口报告「与权威源的偏离」一节具名列出,待维护者裁决。
 */
export function compareEngine(base: Policy, head: Policy): AxisResult {
  const detail = (base.engine ?? '-') + ' → ' + (head.engine ?? '-');
  if (base.engine === head.engine) return { axis: 'engine', relation: 'EQUIVALENT', detail };
  if (!hasJudgingSurface(base) || !hasJudgingSurface(head)) {
    return {
      axis: 'engine',
      relation: 'EQUIVALENT',
      detail: detail + '(一侧无 codes/scopes,engine 惰性,由其余轴定向)',
    };
  }
  return {
    axis: 'engine',
    relation: 'INCOMPARABLE',
    detail: detail + '(两侧均有判定面且判定引擎不同,持有者集合互不包含)',
  };
}

export function comparePolicy(
  base: Policy,
  head: Policy,
  closure: Map<string, Set<string>>,
): { verdict: Relation; axes: AxisResult[] } {
  const axes = [
    compareAdmission(base.admission, head.admission),
    comparePrincipalKinds(base, head),
    compareMode(base.mode, head.mode),
    compareCodes(base, head, closure),
    compareScopes(base.scopes, head.scopes),
    compareEngine(base, head),
  ];
  let verdict: Relation = 'EQUIVALENT';
  for (const axis of axes) verdict = join(verdict, axis.relation);
  return { verdict, axes };
}

export function diffManifests(
  base: Manifest,
  head: Manifest,
  closure: Map<string, Set<string>>,
): EndpointDiff[] {
  const baseByKey = new Map<string, ManifestEntry>();
  for (const entry of base.entries) baseByKey.set(entry.routeKey, entry);
  const headByKey = new Map<string, ManifestEntry>();
  for (const entry of head.entries) headByKey.set(entry.routeKey, entry);

  const diffs: EndpointDiff[] = [];
  for (const [routeKey, headEntry] of headByKey) {
    const baseEntry = baseByKey.get(routeKey);
    if (!baseEntry) {
      diffs.push({
        routeKey,
        verdict: 'ADDED',
        controller: headEntry.controller,
        handler: headEntry.handler,
        axes: [],
        basePolicy: null,
        headPolicy: headEntry.policy,
      });
      continue;
    }
    const { verdict, axes } = comparePolicy(baseEntry.policy, headEntry.policy, closure);
    diffs.push({
      routeKey,
      verdict,
      controller: headEntry.controller,
      handler: headEntry.handler,
      axes,
      basePolicy: baseEntry.policy,
      headPolicy: headEntry.policy,
    });
  }
  for (const [routeKey, baseEntry] of baseByKey) {
    if (headByKey.has(routeKey)) continue;
    diffs.push({
      routeKey,
      verdict: 'REMOVED',
      controller: baseEntry.controller,
      handler: baseEntry.handler,
      axes: [],
      basePolicy: baseEntry.policy,
      headPolicy: null,
    });
  }
  diffs.sort((left, right) => left.routeKey.localeCompare(right.routeKey));
  return diffs;
}

// ──────────────────────────────────────────────────────────────────────────
// fragment 申报
// ──────────────────────────────────────────────────────────────────────────

const DECLARATION_KEYS = ['route', 'reason', 'impact', 'migration'] as const;

/**
 * 解析 changelog.d fragment 里的申报块:
 *
 *   <!-- authz-downgrade
 *   route: GET /api/admin/v1/foo
 *   reason: 为什么必须放宽
 *   impact: 影响面(谁的可达性变了)
 *   migration: 迁移方式(调用方要做什么)
 *   -->
 *
 * 只认**本 PR 新增/改动**的 fragment —— changelog.d 在发版前会攒着历史 fragment,
 * 拿全目录去判会让上一刀的申报在下一刀变成「落空申报」的假红。
 */
export function parseDeclarations(
  files: ReadonlyArray<{ readonly path: string; readonly content: string }>,
): { declarations: Declaration[]; findings: Finding[] } {
  const declarations: Declaration[] = [];
  const findings: Finding[] = [];
  for (const file of files) {
    const lines = file.content.split('\n');
    for (let index = 0; index < lines.length; index++) {
      if (lines[index].trim() !== '<!-- ' + FRAGMENT_MARKER) continue;
      const startLine = index + 1;
      const fields = new Map<string, string>();
      let cursor = index + 1;
      let closed = false;
      while (cursor < lines.length) {
        const line = lines[cursor].trim();
        if (line === '-->') {
          closed = true;
          break;
        }
        const separator = line.indexOf(':');
        if (separator > 0) {
          fields.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
        }
        cursor++;
      }
      index = cursor;
      if (!closed) {
        findings.push({
          rule: 'R14',
          layer: 'L4 Authorization Contract',
          location: file.path + ':' + startLine,
          fact: 'authz-downgrade 申报块没有 --> 闭合',
          basis: 'R14 申报格式(scripts/authz-semantic-diff.ts 头注)',
          remedy: '补上闭合行 -->',
        });
        continue;
      }
      const missing = DECLARATION_KEYS.filter((key) => !(fields.get(key) ?? '').trim());
      if (missing.length > 0) {
        findings.push({
          rule: 'R14',
          layer: 'L4 Authorization Contract',
          location: file.path + ':' + startLine,
          fact: 'authz-downgrade 申报块缺少非空字段: ' + missing.join(', '),
          basis: 'R14 申报字段(原因 / 影响端点 / 迁移方式)—— goal Phase 5 D1',
          remedy:
            '补齐 route / reason / impact / migration 四行;' +
            '空洞申报等于没申报,而申报本身也不构成批准(DECISIONS 第 10 条)',
        });
        continue;
      }
      declarations.push({
        route: (fields.get('route') as string).trim(),
        reason: (fields.get('reason') as string).trim(),
        impact: (fields.get('impact') as string).trim(),
        migration: (fields.get('migration') as string).trim(),
        file: file.path,
        line: startLine,
      });
    }
  }
  return { declarations, findings };
}

export function judgeDeclarations(
  diffs: readonly EndpointDiff[],
  declarations: readonly Declaration[],
): Finding[] {
  const findings: Finding[] = [];
  const flagged = diffs.filter(
    (diff) => diff.verdict === 'BROADER' || diff.verdict === 'INCOMPARABLE',
  );
  const declaredRoutes = new Set(declarations.map((declaration) => declaration.route));
  for (const diff of flagged) {
    if (declaredRoutes.has(diff.routeKey)) continue;
    const axisText = diff.axes
      .filter((axis) => axis.relation !== 'EQUIVALENT')
      .map((axis) => axis.axis + ' ' + axis.relation + '(' + axis.detail + ')')
      .join('; ');
    findings.push({
      rule: 'R14',
      layer: 'L4 Authorization Contract',
      location: diff.routeKey + '  ' + diff.controller + '.' + diff.handler,
      fact:
        '授权语义判定 ' +
        diff.verdict +
        (diff.verdict === 'BROADER' ? '(保护等级降级)' : '(证明不了强弱,保守按降级处置)') +
        ':' +
        (axisText || '无差异轴'),
      basis:
        MANIFEST_DOC + ' 的 base↔head 结构化策略;判定规则见 scripts/authz-semantic-diff.ts 头注',
      remedy:
        '① 若非本意 —— 改回声明,让本端点回到 EQUIVALENT/NARROWER;' +
        '② 若确需放宽 —— 在 changelog.d/ 的 fragment 里补 authz-downgrade 申报块' +
        '(route/reason/impact/migration 四行),并由维护者在 harness-review 环境点批。' +
        '申报是记录载体,不构成批准(DECISIONS 第 10 条),AI 不得自批。',
    });
  }
  const flaggedRoutes = new Set(flagged.map((diff) => diff.routeKey));
  for (const declaration of declarations) {
    if (flaggedRoutes.has(declaration.route)) continue;
    findings.push({
      rule: 'R14',
      layer: 'L4 Authorization Contract',
      location: declaration.file + ':' + declaration.line,
      fact: '申报了 ' + declaration.route + ' 的授权降级,但本次 diff 里该端点没有降级/不可比',
      basis: MANIFEST_DOC + ' 的 base↔head 比对结果',
      remedy:
        '删掉这个申报块,或核对 route 是否写错(必须与 manifest 的 routeKey 逐字一致,' +
        '形如 "GET /api/admin/v1/foo")。留着不实的降级申报会污染审计记录。',
    });
  }
  return findings;
}

// ──────────────────────────────────────────────────────────────────────────
// 渲染
// ──────────────────────────────────────────────────────────────────────────

const VERDICT_LABEL: Record<Verdict, string> = {
  EQUIVALENT: '不变',
  NARROWER: '收紧(放行,恒可见)',
  BROADER: '降级(须申报+审批)',
  INCOMPARABLE: '不可比(保守,须申报+审批)',
  ADDED: '新增端点',
  REMOVED: '移除端点',
};

export function renderReport(diffs: readonly EndpointDiff[], findings: readonly Finding[]): string {
  const lines: string[] = [];
  const counts = new Map<Verdict, number>();
  for (const diff of diffs) counts.set(diff.verdict, (counts.get(diff.verdict) ?? 0) + 1);
  const order: Verdict[] = [
    'BROADER',
    'INCOMPARABLE',
    'NARROWER',
    'ADDED',
    'REMOVED',
    'EQUIVALENT',
  ];

  lines.push('[L4/R14] 授权语义 diff —— ROUTE_AUTHZ base ↔ head');
  lines.push(
    '  ' +
      order.map((verdict) => verdict + '=' + (counts.get(verdict) ?? 0)).join('  ') +
      '  (共 ' +
      diffs.length +
      ' 个端点)',
  );
  lines.push('');

  // 全量迁移清单恒可见:收紧同样改变前端可见行为(原本可用的端点新增 403)。
  const migrations = diffs.filter((diff) => diff.verdict !== 'EQUIVALENT');
  if (migrations.length === 0) {
    lines.push('  授权语义无变化 —— 无迁移清单。');
  } else {
    lines.push('  ── 全量语义迁移清单(升/平/降恒可见)──');
    for (const diff of migrations) {
      lines.push(
        '  · [' + diff.verdict + '] ' + VERDICT_LABEL[diff.verdict] + '  ' + diff.routeKey,
      );
      lines.push('      ' + diff.controller + '.' + diff.handler);
      for (const axis of diff.axes) {
        if (axis.relation === 'EQUIVALENT') continue;
        lines.push('      ' + axis.axis + ': ' + axis.detail + '  ⇒ ' + axis.relation);
      }
      if (diff.verdict === 'ADDED' && diff.headPolicy) {
        lines.push('      新端点策略: ' + describePolicy(diff.headPolicy));
      }
      if (diff.verdict === 'REMOVED' && diff.basePolicy) {
        lines.push('      原策略: ' + describePolicy(diff.basePolicy));
      }
    }
  }
  lines.push('');

  if (findings.length === 0) {
    lines.push('  ✓ 无阻断项。');
  } else {
    lines.push('  ── 阻断项 ' + findings.length + ' 条 ──');
    for (const finding of findings) {
      lines.push('');
      lines.push('[' + finding.layer.split(' ')[0] + '/' + finding.rule + '] ' + finding.location);
      lines.push('  事实: ' + finding.fact);
      lines.push('  依据: ' + finding.basis);
      lines.push('  处置: ' + finding.remedy);
    }
  }
  return lines.join('\n');
}

function describePolicy(policy: Policy): string {
  return (
    'admission=' +
    (policy.admission ?? '-') +
    '; mode=' +
    policy.mode +
    '; codes=' +
    (policy.codes.length
      ? policy.require + ':' + policy.codes.map((entry) => entry.code).join(',')
      : '-') +
    '; scopes=' +
    (policy.scopes.length ? policy.scopes.join('+') : '-') +
    '; engine=' +
    (policy.engine ?? '-') +
    (policy.allowedPrincipalKinds === undefined
      ? ''
      : '; principals=' + policy.allowedPrincipalKinds.join(','))
  );
}

// ──────────────────────────────────────────────────────────────────────────
// CLI
// ──────────────────────────────────────────────────────────────────────────

function readFile(file: string): string {
  return fs.readFileSync(file, 'utf8');
}

function git(root: string, args: readonly string[]): string {
  return execFileSync('git', args as string[], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

function optionValue(argv: readonly string[], name: string): string | null {
  const index = argv.indexOf(name);
  if (index < 0 || index + 1 >= argv.length) return null;
  return argv[index + 1];
}

function optionValues(argv: readonly string[], name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === name && index + 1 < argv.length) values.push(argv[index + 1]);
  }
  return values;
}

function main(): void {
  const argv = process.argv.slice(2);
  const root = optionValue(argv, '--root') ?? process.cwd();
  const graphFile = optionValue(argv, '--graph') ?? path.join(root, GRAPH_FILE);
  const rbacMapFile = optionValue(argv, '--rbac-map') ?? path.join(root, RBAC_MAP);

  const graph = JSON.parse(readFile(graphFile)) as ImplicationGraph;
  const graphFindings = validateGraph(graph, parseCodeUniverse(readFile(rbacMapFile)));

  if (argv.includes('--validate-graph')) {
    if (graphFindings.length > 0) {
      process.stderr.write(renderReport([], graphFindings) + '\n');
      process.exit(1);
    }
    process.stdout.write(
      '权限蕴含图合法:' +
        graph.edges.length +
        ' 条边' +
        (graph.edges.length === 0 ? '(空集 = 任何换码恒不可比,已拍板的默认立场)' : '') +
        '\n',
    );
    return;
  }

  let baseDocument: string;
  let headDocument: string;
  let fragmentFiles: Array<{ path: string; content: string }>;

  const explicitBase = optionValue(argv, '--base-manifest');
  const explicitHead = optionValue(argv, '--head-manifest');
  if (explicitBase && explicitHead) {
    // trusted 裁判形态:base 来自 base checkout,head 由 workflow 经 GitHub API 取回。
    baseDocument = readFile(explicitBase);
    headDocument = readFile(explicitHead);
    fragmentFiles = optionValues(argv, '--fragment-file').map((file) => ({
      path: file,
      content: readFile(file),
    }));
  } else {
    // 本地 / Fast checks 形态:base 取自 git ref,head 取自工作树。
    const baseRef = optionValue(argv, '--base') ?? 'origin/main';
    baseDocument = git(root, ['show', baseRef + ':' + MANIFEST_DOC]);
    headDocument = readFile(path.join(root, MANIFEST_DOC));
    const changed = new Set<string>();
    for (const line of git(root, ['diff', '--name-only', baseRef, '--', FRAGMENT_DIR]).split(
      '\n',
    )) {
      if (line.trim()) changed.add(line.trim());
    }
    for (const line of git(root, [
      'ls-files',
      '--others',
      '--exclude-standard',
      FRAGMENT_DIR,
    ]).split('\n')) {
      if (line.trim()) changed.add(line.trim());
    }
    fragmentFiles = [...changed]
      .filter((file) => file.endsWith('.md') && !file.endsWith('README.md'))
      .filter((file) => fs.existsSync(path.join(root, file)))
      .map((file) => ({ path: file, content: readFile(path.join(root, file)) }));
  }

  const baseManifest = extractManifest(baseDocument, 'base ' + MANIFEST_DOC);
  const headManifest = extractManifest(headDocument, 'head ' + MANIFEST_DOC);
  const diffs = diffManifests(baseManifest, headManifest, buildClosure(graph));
  const parsed = parseDeclarations(fragmentFiles);
  const findings = [
    ...graphFindings,
    ...parsed.findings,
    ...judgeDeclarations(diffs, parsed.declarations),
  ];
  const approvalRequired = diffs.some(
    (diff) => diff.verdict === 'BROADER' || diff.verdict === 'INCOMPARABLE',
  );

  const jsonOut = optionValue(argv, '--json');
  if (jsonOut) {
    fs.writeFileSync(
      jsonOut,
      JSON.stringify(
        {
          rule: 'R14',
          layer: 'L4 Authorization Contract',
          approvalRequired,
          blocking: findings.length > 0,
          counts: diffs.reduce<Record<string, number>>((all, diff) => {
            all[diff.verdict] = (all[diff.verdict] ?? 0) + 1;
            return all;
          }, {}),
          migrations: diffs.filter((diff) => diff.verdict !== 'EQUIVALENT'),
          findings,
        },
        null,
        2,
      ) + '\n',
      'utf8',
    );
  }

  process.stdout.write(renderReport(diffs, findings) + '\n');
  if (approvalRequired) {
    process.stdout.write(
      '\n⚠️ 本次含降级/不可比端点 —— 除申报外,还必须由维护者在 harness-review 环境点批。\n' +
        '   权威裁决在 Red-zone (trusted) 工作流(跑 base 版判据),本地/Fast checks 只是快速反馈。\n',
    );
  }
  if (findings.length > 0) process.exit(1);
}

// 被 selftest import 时不跑 CLI(两个运行时都靠这个判据:进程 argv 里有本文件名)。
const invokedDirectly =
  process.argv[1] !== undefined && /authz-semantic-diff\.ts$/.test(process.argv[1]);
if (invokedDirectly) {
  try {
    main();
  } catch (error) {
    process.stderr.write(
      'authz-semantic-diff failed: ' +
        (error instanceof Error ? error.message : String(error)) +
        '\n',
    );
    process.exit(1);
  }
}
