import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Harness 3.0 P2.5 — 事故回放(把「教训」变成「可重跑的证明」)。
//
// 仓库的教训一直只存在于 memory 与 PR 叙事里 —— 它们无法回答
// **「今天这个事故还会不会重演」**。本脚本对 harness/incidents.json 里
// 每条标 covered 的事故实际触发一次场景,断言守护确实拦下;
// 对每条反向案例(inverse)断言守护确实**不**拦。
//
// 为什么反向案例同等重要:P2b 实测三次误伤 —— 误伤到让人不得不绕过的程度,
// 防线就已经失效。只测「该拦时拦」会把守护越修越严,直到没人愿意用。
//
// 用途:
//   pnpm harness:replay            改 harness / 换模型 / 大重构前后各跑一次
//   pnpm harness:replay --coverage 只看覆盖率与缺口(不跑探针)
//
// 设计:探针只做**只读或自还原**的操作;任何会污染仓库的探针一律不写。

const ROOT = path.resolve(__dirname, '..');

interface Incident {
  readonly id: string;
  readonly title: string;
  /**
   * covered    = **真触发**:探针实际执行守护本体(跑 hook / 门禁命令 / lint)并断言其裁决
   * structural = **结构断言**:探针只查源码或配置里的字符串/结构,不执行守护
   * 两者强度差一个量级,所以分开计数(2026-07-29 跨模型评审 finding 7)。
   */
  readonly status: 'covered' | 'structural' | 'uncovered' | 'accepted';
  readonly guard: string | null;
  readonly probe?: string;
  readonly note?: string;
  readonly probeNote?: string;
}
interface Inverse {
  readonly id: string;
  readonly title: string;
  readonly why: string;
  readonly probe: string;
  readonly probeKind: 'live' | 'structural';
  readonly probeNote?: string;
}

const registry = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'harness/incidents.json'), 'utf-8'),
) as { incidents: Incident[]; inverse: Inverse[] };

let passed = 0;
const failures: string[] = [];
const skipped: string[] = [];

function record(ok: boolean, label: string, detail: string): void {
  if (ok) {
    passed++;
    console.log(`✓ ${label}`);
  } else {
    failures.push(`✗ ${label} — ${detail}`);
  }
}

function hookExit(script: string, input: unknown): number {
  try {
    execFileSync(path.join(ROOT, '.claude/hooks', script), {
      input: JSON.stringify(input),
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: ROOT,
    });
    return 0;
  } catch (err) {
    return (err as { status?: number }).status ?? -1;
  }
}

function fileHas(rel: string, needle: string): boolean {
  try {
    return fs.readFileSync(path.join(ROOT, rel), 'utf-8').includes(needle);
  } catch {
    return false;
  }
}

function gitPath(name: string): string {
  const p = execFileSync('git', ['rev-parse', '--git-path', name], {
    encoding: 'utf-8',
    cwd: ROOT,
  }).trim();
  return path.isAbsolute(p) ? p : path.join(ROOT, p);
}

/**
 * 在「开工门禁已过」的前提下跑一段探针,跑完恒还原。
 *
 * 为什么需要:P1-31 起 bash-write-guard 在查红区**之前**先查开工门禁(与 Edit 侧同口径)。
 * CI 里从来没有门禁标记 ⇒ 凡是调 bash-write-guard 的探针都会先被门禁截住,
 * 而那与它们真正要断言的**红区判定**是两件事。
 *
 * ⚠️ 两个方向都会坏,漏了哪个都不行:
 *   - 期望 exit 0 的反向用例 → 以「门禁未过」**假红**(INV-03 / INC-15 benign 实测中招);
 *   - 期望 exit 2 的攻击用例 → 被门禁**替红区满足**,变成**假绿**:
 *     哪怕把红区判定整个删掉它照样返回 2。INC-15 的攻击断言当时正处在这个状态。
 *
 * ⚠️ 本机跑 replay 时标记通常**存在**(开工门禁刚写过),所以这类缺口在本机
 *    看不见 —— 本条正是这么漏进 CI 的。helper 恒**覆盖**成有效标记,
 *    让本机与 CI 走同一条路径,而不是听任环境决定。
 */
