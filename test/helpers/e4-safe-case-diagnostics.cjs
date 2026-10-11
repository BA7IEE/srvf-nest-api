'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const SCHEMA = 'srvf-e4-safe-case-diagnostics/v2';
const COUNT_KEYS = [
  'numPassedTests',
  'numFailedTests',
  'numPendingTests',
  'numTotalTestSuites',
  'numPassedTestSuites',
  'numFailedTestSuites',
  'numRuntimeErrorTestSuites',
];
const BIND_KEYS = ['head', 'run', 'attempt', 'stage'];
const CATEGORIES = [
  'ASSERTION',
  'TYPE_ERROR',
  'SYNTAX_ERROR',
  'TEST_TIMEOUT',
  'DATABASE_TRANSACTION',
  'DATABASE_REFERENCE',
  'DATABASE_RELATION',
  'DATABASE_TIMEOUT',
  'UNCLASSIFIED',
];
const REASONS = [
  'CATALOG',
  'BINDING',
  'SOURCE_HASH',
  'COUNTS',
  'CASE_LOCATION',
  'CASE_LIMIT',
  'ARTIFACT_LIMIT',
  'STRUCTURE',
];
const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
const exact = (value, keys) =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
const fail = (reason) => {
  throw new Error(reason);
};
function prepare(catalog, binding) {
  if (
    !exact(binding, BIND_KEYS) ||
    !/^[a-f0-9]{40}$/.test(binding.head) ||
    !/^[1-9]\d*$/.test(binding.run) ||
    !/^[1-9]\d*$/.test(binding.attempt) ||
    !['d0', 'n1-install', 'd3', 'd4', 'd5', 'd6-migration', 'd6-regression'].includes(binding.stage)
  )
    fail('BINDING');
  if (
    !exact(catalog, ['schema', 'sourceHead', 'files', 'cases']) ||
    catalog.schema !== 'srvf-e4-case-catalog/v1' ||
    catalog.sourceHead !== '2e5828715a9fd7238b7ab73416dcffa1d9f32efc' ||
    !Array.isArray(catalog.files) ||
    !Array.isArray(catalog.cases) ||
    catalog.files.length < 1 ||
    catalog.files.length > 2 ||
    catalog.cases.length < 1 ||
    catalog.cases.length > 10000
  )
    fail('CATALOG');
  const files = new Map(),
    cases = new Map();
  for (const item of catalog.files) {
    if (
      !exact(item, ['file', 'sha256']) ||
      typeof item.file !== 'string' ||
      !/^(?:test\/[a-zA-Z0-9_./-]+|fixture\.test\.cjs)$/.test(item.file) ||
      item.file.split('/').some((part) => part === '..' || part === '') ||
      !/^[a-f0-9]{64}$/.test(item.sha256) ||
      files.has(item.file)
    )
      fail('CATALOG');
    files.set(item.file, item.sha256);
  }
  for (const item of catalog.cases) {
    if (
      !exact(item, ['file', 'line', 'column', 'name']) ||
      !files.has(item.file) ||
      !Number.isSafeInteger(item.line) ||
      item.line < 1 ||
      !Number.isSafeInteger(item.column) ||
      item.column < 1 ||
      typeof item.name !== 'string' ||
      item.name.length < 1 ||
      item.name.length > 768 ||
      /[\r\n\0]/.test(item.name)
    )
      fail('CATALOG');
    const key = [item.file, item.line, item.column].join(':');
    if (cases.has(key)) fail('CATALOG');
    cases.set(key, item);
  }
  return { files, cases, catalogDigest: sha(JSON.stringify(catalog)) };
}
function category(details) {
  const values = Array.isArray(details) ? details : [details];
  const found = [];
  for (const error of values) {
    if (!error || typeof error !== 'object') continue;
    if (error.matcherResult && typeof error.matcherResult === 'object') found.push('ASSERTION');
    else if (error.name === 'TypeError') found.push('TYPE_ERROR');
    else if (error.name === 'SyntaxError') found.push('SYNTAX_ERROR');
    else if (error.name === 'TimeoutError') found.push('TEST_TIMEOUT');
    else if (error.code === 'P2028') found.push('DATABASE_TRANSACTION');
    else if (error.code === 'P2003' || error.code === '23503') found.push('DATABASE_REFERENCE');
    else if (error.code === '42P01') found.push('DATABASE_RELATION');
    else if (error.code === '57014') found.push('DATABASE_TIMEOUT');
  }
  const unique = [...new Set(found)];
  return unique.length === 1 ? unique[0] : 'UNCLASSIFIED';
}
function countsOf(result) {
  if (
    !result ||
    !COUNT_KEYS.every(
      (key) => Number.isSafeInteger(result[key]) && result[key] >= 0 && result[key] <= 10000,
    )
  )
    fail('COUNTS');
  return Object.fromEntries(COUNT_KEYS.map((key) => [key, result[key]]));
}
function build(result, catalog, binding, root) {
  let verifiedBinding = null;
  try {
    const ready = prepare(catalog, binding);
    verifiedBinding = { ...binding };
    for (const [file, digest] of ready.files) {
      const resolved = path.resolve(root, file);
      if (
        path.relative(root, resolved) !== file ||
        !fs.lstatSync(resolved).isFile() ||
        sha(fs.readFileSync(resolved)) !== digest
      )
        fail('SOURCE_HASH');
    }
    const counts = countsOf(result);
    if (
      !Array.isArray(result.testResults) ||
      result.testResults.length > counts.numTotalTestSuites ||
      counts.numTotalTestSuites > ready.files.size
    )
      fail('COUNTS');
    const failures = [],
      suiteFailures = [],
      seenSuites = new Set();
    let unknownCases = 0;
    let passed = 0,
      failed = 0,
      pending = 0,
      failedSuites = 0,
      runtimeSuites = 0,
      passedSuites = 0;
    const occurrences = new Map();
    for (const suite of result.testResults) {
      if (!suite || typeof suite.testFilePath !== 'string' || !Array.isArray(suite.testResults))
        fail('STRUCTURE');
      const file = path.relative(root, suite.testFilePath);
      if (!ready.files.has(file) || seenSuites.has(file)) fail('STRUCTURE');
      seenSuites.add(file);
      let suiteFailed = false;
      for (const test of suite.testResults) {
        const locationValid =
          exact(test.location, ['line', 'column']) &&
          Number.isSafeInteger(test.location.line) &&
          Number.isSafeInteger(test.location.column);
        const key = locationValid ? [file, test.location.line, test.location.column].join(':') : '';
        const entry = ready.cases.get(key);
        const occurrence = entry ? (occurrences.get(key) ?? 0) + 1 : 0;
        if (entry) occurrences.set(key, occurrence);
        if (test.status === 'passed') {
          passed++;
          continue;
        }
        if (['pending', 'todo', 'disabled'].includes(test.status)) {
          pending++;
          continue;
        }
        if (test.status !== 'failed') fail('STRUCTURE');
        failed++;
        suiteFailed = true;
        if (entry) {
          failures.push({
            ...entry,
            occurrence,
            catalogued: true,
            category: category(test.failureDetails),
          });
        } else {
          unknownCases++;
          failures.push({
            file,
            line: 0,
            column: 0,
            name: 'UNREVIEWED_' + String(failures.length + 1).padStart(4, '0'),
            occurrence: 1,
            catalogued: false,
            category: category(test.failureDetails),
          });
        }
        if (failures.length > 64) fail('CASE_LIMIT');
      }
      if (suite.testExecError) {
        runtimeSuites++;
        suiteFailed = true;
        suiteFailures.push({ file, category: category(suite.testExecError) });
      }
      if (suiteFailed) failedSuites++;
      else if (suite.testResults.some((test) => test.status === 'passed')) passedSuites++;
    }
    if (
      passed !== counts.numPassedTests ||
      failed !== counts.numFailedTests ||
      pending !== counts.numPendingTests ||
      failedSuites !== counts.numFailedTestSuites ||
      runtimeSuites !== counts.numRuntimeErrorTestSuites ||
      passedSuites !== counts.numPassedTestSuites
    )
      fail('COUNTS');
    const record = {
      schema: SCHEMA,
      status: unknownCases === 0 ? 'COMPLETE' : 'UNKNOWN',
      reason: unknownCases === 0 ? 'CASE_DIAGNOSTICS' : 'UNREVIEWED_CASES',
      binding: { ...binding },
      sourceHead: catalog.sourceHead,
      catalogDigest: ready.catalogDigest,
      sourceDigests: catalog.files.map((item) => ({ ...item })),
      counts,
      unexecutedSuites: counts.numTotalTestSuites - result.testResults.length,
      failures,
      suiteFailures,
    };
    if (Buffer.byteLength(JSON.stringify(record)) > 65536) fail('ARTIFACT_LIMIT');
    return record;
  } catch (error) {
    return {
      schema: SCHEMA,
      status: 'UNKNOWN',
      reason: REASONS.includes(error.message) ? error.message : 'STRUCTURE',
      binding: verifiedBinding,
      counts: null,
      failures: [],
      suiteFailures: [],
    };
  }
}
function validate(record, catalog, binding) {
  try {
    const ready = prepare(catalog, binding);
    if (
      exact(record, [
        'schema',
        'status',
        'reason',
        'binding',
        'counts',
        'failures',
        'suiteFailures',
      ]) &&
      record.schema === SCHEMA &&
      record.status === 'UNKNOWN' &&
      REASONS.includes(record.reason) &&
      record.counts === null &&
      Array.isArray(record.failures) &&
      record.failures.length === 0 &&
      Array.isArray(record.suiteFailures) &&
      record.suiteFailures.length === 0 &&
      exact(record.binding, BIND_KEYS) &&
      BIND_KEYS.every((key) => record.binding[key] === binding[key])
    )
      return true;
    if (
      !exact(record, [
        'schema',
        'status',
        'reason',
        'binding',
        'sourceHead',
        'catalogDigest',
        'sourceDigests',
        'counts',
        'unexecutedSuites',
        'failures',
        'suiteFailures',
      ]) ||
      record.schema !== SCHEMA ||
      !(
        (record.status === 'COMPLETE' && record.reason === 'CASE_DIAGNOSTICS') ||
        (record.status === 'UNKNOWN' && record.reason === 'UNREVIEWED_CASES')
      ) ||
      record.sourceHead !== catalog.sourceHead ||
      !exact(record.binding, BIND_KEYS) ||
      BIND_KEYS.some((key) => record.binding[key] !== binding[key]) ||
      record.catalogDigest !== ready.catalogDigest ||
      JSON.stringify(record.sourceDigests) !== JSON.stringify(catalog.files)
    )
      return false;
    const counts = countsOf(record.counts);
    if (
      !Number.isSafeInteger(record.unexecutedSuites) ||
      record.unexecutedSuites < 0 ||
      record.unexecutedSuites > counts.numTotalTestSuites ||
      counts.numTotalTestSuites > ready.files.size ||
      counts.numPassedTestSuites + counts.numFailedTestSuites + record.unexecutedSuites >
        counts.numTotalTestSuites
    )
      return false;
    if (
      !Array.isArray(record.failures) ||
      record.failures.length > 64 ||
      record.failures.length !== counts.numFailedTests ||
      !Array.isArray(record.suiteFailures) ||
      record.suiteFailures.length !== counts.numRuntimeErrorTestSuites ||
      Buffer.byteLength(JSON.stringify(record)) > 65536
    )
      return false;
    const occurrences = new Map(),
      suiteFiles = new Set();
    let unknownCases = 0,
      index = 0;
    for (const item of record.failures) {
      index++;
      if (
        !exact(item, ['file', 'line', 'column', 'name', 'occurrence', 'catalogued', 'category']) ||
        !CATEGORIES.includes(item.category)
      )
        return false;
      if (item.catalogued === false) {
        if (
          !ready.files.has(item.file) ||
          item.line !== 0 ||
          item.column !== 0 ||
          item.occurrence !== 1 ||
          item.name !== 'UNREVIEWED_' + String(index).padStart(4, '0')
        )
          return false;
        unknownCases++;
        continue;
      }
      if (item.catalogued !== true) return false;
      const key = [item.file, item.line, item.column].join(':'),
        entry = ready.cases.get(key);
      if (
        !entry ||
        item.name !== entry.name ||
        item.file !== entry.file ||
        item.line !== entry.line ||
        item.column !== entry.column
      )
        return false;
      if (
        !Number.isSafeInteger(item.occurrence) ||
        item.occurrence < 1 ||
        item.occurrence > 10000 ||
        item.occurrence <= (occurrences.get(key) ?? 0)
      )
        return false;
      occurrences.set(key, item.occurrence);
    }
    for (const item of record.suiteFailures) {
      if (
        !exact(item, ['file', 'category']) ||
        !ready.files.has(item.file) ||
        !CATEGORIES.includes(item.category) ||
        suiteFiles.has(item.file)
      )
        return false;
      suiteFiles.add(item.file);
    }
    if ((unknownCases === 0) !== (record.status === 'COMPLETE')) return false;
    if (
      new Set([
        ...record.failures.map((item) => item.file),
        ...record.suiteFailures.map((item) => item.file),
      ]).size !== counts.numFailedTestSuites
    )
      return false;
    return true;
  } catch {
    return false;
  }
}
function unknown(binding, reason = 'STRUCTURE') {
  let safe = null;
  if (
    exact(binding, BIND_KEYS) &&
    /^[a-f0-9]{40}$/.test(binding.head) &&
    /^[1-9]\d*$/.test(binding.run) &&
    /^[1-9]\d*$/.test(binding.attempt) &&
    binding.stage === 'd0'
  )
    safe = { ...binding };
  return {
    schema: SCHEMA,
    status: 'UNKNOWN',
    reason: REASONS.includes(reason) ? reason : 'STRUCTURE',
    binding: safe,
    counts: null,
    failures: [],
    suiteFailures: [],
  };
}

