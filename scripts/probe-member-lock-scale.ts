/**
 * 10000 member lock 短事务可行性原型(活动业务改造 v1.1 第 0 批;合同 §5.13 / §10.6 / §14)。
 *
 * 立项理由:合同 §14 第 0 批最后一项写死「10000 member lock 短事务可行性原型,未通过前不定
 * 最终 schema 细节」—— 它是第 1 批 schema lane 的前置硬门。§5.13 同时钉死:万人统一生效必须
 * 在**现有** 7 秒事务预算内完成,**不允许把 timeout 调大来掩盖**。本脚本只做两件事:
 * **测量**与**如实记录**。它不改任何预算常量、不改 lockMembersForWrite 本体、不建新锁域。
 *
 * 为什么是脚本而不是 spec:读数与机器规格强相关,挂进 jest 会给 CI 引入性能相关的假红
 * (本仓已有「本机连跑榨干 → 假红」的事故在案)。故它是**手动、可重复**的探针,
 * 不进 CI、不进默认 jest。
 *
 * 跑法(**不改 package.json** —— 它在红区 ci-control-plane 内,加 npm script 需令牌):
 *   pnpm exec tsx scripts/probe-member-lock-scale.ts
 *   PROBE_ROUNDS=20 pnpm exec tsx scripts/probe-member-lock-scale.ts   # 轮数可调(默认 60)
 *
 * ──────────────────────────────────────────────────────────────────────────
 * 仪器纪律(本仓已记录的教训:**仪器撒谎时读数恰好印证预期**)。因此本脚本在报数之前
 * 先自证,任何一条不成立就应当先修仪器:
 *   ① 库名护栏有**反向自证**:故意喂非测试库名必须被拒(否则护栏是摆设)。
 *   ② advisory 锁**真的取到了**:pg_locks 里数得出来,且不在集合内的键确实是空闲的。
 *   ③ 行锁**真的加上了**:另一条连接对集合内的行 FOR UPDATE NOWAIT 必须失败、
 *      对集合外的行必须成功。这条专门守「`SELECT 'lit' FROM t … FOR SHARE` 静默不加锁」
 *      那个已经踩过的坑 —— 写得像加锁不等于加了锁。
 *   ④ 空载基线:同样的事务框架、零 lock、零行锁,必须显著低于有载读数。
 *   ⑤ 反向读数:把 10000 拆成 2 段 5000 顺序取锁,并与独立跑的 5000 档互相对照。
 * ──────────────────────────────────────────────────────────────────────────
 *
 * 安全边界:
 *   - 只连 app_test* 派生测试库(护栏见 assertProbeTargetDatabase),不匹配立即非零退出。
 *   - 只 CREATE / DROP **自己的**随机后缀表(probe_*_<sfx>),用完必删(finally + 信号处理)。
 *     刻意不用 TEMP 表:temp 表绕过 WAL,会**低估**真实行锁与提交成本。
 *   - 不 TRUNCATE、不碰任何业务表、不跑 migration。
 */

import * as os from 'os';

import { Prisma, PrismaClient } from '@prisma/client';

import { loadTestEnv } from '../test/setup/load-env';
import { deriveTestDbName } from '../test/setup/worktree-db';
import {
  MEMBER_LOCK_WAIT_BUDGET_MS,
  MEMBER_TX_TIMEOUT_MS,
  MEMBER_TX_WORK_BUDGET_MS,
  lockMembersForWrite,
  runMemberLinearizedTransaction,
} from '../src/common/prisma/member-advisory-lock.util';

// ─────────────────────────────────────────────────────────────────────────────
// 配置
// ─────────────────────────────────────────────────────────────────────────────

/** 四档规模(合同 §13.7 固定 fixture:30 / 500 / 2000 / 10000)。 */
const SCALES = [30, 500, 2000, 10000] as const;
/** 反向读数的对照档(2×5000 拆分要和它对拍)。 */
const SPLIT_HALF = 5000;
/** 每档轮数;DoD 要求 ≥ 20。 */
const ROUNDS = Number(process.env.PROBE_ROUNDS ?? 60);
/** 丢弃的预热轮(连接预热 / 计划缓存);不计入统计。 */
const WARMUP_ROUNDS = 3;
/** 全库 fixture 人数 = 最大档位。 */
const POPULATION = 10000;
/** day-state 的账期日(远未来,遵守本仓 near-future-date 防炸弹规则)。 */
const LEDGER_DATE = '2099-06-15';
/** PostgreSQL 扩展查询协议 Bind 消息的参数个数上限(int16)。 */
const PG_BIND_PARAM_LIMIT = 65535;

// ─────────────────────────────────────────────────────────────────────────────
// 计时与统计
// ─────────────────────────────────────────────────────────────────────────────

function nowMs(): number {
  return Number(process.hrtime.bigint()) / 1e6;
}

/**
 * 最近秩(nearest-rank)百分位。**不做插值** —— 样本量只有几十时插值是假精度。
 * n=57 时 P99 落在第 57 个样本,即观测最大值;报告里必须照此口径读。
 */
