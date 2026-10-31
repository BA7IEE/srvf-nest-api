#!/usr/bin/env node
/**
 * 夜间串行 e2e 线(.github/workflows/nightly-e2e-leaks.yml)的**分片清单唯一真相源**。
 *
 * 为什么不用 `jest --shard N/M`(白天 CI 用的那种):
 *   `--shard` 按文件哈希均分,同域 spec 会被打散到不同进程。夜间线的价值不是"跑得快",
 *   是 `--detectOpenHandles` 在**单进程连续跑**时能观察到 spec 之间累积出来的句柄泄漏。
 *   哈希均分会把"同族共享的单例 / 缓存"这类泄漏的两端拆到不同片里,片内看不见。
 *   故本文件按**域**切:同域 spec 仍连续跑在同一个 node 进程里。
 *
 * 2026-10-27:旧 activity 29 分钟估算已经失效,286 个套件在 70 分钟内未跑完。
 *   四片保留已观察到的完整 42 套件前序链及其精确顺序;其它活动套件按完整业务族
 *   分两片,原平台片不拆。历史耗时用于规划,不是未来耗时保证或业务 SLA。
 *   未知的跨片交互不再可见,不能宣称保留了原 286 套件的全部累积状态。
 *
 * ⚠️ 本文件与 workflow 的分工:
 *   本文件只**算**清单(纯函数,无副作用),workflow 负责**核**清单 ——
 *   每片断言 jest 实际收到的 suite 数等于这里的预算数,四片之和等于磁盘上的文件数。
 *   少了这一核,新增 spec 落不进任何一片时会**每片都绿 = 静默漏跑**,与漏跑等价。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const E2E_DIR = path.join(REPO_ROOT, 'test', 'e2e');
const SPEC_SUFFIX = '.e2e-spec.ts';

/**
 * 原活动片的文件名前缀。原平台 catch-all 保持完整,现在是片 4。
 *
 * 前缀取"词干"以覆盖单复数:`activit` 同时覆盖 activity* 与 activities*,
 * `member` 覆盖 member* / members* / memberships*,`attendance` 覆盖 attendance(s)*。
 * `app-` 面只把活动/出勤/报名那几支划进来,其余 app-me-* / app-my-certificates 等留在片 2。
 */
const ACTIVITY_PREFIXES = [
  'activit',
  'app-activit',
  'app-managed-activit',
  'participation',
  'assignments',
  'supervision',
  'contribution',
  'attendance',
  'app-my-attendance',
  'app-my-registrations',
  'registration',
  'member',
  'team',
  'recruitment',
  'realname',
  'emergency',
];

// 两次已保存的慢现场(40230772672 / 40411677209)具有相同的完整前序链。
// 不依赖 Jest 文件大小/历史耗时缓存排序:新增观测代码已经改变过默认次序。
export const CONTEXT_ORDER = Object.freeze([
  'test/e2e/activity-os-r5-e4-contribution-settlement-migration.e2e-spec.ts',
  'test/e2e/activity-os-r5-e4-contribution-settlement-scale.e2e-spec.ts',
  'test/e2e/activity-os-r5-e3-contribution-shadow-mapping-proof.e2e-spec.ts',
  'test/e2e/recruitment.e2e-spec.ts',
  'test/e2e/activity-os-r4-d7-time-correction.e2e-spec.ts',
  'test/e2e/activity-batch4-allocation-runtime.e2e-spec.ts',
  'test/e2e/activity-os-r3-c3-1-candidate.e2e-spec.ts',
  'test/e2e/attendances.e2e-spec.ts',
  'test/e2e/activity-registrations-state-transition.e2e-spec.ts',
  'test/e2e/activity-v11-batch4-allocation-command-replay-migration.e2e-spec.ts',
  'test/e2e/activity-os-r4-d6-time-ledger.e2e-spec.ts',
  'test/e2e/team-join.e2e-spec.ts',
  'test/e2e/activity-batch3-3-lifecycle-and-member-read.e2e-spec.ts',
  'test/e2e/activity-settlement-correction.e2e-spec.ts',
  'test/e2e/activity-settlement-draft-batch.e2e-spec.ts',
  'test/e2e/activity-v11-slice2-schema-constraints.e2e-spec.ts',
  'test/e2e/activity-os-r4-d4-time-bucket-settlement.e2e-spec.ts',
  'test/e2e/activity-v11-slice4-schema-constraints.e2e-spec.ts',
  'test/e2e/activity-os-r5-e4-contribution-settlement.e2e-spec.ts',
  'test/e2e/activity-ledger-posting.e2e-spec.ts',
  'test/e2e/activity-settlement-closure.e2e-spec.ts',
  'test/e2e/activity-os-r5-e4-assert-source-reuse-migration.e2e-spec.ts',
  'test/e2e/activity-registration-waitlist.e2e-spec.ts',
  'test/e2e/activity-v11-slice1-schema-constraints.e2e-spec.ts',
  'test/e2e/activity-settlement-closure-concurrency.e2e-spec.ts',
  'test/e2e/recruitment-identity.e2e-spec.ts',
  'test/e2e/activity-registrations-insurance-gate.e2e-spec.ts',
  'test/e2e/activity-os-r5-e3-contribution-shadow-source-proof.e2e-spec.ts',
  'test/e2e/activity-batch4-onsite-participation.e2e-spec.ts',
  'test/e2e/activity-batch6-offline-writer.e2e-spec.ts',
  'test/e2e/activity-batch6-staff-import-offline.e2e-spec.ts',
  'test/e2e/activity-os-r4-d7-pairing-index-probe.e2e-spec.ts',
  'test/e2e/activity-registration-permanent-head-runtime.e2e-spec.ts',
  'test/e2e/activity-v11-slice5-schema-constraints.e2e-spec.ts',
  'test/e2e/activity-batch4-registration-command.e2e-spec.ts',
  'test/e2e/activity-settlement-draft.e2e-spec.ts',
  'test/e2e/activity-settlement-submit.e2e-spec.ts',
  'test/e2e/activity-registrations.e2e-spec.ts',
  'test/e2e/activity-os-r3-c1-d2b-template-catalogue.e2e-spec.ts',
  'test/e2e/activity-v11-batch4-allocation-determinism-migration.e2e-spec.ts',
  'test/e2e/activity-os-r5-e3-d3-signature.e2e-spec.ts',
  'test/e2e/activity-ledger-posting-scale.e2e-spec.ts',
]);
const contextSet = new Set(CONTEXT_ORDER);
const SHARDS = [
  { id: 1, name: '完整历史前序链 · 固定顺序' },
  { id: 2, name: 'R4 · R5其它 · 活动应用与批次 · v1.1' },
  { id: 3, name: 'R1–R3 · E4其它 · 结算账本出勤 · 队员' },
  { id: 4, name: '权限 · 通知 · 资产 · 平台' },
];

