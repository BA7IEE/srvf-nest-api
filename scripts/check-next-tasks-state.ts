/**
 * check-next-tasks-state.ts —— 台账状态收口闸(`docs/ai-harness/NEXT_TASKS.md`)。
 *
 * **要防的缺陷类**:**活干完了,台账仍写着「待办」。**
 * 台账是各会话判断「还有什么活」的唯一入口,也是维护者(看不懂代码)唯一的进度视图 ——
 * 条目写着待办 ⇒ 会被重新下发,或在进度盘点里被算成未完成。
 * 2026-08 内**同一形态复发四次**(P2-8 / P2-12 / P2-13 / P2-15)⇒ 不是偶发疏忽,是流程缺口。
 *
 * ─── 🔴 起草时那个更直觉的模型已被实测否掉,别再走回去 ───────────────────────
 * 第一反应是「PR 忘了改台账」,据此想做的闸是「commit 点名 `Pn-m` ⇒ 该 PR 必须碰
 * `NEXT_TASKS.md`」。**实测检出率 0/3**:那几个 PR **全部碰了台账,而且都编辑了自己那一节**
 * (`git show 95c93eb2 -- docs/ai-harness/NEXT_TASKS.md` 的 hunk 就落在 P2-8 自己的行段上)。
 * 真缺陷是「碰了、写了正文,但**没有任何地方记录『这条到底完没完』**」——
 * 因为台账**根本没有状态字段**。本闸先给它一个,再守住它。
 *
 * ─── 三条判据 ─────────────────────────────────────────────────────────────
 *   A 结构:每条 `### Pn-m` 恰有一行 `**状态**:…`,取值在白名单内、形态要求满足。
 *   B 防谎报:`已收口(#N)` / `进行中(#N)` 里的 `#N` 必须真的已合进 main。
 *   C ⭐主力:状态 = `待办`,而 main 上存在 **subject 点名本条编号的「交付类」已合 commit**
 *     ⇒ 红并点名该条。
 *
 * ⭐ **C 只对 `待办` 开火,对其它一切状态都不红 —— 这是刻意的,别扩大它的开火面。**
 * P2-12a 合入时 P2-12b 还没做,那时写 `待办` 是错的、写 `进行中` 是对的;
 * P2-11 现在是 `待拍板`,也不该红。**闸治的是「沉默」,不是「没做完」** ——
 * 任何显式非 `待办` 的值都代表有人想过了,放行。这条决定了 C 的假阳性率。
 *
 * ─── ⚠️ 已知缺口(逐条登记,别当它们不存在)────────────────────────────────
 * 1. **C 只能管「subject 点名了编号」的那批。** 实测(`3948ccbc`)近 40 个 commit 里只有
 *    **20** 带 `Pn-m`(P1-32 PR 1/3b、P2-14 刀 A 之外那批都没带)。⇒ 它管住的是
 *    「点名了却仍写待办」这一类,**漏的是「压根没点名」那一类**。要不要治
 *    (比如要求 commit subject 必带编号)另立,本闸不做。**闸绿 ≠ 台账准。**
 * 2. **C 对「多刀条目里新增的那一刀」失明。** 状态是条目级的:P1-28 写着 `进行中`,
 *    再合十刀它也不红。一条目一状态本就是有损模型,这是它的代价。
 * 3. 🔴 **编号命名空间撞车。** 2026-06 的提交用 `P2-6`/`P2-7`/`P2-8` 指
 *    「**App API Phase 2 第 N 项**」,与今天的台账编号是**两套命名空间**:
 *      - `a327c7ba feat(app): add App my-certificates endpoint (P2-7)` (#160) ← 交付类,过不了类型过滤
 *      - `d26de9f9 docs(app): close out App API Phase 2 docs (P2-8)` (#161) ← 侥幸被 docs 过滤挡掉
 *    ⇒ 只要 `P2-7` 被标 `待办`,C 就会假阳性点名它。**当前它合理值是 `⏸ 挂起` 所以红不了,
 *    但那是运气不是设计。** 若将来真要用 `待办`,先看这条。
 * 4. `进行中(#N)` 的 `#N` 也走 B(它们记的是「已合的那几刀」);**在飞的 PR 号写进去会红** ——
 *    那是刻意的:在飞的 PR 属于正文,不属于状态行。
 *
 * ─── ⚠️ 取证纪律 ─────────────────────────────────────────────────────────
 * **别用 BSD `grep -E` 的 `(^|[^0-9A-Za-z-])P2-8([^0-9]|$)` 形状复核本闸的读数** ——
 * macOS 上分组内带 `^`/`$` 的交替**恒失效且静默返回 0**(实测:该式 0,`[^0-9A-Za-z-]P2-8[^0-9]` 2)。
 * 本文件用 JS lookbehind(`/(?<![0-9A-Za-z-])P2-12[a-z]?(?![0-9])/`),它同时天然满足
 * 「`P2-1` 不得吃掉 `P2-12`」这条边界要求(见 selfCheck 的边界用例)。
 *
 * ─── 白名单为什么只有五个值 ────────────────────────────────────────────────
 * 实测扫过 25 条正文,在用的状态词有 `已交付`/`已收口`/`✅ 已完成`/`待做`/`待答`/`待拍板`/
 * `⏸ 剩余全部是维护者动作`/`不阻塞首次上线` 等**至少八种**,且多数条目本就是「部分收口」。
 * 收敛成五个值的关键是换一条读法:**状态描述的是「剩余部分」的状态,不是已完成部分。**
 * 于是「代码全交付、只剩维护者跑 runbook」= `⏸ 挂起(原因写清)`,
 * 「8 个 PR 合了 5 个」= `进行中(5/8,…)`,不需要第六个值。
 * 白名单与台账里那张图例表**双向相等**(见 selfCheck 的 legend 部分)—— 防止两处漂成第二份真相。
 *
 * CLI:`pnpm exec tsx scripts/check-next-tasks-state.ts [--base <ref>]`。退出码 0 / 1。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const LEDGER_PATH = 'docs/ai-harness/NEXT_TASKS.md';

/**
 * 地板锚点,**不写死 25** —— 写死会让「新增一条条目」变成「改判据才能过」。
 * 低于地板说明扫描面塌了(标题格式被改 / 读错文件),判据当场红而不是静默放行:
 * 「判据失去输入 ≠ 通过」。
 */
