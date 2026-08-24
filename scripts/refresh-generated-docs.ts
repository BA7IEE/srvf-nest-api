/**
 * refresh-generated-docs.ts — 生成物「一次性全刷」入口(实测依赖图版)
 *
 * ## 为什么有这个文件
 *
 * 2026-08-24 一天之内,同一形态复发 **7 次**:改了源、只刷了一部分生成物,
 * 剩下的到 CI 才红(逐条见 docs/ai-harness/README.md §1.7)。
 * 当时流传的补救办法是一句口诀 ——「顺序是 openapi → clients → authz → codemap」——
 * 而那句口诀**经实测有两处错**(见下方「实测结论」)。
 * 固化一个错的顺序比没有入口更糟:它让人以为「跑了这个就齐了」。
 *
 * 所以本文件刻意**不**是「把口诀写成脚本」,而是:
 *   ① 刷新集合从 package.json 现算,不在这里维护第二份名单;
 *   ② 只登记**实测出来的那一条**真依赖边;
 *   ③ 跑完用「再跑一遍看还变不变」自证顺序够用 —— 顺序错了本脚本自己红。
 *
 * ## 实测结论(方法与证据见 docs/ai-harness/README.md §1.7)
 *
 * 六个刷新器里,**只有一条真的生成物→生成物依赖**:
 *
 *     docs:openapi ──(docs/handoff/openapi.json)──▶ docs:feclient
 *
 * 其余五个各自只读 `src/` / `prisma/` / `harness/*.json` 与**自己的**产物,
 * 彼此之间零依赖、无先后。⇒ 真正的缺陷不是「顺序记错」,是「**改了源只刷了一部分**」。
 *
 * ⚠️ 口诀错在哪:`docs:authz` 与 `docs:codemap` **不在 openapi 的下游**。
 *    实测把 docs/handoff/openapi.json 改坏,这两条守护纹丝不动(只有 openapi 与 feclient 红)。
 *    它们之所以常常跟着一起红,是因为**它们和 openapi 共用上游 `src/`** —— 同源,不是串联。
 *
 * ## 刻意不做
 *
 * - **不跑任何 `docs:*:check`**:刷新与校验是两件事。刷完再校验必绿,那是同义反复,
 *   证明不了入口没漏刷。本脚本的自证走的是另一条路(见「自证」)。
 * - **不刷 contract 快照**(`pnpm test:contract -u`):那份要**连数据库**起 Nest,
 *   且「盲 `-u` 更新快照」在 .claude/settings.json 的 deny 清单里 —— 必须人当场判读。
 * - **不刷 service 尺寸基线**(`pnpm harness:servicesize:write`):它是**棘轮**,
 *   整体重算会把上限一起调高,混进「顺手全刷」里等于自动放宽治理闸。
 * - **不接 CI**:CI 上跑的恒是 `docs:*:check`(Fast checks)。本脚本是给人用的。
 *
 * ## 自证(两条,都在「树是干净的」时也照样能失败)
 *
 * 1. **登记表完备性**:package.json 里每一条 `docs:*:check` 都必须在本文件的 REGISTRY 里
 *    有一行 —— 要么指向刷新器,要么显式写明「无对应生成物」及理由。
 *    新加一条 `docs:foo:check` 而忘了登记 ⇒ 本脚本当场退 1。
 *    (这条不依赖工作树状态,是结构性的。)
 * 2. **顺序充分性**:第一趟按登记顺序刷完之后,**再刷一趟**;若第二趟还改动了任何文件,
 *    说明存在一条没登记的依赖边(下游先于上游跑了)⇒ 退 1 并报出是哪份产物。
 *
 * 用法:
 *   pnpm docs:refresh
 *   pnpm docs:refresh --dry-run    # 只打印计划与自证①,不写任何文件
 *
 * ⚠️ 本文件**不在** harness/redzone.json 内(名字不匹配 selfGuard 的 `check-*` /
 *    `generate-*` 等 glob)—— 它是编排工具不是判据,执法仍然全在 CI 的 `docs:*:check`。
 */

import { execFileSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..');

type RegistryRow = {
  /** package.json 里的守护脚本名 */
  readonly check: string;
  /** 对应的刷新脚本名;null = 这条守护没有生成物可刷 */
  readonly refresh: string | null;
  /** 实测:本刷新器读了哪些**别的刷新器**的产物(决定先后) */
  readonly after?: readonly string[];
  /** 人话理由 —— refresh 为 null 时必填 */
  readonly why: string;
};

/**
 * 登记表。**每一行的「读了谁的产物」都是实测出来的**,不是从命令名猜的:
 * 手法见 README §1.7(运行期 fs 追踪 + 扰动矩阵 + 读常量,三法交叉)。
 */
const REGISTRY: readonly RegistryRow[] = [
  {
    check: 'docs:openapi:check',
    refresh: 'docs:openapi',
    why: '产物 docs/handoff/openapi.json。实测只读 src/(经 ts-node 模块图,809 份)与自己的产物;零数据库(DATABASE_URL 默认指向 127.0.0.1:1)',
  },
  {
    check: 'docs:feclient:check',
    refresh: 'docs:feclient',
    after: ['docs:openapi'],
    why: '产物 docs/handoff/clients/。⭐ 全仓**唯一**一条生成物→生成物的边:实测它一个 src/ 文件都不读,只读 docs/handoff/openapi.json 与自己的产物',
  },
  {
    check: 'docs:authz:check',
    refresh: 'docs:authz',
    why: '产物 docs/ai-harness/ROUTE_AUTHZ.md + harness/authz-assertion-patterns.json。inputDigest = src 下全部 .ts(排除 *.spec.ts)+ test/contract/openapi.contract-spec.ts;**与 openapi.json 无关**',
  },
  {
    check: 'docs:codemap:check',
    refresh: 'docs:codemap',
    why: '产物 CODEMAP.md。读 src/ 与自己的产物,另枚举 prisma/migrations/ 与 test/e2e/ 目录(只数不读内容);**与 openapi.json 无关**',
  },
  {
    check: 'docs:rbacmap:check',
    refresh: 'docs:rbacmap',
    why: '产物 docs/ai-harness/RBAC_MAP.md 的生成段。读 src 下的 *.controller.ts + prisma/seed.ts + 自己的产物',
  },
  {
    check: 'docs:counts:check',
    refresh: 'docs:counts',
    why: '产物 docs/current-state.md 的 counts 块。读 src/ + prisma/seed.ts + prisma/migrations/ + test/contract/openapi.contract-spec.ts',
  },
  {
    check: 'docs:readtax:check',
    refresh: null,
    why: '纯判据,无生成物 —— 它量的是恒读层字符预算。⚠️ 它**读** docs/current-state.md(= docs:counts 的产物),所以 counts 把计数块撑大到越过预算时它会红;当前 7232/9600(75%),不是本类缺陷的常见触发点',
  },
  {
    check: 'docs:boundaries:check',
    refresh: null,
    why: '纯判据(A 类 metadata 完整性),无生成物。同一脚本的报告态 `docs:boundaries` 也不写文件 —— 实测 WRITE 0 条',
  },
  {
    check: 'docs:boundaries:debt:check',
    refresh: null,
    why: '纯判据(债务台账语义字段完整性),无生成物',
  },
  {
    check: 'docs:boundaries:newdebt:check',
    refresh: null,
    why: '纯判据(禁新增代码债),无生成物',
  },
  {
    check: 'docs:boundaries:ids:check',
    refresh: null,
    why: '纯判据(债务 call-site 身份仍解析得开),无生成物',
  },
];

function fail(message: string): never {
  process.stderr.write(`\n✗ ${message}\n`);
  process.exit(1);
}

function packageScripts(): Record<string, string> {
  const raw = fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8');
  const parsed = JSON.parse(raw) as { scripts?: Record<string, string> };
  return parsed.scripts ?? {};
}

/** 自证 ①:登记表 ↔ package.json 的 `docs:*:check` 全集,双向比对。 */
function assertRegistryCoversPackageJson(scripts: Record<string, string>): void {
  const declared = new Set(REGISTRY.map((row) => row.check));
  const actual = new Set(Object.keys(scripts).filter((name) => /^docs:.*:check$/.test(name)));

  const missing = [...actual].filter((name) => !declared.has(name)).sort();
  const stale = [...declared].filter((name) => !actual.has(name)).sort();

  if (missing.length > 0) {
    fail(
      `package.json 新增了守护但刷新入口没登记:${missing.join(', ')}\n` +
        `  往 scripts/refresh-generated-docs.ts 的 REGISTRY 里加一行:\n` +
        `    · 有生成物 ⇒ refresh 填对应的 \`docs:*\` 脚本名(并实测它读不读别人的产物)\n` +
        `    · 纯判据   ⇒ refresh 填 null,why 写清为什么没有生成物\n` +
        `  ⚠️ 别为了让本脚本变绿就随手填 null —— 那正是「漏刷一份」的来源。`,
    );
  }
  if (stale.length > 0) {
    fail(
      `刷新入口登记了 package.json 里已经不存在的守护:${stale.join(', ')}\n` +
        `  守护被删或改名了,REGISTRY 要同步。`,
    );
  }

  for (const row of REGISTRY) {
    if (row.refresh !== null && scripts[row.refresh] === undefined) {
      fail(`REGISTRY 指向的刷新脚本在 package.json 里不存在:${row.refresh}`);
    }
    for (const dep of row.after ?? []) {
      if (!REGISTRY.some((other) => other.refresh === dep)) {
        fail(`REGISTRY 里 ${row.check} 声明 after: ${dep},但没有哪一行的 refresh 是它`);
      }
    }
  }
}

/** 按声明的 after 边做拓扑排序(边极少,朴素实现即可)。 */
function plan(): readonly RegistryRow[] {
  const rows = REGISTRY.filter((row) => row.refresh !== null);
  const done = new Set<string>();
  const ordered: RegistryRow[] = [];
  let guard = rows.length + 1;
  while (ordered.length < rows.length) {
    if (guard-- <= 0) fail('REGISTRY 的 after 声明成环,排不出顺序');
    for (const row of rows) {
      const name = row.refresh as string;
      if (done.has(name)) continue;
      if ((row.after ?? []).every((dep) => done.has(dep))) {
        done.add(name);
        ordered.push(row);
      }
    }
  }
  return ordered;
}

function git(args: readonly string[]): string {
  return execFileSync('git', [...args], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28 });
}

