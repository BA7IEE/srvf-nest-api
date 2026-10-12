import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { ESLint } from 'eslint';

// Full, uncached lint through serial original CLI calls for the three original root globs.
// Reporting remains partitioned; config, projects, rules, heap and window stay fixed.
export const COLD_LINT_PATTERNS = ['src/**/*.ts', 'test/**/*.ts', 'prisma/**/*.ts'];
export const COLD_LINT_BATCH_SIZE = 300;
export const COLD_LINT_WINDOW_MS = 300_000;
const ROOTS = ['src', 'test', 'prisma'];
const PROJECTS = ['./tsconfig.json', './test/tsconfig.test.json', './prisma/tsconfig.eslint.json'];
const OUTPUT_LIMIT = 64 * 1024 * 1024;

class ColdLintFailure extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'ColdLintFailure';
  }
}
function requireCondition(value: unknown, code: string): asserts value {
  if (!value) throw new ColdLintFailure(code);
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function integer(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function digest(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}
function posix(value: string): string {
  return value.split(sep).join('/');
}
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (!record(item)) return item;
    return Object.fromEntries(
      Object.keys(item)
        .sort()
        .map((key) => [key, item[key]]),
    );
  });
}

export function coldLintPlan(files: readonly string[]): string[][] {
  requireCondition(files.length > 0, 'EMPTY_INPUT');
  requireCondition(new Set(files).size === files.length, 'DUPLICATE_INPUT');
  requireCondition(
    files.every(
      (file) => /^(src|test|prisma)\/.+\.ts$/u.test(file) && !file.split('/').includes('..'),
    ),
    'OUTSIDE_ORIGINAL_GLOBS',
  );
  requireCondition(
    ROOTS.every((root) => files.some((file) => file.startsWith(root + '/'))),
    'EMPTY_GLOB',
  );
  const ordered = ROOTS.flatMap((root) =>
    files.filter((file) => file.startsWith(root + '/')).sort(),
  );
  const result: string[][] = [];
  for (let offset = 0; offset < ordered.length; offset += COLD_LINT_BATCH_SIZE)
    result.push(ordered.slice(offset, offset + COLD_LINT_BATCH_SIZE));
  return result;
}

interface Diagnostic {
  file: string;
  ruleId: string | null;
  severity: number;
  line: number | null;
  column: number | null;
  endLine: number | null;
  endColumn: number | null;
  messageHash: string;
}
interface Report {
  files: string[];
  errors: number;
  warnings: number;
  diagnostics: Diagnostic[];
}
interface ChildResult {
  stdout: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  spawnFailed?: boolean;
}

