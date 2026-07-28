/**
 * harness-guards.selftest.ts — Harness 机器层守卫回归自测(第五轮 review R5-02/03/04)
 *
 * 把冻结报告 docs/archive/reviews/full-repo-fifth-review-v0.57.0.md §2.2/§5 列出的
 * 每个绕过 / 失败样例固化为断言,逐一验证已被杀死;后续任何人改回词法计数 / 放松校验 /
 * 去掉哈希段,本自测即红。
 *
 * 运行:`pnpm tsx scripts/harness-guards.selftest.ts`(exit 0 全过 / exit 1 有失败)。
 * 形态说明:本脚本当前未接入 package.json 的 agent:check:* 自动链,必须显式运行;
 * Jest worktree ignore guard 直接读取三份 config,不宣称 CI 已自动执行本 selftest。
 * preflight(R5-08)的参数 / bump 特征回归在 scripts/agent-preflight.selftest.sh。
 */

import * as fs from 'fs';
import * as path from 'path';
import { checkFragment, mergeIntoChangelog } from './changelog-merge';
import {
  countAuditLogEventMembers,
  countDecoratorUsage,
  countExpectedRoutesInSource,
  countHttpStatusProps,
  countRbacRoleUpserts,
  diffSeedPermissionExtractions,
  extractSeedPermissionCodesAst,
} from './docs-counts';
import {
  deriveTestDbName,
  deriveTestDbNameFrom,
  deriveTemplateTestDbName,
} from '../test/setup/worktree-db';
import contractJestConfig from '../test/jest-contract.config';
import e2eJestConfig from '../test/jest-e2e.config';
import unitJestConfig from '../test/jest-unit.config';

let passCount = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    passCount += 1;
    process.stdout.write(`✓ ${name}\n`);
  } else {
    failures.push(name);
    process.stderr.write(`✗ ${name}${detail ? ` — ${detail}` : ''}\n`);
  }
}

function checkEq(name: string, actual: unknown, expected: unknown): void {
  check(name, actual === expected, `actual=${String(actual)} expected=${String(expected)}`);
}

function checkThrows(name: string, fn: () => unknown, msgPart: string): void {
  try {
    fn();
    failures.push(name);
    process.stderr.write(`✗ ${name} — 期望抛错但未抛\n`);
  } catch (e) {
    check(name, String((e as Error).message).includes(msgPart), (e as Error).message);
  }
}

// ---------------------------------------------------------------------------
// R5-02 — docs-counts 绕过样例(报告 §2.2「docs-counts 九提取器」逐条)
// ---------------------------------------------------------------------------

// 样例 1/2:block comment / template literal 行首 @Controller( 曾被计;`@Controller (` 曾漏计
const CONTROLLER_SAMPLE = `
/*
@Controller('ghost-in-block-comment')
*/
const tpl = \`
@Controller('ghost-in-template')
\`;
// @Controller('ghost-in-line-comment')
@Controller ('spaced')
class SpacedController {}
@Controller('real')
class RealController {}
`;
checkEq(
  'R5-02 controller:注释/模板字面量不计,`@Controller (` 空格形态计入',
  countDecoratorUsage(CONTROLLER_SAMPLE).controllers,
  2,
);

// 样例:@Cron( 曾对注释与字符串裸 occurrence 计数
const CRON_SAMPLE = `
/* @Cron('0 0 * * *') */
const s = "@Cron('ghost-in-string')";
const t = \`@Cron('ghost-in-template')\`;
// @Cron('ghost-in-line-comment')
class Job {
  @Cron('0 9 * * *')
  run(): void {}
}
`;
checkEq('R5-02 cron:注释/字符串不计,真装饰器计入', countDecoratorUsage(CRON_SAMPLE).cron, 1);

