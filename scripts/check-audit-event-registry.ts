import { readFileSync, readdirSync } from 'node:fs';
import * as path from 'node:path';

import * as ts from 'typescript';

// ══════════════════════════════════════════════════════════════════════════
// 审计事件登记表双向对拍判据 —— P2-23b(2026-08-27;同日自 spec 收编本文件)
// ══════════════════════════════════════════════════════════════════════════
//
// 合同 ④「字典、Audit events … 生成并对账」在 Audit events 半上此前零判据:
// 事件名已被 `audit-logs.types.ts` 的闭 union `AuditLogEvent` 收编(TS 静态锁
// 三条写库漏斗的调用点),但 union 里**有哪些事件**没有任何对外清单 ——
// ④-b 的签字只能「接受现状」。本判据把那半变成机器可判:
//
//   D1  union 提取闭集 —— AuditLogEvent 必须是纯字符串字面量 union,
//       出现非字面量成员(模板 / 引用)⇒ fail-closed 红(提取不到 = 红,不是跳过)。
//   D2  登记表声明行对拍 ——「**审计事件(机器核对):N 个 · 活跃:A · 已退役/零产出:Z**」
//       三段数字与实测相等。
//   D3  正向(漏登记)—— union 里每个事件都必须在登记表;漏一条 ⇒ 红,点名。
//   D4  反向(多登记 / 已消失)—— 登记表每条都必须真在 union;幽灵 ⇒ 红。
//   D5  出现次数镜像 —— 登记表「仓内出现次数」与 AST 全仓扫描逐条相等
//       (口径:src/** 下字符串字面量,排除 audit-logs.types.ts 与 *.spec.ts,
//        含常量定义与三元分支,不含注释)。
//   D6  零产出闭集 —— 出现次数为 0 ⇒ 备注必须显式含「已退役」或「零产出」;
//       次数 > 0 ⇒ 备注不得声称退役。静默死事件 ⇒ 红。
//
// 形态(2026-08-27 收编):本文件是判据本体,住 selfGuard 红区(`scripts/check-*.ts`);
// `src/modules/audit-logs/audit-event-registry.spec.ts` 是薄运行器(真读数 +
// 常驻变异对拍 M1–M6),不承载实质逻辑。P2-23b 首发时的零红区形态随维护者
// 2026-08-27 令牌收编升级 —— 详见 NEXT_TASKS P2-23b。

export const AUDIT_TYPES_PATH = 'src/modules/audit-logs/audit-logs.types.ts';
export const AUDIT_REGISTRY_PATH = 'docs/ai-harness/AUDIT_EVENT_REGISTRY.md';
export const AUDIT_SRC_ROOT = 'src';

// ─── 提取器 1:union(AST;fail-closed)─────────────────────────────────────

interface UnionParse {
  /** 按声明顺序的成员字面量(未去重;D1 查重)。 */
  members: string[];
  /** 仪器缺陷:非字面量成员 / 找不到别名 / 不是 union —— 一律 fail-closed。 */
  defects: string[];
}

export function extractUnion(source: string): UnionParse {
  const sf = ts.createSourceFile('audit-logs.types.ts', source, ts.ScriptTarget.Latest, true);
  const defects: string[] = [];
  const members: string[] = [];
  let found = false;
  for (const st of sf.statements) {
    if (ts.isTypeAliasDeclaration(st) && st.name.text === 'AuditLogEvent') {
      found = true;
      if (!ts.isUnionTypeNode(st.type)) {
        defects.push('AuditLogEvent 不是 union(形态变了,提取器需要人看)');
        continue;
      }
      for (const m of st.type.types) {
        if (ts.isLiteralTypeNode(m) && ts.isStringLiteral(m.literal)) {
          members.push(m.literal.text);
        } else {
          defects.push(`非字符串字面量成员(${ts.SyntaxKind[m.kind]})—— fail-closed`);
        }
      }
    }
  }
  if (!found) defects.push('未找到 type AuditLogEvent 声明(文件形态变了,提取器需要人看)');
  const seen = new Set<string>();
  for (const m of members) {
    if (seen.has(m)) defects.push(`union 成员重复:'${m}'`);
    seen.add(m);
  }
  return { members, defects };
}