export function coldLintReport(
  root: string,
  expected: readonly string[],
  child: ChildResult,
): Report {
  requireCondition(!child.spawnFailed, 'CHILD_SPAWN');
  requireCondition(!child.timedOut, 'WINDOW_EXCEEDED');
  requireCondition(child.signal === null, 'CHILD_SIGNAL');
  requireCondition(child.code === 0 || child.code === 1, 'CHILD_EXIT');
  let rows: unknown;
  try {
    rows = JSON.parse(child.stdout);
  } catch {
    throw new ColdLintFailure('INVALID_REPORT_JSON');
  }
  requireCondition(Array.isArray(rows) && rows.length > 0, 'EMPTY_REPORT');
  const files: string[] = [];
  const diagnostics: Diagnostic[] = [];
  let errors = 0;
  let warnings = 0;
  const reportRows: readonly unknown[] = rows;
  for (const row of reportRows) {
    requireCondition(
      record(row) &&
        typeof row.filePath === 'string' &&
        isAbsolute(row.filePath) &&
        integer(row.errorCount) &&
        integer(row.warningCount) &&
        Array.isArray(row.messages),
      'INVALID_REPORT_ROW',
    );
    requireCondition(row.output === undefined, 'UNEXPECTED_FIX_OUTPUT');
    const file = posix(relative(root, row.filePath));
    requireCondition(expected.includes(file), 'UNKNOWN_REPORT_FILE');
    requireCondition(!files.includes(file), 'DUPLICATE_REPORT_FILE');
    files.push(file);
    let countedErrors = 0;
    let countedWarnings = 0;
    const messages: readonly unknown[] = row.messages;
    for (const message of messages) {
      requireCondition(
        record(message) &&
          (message.severity === 1 || message.severity === 2) &&
          (typeof message.ruleId === 'string' || message.ruleId === null) &&
          typeof message.message === 'string',
        'INVALID_DIAGNOSTIC',
      );
      if (message.severity === 2) countedErrors += 1;
      else countedWarnings += 1;
      const location = (key: string) => {
        const value = message[key];
        requireCondition(value === undefined || integer(value), 'INVALID_DIAGNOSTIC_LOCATION');
        return value === undefined ? null : value;
      };
      diagnostics.push({
        file,
        ruleId: message.ruleId,
        severity: message.severity,
        line: location('line'),
        column: location('column'),
        endLine: location('endLine'),
        endColumn: location('endColumn'),
        messageHash: digest(message.message),
      });
    }
    requireCondition(
      countedErrors === row.errorCount && countedWarnings === row.warningCount,
      'COUNT_MISMATCH',
    );
    errors += countedErrors;
    warnings += countedWarnings;
  }
  requireCondition(
    files.length === expected.length && expected.every((file) => files.includes(file)),
    'MISSING_REPORT_FILE',
  );
  requireCondition(child.code === (errors + warnings > 0 ? 1 : 0), 'EXIT_DIAGNOSTIC_MISMATCH');
  return { files, errors, warnings, diagnostics };
}

export function coldLintRootReports(
  root: string,
  expected: readonly string[],
  children: readonly ChildResult[],
  outputLimit = OUTPUT_LIMIT,
): Report {
  requireCondition(children.length === ROOTS.length, 'ROOT_REPORT_COUNT');
  requireCondition(
    integer(outputLimit) && outputLimit > 0 && outputLimit <= OUTPUT_LIMIT,
    'REPORT_LIMIT',
  );
  const total: Report = { files: [], errors: 0, warnings: 0, diagnostics: [] };
  let bytes = 0;
  for (const [index, child] of children.entries()) {
    bytes += Buffer.byteLength(child.stdout, 'utf8');
    requireCondition(bytes <= outputLimit, 'REPORT_LIMIT');
    const files = expected.filter((file) => file.startsWith(ROOTS[index] + '/'));
    requireCondition(files.length > 0, 'EMPTY_GLOB');
    const report = coldLintReport(root, files, child);
    total.files.push(...report.files);
    total.errors += report.errors;
    total.warnings += report.warnings;
    total.diagnostics.push(...report.diagnostics);
  }
  requireCondition(
    total.files.length === expected.length &&
      new Set(total.files).size === expected.length &&
      expected.every((file) => total.files.includes(file)),
    'FULL_COVERAGE_MISSING',
  );
  return total;
}

function walk(root: string, folder: string): string[] {
  const output: string[] = [];
  for (const entry of readdirSync(resolve(root, folder), { withFileTypes: true })) {
    const file = posix(folder + '/' + entry.name);
    // No silent differences from the original glob jurisdiction.
    requireCondition(!entry.isSymbolicLink(), 'SYMLINK_JURISDICTION_UNPROVED');
    if (entry.isDirectory()) output.push(...walk(root, file));
    else if (entry.isFile()) output.push(file);
  }
  return output;
}

async function manifest(root: string, eslint: ESLint): Promise<string[]> {
  const files: string[] = [];
  // ESLint's glob matcher has dot:true. Include dot files/directories, then use
  // the public original-config ignore decision for every .ts candidate.
  for (const folder of ROOTS) {
    for (const file of walk(root, folder)
      .filter((name) => name.endsWith('.ts'))
      .sort()) {
      if (!(await eslint.isPathIgnored(resolve(root, file)))) files.push(file);
    }
  }
  coldLintPlan(files);
  return files;
}

