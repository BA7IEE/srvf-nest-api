/**
 * check-migration-count-sync.ts — 「加一条 migration 打挂 N 份 e2e 计数 spec」类闸
 *
 * ## 立项证据(实测,不是推演)
 *
 * 2026-08-25 `#1186` 加了第 96 条 migration。仓库里有若干份**冷库重放型** e2e spec
 * 各自手写一行 `const CURRENT_MIGRATION_COUNT = 95;`,它们**全部当场过期**;
 * 而本机 lint / typecheck / 全量 unit / 十余条静态判据**全绿、零症状** ——
 * 唯一会红的地方是 CI 的 e2e 分片,也就是最贵、最晚、最容易被读成 flake 的那一格。
 * 同形状此前已复发过两次(`#1048` / `#1055`,见
 * `test/e2e/insurance-evidence-registration-revision-migration.e2e-spec.ts` 头注)。
 *
 * 这不是「某几份 spec 忘了改」的实例问题,是**一整类**:
 * 「加 migration」的连坐面里有一片**本机零反馈区**,靠人记住去 grep。
 *
 * ## 为什么不把那个常量改成「从磁盘现取」
 *
 * ⭐ **刻意不改,理由与 `EXPECTED_ROUTE_COUNT` 同一条**:自动取数 = 判据永远同意自己。
 * 那几份 spec 断言的是「**冷库从零重放之后,`_prisma_migrations` 里成功记录数**
 * 等于我(人)声明的期望值」—— 若期望值改成运行时读 `prisma/migrations/` 目录,
 * 那条断言就退化成「Prisma 把它自己数出来的文件都跑了」,漏跑 / 半途失败以外的
 * 任何形状(比如某条 migration 目录被误删)它都不再有判别力。
 *
 * 所以本判据要守的是「**那个手写的数有没有跟上**」,不是取消手写。
 * 本判据与 spec 是两句**不同**的话:
 *   · spec:数据库里真的跑成功了 N 条(需要 Postgres,只在 CI e2e 分片有)
 *   · 本闸:那个 N 与 `prisma/migrations/` 的目录数一致(纯文件解析,秒级,恒跑)
 * 两者缺一不可;本闸把「过期」这一格从 e2e 分片提前到 fast job。
 *
 * ## 管辖面(三条断言)
 *
 *   A. **同步**:每一处 `const CURRENT_MIGRATION_COUNT = N;` 都必须等于
 *      `prisma/migrations/` 的实际目录数。红时**点名到文件:行号 + 声明值 + 实际值**。
 *   B. **扫描面没塌**:发现到的钉子份数有地板(见 `MIN_PINNING_SPECS`),
 *      并把「扫了多少份文件 / 发现多少份钉子」**打印出来**给人看。
 *      ⚠️ 地板是**下界不是等号** —— 第 7 份 spec 出现时必须被自动纳管,
 *      写死「恰 6 份」的判据在那一天会静默漏掉它,那正是本刀要消灭的缺陷形状。
 *   C. **别名逃逸**:凡是引用了冷库重放辅助函数 `successfulMigrationCount` 的测试文件,
 *      都必须用 `CURRENT_MIGRATION_COUNT` 这个名字声明它的期望值。
 *      这一条堵的是**已发生过两次**的真实事故:`insurance-*-migration.e2e-spec.ts`
 *      当年写的是裸 `toBe(90)`,于是「按 CURRENT_MIGRATION_COUNT 搜」搜不到它,
 *      改完另外 5 份推上去被它再咬一轮(`#1048` / `#1055`)。
 *
 * ## 刻意不做
 *
 * - **不判 `prisma/CLAUDE.md` 的声明数**:那一格已有唯一主人 ——
 *   `scripts/check-codemap.ts` 的 `migration-count-matches`(`pnpm docs:codemap:check`)。
 *   再判一遍会造出第二份真相,两边措辞一漂移就永远说不清听谁的。
 * - **不读也不改任何 spec 的断言**:本闸只读它们的常量声明。
 * - **不连数据库、不起 Nest**:纯文件解析 + 语法树,故可挂在无 Postgres 的 fast job。
 *
 * ## 用法
 *
 *   pnpm docs:migcount:check          # = tsx scripts/check-migration-count-sync.ts
 *
 * 红了怎么修:把报出来的每一份文件里那一行的数字改成实际值(通常就是 +1),
 * 别去动同文件里的**历史世代基线**(例如 insurance 那份的 `toBe(81)` ×2 与
 * `!== 81` ×2 —— 那是「第 82 刀之前」的冷库重放起点,随仓库增长永不变)。
 *
 * ⚠️ 本文件在 `harness/redzone.json` 的 selfGuard 内(`scripts/check-*.ts`)。
 *    判据逻辑刻意放在这里而不是 spec 里:`test/e2e/**` 不在 selfGuard,
 *    任何 PR 都能顺手把它改松;放在受保护文件里,改松就必须动红区。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';

const ROOT = path.resolve(__dirname, '..');

/** 权威源:migration 的实际条数。 */
const MIGRATIONS_DIR = 'prisma/migrations';

