import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import type { Stats } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import {
  E4_D1_OFFLINE_SCENARIOS,
  E4_D1_SCOPE,
  assertE4D1CaptureSummary,
  e4D1CaptureSummaryExitCode,
  runE4N1AdmissionCheck,
  type E4N1AdmissionSummary,
  type E4D1CaptureSummary,
} from './e4-d1-result-capture';

/**
 * Durable, deliberately small transport for the already fail-closed D1
 * summary. The durable records live under the worktree's Git metadata, never
 * in the repository, and never contain child stdout/stderr or database data.
 */
export const E4_D1_EVIDENCE_SCHEMA = 'srvf-e4-d1-evidence/v1';
export const E4_D1_EVIDENCE_REPORT_SCHEMA = 'srvf-e4-d1-evidence-report/v1';

const EVIDENCE_DIRECTORY = 'srvf-e4-d1-evidence';
const RUN_PREFIX = 'run-';
const MAX_SAFE_JSON_BYTES = 64 * 1024;
const MAX_ATTESTATION_BYTES = 8 * 1024;
const MAX_RUN_DURATION_MS = 120_000;
const MTIME_SLOP_MS = 5_000;
const CHILD_STREAM_MAX_BYTES = 64 * 1024;
type E4D1EvidenceFile = 'attestation.json' | 'summary.json' | 'exit.json' | 'final.json';

type E4D1EvidenceMode = 'EXECUTE' | 'OFFLINE';
type E4D1EvidenceStatus = 'PASS' | 'FAIL' | 'UNKNOWN';
type E4D1EvidenceReason =
  | 'PASS'
  | 'CHILD_REPORTED_FAIL'
  | 'CHILD_REPORTED_UNKNOWN'
  | 'SUMMARY_MISSING'
  | 'SUMMARY_INVALID'
  | 'BINDING_MISMATCH'
  | 'CHILD_EXIT_MISMATCH'
  | 'STREAM_LIMIT'
  | 'PROCESS_INTERRUPTED'
  | 'SPAWN_ERROR'
  | 'FALLBACK_PASS_REJECTED'
  | 'ADMISSION_REJECTED'
  | 'ADMISSION_UNKNOWN'
  | 'RUN_NOT_FOUND'
  | 'LATEST_INVALID'
  | 'FILE_MISSING'
  | 'FILE_INVALID'
  | 'FILE_OVERSIZE'
  | 'FILE_PERMISSIONS'
  | 'HASH_MISMATCH'
  | 'FINAL_MISMATCH'
  | 'USAGE'
  | 'PERSISTENCE_ERROR';

type E4D1EvidenceInputs = {
  helperSha256: string;
  launcherSha256: string;
  migrationSpecSha256: string;
  commandSha256: string;
};

type E4D1EvidenceAttestation = {
  schema: typeof E4_D1_EVIDENCE_SCHEMA;
  kind: 'ATTESTATION';
  runId: string;
  scopeHash: string;
  mode: E4D1EvidenceMode;
  scenario: string | null;
  startedAt: string;
  ownerUid: number | null;
  inputs: E4D1EvidenceInputs;
};

type E4D1EvidenceExit = {
  schema: typeof E4_D1_EVIDENCE_SCHEMA;
  kind: 'EXIT';
  runId: string;
  scopeHash: string;
  exitCode: number | null;
  signaled: boolean;
  spawnError: boolean;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutExceeded: boolean;
  stderrExceeded: boolean;
};

type E4D1EvidenceFinal = {
  schema: typeof E4_D1_EVIDENCE_SCHEMA;
  kind: 'FINAL';
  runId: string;
  scopeHash: string;
  tokenHash: string | null;
  status: E4D1EvidenceStatus;
  reason: Exclude<
    E4D1EvidenceReason,
    | 'RUN_NOT_FOUND'
    | 'LATEST_INVALID'
    | 'FILE_MISSING'
    | 'FILE_INVALID'
    | 'FILE_OVERSIZE'
    | 'FILE_PERMISSIONS'
    | 'HASH_MISMATCH'
    | 'FINAL_MISMATCH'
    | 'USAGE'
    | 'PERSISTENCE_ERROR'
  >;
  attestationSha256: string;
  summarySha256: string | null;
  exitSha256: string;
  completedAt: string;
};