function inputSeal(root: string): string {
  // scripts participate in imported TS graphs but are NOT added to lint scope.
  const paths = [
    ...[...ROOTS, 'scripts'].flatMap((folder) =>
      walk(root, folder).filter((file) => file.endsWith('.ts')),
    ),
    ...walk(root, 'eslint-rules').filter((file) => file.endsWith('.mjs')),
    ...walk(root, 'harness').filter((file) => file.endsWith('.json')),
    'eslint.config.mjs',
    'eslint.harness.mjs',
    'package.json',
    'pnpm-lock.yaml',
    'tsconfig.json',
    'test/tsconfig.test.json',
    'prisma/tsconfig.eslint.json',
    'docs/ai-harness/ROUTE_AUTHZ.md',
  ].sort();
  return digest(
    paths.map((file) => file + '\0' + digest(readFileSync(resolve(root, file)))).join('\n'),
  );
}

function assertInputUnchanged(before: string, after: string): void {
  requireCondition(before === after, 'INPUT_CHANGED');
}

async function configSeal(root: string, eslint: ESLint, files: readonly string[]): Promise<string> {
  const descriptions: unknown[] = [];
  for (const file of files) {
    const value: unknown = await eslint.calculateConfigForFile(resolve(root, file));
    requireCondition(record(value) && record(value.languageOptions), 'CONFIG_MISSING');
    const language = value.languageOptions;
    requireCondition(
      record(language.parserOptions) && record(language.parser),
      'TYPE_CONFIG_MISSING',
    );
    requireCondition(
      canonical(language.parserOptions.project) === canonical(PROJECTS),
      'PROJECT_LIST_CHANGED',
    );
    requireCondition(language.parserOptions.tsconfigRootDir === root, 'PROJECT_ROOT_CHANGED');
    requireCondition(
      language.parserOptions.projectService === undefined &&
        language.parserOptions.programs === undefined,
      'PROGRAM_SCOPE_CHANGED',
    );
    requireCondition(
      record(language.parser.meta) && record(value.plugins),
      'PARSER_OR_PLUGINS_MISSING',
    );
    descriptions.push({
      file,
      rules: value.rules,
      settings: value.settings,
      linterOptions: value.linterOptions,
      language: {
        sourceType: language.sourceType,
        ecmaVersion: language.ecmaVersion,
        globals: language.globals,
        parserOptions: language.parserOptions,
        parser: language.parser.meta,
      },
      plugins: Object.keys(value.plugins),
    });
  }
  return digest(canonical(descriptions));
}

async function runCli(
  root: string,
  files: readonly string[],
  deadline: number,
): Promise<ChildResult> {
  requireCondition(Date.now() < deadline, 'WINDOW_EXCEEDED');
  const cli = resolve(dirname(require.resolve('eslint/package.json')), 'bin/eslint.js');
  // This suffix is also typescript-estree's original automatic single-run
  // inference. Do not invoke the parser through a new in-process API host.
  requireCondition(posix(cli).endsWith('/node_modules/eslint/bin/eslint.js'), 'CLI_HOST_CHANGED');
  return new Promise((resolveResult, reject) => {
    const child = spawn(
      process.execPath,
      ['--max-old-space-size=6144', cli, '--max-warnings', '0', '--format', 'json', ...files],
      {
        cwd: root,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let bytes = 0;
    const chunks: Buffer[] = [];
    let timedOut = false;
    let exceeded = false;
    let forceTimer: NodeJS.Timeout | undefined;
    const stop = () => {
      child.kill('SIGTERM');
      forceTimer ??= setTimeout(() => child.kill('SIGKILL'), 2_000);
    };
    const interrupt = () => {
      timedOut = true;
      stop();
    };
    const timer = setTimeout(interrupt, Math.max(1, deadline - Date.now()));
    process.once('SIGINT', interrupt);
    process.once('SIGTERM', interrupt);
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > OUTPUT_LIMIT) {
        exceeded = true;
        stop();
      } else chunks.push(chunk);
    });
    // Never retain/print stderr: rule/parser failures can contain source text.
    child.stderr.resume();
    const finish = () => {
      clearTimeout(timer);
      if (forceTimer !== undefined) clearTimeout(forceTimer);
      process.removeListener('SIGINT', interrupt);
      process.removeListener('SIGTERM', interrupt);
    };
    child.once('error', () => {
      finish();
      resolveResult({ stdout: '', code: null, signal: null, timedOut, spawnFailed: true });
    });
    child.once('close', (code, signal) => {
      finish();
      if (exceeded) reject(new ColdLintFailure('REPORT_LIMIT'));
      else
        resolveResult({ stdout: Buffer.concat(chunks).toString('utf8'), code, signal, timedOut });
    });
  });
}