/** 扫描面:整个 test/ 树(不只 test/e2e —— 钉子搬到 journeys/contract 也照样管得住)。 */
const SCAN_DIR = 'test';

/** 被管住的常量名。命名统一是 `#1048`/`#1055` 之后的既有约定,断言 C 负责维持它。 */
const PIN_CONST = 'CURRENT_MIGRATION_COUNT';

/** 冷库重放辅助函数名 —— 用它识别「这份 spec 在数 migration」。 */
const REPLAY_HELPER = 'successfulMigrationCount';

/**
 * 地板锚点(**下界,不是等号**)。当前实测 6 份;定成 6 是说「掉到 6 以下 = 扫描面塌了」,
 * 不是说「只有 6 份」。新增第 7 份会被自动纳管且不需要动这个数。
 *
 * ⚠️ 要**调低**它必须有真实理由(某份 spec 被删),而本文件在红区 selfGuard 内 ——
 *    调低就得走授权,那正是该有的摩擦。
 */
const MIN_PINNING_SPECS = 6;

/**
 * 仪器自证的第二个地板:migration 只增不减,所以「数出来比这还少」只可能是
 * 目录读错了 / 路径写错了,不可能是真的。
 */
const MIN_MIGRATIONS = 90;

/** 仪器自证的第三个地板:test/ 下的 .ts 数量。塌到个位数 = 遍历坏了。 */
const MIN_SCANNED_FILES = 200;

export interface Pin {
  /** 仓库相对路径 */
  readonly file: string;
  /** 1-based 行号 */
  readonly line: number;
  readonly declared: number;
}

export interface MigrationCountReport {
  /** `prisma/migrations/` 的实际目录数 */
  readonly actual: number;
  /** 发现的全部钉子 */
  readonly pins: readonly Pin[];
  /** 扫过的 .ts 文件总数(报出来,便于人看出扫描面是否塌了) */
  readonly scannedFiles: number;
  /** 钉了常量的文件数(与 pins.length 可能不等 —— 同文件多处声明) */
  readonly pinningFiles: number;
  /** 断言 C:引用了重放辅助函数却没用统一常量名的文件 */
  readonly aliasEscapes: readonly string[];
  /** 声明存在但初始化值不是数字字面量 ⇒ 静态读不出来。判不了 ≠ 没漂移,一律算红。 */
  readonly unreadable: readonly string[];
}

/**
 * 数 `prisma/migrations/` 下的目录数。口径与 `scripts/check-codemap.ts` 的
 * `countMigrationDirs()` 逐字一致(只数子目录,忽略 `migration_lock.toml`)——
 * 两处若用不同口径,就会出现「codemap 说 96、本闸说 97」的互相矛盾。
 */
export function countMigrationDirs(): number {
  const abs = path.join(ROOT, MIGRATIONS_DIR);
  if (!fs.existsSync(abs)) return 0;
  return fs.readdirSync(abs, { withFileTypes: true }).filter((d) => d.isDirectory()).length;
}

/** 递归收集 test/ 下全部 .ts(目录当前是平的,但不假设它一直平)。 */
function listTestFiles(): string[] {
  const out: string[] = [];
  const walk = (relDir: string): void => {
    const abs = path.join(ROOT, relDir);
    if (!fs.existsSync(abs)) return;
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      const rel = path.posix.join(relDir, entry.name);
      if (entry.isDirectory()) walk(rel);
      else if (entry.isFile() && entry.name.endsWith('.ts')) out.push(rel);
    }
  };
  walk(SCAN_DIR);
  return out.sort();
}

export interface FileScan {
  readonly pins: readonly Pin[];
  readonly usesReplayHelper: boolean;
  readonly unreadable: boolean;
}

/**
 * 语法树扫描,**不用正则**:注释里出现的 `CURRENT_MIGRATION_COUNT` / 拼在字符串里的
 * `successfulMigrationCount` 都不该算数。insurance 那份的头注里两个名字都出现过,
 * 正则版会把注释当成声明。
 */