export const SHARD_COUNT = SHARDS.length;

const alternation = (prefixes) =>
  prefixes.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');

/** 核心链之外按完整业务族分配,不按文件哈希或即时耗时动态调度。 */
export function familyFor(spec) {
  const name = path.posix.basename(spec);
  if (!ACTIVITY_PREFIXES.some((prefix) => name.startsWith(prefix))) return 'platform';
  if (name.startsWith('activity-os-r5-e4-')) return 'r5-e4';
  if (name.startsWith('activity-os-r5-')) return 'r5-other';
  if (name.startsWith('activity-os-r4-')) return 'r4';
  if (name.startsWith('activity-os-r3-')) return 'r3';
  if (/^activity-os-r[12]-/.test(name)) return 'r1-r2';
  if (name.startsWith('activity-v11-')) return 'v11';
  if (/^activity-(batch|b7-)/.test(name)) return 'activity-batches';
  if (/^(activity-(settlement|ledger)|attendance|app-my-attendance|contribution)/.test(name))
    return 'settlement-ledger-attendance';
  if (/^(member|team|recruitment|realname|emergency)/.test(name)) return 'people';
  return 'activity-application';
}

const FAMILY_SHARDS = {
  'r5-other': 2,
  r4: 2,
  v11: 2,
  'activity-batches': 2,
  'activity-application': 2,
  'r5-e4': 3,
  r3: 3,
  'r1-r2': 3,
  'settlement-ledger-attendance': 3,
  people: 3,
  platform: 4,
};

export function shardFor(spec) {
  return contextSet.has(spec) ? 1 : FAMILY_SHARDS[familyFor(spec)];
}

/**
 * 生成传给 `jest --testPathPatterns` 的正则。
 * jest 拿它匹配**完整路径**,故以 `/test/e2e/` 定位目录,`[^/]*` 限定同级文件名。
 */
export function patternFor(shardId) {
  const shard = SHARDS.find((s) => s.id === shardId);
  if (!shard) throw new Error(`未知分片 ${shardId}(合法值 1..${SHARD_COUNT})`);
  const files = allSpecs().filter((spec) => shardFor(spec) === shardId);
  return `/(?:${alternation(files)})$`;
}

export function allSpecs() {
  const walk = (dir) =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
      const full = path.join(dir, d.name);
      return d.isDirectory() ? walk(full) : d.name.endsWith(SPEC_SUFFIX) ? [full] : [];
    });
  return walk(E2E_DIR)
    .map((f) => path.relative(REPO_ROOT, f).split(path.sep).join('/'))
    .sort();
}

