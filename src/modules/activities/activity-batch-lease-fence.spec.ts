import * as fs from 'node:fs';
import * as path from 'node:path';

import * as ts from 'typescript';

// ===== 「批任务状态变更漏围栏」缺陷类的执行位(第六轮评审 B-02)=====
//
// 缺陷类定义:**worker 拿着一份已经过期的租约,去改一条已被新一代持有者接管的
// `ActivityBatchJob` / `ActivityBatchJobItem` 行。**
//
// 可复现时序:
//   A 领 job(generation=7)→ A 超时但仍在跑 → B 重领(generation=8)
//   → B 处理完某 item → A 从旧调用返回、进入异常清理
//   → A 把 B 已完成的 item 改 failed / 把 B 持有的 job 清回 pending / 覆盖收尾状态
//
// ⚠️ 「账本插入本身幂等」**消不掉**这个竞态。分录靠 `ParticipationLedgerEntry.entryKey`
// 唯一键 `ON CONFLICT DO NOTHING`,重跑不会重复插入;但 `LedgerPostingBatch.preparedCount`
// 是**累加式**投影(`ledger-preparation.service.ts` 的 `preparedCount: { increment:
// chunkMemberIds.length }`)—— 旧 worker 把已完成 item 重置后,下一轮重跑同一块会**再累加
// 一遍**⇒ `preparedCount > totalCount` ⇒ `finalize` 判 `LEDGER_PREPARE_COUNT_MISMATCH`,
// 把一个业务上其实已经准备完成的批次判 `failed`,job 在 pending / processing / failed 间震荡。
//
// 立此闸的直接理由:**同一个文件里两种写法并存**。修复前 `releaseReconciliationForRetry`
// 带围栏,而 `releaseForRetry` / `markItemFailed` / `markCommitSucceeded` /
// `markReadyForCommit` 四处裸 id —— 不是能力限制,是不一致。修实例不修类,下一个人照着
// 裸 id 那三处再写一处,谁也不会红。
//
// 本 spec 不修实例,它让这个类**长不回来**。四道断言:
//
//   ① 扫描面自证:被扫文件必须存在,且分析器必须真的看见写点(空集恒绿是本仓栽过的坑)。
//      扫描面**动态现取** —— 按 TypeScript AST 找 delegate 写调用与裸 SQL UPDATE,
//      **不写死行号**(行号会漂)、**不写死「恰 N 条」**(少登记一条不产生坏链接)。
//
//   ② 每个写点要么带围栏,要么**显式登记豁免并逐条写理由**,没有默认放行。
//      报错点名 `file:line` 与**缺哪个条件**。
//
//   ③ 豁免表不许有死条目:登记了却扫不到的条目 ⇒ 红(防止函数改名后豁免悄悄扩大)。
//
//   ④ 阳性对照:摘掉围栏 / 新增裸 id 写点 / 把围栏藏进 SET 而非 WHERE,分析器都必须报红。
//
// 覆盖面包含**裸 SQL**:否则「把违规改写成 $executeRaw」就是一条现成的逃生门。

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const WORKER_REL = 'src/modules/activities/activity-batch.worker.ts';
const WORKER_FULL = path.join(REPO_ROOT, WORKER_REL);

/** 受围栏管辖的两个 Prisma delegate ↔ 表名。 */
const FENCED_DELEGATES: ReadonlyMap<string, string> = new Map([
  ['activityBatchJob', 'ActivityBatchJob'],
  ['activityBatchJobItem', 'ActivityBatchJobItem'],
]);

/** 写方法闭集。`create` 家族没有 `where` ⇒ 结构上无法围栏,只能走豁免登记。 */
const WRITE_METHODS: ReadonlySet<string> = new Set([
  'create',
  'createMany',
  'createManyAndReturn',
  'update',
  'updateMany',
  'updateManyAndReturn',
  'upsert',
  'delete',
  'deleteMany',
]);

/** 围栏三元里必须出现在 `where` 的两列(`leaseExpiresAt` 是租约时长,不是身份)。 */
const FENCE_COLUMNS = ['leaseOwner', 'leaseGeneration'] as const;

