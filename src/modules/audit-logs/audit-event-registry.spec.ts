import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

/**
 * 审计事件登记表(`docs/ai-harness/AUDIT_EVENT_REGISTRY.md`)双向对拍 —— **薄运行器**。
 *
 * 判据本体在 `scripts/check-audit-event-registry.ts`(selfGuard 红区;2026-08-27
 * 维护者令牌收编,见 NEXT_TASKS P2-23b)。本文件只做三件事:
 *   1. 仪器自证(S 组,合成样本):提取器/解析器/计数的判别力;
 *   2. 真读数(B 组):union ↔ 登记表 ↔ 全仓计数,六维全绿才作数;
 *   3. 常驻变异对拍(M1–M6):喂假输入,断言红集精确 —— 弄假必红,每次 CI 都跑。
 *
 * ⭐ M3 刻意假设对手是聪明的:只改计数让总数对上。判的是逐条相等,不是总数。
 */

import {
  AUDIT_REGISTRY_PATH,
  AUDIT_SRC_ROOT,
  AUDIT_TYPES_PATH,
  allDimensions,
  countOccurrences,
  extractUnion,
  listSourceFiles,
  parseRegistry,
} from '../../../scripts/check-audit-event-registry';

const TYPES_SOURCE = readFileSync(path.resolve(__dirname, '../../..', AUDIT_TYPES_PATH), 'utf8');
const REGISTRY_TEXT = readFileSync(
  path.resolve(__dirname, '../../..', AUDIT_REGISTRY_PATH),
  'utf8',
);
/** 真仓文件清单(排除 union 宿主自身)。 */
const SRC_FILES = listSourceFiles(path.resolve(__dirname, '../../..', AUDIT_SRC_ROOT), [
  path.resolve(__dirname, '../../..', AUDIT_TYPES_PATH),
]);
/** 真仓计数一次算完,各维共用(慢路径只跑一次)。 */
const REAL_COUNTS = (() => {
  const u = extractUnion(TYPES_SOURCE);
  return countOccurrences(SRC_FILES, new Set(u.members));
})();

type Dim = 'D0' | 'D1' | 'D2' | 'D3' | 'D4' | 'D5' | 'D6';

/** 变异对拍的公共断言:目标维点名、且**只有**目标维红(红集精确、两两不相交)。 */
function expectOnlyRed(dims: Record<Dim, string[]>, target: Dim, mustMention: string): void {
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

  it('S1 提取器:纯字面量 union 能读出来,无缺陷', () => {
    const u = extractUnion(SYN_UNION);
    expect(u.defects).toEqual([]);
    expect(u.members).toEqual(['a.one', 'a.two', 'b.retired']);
  });

  it('S2 提取器 fail-closed:非字面量成员 ⇒ D1 红', () => {
    const bad = "export type AuditLogEvent =\n  | 'a.one'\n  | `b.${string}`;\n";
    const defects = extractUnion(bad).defects;
    expect(defects.join('\n')).toContain('非字符串字面量成员');
  });

  it('S3 提取器 fail-closed:找不到别名 ⇒ 红', () => {
    expect(extractUnion('export type NotIt = "x";').defects.join('\n')).toContain(
      '未找到 type AuditLogEvent',
    );
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
    const prev = SYN_FILES.map((f) => [f, existsSync(f) ? readFileSync(f, 'utf8') : null] as const);
    try {
      writeFileSync(
        '/tmp/syn-a.ts',
        "const E = 'a.one'; // 'a.two' in comment\nconst x = cond ? 'a.two' : 'a.one';\n",
      );
      writeFileSync('/tmp/syn-b.ts', "const y = 'a.two';\n");
      const counts = countOccurrences([...SYN_FILES], new Set(['a.one', 'a.two', 'b.retired']));
      expect(counts.get('a.one')).toBe(2);
      expect(counts.get('a.two')).toBe(2); // 注释里那次不算
      expect(counts.get('b.retired')).toBe(0);
    } finally {
      for (const [f, c] of prev) {
        if (c === null) rmSync(f, { force: true });
        else writeFileSync(f, c);
      }
    }
  });

  it('S6 合成全链:干净样本六维全绿', () => {
    const prev = SYN_FILES.map((f) => [f, existsSync(f) ? readFileSync(f, 'utf8') : null] as const);
    try {
      writeFileSync('/tmp/syn-a.ts', "const E = 'a.one'; const x = cond ? 'a.two' : 'a.one';\n");
      writeFileSync('/tmp/syn-b.ts', "const y = 'a.two';\n");
      const counts = countOccurrences([...SYN_FILES], new Set(['a.one', 'a.two', 'b.retired']));
      const dims = allDimensions(SYN_UNION, SYN_REGISTRY, counts);
      for (const defects of Object.values(dims)) expect(defects).toEqual([]);
    } finally {
      for (const [f, c] of prev) {
        if (c === null) rmSync(f, { force: true });
        else writeFileSync(f, c);
      }
    }
  });
});

