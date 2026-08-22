/**
 * 冻结稿落地台账的判据(`docs/ai-harness/FROZEN_DRAFTS.md`)。
 *
 * **要防的缺陷类**:归档目录里新增一份冻结稿 / 施工依据,却没人把它登记进台账 ——
 * 而**漏登记不产生任何坏链接**,既有的 `referenced-paths-exist` 之类守护看不见它。
 * 这一类在本仓已发生过两次(`docs/ai-harness/README.md` 漂成"恰 4 文件";
 * `docs/README.md` 那句「当前两份」漏掉 rbac 目录终态与整个活动 v1.1 合同目录)。
 *
 * **判据形状**:不是"至少登记了几份",而是**双向集合相等** ——
 * 少一份 = 新文件未分类;多一份 = 登记了已删除的文件。两个方向都会红。
 *
 * ⚠️ **扫描面不得退化成关键词匹配**。"头部含冻结 / FROZEN"那版试过并当场否决:
 * 实测漏掉 `activity-responsibility-workflow-v2-review.md`(头部写"业务已定版"),
 * 而那份正是"代码已落、闸未开"的欠账项 —— 关键词判据会把最需要看见的那份漏掉。
 *
 * ⚠️ 每条判据前先跑**自证**:扫描面为空 / 解析不出编号时,判据当场红而不是静默放行。
 * 「判据失去输入 ≠ 通过」。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  CATEGORIES,
  LEDGER_PATH,
  activityAcceptanceCoverage,
  computeReadings,
  extractReadingsBlock,
  parseClassifications,
  renderReadings,
  scanArchivedDocs,
} from '../scripts/frozen-drafts-ledger';

const ROOT = process.cwd();
const ledger = readFileSync(resolve(ROOT, LEDGER_PATH), 'utf8');

/** 归档目录的地板:低于它说明扫描面塌了(读错目录 / 过滤写错),不是"仓库真的只剩这么几份"。 */
const ARCHIVED_DOCS_FLOOR = 80;
/** 读数条数地板:computeReadings 被删空时判据必须红。 */
const READINGS_FLOOR = 10;

/** §1 欠账表里的台账编号(第三列);`—` 表示这项没有 NEXT_TASKS 编号。 */
function ledgerIdsInSummaryTable(markdown: string): Set<string> {
  const ids = new Set<string>();
  for (const line of markdown.split('\n')) {
    const row = /^\|\s*\d+\s*\|[^|]+\|\s*([^|]+?)\s*\|/.exec(line);
    if (!row) continue;
    const cell = row[1];
    if (/^P\d+-\d+$/.test(cell)) ids.add(cell);
  }
  return ids;
}

describe('冻结稿落地台账 —— 自证', () => {
  it('扫描面非空且不低于地板(判据失去输入 ≠ 通过)', () => {
    const docs = scanArchivedDocs(ROOT);
    expect(docs.length).toBeGreaterThanOrEqual(ARCHIVED_DOCS_FLOOR);
    expect(docs.every((d) => d.startsWith('docs/archive/') && d.endsWith('.md'))).toBe(true);
  });

  it('台账三个锚点都在(§1 欠账表 / 读数块 / §3 分类表)', () => {
    expect(ledger).toContain('## 1. 还有欠账的冻结稿');
    expect(ledger).toContain('## 3. 归档评审稿 / 计划全量分类');
    expect(() => extractReadingsBlock(ledger)).not.toThrow();
    expect(ledgerIdsInSummaryTable(ledger).size).toBeGreaterThan(0);
    expect(parseClassifications(ledger).length).toBeGreaterThanOrEqual(ARCHIVED_DOCS_FLOOR);
  });

  it('活动验收编号解析非空且自洽(bound + todo == 合同定义数)', () => {
    const coverage = activityAcceptanceCoverage(ROOT);
    expect(coverage.defined).toBeGreaterThanOrEqual(90);
    expect(coverage.bound).toBeGreaterThan(0);
    expect(coverage.bound + coverage.todo).toBe(coverage.defined);
  });

  it('读数条数不低于地板', () => {
    expect(computeReadings(ROOT).length).toBeGreaterThanOrEqual(READINGS_FLOOR);
  });
});

describe('冻结稿落地台账 —— 分类完整性', () => {
  it('归档目录里的每一份 .md 都在 §3 有且只有一条分类(双向集合相等)', () => {
    const actual = scanArchivedDocs(ROOT);
    const declared = parseClassifications(ledger);
    const declaredPaths = declared.map((c) => c.path);

    // 方向一:新增文件未登记。
    expect(actual.filter((f) => !declaredPaths.includes(f))).toEqual([]);
    // 方向二:登记了已不存在的文件。
    expect(declaredPaths.filter((f) => !actual.includes(f))).toEqual([]);
    // 同一份文件不得登记两次(两条分类 = 又一份"第二真相")。
    expect(declaredPaths.length).toBe(new Set(declaredPaths).size);
  });

  it('分类取值落在闭集内,且 open 必须带台账编号', () => {
    for (const entry of parseClassifications(ledger)) {
      expect(CATEGORIES).toContain(entry.category);
      if (entry.category === 'open') {
        expect(entry.ledgerId).toBeDefined();
      }
    }
  });

  it('§1 欠账表的台账编号与 §3 的 open 行互证', () => {
    const summaryIds = ledgerIdsInSummaryTable(ledger);
    const openIds = new Set(
      parseClassifications(ledger)
        .filter((c) => c.category === 'open')
        .map((c) => c.ledgerId)
        .filter((id): id is string => id !== undefined && id !== '-'),
    );
    expect([...openIds].filter((id) => !summaryIds.has(id))).toEqual([]);
    expect([...summaryIds].filter((id) => !openIds.has(id))).toEqual([]);
  });
});

describe('冻结稿落地台账 —— 读数新鲜度', () => {
  it('文档里的读数块与现算结果逐字节相同', () => {
    expect(extractReadingsBlock(ledger)).toBe(renderReadings(computeReadings(ROOT)));
  });

  it('读数块不含时间戳与 git SHA(否则字节比对恒假红且自引用)', () => {
    const block = renderReadings(computeReadings(ROOT));
    expect(block).not.toMatch(/\b20\d{2}-\d{2}-\d{2}\b/);
    expect(block).not.toMatch(/\b[0-9a-f]{7,40}\b/);
  });
});