export const MIN_ENTRIES = 20;
/** main 历史地板:CI 上浅克隆(fetch-depth: 1)会让 C 全程失明,必须当场红。 */
export const MIN_COMMITS = 500;
/** 「交付类 commit 点名某条目」的命中地板:归零说明类型过滤或编号正则坏了,C 会静默全绿。 */
export const MIN_DELIVERY_HITS = 5;

/** 条目标题:`### P1-32 …` / `### P2-8 …`。同层级的非编号标题(如业务 Decision)不在管辖面。 */
const ENTRY_HEADING = /^###\s+(P[12]-\d+)(?=[\s:：—-]|$)/;
/** 区段边界:下一个 `## ` 或 `### ` 标题。`#### ` 属于本条目正文,不算边界。 */
const SECTION_BOUNDARY = /^#{2,3}\s/;
/** 状态行:行首 `**状态**:`(全角冒号)。刻意不认 `- **状态**:` —— 台账正文里已有两行那种散文式写法。 */
const STATUS_LINE = /^\*\*状态\*\*:\s*(.+?)\s*$/;

/**
 * 交付类 commit 类型。`docs(…)` 是**记账动作本身**不是交付 ——
 * 实测反例是决定性的:P2-11 唯一点名它的提交就是
 * `3948ccbc docs(next-tasks): P2-11 立项前取证`,照字面判则**一条新条目刚登记进台账就当场变红**。
 * 同形态还有 P1-10 / P1-20 / P1-25 / P1-27 / P1-30。
 * **本机实测读数(`origin/main` = `3948ccbc`,25 条条目)**:若全部标 `待办`,
 * 不过滤类型时 C 会点名 **16** 条,过滤 `docs`/`chore`/`style` 后降到 **9** 条;
 * 那 9 条里 8 条是真阳性(P1-31 / P1-32 / P2-8 / P2-12 / P2-13 / P2-14 / P2-15 / P2-16),
 * 残留假阳性**恰 1 条**(P2-7,见已知缺口 3)。三条已知阳性 P2-8 / P2-12 / P2-13 仍 **3/3 检出**。
 */