// 样例:httpStatus: 曾对注释与字符串裸 occurrence 计数
const BIZ_SAMPLE = `
/* httpStatus: 400 */
const s = 'httpStatus:';
// httpStatus: 401
export const BizCode = {
  A: { code: 10001, message: 'x', httpStatus: 400 },
  B: { code: 10002, message: 'y', httpStatus: 404 },
} as const;
`;
checkEq('R5-02 bizcode:注释/字符串不计,真属性计入', countHttpStatusProps(BIZ_SAMPLE), 2);

// 样例:block comment 中 code: 'ghost.read' 曾被计为权限码
const SEED_BLOCK_COMMENT_SAMPLE = `
/* code: 'ghost.read' */
const REAL_CODE = 'member.read.record';
const perms = [{ code: 'user.create.record', name: 'x' }];
const roleNotPerm = { code: 'ops-admin' };
`;
{
  const ast = extractSeedPermissionCodesAst(SEED_BLOCK_COMMENT_SAMPLE);
  check('R5-02 权限码:block comment 中的码不进 AST 真源', !ast.has('ghost.read'));
  checkEq('R5-02 权限码:AST 真源计数正确(2)', ast.size, 2);
  const diff = diffSeedPermissionExtractions(SEED_BLOCK_COMMENT_SAMPLE);
  check(
    'R5-02 权限码:注释码使双口径分歧被暴露(guard exit 2,不静默)',
    diff.onlyLegacy.includes('ghost.read'),
  );
}

// 样例:双引号字面量曾漏计(静默);现 AST 计入且与镜像正则分歧 → guard 必响
const SEED_DQUOTE_SAMPLE = `
const X_CODE = "double.quoted.code";
const perms = [{ code: "another.dq.code" }];
`;
{
  const ast = extractSeedPermissionCodesAst(SEED_DQUOTE_SAMPLE);
  check(
    'R5-02 权限码:双引号形态 AST 计入',
    ast.has('double.quoted.code') && ast.has('another.dq.code'),
  );
  const diff = diffSeedPermissionExtractions(SEED_DQUOTE_SAMPLE);
  checkEq('R5-02 权限码:双引号使双口径分歧被暴露', diff.onlyAst.length, 2);
}

// 合规书写(seed 书写契约)下双口径必须一致 —— 合成样例 + 真实 seed 双验证
const SEED_CLEAN_SAMPLE = `
// 行注释里的示例不算:code: 'comment.example'
const A_CODE = 'a.b';
const list = [{ code: 'c.d' }, { code: 'e.f-g' }];
`;
{
  const diff = diffSeedPermissionExtractions(SEED_CLEAN_SAMPLE);
  check(
    'R5-02 权限码:合规书写双口径一致(合成样例)',
    diff.onlyAst.length === 0 && diff.onlyLegacy.length === 0 && diff.ast.size === 3,
  );
  const realSeed = fs.readFileSync(path.resolve(__dirname, '../prisma/seed.ts'), 'utf-8');
  const realDiff = diffSeedPermissionExtractions(realSeed);
  check(
    'R5-02 权限码:真实 prisma/seed.ts 双口径一致(与 check-rbac-map 同拍)',
    realDiff.onlyAst.length === 0 && realDiff.onlyLegacy.length === 0,
    `onlyAst=[${realDiff.onlyAst.join(',')}] onlyLegacy=[${realDiff.onlyLegacy.join(',')}]`,
  );
}

// 样例:同行 union 曾得 0(现有多行风格得 2)
checkEq(
  'R5-02 audit:同行 union 计数正确',
  countAuditLogEventMembers(`export type AuditLogEvent = 'a' | 'b';`),
  2,
);
checkEq(
  'R5-02 audit:多行 + 注释/空行风格计数正确',
  countAuditLogEventMembers(`
export type AuditLogEvent =
  | 'a' // 尾注释
  // 分组注释行
  | 'b'

  | 'c';
`),
  3,
);
checkEq(
  'R5-02 audit:单成员(无 | )计数正确',
  countAuditLogEventMembers(`export type AuditLogEvent = 'only';`),
  1,
);
checkThrows(
  'R5-02 audit:非字符串字面量成员拒绝(不静默漏计)',
  () => countAuditLogEventMembers(`export type AuditLogEvent = 'a' | OtherType;`),
  '非字符串字面量',
);
checkThrows(
  'R5-02 audit:联合未找到时报错',
  () => countAuditLogEventMembers(`export type Other = 'a';`),
  '未找到',
);