type E4D1EvidenceLatest = {
  schema: typeof E4_D1_EVIDENCE_SCHEMA;
  kind: 'LATEST';
  runId: string;
  scopeHash: string;
  completedAt: string;
};

export type E4D1EvidenceReport = {
  schema: typeof E4_D1_EVIDENCE_REPORT_SCHEMA;
  runId: string | null;
  scopeHash: string | null;
  status: E4D1EvidenceStatus;
  reason: E4D1EvidenceReason;
  child: E4D1EvidenceExit | null;
  summary: E4D1CaptureSummary | null;
  currentInputsMatch: boolean | null;
  admission: E4N1AdmissionSummary | null;
  d1Started: boolean;
};

type E4D1ChildResult = {
  exit: E4D1EvidenceExit;
  stdout: string | null;
};

type E4D1Stream = {
  bytes: number;
  exceeded: boolean;
  text: string | null;
};

class E4D1EvidenceError extends Error {
  constructor(readonly code: E4D1EvidenceReason) {
    super(code);
  }
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function scopeHash(): string {
  return sha256(E4_D1_SCOPE);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).sort().join(',') !== [...keys].sort().join(','))
    throw new E4D1EvidenceError('FILE_INVALID');
}

function assertHex(value: unknown, length: number): string {
  if (typeof value !== 'string' || !new RegExp('^[a-f0-9]{' + length + '}$', 'u').test(value))
    throw new E4D1EvidenceError('FILE_INVALID');
  return value;
}

function assertBoolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new E4D1EvidenceError('FILE_INVALID');
  return value;
}

function assertInteger(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max)
    throw new E4D1EvidenceError('FILE_INVALID');
  return value;
}

function assertOneOf<T extends readonly string[]>(value: unknown, values: T): T[number] {
  if (typeof value !== 'string' || !values.includes(value))
    throw new E4D1EvidenceError('FILE_INVALID');
  return value;
}

function assertIsoDate(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    throw new E4D1EvidenceError('FILE_INVALID');
  return value;
}

function currentUid(): number | null {
  return typeof process.getuid === 'function' ? process.getuid() : null;
}

function assertOwnerAndMode(path: string, kind: 'directory' | 'file'): Stats {
  let stats: Stats;
  try {
    stats = lstatSync(path);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
      throw new E4D1EvidenceError('FILE_MISSING');
    throw new E4D1EvidenceError('FILE_INVALID');
  }
  if (
    (kind === 'directory' ? !stats.isDirectory() : !stats.isFile()) ||
    stats.isSymbolicLink() ||
    (stats.mode & 0o077) !== 0 ||
    (currentUid() !== null && stats.uid !== currentUid())
  )
    throw new E4D1EvidenceError('FILE_PERMISSIONS');
  return stats;
}

function assertDirectChild(parent: string, path: string, name: string): string {
  const resolved = resolve(path);
  if (dirname(resolved) !== resolve(parent) || basename(resolved) !== name)
    throw new E4D1EvidenceError('FILE_INVALID');
  return resolved;
}

function repositoryRoot(): string {
  return resolve(__dirname, '../..');
}

