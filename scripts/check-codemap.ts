#!/usr/bin/env tsx
/**
 * check-codemap.ts — CODEMAP 漂移检查
 *
 * 用途:扫描 CODEMAP.md 与当前源码结构的漂移,输出 PASS / WARN / FAIL / INFO。
 * 只读检查,不修改任何文件,不接入 CI。
 *
 * 运行:`pnpm docs:codemap:check`
 *
 * 退出码:
 *   0 — 无 FAIL(WARN / INFO 不导致非 0)
 *   1 — 存在 FAIL(模块结构性漂移)
 *
 * 检查项:
 *   A. modules-in-codemap         — src/modules/* 是否都在 CODEMAP 表格中 (FAIL on miss)
 *   B. codemap-modules-real       — CODEMAP 模块是否真实存在 (FAIL on stale)
 *   C. claude-md-referenced       — 已存在 module-local CLAUDE.md 是否在 CODEMAP 中被引用 (WARN)
 *   D. service-loc-*              — service LOC 阈值与声明漂移 (WARN / INFO)
 *   E. referenced-paths-exist     — CODEMAP 中相对路径 markdown 链接是否存在 (WARN)
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
const codemapRelPath = 'CODEMAP.md';
const codemapAbsPath = path.join(repoRoot, codemapRelPath);

// ---------------------------------------------------------------------------
// File loaders
// ---------------------------------------------------------------------------

function readCodemap(): string {
  if (!fs.existsSync(codemapAbsPath)) {
    return '';
  }
  return fs.readFileSync(codemapAbsPath, 'utf8');
}

function listRealModules(): string[] {
  const modulesDir = path.join(repoRoot, 'src', 'modules');
  if (!fs.existsSync(modulesDir)) return [];
  return fs
    .readdirSync(modulesDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

// Matches `wc -l` semantics: count trailing newlines, not split segments.
function countLines(content: string): number {
  const m = content.match(/\n/g);
  return m ? m.length : 0;
}

function listClaudeMdUnderDirs(parentRelDirs: string[]): string[] {
  const found: string[] = [];
  for (const parentRel of parentRelDirs) {
    const parentAbs = path.join(repoRoot, parentRel);
    if (!fs.existsSync(parentAbs)) continue;
    for (const entry of fs.readdirSync(parentAbs, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const claudeAbs = path.join(parentAbs, entry.name, 'CLAUDE.md');
      if (fs.existsSync(claudeAbs)) {
        const rel = path.relative(repoRoot, claudeAbs).split(path.sep).join('/');
        found.push(rel);
      }
    }
  }
  return found.sort();
}

interface ServiceEntry {
  relPath: string;
  module: string;
  basename: string;
  loc: number;
}

function listServiceFiles(): ServiceEntry[] {
  const modulesDir = path.join(repoRoot, 'src', 'modules');
  if (!fs.existsSync(modulesDir)) return [];
  const out: ServiceEntry[] = [];
  for (const dir of fs.readdirSync(modulesDir, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const modAbs = path.join(modulesDir, dir.name);
    for (const f of fs.readdirSync(modAbs, { withFileTypes: true })) {
      if (!f.isFile() || !f.name.endsWith('.service.ts')) continue;
      const abs = path.join(modAbs, f.name);
      const loc = countLines(fs.readFileSync(abs, 'utf8'));
      out.push({
        relPath: path.relative(repoRoot, abs).split(path.sep).join('/'),
        module: dir.name,
        basename: f.name,
        loc,
      });
    }
  }
  return out.sort((a, b) => b.loc - a.loc);
}

// ---------------------------------------------------------------------------
// CODEMAP parsers
// ---------------------------------------------------------------------------

const MODULES_SECTION_RE = /^##\s+src\/modules\//;
const ANY_SECTION_RE = /^##\s+/;
const MODULE_ROW_RE = /^\|\s*`([a-z0-9-]+)\/`/;
const SERVICE_LOC_RE = /service\s+(\d+)L/;
const MD_LINK_RE = /\[[^\]]*\]\(([^)]+)\)/g;

function* iterModulesSection(codemap: string): Generator<string> {
  const lines = codemap.split('\n');
  let inside = false;
  for (const line of lines) {
    if (MODULES_SECTION_RE.test(line)) {
      inside = true;
      continue;
    }
    if (inside && ANY_SECTION_RE.test(line)) return;
    if (inside) yield line;
  }
}

function parseCodemapModules(codemap: string): string[] {
  const out: string[] = [];
  for (const line of iterModulesSection(codemap)) {
    const m = MODULE_ROW_RE.exec(line);
    if (m) out.push(m[1]);
  }
  return out;
}

function parseCodemapDeclaredServiceLoc(codemap: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const line of iterModulesSection(codemap)) {
    const modMatch = MODULE_ROW_RE.exec(line);
    if (!modMatch) continue;
    const locMatch = SERVICE_LOC_RE.exec(line);
    if (locMatch) out.set(modMatch[1], parseInt(locMatch[1], 10));
  }
  return out;
}

function extractRelativeLinks(codemap: string): string[] {
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  // Reset state for safety in case the regex was reused.
  MD_LINK_RE.lastIndex = 0;
  while ((m = MD_LINK_RE.exec(codemap)) !== null) {
    let target = m[1].trim();
    if (target === '') continue;
    if (/^https?:\/\//i.test(target)) continue;
    if (target.startsWith('#')) continue;
    if (target.startsWith('mailto:')) continue;
    const hashIdx = target.indexOf('#');
    if (hashIdx >= 0) target = target.slice(0, hashIdx);
    if (target === '') continue;
    seen.add(target);
  }
  return [...seen].sort();
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

function checkModulesInCodemap(real: string[], declared: string[]): CheckResult {
  const declaredSet = new Set(declared);
  const missing = real.filter((m) => !declaredSet.has(m));
  if (missing.length === 0) {
    return {
      id: 'modules-in-codemap',
      severity: 'PASS',
      summary: `${real.length}/${real.length} present`,
    };
  }
  return {
    id: 'modules-in-codemap',
    severity: 'FAIL',
    summary: `${missing.length} real module(s) missing from CODEMAP`,
    details: missing.map((m) => `src/modules/${m}/ (exists on disk, not in CODEMAP)`),
  };
}

function checkCodemapModulesReal(real: string[], declared: string[]): CheckResult {
  const realSet = new Set(real);
  const stale = declared.filter((m) => !realSet.has(m));
  if (stale.length === 0) {
    return {
      id: 'codemap-modules-real',
      severity: 'PASS',
      summary: `${declared.length}/${declared.length} exist`,
    };
  }
  return {
    id: 'codemap-modules-real',
    severity: 'FAIL',
    summary: `${stale.length} stale module(s) in CODEMAP`,
    details: stale.map((m) => `src/modules/${m}/ (in CODEMAP, not on disk)`),
  };
}

function checkClaudeMdReferenced(claudeMdPaths: string[], codemap: string): CheckResult {
  const unreferenced = claudeMdPaths.filter((p) => !codemap.includes(p));
  if (claudeMdPaths.length === 0) {
    return {
      id: 'claude-md-referenced',
      severity: 'PASS',
      summary: 'no module-local CLAUDE.md to check',
    };
  }
  if (unreferenced.length === 0) {
    return {
      id: 'claude-md-referenced',
      severity: 'PASS',
      summary: `${claudeMdPaths.length}/${claudeMdPaths.length} referenced`,
    };
  }
  return {
    id: 'claude-md-referenced',
    severity: 'WARN',
    summary: `${unreferenced.length} unreferenced (of ${claudeMdPaths.length})`,
    details: unreferenced,
  };
}

function checkServiceLoc(
  services: ServiceEntry[],
  declared: Map<string, number>,
): CheckResult[] {
  const results: CheckResult[] = [];

  const god = services.filter((s) => s.loc > 700);
  const large = services.filter((s) => s.loc > 500 && s.loc <= 700);

  if (god.length === 0) {
    results.push({
      id: 'service-loc-godservice',
      severity: 'PASS',
      summary: 'no service file exceeds 700 lines',
    });
  } else {
    results.push({
      id: 'service-loc-godservice',
      severity: 'WARN',
      summary: `${god.length} god-service candidate(s) (LOC > 700)`,
      details: god.map((s) => `${s.relPath}: ${s.loc} lines`),
    });
  }

  if (large.length > 0) {
    results.push({
      id: 'service-loc-large',
      severity: 'INFO',
      summary: `${large.length} large service(s) (500 < LOC <= 700)`,
      details: large.map((s) => `${s.relPath}: ${s.loc} lines`),
    });
  }

  const drift: string[] = [];
  for (const [moduleName, declaredLoc] of declared) {
    const expectedRel = `src/modules/${moduleName}/${moduleName}.service.ts`;
    const actual = services.find((s) => s.relPath === expectedRel);
    if (!actual) continue;
    const diff = actual.loc - declaredLoc;
    if (Math.abs(diff) > 100) {
      const sign = diff >= 0 ? '+' : '';
      drift.push(
        `${expectedRel}: CODEMAP declares ${declaredLoc}L, actual ${actual.loc}L (drift ${sign}${diff}L)`,
      );
    }
  }
  if (drift.length > 0) {
    results.push({
      id: 'service-loc-declared-drift',
      severity: 'WARN',
      summary: `${drift.length} declared service LOC drift > 100 lines`,
      details: drift,
    });
  }

  return results;
}

function checkReferencedPathsExist(codemap: string): CheckResult {
  const targets = extractRelativeLinks(codemap);
  const missing: string[] = [];
  for (const target of targets) {
    const abs = path.join(repoRoot, target);
    if (!fs.existsSync(abs)) missing.push(target);
  }
  if (missing.length === 0) {
    return {
      id: 'referenced-paths-exist',
      severity: 'PASS',
      summary: `${targets.length} relative link(s) all resolve`,
    };
  }
  return {
    id: 'referenced-paths-exist',
    severity: 'WARN',
    summary: `${missing.length} broken relative link(s) (of ${targets.length})`,
    details: missing,
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
  if (!fs.existsSync(codemapAbsPath)) {
    console.log(`[FAIL] codemap-exists (CODEMAP.md not found at ${codemapAbsPath})`);
    console.log('');
    console.log('Summary: 1 FAIL, 0 WARN, 0 INFO, 0 PASS');
    process.exitCode = 1;
    return;
  }

  const codemap = readCodemap();
  const realModules = listRealModules();
  const declaredModules = parseCodemapModules(codemap);
  const claudeMdPaths = listClaudeMdUnderDirs(['src/modules', 'src/common']);
  const services = listServiceFiles();
  const declaredServiceLoc = parseCodemapDeclaredServiceLoc(codemap);

  const results: CheckResult[] = [
    checkModulesInCodemap(realModules, declaredModules),
    checkCodemapModulesReal(realModules, declaredModules),
    checkClaudeMdReferenced(claudeMdPaths, codemap),
    ...checkServiceLoc(services, declaredServiceLoc),
    checkReferencedPathsExist(codemap),
  ];

  for (const r of results) printResult(r);
  printSummary(results);

  const hasFail = results.some((r) => r.severity === 'FAIL');
  process.exitCode = hasFail ? 1 : 0;
}

main();
