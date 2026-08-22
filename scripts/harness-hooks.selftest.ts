import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

// Harness 3.0 P2b — hooks 的**行为**自测(不只是「文件存在 + 已接线」)。
//
// 为什么单独一份:harness-guards.selftest 断言的是「装没装」,本文件断言的是「拦不拦得住」。
// 两者都需要 —— 装了但逻辑写错(比如用 exit 1 而不是 exit 2)同样是静默失效:
// Claude Code 把 exit 1 当**非阻断**错误直接放行,而人看日志会以为拦住了。
//
// 每条用例喂一段真实的 hook stdin JSON,断言退出码:
//   2 = 阻断(唯一有效的拒绝方式) / 0 = 放行
//
// 运行:pnpm exec tsx scripts/harness-hooks.selftest.ts(已并入 pnpm harness:selftest)

const repoRoot = path.resolve(__dirname, '..');
const hooksDir = path.join(repoRoot, '.claude/hooks');

let passed = 0;
const failures: string[] = [];

function runHook(script: string, input: unknown): number {
  try {
    execFileSync(path.join(hooksDir, script), {
      input: JSON.stringify(input),
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: repoRoot,
    });
    return 0;
  } catch (err) {
    return (err as { status?: number }).status ?? -1;
  }
}

function expectExit(name: string, script: string, input: unknown, want: 0 | 2): void {
  const got = runHook(script, input);
  if (got === want) {
    passed++;
    console.log(`✓ ${name}`);
  } else {
    failures.push(
      `✗ ${name} — 期望 exit ${want},实际 ${got}` +
        (got === 1 ? '(⚠️ exit 1 是非阻断的,Claude Code 会直接放行!)' : ''),
    );
  }
}

const edit = (file: string) => ({ tool_name: 'Edit', tool_input: { file_path: file } });
const bash = (command: string) => ({ tool_name: 'Bash', tool_input: { command } });

function gitPath(name: string): string {
  const p = execFileSync('git', ['rev-parse', '--git-path', name], {
    encoding: 'utf-8',
    cwd: repoRoot,
  }).trim();
  return path.isAbsolute(p) ? p : path.join(repoRoot, p);
}

// 自测必须测「基线执法强度」,与当前 worktree 是否恰好持有 token / marker 无关。
// 否则维护者授权期间会出现「拦不住」的假失败；反过来，陈旧的 preflight marker
// 又会让放行路径被前一次会话污染。两者均在本次自测开始时隔离，退出时原样恢复。
function isolateHookState(file: string, label: string): () => void {
  const backup = `${file}.hooks-selftest-bak`;
  if (fs.existsSync(backup)) {
    throw new Error(`hook selftest ${label} 备份残留：${backup}；拒绝覆盖未知状态`);
  }
  const existed = fs.existsSync(file);
  if (existed) fs.renameSync(file, backup);
  return () => {
    fs.rmSync(file, { force: true });
    if (existed && fs.existsSync(backup)) fs.renameSync(backup, file);
  };
}

// 四个 preflight-gate 对照替换的是 agent-preflight 的输出，故必须同时固定
// preflight 自己的环境前提。fresh checkout 的 prisma/schema.prisma mtime 会天然
// 晚于复用的 node_modules，若不隔离该条件，gate 会在调用 fake preflight 前就退出，
// 造成「本地四红、CI 四绿」的环境耦合假象。这里只暂时提升生成物时间戳，finally
// 恢复原值；不写 schema、不运行 generate，也不改变实际 gate 行为。
function stabilizePreflightFixtureEnvironment(): () => void {
  const pnpmRoot = path.join(repoRoot, 'node_modules/.pnpm');
  const generatedSchema = fs
    .readdirSync(pnpmRoot)
    .sort()
    .map((entry) => path.join(pnpmRoot, entry, 'node_modules/.prisma/client/schema.prisma'))
    .find((candidate) => fs.existsSync(candidate));
  if (!generatedSchema) {
    throw new Error(
      'hook selftest 前提不满足：缺少已生成 Prisma client；先跑 pnpm prisma:generate。',
    );
  }
  const sourceStat = fs.statSync(path.join(repoRoot, 'prisma/schema.prisma'));
  const generatedStat = fs.statSync(generatedSchema);
  if (generatedStat.mtimeMs >= sourceStat.mtimeMs) return () => undefined;

  fs.utimesSync(
    generatedSchema,
    new Date(generatedStat.atimeMs),
    new Date(sourceStat.mtimeMs + 1_000),
  );
  return () => {
    fs.utimesSync(
      generatedSchema,
      new Date(generatedStat.atimeMs),
      new Date(generatedStat.mtimeMs),
    );
  };
}

