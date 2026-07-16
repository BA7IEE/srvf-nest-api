/**
 * docs-counts.ts — current-state §1 计数块生成 / 校验(Harness 2.0 T0 §1.4 / d2)
 *
 * 把"事实计数"从人工维护改为脚本从真源数出,消灭计数漂移(历史在案三次:
 * migration 恒 49 实为 50、RBAC_MAP 76→191、模块 CLAUDE.md 9→11)。
 *
 * 真源(与既有守卫同口径,不另造第二套):
 *   模块          = src/modules 一级目录数
 *   Controller    = src/**\/*.controller.ts 文件数
 *   Endpoint      = test/contract/openapi.contract-spec.ts 的 EXPECTED_ROUTES 条目数,
 *                   并与该 spec 自身 toHaveLength(N) 断言交叉核对,不一致 → exit 2
 *   Migration     = prisma/migrations 一级目录数(migration_lock.toml 为文件不计)
 *   BizCode       = biz-code.constant.ts 内 `httpStatus:` 出现次数(每码恰一处,见 docs/reference/response-pagination-errors.md)
 *   权限码        = prisma/seed.ts 权限码集合大小;注释剥离 + code:'…' / *_CODE='…'
 *                   双正则镜像 scripts/check-rbac-map.ts(同一口径)
 *   AuditLogEvent = audit-logs.types.ts 联合类型成员数
 *   内建角色      = prisma/seed.ts `rbacRole.upsert(` 出现次数
 *   Cron          = src/**\/*.ts 内 `@Cron(` 出现次数
 *
 * 模式:
 *   (无参)   打印计数表,不读写文档
 *   --write   docs/current-state.md 存在 counts 锚时重写锚间内容;无锚(PR3 接线前)提示后 exit 0
 *   --check   有锚 → 重新生成并逐字比对,不一致 exit 1;无锚 → 宽限跳过 exit 0
 *
 * 首跑若与文档存量数字不符:按 T0 §4 R6 属"发现存量漂移",上报拍板,不悄改。
 */

import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..');
const CURRENT_STATE = 'docs/current-state.md';
const BEGIN = '<!-- counts:begin -->';
const END = '<!-- counts:end -->';

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf-8');
}

function listDirs(rel: string): string[] {
  return fs
    .readdirSync(path.join(ROOT, rel), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

function walkTsFiles(rel: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.ts')) out.push(p);
    }
  };
  walk(path.join(ROOT, rel));
  return out;
}

function countOccurrences(hay: string, needle: string): number {
  return hay.split(needle).length - 1;
}

// 注释剥离与权限码形状:镜像 scripts/check-rbac-map.ts(改那边须同步这边;seed 书写
// 契约见其头注:权限码必须保持 `code: '<literal>'` 或 `*_CODE = '<literal>'` 形态)
const CODE_SHAPE = "[a-z][a-z-]*(?:\\.[a-z-]+)+";

function stripComments(source: string): string {
  return source.replace(/^\s*\/\/.*$/gm, '').replace(/(\s)\/\/.*$/gm, '$1');
}

function countPermissions(seedSource: string): number {
  const src = stripComments(seedSource);
  const codes = new Set<string>();
  for (const re of [
    new RegExp(`code:\\s*'(${CODE_SHAPE})'`, 'g'),
    new RegExp(`_CODE\\s*=\\s*'(${CODE_SHAPE})'`, 'g'),
  ]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) codes.add(m[1]);
  }
  return codes.size;
}

function countEndpoints(): number {
  const src = read('test/contract/openapi.contract-spec.ts');
  const start = src.indexOf('const EXPECTED_ROUTES');
  const end = src.indexOf('\n];', start);
  if (start < 0 || end < 0) {
    throw new Error('EXPECTED_ROUTES 声明或结尾未找到(contract spec 结构变化,需同步本脚本)');
  }
  const entries = src.slice(start, end).match(/^\s*\[\s*'(get|post|put|patch|delete)'\s*,/gm) ?? [];
  const selfAssert = src.match(/EXPECTED_ROUTES\)\.toHaveLength\((\d+)\)/);
  if (selfAssert && Number(selfAssert[1]) !== entries.length) {
    process.stderr.write(
      `✗ contract spec 内部不一致:EXPECTED_ROUTES 条目 ${entries.length} ≠ toHaveLength(${selfAssert[1]})\n`,
    );
    process.exit(2);
  }
  return entries.length;
}

