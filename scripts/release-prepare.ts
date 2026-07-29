import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

// Harness 3.0 P4c — 发版收口阶段 A(合并前的全部簿记,一次做完)。
//
// 背景:v0.62.0 的收口用了 **5 个纯簿记 PR**(#794 归并 changelog / #795 bump /
// #796 **修日期笔误** / #797 handoff 快照 / #798 current-state 回填),每个都要
// 维护者点一次、等一轮 CI。其中 #796 是手工必然会犯的那类错 —— 日期是可计算的,
// 不该由人抄。
//
// 本脚本把阶段 A 的五件事合成一次写入(仍是一个 PR,仍需维护者拍板合并):
//   1. changelog.d/ fragment 归并进 ## Unreleased
//   2. ## Unreleased → ## vX.Y.Z - <今天>(日期自动,消灭 #796 那类错)
//   3. package.json#version + apply-swagger setVersion
//   4. 生成 docs/archive/handoff/vX.Y.Z.md(数字来自守护计数,叙事取自 CHANGELOG 本版段)
//   5. 回填 current-state §1
//
// 设计约束(沿对抗性评审结论):
//   - **幂等可重入**:每步先探测已完成态;中途失败重跑不会写坏
//   - **fail-closed**:任一步无法确定 → 停下并打印「已完成/未完成」清单,不猜
//   - **绝不合并**:自合门保留(主会话自开 PR 合并到 main 须维护者明确点头)
//   - **绝不打 tag / 发 Release**:那些必须发生在 squash 合并之后,见 release-finish.ts
//
// 用法:pnpm release:prepare 0.63.0 [--dry-run]

const ROOT = path.resolve(__dirname, '..');
const CHANGELOG = 'CHANGELOG.md';
const CURRENT_STATE = 'docs/current-state.md';
const SWAGGER = 'src/bootstrap/apply-swagger.ts';
const PKG = 'package.json';

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf-8');
}
function write(rel: string, content: string): void {
  fs.writeFileSync(path.join(ROOT, rel), content);
}
function git(args: string[]): string {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf-8' }).trim();
}

interface Step {
  readonly name: string;
  /** 已完成则返回说明(跳过);未完成返回 null */
  readonly done: () => string | null;
  readonly run: () => void;
}

function todayInBeijing(): string {
  // 发版日期按北京时区(团队所在地),避免 UTC 下「昨天发的版写成今天」
  const now = new Date();
  const bj = new Date(now.getTime() + (8 * 60 + now.getTimezoneOffset()) * 60_000);
  const mm = String(bj.getMonth() + 1).padStart(2, '0');
  const dd = String(bj.getDate()).padStart(2, '0');
  return `${bj.getFullYear()}-${mm}-${dd}`;
}

function assertSemver(v: string): void {
  if (!/^\d+\.\d+\.\d+$/.test(v)) {
    throw new Error(`版本号形态非法:'${v}'(期望 X.Y.Z,不带 v 前缀)`);
  }
}

function readCounts(): Array<[string, string]> {
  // current-state 的 counts 块由 pnpm docs:counts 生成,是唯一事实源
  const doc = read(CURRENT_STATE);
  const b = doc.indexOf('<!-- counts:begin -->');
  const e = doc.indexOf('<!-- counts:end -->');
  if (b === -1 || e === -1) throw new Error('current-state 缺少 counts 块 —— 无法取 footprint');
  const block = doc.slice(b, e);
  const out: Array<[string, string]> = [];
  for (const m of block.matchAll(/^\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|$/gm)) {
    const k = m[1].trim();
    if (k && k !== '计数项' && !/^-+$/.test(k)) out.push([k, m[2].trim()]);
  }
  return out;
}

function extractChangelogSection(version: string): string {
  const doc = read(CHANGELOG);
  const start = doc.indexOf(`## v${version} -`);
  if (start === -1) return '';
  const rest = doc.slice(start);
  const nextIdx = rest.indexOf('\n## ', 1);
  return (nextIdx === -1 ? rest : rest.slice(0, nextIdx)).trim();
}