export async function runColdLint(root: string): Promise<Report> {
  const started = Date.now();
  const deadline = started + COLD_LINT_WINDOW_MS;
  const phase = (
    name: 'MANIFEST' | 'INPUT_SEAL' | 'CONFIG_SEAL' | 'CLI_START' | 'CLI_END',
    files: number,
    child?: ChildResult,
  ) =>
    console.info(
      'COLD_LINT_PHASE',
      JSON.stringify({
        phase: name,
        files,
        elapsedMs: Date.now() - started,
        ...(child ? { code: child.code, signal: child.signal, timedOut: child.timedOut } : {}),
      }),
    );
  const eslint = new ESLint({ cwd: root });
  const files = await manifest(root, eslint);
  phase('MANIFEST', files.length);
  const before = inputSeal(root);
  phase('INPUT_SEAL', files.length);
  const config = await configSeal(root, eslint, files);
  phase('CONFIG_SEAL', files.length);
  const batches = coldLintPlan(files);
  assertInputUnchanged(before, inputSeal(root));
  // The original globs avoid argument limits and retain the original CLI host.
  // Validate the complete report against the independently sealed jurisdiction.
  const children: ChildResult[] = [];
  let outputBytes = 0;
  for (const [index, pattern] of COLD_LINT_PATTERNS.entries()) {
    const selected = files.filter((file) => file.startsWith(ROOTS[index] + '/'));
    assertInputUnchanged(before, inputSeal(root));
    phase('CLI_START', selected.length);
    const child = await runCli(root, [pattern], deadline);
    phase('CLI_END', selected.length, child);
    outputBytes += Buffer.byteLength(child.stdout, 'utf8');
    requireCondition(outputBytes <= OUTPUT_LIMIT, 'REPORT_LIMIT');
    // Reject a failed/missing/duplicate root before starting the next CLI.
    coldLintReport(root, selected, child);
    children.push(child);
  }
  const total = coldLintRootReports(root, files, children);
  for (const [index, batch] of batches.entries()) {
    const diagnostics = total.diagnostics.filter((row) => batch.includes(row.file));
    console.info(
      'COLD_LINT_BATCH',
      JSON.stringify({
        batch: index + 1,
        batches: batches.length,
        files: batch.length,
        errors: diagnostics.filter((row) => row.severity === 2).length,
        warnings: diagnostics.filter((row) => row.severity === 1).length,
        elapsedMs: Date.now() - started,
      }),
    );
  }
  requireCondition(Date.now() <= deadline, 'WINDOW_EXCEEDED');
  assertInputUnchanged(before, inputSeal(root));
  requireCondition(
    canonical(await manifest(root, eslint)) === canonical(files),
    'JURISDICTION_CHANGED',
  );
  requireCondition((await configSeal(root, eslint, files)) === config, 'CONFIG_CHANGED');
  requireCondition(Date.now() <= deadline, 'WINDOW_EXCEEDED');
  requireCondition(
    new Set(total.files).size === files.length && total.files.length === files.length,
    'FULL_COVERAGE_MISSING',
  );
  for (const item of total.diagnostics)
    console.info(
      'COLD_LINT_DIAGNOSTIC',
      JSON.stringify({
        file: item.file,
        ruleId: item.ruleId,
        severity: item.severity,
        line: item.line,
        column: item.column,
      }),
    );
  console.info(
    'COLD_LINT_COMPLETE',
    JSON.stringify({
      files: total.files.length,
      batches: batches.length,
      errors: total.errors,
      warnings: total.warnings,
      elapsedMs: Date.now() - started,
      inputSeal: before,
      configSeal: config,
    }),
  );
  requireCondition(total.errors === 0 && total.warnings === 0, 'RULE_DIAGNOSTICS');
  return total;
}