const restoreHookSelftestState: Array<() => void> = [];
try {
  restoreHookSelftestState.push(
    isolateHookState(gitPath('srvf-redzone-grant.json'), 'red-zone token'),
    isolateHookState(gitPath('srvf-preflight.json'), 'preflight marker'),
    stabilizePreflightFixtureEnvironment(),
  );
} catch (error) {
  for (const restore of restoreHookSelftestState.reverse()) restore();
  throw error;
}
let hookSelftestRestored = false;
function restoreHookSelftestEnvironment(): void {
  if (hookSelftestRestored) return;
  hookSelftestRestored = true;
  for (const restore of [...restoreHookSelftestState].reverse()) restore();
}
process.on('exit', restoreHookSelftestEnvironment);
process.on('SIGINT', () => {
  restoreHookSelftestEnvironment();
  process.exit(130);
});

console.log('ℹ hook selftest 环境：已隔离 red-zone token / preflight marker，并固定 Prisma 生成物前提。');

// ---- redzone-guard:红区与裁判保护 ----
expectExit('redzone:AGENTS.md 拒绝', 'redzone-guard.sh', edit('AGENTS.md'), 2);
expectExit('redzone:.claude/CLAUDE.md 拒绝(第二份 CLAUDE)', 'redzone-guard.sh', edit('.claude/CLAUDE.md'), 2);
expectExit('redzone:prisma/schema.prisma 拒绝', 'redzone-guard.sh', edit('prisma/schema.prisma'), 2);
expectExit('redzone:migrations 目录内文件拒绝', 'redzone-guard.sh', edit('prisma/migrations/20260101_x/migration.sql'), 2);
expectExit('redzone:workflows 拒绝', 'redzone-guard.sh', edit('.github/workflows/ci.yml'), 2);
expectExit('redzone:auth 模块拒绝', 'redzone-guard.sh', edit('src/modules/auth/auth.service.ts'), 2);
expectExit('redzone:全局 interceptor 拒绝', 'redzone-guard.sh', edit('src/common/interceptors/response.interceptor.ts'), 2);
expectExit('redzone:bootstrap 拒绝(全局 Pipe 真身)', 'redzone-guard.sh', edit('src/bootstrap/apply-global-setup.ts'), 2);
expectExit('selfGuard:守卫脚本拒绝', 'redzone-guard.sh', edit('scripts/check-codemap.ts'), 2);
expectExit('selfGuard:test/setup 拒绝(e2e 地基)', 'redzone-guard.sh', edit('test/setup/reset-db.ts'), 2);
expectExit('selfGuard:contract 快照拒绝(考卷本体)', 'redzone-guard.sh', edit('test/contract/openapi.contract-spec.ts'), 2);
expectExit('selfGuard:hook 自身拒绝', 'redzone-guard.sh', edit('.claude/hooks/redzone-guard.sh'), 2);
expectExit('selfGuard:红区清单自身拒绝', 'redzone-guard.sh', edit('harness/redzone.json'), 2);
expectExit('selfGuard:lint 执法块拒绝', 'redzone-guard.sh', edit('eslint.harness.mjs'), 2);

// 放行面:普通业务代码与普通测试不受影响(误杀会训练出「无视门禁」的习惯)
expectExit('放行:业务 service', 'redzone-guard.sh', edit('src/modules/users/users.service.ts'), 0);
expectExit('放行:普通 e2e', 'redzone-guard.sh', edit('test/e2e/users.e2e-spec.ts'), 0);
expectExit('放行:普通文档', 'redzone-guard.sh', edit('docs/testing.md'), 0);
expectExit('放行:CHANGELOG(行级语义交 CI 判)', 'redzone-guard.sh', edit('CHANGELOG.md'), 0);

// archive:允许新增,禁改既有
expectExit('archive:新增文件放行', 'redzone-guard.sh', edit('docs/archive/plans/brand-new-plan.md'), 0);
{
  const existing = 'docs/archive/plans/harness-3.0-blueprint.md';
  if (fs.existsSync(path.join(repoRoot, existing))) {
    expectExit('archive:改既有文件拒绝', 'redzone-guard.sh', edit(existing), 2);
  }
}