function buildSteps(version: string, tag: string, date: string, handoffRel: string): Step[] {
  return [
    {
      name: 'changelog.d fragment 归并',
      done: () => {
        const dir = path.join(ROOT, 'changelog.d');
        if (!fs.existsSync(dir)) return 'changelog.d/ 不存在';
        const frags = fs.readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'README.md');
        return frags.length === 0 ? '无待归并 fragment' : null;
      },
      run: () => {
        execFileSync('pnpm', ['changelog:merge'], { cwd: ROOT, stdio: 'inherit' });
      },
    },
    {
      name: `CHANGELOG:## Unreleased → ## ${tag} - ${date}`,
      done: () => (read(CHANGELOG).includes(`## ${tag} -`) ? `${tag} 段已存在` : null),
      run: () => {
        const doc = read(CHANGELOG);
        if (!doc.includes('## Unreleased')) {
          throw new Error('CHANGELOG 无 ## Unreleased 段 —— 无法折叠(是否已发过版?)');
        }
        const body = doc.slice(doc.indexOf('## Unreleased') + '## Unreleased'.length);
        const nextIdx = body.indexOf('\n## ');
        const section = (nextIdx === -1 ? body : body.slice(0, nextIdx)).trim();
        if (section === '') {
          throw new Error('## Unreleased 段为空 —— 没有可发布的变更,拒绝生成空版本');
        }
        write(CHANGELOG, doc.replace('## Unreleased', `## ${tag} - ${date}`));
      },
    },
    {
      name: `package.json version → ${version}`,
      done: () => {
        const pkg = JSON.parse(read(PKG)) as { version: string };
        return pkg.version === version ? `已是 ${version}` : null;
      },
      run: () => {
        const raw = read(PKG);
        const cur = (JSON.parse(raw) as { version: string }).version;
        write(PKG, raw.replace(`"version": "${cur}"`, `"version": "${version}"`));
      },
    },
    {
      name: `apply-swagger setVersion → ${version}`,
      done: () => (read(SWAGGER).includes(`.setVersion('${version}')`) ? `已是 ${version}` : null),
      run: () => {
        const raw = read(SWAGGER);
        const next = raw.replace(/\.setVersion\('[^']+'\)/, `.setVersion('${version}')`);
        if (next === raw) throw new Error(`${SWAGGER} 未找到 setVersion(...) —— 结构变了,拒绝盲改`);
        write(SWAGGER, next);
      },
    },
    {
      // ⚠️ 必须紧跟在 apply-swagger 版本改动之后:openapi 快照的 `info.version`
      // 取自 setVersion,版本一改快照立即过期,而 P4d 把「契约快照新鲜度」接进了 CI。
      // 不做这一步,**每一次发版都会被自己的守护卡住** —— v0.63.0 发版 PR 的
      // Fast checks 就是这么红的(2026-07-29 实测,发版链第一次真实使用即暴露)。
      // 教训:加一道门时,必须同时问「哪些既有流程会撞上它」。
      name: 'openapi 快照随版本刷新',
      done: () => {
        try {
          execFileSync('pnpm', ['exec', 'ts-node', '--project', 'tsconfig.json',
            'scripts/generate-openapi.ts', '--check'], { cwd: ROOT, stdio: 'pipe' });
          return '快照已与当前代码一致';
        } catch {
          return null;
        }
      },
      run: () => {
        execFileSync('pnpm', ['exec', 'ts-node', '--project', 'tsconfig.json',
          'scripts/generate-openapi.ts'], { cwd: ROOT, stdio: 'inherit' });
      },
    },
    {
      name: `生成 ${handoffRel}`,
      done: () => (fs.existsSync(path.join(ROOT, handoffRel)) ? '快照已存在(不回改)' : null),
      run: () => {
        const counts = readCounts();
        const section = extractChangelogSection(version);
        if (section === '') throw new Error(`CHANGELOG 无 ## ${tag} 段 —— 无法生成 handoff`);
        const handoffDir = path.join(ROOT, 'docs/archive/handoff');
        // ⚠️ 必须按 semver 数值排序,不能用字符串排序:
        // 字符串下 'v0.9.0' > 'v0.62.0'(逐字符比 '9' > '6'),会把「接续上一版」指错。
        const semverKey = (f: string): number[] =>
          f.replace(/^v|\.md$/g, '').split('.').map((n) => parseInt(n, 10));
        const prev = fs
          .readdirSync(handoffDir)
          .filter((f) => /^v\d+\.\d+\.\d+\.md$/.test(f) && f !== `${tag}.md`)
          .sort((a, b) => {
            const [x, y] = [semverKey(a), semverKey(b)];
            return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
          })
          .pop();
        const baseline = git(['rev-parse', 'HEAD']);
        const lines = [
          `# SRVF API ${tag} Handoff Index`,
          '',
          '> 面向下一次 AI 开发会话。**本文件由 `pnpm release:prepare` 生成**;',
          '> 它是 release 时刻的**快照**,合入后不回改 —— 发现过时请改 `docs/current-state.md`。',
        ];
        if (prev) lines.push(`> 接续 [\`${prev}\`](${prev});逐笔详情见 CHANGELOG \`## ${tag}\` 段。`);
        lines.push(
          '',
          '---',
          '',
          '## 1. 版本与 footprint',
          '',
          `- **${tag}**(Release 日期 **${date}**)`,
          `- 生成时代码基线:\`${baseline}\``,
          '- 仓库 footprint(取自 `pnpm docs:counts` 守护计数,与 current-state 同源):',
          '',
          '| 计数项 | 值 |',
          '|---|---|',
          ...counts.map(([k, v]) => `| ${k} | ${v} |`),
          '',
          '## 2. 本版交付(取自 CHANGELOG,逐笔详情见该段)',
          '',
          section.split('\n').slice(1).join('\n').trim(),
          '',
          '## 3. 状态口径',
          '',
          '- 本版本是**代码与契约里程碑 Release**,不等于生产部署;部署边界见 `docs/current-state.md` §1 与 §4。',
          '- tag 指向本 release PR 的 squash 合并提交(由 `pnpm release:finish` 打,并输出证据)。',
          '',
        );
        write(handoffRel, lines.join('\n'));
      },
    },
    // 原「current-state §1 回填」步骤已于 2026-07-29 删除。
    //
    // 它往 current-state §1 写 `| 版本 / Release | **vX.Y.Z**(日期…) |` 这一行,
    // 而 **P3 恒读层重写把那一行删了** —— 版本号 / main HEAD / open PR 属机器可查事实,
    // 现场跑 `pnpm agent:preflight` 即得,留在恒读层只会周期性过期。
    // 于是这一步永久失败(它 fail-closed 拒绝盲改,这点是对的),
    // 而**直到本次真实发版才暴露** —— release:prepare 此前只在自测里跑过。
    //
    // 教训(已登记):**文档瘦身会砍掉脚本依赖的锚点,而没有守护看得见这种依赖**。
    // 恒读层守护只管体积,docs-counts 只管计数块,谁都不知道有个脚本在找那一行。
    // 现在版本真相的载体是:package.json + git tag + handoff 快照 —— 三者都不在恒读层,
    // 不需要回填。
  ];
}