function percentile(samples: readonly number[], p: number): number {
  if (samples.length === 0) return Number.NaN;
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

function median(samples: readonly number[]): number {
  return percentile(samples, 50);
}

function fmt(ms: number): string {
  if (Number.isNaN(ms)) return 'n/a';
  return ms.toFixed(1);
}

/**
 * 错误摘要。**必须 trim 后再取首行** —— Prisma 的 raw 错误信息以 `\n` 开头,
 * 直接 `split('\n')[0]` 会得到空串,于是「失败 6/6」旁边什么都不写,
 * 看上去像没出错。仪器自己把证据吞掉,是这次实测当场抓到的第一个 bug。
 */
function briefError(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return (
    text
      .trim()
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .join(' ⏎ ')
      .slice(0, 240) || '(空错误信息)'
  );
}

interface Stats {
  n: number;
  p50: number;
  p95: number;
  p99: number;
  min: number;
  max: number;
  /** 前半 / 后半中位数 —— 用来看有没有系统性漂移(表膨胀等)。 */
  firstHalfP50: number;
  secondHalfP50: number;
}

function stats(samples: readonly number[]): Stats {
  const half = Math.floor(samples.length / 2);
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    n: samples.length,
    p50: percentile(samples, 50),
    p95: percentile(samples, 95),
    p99: percentile(samples, 99),
    min: sorted[0] ?? Number.NaN,
    max: sorted[sorted.length - 1] ?? Number.NaN,
    firstHalfP50: median(samples.slice(0, half)),
    secondHalfP50: median(samples.slice(half)),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// ① 库名护栏(带反向自证)
// ─────────────────────────────────────────────────────────────────────────────

/** 允许连接的主机 —— 与 test/setup/test-db.ts 同口径,只允许本机 / 本机容器网络。 */
const ALLOWED_DB_HOSTS: readonly string[] = [
  'localhost',
  '127.0.0.1',
  '::1',
  'postgres',
  'db',
  'u-nest-api-postgres',
  'host.docker.internal',
];

export class ProbeGuardError extends Error {}

/**
 * 探针的目标库护栏(fail-closed,三段全过才放行):
 *   1. 能解析成 postgresql:// URL,且 host 在允许清单内(逐字相等,不是子串);
 *   2. 库名以 'app_test' 开头(DoD 明写的 app_test* 判据);
 *   3. 库名**逐字等于** deriveTestDbName() —— 与 e2e 护栏共用同一个真源。
 *
 * 第 3 段刻意比 DoD 更严:只做 `app_test*` 前缀匹配的话,`app_test_prod` /
 * `app_test_backup` / 别的 lane 的库全都放行 —— 那正是 test-db.ts 里已经修过一次的洞。
 * 探针虽然只建删自己的表(不 TRUNCATE),但「在别人的库里建表」同样是误伤。
 */
export function assertProbeTargetDatabase(url: string | undefined): string {
  if (!url) {
    throw new ProbeGuardError('DATABASE_URL 未设置,拒绝连接');
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ProbeGuardError('DATABASE_URL 不是合法 URL,无法判定它指向哪个库,拒绝连接');
  }

  if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') {
    throw new ProbeGuardError(`DATABASE_URL 协议必须是 postgresql:,实际 '${parsed.protocol}'`);
  }

  const host = parsed.hostname.toLowerCase();
  if (!ALLOWED_DB_HOSTS.includes(host)) {
    throw new ProbeGuardError(
      `DATABASE_URL 指向的主机 '${host}' 不在允许清单内,拒绝连接。` +
        `只允许:${ALLOWED_DB_HOSTS.join(' / ')}`,
    );
  }

  const dbName = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (!dbName.startsWith('app_test')) {
    throw new ProbeGuardError(
      `目标库名 '${dbName}' 不匹配 app_test* —— 探针只允许在测试库上建表,拒绝连接`,
    );
  }

  const expected = deriveTestDbName();
  if (dbName !== expected) {
    throw new ProbeGuardError(
      `目标库名 '${dbName}' 与本 worktree 应使用的派生库名 '${expected}' 不一致,拒绝连接` +
        `(仅前缀匹配会放行 app_test_prod / 别的 lane 的库)`,
    );
  }

  return dbName;
}

/**
 * 护栏的**反向自证**:喂一批必须被拒的 URL,任何一条被放行 ⇒ 护栏是假的 ⇒ 立即非零退出。
 * 同时喂真实 URL 验证它确实放行(否则「一律拒绝」也能骗过反向断言)。
 */
function selfCheckGuard(realUrl: string): string[] {
  const lines: string[] = [];
  const hostile: Array<[string, string | undefined]> = [
    ['生产库名 app', 'postgresql://u:p@localhost:5432/app'],
    ['app_test 前缀但不是本库', 'postgresql://u:p@localhost:5432/app_test_prod'],
    ['别的 lane 的派生库', 'postgresql://u:p@localhost:5432/app_test_other_lane_abc123'],
    ['远程主机 + 合法库名', `postgresql://u:p@db.example.com:5432/${deriveTestDbName()}`],
    ['维护库 postgres', 'postgresql://u:p@localhost:5432/postgres'],
    ['未设置', undefined],
  ];

  let allRejected = true;
  for (const [label, url] of hostile) {
    let rejected = false;
    let reason = '';
    try {
      assertProbeTargetDatabase(url);
    } catch (err) {
      rejected = err instanceof ProbeGuardError;
      reason = briefError(err);
    }
    if (!rejected) allRejected = false;
    lines.push(`| ${label} | ${rejected ? '✅ 拒绝' : '❌ **放行(护栏失效)**'} | ${reason} |`);
  }

  let acceptedReal = false;
  let detail = '';
  try {
    detail = assertProbeTargetDatabase(realUrl);
    acceptedReal = true;
  } catch (err) {
    detail = briefError(err);
  }
  lines.push(`| 真实目标库 | ${acceptedReal ? '✅ 放行' : '❌ **误拒**'} | ${detail} |`);

  if (!allRejected || !acceptedReal) {
    console.error('\n❌ 库名护栏自证失败 —— 读数不算数,先修仪器。');
    lines.forEach((l) => console.error(l));
    process.exit(1);
  }
  return lines;
}

// ─────────────────────────────────────────────────────────────────────────────
// fixture:自有随机后缀真实表
// ─────────────────────────────────────────────────────────────────────────────

interface Fixture {
  suffix: string;
  dayState: string;
  resultRevision: string;
  batch: string;
  run: string;
  reviewAction: string;
  audit: string;
  outbox: string;
  memberIds: string[];
}

const SAFE_IDENT = /^[a-z0-9_]+$/;

function ident(name: string): Prisma.Sql {
  if (!SAFE_IDENT.test(name)) throw new Error(`非法标识符 '${name}'`);
  return Prisma.raw(name);
}

function makeSuffix(): string {
  // 随机后缀:避免与别的 lane / 并行会话撞表名
  return (
    Math.random().toString(36).slice(2, 8).padEnd(6, 'x') + Date.now().toString(36).slice(-4)
  ).toLowerCase();
}

/** 生成 cuid 形状的合成 memberId(长度与真实 Member.id 的 cuid 一致:25 字符)。 */
function makeMemberIds(count: number, suffix: string): string[] {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const body = `${suffix}${i.toString(36).padStart(10, '0')}`.padEnd(24, '0').slice(0, 24);
    ids.push(`c${body}`);
  }
  return ids;
}

async function createFixture(prisma: PrismaClient): Promise<Fixture> {
  const suffix = makeSuffix();
  const fx: Fixture = {
    suffix,
    dayState: `probe_day_state_${suffix}`,
    resultRevision: `probe_result_revision_${suffix}`,
    batch: `probe_batch_${suffix}`,
    run: `probe_run_${suffix}`,
    reviewAction: `probe_review_action_${suffix}`,
    audit: `probe_audit_${suffix}`,
    outbox: `probe_outbox_${suffix}`,
    memberIds: makeMemberIds(POPULATION, suffix),
  };

  // 形状对齐合同 §5.13 第 4/7 步要触碰的对象:day-state(member+date,带 version 做 CAS)、
  // result revision(每人一条)、batch / run(单例)、review / audit / outbox(单例写)。
  await prisma.$executeRaw`
    CREATE TABLE ${ident(fx.dayState)} (
      member_id          text        NOT NULL,
      ledger_date        date        NOT NULL,
      version            integer     NOT NULL DEFAULT 1,
      recognized_minutes integer     NOT NULL DEFAULT 0,
      credited_value     integer     NOT NULL DEFAULT 0,
      updated_at         timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (member_id, ledger_date)
    )`;
  await prisma.$executeRaw`
    CREATE TABLE ${ident(fx.resultRevision)} (
      id        text    PRIMARY KEY,
      member_id text    NOT NULL,
      status    text    NOT NULL,
      version   integer NOT NULL DEFAULT 1
    )`;
  await prisma.$executeRaw`CREATE INDEX ON ${ident(fx.resultRevision)} (member_id)`;
  await prisma.$executeRaw`
    CREATE TABLE ${ident(fx.batch)} (
      id text PRIMARY KEY, status text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
    )`;
  await prisma.$executeRaw`
    CREATE TABLE ${ident(fx.run)} (
      id text PRIMARY KEY, status text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
    )`;
  await prisma.$executeRaw`
    CREATE TABLE ${ident(fx.reviewAction)} (
      id text PRIMARY KEY, batch_id text NOT NULL, action text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )`;
  await prisma.$executeRaw`
    CREATE TABLE ${ident(fx.audit)} (
      id text PRIMARY KEY, batch_id text NOT NULL, payload jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )`;
  await prisma.$executeRaw`
    CREATE TABLE ${ident(fx.outbox)} (
      id text PRIMARY KEY, batch_id text NOT NULL, event_key text NOT NULL UNIQUE,
      payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
    )`;

  const values = Prisma.join(fx.memberIds.map((id) => Prisma.sql`(${id}, ${LEDGER_DATE}::date)`));
  await prisma.$executeRaw`
    INSERT INTO ${ident(fx.dayState)} (member_id, ledger_date)
    SELECT v.member_id, v.ledger_date FROM (VALUES ${values}) AS v(member_id, ledger_date)`;
  await prisma.$executeRaw`
    INSERT INTO ${ident(fx.resultRevision)} (id, member_id, status)
    SELECT 'rr_' || member_id, member_id, 'PREPARING' FROM ${ident(fx.dayState)}`;
  await prisma.$executeRaw`INSERT INTO ${ident(fx.batch)} (id, status) VALUES ('batch_1', 'READY')`;
  await prisma.$executeRaw`INSERT INTO ${ident(fx.run)} (id, status) VALUES ('run_1', 'REVIEWED')`;

  await prisma.$executeRawUnsafe(`ANALYZE ${fx.dayState}`);
  await prisma.$executeRawUnsafe(`ANALYZE ${fx.resultRevision}`);
  return fx;
}

