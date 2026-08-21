/**
 * check-permission-catalog-closure.ts —— 「四桶并集必须等于权限码全集」类闸。
 *
 * ⚠️ 本文件在 `harness/redzone.json` 的 selfGuard 内(`scripts/check-*.ts`)。
 *    判据逻辑刻意放在这里而不是 spec 里:spec(`src/**\/*.spec.ts`)不在 selfGuard,
 *    任何 PR 都能顺手改松它;把**实质逻辑**放在受保护文件里,改松就必须动红区。
 *    spec 侧只做薄运行器(见 `src/modules/permissions/permission-catalog-closure.spec.ts`)。
 *
 * ──────────────────────────────────────────────────────────────────────────
 * 立项理由(第七轮评审顺带发现 ①)
 *
 * `RBAC_SEED_CATALOG.permissions` 是**四个具名桶**,不是闭包。实测(`e04efa12`):
 *
 *     rbac 14 · bootstrap 115 · attachment 20 · business 90  ⇒ 并集 225
 *     权限码全集                                              ⇒ 237
 *
 * 漏的 12 条**恰好是整个 `ACTIVITY_RESPONSIBILITY_WORKFLOW_PERMISSION_SEED`** ——
 * 责任闭环那批加了自己的权限数组,却没人把它接进目录。
 *
 * 🔴 为什么这种漏法**零症状**:类型对(都是 `RbacPermissionSeed[]`)、
 * 数量看着合理(225 很像「差不多全部」)、没有断言也没有命名提示。
 * 而漏掉的偏偏是**最新、最需要盯的 flag-gated 码**(结算真相链 6 条、
 * 责任 override、跨组织发起、考勤退回)—— 想数它们的判据恰好数不到。
 *
 * 已知的真实后果:R7-D-01 建「权限码必须有持有人」闸时,实施方**差点**把
 * `RBAC_SEED_CATALOG.permissions` 当全集用 —— 那样它就会对这 12 条完全失明。
 * 那次是靠个人警觉绕开的,不是靠机制。本闸把它变成机制。
 *
 * ──────────────────────────────────────────────────────────────────────────
 * ⭐ 两侧口径必须是**不同的来源**(否则是恒 PASS 假绿)
 *
 *   · 全集侧 = `docs-counts` 的 **typed-AST 提取器**,静态扫 seed 事实闭包的
 *     源文本(`prisma/seed.ts` + `src/modules/permissions/rbac-seed-facts.ts`),
 *     逐条读 `code: '<literal>'` / `*_CODE = '<literal>'`。
 *   · 并集侧 = `RBAC_SEED_CATALOG.permissions` 的**运行时导出值**。
 *
 * 一个读源码文本、一个读运行时对象 ⇒ **它们真的会分叉**,分叉即本闸要抓的缺陷。
 * 若把全集侧换成「并集自己」,判据恒绿 —— 那是「拿生成器输出跟生成器输入比」,
 * 本仓已登记的假绿形状。变异对拍必须包含这一条口径对照。
 *
 * ──────────────────────────────────────────────────────────────────────────
 * 两个方向都查
 *
 *   (a) 全集有、任何桶都没有 → 新权限数组没接进目录(本闸的主用途)
 *   (b) 桶里有、全集没有     → 提取器口径漂了,或桶里有幽灵码
 *
 * (b) 不是理论洁癖:它是全集侧失效的**唯一**症状 —— 提取器若少认一种写法,
 * 全集会缩水,而缩水后的全集恒是并集的子集,方向 (a) 反而全绿。
 *
 * ──────────────────────────────────────────────────────────────────────────
 * 仪器纪律:先自证再报数
 *
 * 空集恒等于空集会静默变绿。用**地板锚点**(≥N)不用「恰 N 条」——
 * 后者每次新增权限码都要改判据,改判据的摩擦会诱导人把数字调大了事。
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  SEED_FACTS_CLOSURE,
  extractSeedFactsPermissionCodesAst,
  readSeedFactsClosure,
} from './docs-counts';

const ROOT = resolve(__dirname, '..');

/** 地板锚点。起草时实测:桶 5 个、并集与全集各 237 条。 */
export const MIN_BUCKETS = 4;
export const MIN_PERMISSION_CODES = 200;

export interface CatalogClosureReport {
  /** 每个桶的条数(含桶间重叠),按桶名排序。 */
  bucketCounts: ReadonlyArray<readonly [string, number]>;
  /** 各桶并集(去重)。 */
  union: ReadonlySet<string>;
  /** typed-AST 扫出的权限码全集。 */
  full: ReadonlySet<string>;
  /** (a) 全集有、任何桶都没有 —— 新权限数组没接进目录。 */
  missingFromBuckets: readonly string[];
  /** (b) 桶里有、全集没有 —— 提取器口径漂了,或桶里有幽灵码。 */
  phantomInBuckets: readonly string[];
}