// 样例:rbacRole.upsert( 曾对注释与字符串裸 occurrence 计数
const ROLE_SAMPLE = `
/* prisma.rbacRole.upsert( */
const s = "rbacRole.upsert(";
// prisma.rbacRole.upsert(
async function seed(prisma: any, tx: any) {
  await prisma.rbacRole.upsert({ where: {}, update: {}, create: {} });
  await tx.rbacRole.upsert({ where: {}, update: {}, create: {} });
}
`;
checkEq('R5-02 内建角色:注释/字符串不计,真调用计入', countRbacRoleUpserts(ROLE_SAMPLE), 2);

// 样例:endpoint 曾只识别单引号数组行;双引号 / helper 漏计,spread 静默漏计
checkEq(
  'R5-02 endpoint:双引号 tuple 计入',
  countExpectedRoutesInSource(`const EXPECTED_ROUTES = [["get", "/a"], ['post', '/b']];`),
  2,
);
checkEq(
  'R5-02 endpoint:helper 调用形态按元素计入',
  countExpectedRoutesInSource(`const EXPECTED_ROUTES = [route('get', '/a'), ['get', '/b']];`),
  2,
);
checkThrows(
  'R5-02 endpoint:spread 元素拒绝(不静默漏计)',
  () => countExpectedRoutesInSource(`const EXPECTED_ROUTES = [['get', '/a'], ...EXTRA_ROUTES];`),
  'spread',
);
checkEq(
  'R5-02 endpoint:类型标注 + as const 形态计入',
  countExpectedRoutesInSource(
    `const EXPECTED_ROUTES: ReadonlyArray<readonly [string, string]> = [['get', '/a']] as const;`,
  ),
  1,
);

// ---------------------------------------------------------------------------
// R5-03 — changelog-merge 失败样例(报告 §5 R5-03 逐条)
// ---------------------------------------------------------------------------

// 样例:非法 UTF-8 bytes 曾被宽松解码为 U+FFFD 写入 CHANGELOG 后删源
check(
  'R5-03 fragment:非 UTF-8 拒收',
  checkFragment('bad.md', Buffer.from([0xff, 0xfe, 0x41])).issues.some((i) =>
    i.includes('非 UTF-8'),
  ),
);
// 样例:只有空 fragment 时曾重写 CHANGELOG、删源并报告成功
check('R5-03 fragment:空文件拒收', checkFragment('empty.md', Buffer.from('')).issues.length > 0);
check(
  'R5-03 fragment:纯空白拒收',
  checkFragment('blank.md', Buffer.from('  \n\t\n')).issues.length > 0,
);
// 样例:fragment 内 ## Nested 曾成为新的顶级 release heading
check(
  'R5-03 fragment:二级 heading 拒收(报告 ## Nested 样例)',
  checkFragment('nested.md', Buffer.from('- ok\n## Nested\n- entry')).issues.some((i) =>
    i.includes('heading'),
  ),
);
check(
  'R5-03 fragment:一级 heading 拒收',
  checkFragment('h1.md', Buffer.from('# Top')).issues.length > 0,
);
checkEq(
  'R5-03 fragment:### 及以下允许',
  checkFragment('ok.md', Buffer.from('### Fixed\n\n- 修复 xx\n#### 细节\n- yy')).issues.length,
  0,
);
checkEq(
  'R5-03 fragment:code fence 内的 # 行不误拒',
  checkFragment('fence.md', Buffer.from('- entry\n```bash\n# shell 注释\n## 也是注释\n```\n'))
    .issues.length,
  0,
);

