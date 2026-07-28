/**
 * generate-codemap.ts — CODEMAP.md 机械部分的生成器(Harness 3.0 P4b)
 *
 * 镜像反转:CODEMAP 里「机器能算出来的」由本脚本写,人只写「机器算不出来的」。
 *
 * 反转的理由(P4b 立项证据):
 *   - CODEMAP.md 41,694 字符,其中 **11,111 字符(27%)是一个表格单元格** ——
 *     `prisma/migrations/` 行里逐次累积的「前一为…」链。每加一个 migration,
 *     上一条就永久黏在导航文档里,没有任何机制会让它退场。
 *   - 「体量」列有 5 种写法(`L (14212L)` / `S (F4 闭环)` / `⚠G (service 1419L)` /
 *     `M (2201L;F3 前 1900L 级,原「S」系陈旧,随本批 true-up)` / `L (源 5264L)`),
 *     因为它是人手写的 —— 每种写法都是某次 PR 里顺手加的。
 *   - 旧模式是 `check-codemap.ts` **发现漂移 → 人手订正**。漂移检出是好事,
 *     但「订正」这一步本身不产生信息:数字就在磁盘上,照抄一遍只是劳动。
 *
 * 本脚本拥有(会被逐字重写,人改了也会被覆盖):
 *   1. `## src/modules/(N 个业务模块…)` 标题里的 N
 *   2. 模块表「体量」列 —— 统一格式 `{等级} {模块总L} · svc {最大 service L}`
 *   3. 模块行散文里的 `service (\d+)L` —— 仅限指代 `<模块>/<模块>.service.ts` 的那处
 *      (与 check-codemap.ts 的 SERVICE_LOC_RE 同口径;其它 LOC 提法指代别的文件,
 *       无法从文本推断归属,仍归人工)
 *   4. `prisma/` 表 `migrations/` 行的「职责」格 —— 总数 + 最近三个,
 *      完整历史链下沉至 docs/archive/prisma-migration-history.md
 *   5. `test/` 表 `e2e/` 行的 spec 计数
 *
 * 人工保留(生成器逐字不动):导语、体量级别定义、每个模块的「职责 / 主要风险 /
 * 本地铁律 / 本地约束」四列、common/ 与 bootstrap/ 两节、冲突处理尾注。
 *
 * 模式:
 *   (无参)    就地重写 CODEMAP.md
 *   --check   重新生成到内存并逐字比对,不一致 exit 1 并打印差异行(CI 新鲜度门)
 *
 * ⚠️ 本文件在 harness/redzone.json selfGuard 内:`--check` 是 CI 的一道门,
 *    能改它就能把校验静默改成恒 PASS。
 */

import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..');
const CODEMAP = path.join(ROOT, 'CODEMAP.md');
const HISTORY_LINK = 'docs/archive/prisma-migration-history.md';

// ---------------------------------------------------------------------------
// 真源读取
// ---------------------------------------------------------------------------

/** 与 check-codemap.ts countLines 同口径:数换行符,匹配 `wc -l`。 */
function countLines(content: string): number {
  const m = content.match(/\n/g);
  return m ? m.length : content.length > 0 ? 1 : 0;
}

function listDirs(abs: string): string[] {
  if (!fs.existsSync(abs)) return [];
  return fs
    .readdirSync(abs, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

/** 递归统计目录下所有 .ts 行数(排除 *.spec.ts —— 测试不算模块体量)。 */
function moduleLoc(modAbs: string): number {
  let total = 0;
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.ts') && !e.name.endsWith('.spec.ts'))
        total += countLines(fs.readFileSync(p, 'utf8'));
    }
  };
  walk(modAbs);
  return total;
}

interface SvcInfo {
  /** 最大 service 文件行数;模块无 service 时为 0 */
  loc: number;
  /** 该文件 basename;等于 `<模块>.service.ts` 时为 null(无需额外标注) */
  basename: string | null;
  /** 同名主 service `<模块>/<模块>.service.ts` 行数;不存在为 null */
  eponymousLoc: number | null;
}

/** 找模块内最大的 *.service.ts(递归 —— 拆分后的 service 常落在子目录)。 */
function mainService(modAbs: string, moduleName: string): SvcInfo {
  let bestLoc = 0;
  let bestBase = '';
  let eponymousLoc: number | null = null;
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(p);
        continue;
      }
      if (!e.name.endsWith('.service.ts') || e.name.endsWith('.spec.ts')) continue;
      const loc = countLines(fs.readFileSync(p, 'utf8'));
      if (loc > bestLoc) {
        bestLoc = loc;
        bestBase = e.name;
      }
      // 同名主 service 只认模块根目录下那个(与 check-codemap.ts 逐字同口径)
      if (dir === modAbs && e.name === `${moduleName}.service.ts`) eponymousLoc = loc;
    }
  };
  walk(modAbs);
  if (bestLoc === 0) return { loc: 0, basename: null, eponymousLoc };
  return {
    loc: bestLoc,
    basename: bestBase === `${moduleName}.service.ts` ? null : bestBase,
    eponymousLoc,
  };
}

/**
 * 体量等级。沿用 CODEMAP 既有刻度(S <500 / M 500–1500 / L 1500–2500),
 * 补一档 `XL` —— 现表里 activities 14,212 行也标 "L",刻度顶格后失去分辨力。
 * `⚠G` 与等级正交:任一 service 单文件 >700 行即挂(AGENTS god-service 观察线)。
 */