describe('P2-23b 审计事件登记表 —— 真源对拍(union ↔ 登记表 ↔ 全仓)', () => {
  // 真仓计数在模块加载时一次算完(REAL_COUNTS),六个 it 共用。
  let dims: Record<Dim, string[]>;
  beforeAll(() => {
    dims = allDimensions(TYPES_SOURCE, REGISTRY_TEXT, REAL_COUNTS);
  });

  it('B0 仪器健康:D0 与 D1 零缺陷(否则其余各维读数不可信)', () => {
    expect(dims.D0).toEqual([]);
    expect(dims.D1).toEqual([]);
  });

  it('B2 声明行:156/151/5 与实测相等', () => {
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
  // 全部变异只动登记表文本或 union 文本 —— 不碰真源、不碰真仓文件。
  // 计数一律用真仓 REAL_COUNTS(变异的成员都 ⊆ 真 union ⇒ 不串红)。

  it('M1 漏登记一条 ⇒ 只有 D3 红,点名那条', () => {
    const mutated = REGISTRY_TEXT.replace(/^\| `auth\.login` \| \d+ \|.*\n/m, '');
    expect(mutated).not.toBe(REGISTRY_TEXT);
    expectOnlyRed(allDimensions(TYPES_SOURCE, mutated, REAL_COUNTS), 'D3', "'auth.login'");
  });

  it('M2 多登记一条幽灵 ⇒ 只有 D4 红', () => {
    const mutated = REGISTRY_TEXT.replace(
      /^\| `profile\.read\.other` \| (\d+) \|(.*)$/m,
      '| `ghost.event` | $1 |$2\n| `profile.read.other` | $1 |$2',
    );
    expect(mutated).not.toBe(REGISTRY_TEXT);
    expectOnlyRed(allDimensions(TYPES_SOURCE, mutated, REAL_COUNTS), 'D4', "'ghost.event'");
  });

  it('M3 出现次数漂移(攻击者只改计数让总数对上)⇒ 只有 D5 红', () => {
    const mutated = REGISTRY_TEXT.replace(
      /^(\| `auth\.login` \| )\d+( \|)/m,
      (_m, p1: string, p2: string) => `${p1}99${p2}`,
    );
    expect(mutated).not.toBe(REGISTRY_TEXT);
    expectOnlyRed(allDimensions(TYPES_SOURCE, mutated, REAL_COUNTS), 'D5', "'auth.login'");
  });

  it('M4 声明行数字改错 ⇒ 只有 D2 红', () => {
    const mutated = REGISTRY_TEXT.replace(
      /^\*\*审计事件\(机器核对\):\d+ 个 · 活跃\(≥1 次出现\):\d+ · 已退役\/零产出:\d+\*\*$/m,
      '**审计事件(机器核对):155 个 · 活跃(≥1 次出现):151 · 已退役/零产出:5**',
    );
    expect(mutated).not.toBe(REGISTRY_TEXT);
    expectOnlyRed(allDimensions(TYPES_SOURCE, mutated, REAL_COUNTS), 'D2', '实际解析到');
  });

  it('M5 零产出事件的标注被删 ⇒ 只有 D6 红', () => {
    const mutated = REGISTRY_TEXT.replace(
      /^(\| `role-permission\.grant` \| 0 \|)[^|]*(\|)$/m,
      '$1 $2',
    );
    expect(mutated).not.toBe(REGISTRY_TEXT);
    expectOnlyRed(
      allDimensions(TYPES_SOURCE, mutated, REAL_COUNTS),
      'D6',
      "'role-permission.grant'",
    );
  });

  it('M6 union 冒出非字面量成员 ⇒ 只有 D1 红(fail-closed)', () => {
    const mutated = TYPES_SOURCE.replace(
      /\n( {2}\| 'role-permission\.grant'.*)$/m,
      '\n  | `dynamic.${string}`$1',
    );
    // 若上面没替换到(格式漂移),测试自己先红 —— 变异对拍不许静默空跑。
    expect(mutated).not.toBe(TYPES_SOURCE);
    const defects = extractUnion(mutated).defects;
    expect(defects.join('\n')).toContain('非字符串字面量成员');
  });
});