// 归并文本不撕分段:合法归并后顶级 `## ` heading 数不变
const DOC_WITH_UNRELEASED = `# Changelog\n\n## Unreleased\n\n- old\n\n## v1.0.0 - 2026-01-01\n\n- released\n`;
{
  const merged = mergeIntoChangelog(DOC_WITH_UNRELEASED, '- new');
  check(
    'R5-03 merge:条目落在 Unreleased 段内(old 之后、release 段之前)',
    merged.indexOf('- new') > merged.indexOf('- old') &&
      merged.indexOf('- new') < merged.indexOf('## v1.0.0'),
  );
  checkEq(
    'R5-03 merge:顶级 heading 数不变(报告 2→3 症状不再)',
    (merged.match(/^## /gm) ?? []).length,
    2,
  );
}
{
  const doc = `# Changelog\n\n## v1.0.0 - 2026-01-01\n\n- released\n`;
  const merged = mergeIntoChangelog(doc, '- new');
  check(
    'R5-03 merge:无 Unreleased 段时在首个 release 前新建',
    merged.includes('## Unreleased') && merged.indexOf('- new') < merged.indexOf('## v1.0.0'),
  );
}
checkThrows(
  'R5-03 merge:CHANGELOG 无 release 段拒绝归并',
  () => mergeIntoChangelog('# X\n\nnothing here', '- new'),
  '结构异常',
);

// ---------------------------------------------------------------------------
// R5-04 — worktree 库名派生碰撞样例(报告 §5 R5-04 逐条)
// ---------------------------------------------------------------------------

checkEq(
  'R5-04 db:主仓恒 app_test(行为零变化)',
  deriveTestDbNameFrom('/repo/main', false),
  'app_test',
);

// 样例:lane-a 与 lane_a 曾同为 app_test_lane_a
{
  const a = deriveTestDbNameFrom('/w/lane-a', true);
  const b = deriveTestDbNameFrom('/w/lane_a', true);
  check('R5-04 db:lane-a 与 lane_a 不再共库', a !== b, `${a} == ${b}`);
  check(
    'R5-04 db:派生名保留 app_test_ 前缀(安全护栏不破)',
    a.startsWith('app_test_') && b.startsWith('app_test_'),
  );
}
// 样例:两个共享前 40 字符的名称曾同 slug
{
  const prefix = 'x'.repeat(40);
  const p1 = deriveTestDbNameFrom(`/w/${prefix}-one`, true);
  const p2 = deriveTestDbNameFrom(`/w/${prefix}-two`, true);
  check('R5-04 db:40 字符共同前缀不再共库', p1 !== p2, `${p1} == ${p2}`);
  check(
    'R5-04 db:长名派生仍 ≤ PostgreSQL 63 字符上限',
    p1.length <= 63 && p2.length <= 63,
    `${p1.length}`,
  );
}
// 样例:全中文目录名空 slug 曾回落主库 app_test
{
  const zh = deriveTestDbNameFrom('/w/审计五', true);
  check('R5-04 db:全中文名不回落 app_test', zh !== 'app_test' && zh.startsWith('app_test_'), zh);
}
// 同 basename 不同父目录也不共库;同路径重复派生稳定
{
  const x = deriveTestDbNameFrom('/x/lane-a', true);
  const y = deriveTestDbNameFrom('/y/lane-a', true);
  check('R5-04 db:同名 worktree 挂不同路径不共库', x !== y);
  checkEq('R5-04 db:同路径重复派生稳定', deriveTestDbNameFrom('/x/lane-a', true), x);
}

// ---------------------------------------------------------------------------
// P1 — jest worker 级派生(Harness 3.0 并行化;worker 后缀并入唯一派生源)
// ---------------------------------------------------------------------------

{
  const savedWorkerId = process.env.JEST_WORKER_ID;
  const savedCwdNote = '本段只测纯函数与 env 分支,不触碰任何数据库';
  void savedCwdNote;

  // worker 后缀:合法 1-2 位数字
  process.env.JEST_WORKER_ID = '3';
  const w3 = deriveTestDbName();
  check('P1 db:worker 内派生名以 _w<id> 结尾', w3.endsWith('_w3'), w3);
  check('P1 db:worker 派生名仍含 app_test 子串(安全护栏不破)', w3.includes('app_test'), w3);
  check('P1 db:worker 派生名 ≤ 63 字符', w3.length <= 63, `${w3.length}`);

  // 两位 worker 号
  process.env.JEST_WORKER_ID = '12';
  check('P1 db:两位 worker 号可用', deriveTestDbName().endsWith('_w12'));

  // 非法 worker 号必须抛错(拒绝任意字符串拼进库名)
  process.env.JEST_WORKER_ID = 'evil;DROP';
  checkThrows('P1 db:非法 JEST_WORKER_ID 拒绝派生', () => deriveTestDbName(), '非法 JEST_WORKER_ID');
  process.env.JEST_WORKER_ID = '123';
  checkThrows('P1 db:三位 worker 号拒绝(超出预期规模)', () => deriveTestDbName(), '非法 JEST_WORKER_ID');

  // jest 之外(无 JEST_WORKER_ID)→ 模板库名,与 checkout 级派生一致
  delete process.env.JEST_WORKER_ID;
  checkEq('P1 db:无 worker 上下文时回到模板库名', deriveTestDbName(), deriveTemplateTestDbName());

  // worker 展开:长 slug + 两位 worker 号仍 ≤63 且互不相同
  {
    const longBase = deriveTestDbNameFrom(`/w/${'y'.repeat(40)}-lane`, true);
    check('P1 db:长 slug 模板 + _w 后缀总长安全余量', longBase.length + 4 <= 63, `${longBase.length}`);
  }

  if (savedWorkerId === undefined) delete process.env.JEST_WORKER_ID;
  else process.env.JEST_WORKER_ID = savedWorkerId;
}

// ---------------------------------------------------------------------------
// P1 — 并行 e2e 的三条承重不变式(Harness 3.0 P1;对抗性评审 blocker/major 固化)
// ---------------------------------------------------------------------------

{
  const repoRoot = path.resolve(__dirname, '..');
  const read = (rel: string): string => fs.readFileSync(path.join(repoRoot, rel), 'utf-8');

  // ① 两条泄漏检测线的 grep 字符串**互不相同且各自正确**。
  // 实测:并行 worker 模式打 'A worker process has failed to exit gracefully'(退出码 0);
  // 串行 + detectOpenHandles 打 'Jest has detected the following N open handle' 并挂死。
  // 曾经写反过(夜间线 grep 了并行才有的文案 = 死代码,泄漏检测净归零)。
  const ci = read('.github/workflows/ci.yml');
  const nightly = read('.github/workflows/nightly-e2e-leaks.yml');
  check(
    'P1 leak:ci.yml 并行 e2e 步骤 grep worker 强杀文案(告警级)',
    ci.includes("grep -q 'failed to exit gracefully'") && ci.includes('::warning::'),
    'ci.yml 缺并行泄漏 grep 或未按告警级投递',
  );
  // 该警告在本仓基线即非零(串行 detectOpenHandles 实测零句柄),
  // 设成硬失败会让 CI 永久红且无鉴别力 —— 权威判据必须留在夜间线。
  check(
    'P1 leak:ci.yml 的 worker 强杀不得升为硬失败',
    !/failed to exit gracefully'[\s\S]{0,200}::error::/.test(ci),
    'ci.yml 把已知基线警告升成了硬失败',
  );
  check(
    'P1 leak:nightly grep 串行 detectOpenHandles 文案(非 worker 文案)',
    nightly.includes("grep -q 'Jest has detected the following'"),
    'nightly grep 字符串错误(串行模式下不会出现 worker 文案)',
  );
  check(
    'P1 leak:nightly 对挂死有 timeout 兜底(detectOpenHandles 泄漏时不退出)',
    /timeout .*--kill-after/.test(nightly) && nightly.includes('124'),
    'nightly 缺 timeout/超时判定',
  );

  // ② CI gate 必须正面证明 slow 的 skipped 合法(docs-only),不得从 skipped 反推。
  // 曾经 fail-open:changeset 失败 → slow skipped → required check 变绿而 e2e 从未跑。
  check(
    'P1 gate:校验 changeset 结果',
    ci.includes("needs.changeset.result }}\" != \"success\""),
    'gate 未校验 changeset,存在 fail-open 假绿路径',
  );
  check(
    'P1 gate:slow=skipped 需 docs_only 正面证明',
    ci.includes("needs.changeset.outputs.docs_only }}\" != \"true\""),
    'gate 未正面证明 docs-only',
  );

  // ③ P2b 执法层接线:hooks 存在、可执行、且在 settings 里被正确挂载。
  // 「装了 hook 但没接线」= 以为有防线其实没有,与 selector 写错同类的静默失效。
  const settings = JSON.parse(read('.claude/settings.json')) as {
    hooks?: Record<string, Array<{ matcher?: string; hooks?: Array<{ command?: string }> }>>;
    permissions?: { deny?: string[]; ask?: string[]; allow?: string[] };
  };
  const hookCmds = Object.values(settings.hooks ?? {})
    .flat()
    .flatMap((m) => (m.hooks ?? []).map((h) => h.command ?? ''));
  for (const script of [
    'preflight-gate.sh',
    'preflight-required.sh',
    'redzone-guard.sh',
    'bash-write-guard.sh',
  ]) {
    const p = path.join(repoRoot, '.claude/hooks', script);
    check(`P2b hook:${script} 存在`, fs.existsSync(p), '文件缺失');
    if (fs.existsSync(p)) {
      check(`P2b hook:${script} 有执行位`, (fs.statSync(p).mode & 0o111) !== 0, 'chmod +x 缺失');
    }
    check(
      `P2b hook:${script} 已在 settings 接线`,
      hookCmds.some((c) => c.includes(script)),
      '脚本存在但没挂进 settings —— 等于没装',
    );
  }
  // Bash 旁路必须挂:只拦 Edit/Write 不拦 Bash,一条 sed -i 即可绕过全部红区保护
  check(
    'P2b hook:Bash 旁路已挂 PreToolUse',
    (settings.hooks?.PreToolUse ?? []).some(
      (m) =>
        m.matcher === 'Bash' &&
        (m.hooks ?? []).some((h) => h.command?.includes('bash-write-guard')),
    ),
    '未挂 Bash matcher —— sed -i / > 可绕过红区',
  );

  // ④ redzone.json 可解析,且裁判保护覆盖执法层自身
  const redzone = JSON.parse(read('harness/redzone.json')) as {
    redzone: Array<{ id: string; globs: string[] }>;
    selfGuard: Array<{ id: string; globs: string[] }>;
  };
  const selfGlobs = redzone.selfGuard.flatMap((e) => e.globs);
  for (const must of [
    'test/setup/**',
    'test/contract/**',
    '.claude/hooks/**',
    'harness/**',
    'eslint.harness.mjs',
    'scripts/harness-grant.ts', // 授权工具:能改它就能自授权,最关键的一条
  ]) {
    check(`P2b redzone:裁判保护覆盖 ${must}`, selfGlobs.includes(must), '执法层可被 PR 内改松');
  }

  // ── ci-guard-coverage:凡被检查链引用的 scripts/ 文件,必须落在裁判保护内 ──────
  // 2026-07-28 把 selfGuard 从整个 scripts/** 收窄为具名清单后,新增的漏洞是
  // 「把守卫命名成清单外的名字再挂进 CI」。本断言把这个洞堵死:从 package.json 的
  // 检查链(agent:check:* / harness:selftest / docs:*:check)与 ci.yml 里解析出所有
  // 被引用的 scripts/ 文件,逐一要求命中 selfGuard —— 加了新守卫却没纳入保护,当场红。
  {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    const ciYml = read('.github/workflows/ci.yml');
    const guardEntries = Object.entries(pkg.scripts).filter(([name]) =>
      /^(agent:check|harness:selftest|docs:.*:check)/.test(name),
    );
    // 展开一层 pnpm <script> 引用,拿到最终的 scripts/ 路径
    const referenced = new Set<string>();
    const collect = (cmd: string): void => {
      for (const m of cmd.matchAll(/scripts\/[A-Za-z0-9._-]+\.(ts|sh)/g)) referenced.add(m[0]);
      for (const m of cmd.matchAll(/pnpm ([a-z][a-z0-9:-]*)/g)) {
        const sub = pkg.scripts[m[1]];
        if (sub && !sub.includes(m[1])) collect(sub);
      }
    };
    for (const [, cmd] of guardEntries) collect(cmd);
    for (const m of ciYml.matchAll(/pnpm ([a-z][a-z0-9:-]*)/g)) {
      const sub = pkg.scripts[m[1]];
      if (sub) collect(sub);
    }

    const matchesAnyGlob = (p: string): boolean =>
      selfGlobs.some((g) => {
        if (g.includes('**')) return p.startsWith(g.slice(0, g.indexOf('**')));
        // scripts/check-*.ts 形态:转成正则
        const re = new RegExp(`^${g.replace(/[.]/g, '\\.').replace(/\*/g, '[^/]*')}$`);
        return re.test(p);
      });

    const unprotected = [...referenced].filter((p) => !matchesAnyGlob(p)).sort();
    check(
      'P4a ci-guard-coverage:检查链引用的守卫脚本均在裁判保护内',
      unprotected.length === 0,
      `以下脚本被 CI/检查链引用却不在 selfGuard,可在同一 PR 内被改松而不被察觉:\n    ${unprotected.join('\n    ')}`,
    );
  }
  const redGlobs = redzone.redzone.flatMap((e) => e.globs);
  for (const must of [
    'AGENTS.md',
    '.claude/CLAUDE.md',
    '.github/workflows/**',
    'prisma/schema.prisma',
    'src/modules/auth/**',
  ]) {
    check(`P2b redzone:红区覆盖 ${must}`, redGlobs.includes(must), 'AGENTS §3 清单条目缺失');
  }

  // ⑤ 权限缺口(P1 对抗性评审实证):机器层不得比散文松
  const deny = settings.permissions?.deny ?? [];
  const ask = settings.permissions?.ask ?? [];
  check(
    'P2b perm:--force-with-lease 已 deny',
    deny.some((r) => r.includes('force-with-lease')),
    'deny 只有 --force,而 process §5.4 条 7 明禁 --force-with-lease',
  );
  check(
    'P2b perm:pnpm prisma:migrate 别名已受管',
    ask.some((r) => r.includes('prisma:migrate')),
    '该别名 = prisma migrate dev,原先不命中任何规则',
  );
  check(
    'P2b perm:盲更新快照已受管',
    ask.some((r) => r.includes('updateSnapshot')),
    'AGENTS §1 snapshot SOP 禁盲 -u,原先零机器载体',
  );
  check(
    'P2b perm:settings 与 example 严格同步',
    read('.claude/settings.json') === read('.claude/settings.example.json'),
    '两文件必须逐字节一致(白名单改动须成对可见)',
  );

  // ⑥ P4c 发版脚本的硬边界(设计即约束,不靠自觉)
  {
    const prep = read('scripts/release-prepare.ts');
    const finish = read('scripts/release-finish.ts');
    // 阶段 A 只写文件:不提交、不开 PR、不合并、不打 tag —— 自合门必须留在人手里
    for (const forbidden of ['git commit', 'gh pr create', 'gh pr merge', "'tag'", 'git push']) {
      check(
        `P4c release:阶段 A 不含「${forbidden}」`,
        !prep.includes(forbidden),
        '阶段 A 越界:它只应写文件,提交/开 PR/合并/打 tag 全部交人(自合门)',
      );
    }
    // 阶段 B 不改任何仓库文件(只与 git ref / GitHub 打交道;临时 notes 文件在 tmp/ 内)
    check(
      'P4c release:阶段 B 不写仓库文档',
      !/writeFileSync\([^)]*(CHANGELOG|current-state|package\.json|apply-swagger)/.test(finish),
      '阶段 B 越界:tag/Release 阶段不该再改文件,否则 release PR 的 diff 不可信',
    );
    // 两段都必须 fail-closed
    for (const [name, src] of [
      ['prepare', prep],
      ['finish', finish],
    ] as const) {
      check(
        `P4c release:${name} 具备 fail-closed 退出`,
        src.includes('process.exit(1)'),
        '无法确定时必须停下,不猜',
      );
    }
    // handoff「接续上一版」必须按 semver 数值排序 —— 字符串排序下 v0.9.0 > v0.62.0(实测踩到)
    check(
      'P4c release:handoff 上一版按 semver 数值排序',
      prep.includes('semverKey'),
      '字符串排序会把「接续上一版」指错(v0.9.0 > v0.62.0)',
    );
    // tag 不得被自动移动:已存在但指向不符 → 停下报告
    check(
      'P4c release:已存在的 tag 指向不符时不自动移动',
      finish.includes('不自动移动 tag'),
      'tag 指错是重大异常,必须人工确认',
    );
  }

  // ⑦ 集群级目录视图(pg_locks / pg_stat_activity)必须按当前库收敛。
  // TEMPLATE 克隆使各 worker 库的 pg_class.oid 完全相同(已实测),
  // 不加库谓词的观测会计入别的 worker 的锁 → 并发屏障提前放行 → 测试假绿。
  const DB_SCOPED = /datname\s*=\s*current_database\(\)|lock\.database\s*=|pid\s*=\s*pg_backend_pid\(\)|pid\s*=\s*CAST\(/;
  const e2eDir = path.join(repoRoot, 'test/e2e');
  const offenders: string[] = [];
  for (const file of fs.readdirSync(e2eDir).filter((f) => f.endsWith('.e2e-spec.ts'))) {
    const src = fs.readFileSync(path.join(e2eDir, file), 'utf-8');
    // 逐个模板字面量/查询块检查:含 pg_locks|pg_stat_activity 的片段必须带库/进程谓词
    for (const match of src.split(/\$queryRaw|Prisma\.sql/).slice(1)) {
      const block = match.slice(0, 700);
      if (/FROM\s+pg_(locks|stat_activity)/i.test(block) && !DB_SCOPED.test(block)) {
        offenders.push(`${file}: ${block.replace(/\s+/g, ' ').slice(0, 90)}`);
      }
    }
  }
  check(
    'P1 parallel:pg_locks / pg_stat_activity 观测均按当前库或 pid 收敛',
    offenders.length === 0,
    `未收敛的观测点:\n    ${offenders.join('\n    ')}`,
  );
}

// ---------------------------------------------------------------------------

// R5-05 — Jest discovery/haste map 必须同时隔离两类仓内 worktree
const JEST_CONFIGS = [
  ['unit', unitJestConfig],
  ['contract', contractJestConfig],
  ['e2e', e2eJestConfig],
] as const;
const JEST_IGNORE_KEYS = ['testPathIgnorePatterns', 'modulePathIgnorePatterns'] as const;
const JEST_WORKTREE_PATTERNS = ['<rootDir>/.claude/worktrees/', '<rootDir>/\\.worktrees/'] as const;

for (const [configName, config] of JEST_CONFIGS) {
  for (const ignoreKey of JEST_IGNORE_KEYS) {
    const patterns = config[ignoreKey] ?? [];
    for (const worktreePattern of JEST_WORKTREE_PATTERNS) {
      check(
        `R5-05 jest:${configName}.${ignoreKey} 覆盖 ${worktreePattern}`,
        patterns.includes(worktreePattern),
        `patterns=[${patterns.join(',')}]`,
      );
    }
  }
}

// ---------------------------------------------------------------------------

process.stdout.write(`\n${passCount} passed, ${failures.length} failed\n`);
if (failures.length > 0) process.exit(1);