export function scanSource(relPath: string, text: string): FileScan {
  const sf = ts.createSourceFile(relPath, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const pins: Pin[] = [];
  let usesReplayHelper = false;
  let unreadable = false;

  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === REPLAY_HELPER) usesReplayHelper = true;

    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === PIN_CONST
    ) {
      const init = node.initializer;
      if (init !== undefined && ts.isNumericLiteral(init)) {
        const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
        pins.push({ file: relPath, line, declared: Number(init.text) });
      } else {
        unreadable = true;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  return { pins, usesReplayHelper, unreadable };
}

export function analyzeMigrationCountSync(): MigrationCountReport {
  const actual = countMigrationDirs();
  const files = listTestFiles();

  const pins: Pin[] = [];
  const aliasEscapes: string[] = [];
  const unreadable: string[] = [];
  const pinningFiles = new Set<string>();

  for (const rel of files) {
    const scan = scanSource(rel, fs.readFileSync(path.join(ROOT, rel), 'utf8'));
    for (const pin of scan.pins) {
      pins.push(pin);
      pinningFiles.add(pin.file);
    }
    if (scan.unreadable) unreadable.push(rel);
    if (scan.usesReplayHelper && scan.pins.length === 0) aliasEscapes.push(rel);
  }

  return {
    actual,
    pins,
    scannedFiles: files.length,
    pinningFiles: pinningFiles.size,
    aliasEscapes,
    unreadable,
  };
}

/** 断言 A:每个钉子都必须等于实际值。 */
export function stalePins(report: MigrationCountReport): readonly Pin[] {
  return report.pins.filter((pin) => pin.declared !== report.actual);
}

/** 自证:仪器没瞎才报数。返回空数组 = 自证通过。 */
export function selfCheck(report: MigrationCountReport): string[] {
  const problems: string[] = [];

  if (report.actual < MIN_MIGRATIONS) {
    problems.push(
      `migration 只数出 ${report.actual} 条,地板是 ${MIN_MIGRATIONS} —— ` +
        `migration 只增不减,读数比地板还小只可能是 ${MIGRATIONS_DIR}/ 没读到。`,
    );
  }
  if (report.scannedFiles < MIN_SCANNED_FILES) {
    problems.push(
      `只扫到 ${report.scannedFiles} 份 ${SCAN_DIR}/ 下的 .ts,地板是 ${MIN_SCANNED_FILES} —— 遍历塌了。`,
    );
  }
  if (report.pinningFiles < MIN_PINNING_SPECS) {
    problems.push(
      `只发现 ${report.pinningFiles} 份 spec 钉了 ${PIN_CONST},地板是 ${MIN_PINNING_SPECS} —— ` +
        `要么真删了 spec(那要连同本文件的 MIN_PINNING_SPECS 一起改,须红区授权),` +
        `要么识别逻辑坏了在空转。`,
    );
  }
  for (const file of report.unreadable) {
    problems.push(
      `${file}:${PIN_CONST} 的初始化值不是数字字面量,静态读不出来 —— ` +
        `「判不了」不等于「没漂移」,请改回 \`const ${PIN_CONST} = <数字>;\` 形态。`,
    );
  }

  return problems;
}

function main(): void {
  const report = analyzeMigrationCountSync();
  const problems = selfCheck(report);
  const stale = stalePins(report);

  for (const problem of problems) console.error(`🔴 自证失败:${problem}`);

  for (const pin of stale) {
    console.error(
      `🔴 ${pin.file}:${pin.line} — ${PIN_CONST} 声明 ${pin.declared},` +
        `实际 ${MIGRATIONS_DIR}/ 有 ${report.actual} 个(差 ${report.actual - pin.declared})`,
    );
  }
  for (const file of report.aliasEscapes) {
    console.error(
      `🔴 ${file} 引用了 ${REPLAY_HELPER}() 却没有 ${PIN_CONST} 声明 —— ` +
        `期望值一旦写成裸字面量,本闸(以及任何按常量名 grep 的人)就看不见它;` +
        `这正是 #1048 / #1055 两次复发的形状。`,
    );
  }

  const broken = problems.length + stale.length + report.aliasEscapes.length;

  if (broken === 0) {
    console.log(
      `✓ migration 计数已同步:${MIGRATIONS_DIR}/ 实际 ${report.actual} 个;` +
        `${report.pinningFiles} 份 spec 的 ${PIN_CONST} 全部一致` +
        `(共 ${report.pins.length} 处声明;扫描 ${SCAN_DIR}/ 下 ${report.scannedFiles} 份 .ts)。`,
    );
    for (const pin of report.pins) {
      console.log(`    ${pin.file}:${pin.line} = ${pin.declared}`);
    }
  } else if (stale.length > 0) {
    console.error(
      `\n修法:把上面 ${stale.length} 处改成 ${report.actual}。` +
        `\n  ⚠️ 只改 \`const ${PIN_CONST} = …\` 那一行;同文件里的**历史世代基线**` +
        `(如 insurance 那份的 81)是另一件事,随仓库增长永不变,改它 = 把基线改坏。` +
        `\n  ⚠️ 别把常量改成「从磁盘现取」—— 那会让 spec 的断言退化成同义反复(见本文件头注)。`,
    );
  }

  process.exit(broken === 0 ? 0 : 1);
}

if (require.main === module) main();
