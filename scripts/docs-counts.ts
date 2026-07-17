/**
 * docs-counts.ts — current-state §1 计数块生成 / 校验(Harness 2.0 T0 §1.4 / d2)
 *
 * 把"事实计数"从人工维护改为脚本从真源数出,消灭计数漂移(历史在案三次:
 * migration 恒 49 实为 50、RBAC_MAP 76→191、模块 CLAUDE.md 9→11)。
 *
 * 提取方式(第五轮 review R5-02 起):词法 regex 改 TypeScript AST 真源计数——
 * 注释 / 字符串 / 模板字面量中的形似代码不再误计,`@Controller (` / 同行 union /
 * 双引号字面量等合法书写不再漏计;绕过样例回归测试:scripts/harness-guards.selftest.ts
 * (`pnpm tsx scripts/harness-guards.selftest.ts`)。
 *
 * 真源(与既有守卫同口径,不另造第二套):
 *   模块          = src/modules 一级目录数
 *   Controller    = src/**\/*.ts 中带 @Controller(...) 装饰器的 class 声明数
 *   Endpoint      = test/contract/openapi.contract-spec.ts 的 EXPECTED_ROUTES 数组元素数
 *                   (spread 元素无法静态计数 → 拒绝并要求同步;并与该 spec 自身
 *                   toHaveLength(N) 断言交叉核对,不一致 → exit 2)
 *   Migration     = prisma/migrations 一级目录数(migration_lock.toml 为文件不计)
 *   BizCode       = biz-code.constant.ts 内 `httpStatus` 属性赋值数(每码恰一处,见 docs/reference/response-pagination-errors.md)
 *   权限码        = prisma/seed.ts 权限码集合大小(AST:`code: '…'` 属性 + `*_CODE` 常量;
 *                   同时保留 scripts/check-rbac-map.ts 镜像正则做第二口径交叉校验,
 *                   双口径分歧 → exit 2 —— 守住 seed 书写契约并强制两守卫同步)
 *   AuditLogEvent = audit-logs.types.ts `AuditLogEvent` 联合类型字符串成员数(同行 / 多行书写均可)
 *   内建角色      = prisma/seed.ts `*.rbacRole.upsert(…)` 调用数
 *   Cron          = src/**\/*.ts 中 @Cron(...) 装饰器数
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
import * as ts from 'typescript';

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

// ---------------------------------------------------------------------------
// AST 提取器(导出供 scripts/harness-guards.selftest.ts 喂合成样例回归)
// ---------------------------------------------------------------------------

function parseSource(source: string): ts.SourceFile {
  return ts.createSourceFile('probe.ts', source, ts.ScriptTarget.Latest, true);
}

// 装饰器名:支持 `@Name(...)` / `@Name` / `@ns.Name(...)` 三形态
function decoratorName(dec: ts.Decorator): string | null {
  let expr: ts.Expression = dec.expression;
  if (ts.isCallExpression(expr)) expr = expr.expression;
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  return null;
}

// 一次解析同时数 @Controller class 与 @Cron 装饰器(两者共扫 src/**/*.ts)
export function countDecoratorUsage(source: string): { controllers: number; cron: number } {
  const sf = parseSource(source);
  let controllers = 0;
  let cron = 0;
  const visit = (node: ts.Node): void => {
    if (ts.canHaveDecorators(node)) {
      for (const dec of ts.getDecorators(node) ?? []) {
        const name = decoratorName(dec);
        if (name === 'Controller' && ts.isClassDeclaration(node)) controllers += 1;
        else if (name === 'Cron') cron += 1;
      }
    }
    node.forEachChild(visit);
  };
  visit(sf);
  return { controllers, cron };
}

export function countHttpStatusProps(source: string): number {
  const sf = parseSource(source);
  let n = 0;
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAssignment(node) &&
      (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) &&
      node.name.text === 'httpStatus'
    ) {
      n += 1;
    }
    node.forEachChild(visit);
  };
  visit(sf);
  return n;
}