// ---------------------------------------------------------------------------
// 豁免登记表 —— 逐条写理由,不能笼统一句「领取除外」
// ---------------------------------------------------------------------------
//
// `site` 是**外层方法名 + 写法**,不是行号:行号会漂,方法改名则 ③ 当场红。
interface FenceExemption {
  readonly site: string;
  readonly why: string;
}

const FENCE_EXEMPTIONS: readonly FenceExemption[] = [
  {
    site: 'claimJob → activityBatchJob.update',
    why:
      '这里正是**建立**租约的地方(`leaseGeneration: { increment: 1 }`)。它跑在 ' +
      '`FOR UPDATE SKIP LOCKED` 选出的候选行的同一事务里,行锁本身就是互斥来源;' +
      '此刻调用方手上还没有围栏可比,要求它带围栏是循环依赖。',
  },
  {
    site: 'sweepDead → activityBatchJob.updateMany',
    why:
      '过期租约清道夫:`where` 恒含 `leaseExpiresAt: { not: null, lte: now }` + ' +
      '`attempts >= MAX`,按定义只碰**持有者已死**的行。它不是任何持有者的收尾写,' +
      '没有 fence 可带 —— 反过来,带上围栏它就永远清不掉别人留下的僵尸任务。',
  },
  {
    site: 'sweepDead → raw UPDATE "ActivityBatchJob"',
    why:
      '同上,`bulk_proxy` / `import_execute` 两族的清道夫。走裸 SQL 只是因为可取条件里有 ' +
      "`payload->>'action'` 这类 Prisma where 表达不了的 JSON 谓词;WHERE 里同样恒含 " +
      '`"leaseExpiresAt" IS NOT NULL AND "leaseExpiresAt" <= now`。',
  },
  {
    site: 'enqueuePreparingBatches → activityBatchJob.updateMany',
    why:
      'ready 批次的**恢复器**:把「job 已 succeeded 但 batch 还停在 ready」(= 上一任在 ' +
      'commit ack 前崩溃)的任务恢复 pending。它的 where 恒含 ' +
      '`OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }]`,只碰租约已释放/' +
      '已过期的行。调用方是**尚未领取任何任务**的取活前置,手上没有围栏。',
  },
];

// ---------------------------------------------------------------------------
// 分析器
// ---------------------------------------------------------------------------

interface DiscoveredWrite {
  readonly line: number;
  /** 与豁免表 `site` 同构的稳定键 */
  readonly site: string;
  readonly fenced: boolean;
  /** 未带围栏时,缺了哪些条件 */
  readonly missing: readonly string[];
}

/** 往上找最近的具名方法/函数,作为豁免表的稳定键。 */
function enclosingName(node: ts.Node): string {
  let current: ts.Node | undefined = node.parent;
  while (current !== undefined) {
    if (
      (ts.isMethodDeclaration(current) ||
        ts.isFunctionDeclaration(current) ||
        ts.isPropertyDeclaration(current)) &&
      current.name !== undefined &&
      ts.isIdentifier(current.name)
    ) {
      return current.name.text;
    }
    current = current.parent;
  }
  return '(top-level)';
}

/** 收集 `where` 对象里出现的键路径(两层足够:item 的围栏挂在 `job` 关系下)。 */
function whereKeyPaths(node: ts.Node, prefix = '', depth = 0): string[] {
  if (!ts.isObjectLiteralExpression(node) || depth > 2) return [];
  const out: string[] = [];
  for (const property of node.properties) {
    if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) continue;
    const name = property.name;
    if (name === undefined || (!ts.isIdentifier(name) && !ts.isStringLiteral(name))) continue;
    const key = prefix === '' ? name.text : `${prefix}.${name.text}`;
    out.push(key);
    if (ts.isPropertyAssignment(property)) {
      out.push(...whereKeyPaths(property.initializer, key, depth + 1));
    }
  }
  return out;
}

function firstProperty(
  argument: ts.ObjectLiteralExpression,
  key: string,
): ts.Expression | undefined {
  for (const property of argument.properties) {
    if (
      ts.isPropertyAssignment(property) &&
      ts.isIdentifier(property.name) &&
      property.name.text === key
    ) {
      return property.initializer;
    }
  }
  return undefined;
}