function main(): void {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const version = args.find((a) => !a.startsWith('--'));
  if (!version) {
    console.error('用法:pnpm release:prepare <X.Y.Z> [--dry-run]');
    process.exit(1);
  }
  assertSemver(version);

  const tag = `v${version}`;
  const date = todayInBeijing();
  const handoffRel = `docs/archive/handoff/${tag}.md`;
  const steps = buildSteps(version, tag, date, handoffRel);
  const doneMsgs: string[] = [];

  console.log(`发版阶段 A:${tag}(日期 ${date}${dryRun ? ';DRY-RUN' : ''})\n`);

  for (const step of steps) {
    let already: string | null;
    try {
      already = step.done();
    } catch (err) {
      console.error(`✗ 无法判定「${step.name}」是否已完成:${(err as Error).message}`);
      console.error('  fail-closed:停下,不猜。请人工确认后重跑。');
      process.exit(1);
    }
    if (already !== null) {
      console.log(`⏭  跳过 ${step.name} — ${already}`);
      continue;
    }
    if (dryRun) {
      console.log(`·  将执行 ${step.name}`);
      continue;
    }
    try {
      step.run();
      doneMsgs.push(step.name);
      console.log(`✓  ${step.name}`);
    } catch (err) {
      const remaining = steps.slice(steps.indexOf(step)).map((s) => s.name);
      console.error(`\n✗ 「${step.name}」失败:${(err as Error).message}`);
      console.error(`\n已完成:${doneMsgs.join(' / ') || '(无)'}`);
      console.error(`未完成:${remaining.join(' / ')}`);
      console.error('\n本脚本幂等:修好上述问题后直接重跑,已完成的步骤会自动跳过。');
      process.exit(1);
    }
  }

  console.log('\n下一步(阶段 A 到此为止,脚本**不会**自行提交 / 开 PR / 合并 / 打 tag):');
  console.log('  1. 复核 git diff(尤其 CHANGELOG 折叠段与 handoff 叙事)');
  console.log('  2. pnpm docs:counts && pnpm agent:check:full');
  console.log('  3. 提交 + 开 PR(档位 E),由**维护者**拍板合并');
  console.log(`  4. 合并后跑:pnpm release:finish ${version}`);
}

main();
