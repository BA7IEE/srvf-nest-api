import { readFileSync, readdirSync } from 'node:fs';
import * as path from 'node:path';

// ══════════════════════════════════════════════════════════════════════════
// docs/ai-harness 目录登记守护 —— 双向集合相等(unit 轮,零红区)
// ══════════════════════════════════════════════════════════════════════════
//
// 缺陷类(#1202 自述暴露):目录表少登记一条**不产生任何坏链接** ——
// GitHub 不会红、docs:*:check 不会红,漏登只能靠人眼。本仓的工具文档全靠
// 目录表做发现入口(AGENTS.md §5 / README),漏登 = 文档存在但没人知道要看。
//
// 判据(双向集合相等,沿 P2-23a/b 登记表同一条纪律):
//   D1  死链 —— README 目录表链接的 .md 在 docs/ai-harness/ 下不存在 ⇒ 红。
//   D2  漏登 —— docs/ai-harness/ 下的 .md 没被 README 链接 ⇒ 红(空表不许静默)。
//
// 口径:只管 docs/ai-harness/ 的**直接子文件**(子目录如 generated/ 不在目录表职责内);
// README.md 自身在目录表内(自指一条,现状如此)。链接取 README.md 全文的
// 裸文件名 markdown 链接(`](NAME.md)`),带路径的链接(`](../…)`)不属于本表职责。
//
// 形态:沿 P2-23a/b 先例,不带 `.criteria.spec.ts` 后缀(实质逻辑留 spec,零红区)。

const DOCS_DIR = path.resolve(__dirname, '../docs/ai-harness');
const README_TEXT = readFileSync(path.join(DOCS_DIR, 'README.md'), 'utf8');

function actualFiles(dir: string): Set<string> {
  return new Set(
    readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.md'))
      .map((e) => e.name),
  );
}

const LINK_RE = /\]\(([A-Za-z0-9_-]+\.md)\)/g;

function linkedFiles(readmeText: string): Set<string> {
  const out = new Set<string>();
  for (const m of readmeText.matchAll(LINK_RE)) out.add(m[1]);
  return out;
}

// ══════════════════════════════════════════════════════════════════════════
// 判决
// ══════════════════════════════════════════════════════════════════════════

function allDimensions(files: Set<string>, links: Set<string>): { D1: string[]; D2: string[] } {
  const d1: string[] = [];
  const d2: string[] = [];
  for (const l of [...links].sort()) {
    if (!files.has(l)) d1.push(`README 链接的文件不存在(死链):'${l}'`);
  }
  for (const f of [...files].sort()) {
    if (!links.has(f)) d2.push(`目录文件未登记进 README 目录表(漏登):'${f}'`);
  }
  return { D1: d1, D2: d2 };
}

// ══════════════════════════════════════════════════════════════════════════
// 测试
// ══════════════════════════════════════════════════════════════════════════

describe('docs/ai-harness 目录登记守护 —— 真源对拍', () => {
  it('B1 无死链:README 链接的每个 .md 都存在', () => {
    expect(allDimensions(actualFiles(DOCS_DIR), linkedFiles(README_TEXT)).D1).toEqual([]);
  });

  it('B2 无漏登:目录里每个 .md 都被 README 链接', () => {
    expect(allDimensions(actualFiles(DOCS_DIR), linkedFiles(README_TEXT)).D2).toEqual([]);
  });
});

describe('docs/ai-harness 目录登记守护 —— 常驻变异对拍(合成样本)', () => {
  const FILES = new Set(['README.md', 'TOOL_TRAPS.md', 'NEXT_TASKS.md']);
  const README =
    '见 [README](README.md) 与 [`TOOL_TRAPS.md`](TOOL_TRAPS.md) 和 [`NEXT_TASKS.md`](NEXT_TASKS.md)';

  it('M1 合成基线:双向相等 ⇒ 两维全绿', () => {
    const dims = allDimensions(FILES, linkedFiles(README));
    expect(dims.D1).toEqual([]);
    expect(dims.D2).toEqual([]);
  });

  it('M2 漏登一条 ⇒ 只有 D2 红,点名那条', () => {
    const dims = allDimensions(
      FILES,
      linkedFiles(README.replace('[`TOOL_TRAPS.md`](TOOL_TRAPS.md)', '')),
    );
    expect(dims.D1).toEqual([]);
    expect(dims.D2.join('\n')).toContain("'TOOL_TRAPS.md'");
  });

  it('M3 死链 ⇒ 只有 D1 红,点名那条', () => {
    const dims = allDimensions(new Set(['README.md', 'TOOL_TRAPS.md']), linkedFiles(README));
    expect(dims.D2).toEqual([]);
    expect(dims.D1.join('\n')).toContain("'NEXT_TASKS.md'");
  });

  it('M4 带路径的链接不算本表职责(不误报)', () => {
    const readme = `${README} 另见 [归档](../archive/ai-harness/x.md)`;
    const dims = allDimensions(FILES, linkedFiles(readme));
    expect(dims.D1).toEqual([]);
    expect(dims.D2).toEqual([]);
  });
});