function withPreflightPass<T>(fn: () => T): T {
  const marker = gitPath('srvf-preflight.json');
  const bak = `${marker}.replay-bak`;
  const had = fs.existsSync(marker);
  if (had) fs.renameSync(marker, bak);
  const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd: ROOT,
    encoding: 'utf-8',
  }).trim();
  // 按分支名判过期(见 preflight-required.sh),故 branch 必须是当前分支。
  fs.writeFileSync(marker, JSON.stringify({ status: 'pass', branch, head: 'replay' }));
  try {
    return fn();
  } finally {
    fs.rmSync(marker, { force: true });
    if (had) fs.renameSync(bak, marker);
  }
}

// ── 跨 worktree 拓扑夹具(2026-08-24)────────────────────────────────────────
// 被回放的缺陷:四个 hook 都从**脚本自身位置**反推仓根,而 hook 以
// `$CLAUDE_PROJECT_DIR/.claude/hooks/…` 注册、`CLAUDE_PROJECT_DIR` 恒指主仓 ⇒
// 在任何 worktree 里仓根都指向主仓,于是「归哪棵树管」全判错。
//
// ⚠️ 为什么非得**真造一棵** worktree:本文件的 hookExit 跑的是
// `<ROOT>/.claude/hooks/*.sh`,hook 反推出来的仓根**就等于 ROOT**。探针若只喂 ROOT 内的
// 路径,「仓根指的那棵树」与「目标所属的那棵树」永远重合,缺陷在结构上无从显形 ——
// 用例对**修复前的代码也会全绿**,那是空变异(改了被测代码而被测的量纹丝不动)。
// 必须让两者真的不是同一棵树,下面四条才有执行位。
//
// 造得起:`--no-checkout` 只落 `.git`、不 materialize 工作区文件(秒级)。
// hook 定位工作树的办法是「向上找第一个存在的祖先目录再问 git」,空目录一样定位得到。
let crossWt: { wt: string; dir: string } | null = null;
let alienRepo: string | null = null;
const pendingRestores: Array<() => void> = [];

function gitPathIn(repo: string, name: string): string {
  const p = execFileSync('git', ['rev-parse', '--git-path', name], {
    encoding: 'utf-8',
    cwd: repo,
  }).trim();
  return path.isAbsolute(p) ? p : path.join(repo, p);
}

function crossWorktree(): string {
  if (crossWt) return crossWt.wt;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'srvf-replay-wt-'));
  const wt = path.join(dir, 'wt');
  execFileSync('git', ['worktree', 'add', '--no-checkout', '--detach', wt, 'HEAD'], {
    cwd: ROOT,
    stdio: 'pipe',
  });
  crossWt = { wt, dir };
  return wt;
}

/** 造一棵**不属于本仓家族**的独立 git 仓 —— 用来钉「本仓 harness 不管别的仓」。 */
function alienGitRepo(): string {
  if (alienRepo) return alienRepo;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'srvf-replay-alien-'));
  execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'pipe' });
  alienRepo = dir;
  return dir;
}