/** 并集侧:读 `RBAC_SEED_CATALOG.permissions` 的**运行时**导出值。 */
function collectBucketUnion(): {
  bucketCounts: Array<readonly [string, number]>;
  union: Set<string>;
} {
  // 运行时 import —— 与全集侧的静态 AST 扫描是两条独立通路,这正是本闸的前提。
  // seed.ts 有 `require.main === module` 守卫,import 不会触发 seed 执行。
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const seed = require(join(ROOT, 'prisma/seed')) as {
    RBAC_SEED_CATALOG: { permissions: Record<string, ReadonlyArray<{ code: string }>> };
  };
  const buckets = seed.RBAC_SEED_CATALOG.permissions;

  const bucketCounts: Array<readonly [string, number]> = [];
  const union = new Set<string>();
  for (const name of Object.keys(buckets).sort()) {
    const entries = buckets[name];
    bucketCounts.push([name, entries.length] as const);
    for (const entry of entries) union.add(entry.code);
  }
  return { bucketCounts, union };
}

/** 全集侧:typed-AST 静态扫 seed 事实闭包的源文本。与并集侧不同源。 */
function collectFullSet(): Set<string> {
  return extractSeedFactsPermissionCodesAst(readSeedFactsClosure(SEED_FACTS_CLOSURE));
}

/**
 * 自证:扫描面塌了就拒绝报结论。
 *
 * 返回失败原因清单;非空即「仪器失效」,调用方必须当红处理而不是当绿。
 */
export function selfCheck(report: CatalogClosureReport): string[] {
  const failures: string[] = [];
  if (report.bucketCounts.length < MIN_BUCKETS) {
    failures.push(
      `RBAC_SEED_CATALOG.permissions 只发现 ${report.bucketCounts.length} 个桶 ` +
        `(< 地板 ${MIN_BUCKETS}) —— 目录结构可能已变`,
    );
  }
  if (report.union.size < MIN_PERMISSION_CODES) {
    failures.push(
      `各桶并集只有 ${report.union.size} 条 (< 地板 ${MIN_PERMISSION_CODES}) —— 并集侧塌了`,
    );
  }
  if (report.full.size < MIN_PERMISSION_CODES) {
    failures.push(
      `typed-AST 全集只有 ${report.full.size} 条 (< 地板 ${MIN_PERMISSION_CODES}) —— ` +
        `全集侧塌了,提取器口径可能已变`,
    );
  }
  // 事实闭包文件必须都存在且非空 —— 少一个文件会让全集静默缩水。
  for (const relative of SEED_FACTS_CLOSURE) {
    let text = '';
    try {
      text = readFileSync(join(ROOT, relative), 'utf8');
    } catch {
      failures.push(`seed 事实闭包文件读不到:${relative}`);
      continue;
    }
    if (text.trim().length === 0) failures.push(`seed 事实闭包文件为空:${relative}`);
  }
  return failures;
}

export function analyzeCatalogClosure(): CatalogClosureReport {
  const { bucketCounts, union } = collectBucketUnion();
  const full = collectFullSet();
  return {
    bucketCounts,
    union,
    full,
    missingFromBuckets: [...full].filter((code) => !union.has(code)).sort(),
    phantomInBuckets: [...union].filter((code) => !full.has(code)).sort(),
  };
}

/** CLI:`pnpm exec tsx scripts/check-permission-catalog-closure.ts`。退出码 0 / 1。 */
function main(): void {
  const report = analyzeCatalogClosure();

  const instrumentFailures = selfCheck(report);
  if (instrumentFailures.length > 0) {
    console.error('🔴 仪器失效 —— 拒绝报结论:');
    for (const failure of instrumentFailures) console.error(`  · ${failure}`);
    process.exit(1);
  }

  console.log(
    `扫描面:${report.bucketCounts.length} 个桶 ` +
      `(${report.bucketCounts.map(([n, c]) => `${n} ${c}`).join(' · ')})` +
      ` · 并集 ${report.union.size} · typed-AST 全集 ${report.full.size}`,
  );

  for (const code of report.missingFromBuckets) {
    console.error(
      `🔴 权限码不在任何桶内:${code}` +
        '(全集有它,RBAC_SEED_CATALOG.permissions 的各桶都没有 ——' +
        ' 新增权限数组时忘了在目录里加桶)',
    );
  }
  for (const code of report.phantomInBuckets) {
    console.error(
      `🔴 桶里有、全集没有:${code}` +
        '(typed-AST 提取器口径漂了,或桶里混进了不存在的码)',
    );
  }

  const broken = report.missingFromBuckets.length + report.phantomInBuckets.length;
  if (broken === 0) {
    console.log('✓ 各桶并集等于权限码全集。');
  } else {
    console.error(
      '\n修法:在 `prisma/seed.ts` 的 `RBAC_SEED_CATALOG.permissions` 里为新权限数组**加一个桶**。' +
        '\n⚠️ 不要加一个 `all` 桶把全集塞进去了事 —— 那让分桶失去意义,' +
        '\n   且下次新数组照样可以不进任何桶(闸会红,但人会顺手往 all 里塞)。',
    );
  }
  process.exit(broken === 0 ? 0 : 1);
}

if (require.main === module) main();
