/**
 * check-redzone.ts — 红区触碰的 **CI 侧、agent 无关**检测(Harness 3.0 P2c)
 *
 * 为什么必须有:`.claude/hooks/redzone-guard.sh` 只在 Claude Code 会话里生效。
 * Codex / Cursor / 别的 agent / 人手 `vim` / GitHub 网页编辑 —— **全都绕过它**。
 * 也就是说 P2b 之前建起来的整套红区执法,覆盖的只是「其中一个执行体」。
 * 本脚本把同一份 `harness/redzone.json` 搬到 CI 上判:**改动是谁做的不重要,
 * 只要进了 PR 就会被看见**。
 *
 * ⚠️ 它是**检测 + 摩擦**,不是不可伪造的授权。
 *    本仓的 AI 用的就是维护者本人的 `gh` token —— GitHub 这一侧任何门(label /
 *    environment 审批 / review)在协议上都无法区分「维护者点的」和「AI 用维护者
 *    的 token 点的」。所以本层的真实价值是:
 *      ① 红区触碰**永远显形**,不依赖是哪个 agent 干的
 *      ② 强制多一次人类动作与一条审计记录
 *    真正不可绕过的那一步,只能是维护者自己在合并前看一眼被标红的 PR。
 *    **把这句写在这里,是为了不让任何人(包括未来的我)以为这层比它实际更强。**
 *
 * 判定必须与 hook 逐字一致 —— 两套实现各自演化就会出现「一边拦一边放」,
 * 那比没有守护更糟(人会以为已经被管住了)。一致性由
 * `scripts/harness-guards.selftest.ts` 的 parity 用例逐条比对两边裁决来锁死。
 *
 * 用法:
 *   tsx scripts/check-redzone.ts --base origin/main      # CI:比对 base...HEAD
 *   tsx scripts/check-redzone.ts --files a.ts b.md       # 显式给文件列表(自测用)
 *
 * 退出码恒 0(内部错误除外):**本脚本只负责报告**,拦不拦由 workflow 的审批 job 决定。
 * 理由:一个红 X 只说明「有问题」,而维护者需要知道的是「这个 PR 需要你点一下」——
 * 那是两种不同的信号,混在一起会让人学会无视红 X。
 *
 * ⚠️ 本文件在 harness/redzone.json 的 selfGuard 内(`scripts/check-*.ts`)。
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..');

interface Entry {
  readonly id: string;
  readonly globs: readonly string[];
  readonly why: string;
  readonly allowCreate?: boolean;
}
interface Registry {
  readonly redzone: readonly Entry[];
  readonly selfGuard: readonly Entry[];
}

export interface Hit {
  readonly file: string;
  readonly kind: 'redzone' | 'selfGuard';
  readonly id: string;
  readonly why: string;
}

/**
 * glob 匹配 —— 逐条对齐 redzone-guard.sh 的 `matches_glob`:
 *   含 `**`:按「`**` 前的前缀」+「`**` 后的后缀(去掉前导 /)」两头匹配
 *   不含 `**`:等价于 bash `case` 的模式匹配(`*` 不跨目录、`?` 单字符、`[...]` 字符类)
 * 任何一处偏离都会造成两侧裁决分歧,parity 自测会当场红。
 */
export function matchesGlob(p: string, glob: string): boolean {
  if (glob.includes('**')) {
    const prefix = glob.slice(0, glob.indexOf('**'));
    let suffix = glob.slice(glob.lastIndexOf('**') + 2);
    if (suffix.startsWith('/')) suffix = suffix.slice(1);
    if (!p.startsWith(prefix)) return false;
    return suffix === '' || p.endsWith(suffix);
  }
  // bash case:* 不跨 /? 实际上 bash 的 case 里 * **会**跨 /。逐字对齐它。
  const rx = new RegExp(
    `^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`,
  );
  return rx.test(p);
}

export function loadRegistry(): Registry {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'harness/redzone.json'), 'utf-8')) as Registry;
}

/**
 * 单个路径的裁决。`added=true` 表示本次变更**新建**了该文件 ——
 * 对 allowCreate 条目(archive)新建放行、改既有不放行,与 hook 的
 * 「文件不存在即放行」同义(CI 侧只能看 diff 状态,看不了工作树)。
 */