async function dropFixture(prisma: PrismaClient, fx: Fixture | null): Promise<void> {
  if (!fx) return;
  for (const t of [
    fx.outbox,
    fx.audit,
    fx.reviewAction,
    fx.run,
    fx.batch,
    fx.resultRevision,
    fx.dayState,
  ]) {
    try {
      await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS ${t}`);
    } catch (err) {
      console.error(`⚠️ 清理 ${t} 失败:${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 一轮 commit 事务的三段计时
// ─────────────────────────────────────────────────────────────────────────────

interface RoundTiming {
  advisoryMs: number;
  dayStateMs: number;
  finalWriteMs: number;
  totalTxMs: number;
}

/** 段 2:按 (member_id, ledger_date) 排序取行锁,并与 preparing 阶段的 baseline version 比对。 */
function dayStateLockSql(fx: Fixture, memberIds: readonly string[]): Prisma.Sql {
  const pairs = memberIds.map((id) => Prisma.sql`(${id}::text, ${LEDGER_DATE}::date)`);
  return Prisma.sql`
    SELECT d.member_id, d.version
    FROM ${ident(fx.dayState)} d
    JOIN (VALUES ${Prisma.join(pairs)}) AS t(member_id, ledger_date)
      ON d.member_id = t.member_id AND d.ledger_date = t.ledger_date
    ORDER BY d.member_id, d.ledger_date
    FOR UPDATE OF d`;
}

/**
 * 全局写序号。**不能拿轮号当主键** —— 轮号在每个档位都从 0 重新开始,
 * 于是 500 档第 0 轮会去插 30 档第 0 轮已经插过的 `ra_0`,当场 unique 违例、
 * 整档 60 轮全灭。第一次冒烟就是这么红的,记在这里免得再犯。
 */
let writeSeq = 0;

/** 段 3:终写 —— 语句条数固定为 7,**不随人数增长**(本仓批量化的真判据是 SQL 次数)。 */
async function finalWrites(
  tx: Prisma.TransactionClient,
  fx: Fixture,
  memberIds: readonly string[],
  round: number,
): Promise<void> {
  const seq = ++writeSeq;
  const rows = Prisma.join(
    memberIds.map((id) => Prisma.sql`(${id}::text, ${LEDGER_DATE}::date, ${round}::integer)`),
  );
  // ① day-state 版本递增 + 合计更新
  await tx.$executeRaw`
    UPDATE ${ident(fx.dayState)} d
    SET version = d.version + 1, credited_value = t.val, updated_at = now()
    FROM (VALUES ${rows}) AS t(member_id, ledger_date, val)
    WHERE d.member_id = t.member_id AND d.ledger_date = t.ledger_date`;
  // ② result revisions → committed
  const ids = Prisma.join(memberIds.map((id) => Prisma.sql`${id}`));
  await tx.$executeRaw`
    UPDATE ${ident(fx.resultRevision)}
    SET status = 'COMMITTED', version = version + 1
    WHERE member_id IN (${ids})`;
  // ③ batch → committed  ④ run → posted
  await tx.$executeRaw`UPDATE ${ident(fx.batch)} SET status = 'COMMITTED', updated_at = now() WHERE id = 'batch_1'`;
  await tx.$executeRaw`UPDATE ${ident(fx.run)} SET status = 'POSTED', updated_at = now() WHERE id = 'run_1'`;
  // ⑤ ReviewAction  ⑥ Audit  ⑦ NotificationOutbox
  await tx.$executeRaw`
    INSERT INTO ${ident(fx.reviewAction)} (id, batch_id, action)
    VALUES (${`ra_${seq}`}, 'batch_1', 'COMMIT_BATCH')`;
  await tx.$executeRaw`
    INSERT INTO ${ident(fx.audit)} (id, batch_id, payload)
    VALUES (${`au_${seq}`}, 'batch_1', ${{ members: memberIds.length }})`;
  await tx.$executeRaw`
    INSERT INTO ${ident(fx.outbox)} (id, batch_id, event_key, payload)
    VALUES (${`ob_${seq}`}, 'batch_1', ${`ledger.committed:batch_1:${seq}`}, ${{
      members: memberIds.length,
    }})`;
}

/**
 * 跑一轮完整的「万人统一生效」短事务。
 * lockSplit > 0 时把 advisory 取锁拆成多段顺序取(反向读数用);否则一次取全部。
 */
async function runCommitRound(
  prisma: PrismaClient,
  fx: Fixture,
  memberIds: readonly string[],
  baseline: Map<string, number>,
  round: number,
  lockSplit = 0,
): Promise<RoundTiming> {
  const txStart = nowMs();
  const timing = await runMemberLinearizedTransaction(prisma, async (tx) => {
    // ── 段 1:member advisory lock ────────────────────────────────────────
    const t0 = nowMs();
    if (lockSplit > 0) {
      for (let i = 0; i < memberIds.length; i += lockSplit) {
        await lockMembersForWrite(tx, memberIds.slice(i, i + lockSplit));
      }
    } else {
      await lockMembersForWrite(tx, memberIds);
    }
    const t1 = nowMs();

    // ── 段 2:day-state 行锁 + baseline 比对 ──────────────────────────────
    const locked = await tx.$queryRaw<Array<{ member_id: string; version: number }>>(
      dayStateLockSql(fx, memberIds),
    );
    if (locked.length !== memberIds.length) {
      throw new Error(`day-state 行数不符:期望 ${memberIds.length},实得 ${locked.length}`);
    }
    // 比对必须是**真比对**:baseline 不符就抛,否则这一段等于空跑一条 SELECT
    for (const row of locked) {
      const expected = baseline.get(row.member_id);
      if (expected === undefined || Number(row.version) !== expected) {
        throw new Error(
          `day-state version 与 baseline 不符:${row.member_id} 期望 ${String(expected)},实得 ${String(row.version)}`,
        );
      }
    }
    const t2 = nowMs();

    // ── 段 3:终写 ────────────────────────────────────────────────────────
    await finalWrites(tx, fx, memberIds, round);
    const t3 = nowMs();

    return { advisoryMs: t1 - t0, dayStateMs: t2 - t1, finalWriteMs: t3 - t2 };
  });
  const totalTxMs = nowMs() - txStart;

  for (const id of memberIds) baseline.set(id, (baseline.get(id) ?? 0) + 1);
  return { ...timing, totalTxMs };
}

// ─────────────────────────────────────────────────────────────────────────────
// ②③ 锁生效自证
// ─────────────────────────────────────────────────────────────────────────────

interface InstrumentProof {
  advisoryHeld: number;
  advisoryExpected: number;
  advisoryOutsideKeyFree: boolean;
  rowLockInsideBlocked: boolean;
  rowLockOutsideFree: boolean;
  lockRowsPlan: string;
}

/**
 * 在一条**持锁中**的事务里,用第二条连接反着验:
 *   - advisory:pg_locks 里 advisory 条数 == 集合内不同 hashtext 键数;集合外的键仍可取。
 *   - 行锁:集合内的行 FOR UPDATE NOWAIT 必须失败;集合外的行必须成功。
 * 两侧都验才算数 —— 只验「里面锁住了」的话,一个恒失败的探针也能报绿。
 */
async function proveLocksActuallyTaken(
  prisma: PrismaClient,
  observer: PrismaClient,
  fx: Fixture,
): Promise<InstrumentProof> {
  const inside = fx.memberIds.slice(0, 200);
  const outside = fx.memberIds[POPULATION - 1];

  const expectedKeys = await observer.$queryRaw<Array<{ n: bigint }>>(
    Prisma.sql`SELECT count(DISTINCT hashtext(v.id)) AS n
               FROM (VALUES ${Prisma.join(inside.map((id) => Prisma.sql`(${id})`))}) AS v(id)`,
  );
  const advisoryExpected = Number(expectedKeys[0]?.n ?? 0);

  const plan = await observer.$queryRawUnsafe<Array<Record<string, string>>>(
    `EXPLAIN SELECT d.member_id FROM ${fx.dayState} d ORDER BY d.member_id, d.ledger_date FOR UPDATE OF d`,
  );
  const planText = plan.map((r) => Object.values(r).join('')).join(' / ');

  const proof: InstrumentProof = {
    advisoryHeld: 0,
    advisoryExpected,
    advisoryOutsideKeyFree: false,
    rowLockInsideBlocked: false,
    rowLockOutsideFree: false,
    lockRowsPlan: planText,
  };

  await runMemberLinearizedTransaction(prisma, async (tx) => {
    await lockMembersForWrite(tx, inside);
    await tx.$queryRaw(dayStateLockSql(fx, inside));

    const held = await observer.$queryRaw<Array<{ n: bigint }>>(
      Prisma.sql`SELECT count(*) AS n FROM pg_locks WHERE locktype = 'advisory'`,
    );
    proof.advisoryHeld = Number(held[0]?.n ?? 0);

    // advisory 反向:不在集合内的键必须仍可立即取到
    try {
      await observer.$transaction(async (o) => {
        await o.$executeRawUnsafe('SET LOCAL lock_timeout = 500');
        await o.$queryRaw(
          Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${outside}))::text AS locked`,
        );
      });
      proof.advisoryOutsideKeyFree = true;
    } catch {
      proof.advisoryOutsideKeyFree = false;
    }

    // 行锁正向:集合内的行 NOWAIT 必须失败
    try {
      await observer.$transaction(async (o) => {
        await o.$queryRawUnsafe(
          `SELECT version FROM ${fx.dayState} WHERE member_id = $1 FOR UPDATE NOWAIT`,
          inside[0],
        );
      });
      proof.rowLockInsideBlocked = false; // 竟然拿到了 ⇒ 行锁没加上
    } catch {
      proof.rowLockInsideBlocked = true;
    }

    // 行锁反向:集合外的行 NOWAIT 必须成功
    try {
      await observer.$transaction(async (o) => {
        await o.$queryRawUnsafe(
          `SELECT version FROM ${fx.dayState} WHERE member_id = $1 FOR UPDATE NOWAIT`,
          outside,
        );
      });
      proof.rowLockOutsideFree = true;
    } catch {
      proof.rowLockOutsideFree = false;
    }
  });

  return proof;
}

// ─────────────────────────────────────────────────────────────────────────────
// hashtext 碰撞
// ─────────────────────────────────────────────────────────────────────────────

interface CollisionResult {
  setsTotal: number;
  setsWithCollision: number;
  totalExcess: number;
  observedRatePct: number;
  theoreticalRatePct: number;
  actualSetExcess: number;
}

/**
 * 蒙特卡洛:R 组各 N 个 id,统计「同一组内出现 hashtext 碰撞」的组数。
 * 理论:期望碰撞对数 λ = C(N,2)/2^32;P(≥1 对) ≈ 1 − e^(−λ)。
 */
async function measureHashtextCollisions(
  prisma: PrismaClient,
  fx: Fixture,
  sets: number,
  size: number,
): Promise<CollisionResult> {
  const rows = await prisma.$queryRawUnsafe<
    Array<{ sets_total: bigint; sets_with_collision: bigint; total_excess: bigint }>
  >(
    `WITH s AS (
       SELECT g AS set_no, 'c' || substr(md5(g::text || ':' || i::text), 1, 24) AS member_id
       FROM generate_series(1, $1) g CROSS JOIN generate_series(1, $2) i
     ), agg AS (
       SELECT set_no,
              count(DISTINCT member_id)           AS distinct_ids,
              count(DISTINCT hashtext(member_id)) AS distinct_keys
       FROM s GROUP BY set_no
     )
     SELECT count(*)::bigint AS sets_total,
            sum(CASE WHEN distinct_ids > distinct_keys THEN 1 ELSE 0 END)::bigint AS sets_with_collision,
            sum(distinct_ids - distinct_keys)::bigint AS total_excess
     FROM agg`,
    sets,
    size,
  );

  const r = rows[0];
  const actual = await prisma.$queryRaw<Array<{ excess: bigint }>>(
    Prisma.sql`SELECT (count(DISTINCT v.id) - count(DISTINCT hashtext(v.id)))::bigint AS excess
               FROM (VALUES ${Prisma.join(fx.memberIds.map((id) => Prisma.sql`(${id})`))}) AS v(id)`,
  );

  const lambda = (size * (size - 1)) / 2 / 2 ** 32;
  const total = Number(r?.sets_total ?? 0);
  const withColl = Number(r?.sets_with_collision ?? 0);
  return {
    setsTotal: total,
    setsWithCollision: withColl,
    totalExcess: Number(r?.total_excess ?? 0),
    observedRatePct: total > 0 ? (withColl / total) * 100 : Number.NaN,
    theoreticalRatePct: (1 - Math.exp(-lambda)) * 100,
    actualSetExcess: Number(actual[0]?.excess ?? 0),
  };
}

interface CollisionConsequence {
  pair: { a: string; b: string; key: number } | null;
  middle: string | null;
  mechanismDeadlock: boolean;
  mechanismDetail: string;
  naturalAttempts: number;
  naturalDeadlocks: number;
}

function isDeadlock(err: unknown): boolean {
  const meta = (err as { meta?: { code?: unknown } } | null)?.meta;
  if (meta && String(meta.code) === '40P01') return true;
  const text = err instanceof Error ? err.message : String(err);
  return text.includes('40P01') || text.includes('deadlock detected');
}

/**
 * 碰撞的**后果**实测。
 *
 * 结构上的问题:`lockMembersForWrite` 用 `ORDER BY member_id` 固定取锁顺序,但真正的锁键是
 * `hashtext(member_id)`。排序键与锁键不是同一个东西 —— 一旦出现 hashtext 碰撞
 * (a ≠ b 但 key(a) == key(b)),再有第三个 c 满足 a < c < b,那么
 *   批次甲 {a, c} 的取锁序 = key(a), key(c)
 *   批次乙 {c, b} 的取锁序 = key(c), key(b) == key(a)
 * 两者**反序**,构成死锁边。本函数先证机制(显式交错),再看自然并发下的窗口有多窄。
 */
async function measureCollisionConsequence(
  p1: PrismaClient,
  p2: PrismaClient,
  searchClient: PrismaClient,
): Promise<CollisionConsequence> {
  const found = await searchClient.$queryRawUnsafe<Array<{ k: number; a: string; b: string }>>(
    `WITH ids AS (
       SELECT 'c' || substr(md5(g::text), 1, 24) AS member_id FROM generate_series(1, 400000) g
     ), h AS (SELECT member_id, hashtext(member_id) AS k FROM ids)
     SELECT k, min(member_id) AS a, max(member_id) AS b
     FROM h GROUP BY k HAVING count(*) = 2 ORDER BY k LIMIT 1`,
  );

  const out: CollisionConsequence = {
    pair: null,
    middle: null,
    mechanismDeadlock: false,
    mechanismDetail: '',
    naturalAttempts: 0,
    naturalDeadlocks: 0,
  };
  const hit = found[0];
  if (!hit) {
    out.mechanismDetail = '未在 400k 合成 id 中找到 hashtext 碰撞对,跳过后果实验';
    return out;
  }
  out.pair = { a: hit.a, b: hit.b, key: hit.k };

  // 构造严格位于 a 与 b 之间的第三个 id。顺序**由库的 collation 判定**,
  // 不靠 JS 的 UTF-16 序推断 —— 真正决定取锁顺序的是 SQL 的 ORDER BY。
  const mid = `${hit.a}~`;
  const ordered = await searchClient.$queryRaw<Array<{ ok: boolean; midkey: number }>>(
    Prisma.sql`SELECT (${hit.a} < ${mid} AND ${mid} < ${hit.b}) AS ok, hashtext(${mid}) AS midkey`,
  );
  if (!ordered[0]?.ok || ordered[0].midkey === hit.k) {
    out.mechanismDetail = `构造中间 id 失败(ordered=${String(ordered[0]?.ok)})`;
    return out;
  }
  out.middle = mid;

  // ── 机制证明:显式交错 ────────────────────────────────────────────────
  let releaseA = (): void => {};
  let releaseB = (): void => {};
  const heldA = new Promise<void>((r) => {
    releaseA = r;
  });
  const heldB = new Promise<void>((r) => {
    releaseB = r;
  });
  const errors: unknown[] = [];

  const tx1 = runMemberLinearizedTransaction(p1, async (tx) => {
    await lockMembersForWrite(tx, [hit.a]); // 持 key(a)
    releaseA();
    await heldB;
    await lockMembersForWrite(tx, [hit.a, mid]); // 序:a → mid,等 key(mid)
  }).catch((e: unknown) => {
    errors.push(e);
  });

  const tx2 = runMemberLinearizedTransaction(p2, async (tx) => {
    await heldA;
    await lockMembersForWrite(tx, [mid]); // 持 key(mid)
    releaseB();
    await lockMembersForWrite(tx, [mid, hit.b]); // 序:mid → b,等 key(b) == key(a)
  }).catch((e: unknown) => {
    errors.push(e);
  });

  await Promise.all([tx1, tx2]);
  out.mechanismDeadlock = errors.some(isDeadlock);
  out.mechanismDetail = errors.length
    ? errors
        .map((e) => briefError(e))
        .join(' | ')
        .slice(0, 400)
    : '两个事务都成功(未触发)';

  // ── 自然并发:各自一条语句,看窗口有多窄 ────────────────────────────
  const ATTEMPTS = 60;
  for (let i = 0; i < ATTEMPTS; i++) {
    const errs: unknown[] = [];
    await Promise.all([
      runMemberLinearizedTransaction(p1, (tx) => lockMembersForWrite(tx, [hit.a, mid])).catch(
        (e: unknown) => {
          errs.push(e);
        },
      ),
      runMemberLinearizedTransaction(p2, (tx) => lockMembersForWrite(tx, [mid, hit.b])).catch(
        (e: unknown) => {
          errs.push(e);
        },
      ),
    ]);
    out.naturalAttempts++;
    if (errs.some(isDeadlock)) out.naturalDeadlocks++;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// 语句构建耗时 / bind 参数上限 / 共享锁表天花板
// ─────────────────────────────────────────────────────────────────────────────

interface BuildCostRow {
  scale: number;
  buildMs: number;
}

/** 复刻 lockMembersForWrite 内的构造表达式,**只测构建**(不执行),与执行耗时分开计。 */
function buildLockSqlOnly(memberIds: readonly string[]): { sql: Prisma.Sql; buildMs: number } {
  const t0 = nowMs();
  const orderedIds = [...new Set(memberIds)].sort();
  const sql = Prisma.sql`
      SELECT pg_advisory_xact_lock(hashtext(member_id))::text AS locked
      FROM (VALUES ${Prisma.join(orderedIds.map((memberId) => Prisma.sql`(${memberId})`))})
        AS member_ids(member_id)
      ORDER BY member_id
    `;
  return { sql, buildMs: nowMs() - t0 };
}

interface BindLimitResult {
  measuredMax: number;
  firstFail: number;
  failMsg: string;
  protocolLimit: number;
}

/**
 * bind 参数上限 —— **实测,不假定**。
 *
 * 第一次冒烟就打脸了:PostgreSQL 协议的 Bind 消息用无符号 int16,上限 65535,
 * 但真正先撞上的是 **Prisma 查询引擎自己的 32767**(有符号 i16):
 *   `too many bind variables in prepared statement, expected maximum of 32767`
 * 差一倍。写死 65535 去算「还能撑多少人」会把余量算成两倍,
 * 所以这里二分实测,后面的每档人数上限一律由实测值推导。
 */
async function probeBindParamLimit(prisma: PrismaClient): Promise<BindLimitResult> {
  const tryN = async (n: number): Promise<string | null> => {
    const frags: Prisma.Sql[] = [];
    for (let i = 0; i < n; i++) frags.push(Prisma.sql`(${i})`);
    try {
      await prisma.$queryRaw(
        Prisma.sql`SELECT count(*)::int AS n FROM (VALUES ${Prisma.join(frags)}) AS v(x)`,
      );
      return null;
    } catch (err) {
      return briefError(err);
    }
  };

  let lo = 1;
  let hi = PG_BIND_PARAM_LIMIT + 1;
  let failMsg = '';
  const top = await tryN(hi);
  if (top === null) {
    return { measuredMax: hi, firstFail: -1, failMsg: '(到协议上限仍未失败)', protocolLimit: PG_BIND_PARAM_LIMIT };
  }
  failMsg = top;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    const res = await tryN(mid);
    if (res === null) {
      lo = mid;
    } else {
      hi = mid;
      failMsg = res;
    }
  }
  return { measuredMax: lo, firstFail: hi, failMsg, protocolLimit: PG_BIND_PARAM_LIMIT };
}

async function probeSharedLockCeiling(
  prisma: PrismaClient,
): Promise<{ lastOk: number; firstFail: number; formulaFloor: number }> {
  const settings = await prisma.$queryRaw<Array<{ floor: number }>>(
    Prisma.sql`SELECT (current_setting('max_locks_per_transaction')::int
                     * (current_setting('max_connections')::int
                        + current_setting('max_prepared_transactions')::int))::int AS floor`,
  );
  const formulaFloor = Number(settings[0]?.floor ?? 0);

  const attempt = async (n: number): Promise<boolean> => {
    try {
      await prisma.$transaction(async (tx) => {
        await tx.$queryRawUnsafe(
          `SELECT pg_advisory_xact_lock(hashtext('probe_ceiling_' || g))::text
           FROM generate_series(1, ${n}) g`,
        );
      });
      return true;
    } catch {
      return false;
    }
  };

  let lo = 10_000;
  let hi = 64_000;
  if (!(await attempt(lo))) return { lastOk: 0, firstFail: lo, formulaFloor };
  if (await attempt(hi)) return { lastOk: hi, firstFail: -1, formulaFloor };
  let lastOk = lo;
  let firstFail = hi;
  while (hi - lo > 1000) {
    const mid = Math.round((lo + hi) / 2 / 1000) * 1000;
    if (mid <= lo || mid >= hi) break;
    if (await attempt(mid)) {
      lo = mid;
      lastOk = mid;
    } else {
      hi = mid;
      firstFail = mid;
    }
  }
  return { lastOk, firstFail, formulaFloor };
}

// ─────────────────────────────────────────────────────────────────────────────
// 输出
// ─────────────────────────────────────────────────────────────────────────────

function statsRow(label: string, s: Stats): string {
  return `| ${label} | ${s.n} | ${fmt(s.p50)} | ${fmt(s.p95)} | ${fmt(s.p99)} | ${fmt(s.min)} | ${fmt(s.max)} |`;
}

// ─────────────────────────────────────────────────────────────────────────────
// main
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  loadTestEnv();
  const url = process.env.DATABASE_URL;

  console.log('## 0. 库名护栏与反向自证\n');
  console.log('| 输入 | 结果 | 说明 |');
  console.log('| --- | --- | --- |');
  selfCheckGuard(url ?? '').forEach((l) => console.log(l));
  const dbName = assertProbeTargetDatabase(url);

  const prisma = new PrismaClient();
  const observer = new PrismaClient();
  const rival = new PrismaClient();
  let fx: Fixture | null = null;

  const cleanup = async (): Promise<void> => {
    await dropFixture(prisma, fx);
    await Promise.all([prisma.$disconnect(), observer.$disconnect(), rival.$disconnect()]);
  };
  process.on('SIGINT', () => {
    void cleanup().then(() => process.exit(130));
  });

  try {
    // ── 机器 / 库规格 ──────────────────────────────────────────────────
    const ver = await prisma.$queryRaw<Array<{ v: string }>>(Prisma.sql`SELECT version() AS v`);
    const cfg = await prisma.$queryRaw<Array<{ name: string; setting: string }>>(
      Prisma.sql`SELECT name, setting FROM pg_settings
                 WHERE name IN ('max_connections','max_locks_per_transaction','shared_buffers',
                                'work_mem','synchronous_commit','fsync','deadlock_timeout',
                                'default_transaction_isolation')
                 ORDER BY name`,
    );
    console.log('\n## 1. 机器与数据库规格\n');
    console.log('```');
    console.log(`host        : ${os.type()} ${os.release()} ${os.arch()}`);
    console.log(`cpu         : ${os.cpus()[0]?.model ?? 'unknown'} × ${os.cpus().length}`);
    console.log(`memory      : ${(os.totalmem() / 1024 ** 3).toFixed(1)} GiB`);
    console.log(`node        : ${process.version}`);
    console.log(`database    : ${dbName}`);
    console.log(`pg version  : ${ver[0]?.v ?? 'unknown'}`);
    cfg.forEach((c) => console.log(`pg ${c.name.padEnd(28)}: ${c.setting}`));
    console.log(
      `budgets     : LOCK_WAIT=${MEMBER_LOCK_WAIT_BUDGET_MS}ms  WORK=${MEMBER_TX_WORK_BUDGET_MS}ms  TX_TIMEOUT=${MEMBER_TX_TIMEOUT_MS}ms`,
    );
    console.log(`rounds      : ${ROUNDS}(前 ${WARMUP_ROUNDS} 轮预热丢弃)`);
    console.log('```');

    // ── fixture ────────────────────────────────────────────────────────
    console.log(`\n建 fixture(${POPULATION} 人 × 1 账期日)…`);
    fx = await createFixture(prisma);
    console.log(`表后缀:_${fx.suffix}`);

    // ── 锁生效自证 ─────────────────────────────────────────────────────
    const proof = await proveLocksActuallyTaken(prisma, observer, fx);
    console.log('\n## 2. 仪器自证 A —— 锁是不是真的加上了\n');
    console.log('| 判据 | 期望 | 实测 | 结论 |');
    console.log('| --- | --- | --- | --- |');
    console.log(
      `| advisory 持锁数(pg_locks) | ${proof.advisoryExpected} | ${proof.advisoryHeld} | ${proof.advisoryHeld === proof.advisoryExpected ? '✅' : '❌'} |`,
    );
    console.log(
      `| 集合**外**的 advisory 键仍空闲 | 可立即取到 | ${proof.advisoryOutsideKeyFree ? '可取到' : '取不到'} | ${proof.advisoryOutsideKeyFree ? '✅' : '❌'} |`,
    );
    console.log(
      `| 集合**内**的行 FOR UPDATE NOWAIT | 必须失败 | ${proof.rowLockInsideBlocked ? '失败' : '**成功(行锁没加上)**'} | ${proof.rowLockInsideBlocked ? '✅' : '❌'} |`,
    );
    console.log(
      `| 集合**外**的行 FOR UPDATE NOWAIT | 必须成功 | ${proof.rowLockOutsideFree ? '成功' : '失败'} | ${proof.rowLockOutsideFree ? '✅' : '❌'} |`,
    );
    console.log('\nLockRows 计划形状(证明取锁在 Sort 之上,顺序跟随 ORDER BY):');
    console.log('```');
    console.log(proof.lockRowsPlan);
    console.log('```');

    const proofOk =
      proof.advisoryHeld === proof.advisoryExpected &&
      proof.advisoryOutsideKeyFree &&
      proof.rowLockInsideBlocked &&
      proof.rowLockOutsideFree;
    if (!proofOk) {
      console.error('\n❌ 锁生效自证未全过 —— 后续读数不算数。先修仪器。');
      process.exitCode = 1;
      return;
    }

    // ── 空载基线 ───────────────────────────────────────────────────────
    const idleSamples: number[] = [];
    for (let i = 0; i < ROUNDS; i++) {
      const t = nowMs();
      await runMemberLinearizedTransaction(prisma, async (tx) => {
        await tx.$queryRaw(Prisma.sql`SELECT 1 AS x`);
      });
      if (i >= WARMUP_ROUNDS) idleSamples.push(nowMs() - t);
    }
    const idle = stats(idleSamples);

    // ── 四档 + 5000 对照档 ─────────────────────────────────────────────
    const baseline = new Map<string, number>();
    const initial = await prisma.$queryRawUnsafe<Array<{ member_id: string; version: number }>>(
      `SELECT member_id, version FROM ${fx.dayState}`,
    );
    initial.forEach((r) => baseline.set(r.member_id, Number(r.version)));

    const scaleStats = new Map<number, Record<string, Stats>>();
    const failures = new Map<number, string[]>();
    const allScales = [...new Set([...SCALES, SPLIT_HALF])].sort((a, b) => a - b);

    for (const scale of allScales) {
      const members = fx.memberIds.slice(0, scale);
      const adv: number[] = [];
      const day: number[] = [];
      const fin: number[] = [];
      const tot: number[] = [];
      const errs: string[] = [];
      process.stdout.write(`\n跑 ${scale} 档 ${ROUNDS} 轮…`);
      for (let r = 0; r < ROUNDS; r++) {
        try {
          const t = await runCommitRound(prisma, fx, members, baseline, r);
          if (r >= WARMUP_ROUNDS) {
            adv.push(t.advisoryMs);
            day.push(t.dayStateMs);
            fin.push(t.finalWriteMs);
            tot.push(t.totalTxMs);
          }
        } catch (err) {
          errs.push(briefError(err));
        }
      }
      process.stdout.write(` 完成(失败 ${errs.length} 轮)`);
      scaleStats.set(scale, {
        advisory: stats(adv),
        dayState: stats(day),
        finalWrite: stats(fin),
        total: stats(tot),
      });
      failures.set(scale, errs);
      await prisma.$executeRawUnsafe(`VACUUM (ANALYZE) ${fx.dayState}`);
      await prisma.$executeRawUnsafe(`VACUUM (ANALYZE) ${fx.resultRevision}`);
    }

    // ── 反向读数:10000 拆成 2×5000 顺序取锁 ───────────────────────────
    const splitAdv: number[] = [];
    const splitTot: number[] = [];
    const splitErrs: string[] = [];
    process.stdout.write(`\n跑 10000 档(拆 2×${SPLIT_HALF} 顺序取锁)${ROUNDS} 轮…`);
    for (let r = 0; r < ROUNDS; r++) {
      try {
        const t = await runCommitRound(
          prisma,
          fx,
          fx.memberIds.slice(0, 10000),
          baseline,
          100_000 + r,
          SPLIT_HALF,
        );
        if (r >= WARMUP_ROUNDS) {
          splitAdv.push(t.advisoryMs);
          splitTot.push(t.totalTxMs);
        }
      } catch (err) {
        splitErrs.push(briefError(err));
      }
    }
    process.stdout.write(` 完成(失败 ${splitErrs.length} 轮)\n`);

    // ── 输出读数 ───────────────────────────────────────────────────────
    console.log('\n## 3. 四档读数(单位 ms;nearest-rank 百分位,不插值)\n');
    for (const scale of allScales) {
      const s = scaleStats.get(scale);
      if (!s) continue;
      const isExtra = !(SCALES as readonly number[]).includes(scale);
      console.log(`### ${scale} 人${isExtra ? '(反向读数对照档,非 DoD 四档)' : ''}\n`);
      console.log('| 分段 | n | P50 | P95 | P99 | min | max |');
      console.log('| --- | --- | --- | --- | --- | --- | --- |');
      console.log(statsRow('① advisory 取锁', s.advisory));
      console.log(statsRow('② day-state 行锁 + 比对', s.dayState));
      console.log(statsRow('③ 终写(batch/run/review/audit/outbox)', s.finalWrite));
      console.log(statsRow('**整事务(含 BEGIN/COMMIT)**', s.total));
      const errs = failures.get(scale) ?? [];
      console.log(
        `\n失败轮数:${errs.length}/${ROUNDS}${errs.length ? ` —— ${errs[0]}` : ''};` +
          `漂移检查(整事务前半 P50 → 后半 P50):${fmt(s.total.firstHalfP50)} → ${fmt(s.total.secondHalfP50)}\n`,
      );
    }

    console.log('\n## 4. 仪器自证 B —— 空载基线与反向读数\n');
    console.log('| 对照 | n | P50 | P95 | P99 |');
    console.log('| --- | --- | --- | --- | --- |');
    console.log(
      `| 空载(同事务框架,零 lock 零行锁) | ${idle.n} | ${fmt(idle.p50)} | ${fmt(idle.p95)} | ${fmt(idle.p99)} |`,
    );
    const s10k = scaleStats.get(10000);
    const s5k = scaleStats.get(SPLIT_HALF);
    const splitAdvS = stats(splitAdv);
    const splitTotS = stats(splitTot);
    if (s10k) {
      console.log(
        `| 10000 有载整事务 | ${s10k.total.n} | ${fmt(s10k.total.p50)} | ${fmt(s10k.total.p95)} | ${fmt(s10k.total.p99)} |`,
      );
      console.log(
        `| 10000 一次取锁 ①段 | ${s10k.advisory.n} | ${fmt(s10k.advisory.p50)} | ${fmt(s10k.advisory.p95)} | ${fmt(s10k.advisory.p99)} |`,
      );
      console.log(
        `| 10000 拆 2×5000 ①段合计 | ${splitAdvS.n} | ${fmt(splitAdvS.p50)} | ${fmt(splitAdvS.p95)} | ${fmt(splitAdvS.p99)} |`,
      );
    }
    if (s5k) {
      console.log(
        `| 独立 5000 档 ①段 | ${s5k.advisory.n} | ${fmt(s5k.advisory.p50)} | ${fmt(s5k.advisory.p95)} | ${fmt(s5k.advisory.p99)} |`,
      );
    }
    console.log(
      `| 10000 拆 2×5000 整事务 | ${splitTotS.n} | ${fmt(splitTotS.p50)} | ${fmt(splitTotS.p95)} | ${fmt(splitTotS.p99)} |`,
    );
    if (s10k && s5k) {
      const halfExpected = s10k.advisory.p50 / 2;
      console.log(
        `\n- 空载判据:10000 有载整事务 P50 / 空载 P50 = **${(s10k.total.p50 / idle.p50).toFixed(1)}×**(要求显著 > 1)。\n` +
          `- 剂量-反应判据:10000 一次取锁 P50 = ${fmt(s10k.advisory.p50)}ms,其一半 = ${fmt(halfExpected)}ms;` +
          `独立 5000 档 ①段 P50 = ${fmt(s5k.advisory.p50)}ms(比值 ${(s5k.advisory.p50 / halfExpected).toFixed(2)},≈1 即线性)。\n` +
          `- 拆分判据:2×5000 顺序取锁 ①段合计 P50 = ${fmt(splitAdvS.p50)}ms vs 一次取满 ${fmt(s10k.advisory.p50)}ms;` +
          `失败 ${splitErrs.length}/${ROUNDS} 轮。\n`,
      );
    }

    // ── hashtext 碰撞 ──────────────────────────────────────────────────
    console.log('\n## 5. hashtext 碰撞\n');
    // 组数取 2000 而不是 300:碰撞率只有 ~1.2%,300 组期望才 3.5 次,
    // 观测到 1 次和观测到 5 次都在噪声里 —— 那种样本量下说「实测≈理论」是自欺。
    // 2000 组期望 ~23 次,估计量才站得住。
    const coll = await measureHashtextCollisions(prisma, fx, 2000, 10000);
    console.log(
      `- 蒙特卡洛:${coll.setsTotal} 组 × 10000 个 id,其中 **${coll.setsWithCollision} 组**出现碰撞` +
        `(实测 ${coll.observedRatePct.toFixed(2)}%,理论 ${coll.theoreticalRatePct.toFixed(2)}%);` +
        `累计多余(被碰撞吞掉的)id 数 ${coll.totalExcess}。`,
    );
    console.log(
      `- 本次探针实际使用的 10000 个 id:碰撞导致的多余 id 数 = **${coll.actualSetExcess}**。`,
    );

    const cons = await measureCollisionConsequence(prisma, rival, observer);
    if (cons.pair) {
      console.log(
        `- 真实碰撞对:\`${cons.pair.a}\` 与 \`${cons.pair.b}\` → hashtext 同为 \`${cons.pair.key}\`;` +
          `构造的中间 id \`${cons.middle ?? ''}\`。`,
      );
      console.log(
        `- **机制实验(显式交错)**:${cons.mechanismDeadlock ? '✅ 触发 40P01 死锁' : '未触发'} —— ${cons.mechanismDetail}`,
      );
      console.log(
        `- **自然并发实验**:${cons.naturalAttempts} 次对撞中观测到 40P01 **${cons.naturalDeadlocks}** 次。`,
      );
    } else {
      console.log(`- ${cons.mechanismDetail}`);
    }

    // ── 语句构建 vs 执行 / bind 参数 ───────────────────────────────────
    console.log('\n## 6. 语句构建耗时、执行耗时与 bind 参数上限\n');
    const buildRows: BuildCostRow[] = [];
    for (const scale of allScales) {
      const members = fx.memberIds.slice(0, scale);
      const runs: number[] = [];
      for (let i = 0; i < 20; i++) {
        const b = buildLockSqlOnly(members);
        if (i >= 3) runs.push(b.buildMs);
      }
      buildRows.push({ scale, buildMs: median(runs) });
    }
    console.log('| 规模 | Prisma.join 构建 P50(ms) | 该语句 bind 参数数 |');
    console.log('| --- | --- | --- |');
    buildRows.forEach((r) => console.log(`| ${r.scale} | ${fmt(r.buildMs)} | ${r.scale} |`));
    if (s10k) {
      const build10k = buildRows.find((r) => r.scale === 10000)?.buildMs ?? Number.NaN;
      console.log(
        `\n10000 档 ①段总耗时 P50 = ${fmt(s10k.advisory.p50)}ms,其中**构建 ${fmt(build10k)}ms**,` +
          `**执行(往返 + 取 10000 把锁)≈ ${fmt(s10k.advisory.p50 - build10k)}ms**。`,
      );
    }

    const bind = await probeBindParamLimit(prisma);
    console.log(
      `\n**bind 参数上限实测(二分)**:最大可用 **${bind.measuredMax}** 个;` +
        `${bind.firstFail} 个失败 —— ${bind.failMsg}\n` +
        `PostgreSQL 协议上限是 ${bind.protocolLimit}(无符号 int16),` +
        `但先撞上的是 Prisma 引擎的有符号 i16 上限 —— **实际可用额度只有协议值的一半**。\n`,
    );

    console.log('本事务内四条语句的 bind 参数消耗(N = 人数;上限按实测值推导):\n');
    console.log(`| 语句 | 每人参数 | N=10000 | 撞 ${bind.measuredMax} 上限时的 N | 余量 |`);
    console.log('| --- | --- | --- | --- | --- |');
    const row = (label: string, per: number, bold = false): string => {
      const capN = Math.floor(bind.measuredMax / per);
      const headroom = `${(((capN - 10000) / 10000) * 100).toFixed(0)}%`;
      const cap = bold ? `**${capN}**` : `${capN}`;
      const hr = bold ? `**${headroom}**` : headroom;
      return `| ${label} | ${per} | ${per * 10000} | ${cap} | ${hr} |`;
    };
    console.log(row('① advisory 取锁 VALUES', 1));
    console.log(row('② day-state FOR UPDATE join', 2));
    console.log(row('③ day-state 批量 UPDATE', 3, true));
    console.log(row('④ result revision UPDATE', 1));
    console.log(
      `\n⚠️ 最紧的是 ③:本探针每人只写 1 个业务值(3 参数/人)就已经把余量压到 ` +
        `**${(((Math.floor(bind.measuredMax / 3) - 10000) / 10000) * 100).toFixed(0)}%**。` +
        `真实 day-state 要回写 recognized / credited / cappedOut 等多个字段 —— ` +
        `每人 4 参数时上限 ${Math.floor(bind.measuredMax / 4)} 人、5 参数时 ${Math.floor(bind.measuredMax / 5)} 人,` +
        `**都低于 10000**。这一条是 schema lane 的硬约束,不是余量问题。`,
    );

    // ── 共享锁表天花板 ─────────────────────────────────────────────────
    console.log('\n## 7. 共享锁表天花板(advisory 锁占用共享内存)\n');
    const ceiling = await probeSharedLockCeiling(prisma);
    console.log(
      `- 公式保底(max_locks_per_transaction × (max_connections + max_prepared_transactions))= **${ceiling.formulaFloor}**。`,
    );
    console.log(
      `- 单事务实测:${ceiling.lastOk} 把 advisory 锁通过;` +
        `${ceiling.firstFail > 0 ? `${ceiling.firstFail} 把失败(out of shared memory)` : '未测到上限'}` +
        '(空载服务器,二分粒度 1000)。',
    );
    console.log(
      `- 10000 人一次生效占公式保底额度的 **${((10000 / ceiling.formulaFloor) * 100).toFixed(0)}%**。`,
    );

    console.log('\n---\n探针结束。fixture 表将被删除。');
  } finally {
    await cleanup();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