// ─── 提取器 2:登记表(文本)───────────────────────────────────────────────

interface RegistryRow {
  event: string;
  count: number;
  note: string;
}

interface RegistryParse {
  rows: RegistryRow[];
  declared: { total: number; active: number; zero: number } | null;
  defects: string[];
}

const DECLARED_LINE_RE =
  /^\*\*审计事件\(机器核对\):(\d+) 个 · 活跃\(≥1 次出现\):(\d+) · 已退役\/零产出:(\d+)\*\*$/;
const ROW_RE = /^\| `([^`]+)` \| (\d+) \| ?(.*?) ?\|$/;

export function parseRegistry(text: string | null): RegistryParse {
  const rows: RegistryRow[] = [];
  const defects: string[] = [];
  let declared: RegistryParse['declared'] = null;
  let inTable = false;
  let declaredSeen = false;
  const seen = new Set<string>();
  for (const line of text === null ? [] : text.split('\n')) {
    const decl = line.trim().match(DECLARED_LINE_RE);
    if (decl) {
      if (declaredSeen) defects.push('声明行出现两次');
      declaredSeen = true;
      declared = { total: +decl[1], active: +decl[2], zero: +decl[3] };
      continue;
    }
    if (line.startsWith('| event |')) {
      inTable = true;
      continue;
    }
    if (line.startsWith('|---')) continue;
    if (line.startsWith('|')) {
      if (!inTable) {
        defects.push(`无法解析的表格行(表头之外):${line.slice(0, 60)}`);
        continue;
      }
      const m = line.match(ROW_RE);
      if (!m) {
        defects.push(`无法解析的表格行:${line.slice(0, 60)}`);
        continue;
      }
      const event = m[1];
      if (seen.has(event)) defects.push(`登记表重复条目:'${event}'`);
      seen.add(event);
      rows.push({ event, count: +m[2], note: m[3].trim() });
      continue;
    }
    if (inTable && line.trim() === '') inTable = false;
  }
  if (!declaredSeen) defects.push('未找到声明行(「审计事件(机器核对):…」)');
  if (text === null) defects.unshift('登记表文件不存在');
  return { rows, declared, defects };
}

// ─── 提取器 3:全仓出现计数(AST 字面量,不含注释)────────────────────────

/** 扫描根下的非 spec TS 文件清单(相对 repoRoot;排除调用方点名的排除项)。 */
export function listSourceFiles(root: string, exclude: readonly string[] = []): string[] {
  const acc: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (p.endsWith('.ts') && !p.endsWith('.spec.ts')) acc.push(p);
    }
  };
  walk(root);
  return acc.filter((f) => !exclude.includes(f));
}

export function countOccurrences(files: string[], events: Set<string>): Map<string, number> {
  const counts = new Map<string, number>([...events].map((e) => [e, 0]));
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      if (ts.isStringLiteral(node) && counts.has(node.text)) {
        counts.set(node.text, (counts.get(node.text) ?? 0) + 1);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return counts;
}

// ─── 六维判决(纯函数)─────────────────────────────────────────────────────

export type AuditRegistryDimensions = Record<
  'D0' | 'D1' | 'D2' | 'D3' | 'D4' | 'D5' | 'D6',
  string[]
>;

export function allDimensions(
  unionSource: string,
  registryText: string,
  counts: ReadonlyMap<string, number>,
): AuditRegistryDimensions {
  const u = extractUnion(unionSource);
  const r = parseRegistry(registryText);
  const members = u.members;
  const memberSet = new Set(members);

  const d0 = [...u.defects, ...r.defects];

  const d1: string[] = [...u.defects];

  const d2: string[] = [];
  if (r.declared && u.defects.length === 0) {
    const zero = members.filter((m) => (counts.get(m) ?? 0) === 0).length;
    const active = members.length - zero;
    if (r.declared.total !== members.length) {
      d2.push(`声明总数不符:声明 ${r.declared.total},实际解析到 ${members.length}`);
    }
    if (r.declared.active !== active) {
      d2.push(`声明活跃数不符:声明 ${r.declared.active},实际 ${active}`);
    }
    if (r.declared.zero !== zero) {
      d2.push(`声明零产出数不符:声明 ${r.declared.zero},实际 ${zero}`);
    }
  }

  const d3: string[] = [];
  if (u.defects.length === 0) {
    for (const m of memberSet) {
      if (!r.rows.some((row) => row.event === m)) d3.push(`union 事件未登记:'${m}'`);
    }
  }

  const d4: string[] = [];
  for (const row of r.rows) {
    if (u.defects.length === 0 && !memberSet.has(row.event)) {
      d4.push(`登记表条目不在 union(多登记 / 已消失):'${row.event}'`);
    }
  }

  const d5: string[] = [];
  if (u.defects.length === 0) {
    for (const row of r.rows) {
      if (!memberSet.has(row.event)) continue;
      const actual = counts.get(row.event) ?? 0;
      if (actual !== row.count) {
        d5.push(`出现次数漂移:'${row.event}' 登记 ${row.count},实测 ${actual}`);
      }
    }
  }

  const d6: string[] = [];
  if (u.defects.length === 0) {
    for (const row of r.rows) {
      if (!memberSet.has(row.event)) continue;
      const actual = counts.get(row.event) ?? 0;
      const marked = row.note.includes('已退役') || row.note.includes('零产出');
      if (actual === 0 && !marked) {
        d6.push(`零产出事件未标注(静默死事件):'${row.event}'`);
      }
      if (actual > 0 && row.note.includes('已退役')) {
        d6.push(`备注声称已退役但仍有 ${actual} 处出现:'${row.event}'`);
      }
    }
  }

  return { D0: d0, D1: d1, D2: d2, D3: d3, D4: d4, D5: d5, D6: d6 };
}

// ─── 对外出口:judge + 读数 + CLI ──────────────────────────────────────────

export interface AuditRegistryJudgement {
  readonly ok: boolean;
  readonly evidence: readonly string[];
  /** cutover:check ④ 的对拍读数(提取塌了给 -1,由计数型判据判红)。 */
  readonly counts: { readonly total: number; readonly active: number; readonly zero: number };
}

/** 真仓判决:types.ts + 登记表 + 全仓扫描一次跑完。 */
export function judgeAuditEventRegistry(
  typesSource: string | null,
  registryText: string | null,
  srcFiles: readonly string[],
): AuditRegistryJudgement {
  if (typesSource === null || registryText === null) {
    return {
      ok: false,
      evidence: ['audit-logs.types.ts 或登记表读不到 ⇒ 判据失去输入'],
      counts: { total: -1, active: -1, zero: -1 },
    };
  }
  const u = extractUnion(typesSource);
  const counts = countOccurrences([...srcFiles], new Set(u.members));
  const dims = allDimensions(typesSource, registryText, counts);
  const zero = u.members.filter((m) => (counts.get(m) ?? 0) === 0).length;
  const defects = Object.values(dims).flat();
  return {
    ok: defects.length === 0,
    evidence: defects.length === 0 ? ['六维全绿:D0–D6 零缺陷'] : defects,
    counts: { total: u.members.length, active: u.members.length - zero, zero },
  };
}

// ─── CLI(pnpm exec tsx scripts/check-audit-event-registry.ts)─────────────

function main(): void {
  const repoRoot = path.resolve(__dirname, '..');
  const typesRel = path.join(repoRoot, AUDIT_TYPES_PATH);
  const types = readFileSync(typesRel, 'utf8');
  const registry = readFileSync(path.join(repoRoot, AUDIT_REGISTRY_PATH), 'utf8');
  const srcFiles = listSourceFiles(path.join(repoRoot, AUDIT_SRC_ROOT), [typesRel]);
  const j = judgeAuditEventRegistry(types, registry, srcFiles);
  console.log(`audit-event-registry-total = ${j.counts.total}`);
  console.log(`audit-event-registry-active = ${j.counts.active}`);
  if (j.ok) {
    console.log(`✓ 审计事件登记表六维全绿(${j.evidence[0]})`);
    return;
  }
  for (const d of j.evidence) console.error(`✕ ${d}`);
  process.exit(1);
}

if (require.main === module) main();