function cleanupFixtures(): void {
  while (pendingRestores.length > 0) {
    const restore = pendingRestores.pop();
    try {
      restore?.();
    } catch {
      /* 尽力还原:一处失败不该拖垮其余 */
    }
  }
  if (crossWt) {
    const { wt, dir } = crossWt;
    crossWt = null;
    // 只删本进程刚在临时目录里造的那棵,**永不**碰别处的 worktree
    if (dir.startsWith(os.tmpdir()) && path.basename(dir).startsWith('srvf-replay-wt-')) {
      try {
        execFileSync('git', ['worktree', 'remove', '--force', wt], { cwd: ROOT, stdio: 'pipe' });
      } catch {
        /* 下面 rm + prune 兜底 */
      }
      fs.rmSync(dir, { recursive: true, force: true });
      try {
        execFileSync('git', ['worktree', 'prune'], { cwd: ROOT, stdio: 'pipe' });
      } catch {
        /* 已经干净 */
      }
    }
  }
  if (alienRepo) {
    const dir = alienRepo;
    alienRepo = null;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
process.on('exit', cleanupFixtures);
process.on('SIGINT', () => {
  cleanupFixtures();
  process.exit(130);
});

/**
 * 让跨 worktree 的用例**自己控制**两棵树的门禁标记与红区令牌,一律不继承本机环境。
 *
 * 仓内踩过(同 withPreflightPass 的教训):探针不隔离标记时,断言会被 preflight 顺手满足,
 * 于是「本地跑过了」变成无效证据 —— 哪怕把被测的判定整个删掉它照样绿。
 * 这里把**四个状态位**(两棵树的标记 + 两棵树的令牌)全部显式写死,跑完逐一还原;
 * 还原动作同时挂进 pendingRestores,半途被 SIGINT 打断也不会把令牌停在 .bak。
 */
function withTreeState<T>(
  wt: string,
  state: {
    readonly rootMarker: boolean;
    readonly wtMarker: boolean;
    readonly wtGrant: readonly string[] | null;
  },
  fn: () => T,
): T {
  const markerFor = (repo: string): string =>
    JSON.stringify({
      status: 'pass',
      branch: execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd: repo,
        encoding: 'utf-8',
      }).trim(),
      head: 'replay',
    });
  const grantFor = (globs: readonly string[]): string =>
    JSON.stringify({ grants: globs.map((glob) => ({ glob, reason: 'replay 探针', ts: '' })) });

  const bits: Array<[string, string | null]> = [
    [gitPath('srvf-preflight.json'), state.rootMarker ? markerFor(ROOT) : null],
    [gitPathIn(wt, 'srvf-preflight.json'), state.wtMarker ? markerFor(wt) : null],
    [gitPathIn(wt, 'srvf-redzone-grant.json'), state.wtGrant ? grantFor(state.wtGrant) : null],
    // ROOT 的令牌一并清空:维护者授权期间它是有内容的,不隔离的话红区用例会被
    // **本次授权**顺手放行 —— 又一次「断言被别的东西满足」。
    [gitPath('srvf-redzone-grant.json'), null],
  ];
  const saved = bits.map(([file]) => {
    const bak = `${file}.wt-replay-bak`;
    const had = fs.existsSync(file);
    if (had) fs.renameSync(file, bak);
    return { file, bak, had };
  });
  const restore = (): void => {
    for (const s of saved) {
      fs.rmSync(s.file, { force: true });
      if (s.had && fs.existsSync(s.bak)) fs.renameSync(s.bak, s.file);
    }
  };
  pendingRestores.push(restore);
  for (const [file, content] of bits) if (content !== null) fs.writeFileSync(file, content);
  try {
    return fn();
  } finally {
    restore();
    const i = pendingRestores.indexOf(restore);
    if (i >= 0) pendingRestores.splice(i, 1);
  }
}

const edit = (f: string) => ({ tool_name: 'Edit', tool_input: { file_path: f } });
const bash = (c: string) => ({ tool_name: 'Bash', tool_input: { command: c } });

