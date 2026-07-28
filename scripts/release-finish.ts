import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

// Harness 3.0 P4c — 发版收口阶段 B(squash 合并**之后**的收尾)。
//
// 为什么必须两段:tag 与 GitHub Release 必须指向 release PR 的 **squash 合并提交**,
// 而那个提交在 PR 合并前不存在。把它们塞进阶段 A 会指向一个将被 squash 丢弃的提交。
//
// 本脚本做三件事,全部幂等:
//   1. 打 tag vX.Y.Z 指向 main 当前 HEAD(先校验该 HEAD 确实是本版 release 提交)
//   2. push tag
//   3. 建 GitHub Release,Notes 取自 CHANGELOG 对应段
//
// 设计约束:
//   - **幂等**:tag / Release 已存在则跳过并核对指向是否正确(指错 = 停下报告)
//   - **fail-closed**:任何一步无法验证(gh 未登录、CHANGELOG 无该段、HEAD 不匹配)→ 停
//   - **不改任何文件**:阶段 B 只与 git ref 和 GitHub 打交道
//
// 用法:pnpm release:finish 0.63.0 [--dry-run]

const ROOT = path.resolve(__dirname, '..');

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf-8' }).trim();
}
function gitQuiet(args: string[]): { ok: boolean; out: string } {
  try {
    return { ok: true, out: git(args) };
  } catch (err) {
    return { ok: false, out: (err as { stderr?: Buffer }).stderr?.toString() ?? '' };
  }
}
function gh(args: string[]): string {
  return execFileSync('gh', args, { cwd: ROOT, encoding: 'utf-8' }).trim();
}
function ghQuiet(args: string[]): { ok: boolean; out: string } {
  try {
    return { ok: true, out: gh(args) };
  } catch (err) {
    return { ok: false, out: (err as { stderr?: Buffer }).stderr?.toString() ?? '' };
  }
}

function extractNotes(version: string): string {
  const doc = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf-8');
  const start = doc.indexOf(`## v${version} -`);
  if (start === -1) return '';
  const rest = doc.slice(start);
  const nextIdx = rest.indexOf('\n## ', 1);
  const section = (nextIdx === -1 ? rest : rest.slice(0, nextIdx)).trim();
  return section.split('\n').slice(1).join('\n').trim();
}

function fail(msg: string, hint?: string): never {
  console.error(`\n✗ ${msg}`);
  if (hint) console.error(`  ${hint}`);
  console.error('\n本脚本幂等:修好后直接重跑,已完成的步骤会自动跳过。');
  process.exit(1);
}

function main(): void {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const version = args.find((a) => !a.startsWith('--'));
  if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
    console.error('用法:pnpm release:finish <X.Y.Z> [--dry-run]');
    process.exit(1);
  }
  const tag = `v${version}`;

  // ── 前置校验(全部 fail-closed)────────────────────────────────────────────
  const auth = ghQuiet(['auth', 'status']);
  if (!auth.ok) fail('gh 未登录,无法建 Release', '先跑 gh auth login');

  const pkgVersion = (
    JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8')) as { version: string }
  ).version;
  if (pkgVersion !== version) {
    fail(
      `package.json#version 是 ${pkgVersion},与参数 ${version} 不一致`,
      '阶段 A 是否已合并?顺序:release:prepare → 开 PR → 维护者合并 → release:finish',
    );
  }

  const notes = extractNotes(version);
  if (notes === '') fail(`CHANGELOG 无 ## ${tag} 段 —— 拿不到 Release Notes`);

  git(['fetch', 'origin', 'main', '--tags', '-q']);
  const localHead = git(['rev-parse', 'HEAD']);
  const originMain = git(['rev-parse', 'origin/main']);
  if (localHead !== originMain) {
    fail(
      `本地 HEAD(${localHead.slice(0, 8)})≠ origin/main(${originMain.slice(0, 8)})`,
      '阶段 B 必须在已合并的 main 上跑:git checkout main && git pull --ff-only origin main',
    );
  }

  // main 的 HEAD 必须确实是本版 release 提交(防止在错误的提交上打 tag)
  const headMsg = git(['log', '-1', '--pretty=%s']);
  if (!headMsg.includes(tag) && !headMsg.includes(version)) {
    fail(
      `main HEAD 的提交信息不含 ${tag}:「${headMsg}」`,
      'tag 必须指向 release PR 的 squash 合并提交。若确认无误,请人工打 tag 并说明原因。',
    );
  }

  console.log(`发版阶段 B:${tag}${dryRun ? '(DRY-RUN)' : ''}`);
  console.log(`  目标提交:${localHead.slice(0, 8)} 「${headMsg}」\n`);

  // ── 1. tag(幂等:已存在则校验指向)────────────────────────────────────────
  const localTag = gitQuiet(['rev-parse', `${tag}^{commit}`]);
  if (localTag.ok) {
    if (localTag.out !== localHead) {
      fail(
        `本地 tag ${tag} 指向 ${localTag.out.slice(0, 8)},而目标是 ${localHead.slice(0, 8)}`,
        '已存在的 tag 指错提交属重大异常 —— 不自动移动 tag,请人工确认。',
      );
    }
    console.log(`⏭  tag ${tag} 已存在且指向正确`);
  } else if (dryRun) {
    console.log(`·  将打 tag ${tag}`);
  } else {
    git(['tag', tag, localHead]);
    console.log(`✓  已打 tag ${tag} → ${localHead.slice(0, 8)}`);
  }

  // ── 2. push tag(幂等:远端已有则跳过)────────────────────────────────────
  const remoteTag = gitQuiet(['ls-remote', '--tags', 'origin', tag]);
  const remoteHasTag = remoteTag.ok && remoteTag.out.trim() !== '';
  if (remoteHasTag) {
    console.log(`⏭  远端已有 tag ${tag}`);
  } else if (dryRun) {
    console.log(`·  将 push tag ${tag}`);
  } else {
    git(['push', 'origin', tag]);
    console.log(`✓  已 push tag ${tag}`);
  }

  // ── 3. GitHub Release(幂等:已存在则跳过)────────────────────────────────
  const existing = ghQuiet(['release', 'view', tag, '--json', 'tagName']);
  if (existing.ok) {
    console.log(`⏭  GitHub Release ${tag} 已存在`);
  } else if (dryRun) {
    console.log(`·  将建 GitHub Release ${tag}(Notes 取自 CHANGELOG,${notes.split('\n').length} 行)`);
  } else {
    const notesFile = path.join(ROOT, 'tmp', `release-notes-${tag}.md`);
    fs.mkdirSync(path.dirname(notesFile), { recursive: true });
    fs.writeFileSync(notesFile, notes);
    gh(['release', 'create', tag, '--title', tag, '--notes-file', notesFile, '--latest']);
    fs.rmSync(notesFile, { force: true });
    console.log(`✓  已建 GitHub Release ${tag}(标 Latest)`);
  }

  if (dryRun) return;

  // ── 收尾证据(供人话简报直接引用)────────────────────────────────────────
  console.log('\n收尾证据:');
  console.log(`  tag        ${tag} → ${localHead.slice(0, 8)}`);
  const relList = ghQuiet(['release', 'list', '--limit', '1']);
  if (relList.ok) console.log(`  release    ${relList.out.split('\n')[0]}`);
  const prList = ghQuiet(['pr', 'list', '--state', 'open', '--json', 'number', '--jq', 'length']);
  if (prList.ok) console.log(`  open PR    ${prList.out}`);
  console.log('\n剩余人工项:current-state §1 的 tag/Release 行若需补链接,按实际回填(A 档)。');
}

main();