export async function proveColdLintEquivalence(root: string): Promise<void> {
  const samples = [
    'src/modules/activities/activities.controller.ts',
    'src/common/datetime/clock-authority.spec.ts',
    'test/helpers/activity-contribution-policy.fixture.ts',
    'prisma/seed.ts',
  ];
  const eslint = new ESLint({ cwd: root });
  const all = await manifest(root, eslint);
  requireCondition(
    samples.every((file) => all.includes(file)),
    'EQUIVALENCE_SAMPLE_MISSING',
  );
  const before = inputSeal(root);
  const config = await configSeal(root, eslint, samples);
  const deadline = Date.now() + COLD_LINT_WINDOW_MS;
  const original = coldLintReport(root, samples, await runCli(root, samples, deadline));
  const separate: Diagnostic[] = [];
  for (const file of samples)
    separate.push(
      ...coldLintReport(root, [file], await runCli(root, [file], deadline)).diagnostics,
    );
  const ordered = (items: Diagnostic[]) => items.map(canonical).sort();
  requireCondition(
    canonical(ordered(original.diagnostics)) === canonical(ordered(separate)),
    'DIAGNOSTIC_EQUIVALENCE_FAILED',
  );
  requireCondition(
    inputSeal(root) === before && (await configSeal(root, eslint, samples)) === config,
    'EQUIVALENCE_INPUT_CHANGED',
  );
  console.info(
    'COLD_LINT_EQUIVALENCE',
    JSON.stringify({
      samples,
      diagnostics: original.diagnostics.length,
      configSeal: config,
      inputSeal: before,
    }),
  );
}