// 探针注册表:每个返回 [是否通过, 说明]
// 全部只读或自还原 —— 回放不得污染仓库(否则没人敢在开发中途跑)。
const probes: Record<string, () => [boolean, string]> = {
  'near-future-date-lint': () => {
    // 真触发(自还原):写一个带近未来日期的临时 spec,跑仓库自己的 eslint 二进制,
    // 断言当场红且命中 srvf/no-near-future-date。日期用「回放当天 + 30 天」动态
    // 生成 —— 探针自己硬编码一个日期,就是在给 2090 年的同事埋下一颗新炸弹。
    const iso = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
    const rel = 'test/e2e/__replay-inc18-datebomb-probe.e2e-spec.ts';
    const abs = path.join(ROOT, rel);
    try {
      fs.writeFileSync(abs, `const d = new Date('${iso}T08:00:00.000Z');\nexport default d;\n`);
      const r = spawnSync(path.join(ROOT, 'node_modules/.bin/eslint'), ['--format', 'json', rel], {
        cwd: ROOT,
        encoding: 'utf-8',
      });
      const ok =
        r.status !== 0 &&
        typeof r.stdout === 'string' &&
        r.stdout.includes('srvf/no-near-future-date');
      return [ok, `近未来日期(${iso})的临时 spec 未被正式 lint 拦下(exit=${String(r.status)})`];
    } finally {
      fs.rmSync(abs, { force: true });
    }
  },
  'prisma-stale': () => {
    const src = fs.readFileSync(path.join(ROOT, '.claude/hooks/preflight-gate.sh'), 'utf-8');
    const ok = src.includes('GENERATED_SCHEMA') && src.includes('prisma:generate');
    return [ok, '门禁未检测 Prisma 生成物陈旧'];
  },
  'counts-drift': () => {
    try {
      execFileSync('pnpm', ['docs:counts:check'], { cwd: ROOT, stdio: 'pipe' });
      return [true, ''];
    } catch {
      return [false, 'docs:counts:check 当前为红(计数已漂移)'];
    }
  },
  'release-prepare-anchors': () => {
    // 发版链的两条不变量,都用静态判(回放要秒级,不能真跑一次发版):
    //   ① openapi 快照必须随版本刷新 —— 否则每次发版都撞自家 CI 的契约新鲜度门
    //   ② release-prepare 不得再依赖 current-state 里那行「版本 / Release」——
    //      P3 已把它删了(版本号属机器可查事实),依赖它的步骤会永久失败
    const raw = fs.readFileSync(path.join(ROOT, 'scripts/release-prepare.ts'), 'utf-8');
    // 先剥行注释再判 —— 否则「注释里解释这次删除」的那句话自己会被判成代码。
    // 今天第四次栽在同一处:描述文本 ≠ 代码位 / 命令位 / 配置位。
    const src = raw
      .split('\n')
      .filter((l) => !l.trim().startsWith('//'))
      .join('\n');
    if (!src.includes('generate-openapi.ts'))
      return [false, 'release-prepare 未刷新 openapi 快照 —— 每次发版都会被契约新鲜度门卡住'];
    if (src.includes('版本 \\/ Release') || src.includes('| 版本 / Release |'))
      return [false, 'release-prepare 仍在找 current-state 的「版本 / Release」行,而 P3 已删除该行'];
    // 反向:该脚本仍须读 current-state 取 counts footprint(删过头也是错)
    if (!src.includes('CURRENT_STATE'))
      return [false, 'release-prepare 不再读 current-state —— handoff 的 footprint 会失去真源'];
    return [true, ''];
  },
  'doc-pinned-by-spec': () => {
    // 真触发:按 spec 里的断言逐条核对被钉住的文档串还在不在。
    // 不跑 jest —— 这里要的是「秒级回放」,而断言集本身就是那份 spec 的内容;
    // spec 文件若被删,下面第一条就红(它也在 selfGuard 里,删不掉才是正常)。
    const spec = 'src/modules/notifications/notification-canonical-docs.spec.ts';
    if (!fs.existsSync(path.join(ROOT, spec))) return [false, `${spec} 不见了 —— 契约钉子被拔掉`];
    const pinned: Array<[string, string[]]> = [
      ['docs/current-state.md', ['Decision 15.1=B/15.2=B', '业务负责人最终确认:2026-07-27']],
      ['docs/ai-harness/NEXT_TASKS.md', ['Decision 15.1=B', 'Decision 15.2=B', 'Role.ADMIN']],
      ['src/modules/notifications/CLAUDE.md', ['Decision 15.1=B', 'Decision 15.2=B']],
    ];
    for (const [rel, needles] of pinned) {
      const abs = path.join(ROOT, rel);
      if (!fs.existsSync(abs)) return [false, `${rel} 不存在`];
      const body = fs.readFileSync(abs, 'utf-8');
      for (const n of needles)
        if (!body.includes(n)) return [false, `${rel} 缺少被 spec 钉住的串:${n}`];
    }
    return [true, ''];
  },
  'interpreter-bypass': () => {
    // 真触发:把「用 python heredoc 写红区 workflow」原样喂给 bash-write-guard。
    // 这条曾经返回 0(放行)—— 正文被剥离后命令位只剩 `python3 -`,不含写侧动词。
    // 同时验反向:只碰非红区文件的 heredoc 必须放行,否则日常编辑全废、
    // 人会去绕过守护(误伤到让人绕过的程度,防线同样失效)。
    const grantFile = gitPath('srvf-redzone-grant.json');
    const bak = `${grantFile}.replay-bak`;
    const had = fs.existsSync(grantFile);
    if (had) fs.renameSync(grantFile, bak);
    try {
      // ⭐ 攻击那条**也**要在门禁已过的前提下跑:门禁未过时它会被门禁拦成 exit 2,
      //    断言照样绿 —— 而那时红区判定有没有生效根本没被测到(假绿)。
      return withPreflightPass((): [boolean, string] => {
        const attack = hookExit(
          'bash-write-guard.sh',
          bash("python3 - <<'PY'\nopen('.github/workflows/ci.yml','w').write('x')\nPY"),
        );
        if (attack !== 2) return [false, `解释器写红区返回 exit ${attack},期望 2(旁路仍在)`];
        const benign = hookExit(
          'bash-write-guard.sh',
          bash("python3 - <<'PY'\nopen('CODEMAP.md').read()\nPY"),
        );
        if (benign !== 0)
          return [false, `只碰非红区的 heredoc 返回 exit ${benign},期望 0(规则过宽会逼人绕过)`];
        return [true, ''];
      });
    } finally {
      if (had) fs.renameSync(bak, grantFile);
    }
  },
  'db-name-collision': () => {
    const src = fs.readFileSync(path.join(ROOT, 'test/setup/worktree-db.ts'), 'utf-8');
    const ok = src.includes('MAX_PG_IDENTIFIER') && src.includes('assertDerivedName');
    return [ok, '派生库名缺 63 字符硬断言(超长会被静默截断 → 跨 worker 撞库)'];
  },
  'hook-exit-code': () => {
    // 真触发:红区写入必须 exit 2(exit 1 会被 Claude Code 当非阻断直接放行)
    const grantFile = gitPath('srvf-redzone-grant.json');
    const bak = `${grantFile}.replay-bak`;
    const had = fs.existsSync(grantFile);
    if (had) fs.renameSync(grantFile, bak);
    try {
      const code = hookExit('redzone-guard.sh', edit('AGENTS.md'));
      return [code === 2, `红区写入返回 exit ${code},期望 2`];
    } finally {
      if (had) fs.renameSync(bak, grantFile);
    }
  },
  'eslint-rules-live': () => {
    try {
      execFileSync('pnpm', ['exec', 'tsx', 'scripts/harness-eslint.selftest.ts'], {
        cwd: ROOT,
        stdio: 'pipe',
      });
      return [true, ''];
    } catch {
      return [false, 'eslint 阳性对照失败 —— 规则可能已静默失效'];
    }
  },
  'gate-fail-open': () => {
    const src = fs.readFileSync(path.join(ROOT, '.claude/hooks/preflight-gate.sh'), 'utf-8');
    const ok = src.includes('-f scripts/agent-preflight.sh') && src.includes('fail-closed');
    return [ok, '门禁未对「脚本不可用」做 fail-closed(会宣布未检查的通过)'];
  },
  'pglocks-db-scoped': () => {
    const dir = path.join(ROOT, 'test/e2e');
    const offenders: string[] = [];
    const scoped = /datname\s*=\s*current_database\(\)|lock\.database\s*=|pid\s*=\s*pg_backend_pid\(\)|pid\s*=\s*CAST\(/;
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.e2e-spec.ts'))) {
      const src = fs.readFileSync(path.join(dir, f), 'utf-8');
      for (const seg of src.split(/\$queryRaw|Prisma\.sql/).slice(1)) {
        const block = seg.slice(0, 700);
        if (/FROM\s+pg_(locks|stat_activity)/i.test(block) && !scoped.test(block)) offenders.push(f);
      }
    }
    return [offenders.length === 0, `未按库收敛的观测点:${[...new Set(offenders)].join(', ')}`];
  },
  'ci-gate-fail-open': () => {
    const ci = fs.readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf-8');
    const ok = ci.includes('needs.changeset.result') && ci.includes('docs_only }}" != "true"');
    return [ok, 'CI gate 未正面证明 docs_only(skipped 会被当通过)'];
  },
  'semver-sort': () => [fileHas('scripts/release-prepare.ts', 'semverKey'), 'handoff 上一版仍按字符串排序'],
  'judge-protected': () => {
    const rz = JSON.parse(fs.readFileSync(path.join(ROOT, 'harness/redzone.json'), 'utf-8')) as {
      selfGuard: Array<{ globs: string[] }>;
    };
    const globs = rz.selfGuard.flatMap((e) => e.globs);
    const ok = globs.includes('scripts/harness-grant.ts') && globs.includes('.claude/hooks/**');
    return [ok, '授权工具或 hook 自身不在裁判保护内'];
  },
  'behind-main-blocks': () => {
    const src = fs.readFileSync(path.join(ROOT, '.claude/hooks/preflight-gate.sh'), 'utf-8');
    const ok = src.includes('BEHIND_LINE') && src.includes('BLOCKING_REASON');
    return [ok, '「落后 origin/main」未被列为拦写的硬条件'];
  },

  'worktree-redzone-enforced': () => {
    // ① worktree 内的**红区**文件、无授权 → 必须拦。
    //
    // 修复前实测(2026-08-24):`REL="${FILE#$REPO_ROOT/}"` 剥不掉主仓前缀 ⇒ REL 仍是绝对路径
    // ⇒ 命中「仓库外文件不归红区管」而 exit 0 —— **红区在每一棵 worktree 里整片失效**,
    // 无授权也能改 prisma/schema.prisma 与 AGENTS.md。这是四面里唯一的纯安全敞口。
    // (CI 侧的 redzone-trusted 扫描与环境审批是独立的、一直有效;塌的是本地这层纵深防御。)
    const wt = crossWorktree();
    return withTreeState(wt, { rootMarker: true, wtMarker: true, wtGrant: null }, () => {
      // 两棵树都装上有效标记:redzone-guard 目前不查门禁标记,装上是为了让本条
      // 在「万一将来把门禁串进红区链路」之后**仍然只测红区**,不被门禁顺手满足。
      const schema = hookExit('redzone-guard.sh', edit(path.join(wt, 'prisma/schema.prisma')));
      if (schema !== 2)
        return [false, `worktree 内 prisma/schema.prisma(绝对路径、无授权)返回 exit ${schema},期望 2`];
      const doc = hookExit('redzone-guard.sh', edit(path.join(wt, 'AGENTS.md')));
      if (doc !== 2) return [false, `worktree 内 AGENTS.md(绝对路径、无授权)返回 exit ${doc},期望 2`];
      // 阳性对照:上面两个 2 必须来自**红区命中**,不能来自「一律 fail-closed」。
      // 少了这一条,把判定改成 `exit 2` 恒拒也能让本探针全绿。
      const normal = hookExit(
        'redzone-guard.sh',
        edit(path.join(wt, 'src/modules/users/users.service.ts')),
      );
      if (normal !== 0)
        return [false, `worktree 内普通业务文件返回 exit ${normal},期望 0 —— 上面的拦截是无差别 fail-closed,不是红区判定`];
      return [true, ''];
    });
  },
  'worktree-grant-consumed': () => {
    // ④(第四面)worktree 的红区**授权令牌**必须被消费。
    // `harness:grant` 把令牌写进该 worktree 自己的 git 目录
    // ($(git rev-parse --git-path srvf-redzone-grant.json)),而修复前 guard 拿 REPO_ROOT 去找,
    // 找的是主仓那个根本不存在的令牌 ⇒ 维护者发下来的授权全程不被消费。
    const wt = crossWorktree();
    return withTreeState(
      wt,
      { rootMarker: true, wtMarker: true, wtGrant: ['prisma/schema.prisma'] },
      () => {
        const granted = hookExit('redzone-guard.sh', edit(path.join(wt, 'prisma/schema.prisma')));
        if (granted !== 0)
          return [false, `该 worktree 持有对应令牌却仍返回 exit ${granted},期望 0 —— 授权没被消费`];
        // 令牌不得越权:只授了 schema,AGENTS.md 必须照拦。
        const other = hookExit('redzone-guard.sh', edit(path.join(wt, 'AGENTS.md')));
        if (other !== 2)
          return [false, `令牌只覆盖 prisma/schema.prisma,AGENTS.md 却返回 exit ${other},期望 2`];
        return [true, ''];
      },
    );
  },
  'worktree-preflight-per-tree': () => {
    // ③ worktree 内文件、**该 worktree 的** preflight 未过 → 必须拦,且不许拿别的树顶替。
    //
    // ⭐ 靶心在 rootMarker=true:ROOT 那棵树**有**有效标记而目标那棵没有。
    // 修复前绝对路径直接 exit 0(fail-open);若有人改成「按 REPO_ROOT 查标记」,
    // 就会被 ROOT 的标记顶替而放行 —— 两种错法本条都拦得住。
    const wt = crossWorktree();
    return withTreeState(wt, { rootMarker: true, wtMarker: false, wtGrant: null }, () => {
      const code = hookExit('preflight-required.sh', edit(path.join(wt, 'docs/x.md')));
      if (code !== 2)
        return [false, `目标 worktree 门禁未过却返回 exit ${code},期望 2(ROOT 那棵树有标记,但它不该顶替)`];
      return [true, ''];
    });
  },

  // ── 反向案例:守护必须**不**拦 ──────────────────────────────────────────
  'worktree-pass-allows-write': () => {
    // ② worktree 内的**非红区**文件、**该 worktree 的** preflight 已过 → 必须放行。
    //
    // ⭐ 靶心在 rootMarker=false:ROOT 那棵树**没有**标记而目标那棵有。
    // 这是缺陷的 fail-closed 那一半(2026-08-24 实证:一条 lane 在自己 worktree 里
    // 门禁明明过了,却因为主仓没标记而完全写不进任何文件)。
    const wt = crossWorktree();
    return withTreeState(wt, { rootMarker: false, wtMarker: true, wtGrant: null }, () => {
      const gate = hookExit('preflight-required.sh', edit(path.join(wt, 'docs/x.md')));
      if (gate !== 0)
        return [false, `目标 worktree 门禁已过却返回 exit ${gate},期望 0(ROOT 那棵树没标记,但它不该拖累)`];
      const rz = hookExit(
        'redzone-guard.sh',
        edit(path.join(wt, 'src/modules/users/users.service.ts')),
      );
      if (rz !== 0) return [false, `worktree 内普通业务文件被红区误拦(exit ${rz})`];
      return [true, ''];
    });
  },
  'outside-repo-family-allowed': () => {
    // ④(情形四)**仓外**绝对路径 —— 定义为**放行**,理由三条:
    //   ⑴ 门禁语义是「本仓状态不干净时别改**本仓**代码」,与仓外文件无关(INV-04 已钉);
    //   ⑵ 红区语义同理 —— 本仓的红区清单管不着别的仓的文件;
    //   ⑶ 拦它们是纯误伤,而误伤会训练出「无视守护」的习惯,比漏放更能摧毁防线。
    // 「仓外」的判据是 git-common-dir:主仓与它的每一棵 worktree 相同,别的仓 / 非仓则不同。
    // ⚠️ 因此「别的 git 仓」也必须放行 —— 若有人把修法写成「只要 git 认得就算仓内」,
    //    本条立刻转红。
    const outside = path.join(os.tmpdir(), 'srvf-replay-outside', 'AGENTS.md');
    const alien = path.join(alienGitRepo(), 'AGENTS.md');
    const wt = crossWorktree();
    return withTreeState(wt, { rootMarker: false, wtMarker: false, wtGrant: null }, () => {
      // 两棵树的标记全部清掉:确保「放行」只可能来自「判成仓外」,不可能来自任何标记。
      const cases: Array<[string, string, string]> = [
        ['preflight-required.sh', outside, '仓外(非 git 仓)路径 · 门禁'],
        ['redzone-guard.sh', outside, '仓外(非 git 仓)路径 · 红区'],
        ['preflight-required.sh', alien, '别的 git 仓里的文件 · 门禁'],
        ['redzone-guard.sh', alien, '别的 git 仓里的文件 · 红区'],
      ];
      for (const [hook, file, label] of cases) {
        const code = hookExit(hook, edit(file));
        if (code !== 0) return [false, `${label} 被误拦(exit ${code}),期望 0`];
      }
      return [true, ''];
    });
  },
  'dirty-tree-allows-write': () => {
    const src = fs.readFileSync(path.join(ROOT, '.claude/hooks/preflight-gate.sh'), 'utf-8');
    const ok = src.includes('ADVISORY') && src.includes('不应开新功能');
    return [ok, '工作树脏 / open PR 未降级为咨询 → 连续开发会卡死'];
  },
  'descriptive-text-allowed': () => {
    const code = hookExit('bash-write-guard.sh', bash('git commit -m "docs: 禁止 sed -i 绕过红区"'));
    return [code === 0, `提交信息里描述写侧命令被误拦(exit ${code})`];
  },
  'read-from-protected-allowed': () => {
    // 目标 `tmp/x.sh` 是**仓内**相对路径 ⇒ 门禁未过时被拦是语义正确的(它确实在写本仓)。
    // 本探针要测的是「源是受保护路径不构成拦截理由」,故须在门禁已过的前提下判。
    const code = withPreflightPass(() =>
      hookExit('bash-write-guard.sh', bash('cp .claude/hooks/redzone-guard.sh tmp/x.sh')),
    );
    return [code === 0, `从受保护路径读出被误拦(exit ${code})`];
  },
  'outside-repo-allowed': () => {
    const marker = gitPath('srvf-preflight.json');
    const bak = `${marker}.replay-bak`;
    const had = fs.existsSync(marker);
    if (had) fs.renameSync(marker, bak);
    try {
      const code = hookExit('preflight-required.sh', edit('/tmp/outside-repo-file.md'));
      return [code === 0, `仓库外文件被本仓门禁误拦(exit ${code})`];
    } finally {
      if (had) fs.renameSync(bak, marker);
    }
  },
  'normal-paths-allowed': () => {
    const codes = [
      hookExit('redzone-guard.sh', edit('src/modules/users/users.service.ts')),
      hookExit('redzone-guard.sh', edit('test/e2e/users.e2e-spec.ts')),
      hookExit('redzone-guard.sh', edit('docs/testing.md')),
    ];
    return [codes.every((c) => c === 0), `日常路径被红区误拦:exit ${codes.join(',')}`];
  },
  'justified-exemption-allowed': () => {
    const n = execFileSync('bash', ['-c', "grep -rc 'eslint-disable-next-line no-restricted-syntax' src | grep -v ':0' | wc -l"], {
      cwd: ROOT,
      encoding: 'utf-8',
    }).trim();
    return [Number(n) > 0, '无任何带原因的豁免样例 —— 若规则不给豁免通道,人会整体关掉它'];
  },
};