// ---- bash-write-guard:写侧旁路 ----
//
// ⚠️ **本批用例必须在「开工门禁已过」的前提下跑**(2026-08-22,P1-31 收口后新增)。
// 收口内容:`bash-write-guard.sh` 在判出写侧后会先校验开工门禁通行标记 ——
// 而本自测的环境**刻意隔离掉了 marker**(见文件头 isolateHookState)。
// 不装回一份有效 marker 的话,本批**每一条**写侧用例都会以「门禁未过」被拦,
// 期望 exit 0 的反向/误伤回归用例会集体假红(实测 7 条),
// 而那与它们真正要测的**红区判定**毫无关系。
//
// ⇒ 本批的语义是「假设门禁已过,红区判定是否正确」;门禁本身的判定由
//    下方 `bash:开工门禁半边` 那一组单独覆盖。
{
  const bashCaseMarker = gitPath('srvf-preflight.json');
  const bashCaseBranch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd: repoRoot,
    encoding: 'utf-8',
  }).trim();
  fs.writeFileSync(
    bashCaseMarker,
    JSON.stringify({ status: 'pass', branch: bashCaseBranch, head: 'selftest' }),
  );
}

expectExit('bash:sed -i 改红区拒绝', 'bash-write-guard.sh', bash("sed -i '' 's/x/y/' AGENTS.md"), 2);
expectExit('bash:重定向写红区拒绝', 'bash-write-guard.sh', bash('echo x > AGENTS.md'), 2);
expectExit('bash:cp 覆盖守卫脚本拒绝', 'bash-write-guard.sh', bash('cp /tmp/e.ts scripts/check-codemap.ts'), 2);
expectExit('bash:解析不出路径的写命令拒绝(fail-closed)', 'bash-write-guard.sh', bash('cat $A | tee $B'), 2);
expectExit('bash:mv 覆盖 hook(目标受保护)拒绝', 'bash-write-guard.sh', bash('mv /tmp/x.sh .claude/hooks/redzone-guard.sh'), 2);

// ---- 误伤回归(施工时真实踩到,必须锁死;误伤比漏放更能摧毁守护可信度)----
// ① 命令里**描述**写侧动词的文本(commit message / heredoc 正文)不是要执行它
expectExit(
  'bash:误伤回归 — commit -m 引号内提到 sed -i 放行',
  'bash-write-guard.sh',
  bash('git commit -m "docs: 禁止 sed -i 与 > 重定向绕过红区"'),
  0,
);
expectExit(
  'bash:误伤回归 — heredoc 正文提到 cp 受保护路径 放行',
  'bash-write-guard.sh',
  bash('git commit -F - <<EOF\n说明:禁止 cp 覆盖 scripts/check-codemap.ts\nEOF'),
  0,
);
// ② cp / mv 只判目标:从受保护路径**读出**是无害的
expectExit(
  'bash:误伤回归 — cp 从受保护路径读出到 tmp 放行',
  'bash-write-guard.sh',
  bash('cp .claude/hooks/redzone-guard.sh tmp/backup.sh'),
  0,
);

