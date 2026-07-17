/**
 * harness-guards.selftest.ts — Harness 机器层守卫回归自测(第五轮 review R5-02/03/04)
 *
 * 把冻结报告 docs/archive/reviews/full-repo-fifth-review-v0.57.0.md §2.2/§5 列出的
 * 每个绕过 / 失败样例固化为断言,逐一验证已被杀死;后续任何人改回词法计数 / 放松校验 /
 * 去掉哈希段,本自测即红。
 *
 * 运行:`pnpm tsx scripts/harness-guards.selftest.ts`(exit 0 全过 / exit 1 有失败)。
 * 形态说明:jest unit 配置只覆盖 src/**;沿 goal 拍板不动 jest 配置,以可执行自测脚本承载。
 * preflight(R5-08)的参数 / bump 特征回归在 scripts/agent-preflight.selftest.sh。
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  checkFragment,
  mergeIntoChangelog,
} from './changelog-merge';
import {
  countAuditLogEventMembers,
  countDecoratorUsage,
  countExpectedRoutesInSource,
  countHttpStatusProps,
  countRbacRoleUpserts,
  diffSeedPermissionExtractions,
  extractSeedPermissionCodesAst,
} from './docs-counts';
import { deriveTestDbNameFrom } from '../test/setup/worktree-db';

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

checkEq('R5-04 db:主仓恒 app_test(行为零变化)', deriveTestDbNameFrom('/repo/main', false), 'app_test');

// 样例:lane-a 与 lane_a 曾同为 app_test_lane_a
{
  const a = deriveTestDbNameFrom('/w/lane-a', true);
  const b = deriveTestDbNameFrom('/w/lane_a', true);
  check('R5-04 db:lane-a 与 lane_a 不再共库', a !== b, `${a} == ${b}`);
  check('R5-04 db:派生名保留 app_test_ 前缀(安全护栏不破)', a.startsWith('app_test_') && b.startsWith('app_test_'));
}
// 样例:两个共享前 40 字符的名称曾同 slug
{
  const prefix = 'x'.repeat(40);
  const p1 = deriveTestDbNameFrom(`/w/${prefix}-one`, true);
  const p2 = deriveTestDbNameFrom(`/w/${prefix}-two`, true);
  check('R5-04 db:40 字符共同前缀不再共库', p1 !== p2, `${p1} == ${p2}`);
  check('R5-04 db:长名派生仍 ≤ PostgreSQL 63 字符上限', p1.length <= 63 && p2.length <= 63, `${p1.length}`);
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

process.stdout.write(`\n${passCount} passed, ${failures.length} failed\n`);
if (failures.length > 0) process.exit(1);