/**
 * 判定一个 `where` 是否带围栏。
 *
 * job 的围栏在顶层(`leaseOwner` / `leaseGeneration`);item 表本身没有租约列,
 * 围栏经 `job` 关系过滤(`job: { leaseOwner, leaseGeneration }`)。两种都认。
 */
function fenceVerdict(paths: readonly string[]): { fenced: boolean; missing: string[] } {
  for (const prefix of ['', 'job.']) {
    const missing = FENCE_COLUMNS.filter((column) => !paths.includes(`${prefix}${column}`));
    if (missing.length === 0) return { fenced: true, missing: [] };
  }
  // 报「顶层缺什么」——最常见的形态就是顶层裸 id。
  return { fenced: false, missing: FENCE_COLUMNS.filter((column) => !paths.includes(column)) };
}

/** 裸 SQL:围栏必须出现在 **WHERE 之后**(SET 里的 `"leaseOwner" = NULL` 不算数)。 */
function rawSqlVerdict(sql: string): { fenced: boolean; missing: string[] } {
  const parts = sql.split(/\bWHERE\b/i);
  if (parts.length < 2) return { fenced: false, missing: [...FENCE_COLUMNS] };
  const whereClause = parts.slice(1).join(' WHERE ');
  const missing = FENCE_COLUMNS.filter((column) => !whereClause.includes(`"${column}"`));
  return { fenced: missing.length === 0, missing };
}