// ---- 漏放回归:解释器旁路(2026-07-29,作者在 P4d 施工中自己走过去了)----
// 剥 heredoc / 引号是为了治误伤,但它同时让「把代码喂给解释器」这条路完全不受检:
// 正文被剥掉后命令位只剩 `python3 -`,不含任何写侧动词 → 放行。
// 当晚作者就用 python heredoc 写进了未授权的红区 workflow,hook 全程沉默 ——
// 正门(sed -i)拦得好好的,后门一直开着。这是**已发生**的绕过,不是假想。
expectExit(
  'bash:漏放回归 — python heredoc 写红区 workflow 拒绝',
  'bash-write-guard.sh',
  bash("python3 - <<'PY'\nopen('.github/workflows/ci.yml','w').write('x')\nPY"),
  2,
);
expectExit(
  'bash:漏放回归 — node -e 内联写红区文档 拒绝',
  'bash-write-guard.sh',
  bash('node -e "require(\'fs\').writeFileSync(\'AGENTS.md\',\'x\')"'),
  2,
);
expectExit(
  'bash:漏放回归 — python heredoc 触碰裁判脚本 拒绝',
  'bash-write-guard.sh',
  bash("python3 - <<'PY'\nopen('scripts/check-codemap.ts','w').write('exit(0)')\nPY"),
  2,
);
// 反向:解释器规则必须只咬红区,否则日常 heredoc 编辑全废 —— 那种误伤会直接
// 逼人绕过守护,后果比漏放更糟。
expectExit(
  'bash:反向 — heredoc 只碰非红区文件 放行',
  'bash-write-guard.sh',
  bash("python3 - <<'PY'\nopen('CODEMAP.md').read()\nPY"),
  0,
);
expectExit(
  'bash:反向 — 跑磁盘上的脚本(非内联代码)放行',
  'bash-write-guard.sh',
  bash('npx tsx scripts/generate-codemap.ts --check'),
  0,
);
expectExit(
  'bash:反向 — 内联代码不含任何路径 放行',
  'bash-write-guard.sh',
  bash('node -e "console.log(1+1)"'),
  0,
);
// 修这条漏放时**当场又踩出一次误伤**:commit message 正文里提到 "ts-node" / "node -e"
// 且用 heredoc 传入,整条命令被判成在跑解释器。判定必须限定在命令位且解释器与
// `<<` 同行 —— 「描述文本 ≠ 命令位」这一课在本守护里已经学了三次,锁死。
expectExit(
  'bash:误伤回归 — commit heredoc 正文提到 node -e / ts-node 放行',
  'bash-write-guard.sh',
  bash(
    'git commit -F - <<MSG\n用 ts-node 而非 tsx:esbuild 不支持 emitDecoratorMetadata\n' +
      '`node -e` 内联写 AGENTS.md 已被拦下\nMSG',
  ),
  0,
);

// ---- 误伤回归:解释器规则的扫描范围(2026-07-29 实测 5 次,逐条固化)----
// 首版在检测到解释器后扫**整条命令原文**找红区路径,于是「命令里提到路径」= 被拦。
// 5 次全发生在真实工作里,每次都逼人换个写法绕开 —— **那正是守护失效的前兆**:
// 人一旦养成绕路的习惯,真该拦的那次也会被绕过去。
// 收窄为「只扫解释器的代码区」(heredoc 正文 + 解释器行本身)后,下面这些必须放行。
expectExit(
  'bash:误伤回归 — 同命令内 python heredoc + commit 信息提到红区路径 放行',
  'bash-write-guard.sh',
  bash(
    "python3 - <<'PY'\nopen('CHANGELOG.md','a').write('x')\nPY\n" +
      'git commit -F - <<MSG\n改了 .github/workflows/ci.yml 的 docs 守护行\nMSG',
  ),
  0,
);
expectExit(
  'bash:误伤回归 — 只读 find 命令里出现裸受保护文件名 放行',
  'bash-write-guard.sh',
  bash('find src prisma -name CLAUDE.md -exec wc -c {} +'),
  0,
);
expectExit(
  'bash:误伤回归 — 跑守卫脚本(命令里含其路径)+ 无关内联代码 放行',
  'bash-write-guard.sh',
  bash('pnpm harness:replay && node -e "console.log(1)"'),
  0,
);
expectExit(
  'bash:误伤回归 — 读受保护文件与内联代码分处不同子命令 放行',
  'bash-write-guard.sh',
  bash('cat .claude/hooks/redzone-guard.sh | head -5; node -e "console.log(2)"'),
  0,
);
// 边界:收窄**不得**让「解释器行本身含内联代码」漏掉 —— 那一行就是代码区
expectExit(
  'bash:边界 — 解释器行内联代码含红区路径 仍拦',
  'bash-write-guard.sh',
  bash('ls -la; node -e "require(\'fs\').writeFileSync(\'AGENTS.md\',\'x\')"; echo done'),
  2,
);
// 边界:heredoc 正文里的写入必须仍被拦,即使同命令另有大量无关文本
expectExit(
  'bash:边界 — heredoc 正文写红区,前后有无关命令 仍拦',
  'bash-write-guard.sh',
  bash(
    'echo start\npython3 - <<PY\nopen("prisma/schema.prisma","w").write("x")\nPY\necho end',
  ),
  2,
);