const NON_DELIVERY_TYPES = new Set(['docs', 'chore', 'style']);
/** 认不出类型的**按交付算**(fail-closed):宁可多红一条让人来看,也不让漏报静默发生。 */
const CONVENTIONAL_PREFIX = /^([a-z]+)(?:\([^)]*\))?!?:/;

export interface Commit {
  readonly sha: string;
  readonly subject: string;
  readonly delivery: boolean;
}

export interface Entry {
  readonly id: string;
  readonly headingLine: number;
  readonly heading: string;
  /** 区段内所有命中 STATUS_LINE 的行(用于「恰一行」判定,多于一行同样是红)。 */
  readonly statusLines: readonly { readonly line: number; readonly value: string }[];
}

export type StatusKind = '待办' | '进行中' | '待拍板' | '⏸ 挂起' | '已收口';

/** 白名单。`needsPr`=括号内必须带 ≥1 个 `#PR 号`;`needsReason`=括号内必须非空。 */
export const STATUS_SPEC: ReadonlyArray<{
  readonly kind: StatusKind;
  readonly bare: boolean;
  readonly needsPr: boolean;
  readonly needsReason: boolean;
}> = [
  { kind: '待办', bare: true, needsPr: false, needsReason: false },
  { kind: '进行中', bare: false, needsPr: true, needsReason: true },
  { kind: '待拍板', bare: false, needsPr: false, needsReason: true },
  { kind: '⏸ 挂起', bare: false, needsPr: false, needsReason: true },
  { kind: '已收口', bare: false, needsPr: true, needsReason: true },
];

export const STATUS_KINDS: readonly StatusKind[] = STATUS_SPEC.map((s) => s.kind);

export interface ParsedStatus {
  readonly kind: StatusKind;
  readonly detail: string;
  readonly prNumbers: readonly number[];
}

