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
import * as os from 'os';
import * as path from 'path';
import { checkFragment, mergeIntoChangelog } from './changelog-merge';
import {
  checkAiHarnessIndex,
  checkServiceSize,
  extractSectionAfter,
  isSizedUnit,
  measureNcloc,
  mentionsDocName,
  serviceSizeInputDigest,
  siblingLinkTargets,
  type ServiceEntry as SizedUnit,
  type ServiceSizeBaseline,
} from './check-codemap';
import {
  buildClosure,
  comparePolicy,
  diffManifests,
  extractManifest as extractAuthzManifest,
  judgeDeclarations as judgeAuthzDeclarations,
  parseCodeUniverse as parseAuthzCodeUniverse,
  parseDeclarations as parseAuthzDeclarations,
  validateGraph as validateAuthzGraph,
  type Manifest as AuthzManifest,
  type Policy as AuthzPolicy,
} from './authz-semantic-diff';
import {
  BREAKING_TABLE,
  diffContracts,
  judgeDeclarations as judgeContractDeclarations,
  parseDeclarations as parseContractDeclarations,
} from './contract-semantic-diff';
import {
  computeInputDigest as computeFeClientDigest,
  renderAll as renderFeClients,
  validateEmitted as validateFeClient,
} from './generate-fe-client';
import {
  SEED_FACTS_CLOSURE as DOCS_COUNTS_SEED_FACTS_CLOSURE,
  assertSeedFactsClosure,
  countAuditLogEventMembers,
  countDecoratorUsage,
  countExpectedRoutesInSource,
  countHttpStatusProps,
  countRbacRoleUpserts,
  diffSeedFactsPermissionExtractions,
  diffSeedPermissionExtractions,
  extractSeedFactsPermissionCodesAst,
  extractSeedPermissionCodesAst,
  readSeedFactsClosure,
} from './docs-counts';
import { SEED_FACTS_CLOSURE as RBAC_MAP_SEED_FACTS_CLOSURE } from './generate-rbac-map';
import { SEED_FACTS_CLOSURE as RBAC_CHECK_SEED_FACTS_CLOSURE } from './check-rbac-map';
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
import * as ts from 'typescript';
import contractJestConfig from '../test/jest-contract.config';
import e2eJestConfig from '../test/jest-e2e.config';
import unitJestConfig from '../test/jest-unit.config';
import { probeDelegateResolution } from './check-boundaries';

let passCount = 0;
const failures: string[] = [];

/**
 * 已知缺口登记(沿 harness-eslint.selftest 的 knownGap 范式)。
 *
 * 语义与 check() 相反:登记的是「现状如此」而不是「这样对」。每条都由一个**真探针**
 * 证明缺口**仍然存在** —— 缺口一旦被修好,探针翻面 → 本自测红 → 逼人来摘登记。
 * 缺口关闭这件事因此不会被忘记,登记也不会退化成一段没人维护的散文。
 */
const knownGaps: Array<{ id: string; text: string }> = [];

function knownGap(id: string, stillOpen: boolean, text: string, closedHint: string): void {
  if (stillOpen) {
    knownGaps.push({ id, text });
    return;
  }
  failures.push(`已知缺口 ${id} 似乎已关闭 —— 请摘掉登记`);
  process.stderr.write(`✗ 已知缺口 ${id} 似乎已关闭 —— 请摘掉登记:${closedHint}\n`);
}

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