const cp = require('node:child_process');
async function child(args, env, capMs, capture = false) {
  const proc = cp.spawn('pnpm', args, {
    env: { ...process.env, ...env },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let bytes = 0,
    exceeded = false,
    timedOut = false,
    stdout = '';
  let stdoutBytes = 0,
    stderrBytes = 0;
  const drain = (part, keep, stream) => {
    const size = Buffer.byteLength(part);
    if (stream === 'stdout') stdoutBytes = Math.min(65537, stdoutBytes + size);
    else stderrBytes = Math.min(65537, stderrBytes + size);
    bytes += size;
    if (bytes > 65536) exceeded = true;
    else if (keep) stdout += part.toString();
  };
  proc.stdout.on('data', (part) => drain(part, capture, 'stdout'));
  proc.stderr.on('data', (part) => drain(part, false, 'stderr'));
  const kill = (signal) => {
    try {
      process.kill(-proc.pid, signal);
    } catch {
      proc.kill(signal);
    }
  };
  let force;
  const timer = setTimeout(() => {
    timedOut = true;
    kill('SIGTERM');
    force = setTimeout(() => kill('SIGKILL'), 2000);
  }, capMs);
  const outcome = await new Promise((resolve) => {
    proc.once('error', () => resolve({ exitCode: null, signaled: false, spawnError: true }));
    proc.once('close', (exitCode, signal) =>
      resolve({ exitCode, signaled: signal !== null, spawnError: false }),
    );
  });
  clearTimeout(timer);
  clearTimeout(force);
  return { ...outcome, exceeded, timedOut, stdout, stdoutBytes, stderrBytes };
}

function closedJestFile(file) {
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    return { fileState: error.code === 'ENOENT' ? 'MISSING' : 'READ_ERROR' };
  }
  if (!stat.isFile()) return { fileState: 'NON_REGULAR' };
  if (stat.size === 0) return { fileState: 'EMPTY' };
  if (stat.size > 2097152) return { fileState: 'TOO_LARGE' };
  let value;
  try {
    value = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { fileState: 'INVALID_JSON' };
  }
  if (
    value === null ||
    value.schema !== 'srvf-e4-closed-jest/v1' ||
    value.binding === null ||
    typeof value.binding !== 'object' ||
    value.binding.head !== process.env.GITHUB_SHA ||
    value.binding.run !== process.env.GITHUB_RUN_ID ||
    value.binding.attempt !== process.env.GITHUB_RUN_ATTEMPT ||
    value.binding.stage !== stage
  )
    return { fileState: 'BINDING_REFUSED' };
  if (
    typeof value.success !== 'boolean' ||
    !Array.isArray(value.testResults) ||
    value.testResults.some(
      (suite) =>
        suite === null ||
        !Array.isArray(suite.assertionResults) ||
        suite.assertionResults.some(
          (test) =>
            test === null ||
            typeof test.fullName !== 'string' ||
            !['passed', 'failed', 'pending', 'todo', 'disabled'].includes(test.status),
        ),
    )
  )
    return { fileState: 'SCHEMA_REFUSED' };
  return { fileState: 'VALID', value };
}

class E4D0Reporter {
  onRunComplete(_contexts, result) {
    const file = process.env.SRVF_E4_CLOSED_JEST_FILE;
    const directory = process.env.SRVF_E4_GITHUB_PRIVATE_DIR;
    if (
      typeof file !== 'string' ||
      typeof directory !== 'string' ||
      path.dirname(file) !== directory
    )
      throw Error('closed reporter destination refused');
    const keys = [
      'numPassedTests',
      'numFailedTests',
      'numPendingTests',
      'numTotalTestSuites',
      'numPassedTestSuites',
      'numFailedTestSuites',
      'numRuntimeErrorTestSuites',
    ];
    if (
      keys.some(
        (key) => !Number.isSafeInteger(result[key]) || result[key] < 0 || result[key] > 10000,
      ) ||
      !Array.isArray(result.testResults)
    )
      throw Error('closed reporter counts refused');
    const testResults = result.testResults.map((suite) => {
      if (!Array.isArray(suite.testResults)) throw Error('closed reporter assertions refused');
      return {
        assertionResults: suite.testResults.map((test) => {
          if (
            typeof test.fullName !== 'string' ||
            !['passed', 'failed', 'pending', 'todo', 'disabled'].includes(test.status)
          )
            throw Error('closed reporter selection refused');
          return { fullName: test.fullName, status: test.status };
        }),
      };
    });
    const value = {
      schema: 'srvf-e4-closed-jest/v1',
      binding: {
        head: process.env.GITHUB_SHA,
        run: process.env.GITHUB_RUN_ID,
        attempt: process.env.GITHUB_RUN_ATTEMPT,
        stage: process.env.SRVF_E4_CLOSED_JEST_STAGE,
      },
      success:
        result.numFailedTests === 0 &&
        result.numFailedTestSuites === 0 &&
        result.numRuntimeErrorTestSuites === 0 &&
        result.numPassedTestSuites === result.numTotalTestSuites,
      numPassedTests: result.numPassedTests,
      numFailedTests: result.numFailedTests,
      numPendingTests: result.numPendingTests,
      numTotalTestSuites: result.numTotalTestSuites,
      testResults,
    };
    const payload = JSON.stringify(value);
    if (Buffer.byteLength(payload) > 2097152) throw Error('closed reporter output limit');
    fs.writeFileSync(file, payload, { mode: 0o600, flag: 'wx' });

    const catalog = JSON.parse(
      fs.readFileSync(path.join(root, 'test/helpers/e4-d0-safe-case-catalog.json'), 'utf8'),
    );
    const binding = {
      head: process.env.GITHUB_SHA,
      run: process.env.GITHUB_RUN_ID,
      attempt: process.env.GITHUB_RUN_ATTEMPT,
      stage: 'd0',
    };
    fs.writeFileSync(
      path.join(directory, 'd0-case-diagnostics.json'),
      JSON.stringify(build(result, catalog, binding, root)),
      { mode: 0o600, flag: 'wx' },
    );
  }
}

const root = process.cwd();
const stage = 'offline';
async function runDiagnostic() {
  const output = path.join(root, 'tmp/e4-github-evidence');
  fs.mkdirSync(output, { recursive: true });
  let report = {
    schema: 'srvf-e4-d0-diagnostic/v1',
    status: 'UNKNOWN',
    reason: 'SETUP_REFUSED',
  };
  const binding = {
    head: process.env.GITHUB_SHA,
    run: process.env.GITHUB_RUN_ID,
    attempt: process.env.GITHUB_RUN_ATTEMPT,
    stage: 'd0',
  };
  try {
    const catalog = JSON.parse(
      fs.readFileSync(path.join(root, 'test/helpers/e4-d0-safe-case-catalog.json'), 'utf8'),
    );
    const prepared = prepare(catalog, binding);
    const frozenFiles = [
      {
        file: 'test/e2e/activity-os-r5-e4-contribution-settlement-migration.e2e-spec.ts',
        sha256: 'bed336fa38ff84d935eb76d40cca00335f2ebe9618aae18d011ec583875e03d8',
      },
      {
        file: 'test/e2e/activity-os-r5-e4-contribution-settlement-scale.e2e-spec.ts',
        sha256: '4ba541ac9cce9a8ae89aec7b6383c15a919c188ba5170149104e7a607c0e2c1b',
      },
    ];
    if (JSON.stringify(catalog.files) !== JSON.stringify(frozenFiles))
      throw Error('frozen D0 inputs refused');

    if (
      process.env.GITHUB_ACTIONS !== 'true' ||
      process.env.GITHUB_REPOSITORY !== 'BA7IEE/srvf-nest-api' ||
      process.env.GITHUB_REF !== 'refs/heads/codex/activity-os-r5-e4-github-validation' ||
      binding.attempt !== '1' ||
      process.version !== 'v22.23.3' ||
      !fs.statSync(path.join(root, '.git')).isDirectory() ||
      process.env.SRVF_E4_GITHUB_ISOLATED !== '1' ||
      process.env.SRVF_TEST_RUN_SCOPE !== 'app_test_w98' ||
      process.env.SRVF_E4_W98 !== '0'
    )
      throw Error('runtime binding refused');
    for (const [file, digest] of prepared.files)
      if (sha(fs.readFileSync(path.join(root, file))) !== digest) throw Error('source refused');
    const cp = require('node:child_process');
    const pnpm = cp.spawnSync('pnpm', ['--version'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 2000,
      maxBuffer: 4096,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (pnpm.status !== 0 || pnpm.stdout.trim() !== '10.14.0')
      throw Error('package manager refused');
    const versions = Object.fromEntries(
      ['jest', 'ts-jest', 'tsx', 'typescript'].map((name) => {
        const version = JSON.parse(
          fs.readFileSync(path.join(root, 'node_modules', name, 'package.json'), 'utf8'),
        ).version;
        if (typeof version !== 'string' || !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(version))
          throw Error('package version refused');
        return [name, version];
      }),
    );
    const selftest = cp.spawnSync(
      process.execPath,
      [path.join(root, 'test/helpers/e4-safe-case-diagnostics.offline.cjs')],
      {
        cwd: root,
        encoding: 'utf8',
        timeout: 10000,
        maxBuffer: 8192,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let checks;
    try {
      const value = JSON.parse(selftest.stdout);
      if (
        selftest.status !== 0 ||
        value.status !== 'PASS' ||
        !Number.isSafeInteger(value.checks) ||
        value.checks < 1 ||
        value.checks > 1000
      )
        throw Error('selftest refused');
      checks = value.checks;
    } catch {
      throw Error('protocol refused');
    }
    fs.writeFileSync(
      path.join(output, 'd0-runtime.json'),
      JSON.stringify(
        {
          schema: 'srvf-e4-d0-runtime/v1',
          binding,
          node: 'v22.23.3',
          pnpm: '10.14.0',
          versions,
          checkout: 'NORMAL_DIRECTORY',
          scope: 'CLOUD_W98',
          bail: true,
          sourceHead: catalog.sourceHead,
          sourceDigests: catalog.files,
          protocol: { status: 'PASS', checks },
        },
        null,
        2,
      ),
      { mode: 0o600, flag: 'wx' },
    );
    // Persist consumption before the only D0 child. A repeated entry or rerun is refused.
    fs.writeFileSync(
      path.join(output, 'd0-admission.json'),
      JSON.stringify({ ...binding, consumed: true }),
      { mode: 0o600, flag: 'wx' },
    );
    const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'srvf-e4-d0-private-'));
    fs.chmodSync(dir, 0o700);
    const file = path.join(dir, 'closed-jest.json');
    process.env.SRVF_E4_GITHUB_PRIVATE_DIR = dir;
    const files = catalog.files.map((item) => item.file);
    const pattern = '(?: offline | offline$)';
    const config = JSON.stringify({
      rootDir: root,
      testEnvironment: 'node',
      testRegex: '.*\\.e2e-spec\\.ts$',
      moduleFileExtensions: ['ts', 'js', 'json'],
      maxWorkers: 1,
      testTimeout: 30000,
      transform: {
        '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/test/tsconfig.test.json' }],
      },
      setupFiles: ['<rootDir>/test/setup/setup-files.ts'],
      reporters: ['default', __filename],
    });
    const result = await child(
      [
        'exec',
        'jest',
        '--runInBand',
        '--no-cache',
        '--bail',
        '--silent',
        '--testLocationInResults',
        '--config',
        config,
        '--runTestsByPath',
        ...files,
        '--testNamePattern',
        pattern,
      ],
      {
        SRVF_E4_W98: '0',
        SRVF_E4_N1_LIFECYCLE: '',
        SRVF_E4_CLOSED_JEST_FILE: file,
        SRVF_E4_CLOSED_JEST_STAGE: stage,
      },
      600000,
    );
    const facts = {
      exitCode:
        Number.isSafeInteger(result.exitCode) && result.exitCode >= 0 && result.exitCode <= 255
          ? result.exitCode
          : null,
      signaled: result.signaled,
      spawnError: result.spawnError,
      timedOut: result.timedOut,
      outputLimitExceeded: result.exceeded,
      stdoutBytes: result.stdoutBytes,
      stderrBytes: result.stderrBytes,
    };
    let safe = unknown(binding, 'STRUCTURE');
    try {
      const candidate = path.join(dir, 'd0-case-diagnostics.json'),
        stat = fs.lstatSync(candidate);
      if (!stat.isFile() || stat.size <= 0 || stat.size > 65536) throw Error('safe file refused');
      const value = JSON.parse(fs.readFileSync(candidate, 'utf8'));
      if (!validate(value, catalog, binding)) throw Error('safe value refused');
      safe = value;
    } catch {}
    fs.writeFileSync(path.join(output, 'd0-case-diagnostics.json'), JSON.stringify(safe, null, 2), {
      mode: 0o600,
      flag: 'wx',
    });
    const closed = closedJestFile(file);
    report = {
      schema: 'srvf-e4-d0-diagnostic/v1',
      binding,
      status: 'UNKNOWN',
      reason: 'JEST_UNAVAILABLE',
      process: facts,
      fileState: closed.fileState,
      diagnostics: { status: safe.status, reason: safe.reason },
    };
    if (closed.fileState === 'VALID') {
      const value = closed.value,
        counts = {
          passed: value.numPassedTests,
          failed: value.numFailedTests,
          skipped: value.numPendingTests,
          suites: value.numTotalTestSuites,
        };
      const selected = value.testResults
          .flatMap((suite) => suite.assertionResults)
          .filter((test) => test.status !== 'pending'),
        names = new RegExp(pattern);
      const selection =
        counts.suites === files.length &&
        selected.length > 0 &&
        selected.filter((test) => test.status === 'passed').length === counts.passed &&
        selected.filter((test) => test.status === 'failed').length === counts.failed &&
        selected.every((test) => test.status === 'passed' || test.status === 'failed') &&
        selected.every((test) => typeof test.fullName === 'string' && names.test(test.fullName));
      report.counts = counts;
      if (result.exceeded || result.timedOut || result.signaled || result.spawnError || !selection)
        report.reason = 'PROCESS_OR_SELECTION';
      else {
        report.status =
          result.exitCode === 0 && value.success === true && counts.failed === 0 ? 'PASS' : 'FAIL';
        report.reason = 'JEST';
        if (report.status === 'PASS' && safe.status !== 'COMPLETE') {
          report.status = 'UNKNOWN';
          report.reason = 'D0_DIAGNOSTICS';
        }
      }
    }
  } catch {}
  fs.writeFileSync(path.join(output, 'status.json'), JSON.stringify(report, null, 2), {
    mode: 0o600,
    flag: 'wx',
  });
  process.stdout.write(JSON.stringify(report) + '\n');
  process.exitCode = report.status === 'PASS' ? 0 : report.status === 'FAIL' ? 1 : 2;
}
module.exports = E4D0Reporter;
Object.assign(module.exports, { build, validate, category, sha, unknown });
if (require.main === module) {
  if (process.argv.length !== 3 || process.argv[2] !== '--run-d0') process.exitCode = 2;
  else void runDiagnostic();
}