// 权限码形状:镜像 scripts/check-rbac-map.ts(改那边须同步这边;seed 书写契约见其头注)
const CODE_SHAPE = "[a-z][a-z-]*(?:\\.[a-z-]+)+";
const CODE_SHAPE_EXACT = new RegExp(`^${CODE_SHAPE}$`);

function literalText(node: ts.Expression): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return null;
}

// AST 口径:`code: '<literal>'` 对象属性 + `*_CODE = '<literal>'` 变量声明(引号风格不限)
export function extractSeedPermissionCodesAst(source: string): Set<string> {
  const sf = parseSource(source);
  const codes = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAssignment(node) &&
      (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) &&
      node.name.text === 'code'
    ) {
      const text = literalText(node.initializer);
      if (text !== null && CODE_SHAPE_EXACT.test(text)) codes.add(text);
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text.endsWith('_CODE') &&
      node.initializer !== undefined
    ) {
      const text = literalText(node.initializer);
      if (text !== null && CODE_SHAPE_EXACT.test(text)) codes.add(text);
    }
    node.forEachChild(visit);
  };
  visit(sf);
  return codes;
}

// 镜像口径:与 scripts/check-rbac-map.ts 逐字同款(剥 // 行注释 + 单引号双正则)。
// 只用于交叉校验,不作为计数真源。
function stripLineComments(source: string): string {
  return source.replace(/^\s*\/\/.*$/gm, '').replace(/(\s)\/\/.*$/gm, '$1');
}

export function extractSeedPermissionCodesLegacyRegex(source: string): Set<string> {
  const src = stripLineComments(source);
  const codes = new Set<string>();
  for (const re of [
    new RegExp(`code:\\s*'(${CODE_SHAPE})'`, 'g'),
    new RegExp(`_CODE\\s*=\\s*'(${CODE_SHAPE})'`, 'g'),
  ]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) codes.add(m[1]);
  }
  return codes;
}

export function diffSeedPermissionExtractions(seedSource: string): {
  ast: Set<string>;
  onlyAst: string[];
  onlyLegacy: string[];
} {
  const ast = extractSeedPermissionCodesAst(seedSource);
  const legacy = extractSeedPermissionCodesLegacyRegex(seedSource);
  const onlyAst = [...ast].filter((c) => !legacy.has(c)).sort();
  const onlyLegacy = [...legacy].filter((c) => !ast.has(c)).sort();
  return { ast, onlyAst, onlyLegacy };
}

export function countAuditLogEventMembers(source: string): number {
  const sf = parseSource(source);
  let result: number | null = null;
  const visit = (node: ts.Node): void => {
    if (ts.isTypeAliasDeclaration(node) && node.name.text === 'AuditLogEvent') {
      result = countUnionStringMembers(node.type);
    }
    node.forEachChild(visit);
  };
  visit(sf);
  if (result === null) throw new Error('AuditLogEvent 联合类型未找到');
  return result;
}

function countUnionStringMembers(t: ts.TypeNode): number {
  if (ts.isUnionTypeNode(t)) return t.types.reduce((acc, m) => acc + countUnionStringMembers(m), 0);
  if (ts.isParenthesizedTypeNode(t)) return countUnionStringMembers(t.type);
  if (ts.isLiteralTypeNode(t) && ts.isStringLiteral(t.literal)) return 1;
  throw new Error(
    `AuditLogEvent 联合含非字符串字面量成员(${ts.SyntaxKind[t.kind]}),需同步本脚本`,
  );
}

// 数 `<recv>.rbacRole.upsert(...)` 调用(注释 / 字符串中的同名文本不计)
export function countRbacRoleUpserts(source: string): number {
  const sf = parseSource(source);
  let n = 0;
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'upsert' &&
      ts.isPropertyAccessExpression(node.expression.expression) &&
      node.expression.expression.name.text === 'rbacRole'
    ) {
      n += 1;
    }
    node.forEachChild(visit);
  };
  visit(sf);
  return n;
}