export function judge(rel: string, added: boolean, reg = loadRegistry()): Hit | null {
  if (rel.startsWith('/')) return null;
  const scan = (entries: readonly Entry[], kind: Hit['kind']): Hit | null => {
    for (const e of entries)
      for (const g of e.globs)
        if (matchesGlob(rel, g)) {
          if (e.allowCreate === true && added) return null;
          return { file: rel, kind, id: e.id, why: e.why };
        }
    return null;
  };
  return scan(reg.redzone, 'redzone') ?? scan(reg.selfGuard, 'selfGuard');
}

// ---------------------------------------------------------------------------

function changedFiles(base: string): Array<{ file: string; added: boolean }> {
  // --name-status + -z:文件名含空格/中文/引号都不会被 shell 或 quotepath 破坏。
  // 本仓有中文文件名(docs/V2红线与复活路径.md),`core.quotepath=false` 不可省。
  const out = execFileSync(
    'git',
    ['-c', 'core.quotepath=false', 'diff', '--name-status', '-z', `${base}...HEAD`],
    { cwd: ROOT, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 },
  );
  const parts = out.split('\0').filter((s) => s !== '');
  const res: Array<{ file: string; added: boolean }> = [];
  for (let i = 0; i < parts.length; ) {
    const status = parts[i];
    // R(重命名)/C(复制)后面跟两个路径:旧、新。判新路径。
    if (status.startsWith('R') || status.startsWith('C')) {
      res.push({ file: parts[i + 2], added: false });
      i += 3;
    } else {
      res.push({ file: parts[i + 1], added: status.startsWith('A') });
      i += 2;
    }
  }
  return res;
}

function ghOutput(key: string, value: string): void {
  const f = process.env.GITHUB_OUTPUT;
  if (f) fs.appendFileSync(f, `${key}=${value}\n`);
}

function main(): void {
  const argv = process.argv.slice(2);
  let files: Array<{ file: string; added: boolean }>;

  const filesIdx = argv.indexOf('--files');
  if (filesIdx >= 0) {
    files = argv.slice(filesIdx + 1).map((f) => ({ file: f, added: false }));
  } else {
    const baseIdx = argv.indexOf('--base');
    const base = baseIdx >= 0 ? argv[baseIdx + 1] : 'origin/main';
    try {
      files = changedFiles(base);
    } catch (err) {
      // 拿不到 diff = 无法判断 → **fail-closed**。
      // 「无法验证」绝不能等于「通过」—— 这是 INC-07 的教训(门禁宣布未检查的通过)。
      console.error(`✗ 无法计算变更集(base=${base}):${String(err)}`);
      console.error('  拒绝在无法验证的情况下报告「未触碰红区」。');
      ghOutput('touched', 'error');
      process.exit(1);
    }
  }

  const reg = loadRegistry();
  const hits = files.map((f) => judge(f.file, f.added, reg)).filter((h): h is Hit => h !== null);

  if (hits.length === 0) {
    console.log(`✓ 本次变更 ${files.length} 个文件,未触碰红区或执法层`);
    ghOutput('touched', 'false');
    return;
  }

  const byKind = { redzone: hits.filter((h) => h.kind === 'redzone'), selfGuard: hits.filter((h) => h.kind === 'selfGuard') };
  console.log(`⚠️ 本次变更触碰受保护路径 ${hits.length} 处 —— 需要维护者在 PR 页面审批\n`);
  for (const [kind, label] of [
    ['redzone', '红区'],
    ['selfGuard', '执法层(裁判保护)'],
  ] as const) {
    const list = byKind[kind];
    if (list.length === 0) continue;
    console.log(`${label}:`);
    for (const h of list) {
      // why 在 redzone.json 里写得很长(那是给人读的完整理由),注解里截断 ——
      // 一屏塞不下的注解等于没有注解,人会直接略过
      const brief = h.why.length > 110 ? `${h.why.slice(0, 110)}…` : h.why;
      console.log(`  ${h.file}`);
      console.log(`    命中 ${h.id} — ${brief}`);
      // GitHub Actions 注解:直接标在 PR 的 Files changed 页上,不用翻日志
      console.log(`::warning file=${h.file}::受保护路径(${h.id}):${brief}`);
    }
  }
  ghOutput('touched', 'true');
  ghOutput('count', String(hits.length));
}

if (require.main === module) main();
