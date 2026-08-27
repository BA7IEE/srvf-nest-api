import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

import * as ts from 'typescript';

// ══════════════════════════════════════════════════════════════════════════
// P2-23 剩余半:审计事件登记表 —— 双向对拍判据(unit 轮,不连库、零红区)
// ══════════════════════════════════════════════════════════════════════════
//
// 合同 ④「字典、Audit events … 生成并对账」在 Audit events 半上此前零判据:
// 事件名已被 `audit-logs.types.ts` 的闭 union `AuditLogEvent` 收编(TS 静态锁
// 三条写库漏斗的调用点),但 union 里**有哪些事件**没有任何对外清单 ——
// ④-b 的签字只能「接受现状」。本 spec 把那半变成机器可判:
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
// ⭐ 常驻变异对拍 M1–M6(见文末):六条主判据每条各有一个「弄假必红」的
//   正对照,红集互不相交 —— 每次 CI 都跑,不是跑完就扔。
//
// 形态取舍:沿 P2-23a 字典刀(seed-dictionary-registry.spec.ts)先例 ——
// 不带 `.criteria.spec.ts` 后缀(那族要求薄运行器、实质逻辑住 scripts/check-*.ts
// 红区),判据有实质逻辑且零红区,故逻辑留本文件。

// ─── 真源(本 spec 不 import 生产模块 —— 只读源码文本;AST 不吃注释)──────

const TYPES_PATH = path.resolve(__dirname, 'audit-logs.types.ts');
const TYPES_SOURCE = readFileSync(TYPES_PATH, 'utf8');

const REGISTRY_REL = 'docs/ai-harness/AUDIT_EVENT_REGISTRY.md';
const REGISTRY_TEXT = readFileSync(path.resolve(__dirname, '../../..', REGISTRY_REL), 'utf8');

/** 全仓扫描根:只扫 src 下的非 spec TS 文件,排除 union 宿主文件自身。 */
function listSourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) listSourceFiles(p, acc);
    else if (p.endsWith('.ts') && !p.endsWith('.spec.ts')) acc.push(p);
  }
  return acc;
}

const SRC_ROOT = path.resolve(__dirname, '../../..', 'src');

// ══════════════════════════════════════════════════════════════════════════
// 提取器 1:union(AST;fail-closed)
// ══════════════════════════════════════════════════════════════════════════

interface UnionParse {
  /** 按声明顺序的成员字面量(未去重;D1 查重)。 */
  members: string[];
  /** 仪器缺陷:非字面量成员 / 找不到别名 / 不是 union —— 一律 fail-closed。 */
  defects: string[];
}