expectExit('bash:git status 放行', 'bash-write-guard.sh', bash('git status --short'), 0);
expectExit('bash:pnpm lint 放行', 'bash-write-guard.sh', bash('pnpm lint'), 0);
expectExit('bash:写普通业务文件放行', 'bash-write-guard.sh', bash("sed -i '' 's/a/b/' src/modules/users/users.service.ts"), 0);
expectExit('bash:重定向 /dev/null 放行', 'bash-write-guard.sh', bash('pnpm test > /dev/null 2>&1'), 0);

// ---- bash:开工门禁半边(P1-31 收口,2026-08-22)----
//
// 缺陷:`preflight-required.sh` 只挂在 `Edit|Write|MultiEdit|NotebookEdit` 上,
// Bash 侧**从不校验开工门禁通行标记** ⇒ 一条 `python3 <<'PY' … PY` 写文件
// 完全绕过「依赖/生成物陈旧、落后 origin/main、中途换分支」这些前提。
// **同一个写操作走 Edit 被拦、走 Bash 放行** —— 判定不一致本身就是缺陷,
// 而 bypass 模式恰恰要求优先用 Bash,所以这条旁路是**默认路径**不是边角。
//
// ⭐ 下面第三组是**靶心**:只证明「Bash 侧会拦了」不够 —— 拦过头(连只读都拦)
// 与拦不够都是错的,要证明它与 Edit 侧**同口径**。
{
  const marker = gitPath('srvf-preflight.json');
  const backup = `${marker}.p131-bak`;
  const had = fs.existsSync(marker);
  if (had) fs.renameSync(marker, backup);
  const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd: repoRoot,
    encoding: 'utf-8',
  }).trim();
  const writeMarker = (): void => {
    fs.writeFileSync(marker, JSON.stringify({ status: 'pass', branch, head: 'selftest' }));
  };
  try {
    // ① 正:门禁未过 + 各类写侧 Bash 命令 → 必须拦
    fs.rmSync(marker, { force: true });
    expectExit(
      'bash 门禁:未过时 python heredoc 写**仓内**文件被拦(这条旁路正是 P1-31)',
      'bash-write-guard.sh',
      bash('python3 <<PY\nopen("docs/current-state.md","w").write("x")\nPY'),
      2,
    );
    // ⭐ 仓库**外**必须放行 —— 门禁语义是「本仓状态不干净时别改本仓代码」,与仓外文件无关。
    // 本刀初版做成命令级预检并喂空 JSON,丢掉了这条规则,被 harness:replay 的 INV-03
    // 当场抓出(`cp <受保护路径> /tmp/backup` 这种**从受保护路径读出**的命令被误拦)。
    expectExit(
      'bash 门禁:未过时写**仓库外**文件仍放行(与 Edit 侧「仓外不受门禁管」同口径)',
      'bash-write-guard.sh',
      bash('python3 <<PY\nopen("/tmp/p131-outside.md","w").write("x")\nPY'),
      0,
    );
    expectExit(
      'bash 门禁:未过时 cp 从受保护路径读出到仓外仍放行(INV-03 回归)',
      'bash-write-guard.sh',
      bash('cp .claude/hooks/redzone-guard.sh /tmp/p131-backup.sh'),
      0,
    );
    expectExit(
      'bash 门禁:未过时 sed -i 被拦',
      'bash-write-guard.sh',
      bash("sed -i '' 's/a/b/' docs/current-state.md"),
      2,
    );
    expectExit(
      'bash 门禁:未过时重定向写**仓内**被拦',
      'bash-write-guard.sh',
      bash('echo hi > docs/current-state.md'),
      2,
    );

    // ② 反:门禁未过 + 只读命令 → 必须放行
    // 门禁自己的文案就是「只读调研可继续,写操作会被拦下」,Bash 侧必须同口径;
    // 拦了只读就是过度收紧,会把调研也锁死。
    expectExit(
      'bash 门禁:未过时只读命令(cat)仍放行',
      'bash-write-guard.sh',
      bash('cat docs/current-state.md | head -5'),
      0,
    );
    expectExit(
      'bash 门禁:未过时只读命令(grep)仍放行',
      'bash-write-guard.sh',
      bash('grep -rn foo src/'),
      0,
    );

    // ③ ⭐ 一致性(靶心):同一个写操作,Edit 侧与 Bash 侧结论必须相同 —— 两个方向都测。
    expectExit(
      '一致性:门禁未过 → Edit 侧拒',
      'preflight-required.sh',
      edit(path.join(repoRoot, 'docs/x.md')),
      2,
    );
    expectExit(
      '一致性:门禁未过 → Bash 侧同样拒(与上一条必须同结论)',
      'bash-write-guard.sh',
      bash("sed -i '' 's/a/b/' docs/x.md"),
      2,
    );
    writeMarker();
    expectExit(
      '一致性:门禁已过 → Edit 侧放行',
      'preflight-required.sh',
      edit(path.join(repoRoot, 'docs/x.md')),
      0,
    );
    expectExit(
      '一致性:门禁已过 → Bash 侧同样放行(与上一条必须同结论)',
      'bash-write-guard.sh',
      bash("sed -i '' 's/a/b/' docs/x.md"),
      0,
    );

    // ④ 回归:门禁已过时,红区判定不得被本次收口弄坏
    expectExit(
      'bash 门禁:已过时写红区仍按红区拦(没把老 behavior 弄坏)',
      'bash-write-guard.sh',
      bash("sed -i '' 's/a/b/' prisma/schema.prisma"),
      2,
    );
  } finally {
    fs.rmSync(marker, { force: true });
    if (had) fs.renameSync(backup, marker);
  }
}