function countAuditEvents(): number {
  const lines = read('src/modules/audit-logs/audit-logs.types.ts').split('\n');
  const startIdx = lines.findIndex((l) => l.includes('export type AuditLogEvent'));
  if (startIdx < 0) throw new Error('AuditLogEvent 联合类型未找到');
  let n = 0;
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*\|\s*'[^']+'/.test(line)) {
      n += 1;
      // 末位成员以 ';' 收束(注释剥离后判断)→ 联合结束
      if (line.replace(/\/\/.*$/, '').includes(';')) break;
    } else if (/^\s*(\/\/.*)?$/.test(line)) {
      // 联合内插的分组注释行 / 空行:跳过不终止(实测 113 成员间夹多段注释)
      continue;
    } else {
      break;
    }
  }
  return n;
}

function gather(): ReadonlyArray<readonly [string, number]> {
  const srcFiles = walkTsFiles('src');
  const seedSource = read('prisma/seed.ts');
  let cron = 0;
  let controllers = 0;
  for (const f of srcFiles) {
    const content = fs.readFileSync(f, 'utf-8');
    cron += countOccurrences(content, '@Cron(');
    // 行首装饰器 = 顶层 controller 类;注释中的 `@Controller(` 提及不计
    // (实测 71 文件 / 93 全匹配 / 74 行首,与文档口径一致的是行首类数)
    controllers += (content.match(/^@Controller\(/gm) ?? []).length;
  }
  // 标签刻意精简:current-state 恒读预算紧张;各项真源与口径见本文件头注
  return [
    ['模块', listDirs('src/modules').length],
    ['Controller', controllers],
    ['Endpoint', countEndpoints()],
    ['Migration', listDirs('prisma/migrations').length],
    ['BizCode', countOccurrences(read('src/common/exceptions/biz-code.constant.ts'), 'httpStatus:')],
    ['权限码', countPermissions(seedSource)],
    ['AuditLogEvent', countAuditEvents()],
    ['内建角色', countOccurrences(seedSource, 'rbacRole.upsert(')],
    ['Cron', cron],
  ];
}

function renderBlock(rows: ReadonlyArray<readonly [string, number]>): string {
  const lines = [
    BEGIN,
    '<!-- 由 `pnpm docs:counts` 生成;禁止手改,`pnpm docs:counts:check` 守护 -->',
    '| 计数项 | 值 |',
    '|---|---|',
    ...rows.map(([k, v]) => `| ${k} | ${v} |`),
    END,
  ];
  return lines.join('\n');
}

function main(): void {
  const mode = process.argv[2] ?? '';
  const rows = gather();

  for (const [k, v] of rows) process.stdout.write(`${k}: ${v}\n`);
  if (mode !== '--write' && mode !== '--check') return;

  const doc = read(CURRENT_STATE);
  const b = doc.indexOf(BEGIN);
  const e = doc.indexOf(END);
  if (b < 0 || e < 0) {
    process.stdout.write('(counts 锚未接线 — PR3 前预期;跳过,exit 0)\n');
    return;
  }

  const block = renderBlock(rows);
  const existing = doc.slice(b, e + END.length);

  if (mode === '--check') {
    if (existing === block) {
      process.stdout.write('✓ counts 块与真源一致\n');
      return;
    }
    process.stderr.write('✗ counts 块与真源不一致(禁手改;跑 `pnpm docs:counts` 重生成)\n');
    process.stderr.write(`--- 文档现值 ---\n${existing}\n--- 真源应为 ---\n${block}\n`);
    process.exit(1);
  }

  if (existing === block) {
    process.stdout.write('✓ counts 块已是最新\n');
    return;
  }
  fs.writeFileSync(path.join(ROOT, CURRENT_STATE), doc.slice(0, b) + block + doc.slice(e + END.length));
  process.stdout.write('✓ counts 块已更新\n');
}

main();
