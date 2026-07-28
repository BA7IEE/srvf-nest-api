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

// 自测必须测「基线执法强度」,与当前是否恰好持有授权令牌无关 ——
// 否则维护者授权期间跑自测会得到「拦不住」的假失败,反过来无授权时又测不到放行路径。
// 因此整段测试期间把令牌移开,结束后原样放回(含异常路径)。
const grantFile = gitPath('srvf-redzone-grant.json');
const grantBackup = `${grantFile}.selftest-bak`;
const hadGrant = fs.existsSync(grantFile);
if (hadGrant) fs.renameSync(grantFile, grantBackup);
function restoreGrant(): void {
  if (hadGrant && fs.existsSync(grantBackup)) fs.renameSync(grantBackup, grantFile);
}
process.on('exit', restoreGrant);
process.on('SIGINT', () => {
  restoreGrant();
  process.exit(130);
});

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

expectExit('bash:git status 放行', 'bash-write-guard.sh', bash('git status --short'), 0);
expectExit('bash:pnpm lint 放行', 'bash-write-guard.sh', bash('pnpm lint'), 0);
expectExit('bash:写普通业务文件放行', 'bash-write-guard.sh', bash("sed -i '' 's/a/b/' src/modules/users/users.service.ts"), 0);
expectExit('bash:重定向 /dev/null 放行', 'bash-write-guard.sh', bash('pnpm test > /dev/null 2>&1'), 0);

// ---- preflight-required:开工门禁执法半边 ----
{
  const marker = gitPath('srvf-preflight.json');
  const backup = `${marker}.selftest-bak`;
  const had = fs.existsSync(marker);
  if (had) fs.renameSync(marker, backup);
  try {
    expectExit('preflight:无通行标记时拒绝写', 'preflight-required.sh', edit('src/x.ts'), 2);
    const head = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      encoding: 'utf-8',
      cwd: repoRoot,
    }).trim();
    fs.writeFileSync(marker, JSON.stringify({ status: 'pass', head }));
    expectExit('preflight:标记 HEAD 一致时放行', 'preflight-required.sh', edit('src/x.ts'), 0);
    fs.writeFileSync(marker, JSON.stringify({ status: 'pass', head: 'deadbee' }));
    expectExit('preflight:标记 HEAD 过期时拒绝', 'preflight-required.sh', edit('src/x.ts'), 2);
  } finally {
    fs.rmSync(marker, { force: true });
    if (had) fs.renameSync(backup, marker);
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
