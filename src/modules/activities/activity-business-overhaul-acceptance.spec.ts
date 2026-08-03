import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * 活动业务改造 v1.1 —— 验收编号骨架 + 合同完整性守护(第 0 批交付项)。
 *
 * 合同 §14「第0批」要求 AC / ADV 编号先以 `it.todo` 入仓,**不让 main 长期红**。
 * 但纯 todo 列表会与合同悄悄漂移,所以本文件的 todo **全部由合同原文解析生成**:
 * 合同里加一条 AC,这里的待办自动多一条;合同被改动,下面的 SHA256 断言当场红。
 *
 * 每批实现落地时:把对应 `it.todo` 换成真实用例(或在 e2e 里实现并在此标注去向),
 * **不是**把它删掉 —— 删 todo 等于让验收编号静默消失。
 */

const CONTRACT_DIR = 'docs/archive/reviews/activity-business-overhaul-v1.1';

function readContractFile(fileName: string): string {
  return readFileSync(resolve(process.cwd(), CONTRACT_DIR, fileName), 'utf8');
}

const BUSINESS_PLAN = 'SRVF_活动业务全流程修正方案_正式版_v1.1.md';
const MATRIX = 'SRVF_活动业务规则_355项追踪矩阵_v1.1.md';
const SHA256_MANIFEST = 'SRVF_活动业务文档_v1.1_SHA256.txt';

const businessPlan = readContractFile(BUSINESS_PLAN);
const matrix = readContractFile(MATRIX);

/**
 * 解析验收条目定义行:`- **AC-001**` 后跟一个全角空格(U+3000)再跟一句话。
 * 分隔符写成 `[^\S\n]*`(除换行外的空白)而非 `\s*` —— 后者会吃掉行尾换行,
 * 把下一行的正文当成本条的标题。
 */
function parseAcceptanceDefinitions(prefix: 'AC' | 'ADV'): { id: string; title: string }[] {
  const pattern = new RegExp(`^- \\*\\*(${prefix}-\\d{3})\\*\\*[^\\S\\n]*(.+)$`, 'gm');
  const found: { id: string; title: string }[] = [];
  for (const match of businessPlan.matchAll(pattern)) {
    found.push({ id: match[1], title: match[2].trim() });
  }
  return found;
}

const acceptanceCases = parseAcceptanceDefinitions('AC');
const adversarialCases = parseAcceptanceDefinitions('ADV');

function expectedIds(prefix: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => `${prefix}-${String(i + 1).padStart(3, '0')}`);
}

describe('活动业务改造 v1.1 合同完整性', () => {
  it('四份合同与入仓时的 SHA256 清单逐字节一致', () => {
    const manifest = readContractFile(SHA256_MANIFEST)
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    // 清单本身也是判据:少一行就等于少守一份合同。
    expect(manifest).toHaveLength(4);

    for (const line of manifest) {
      const [expectedDigest, ...nameParts] = line.split(/\s+/);
      const fileName = nameParts.join(' ');
      const actualDigest = createHash('sha256')
        .update(readFileSync(resolve(process.cwd(), CONTRACT_DIR, fileName)))
        .digest('hex');
      expect(`${fileName}:${actualDigest}`).toBe(`${fileName}:${expectedDigest}`);
    }
  });

  it('验收编号恰为 AC-001..072 与 ADV-001..023,无缺号无重号', () => {
    expect(acceptanceCases.map((c) => c.id)).toEqual(expectedIds('AC', 72));
    expect(adversarialCases.map((c) => c.id)).toEqual(expectedIds('ADV', 23));
  });

  it('355 项追踪矩阵行数为 355 且编号唯一', () => {
    const rowIds = [...matrix.matchAll(/^\| ([A-Z]\d{2}) \|/gm)].map((m) => m[1]);
    expect(rowIds).toHaveLength(355);
    expect(new Set(rowIds).size).toBe(355);
  });

  it('矩阵引用的每个验收编号都真实存在(含 `AC-001..004` 区间写法的两个端点)', () => {
    const knownIds = new Set([
      ...acceptanceCases.map((c) => c.id),
      ...adversarialCases.map((c) => c.id),
    ]);
    const referenced = new Set<string>();

    for (const match of matrix.matchAll(/(AC|ADV)-(\d{3})(?:\.\.(\d{3}))?/g)) {
      const [, prefix, start, end] = match;
      referenced.add(`${prefix}-${start}`);
      if (end !== undefined) referenced.add(`${prefix}-${end}`);
    }

    // 矩阵必须真的引用了验收编号 —— 空集合会让下面的断言恒真。
    expect(referenced.size).toBeGreaterThan(0);
    expect([...referenced].filter((id) => !knownIds.has(id))).toEqual([]);
  });

  it('活文档仍指向本合同目录(指针被删则红)', () => {
    const currentState = readFileSync(resolve(process.cwd(), 'docs/current-state.md'), 'utf8');
    const nextTasks = readFileSync(resolve(process.cwd(), 'docs/ai-harness/NEXT_TASKS.md'), 'utf8');

    for (const document of [currentState, nextTasks]) {
      expect(document).toContain('activity-business-overhaul-v1.1');
    }
    expect(nextTasks).toContain('P1-28');
  });
});

describe('活动业务改造 v1.1 验收编号(AC-001..072)—— 待实现', () => {
  for (const { id, title } of acceptanceCases) {
    it.todo(`${id} ${title}`);
  }
});

describe('活动业务改造 v1.1 对抗测试(ADV-001..023)—— 待实现', () => {
  for (const { id, title } of adversarialCases) {
    it.todo(`${id} ${title}`);
  }
});
