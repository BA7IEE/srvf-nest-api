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

import { execFileSync, spawnSync } from 'child_process';
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
  assertConnectedTestDatabase,
  assertDroppableTestDbName,
  assertTestDatabaseUrl,
  type RawQueryClient,
} from '../test/setup/test-db';
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

/**
 * 剥掉注释行,再对源码文本做断言。
 *
 * 为什么必须有(2026-07-29 review findings P2-1):本文件有 7 处「读文件内容 +
 * `.includes(某字符串)`」的静态断言,**没有一处剥注释**。于是只要注释里写了同样的话,
 * 断言就变绿 —— 真实逻辑删没删都一样。
 *
 * 这不是理论风险,同一天已经真实发生两次:
 *   · workflow 文件引用断言,命中了注释里**描述**那个错误的句子
 *   · INC-17 探针,命中了 release-prepare 里**解释这次删除**的注释
 * 两次都是「写断言的人」和「写注释的人」是同一个,当场自摆乌龙。
 *
 * 危险方向是**注释让断言通过**(假绿);反过来「注释让断言误报」只是噪音,
 * 所以只在前一种场景使用本函数。
 */
function codeOnly(text: string, style: 'hash' | 'slash' = 'hash'): string {
  const re = style === 'hash' ? /(^|\s)#.*$/ : /(^|\s)\/\/.*$/;
  return text
    .split('\n')
    .map((l) => l.replace(re, ''))
    .join('\n');
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

async function checkRejects(name: string, fn: () => Promise<unknown>, msgPart: string): Promise<void> {
  try {
    await fn();
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
// F1 — 测试库安全闸(2026-07-29 跨模型评审 finding 1:真实数据破坏风险)
//
// 旧实现是 `url.includes('app_test')`。任何**远程** DATABASE_URL 只要路径含
// 'app_test' 就通过闸门,随后 reset-db.ts 对它 TRUNCATE 55 张业务表。
// 下面第一条用例就是评审给出的那条 URL —— 它必须抛错。
// ---------------------------------------------------------------------------

{
  const expectedDb = deriveTestDbName();
  process.stdout.write(`  · 本 checkout 的派生测试库名:${expectedDb}\n`);

  // ① 评审给出的攻击样例:远程主机 + 含 'app_test' 子串的库名
  const REMOTE_URL = 'postgresql://user:pw@prod.example.com:5432/app_test_prod';
  checkThrows(
    'F1 dburl:远程主机 + app_test 子串库名被拒(旧实现原样放行)',
    () => assertTestDatabaseUrl(REMOTE_URL),
    '不在允许清单内',
  );
  // 报错信息会被贴进 PR / issue,不得把口令一起带出去
  try {
    assertTestDatabaseUrl(REMOTE_URL);
  } catch (e) {
    check(
      'F1 dburl:拒绝信息里的口令已掩码',
      !String((e as Error).message).includes(':pw@'),
      String((e as Error).message),
    );
  }

  // ② host 合法但库名只是「含子串」——旧实现的第二个洞
  checkThrows(
    'F1 dburl:本机主机 + app_test_prod 库名仍被拒(子串 ≠ 相等)',
    () => assertTestDatabaseUrl('postgresql://postgres:postgres@localhost:5432/app_test_prod'),
    '库名必须严格等于',
  );
  checkThrows(
    'F1 dburl:开发库 app 被拒',
    () => assertTestDatabaseUrl('postgresql://postgres:postgres@localhost:5432/app'),
    '库名必须严格等于',
  );
  checkThrows('F1 dburl:未设置被拒', () => assertTestDatabaseUrl(undefined), '未设置');
  checkThrows(
    'F1 dburl:非法 URL 被拒(无法判定目标 ≠ 放行)',
    () => assertTestDatabaseUrl('not-a-url'),
    '不是合法 URL',
  );
  checkThrows(
    'F1 dburl:非 postgres 协议被拒',
    () => assertTestDatabaseUrl('mysql://localhost:3306/app_test'),
    '协议必须是',
  );

  // ③ 反向:当前真实派生库名必须原样通过(闸门不能把正常路径判死)
  {
    let threw = '';
    try {
      assertTestDatabaseUrl(
        `postgresql://postgres:postgres@localhost:5432/${expectedDb}?schema=public&connection_limit=5`,
      );
    } catch (e) {
      threw = (e as Error).message;
    }
    check(`F1 dburl:当前真实派生库名 '${expectedDb}' 通过`, threw === '', threw);
  }

  // ④ 建/删库的名字闸:只允许本 checkout 派生的那一族
  const template = deriveTemplateTestDbName();
  {
    let threw = '';
    try {
      assertDroppableTestDbName(template);
      assertDroppableTestDbName(`${template}_w7`);
    } catch (e) {
      threw = (e as Error).message;
    }
    check('F1 dbname:模板库与 _w<N> 克隆库允许 CREATE/DROP', threw === '', threw);
  }
  checkThrows(
    'F1 dbname:开发库 app 拒绝 CREATE/DROP',
    () => assertDroppableTestDbName('app'),
    '只允许本 checkout 派生的库',
  );
  checkThrows(
    'F1 dbname:别的 lane 的派生库拒绝 CREATE/DROP(旧 startsWith 会放行)',
    () => assertDroppableTestDbName('app_test_some_other_lane_abc123'),
    '只允许本 checkout 派生的库',
  );
  checkThrows(
    'F1 dbname:三位 worker 号不在派生族内',
    () => assertDroppableTestDbName(`${template}_w123`),
    '只允许本 checkout 派生的库',
  );
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
  // 剥注释后再判 —— 否则注释里写一句同样的话,断言就绿了(见 codeOnly 的说明)
  const ci = codeOnly(read('.github/workflows/ci.yml'));
  const nightly = codeOnly(read('.github/workflows/nightly-e2e-leaks.yml'));
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
// P4b — generate-codemap.ts 正向对照
//
// 生成器的危险不在「算错数字」(那会被 --check 当场抓到),而在 **吃掉人工列** ——
// CODEMAP 的价值 90% 在「主要风险 / 本地铁律」那几列散文里,一次贪心的正则就能
// 把它们抹平,而且抹平后 --check 依然全绿(生成器跟自己比,永远一致)。
// 所以这里断言的是「人工列逐字不变」与「篡改必被抓」两件事,不是数字对不对。
// ---------------------------------------------------------------------------
{
  const REPO_ROOT = path.resolve(__dirname, '..');
  const codemapPath = path.join(REPO_ROOT, 'CODEMAP.md');
  const gen = path.join(REPO_ROOT, 'scripts', 'generate-codemap.ts');
  const original = fs.readFileSync(codemapPath, 'utf8');

  /** 抽出全部模块行的人工四列(职责 / 风险 / 本地约束),用于逐字比对。 */
  const humanCells = (doc: string): string => {
    const out: string[] = [];
    let inSec = false;
    for (const line of doc.split('\n')) {
      if (line.startsWith('## src/modules/')) { inSec = true; continue; }
      if (inSec && line.startsWith('## ')) break;
      if (!inSec) continue;
      const m = /^\|\s*`([a-z0-9-]+)\/`\s*\|/.exec(line);
      if (!m) continue;
      const cells = line.split('|');
      if (cells.length !== 7) continue;
      // cells[2] = 体量(生成物,跳过);cells[3..5] = 人工列
      out.push(`${m[1]}::${cells.slice(3, 6).join('|')}`);
    }
    return out.join('\n');
  };

  const runGen = (args: string[]): { code: number; out: string } => {
    const r = spawnSync('npx', ['tsx', gen, ...args], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: { ...process.env, npm_config_yes: 'true' },
    });
    return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };

  try {
    // 1) 反向案例:未改动时 --check 必须绿(误报会摧毁守护可信度)
    checkEq('P4b codemap:--check 干净树为 0', runGen(['--check']).code, 0);

    // 2) 幂等:再生成一次不应产生 diff
    runGen([]);
    checkEq(
      'P4b codemap:生成幂等(第二次无改动)',
      fs.readFileSync(codemapPath, 'utf8'),
      original,
    );

    // 3) 正向对照:体量列被篡改 → --check 必须 exit 1
    const tampered = original.replace(
      /^(\|\s*`activities\/`\s*\|)[^|]*\|/m,
      '$1 S 1L |',
    );
    check('P4b codemap:篡改样本确实改动了文本', tampered !== original);
    fs.writeFileSync(codemapPath, tampered, 'utf8');
    const bad = runGen(['--check']);
    checkEq('P4b codemap:体量列被篡改 → --check exit 1', bad.code, 1);
    check(
      'P4b codemap:--check 打印出问题行',
      bad.out.includes('activities/'),
      bad.out.slice(0, 300),
    );

    // 4) 关键断言:重新生成后,人工四列必须逐字复原(生成器不吃散文)
    fs.writeFileSync(codemapPath, tampered, 'utf8');
    runGen([]);
    checkEq(
      'P4b codemap:重新生成后人工列逐字不变',
      humanCells(fs.readFileSync(codemapPath, 'utf8')),
      humanCells(original),
    );
  } finally {
    // 自复原:selftest 绝不留下被篡改的仓库文件
    fs.writeFileSync(codemapPath, original, 'utf8');
  }
}

// ---------------------------------------------------------------------------
// review P2-1 — codeOnly 自身的阳性对照(守护的守护)
//
// 剥注释这件事本身也可能写错。用合成样例直接验:注释里的句子必须消失,
// 代码里的同一句必须留下 —— 否则「剥注释」会从治假绿变成造假红。
// ---------------------------------------------------------------------------
{
  const yaml = ['run: echo "红区扫描未成功"', '# 注释里也提到 红区扫描未成功', 'x: 1'].join('\n');
  const stripped = codeOnly(yaml);
  check(
    'P2-1 codeOnly:注释里的句子被剥掉',
    stripped.split('\n')[1].trim() === '',
    stripped.split('\n')[1],
  );
  check(
    'P2-1 codeOnly:代码里的同一句必须保留(不能剥过头)',
    stripped.includes('run: echo "红区扫描未成功"'),
  );
  const ts = ['const a = 1;', '// 注释 no-use-guards', 'const b = "no-use-guards";'].join('\n');
  const strippedTs = codeOnly(ts, 'slash');
  check(
    'P2-1 codeOnly:slash 风格同样生效且不误伤字符串',
    strippedTs.split('\n')[1].trim() === '' && strippedTs.includes('const b = "no-use-guards";'),
  );
}

// ---------------------------------------------------------------------------
// P6 — changelog fragment 形态判定
//
// 立项证据:2026-07-28/29 通宵 8 个 PR,**每一个都在 CHANGELOG 上撞冲突**。
// fragment 机制 Harness 2.0 就建好了,当晚一个都没人用(包括我)。
// 反向用例在这里尤其重要:**发版收口本身要改 CHANGELOG** ——
// 若不豁免,发版会永远过不了自己这道门(而那种门迟早被整个关掉)。
// ---------------------------------------------------------------------------
{
  const { judgeChangelog } = require('./check-changelog-fragment') as {
    judgeChangelog: (
      changed: readonly string[],
      unreleasedTouched: boolean,
      versionBumped: boolean,
      fragmentsDeleted: boolean,
    ) => { ok: boolean; reason: string };
  };
  const cases: Array<[string, boolean, { ok: boolean; reason: string }]> = [
    [
      'P6 changelog:直接改 Unreleased 且无 fragment → 拦',
      false,
      judgeChangelog(['CHANGELOG.md', 'src/x.ts'], true, false, false),
    ],
    [
      'P6 changelog:提供了 fragment → 放行',
      true,
      judgeChangelog(['CHANGELOG.md', 'changelog.d/my-lane.md'], true, false, false),
    ],
    [
      'P6 changelog:只给 fragment 不碰 CHANGELOG → 放行',
      true,
      judgeChangelog(['changelog.d/my-lane.md', 'src/x.ts'], false, false, false),
    ],
    [
      'P6 changelog:反向 — 发版收口(归并 fragment + bump 版本)必须放行',
      true,
      judgeChangelog(['CHANGELOG.md', 'package.json', 'changelog.d/a.md'], true, true, true),
    ],
    [
      'P6 changelog:反向 — 只改历史版本段(不碰 Unreleased)放行',
      true,
      judgeChangelog(['CHANGELOG.md'], false, false, false),
    ],
    [
      'P6 changelog:反向 — 完全不碰 CHANGELOG 放行',
      true,
      judgeChangelog(['src/x.ts', 'docs/testing.md'], false, false, false),
    ],
    [
      'P6 changelog:fragment 目录的 README 不算 fragment',
      false,
      judgeChangelog(['CHANGELOG.md', 'changelog.d/README.md'], true, false, false),
    ],
    [
      'P6 changelog:只 bump 版本但没归并 fragment → 仍拦(不是发版形态)',
      false,
      judgeChangelog(['CHANGELOG.md', 'package.json'], true, true, false),
    ],
  ];
  for (const [name, wantOk, got] of cases) check(name, got.ok === wantOk, `reason=${got.reason}`);
}

// ---------------------------------------------------------------------------
// P2c — CI 接线的 fail-open 面(与 INC-09 同一类:skipped ≠ 通过)
// ---------------------------------------------------------------------------
{
  // 同样剥注释:本块下面每一条都是 `ci.includes(某句错误文案)`,
  // 而那些文案在注释里也出现过 —— 不剥的话,删掉真实逻辑只留注释,断言照样绿。
  const ci = codeOnly(
    fs.readFileSync(path.resolve(__dirname, '..', '.github/workflows/ci.yml'), 'utf-8'),
  );
  const cases: Array<[string, boolean, string]> = [
    [
      'P2c ci:gate 依赖 redzone-scan 与 redzone-approval',
      /needs:\s*\[changeset, fast, slow, redzone-scan, redzone-approval\]/.test(ci),
      'gate 不依赖这两个 job = 审批不影响放行,门形同虚设',
    ],
    [
      'P2c ci:scan 未成功即拒绝放行(无法验证 ≠ 通过)',
      ci.includes('红区扫描未成功'),
      'scan 失败时若不拦,等于在没查的情况下宣布没触碰(INC-07 同型)',
    ],
    [
      'P2c ci:approval 跳过必须由 touched=false 正面证明',
      ci.includes("case \"$touched\" in") && ci.includes('未触碰红区却跑了审批'),
      '从 skipped 反推「没触碰」= INC-09 原样复发',
    ],
    [
      'P2c ci:touched 无明确结论时 fail-closed',
      ci.includes('未给出明确结论'),
      'touched 为空/error 时若放行,scan 崩溃就等于绕过整层',
    ],
    [
      'P2c ci:approval job 挂 harness-review 环境',
      /redzone-approval:[\s\S]*?environment:\s*harness-review/.test(ci),
      '不挂环境 = 无人审批,job 直接绿',
    ],
    [
      'P2c ci:scan 用全深度 checkout(浅克隆算不出 base...HEAD)',
      /redzone-scan:[\s\S]*?fetch-depth:\s*0/.test(ci),
      '浅克隆下 diff 会算错或报错,进而 fail-closed 卡住所有 PR',
    ],
    [
      // 实测踩到:新 job 里写了 `node-version-file: .nvmrc`,而本仓没有 .nvmrc,
      // scan job 当场失败(且因为 fail-closed,连带整个 gate 拒绝放行)。
      // 凡 CI 引用仓内文件,该文件必须真的存在 —— 这条能静态判,就别留给 CI 去发现。
      'P2c ci:workflow 引用的仓内文件必须存在',
      (() => {
        // `ci` 在本块开头已经过 codeOnly 剥注释 —— 否则「注释里**描述**这个错误」
        // 的那句话自己会被判成配置(实测踩到过)。
        const refs = [
          ...ci.matchAll(/(?:node-version-file|env-file|args-file):\s*([^\s#]+)/g),
        ].map((m) => m[1]);
        return refs.every((r) => fs.existsSync(path.resolve(__dirname, '..', r)));
      })(),
      'workflow 指向不存在的文件 → 该 job 直接失败',
    ],
    [
      'P2c ci:两个 required check 名逐字未动',
      ci.includes('name: Lint / Typecheck / E2E') && ci.includes('name: Docker image build'),
      'branch protection 逐字锁这两个名字,改名 = 全仓 PR 永久卡死(含维护者本人)',
    ],
  ];
  for (const [name, ok, why] of cases) check(name, ok, why);
}

// ---------------------------------------------------------------------------
// F3 — 独立裁判(pull_request_target,base-trusted)的三条禁令
//
// pull_request_target 能拿到 secrets,而 PR 可以来自任何人。历史上几乎所有该
// 触发器的事故都是同一形态:**先 checkout 了 PR 代码,再在有 secrets 的上下文
// 里跑它**(装依赖 = 执行 PR 的 lifecycle script;跑构建 = 执行 PR 的配置)。
//
// 下面每条都在**剥掉注释之后**判 —— workflow 顶部的禁令注释里逐字写着
// 「不跑 pnpm install」,不剥注释的话,这条断言会被那句注释自己满足/推翻
// (#817 的 comment-satisfiable 教训,本仓一天内栽过四次)。
// ---------------------------------------------------------------------------

{
  const repoRoot = path.resolve(__dirname, '..');
  const ymlRaw = fs.readFileSync(
    path.join(repoRoot, '.github/workflows/redzone-trusted.yml'),
    'utf-8',
  );
  const judgeRaw = fs.readFileSync(
    path.join(repoRoot, '.github/workflows/redzone-trusted-judge.mjs'),
    'utf-8',
  );
  const yml = codeOnly(ymlRaw, 'hash');
  const judge = codeOnly(judgeRaw, 'slash');

  const cases: Array<[string, boolean, string]> = [
    [
      'F3 trusted:用 pull_request_target 触发(裁判必须跑 base 的定义)',
      yml.includes('pull_request_target:'),
      '普通 pull_request 触发时 workflow 也来自 PR —— 又变成自考自评',
    ],
    // ── 禁令①:绝不 checkout PR 代码 ──
    [
      'F3 禁令①:不出现 github.event.pull_request.head(绝不 checkout PR 代码)',
      !yml.includes('pull_request.head'),
      'checkout PR head/merge ref = 把 PR 的代码放进有 secrets 的进程,这是该触发器的头号事故形态',
    ],
    [
      'F3 禁令①:checkout 显式钉在 base_ref 上',
      yml.includes('ref: ${{ github.base_ref }}'),
      '不写 ref 会用默认引用;显式写死 base_ref 才能让「没 checkout PR」看得见、可断言',
    ],
    [
      'F3 禁令①:checkout 只有一处(不留第二个 checkout 偷偷拉 PR)',
      (yml.match(/uses:\s*actions\/checkout/g) ?? []).length === 1,
      '多一个 checkout 就多一次把 PR 代码拉进来的机会',
    ],
    // ── 禁令②:绝不安装 PR 依赖 ──
    [
      'F3 禁令②:不装任何依赖(pnpm/npm/yarn install 均不得出现)',
      !/\b(pnpm|npm|yarn)\s+(install|ci)\b/.test(yml) && !yml.includes('pnpm/action-setup'),
      '装依赖会执行 PR 锁文件里的 lifecycle script —— 等于在有 secrets 的上下文里跑 PR 的代码',
    ],
    // ── 禁令③:绝不执行 PR 内任何脚本 ──
    [
      'F3 禁令③:裁判脚本取自 base checkout 的固定路径',
      yml.includes('node .github/workflows/redzone-trusted-judge.mjs'),
      '裁判必须是 base 上的那一份;跑 PR 提供的脚本就是 finding 2 本身',
    ],
    [
      'F3 禁令③:裁判只 import node: 内置模块(不碰 node_modules)',
      (judgeRaw.match(/^import .* from '([^']+)'/gm) ?? []).every((l) => l.includes("from 'node:")),
      '一旦 import 第三方包就必须装依赖,禁令②随之破功',
    ],
    // ── 权限与判法 ──
    [
      'F3 trusted:权限只读',
      /permissions:\s*\n\s*contents:\s*read\s*\n\s*pull-requests:\s*read/.test(yml) &&
        !/permissions:[\s\S]{0,120}write/.test(yml),
      'pull_request_target 默认给写权限;不收紧就等于把写权限暴露在最危险的触发器上',
    ],
    [
      'F3 trusted:required context 名逐字为 Red-zone (trusted)',
      yml.includes('name: Red-zone (trusted)'),
      '维护者会把这个名字增量 POST 进 branch protection;改名 = 该门永久报不出来',
    ],
    [
      'F3 trusted:approval 跳过必须由 required=false 正面证明(不从 skipped 反推)',
      yml.includes("required='${{ needs.scan.outputs.required }}'") &&
        yml.includes('无法验证 ≠ 通过'),
      'scan 失败时 required 是空串,若从 skipped 反推就会在「没查出来」时放行(INC-07)',
    ],
    // ── 裁判本体的三条不变式 ──
    [
      'F3 judge:rename 判新旧两条路径',
      judge.includes('previous_filename'),
      '只判新路径的话,`git mv 受保护文件 非保护路径` 就能把文件挪出保护区而不触发审批',
    ],
    [
      'F3 judge:变更清单翻页且与 changed_files 对账(禁静默截断)',
      judge.includes('--paginate') && judge.includes('expectedCount'),
      'pulls/files 端点上限 3000 且**静默**截断;不对账就会在超大 PR 上漏判',
    ],
    [
      'F3 judge:裁判自身/判据/CI 配置无条件要求审批(硬编码,不从 registry 读)',
      judge.includes('ALWAYS_REQUIRE_APPROVAL') &&
        judge.includes("'.github/workflows/**'") &&
        judge.includes("'harness/redzone.json'"),
      'registry 若被读坏或条目被挪走,碰裁判自身仍必须惊动维护者',
    ],
    [
      'F3 judge:异常一律 fail-closed(要求审批)',
      judge.includes('failClosed') && judge.includes("emit('required', 'true')"),
      '「查不出来」永远不等于「没触碰」',
    ],
  ];
  for (const [name, ok, why] of cases) check(name, ok, why);

  // 顶部禁令注释本身也必须在(这条刻意判**原文**:它要的就是那段给人读的说明)。
  // 它与上面每条行为断言是两回事 —— 上面判「事实如此」,这条判「说明还在」。
  check(
    'F3 trusted:顶部三条禁令的醒目注释未被删除',
    ymlRaw.includes('pull_request_target') &&
      ymlRaw.includes('绝不 checkout PR 代码') &&
      ymlRaw.includes('绝不安装 PR 依赖') &&
      ymlRaw.includes('绝不执行 PR 内任何脚本'),
    '下一个改这个文件的人必须先读到危险性说明;注释没了,禁令就只剩断言在守',
  );
}

// ---------------------------------------------------------------------------
// P2c — CI 侧红区检测 与 hook 的**裁决一致性**(parity)
//
// 两套实现判同一份 harness/redzone.json:hook 用 bash case,CI 用 TS 正则。
// 各自演化就会出现「一边拦一边放」—— 那比没有守护更糟,因为人会以为已经管住了。
// 这里对一组覆盖每类条目的路径逐条比对两边裁决,任何分歧当场红。
// ---------------------------------------------------------------------------
{
  const REPO = path.resolve(__dirname, '..');
  const grantFile = execFileSync('git', ['rev-parse', '--git-path', 'srvf-redzone-grant.json'], {
    encoding: 'utf-8',
    cwd: REPO,
  }).trim();
  const grantAbs = path.isAbsolute(grantFile) ? grantFile : path.join(REPO, grantFile);
  const bak = `${grantAbs}.parity-bak`;
  const hadGrant = fs.existsSync(grantAbs);
  if (hadGrant) fs.renameSync(grantAbs, bak);

  try {
    // 覆盖:每个 redzone 组各一 + selfGuard 各类 + archive 新建/改既有 + 日常放行路径
    const FIXTURES = [
      'AGENTS.md',
      'CLAUDE.md',
      '.claude/CLAUDE.md',
      'docs/api-surface-policy.md',
      '.github/workflows/ci.yml',
      'prisma/schema.prisma',
      'prisma/migrations/20260101_x/migration.sql',
      'prisma/seed.ts',
      'src/common/guards/jwt-auth.guard.ts',
      'src/bootstrap/apply-global-setup.ts',
      'src/modules/auth/auth.service.ts',
      'src/modules/storage/storage-crypto.service.ts',
      'Dockerfile',
      'docker-compose.yml',
      '.env.test',
      // F2 — CI 控制面与生产入口(2026-07-29 跨模型评审:此前 12/12 全不在保护内)
      'pnpm-lock.yaml',
      'eslint.config.mjs',
      'tsconfig.json',
      'test/tsconfig.test.json',
      'scripts/tsconfig.json',
      'prisma/tsconfig.eslint.json',
      'test/jest-e2e.config.ts',
      'nest-cli.json',
      'scripts/harness-needs.ts',
      'src/main.ts',
      'src/app.module.ts',
      'src/modules/authz/authz.service.ts',
      'src/common/decorators/login-throttle.decorator.ts',
      'scripts/release-prepare.ts',
      'scripts/release-finish.ts',
      'harness/redzone.json',
      'harness/incidents.json',
      '.claude/hooks/redzone-guard.sh',
      '.claude/settings.json',
      'eslint.harness.mjs',
      'scripts/check-codemap.ts',
      'scripts/check-redzone.ts',
      'scripts/harness-eslint.selftest.ts',
      'scripts/agent-preflight.sh',
      'scripts/docs-counts.ts',
      'scripts/harness-grant.ts',
      'scripts/generate-codemap.ts',
      'scripts/replay-incidents.ts',
      'scripts/changelog-merge.ts',
      'test/setup/test-app.ts',
      'test/contract/openapi.contract-spec.ts',
      'docs/archive/plans/harness-3.0-blueprint.md',
      'docs/archive/plans/definitely-brand-new-file.md',
      'src/modules/users/users.service.ts',
      'test/e2e/users.e2e-spec.ts',
      'docs/testing.md',
      'CHANGELOG.md',
      'package.json',
    ];

    const hookBlocks = (rel: string): boolean => {
      const r = spawnSync(path.join(REPO, '.claude/hooks/redzone-guard.sh'), {
        input: JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: rel } }),
        encoding: 'utf-8',
        cwd: REPO,
      });
      return r.status === 2;
    };

    // 与 hook 同口径:它按「磁盘上文件是否存在」决定 archive 的新建豁免
    const judge = (
      require('./check-redzone') as {
        judge: (rel: string, added: boolean) => unknown;
      }
    ).judge;

    let mismatches = 0;
    for (const rel of FIXTURES) {
      const added = !fs.existsSync(path.join(REPO, rel));
      const ci = judge(rel, added) !== null;
      const hook = hookBlocks(rel);
      if (ci !== hook) {
        mismatches++;
        failures.push(
          `✗ P2c parity 分歧:${rel} — hook ${hook ? '拦' : '放'} / CI ${ci ? '拦' : '放'}` +
            '(两侧裁决必须逐条一致,否则会出现「一边拦一边放」)',
        );
      }
    }
    check(
      `P2c redzone parity:${FIXTURES.length} 条路径 hook 与 CI 裁决一致`,
      mismatches === 0,
      `${mismatches} 条分歧`,
    );
  } finally {
    if (hadGrant && fs.existsSync(bak)) fs.renameSync(bak, grantAbs);
  }
}

// ---------------------------------------------------------------------------
// F1 — 「连接建立之后」的求证(assertConnectedTestDatabase)
//
// 这一层是给 URL 判定兜底的:URL 只表达**意图**,DNS 劫持 / 端口转发能让一条
// 完全合规的 URL 落到别的机器上。用假客户端喂各种服务器回答,断言裁决 ——
// 不需要真数据库,所以能进 CI 的 fast job(harness:selftest)。
// ---------------------------------------------------------------------------

async function runConnectedDbAssertions(): Promise<void> {
  const expectedDb = deriveTestDbName();
  const fakeClient = (rows: unknown): RawQueryClient => ({
    $queryRawUnsafe: <T = unknown,>(): Promise<T> => Promise.resolve(rows as T),
  });

  // 正常路径:库名对上 + 服务端地址在 docker 网桥段 / unix socket
  for (const [label, srv] of [
    ['docker 网桥地址', '192.168.97.2'],
    ['环回地址', '127.0.0.1'],
    ['unix socket(inet_server_addr 为 NULL)', null],
  ] as const) {
    let threw = '';
    try {
      await assertConnectedTestDatabase(fakeClient([{ db: expectedDb, srv }]), expectedDb);
    } catch (e) {
      threw = (e as Error).message;
    }
    check(`F1 connected:${label} + 库名一致 → 放行`, threw === '', threw);
  }

  // 连到了同一台机器上的别的库(URL 判定看不见这种情况)
  await checkRejects(
    'F1 connected:current_database() 与预期不符 → 拒',
    () => assertConnectedTestDatabase(fakeClient([{ db: 'app', srv: '127.0.0.1' }]), expectedDb),
    '已连接的库与预期不符',
  );
  // 库名恰好对上,但服务器在公网 —— 正是「URL 合规却落到别处」的形态
  await checkRejects(
    'F1 connected:服务端为公网地址 → 拒(即使库名对上)',
    () =>
      assertConnectedTestDatabase(fakeClient([{ db: expectedDb, srv: '13.250.1.1' }]), expectedDb),
    '公网可路由地址',
  );
  // 问不出答案 ≠ 通过(INC-07 的同一课)
  await checkRejects(
    'F1 connected:查不到 current_database() → 拒(无法验证 ≠ 通过)',
    () => assertConnectedTestDatabase(fakeClient([]), expectedDb),
    '无法向 Postgres 求证',
  );
}

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// F3 — trusted 裁判的**行为**断言(不是 grep 源码字符串)
//
// 上面那组 F3 断言判的是「文件里有没有那行」。这一组直接 import 裁判的纯函数,
// 喂合成的变更清单,断言它的**裁决**。区别在 finding 4 这种场景上尤其要紧:
// `judge.includes('previous_filename')` 只能证明那个词出现过,证明不了
// 「rename 出保护区确实会被拦」。
// ---------------------------------------------------------------------------

async function runTrustedJudgeAssertions(): Promise<void> {
  const judge = (await import('../.github/workflows/redzone-trusted-judge.mjs')) as {
    collectHits: (
      files: Array<{ filename: string; status: string; previous_filename?: string }>,
      entries: unknown[],
    ) => Array<{ file: string; id: string }>;
    flattenRegistry: (reg: unknown) => unknown[];
    ALWAYS_REQUIRE_APPROVAL: string[];
  };
  const reg = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, '../harness/redzone.json'), 'utf-8'),
  ) as unknown;
  const entries = judge.flattenRegistry(reg);
  const hitsOf = (
    files: Array<{ filename: string; status: string; previous_filename?: string }>,
    ent: unknown[] = entries,
  ): string[] => judge.collectHits(files, ent).map((h) => h.file);

  // finding 4:把受保护文件 rename 到非保护路径 —— 只判新路径就会漏
  check(
    'F3 行为:rename「受保护 → 非保护」被拦(判旧路径)',
    hitsOf([
      { filename: 'docs/moved-out.md', status: 'renamed', previous_filename: 'AGENTS.md' },
    ]).includes('AGENTS.md'),
    'git mv 受保护文件 非保护路径 必须仍然触发审批',
  );
  check(
    'F3 行为:rename「非保护 → 受保护」被拦(判新路径)',
    hitsOf([
      { filename: 'AGENTS.md', status: 'renamed', previous_filename: 'docs/whatever.md' },
    ]).includes('AGENTS.md'),
    '反方向同样要拦 —— 否则可以把任意内容改名成受保护文件',
  );
  // 反向:日常路径不得误伤(误伤到让人绕过的程度,防线同样失效)
  check(
    'F3 行为:普通业务文件不被拦',
    hitsOf([
      { filename: 'src/modules/users/users.service.ts', status: 'modified' },
      { filename: 'test/e2e/users.e2e-spec.ts', status: 'modified' },
      { filename: 'docs/testing.md', status: 'modified' },
      { filename: 'changelog.d/whatever.md', status: 'added' },
    ]).length === 0,
    '日常路径被误拦会训练出「无视门禁」的习惯',
  );
  // allowCreate:archive 新建放行、改既有拦下
  check(
    'F3 行为:archive 新建放行 / 改既有拦下',
    hitsOf([{ filename: 'docs/archive/plans/brand-new.md', status: 'added' }]).length === 0 &&
      hitsOf([{ filename: 'docs/archive/plans/existing.md', status: 'modified' }]).length === 1,
    'allowCreate 语义必须与 hook / CI 侧一致',
  );
  // 硬编码兜底:即使 registry 被读成空,碰裁判自身仍要审批
  check(
    'F3 行为:registry 为空时,碰裁判自身/判据仍无条件要求审批',
    hitsOf(
      [
        { filename: '.github/workflows/redzone-trusted.yml', status: 'modified' },
        { filename: '.github/workflows/redzone-trusted-judge.mjs', status: 'modified' },
        { filename: 'harness/redzone.json', status: 'modified' },
      ],
      [],
    ).length === 3,
    'ALWAYS_REQUIRE_APPROVAL 必须独立于 registry —— 条目被挪走也不能让裁判自身失守',
  );
  // F2 新加的 glob 在 trusted 侧同样生效(证明 matchesGlob 认得 *-throttle.decorator.ts)
  check(
    'F3 行为:F2 新增的限流装饰器 / authz glob 在 trusted 裁判侧同样命中',
    hitsOf([
      { filename: 'src/common/decorators/login-throttle.decorator.ts', status: 'modified' },
      { filename: 'src/modules/authz/authz.service.ts', status: 'modified' },
      { filename: 'package.json', status: 'modified' },
    ]).length === 3,
    '三处消费者若对同一条 glob 判得不一样,就又回到「一边拦一边放」',
  );
}

void (async (): Promise<void> => {
  await runConnectedDbAssertions();
  await runTrustedJudgeAssertions();
  process.stdout.write(`\n${passCount} passed, ${failures.length} failed\n`);
  if (failures.length > 0) process.exit(1);
})();