export interface ColdLintSelfCheck {
  name: string;
  passed: boolean;
}
export function coldLintSelfChecks(): ColdLintSelfCheck[] {
  const root = resolve('/cold-lint-selfcheck');
  const names = ['src/a.ts', 'test/b.ts', 'prisma/c.ts'];
  const zero = (file: string) => ({
    filePath: resolve(root, file),
    errorCount: 0,
    warningCount: 0,
    messages: [],
  });
  const child = (rows: unknown, extra: Partial<ChildResult> = {}): ChildResult => ({
    stdout: JSON.stringify(rows),
    code: 0,
    signal: null,
    timedOut: false,
    ...extra,
  });
  const checks: ColdLintSelfCheck[] = [];
  const yes = (name: string, run: () => boolean) => {
    try {
      checks.push({ name, passed: run() });
    } catch {
      checks.push({ name, passed: false });
    }
  };
  const no = (name: string, code: string, run: () => unknown) =>
    yes(name, () => {
      try {
        run();
        return false;
      } catch (error) {
        return error instanceof ColdLintFailure && error.code === code;
      }
    });
  yes(
    'complete original-glob plan',
    () => canonical(coldLintPlan([...names].reverse()).flat()) === canonical(names),
  );
  const many = Array.from(
    { length: 701 },
    (_, index) => 'src/' + String(index).padStart(4, '0') + '.ts',
  ).concat(names.slice(1));
  yes('fixed serial batches cover every file exactly once', () => {
    const plan = coldLintPlan(many);
    return (
      plan.length === 3 &&
      plan.every((batch) => batch.length <= 300) &&
      canonical(plan.flat()) === canonical(many) &&
      new Set(plan.flat()).size === many.length
    );
  });
  no('empty input fails', 'EMPTY_INPUT', () => coldLintPlan([]));
  no('duplicate input fails', 'DUPLICATE_INPUT', () => coldLintPlan([...names, names[0]]));
  no('outside input fails', 'OUTSIDE_ORIGINAL_GLOBS', () =>
    coldLintPlan([...names, 'scripts/x.ts']),
  );
  no('traversal input fails', 'OUTSIDE_ORIGINAL_GLOBS', () =>
    coldLintPlan([...names, 'src/../x.ts']),
  );
  no('missing original glob fails', 'EMPTY_GLOB', () => coldLintPlan(names.slice(0, 2)));
  yes(
    'complete zero-diagnostic report passes',
    () => coldLintReport(root, names, child(names.map(zero))).files.length === 3,
  );
  no('empty scan fails', 'EMPTY_REPORT', () => coldLintReport(root, names, child([])));
  no('duplicate result fails', 'DUPLICATE_REPORT_FILE', () =>
    coldLintReport(root, names, child([...names.map(zero), zero(names[0])])),
  );
  no('missing result fails', 'MISSING_REPORT_FILE', () =>
    coldLintReport(root, names, child(names.slice(0, 2).map(zero))),
  );
  no('unknown result fails', 'UNKNOWN_REPORT_FILE', () =>
    coldLintReport(root, names, child([...names.map(zero), zero('src/extra.ts')])),
  );
  no('nonzero process failure fails', 'CHILD_EXIT', () =>
    coldLintReport(root, names, child(names.map(zero), { code: 2 })),
  );
  no('signal and OOM fail', 'CHILD_SIGNAL', () =>
    coldLintReport(root, names, child(names.map(zero), { code: null, signal: 'SIGABRT' })),
  );
  no('interruption and deadline fail', 'WINDOW_EXCEEDED', () =>
    coldLintReport(root, names, child(names.map(zero), { timedOut: true })),
  );
  no('damaged JSON fails', 'INVALID_REPORT_JSON', () =>
    coldLintReport(root, names, child([], { stdout: '{' })),
  );
  no('invalid result shape fails', 'INVALID_REPORT_ROW', () =>
    coldLintReport(root, names, child([{ filePath: 'src/a.ts' }])),
  );
  no('unexpected fixer output fails', 'UNEXPECTED_FIX_OUTPUT', () =>
    coldLintReport(root, names, child([{ ...zero(names[0]), output: 'changed' }])),
  );
  no('unreported process error fails', 'EXIT_DIAGNOSTIC_MISMATCH', () =>
    coldLintReport(root, names, child(names.map(zero), { code: 1 })),
  );
  const error = {
    ruleId: 'test-rule',
    severity: 2,
    message: 'fixed red control',
    line: 1,
    column: 1,
  };
  const warning = { ...error, severity: 1 };
  const red = [
    { ...zero(names[0]), errorCount: 1, messages: [error] },
    ...names.slice(1).map(zero),
  ];
  const amber = [
    { ...zero(names[0]), warningCount: 1, messages: [warning] },
    ...names.slice(1).map(zero),
  ];
  yes(
    'rule errors remain nonzero diagnostics',
    () => coldLintReport(root, names, child(red, { code: 1 })).errors === 1,
  );
  yes(
    'warnings remain nonzero diagnostics',
    () => coldLintReport(root, names, child(amber, { code: 1 })).warnings === 1,
  );
  no('warning cannot silently exit zero', 'EXIT_DIAGNOSTIC_MISMATCH', () =>
    coldLintReport(root, names, child(amber)),
  );
  no('message counts cannot disagree', 'COUNT_MISMATCH', () =>
    coldLintReport(root, names, child([{ ...zero(names[0]), errorCount: 1 }])),
  );
  no('invalid severity fails', 'INVALID_DIAGNOSTIC', () =>
    coldLintReport(
      root,
      names,
      child([{ ...zero(names[0]), messages: [{ ...error, severity: 0 }] }]),
    ),
  );
  no('invalid location fails', 'INVALID_DIAGNOSTIC_LOCATION', () =>
    coldLintReport(
      root,
      names,
      child([{ ...zero(names[0]), messages: [{ ...error, line: 'bad' }] }]),
    ),
  );
  yes('unchanged input fingerprint passes', () => {
    assertInputUnchanged(digest('same'), digest('same'));
    return true;
  });
  no('input fingerprint change fails', 'INPUT_CHANGED', () =>
    assertInputUnchanged(digest('before'), digest('after')),
  );
  no('spawn failures fail closed', 'CHILD_SPAWN', () =>
    coldLintReport(root, names, child(names.map(zero), { spawnFailed: true })),
  );
  const roots = names.map((name) => child([zero(name)]));
  yes(
    'serial root reports equal the original complete report',
    () =>
      canonical(coldLintRootReports(root, names, roots)) ===
      canonical(coldLintReport(root, names, child(names.map(zero)))),
  );
  no('missing root report fails', 'ROOT_REPORT_COUNT', () =>
    coldLintRootReports(root, names, roots.slice(0, 2)),
  );
  no('wrong root report fails', 'UNKNOWN_REPORT_FILE', () =>
    coldLintRootReports(root, names, [roots[1], roots[0], roots[2]]),
  );
  no('duplicate within root fails', 'DUPLICATE_REPORT_FILE', () =>
    coldLintRootReports(root, names, [child([zero(names[0]), zero(names[0])]), ...roots.slice(1)]),
  );
  no('later root signal fails', 'CHILD_SIGNAL', () =>
    coldLintRootReports(root, names, [roots[0], { ...roots[1], signal: 'SIGABRT' }, roots[2]]),
  );
  no('later root deadline fails', 'WINDOW_EXCEEDED', () =>
    coldLintRootReports(root, names, [roots[0], { ...roots[1], timedOut: true }, roots[2]]),
  );
  no('cumulative output cap retained across roots', 'REPORT_LIMIT', () =>
    coldLintRootReports(
      root,
      names,
      roots,
      roots.reduce((sum, item) => sum + Buffer.byteLength(item.stdout, 'utf8'), 0) - 1,
    ),
  );
  no('output cap cannot be widened', 'REPORT_LIMIT', () =>
    coldLintRootReports(root, names, roots, OUTPUT_LIMIT + 1),
  );
  return checks;
}

if (require.main === module) {
  const root = process.cwd();
  const argument = process.argv[2];
  const main = async () => {
    requireCondition(process.argv.length <= 3, 'UNSUPPORTED_ARGUMENTS');
    if (argument === '--selftest') {
      const checks = coldLintSelfChecks();
      for (const check of checks) console.info('COLD_LINT_SELFCHECK', JSON.stringify(check));
      requireCondition(
        checks.length >= 27 && checks.every((check) => check.passed),
        'SELFCHECK_FAILED',
      );
    } else if (argument === '--prove-equivalence') await proveColdLintEquivalence(root);
    else {
      requireCondition(argument === undefined, 'UNSUPPORTED_ARGUMENTS');
      await runColdLint(root);
    }
  };
  void main().catch((error: unknown) => {
    console.error(
      'COLD_LINT_FAIL',
      error instanceof ColdLintFailure ? error.code : 'UNCLASSIFIED_TOOL_FAILURE',
    );
    process.exitCode = 1;
  });
}