async function checkRejects(
  name: string,
  fn: () => Promise<unknown>,
  msgPart: string,
): Promise<void> {
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

// seed 事实闭包必须由三个独立解析器精确具名；漏掉 facts 时 14 条 rbac.* 必须立刻显形。
{
  const expectedClosure = ['prisma/seed.ts', 'src/modules/permissions/rbac-seed-facts.ts'];
  const closures = [
    DOCS_COUNTS_SEED_FACTS_CLOSURE,
    RBAC_MAP_SEED_FACTS_CLOSURE,
    RBAC_CHECK_SEED_FACTS_CLOSURE,
  ];
  check(
    'R5-02 权限码:三解析器 seed 事实闭包逐项一致',
    closures.every(
      (closure) =>
        closure.length === expectedClosure.length &&
        closure.every((file, index) => file === expectedClosure[index]),
    ),
  );

  const closureSources = readSeedFactsClosure();
  const closureDiff = diffSeedFactsPermissionExtractions(closureSources);
  // 第七轮评审 R7-A-01(2026-08-21):member.correct.identity 入目录 ⇒ 236 → 237、222 → 223。
  // 两个数字都是**随新增码正常上移**的基线,不是不变量;真正的不变量是下方 checkEq 的
  // 差值恒 14(= rbac-seed-facts.ts 独有的 14 条 rbac.* 码)—— 剔除 facts 后必须正好少这 14 条,
  // 少于 14 说明 facts 里的码漏进了 seed.ts,多于 14 说明闭包提取器把别处的码算了进来。
  const FACTS_ONLY_RBAC_CODE_COUNT = 14;
  const CLOSURE_PERMISSION_CODE_COUNT = 237;
  check(
    `R5-02 权限码:真实 seed 事实闭包双口径一致且为 ${CLOSURE_PERMISSION_CODE_COUNT}`,
    closureDiff.onlyAst.length === 0 &&
      closureDiff.onlyLegacy.length === 0 &&
      closureDiff.ast.size === CLOSURE_PERMISSION_CODE_COUNT,
    `ast=${closureDiff.ast.size} onlyAst=[${closureDiff.onlyAst.join(',')}] onlyLegacy=[${closureDiff.onlyLegacy.join(',')}]`,
  );

  const withoutFacts = DOCS_COUNTS_SEED_FACTS_CLOSURE.filter(
    (file) => file !== 'src/modules/permissions/rbac-seed-facts.ts',
  );
  const incompleteSources = withoutFacts.map((file) =>
    fs.readFileSync(path.resolve(__dirname, '..', file), 'utf-8'),
  );
  checkEq(
    `R5-02 权限码:剔除 facts 后码数跌至 ${CLOSURE_PERMISSION_CODE_COUNT - FACTS_ONLY_RBAC_CODE_COUNT}`,
    extractSeedFactsPermissionCodesAst(incompleteSources).size,
    CLOSURE_PERMISSION_CODE_COUNT - FACTS_ONLY_RBAC_CODE_COUNT,
  );
  checkThrows(
    'R5-02 权限码:剔除 facts 的闭包被拒',
    () => assertSeedFactsClosure(withoutFacts),
    'seed 事实闭包必须精确为',
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
  checkThrows(
    'P1 db:非法 JEST_WORKER_ID 拒绝派生',
    () => deriveTestDbName(),
    '非法 JEST_WORKER_ID',
  );
  process.env.JEST_WORKER_ID = '123';
  checkThrows(
    'P1 db:三位 worker 号拒绝(超出预期规模)',
    () => deriveTestDbName(),
    '非法 JEST_WORKER_ID',
  );

  // jest 之外(无 JEST_WORKER_ID)→ 模板库名,与 checkout 级派生一致
  delete process.env.JEST_WORKER_ID;
  checkEq('P1 db:无 worker 上下文时回到模板库名', deriveTestDbName(), deriveTemplateTestDbName());

  // worker 展开:长 slug + 两位 worker 号仍 ≤63 且互不相同
  {
    const longBase = deriveTestDbNameFrom(`/w/${'y'.repeat(40)}-lane`, true);
    check(
      'P1 db:长 slug 模板 + _w 后缀总长安全余量',
      longBase.length + 4 <= 63,
      `${longBase.length}`,
    );
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

  // ①a e2e 分片配置的两处必须同步:`matrix: shard: [...]` 与 `--shard=N/<分母>`。
  // 错配的两种后果不对称,危险的是第二种:
  //   - 矩阵片数 > 分母:多出来的片跑 `--shard=4/3`,jest 行为未定义(至少会炸,看得见)
  //   - **矩阵片数 < 分母:只跑 分母分之片数 的 spec,而每片都成功 ⇒ CI 全绿**
  //     ——「闸在跑但覆盖不全」,没有任何信号,与漏跑等价。
  // 这条守的正是第二种:它是本仓最怕的静默失效形状,且改配置时极易只改一处。
  {
    const shardList = /matrix:\s*\n\s*shard:\s*\[([^\]]+)\]/.exec(ci);
    const denominator = /--shard=\$\{\{ matrix\.shard \}\}\/(\d+)/.exec(ci);
    const count = shardList ? shardList[1].split(',').filter((s) => s.trim()).length : 0;
    const denom = denominator ? Number(denominator[1]) : 0;
    check(
      'P1 e2e shard:矩阵片数 == --shard 分母(错配会静默漏跑且 CI 全绿)',
      count > 0 && denom > 0 && count === denom,
      `ci.yml e2e 分片错配:matrix ${count} 片 vs --shard 分母 ${denom}`,
    );
  }

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
  // ①b 失败可见性(2026-08-16 新增)。本线**不进 required checks**(设计如此:它慢、
  // 不该阻塞 PR),所以「红了」这件事没有任何天然投递渠道 —— 实测连红 6 天无人知晓。
  // 判据装了而输出没人消费 = 等于没装,故投递本身也必须是执行位、并被守护。
  check(
    'P1 leak:nightly 失败时投递 Issue(红了必须有人看见)',
    /if:\s*failure\(\)/.test(nightly) && /gh issue (create|comment)/.test(nightly),
    'nightly 缺失败投递 —— 本线不进 required checks,没有投递就没有任何人会知道它红了',
  );
  // 不去重就会连红 N 天刷 N 个同样的 Issue,收件人随即整体无视 = 告警疲劳,
  // 与「没有通知」等价。故「先查既有 open Issue」这一步本身是判据的一部分。
  //
  // ⚠️ 本条最初写成 /gh issue list[\s\S]{0,200}--state open/,**是错的**:文件里有两处
  // `gh issue list`(失败投递、绿后关闭),该正则任一处命中即通过 ⇒ 拆掉失败投递那处的
  // `--state open` 时断言照样绿(实测变异未变红)。断言名字在说「投递前去重」,量的却是
  // 「文件里某处有 open 查询」。改成**逐处配对计数**:每一处 list 都必须自带 --state open。
  const issueListCount = (nightly.match(/gh issue list/g) ?? []).length;
  const issueListOpenCount = (nightly.match(/gh issue list[^\n]*--state open/g) ?? []).length;
  check(
    'P1 leak:nightly 每处 Issue 查询都限定 open(防重复轰炸导致告警疲劳)',
    issueListCount >= 2 && issueListCount === issueListOpenCount,
    `nightly 的 gh issue list 有 ${issueListCount} 处,其中仅 ${issueListOpenCount} 处限定 --state open`,
  );
  // 不自动关闭则 Issue 长期挂着,下次真红时无从分辨新旧 —— 同样使通知失去鉴别力。
  check(
    'P1 leak:nightly 恢复绿后关闭 Issue',
    /if:\s*success\(\)/.test(nightly) && nightly.includes('gh issue close'),
    'nightly 绿后未关闭 Issue,陈旧 Issue 会让下次告警失去鉴别力',
  );
  // 结论必须由检测步骤单点产出($LEAK_VERDICT),投递步骤只做渲染。
  // 若投递自行重判,两份判断迟早分叉:workflow 说超时、Issue 说泄漏,读者无从取信。
  //
  // ⚠️ 与上一条同形的坑:写成 nightly.includes('LEAK_VERDICT') 是不够的 —— 检测步骤
  // 本就写了 4 次该变量,投递步骤改读别的变量时断言照样绿。必须锚**读取点本身**
  // (投递步骤里那句 verdict="${LEAK_VERDICT:-...}"),并同时要求产出侧确有写入。
  check(
    'P1 leak:nightly 投递复用检测步骤的判定(单一判据来源)',
    /verdict="\$\{LEAK_VERDICT:-/.test(nightly) && /LEAK_VERDICT=\S+' >> "\$GITHUB_ENV"/.test(nightly),
    'nightly 的 Issue 投递未复用 $LEAK_VERDICT(或检测步骤未产出),存在两份判断分叉的风险',
  );

  // ─────────────────────────────────────────────────────────────────────
  // ①c 夜间线**分片**(2026-08-19,issue #1080)。
  // 分片把「一个进程跑完全部 spec」换成「每片一个进程」,随之引入本仓最怕的静默
  // 失效形状:**新增 spec 落不进任何一片时,每片都正常绿,覆盖面却悄悄缩水**。
  // ci.yml 的 `P1 e2e shard` 守的是同一个形状,但两边机制不同(那边是 `--shard N/M`
  // 的分母,这边是 scripts/e2e-shard-plan.mjs 的域清单),故必须各守各的。
  const shardPlan = path.join(repoRoot, 'scripts/e2e-shard-plan.mjs');
  {
    const shardList = /matrix:\s*\n\s*shard:\s*\[([^\]]+)\]/.exec(nightly);
    const matrixCount = shardList ? shardList[1].split(',').filter((s) => s.trim()).length : 0;
    const declared = Number(
      execFileSync('node', [shardPlan, '--shards'], { encoding: 'utf-8' }).trim(),
    );
    check(
      'P1 leak:nightly 矩阵片数 == 分片清单声明的片数(错配会整片静默不跑)',
      matrixCount > 0 && declared > 0 && matrixCount === declared,
      `nightly 矩阵 ${matrixCount} 片 vs e2e-shard-plan.mjs 声明 ${declared} 片`,
    );
  }
  // 清单自洽本身也要每个 PR 都核:新增 spec 落空是**加 spec 的那个 PR** 引入的,
  // 等到夜里才发现意味着中间所有 PR 都跑在缩水的覆盖面上。
  {
    const r = spawnSync('node', [shardPlan, '--verify'], { encoding: 'utf-8' });
    check(
      'P1 leak:e2e 分片清单自洽(每个 spec 恰好落进一片)',
      r.status === 0,
      `e2e-shard-plan.mjs --verify 退出码 ${String(r.status)}:${(r.stderr || '').trim()}`,
    );
  }
  check(
    'P1 leak:nightly 开跑前先核分片清单完整性',
    // ⚠️ 不能只 grep `e2e-shard-plan.mjs --verify`:该串在本文件的 ::error:: 文案与
    // 处置建议里也出现(那些是 code 不是注释,codeOnly 剥不掉),删掉真步骤断言照样绿
    // (实测变异 M3 未变红)。故锚**步骤形态**本身,散文无法满足。
    /^\s*run: node scripts\/e2e-shard-plan\.mjs --verify\s*$/m.test(nightly),
    'nightly 少了 `--verify` 步骤 —— spec 落空时两片都会绿',
  );
  // 「清单自洽」证明不了「jest 真的收到了这么多」:pattern 写错、testPathIgnorePatterns
  // 变化都会让实收少于预算,而少跑的那部分不会以任何形式变红。故必须逐片对数。
  check(
    'P1 leak:nightly 逐片核对 jest 实收 suite 数 == 清单预算数',
    /LEAK_VERDICT=shard-plan-drift/.test(nightly) && /"\$suites" -ne "\$planned"/.test(nightly),
    'nightly 缺 shard-plan-drift 判别 —— 实收少于预算时不会变红',
  );
  // 恒保持 job timeout > 内层 timeout,否则内层的「超时/泄漏」判别拿不到执行机会
  // (job 先被杀,`too-slow` / `leak-no-stack` 两条消息都发不出来,退回 2026-08-16
  // 之前「只知道红了、不知道为什么红」的状态)。此前这条只写在注释里,现在机核。
  {
    const jobSection = nightly.slice(nightly.indexOf('e2e-leaks:'), nightly.indexOf('notify-failure:'));
    const jobMin = Number(/timeout-minutes:\s*(\d+)/.exec(jobSection)?.[1] ?? 0);
    const innerMin = Number(/timeout\s+--signal=TERM\s+--kill-after=\d+s\s+(\d+)m/.exec(jobSection)?.[1] ?? 0);
    check(
      'P1 leak:nightly job timeout > 内层 timeout(否则超时/泄漏判别拿不到执行机会)',
      jobMin > 0 && innerMin > 0 && jobMin > innerMin,
      `job timeout-minutes=${jobMin} vs 内层 timeout=${innerMin}m`,
    );
  }
  // 通知必须是**聚合** job:片 1 绿不代表这条线绿。若关闭逻辑留在片内,
  // 片 1 会去关掉片 2 刚开的 Issue —— 红着的线看起来是绿的,比不通知更坏。
  {
    const jobSection = nightly.slice(nightly.indexOf('e2e-leaks:'), nightly.indexOf('notify-failure:'));
    check(
      'P1 leak:分片 job 内不得直接开关 Issue(须由聚合 job 判两片全绿)',
      !/gh issue/.test(jobSection),
      '分片 job 里出现了 gh issue —— 单片结论会误开/误关 Issue',
    );
    check(
      'P1 leak:Issue 开关两个 job 都以全部分片为前提',
      (nightly.match(/needs:\s*e2e-leaks/g) ?? []).length >= 2,
      '通知 job 未 needs 分片 job —— 会与分片并发跑,拿不到结论',
    );
  }

  // ② CI gate 必须正面证明 slow 的 skipped 合法(docs-only),不得从 skipped 反推。
  // 曾经 fail-open:changeset 失败 → slow skipped → required check 变绿而 e2e 从未跑。
  check(
    'P1 gate:校验 changeset 结果',
    ci.includes('needs.changeset.result }}" != "success"'),
    'gate 未校验 changeset,存在 fail-open 假绿路径',
  );
  check(
    'P1 gate:slow=skipped 需 docs_only 正面证明',
    ci.includes('needs.changeset.outputs.docs_only }}" != "true"'),
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
    'eslint-rules/**', // 第 18 条的规则体(本仓首条自定义规则)= 与上一条同一道防线的两半
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
  const DB_SCOPED =
    /datname\s*=\s*current_database\(\)|lock\.database\s*=|pid\s*=\s*pg_backend_pid\(\)|pid\s*=\s*CAST\(/;
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

// ---------------------------------------------------------------------------
// Phase 0 — 架构治理登记表 / 生成器的阳性对照
//
// Phase 0 的扫描器仍是 report-only，但 inputDigest 是「这份盘点是否对应当前输入」
// 的唯一新鲜度证据。只断言当前 --check 为绿还不够：若把 digest 计算缩成常量，
// 绿得再漂亮也是假绿。因此在临时副本中实际改动输入文件，要求两个入口立刻拒绝。
// 临时副本避免碰 src/ 与 prisma，既不污染业务工作树，也不会把测试行为带入业务代码。
// ---------------------------------------------------------------------------
{
  const REPO = path.resolve(__dirname, '..');
  const read = (rel: string): string => fs.readFileSync(path.join(REPO, rel), 'utf8');
  const registry = JSON.parse(read('harness/redzone.json')) as {
    selfGuard: Array<{ globs: string[] }>;
  };
  const selfGlobs = registry.selfGuard.flatMap((entry) => entry.globs);
  const governanceFiles: Array<readonly [string, string]> = [
    ['harness/domain-map.json', 'harness/**'],
    ['harness/architecture-debt.json', 'harness/**'],
    ['harness/state-machines.json', 'harness/**'],
    ['harness/authz-assertion-patterns.json', 'harness/**'],
    ['harness/baseline-health.json', 'harness/**'],
    ['scripts/check-boundaries.ts', 'scripts/check-*.ts'],
    ['scripts/generate-authz-manifest.ts', 'scripts/generate-*.ts'],
    ['docs/ai-harness/BASELINE_HEALTH.md', 'docs/ai-harness/BASELINE_HEALTH.md'],
    ['docs/ai-harness/EXTERNAL_IO_INVENTORY.md', 'docs/ai-harness/EXTERNAL_IO_INVENTORY.md'],
    ['docs/ai-harness/ROUTE_AUTHZ.md', 'docs/ai-harness/ROUTE_AUTHZ.md'],
    [
      'docs/archive/reviews/architecture-governance-v4/README.md',
      'docs/archive/reviews/architecture-governance-v4/README.md',
    ],
    [
      'docs/archive/reviews/architecture-governance-v4/DECISIONS-2026-08-09.md',
      'docs/archive/reviews/architecture-governance-v4/DECISIONS-2026-08-09.md',
    ],
    [
      'changelog.d/architecture-governance-phase0.added.md',
      'changelog.d/architecture-governance-phase0.added.md',
    ],
    [
      'changelog.d/architecture-governance-phase0-gate.added.md',
      'changelog.d/architecture-governance-phase0-gate.added.md',
    ],
  ];
  for (const [file, glob] of governanceFiles) {
    check(
      `Governance selfGuard:${file} 已由 ${glob} 收编`,
      selfGlobs.includes(glob),
      '新增取证产物若未进入 selfGuard，可在同一 PR 内静默篡改基线或生成器。',
    );
  }

  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
  const expectedScripts: Record<string, string> = {
    'docs:boundaries': 'tsx scripts/check-boundaries.ts --violations',
    'docs:boundaries:check': 'tsx scripts/check-boundaries.ts --metadata',
    'docs:authz': 'tsx scripts/generate-authz-manifest.ts --write',
    'docs:authz:check': 'tsx scripts/generate-authz-manifest.ts --check',
  };
  for (const [name, command] of Object.entries(expectedScripts)) {
    checkEq(`P0 package:${name} 接到物理入口`, pkg.scripts[name], command);
  }

  const ci = codeOnly(read('.github/workflows/ci.yml'));
  check(
    'P0 ci:A 类元数据在既有 Fast checks 内阻断，B 类违规恒 report-only',
    ci.includes('- name: Architecture governance A-metadata gate (B reports only)') &&
      ci.includes('pnpm docs:boundaries || true') &&
      ci.includes('pnpm docs:boundaries:check') &&
      ci.includes('pnpm docs:authz:check') &&
      !ci.includes('pnpm docs:boundaries:check || true') &&
      !ci.includes('pnpm docs:authz:check || true'),
    'A 类完整性翻闸缺失，或 B 类违规被误升级为硬门禁。',
  );

  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'srvf-phase0-input-digest-'));
  const copyIntoFixture = (rel: string): void => {
    const source = path.join(REPO, rel);
    const target = path.join(fixtureRoot, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(source, target, { recursive: true });
  };
  const runFixture = (script: string, args: string[]): { code: number; out: string } => {
    const result = spawnSync(
      path.join(REPO, 'node_modules', '.bin', 'tsx'),
      [path.join(fixtureRoot, script), ...args],
      { cwd: fixtureRoot, encoding: 'utf8' },
    );
    return {
      code: result.status ?? -1,
      out: `${result.stdout ?? ''}${result.stderr ?? ''}`,
    };
  };
  const mutateInputAndRun = (
    rel: string,
    script: string,
    args: string[],
  ): { code: number; out: string } => {
    const target = path.join(fixtureRoot, rel);
    const original = fs.readFileSync(target, 'utf8');
    fs.appendFileSync(target, '\n// Phase 0 selftest input mutation\n', 'utf8');
    try {
      return runFixture(script, args);
    } finally {
      fs.writeFileSync(target, original, 'utf8');
    }
  };

  try {
    for (const rel of [
      'src',
      // typed 扫描以仓库 tsconfig 为唯一作用域源(不另写 glob),fixture 因此必须
      // 是一个带 tsconfig 的完整小仓 —— 少了它 typed program 建不起来。
      'tsconfig.json',
      'prisma/schema.prisma',
      // R10 4-1b:L1 配置列的 governed 门槛要从 migration 的 DB CHECK 重算闭集,
      // 夹具没有 migrations 就会对每条 governed L1 报「找不到 CHECK」—— 那是夹具失真,
      // 不是判据发现。628K,相对已复制的 src(10M)可以忽略。
      'prisma/migrations',
      'harness/domain-map.json',
      'harness/architecture-debt.json',
      'harness/state-machines.json',
      'harness/authz-assertion-patterns.json',
      'docs/ai-harness/ROUTE_AUTHZ.md',
      'test/contract/openapi.contract-spec.ts',
      'scripts/check-boundaries.ts',
      'scripts/generate-authz-manifest.ts',
    ]) {
      copyIntoFixture(rel);
    }
    fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(fixtureRoot, 'node_modules'), 'dir');

    checkEq(
      'P1 domain-map 定性正例:confirmed 与 decisionsPending 一致时通过',
      runFixture('scripts/check-boundaries.ts', ['--metadata']).code,
      0,
    );
    const fixtureDomainMap = path.join(fixtureRoot, 'harness/domain-map.json');
    const originalDomainMap = fs.readFileSync(fixtureDomainMap, 'utf8');

    // Phase 2 R5/R6:在临时副本里放入一组最小 Prisma 形态。扫描器只依赖
    // AST + schema/登记表,不靠业务测试或运行时。
    //
    // Phase 3 typed 化后这里必须显式声明 `prisma` 的类型:原版写的是裸
    // `this.prisma`(从不声明),名字启发式靠**拼写**就能命中,类型解析则解析不出
    // 任何 delegate。真实 `src/**` 全部通过 tsc,夹具不声明类型才是失真的那一方 ——
    // 补上声明是让夹具贴近真源,断言集一条未改。
    const phase2FixtureRel = 'src/modules/activities/phase2-boundary-fixture.ts';
    const phase2FixtureFile = path.join(fixtureRoot, phase2FixtureRel);
    fs.writeFileSync(
      phase2FixtureFile,
      [
        "import type { PrismaClient } from '@prisma/client';",
        '',
        'class Phase2BoundaryFixture {',
        '  private readonly prisma!: PrismaClient;',
        '  kernelAllowed() {',
        "    return this.prisma.user.findMany({ where: { id: 'u' }, select: { id: true, status: true } });",
        '  }',
        '  kernelPredicateViolation() {',
        "    return this.prisma.user.findMany({ where: { username: 'u' }, select: { id: true } });",
        '  }',
        '  kernelOmitViolation() {',
        "    return this.prisma.user.findMany({ omit: { username: true } });",
        '  }',
        '  includeViolation() {',
        '    return this.prisma.activityRegistration.findMany({ include: { member: true } });',
        '  }',
        '  factAllowed() {',
        '    return this.prisma.rbacRole.findMany({ select: { id: true, code: true } });',
        '  }',
        '  factRejected() {',
        '    return this.prisma.rbacRole.findMany({ select: { id: true } });',
        '  }',
        '  semanticControl() {',
        "    return this.prisma.user.findMany({ where: { status: 'ACTIVE' }, select: { id: true } });",
        '  }',
        '  semanticViolation() {',
        '    return this.prisma.user.findMany({',
        "      where: { status: 'ACTIVE', createdAt: { gte: new Date('2026-01-01') } },",
        '      select: { id: true },',
        '    });',
        '  }',
        '  dynamicViolation() {',
        '    const select = { id: true };',
        '    return this.prisma.user.findMany({ select });',
        '  }',
        '  rawSameDomainControl() {',
        "    return this.prisma.$queryRawUnsafe('SELECT 1 FROM \\\"Activity\\\"');",
        '  }',
        '  rawDefaultTableViolation() {',
        "    return this.prisma.$queryRawUnsafe('SELECT 1 FROM \\\"User\\\"');",
        '  }',
        '  rawMappedTableViolation() {',
        "    return this.prisma.$queryRawUnsafe('SELECT 1 FROM roles');",
        '  }',
        '  sameSubdomainWriteControl() {',
        "    return this.prisma.activity.updateMany({ data: { title: 'x' } });",
        '  }',
        '  observedSubdomainWriteViolation() {',
        "    return this.prisma.activityRegistration.updateMany({ data: { statusCode: 'x' } });",
        '  }',
        '}',
        '',
      ].join('\n'),
      'utf8',
    );
    const phase2Map = JSON.parse(originalDomainMap) as {
      crossDomainReadAllowlist: Array<Record<string, string>>;
      moduleOwnership: Record<string, { subdomain?: string }>;
    };
    phase2Map.crossDomainReadAllowlist.push({
      sourceDomain: 'participation',
      sourceModule: 'activities',
      targetDomain: 'platform-access',
      prismaModel: 'RbacRole',
      operation: 'findMany',
      sourceFile: phase2FixtureRel,
      sourceSymbol: 'Phase2BoundaryFixture.factAllowed',
      accessPath: 'RbacRole',
      observedBy: 'Phase 2 synthetic positive control',
      reviewTrigger: 'selftest only',
    });
    const phase2WithoutObservedSubdomainWrite = JSON.parse(JSON.stringify(phase2Map)) as typeof phase2Map;
    phase2WithoutObservedSubdomainWrite.moduleOwnership['activity-registrations'].subdomain =
      phase2WithoutObservedSubdomainWrite.moduleOwnership.activities.subdomain;
    fs.writeFileSync(
      fixtureDomainMap,
      JSON.stringify(phase2WithoutObservedSubdomainWrite, null, 2) + '\n',
      'utf8',
    );
    const phase2WithoutObservedSubdomainWriteScan = runFixture('scripts/check-boundaries.ts', [
      '--violations',
    ]);
    fs.writeFileSync(fixtureDomainMap, JSON.stringify(phase2Map, null, 2) + '\n', 'utf8');
    const phase2Scan = runFixture('scripts/check-boundaries.ts', ['--violations']);
    fs.writeFileSync(fixtureDomainMap, originalDomainMap, 'utf8');
    fs.rmSync(phase2FixtureFile, { force: true });
    type Phase2Finding = {
      kind: string;
      disposition: string;
      prismaModel: string | null;
      callSiteId: string;
      location: { file: string; symbol: string };
      details: Record<string, unknown>;
    };
    type Phase2EdgeUsage = {
      from: string;
      to: string;
      importCount: number;
      crossDomainAccessCount: number;
    };
    let phase2Findings: Phase2Finding[] = [];
    let phase2WithoutObservedSubdomainWriteFindings: Phase2Finding[] = [];
    let phase2DeclaredEdgeUsage: Phase2EdgeUsage[] = [];
    let phase2UndeclaredDirectionUsage: Phase2EdgeUsage[] = [];
    try {
      const phase2Output = JSON.parse(phase2Scan.out) as {
        findings: typeof phase2Findings;
        edgeUsage: {
          declaredEdges: typeof phase2DeclaredEdgeUsage;
          undeclaredDirections: typeof phase2UndeclaredDirectionUsage;
        };
      };
      phase2Findings = phase2Output.findings;
      phase2DeclaredEdgeUsage = phase2Output.edgeUsage.declaredEdges;
      phase2UndeclaredDirectionUsage = phase2Output.edgeUsage.undeclaredDirections;
      phase2WithoutObservedSubdomainWriteFindings = (
        JSON.parse(phase2WithoutObservedSubdomainWriteScan.out) as {
          findings: typeof phase2WithoutObservedSubdomainWriteFindings;
        }
      ).findings;
    } catch {
      // 由下一个断言输出原始执行结果，避免 JSON 解析异常遮住真正的自测原因。
    }
    const phase2Detail = phase2Scan.out.slice(-8000);
    const phase2Local = phase2Findings.filter((item) => item.location.file === phase2FixtureRel);
    const phase2WithoutObservedSubdomainWriteLocal =
      phase2WithoutObservedSubdomainWriteFindings.filter(
        (item) => item.location.file === phase2FixtureRel,
      );
    const localKind = (kind: string, symbol: string): typeof phase2Local =>
      phase2Local.filter((item) => item.kind === kind && item.location.symbol === symbol);
    const platformCoreToAccessUsage = phase2DeclaredEdgeUsage.find(
      (item) => item.from === 'platform-core' && item.to === 'platform-access',
    );
    check(
      'P2 D4 已声明边使用统计:platform-core→platform-access import 数与手工计数一致',
      // ⚠️ 这个数字**刻意硬编码**:它守的是「已声明边上的用量不会悄悄膨胀」——
      // 边本身合法,所以边界检查不会红,只有这条手工计数会。改动它必须在 PR 里写明原因。
      //
      // 17 → 19(2026-08-17,Phase 6-B 第三域第七刀):attachments.service 由 1 个文件拆成 6 个,
      // 同一组依赖(prisma.service / rbac.service)从"1 个文件持有 2 条"变成"6 个文件共持有 9 条",
      // 全仓净增 2。**不是新增依赖**,是同一依赖被更多文件各自 import 的机械后果 ——
      // 拆分把一次 import 摊成多次,这是抽类的固有代价,不是边界退化。
      platformCoreToAccessUsage?.importCount === 19 &&
        !phase2UndeclaredDirectionUsage.some(
          (item) => item.from === 'platform-core' && item.to === 'platform-access',
        ),
      phase2Detail,
    );
    check(
      'P2 R5 kernel 读正例:显式 select 与 kernel 谓词进入第一档',
      localKind('cross-domain-kernel-read', 'Phase2BoundaryFixture.kernelAllowed').length === 1,
      phase2Detail,
    );
    check(
      'P2 R5 kernel 读负例:omit 不能替代 select，必被报出',
      localKind('cross-domain-kernel-read-violation', 'Phase2BoundaryFixture.kernelOmitViolation')
        .length === 1,
      phase2Detail,
    );
    check(
      'P2 R5 kernel 读负例:裸 include 拉取他域整行，必被报出',
      localKind('cross-domain-kernel-read-violation', 'Phase2BoundaryFixture.includeViolation')
        .length === 1,
      phase2Detail,
    );
    check(
      'P2 R5 kernel 谓词负例:可返回字段不自动可作谓词',
      localKind(
        'cross-domain-kernel-predicate-violation',
        'Phase2BoundaryFixture.kernelPredicateViolation',
      ).length === 1,
      phase2Detail,
    );
    check(
      'P2 R5 二档正例:精确 allowlist 仅放行实测调用点',
      localKind('cross-domain-fact-read', 'Phase2BoundaryFixture.factAllowed').length === 1,
      phase2Detail,
    );
    check(
      'P2 R5 二档负例:没有 allowlist 的事实读仍列候选',
      localKind('cross-domain-fact-read-candidate', 'Phase2BoundaryFixture.factRejected').length ===
        1,
      phase2Detail,
    );
    check(
      'P2 R5 三档正例:单独状态条件不被误认成语义时间窗查询',
      localKind('cross-domain-semantic-read-candidate', 'Phase2BoundaryFixture.semanticControl')
        .length === 0,
      phase2Detail,
    );
    check(
      'P2 R5 三档负例:他域状态加时间窗组合必列属主谓词候选',
      localKind('cross-domain-semantic-read-candidate', 'Phase2BoundaryFixture.semanticViolation')
        .length === 1,
      phase2Detail,
    );
    check(
      'P2 R5 动态形状负例:动态 select 不会被静默归入任何读档',
      localKind('cross-domain-read-dynamic', 'Phase2BoundaryFixture.dynamicViolation').length ===
        1,
      phase2Detail,
    );
    const rawFindings = phase2Local.filter((item) => item.kind === 'raw-cross-domain-table');
    check(
      'P2 R6 raw SQL 正例:同域物理表不产生跨域表命中',
      rawFindings.every(
        (item) => item.location.symbol !== 'Phase2BoundaryFixture.rawSameDomainControl',
      ),
      phase2Detail,
    );
    check(
      'P2 R6 raw SQL 负例:Prisma 默认物理表名 User 必被命中',
      rawFindings.some(
        (item) =>
          item.location.symbol === 'Phase2BoundaryFixture.rawDefaultTableViolation' &&
          item.prismaModel === 'User' &&
          item.details.physicalTable === 'User' &&
          item.details.physicalTableSource === 'prisma-model-default',
      ),
      phase2Detail,
    );
    check(
      'P2 R6 raw SQL 负例:@@map 物理表名 roles 必被命中',
      rawFindings.some(
        (item) =>
          item.location.symbol === 'Phase2BoundaryFixture.rawMappedTableViolation' &&
          item.prismaModel === 'RbacRole' &&
          item.details.physicalTable === 'roles' &&
          item.details.physicalTableSource === '@@map',
      ),
      phase2Detail,
    );
    check(
      'P2 R6 子域写正例:同一 observed subdomain 不记跨子域写',
      localKind(
        'observed-subdomain-cross-owner-write',
        'Phase2BoundaryFixture.sameSubdomainWriteControl',
      ).length === 0,
      phase2Detail,
    );
    check(
      'P2 R6 子域写负例:participation 子域间写路径单列观察',
      localKind(
        'observed-subdomain-cross-owner-write',
        'Phase2BoundaryFixture.observedSubdomainWriteViolation',
      ).length === 1,
      phase2Detail,
    );
    const observedWriteSymbol = 'Phase2BoundaryFixture.observedSubdomainWriteViolation';
    const originalDirectWrite = phase2Local.filter(
      (item) => item.kind === 'cross-owner-write' && item.location.symbol === observedWriteSymbol,
    );
    const noObservationDirectWrite = phase2WithoutObservedSubdomainWriteLocal.filter(
      (item) => item.kind === 'cross-owner-write' && item.location.symbol === observedWriteSymbol,
    );
    check(
      'P2 R6 新增子域观察不改变同一真实写的既有 callSiteId',
      originalDirectWrite.length === 1 &&
        noObservationDirectWrite.length === 1 &&
        originalDirectWrite[0].callSiteId === noObservationDirectWrite[0].callSiteId,
      `${phase2Detail}\n${phase2WithoutObservedSubdomainWriteScan.out.slice(-4000)}`,
    );
    // ──────────────────────────────────────────────────────────────────────
    // R2/R3 依赖图覆盖面(Phase 3 前置 D2)
    //
    // 实测:本仓跨域 re-export / 动态 import() / import=require **各 0 条**,
    // 依赖图改判定拿不到任何新发现。因此本刀不改判定,只做两件事:
    //   ① 三种形态各一条正样例 —— 证明解析器认得,而不是「没命中所以以为没有」;
    //   ② 把「当前为 0」钉成断言 —— **第一条真出现时本自测就红**,逼人来看一眼。
    // ②是本仓「此刻不存在型判据必须写明到期条件」范式:到期条件 = 仓里出现第一条。
    // 到期处置 = 确认该依赖是否该存在,然后更新此处期望值,不是直接删断言。
    // ──────────────────────────────────────────────────────────────────────
    const liveImportForms = new Map<string, number>();
    for (const item of phase2Findings.filter((f) => f.kind === 'cross-domain-import')) {
      const form = String((item.details as { form?: unknown }).form ?? 'import');
      liveImportForms.set(form, (liveImportForms.get(form) ?? 0) + 1);
    }
    checkEq('D2 覆盖面:跨域 re-export 当前为 0(出现第一条即红)', liveImportForms.get('export-from') ?? 0, 0);
    checkEq(
      'D2 覆盖面:跨域动态 import() 当前为 0(出现第一条即红)',
      liveImportForms.get('dynamic-import') ?? 0,
      0,
    );
    checkEq(
      'D2 覆盖面:跨域 import=require 当前为 0(出现第一条即红)',
      liveImportForms.get('import-equals') ?? 0,
      0,
    );
    check(
      'D2 覆盖面:形态标注已接线(实存 import 形态全部带 form 字段)',
      (liveImportForms.get('import') ?? 0) > 0,
      phase2Detail,
    );

    // type-only 边:照算 + 打标记(维护者 2026-08-13 拍板)。
    // 若静默豁免,v4 §4 的 platform-access 业务入边「恒 0」会当场变成假话 ——
    // 实测那 3 条反向边恰好全是 type-only。
    const typeOnlyImports = phase2Findings.filter(
      (f) => f.kind === 'cross-domain-import' && (f.details as { typeOnly?: unknown }).typeOnly === true,
    );
    check(
      'D2 type-only:仍计入依赖边且带 typeOnly 标记(不静默豁免)',
      typeOnlyImports.length > 0,
      `type-only 跨域违规边 = ${typeOnlyImports.length}`,
    );

    // 三种未见形态的正样例:写进夹具仓再扫一遍,证明「0 条」是真的没有,
    // 不是解析器看不见。
    // 方向必须取**未声明**的那一侧才会产生违规记录:participation→platform-access
    // 是已声明边(business→platform 合法),反过来 platform-access→participation
    // 才是 v4 §4 要求恒 0 的反向边。故夹具放在 permissions(platform-access)里
    // 指向 activities(participation)。
    const coverageRel = 'src/modules/permissions/phase3-import-form-fixture.ts';
    const coverageFile = path.join(fixtureRoot, coverageRel);
    fs.writeFileSync(
      coverageFile,
      [
        "export { ActivitiesService } from '../activities/activities.service';",
        'export async function dyn() {',
        "  return import('../activities/activities.service');",
        '}',
        "import eq = require('../activities/activities.service');",
        'export const held = eq;',
        '',
      ].join('\n'),
      'utf8',
    );
    const coverageScan = runFixture('scripts/check-boundaries.ts', ['--violations']);
    fs.rmSync(coverageFile, { force: true });
    let coverageForms = new Set<string>();
    try {
      const parsed = JSON.parse(coverageScan.out) as { findings: Phase2Finding[] };
      coverageForms = new Set(
        parsed.findings
          .filter((f) => f.kind === 'cross-domain-import' && f.location.file === coverageRel)
          .map((f) => String((f.details as { form?: unknown }).form)),
      );
    } catch {
      coverageForms = new Set();
    }
    const coverageDetail = coverageScan.out.slice(-3000);
    check('D2 正样例:跨域 re-export 被识别为依赖边', coverageForms.has('export-from'), coverageDetail);
    check('D2 正样例:跨域动态 import() 被识别为依赖边', coverageForms.has('dynamic-import'), coverageDetail);
    check('D2 正样例:跨域 import=require 被识别为依赖边', coverageForms.has('import-equals'), coverageDetail);

    // ── R15 src/common 治理(架构治理 v4 终审【七】)──────────────────────
    // 三条判据各一正一负。**负样例必须是「形似但合法」** —— 与正样例只差
    // 一处语义(读的字段在不在 kernel 白名单内 / 有没有时间窗 / import 落在
    // common 内还是 modules 里),否则「负例通过」证明不了判据认的是那件事,
    // 只证明它认得出两段完全不同的代码。
    const r15Rel = 'src/common/r15-boundary-fixture.ts';
    const r15File = path.join(fixtureRoot, r15Rel);
    fs.writeFileSync(
      r15File,
      [
        "import type { PrismaClient } from '@prisma/client';",
        '',
        '// ③ 正样例:common → src/modules 入边(恒 0 的那条结构判据)。',
        "export { ActivitiesService } from '../modules/activities/activities.service';",
        '// ③ 负样例:common 内部互引 —— 形似(同样是相对 import)但不是入边。',
        "import { notDeletedWhere } from './prisma/soft-delete.util';",
        '',
        'export class R15BoundaryFixture {',
        '  private readonly prisma!: PrismaClient;',
        '  // ① 负样例:kernelReadFields 白名单内的事实读,显式 select、字段全在白名单里。',
        '  kernelFactReadControl() {',
        "    return this.prisma.user.findMany({ where: { id: 'u' }, select: { id: true, status: true } });",
        '  }',
        '  // ① 正样例(delegate 形态):业务 model 且无 kernel 白名单出口。',
        '  delegateViolation() {',
        "    return this.prisma.activity.findMany({ where: { id: 'a' }, select: { id: true } });",
        '  }',
        '  // ① 正样例(raw 形态):raw SQL 打业务物理表 —— 实测 6 条存量全是这个形态。',
        '  rawViolation() {',
        '    return this.prisma.$queryRawUnsafe(\'SELECT 1 FROM "Activity"\');',
        '  }',
        '  // ② 正样例:内联「状态 + 时间窗」谓词组合。',
        '  predicateViolation() {',
        '    return this.prisma.user.findMany({',
        "      where: { status: 'ACTIVE', createdAt: { gte: new Date('2026-01-01') } },",
        '      select: { id: true },',
        '    });',
        '  }',
        '  // ② 负样例:只有状态谓词、没有时间窗 —— 与正样例只差 createdAt 一项。',
        '  predicateControl() {',
        "    return this.prisma.user.findMany({ where: { status: 'ACTIVE' }, select: { id: true, status: true } });",
        '  }',
        "  keepAlive() { return notDeletedWhere({ id: 'x' }); }",
        '}',
        '',
      ].join('\n'),
      'utf8',
    );
    const r15Scan = runFixture('scripts/check-boundaries.ts', ['--violations']);
    fs.rmSync(r15File, { force: true });
    let r15Findings: Phase2Finding[] = [];
    let r15Summary: Record<string, number> = {};
    try {
      const parsed = JSON.parse(r15Scan.out) as {
        commonGovernance: { findings: Phase2Finding[] } & Record<string, number>;
      };
      r15Findings = parsed.commonGovernance.findings.filter(
        (item) => item.location.file === r15Rel,
      );
      r15Summary = parsed.commonGovernance as unknown as Record<string, number>;
    } catch {
      // 下面的断言会把原始输出打出来,不让 JSON 解析异常遮住真因。
    }
    const r15Detail = r15Scan.out.slice(-8000);
    const r15Kind = (kind: string, symbol: string): Phase2Finding[] =>
      r15Findings.filter((item) => item.kind === kind && item.location.symbol === symbol);
    check(
      'R15 ① 正样例(delegate):business model 无 kernel 出口必报',
      r15Kind('common-business-table-access', 'R15BoundaryFixture.delegateViolation').length === 1,
      r15Detail,
    );
    check(
      'R15 ① 正样例(raw):raw SQL 打业务物理表必报',
      r15Kind('common-business-table-access', 'R15BoundaryFixture.rawViolation').length === 1,
      r15Detail,
    );
    check(
      'R15 ① 负样例:kernelReadFields 白名单内的事实读不得报违规',
      r15Kind('common-business-table-access', 'R15BoundaryFixture.kernelFactReadControl').length ===
        0 &&
        r15Kind('common-kernel-fact-read', 'R15BoundaryFixture.kernelFactReadControl').length === 1,
      r15Detail,
    );
    check(
      'R15 ② 正样例:内联状态 + 时间窗谓词组合必报',
      r15Kind('common-business-predicate', 'R15BoundaryFixture.predicateViolation').length === 1,
      r15Detail,
    );
    check(
      'R15 ② 负样例:只有状态谓词、无时间窗不得报',
      r15Kind('common-business-predicate', 'R15BoundaryFixture.predicateControl').length === 0,
      r15Detail,
    );
    check(
      'R15 ③ 正样例:common → src/modules 入边必报',
      r15Findings.filter((item) => item.kind === 'common-to-module-import').length === 1,
      r15Detail,
    );
    check(
      'R15 ③ 负样例:common 内部互引不算入边',
      r15Findings.every(
        (item) =>
          item.kind !== 'common-to-module-import' ||
          String((item.details as { specifier?: unknown }).specifier).includes('modules/'),
      ),
      r15Detail,
    );
    // 判据①的存量:6 条全在 claim-at-status.util.ts(raw 形态,跨三个域)。
    // 它们**不是白名单**,是登记在案的历史债 —— 白名单意味着「这样做是对的」,
    // 而正确终态是表名参数化、common 不留业务表知识(维护者 2026-08-15 拍板)。
    // 钉住这个数,新增业务表访问即红。
    check(
      'R15 ① 存量基线:src/common 的业务表访问恰为 6 条(claim-at-status 的 raw 形态)',
      r15Summary.businessTableAccess === 6 + 2,
      `businessTableAccess=${String(r15Summary.businessTableAccess)}(夹具贡献 2 条)\n${r15Detail}`,
    );
    check(
      'R15 ③ 存量基线:src/common → src/modules 入边恒 0(夹具外)',
      r15Summary.moduleImportEdges === 1,
      `moduleImportEdges=${String(r15Summary.moduleImportEdges)}(夹具贡献 1 条)\n${r15Detail}`,
    );

    const confirmedButPendingMap = JSON.parse(originalDomainMap) as {
      decisionsPending: string[];
    };
    confirmedButPendingMap.decisionsPending.push('publicSurface');
    fs.writeFileSync(
      fixtureDomainMap,
      JSON.stringify(confirmedButPendingMap, null, 2) + '\n',
      'utf8',
    );
    const confirmedButPending = runFixture('scripts/check-boundaries.ts', ['--metadata']);
    fs.writeFileSync(fixtureDomainMap, originalDomainMap, 'utf8');
    check(
      'P1 domain-map 定性负例:pending 指向 confirmed:true 对象必被拒绝',
      confirmedButPending.code !== 0 &&
        confirmedButPending.out.includes(
          'decisionsPending lists confirmed governance object: publicSurface',
        ),
      confirmedButPending.out,
    );
    const unlistedPendingMap = JSON.parse(originalDomainMap) as {
      publicSurface: { confirmed: boolean };
      decisionsPending: string[];
    };
    unlistedPendingMap.publicSurface.confirmed = false;
    fs.writeFileSync(fixtureDomainMap, JSON.stringify(unlistedPendingMap, null, 2) + '\n', 'utf8');
    const unlistedPending = runFixture('scripts/check-boundaries.ts', ['--metadata']);
    fs.writeFileSync(fixtureDomainMap, originalDomainMap, 'utf8');
    check(
      'P1 domain-map 定性负例:confirmed:false 对象缺 pending 必被拒绝',
      unlistedPending.code !== 0 &&
        unlistedPending.out.includes(
          'confirmed:false governance object missing from decisionsPending: publicSurface',
        ),
      unlistedPending.out,
    );
    const staleDomainMap = mutateInputAndRun('src/app.module.ts', 'scripts/check-boundaries.ts', [
      '--metadata',
    ]);
    check(
      'P0 inputDigest 阳性:触碰任一 domain-map 输入文件必使 metadata 拒绝',
      staleDomainMap.code !== 0 && staleDomainMap.out.includes('inputDigest stale'),
      staleDomainMap.out,
    );
    const staleStateMachines = mutateInputAndRun(
      'prisma/schema.prisma',
      'scripts/check-boundaries.ts',
      ['--metadata'],
    );
    check(
      'P0 inputDigest 阳性:触碰 state-machine 输入文件必使登记表拒绝',
      staleStateMachines.code !== 0 &&
        staleStateMachines.out.includes('state-machines.json.inputDigest stale'),
      staleStateMachines.out,
    );

    // -----------------------------------------------------------------------
    // R10 Phase 4-1b —— 状态机 governed 声明闸
    //
    // 4-1a 实测:闭集已有 34/56 被 DB CHECK 兜住,而**边有 20 条零机器声明、
    // 18 条无具名状态机模块**。只比闭集的一致性检查会对那 20 条恒真通过 = 空绿。
    // 因此下面每条判据都必须有**一正一负**,且负样例「形似但非法」——
    // 尤其 `空绿负例` 那条:它给的闭集完全合法,只是拿不出边与实现映射。
    // -----------------------------------------------------------------------
    interface FixtureStateEntry {
      model: string;
      field: string;
      governanceStatus: string;
      layer: string;
      stateSet: { values: string[] | null; source: string; sourceRef: string };
      transitions: string | string[];
      governedBlockers: string[];
      governedEvidence?: {
        edgeModel: string;
        implementationFile?: string;
        implementationSymbol?: string;
        edges?: Array<{ from: string; to: string; action?: string }>;
        wrongStateBizCodes: string[];
      };
    }
    const fixtureStateMachines = path.join(fixtureRoot, 'harness/state-machines.json');
    const originalStateMachines = fs.readFileSync(fixtureStateMachines, 'utf8');
    const liveStateRegistry = JSON.parse(originalStateMachines) as { entries: FixtureStateEntry[] };
    const pick = (entries: FixtureStateEntry[], model: string, field: string): FixtureStateEntry => {
      const found = entries.find((item) => item.model === model && item.field === field);
      if (found === undefined) throw new Error(`state entry missing: ${model}.${field}`);
      return found;
    };
    /**
     * 逐条断言比对的是**解析后的 errors 数组**,不是原始 stdout ——
     * stdout 是 JSON,消息里的引号被转义成 `\"`,拿裸 `includes('"archived"')` 去比
     * 会**永远不匹配**:判据明明红了,断言却报「没红」。这类失真会把真判据误判成空转。
     */
    const runStateRegistry = (
      mutate: (entries: FixtureStateEntry[]) => void,
    ): { code: number; out: string; errors: string[] } => {
      const parsed = JSON.parse(originalStateMachines) as { entries: FixtureStateEntry[] };
      mutate(parsed.entries);
      fs.writeFileSync(fixtureStateMachines, JSON.stringify(parsed, null, 2) + '\n', 'utf8');
      let result: { code: number; out: string };
      try {
        result = runFixture('scripts/check-boundaries.ts', ['--metadata']);
      } finally {
        fs.writeFileSync(fixtureStateMachines, originalStateMachines, 'utf8');
      }
      let errors: string[] = [];
      try {
        errors = (JSON.parse(result.out) as { errors: string[] }).errors;
      } catch {
        // 解析不了就留空数组 —— 断言随即失败并打出原始输出,不静默放行。
      }
      return { ...result, errors };
    };
    const saidThat = (result: { errors: string[] }, needle: string): boolean =>
      result.errors.some((message) => message.includes(needle));
    /** L3 `Activity.statusCode` 的完整合法证据 —— enumerated 路径的正例底座。 */
    const activityEvidence = (): FixtureStateEntry['governedEvidence'] => ({
      edgeModel: 'enumerated',
      implementationFile: 'src/modules/activities/activity-state-machine.ts',
      implementationSymbol: 'ActivityStateMachine',
      edges: [
        { from: 'draft', to: 'published', action: 'publish' },
        { from: 'draft', to: 'cancelled', action: 'cancel' },
        { from: 'published', to: 'cancelled', action: 'cancel' },
        { from: 'published', to: 'terminated', action: 'terminate' },
        { from: 'published', to: 'completed', action: 'complete' },
      ],
      wrongStateBizCodes: ['ACTIVITY_STATUS_INVALID'],
    });
    const asGovernedActivity = (
      entries: FixtureStateEntry[],
      tweak: (entry: FixtureStateEntry) => void = () => {},
    ): void => {
      const entry = pick(entries, 'Activity', 'statusCode');
      entry.governanceStatus = 'governed';
      entry.governedBlockers = [];
      entry.governedEvidence = activityEvidence();
      tweak(entry);
    };

    const governedEntries = liveStateRegistry.entries.filter(
      (entry) => entry.governanceStatus === 'governed',
    );
    check(
      'R10 4-1b 存量基线:恰 8 条已升 governed,且全部是 L1 配置列(本刀不升任何 L3)',
      governedEntries.length === 8 &&
        governedEntries.every(
          (entry) =>
            entry.layer === 'L1' &&
            entry.transitions === 'unconstrained' &&
            entry.governedEvidence?.edgeModel === 'unconstrained' &&
            entry.governedEvidence.wrongStateBizCodes.length === 0,
        ),
      `governed=${governedEntries.map((entry) => `${entry.model}.${entry.field}[${entry.layer}]`).join(', ')}`,
    );
    checkEq(
      'R10 4-1b 正例:当前登记表(含 8 条 governed)通过声明闸',
      runFixture('scripts/check-boundaries.ts', ['--metadata']).code,
      0,
    );

    // ★ 本刀的核心自证:这条负样例的闭集完全合法(5 值、DB 有声明),
    //   **只比闭集的判据会放它过去** —— 而它恰恰一条边、一个实现模块都拿不出来。
    //   4-1a §3.1 点名的 20 条「edges-not-derived」全是这个形状。
    const vacuousGreen = runStateRegistry((entries) => {
      const entry = pick(entries, 'ActivityInvitation', 'statusCode');
      entry.governanceStatus = 'governed';
      entry.governedBlockers = [];
      entry.governedEvidence = { edgeModel: 'enumerated', wrongStateBizCodes: [] };
    });
    const vacuousSource = pick(liveStateRegistry.entries, 'ActivityInvitation', 'statusCode');
    check(
      'R10 4-1b 空绿负例:闭集合法但零边零实现的 L3 必被拒(只比闭集会放它过去)',
      vacuousGreen.code !== 0 &&
        saidThat(
          vacuousGreen,
          'ActivityInvitation.statusCode: governedEvidence.implementationFile must be an existing src/**.ts file',
        ) &&
        // 前提对照:它的闭集确实是「合法且已声明」的,否则这条负例证明不了空绿。
        Array.isArray(vacuousSource.stateSet.values) &&
        vacuousSource.stateSet.values.length > 0,
      vacuousGreen.out,
    );

    checkEq(
      'R10 4-1b enumerated 正例:真文件 + 真符号 + 5 条真边 + 真码的 L3 通过(证明这条路不是死代码)',
      runStateRegistry((entries) => asGovernedActivity(entries)).code,
      0,
    );
    const edgeNotInModule = runStateRegistry((entries) =>
      asGovernedActivity(entries, (entry) => {
        // 形似但非法:换成**另一个真状态机**(符号也跟着换成真的),
        // 于是 file / symbol 两关都过,唯独边在那个模块里根本不存在。
        entry.governedEvidence = {
          ...activityEvidence(),
          implementationFile: 'src/modules/attendances/attendance-sheet-state-machine.ts',
          implementationSymbol: 'AttendanceSheetStateMachine',
        } as FixtureStateEntry['governedEvidence'];
      }),
    );
    check(
      'R10 4-1b 边负例:登记表写了、具名模块里没有 —— 必被拒',
      edgeNotInModule.code !== 0 &&
        saidThat(edgeNotInModule, 'registry declares an edge the named module does not mention'),
      edgeNotInModule.out,
    );
    const missingEdge = runStateRegistry((entries) =>
      asGovernedActivity(entries, (entry) => {
        entry.governedEvidence = {
          ...activityEvidence(),
          edges: activityEvidence()?.edges?.filter((edge) => edge.to !== 'completed'),
        } as FixtureStateEntry['governedEvidence'];
      }),
    );
    check(
      'R10 4-1b 反向边负例:模块里出现的状态没有边覆盖 —— 边表不完整必被拒',
      missingEdge.code !== 0 &&
        saidThat(
          missingEdge,
          'state "completed" appears in src/modules/activities/activity-state-machine.ts but no declared edge touches it',
        ),
      missingEdge.out,
    );
    const fabricatedEdge = runStateRegistry((entries) =>
      asGovernedActivity(entries, (entry) => {
        entry.governedEvidence?.edges?.push({ from: 'published', to: 'archived', action: 'archive' });
      }),
    );
    check(
      'R10 4-1b 造边负例:端点不在闭集内必被拒',
      fabricatedEdge.code !== 0 &&
        saidThat(fabricatedEdge, 'edge endpoint "archived" is not in stateSet.values'),
      fabricatedEdge.out,
    );
    const wrongSymbol = runStateRegistry((entries) =>
      asGovernedActivity(entries, (entry) => {
        if (entry.governedEvidence !== undefined)
          entry.governedEvidence.implementationSymbol = 'ActivityStateMachineService';
      }),
    );
    check(
      'R10 4-1b 实现映射负例:符号在该文件里没有声明必被拒',
      wrongSymbol.code !== 0 &&
        saidThat(
          wrongSymbol,
          'governedEvidence.implementationSymbol "ActivityStateMachineService" is not declared',
        ),
      wrongSymbol.out,
    );
    const unknownBizCode = runStateRegistry((entries) =>
      asGovernedActivity(entries, (entry) => {
        if (entry.governedEvidence !== undefined)
          entry.governedEvidence.wrongStateBizCodes = ['ACTIVITY_STATE_INVALID'];
      }),
    );
    check(
      'R10 4-1b 错误码负例:wrong-state 码不在 BizCode 里必被拒(形似:STATE vs STATUS)',
      unknownBizCode.code !== 0 &&
        saidThat(
          unknownBizCode,
          'wrongStateBizCodes contains unknown BizCode "ACTIVITY_STATE_INVALID"',
        ),
      unknownBizCode.out,
    );

    // L1 侧:闭集必须与**在册**的 DB CHECK 逐值相等,且 sourceRef 必须指向那条 migration。
    const l1ClosedSetDrift = runStateRegistry((entries) => {
      pick(entries, 'Activity', 'allocationModeCode').stateSet.values = [
        'first_come',
        'qualification_rank',
      ];
    });
    check(
      'R10 4-1b L1 负例:闭集与在册 DB CHECK 不符必被拒',
      l1ClosedSetDrift.code !== 0 &&
        saidThat(l1ClosedSetDrift, 'closed-set CHECK in force') &&
        saidThat(l1ClosedSetDrift, 'but registry declares'),
      l1ClosedSetDrift.out,
    );
    const l1WrongSourceRef = runStateRegistry((entries) => {
      // 形似但非法:指向另一条**真实存在**的 migration(不是瞎编的路径)。
      pick(entries, 'Activity', 'allocationModeCode').stateSet.sourceRef =
        'prisma/migrations/20260804020000_activity_v11_slice1_sessions_participation_capacity';
    });
    check(
      'R10 4-1b L1 负例:sourceRef 指向别的真 migration 必被拒',
      l1WrongSourceRef.code !== 0 &&
        saidThat(
          l1WrongSourceRef,
          'stateSet.sourceRef must name the migration holding the CHECK in force',
        ),
      l1WrongSourceRef.out,
    );
    const l1FakeEdges = runStateRegistry((entries) => {
      const entry = pick(entries, 'SettlementReviewAction', 'stageCode');
      if (entry.governedEvidence !== undefined) entry.governedEvidence.edgeModel = 'enumerated';
    });
    check(
      'R10 4-1b L1 负例:配置列谎称 enumerated 边模型必被拒',
      l1FakeEdges.code !== 0 &&
        saidThat(l1FakeEdges, 'L1 governed requires governedEvidence.edgeModel "unconstrained"'),
      l1FakeEdges.out,
    );

    // 声明一致性:两个方向都堵死 —— 缺证据不许 governed,inventory 也不许留陈旧证据。
    const governedWithoutEvidence = runStateRegistry((entries) => {
      delete pick(entries, 'ActivityAllocationBatch', 'modeCode').governedEvidence;
    });
    check(
      'R10 4-1b 负例:governed 但不带 governedEvidence 必被拒',
      governedWithoutEvidence.code !== 0 &&
        saidThat(governedWithoutEvidence, 'governed requires governedEvidence'),
      governedWithoutEvidence.out,
    );
    const staleEvidence = runStateRegistry((entries) => {
      pick(entries, 'Activity', 'statusCode').governedEvidence = {
        edgeModel: 'unconstrained',
        wrongStateBizCodes: [],
      };
    });
    check(
      'R10 4-1b 负例:inventory 条目携带陈旧 governedEvidence 必被拒',
      staleEvidence.code !== 0 &&
        saidThat(staleEvidence, 'inventory entries must not carry governedEvidence'),
      staleEvidence.out,
    );
    const governedWithBlockers = runStateRegistry((entries) => {
      pick(entries, 'ActivityInvitation', 'statusCode').governanceStatus = 'governed';
    });
    check(
      'R10 4-1b 负例:仍带 governedBlockers 不许标 governed',
      governedWithBlockers.code !== 0 &&
        saidThat(governedWithBlockers, 'governed requires empty governedBlockers'),
      governedWithBlockers.out,
    );
    const badStatus = runStateRegistry((entries) => {
      pick(entries, 'Activity', 'statusCode').governanceStatus = 'partially-governed';
    });
    check(
      'R10 4-1b 负例:governanceStatus 只认 inventory | governed',
      badStatus.code !== 0 &&
        saidThat(badStatus, 'governanceStatus must be "inventory" or "governed"'),
      badStatus.out,
    );

    // B 类恒 report:复用上面那次 `--violations`(不另起一次 typed 扫描)。
    // 这里钉两件事:①它明确自述 report-only ②「只比闭集的空绿面」这个读数真的被算出来了。
    let stateGovernance: {
      enforcement?: string;
      byStatus?: Record<string, number>;
      edgeCoverage?: Record<string, number>;
    } = {};
    try {
      stateGovernance = (
        JSON.parse(r15Scan.out) as { stateGovernance: typeof stateGovernance }
      ).stateGovernance;
    } catch {
      // 断言失败时下面会打出原始输出。
    }
    check(
      'R10 4-1b B 类:--violations 报出状态机治理面且恒 report-only',
      stateGovernance.enforcement === 'report-only' &&
        stateGovernance.byStatus?.governed === 8 &&
        typeof stateGovernance.edgeCoverage?.vacuousGreenIfClosedSetOnly === 'number' &&
        // 空绿面必须 > 0,否则这份报告在自述「只比闭集也够用」——
        // 而 4-1a 的实测正相反。归零那天该由人来摘这条断言,不是静默通过。
        stateGovernance.edgeCoverage.vacuousGreenIfClosedSetOnly > 0,
      `stateGovernance=${JSON.stringify(stateGovernance)}`,
    );

    checkEq(
      'P0 authz:临时副本 --check 的干净输入通过',
      runFixture('scripts/generate-authz-manifest.ts', ['--check']).code,
      0,
    );
    const fixtureClassification = path.join(fixtureRoot, 'harness/route-authz-classification.json');
    fs.writeFileSync(fixtureClassification, '{"retired":true}\n', 'utf8');
    const residualOverlay = runFixture('scripts/generate-authz-manifest.ts', ['--check']);
    fs.rmSync(fixtureClassification, { force: true });
    check(
      'P1 overlay 退役负例:残留 classification 文件必被 --check 拒绝',
      residualOverlay.code !== 0 &&
        residualOverlay.out.includes(
          'retired classification overlay must not exist: harness/route-authz-classification.json',
        ),
      residualOverlay.out,
    );
    const retiredMode = runFixture('scripts/generate-authz-manifest.ts', ['--plan-surface=admin']);
    check(
      'P1 overlay 退役负例:旧 codemod mode 不再可用',
      retiredMode.code !== 0 && retiredMode.out.includes('overlay transition modes are retired'),
      retiredMode.out,
    );
    const fixtureAppActivities = path.join(
      fixtureRoot,
      'src/modules/activities/controllers/app-activities.controller.ts',
    );
    const originalAppActivities = fs.readFileSync(fixtureAppActivities, 'utf8');
    fs.writeFileSync(
      fixtureAppActivities,
      originalAppActivities.replace('@LoginScoped(', '@LoginScopedRetired('),
      'utf8',
    );
    const missingDeclaration = runFixture('scripts/generate-authz-manifest.ts', ['--check']);
    fs.writeFileSync(fixtureAppActivities, originalAppActivities, 'utf8');
    check(
      'P1 全量声明负例:任一路由缺声明必被 --check 拒绝',
      missingDeclaration.code !== 0 &&
        missingDeclaration.out.includes('route authorization declaration missing:'),
      missingDeclaration.out,
    );
    const fixtureAssertionPatterns = path.join(
      fixtureRoot,
      'harness/authz-assertion-patterns.json',
    );
    const originalAssertionPatterns = fs.readFileSync(fixtureAssertionPatterns, 'utf8');
    fs.writeFileSync(
      fixtureAssertionPatterns,
      originalAssertionPatterns.replace('rbac-can', 'rbac-can-mutated'),
      'utf8',
    );
    const staleAssertionPatterns = runFixture('scripts/generate-authz-manifest.ts', ['--check']);
    fs.writeFileSync(fixtureAssertionPatterns, originalAssertionPatterns, 'utf8');
    check(
      'P1 assertion patterns:手改 JSON 必被单一来源新鲜度检查拒绝',
      staleAssertionPatterns.code !== 0 &&
        staleAssertionPatterns.out.includes('harness/authz-assertion-patterns.json is stale'),
      staleAssertionPatterns.out,
    );
    const staleAuthz = mutateInputAndRun(
      'src/app.module.ts',
      'scripts/generate-authz-manifest.ts',
      ['--check'],
    );
    check(
      'P1 inputDigest 阳性:触碰任一 authz 输入文件必使生成物过期',
      staleAuthz.code !== 0 &&
        staleAuthz.out.includes(
          'docs/ai-harness/ROUTE_AUTHZ.md is stale; run generator with --write',
        ),
      staleAuthz.out,
    );
  } catch (error) {
    check(
      'P0 inputDigest 阳性:临时副本可真实执行登记表与生成器',
      false,
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
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
      if (line.startsWith('## src/modules/')) {
        inSec = true;
        continue;
      }
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
    checkEq('P4b codemap:生成幂等(第二次无改动)', fs.readFileSync(codemapPath, 'utf8'), original);

    // 3) 正向对照:体量列被篡改 → --check 必须 exit 1
    const tampered = original.replace(/^(\|\s*`activities\/`\s*\|)[^|]*\|/m, '$1 S 1L |');
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
      // ⚠️ 逐字钉住**整份** needs 列表,不只钉 redzone 两项 —— 这是有意的:
      // 从 gate.needs 摘掉 fast / slow / journeys / harness-* 中任何一个,gate 都会在
      // 那项根本没跑的情况下放行,那正是最该拦的 fail-open。代价是往 gate 加 job 必须
      // 同步改本行;那不是麻烦,是加 job 该有的摩擦。
      // harness-selftest / harness-replay 于 2026-08-15 从 fast 拆出(见 ci.yml 两个
      // job 的头注):它们恒跑、docs-only 也不跳,故 gate 对它们只接受 success。
      /needs:\s*\[changeset, fast, harness-selftest, harness-replay, slow, journeys, redzone-scan, redzone-approval\]/.test(
        ci,
      ),
      'gate 不依赖这两个 job = 审批不影响放行,门形同虚设',
    ],
    [
      'P2c ci:scan 未成功即拒绝放行(无法验证 ≠ 通过)',
      ci.includes('红区扫描未成功'),
      'scan 失败时若不拦,等于在没查的情况下宣布没触碰(INC-07 同型)',
    ],
    [
      'P2c ci:approval 跳过必须由 touched=false 正面证明',
      ci.includes('case "$touched" in') && ci.includes('未触碰红区却跑了审批'),
      '从 skipped 反推「没触碰」= INC-09 原样复发',
    ],
    [
      'P2c ci:touched 无明确结论时 fail-closed',
      ci.includes('未给出明确结论'),
      'touched 为空/error 时若放行,scan 崩溃就等于绕过整层',
    ],
    [
      // 2026-07-29 清账:环境审批从 ci.yml 的 redzone-approval **搬到**了独立的
      // trusted workflow(前者跑 PR 自己的 scan,对着不可信结论要审批是仪式不是保障)。
      // 原断言查的是 ci.yml 里那处环境 —— 若只是删掉,「审批环境必须存在」这条守护
      // 就随搬家一起消失了。**搬家时最容易丢的正是守护本身**,所以本条不删,改为
      // 指向保护真正所在的地方,并额外钉住「ci.yml 侧不得再挂」——
      // 防止将来有人加回去,又变成同一件事批两次的摩擦。
      'F3 trusted:环境审批挂在 base-trusted 裁判上(且 ci.yml 侧不重复)',
      /approval:[\s\S]*?environment:\s*harness-review/.test(
        fs.readFileSync(
          path.resolve(__dirname, '..', '.github/workflows/redzone-trusted.yml'),
          'utf-8',
        ),
      ) && !/redzone-approval:[\s\S]*?environment:\s*harness-review/.test(ci),
      '不挂环境 = 无人审批 job 直接绿;两处都挂 = 每个执法层 PR 要批两次',
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
        const refs = [...ci.matchAll(/(?:node-version-file|env-file|args-file):\s*([^\s#]+)/g)].map(
          (m) => m[1],
        );
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
  // 架构治理 Phase 5:同一个 scan job 里多了第二个执行体(R14 授权语义裁判)。
  // 「引入新执法体却不同步扩保护 = 把防线搬到闸门外」是本仓已记录的事故形状,
  // 所以它在落地的同一刀里就进 F3 断言组,和红区裁判受同一套禁令约束。
  const authzJudgeRaw = fs.readFileSync(
    path.join(repoRoot, '.github/workflows/authz-trusted-judge.mjs'),
    'utf-8',
  );
  const authzJudge = codeOnly(authzJudgeRaw, 'slash');
  // 刀 5-2:同 job 内的第三个执行体(R11 契约语义裁判),同样在落地的同一刀进 F3。
  const contractJudgeRaw = fs.readFileSync(
    path.join(repoRoot, '.github/workflows/contract-trusted-judge.mjs'),
    'utf-8',
  );
  const contractJudge = codeOnly(contractJudgeRaw, 'slash');

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
    // ── 第五轮评审 J2 · L2:棘轮单调性 ──────────────────────────────────────
    [
      // M4:判据从「硬编码那一条基线的路径」换成「遍历注册表」。
      // 断言随之翻面 —— 现在要证明的是**没有**硬编码路径:出现具体基线路径
      // 恰恰说明有人又把某一条写死回去了,而写死等于新棘轮默认不在裁决范围内。
      'F3 judge:棘轮单调性按注册表遍历判定(不硬编码任何一条基线路径)',
      judge.includes('judgeBaselineMonotonicity') &&
        judge.includes('harness/ratchet-registry.json') &&
        judge.includes('parseRatchetRegistryDoc') &&
        !judge.includes('harness/is-optional-null-baseline.json'),
      '这道闸是唯一能拦「同 PR 新增违规 + 顺手加基线」与「A 换 B」的位置;' +
        '写死单一路径 = 第二条棘轮一落地就默认无人裁',
    ],
    [
      'F3 judge:注册表自身只可增不可删(判据的判据也有人看)',
      judge.includes('judgeRegistryMonotonicity') &&
        /failHard\(\s*['"`]棘轮注册表被削减/.test(judge),
      '允许摘条目 ⇒「先把自己从注册表摘掉、再随便改基线」是一条完整的绕过路径',
    ],
    [
      // 上一版把「head 没有这份文件」判成 `{ ok: true }`,理由是 lint 侧会红 ——
      // 而 lint 跑在 PR 自己的树上,同一个 PR 可以顺手改掉加载它的地方。
      'F3 judge:基线被删 / 改名 = 硬失败(不再判成 HEAD = ∅ ⊆ BASE)',
      judge.includes('removedFile') && /failHard\(`棘轮 \$\{ratchet\.id\} 的判据被移走/.test(judge),
      '「删掉判据」与「判据通过」在门禁看来一模一样,正是本裁判存在的理由所反对的',
    ],
    [
      'F3 judge:head 版本走 API 给的 contents_url,不自己拼',
      judge.includes('contents_url'),
      'fork PR 的 head 仓库不同,自己拼 URL 拼错就会取到 base 内容 —— 判据静默变成「自己和自己比」,永远通过',
    ],
    [
      // ⚠️ 判的是**剥掉注释后的代码**:failHard 必须真的存在、真的 exit,
      //    且单调性违规那条路真的走它。注释里写「这是硬失败」不算数
      //    ——「描述文本 ≠ 执行位」本仓一天栽过四次。
      'F3 judge:单调性违规是**硬失败**,不是「要求审批」',
      /function failHard\([\s\S]*?process\.exit\(1\)/.test(judge) &&
        /failHard\(`棘轮 \$\{ratchet\.id\} 被破坏/.test(judge),
      '若退化成 failClosed,维护者点一下 harness-review 就能把破坏棘轮的 PR 放行 —— 那等于没有这道闸',
    ],
    [
      // scan 失败 ⇒ approval job 被 skip ⇒ 没有可点的审批按钮。
      // 这条不变式写在 redzone-trusted.yml 的 verdict 聚合里,不在 judge 里 ——
      // 所以在这里对 yml 复查一次:它一旦被改成「scan 失败也继续」,硬闸就软了。
      'F3 trusted:scan 失败即整体拒绝(硬闸不可被审批绕过的前提)',
      /scan.*!=.*success/.test(yml) && yml.includes('exit 1'),
      'verdict 若不再因 scan 失败而退出,单调性硬闸就退化成「点一下就过」',
    ],
    [
      'F3 judge:head 判据(注册表 + 全部基线)**只 parse 不执行**',
      !/import\s*\(\s*[^)]*harness\//.test(judge) &&
        !/require\s*\(\s*[^)]*harness\//.test(judge) &&
        judge.includes('JSON.parse'),
      'pull_request_target 下 import PR 的文件 = 在有 secrets 的进程里执行 PR 代码(这正是 L1 把基线抽成 JSON 的原因)',
    ],
    // ── R14 授权语义裁判:同 job 内的第二个执行体,受同一套禁令 ────────────────
    [
      'F3 authz:裁判脚本取自 base checkout 的固定路径',
      yml.includes('node .github/workflows/authz-trusted-judge.mjs'),
      '跑 PR 提供的脚本就是 finding 2 本身 —— 第二个执行体同样适用',
    ],
    [
      'F3 authz:裁判只 import node: 内置模块(不碰 node_modules)',
      (authzJudgeRaw.match(/^import .* from '([^']+)'/gm) ?? []).every((l) =>
        l.includes("from 'node:"),
      ),
      '一旦 import 第三方包就必须装依赖,禁令②随之破功',
    ],
    [
      // 判据必须来自 base:比较器、蕴含图、权限码全集三者任一取自 head,
      // PR 就能自己把「换码」洗成「收紧」(加一条蕴含边即可)。
      'F3 authz:比较器与判据登记表全部取自 base 的固定相对路径',
      authzJudge.includes("'scripts/authz-semantic-diff.ts'") &&
        authzJudge.includes("'harness/authz-implication-graph.json'") &&
        authzJudge.includes("'docs/ai-harness/RBAC_MAP.md'") &&
        authzJudge.includes('--experimental-strip-types'),
      'PR 若能提供蕴含图,加一条 A⇒B 边就能把自己的换码洗成收紧 —— 判据必须来自 base',
    ],
    [
      'F3 authz:head 版本走 API 给的 contents_url,不自己拼',
      authzJudge.includes('contents_url'),
      'fork PR 的 head 仓库不同,拼错就会取到 base 内容 —— 判据静默变成「自己和自己比」,永远通过',
    ],
    [
      'F3 authz:变更清单翻页且与 changed_files 对账(禁静默截断)',
      authzJudge.includes('--paginate') && authzJudge.includes('expectedCount'),
      'pulls/files 端点上限 3000 且**静默**截断;不对账就会在超大 PR 上漏判降级',
    ],
    [
      'F3 authz:head 内容**只解码写盘 + 解析,不执行**',
      !/import\s*\(/.test(authzJudge) &&
        !/\brequire\s*\(/.test(authzJudge) &&
        authzJudge.includes('JSON.parse'),
      'pull_request_target 下 import PR 的文件 = 在有 secrets 的进程里执行 PR 代码',
    ],
    [
      // 与棘轮硬闸同构:申报缺失是**查清楚了的违规**,不是「查不出来」。
      // 退化成 failClosed 的话,维护者点一下 harness-review 就能把「降级且没申报」放行。
      'F3 authz:申报缺失是**硬失败**,不是「要求审批」',
      /function failHard\([\s\S]*?process\.exit\(1\)/.test(authzJudge) &&
        /failHard\(\s*['"`]授权语义门/.test(authzJudge),
      '若退化成 failClosed,点一下审批就能放行「降级且未申报」—— 那等于没有这道闸',
    ],
    [
      'F3 authz:异常一律 fail-closed(要求审批)',
      authzJudge.includes('failClosed') && authzJudge.includes("emit(OUTPUT_KEY, 'true')"),
      '「查不出来」永远不等于「没降级」',
    ],
    [
      // verdict 若只看 required,authzRequired=true 的 PR 会在 approval 被跳过时
      // 落进「未触碰红区」分支直接放行 —— 第二路裁决必须真的参与聚合。
      'F3 trusted:verdict 聚合把授权降级那一路一起判(两路都要明确 true/false)',
      yml.includes("authz_required='${{ needs.scan.outputs.authzRequired }}'") &&
        yml.includes('needs.scan.outputs.authzRequired == \'true\'') &&
        /for verdict in "\$required" "\$authz_required"/.test(yml),
      '只看 required 的话,授权降级的 PR 会因 approval 被跳过而落进「无需审批」分支放行',
    ],
    // ── R11 契约语义裁判:同 job 内的第三个执行体,受同一套禁令 ────────────────
    [
      'F3 contract:裁判脚本取自 base checkout 的固定路径',
      yml.includes('node .github/workflows/contract-trusted-judge.mjs'),
      '跑 PR 提供的脚本就是 finding 2 本身 —— 第三个执行体同样适用',
    ],
    [
      'F3 contract:裁判只 import node: 内置模块(不碰 node_modules)',
      (contractJudgeRaw.match(/^import .* from '([^']+)'/gm) ?? []).every((l) =>
        l.includes("from 'node:"),
      ),
      '一旦 import 第三方包就必须装依赖,禁令②随之破功',
    ],
    [
      'F3 contract:比较器取自 base 的固定相对路径,用内置 strip-types 跑',
      contractJudge.includes("'scripts/contract-semantic-diff.ts'") &&
        contractJudge.includes('--experimental-strip-types'),
      '判定表若来自 head,PR 就能把自己的破坏改判成 additive',
    ],
    [
      // openapi.json ~3.8MB 超过 contents API 的 1MB 上限,必须走 raw_url;
      // 但仍必须是 **API 给出的** URL,不能自己拼(fork PR 的 head 仓库不同)。
      'F3 contract:head 版本走 API 给出的 raw_url / contents_url,不自己拼',
      contractJudge.includes('raw_url') && contractJudge.includes('contents_url'),
      '自己拼 URL 拼错就会取到 base 内容 —— 判据静默变成「自己和自己比」,永远通过',
    ],
    [
      'F3 contract:变更清单翻页且与 changed_files 对账(禁静默截断)',
      contractJudge.includes('--paginate') && contractJudge.includes('expectedCount'),
      'pulls/files 端点上限 3000 且**静默**截断;不对账就会在超大 PR 上漏判破坏',
    ],
    [
      'F3 contract:head 内容**只 parse 不执行**',
      !/import\s*\(/.test(contractJudge) &&
        !/\brequire\s*\(/.test(contractJudge) &&
        contractJudge.includes('JSON.parse'),
      'pull_request_target 下 import PR 的文件 = 在有 secrets 的进程里执行 PR 代码',
    ],
    [
      'F3 contract:申报缺失是**硬失败**,不是「要求审批」',
      /function failHard\([\s\S]*?process\.exit\(1\)/.test(contractJudge) &&
        /failHard\(\s*['"`]契约语义门/.test(contractJudge),
      '若退化成 failClosed,点一下审批就能放行「破坏且未申报」—— 那等于没有这道闸',
    ],
    [
      'F3 contract:异常一律 fail-closed(要求审批)',
      contractJudge.includes('failClosed') && contractJudge.includes("emit(OUTPUT_KEY, 'true')"),
      '「查不出来」永远不等于「没破坏」',
    ],
    [
      'F3 trusted:verdict 聚合把契约破坏那一路一起判(三路都要明确 true/false)',
      yml.includes("contract_required='${{ needs.scan.outputs.contractRequired }}'") &&
        yml.includes("needs.scan.outputs.contractRequired == 'true'") &&
        /for verdict in "\$required" "\$authz_required" "\$contract_required"/.test(yml),
      '只看前两路的话,破坏契约的 PR 会因 approval 被跳过而落进「无需审批」分支放行',
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
    // 每条 glob 至少 1 正 1 反。`no` 的语义是**全局不受保护**(不是「只不被这条命中」),
    // 所以负样例都挑成不会被别的 glob 顺手捞走的近似路径。
    const GLOB_EXPECTATIONS: ReadonlyArray<{
      glob: string;
      yes: readonly string[];
      no: readonly string[];
    }> = [
      // ── redzone ──
      { glob: 'AGENTS.md', yes: ['AGENTS.md'], no: ['docs/AGENTS.md'] },
      { glob: 'CLAUDE.md', yes: ['CLAUDE.md'], no: ['src/modules/users/CLAUDE.md'] },
      { glob: '.claude/CLAUDE.md', yes: ['.claude/CLAUDE.md'], no: ['.claude/NOTES.md'] },
      { glob: 'ARCHITECTURE.md', yes: ['ARCHITECTURE.md'], no: ['docs/ARCHITECTURE.md'] },
      {
        glob: 'docs/srvf-foundation-baseline.md',
        yes: ['docs/srvf-foundation-baseline.md'],
        no: ['docs/srvf-foundation-baseline-v2.md'],
      },
      {
        glob: 'docs/V2红线与复活路径.md',
        yes: ['docs/V2红线与复活路径.md'],
        no: ['docs/V2红线与复活路径.bak.md'],
      },
      {
        glob: 'docs/api-surface-policy.md',
        yes: ['docs/api-surface-policy.md'],
        no: ['docs/api-surface-policy-draft.md'],
      },
      {
        glob: '.github/workflows/**',
        yes: ['.github/workflows/ci.yml', '.github/workflows/redzone-trusted-judge.mjs'],
        no: ['.github/ISSUE_TEMPLATE.md'],
      },
      {
        glob: 'prisma/schema.prisma',
        yes: ['prisma/schema.prisma'],
        no: ['prisma/schema.prisma.bak'],
      },
      {
        glob: 'prisma/migrations/**',
        yes: ['prisma/migrations/20260101_x/migration.sql'],
        no: ['prisma/migrations-archive/old.sql'],
      },
      { glob: 'prisma/seed.ts', yes: ['prisma/seed.ts'], no: ['prisma/seed-helpers.ts'] },
      {
        glob: 'src/modules/permissions/rbac-seed-facts.ts',
        yes: ['src/modules/permissions/rbac-seed-facts.ts'],
        no: ['src/modules/permissions/rbac-seed-fact.ts'],
      },
      {
        glob: 'src/common/guards/**',
        yes: ['src/common/guards/jwt-auth.guard.ts'],
        no: ['src/common/guards.ts'],
      },
      {
        glob: 'src/common/filters/**',
        yes: ['src/common/filters/http-exception.filter.ts'],
        no: ['src/common/filters.ts'],
      },
      {
        glob: 'src/common/interceptors/**',
        yes: ['src/common/interceptors/response.interceptor.ts'],
        no: ['src/common/interceptors.ts'],
      },
      {
        glob: 'src/bootstrap/**',
        yes: ['src/bootstrap/apply-global-setup.ts'],
        no: ['src/bootstrapper.ts'],
      },
      {
        glob: 'src/modules/auth/**',
        yes: ['src/modules/auth/auth.service.ts'],
        no: ['src/modules/authors/authors.service.ts'],
      },
      {
        glob: 'src/modules/authz/**',
        yes: ['src/modules/authz/authz.service.ts'],
        no: ['src/modules/authzx/x.service.ts'],
      },
      {
        // finding 5 的落点:原 `src/**/*throttler*` 实测零命中,且仓内真名少个 r。
        // 两种拼法各来一条,其中 rate-throttler 刻意放在**不被别的 glob 覆盖**的目录下,
        // 这样它证明的确实是本条 glob(否则会被 src/bootstrap/** 之类顺手捞走)。
        glob: 'src/**/*throttle*',
        yes: [
          'src/common/decorators/login-throttle.decorator.ts',
          'src/modules/ratelimit/rate-throttler.service.ts',
        ],
        no: ['src/modules/ratelimit/rate-limit.service.ts'],
      },
      { glob: 'src/main.ts', yes: ['src/main.ts'], no: ['src/main.spec.ts'] },
      { glob: 'src/app.module.ts', yes: ['src/app.module.ts'], no: ['src/app.controller.ts'] },
      {
        glob: 'scripts/release-prepare.ts',
        yes: ['scripts/release-prepare.ts'],
        no: ['scripts/release-notes.ts'],
      },
      {
        glob: 'scripts/release-finish.ts',
        yes: ['scripts/release-finish.ts'],
        no: ['scripts/release-finish.md'],
      },
      {
        glob: 'src/modules/storage/storage-crypto.service.ts',
        yes: ['src/modules/storage/storage-crypto.service.ts'],
        no: ['src/modules/storage/storage.service.ts'],
      },
      {
        // allowCreate:**改既有**拦、**新建**放行。判据是磁盘上文件在不在,
        // 所以 yes 必须挑一个真实存在的归档文件。
        glob: 'docs/archive/**',
        yes: ['docs/archive/plans/harness-3.0-blueprint.md'],
        no: ['docs/archived/not-the-archive.md'],
      },
      { glob: '.env.test', yes: ['.env.test'], no: ['.env.testing'] },
      { glob: 'Dockerfile', yes: ['Dockerfile'], no: ['Dockerfile.dev'] },
      { glob: '.dockerignore', yes: ['.dockerignore'], no: ['.dockerignore.bak'] },
      {
        glob: 'docker-compose.yml',
        yes: ['docker-compose.yml'],
        no: ['docker-compose.override.yml'],
      },
      // ── selfGuard ──
      {
        glob: 'harness/**',
        yes: ['harness/redzone.json', 'harness/incidents.json'],
        no: ['harness.md'],
      },
      {
        glob: '.claude/hooks/**',
        yes: ['.claude/hooks/redzone-guard.sh'],
        no: ['.claude/hooks.md'],
      },
      {
        glob: '.claude/settings.json',
        yes: ['.claude/settings.json'],
        no: ['.claude/settings.local.json'],
      },
      {
        glob: '.claude/settings.example.json',
        yes: ['.claude/settings.example.json'],
        no: ['.claude/settings.example.md'],
      },
      { glob: '.claude/rules/**', yes: ['.claude/rules/anything.md'], no: ['.claude/rules.md'] },
      { glob: 'eslint.harness.mjs', yes: ['eslint.harness.mjs'], no: ['eslint.harness.test.mjs'] },
      {
        // 2026-07-31(第五轮评审 J2·L3):第 18 条从选择器换成本仓首条真自定义规则,
        // 规则体是**新的执法体**,与 eslint.harness.mjs 是同一道防线的两半。
        // 负样例刻意挑 src/ 下的同名目录:确认保护绑的是仓库根那一个,没有顺手捞走别处。
        glob: 'eslint-rules/**',
        yes: ['eslint-rules/no-nullable-is-optional.mjs'],
        no: ['src/eslint-rules/no-nullable-is-optional.mjs'],
      },
      { glob: 'scripts/check-*.ts', yes: ['scripts/check-redzone.ts'], no: ['scripts/checker.ts'] },
      { glob: 'scripts/check-*.sh', yes: ['scripts/check-quick.sh'], no: ['scripts/checkup.sh'] },
      {
        glob: 'scripts/*.selftest.ts',
        yes: ['scripts/harness-guards.selftest.ts'],
        no: ['scripts/harness-guards.selftest.js'],
      },
      {
        glob: 'scripts/*.selftest.sh',
        yes: ['scripts/agent-preflight.selftest.sh'],
        no: ['scripts/agent-preflight.selftest.bash'],
      },
      {
        glob: 'scripts/agent-preflight.sh',
        yes: ['scripts/agent-preflight.sh'],
        no: ['scripts/agent-preflight.ts'],
      },
      {
        glob: 'scripts/docs-counts.ts',
        yes: ['scripts/docs-counts.ts'],
        no: ['scripts/docs-count.ts'],
      },
      {
        glob: 'scripts/docs-readtax.ts',
        yes: ['scripts/docs-readtax.ts'],
        no: ['scripts/docs-readtax.md'],
      },
      {
        glob: 'scripts/harness-grant.ts',
        yes: ['scripts/harness-grant.ts'],
        no: ['scripts/harness-grants.ts'],
      },
      {
        glob: 'scripts/db-test-prune.ts',
        yes: ['scripts/db-test-prune.ts'],
        no: ['scripts/db-test-prune.sh'],
      },
      {
        glob: 'scripts/generate-*.ts',
        yes: ['scripts/generate-codemap.ts'],
        no: ['scripts/generator.ts'],
      },
      {
        glob: 'scripts/replay-*.ts',
        yes: ['scripts/replay-incidents.ts'],
        no: ['scripts/replayer.ts'],
      },
      {
        // R14 / R11 两支语义门的判据本体(架构治理 Phase 5)。反样例挑 `-semantic-diff.mjs`:
        // 比较器刻意写成「tsx 与裸 node 都能跑」的 .ts,若哪天有人图省事复制成 .mjs
        // 旁路一份,它不在保护内 —— 这条反样例把那个形状钉出来。
        glob: 'scripts/*-semantic-diff.ts',
        yes: ['scripts/authz-semantic-diff.ts', 'scripts/contract-semantic-diff.ts'],
        no: ['scripts/authz-semantic-diff.mjs', 'scripts/semantic-diff.ts'],
      },
      { glob: 'test/setup/**', yes: ['test/setup/test-db.ts'], no: ['test/setup.ts'] },
      {
        glob: 'test/contract/**',
        yes: ['test/contract/openapi.contract-spec.ts'],
        no: ['test/contracts.ts'],
      },
      {
        glob: 'docs/ai-harness/BASELINE_HEALTH.md',
        yes: ['docs/ai-harness/BASELINE_HEALTH.md'],
        no: ['docs/ai-harness/BASELINE_HEALTH-draft.md'],
      },
      {
        glob: 'docs/ai-harness/EXTERNAL_IO_INVENTORY.md',
        yes: ['docs/ai-harness/EXTERNAL_IO_INVENTORY.md'],
        no: ['docs/ai-harness/EXTERNAL_IO_INVENTORY-draft.md'],
      },
      {
        glob: 'docs/ai-harness/ROUTE_AUTHZ.md',
        yes: ['docs/ai-harness/ROUTE_AUTHZ.md'],
        no: ['docs/ai-harness/ROUTE_AUTHZ-draft.md'],
      },
      {
        glob: 'docs/archive/reviews/architecture-governance-v4/README.md',
        yes: ['docs/archive/reviews/architecture-governance-v4/README.md'],
        no: ['docs/archive/reviews/architecture-governance-v4/README-draft.md'],
      },
      {
        glob: 'docs/archive/reviews/architecture-governance-v4/DECISIONS-2026-08-09.md',
        yes: ['docs/archive/reviews/architecture-governance-v4/DECISIONS-2026-08-09.md'],
        no: ['docs/archive/reviews/architecture-governance-v4/DECISIONS-draft.md'],
      },
      {
        glob: 'changelog.d/architecture-governance-phase0.added.md',
        yes: ['changelog.d/architecture-governance-phase0.added.md'],
        no: ['changelog.d/architecture-governance-phase0-draft.added.md'],
      },
      {
        glob: 'changelog.d/architecture-governance-phase0-gate.added.md',
        yes: ['changelog.d/architecture-governance-phase0-gate.added.md'],
        no: ['changelog.d/architecture-governance-phase0-gate-draft.added.md'],
      },
      { glob: 'package.json', yes: ['package.json'], no: ['src/vendor/package.json'] },
      { glob: 'pnpm-lock.yaml', yes: ['pnpm-lock.yaml'], no: ['pnpm-workspace.yaml'] },
      { glob: 'eslint.config.mjs', yes: ['eslint.config.mjs'], no: ['eslint.config.js'] },
      { glob: 'tsconfig.json', yes: ['tsconfig.json'], no: ['tsconfig.build.json'] },
      {
        glob: 'test/tsconfig.test.json',
        yes: ['test/tsconfig.test.json'],
        no: ['test/tsconfig.json'],
      },
      {
        glob: 'scripts/tsconfig.json',
        yes: ['scripts/tsconfig.json'],
        no: ['scripts/tsconfig.build.json'],
      },
      {
        glob: 'prisma/tsconfig.eslint.json',
        yes: ['prisma/tsconfig.eslint.json'],
        no: ['prisma/tsconfig.json'],
      },
      {
        glob: 'test/jest-*.config.ts',
        yes: ['test/jest-e2e.config.ts', 'test/jest-unit.config.ts'],
        no: ['test/jest.config.ts'],
      },
      { glob: 'nest-cli.json', yes: ['nest-cli.json'], no: ['nest-cli.dev.json'] },
      {
        glob: 'scripts/harness-needs.ts',
        yes: ['scripts/harness-needs.ts'],
        no: ['scripts/harness-need.ts'],
      },
    ];

    // ① 覆盖闭环:registry 里每条 glob 都必须在期望值表里有正反样例。
    // 加了新 glob 却不加样例 = 那条 glob 从此没有阳性对照,写错了也没人知道
    // (与 eslint 侧「选择器覆盖闭环」同源;INC-06 就是这么静默失效的)。
    const registry = (
      require('./check-redzone') as {
        loadRegistry: () => {
          redzone: Array<{ globs: string[] }>;
          selfGuard: Array<{ globs: string[] }>;
        };
      }
    ).loadRegistry();
    const registryGlobs = [...registry.redzone, ...registry.selfGuard].flatMap((e) => e.globs);
    const tabled = new Set(GLOB_EXPECTATIONS.map((g) => g.glob));
    const uncovered = registryGlobs.filter((g) => !tabled.has(g));
    check(
      `F4 glob 覆盖闭环:${registryGlobs.length}/${registryGlobs.length} 条 glob 均有正反样例`,
      uncovered.length === 0,
      `缺样例的 glob:${uncovered.join(', ')}`,
    );
    const stale = [...tabled].filter((g) => !registryGlobs.includes(g));
    check(
      'F4 glob 覆盖闭环:期望值表里没有 registry 已删除的陈旧 glob',
      stale.length === 0,
      `registry 已无此 glob:${stale.join(', ')}`,
    );

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

    // ② 三方比对:fixture + **期望值** + TS 结果 + Hook 结果。
    //
    // 为什么必须有「期望值」这一列(2026-07-29 跨模型评审 finding 5):
    // 旧版只断言「两边相等」。而 hook 与 TS 的 glob 引擎是**一致地错**的 ——
    // 37 条用例全绿,证明的只是「两把刻错的尺子读数相同」,
    // `src/**/*throttler*` 零命中这件事一条用例都没抓到。
    // parity(一致)≠ correctness(正确),期望值那一列才是后者。
    let tsWrong = 0;
    let hookWrong = 0;
    let disagree = 0;
    let total = 0;
    for (const { glob, yes, no } of GLOB_EXPECTATIONS) {
      for (const [paths, expected] of [
        [yes, true],
        [no, false],
      ] as const) {
        for (const rel of paths) {
          total++;
          const added = !fs.existsSync(path.join(REPO, rel));
          const ts = judge(rel, added) !== null;
          const hook = hookBlocks(rel);
          if (ts !== expected) {
            tsWrong++;
            failures.push(
              `✗ F4 期望值(TS):${rel} — 期望${expected ? '拦' : '放'},TS 实际${ts ? '拦' : '放'}(glob ${glob})`,
            );
          }
          if (hook !== expected) {
            hookWrong++;
            failures.push(
              `✗ F4 期望值(Hook):${rel} — 期望${expected ? '拦' : '放'},Hook 实际${hook ? '拦' : '放'}(glob ${glob})`,
            );
          }
          if (ts !== hook) {
            disagree++;
            failures.push(
              `✗ F4 parity 分歧:${rel} — hook ${hook ? '拦' : '放'} / TS ${ts ? '拦' : '放'}`,
            );
          }
        }
      }
    }
    check(`F4 三方比对:${total} 条样例 TS 裁决 == 期望值`, tsWrong === 0, `${tsWrong} 条不符`);
    check(
      `F4 三方比对:${total} 条样例 Hook 裁决 == 期望值`,
      hookWrong === 0,
      `${hookWrong} 条不符`,
    );
    check(`F4 三方比对:${total} 条样例 TS 与 Hook 一致`, disagree === 0, `${disagree} 条分歧`);
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
    $queryRawUnsafe: <T = unknown>(): Promise<T> => Promise.resolve(rows as T),
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
    judgeBaselineMonotonicity: (
      baseText: string,
      headText: string | null,
      relPath?: string,
    ) => { ok: boolean; added: string[]; removedFile: boolean };
    judgeNumericMonotonicity: (
      baseText: string,
      headText: string | null,
      metric: string,
      relPath?: string,
    ) => { ok: boolean; added: string[]; grown: string[]; removedFile: boolean };
    judgeSetMonotonicity: (
      baseText: string,
      headText: string | null,
      setField: string,
      relPath?: string,
    ) => { ok: boolean; added: string[]; grown: string[]; removedFile: boolean };
    judgeRegistryMonotonicity: (
      baseText: string,
      headText: string | null,
    ) => {
      ok: boolean;
      removed: string[];
      deleted: boolean;
      mutated: Array<{ id: string; field: string; base: string; head: string }>;
    };
    judgeRuleUnionMonotonicity: (
      baseUnions: Map<string, Set<string>>,
      headUnions: Map<string, Set<string>>,
    ) => { ok: boolean; added: Array<{ rule: string; key: string }> };
    registryFailureKind: (verdict: {
      deleted: boolean;
      removed: string[];
      mutated: unknown[];
    }) => 'removed' | 'mutated' | null;
    parseRatchetRegistryDoc: (
      text: string,
      which: string,
    ) => Array<{
      id: string;
      // EC-1:kind 省略时由解析器填 'eslint-exempt';numeric / set 型不带 rule/symbolShape。
      kind: string;
      baseline: string;
      rule?: string;
      symbolShape?: string;
      metric?: string;
      setField?: string;
    }>;
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

  // ── 第 18 条棘轮单调性的**行为**断言(M4 / M5 —— 第五轮评审两条 FAIL)────────
  //
  // 为什么这两条只能在这里验、不能在 harness-eslint.selftest 里验:
  // 它们要的是**两份不同的基线**(base 一份、head 一份)同时在场。
  // `pnpm lint` 与 `harness:selftest` 在 PR 的树上都只看得到 head 那一份 ——
  // 「新增违规 + 同 PR 加基线」于是两边全绿,因为 PR 改的正是判据本身。
  // 真实 CI 行为(走 GitHub API 取 head 版本)只能在 main 上实跑验证一次。
  {
    const doc = (entries: Array<{ file: string; symbol: string }>): string =>
      JSON.stringify({ version: 1, entries });
    const BASE = doc([
      { file: 'a.dto.ts', symbol: 'A.x' },
      { file: 'a.dto.ts', symbol: 'A.y' },
      { file: 'b.dto.ts', symbol: 'B.z' },
    ]);
    const verdict = (head: string | null): boolean =>
      judge.judgeBaselineMonotonicity(BASE, head).ok;

    check('F3 单调性:HEAD == BASE → 放行', verdict(BASE), '不改基线的 PR 不该被这道闸打扰');
    check(
      'F3 单调性:只删不增 → 放行(棘轮就是要让它缩)',
      verdict(doc([{ file: 'a.dto.ts', symbol: 'A.x' }])),
      '还债必须畅通,否则下一个人会绕开棘轮而不是还债',
    );
    check(
      'F3 单调性 · M4:新增违规 + 同 PR 把它加进基线 → 拒',
      !verdict(
        doc([
          { file: 'a.dto.ts', symbol: 'A.x' },
          { file: 'a.dto.ts', symbol: 'A.y' },
          { file: 'b.dto.ts', symbol: 'B.z' },
          { file: 'c.dto.ts', symbol: 'C.brandNew' },
        ]),
      ),
      'lint 与 selftest 读的都是 PR 自己的基线,这一种只有 base-trusted 裁判拦得住',
    );
    check(
      'F3 单调性 · M5:A 换 B(**总数不变**)→ 拒',
      !verdict(
        doc([
          { file: 'a.dto.ts', symbol: 'A.x' },
          { file: 'a.dto.ts', symbol: 'A.y' },
          { file: 'c.dto.ts', symbol: 'C.brandNew' },
        ]),
      ),
      '按 (file, symbol) 集合判而不是看总数 —— 看总数的判据对这一种完全失明',
    );
    check(
      'F3 单调性:同文件内换 symbol(总数不变)→ 拒',
      !verdict(
        doc([
          { file: 'a.dto.ts', symbol: 'A.x' },
          { file: 'a.dto.ts', symbol: 'A.RENAMED' },
          { file: 'b.dto.ts', symbol: 'B.z' },
        ]),
      ),
      '同一文件内的 A 换 B 连「文件数」都不变,更隐蔽',
    );
    for (const [name, bad] of [
      ['非法 JSON', '{oops'],
      ['缺 entries 数组', '{"version":1}'],
      ['条目缺 symbol', '{"version":1,"entries":[{"file":"a.dto.ts"}]}'],
    ] as const) {
      let threw = false;
      try {
        judge.judgeBaselineMonotonicity(BASE, bad);
      } catch {
        threw = true;
      }
      check(
        `F3 单调性 fail-closed:head 基线${name} → 抛(交由 failClosed 拦)`,
        threw,
        '判不了就必须响,静默当成「没新增」等于给畸形文档开了后门',
      );
    }

    // ── M4 · 三洞封堵的**行为**断言(不是 grep 源码字符串)────────────────────
    check(
      'F3 单调性 · M4:基线被删 / 改名 → 拒(不再判成 HEAD = ∅ ⊆ BASE)',
      judge.judgeBaselineMonotonicity(BASE, null).removedFile === true &&
        judge.judgeBaselineMonotonicity(BASE, null).ok === false,
      '上一版判成「成立」的理由是「lint 侧会红」—— 而 lint 跑在 PR 自己的树上,同一个 PR 改得掉',
    );
    check(
      'F3 单调性 · M4:清零走空 entries 仍放行(留下可 review 的零,而不是消失的文件)',
      judge.judgeBaselineMonotonicity(BASE, doc([])).ok,
      '还债必须畅通;禁的是「文件不见了」,不是「清单空了」',
    );

    const reg = (ids: string[]): string =>
      JSON.stringify({
        version: 1,
        ratchets: ids.map((id) => ({
          id,
          baseline: `harness/${id}.json`,
          rule: `srvf/${id}`,
          symbolShape: 'class-field',
          why: 'w',
        })),
      });
    const BASE_REG = reg(['a', 'b']);
    check(
      'F3 注册表 · M4:HEAD == BASE → 放行',
      judge.judgeRegistryMonotonicity(BASE_REG, BASE_REG).ok,
      '不动注册表的 PR 不该被这道闸打扰',
    );
    check(
      'F3 注册表 · M4:新增一条棘轮 → 放行(只可增)',
      judge.judgeRegistryMonotonicity(BASE_REG, reg(['a', 'b', 'c'])).ok,
      '加棘轮必须畅通,否则下一个人会绕开注册表而不是登记',
    );
    check(
      'F3 注册表 · M4:摘掉一条登记 → 拒',
      !judge.judgeRegistryMonotonicity(BASE_REG, reg(['a'])).ok,
      '「先把自己从注册表摘掉、再随便改基线」是一条完整的绕过路径',
    );
    check(
      'F3 注册表 · M4:整份注册表被删 / 改名 → 拒',
      judge.judgeRegistryMonotonicity(BASE_REG, null).deleted === true &&
        !judge.judgeRegistryMonotonicity(BASE_REG, null).ok,
      '删掉注册表 = 全仓棘轮集体退保,这必须是最响的一种失败',
    );
    // ── R1 · 四元组冻结 + 并集单调性(2026-08-01 整批评审 ①)────────────────
    //
    // M4 只冻结 id,于是「同 id 换载体」在 M4 之后**仍然全绿**:
    //   新增一份洗过的 harness/<旧名>-v2.json、把 baseline 指过去、**旧文件一个字不动** ——
    //   裁判读 base 注册表拿到旧路径,旧路径没改动 ⇒ 判成 HEAD == BASE ⇒ 放行;
    //   而 eslint.harness.mjs 读的是 head 注册表,吃的是 v2。
    // 下面每一条都是「修复前放行 / 修复后拒」的行为断言,不是 grep 源码字符串。
    {
      /** 造一份注册表:ratchets[i] 可逐字段覆写,用来精确构造「只换一个字段」的变异。 */
      const regOf = (
        entries: ReadonlyArray<{
          id: string;
          baseline?: string;
          rule?: string;
          symbolShape?: string;
        }>,
      ): string =>
        JSON.stringify({
          version: 1,
          ratchets: entries.map((e) => ({
            id: e.id,
            baseline: e.baseline ?? `harness/${e.id}.json`,
            rule: e.rule ?? `srvf/${e.id}`,
            symbolShape: e.symbolShape ?? 'class-field',
            why: 'w',
          })),
        });
      const BASE_Q = regOf([{ id: 'a' }, { id: 'b' }]);

      check(
        'F3 四元组 · R1:四元组一字不改 → 放行',
        judge.judgeRegistryMonotonicity(BASE_Q, BASE_Q).ok,
        '不动注册表的 PR 不该被这道闸打扰',
      );
      check(
        'F3 四元组 · R1:**同 id 换 baseline 路径** → 拒(这正是修复前全绿的那一种)',
        (() => {
          const v = judge.judgeRegistryMonotonicity(
            BASE_Q,
            regOf([{ id: 'a', baseline: 'harness/a-v2.json' }, { id: 'b' }]),
          );
          return (
            !v.ok &&
            v.mutated.length === 1 &&
            v.mutated[0].id === 'a' &&
            v.mutated[0].field === 'baseline' &&
            v.mutated[0].head === 'harness/a-v2.json'
          );
        })(),
        '拷贝一份改指向、旧文件不动 —— 不涉及 rename,「基线不得删除/改名」那条完全看不见它',
      );
      check(
        'F3 四元组 · R1:同 id 换 rule → 拒',
        !judge.judgeRegistryMonotonicity(
          BASE_Q,
          regOf([{ id: 'a', rule: 'srvf/other' }, { id: 'b' }]),
        ).ok,
        'rule 一换,那份基线就转去豁免别的规则,而原规则的存量豁免面凭空消失/转移',
      );
      check(
        'F3 四元组 · R1:同 id 换 symbolShape → 拒',
        !judge.judgeRegistryMonotonicity(
          BASE_Q,
          regOf([{ id: 'a', symbolShape: 'class-method-param' }, { id: 'b' }]),
        ).ok,
        'symbolShape 决定身份粒度 —— 粒度一粗,一行豁免就能盖住更多真实违规',
      );
      check(
        'F3 四元组 · R1:新增全新 id 仍放行(否则以后没人能再落地一条新棘轮)',
        judge.judgeRegistryMonotonicity(BASE_Q, regOf([{ id: 'a' }, { id: 'b' }, { id: 'c' }])).ok,
        '加棘轮必须畅通,否则下一个人会绕开注册表而不是登记',
      );
      for (const [name, bad] of [
        ['缺 rule', '{"version":1,"ratchets":[{"id":"a","baseline":"h.json","symbolShape":"x"}]}'],
        ['缺 symbolShape', '{"version":1,"ratchets":[{"id":"a","baseline":"h.json","rule":"r"}]}'],
        [
          '重复 id',
          '{"version":1,"ratchets":[{"id":"a","baseline":"h.json","rule":"r","symbolShape":"s"},{"id":"a","baseline":"h2.json","rule":"r","symbolShape":"s"}]}',
        ],
      ] as const) {
        let threw = false;
        try {
          judge.judgeRegistryMonotonicity(BASE_Q, bad);
        } catch {
          threw = true;
        }
        check(
          `F3 四元组 fail-closed:head 注册表${name} → 抛(交由 failClosed 拦)`,
          threw,
          '判不了就必须响 —— 四元组缺一个字段就没法判「载体有没有被换掉」',
        );
      }

      // ── 分支选择本身的阳性对照(2026-08-01,#870 一次性对抗 PR 实测抓到)──────
      //
      // 上一版 main() 写的是 `if (!verdict.ok) failHard('被削减')`,而 `ok` 在 removed
      // **或** mutated 非空时都为 false —— 于是「换载体」一头撞进「被削减」分支,
      // 实测打印出 `head 少了 0 条:`。门是关住了(fail-closed 没错),但报的原因是错的。
      //
      // ⚠️ 上面那组断言**抓不到它**:它们判的是 judgeRegistryMonotonicity 的返回值,
      // 而那个返回值一直是对的;错的是 main() 里拿返回值挑分支的那几行。
      // 把挑分支抽成 registryFailureKind 之后,这里才有东西可断言 ——
      // 「结构断言 + 纯函数对照看不见接线」这条教训的执行位就落在下面四条上。
      {
        const kind = judge.registryFailureKind;
        check(
          'F3 分支 · #870:**只有** mutated 的裁决必须报 mutated(不许落进「被削减」)',
          kind({ deleted: false, removed: [], mutated: [{ id: 'a' }] }) === 'mutated',
          '报错报错了 = operator 按错误的原因去排查;这正是 #870 实测到的 `head 少了 0 条:`',
        );
        check(
          'F3 分支:只有 removed 的裁决报 removed',
          kind({ deleted: false, removed: ['a'], mutated: [] }) === 'removed',
          '摘登记仍须报「被削减」,不能被新分支抢走',
        );
        check(
          'F3 分支:removed 与 mutated 同时出现时报 removed(条目都没了,谈不上载体换没换)',
          kind({ deleted: false, removed: ['a'], mutated: [{ id: 'b' }] }) === 'removed',
          '两者同时命中时的优先级必须是确定的,否则同一份输入可能报出两种原因',
        );
        check(
          'F3 分支:整份注册表被删 → removed',
          kind({ deleted: true, removed: ['a', 'b'], mutated: [] }) === 'removed',
          'deleted 是 removed 的极端形态',
        );
        check(
          'F3 分支反向:干净的裁决不报任何失败(不许「什么都拦」)',
          kind({ deleted: false, removed: [], mutated: [] }) === null,
          '误伤会训练出「无视门禁」的习惯,与漏放同样致命',
        );
      }

      // ── EC-1(2026-08-17):注册表两态 —— 数值型棘轮 ─────────────────────────
      //
      // 到此为止注册表只装得下 ESLint 豁免型(身份 = (file, symbol),不认数值)。
      // 尺寸棘轮装不进来的三条结构原因见 SERVICE_SIZE_RATCHET.md §5,其中第三条是
      // **裁判语义正好反了**:数值若编进 symbol,合法的「变小」会造出新 key 而硬失败。
      // 下面这组钉的就是新增的 numeric-monotonic 形态,以及它与旧形态的隔离。
      {
        const numDoc = (entries: ReadonlyArray<{ file: string; loc: number }>): string =>
          JSON.stringify({ version: 1, entries });
        const BASE_N = numDoc([
          { file: 'a.service.ts', loc: 1000 },
          { file: 'b.service.ts', loc: 800 },
        ]);
        const nv = (head: string | null) => judge.judgeNumericMonotonicity(BASE_N, head, 'loc');

        check(
          'F3 数值型:HEAD == BASE → 放行',
          nv(BASE_N).ok,
          '不动基线的 PR 不该被这道闸打扰',
        );
        check(
          'F3 数值型:数值**变小** → 放行(棘轮做功的方向)',
          nv(numDoc([{ file: 'a.service.ts', loc: 900 }, { file: 'b.service.ts', loc: 800 }])).ok,
          '⚠️ 这一条正是旧裁判做不到的:按 (file,symbol) 集合比时,数值编进 symbol 会让「变小」造出新 key 而硬失败',
        );
        check(
          'F3 数值型:条目**消失** → 放行(拆到阈值以下就该退出基线)',
          nv(numDoc([{ file: 'b.service.ts', loc: 800 }])).ok,
          '还债必须畅通,否则下一个人会绕开棘轮而不是还债',
        );
        check(
          'F3 数值型:数值**变大** → 拒(这是本形态存在的唯一理由)',
          (() => {
            const v = nv(
              numDoc([{ file: 'a.service.ts', loc: 1001 }, { file: 'b.service.ts', loc: 800 }]),
            );
            return !v.ok && v.grown.length === 1 && v.grown[0].includes('1000 → 1001');
          })(),
          '在 PR 自己的树上「把数字改大」与「把代码改小」结果一样(闸都绿),只有拿 base 比才分得出',
        );
        check(
          'F3 数值型:**新增**条目 → 拒(新认领一个超阈值单元须维护者授权)',
          (() => {
            const v = nv(
              numDoc([
                { file: 'a.service.ts', loc: 1000 },
                { file: 'b.service.ts', loc: 800 },
                { file: 'c.service.ts', loc: 1500 },
              ]),
            );
            return !v.ok && v.added.length === 1 && v.added[0].startsWith('c.service.ts');
          })(),
          'report 期的 service-size-new-above-threshold 报的就是这个,转 blocking 后必须由裁判兜住',
        );
        check(
          'F3 数值型:基线文件被删 → removedFile(与 ESLint 型同判)',
          nv(null).removedFile && !nv(null).ok,
          '「删掉判据」与「判据通过」在任何看得懂的门禁里都不该是同一件事',
        );
        check(
          'F3 数值型 fail-closed:metric 缺失 → 抛,**不当 0**',
          (() => {
            try {
              judge.judgeNumericMonotonicity(
                BASE_N,
                JSON.stringify({ version: 1, entries: [{ file: 'a.service.ts' }] }),
                'loc',
              );
              return false;
            } catch {
              return true;
            }
          })(),
          '当 0 会让「抹掉一个数字」等价于「缩到 0」—— 于是删掉数值就能让任意增长看起来像收缩',
        );
        check(
          'F3 数值型 fail-closed:同一 file 重复出现 → 抛',
          (() => {
            try {
              judge.judgeNumericMonotonicity(
                BASE_N,
                numDoc([{ file: 'a.service.ts', loc: 900 }, { file: 'a.service.ts', loc: 2000 }]),
                'loc',
              );
              return false;
            } catch {
              return true;
            }
          })(),
          '重复 file 会让「取哪一条」看运气,身份映射当场失去意义(同注册表重复 id)',
        );

        // 形态隔离:注册表解析层
        const regKind = (
          over: Record<string, unknown>,
        ): (() => ReturnType<typeof judge.parseRatchetRegistryDoc>) => {
          return () =>
            judge.parseRatchetRegistryDoc(
              JSON.stringify({
                version: 1,
                ratchets: [{ id: 'n', baseline: 'harness/n.json', why: 'w', ...over }],
              }),
              'head',
            );
        };
        // ⚠️ 只断言「抛了」是不够的:变异对拍实测,把 kind 校验整条删掉之后,
        // 未知 kind 会走到 `RATCHET_KINDS[kind]` = undefined,`for...of undefined`
        // 抛 TypeError —— 于是「抛了」照样成立,用例全绿而闸已经没了。
        // 故断言必须认**这条闸自己的错误**,而不是"某处炸了"。
        const throwsWith = (fn: () => unknown, needle: string): boolean => {
          try {
            fn();
            return false;
          } catch (err) {
            return String(err).includes(needle);
          }
        };
        const throws = (fn: () => unknown): boolean => throwsWith(fn, '');

        check(
          'F3 kind:省略 kind → 按 eslint-exempt 解析(既有三条一个字节都不用改)',
          regKind({ rule: 'srvf/x', symbolShape: 'class-field' })()[0].kind === 'eslint-exempt',
          '要求既有条目补字段就等于改它们的载体三元组,那会被冻结检查判成 mutated —— 死锁',
        );
        check(
          'F3 kind:numeric-monotonic 带 metric → 通过',
          regKind({ kind: 'numeric-monotonic', metric: 'loc' })()[0].metric === 'loc',
          '',
        );
        check(
          'F3 kind:numeric-monotonic **缺 metric** → 抛',
          throws(regKind({ kind: 'numeric-monotonic' })),
          '缺了就没法判「载体有没有被换掉」,与 eslint 型缺 rule 同理',
        );
        check(
          'F3 kind:⚠️ numeric-monotonic **携带 rule** → 抛(不是可选,是禁止)',
          throws(regKind({ kind: 'numeric-monotonic', metric: 'loc', rule: 'srvf/x' })),
          '允许它带真实规则名 = 允许它借道把基线里的文件从那条 ESLint 规则里豁免掉,而 ④-c 对它无从判起',
        );
        check(
          'F3 kind:numeric-monotonic 携带 symbolShape → 抛',
          throws(
            regKind({ kind: 'numeric-monotonic', metric: 'loc', symbolShape: 'class-field' }),
          ),
          '同上:数值型没有 symbol,带上它只会让人以为它参与集合判定',
        );
        check(
          'F3 kind:未知 kind → 抛**且报的是 kind 未知**(不许静默落进默认形态)',
          throwsWith(regKind({ kind: 'whatever', metric: 'loc' }), 'kind 未知'),
          '静默落默认 = 一个拼错的 kind 让数值型被当成 eslint 型判,而它的基线里没有 symbol;' +
            '⚠️ 断言必须认这条闸自己的错误 —— 删掉它之后 for...of undefined 同样会抛,只断言「抛了」会全绿',
        );
        check(
          'F3 kind:⚠️ **翻 kind** → 判 mutated(换掉判它的那套判据)',
          (() => {
            const base = JSON.stringify({
              version: 1,
              ratchets: [
                { id: 'n', kind: 'numeric-monotonic', baseline: 'harness/n.json', metric: 'loc', why: 'w' },
              ],
            });
            const head = JSON.stringify({
              version: 1,
              ratchets: [
                {
                  id: 'n',
                  kind: 'eslint-exempt',
                  baseline: 'harness/n.json',
                  rule: 'srvf/x',
                  symbolShape: 'class-field',
                  why: 'w',
                },
              ],
            });
            const v = judge.judgeRegistryMonotonicity(base, head);
            return !v.ok && v.mutated.some((m) => m.field === 'kind');
          })(),
          '不冻结 kind,一个 PR 只要翻它就换掉了判据选择,而 baseline 逐字未变、旧冻结检查全绿 —— 与「同 id 换载体」同形',
        );

        // ── set-monotonic:架构债棘轮的执行位(v4 §6 元规则「禁新增代码债」)──────
        {
          const SET = 'callSiteIds';
          const doc = (ids: string[]): string =>
            JSON.stringify({ schemaVersion: '1.0.0', [SET]: ids });
          const BASE = doc(['cs:aaa', 'cs:bbb', 'cs:ccc']);
          const setV = (head: string | null) =>
            judge.judgeSetMonotonicity(BASE, head, SET, 'harness/x.json');

          check(
            'F3 set:head ⊆ base → 通过(原样)',
            setV(doc(['cs:aaa', 'cs:bbb', 'cs:ccc'])).ok,
            '',
          );
          check(
            'F3 set:**还债**(成员消失)→ 通过',
            setV(doc(['cs:aaa'])).ok,
            '还债必须畅通,否则下一个人会绕开棘轮而不是还债 —— 与数值型「file 消失放行」同向',
          );
          check(
            'F3 set:⚠️ **塞进一个基线外身份** → 破棘轮,且点名是谁',
            (() => {
              const v = setV(doc(['cs:aaa', 'cs:bbb', 'cs:ccc', 'cs:NEW']));
              return !v.ok && v.added.length === 1 && v.added[0] === 'cs:NEW';
            })(),
            '这是本闸存在的唯一理由:「写了新违规 + 顺手把它登进基线」在 PR 自己的树上与「改掉违规」同样全绿',
          );
          check(
            'F3 set:⚠️ **等量替换**(删一条加一条,总数不变)→ 仍然破棘轮',
            (() => {
              const v = setV(doc(['cs:aaa', 'cs:bbb', 'cs:NEW']));
              return !v.ok && v.added[0] === 'cs:NEW';
            })(),
            '任何看总数的判据都看不见这一形状 —— 终审【九】「count 永不作为最终棘轮身份」正是为它写的',
          );
          check(
            'F3 set:基线文件被删 / 改名 → removedFile(不许判成空集合成立)',
            setV(null).removedFile,
            '「删掉判据」与「判据通过」在门禁看来必须不同',
          );
          check(
            'F3 set:缺 setField 数组 → 抛**且报的是缺该字段**',
            throwsWith(
              () => judge.judgeSetMonotonicity(BASE, JSON.stringify({}), SET, 'harness/x.json'),
              `缺 ${SET}`,
            ),
            '判不了在这里等价于没有棘轮;断言认这条闸自己的错误,只断言「抛了」会被任意 TypeError 满足',
          );
          check(
            'F3 set:重复成员 → 抛(不是去重)',
            throwsWith(
              () => judge.judgeSetMonotonicity(BASE, doc(['cs:aaa', 'cs:aaa']), SET, 'harness/x.json'),
              '重复成员',
            ),
            '同一身份出现两次说明生成侧已按别的口径计数,「取哪一条」从此看运气',
          );
          check(
            'F3 set:非字符串成员 → 抛',
            throwsWith(
              () =>
                judge.judgeSetMonotonicity(
                  BASE,
                  JSON.stringify({ [SET]: ['cs:aaa', null] }),
                  SET,
                  'harness/x.json',
                ),
              '非字符串',
            ),
            '允许 null 混入 = 允许用一个 null 顶掉一条真实身份,而集合差集看不出这件事',
          );
          check(
            'F3 kind:set-monotonic 带 setField → 通过',
            regKind({ kind: 'set-monotonic', setField: 'callSiteIds' })()[0].setField ===
              'callSiteIds',
            '',
          );
          check(
            'F3 kind:set-monotonic **缺 setField** → 抛',
            throws(regKind({ kind: 'set-monotonic' })),
            '缺了就没法判「载体有没有被换掉」,与 eslint 型缺 rule、数值型缺 metric 同理',
          );
          check(
            'F3 kind:⚠️ set-monotonic **携带 rule** → 抛(与数值型同一理由)',
            throws(regKind({ kind: 'set-monotonic', setField: 'callSiteIds', rule: 'srvf/x' })),
            '它的基线里没有 symbol,⑤(rule 豁免并集只减不增)对它无从判起',
          );
        }
      }

      // ── 并集单调性:借「新增全新 id」这条合法通道给既有 rule 加豁免 ──────────
      const RULE = 'srvf/no-nullable-is-optional';
      const unions = (m: Record<string, string[]>): Map<string, Set<string>> =>
        new Map(Object.entries(m).map(([k, v]) => [k, new Set(v)]));
      const BASE_U = unions({ [RULE]: ['a.dto.ts A.x', 'a.dto.ts A.y'] });

      check(
        'F3 并集 · R1:并集不变 → 放行',
        judge.judgeRuleUnionMonotonicity(BASE_U, BASE_U).ok,
        '不动豁免面的 PR 不该被这道闸打扰',
      );
      check(
        'F3 并集 · R1:并集变小 → 放行(棘轮就是要让它缩)',
        judge.judgeRuleUnionMonotonicity(BASE_U, unions({ [RULE]: ['a.dto.ts A.x'] })).ok,
        '还债必须畅通',
      );
      check(
        'F3 并集 · R1:**新增 id 给既有 rule 塞新豁免** → 拒(四元组冻结与逐基线单调性都看不见它)',
        !judge.judgeRuleUnionMonotonicity(
          BASE_U,
          unions({ [RULE]: ['a.dto.ts A.x', 'a.dto.ts A.y', 'evil.dto.ts E.z'] }),
        ).ok,
        'lint 侧按 head 注册表遍历生成豁免块 —— 新文件里的豁免当场生效,而没有任何一条既有判据会去读它',
      );
      check(
        'F3 并集 · R1:落地**全新 rule** 的新棘轮不受限(它冻结的是自己的存量债)',
        judge.judgeRuleUnionMonotonicity(
          BASE_U,
          unions({ [RULE]: ['a.dto.ts A.x'], 'srvf/brand-new': ['x.ts X.a', 'x.ts X.b'] }),
        ).ok,
        '限死新 rule = 以后没人能再落地一条新棘轮,那会把「加棘轮」变成比「绕过」更贵的选择',
      );
    }

    check(
      'F3 注册表:真实注册表登记了五条棘轮,且 service-size / architecture-debt 的 kind 正确',
      (() => {
        // ⚠️ 刻意用**精确集合**而不是「至少包含」:精确形式同时抓两个方向 ——
        // 少一条 = 那条棘轮的单调性没人裁;多一条 = 有人塞了条没经过评审的棘轮。
        // 代价是每次合法新增都要改这一行,那正是想要的(改这一行会出现在 diff 里)。
        const rs = judge.parseRatchetRegistryDoc(
          fs.readFileSync(path.resolve(__dirname, '../harness/ratchet-registry.json'), 'utf-8'),
          'base',
        );
        const ids = rs
          .map((r) => r.id)
          .sort()
          .join(',');
        const ss = rs.find((r) => r.id === 'service-size');
        const ad = rs.find((r) => r.id === 'architecture-debt');
        // kind 与载体字段一起钉:只钉 id 的话,把 service-size 悄悄改回 eslint-exempt
        // 会让裁判用集合语义去判一份没有 symbol 的基线 —— 那会 fail-closed,但报的原因离真因很远。
        // architecture-debt 同理:翻成 numeric 会让裁判去找不存在的 metric 字段。
        return (
          ids ===
            'architecture-debt,is-optional-null,legacy-param-id,near-future-date,service-size' &&
          ss?.kind === 'numeric-monotonic' &&
          ss.metric === 'loc' &&
          ad?.kind === 'set-monotonic' &&
          ad.setField === 'callSiteIds' &&
          ad.baseline === 'harness/architecture-debt-baseline.json'
        );
      })(),
      '注册表少一条 = 那条棘轮的单调性没人裁,而 lint 与 selftest 都看不出来;' +
        'service-size 的 kind 被改回 eslint-exempt 则等于尺寸棘轮退回「装不进来」的状态',
    );

    // ── 债务棘轮的**接线**断言 ────────────────────────────────────────────────
    //
    // 为什么接线也要断言:2026-08-15 的教训是「命令在 package.json 里却没接任何 CI」——
    // 判据存在、执行位不存在,两头不靠。本组把「接了 CI」与「没被 || true 兜住」
    // 各钉一条;它们与判据本体同处 selfGuard 红区,不会被单独回退。
    {
      const ci = fs.readFileSync(
        path.resolve(__dirname, '../.github/workflows/ci.yml'),
        'utf-8',
      );
      const line = ci
        .split('\n')
        .find((l) => l.includes('docs:boundaries:newdebt:check') && l.trim().startsWith('pnpm'));
      check(
        'F3 债务棘轮:`docs:boundaries:newdebt:check` 已接进 CI',
        line !== undefined,
        'v4 §6 元规则「禁新增代码债」的执行位 —— 不接 CI 就只是一句散文(2026-08-15 同形教训)',
      );
      check(
        'F3 债务棘轮:该步骤**没有** `|| true` 兜底(它不是 report 期检查)',
        line !== undefined && !line.includes('|| true'),
        '带上 || true 等于把刚接的执行位当场拆掉,而检查名一字不变、CI 一片绿',
      );
      // ── 治理文档里的 ✅ 不得与闸的读数公然矛盾 ──────────────────────────────
      //
      // 2026-08-21 实测的缺陷类:SERVICE_SIZE_RATCHET.md §4「专属」条长期挂着
      // 「✅ 已达成(2026-08-17)—— 严口径 93 → 27」,而当日实测已是 35(越过判据线 30)。
      // 那个 ✅ 当时是真的,之后**静默过期**,且没有任何东西守着它 ——
      // 谁照它拍板转闸,就会基于一个不成立的读数做决定。
      //
      // 判据设计(刻意只挑**可证伪**的那一半):
      //   基线文件当前值 > 基线值 ⇒ 必定发生过至少一次「已超阈值文件被增长」
      //   ⇒ 摩擦必定较冻结时上升 ⇒ 专属条不得写成 ✅。
      // 挡不住「摩擦涨了但没超基线」(那需要重放全历史,太贵,由 §3.3 的
      // 「转闸前必须重测」文字承担);挡得住本次这种文档与闸公然矛盾的形态。
      check(
        'F3 尺寸棘轮:闸报了基线文件变大时,§4「专属」条不得写成 ✅(防假 ✅ 静默过期)',
        (() => {
          const root = path.resolve(__dirname, '..');
          const baseline = JSON.parse(
            fs.readFileSync(path.join(root, 'harness/service-size-baseline.json'), 'utf-8'),
          ) as { entries: Array<{ file: string; loc: number }> };
          const grown = baseline.entries.filter((e) => {
            let current: number;
            try {
              current = measureNcloc(fs.readFileSync(path.join(root, e.file), 'utf-8'));
            } catch {
              return false; // 文件没了 = 棘轮做功方向,不是「变大」
            }
            return current > e.loc;
          });
          const doc = fs.readFileSync(
            path.join(root, 'docs/ai-harness/SERVICE_SIZE_RATCHET.md'),
            'utf-8',
          );
          const row = doc
            .split('\n')
            .find((l) => l.includes('| **专属** |') || l.startsWith('| **专属**'));
          if (row === undefined) return false; // 找不到那一行 = 判据失去锚点,fail-closed
          const claimsMet = row.includes('✅');
          return !(grown.length > 0 && claimsMet);
        })(),
        '文档说「摩擦已压到线内」而闸同时在报基线文件变大 —— 两者不可能同真;' +
          '这类 ✅ 会静默过期,而转闸决策正是照它做的(2026-08-21 实测:文档写 27,实况 35)',
      );
      // 同一缺陷类的第二处:STATE_MACHINE_INVENTORY.md §10.4 自称「机器现算」,
      // 实为一次性抄进文档的快照。2026-08-21 复核时登记表已 58 条而表里写 56
      // ——两条 4-1b 之后新增的状态列被登记闸正确逼进了登记表(A 类 blocking 在做功),
      // 文档叙述却没跟着走。
      //
      // 只盯**总条目**一个数:表里其余比率全部由它派生,总数对不上时那些比率一定也不对;
      // 逐个去盯每个比率会让断言本身变成需要维护的第二份真相。
      check(
        'F3 状态机登记表:§10.4「总条目」与 state-machines.json 的 entries 一致(防快照静默过期)',
        (() => {
          const root = path.resolve(__dirname, '..');
          const registry = JSON.parse(
            fs.readFileSync(path.join(root, 'harness/state-machines.json'), 'utf-8'),
          ) as { entries?: unknown[] };
          if (!Array.isArray(registry.entries)) return false; // 拿不到真值 ⇒ fail-closed
          const doc = fs.readFileSync(
            path.join(root, 'docs/ai-harness/STATE_MACHINE_INVENTORY.md'),
            'utf-8',
          );
          const row = doc.split('\n').find((l) => /^\|\s*总条目\s*\|/.test(l));
          if (row === undefined) return false; // 锚点没了 ⇒ 判据失效,不等于通过
          const claimed = row.match(/\|\s*\*{0,2}(\d+)\*{0,2}\s*\|\s*$/);
          if (claimed === null) return false;
          return Number(claimed[1]) === registry.entries.length;
        })(),
        '文档自称「机器现算」而数字是一次性抄进去的 —— 与同日 SERVICE_SIZE_RATCHET §4 的过期 ✅ 同一缺陷类;' +
          '总条目对不上时,表里由它派生的全部比率都不可信',
      );
      // 同一缺陷类的第三处,且这次是**覆盖缺口**而非数字漂移:
      // COMMON_GOVERNANCE.md §3 声称「逐个定性」并列了 12 个子目录,而 src/common
      // 现有 14 个 —— activity-workflow 与 identity 从未经过 R15 定性。
      //
      // 为什么三个月无人发现:R15 的三条自动判据(业务表访问 / 业务谓词 / 模块入边)
      // 只看**内容**,对它们照常生效且当前全绿。缺的是"有没有人看过一眼"这一步,
      // 而那一步此前只活在文档里。本断言把它变成执行位。
      //
      // 判据是**集合相等**不是「至少包含」:少一个 = 新子目录未定性(本次的形状);
      // 多一个 = 表里留着已删除的子目录(反方向,同样是失真)。
      check(
        'F3 common 治理:§3 表格列出的子目录集合 == src/common 实际子目录集合',
        (() => {
          const root = path.resolve(__dirname, '..');
          const actual = fs
            .readdirSync(path.join(root, 'src/common'), { withFileTypes: true })
            .filter((d) => d.isDirectory())
            .map((d) => d.name)
            .sort();
          if (actual.length === 0) return false; // 自证:读不到目录 ⇒ 判据无输入,不等于通过
          const doc = fs.readFileSync(
            path.join(root, 'docs/ai-harness/COMMON_GOVERNANCE.md'),
            'utf-8',
          );
          const listed = [
            ...new Set(
              doc
                .split('\n')
                .map((l) => /^\|\s*`([a-z][a-z0-9-]*)`\s*\|\s*\d+\s*\|/.exec(l))
                .filter((m): m is RegExpExecArray => m !== null)
                .map((m) => m[1]),
            ),
          ].sort();
          if (listed.length === 0) return false; // 表格锚点没了 ⇒ 同上
          return listed.join(',') === actual.join(',');
        })(),
        '新增 src/common 子目录而不在 §3 定性,R15 的三条自动判据看不见(它们只查内容,不查"有没有人定性过");' +
          '实测本次缺口:activity-workflow / identity 两个子目录三个月未被定性',
      );
      check(
        'F3 债务棘轮:身份基线存在且非空(自证,不写死条数)',
        (() => {
          // 用**地板锚点**而不是「恰好 N 个」:基线随还债而缩小是棘轮做功的方向,
          // 写死条数会让每次合法还债都要改这一行,于是这条断言迟早被改成恒真。
          const raw = fs.readFileSync(
            path.resolve(__dirname, '../harness/architecture-debt-baseline.json'),
            'utf-8',
          );
          const doc = JSON.parse(raw) as { callSiteIds?: unknown };
          return Array.isArray(doc.callSiteIds) && doc.callSiteIds.length > 0;
        })(),
        '空基线会让每条现存违规都变成「新增」⇒ 闸恒红 ⇒ 下一个人只会把它关掉',
      );
    }
  }
}

void (async (): Promise<void> => {
  await runConnectedDbAssertions();
  await runTrustedJudgeAssertions();
  // ---------------------------------------------------------------------------
  // 元数据 ↔ 实现 绑定:标 covered / live 的探针必须真的执行守护
  //
  // 立项理由(2026-07-29 元核验发现,同一个病的**第三次复发**):
  //   ① 17 条 lint 选择器「都有阳性对照」—— 实为巧合对齐,无机制保证
  //   ② 37 条 parity「证明判定正确」—— 只证明两把刻错的尺子读数相同
  //   ③ 4 条事故「covered = 会被真实回放」—— 只是登记簿里手写的一个词
  //
  // 三次都是**元数据描述实现,而没有任何东西检查这个描述是真的**。
  // 前两次已各自补了断言;这条把第三处也钉上,并把模式本身写进注释:
  // 凡「元数据声称实现具备某性质」,必须有断言把两者绑死,否则元数据迟早变成谎话 ——
  // 而基于谎话做的判断(「回放 20/20,守护可信」)比没有数字更危险。
  //
  // 判据:探针函数体必须出现 hookExit( / execFileSync( / spawnSync( 之一,
  // 即「真的把输入喂给守护并读它的裁决」。只读源码字符串的一律不算。
  // ---------------------------------------------------------------------------
  {
    const REPO = path.resolve(__dirname, '..');
    const reg = JSON.parse(fs.readFileSync(path.join(REPO, 'harness/incidents.json'), 'utf-8')) as {
      incidents: Array<{ id: string; status: string; probe?: string }>;
      inverse: Array<{ id: string; probeKind?: string; probe: string }>;
    };
    const src = fs.readFileSync(path.join(REPO, 'scripts/replay-incidents.ts'), 'utf-8');

    // 按顶层探针键切分函数体:从本键起到下一个键为止
    const marks: Array<[string, number]> = [];
    const keyRe = /^ {2}'([a-z0-9-]+)':\s*(?:\(\)\s*=>\s*)?/gm;
    let mm: RegExpExecArray | null;
    while ((mm = keyRe.exec(src)) !== null) marks.push([mm[1], mm.index]);
    const bodyOf = (name: string): string | null => {
      const i = marks.findIndex(([n]) => n === name);
      if (i < 0) return null;
      return src.slice(marks[i][1], i + 1 < marks.length ? marks[i + 1][1] : src.length);
    };
    const EXECUTES = /hookExit\(|execFileSync\(|spawnSync\(/;

    /**
     * 判定抽成纯函数,好处有二:
     *   ① **阳性对照可以喂合成登记簿**验证「标错必红」—— 不必去改真的
     *      `harness/incidents.json`(受保护路径;为跑一次测试而申请授权是本末倒置)
     *   ② 判定本身可被读懂与复查,不埋在一段 for 循环里
     */
    const findLiars = (
      registry: typeof reg,
      resolve: (probe: string) => string | null,
    ): string[] => {
      const out: string[] = [];
      for (const inc of registry.incidents) {
        if (inc.status !== 'covered') continue;
        if (!inc.probe) {
          out.push(`${inc.id}:标 covered 却没有 probe`);
          continue;
        }
        const body = resolve(inc.probe);
        if (body === null) out.push(`${inc.id}:probe '${inc.probe}' 在 replay 里不存在`);
        else if (!EXECUTES.test(body))
          out.push(`${inc.id}(${inc.probe}):标 covered 但只做静态检查`);
      }
      for (const inv of registry.inverse ?? []) {
        if (inv.probeKind !== 'live') continue;
        const body = resolve(inv.probe);
        if (body === null) out.push(`${inv.id}:probe '${inv.probe}' 在 replay 里不存在`);
        else if (!EXECUTES.test(body)) out.push(`${inv.id}(${inv.probe}):标 live 但只做静态检查`);
      }
      return out;
    };

    // 阳性对照:合成一份「把静态探针标成 covered / live」的登记簿,必须被抓出来。
    // 不做这一步,上面那条断言就只是又一个「看着绿」的东西 —— 而那正是本条要治的病。
    const fakeReg = {
      incidents: [
        { id: 'FAKE-01', status: 'covered', probe: 'only-reads-source' },
        { id: 'FAKE-02', status: 'covered', probe: 'really-runs-guard' },
        { id: 'FAKE-03', status: 'structural', probe: 'only-reads-source' },
      ],
      inverse: [{ id: 'FAKE-INV', probeKind: 'live', probe: 'only-reads-source' }],
    } as unknown as typeof reg;
    const fakeBodies: Record<string, string> = {
      'only-reads-source': "const s = readFile(p); return [s.includes('x'), ''];",
      'really-runs-guard': "const code = hookExit('redzone-guard.sh', edit('AGENTS.md'));",
    };
    const fakeLiars = findLiars(fakeReg, (p) => fakeBodies[p] ?? null);
    check(
      '登记簿:阳性对照 — 把静态探针标成 covered / live 必被抓出',
      fakeLiars.length === 2 &&
        fakeLiars.some((l) => l.startsWith('FAKE-01')) &&
        fakeLiars.some((l) => l.startsWith('FAKE-INV')),
      `实际抓出 ${fakeLiars.length} 条:${fakeLiars.join(' · ')}`,
    );
    check(
      '登记簿:阳性对照 — 真执行守护的 / 标 structural 的 均不误报',
      !fakeLiars.some((l) => l.startsWith('FAKE-02') || l.startsWith('FAKE-03')),
      fakeLiars.join(' · '),
    );

    const liars = findLiars(reg, bodyOf);

    check(
      '登记簿:标 covered / live 的探针确实执行守护(元数据不得说谎)',
      liars.length === 0,
      liars.join(' · '),
    );
    // 反向:切分逻辑本身要有效 —— 一个都抽不出来时上面会「零违规」假绿
    check(
      '登记簿:探针体切分有效(防「一个都没抽到」的假绿)',
      marks.length >= 15,
      `只抽到 ${marks.length} 个探针体,切分正则可能已失配`,
    );
  }

  // ────────────────────────────────────────────────────────────────────────
  // R14 授权语义 diff(Gate L4)—— 四态比较器阳性对照
  //
  // 为什么每一类都要有样例:v4 勘误㉕ 记录的正是「码集增减方向判反」这一类错误 ——
  // `any` 集增码是**降级**(多开一条进门路),与 `all` 集方向相反。把它判成升级
  // 会让「悄悄多开一道门」这种最典型的提权改动直接静默通过。所以下面既有正样例
  // (每类降级必须被抓),也有**负样例**(any 集增码一旦被判成 NARROWER 即红)。
  // ────────────────────────────────────────────────────────────────────────
  {
    const REPO_ROOT = path.resolve(__dirname, '..');
    const closure = buildClosure({ schemaVersion: '1.0.0', edges: [] });
    const basePolicy = (over: Partial<AuthzPolicy> = {}): AuthzPolicy => ({
      admission: null,
      mode: 'RBAC',
      codes: [{ code: 'user.read.account', scope: null }],
      require: 'all',
      scopes: [],
      engine: 'rbac-global',
      ...over,
    });
    const verdictOf = (base: AuthzPolicy, head: AuthzPolicy): string =>
      comparePolicy(base, head, closure).verdict;

    // ① 降级闭集:每类一例
    checkEq(
      'R14:降级 — 任何模式 → PUBLIC',
      verdictOf(basePolicy(), basePolicy({ mode: 'PUBLIC', codes: [], engine: null })),
      'BROADER',
    );
    // LOGIN_ONLY ↔ PUBLIC 单列两条:它们是**相邻一级**。上面那条「任何模式 → PUBLIC」
    // 起点是 RBAC,跨了两级 —— 把 PUBLIC 与 LOGIN_ONLY 拉平的变异它照样绿(实测:
    // 改 MODE_LEVEL.PUBLIC=1 后全套 307 条一条不红)。而「登录才能看的端点开成公开」
    // 恰恰是最经典的一种降级。正反两条一起上,防拉平后两侧同时假绿。
    checkEq(
      'R14:降级 — LOGIN_ONLY → PUBLIC(相邻一级,单独钉)',
      verdictOf(
        basePolicy({ mode: 'LOGIN_ONLY', codes: [], engine: null }),
        basePolicy({ mode: 'PUBLIC', codes: [], engine: null }),
      ),
      'BROADER',
    );
    checkEq(
      'R14:收紧 — PUBLIC → LOGIN_ONLY(反向)',
      verdictOf(
        basePolicy({ mode: 'PUBLIC', codes: [], engine: null }),
        basePolicy({ mode: 'LOGIN_ONLY', codes: [], engine: null }),
      ),
      'NARROWER',
    );
    checkEq(
      'R14:降级 — RBAC → LOGIN_ONLY',
      verdictOf(basePolicy(), basePolicy({ mode: 'LOGIN_ONLY', codes: [], engine: null })),
      'BROADER',
    );
    checkEq(
      'R14:降级 — LOGIN_SCOPED → LOGIN_ONLY',
      verdictOf(
        basePolicy({ mode: 'LOGIN_SCOPED', codes: [], scopes: ['self'], engine: 'authz-scoped' }),
        basePolicy({ mode: 'LOGIN_ONLY', codes: [], scopes: [], engine: null }),
      ),
      'BROADER',
    );
    checkEq(
      'R14:降级 — RESPONSIBILITY_SCOPED → LOGIN_ONLY',
      verdictOf(
        basePolicy({
          mode: 'RESPONSIBILITY_SCOPED',
          codes: [],
          scopes: ['responsibility'],
          engine: 'authz-scoped',
        }),
        basePolicy({ mode: 'LOGIN_ONLY', codes: [], scopes: [], engine: null }),
      ),
      'BROADER',
    );
    checkEq(
      'R14:降级 — 去除 admission 轴',
      verdictOf(basePolicy({ admission: 'app-member' }), basePolicy({ admission: null })),
      'BROADER',
    );
    checkEq(
      'R14:降级 — scopes 集缩减',
      verdictOf(
        basePolicy({ scopes: ['self', 'responsibility'], engine: 'authz-scoped' }),
        basePolicy({ scopes: ['self'], engine: 'authz-scoped' }),
      ),
      'BROADER',
    );

    // ② require 语义分派:all / any 两个方向各一例(v4 勘误㉕ 的正面判据)
    const allTwo = basePolicy({
      require: 'all',
      codes: [
        { code: 'user.read.account', scope: null },
        { code: 'member.read.record', scope: null },
      ],
    });
    const allOne = basePolicy({ require: 'all', codes: [{ code: 'user.read.account', scope: null }] });
    const anyTwo = basePolicy({
      require: 'any',
      codes: [
        { code: 'user.read.account', scope: null },
        { code: 'member.read.record', scope: null },
      ],
    });
    const anyOne = basePolicy({ require: 'any', codes: [{ code: 'user.read.account', scope: null }] });

    checkEq('R14:require=all — 缩码 = 降级', verdictOf(allTwo, allOne), 'BROADER');
    checkEq('R14:require=all — 增码 = 收紧', verdictOf(allOne, allTwo), 'NARROWER');
    checkEq('R14:require=any — 增码 = 降级(多开一条进门路)', verdictOf(anyOne, anyTwo), 'BROADER');
    checkEq('R14:require=any — 缩码 = 收紧', verdictOf(anyTwo, anyOne), 'NARROWER');
    checkEq('R14:all → any = 降级', verdictOf(allTwo, anyTwo), 'BROADER');
    checkEq('R14:any → all = 收紧', verdictOf(anyTwo, allTwo), 'NARROWER');

    // ②b 负样例:方向判反是本规则最致命的失败模式,单独钉死。
    check(
      'R14:负样例 — any 集增码**不得**被判成收紧/等价',
      verdictOf(anyOne, anyTwo) !== 'NARROWER' && verdictOf(anyOne, anyTwo) !== 'EQUIVALENT',
      `实际判成 ${verdictOf(anyOne, anyTwo)}`,
    );
    check(
      'R14:负样例 — all 集缩码**不得**被判成收紧/等价',
      verdictOf(allTwo, allOne) !== 'NARROWER' && verdictOf(allTwo, allOne) !== 'EQUIVALENT',
      `实际判成 ${verdictOf(allTwo, allOne)}`,
    );
    // 单码时 require 是真空的(all 与 any 的持有者集合逐字相同),不得误报成语义变更
    checkEq(
      'R14:单码时 require 翻转 = 等价(真空,不误报)',
      verdictOf(anyOne, allOne),
      'EQUIVALENT',
    );

    // ③ engine 变化:两侧都有判定面时恒不可比
    checkEq(
      'R14:engine 变化(两侧均有判定面)= 不可比',
      verdictOf(basePolicy(), basePolicy({ engine: 'authz-scoped' })),
      'INCOMPARABLE',
    );
    // 惰性 engine 不得制造假不可比 —— 无 codes/scopes 的一侧其准入与 engine 无关
    checkEq(
      'R14:LOGIN_ONLY → RBAC(engine null→rbac-global)= 收紧,不因惰性 engine 变不可比',
      verdictOf(basePolicy({ mode: 'LOGIN_ONLY', codes: [], engine: null }), basePolicy()),
      'NARROWER',
    );

    // ④ 换码:空蕴含图 ⇒ 无路径 ⇒ 不可比(拍板的默认立场)
    checkEq(
      'R14:换码 A→B(蕴含图空)= 不可比',
      verdictOf(allOne, basePolicy({ codes: [{ code: 'member.read.record', scope: null }] })),
      'INCOMPARABLE',
    );
    // 有边时才允许定向 —— 证明这条边真的参与判定,而不是个摆设登记表
    {
      const withEdge = buildClosure({
        schemaVersion: '1.0.0',
        edges: [{ from: 'member.read.record', to: 'user.read.account' }],
      });
      checkEq(
        'R14:换码 A→B 且蕴含图有 A⇒B 边 = 收紧',
        comparePolicy(
          allOne,
          basePolicy({ codes: [{ code: 'member.read.record', scope: null }] }),
          withEdge,
        ).verdict,
        'NARROWER',
      );
      checkEq(
        'R14:换码 B→A 沿同一条边的反方向 = 降级',
        comparePolicy(
          basePolicy({ codes: [{ code: 'member.read.record', scope: null }] }),
          allOne,
          withEdge,
        ).verdict,
        'BROADER',
      );
    }

    // ⑤ 复合变更无法唯一分解 ⇒ 保守
    checkEq(
      'R14:一轴收紧 + 一轴放宽 = 不可比(复合变更不自作分解)',
      verdictOf(
        basePolicy({ admission: 'app-member', scopes: ['self'], engine: 'authz-scoped' }),
        basePolicy({ admission: null, scopes: ['self', 'responsibility'], engine: 'authz-scoped' }),
      ),
      'INCOMPARABLE',
    );
    // 码绑定 scope:去掉 scope 是放宽(schema 支持,现网 0 例,只能靠本例守)
    checkEq(
      'R14:码绑定 scope 被去除 = 降级',
      verdictOf(
        basePolicy({ codes: [{ code: 'user.read.account', scope: 'self' }] }),
        basePolicy({ codes: [{ code: 'user.read.account', scope: null }] }),
      ),
      'BROADER',
    );

    // ⑥ 收紧恒可见:NARROWER 不阻断,但必须进迁移清单
    {
      const manifest = (policy: AuthzPolicy): AuthzManifest => ({
        schemaVersion: '1.0.0',
        generatorVersion: '2.0.0',
        entries: [
          { routeKey: 'GET /api/admin/v1/probe', controller: 'C', handler: 'h', policy },
        ],
      });
      const tightened = diffManifests(manifest(allOne), manifest(allTwo), closure);
      check(
        'R14:收紧端点进全量迁移清单(升级恒可见,不允许不可见)',
        tightened.length === 1 && tightened[0].verdict === 'NARROWER',
        JSON.stringify(tightened.map((d) => d.verdict)),
      );
      check(
        'R14:收紧端点不产生阻断项(放行)',
        judgeAuthzDeclarations(tightened, []).length === 0,
      );
      const broadened = diffManifests(manifest(allTwo), manifest(allOne), closure);
      check(
        'R14:降级端点无申报即阻断',
        judgeAuthzDeclarations(broadened, []).length === 1,
      );
      check(
        'R14:降级端点申报齐全后不再阻断(但审批仍另计)',
        judgeAuthzDeclarations(broadened, [
          {
            route: 'GET /api/admin/v1/probe',
            reason: 'r',
            impact: 'i',
            migration: 'm',
            file: 'changelog.d/x.md',
            line: 1,
          },
        ]).length === 0,
      );
      check(
        'R14:申报落空(route 不在降级集)同样阻断',
        judgeAuthzDeclarations(tightened, [
          {
            route: 'GET /api/admin/v1/probe',
            reason: 'r',
            impact: 'i',
            migration: 'm',
            file: 'changelog.d/x.md',
            line: 1,
          },
        ]).length === 1,
      );
    }

    // ⑦ 申报块解析:字段留空 = 空洞申报,必须抓
    {
      const parsed = parseAuthzDeclarations([
        {
          path: 'changelog.d/probe.md',
          content: [
            '<!-- authz-downgrade',
            'route: GET /api/admin/v1/probe',
            'reason:',
            'impact: i',
            'migration: m',
            '-->',
          ].join('\n'),
        },
      ]);
      check(
        'R14:申报块字段留空被抓(空洞申报不算申报)',
        parsed.declarations.length === 0 && parsed.findings.length === 1,
        `declarations=${parsed.declarations.length} findings=${parsed.findings.length}`,
      );
      const unclosed = parseAuthzDeclarations([
        { path: 'changelog.d/probe.md', content: '<!-- authz-downgrade\nroute: X\n' },
      ]);
      check('R14:申报块未闭合被抓', unclosed.findings.length === 1);
    }

    // ⑧ 蕴含图结构校验:打错的码会静默退化成「无路径」,所以必须硬红
    {
      const universe = new Set(['user.read.account', 'member.read.record']);
      checkEq(
        'R14:蕴含图空集合法(已拍板的默认立场)',
        validateAuthzGraph({ schemaVersion: '1.0.0', edges: [] }, universe).length,
        0,
      );
      checkEq(
        'R14:蕴含图引用不存在的权限码 = 红',
        validateAuthzGraph(
          { schemaVersion: '1.0.0', edges: [{ from: 'user.read.acount', to: 'member.read.record' }] },
          universe,
        ).length,
        1,
      );
      checkEq(
        'R14:蕴含图自环 = 红',
        validateAuthzGraph(
          { schemaVersion: '1.0.0', edges: [{ from: 'user.read.account', to: 'user.read.account' }] },
          universe,
        ).length,
        1,
      );
      check(
        'R14:蕴含图成环 = 红(否则两个方向的换码都判成收紧,双向绕过审批)',
        validateAuthzGraph(
          {
            schemaVersion: '1.0.0',
            edges: [
              { from: 'user.read.account', to: 'member.read.record' },
              { from: 'member.read.record', to: 'user.read.account' },
            ],
          },
          universe,
        ).length >= 1,
      );
      check(
        'R14:蕴含图 schemaVersion 不匹配 = fail-closed',
        validateAuthzGraph({ schemaVersion: '2.0.0', edges: [] }, universe).length === 1,
      );

      // ── 到期闸:「加第一条边」自动触发 seed 一致性核对的要求 ────────────────
      // 「本次未做」不能只躺在报告里等人记得。到期条件写成执行位:边集一旦非空,
      // 校验器立即红。沿本仓「『此刻不存在』型判据必须写明到期条件」的既有范式。
      {
        const oneEdge = validateAuthzGraph(
          { schemaVersion: '1.0.0', edges: [{ from: 'user.read.account', to: 'member.read.record' }] },
          universe,
        );
        check(
          'R14 到期闸:蕴含图非空但 seed 一致性核对未实现 = 红',
          oneEdge.length === 1 && oneEdge[0].fact.includes('一致性核对'),
          oneEdge.map((f) => f.fact).join(' · '),
        );
        check(
          'R14 到期闸:错误信息写明「不得破坏零依赖 / 双运行时」这条约束',
          oneEdge.length === 1 &&
            oneEdge[0].remedy.includes('零依赖') &&
            oneEdge[0].remedy.includes('双运行时'),
          '到期闸必须把「怎么补才算对」讲清楚,否则下一个人会用破坏地基的接法补它',
        );
        check(
          'R14 到期闸:空集不触发(今天不误伤)',
          validateAuthzGraph({ schemaVersion: '1.0.0', edges: [] }, universe).length === 0,
        );
        // 防「只翻标志位不实现」:置 true 的同时必须真的导出 crossCheckSeedBindings
        // 并在 validateGraph 里调用它。判的是**剥注释后的源码**——注释里写着这个
        // 函数名不算数(「描述文本≠执行位」本仓一天栽过四次)。
        {
          const src = codeOnly(
            fs.readFileSync(path.join(REPO_ROOT, 'scripts/authz-semantic-diff.ts'), 'utf-8'),
            'slash',
          );
          const flagOn = /SEED_CROSS_CHECK_IMPLEMENTED\s*=\s*true/.test(src);
          const implemented =
            /export function crossCheckSeedBindings\b/.test(src) &&
            /crossCheckSeedBindings\s*\(/.test(src.replace(/export function crossCheckSeedBindings/g, ''));
          check(
            'R14 到期闸:标志位置 true 必须伴随真实现(只翻标志位即红)',
            !flagOn || implemented,
            'SEED_CROSS_CHECK_IMPLEMENTED=true 但没有导出并调用 crossCheckSeedBindings —— ' +
              '这正是「翻个开关就把到期闸关掉」的形状',
          );
        }
      }
    }

    // ⑨ manifest schemaVersion 不匹配恒 fail-closed(§9 第 3 条:不猜)
    {
      const doc = (schemaVersion: string): string =>
        `<!-- route-authz-manifest-json\n${JSON.stringify({
          schemaVersion,
          generatorVersion: '2.0.0',
          entries: [],
        })}\n-->`;
      let threw = false;
      try {
        extractAuthzManifest(doc('2.0.0'), 'probe');
      } catch {
        threw = true;
      }
      check('R14:manifest schemaVersion 不匹配 → 抛错不放行', threw);
      check('R14:manifest schemaVersion 匹配 → 正常解析', extractAuthzManifest(doc('1.0.0'), 'probe').entries.length === 0);
    }

    // ⑩ 真实 manifest 必须能被本比较器读懂,且自比恒等价 ——
    //    防「比较器只在合成样例上work、遇到真 498 条就解析失败/漂移」的假绿。
    {
      const realDoc = fs.readFileSync(path.join(REPO_ROOT, 'docs/ai-harness/ROUTE_AUTHZ.md'), 'utf8');
      const real = extractAuthzManifest(realDoc, 'ROUTE_AUTHZ.md');
      check('R14:真实 manifest 可解析且非空', real.entries.length >= 400, `entries=${real.entries.length}`);
      const selfDiff = diffManifests(real, real, closure);
      check(
        'R14:真实 manifest 自比 = 全等价(无假迁移)',
        selfDiff.every((diff) => diff.verdict === 'EQUIVALENT'),
        selfDiff
          .filter((diff) => diff.verdict !== 'EQUIVALENT')
          .map((diff) => `${diff.routeKey}:${diff.verdict}`)
          .join(' · '),
      );
      // 权限码全集解析必须与 RBAC_MAP 自报条数一致(表格形态漂了要当场红)
      const universe = parseAuthzCodeUniverse(
        fs.readFileSync(path.join(REPO_ROOT, 'docs/ai-harness/RBAC_MAP.md'), 'utf8'),
      );
      check('R14:权限码全集解析条数与 RBAC_MAP 自报一致', universe.size > 0, `size=${universe.size}`);
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  // R11 契约语义门(Gate L6)—— breaking 判定表逐类阳性对照
  //
  // 方向不对称是本规则最容易写反的地方:请求侧「枚举删值 / 撤 nullable」是破坏,
  // 响应侧则是反方向的「枚举加值 / 变可空」才是破坏。两侧各自的**反方向**必须判成
  // additive —— 只测一半会让另一半的破坏悄悄放行,或者把正常的加字段误报成破坏。
  // ────────────────────────────────────────────────────────────────────────
  {
    // 最小合法 OpenAPI 文档:一个端点、一个请求体、一个成功响应。
    const doc = (
      request: Record<string, unknown>,
      response: Record<string, unknown>,
      opts: { requiredReq?: string[]; status?: string; drop?: boolean } = {},
    ): Record<string, unknown> => {
      const operation: Record<string, unknown> = {
        requestBody: {
          content: {
            'application/json': {
              schema: { type: 'object', properties: request, required: opts.requiredReq ?? [] },
            },
          },
        },
        responses: {
          [opts.status ?? '200']: {
            content: {
              'application/json': { schema: { type: 'object', properties: response, required: [] } },
            },
          },
        },
      };
      return {
        openapi: '3.0.0',
        components: { schemas: {} },
        paths: opts.drop ? {} : { '/api/probe': { post: operation } },
      };
    };
    const ids = (base: Record<string, unknown>, head: Record<string, unknown>): string[] =>
      diffContracts(base, head).map((finding) => finding.id + '/' + finding.kind);

    const strReq = { name: { type: 'string' } };
    const strRes = { title: { type: 'string' } };

    checkEq(
      'R11:B1 端点删除 = breaking',
      ids(doc(strReq, strRes), doc(strReq, strRes, { drop: true }))[0],
      'B1/endpoint-removed',
    );
    checkEq(
      'R11:B2 响应字段删除 = breaking',
      ids(doc(strReq, strRes), doc(strReq, {}))[0],
      'B2/response-field-removed',
    );
    checkEq(
      'R11:B3 新增必填请求字段 = breaking',
      ids(doc(strReq, strRes), doc({ ...strReq, extra: { type: 'string' } }, strRes, { requiredReq: ['extra'] }))[0],
      'B3/request-required-added',
    );
    checkEq(
      'R11:B4 类型收窄 = breaking',
      ids(doc(strReq, strRes), doc(strReq, { title: { type: 'integer' } }))[0],
      'B4/type-narrowed',
    );
    checkEq(
      'R11:B5 请求枚举**删值** = breaking',
      ids(doc({ mode: { type: 'string', enum: ['a', 'b'] } }, strRes), doc({ mode: { type: 'string', enum: ['a'] } }, strRes))[0],
      'B5/request-enum-value-removed',
    );
    checkEq(
      'R11:B6 响应枚举**加值** = breaking',
      ids(doc(strReq, { s: { type: 'string', enum: ['a'] } }), doc(strReq, { s: { type: 'string', enum: ['a', 'b'] } }))[0],
      'B6/response-enum-value-added',
    );
    checkEq(
      'R11:B7 请求撤销 nullable = breaking',
      ids(doc({ n: { type: 'string', nullable: true } }, strRes), doc({ n: { type: 'string', nullable: false } }, strRes))[0],
      'B7/request-nullable-revoked',
    );
    checkEq(
      'R11:B8 响应变为可空 = breaking',
      ids(doc(strReq, { t: { type: 'string' } }), doc(strReq, { t: { type: 'string', nullable: true } }))[0],
      'B8/response-nullable-added',
    );
    checkEq(
      'R11:B9 成功状态码变更 = breaking',
      ids(doc(strReq, strRes), doc(strReq, strRes, { status: '204' }))[0],
      'B9/success-status-changed',
    );

    // 反方向必须是 additive —— 方向写反时这四条会红,而上面九条仍可能全绿。
    checkEq(
      'R11:反向 — 请求枚举加值 = additive(不是破坏)',
      ids(doc({ mode: { type: 'string', enum: ['a'] } }, strRes), doc({ mode: { type: 'string', enum: ['a', 'b'] } }, strRes))[0],
      'ADD/request-enum-value-added',
    );
    checkEq(
      'R11:反向 — 响应枚举删值 = additive',
      ids(doc(strReq, { s: { type: 'string', enum: ['a', 'b'] } }), doc(strReq, { s: { type: 'string', enum: ['a'] } }))[0],
      'ADD/response-enum-value-removed',
    );
    checkEq(
      'R11:反向 — 新增**可选**请求字段 = additive',
      ids(doc(strReq, strRes), doc({ ...strReq, extra: { type: 'string' } }, strRes))[0],
      'ADD/request-optional-field-added',
    );
    checkEq(
      'R11:反向 — 新增响应字段 = additive',
      ids(doc(strReq, strRes), doc(strReq, { ...strRes, extra: { type: 'string' } }))[0],
      'ADD/response-field-added',
    );
    check(
      'R11:契约无变化 = 零 finding(不产生假破坏)',
      diffContracts(doc(strReq, strRes), doc(strReq, strRes)).length === 0,
    );

    // 申报完整性(两级结构的第一级,与 R14 同构)
    {
      const breakingDiff = diffContracts(doc(strReq, strRes), doc(strReq, {}));
      const decl = {
        operation: 'POST /api/probe',
        reason: 'r',
        impact: 'i',
        migration: 'm',
        rollback: 'revert',
        file: 'changelog.d/x.md',
        line: 1,
      };
      check('R11:破坏无申报即阻断', judgeContractDeclarations(breakingDiff, []).length === 1);
      check('R11:申报齐全后不再阻断(审批仍另计)', judgeContractDeclarations(breakingDiff, [decl]).length === 0);
      check(
        'R11:申报落空(端点无破坏)同样阻断',
        judgeContractDeclarations(diffContracts(doc(strReq, strRes), doc(strReq, strRes)), [decl]).length === 1,
      );
      const parsed = parseContractDeclarations([
        {
          path: 'changelog.d/p.md',
          content: [
            '<!-- contract-breaking',
            'operation: POST /api/probe',
            'reason: r',
            'impact: i',
            'migration: m',
            'rollback:',
            '-->',
          ].join('\n'),
        },
      ]);
      check(
        'R11:申报缺 rollback 字段被抓(真回滚手段必须写明)',
        parsed.declarations.length === 0 && parsed.problems.length === 1,
      );
    }

    // 判定表是机读的,报告与断言共用它 —— 防「表在散文里、执行位在别处」各自漂移
    check(
      'R11:breaking 判定表 9 类齐全且 id 唯一',
      BREAKING_TABLE.length === 9 && new Set(BREAKING_TABLE.map((row) => row.id)).size === 9,
      `实际 ${BREAKING_TABLE.length} 类`,
    );

    // 真契约自比 = 零 finding:防「只在合成样例上 work、遇到 498 端点就狂报假破坏」
    {
      const real = JSON.parse(
        fs.readFileSync(path.resolve(__dirname, '..', 'docs/handoff/openapi.json'), 'utf8'),
      ) as Record<string, unknown>;
      const selfDiff = diffContracts(real, real);
      check(
        'R11:真实 openapi.json 自比 = 零 finding(无假破坏)',
        selfDiff.length === 0,
        selfDiff.slice(0, 5).map((f) => f.id + ' ' + f.operation + ' ' + f.location).join(' · '),
      );
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  // FE client 生成器(Phase 5 刀 5-3)—— §9 登记表元规范的两条硬要求
  //
  // ① inputDigest 必须**确定性**且不含时间戳 / git SHA(§9 第 1 条):否则
  //    「重新生成逐字比对」恒假红,新鲜度守护当场失效;
  // ② 输入闭包的枚举**单源在生成器内**,触碰任一输入必须翻转 digest(§9 第 7 条)——
  //    枚举漏项会让产物静默陈旧,而 check 还在报绿。
  // ────────────────────────────────────────────────────────────────────────
  {
    const REPO_F = path.resolve(__dirname, '..');
    const contract = fs.readFileSync(path.join(REPO_F, 'docs/handoff/openapi.json'), 'utf8');
    const digest = computeFeClientDigest(contract);

    check('FE client:inputDigest 形如 sha256:<hex>', /^sha256:[0-9a-f]{64}$/.test(digest), digest);
    checkEq(
      'FE client:同一输入两次计算 digest 相同(确定性)',
      computeFeClientDigest(contract),
      digest,
    );
    check(
      'FE client:契约内容变化必须翻转 digest(输入闭包不漏项)',
      computeFeClientDigest(contract + ' ') !== digest,
    );
    // 产物本体不得含时间戳 / 日期 / 40 位 git SHA —— 用真产物判,不是判生成器源码。
    {
      const emitted = renderFeClients(contract);
      const offenders: string[] = [];
      for (const [rel, content] of emitted) {
        const head = content.split('\n').slice(0, 12).join('\n');
        if (/\b\d{4}-\d{2}-\d{2}\b/.test(head) || /\b\d{2}:\d{2}:\d{2}\b/.test(head)) {
          offenders.push(rel + '(头部含日期/时间)');
        }
        if (/\b[0-9a-f]{40}\b/.test(head)) offenders.push(rel + '(头部含 40 位 SHA)');
      }
      check(
        'FE client:产物头部不含时间戳 / git SHA(§9 第 1 条,否则新鲜度恒假红)',
        offenders.length === 0,
        offenders.join(' · '),
      );
      check(
        'FE client:五个 surface 各出 types.ts + client.ts,外加一份 shared/types.ts',
        emitted.size === 11 &&
          ['admin', 'app', 'auth', 'system', 'open'].every(
            (id) =>
              emitted.has(`docs/handoff/clients/${id}/types.ts`) &&
              emitted.has(`docs/handoff/clients/${id}/client.ts`),
          ) &&
          emitted.has('docs/handoff/clients/shared/types.ts'),
        `${emitted.size} 个文件:${[...emitted.keys()].join(', ')}`,
      );
      // 维护者 2026-08-13 的口径写成执行位:「产物里不要出现两份内容相同却各自维护的定义」。
      // 判的是**全仓产物**里同名 export 出现几次 —— 共用类型必须只在 shared 定义一次,
      // 各 surface 只 import + re-export。五个 surface 各带一份 Fetcher 就是被这条抓出来的。
      {
        const declaredIn = new Map<string, string[]>();
        for (const [rel, content] of emitted) {
          for (const match of content.matchAll(/^export (?:interface|type) ([A-Za-z0-9_]+)/gm)) {
            const list = declaredIn.get(match[1]) ?? [];
            list.push(rel);
            declaredIn.set(match[1], list);
          }
        }
        const duplicated = [...declaredIn.entries()].filter(([, where]) => where.length > 1);
        check(
          'FE client:全仓产物零重复定义(同名类型只能有一处 export)',
          duplicated.length === 0,
          duplicated
            .slice(0, 5)
            .map(([name, where]) => `${name} @ ${where.join(' + ')}`)
            .join(' · '),
        );
        check(
          'FE client:共用类型确实落在 shared(不是靠各 surface 恰好没撞名)',
          (declaredIn.get('ApiEnvelope') ?? [])[0] === 'docs/handoff/clients/shared/types.ts' &&
            (declaredIn.get('Fetcher') ?? [])[0] === 'docs/handoff/clients/shared/types.ts',
          '零重复也可能是因为共用类型压根没生成 —— 这条钉住它们真的在 shared 里',
        );
      }
      // 产物只出类型与签名:**不得含传输层代码,也不得含真实凭证/端点**。
      //
      // ⚠️ 判的对象要选对(施工时连栽两次):
      //   ① 必须剥掉 `//` **和** `/** */` 两种注释 —— 产物头部那句「不含 baseURL、不含令牌」
      //      本身含这些词,而每个方法上方的 JSDoc 会原样带上端点 summary(里面出现过
      //      「重置腾讯云实名核验 secretId/secretKey」)。只剥 `//` 会被 JSDoc 判红。
      //   ② 判据不能是「出现 secret/apiKey 字样」—— `"secretId": string;` 是**契约里的
      //      字段名**,前端本来就要发它,不是泄露。真正该禁的是**传输层与凭证本身**。
      const stripComments = (source: string): string =>
        codeOnly(source, 'slash').replace(/\/\*[\s\S]*?\*\//g, '');
      const transportOrCredential =
        /\bfetch\s*\(|\baxios\b|XMLHttpRequest|Authorization\s*:|['"`]Bearer\s|baseURL|https?:\/\/|\bprocess\.env\b/;
      const leaked = [...emitted]
        .filter(([, content]) => transportOrCredential.test(stripComments(content)))
        .map(([rel]) => rel);
      check(
        'FE client:产物**代码部分**不含传输层 / 鉴权头 / 硬编码端点(传输层由消费方注入)',
        leaked.length === 0,
        leaked.join(' · '),
      );
      // 正对照:剥注释这一步要真有效 —— 剥之前必须确实能匹配到头部那句说明,
      // 否则「剥完没匹配」可能是因为把全文都剥没了,断言退化成恒真。
      check(
        'FE client:剥注释有效性正对照(剥之前能匹配到头部说明)',
        [...emitted].some(([, content]) => /baseURL/.test(content)),
        '若这条也失败,说明产物头部的安全说明被删了,或剥注释逻辑吃掉了全文',
      );
      check(
        'FE client:剥注释后仍保留代码(不是把全文剥没了)',
        [...emitted].every(([, content]) => /export /.test(stripComments(content))),
      );
      // 生成器自校验必须真的能判 —— 喂一份坏产物,诊断必须非空
      const broken = new Map(emitted);
      broken.set('docs/handoff/clients/admin/types.ts', 'export interface Broken { a: ; }\n');
      check(
        'FE client:产物自校验阳性对照(坏产物必须被 TS 诊断抓到)',
        validateFeClient(broken).length > 0,
      );
      check('FE client:真产物自校验零诊断', validateFeClient(emitted).length === 0);
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  // 已知缺口:生成器写入不经过本地 hook
  //
  // 维护者 2026-08-13 定性:**已知性质,不是漏洞** —— 生成物必须能被重生成,否则改一次
  // 路由声明就永远过不了 docs:authz:check。但它必须**每次自测都显形**,而不是躺在
  // 归档报告里(散文会过期,输出不会)。
  //
  // 下面是**真探针**,不是一句话:先证明该路径确实在红区判据内,再证明写侧 hook 对
  // 「程序内部写盘」这条向量确实放行。哪天 hook 把这条也拦上了,第二个探针翻面 →
  // knownGap() 转红 → 逼人来摘登记。
  // ────────────────────────────────────────────────────────────────────────
  {
    const REPO_G = path.resolve(__dirname, '..');
    // 判据路径刻意选 AGENTS.md:它是红区文档里最不可能被 grant 的一条,
    // 探针因此**不受当前令牌状态影响**(实测教训:第一版用 ROUTE_AUTHZ.md,
    // 恰逢它被临时授权,hook 合规放行,前提断言当场自相矛盾)。
    const STABLE_PROTECTED = 'AGENTS.md';
    const bashGuardExit = (command: string): number => {
      const r = spawnSync(path.join(REPO_G, '.claude/hooks/bash-write-guard.sh'), {
        input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }),
        encoding: 'utf-8',
        cwd: REPO_G,
      });
      return r.status ?? -1;
    };

    // 前提:写侧 hook 本身在工作 —— 路径**字面出现**在命令里时它确实拦得住。
    // 没有这一条,下面的「放行」可能只是说明这个文件压根没被保护,登记就成了废话。
    const literalRedirect = bashGuardExit(`echo x > ${STABLE_PROTECTED}`);
    check(
      '已知缺口前提:路径字面出现时,写侧 hook 确实拦得住(shell 重定向)',
      literalRedirect === 2,
      `echo x > ${STABLE_PROTECTED} 返回 ${literalRedirect},期望 2;` +
        `若为 0,请先确认 ${STABLE_PROTECTED} 是否被临时 grant —— 那会让本探针失去意义`,
    );
    const literalNodeWrite = bashGuardExit(
      `node -e "require('fs').writeFileSync('${STABLE_PROTECTED}','x')"`,
    );
    check(
      '已知缺口前提:node -e 里路径字面出现时同样拦得住(缺口不是「node 一律放行」)',
      literalNodeWrite === 2,
      `返回 ${literalNodeWrite},期望 2`,
    );

    // 缺口本体:路径**不字面出现**在命令文本里时,写侧 hook 看不见。
    // 两条向量各一例 —— 拼接构造 与 路径藏在被调用的程序里(生成器就是后者)。
    const concatExit = bashGuardExit(
      `node -e "const p='AGENTS'+'.md'; require('fs').writeFileSync(p,'x')"`,
    );
    const generatorExit = bashGuardExit('pnpm docs:authz');
    knownGap(
      'WRITE-GUARD-LITERAL-ONLY',
      concatExit === 0 && generatorExit === 0,
      '写侧 hook 按**命令文本里的字面路径**匹配,不做数据流分析 —— 路径不字面出现就看不见:\n' +
        `    · 拼接构造:node -e "const p='AGENTS'+'.md'; fs.writeFileSync(p,…)"  → 放行(实测 exit ${concatExit})\n` +
        `    · 路径藏在被调用的程序里:pnpm docs:authz / docs:codemap 等**生成器**  → 放行(实测 exit ${generatorExit})\n` +
        '    与 eslint 那批「变量中转 / 计算属性」缺口同形:这一层是**字面拦截**,不是数据流执法。\n' +
        '    定性:**已知性质,非漏洞**(维护者 2026-08-13)—— 生成物必须能被重生成,\n' +
        '    否则改一次路由声明就永远过不了 docs:authz:check。\n' +
        '    兜底仍在:CI 侧 check-redzone 按 diff 如实标红,base-trusted 裁判要求 harness-review 环境审批\n' +
        '    (2026-08-13 探针 PR #991 实测:改 ROUTE_AUTHZ.md 触发 architecture-governance-phase0-artifacts 审批)。\n' +
        '    即本地那道闸在 AI 侧靠自觉,**人闸在 CI 侧仍然成立**。',
      `拼接构造返回 ${concatExit}、生成器返回 ${generatorExit},已不再都是 0`,
    );
  }

  // ────────────────────────────────────────────────────────────────────────
  // R5/R6 数据访问扫描 —— typed-AST 绕过样例(v4 EC-COMMON 第 3/4 条)
  //
  // v4 要求 blocking 版必须 typed-AST 化,且 alias / destructuring /
  // variable-forwarding / re-export 四类绕过样例在 selftest 全绿。
  //
  // 为什么必须造样例而不是数实仓命中:实测 typed 版在本仓只比 Phase 0 的名字启发式
  // 多出 1 条(511→512)—— 不是因为启发式准,而是因为本仓恰好把每个 Prisma 句柄都
  // 命名成 prisma/tx/client/db。**能力差距要用对抗样例证明,不能用实仓读数证明**,
  // 否则哪天有人写 `const anythingAtAll = this.prisma` 就静默漏检。
  //
  // 断言走 check-boundaries.ts 导出的 probeDelegateResolution —— 即生产同一条代码
  // 路径。若在这里重写一份解析器,解析器退化了本自测照样绿。
  // ────────────────────────────────────────────────────────────────────────
  {
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'srvf-boundary-fx-'));
    fs.mkdirSync(path.join(fixtureDir, 'node_modules/@prisma/client'), { recursive: true });
    // 形状与生成的 client 一致:每 model 一个 `<Model>Delegate`,client 持有 raw 方法。
    fs.writeFileSync(
      path.join(fixtureDir, 'node_modules/@prisma/client/index.d.ts'),
      'export interface MemberDelegate { create(a?: any): any; findMany(a?: any): any; }\n' +
        'export interface ActivityDelegate { create(a?: any): any; findMany(a?: any): any; }\n' +
        'export interface PrismaClient { member: MemberDelegate; activity: ActivityDelegate;' +
        ' $queryRaw(...a: any[]): any; $executeRaw(...a: any[]): any; }\n' +
        "export declare namespace Prisma { type TransactionClient = Omit<PrismaClient, '$connect'>; }\n",
    );
    fs.writeFileSync(
      path.join(fixtureDir, 'hub.ts'),
      "export type { PrismaClient } from '@prisma/client';\n",
    );

    const positives: Record<string, string> = {
      'direct-baseline':
        "import type { PrismaClient } from '@prisma/client';\n" +
        'declare const prisma: PrismaClient;\n' +
        'export function f() { return prisma.member.create({ data: {} }); }\n',
      // 绕过类 ①variable forwarding:句柄换成任意名字
      'variable-forwarding':
        "import type { PrismaClient } from '@prisma/client';\n" +
        'declare const prisma: PrismaClient;\n' +
        'export function f() { const anythingAtAll = prisma;' +
        ' return anythingAtAll.member.create({ data: {} }); }\n',
      // 绕过类 ②destructuring:delegate 被解构出来,调用形态里根本没有接收者
      destructuring:
        "import type { PrismaClient } from '@prisma/client';\n" +
        'declare const prisma: PrismaClient;\n' +
        'export function f() { const { member } = prisma; return member.create({ data: {} }); }\n',
      // 绕过类 ③import alias
      'import-alias':
        "import type { PrismaClient as Renamed } from '@prisma/client';\n" +
        'declare const zzz: Renamed;\n' +
        'export function f() { return zzz.member.create({ data: {} }); }\n',
      // 绕过类 ④re-export:类型经中转文件再导出
      're-export':
        "import type { PrismaClient } from './hub';\n" +
        'declare const q: PrismaClient;\n' +
        'export function f() { return q.member.create({ data: {} }); }\n',
      // tx 参数:名字刻意不叫 tx,证明判据不是名字
      'tx-parameter':
        "import type { Prisma } from '@prisma/client';\n" +
        'export function f(handle: Prisma.TransactionClient) {' +
        ' return handle.member.create({ data: {} }); }\n',
      // 窄口:仓内实存形态(OutboxClient / SmsDispatchClient 等)
      'narrow-port':
        "import type { MemberDelegate } from '@prisma/client';\n" +
        'interface AudiencePort { member: MemberDelegate }\n' +
        'declare const somethingElse: AudiencePort;\n' +
        'export function f() { return somethingElse.member.create({ data: {} }); }\n',
    };
    const negatives: Record<string, string> = {
      // 阳性对照:长得像但不是 Prisma —— 名字启发式在这两条上都误报
      'lookalike-interface':
        'interface FakeRepo { member: { create(a?: any): any } }\n' +
        'declare const prisma: FakeRepo;\n' +
        'export function f() { return prisma.member.create({ data: {} }); }\n',
      'lookalike-inline':
        'declare const db: { member: { create(a?: any): any } };\n' +
        'export function f() { return db.member.create({ data: {} }); }\n',
    };

    const roots: string[] = [path.join(fixtureDir, 'hub.ts')];
    for (const [name, code] of Object.entries({ ...positives, ...negatives })) {
      const file = path.join(fixtureDir, name + '.ts');
      fs.writeFileSync(file, code);
      roots.push(file);
    }
    const probes = probeDelegateResolution(roots, ['Member', 'Activity'], {
      target: ts.ScriptTarget.ES2022,
      moduleResolution: ts.ModuleResolutionKind.Node10,
      strict: true,
      baseUrl: fixtureDir,
    });
    const resolvedIn = (name: string): string | null =>
      probes.find((p) => p.file === name + '.ts' && p.model !== null)?.model ?? null;

    for (const name of Object.keys(positives)) {
      check(
        `R5/R6 typed-AST 绕过样例(正):${name} 仍被解析为 Member delegate`,
        resolvedIn(name) === 'Member',
        `实际解析 = ${String(resolvedIn(name))}`,
      );
    }
    for (const name of Object.keys(negatives)) {
      check(
        `R5/R6 typed-AST 绕过样例(负):${name} 不得被当成 Prisma 访问`,
        resolvedIn(name) === null,
        `实际解析 = ${String(resolvedIn(name))}`,
      );
    }

    // 名字启发式的阳性对照:证明上面那批「正」样例确实是**被 Phase 0 漏掉的**,
    // 而不是随便挑了几个本来就能过的形态。判据 = Phase 0 那条正则的原文。
    const phase0Heuristic = (receiverText: string): boolean =>
      receiverText.includes('prisma') ||
      ['tx', 'transaction', 'client', 'db'].includes(receiverText) ||
      /(?:^|\.)(prisma|tx|transaction|client|db)(?:\.|$)/.test(receiverText);
    checkEq(
      'R5/R6 对照:variable-forwarding 的接收者名字骗得过 Phase 0 启发式',
      phase0Heuristic('anythingAtAll'),
      false,
    );
    checkEq('R5/R6 对照:tx-parameter 改名 handle 后骗得过 Phase 0 启发式', phase0Heuristic('handle'), false);
    checkEq(
      'R5/R6 对照:lookalike 在 Phase 0 启发式下是误报(名字叫 db 就算数)',
      phase0Heuristic('db'),
      true,
    );

    // raw 通道同样按类型判定,不按名字。
    fs.writeFileSync(
      path.join(fixtureDir, 'raw-channel.ts'),
      "import type { Prisma } from '@prisma/client';\n" +
        'export function f(handle: Prisma.TransactionClient) {' +
        " return handle.$queryRaw`SELECT 1 FROM members`; }\n",
    );
    const rawProbes = probeDelegateResolution(
      [path.join(fixtureDir, 'raw-channel.ts')],
      ['Member'],
      {
        target: ts.ScriptTarget.ES2022,
        moduleResolution: ts.ModuleResolutionKind.Node10,
        strict: true,
        baseUrl: fixtureDir,
      },
    );
    check(
      'R5/R6 raw 通道:$queryRaw 接收者按类型识别(参数名不叫 tx 也认得)',
      rawProbes.some((p) => p.rawCapable),
      `probes=${JSON.stringify(rawProbes)}`,
    );
  }

  // ── IDOR 属主守卫:cancelMy 的两道判定必须都在 ────────────────────────────
  //
  // 为什么是结构断言而不是 e2e：`cancelMy` 有两道独立的属主判定（锁活动前一道、
  // 锁后复读再一道）。它们是纵深防御 —— 删掉任意**一道**，另一道照样返 404，
  // 可观测行为逐字不变，黑盒测试原理上区分不了「一道」和「两道」。实测印证：
  // 单删任一道，`app-my-registrations-write` 42 条全绿；两道全删才红 2 条。
  //
  // 其余三条内存比对属主的端点（my/registrations/:id、notifications/:id、
  // notifications/:id/read）各只有一道判定，删掉即有具名 e2e 用例转红，
  // 已由行为层锁住，**不在此重复登记**。这里只补 e2e 够不到的那一处。
  //
  // 判据要的是**后果**不是比较本身：比较必须落在一个 then 分支会抛的 if 里，
  // 裸比较不算守卫（与「调用无后果分支不构成断言」同一条哲学）。
  {
    const ownerGuardRoot = path.resolve(__dirname, '..');
    const ownerGuardFile = 'src/modules/activity-registrations/activity-registrations.service.ts';
    const ownerGuardSource = ts.createSourceFile(
      ownerGuardFile,
      fs.readFileSync(path.join(ownerGuardRoot, ownerGuardFile), 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    const throwsWithin = (node: ts.Node): boolean => {
      let found = false;
      const visit = (child: ts.Node): void => {
        if (found) return;
        if (ts.isThrowStatement(child)) {
          found = true;
          return;
        }
        child.forEachChild(visit);
      };
      visit(node);
      return found;
    };
    /** `X.memberId !== memberId` 且其所在 if 的 then 分支会抛 = 一道属主守卫。 */
    const countOwnerGuards = (method: ts.MethodDeclaration): number => {
      let guards = 0;
      const visit = (node: ts.Node): void => {
        if (
          ts.isBinaryExpression(node) &&
          node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken
        ) {
          const sides = [node.left, node.right];
          const owner = sides.find(
            (side) => ts.isPropertyAccessExpression(side) && side.name.text === 'memberId',
          );
          const subject = sides.find((side) => ts.isIdentifier(side) && side.text === 'memberId');
          if (owner !== undefined && subject !== undefined) {
            let cursor: ts.Node = node;
            while (cursor !== method && cursor.parent !== undefined) {
              if (ts.isIfStatement(cursor.parent) && throwsWithin(cursor.parent.thenStatement)) {
                guards += 1;
                break;
              }
              cursor = cursor.parent;
            }
          }
        }
        node.forEachChild(visit);
      };
      method.forEachChild(visit);
      return guards;
    };
    const ownerGuardMethods = new Map<string, ts.MethodDeclaration>();
    const collectMethods = (node: ts.Node): void => {
      if (ts.isMethodDeclaration(node) && node.name !== undefined) {
        ownerGuardMethods.set(node.name.getText(ownerGuardSource), node);
      }
      node.forEachChild(collectMethods);
    };
    collectMethods(ownerGuardSource);
    const cancelMy = ownerGuardMethods.get('cancelMy');
    const findMy = ownerGuardMethods.get('findMy');
    check(
      'IDOR 守卫:activity-registrations.service.ts 仍有 cancelMy / findMy 两个方法',
      cancelMy !== undefined && findMy !== undefined,
      `cancelMy=${String(cancelMy !== undefined)} findMy=${String(findMy !== undefined)}`,
    );
    if (cancelMy !== undefined && findMy !== undefined) {
      checkEq(
        'IDOR 守卫:cancelMy 保有两道独立属主判定(e2e 测不出单删,故在此钉住)',
        countOwnerGuards(cancelMy),
        2,
      );
      // 正对照：单道守卫的 findMy 必须恰好数出 1 —— 若判据写坏成恒 0 / 恒大，
      // 上面那条会跟着一起坏而不被发现，这条会先红。
      checkEq('IDOR 守卫:findMy 单道属主判定(判据正对照)', countOwnerGuards(findMy), 1);
    }
  }

  // -------------------------------------------------------------------------
  // Phase 6-A — 大 service 尺寸棘轮:口径与判据的阳性对照
  // -------------------------------------------------------------------------
  //
  // 为什么这几条必须存在:棘轮的判据值是**一个数**,而数最容易被悄悄改坏 ——
  // 把 `>` 写成 `>=`、把 NCLOC 退回物理行、把发现面缩回旧的 `src/modules/*/*.service.ts`,
  // 三种改法都不会让任何既有测试变红,棘轮却已经失效。逐条钉住。
  {
    const sizedUnit = (relPath: string, loc: number, domain: string): SizedUnit => ({
      relPath,
      module: domain,
      basename: relPath.split('/').pop() ?? relPath,
      loc,
      physicalLoc: loc,
    });
    const sizedBaseline = (
      entries: Array<{ file: string; loc: number; domain: string }>,
    ): ServiceSizeBaseline => ({
      schemaVersion: 1,
      generatorVersion: 1,
      metric: 'non-comment-non-blank-lines',
      threshold: 700,
      inputDigest: serviceSizeInputDigest(),
      entries,
    });
    const sevOf = (
      results: ReturnType<typeof checkServiceSize>,
      id: string,
    ): string | undefined => results.find((r) => r.id === id)?.severity;

    const oneBaseline = [{ file: 'src/modules/demo/demo.service.ts', loc: 900, domain: 'demo' }];

    // ① 基线内文件变大 ⇒ 必报
    checkEq(
      '尺寸棘轮:基线文件 +1 行即报',
      sevOf(
        checkServiceSize(
          [sizedUnit('src/modules/demo/demo.service.ts', 901, 'demo')],
          sizedBaseline(oneBaseline),
        ),
        'service-size-ratchet',
      ),
      'WARN',
    );

    // ② 变小 / 持平 ⇒ 不报(否则棘轮会把「正在还债」的 PR 也拦下,没人会再去拆)
    checkEq(
      '尺寸棘轮:基线文件变小不报',
      sevOf(
        checkServiceSize(
          [sizedUnit('src/modules/demo/demo.service.ts', 899, 'demo')],
          sizedBaseline(oneBaseline),
        ),
        'service-size-ratchet',
      ),
      'PASS',
    );
    checkEq(
      '尺寸棘轮:基线文件持平不报(边界:只增才报)',
      sevOf(
        checkServiceSize(
          [sizedUnit('src/modules/demo/demo.service.ts', 900, 'demo')],
          sizedBaseline(oneBaseline),
        ),
        'service-size-ratchet',
      ),
      'PASS',
    );

    // ③ 基线外新文件达到阈值 ⇒ 必报(防「拆成两个次巨无霸」静默入册)
    checkEq(
      '尺寸棘轮:基线外新文件达到阈值即报',
      sevOf(
        checkServiceSize(
          [sizedUnit('src/modules/demo/fresh.service.ts', 700, 'demo')],
          sizedBaseline([]),
        ),
        'service-size-new-above-threshold',
      ),
      'WARN',
    );
    // 阈值下方一行的正对照 —— 若判据写坏成「恒报」,上面那条照样绿,这条会先红。
    checkEq(
      '尺寸棘轮:阈值下一行不报(判据正对照)',
      sevOf(
        checkServiceSize(
          [sizedUnit('src/modules/demo/fresh.service.ts', 699, 'demo')],
          sizedBaseline([]),
        ),
        'service-size-new-above-threshold',
      ),
      undefined,
    );

    // ④ **纯注释膨胀不得触发** —— 这条钉的是 D1 口径本身。
    //    退回物理行计数,它会立刻变红;这正是它存在的理由。
    const realCode = ['export class Demo {', '  run(): number {', '    return 1;', '  }', '}'].join(
      '\n',
    );
    const commentBloat = `${Array.from({ length: 400 }, (_, i) => `// 铁律第 ${i} 条:此处写模块级约束`).join('\n')}\n${realCode}`;
    checkEq('尺寸口径:纯注释膨胀不改变度量值', measureNcloc(commentBloat), measureNcloc(realCode));
    check(
      '尺寸口径:注释膨胀确实撑大了物理行(证明上一条不是因为样例没变)',
      commentBloat.split('\n').length > realCode.split('\n').length + 350,
      `物理行 ${commentBloat.split('\n').length} vs ${realCode.split('\n').length}`,
    );
    checkEq(
      '尺寸棘轮:注释膨胀 400 行不触发棘轮',
      sevOf(
        checkServiceSize(
          [
            sizedUnit(
              'src/modules/demo/demo.service.ts',
              measureNcloc(commentBloat),
              'demo',
            ),
          ],
          sizedBaseline([
            {
              file: 'src/modules/demo/demo.service.ts',
              loc: measureNcloc(realCode),
              domain: 'demo',
            },
          ]),
        ),
        'service-size-ratchet',
      ),
      'PASS',
    );
    // 剥注释必须靠 TS parser 而不是正则:字符串里的 `//` 不是注释。
    checkEq('尺寸口径:字符串里的 // 不算注释', measureNcloc(`const s = '// not a comment';`), 1);
    checkEq('尺寸口径:整行注释不计入', measureNcloc('// only a comment'), 0);

    // ④b **重扫脱锁类**:模板串之后的注释仍须被剥离。
    //
    // 这四条钉的是 2026-08-15 修掉的一个真缺陷 —— 原实现用裸 `ts.createScanner` + `scan()`
    // 循环,遇 `` `…${…}` `` 不调 `reScanTemplateToken()` ⇒ 扫描器脱锁,收尾反引号开启了
    // 一个新模板串,把其后的整行 `//` 注释吞成字符串内容 ⇒ **注释被算成代码**。
    // 实测发现面 149 个文件里 90 个(60.4%)读数虚高,4 个基线文件纯靠虚高才越过阈值 700。
    //
    // ⚠️ 它藏了十一次没被抓到,正是因为上面 22 条尺寸段对照**没有一条**喂过模板串 ——
    // 「纯注释膨胀」「字符串里的 //」都不触发重扫。加对照前先问「缺口长什么样」,
    // 这四条就是那个缺口的形状。
    const tplThenComments = ['const a = `${1}`;', '// c1', '// c2', 'const b = 2;'].join('\n');
    checkEq('尺寸口径:带替换模板串之后的整行注释仍不计入', measureNcloc(tplThenComments), 2);
    const nestedTplThenComments = ['const a = `${`${1}`}`;', '// c1', '// c2', 'const b = 2;'].join(
      '\n',
    );
    checkEq('尺寸口径:嵌套模板串之后的整行注释仍不计入', measureNcloc(nestedTplThenComments), 2);
    // 反向:多行模板串**内部**的 `//` 是字符串内容,不是注释,**不得**被剥掉。
    // 少了这条,「把模板串整段当注释剥掉」也能让上面两条变绿 —— 那是另一种错。
    const multilineTpl = ['const a = `line1', '// 这是字符串内容不是注释', 'line3`;', 'const b = 2;'].join(
      '\n',
    );
    checkEq('尺寸口径:多行模板串内的 // 是内容,不得剥离', measureNcloc(multilineTpl), 4);
    // 同类:正则字面量里的 `/*` 不得被当成块注释起点(裸 scanner 需 reScanSlashToken)。
    checkEq(
      '尺寸口径:正则字面量里的 /* 不是注释起点',
      measureNcloc(['const re = /\\/\\*/;', '// c1', 'const b = 2;'].join('\n')),
      2,
    );

    // ④c **JSDoc 必须不计入** —— 这三条钉的是修复本缺陷时**新引入又当场抓到**的同类缺陷:
    //    `ts.createSourceFile(..., setParentNodes: true)` 之下,`getChildren()` 会把
    //    `/** … */` 作为 **JSDoc 节点**挂在声明下(普通 `/* */` 与 `//` 是 trivia,不在任何
    //    token 区间内),于是按「叶子 token 覆盖」判定时 JSDoc 正文被算成代码。
    //    本仓 JSDoc 密度极高 ⇒ 不守这条,度量会系统性虚高,与要修的缺陷同类。
    checkEq('尺寸口径:单行 JSDoc 不计入', measureNcloc('/** doc */\nfunction f() {}'), 1);
    checkEq(
      '尺寸口径:多行 JSDoc 不计入(只数真代码行)',
      measureNcloc('/**\n * line A\n * line B\n */\nfunction f() {}'),
      1,
    );
    // 反向:JSDoc 里出现 `${}` / `//` 也不得把后面的真代码带走。
    checkEq(
      '尺寸口径:JSDoc 内的 ${} 与 // 不影响其后代码计数',
      measureNcloc('/**\n * `${x}` 与 // 都在 JSDoc 里\n */\nconst a = 1;'),
      1,
    );

    // ⑤ 发现面:orchestrator / handlers 必须算数 —— 旧口径看不见全仓最大的代码文件。
    check(
      '尺寸发现面:*-orchestrator.ts 计入',
      isSizedUnit('src/modules/attachments/attachment-storage-orchestrator.ts'),
    );
    check(
      '尺寸发现面:*.handlers.ts 计入',
      isSizedUnit('src/modules/notifications/notification-outbox.handlers.ts'),
    );
    check(
      '尺寸发现面:嵌套目录下的 service 也计入(旧口径不递归)',
      isSizedUnit('src/modules/demo/nested/deep.service.ts'),
    );
    check('尺寸发现面:*.spec.ts 排除', !isSizedUnit('src/modules/demo/demo.service.spec.ts'));
    check('尺寸发现面:src 之外排除', !isSizedUnit('test/e2e/demo.service.ts'));

    // ⑥ 拆分识别:同域「基线文件变小」+「新超阈值文件」并列显示(只提示,不裁决)
    checkEq(
      '尺寸棘轮:同域拆分并列显示',
      sevOf(
        checkServiceSize(
          [
            sizedUnit('src/modules/demo/demo.service.ts', 800, 'demo'),
            sizedUnit('src/modules/demo/demo-extracted.service.ts', 750, 'demo'),
          ],
          sizedBaseline([
            { file: 'src/modules/demo/demo.service.ts', loc: 1500, domain: 'demo' },
          ]),
        ),
        'service-size-possible-split',
      ),
      'INFO',
    );

    // ⑦ 口径指纹:基线与当前口径不符必须报(阈值/度量被改而基线没重生成)
    checkEq(
      '尺寸棘轮:inputDigest 不符即报(口径已变,基线须重生成)',
      sevOf(
        checkServiceSize([], { ...sizedBaseline([]), inputDigest: 'sha256:stale' }),
        'service-size-digest',
      ),
      'WARN',
    );

    // ⑧ CI 接线:必须在既有 fast job 内、且**此刻处于 report 模式**。
    //    goal §5 承诺「本刀恒 report,不得阻断任何业务 PR」—— 这两条是那句话的执行位。
    //    ⚠️ 转 blocking 时:删 ci.yml 里那个 `|| true`,并把下面第二条断言一起翻面。
    //       两处一起改是刻意的摩擦(翻闸是拍板动作,不该顺手完成)。
    {
      const ciRaw = fs.readFileSync(
        path.resolve(__dirname, '..', '.github/workflows/ci.yml'),
        'utf-8',
      );
      const ci = codeOnly(ciRaw);
      check(
        '尺寸棘轮 CI:接进既有 job(不新增 required context)',
        ci.includes('pnpm harness:servicesize'),
        '步骤缺失 = 棘轮从没在 CI 跑过',
      );
      check(
        '尺寸棘轮 CI:此刻是 report 模式(带 || true)',
        /pnpm harness:servicesize \|\| true/.test(ci),
        '没有 || true ⇒ 已是 blocking:那是拍板动作,须同时更新本断言与 SERVICE_SIZE_RATCHET.md',
      );

      // 债务台账语义完整性(2026-08-15 接闸)。它是 `semanticFieldsComplete` 的
      // **唯一**执法者:--violations 被 `|| true` 兜住、--metadata 根本不碰它。
      // 断言用的是 codeOnly(ci) —— 上方那段 YAML 注释里逐字写了这条命令名,
      // 不剥注释的话「命令还在不在」会被注释本身满足(本仓已栽过两次的形状)。
      check(
        '债务台账 CI:接进既有 A-metadata gate(不新增 required context)',
        ci.includes('pnpm docs:boundaries:debt:check'),
        '步骤缺失 = semanticFieldsComplete 回到零执法',
      );
      check(
        '债务台账 CI:是阻断模式(不带 || true)',
        !/pnpm docs:boundaries:debt:check\s*\|\|\s*true/.test(ci),
        '加了 || true ⇒ 闸被静默关掉:台账填不全也照绿,与接闸的理由直接相反',
      );
    }

    // ⑨ 落盘基线必须与当前口径一致 —— 防「改了阈值却忘了重生成基线」悄悄躺着。
    {
      const onDisk = JSON.parse(
        fs.readFileSync(path.resolve(__dirname, '..', 'harness/service-size-baseline.json'), 'utf-8'),
      ) as ServiceSizeBaseline;
      checkEq('尺寸基线:落盘 inputDigest 与当前口径一致', onDisk.inputDigest, serviceSizeInputDigest());
      checkEq('尺寸基线:落盘 metric 与当前口径一致', onDisk.metric, 'non-comment-non-blank-lines');
      check(
        '尺寸基线:entries 非空(空基线 = 棘轮没有判据)',
        Array.isArray(onDisk.entries) && onDisk.entries.length > 0,
        `entries=${onDisk.entries?.length}`,
      );
    }
  }

  // ── docs/ai-harness 目录登记(check-codemap 的 ai-harness-index-complete)──
  //
  // 守的是「§4 的目录清单 ↔ 磁盘实际文件」。2026-08-15 之前这句话是纯散文,
  // 于是它从「恰 4 文件」一路漂到 11 个都没人发现(Phase 0-6 共 7 份报告)。
  //
  // 下面每条都是**判据绑对**的对照,不是覆盖率装饰:
  // 尤其「子串不算登记」—— 朴素 includes 会让 RBAC_MAP.md 顺带满足 MAP.md,
  // 方向是假绿(真没登记的文件被放行),只有正对照抓得到。
  {
    const STUB = [
      '# x',
      '## 3. 定位路径',
      '见 [`process`](../process.md) 与 [`GHOST.md`](GHOST.md)。',
      '## 4. 目录说明',
      '| [`README.md`](README.md) | 本页 |',
      '| [`RBAC_MAP.md`](RBAC_MAP.md) | 权限地图 |',
      '## 5. 其他',
    ].join('\n');
    const sev = (docs: string[], md: string): string => checkAiHarnessIndex(docs, md).severity;

    checkEq('目录登记:全部登记 ⇒ PASS', sev(['README.md', 'RBAC_MAP.md'], STUB), 'PASS');
    checkEq(
      '目录登记:新增文件未登记 ⇒ FAIL(本检查存在的理由)',
      sev(['README.md', 'RBAC_MAP.md', 'NEW_REPORT.md'], STUB),
      'FAIL',
    );
    checkEq('目录登记:登记了不存在的文件 ⇒ FAIL(反方向)', sev(['README.md'], STUB), 'FAIL');
    checkEq(
      '目录登记:§4 标题缺失 ⇒ FAIL(无法验证 ≠ 通过)',
      sev(['README.md'], '# x\n## 9. 别的\n'),
      'FAIL',
    );
    checkEq('目录登记:README 读不到 ⇒ FAIL(fail-closed)', sev(['README.md'], ''), 'FAIL');
    checkEq(
      '目录登记:子串不算登记(MAP.md 不被 RBAC_MAP.md 盖章)',
      sev(['README.md', 'RBAC_MAP.md', 'MAP.md'], STUB),
      'FAIL',
    );
    check(
      '目录登记:只认 §4,节外链接不算登记',
      !mentionsDocName(extractSectionAfter(STUB, /^##\s*4[.、]?\s*目录说明/m) ?? '', 'GHOST.md'),
      '§3 里的 GHOST.md 被当成了 §4 的登记',
    );
    checkEq(
      '目录登记:跨目录链接不当成本目录条目',
      siblingLinkTargets('见 [`p`](../process.md)').length,
      0,
    );
    // 真仓库读数:守护此刻真的绿(否则上面全是对 stub 的自娱自乐)
    checkEq(
      '目录登记:真实 docs/ai-harness 当前 PASS',
      checkAiHarnessIndex(
        fs
          .readdirSync(path.resolve(__dirname, '..', 'docs/ai-harness'))
          .filter((f) => f.endsWith('.md'))
          .sort(),
        fs.readFileSync(path.resolve(__dirname, '..', 'docs/ai-harness/README.md'), 'utf-8'),
      ).severity,
      'PASS',
    );
  }

  // ===========================================================================
  // journey 直写库接缝纪律(第七轮后续,2026-08-21)
  //
  // 缺陷类:**验证代码自己绕过了被验证的路径,而且没人知道它绕了。**
  //
  // 实测立项时:`test/support/journey-*.ts` 共 **46 处**直接写库
  // (attendance-correction 15 · recruitment-team-join 9 · registration-checkin 8
  //  · outbox-delivery 7 · runtime 5 · certificate-recognition 2),
  // 而 golden journey 是全仓最端到端的验证。每一处直写都是**一段没被穿过的接缝**:
  // 建那个状态的 API 路径若断了、或有个满足不了的前置(第七轮③类),
  // journey 照样全绿 —— 因为它压根没走那条路。
  //
  // 本闸**不禁止直写**(禁了 journey 无法起步),而是**逼每一处交代一次**:
  // 每个直写调用的**紧邻上一行**必须是 `// journey-direct-write: <分类> — <理由>`,
  // 分类取自闭集 —— 自由文本的理由验不了真伪,分类可以。
  //
  // ⭐ `no-api` 是关键一档:它把「图省事的直写」与「真的没有接口」分开 ——
  // 前者该改成走 HTTP,后者是**缺口显形**,必须同时登记 NEXT_TASKS。
  // ===========================================================================
  {
    const JOURNEY_DIRECT_WRITE_CATEGORIES = new Set([
      // 环境搭建,不属于本 journey 声称验证的那条链(组织树 / 字典 / 渠道配置)
      'ambient',
      // 属于被验链,但闸后不可达 ⇒ 当前根本没有 API 路径可走
      'gate-unreachable',
      // 只压缩等待(重试退避 / 定时窗),不跳过任何链上步骤
      'time-compression',
      // 属于被验链、有 API,但刻意从中间态起步 —— 理由必须写明为什么不从头走
      'mid-chain-start',
      // 属于被验链且**没有** API 路径 ⇒ 真缺口,必须同时登记 NEXT_TASKS
      'no-api',
    ]);

    const JOURNEY_WRITE_RE =
      /(?:prisma|tx)\.[A-Za-z][A-Za-z0-9]*\.(?:create|createMany|upsert|update|updateMany)\(/;
    const JOURNEY_NOTE_RE = /\/\/\s*journey-direct-write:\s*([a-z][a-z-]*)\s*—/;

    /** 地板锚点:不写「恰 46 条」—— 那会在下次加 journey 时过期,然后被人顺手改大。 */
    const JOURNEY_WRITE_FLOOR = 30;

    interface JourneyAuditResult {
      writes: number;
      findings: string[];
    }

    function auditJourneyDirectWrites(
      files: ReadonlyArray<{ path: string; text: string }>,
    ): JourneyAuditResult {
      const findings: string[] = [];
      let writes = 0;
      for (const file of files) {
        const lines = file.text.split('\n');
        for (let i = 0; i < lines.length; i += 1) {
          if (!JOURNEY_WRITE_RE.test(lines[i])) continue;
          writes += 1;
          // 只认**紧邻上一行**:允许标注离得远 = 允许一条标注假装覆盖后面所有直写。
          const previous = i > 0 ? lines[i - 1] : '';
          const matched = JOURNEY_NOTE_RE.exec(previous);
          if (!matched) {
            findings.push(`${file.path}:${i + 1} 直写库但上一行没有 journey-direct-write 标注`);
            continue;
          }
          if (!JOURNEY_DIRECT_WRITE_CATEGORIES.has(matched[1])) {
            findings.push(
              `${file.path}:${i + 1} 分类 "${matched[1]}" 不在闭集内` +
                `(合法值:${[...JOURNEY_DIRECT_WRITE_CATEGORIES].join(' / ')})`,
            );
          }
        }
      }
      return { writes, findings };
    }

    // ── 仪器正反对照:先证明这个函数真的会红,再拿它去量真仓库 ──────────────
    const STUB_UNLABELED = 'const a = await prisma.member.create({ data: {} });';
    const STUB_LABELED =
      '// journey-direct-write: ambient — 底座\nconst a = await prisma.member.create({ data: {} });';
    const STUB_BAD_CATEGORY =
      '// journey-direct-write: bogus-category — 理由\nconst a = await prisma.member.create({ data: {} });';
    const STUB_FAR_LABEL =
      '// journey-direct-write: ambient — 底座\n\nconst a = await prisma.member.create({ data: {} });';

    checkEq(
      'journey 直写:无标注 = FAIL',
      auditJourneyDirectWrites([{ path: 's.ts', text: STUB_UNLABELED }]).findings.length,
      1,
    );
    checkEq(
      'journey 直写:合法分类 = PASS',
      auditJourneyDirectWrites([{ path: 's.ts', text: STUB_LABELED }]).findings.length,
      0,
    );
    checkEq(
      'journey 直写:闭集外分类 = FAIL(证明分类闭集真的在管)',
      auditJourneyDirectWrites([{ path: 's.ts', text: STUB_BAD_CATEGORY }]).findings.length,
      1,
    );
    checkEq(
      'journey 直写:标注不紧邻 = FAIL(否则一条标注能假装覆盖后面所有直写)',
      auditJourneyDirectWrites([{ path: 's.ts', text: STUB_FAR_LABEL }]).findings.length,
      1,
    );

    // ── 真仓库读数 ────────────────────────────────────────────────────────
    const journeySupportDir = path.resolve(__dirname, '..', 'test/support');
    const journeyFiles = fs
      .readdirSync(journeySupportDir)
      .filter((name) => name.startsWith('journey-') && name.endsWith('.ts'))
      .sort()
      .map((name) => ({
        path: `test/support/${name}`,
        text: fs.readFileSync(path.join(journeySupportDir, name), 'utf-8'),
      }));

    const journeyAudit = auditJourneyDirectWrites(journeyFiles);

    // 自证:扫描面塌了(找不到 journey 文件 / 正则失配)必须红,不能空集恒等空集变绿。
    check(
      'journey 直写:扫描面非空(地板锚点,不写死条数)',
      journeyFiles.length >= 5 && journeyAudit.writes >= JOURNEY_WRITE_FLOOR,
      `发现 ${journeyFiles.length} 个 journey 文件 / ${journeyAudit.writes} 处直写` +
        `(地板 5 / ${JOURNEY_WRITE_FLOOR})—— 扫描面塌了`,
    );
    check(
      'journey 直写:真实 test/support 当前 PASS(每处都已交代)',
      journeyAudit.findings.length === 0,
      journeyAudit.findings.slice(0, 8).join('\n      '),
    );
  }

  if (knownGaps.length > 0) {
    process.stdout.write(`\n── 已知缺口:${knownGaps.length} 条(不假装安全)──\n`);
    for (const gap of knownGaps) {
      process.stdout.write(`  ⚠ [${gap.id}] ${gap.text}\n`);
    }
  }

  process.stdout.write(
    `\n${passCount} passed, ${failures.length} failed` +
      (knownGaps.length > 0 ? `, ${knownGaps.length} known gaps` : '') +
      '\n',
  );
  if (failures.length > 0) process.exit(1);
})();
