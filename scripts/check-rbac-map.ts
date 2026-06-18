#!/usr/bin/env tsx
/**
 * check-rbac-map.ts — RBAC_MAP 漂移检查
 *
 * 用途:校验 docs/ai-harness/RBAC_MAP.md 声明、prisma/seed.ts 权限码、src/ 实际使用三方一致,
 * 输出 PASS / WARN / FAIL / INFO。只读检查,不修改任何文件,不接入 CI。
 * 沿 scripts/check-codemap.ts 范式(零依赖;承接 docs/ai-harness/NEXT_TASKS.md P1-1 立项)。
 *
 * 运行:`pnpm docs:rbacmap:check`
 *
 * 退出码:
 *   0 — 无 FAIL(WARN / INFO 不导致非 0)
 *   1 — 存在 FAIL(权限事实或地图结构性漂移)
 *
 * 检查项:
 *   A. seed-codes-extract        — seed 权限码可提取且非空(FAIL on empty)
 *   B. rbacmap-code-count        — RBAC_MAP.md 声明的权限码总数 vs seed 实际 (FAIL on drift)
 *   C. rbacmap-controller-count  — RBAC_MAP.md 声明的 controller 数 vs src 实际 (FAIL on drift)
 *   D. controller-prefix-canonical — 全部 @Controller 前缀落在 4 canonical 前缀 (FAIL on violation)
 *   E. direct-call-codes-seeded  — rbac.can()/judge() 同行字面量码必须在 seed 中 (FAIL on miss)
 *   F. seed-codes-referenced     — seed 码在 src 中有字面量引用或被动态模板前缀覆盖 (WARN on orphan)
 *   G. swagger-auth-suffix       — @ApiOperation summary 鉴权后缀(P2-2 惯例)与装饰器/seed 一致
 *                                  (FAIL on 缺失 / @Roles-@Public 不符 / rbac 码不在 seed)
 *
 * 已知边界(刻意,如需更强保证再立项):
 *   - 权限码经 helper 间接传参(assertCan(user, 'x.y.z'))由 F 的全源字面量扫描覆盖;
 *     E 只覆盖 rbac.can(/judge( 同行直调形态,不解析跨行/变量传参。
 *   - attachments 等动态拼接(`attachment.upload.${...}`)按模板字面量前缀识别(INFO 列出)。
 *   - 扫描前仅剥离 // 行注释(本仓库注释惯例),避免注释中的示例码被记作"已引用";
 *     块注释**不**剥离——正则剥块注释会被字符串/注释里的 MIME 通配符 `type/*` 误触
 *     (实测踩坑:attachment-mime-configs.service.ts);块注释内示例码会被记作已引用,接受该边界。
 *   - seed 新增权限码必须保持 `code: '<literal>'` 或 `*_CODE = '<literal>'` 形态,否则 A 会漏提取。
 *   - G 校验 `[roles:]`/`[public]` 与装饰器严格互证、`[rbac:]` 码(含 `<family>.*` 通配族)必在 seed;
 *     但**不**解析 service 调用链,即不校验"该方法实际调的码 = 后缀声明的码"(同 E 的边界);
 *     `[auth]`(仅登录)只要求该方法无 @Roles/@Public。summary 形态须为单行字面量或
 *     `summary:` 换行后单行字面量(prettier reflow 形态),超出此约定按 FAIL 提示同步提取器。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

type Severity = 'PASS' | 'WARN' | 'FAIL' | 'INFO';

interface CheckResult {
  id: string;
  severity: Severity;
  summary: string;
  details?: string[];
}

const repoRoot = process.cwd();
const seedRelPath = 'prisma/seed.ts';
const rbacMapRelPath = 'docs/ai-harness/RBAC_MAP.md';
// 招新一期(招新前段)T3(2026-06-18):open/v1 首用——无账号公开报名 surface(api-surface-policy §0
// 「预留→首用」解锁;第 5 canonical 前缀,与 test/contract/openapi.contract-spec.ts CANONICAL_PREFIXES 同步)。
const CANONICAL_PREFIXES = ['admin/v1', 'app/v1', 'auth/v1', 'system/v1', 'open/v1'] as const;

// 权限码形态:小写字母/中横线段,至少一个点分隔(与 seed 实际码型一致)。
const CODE_SHAPE = '[a-z][a-z-]*(?:\\.[a-z-]+)+';

// ---------------------------------------------------------------------------
// File loaders
// ---------------------------------------------------------------------------

function readRepoFile(relPath: string): string {
  const abs = path.join(repoRoot, relPath);
  return fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '';
}

function listSourceFiles(dirRel: string): string[] {
  const out: string[] = [];
  const walk = (abs: string): void => {
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      const child = path.join(abs, entry.name);
      if (entry.isDirectory()) {
        walk(child);
      } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')) {
        out.push(path.relative(repoRoot, child).split(path.sep).join('/'));
      }
    }
  };
  const rootAbs = path.join(repoRoot, dirRel);
  if (fs.existsSync(rootAbs)) walk(rootAbs);
  return out.sort();
}

// 剥离 // 行注释:"行首 //"与"空白后 //"两种形态(字符串内 'https://...' 无前置空白,不受影响)。
// 不剥块注释:见文件头"已知边界"——`type/*` MIME 通配符会误触块注释正则。
function stripComments(source: string): string {
  return source.replace(/^\s*\/\/.*$/gm, '').replace(/(\s)\/\/.*$/gm, '$1');
}

// ---------------------------------------------------------------------------
// Extractors
// ---------------------------------------------------------------------------

function extractSeedCodes(seedSource: string): Set<string> {
  const codes = new Set<string>();
  const propRe = new RegExp(`code:\\s*'(${CODE_SHAPE})'`, 'g');
  const constRe = new RegExp(`_CODE\\s*=\\s*'(${CODE_SHAPE})'`, 'g');
  for (const re of [propRe, constRe]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(seedSource)) !== null) codes.add(m[1]);
  }
  return codes;
}

interface ControllerDecl {
  relPath: string;
  prefix: string;
}

function extractControllers(files: string[]): ControllerDecl[] {
  const out: ControllerDecl[] = [];
  const re = /^@Controller\(\s*'([^']+)'/gm;
  for (const relPath of files) {
    const source = stripComments(readRepoFile(relPath));
    let m: RegExpExecArray | null;
    re.lastIndex = 0;
    while ((m = re.exec(source)) !== null) {
      out.push({ relPath, prefix: m[1] });
    }
  }
  return out;
}

// RBAC_MAP.md 声明计数:沿文档固定措辞("权限码全集(N 条" / "(N 个 controller")。
function parseDeclaredCount(doc: string, re: RegExp): number | null {
  const m = re.exec(doc);
  return m ? parseInt(m[1], 10) : null;
}

interface SrcScan {
  literalCodes: Set<string>; // 全源字面量码(剥注释后)
  directCallCodes: Map<string, string[]>; // rbac.can(/judge( 同行字面量码 → 出现文件
  dynamicPrefixes: Map<string, string[]>; // 模板字面量动态前缀(如 attachment.upload.)→ 出现文件
}

function scanSources(files: string[]): SrcScan {
  const literalCodes = new Set<string>();
  const directCallCodes = new Map<string, string[]>();
  const dynamicPrefixes = new Map<string, string[]>();
  const literalRe = new RegExp(`'(${CODE_SHAPE})'`, 'g');
  const directRe = new RegExp(`(?:rbac|this)\\.(?:can|judge)\\([^)\\n]*'(${CODE_SHAPE})'`, 'g');
  const dynamicRe = new RegExp('`(' + CODE_SHAPE + '\\.)\\$\\{', 'g');

  for (const relPath of files) {
    const source = stripComments(readRepoFile(relPath));
    let m: RegExpExecArray | null;
    literalRe.lastIndex = 0;
    while ((m = literalRe.exec(source)) !== null) literalCodes.add(m[1]);
    directRe.lastIndex = 0;
    while ((m = directRe.exec(source)) !== null) {
      const list = directCallCodes.get(m[1]) ?? [];
      list.push(relPath);
      directCallCodes.set(m[1], list);
    }
    dynamicRe.lastIndex = 0;
    while ((m = dynamicRe.exec(source)) !== null) {
      const list = dynamicPrefixes.get(m[1]) ?? [];
      list.push(relPath);
      dynamicPrefixes.set(m[1], list);
    }
  }
  return { literalCodes, directCallCodes, dynamicPrefixes };
}

interface EndpointSuffix {
  relPath: string;
  className: string;
  method: string;
  summary: string | null;
  suffix: string | null; // 原样后缀,如 '[rbac: org.read.node]'
  hasPublic: boolean;
  roles: string | null; // 归一化实参,如 'SUPER_ADMIN,ADMIN'
}

// 配对每个 @ApiOperation 的 summary 与同方法装饰器(@Public / @Roles)。
// 形态约定见文件头"已知边界"G 条;controller 方法签名按 2 空格缩进识别。
function extractEndpointSuffixes(files: string[]): EndpointSuffix[] {
  const out: EndpointSuffix[] = [];
  const suffixRe = /\[(rbac: [^\]]+|roles: [^\]]+|public|auth)\]$/;
  for (const relPath of files.filter((f) => f.endsWith('.controller.ts'))) {
    const lines = stripComments(readRepoFile(relPath)).split('\n');
    let cls = '';
    let hasOp = false;
    let inOp = false;
    let wantNext = false;
    let summary: string | null = null;
    let pub = false;
    let roles: string | null = null;
    const reset = (): void => {
      hasOp = false;
      inOp = false;
      wantNext = false;
      summary = null;
      pub = false;
      roles = null;
    };
    for (const raw of lines) {
      const t = raw.trim();
      const cm = /^export class (\w+)/.exec(t);
      if (cm) {
        cls = cm[1];
        reset();
        continue;
      }
      if (/^@ApiOperation/.test(t)) {
        hasOp = true;
        inOp = true;
      }
      if (inOp) {
        if (wantNext) {
          const m = /^'((?:[^'\\]|\\.)*)',?$/.exec(t);
          if (m) {
            summary = m[1];
            wantNext = false;
          }
        } else if (/summary:/.test(t)) {
          const m = /summary:\s*'((?:[^'\\]|\\.)*)'/.exec(t);
          if (m) summary = m[1];
          else wantNext = true;
        }
        if (/\}\)/.test(t) && summary !== null) inOp = false;
      }
      const rm = /^@Roles\(([^)]*)\)/.exec(t);
      if (rm) roles = rm[1].replace(/Role\./g, '').replace(/\s+/g, '');
      if (/^@Public\(\)/.test(t)) pub = true;
      const mm = /^  (?:async )?([a-zA-Z0-9_]+)(?:<[^>]*>)?\(/.exec(raw);
      if (mm && !t.startsWith('@') && hasOp) {
        const sm = summary === null ? null : suffixRe.exec(summary);
        out.push({
          relPath,
          className: cls,
          method: mm[1],
          summary,
          suffix: sm ? `[${sm[1]}]` : null,
          hasPublic: pub,
          roles,
        });
        reset();
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

function checkSeedCodesExtract(codes: Set<string>): CheckResult {
  if (codes.size === 0) {
    return {
      id: 'seed-codes-extract',
      severity: 'FAIL',
      summary: `0 permission codes extracted from ${seedRelPath}(提取形态约定可能被破坏)`,
    };
  }
  return {
    id: 'seed-codes-extract',
    severity: 'PASS',
    summary: `${codes.size} permission code(s) extracted from ${seedRelPath}`,
  };
}

function checkDeclaredCount(
  id: string,
  label: string,
  declared: number | null,
  actual: number,
): CheckResult {
  if (declared === null) {
    return {
      id,
      severity: 'FAIL',
      summary: `${rbacMapRelPath} 未找到${label}声明(实际 ${actual});请同步该文档`,
    };
  }
  if (declared !== actual) {
    return {
      id,
      severity: 'FAIL',
      summary: `${label}漂移:${rbacMapRelPath} 声明 ${declared},实际 ${actual}`,
    };
  }
  return { id, severity: 'PASS', summary: `${label} ${actual},与 ${rbacMapRelPath} 声明一致` };
}

function checkCanonicalPrefixes(controllers: ControllerDecl[]): CheckResult {
  const violations = controllers.filter(
    (c) => !CANONICAL_PREFIXES.some((p) => c.prefix === p || c.prefix.startsWith(`${p}/`)),
  );
  if (violations.length === 0) {
    return {
      id: 'controller-prefix-canonical',
      severity: 'PASS',
      summary: `${controllers.length}/${controllers.length} @Controller 前缀均落 4 canonical 前缀`,
    };
  }
  return {
    id: 'controller-prefix-canonical',
    severity: 'FAIL',
    summary: `${violations.length} 个 @Controller 前缀不在 canonical 前缀内(Route B 终态约束)`,
    details: violations.map((v) => `${v.relPath}: @Controller('${v.prefix}')`),
  };
}

function checkDirectCallCodesSeeded(scan: SrcScan, seedCodes: Set<string>): CheckResult {
  const missing = [...scan.directCallCodes.entries()].filter(([code]) => !seedCodes.has(code));
  if (missing.length === 0) {
    return {
      id: 'direct-call-codes-seeded',
      severity: 'PASS',
      summary: `${scan.directCallCodes.size} 个直调字面量码均存在于 seed`,
    };
  }
  return {
    id: 'direct-call-codes-seeded',
    severity: 'FAIL',
    summary: `${missing.length} 个直调字面量码不在 seed 中(运行时将对所有人返 30100)`,
    details: missing.map(([code, where]) => `'${code}' @ ${[...new Set(where)].join(', ')}`),
  };
}

function checkSeedCodesReferenced(scan: SrcScan, seedCodes: Set<string>): CheckResult[] {
  const prefixes = [...scan.dynamicPrefixes.keys()];
  const orphans: string[] = [];
  let dynamicCovered = 0;
  for (const code of [...seedCodes].sort()) {
    if (scan.literalCodes.has(code)) continue;
    if (prefixes.some((p) => code.startsWith(p))) {
      dynamicCovered++;
      continue;
    }
    orphans.push(code);
  }
  const results: CheckResult[] = [];
  if (prefixes.length > 0) {
    results.push({
      id: 'dynamic-prefixes-found',
      severity: 'INFO',
      summary: `${prefixes.length} 个动态模板前缀(覆盖 ${dynamicCovered} 条 seed 码)`,
      details: prefixes
        .sort()
        .map(
          (p) => `\`${p}\${...}\` @ ${[...new Set(scan.dynamicPrefixes.get(p) ?? [])].join(', ')}`,
        ),
    });
  }
  if (orphans.length === 0) {
    results.push({
      id: 'seed-codes-referenced',
      severity: 'PASS',
      summary: `${seedCodes.size} 条 seed 码全部被 src 字面量或动态前缀覆盖`,
    });
  } else {
    results.push({
      id: 'seed-codes-referenced',
      severity: 'WARN',
      summary: `${orphans.length} 条 seed 码在 src 无字面量引用且不被动态前缀覆盖(孤码候选,可能是刻意预埋)`,
      details: orphans,
    });
  }
  return results;
}

function checkSwaggerAuthSuffix(endpoints: EndpointSuffix[], seedCodes: Set<string>): CheckResult {
  const problems: string[] = [];
  for (const e of endpoints) {
    const at = `${e.relPath} :: ${e.className}.${e.method}`;
    if (e.summary === null) {
      problems.push(`${at}:summary 无法提取(形态超出提取器约定,见文件头 G 边界)`);
      continue;
    }
    if (e.suffix === null) {
      problems.push(`${at}:summary 缺少鉴权后缀`);
      continue;
    }
    if (e.hasPublic) {
      if (e.suffix !== '[public]') problems.push(`${at}:@Public 但后缀为 ${e.suffix}`);
      continue;
    }
    if (e.suffix === '[public]') {
      problems.push(`${at}:后缀 [public] 但无 @Public`);
      continue;
    }
    if (e.roles !== null) {
      if (e.suffix !== `[roles: ${e.roles}]`)
        problems.push(`${at}:@Roles(${e.roles}) 但后缀为 ${e.suffix}`);
      continue;
    }
    if (e.suffix.startsWith('[roles:')) {
      problems.push(`${at}:后缀 ${e.suffix} 但无 @Roles`);
      continue;
    }
    if (e.suffix === '[auth]') continue; // 仅登录:无 @Roles/@Public,无静态可绑码
    const rm = /^\[rbac: (.+)\]$/.exec(e.suffix);
    if (!rm) {
      problems.push(`${at}:后缀形态无法识别 ${e.suffix}`);
      continue;
    }
    const code = rm[1];
    if (code.endsWith('.*')) {
      const prefix = code.slice(0, -1); // 'attachment.upload.'
      if (![...seedCodes].some((c) => c.startsWith(prefix)))
        problems.push(`${at}:通配族 ${code} 无任何 seed 码匹配`);
    } else if (!seedCodes.has(code)) {
      problems.push(`${at}:[rbac: ${code}] 不在 seed 权限码中`);
    }
  }
  if (problems.length === 0) {
    return {
      id: 'swagger-auth-suffix',
      severity: 'PASS',
      summary: `${endpoints.length} 个 @ApiOperation 鉴权后缀与装饰器/seed 一致(P2-2 惯例)`,
    };
  }
  return {
    id: 'swagger-auth-suffix',
    severity: 'FAIL',
    summary: `${problems.length} 处 summary 鉴权后缀缺失 / 与实际鉴权不一致`,
    details: problems,
  };
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function printResult(r: CheckResult): void {
  console.log(`[${r.severity}] ${r.id} (${r.summary})`);
  if (r.details && r.details.length > 0) {
    for (const d of r.details) {
      console.log(`  - ${d}`);
    }
  }
}

function printSummary(results: CheckResult[]): void {
  const tally = { PASS: 0, WARN: 0, FAIL: 0, INFO: 0 };
  for (const r of results) tally[r.severity]++;
  console.log('');
  console.log(
    `Summary: ${tally.FAIL} FAIL, ${tally.WARN} WARN, ${tally.INFO} INFO, ${tally.PASS} PASS`,
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  const seedSource = readRepoFile(seedRelPath);
  const rbacMapDoc = readRepoFile(rbacMapRelPath);
  if (seedSource === '' || rbacMapDoc === '') {
    console.log(`[FAIL] inputs-exist (${seedRelPath} 或 ${rbacMapRelPath} 不存在/为空)`);
    console.log('');
    console.log('Summary: 1 FAIL, 0 WARN, 0 INFO, 0 PASS');
    process.exitCode = 1;
    return;
  }

  const seedCodes = extractSeedCodes(seedSource);
  const srcFiles = listSourceFiles('src');
  const controllers = extractControllers(srcFiles);
  const scan = scanSources(srcFiles);

  const results: CheckResult[] = [
    checkSeedCodesExtract(seedCodes),
    checkDeclaredCount(
      'rbacmap-code-count',
      '权限码总数',
      parseDeclaredCount(rbacMapDoc, /权限码全集\((\d+)\s*条/),
      seedCodes.size,
    ),
    checkDeclaredCount(
      'rbacmap-controller-count',
      'controller 数',
      parseDeclaredCount(rbacMapDoc, /\((\d+)\s*个 controller class/),
      controllers.length,
    ),
    checkCanonicalPrefixes(controllers),
    checkDirectCallCodesSeeded(scan, seedCodes),
    ...checkSeedCodesReferenced(scan, seedCodes),
    checkSwaggerAuthSuffix(extractEndpointSuffixes(srcFiles), seedCodes),
  ];

  for (const r of results) printResult(r);
  printSummary(results);

  const hasFail = results.some((r) => r.severity === 'FAIL');
  process.exitCode = hasFail ? 1 : 0;
}

main();