/** 跑一组探针,返回该组的 (通过数, 总数)。 */
function runGroup(
  label: string,
  items: ReadonlyArray<{ id: string; title: string; probe?: string }>,
): [number, number] {
  console.log(label);
  const before = passed;
  let total = 0;
  for (const it of items) {
    if (!it.probe) {
      skipped.push(`${it.id} 已登记但无 probe`);
      continue;
    }
    const probe = probes[it.probe];
    if (!probe) {
      failures.push(`✗ ${it.id} — 探针 '${it.probe}' 未实现(登记簿与脚本脱节)`);
      total++;
      continue;
    }
    total++;
    const [ok, detail] = probe();
    record(ok, `${it.id} ${it.title.slice(0, 46)}`, detail);
  }
  return [passed - before, total];
}

function main(): void {
  const coverageOnly = process.argv.includes('--coverage');

  const live = registry.incidents.filter((i) => i.status === 'covered');
  const structural = registry.incidents.filter((i) => i.status === 'structural');
  const uncovered = registry.incidents.filter((i) => i.status === 'uncovered');
  const accepted = registry.incidents.filter((i) => i.status === 'accepted');
  const invLive = registry.inverse.filter((i) => i.probeKind === 'live');
  const invStructural = registry.inverse.filter((i) => i.probeKind === 'structural');

  console.log(
    `事故登记簿:${registry.incidents.length} 条 ` +
      `(真触发 ${live.length} / 结构断言 ${structural.length} / ` +
      `uncovered ${uncovered.length} / accepted ${accepted.length})\n` +
      `反向案例:${registry.inverse.length} 条(真触发 ${invLive.length} / 结构断言 ${invStructural.length})\n`,
  );

  if (coverageOnly) {
    for (const i of [...uncovered, ...accepted]) {
      console.log(`[${i.status.toUpperCase()}] ${i.id} ${i.title}`);
      if (i.note) console.log(`         ${i.note}`);
    }
    console.log('\n── 结构断言(只查源码字符串,不执行守护)──');
    for (const i of [...structural, ...invStructural])
      console.log(`[STRUCTURAL] ${i.id} ${i.title}`);
    console.log('\n(--coverage 只列缺口与弱探针,不跑探针)');
    return;
  }

  // ── 第一组:真触发。探针实际跑守护本体并断言裁决 ──
  const [liveOk, liveTotal] = runGroup(
    '── ① 真触发:实际执行守护并断言其裁决 ──',
    [...live, ...invLive],
  );

  // ── 第二组:结构断言。只查源码/配置,发现不了「代码还在但不起作用」──
  const [structOk, structTotal] = runGroup(
    '\n── ② 结构断言:只查源码/配置字符串,**不执行守护** ──',
    [...structural, ...invStructural],
  );

  if (uncovered.length > 0 || accepted.length > 0) {
    console.log('\n── 已知缺口(不假装安全)──');
    for (const i of [...uncovered, ...accepted]) console.log(`  [${i.status}] ${i.id} ${i.title}`);
  }

  for (const s of skipped) console.log(`\n⚠️  ${s}`);
  for (const f of failures) console.error(f);

  // 分组计数,**不再给一个统称的总数**(2026-07-29 跨模型评审 finding 7):
  // 此前统称「事故回放 20/20」,而其中只有 8 条真的触发了守护 ——
  // 一个漂亮的总数把强度差异抹平了,而强度差异恰恰是读者最需要知道的事。
  console.log(
    `\n真触发 ${liveOk}/${liveTotal} 通过 · 结构断言 ${structOk}/${structTotal} 通过 · ` +
      `失败 ${failures.length}`,
  );
  console.log(
    '注:结构断言只能发现「那行代码被删了」,发现不了「那行代码不再起作用」——' +
      '\n    别把两组加起来当成同一种保证。',
  );
  if (failures.length > 0) {
    console.error(
      '\n⚠️ 历史事故的守护已失效,或守护开始误伤。两者都意味着防线不可信 ——' +
        '\n   前者会让事故重演,后者会让人绕过防线。改 harness 后请对比本命令的前后输出。',
    );
    process.exit(1);
  }
}

main();