// ---- preflight-gate:合并进行中不得拦写(2026-07-29 实测死锁)----
// 合并未提交时 HEAD 仍指向合并前的提交,**按定义必然显示落后 origin/main**。
// 若此时拦写,人就被锁在解冲突这一步之外 —— 而解冲突正是门禁要求的补救动作本身。
// (与 P2b「把开工前检查误用成每次写检查」同一类死锁,第二次学。)
{
  const gate = path.join(hooksDir, 'preflight-gate.sh');
  const src = fs.readFileSync(gate, 'utf-8');
  const has = src.includes('MERGE_HEAD');
  if (has) {
    passed++;
    console.log('✓ preflight-gate:合并进行中豁免「落后 origin/main」硬判');
  } else {
    failures.push('✗ preflight-gate 未豁免 MERGE_HEAD —— 解冲突期间会被自己的门禁锁死');
  }
  const degradesNotSilently = src.includes('ADVISORY_MERGE');
  if (degradesNotSilently) {
    passed++;
    console.log('✓ preflight-gate:该豁免降级为提示而非静默');
  } else {
    failures.push('✗ preflight-gate 的 MERGE_HEAD 豁免没有留下提示 —— 降级不等于沉默');
  }
}

// ---- preflight-required:开工门禁执法半边 ----
{
  const marker = gitPath('srvf-preflight.json');
  const backup = `${marker}.selftest-bak`;
  const had = fs.existsSync(marker);
  if (had) fs.renameSync(marker, backup);
  try {
    expectExit('preflight:无通行标记时拒绝写', 'preflight-required.sh', edit('src/x.ts'), 2);

    // 过期判据是**分支名**而非 HEAD sha:会话内正常提交会改 HEAD,
    // 按 sha 判会导致每 commit 一次全线卡死(实测踩到)。要捕捉的是「中途换了分支」。
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf-8',
      cwd: repoRoot,
    }).trim();
    fs.writeFileSync(marker, JSON.stringify({ status: 'pass', branch }));
    expectExit('preflight:同分支时放行', 'preflight-required.sh', edit('src/x.ts'), 0);

    // 同分支但 HEAD 变了(= 会话内提交过)→ 必须仍放行,这是回归点
    fs.writeFileSync(marker, JSON.stringify({ status: 'pass', branch, head: 'deadbee' }));
    expectExit('preflight:同分支但 HEAD 已变(会话内提交)仍放行', 'preflight-required.sh', edit('src/x.ts'), 0);

    fs.writeFileSync(marker, JSON.stringify({ status: 'pass', branch: 'some-other-branch' }));
    expectExit('preflight:换分支后标记过期,拒绝', 'preflight-required.sh', edit('src/x.ts'), 2);

    // 仓库外文件不受本仓门禁管(实测踩到:写 ~/.claude 下的 memory 被拦)
    fs.rmSync(marker, { force: true });
    expectExit(
      'preflight:仓库外文件不受门禁管(即使无标记)',
      'preflight-required.sh',
      edit('/tmp/some-file-outside-repo.md'),
      0,
    );
  } finally {
    fs.rmSync(marker, { force: true });
    if (had) fs.renameSync(backup, marker);
  }
}