/** 某片实际会收到的文件 —— **用的就是发给 jest 的那条正则**,杜绝"算的"与"跑的"分叉。 */
export function specsFor(shardId) {
  const re = new RegExp(patternFor(shardId));
  return allSpecs().filter((f) => re.test(`/${f}`));
}

/**
 * 完整性核验:每个 spec 必须恰好落进一片。
 * 这是本仓最怕的静默失效形状 —— 漏跑不会变红,只会让覆盖面悄悄缩水。
 */
export function verify() {
  const specs = allSpecs();
  const problems = [];
  if (contextSet.size !== 42 || CONTEXT_ORDER.some((spec) => !specs.includes(spec))) {
    problems.push('历史前序链必须包含 42 个互异且实际存在的套件');
  }

  const nested = specs.filter((f) => f.split('/').length !== 3); // test/e2e/<name>
  if (nested.length > 0) {
    problems.push(
      `发现 ${nested.length} 个不在 test/e2e/ 同级的 spec(前缀规则按文件名匹配,嵌套目录会让分片失准):\n` +
        nested.map((f) => `    ${f}`).join('\n') +
        `\n    处置:要么把它们放回 test/e2e/ 同级,要么改本文件的匹配规则。`,
    );
  }

  const hits = new Map(specs.map((f) => [f, []]));
  for (const shard of SHARDS) {
    for (const f of specsFor(shard.id)) hits.get(f).push(shard.id);
  }
  const orphans = [...hits].filter(([, s]) => s.length === 0).map(([f]) => f);
  const dupes = [...hits].filter(([, s]) => s.length > 1);
  if (orphans.length > 0) {
    problems.push(
      `${orphans.length} 个 spec 不属于任何一片(会被静默漏跑,且每片仍然全绿):\n` +
        orphans.map((f) => `    ${f}`).join('\n'),
    );
  }
  if (dupes.length > 0) {
    problems.push(
      `${dupes.length} 个 spec 落进多片(重复跑,浪费且掩盖顺序相关的泄漏):\n` +
        dupes.map(([f, s]) => `    ${f} → 片 ${s.join(',')}`).join('\n'),
    );
  }
  for (const shard of SHARDS) {
    if (specsFor(shard.id).length === 0) {
      problems.push(
        `片 ${shard.id}(${shard.name})一个 spec 都没匹配到 —— 空片是配置错误,不是合法状态。`,
      );
    }
  }
  return { ok: problems.length === 0, problems, total: specs.length };
}

/** 仅供核心片使用的 Jest sequencer;非核心片继续使用默认 sequencer。 */
export default class ContextSequencer {
  sort(tests) {
    const byPath = new Map();
    for (const test of tests) {
      const spec = path.relative(REPO_ROOT, test.path).split(path.sep).join('/');
      if (!contextSet.has(spec) || byPath.has(spec)) throw new Error(`核心顺序输入异常:${spec}`);
      byPath.set(spec, test);
    }
    if (byPath.size !== CONTEXT_ORDER.length) throw new Error('核心顺序缺少套件');
    return CONTEXT_ORDER.map((spec) => byPath.get(spec));
  }

  // 固定顺序不读取或更新 Jest 性能缓存;此类只在核心片显式选择。
  cacheResults() {}
}

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const valueOf = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

if (
  process.argv[1] &&
  fs.existsSync(process.argv[1]) &&
  fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))
) {
  if (flag('shards')) {
    process.stdout.write(`${SHARD_COUNT}\n`);
  } else if (flag('verify')) {
    const { ok, problems, total } = verify();
    for (const shard of SHARDS) {
      process.stdout.write(`片 ${shard.id} ${shard.name}:${specsFor(shard.id).length} 个 spec\n`);
    }
    process.stdout.write(`合计 ${total} 个 spec / ${SHARD_COUNT} 片\n`);
    if (!ok) {
      process.stderr.write(`\n✗ 分片清单不完整:\n${problems.map((p) => `  - ${p}`).join('\n')}\n`);
      process.exit(1);
    }
    process.stdout.write('✓ 每个 spec 恰好落进一片\n');
  } else {
    const shardId = Number(valueOf('shard'));
    if (!Number.isInteger(shardId)) {
      process.stderr.write('用法:--shard <N> [--pattern|--count|--list] | --verify | --shards\n');
      process.exit(2);
    }
    if (flag('pattern')) process.stdout.write(`${patternFor(shardId)}\n`);
    else if (flag('count')) process.stdout.write(`${specsFor(shardId).length}\n`);
    else if (flag('list')) process.stdout.write(`${specsFor(shardId).join('\n')}\n`);
    else {
      const shard = SHARDS.find((s) => s.id === shardId);
      process.stdout.write(
        `片 ${shardId} ${shard?.name ?? ''}:${specsFor(shardId).length} 个 spec\n`,
      );
    }
  }
}