/** 扫一份源码,返回受管辖两张表上的全部写点。 */
export function scanFencedWrites(fileLabel: string, source: string): DiscoveredWrite[] {
  const sourceFile = ts.createSourceFile(fileLabel, source, ts.ScriptTarget.Latest, true);
  const out: DiscoveredWrite[] = [];
  const lineOf = (node: ts.Node): number =>
    sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;

  const visit = (node: ts.Node): void => {
    // ---- Prisma delegate 写调用 ----
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      const target = node.expression.expression;
      const delegate = ts.isPropertyAccessExpression(target)
        ? target.name.text
        : ts.isIdentifier(target)
          ? target.text
          : null;
      if (delegate !== null && FENCED_DELEGATES.has(delegate) && WRITE_METHODS.has(method)) {
        const site = `${enclosingName(node)} → ${delegate}.${method}`;
        const argument = node.arguments[0];
        const where =
          argument !== undefined && ts.isObjectLiteralExpression(argument)
            ? firstProperty(argument, 'where')
            : undefined;
        // 没有 `where`(create 家族,或 where 不是对象字面量 ⇒ 静态核验不了)⇒ 一律判未围栏,
        // 逼人走豁免登记。**不默认放行**。
        const verdict =
          where === undefined
            ? { fenced: false, missing: [...FENCE_COLUMNS] }
            : fenceVerdict(whereKeyPaths(where));
        out.push({ line: lineOf(node), site, ...verdict });
      }
    }
    // ---- 裸 SQL UPDATE ----
    if (ts.isTemplateExpression(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const text = node.getText(sourceFile);
      for (const [, table] of FENCED_DELEGATES) {
        const updates = new RegExp(`UPDATE\\s+"${table}"`, 'i');
        if (!updates.test(text)) continue;
        const verdict = rawSqlVerdict(text);
        out.push({
          line: lineOf(node),
          site: `${enclosingName(node)} → raw UPDATE "${table}"`,
          ...verdict,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return out.sort((a, b) => a.line - b.line);
}

// ---------------------------------------------------------------------------
// 断言
// ---------------------------------------------------------------------------

describe('批任务租约围栏 —— 「过期 worker 覆盖新一代」缺陷类的执行位', () => {
  // ===== ① 扫描面自证:文件在、分析器真的看见了东西 =====
  it('①被扫文件存在,且分析器在其中真的发现了受管辖的写点(空集不许恒绿)', () => {
    expect({ [WORKER_REL]: fs.existsSync(WORKER_FULL) }).toEqual({ [WORKER_REL]: true });

    const discovered = scanFencedWrites(WORKER_REL, fs.readFileSync(WORKER_FULL, 'utf8'));
    // 不写「恰 N 条」:只要求非空 —— 少登记一条不产生坏链接,写死计数反而会过期。
    expect(discovered.length).toBeGreaterThan(0);
    // 两张表都必须在扫描面里(漏掉 item 就等于给它开了后门)。
    const tables = new Set(
      discovered.map((write) =>
        write.site.includes('activityBatchJobItem') || write.site.includes('ActivityBatchJobItem')
          ? 'ActivityBatchJobItem'
          : 'ActivityBatchJob',
      ),
    );
    expect([...tables].sort()).toEqual(['ActivityBatchJob', 'ActivityBatchJobItem']);
  });

  // ===== ② 每个写点要么带围栏,要么显式登记豁免 =====
  it('②每个写点的 where 都含 leaseOwner + leaseGeneration,除非显式登记豁免', () => {
    const discovered = scanFencedWrites(WORKER_REL, fs.readFileSync(WORKER_FULL, 'utf8'));
    const exempted = new Set(FENCE_EXEMPTIONS.map((entry) => entry.site));

    const offenders = discovered
      .filter((write) => !write.fenced && !exempted.has(write.site))
      .map(
        (write) =>
          `${WORKER_REL}:${write.line} [${write.site}] where 缺 ${write.missing.join(' + ')}` +
          ' ⇒ 过期 worker 可覆盖新一代持有者',
      );
    expect({ 漏围栏的批任务写点: offenders }).toEqual({ 漏围栏的批任务写点: [] });
  });

  // ===== ③ 豁免表不许有死条目,且每条都要有理由 =====
  it('③豁免登记逐条有理由,且都还能在代码里扫到(改名/删除后不许悄悄扩大)', () => {
    const reasonless = FENCE_EXEMPTIONS.filter((entry) => entry.why.trim().length < 20).map(
      (entry) => entry.site,
    );
    expect({ 没写理由的豁免: reasonless }).toEqual({ 没写理由的豁免: [] });

    const discovered = scanFencedWrites(WORKER_REL, fs.readFileSync(WORKER_FULL, 'utf8'));
    const sites = new Set(discovered.map((write) => write.site));
    const stale = FENCE_EXEMPTIONS.map((entry) => entry.site).filter((site) => !sites.has(site));
    expect({ 扫不到的死豁免条目: stale }).toEqual({ 扫不到的死豁免条目: [] });

    // 反向:已经带上围栏的写点不该再挂在豁免表上(豁免只留给结构上带不了围栏的)
    const redundant = discovered
      .filter((write) => write.fenced && FENCE_EXEMPTIONS.some((e) => e.site === write.site))
      .map((write) => write.site);
    expect({ 已带围栏却仍登记豁免: redundant }).toEqual({ 已带围栏却仍登记豁免: [] });
  });

  // ===== ④ 阳性对照:判据自己必须能红 =====
  describe('阳性对照(判据自身的真阳性)', () => {
    it('正对照 A:job 更新裸 id ⇒ 报红并点名缺的两个条件', () => {
      const mutated = `
        class W {
          private async releaseForRetry(jobId: string) {
            await this.prisma.activityBatchJob.update({
              where: { id: jobId },
              data: { statusCode: 'pending' },
            });
          }
        }
      `;
      const found = scanFencedWrites('fixture.ts', mutated);
      expect(found).toHaveLength(1);
      expect(found[0].fenced).toBe(false);
      expect(found[0].missing).toEqual(['leaseOwner', 'leaseGeneration']);
      expect(found[0].site).toBe('releaseForRetry → activityBatchJob.update');
    });

    it('正对照 B:只带半个围栏(有 leaseOwner 没 leaseGeneration)⇒ 仍报红', () => {
      const mutated = `
        class W {
          private async release(jobId: string) {
            await this.prisma.activityBatchJob.updateMany({
              where: { id: jobId, leaseOwner: fence.leaseOwner },
              data: { statusCode: 'pending' },
            });
          }
        }
      `;
      const found = scanFencedWrites('fixture.ts', mutated);
      expect(found[0].fenced).toBe(false);
      expect(found[0].missing).toEqual(['leaseGeneration']);
    });

    it('正对照 C:item 的围栏经 job 关系过滤 ⇒ 认;裸 id ⇒ 红', () => {
      const fenced = `
        class W {
          private async markItemFailed(itemId: string) {
            await this.prisma.activityBatchJobItem.updateMany({
              where: { id: itemId, job: { leaseOwner: f.leaseOwner, leaseGeneration: f.leaseGeneration } },
              data: { statusCode: 'failed' },
            });
          }
        }
      `;
      expect(scanFencedWrites('fixture.ts', fenced)[0].fenced).toBe(true);

      const naked = `
        class W {
          private async markItemFailed(itemId: string) {
            await this.prisma.activityBatchJobItem.update({
              where: { id: itemId },
              data: { statusCode: 'failed' },
            });
          }
        }
      `;
      expect(scanFencedWrites('fixture.ts', naked)[0].fenced).toBe(false);
    });

    it('正对照 D:围栏写在 data 里而不是 where ⇒ 不算数', () => {
      const mutated = `
        class W {
          private async sneaky(jobId: string) {
            await this.prisma.activityBatchJob.update({
              where: { id: jobId },
              data: { leaseOwner: null, leaseGeneration: 0 },
            });
          }
        }
      `;
      expect(scanFencedWrites('fixture.ts', mutated)[0].fenced).toBe(false);
    });

    it('正对照 E:裸 SQL 逃生门也被扫到 —— SET 里的 leaseOwner 不能冒充 WHERE 里的', () => {
      const setOnly = `
        class W {
          private async sweep(now: Date) {
            await tx.$executeRaw(Prisma.sql\`
              UPDATE "ActivityBatchJob"
              SET "statusCode" = 'dead', "leaseOwner" = NULL, "leaseGeneration" = 0
              WHERE "id" = \${jobId}
            \`);
          }
        }
      `;
      const found = scanFencedWrites('fixture.ts', setOnly);
      expect(found.some((w) => w.site.includes('raw UPDATE "ActivityBatchJob"'))).toBe(true);
      expect(found.find((w) => w.site.includes('raw UPDATE'))?.fenced).toBe(false);

      const whereFenced = `
        class W {
          private async release(now: Date) {
            await tx.$executeRaw(Prisma.sql\`
              UPDATE "ActivityBatchJob"
              SET "statusCode" = 'pending', "leaseOwner" = NULL
              WHERE "id" = \${jobId}
                AND "leaseOwner" = \${fence.leaseOwner}
                AND "leaseGeneration" = \${fence.leaseGeneration}
            \`);
          }
        }
      `;
      expect(scanFencedWrites('fixture.ts', whereFenced)[0].fenced).toBe(true);
    });

    it('正对照 F:新增一个 create(结构上无 where)⇒ 不默认放行,逼人登记豁免', () => {
      const mutated = `
        class W {
          private async enqueue() {
            await this.prisma.activityBatchJob.create({ data: { jobTypeCode: 'x' } });
          }
        }
      `;
      const found = scanFencedWrites('fixture.ts', mutated);
      expect(found[0].fenced).toBe(false);
      expect(found[0].site).toBe('enqueue → activityBatchJob.create');
    });

    it('正对照 G:delete 家族同样受管辖(不能靠换写法绕开)', () => {
      const mutated = `
        class W {
          private async purge(jobId: string) {
            await this.prisma.activityBatchJob.deleteMany({ where: { id: jobId } });
          }
        }
      `;
      expect(scanFencedWrites('fixture.ts', mutated)[0].fenced).toBe(false);
    });

    it('正对照 H:围栏齐全 ⇒ 判绿(判据不是恒红)', () => {
      const clean = `
        class W {
          private async release(jobId: string) {
            await this.prisma.activityBatchJob.updateMany({
              where: { id: jobId, leaseOwner: f.leaseOwner, leaseGeneration: f.leaseGeneration },
              data: { statusCode: 'pending' },
            });
          }
        }
      `;
      const found = scanFencedWrites('fixture.ts', clean);
      expect(found).toHaveLength(1);
      expect(found[0].fenced).toBe(true);
    });
  });
});