function extractUnion(source: string): UnionParse {
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

// ══════════════════════════════════════════════════════════════════════════
// 提取器 2:登记表(文本;格式与 DICTIONARY_SEED_REGISTRY 同族)
// ══════════════════════════════════════════════════════════════════════════

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

function parseRegistry(text: string): RegistryParse {
  const rows: RegistryRow[] = [];
  const defects: string[] = [];
  let declared: RegistryParse['declared'] = null;
  let inTable = false;
  let declaredSeen = false;
  const seen = new Set<string>();
  for (const line of text.split('\n')) {
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
  return { rows, declared, defects };
}

// ══════════════════════════════════════════════════════════════════════════
// 提取器 3:全仓出现计数(AST 字面量,不含注释)
// ══════════════════════════════════════════════════════════════════════════

function countOccurrences(files: string[], events: Set<string>): Map<string, number> {
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

// ══════════════════════════════════════════════════════════════════════════
// 六维判据
// ══════════════════════════════════════════════════════════════════════════

interface Extracted {
  members: string[];
  counts: Map<string, number>;
}

/** 全仓提取(慢路径,真实用例只跑一次并缓存)。 */
let cache: Extracted | null = null;
function extractReal(): Extracted {
  if (cache) return cache;
  const u = extractUnion(TYPES_SOURCE);
  if (u.defects.length > 0) return { members: [], counts: new Map() };
  const files = listSourceFiles(SRC_ROOT).filter((f) => path.resolve(f) !== TYPES_PATH);
  cache = { members: u.members, counts: countOccurrences(files, new Set(u.members)) };
  return cache;
}

function allDimensions(
  unionSource: string,
  registryText: string,
  files: string[] | null,
): Record<'D0' | 'D1' | 'D2' | 'D3' | 'D4' | 'D5' | 'D6', string[]> {
  const u = extractUnion(unionSource);
  const r = parseRegistry(registryText);
  const members = u.members;
  const memberSet = new Set(members);
  // 变异对拍里 unionSource 是合成样本,不扫真仓 —— 计数来自真仓(由调用方保证
  // 合成 union ⊆ 真 union,否则 D5 自己会红,这本身就是 fail-closed)。
  const counts = files === null ? extractReal().counts : countOccurrences(files, memberSet);

  const d0 = [...u.defects, ...r.defects];

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

  return { D0: d0, D1: [], D2: d2, D3: d3, D4: d4, D5: d5, D6: d6 };
}

// D1 的缺陷由提取器直接给出(extractUnion.defects),单独跑:
function d1Defects(unionSource: string): string[] {
  return extractUnion(unionSource).defects;
}

/** 变异对拍的公共断言:目标维点名、且**只有**目标维红(红集精确、两两不相交)。 */
function expectOnlyRed(
  dims: Record<'D0' | 'D1' | 'D2' | 'D3' | 'D4' | 'D5' | 'D6', string[]>,
  target: 'D1' | 'D2' | 'D3' | 'D4' | 'D5' | 'D6',
  mustMention: string,
): void {
  for (const [dim, defects] of Object.entries(dims)) {
    if (dim === target) {
      expect(defects.length).toBeGreaterThan(0);
      expect(defects.join('\n')).toContain(mustMention);
    } else {
      expect(defects).toEqual([]);
    }
  }
}

// ══════════════════════════════════════════════════════════════════════════
// 测试
// ══════════════════════════════════════════════════════════════════════════

describe('P2-23b 审计事件登记表 —— 仪器自证(合成样本,不落盘)', () => {
  const SYN_UNION = "export type AuditLogEvent =\n  | 'a.one'\n  | 'a.two'\n  | 'b.retired';\n";
  const SYN_REGISTRY = [
    '**审计事件(机器核对):3 个 · 活跃(≥1 次出现):2 · 已退役/零产出:1**',
    '',
    '## a',
    '',
    '| event | 仓内出现次数 | 备注 |',
    '|---|---|---|',
    '| `a.one` | 2 |  |',
    '| `a.two` | 2 |  |',
    '',
    '## b',
    '',
    '| event | 仓内出现次数 | 备注 |',
    '|---|---|---|',
    '| `b.retired` | 0 | 已退役(词条刻意保留) |',
    '',
  ].join('\n');
  const SYN_FILES = ['/tmp/syn-a.ts', '/tmp/syn-b.ts'] as const;

  let synSaved: Array<[string, string | null]> = [];
  afterEach(() => {
    for (const [f, c] of synSaved) {
      if (c === null) rmSync(f, { force: true });
      else writeFileSync(f, c);
    }
    synSaved = [];
  });

  function withSynFiles(files: Array<[string, string]>, fn: () => void): void {
    synSaved = SYN_FILES.map((f) => [f, existsSync(f) ? readFileSync(f, 'utf8') : null]);
    for (const [f, c] of files) writeFileSync(f, c);
    fn();
  }

  it('S1 提取器:纯字面量 union 能读出来,无缺陷', () => {
    const u = extractUnion(SYN_UNION);
    expect(u.defects).toEqual([]);
    expect(u.members).toEqual(['a.one', 'a.two', 'b.retired']);
  });

  it('S2 提取器 fail-closed:非字面量成员 ⇒ D1 红', () => {
    const bad = "export type AuditLogEvent =\n  | 'a.one'\n  | `b.${string}`;\n";
    const defects = d1Defects(bad);
    expect(defects.join('\n')).toContain('非字符串字面量成员');
  });

  it('S3 提取器 fail-closed:找不到别名 ⇒ 红', () => {
    expect(d1Defects('export type NotIt = "x";').join('\n')).toContain('未找到 type AuditLogEvent');
  });

  it('S4 登记表解析:声明行 + 行计数 + 重复检测', () => {
    const r = parseRegistry(SYN_REGISTRY);
    expect(r.defects).toEqual([]);
    expect(r.declared).toEqual({ total: 3, active: 2, zero: 1 });
    expect(r.rows.map((x) => x.event)).toEqual(['a.one', 'a.two', 'b.retired']);
    const dup = parseRegistry(SYN_REGISTRY.replace('| `a.two` | 2 |  |', '| `a.one` | 2 |  |'));
    expect(dup.defects.join('\n')).toContain('重复条目');
  });

  it('S5 出现计数:AST 字面量计数、注释不算', () => {
    withSynFiles(
      [
        [
          '/tmp/syn-a.ts',
          "const E = 'a.one'; // 'a.two' in comment\nconst x = cond ? 'a.two' : 'a.one';\n",
        ],
        ['/tmp/syn-b.ts', "const y = 'a.two';\n"],
      ],
      () => {
        const counts = countOccurrences([...SYN_FILES], new Set(['a.one', 'a.two', 'b.retired']));
        expect(counts.get('a.one')).toBe(2);
        expect(counts.get('a.two')).toBe(2); // 注释里那次不算
        expect(counts.get('b.retired')).toBe(0);
      },
    );
  });

  it('S6 合成全链:干净样本六维全绿', () => {
    withSynFiles(
      [
        ['/tmp/syn-a.ts', "const E = 'a.one'; const x = cond ? 'a.two' : 'a.one';\n"],
        ['/tmp/syn-b.ts', "const y = 'a.two';\n"],
      ],
      () => {
        const dims = allDimensions(SYN_UNION, SYN_REGISTRY, [...SYN_FILES]);
        for (const defects of Object.values(dims)) expect(defects).toEqual([]);
        expect(d1Defects(SYN_UNION)).toEqual([]);
      },
    );
  });
});

describe('P2-23b 审计事件登记表 —— 真源对拍(union ↔ 登记表 ↔ 全仓)', () => {
  // 真仓计数慢(AST 全仓扫一遍),一次提出,各维共用。
  let dims: Record<'D0' | 'D1' | 'D2' | 'D3' | 'D4' | 'D5' | 'D6', string[]>;
  beforeAll(() => {
    dims = allDimensions(TYPES_SOURCE, REGISTRY_TEXT, null);
    dims.D1 = d1Defects(TYPES_SOURCE);
  });

  it('B0 仪器健康:D0 与 D1 零缺陷(否则其余各维读数不可信)', () => {
    expect(dims.D0).toEqual([]);
    expect(dims.D1).toEqual([]);
  });

  it('B2 声明行:147/142/5 与实测相等', () => {
    expect(dims.D2).toEqual([]);
  });

  it('B3 正向:union 每个事件都在登记表(漏登记红)', () => {
    expect(dims.D3).toEqual([]);
  });

  it('B4 反向:登记表每条都在 union(幽灵红)', () => {
    expect(dims.D4).toEqual([]);
  });

  it('B5 出现次数逐条相等', () => {
    expect(dims.D5).toEqual([]);
  });

  it('B6 零产出闭集:死事件必须显式标注', () => {
    expect(dims.D6).toEqual([]);
  });
});

describe('P2-23b 审计事件登记表 —— 常驻变异对拍(弄假必红,红集互不相交)', () => {
  // 全部变异只动登记表文本或合成 union —— 不碰真源、不碰真仓文件。
  // 合成 union 用 S 组同款(其成员 ⊆ 真 union ⇒ D5 计数复用真仓结果,不串红)。

  it('M1 漏登记一条 ⇒ 只有 D3 红,点名那条', () => {
    const mutated = REGISTRY_TEXT.replace(/^\| `auth\.login` \| \d+ \|.*\n/m, '');
    expect(mutated).not.toBe(REGISTRY_TEXT);
    const dims = allDimensions(TYPES_SOURCE, mutated, null);
    dims.D1 = [];
    expectOnlyRed(dims, 'D3', "'auth.login'");
  });

  it('M2 多登记一条幽灵 ⇒ 只有 D4 红', () => {
    const mutated = REGISTRY_TEXT.replace(
      /^\| `profile\.read\.other` \| (\d+) \|(.*)$/m,
      '| `ghost.event` | $1 |$2\n| `profile.read.other` | $1 |$2',
    );
    expect(mutated).not.toBe(REGISTRY_TEXT);
    const dims = allDimensions(TYPES_SOURCE, mutated, null);
    dims.D1 = [];
    expectOnlyRed(dims, 'D4', "'ghost.event'");
  });

  it('M3 出现次数漂移(攻击者只改计数让总数对上)⇒ 只有 D5 红', () => {
    const mutated = REGISTRY_TEXT.replace(
      /^(\| `auth\.login` \| )\d+( \|)/m,
      (_m, p1: string, p2: string) => `${p1}99${p2}`,
    );
    expect(mutated).not.toBe(REGISTRY_TEXT);
    const dims = allDimensions(TYPES_SOURCE, mutated, null);
    dims.D1 = [];
    expectOnlyRed(dims, 'D5', "'auth.login'");
  });

  it('M4 声明行数字改错 ⇒ 只有 D2 红', () => {
    const mutated = REGISTRY_TEXT.replace(
      /^\*\*审计事件\(机器核对\):\d+ 个 · 活跃\(≥1 次出现\):\d+ · 已退役\/零产出:\d+\*\*$/m,
      '**审计事件(机器核对):146 个 · 活跃(≥1 次出现):142 · 已退役/零产出:5**',
    );
    expect(mutated).not.toBe(REGISTRY_TEXT);
    const dims = allDimensions(TYPES_SOURCE, mutated, null);
    dims.D1 = [];
    expectOnlyRed(dims, 'D2', '实际解析到');
  });

  it('M5 零产出事件的标注被删 ⇒ 只有 D6 红', () => {
    const mutated = REGISTRY_TEXT.replace(
      /^(\| `role-permission\.grant` \| 0 \|)[^|]*(\|)$/m,
      '$1 $2',
    );
    expect(mutated).not.toBe(REGISTRY_TEXT);
    const dims = allDimensions(TYPES_SOURCE, mutated, null);
    dims.D1 = [];
    expectOnlyRed(dims, 'D6', "'role-permission.grant'");
  });

  it('M6 union 冒出非字面量成员 ⇒ 只有 D1 红(fail-closed)', () => {
    const mutated = TYPES_SOURCE.replace(
      /\n( {2}\| 'role-permission\.grant'.*)$/m,
      '\n  | `dynamic.${string}`$1',
    );
    // 若上面没替换到(格式漂移),测试自己先红 —— 变异对拍不许静默空跑。
    expect(mutated).not.toBe(TYPES_SOURCE);
    const defects = d1Defects(mutated);
    expect(defects.join('\n')).toContain('非字符串字面量成员');
  });
});