function gitMetadataEvidenceRoot(): string {
  const cwd = repositoryRoot();
  let gitPath: string;
  let gitDir: string;
  try {
    gitPath = execFileSync('git', ['rev-parse', '--git-path', EVIDENCE_DIRECTORY], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    gitDir = execFileSync('git', ['rev-parse', '--git-dir'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    throw new E4D1EvidenceError('PERSISTENCE_ERROR');
  }
  const root = resolve(cwd, gitPath);
  if (!gitPath || root !== resolve(cwd, gitDir, EVIDENCE_DIRECTORY))
    throw new E4D1EvidenceError('PERSISTENCE_ERROR');
  return root;
}

function evidenceRootFromEnvironment(): string {
  const override = process.env.SRVF_E4_D1_EVIDENCE_ROOT;
  if (override === undefined || override === '') return gitMetadataEvidenceRoot();
  const root = resolve(override);
  if (
    dirname(root) !== resolve(tmpdir()) ||
    !basename(root).startsWith('srvf-e4-d1-evidence-test-')
  )
    throw new E4D1EvidenceError('PERSISTENCE_ERROR');
  return root;
}

function ensureEvidenceRoot(root: string): string {
  try {
    if (!existsSync(root)) {
      mkdirSync(root, { mode: 0o700 });
      chmodSync(root, 0o700);
    }
  } catch {
    throw new E4D1EvidenceError('PERSISTENCE_ERROR');
  }
  assertOwnerAndMode(root, 'directory');
  return root;
}

function assertRunId(value: unknown): string {
  return assertHex(value, 32);
}

function runDirectory(root: string, runId: string): string {
  const name = RUN_PREFIX + assertRunId(runId);
  return assertDirectChild(root, join(root, name), name);
}

function createRun(root: string): { runId: string; directory: string } {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const runId = randomBytes(16).toString('hex');
    const directory = runDirectory(root, runId);
    try {
      mkdirSync(directory, { mode: 0o700 });
      chmodSync(directory, 0o700);
      assertOwnerAndMode(directory, 'directory');
      return { runId, directory };
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')
        continue;
      throw new E4D1EvidenceError('PERSISTENCE_ERROR');
    }
  }
  throw new E4D1EvidenceError('PERSISTENCE_ERROR');
}

function knownFile(directory: string, name: E4D1EvidenceFile | 'latest.json'): string {
  return assertDirectChild(directory, join(directory, name), name);
}

function fsyncDirectory(directory: string): void {
  const descriptor = openSync(directory, 'r');
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function atomicWriteJson(
  directory: string,
  name: E4D1EvidenceFile | 'latest.json',
  value: unknown,
  overwrite = false,
): string {
  assertOwnerAndMode(directory, 'directory');
  const destination = knownFile(directory, name);
  if (!overwrite && existsSync(destination)) throw new E4D1EvidenceError('PERSISTENCE_ERROR');
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text, 'utf8') > MAX_SAFE_JSON_BYTES)
    throw new E4D1EvidenceError('PERSISTENCE_ERROR');
  const temporaryName = '.' + name + '.' + randomBytes(12).toString('hex') + '.tmp';
  const temporary = assertDirectChild(directory, join(directory, temporaryName), temporaryName);
  try {
    const descriptor = openSync(temporary, 'wx', 0o600);
    try {
      writeFileSync(descriptor, text, 'utf8');
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    chmodSync(temporary, 0o600);
    renameSync(temporary, destination);
    fsyncDirectory(directory);
  } catch {
    try {
      if (existsSync(temporary)) unlinkSync(temporary);
    } catch {
      // A failed temporary cleanup is not a durable result and is never read.
    }
    throw new E4D1EvidenceError('PERSISTENCE_ERROR');
  }
  return sha256(text);
}

function readSafeJson(
  directory: string,
  name: E4D1EvidenceFile | 'latest.json',
  maxBytes = MAX_SAFE_JSON_BYTES,
): { value: unknown; text: string; mtimeMs: number } {
  assertOwnerAndMode(directory, 'directory');
  const file = knownFile(directory, name);
  const stats = assertOwnerAndMode(file, 'file');
  if (stats.size <= 0) throw new E4D1EvidenceError('FILE_INVALID');
  if (stats.size > maxBytes) throw new E4D1EvidenceError('FILE_OVERSIZE');
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    throw new E4D1EvidenceError('FILE_INVALID');
  }
  try {
    return { value: JSON.parse(text) as unknown, text, mtimeMs: stats.mtimeMs };
  } catch {
    throw new E4D1EvidenceError('FILE_INVALID');
  }
}

function commandArguments(mode: E4D1EvidenceMode, scenario: string | null): string[] {
  if (mode === 'EXECUTE')
    return [
      'exec',
      'tsx',
      'test/helpers/e4-d1-result-capture.ts',
      '--execute',
      '--scope',
      E4_D1_SCOPE,
    ];
  if (scenario === null || !(E4_D1_OFFLINE_SCENARIOS as readonly string[]).includes(scenario))
    throw new E4D1EvidenceError('USAGE');
  return ['exec', 'tsx', 'test/helpers/e4-d1-result-capture.ts', '--offline-scenario', scenario];
}

function inputHashes(mode: E4D1EvidenceMode, scenario: string | null): E4D1EvidenceInputs {
  const root = repositoryRoot();
  try {
    return {
      helperSha256: sha256(readFileSync(join(root, 'test/helpers/e4-d1-result-capture.ts'))),
      launcherSha256: sha256(readFileSync(join(root, 'test/helpers/e4-d1-evidence-launcher.ts'))),
      migrationSpecSha256: sha256(
        readFileSync(
          join(root, 'test/e2e/activity-os-r5-e4-contribution-settlement-migration.e2e-spec.ts'),
        ),
      ),
      commandSha256: sha256(commandArguments(mode, scenario).join('\u0000')),
    };
  } catch {
    throw new E4D1EvidenceError('PERSISTENCE_ERROR');
  }
}

function assertInputs(value: unknown): asserts value is E4D1EvidenceInputs {
  if (!isRecord(value)) throw new E4D1EvidenceError('FILE_INVALID');
  assertKeys(value, ['helperSha256', 'launcherSha256', 'migrationSpecSha256', 'commandSha256']);
  for (const key of ['helperSha256', 'launcherSha256', 'migrationSpecSha256', 'commandSha256'])
    assertHex(value[key], 64);
}

function assertAttestation(value: unknown): asserts value is E4D1EvidenceAttestation {
  if (!isRecord(value)) throw new E4D1EvidenceError('FILE_INVALID');
  assertKeys(value, [
    'schema',
    'kind',
    'runId',
    'scopeHash',
    'mode',
    'scenario',
    'startedAt',
    'ownerUid',
    'inputs',
  ]);
  if (value.schema !== E4_D1_EVIDENCE_SCHEMA || value.kind !== 'ATTESTATION')
    throw new E4D1EvidenceError('FILE_INVALID');
  assertRunId(value.runId);
  if (assertHex(value.scopeHash, 64) !== scopeHash())
    throw new E4D1EvidenceError('BINDING_MISMATCH');
  const mode = assertOneOf(value.mode, ['EXECUTE', 'OFFLINE'] as const);
  if (value.scenario !== null) assertOneOf(value.scenario, E4_D1_OFFLINE_SCENARIOS);
  if ((mode === 'EXECUTE') !== (value.scenario === null))
    throw new E4D1EvidenceError('FILE_INVALID');
  assertIsoDate(value.startedAt);
  if (value.ownerUid !== null) assertInteger(value.ownerUid, 0, 4_294_967_295);
  assertInputs(value.inputs);
}

function assertExit(value: unknown): asserts value is E4D1EvidenceExit {
  if (!isRecord(value)) throw new E4D1EvidenceError('FILE_INVALID');
  assertKeys(value, [
    'schema',
    'kind',
    'runId',
    'scopeHash',
    'exitCode',
    'signaled',
    'spawnError',
    'stdoutBytes',
    'stderrBytes',
    'stdoutExceeded',
    'stderrExceeded',
  ]);
  if (value.schema !== E4_D1_EVIDENCE_SCHEMA || value.kind !== 'EXIT')
    throw new E4D1EvidenceError('FILE_INVALID');
  assertRunId(value.runId);
  if (assertHex(value.scopeHash, 64) !== scopeHash())
    throw new E4D1EvidenceError('BINDING_MISMATCH');
  if (value.exitCode !== null) assertInteger(value.exitCode, 0, 255);
  for (const key of ['signaled', 'spawnError', 'stdoutExceeded', 'stderrExceeded'])
    assertBoolean(value[key]);
  assertInteger(value.stdoutBytes);
  assertInteger(value.stderrBytes);
}

function assertFinal(value: unknown): asserts value is E4D1EvidenceFinal {
  if (!isRecord(value)) throw new E4D1EvidenceError('FILE_INVALID');
  assertKeys(value, [
    'schema',
    'kind',
    'runId',
    'scopeHash',
    'tokenHash',
    'status',
    'reason',
    'attestationSha256',
    'summarySha256',
    'exitSha256',
    'completedAt',
  ]);
  if (value.schema !== E4_D1_EVIDENCE_SCHEMA || value.kind !== 'FINAL')
    throw new E4D1EvidenceError('FILE_INVALID');
  assertRunId(value.runId);
  if (assertHex(value.scopeHash, 64) !== scopeHash())
    throw new E4D1EvidenceError('BINDING_MISMATCH');
  if (value.tokenHash !== null) assertHex(value.tokenHash, 64);
  assertOneOf(value.status, ['PASS', 'FAIL', 'UNKNOWN'] as const);
  assertOneOf(value.reason, [
    'PASS',
    'CHILD_REPORTED_FAIL',
    'CHILD_REPORTED_UNKNOWN',
    'SUMMARY_MISSING',
    'SUMMARY_INVALID',
    'BINDING_MISMATCH',
    'CHILD_EXIT_MISMATCH',
    'STREAM_LIMIT',
    'PROCESS_INTERRUPTED',
    'SPAWN_ERROR',
    'FALLBACK_PASS_REJECTED',
  ] as const);
  assertHex(value.attestationSha256, 64);
  if (value.summarySha256 !== null) assertHex(value.summarySha256, 64);
  assertHex(value.exitSha256, 64);
  assertIsoDate(value.completedAt);
}

function assertLatest(value: unknown): asserts value is E4D1EvidenceLatest {
  if (!isRecord(value)) throw new E4D1EvidenceError('LATEST_INVALID');
  try {
    assertKeys(value, ['schema', 'kind', 'runId', 'scopeHash', 'completedAt']);
    if (value.schema !== E4_D1_EVIDENCE_SCHEMA || value.kind !== 'LATEST')
      throw new E4D1EvidenceError('LATEST_INVALID');
    assertRunId(value.runId);
    if (assertHex(value.scopeHash, 64) !== scopeHash())
      throw new E4D1EvidenceError('LATEST_INVALID');
    assertIsoDate(value.completedAt);
  } catch {
    throw new E4D1EvidenceError('LATEST_INVALID');
  }
}

function readStream(stream: Readable, retain: boolean): Promise<E4D1Stream> {
  return new Promise((resolveStream) => {
    let bytes = 0;
    let exceeded = false;
    let text = '';
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolveStream({ bytes, exceeded, text: retain && !exceeded ? text : null });
    };
    stream.on('data', (chunk: Buffer | string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > CHILD_STREAM_MAX_BYTES) {
        exceeded = true;
        text = '';
      } else if (retain && !exceeded) text += chunk.toString();
    });
    stream.once('error', finish);
    stream.once('end', finish);
    stream.resume();
  });
}

