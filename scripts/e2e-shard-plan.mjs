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
 * 分片数为什么是 2(不是 3、4):
 *   activity 族单族就约 29 分钟,是**不可再分的地板** —— 切到 4 片一秒都省不下来,
 *   3 片相对 2 片也只买到约 10 分钟墙钟。片数是与检出能力的直接权衡(片越多,
 *   每个进程能观察到的累积状态越少),所以取"够用就好"的最小值:2。
 *
 * ⚠️ 本文件与 workflow 的分工:
 *   本文件只**算**清单(纯函数,无副作用),workflow 负责**核**清单 ——
 *   每片断言 jest 实际收到的 suite 数等于这里的预算数,两片之和等于磁盘上的文件数。
 *   少了这一核,新增 spec 落不进任何一片时会**每片都绿 = 静默漏跑**,与漏跑等价。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const E2E_DIR = path.join(REPO_ROOT, 'test', 'e2e');
const SPEC_SUFFIX = '.e2e-spec.ts';

/**
 * 片 1 的**文件名前缀**清单(按域归族)。片 2 是 catch-all:凡不匹配这里的一律归它,
 * 所以**新增 spec 不可能落空** —— 最坏是落进片 2,而不是谁都不跑。
 *
 * 前缀取"词干"以覆盖单复数:`activit` 同时覆盖 activity* 与 activities*,
 * `member` 覆盖 member* / members* / memberships*,`attendance` 覆盖 attendance(s)*。
 * `app-` 面只把活动/出勤/报名那几支划进来,其余 app-me-* / app-my-certificates 等留在片 2。
 */
const SHARD_1_PREFIXES = [
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

const SHARDS = [
  { id: 1, name: '活动 · 出勤 · 队员', prefixes: SHARD_1_PREFIXES },
  { id: 2, name: '权限 · 通知 · 资产 · 平台', catchAll: true },
];

export const SHARD_COUNT = SHARDS.length;

const alternation = (prefixes) => prefixes.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');

/**
 * 生成传给 `jest --testPathPatterns` 的正则。
 * jest 拿它匹配**完整路径**,故以 `/test/e2e/` 定位目录,`[^/]*` 限定同级文件名。
 */
export function patternFor(shardId) {
  const shard = SHARDS.find((s) => s.id === shardId);
  if (!shard) throw new Error(`未知分片 ${shardId}(合法值 1..${SHARD_COUNT})`);
  const alt = alternation(SHARD_1_PREFIXES);
  // catch-all 用否定前瞻表达"不属于其它任何片",与片 1 的正则**同源** ——
  // 两边各写一份清单迟早分叉,那就会出现"两片都不要"或"两片都跑"的文件。
  const body = shard.catchAll ? `(?!(?:${alt}))` : `(?=(?:${alt}))`;
  return `/test/e2e/${body}[^/]*\\.e2e-spec\\.ts$`;
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
      problems.push(`片 ${shard.id}(${shard.name})一个 spec 都没匹配到 —— 空片是配置错误,不是合法状态。`);
    }
  }
  return { ok: problems.length === 0, problems, total: specs.length };
}

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const valueOf = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
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
      process.stdout.write(`片 ${shardId} ${shard?.name ?? ''}:${specsFor(shardId).length} 个 spec\n`);
    }
  }
}