/** 工作树里「与 HEAD 不同 + 未跟踪」的每个文件的内容指纹。用于自证 ②。 */
function worktreeSnapshot(): Map<string, string> {
  const snapshot = new Map<string, string>();
  const status = git(['status', '--porcelain=v1', '-z']).split('\0').filter(Boolean);
  for (const entry of status) {
    const rel = entry.slice(3);
    if (rel === '') continue;
    const abs = path.join(ROOT, rel);
    let digest = '<absent>';
    try {
      if (fs.statSync(abs).isFile()) {
        digest = crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
      } else {
        digest = '<dir>';
      }
    } catch {
      digest = '<absent>';
    }
    snapshot.set(rel, digest);
  }
  return snapshot;
}

function snapshotDiff(before: Map<string, string>, after: Map<string, string>): string[] {
  const changed: string[] = [];
  for (const key of new Set([...before.keys(), ...after.keys()])) {
    if (before.get(key) !== after.get(key)) changed.push(key);
  }
  return changed.sort();
}

function runPass(ordered: readonly RegistryRow[], label: string): void {
  for (const row of ordered) {
    const name = row.refresh as string;
    process.stdout.write(`  [${label}] pnpm run ${name}\n`);
    try {
      execFileSync('pnpm', ['run', name], { cwd: ROOT, stdio: 'inherit' });
    } catch {
      fail(`刷新失败:pnpm run ${name}(上面是它自己的输出)`);
    }
  }
}

function main(): void {
  const dryRun = process.argv.includes('--dry-run');
  const scripts = packageScripts();

  assertRegistryCoversPackageJson(scripts);
  const ordered = plan();
  const edges = REGISTRY.reduce((total, row) => total + (row.after?.length ?? 0), 0);

  process.stdout.write(`刷新计划(${ordered.length} 个刷新器,登记的依赖边 ${edges} 条):\n`);
  for (const row of ordered) {
    const after = (row.after ?? []).length > 0 ? `  ← 必须晚于 ${(row.after ?? []).join(', ')}` : '';
    process.stdout.write(`  ${row.refresh}${after}\n`);
  }
  const judgesOnly = REGISTRY.filter((row) => row.refresh === null).map((row) => row.check);
  process.stdout.write(`无生成物的纯判据(不刷,CI 上照跑):${judgesOnly.join(' · ')}\n\n`);

  if (dryRun) {
    process.stdout.write('✓ 自证①(登记表 ↔ package.json 双向比对)通过;--dry-run 到此为止\n');
    return;
  }

  runPass(ordered, '1/2');
  const afterFirst = worktreeSnapshot();

  process.stdout.write('\n第二趟(自证②:顺序够不够用 —— 再刷一遍不该再变)\n');
  runPass(ordered, '2/2');
  const afterSecond = worktreeSnapshot();

  const drifted = snapshotDiff(afterFirst, afterSecond);
  if (drifted.length > 0) {
    fail(
      `第二趟还在改文件 ⇒ 存在一条**没登记的依赖边**(下游先于上游跑了):\n` +
        drifted.map((file) => `    ${file}`).join('\n') +
        `\n  把产出这些文件的刷新器的 after 补上(并说明是实测出来的),再跑一次。`,
    );
  }

  process.stdout.write('\n✓ 全部生成物已刷新\n');
  process.stdout.write('✓ 自证①:登记表覆盖 package.json 里全部 docs:*:check\n');
  process.stdout.write('✓ 自证②:第二趟零改动 ⇒ 登记的顺序对这次改动是够用的\n');
  process.stdout.write('\n下一步:`git status` 看刷出了什么;CI 的裁决恒是 `docs:*:check`,不是本脚本。\n');
}

if (require.main === module) main();