/** 把状态串解析成 `{kind, detail, prNumbers}`;不在白名单 / 形态不合返回 `null`。 */
export function parseStatus(raw: string): ParsedStatus | null {
  for (const spec of STATUS_SPEC) {
    if (spec.bare) {
      if (raw === spec.kind) return { kind: spec.kind, detail: '', prNumbers: [] };
      continue;
    }
    if (!raw.startsWith(spec.kind)) continue;
    const rest = raw.slice(spec.kind.length);
    const wrapped = /^\((.*)\)$/s.exec(rest);
    if (!wrapped) return null;
    const detail = wrapped[1].trim();
    if (spec.needsReason && detail === '') return null;
    const prNumbers = [...detail.matchAll(/#(\d+)/g)].map((m) => Number(m[1]));
    if (spec.needsPr && prNumbers.length === 0) return null;
    return { kind: spec.kind, detail, prNumbers };
  }
  return null;
}

/** 条目编号 → 匹配 commit subject 的正则。`P2-12a`/`P2-12b` 归属 `P2-12`;`P2-1` 不吃 `P2-12`。 */
export function entryIdPattern(id: string): RegExp {
  return new RegExp(`(?<![0-9A-Za-z-])${id}[a-z]?(?![0-9])`);
}

export function isDeliverySubject(subject: string): boolean {
  const match = CONVENTIONAL_PREFIX.exec(subject.trim());
  if (!match) return true; // 认不出类型 ⇒ fail-closed 按交付算
  return !NON_DELIVERY_TYPES.has(match[1]);
}

/** 解析全部 `### Pn-m` 条目及其区段内的状态行。 */
export function parseEntries(markdown: string): Entry[] {
  const lines = markdown.split('\n');
  const entries: Entry[] = [];
  let current: {
    id: string;
    headingLine: number;
    heading: string;
    statusLines: { line: number; value: string }[];
  } | null = null;

  const flush = (): void => {
    if (current) entries.push(current);
    current = null;
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (SECTION_BOUNDARY.test(line)) {
      flush();
      const heading = ENTRY_HEADING.exec(line);
      if (heading) current = { id: heading[1], headingLine: i + 1, heading: line, statusLines: [] };
      continue;
    }
    if (!current) continue;
    const status = STATUS_LINE.exec(line);
    if (status) current.statusLines.push({ line: i + 1, value: status[1] });
  }
  flush();
  return entries;
}

/**
 * 台账图例表里声明的取值集合。selfCheck 断言它与 `STATUS_KINDS` **双向相等** ——
 * 少一个 = 代码认的值文档没写;多一个 = 文档许诺的值代码不认。两个方向都是「第二份真相」。
 */
export function parseLegendKinds(markdown: string): string[] {
  const block = /<!--\s*status-legend:begin\s*-->([\s\S]*?)<!--\s*status-legend:end\s*-->/.exec(markdown);
  if (!block) return [];
  return [...block[1].matchAll(/^>?\s*\|\s*`([^`]+?)(?:\(…\))?`\s*\|/gm)].map((m) => m[1].trim());
}

/**
 * 刻意不用不可见分隔符:`%H %s` + 定长 40 位 SHA 切分,源码里没有控制字节。
 * (首版用 `%x1f` 分隔,落盘后源码里就多了一个看不见的 0x1F —— 那类东西没人 review 得出来。)
 */
export function readCommits(baseRef: string): Commit[] {
  const raw = execFileSync('git', ['log', '--format=%H %s', baseRef], {
    encoding: 'utf8',
    maxBuffer: 1 << 28,
  });
  return raw
    .split('\n')
    .filter((line) => /^[0-9a-f]{40} /.test(line))
    .map((line) => {
      const sha = line.slice(0, 40);
      const subject = line.slice(41);
      return { sha, subject, delivery: isDeliverySubject(subject) };
    });
}

/** 依次尝试候选 ref,返回第一个存在的。全都不存在 ⇒ 抛(不是静默降级到空历史)。 */
export function resolveBaseRef(explicit?: string): string {
  const candidates = explicit ? [explicit] : ['origin/main', 'main'];
  for (const ref of candidates) {
    try {
      execFileSync('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { stdio: 'pipe' });
      return ref;
    } catch {
      /* 继续试下一个 */
    }
  }
  throw new Error(
    `解析不出 main 的 ref(试过:${candidates.join(' / ')})。` +
      'CI 上请确认 checkout 用了 fetch-depth: 0 并 fetch 过 base 分支 —— 浅克隆会让判据 C 全程失明。',
  );
}

export interface Facts {
  readonly entries: readonly Entry[];
  readonly commits: readonly Commit[];
  readonly legendKinds: readonly string[];
  /** 条目编号 → 点名它的**交付类**已合 commit。 */
  readonly deliveryByEntry: ReadonlyMap<string, readonly Commit[]>;
  /** main 上出现过的全部 PR 号(`(#N)` 形态)。 */
  readonly mergedPrs: ReadonlySet<number>;
}

export function gatherFacts(root: string, baseRef: string): Facts {
  const markdown = readFileSync(resolve(root, LEDGER_PATH), 'utf8');
  const entries = parseEntries(markdown);
  const commits = readCommits(baseRef);
  const deliveryByEntry = new Map<string, readonly Commit[]>();
  for (const entry of entries) {
    const pattern = entryIdPattern(entry.id);
    deliveryByEntry.set(
      entry.id,
      commits.filter((c) => c.delivery && pattern.test(c.subject)),
    );
  }
  const mergedPrs = new Set<number>();
  for (const commit of commits) {
    for (const match of commit.subject.matchAll(/\(#(\d+)\)/g)) mergedPrs.add(Number(match[1]));
  }
  return { entries, commits, legendKinds: parseLegendKinds(markdown), deliveryByEntry, mergedPrs };
}

/** 仪器自证:先证明自己有输入、且尺子没刻错,再去报数。 */
export function selfCheck(facts: Facts): string[] {
  const failures: string[] = [];

  if (facts.entries.length < MIN_ENTRIES) {
    failures.push(
      `扫描面塌了:只解析出 ${facts.entries.length} 条 \`### Pn-m\` 条目(地板 ${MIN_ENTRIES})。` +
        '多半是标题格式被改或读错文件 —— 「判据失去输入 ≠ 通过」。',
    );
  }
  const duplicates = facts.entries.map((e) => e.id).filter((id, index, all) => all.indexOf(id) !== index);
  if (duplicates.length > 0) failures.push(`同一编号出现多条条目:${[...new Set(duplicates)].join(' / ')}`);

  if (facts.commits.length < MIN_COMMITS) {
    failures.push(
      `main 历史只读到 ${facts.commits.length} 个 commit(地板 ${MIN_COMMITS})—— ` +
        '判据 C 会全程失明。CI 上检查 checkout 的 fetch-depth。',
    );
  }
  const deliveryHits = [...facts.deliveryByEntry.values()].reduce((sum, list) => sum + list.length, 0);
  if (deliveryHits < MIN_DELIVERY_HITS) {
    failures.push(
      `「交付类 commit 点名条目」命中 ${deliveryHits} 条(地板 ${MIN_DELIVERY_HITS})—— ` +
        '编号正则或 commit 类型过滤坏了,判据 C 会静默全绿。',
    );
  }
  if (!facts.commits.some((c) => c.delivery) || !facts.commits.some((c) => !c.delivery)) {
    failures.push('commit 类型过滤退化成恒真 / 恒假(交付与非交付必须都存在)。');
  }

  // 编号边界:`P2-1` 不得吃掉 `P2-12`;`P2-12a` 必须归属 `P2-12`。
  if (entryIdPattern('P2-1').test('闸(P2-12) (#1)')) failures.push('编号正则把 `P2-12` 误判成 `P2-1`(边界失效)。');
  if (!entryIdPattern('P2-12').test('闸(P2-12a) (#1)')) failures.push('编号正则没把 `P2-12a` 归属到 `P2-12`。');
  if (entryIdPattern('P1-3').test('(P1-32 PR 4a)')) failures.push('编号正则把 `P1-32` 误判成 `P1-3`(边界失效)。');

  const legend = [...facts.legendKinds].sort();
  const code = [...STATUS_KINDS].sort();
  if (legend.length === 0) {
    failures.push('台账里找不到 `status-legend` 图例块 —— 白名单没有人话版本,写台账的人无从遵守。');
  } else if (legend.join('|') !== code.join('|')) {
    failures.push(
      `台账图例与判据白名单不相等(第二份真相):图例 [${legend.join(', ')}] vs 判据 [${code.join(', ')}]。`,
    );
  }
  return failures;
}

export interface Report {
  readonly facts: Facts;
  readonly selfFailures: readonly string[];
  readonly aFailures: readonly string[];
  readonly bFailures: readonly string[];
  readonly cFailures: readonly string[];
}

export function analyze(root: string, baseRef: string): Report {
  const facts = gatherFacts(root, baseRef);
  const selfFailures = selfCheck(facts);
  const aFailures: string[] = [];
  const bFailures: string[] = [];
  const cFailures: string[] = [];

  for (const entry of facts.entries) {
    const where = `${LEDGER_PATH}:${entry.headingLine} (${entry.id})`;

    if (entry.statusLines.length === 0) {
      aFailures.push(
        `${where} 没有状态行。在标题下方补一行 \`**状态**:<白名单取值>\`` +
          '(取值见台账顶部图例;别用 `- **状态**:` 那种散文写法,判据不认)。',
      );
      continue;
    }
    if (entry.statusLines.length > 1) {
      aFailures.push(
        `${where} 有 ${entry.statusLines.length} 行状态(第 ${entry.statusLines
          .map((s) => s.line)
          .join(' / ')} 行)—— 一条目恰一行,多一行就是第二份真相。`,
      );
      continue;
    }

    const [status] = entry.statusLines;
    const parsed = parseStatus(status.value);
    if (!parsed) {
      aFailures.push(
        `${LEDGER_PATH}:${status.line} (${entry.id}) 状态取值不合法:\`${status.value}\`。` +
          `只能是 ${STATUS_KINDS.map((k) => `\`${k}\``).join(' / ')};` +
          '除 `待办` 外必须带括号且括号内非空,`进行中` / `已收口` 还必须带 ≥1 个 `#PR 号`。',
      );
      continue;
    }

    // ── B:防谎报。`已收口` / `进行中` 记的都是「已合的那几刀」。
    if (parsed.kind === '已收口' || parsed.kind === '进行中') {
      const missing = parsed.prNumbers.filter((pr) => !facts.mergedPrs.has(pr));
      if (missing.length > 0) {
        bFailures.push(
          `${LEDGER_PATH}:${status.line} (${entry.id}) 状态声称 \`${parsed.kind}\`,` +
            `但 ${missing.map((pr) => `#${pr}`).join(' / ')} 在 main 上找不到已合入的痕迹。` +
            '(在飞的 PR 号请写在正文里,不要写进状态行。)',
        );
      }
    }

    // ── C:主力。只对 `待办` 开火。
    if (parsed.kind === '待办') {
      const hits = facts.deliveryByEntry.get(entry.id) ?? [];
      if (hits.length > 0) {
        cFailures.push(
          `${LEDGER_PATH}:${status.line} (${entry.id}) 仍写 \`待办\`,` +
            `但 main 上已有 ${hits.length} 个**交付类** commit 点名它:\n` +
            hits.map((c) => `      ${c.sha.slice(0, 8)} ${c.subject}`).join('\n') +
            '\n    ⇒ 要么把状态改成真实值(`进行中` / `已收口` / `待拍板` / `⏸ 挂起`),' +
            '要么说明为什么它仍是待办。',
        );
      }
    }
  }
  return { facts, selfFailures, aFailures, bFailures, cFailures };
}

export function formatFailures(report: Report): string[] {
  return [...report.selfFailures, ...report.aFailures, ...report.bFailures, ...report.cFailures];
}

function main(argv: readonly string[]): number {
  const baseIndex = argv.indexOf('--base');
  const baseRef = resolveBaseRef(baseIndex >= 0 ? argv[baseIndex + 1] : undefined);
  const report = analyze(process.cwd(), baseRef);

  const counts = new Map<string, number>();
  for (const entry of report.facts.entries) {
    const parsed = entry.statusLines.length === 1 ? parseStatus(entry.statusLines[0].value) : null;
    const key = parsed ? parsed.kind : '(不合法/缺失)';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const deliveryHits = [...report.facts.deliveryByEntry.values()].reduce((s, l) => s + l.length, 0);

  console.log(`台账状态收口闸 —— 基准 ref: ${baseRef}`);
  console.log(
    `  条目 ${report.facts.entries.length} 条 / main ${report.facts.commits.length} commit / ` +
      `交付类点名命中 ${deliveryHits} 条`,
  );
  console.log(`  状态分布:${[...counts.entries()].map(([k, v]) => `${k} ${v}`).join(' · ')}`);

  const failures = formatFailures(report);
  if (failures.length === 0) {
    console.log('✓ A 结构完整 / B 无谎报 / C 无「点名了却仍写待办」');
    console.log(
      '⚠️ 射程限制:C 只管「commit subject 点名了编号」的那批 —— 实测近 40 个 commit 里 20 个带编号。' +
        '闸绿 ≠ 台账准(见本文件头注「已知缺口」)。',
    );
    return 0;
  }
  console.error(`\n✗ 台账状态收口闸失败(${failures.length} 条):\n`);
  for (const failure of failures) console.error(`  - ${failure}`);
  console.error(`\n  规则与取值说明见 ${LEDGER_PATH} 顶部的状态图例,以及本文件头注。`);
  return 1;
}

if (process.argv[1] && /check-next-tasks-state\.ts$/.test(process.argv[1])) {
  process.exit(main(process.argv.slice(2)));
}