function grade(loc: number): string {
  if (loc < 500) return 'S';
  if (loc <= 1500) return 'M';
  if (loc <= 2500) return 'L';
  return 'XL';
}

function fmtSize(modAbs: string, moduleName: string, svc: SvcInfo): string {
  const loc = moduleLoc(modAbs);
  const g = grade(loc) + (svc.loc > 700 ? ' ⚠G' : '');
  if (svc.loc === 0) return `${g} ${loc}L`;
  const named = svc.basename ? `(${svc.basename})` : '';
  return `${g} ${loc}L · svc ${svc.loc}L${named}`;
}

function countE2eSpecs(): number {
  const dir = path.join(ROOT, 'test', 'e2e');
  if (!fs.existsSync(dir)) return 0;
  let n = 0;
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.e2e-spec.ts')) n++;
    }
  };
  walk(dir);
  return n;
}

/**
 * migrations 行的「职责」格。
 *
 * 旧值是逐次累积的「前一为…」链(11,111 字符 = CODEMAP 的 27%)。那条链没有退场
 * 机制:每个新 migration 把上一条永久钉在导航文档里。导航真正需要的是「有多少个 /
 * 最新几个叫什么」;每个 migration 干了什么,权威源是它自己的 SQL 与对应 PR。
 */
function migrationsCell(): string {
  const all = listDirs(path.join(ROOT, 'prisma', 'migrations'));
  const items = all
    .slice(-3)
    .reverse()
    .map((n) => `\`${n}\``)
    .join(' ← ');
  return (
    `${all.length} 个 migration。最近三个(新→旧):${items}。` +
    `每个 migration 做了什么,以其自身 SQL 与对应 PR 为准;` +
    `2026-07-23 前的历史链见[归档](${HISTORY_LINK})`
  );
}

// ---------------------------------------------------------------------------
// 生成
// ---------------------------------------------------------------------------

const MODULE_ROW = /^\|\s*`([a-z0-9-]+)\/`\s*\|/;

function generate(src: string): string {
  const modulesDir = path.join(ROOT, 'src', 'modules');
  const realModules = listDirs(modulesDir);
  const out: string[] = [];
  let section: 'modules' | 'prisma' | 'test' | null = null;

  for (const line of src.split('\n')) {
    if (line.startsWith('## src/modules/')) {
      section = 'modules';
      out.push(line.replace(/\(\s*\d+\s*个业务模块/, `(${realModules.length} 个业务模块`));
      continue;
    }
    if (line.startsWith('## prisma/')) {
      section = 'prisma';
      out.push(line);
      continue;
    }
    if (line.startsWith('## test/')) {
      section = 'test';
      out.push(line);
      continue;
    }
    if (line.startsWith('## ')) {
      section = null;
      out.push(line);
      continue;
    }

    if (section === 'modules') {
      const m = MODULE_ROW.exec(line);
      if (m) {
        const name = m[1];
        const modAbs = path.join(modulesDir, name);
        const cells = line.split('|');
        // `| a | b | c | d | e |` → split 得 7 段(首尾空)。磁盘上不存在的模块交给
        // check-codemap.ts 报 stale;列数异常同理 —— 生成器绝不猜测性改写。
        if (!fs.existsSync(modAbs) || cells.length !== 7) {
          out.push(line);
          continue;
        }
        const svc = mainService(modAbs, name);
        cells[2] = ` ${fmtSize(modAbs, name, svc)} `;
        if (svc.eponymousLoc !== null) {
          for (let i = 3; i < 6; i++)
            cells[i] = cells[i].replace(/service\s+\d+L/g, `service ${svc.eponymousLoc}L`);
        }
        out.push(cells.join('|'));
        continue;
      }
    }

    if (section === 'prisma' && /^\|\s*`migrations\/`\s*\|/.test(line)) {
      const cells = line.split('|');
      if (cells.length === 6) {
        cells[2] = ` ${migrationsCell()} `;
        out.push(cells.join('|'));
        continue;
      }
    }

    if (section === 'test' && /^\|\s*`e2e\/`\s*\|/.test(line)) {
      const cells = line.split('|');
      if (cells.length === 4) {
        cells[2] = ` E2E spec(${countE2eSpecs()} 个 \`*.e2e-spec.ts\`) `;
        out.push(cells.join('|'));
        continue;
      }
    }

    out.push(line);
  }

  return out.join('\n');
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function main(): void {
  const check = process.argv.includes('--check');
  const src = fs.readFileSync(CODEMAP, 'utf8');
  const next = generate(src);

  if (!check) {
    if (next === src) console.log('CODEMAP.md 已是最新,无改动');
    else {
      fs.writeFileSync(CODEMAP, next, 'utf8');
      console.log(`CODEMAP.md 已重写(${src.length} → ${next.length} 字符)`);
    }
    return;
  }

  if (next === src) {
    console.log('✓ CODEMAP.md 生成块与真源一致');
    return;
  }

  const a = src.split('\n');
  const b = next.split('\n');
  console.error('✗ CODEMAP.md 生成块已过期 —— 跑 `pnpm docs:codemap` 重新生成\n');
  let shown = 0;
  for (let i = 0; i < Math.max(a.length, b.length) && shown < 10; i++) {
    if (a[i] === b[i]) continue;
    shown++;
    console.error(`  第 ${i + 1} 行`);
    console.error(`    文档: ${(a[i] ?? '(缺行)').slice(0, 160)}`);
    console.error(`    真源: ${(b[i] ?? '(缺行)').slice(0, 160)}`);
  }
  process.exit(1);
}

main();