// EXPECTED_ROUTES 数组元素数(元素形态不限:单/双引号 tuple、helper 调用均计 1;
// spread 无法静态展开 → 抛错要求平铺或同步脚本,拒绝静默漏计)
export function countExpectedRoutesInSource(source: string): number {
  const sf = parseSource(source);
  let arr: ts.ArrayLiteralExpression | undefined;
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'EXPECTED_ROUTES' &&
      node.initializer !== undefined
    ) {
      let init: ts.Expression = node.initializer;
      while (
        ts.isAsExpression(init) ||
        ts.isSatisfiesExpression(init) ||
        ts.isParenthesizedExpression(init)
      ) {
        init = init.expression;
      }
      if (ts.isArrayLiteralExpression(init)) arr = init;
    }
    node.forEachChild(visit);
  };
  visit(sf);
  if (!arr) {
    throw new Error('EXPECTED_ROUTES 数组字面量未找到(contract spec 结构变化,需同步本脚本)');
  }
  for (const el of arr.elements) {
    if (ts.isSpreadElement(el)) {
      throw new Error('EXPECTED_ROUTES 含 spread 元素,无法静态计数;请平铺路由或同步本脚本');
    }
  }
  return arr.elements.length;
}

// ---------------------------------------------------------------------------
// 计数装配
// ---------------------------------------------------------------------------

function countPermissions(seedSource: string): number {
  const { ast, onlyAst, onlyLegacy } = diffSeedPermissionExtractions(seedSource);
  if (onlyAst.length > 0 || onlyLegacy.length > 0) {
    process.stderr.write(
      '✗ seed 权限码双口径不一致(AST 真源 vs check-rbac-map 镜像正则)——多半是注释/字符串中的示例码、双引号或模板字面量书写;请按 seed 书写契约改回 `code: \'<literal>\'` 单引号形态,或同步 scripts/check-rbac-map.ts 后再同步本脚本\n',
    );
    if (onlyAst.length > 0) process.stderr.write(`  仅 AST 提到:${onlyAst.join(', ')}\n`);
    if (onlyLegacy.length > 0) process.stderr.write(`  仅镜像正则提到:${onlyLegacy.join(', ')}\n`);
    process.exit(2);
  }
  return ast.size;
}

function countEndpoints(): number {
  const src = read('test/contract/openapi.contract-spec.ts');
  const entries = countExpectedRoutesInSource(src);
  const selfAssert = src.match(/EXPECTED_ROUTES\)\.toHaveLength\((\d+)\)/);
  if (selfAssert && Number(selfAssert[1]) !== entries) {
    process.stderr.write(
      `✗ contract spec 内部不一致:EXPECTED_ROUTES 条目 ${entries} ≠ toHaveLength(${selfAssert[1]})\n`,
    );
    process.exit(2);
  }
  return entries;
}

function gather(): ReadonlyArray<readonly [string, number]> {
  const srcFiles = walkTsFiles('src');
  const seedSource = read('prisma/seed.ts');
  let cron = 0;
  let controllers = 0;
  for (const f of srcFiles) {
    const content = fs.readFileSync(f, 'utf-8');
    // 子串预筛只为省去无关文件的 AST 解析;真假由 AST 判定
    if (!content.includes('@Controller') && !content.includes('@Cron')) continue;
    const usage = countDecoratorUsage(content);
    controllers += usage.controllers;
    cron += usage.cron;
  }
  // 标签刻意精简:current-state 恒读预算紧张;各项真源与口径见本文件头注
  return [
    ['模块', listDirs('src/modules').length],
    ['Controller', controllers],
    ['Endpoint', countEndpoints()],
    ['Migration', listDirs('prisma/migrations').length],
    ['BizCode', countHttpStatusProps(read('src/common/exceptions/biz-code.constant.ts'))],
    ['权限码', countPermissions(seedSource)],
    ['AuditLogEvent', countAuditLogEventMembers(read('src/modules/audit-logs/audit-logs.types.ts'))],
    ['内建角色', countRbacRoleUpserts(seedSource)],
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

// 供 selftest 以 import 方式复用提取器;直跑(pnpm docs:counts[:check])才执行 main
if (require.main === module) main();