// ---- preflight-gate:硬条件 vs 咨询条件(语义修正回归)----
// 这四条锁死「哪些状态该拦写、哪些只该提示」,是三次实测事故的固化:
//   ① gate 用 -x 判可执行性而脚本是 644 → 检查被整段跳过却报 PASS(fail-open)
//   ② 树脏 / 有 open PR 被升为拦写 → 连续开发从第二次写入起全线卡死
//   ③ 脚本缺失被静默当成通过
{
  const gate = path.join(hooksDir, 'preflight-gate.sh');
  const realPreflight = path.join(repoRoot, 'scripts/agent-preflight.sh');
  const backup = `${realPreflight}.selftest-bak`;
  const marker = gitPath('srvf-preflight.json');
  const hadReal = fs.existsSync(realPreflight);
  if (hadReal) fs.copyFileSync(realPreflight, backup);

  const runGate = (): { markerWritten: boolean; ctx: string } => {
    fs.rmSync(marker, { force: true });
    let out = '';
    try {
      out = execFileSync(gate, {
        input: JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup' }),
        encoding: 'utf-8',
        cwd: repoRoot,
      });
    } catch {
      out = '';
    }
    let ctx = out;
    try {
      ctx =
        (JSON.parse(out) as { hookSpecificOutput?: { additionalContext?: string } })
          .hookSpecificOutput?.additionalContext ?? out;
    } catch {
      /* 非 JSON:原样比对 */
    }
    return { markerWritten: fs.existsSync(marker), ctx };
  };

  const fakePreflight = (body: string): void =>
    fs.writeFileSync(realPreflight, `#!/usr/bin/env bash\n${body}\n`, { mode: 0o644 });

  const gateCase = (name: string, wantMarker: boolean, expectIn?: string): void => {
    const { markerWritten, ctx } = runGate();
    const ok = markerWritten === wantMarker && (!expectIn || ctx.includes(expectIn));
    if (ok) {
      passed++;
      console.log(`✓ ${name}`);
    } else {
      failures.push(
        `✗ ${name} — 期望发放标记=${String(wantMarker)},实际=${String(markerWritten)}` +
          (expectIn && !ctx.includes(expectIn) ? `;文案缺「${expectIn}」` : ''),
      );
    }
  };

  try {
    // 咨询条件:树脏 / 有 open PR → 放行写,但提示「不应开新功能」
    fakePreflight(
      'echo "preflight 门禁未过:"\n' +
        'echo "  ✗ 工作树非 clean(git status --short 非空)→ 先 commit"\n' +
        'echo "  ✗ 存在 open PR(gh pr list --state open 非空)→ 先合并"\n' +
        'echo "(global 模式硬判 工作树 / open-PR / 未落后 origin/main 三条)"\nexit 1',
    );
    gateCase('gate:树脏+open PR 属咨询,仍放行写', true, '不应开新功能');

    // 硬条件:落后 origin/main → 拦写(会在过时基础上改代码)
    fakePreflight(
      'echo "preflight 门禁未过:"\n' +
        'echo "  ✗ 落后 origin/main 3 个 commit → 先 git pull --ff-only"\n' +
        'echo "(global 模式硬判 工作树 / open-PR / 未落后 origin/main 三条)"\nexit 1',
    );
    gateCase('gate:落后 origin/main 属硬条件,拦写', false, '落后 origin/main');

    // 脚本缺失 → fail-closed(无法验证 ≠ 通过)
    fs.rmSync(realPreflight, { force: true });
    gateCase('gate:preflight 脚本缺失时 fail-closed', false, 'fail-closed');

    // 全过 → 发标记
    fakePreflight('echo "✅ 硬门禁通过"\nexit 0');
    gateCase('gate:全过时发放通行标记', true);
  } finally {
    if (hadReal) {
      fs.copyFileSync(backup, realPreflight);
      fs.rmSync(backup, { force: true });
    }
    fs.rmSync(marker, { force: true });
  }
}

for (const f of failures) console.error(f);
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.error(
    '\n⚠️ hook 行为不符预期。注意:Claude Code 只把 **exit 2** 当阻断,' +
      'exit 1 会被当成非阻断错误直接放行 —— 那样「拦截」只是纸面上的。',
  );
  process.exit(1);
}