function waitForChild(child: ReturnType<typeof spawn>): Promise<{
  exitCode: number | null;
  signaled: boolean;
  spawnError: boolean;
}> {
  return new Promise((resolveChild) => {
    let settled = false;
    const finish = (result: {
      exitCode: number | null;
      signaled: boolean;
      spawnError: boolean;
    }) => {
      if (settled) return;
      settled = true;
      resolveChild(result);
    };
    child.once('error', () => finish({ exitCode: null, signaled: false, spawnError: true }));
    child.once('close', (code, signal) =>
      finish({ exitCode: code, signaled: signal !== null, spawnError: false }),
    );
  });
}

async function runCaptureChild(
  runId: string,
  mode: E4D1EvidenceMode,
  scenario: string | null,
): Promise<E4D1ChildResult> {
  const args = commandArguments(mode, scenario);
  const child = spawn('pnpm', args, {
    cwd: repositoryRoot(),
    env: { ...process.env, SRVF_E4_D1_RUN_ID: runId },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const [processResult, stdout, stderr] = await Promise.all([
    waitForChild(child),
    readStream(child.stdout, true),
    readStream(child.stderr, false),
  ]);
  return {
    exit: {
      schema: E4_D1_EVIDENCE_SCHEMA,
      kind: 'EXIT',
      runId,
      scopeHash: scopeHash(),
      ...processResult,
      stdoutBytes: stdout.bytes,
      stderrBytes: stderr.bytes,
      stdoutExceeded: stdout.exceeded,
      stderrExceeded: stderr.exceeded,
    },
    stdout: stdout.text,
  };
}

function parseSafeSummary(stdout: string | null): E4D1CaptureSummary | null {
  if (stdout === null || Buffer.byteLength(stdout, 'utf8') > MAX_SAFE_JSON_BYTES) return null;
  try {
    const summary: unknown = JSON.parse(stdout);
    assertE4D1CaptureSummary(summary);
    return summary;
  } catch {
    return null;
  }
}

function deriveFinal(
  attestation: E4D1EvidenceAttestation,
  child: E4D1EvidenceExit,
  summary: E4D1CaptureSummary | null,
): Pick<E4D1EvidenceFinal, 'status' | 'reason' | 'tokenHash'> {
  if (summary === null) return { status: 'UNKNOWN', reason: 'SUMMARY_MISSING', tokenHash: null };
  if (
    summary.binding.runId !== attestation.runId ||
    summary.binding.scopeHash !== attestation.scopeHash ||
    summary.binding.tokenHash === null
  )
    return { status: 'UNKNOWN', reason: 'BINDING_MISMATCH', tokenHash: null };
  if (child.spawnError)
    return { status: 'UNKNOWN', reason: 'SPAWN_ERROR', tokenHash: summary.binding.tokenHash };
  if (child.signaled)
    return {
      status: 'UNKNOWN',
      reason: 'PROCESS_INTERRUPTED',
      tokenHash: summary.binding.tokenHash,
    };
  if (child.stdoutExceeded || child.stderrExceeded)
    return { status: 'UNKNOWN', reason: 'STREAM_LIMIT', tokenHash: summary.binding.tokenHash };
  if (summary.capture.source === 'FALLBACK' && summary.status === 'PASS')
    return {
      status: 'UNKNOWN',
      reason: 'FALLBACK_PASS_REJECTED',
      tokenHash: summary.binding.tokenHash,
    };
  if (child.exitCode !== e4D1CaptureSummaryExitCode(summary))
    return {
      status: 'UNKNOWN',
      reason: 'CHILD_EXIT_MISMATCH',
      tokenHash: summary.binding.tokenHash,
    };
  return {
    status: summary.status,
    reason:
      summary.status === 'PASS'
        ? 'PASS'
        : summary.status === 'FAIL'
          ? 'CHILD_REPORTED_FAIL'
          : 'CHILD_REPORTED_UNKNOWN',
    tokenHash: summary.binding.tokenHash,
  };
}

function report(
  runId: string | null,
  status: E4D1EvidenceStatus,
  reason: E4D1EvidenceReason,
  child: E4D1EvidenceExit | null = null,
  summary: E4D1CaptureSummary | null = null,
  currentInputsMatch: boolean | null = null,
  admission: E4N1AdmissionSummary | null = null,
  d1Started = false,
): E4D1EvidenceReport {
  return {
    schema: E4_D1_EVIDENCE_REPORT_SCHEMA,
    runId,
    scopeHash: runId === null ? null : scopeHash(),
    status,
    reason,
    child,
    summary,
    currentInputsMatch,
    admission,
    d1Started,
  };
}

export async function gateE4D1Execution<T>(
  admission: () => Promise<E4N1AdmissionSummary>,
  startD1: () => Promise<T>,
): Promise<{ admission: E4N1AdmissionSummary; d1Started: boolean; value: T | null }> {
  const result = await admission();
  if (result.status !== 'READY') return { admission: result, d1Started: false, value: null };
  return { admission: result, d1Started: true, value: await startD1() };
}

async function startRun(
  mode: E4D1EvidenceMode,
  scenario: string | null,
): Promise<E4D1EvidenceReport> {
  const root = ensureEvidenceRoot(evidenceRootFromEnvironment());
  const { runId, directory } = createRun(root);
  const attestation: E4D1EvidenceAttestation = {
    schema: E4_D1_EVIDENCE_SCHEMA,
    kind: 'ATTESTATION',
    runId,
    scopeHash: scopeHash(),
    mode,
    scenario,
    startedAt: new Date().toISOString(),
    ownerUid: currentUid(),
    inputs: inputHashes(mode, scenario),
  };
  const attestationText = JSON.stringify(attestation);
  if (Buffer.byteLength(attestationText, 'utf8') > MAX_ATTESTATION_BYTES)
    throw new E4D1EvidenceError('PERSISTENCE_ERROR');
  const attestationSha256 = atomicWriteJson(directory, 'attestation.json', attestation);
  const childResult = await runCaptureChild(runId, mode, scenario);
  const summary = parseSafeSummary(childResult.stdout);
  const summarySha256 =
    summary === null ? null : atomicWriteJson(directory, 'summary.json', summary);
  const exitSha256 = atomicWriteJson(directory, 'exit.json', childResult.exit);
  const outcome = deriveFinal(attestation, childResult.exit, summary);
  const final: E4D1EvidenceFinal = {
    schema: E4_D1_EVIDENCE_SCHEMA,
    kind: 'FINAL',
    runId,
    scopeHash: scopeHash(),
    tokenHash: outcome.tokenHash,
    status: outcome.status,
    reason: outcome.reason,
    attestationSha256,
    summarySha256,
    exitSha256,
    completedAt: new Date().toISOString(),
  };
  atomicWriteJson(directory, 'final.json', final);
  atomicWriteJson(
    root,
    'latest.json',
    {
      schema: E4_D1_EVIDENCE_SCHEMA,
      kind: 'LATEST',
      runId,
      scopeHash: scopeHash(),
      completedAt: final.completedAt,
    } satisfies E4D1EvidenceLatest,
    true,
  );
  return report(
    runId,
    final.status,
    final.reason,
    childResult.exit,
    summary,
    true,
    null,
    mode === 'EXECUTE',
  );
}

async function startExecuteRun(): Promise<E4D1EvidenceReport> {
  const gated = await gateE4D1Execution(
    () => runE4N1AdmissionCheck(E4_D1_SCOPE),
    () => startRun('EXECUTE', null),
  );
  if (!gated.d1Started)
    return report(
      null,
      'UNKNOWN',
      gated.admission.status === 'REJECTED' ? 'ADMISSION_REJECTED' : 'ADMISSION_UNKNOWN',
      null,
      null,
      null,
      gated.admission,
      false,
    );
  if (gated.value === null) throw new E4D1EvidenceError('PERSISTENCE_ERROR');
  return { ...gated.value, admission: gated.admission, d1Started: true };
}

function assertRunBindings(
  attestation: E4D1EvidenceAttestation,
  child: E4D1EvidenceExit,
  final: E4D1EvidenceFinal,
  requestedRunId: string,
): void {
  if (
    attestation.runId !== requestedRunId ||
    child.runId !== requestedRunId ||
    final.runId !== requestedRunId ||
    attestation.scopeHash !== scopeHash() ||
    child.scopeHash !== scopeHash() ||
    final.scopeHash !== scopeHash()
  )
    throw new E4D1EvidenceError('BINDING_MISMATCH');
}

function assertRecordTimes(
  attestation: E4D1EvidenceAttestation,
  final: E4D1EvidenceFinal,
  mtimes: number[],
): void {
  const started = Date.parse(attestation.startedAt);
  const completed = Date.parse(final.completedAt);
  if (completed < started || completed - started > MAX_RUN_DURATION_MS)
    throw new E4D1EvidenceError('FILE_INVALID');
  if (mtimes.some((mtime) => mtime < started - MTIME_SLOP_MS || mtime > completed + MTIME_SLOP_MS))
    throw new E4D1EvidenceError('FILE_INVALID');
}

function readRun(root: string, requestedRunId: string): E4D1EvidenceReport {
  try {
    assertOwnerAndMode(root, 'directory');
    const runId = assertRunId(requestedRunId);
    const directory = runDirectory(root, runId);
    try {
      assertOwnerAndMode(directory, 'directory');
    } catch (error) {
      if (error instanceof E4D1EvidenceError && error.code === 'FILE_MISSING')
        return report(null, 'UNKNOWN', 'RUN_NOT_FOUND');
      throw error;
    }
    const attestation = readSafeJson(directory, 'attestation.json', MAX_ATTESTATION_BYTES);
    const exit = readSafeJson(directory, 'exit.json');
    const final = readSafeJson(directory, 'final.json');
    assertAttestation(attestation.value);
    assertExit(exit.value);
    assertFinal(final.value);
    assertRunBindings(attestation.value, exit.value, final.value, runId);
    if (
      sha256(attestation.text) !== final.value.attestationSha256 ||
      sha256(exit.text) !== final.value.exitSha256
    )
      throw new E4D1EvidenceError('HASH_MISMATCH');
    let summary: E4D1CaptureSummary | null = null;
    let summaryMtime: number | null = null;
    if (final.value.summarySha256 !== null) {
      let summaryFile: { value: unknown; text: string; mtimeMs: number };
      try {
        summaryFile = readSafeJson(directory, 'summary.json');
      } catch (error) {
        if (error instanceof E4D1EvidenceError && error.code === 'FILE_MISSING')
          throw new E4D1EvidenceError('SUMMARY_MISSING');
        throw error;
      }
      try {
        assertE4D1CaptureSummary(summaryFile.value);
      } catch {
        throw new E4D1EvidenceError('SUMMARY_INVALID');
      }
      if (sha256(summaryFile.text) !== final.value.summarySha256)
        throw new E4D1EvidenceError('HASH_MISMATCH');
      summary = summaryFile.value;
      summaryMtime = summaryFile.mtimeMs;
    } else if (existsSync(knownFile(directory, 'summary.json')))
      throw new E4D1EvidenceError('FILE_INVALID');
    const derived = deriveFinal(attestation.value, exit.value, summary);
    if (
      final.value.status !== derived.status ||
      final.value.reason !== derived.reason ||
      final.value.tokenHash !== derived.tokenHash
    )
      throw new E4D1EvidenceError('FINAL_MISMATCH');
    assertRecordTimes(attestation.value, final.value, [
      attestation.mtimeMs,
      exit.mtimeMs,
      final.mtimeMs,
      ...(summaryMtime === null ? [] : [summaryMtime]),
    ]);
    const current = inputHashes(attestation.value.mode, attestation.value.scenario);
    const currentInputsMatch = JSON.stringify(current) === JSON.stringify(attestation.value.inputs);
    return report(
      runId,
      final.value.status,
      final.value.reason,
      exit.value,
      summary,
      currentInputsMatch,
      null,
      attestation.value.mode === 'EXECUTE',
    );
  } catch (error) {
    const reason = error instanceof E4D1EvidenceError ? error.code : 'FILE_INVALID';
    return report(null, 'UNKNOWN', reason);
  }
}

function readLatest(): E4D1EvidenceReport {
  try {
    const root = evidenceRootFromEnvironment();
    assertOwnerAndMode(root, 'directory');
    let latest: { value: unknown; mtimeMs: number };
    try {
      latest = readSafeJson(root, 'latest.json');
      assertLatest(latest.value);
    } catch {
      return report(null, 'UNKNOWN', 'LATEST_INVALID');
    }
    const result = readRun(root, latest.value.runId);
    if (result.runId === null) return result;
    const directory = runDirectory(root, latest.value.runId);
    const final = readSafeJson(directory, 'final.json');
    assertFinal(final.value);
    if (
      final.value.completedAt !== latest.value.completedAt ||
      latest.mtimeMs < Date.parse(final.value.completedAt) - MTIME_SLOP_MS ||
      latest.mtimeMs > Date.parse(final.value.completedAt) + MTIME_SLOP_MS
    )
      return report(null, 'UNKNOWN', 'LATEST_INVALID');
    return result;
  } catch (error) {
    return report(
      null,
      'UNKNOWN',
      error instanceof E4D1EvidenceError ? error.code : 'LATEST_INVALID',
    );
  }
}

function exitCode(status: E4D1EvidenceStatus): 0 | 1 | 2 {
  return status === 'PASS' ? 0 : status === 'FAIL' ? 1 : 2;
}

function usage(): E4D1EvidenceReport {
  return report(null, 'UNKNOWN', 'USAGE');
}

async function main(argv: string[]): Promise<void> {
  const [command, first, second, third, ...rest] = argv;
  let result: E4D1EvidenceReport;
  let dropStdout = false;
  try {
    if (
      command === '--execute' &&
      first === '--scope' &&
      second === E4_D1_SCOPE &&
      rest.length === 0
    )
      result = await startExecuteRun();
    else if (
      command === '--offline-scenario' &&
      typeof first === 'string' &&
      (E4_D1_OFFLINE_SCENARIOS as readonly string[]).includes(first) &&
      ((second === undefined && rest.length === 0) ||
        (second === '--drop-stdout' && rest.length === 0))
    ) {
      dropStdout = second === '--drop-stdout';
      result = await startRun('OFFLINE', first);
    } else if (
      command === '--read-latest' &&
      first === '--scope' &&
      second === E4_D1_SCOPE &&
      rest.length === 0
    )
      result = readLatest();
    else if (
      command === '--read-run' &&
      typeof first === 'string' &&
      second === '--scope' &&
      third === E4_D1_SCOPE &&
      rest.length === 0
    )
      result = readRun(evidenceRootFromEnvironment(), first);
    else result = usage();
  } catch (error) {
    result = report(
      null,
      'UNKNOWN',
      error instanceof E4D1EvidenceError ? error.code : 'PERSISTENCE_ERROR',
    );
  }
  if (!dropStdout) process.stdout.write(JSON.stringify(result) + '\n');
  process.exitCode = exitCode(result.status);
}

if (require.main === module) void main(process.argv.slice(2));
