import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type { Readable } from 'node:stream';

/**
 * The D1 test itself owns the database evidence. This helper only transports a
 * closed, fixed-schema projection of that evidence. It deliberately never
 * retain stdout, stderr, query plans, connection details, roots, or Jest
 * failure text.
 */
export const E4_D1_CAPTURE_SCHEMA = 'srvf-e4-d1-capture/v3';
export const E4_D1_CAPTURE_SUMMARY_SCHEMA_V1 = 'srvf-e4-d1-capture-summary/v1';
export const E4_D1_CAPTURE_SUMMARY_SCHEMA_V2 = 'srvf-e4-d1-capture-summary/v2';
export const E4_D1_CAPTURE_SUMMARY_SCHEMA_V3 = 'srvf-e4-d1-capture-summary/v3';
export const E4_D1_CAPTURE_SUMMARY_SCHEMA = 'srvf-e4-d1-capture-summary/v4';
export const E4_D1_TEST_ID = 'E4_D1_RETAINED_BODY';
const E4_D1_LOCAL_SCOPE = 'app_test_srvf_nest_api_delivery_flow_pilot_f59fbc_w98';

/** An explicit test-only opt-in; ordinary CI and historical local bindings keep
 * the original scope. The shared database derivation/safety guards are untouched. */
export function resolveE4ValidationScope(
  env: NodeJS.ProcessEnv = process.env,
  normalCheckout = statSync(resolve(__dirname, '../../.git')).isDirectory(),
): string {
  if (env.SRVF_E4_GITHUB_ISOLATED === undefined || env.SRVF_E4_GITHUB_ISOLATED === '')
    return E4_D1_LOCAL_SCOPE;
  if (
    env.SRVF_E4_GITHUB_ISOLATED !== '1' ||
    env.GITHUB_ACTIONS !== 'true' ||
    env.GITHUB_REPOSITORY !== 'BA7IEE/srvf-nest-api' ||
    env.GITHUB_REF !== 'refs/heads/codex/activity-os-r5-e4-github-validation' ||
    env.SRVF_TEST_RUN_SCOPE !== 'app_test_w98' ||
    !normalCheckout
  )
    throw new Error('E4 isolated GitHub scope refused');
  return 'app_test_w98';
}

export const E4_D1_SCOPE = resolveE4ValidationScope();
export const E4_D1_JEST_FULL_NAME =
  'E4 terminal expected retained function-body diagnostic pins retained full source and captures the complete current body once';
export const E4_N1_ADMISSION_SCHEMA = 'srvf-e4-n1-admission/v1';
export const E4_N1_ADMISSION_JEST_FULL_NAME =
  'E4 N1 candidate admission gate verifies the installed candidate before the D1 launcher can start';

const SAFE_RESULT_MAX_BYTES = 64 * 1024;
const JEST_JSON_MAX_BYTES = 2 * 1024 * 1024;
const STREAM_MAX_BYTES = 64 * 1024;
const TOKEN_HEX_LENGTH = 48;
const BODY_ELIGIBILITY_VALUE_MAX = 1_000_000;

export const E4_D1_PROOF_STEPS = [
  'old-current',
  'body-current',
  'current-stored',
  'document-hashes',
  'source-hashes',
  'root-hashes',
] as const;
export type E4D1ProofStep = (typeof E4_D1_PROOF_STEPS)[number];

export const E4_D1_PROOF_EXPECTED: Record<E4D1ProofStep, Record<string, number | boolean>> = {
  'old-current': { oldCount: 8000, currentCount: 8000, leftDifferences: 0, rightDifferences: 0 },
  'body-current': {
    directCount: 8000,
    currentCount: 8000,
    leftDifferences: 0,
    rightDifferences: 0,
  },
  'current-stored': {
    currentCount: 8000,
    storedCount: 8000,
    leftDifferences: 0,
    rightDifferences: 0,
  },
  'document-hashes': { storedCount: 8000, completeKeys: true, evaluationHashes: true },
  'source-hashes': { storedCount: 8000, sourceHashes: true, references: 50000 },
  'root-hashes': {
    rootUnits: 8000,
    rootReferences: 50000,
    rootTotal: true,
    rootSourceHash: true,
    rootEvaluationHash: true,
  },
};

const E4_D1_FAILURE_CODES = [
  'DEADLINE',
  'BACKEND_ENDED',
  'REQUEST_DEADLINE',
  'CHECKSUM',
  'PUBLIC_RESIDUE',
  'PUBLIC_SOURCE',
  'GUARD',
  'ROOT_COUNT',
  'ROOT_CHAIN',
  'FULL_TRUTH',
  'PLAN_FIELDS',
  'PLAN_STAGE',
  'DOCUMENTS_MULTIPLE',
  'BODY_COVERAGE',
  'ELIGIBILITY',
  'RESOURCE',
  'SNAPSHOT',
  'PROOF_QUEUE',
  'PROOF_DEADLINE',
  'UNKNOWN',
] as const;
export type E4D1FailureCode = (typeof E4_D1_FAILURE_CODES)[number];

export const E4_D1_FAILED_PHASES = [
  'entry',
  'lease',
  'observer',
  'plan-connect',
  'source-catalog',
  'temporary-old-install',
  'null-body-calibration',
  'complete-proof-snapshot',
  'complete-proof-old-current',
  'complete-proof-body-current',
  'complete-proof-current-stored',
  'complete-proof-document-hashes',
  'complete-proof-source-hashes',
  'complete-proof-root-hashes',
  'complete-current-body-plan',
  'temporary-old-cleanup',
  'plan-close',
  'owner-release',
  'partial-owner-release',
  'final-metadata',
  'observer-close',
] as const;
export type E4D1FailedPhase = (typeof E4_D1_FAILED_PHASES)[number];

export type E4D1ResourceFrame = {
  databases: number;
  clients: number;
  ownerBackends: number;
  leaseLocks: number;
  leaseOwnerVisible: boolean;
  observerVisible: boolean;
  planVisible: boolean;
  exactScope: boolean;
  samePrincipal: boolean;
  sameServer: boolean;
};

export type E4D1ProofFrame = {
  outcome: 'PASS' | 'REJECTED';
  step: E4D1ProofStep;
  durationMs: number;
  values: Record<string, number | boolean>;
};

export const E4_D1_BODY_ELIGIBILITY_REJECTIONS = [
  'PRODUCER_MATCH_COUNT',
  'CONSUMER_MATCH_COUNT',
  'PRODUCER_ROWS',
  'CONSUMER_ROWS',
  'PRODUCER_LOOPS',
  'CONSUMER_LOOPS',
  'TEMP_WRITTEN',
] as const;
export type E4D1BodyEligibilityRejection = (typeof E4_D1_BODY_ELIGIBILITY_REJECTIONS)[number];

export const E4_D1_BODY_RECOGNITION_NODE_TYPES = [
  'Result',
  'CTE Scan',
  'Function Scan',
  'Seq Scan',
  'Index Scan',
  'Index Only Scan',
  'Bitmap Heap Scan',
  'Bitmap Index Scan',
  'BitmapAnd',
  'BitmapOr',
  'Append',
  'Merge Append',
  'Aggregate',
  'Group',
  'Sort',
  'Incremental Sort',
  'Unique',
  'Limit',
  'Hash',
  'Hash Join',
  'Merge Join',
  'Nested Loop',
  'Materialize',
  'Memoize',
  'Subquery Scan',
  'WindowAgg',
  'SetOp',
  'Gather',
  'Gather Merge',
  'Values Scan',
  'ProjectSet',
  'LockRows',
  'OTHER',
] as const;
export const E4_D1_BODY_RECOGNITION_ROLES = ['root', 'producer', 'consumer', 'node'] as const;
export type E4D1BodyRecognitionNodeType = (typeof E4_D1_BODY_RECOGNITION_NODE_TYPES)[number];
export type E4D1BodyRecognitionRole = (typeof E4_D1_BODY_RECOGNITION_ROLES)[number];

export type E4D1BodyRecognitionNode = {
  ordinal: number;
  parentOrdinal: number | null;
  nodeType: E4D1BodyRecognitionNodeType;
  role: E4D1BodyRecognitionRole;
  ctePresent: boolean;
  cteTargetExact: boolean;
  cteTargetPrefix: boolean;
  subplanPresent: boolean;
  subplanTargetExact: boolean;
  subplanTargetPrefix: boolean;
};

export type E4D1BodyRecognitionDiagnostic = {
  nodeCount: number;
  nodeTypeCounts: Record<E4D1BodyRecognitionNodeType, number>;
  nodes: E4D1BodyRecognitionNode[];
};

export type E4D1BodyEligibilityNode = {
  actualRows: number;
  loops: number;
  tempRead: number;
  tempWritten: number;
};

export type E4D1BodyEligibilityDiagnostic = {
  producerMatches: number;
  consumerMatches: number;
  producer: E4D1BodyEligibilityNode | null;
  consumer: E4D1BodyEligibilityNode | null;
  checks: {
    producerExactlyOne: boolean;
    consumerExactlyOne: boolean;
    producerRows: boolean;
    consumerRows: boolean;
    producerLoops: boolean;
    consumerLoops: boolean;
    temporaryWritten: boolean;
    eligible: boolean;
  };
  rejected: E4D1BodyEligibilityRejection[];
};

export type E4D1TerminalState = {
  completed: boolean;
  failedPhase: E4D1FailedPhase | null;
  failureCode: E4D1FailureCode | null;
  temporary: 'NOT_CREATED' | 'PRESENT' | 'ABSENT' | 'UNKNOWN';
  planClosed: boolean;
  observerClosed: boolean;
  pending: number;
  idle: boolean;
  settingsRestored: boolean;
  publicUnchanged: boolean;
  releaseKnown: boolean;
  deadlinePassed: boolean;
  before: E4D1ResourceFrame | 'UNKNOWN';
  after: E4D1ResourceFrame | 'UNKNOWN';
  nullCalibration: {
    observed: boolean;
    eligibility: boolean;
    fullCoverageRejected: boolean;
  };
  fullPlan: {
    observed: boolean;
    eligibility: boolean;
    nodeCount: number;
    bodyEligibility: E4D1BodyEligibilityDiagnostic | null;
    bodyRecognition: E4D1BodyRecognitionDiagnostic | null;
  };
  proofs: E4D1ProofFrame[];
};

export type E4D1CaptureContext = {
  captureDir: string;
  resultFile: string;
  fallbackFile: string;
  token: string;
  scopeHash: string;
};

export type E4D1SafeResult = {
  schema: typeof E4_D1_CAPTURE_SCHEMA;
  token: string;
  scopeHash: string;
  testId: typeof E4_D1_TEST_ID;
  terminalStatus: 'PASS' | 'FAIL' | 'UNKNOWN';
  terminal: E4D1TerminalState;
};

export type E4D1JestArtifact =
  | 'IN_MEMORY'
  | 'MISSING'
  | 'NOT_FILE'
  | 'EMPTY'
  | 'OVERSIZE'
  | 'UNREADABLE'
  | 'INVALID_JSON'
  | 'PARSED';

export type E4D1JestSummary = {
  artifact: E4D1JestArtifact;
  valid: boolean;
  success: boolean;
  total: number;
  passed: number;
  failed: number;
  pending: number;
  todo: number;
  totalSuites: number;
  passedSuites: number;
  failedSuites: number;
  privateDiagnostics: boolean;
  targetPassed: boolean;
};

export type E4N1AdmissionSummary = {
  schema: typeof E4_N1_ADMISSION_SCHEMA;
  status: 'READY' | 'REJECTED' | 'UNKNOWN';
  process: {
    exitCode: number | null;
    signaled: boolean;
    spawnError: boolean;
  };
  streams: {
    stdoutBytes: number;
    stderrBytes: number;
    stdoutExceeded: boolean;
    stderrExceeded: boolean;
  };
  jest: E4D1JestSummary;
};

export type E4D1SummaryBinding = {
  runId: string | null;
  scopeHash: string;
  tokenHash: string | null;
};

export type E4D1SafeProofDiagnostic = {
  step: E4D1ProofStep;
  observed: boolean;
  outcome: 'PASS' | 'REJECTED' | null;
  values: Record<string, number | boolean> | null;
};

export type E4D1SafeCleanupDiagnostic = {
  temporary: E4D1TerminalState['temporary'];
  planClosed: boolean;
  observerClosed: boolean;
  pendingClear: boolean;
  idle: boolean;
  settingsRestored: boolean;
  publicUnchanged: boolean;
  releaseKnown: boolean;
  deadlinePassed: boolean;
};

export type E4D1SafeTerminalDiagnosticV2 = {
  failedPhase: E4D1FailedPhase | null;
  failureCode: E4D1FailureCode | null;
  proofs: E4D1SafeProofDiagnostic[];
  cleanup: E4D1SafeCleanupDiagnostic;
};

export type E4D1SafeTerminalDiagnosticV3 = E4D1SafeTerminalDiagnosticV2 & {
  bodyEligibility: E4D1BodyEligibilityDiagnostic | null;
};

export type E4D1SafeTerminalDiagnostic = E4D1SafeTerminalDiagnosticV3 & {
  bodyRecognition: E4D1BodyRecognitionDiagnostic | null;
};

type E4D1CaptureSummaryBase = {
  status: 'PASS' | 'FAIL' | 'UNKNOWN';
  reason:
    | 'PASS'
    | 'CAPTURE_MISSING'
    | 'CAPTURE_INVALID'
    | 'CAPTURE_UNKNOWN'
    | 'JEST_MISSING'
    | 'JEST_INVALID'
    | 'JEST_PRIVATE_DIAGNOSTICS'
    | 'JEST_FAILED'
    | 'EXIT_JEST_MISMATCH'
    | 'PROCESS_INTERRUPTED'
    | 'STREAM_LIMIT'
    | 'SPAWN_ERROR'
    | 'USAGE';
  process: {
    exitCode: number | null;
    signaled: boolean;
    spawnError: boolean;
    interrupted: boolean;
  };
  streams: {
    stdoutBytes: number;
    stderrBytes: number;
    stdoutExceeded: boolean;
    stderrExceeded: boolean;
  };
  jest: E4D1JestSummary;
  binding: E4D1SummaryBinding;
};

export type E4D1CaptureSummaryV1 = E4D1CaptureSummaryBase & {
  schema: typeof E4_D1_CAPTURE_SUMMARY_SCHEMA_V1;
  capture: {
    valid: boolean;
    terminalStatus: 'PASS' | 'FAIL' | 'UNKNOWN' | null;
    source: 'TERMINAL' | 'FALLBACK' | null;
  };
};

export type E4D1CaptureSummaryV2 = E4D1CaptureSummaryBase & {
  schema: typeof E4_D1_CAPTURE_SUMMARY_SCHEMA_V2;
  capture: {
    valid: boolean;
    terminalStatus: 'PASS' | 'FAIL' | 'UNKNOWN' | null;
    source: 'TERMINAL' | 'FALLBACK' | null;
    diagnostic: E4D1SafeTerminalDiagnosticV2 | null;
  };
};

export type E4D1CaptureSummaryV3 = E4D1CaptureSummaryBase & {
  schema: typeof E4_D1_CAPTURE_SUMMARY_SCHEMA_V3;
  capture: {
    valid: boolean;
    terminalStatus: 'PASS' | 'FAIL' | 'UNKNOWN' | null;
    source: 'TERMINAL' | 'FALLBACK' | null;
    diagnostic: E4D1SafeTerminalDiagnosticV3 | null;
  };
};

export type E4D1CaptureSummaryV4 = E4D1CaptureSummaryBase & {
  schema: typeof E4_D1_CAPTURE_SUMMARY_SCHEMA;
  capture: {
    valid: boolean;
    terminalStatus: 'PASS' | 'FAIL' | 'UNKNOWN' | null;
    source: 'TERMINAL' | 'FALLBACK' | null;
    diagnostic: E4D1SafeTerminalDiagnostic | null;
  };
};

export type E4D1CaptureSummary =
  | E4D1CaptureSummaryV1
  | E4D1CaptureSummaryV2
  | E4D1CaptureSummaryV3
  | E4D1CaptureSummaryV4;

type E4D1RunnerSession = {
  context: E4D1CaptureContext;
  jestFile: string;
  dispose: () => void;
};

type E4D1ProcessResult = {
  exitCode: number | null;
  signaled: boolean;
  spawnError: boolean;
  interrupted?: boolean;
};

type E4D1StreamResult = {
  bytes: number;
  exceeded: boolean;
};

function hash(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

function e4D1SummaryRunId(): string | null {
  const value = process.env.SRVF_E4_D1_RUN_ID;
  return typeof value === 'string' && /^[a-f0-9]{32}$/u.test(value) ? value : null;
}

function e4D1SummaryBinding(context?: E4D1CaptureContext): E4D1SummaryBinding {
  return {
    runId: e4D1SummaryRunId(),
    scopeHash: context?.scopeHash ?? hash(E4_D1_SCOPE),
    tokenHash: context === undefined ? null : hash(context.token),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  name: string,
): void {
  if (Object.keys(value).sort().join(',') !== [...keys].sort().join(','))
    throw new Error('E4 D1 capture ' + name + ' keys differ');
}

function assertSafeInteger(
  value: unknown,
  name: string,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max)
    throw new Error('E4 D1 capture ' + name + ' differs');
  return value;
}

function assertSafeDurationMs(value: unknown, name: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 30_000 ||
    Number(value.toFixed(3)) !== value
  )
    throw new Error('E4 D1 capture ' + name + ' differs');
  return value;
}

function assertBoolean(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') throw new Error('E4 D1 capture ' + name + ' differs');
  return value;
}

function assertOneOf<T extends readonly string[]>(
  value: unknown,
  values: T,
  name: string,
): T[number] {
  if (typeof value !== 'string' || !values.includes(value))
    throw new Error('E4 D1 capture ' + name + ' differs');
  return value;
}

function assertHex(value: unknown, length: number, name: string): string {
  if (typeof value !== 'string' || !new RegExp('^[a-f0-9]{' + length + '}$', 'u').test(value))
    throw new Error('E4 D1 capture ' + name + ' differs');
  return value;
}

function assertPrivateCaptureDirectory(captureDir: string, token: string): string {
  const resolved = resolve(captureDir);
  const root = resolve(tmpdir());
  if (
    dirname(resolved) !== root ||
    !basename(resolved).startsWith('srvf-e4-d1-capture-') ||
    !lstatSync(resolved).isDirectory() ||
    (statSync(resolved).mode & 0o077) !== 0
  )
    throw new Error('E4 D1 capture directory differs');
  const marker = join(resolved, '.owner');
  if (!lstatSync(marker).isFile() || (statSync(marker).mode & 0o077) !== 0)
    throw new Error('E4 D1 capture owner marker differs');
  if (readFileSync(marker, 'utf8') !== token) throw new Error('E4 D1 capture owner marker differs');
  return resolved;
}

export function openE4D1CaptureContext(env: NodeJS.ProcessEnv): E4D1CaptureContext {
  const token = assertHex(env.SRVF_E4_D1_CAPTURE_TOKEN, TOKEN_HEX_LENGTH, 'token');
  if (env.SRVF_TEST_RUN_SCOPE !== E4_D1_SCOPE) throw new Error('E4 D1 capture scope differs');
  if (typeof env.SRVF_E4_D1_CAPTURE_DIR !== 'string')
    throw new Error('E4 D1 capture directory unavailable');
  const captureDir = assertPrivateCaptureDirectory(env.SRVF_E4_D1_CAPTURE_DIR, token);
  const resultFile = resolve(env.SRVF_E4_D1_RESULT_FILE ?? '');
  if (resultFile !== join(captureDir, 'result.json'))
    throw new Error('E4 D1 capture result path differs');
  return {
    captureDir,
    resultFile,
    fallbackFile: join(captureDir, 'fallback.json'),
    token,
    scopeHash: hash(E4_D1_SCOPE),
  };
}

export function createE4D1CaptureSession(scope = E4_D1_SCOPE): E4D1RunnerSession {
  if (scope !== E4_D1_SCOPE) throw new Error('E4 D1 capture scope differs');
  const captureDir = mkdtempSync(join(resolve(tmpdir()), 'srvf-e4-d1-capture-'));
  chmodSync(captureDir, 0o700);
  const token = randomBytes(TOKEN_HEX_LENGTH / 2).toString('hex');
  const marker = join(captureDir, '.owner');
  writeFileSync(marker, token, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  const context = openE4D1CaptureContext({
    SRVF_E4_D1_CAPTURE_DIR: captureDir,
    SRVF_E4_D1_RESULT_FILE: join(captureDir, 'result.json'),
    SRVF_E4_D1_CAPTURE_TOKEN: token,
    SRVF_TEST_RUN_SCOPE: scope,
  });
  return {
    context,
    jestFile: join(captureDir, 'jest.json'),
    dispose: () => {
      const verified = assertPrivateCaptureDirectory(captureDir, token);
      rmSync(verified, { recursive: true, force: false, maxRetries: 0 });
    },
  };
}

function assertResourceFrame(value: unknown, name: string): asserts value is E4D1ResourceFrame {
  if (!isRecord(value)) throw new Error('E4 D1 capture ' + name + ' differs');
  assertExactKeys(
    value,
    [
      'databases',
      'clients',
      'ownerBackends',
      'leaseLocks',
      'leaseOwnerVisible',
      'observerVisible',
      'planVisible',
      'exactScope',
      'samePrincipal',
      'sameServer',
    ],
    name,
  );
  assertSafeInteger(value.databases, name + '.databases', 0, 1);
  assertSafeInteger(value.clients, name + '.clients', 0, 2);
  assertSafeInteger(value.ownerBackends, name + '.ownerBackends', 0, 1);
  assertSafeInteger(value.leaseLocks, name + '.leaseLocks', 0, 1);
  for (const key of [
    'leaseOwnerVisible',
    'observerVisible',
    'planVisible',
    'exactScope',
    'samePrincipal',
    'sameServer',
  ])
    assertBoolean(value[key], name + '.' + key);
}

function assertProofFrame(value: unknown, name: string): asserts value is E4D1ProofFrame {
  if (!isRecord(value)) throw new Error('E4 D1 capture ' + name + ' differs');
  assertExactKeys(value, ['outcome', 'step', 'durationMs', 'values'], name);
  assertOneOf(value.outcome, ['PASS', 'REJECTED'] as const, name + '.outcome');
  const step = assertOneOf(value.step, E4_D1_PROOF_STEPS, name + '.step');
  assertSafeDurationMs(value.durationMs, name + '.durationMs');
  if (!isRecord(value.values)) throw new Error('E4 D1 capture ' + name + '.values differs');
  const expected = E4_D1_PROOF_EXPECTED[step];
  assertExactKeys(value.values, Object.keys(expected), name + '.values');
  for (const [key, expectedValue] of Object.entries(expected)) {
    const actual = value.values[key];
    if (typeof expectedValue === 'number') assertSafeInteger(actual, name + '.values.' + key);
    else assertBoolean(actual, name + '.values.' + key);
  }
}

function assertSafeProofDiagnostic(
  value: unknown,
  name: string,
  expectedStep: E4D1ProofStep,
): asserts value is E4D1SafeProofDiagnostic {
  if (!isRecord(value)) throw new Error('E4 D1 capture ' + name + ' differs');
  assertExactKeys(value, ['step', 'observed', 'outcome', 'values'], name);
  const step = assertOneOf(value.step, E4_D1_PROOF_STEPS, name + '.step');
  if (step !== expectedStep) throw new Error('E4 D1 capture ' + name + '.step differs');
  const observed = assertBoolean(value.observed, name + '.observed');
  if (!observed) {
    if (value.outcome !== null || value.values !== null)
      throw new Error('E4 D1 capture ' + name + ' missing differs');
    return;
  }
  assertOneOf(value.outcome, ['PASS', 'REJECTED'] as const, name + '.outcome');
  if (!isRecord(value.values)) throw new Error('E4 D1 capture ' + name + '.values differs');
  const expected = E4_D1_PROOF_EXPECTED[step];
  assertExactKeys(value.values, Object.keys(expected), name + '.values');
  for (const [key, expectedValue] of Object.entries(expected)) {
    const actual = value.values[key];
    if (typeof expectedValue === 'number') assertSafeInteger(actual, name + '.values.' + key);
    else assertBoolean(actual, name + '.values.' + key);
  }
}

function assertBodyEligibilityNode(
  value: unknown,
  name: string,
): asserts value is E4D1BodyEligibilityNode {
  if (!isRecord(value)) throw new Error('E4 D1 capture ' + name + ' differs');
  assertExactKeys(value, ['actualRows', 'loops', 'tempRead', 'tempWritten'], name);
  for (const key of ['actualRows', 'loops', 'tempRead', 'tempWritten'])
    assertSafeInteger(value[key], name + '.' + key, 0, BODY_ELIGIBILITY_VALUE_MAX);
}

function assertBodyEligibilityDiagnostic(
  value: unknown,
  name: string,
): asserts value is E4D1BodyEligibilityDiagnostic {
  if (!isRecord(value)) throw new Error('E4 D1 capture ' + name + ' differs');
  assertExactKeys(
    value,
    ['producerMatches', 'consumerMatches', 'producer', 'consumer', 'checks', 'rejected'],
    name,
  );
  assertSafeInteger(value.producerMatches, name + '.producerMatches', 0, 256);
  assertSafeInteger(value.consumerMatches, name + '.consumerMatches', 0, 256);
  const producerExactlyOne = value.producerMatches === 1;
  const consumerExactlyOne = value.consumerMatches === 1;
  if (producerExactlyOne) assertBodyEligibilityNode(value.producer, name + '.producer');
  else if (value.producer !== null) throw new Error('E4 D1 capture ' + name + '.producer differs');
  if (consumerExactlyOne) assertBodyEligibilityNode(value.consumer, name + '.consumer');
  else if (value.consumer !== null) throw new Error('E4 D1 capture ' + name + '.consumer differs');
  if (!isRecord(value.checks)) throw new Error('E4 D1 capture ' + name + '.checks differs');
  assertExactKeys(
    value.checks,
    [
      'producerExactlyOne',
      'consumerExactlyOne',
      'producerRows',
      'consumerRows',
      'producerLoops',
      'consumerLoops',
      'temporaryWritten',
      'eligible',
    ],
    name + '.checks',
  );
  for (const key of [
    'producerExactlyOne',
    'consumerExactlyOne',
    'producerRows',
    'consumerRows',
    'producerLoops',
    'consumerLoops',
    'temporaryWritten',
    'eligible',
  ])
    assertBoolean(value.checks[key], name + '.checks.' + key);
  const producer = value.producer;
  const consumer = value.consumer;
  const expectedChecks = {
    producerExactlyOne,
    consumerExactlyOne,
    producerRows: producer?.actualRows === 8000,
    consumerRows: consumer?.actualRows === 8000,
    producerLoops: producer?.loops === 1,
    consumerLoops: consumer?.loops === 1,
    temporaryWritten: (producer?.tempWritten ?? 0) > 0 || (consumer?.tempWritten ?? 0) > 0,
  };
  const expectedRejected = [
    ...(expectedChecks.producerExactlyOne ? [] : ['PRODUCER_MATCH_COUNT' as const]),
    ...(expectedChecks.consumerExactlyOne ? [] : ['CONSUMER_MATCH_COUNT' as const]),
    ...(expectedChecks.producerRows ? [] : ['PRODUCER_ROWS' as const]),
    ...(expectedChecks.consumerRows ? [] : ['CONSUMER_ROWS' as const]),
    ...(expectedChecks.producerLoops ? [] : ['PRODUCER_LOOPS' as const]),
    ...(expectedChecks.consumerLoops ? [] : ['CONSUMER_LOOPS' as const]),
    ...(expectedChecks.temporaryWritten ? [] : ['TEMP_WRITTEN' as const]),
  ];
  for (const [key, expected] of Object.entries(expectedChecks))
    if (value.checks[key] !== expected)
      throw new Error('E4 D1 capture ' + name + '.checks.' + key + ' differs');
  if (value.checks.eligible !== (expectedRejected.length === 0))
    throw new Error('E4 D1 capture ' + name + '.checks.eligible differs');
  if (!Array.isArray(value.rejected) || value.rejected.length !== expectedRejected.length)
    throw new Error('E4 D1 capture ' + name + '.rejected differs');
  for (const [index, reason] of value.rejected.entries()) {
    assertOneOf(reason, E4_D1_BODY_ELIGIBILITY_REJECTIONS, name + '.rejected.' + index);
    if (reason !== expectedRejected[index])
      throw new Error('E4 D1 capture ' + name + '.rejected.' + index + ' differs');
  }
}

function assertBodyRecognitionNode(
  value: unknown,
  name: string,
  ordinal: number,
): asserts value is E4D1BodyRecognitionNode {
  if (!isRecord(value)) throw new Error('E4 D1 capture ' + name + ' differs');
  assertExactKeys(
    value,
    [
      'ordinal',
      'parentOrdinal',
      'nodeType',
      'role',
      'ctePresent',
      'cteTargetExact',
      'cteTargetPrefix',
      'subplanPresent',
      'subplanTargetExact',
      'subplanTargetPrefix',
    ],
    name,
  );
  assertSafeInteger(value.ordinal, name + '.ordinal', 0, 255);
  if (value.ordinal !== ordinal) throw new Error('E4 D1 capture ' + name + '.ordinal differs');
  if (ordinal === 0) {
    if (value.parentOrdinal !== null)
      throw new Error('E4 D1 capture ' + name + '.parentOrdinal differs');
  } else {
    assertSafeInteger(value.parentOrdinal, name + '.parentOrdinal', 0, ordinal - 1);
  }
  assertOneOf(value.nodeType, E4_D1_BODY_RECOGNITION_NODE_TYPES, name + '.nodeType');
  assertOneOf(value.role, E4_D1_BODY_RECOGNITION_ROLES, name + '.role');
  for (const key of [
    'ctePresent',
    'cteTargetExact',
    'cteTargetPrefix',
    'subplanPresent',
    'subplanTargetExact',
    'subplanTargetPrefix',
  ])
    assertBoolean(value[key], name + '.' + key);
  if (value.cteTargetExact && !value.ctePresent)
    throw new Error('E4 D1 capture ' + name + '.cte target differs');
  if (value.cteTargetPrefix && !value.ctePresent)
    throw new Error('E4 D1 capture ' + name + '.cte prefix differs');
  if (value.subplanTargetExact && !value.subplanPresent)
    throw new Error('E4 D1 capture ' + name + '.subplan target differs');
  if (value.subplanTargetPrefix && !value.subplanPresent)
    throw new Error('E4 D1 capture ' + name + '.subplan prefix differs');
}

function assertBodyRecognitionDiagnostic(
  value: unknown,
  name: string,
): asserts value is E4D1BodyRecognitionDiagnostic {
  if (!isRecord(value)) throw new Error('E4 D1 capture ' + name + ' differs');
  assertExactKeys(value, ['nodeCount', 'nodeTypeCounts', 'nodes'], name);
  assertSafeInteger(value.nodeCount, name + '.nodeCount', 0, 256);
  if (!isRecord(value.nodeTypeCounts))
    throw new Error('E4 D1 capture ' + name + '.nodeTypeCounts differs');
  assertExactKeys(
    value.nodeTypeCounts,
    E4_D1_BODY_RECOGNITION_NODE_TYPES,
    name + '.nodeTypeCounts',
  );
  for (const nodeType of E4_D1_BODY_RECOGNITION_NODE_TYPES)
    assertSafeInteger(value.nodeTypeCounts[nodeType], name + '.nodeTypeCounts.' + nodeType, 0, 256);
  if (!Array.isArray(value.nodes) || value.nodes.length !== value.nodeCount)
    throw new Error('E4 D1 capture ' + name + '.nodes differs');
  const actualCounts = Object.fromEntries(
    E4_D1_BODY_RECOGNITION_NODE_TYPES.map((nodeType) => [nodeType, 0]),
  ) as Record<E4D1BodyRecognitionNodeType, number>;
  for (const [ordinal, node] of value.nodes.entries()) {
    assertBodyRecognitionNode(node, name + '.nodes.' + ordinal, ordinal);
    actualCounts[node.nodeType]++;
  }
  for (const nodeType of E4_D1_BODY_RECOGNITION_NODE_TYPES)
    if (value.nodeTypeCounts[nodeType] !== actualCounts[nodeType])
      throw new Error('E4 D1 capture ' + name + '.nodeTypeCounts.' + nodeType + ' differs');
}

function assertSafeTerminalDiagnosticFields(value: Record<string, unknown>, name: string): void {
  if (value.failedPhase !== null)
    assertOneOf(value.failedPhase, E4_D1_FAILED_PHASES, name + '.failedPhase');
  if (value.failureCode !== null)
    assertOneOf(value.failureCode, E4_D1_FAILURE_CODES, name + '.failureCode');
  if (value.failedPhase === null && value.failureCode !== null)
    throw new Error('E4 D1 capture ' + name + ' failure pairing differs');
  if (!Array.isArray(value.proofs) || value.proofs.length !== E4_D1_PROOF_STEPS.length)
    throw new Error('E4 D1 capture ' + name + '.proofs differs');
  for (const [index, step] of E4_D1_PROOF_STEPS.entries())
    assertSafeProofDiagnostic(value.proofs[index], name + '.proofs.' + index, step);
  if (!isRecord(value.cleanup)) throw new Error('E4 D1 capture ' + name + '.cleanup differs');
  assertExactKeys(
    value.cleanup,
    [
      'temporary',
      'planClosed',
      'observerClosed',
      'pendingClear',
      'idle',
      'settingsRestored',
      'publicUnchanged',
      'releaseKnown',
      'deadlinePassed',
    ],
    name + '.cleanup',
  );
  assertOneOf(
    value.cleanup.temporary,
    ['NOT_CREATED', 'PRESENT', 'ABSENT', 'UNKNOWN'] as const,
    name + '.cleanup.temporary',
  );
  for (const key of [
    'planClosed',
    'observerClosed',
    'pendingClear',
    'idle',
    'settingsRestored',
    'publicUnchanged',
    'releaseKnown',
    'deadlinePassed',
  ])
    assertBoolean(value.cleanup[key], name + '.cleanup.' + key);
}

function assertSafeTerminalDiagnosticV2(
  value: unknown,
  name: string,
): asserts value is E4D1SafeTerminalDiagnosticV2 {
  if (!isRecord(value)) throw new Error('E4 D1 capture ' + name + ' differs');
  assertExactKeys(value, ['failedPhase', 'failureCode', 'proofs', 'cleanup'], name);
  assertSafeTerminalDiagnosticFields(value, name);
}

function assertSafeTerminalDiagnosticV3(
  value: unknown,
  name: string,
): asserts value is E4D1SafeTerminalDiagnosticV3 {
  if (!isRecord(value)) throw new Error('E4 D1 capture ' + name + ' differs');
  assertExactKeys(
    value,
    ['failedPhase', 'failureCode', 'proofs', 'cleanup', 'bodyEligibility'],
    name,
  );
  assertSafeTerminalDiagnosticFields(value, name);
  if (value.bodyEligibility !== null)
    assertBodyEligibilityDiagnostic(value.bodyEligibility, name + '.bodyEligibility');
  if (value.failureCode === 'ELIGIBILITY') {
    if (value.bodyEligibility === null || value.bodyEligibility.checks.eligible)
      throw new Error('E4 D1 capture ' + name + '.bodyEligibility differs');
  }
}

function assertSafeTerminalDiagnostic(
  value: unknown,
  name: string,
): asserts value is E4D1SafeTerminalDiagnostic {
  if (!isRecord(value)) throw new Error('E4 D1 capture ' + name + ' differs');
  assertExactKeys(
    value,
    ['failedPhase', 'failureCode', 'proofs', 'cleanup', 'bodyEligibility', 'bodyRecognition'],
    name,
  );
  assertSafeTerminalDiagnosticFields(value, name);
  if (value.bodyEligibility !== null)
    assertBodyEligibilityDiagnostic(value.bodyEligibility, name + '.bodyEligibility');
  if (value.bodyRecognition !== null)
    assertBodyRecognitionDiagnostic(value.bodyRecognition, name + '.bodyRecognition');
  if (value.failureCode === 'ELIGIBILITY') {
    if (
      value.bodyEligibility === null ||
      value.bodyEligibility.checks.eligible ||
      value.bodyRecognition === null
    )
      throw new Error('E4 D1 capture ' + name + '.bodyEligibility differs');
  }
}

function assertTerminalState(value: unknown): asserts value is E4D1TerminalState {
  if (!isRecord(value)) throw new Error('E4 D1 capture terminal differs');
  assertExactKeys(
    value,
    [
      'completed',
      'failedPhase',
      'failureCode',
      'temporary',
      'planClosed',
      'observerClosed',
      'pending',
      'idle',
      'settingsRestored',
      'publicUnchanged',
      'releaseKnown',
      'deadlinePassed',
      'before',
      'after',
      'nullCalibration',
      'fullPlan',
      'proofs',
    ],
    'terminal',
  );
  for (const key of [
    'completed',
    'planClosed',
    'observerClosed',
    'idle',
    'settingsRestored',
    'publicUnchanged',
    'releaseKnown',
    'deadlinePassed',
  ])
    assertBoolean(value[key], 'terminal.' + key);
  if (value.failedPhase !== null)
    assertOneOf(value.failedPhase, E4_D1_FAILED_PHASES, 'terminal.failedPhase');
  if (value.failureCode !== null)
    assertOneOf(value.failureCode, E4_D1_FAILURE_CODES, 'terminal.failureCode');
  if (value.failedPhase === null && value.failureCode !== null)
    throw new Error('E4 D1 capture terminal failure pairing differs');
  assertOneOf(
    value.temporary,
    ['NOT_CREATED', 'PRESENT', 'ABSENT', 'UNKNOWN'] as const,
    'terminal.temporary',
  );
  assertSafeInteger(value.pending, 'terminal.pending', 0, 8);
  for (const key of ['before', 'after'] as const) {
    if (value[key] !== 'UNKNOWN') assertResourceFrame(value[key], 'terminal.' + key);
  }
  if (!isRecord(value.nullCalibration)) throw new Error('E4 D1 capture null calibration differs');
  assertExactKeys(
    value.nullCalibration,
    ['observed', 'eligibility', 'fullCoverageRejected'],
    'terminal.nullCalibration',
  );
  for (const key of ['observed', 'eligibility', 'fullCoverageRejected'])
    assertBoolean(value.nullCalibration[key], 'terminal.nullCalibration.' + key);
  if (!isRecord(value.fullPlan)) throw new Error('E4 D1 capture full plan differs');
  assertExactKeys(
    value.fullPlan,
    ['observed', 'eligibility', 'nodeCount', 'bodyEligibility', 'bodyRecognition'],
    'terminal.fullPlan',
  );
  assertBoolean(value.fullPlan.observed, 'terminal.fullPlan.observed');
  assertBoolean(value.fullPlan.eligibility, 'terminal.fullPlan.eligibility');
  assertSafeInteger(value.fullPlan.nodeCount, 'terminal.fullPlan.nodeCount', 0, 256);
  if (value.fullPlan.bodyEligibility !== null)
    assertBodyEligibilityDiagnostic(
      value.fullPlan.bodyEligibility,
      'terminal.fullPlan.bodyEligibility',
    );
  if (value.fullPlan.bodyRecognition !== null)
    assertBodyRecognitionDiagnostic(
      value.fullPlan.bodyRecognition,
      'terminal.fullPlan.bodyRecognition',
    );
  if (
    !value.fullPlan.observed &&
    (value.fullPlan.bodyEligibility !== null || value.fullPlan.bodyRecognition !== null)
  )
    throw new Error('E4 D1 capture terminal.fullPlan body eligibility differs');
  if (value.fullPlan.observed && value.fullPlan.bodyRecognition === null)
    throw new Error('E4 D1 capture terminal.fullPlan body recognition differs');
  if (
    value.fullPlan.bodyRecognition !== null &&
    value.fullPlan.nodeCount !== value.fullPlan.bodyRecognition.nodeCount
  )
    throw new Error('E4 D1 capture terminal.fullPlan node count differs');
  if (
    value.fullPlan.bodyEligibility !== null &&
    value.fullPlan.eligibility !== value.fullPlan.bodyEligibility.checks.eligible
  )
    throw new Error('E4 D1 capture terminal.fullPlan eligibility differs');
  if (value.failureCode === 'ELIGIBILITY') {
    if (value.fullPlan.bodyEligibility === null || value.fullPlan.bodyEligibility.checks.eligible)
      throw new Error('E4 D1 capture terminal.fullPlan eligibility evidence differs');
  }
  if (!Array.isArray(value.proofs) || value.proofs.length > E4_D1_PROOF_STEPS.length)
    throw new Error('E4 D1 capture proof list differs');
  for (const [index, proof] of value.proofs.entries())
    assertProofFrame(proof, 'terminal.proofs.' + index);
  const steps = value.proofs.map((proof) => proof.step);
  if (new Set(steps).size !== steps.length)
    throw new Error('E4 D1 capture proof duplication differs');
}

function copyBodyEligibility(
  value: E4D1BodyEligibilityDiagnostic | null,
): E4D1BodyEligibilityDiagnostic | null {
  if (value === null) return null;
  const copyNode = (node: E4D1BodyEligibilityNode | null) =>
    node === null
      ? null
      : {
          actualRows: node.actualRows,
          loops: node.loops,
          tempRead: node.tempRead,
          tempWritten: node.tempWritten,
        };
  return {
    producerMatches: value.producerMatches,
    consumerMatches: value.consumerMatches,
    producer: copyNode(value.producer),
    consumer: copyNode(value.consumer),
    checks: { ...value.checks },
    rejected: [...value.rejected],
  };
}

function copyBodyRecognition(
  value: E4D1BodyRecognitionDiagnostic | null,
): E4D1BodyRecognitionDiagnostic | null {
  if (value === null) return null;
  return {
    nodeCount: value.nodeCount,
    nodeTypeCounts: { ...value.nodeTypeCounts },
    nodes: value.nodes.map((node) => ({ ...node })),
  };
}

function safeTerminalDiagnostic(terminal: E4D1TerminalState): E4D1SafeTerminalDiagnostic {
  const proofs = new Map<E4D1ProofStep, E4D1ProofFrame>(
    terminal.proofs.map((proof): [E4D1ProofStep, E4D1ProofFrame] => [proof.step, proof]),
  );
  return {
    failedPhase: terminal.failedPhase,
    failureCode: terminal.failureCode,
    proofs: E4_D1_PROOF_STEPS.map((step) => {
      const proof = proofs.get(step);
      return proof === undefined
        ? { step, observed: false, outcome: null, values: null }
        : { step, observed: true, outcome: proof.outcome, values: { ...proof.values } };
    }),
    cleanup: {
      temporary: terminal.temporary,
      planClosed: terminal.planClosed,
      observerClosed: terminal.observerClosed,
      pendingClear: terminal.pending === 0,
      idle: terminal.idle,
      settingsRestored: terminal.settingsRestored,
      publicUnchanged: terminal.publicUnchanged,
      releaseKnown: terminal.releaseKnown,
      deadlinePassed: terminal.deadlinePassed,
    },
    bodyEligibility: copyBodyEligibility(terminal.fullPlan.bodyEligibility),
    bodyRecognition: copyBodyRecognition(terminal.fullPlan.bodyRecognition),
  };
}

function safeDiagnosticV2ProvesPass(diagnostic: E4D1SafeTerminalDiagnosticV2): boolean {
  const cleanup = diagnostic.cleanup;
  return (
    diagnostic.failedPhase === null &&
    diagnostic.failureCode === null &&
    cleanup.temporary === 'ABSENT' &&
    cleanup.planClosed &&
    cleanup.observerClosed &&
    cleanup.pendingClear &&
    cleanup.idle &&
    cleanup.settingsRestored &&
    cleanup.publicUnchanged &&
    cleanup.releaseKnown &&
    !cleanup.deadlinePassed &&
    diagnostic.proofs.every((proof, index) => {
      const expected = E4_D1_PROOF_EXPECTED[E4_D1_PROOF_STEPS[index]];
      return (
        proof.observed &&
        proof.outcome === 'PASS' &&
        proof.values !== null &&
        JSON.stringify(proof.values) === JSON.stringify(expected)
      );
    })
  );
}

function safeDiagnosticProvesPass(diagnostic: E4D1SafeTerminalDiagnostic): boolean {
  return (
    diagnostic.bodyEligibility !== null &&
    diagnostic.bodyEligibility.checks.eligible &&
    diagnostic.bodyEligibility.rejected.length === 0 &&
    diagnostic.bodyRecognition !== null &&
    diagnostic.bodyRecognition.nodeCount > 0 &&
    safeDiagnosticV2ProvesPass(diagnostic)
  );
}

function sameResource(frame: E4D1ResourceFrame | 'UNKNOWN', expected: E4D1ResourceFrame): boolean {
  return frame !== 'UNKNOWN' && JSON.stringify(frame) === JSON.stringify(expected);
}

function proofsPass(proofs: E4D1ProofFrame[]): boolean {
  return (
    proofs.length === E4_D1_PROOF_STEPS.length &&
    proofs.every((proof, index) => {
      const expected = E4_D1_PROOF_EXPECTED[E4_D1_PROOF_STEPS[index]];
      return (
        proof.outcome === 'PASS' &&
        proof.step === E4_D1_PROOF_STEPS[index] &&
        JSON.stringify(proof.values) === JSON.stringify(expected)
      );
    })
  );
}

export function e4D1TerminalStatus(terminal: E4D1TerminalState): 'PASS' | 'FAIL' | 'UNKNOWN' {
  assertTerminalState(terminal);
  const closureKnown =
    terminal.temporary === 'ABSENT' &&
    terminal.planClosed &&
    terminal.observerClosed &&
    terminal.pending === 0 &&
    terminal.idle &&
    terminal.settingsRestored &&
    terminal.publicUnchanged &&
    terminal.releaseKnown &&
    !terminal.deadlinePassed &&
    sameResource(terminal.before, {
      databases: 1,
      clients: 0,
      ownerBackends: 1,
      leaseLocks: 1,
      leaseOwnerVisible: true,
      observerVisible: true,
      planVisible: false,
      exactScope: true,
      samePrincipal: true,
      sameServer: true,
    }) &&
    sameResource(terminal.after, {
      databases: 1,
      clients: 0,
      ownerBackends: 0,
      leaseLocks: 0,
      leaseOwnerVisible: false,
      observerVisible: true,
      planVisible: false,
      exactScope: true,
      samePrincipal: true,
      sameServer: true,
    });
  const completeTruth =
    terminal.nullCalibration.observed &&
    terminal.nullCalibration.eligibility === false &&
    terminal.nullCalibration.fullCoverageRejected &&
    terminal.fullPlan.observed &&
    terminal.fullPlan.eligibility &&
    terminal.fullPlan.nodeCount > 0 &&
    terminal.fullPlan.bodyEligibility !== null &&
    terminal.fullPlan.bodyEligibility.checks.eligible &&
    terminal.fullPlan.bodyEligibility.rejected.length === 0 &&
    terminal.fullPlan.bodyRecognition !== null &&
    terminal.fullPlan.bodyRecognition.nodeCount === terminal.fullPlan.nodeCount &&
    proofsPass(terminal.proofs);
  if (
    terminal.completed &&
    terminal.failedPhase === null &&
    terminal.failureCode === null &&
    closureKnown &&
    completeTruth
  )
    return 'PASS';
  if (
    closureKnown &&
    terminal.failedPhase !== null &&
    terminal.failureCode !== null &&
    terminal.failureCode !== 'UNKNOWN'
  )
    return 'FAIL';
  if (
    !closureKnown ||
    !completeTruth ||
    terminal.failureCode === null ||
    terminal.failureCode === 'UNKNOWN' ||
    terminal.deadlinePassed
  )
    return 'UNKNOWN';
  return 'FAIL';
}

export function createE4D1SafeResult(
  context: E4D1CaptureContext,
  terminal: E4D1TerminalState,
): E4D1SafeResult {
  const checked = openE4D1CaptureContext({
    SRVF_E4_D1_CAPTURE_DIR: context.captureDir,
    SRVF_E4_D1_RESULT_FILE: context.resultFile,
    SRVF_E4_D1_CAPTURE_TOKEN: context.token,
    SRVF_TEST_RUN_SCOPE: E4_D1_SCOPE,
  });
  if (checked.scopeHash !== context.scopeHash) throw new Error('E4 D1 capture scope hash differs');
  const result: E4D1SafeResult = {
    schema: E4_D1_CAPTURE_SCHEMA,
    token: context.token,
    scopeHash: context.scopeHash,
    testId: E4_D1_TEST_ID,
    terminalStatus: e4D1TerminalStatus(terminal),
    terminal,
  };
  assertE4D1SafeResult(result, context);
  return result;
}

function assertE4D1SafeResult(
  value: unknown,
  context?: E4D1CaptureContext,
): asserts value is E4D1SafeResult {
  if (!isRecord(value)) throw new Error('E4 D1 capture result differs');
  assertExactKeys(
    value,
    ['schema', 'token', 'scopeHash', 'testId', 'terminalStatus', 'terminal'],
    'result',
  );
  if (value.schema !== E4_D1_CAPTURE_SCHEMA) throw new Error('E4 D1 capture schema differs');
  const token = assertHex(value.token, TOKEN_HEX_LENGTH, 'result.token');
  const scopeHash = assertHex(value.scopeHash, 64, 'result.scopeHash');
  if (value.testId !== E4_D1_TEST_ID) throw new Error('E4 D1 capture test id differs');
  assertOneOf(value.terminalStatus, ['PASS', 'FAIL', 'UNKNOWN'] as const, 'result.terminalStatus');
  assertTerminalState(value.terminal);
  if (value.terminalStatus !== e4D1TerminalStatus(value.terminal))
    throw new Error('E4 D1 capture terminal status differs');
  if (context && (token !== context.token || scopeHash !== context.scopeHash))
    throw new Error('E4 D1 capture binding differs');
}

function writeE4D1SafeResultFile(
  context: E4D1CaptureContext,
  file: string,
  terminal: E4D1TerminalState,
): E4D1SafeResult {
  const verified = openE4D1CaptureContext({
    SRVF_E4_D1_CAPTURE_DIR: context.captureDir,
    SRVF_E4_D1_RESULT_FILE: context.resultFile,
    SRVF_E4_D1_CAPTURE_TOKEN: context.token,
    SRVF_TEST_RUN_SCOPE: E4_D1_SCOPE,
  });
  if (file !== verified.resultFile && file !== verified.fallbackFile)
    throw new Error('E4 D1 capture output path differs');
  const result = createE4D1SafeResult(context, terminal);
  const text = JSON.stringify(result);
  if (Buffer.byteLength(text, 'utf8') > SAFE_RESULT_MAX_BYTES)
    throw new Error('E4 D1 capture result bound exceeded');
  if (existsSync(file)) throw new Error('E4 D1 capture result already exists');
  const temporary = join(context.captureDir, '.result-' + randomBytes(12).toString('hex') + '.tmp');
  try {
    writeFileSync(temporary, text, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    chmodSync(temporary, 0o600);
    renameSync(temporary, file);
  } catch (error) {
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error;
  }
  return result;
}

export function writeE4D1SafeResult(
  context: E4D1CaptureContext,
  terminal: E4D1TerminalState,
): E4D1SafeResult {
  return writeE4D1SafeResultFile(context, context.resultFile, terminal);
}

function fallbackUnknownTerminal(): E4D1TerminalState {
  return {
    completed: false,
    failedPhase: null,
    failureCode: null,
    temporary: 'UNKNOWN',
    planClosed: false,
    observerClosed: false,
    pending: 0,
    idle: false,
    settingsRestored: false,
    publicUnchanged: false,
    releaseKnown: false,
    deadlinePassed: false,
    before: 'UNKNOWN',
    after: 'UNKNOWN',
    nullCalibration: { observed: false, eligibility: false, fullCoverageRejected: false },
    fullPlan: {
      observed: false,
      eligibility: false,
      nodeCount: 0,
      bodyEligibility: null,
      bodyRecognition: null,
    },
    proofs: [],
  };
}

/**
 * A final writer must never replace a pre-existing terminal failure with a
 * serialization exception. The fallback intentionally carries no phase,
 * error text, or leaked payload: it is only a durable UNKNOWN marker.
 */
export function writeE4D1FallbackUnknownResult(context: E4D1CaptureContext): E4D1SafeResult {
  return writeE4D1SafeResultFile(context, context.fallbackFile, fallbackUnknownTerminal());
}

function readE4D1SafeResultFile(context: E4D1CaptureContext, file: string): E4D1SafeResult {
  const verified = openE4D1CaptureContext({
    SRVF_E4_D1_CAPTURE_DIR: context.captureDir,
    SRVF_E4_D1_RESULT_FILE: context.resultFile,
    SRVF_E4_D1_CAPTURE_TOKEN: context.token,
    SRVF_TEST_RUN_SCOPE: E4_D1_SCOPE,
  });
  if (file !== verified.resultFile && file !== verified.fallbackFile)
    throw new Error('E4 D1 capture output path differs');
  const stats = lstatSync(file);
  if (!stats.isFile() || stats.size <= 0 || stats.size > SAFE_RESULT_MAX_BYTES)
    throw new Error('E4 D1 capture result unavailable');
  const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
  assertE4D1SafeResult(parsed, verified);
  return parsed;
}

export function readE4D1SafeResult(context: E4D1CaptureContext): E4D1SafeResult {
  return readE4D1SafeResultFile(context, context.resultFile);
}

function readE4D1CaptureResult(context: E4D1CaptureContext): {
  result: E4D1SafeResult;
  source: 'TERMINAL' | 'FALLBACK';
} {
  try {
    return { result: readE4D1SafeResultFile(context, context.resultFile), source: 'TERMINAL' };
  } catch {
    return { result: readE4D1SafeResultFile(context, context.fallbackFile), source: 'FALLBACK' };
  }
}

function emptyJestSummary(artifact: E4D1JestArtifact): E4D1JestSummary {
  return {
    artifact,
    valid: false,
    success: false,
    total: 0,
    passed: 0,
    failed: 0,
    pending: 0,
    todo: 0,
    totalSuites: 0,
    passedSuites: 0,
    failedSuites: 0,
    privateDiagnostics: false,
    targetPassed: false,
  };
}

function hasPrivateJestDiagnostics(value: unknown): boolean {
  const pending: unknown[] = [value];
  let visited = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (++visited > 20000) return true;
    if (Array.isArray(current)) {
      for (const child of current) pending.push(child);
      continue;
    }
    if (!isRecord(current)) continue;
    for (const [key, child] of Object.entries(current)) {
      if (/^(failureMessages?|message|stack)$/iu.test(key)) {
        if (typeof child === 'string' && child.length > 0) return true;
        if (
          Array.isArray(child) &&
          child.some((item) => typeof item === 'string' && item.length > 0)
        )
          return true;
      }
      pending.push(child);
    }
  }
  return false;
}

function parseJestSummary(
  value: unknown,
  artifact: E4D1JestArtifact = 'IN_MEMORY',
  targetFullName = E4_D1_JEST_FULL_NAME,
): E4D1JestSummary {
  const unavailable = emptyJestSummary(artifact);
  if (!isRecord(value)) return unavailable;
  const integer = (item: unknown) =>
    typeof item === 'number' && Number.isSafeInteger(item) && item >= 0 ? item : null;
  const total = integer(value.numTotalTests);
  const passed = integer(value.numPassedTests);
  const failed = integer(value.numFailedTests);
  const pending = integer(value.numPendingTests);
  const todo = integer(value.numTodoTests);
  const totalSuites = integer(value.numTotalTestSuites);
  const passedSuites = integer(value.numPassedTestSuites);
  const failedSuites = integer(value.numFailedTestSuites);
  if (
    typeof value.success !== 'boolean' ||
    total === null ||
    passed === null ||
    failed === null ||
    pending === null ||
    todo === null ||
    totalSuites === null ||
    passedSuites === null ||
    failedSuites === null
  )
    return unavailable;
  const testResults = value.testResults;
  if (!Array.isArray(testResults) || testResults.length !== 1) return unavailable;
  const assertions = testResults.flatMap((result) =>
    isRecord(result) && Array.isArray(result.assertionResults) ? result.assertionResults : [],
  );
  const target = assertions.filter(
    (assertion) =>
      isRecord(assertion) && assertion.fullName === targetFullName && assertion.status === 'passed',
  );
  const privateDiagnostics = hasPrivateJestDiagnostics(value);
  return {
    artifact,
    valid: true,
    success: value.success,
    total,
    passed,
    failed,
    pending,
    todo,
    totalSuites,
    passedSuites,
    failedSuites,
    privateDiagnostics,
    targetPassed: target.length === 1,
  };
}

export function summarizeE4D1Capture(input: {
  process: E4D1ProcessResult;
  streams: { stdout: E4D1StreamResult; stderr: E4D1StreamResult };
  jest: unknown;
  capture: unknown;
  context?: E4D1CaptureContext;
  captureMissing?: boolean;
  captureSource?: 'TERMINAL' | 'FALLBACK';
  jestArtifact?: E4D1JestArtifact;
}): E4D1CaptureSummary {
  const jest = parseJestSummary(input.jest, input.jestArtifact);
  let capture: E4D1SafeResult | undefined;
  try {
    assertE4D1SafeResult(input.capture, input.context);
    capture = input.capture;
  } catch {
    // A malformed record is intentionally indistinguishable from absent evidence.
  }
  const summaryBase: Omit<E4D1CaptureSummaryV4, 'status' | 'reason'> = {
    schema: E4_D1_CAPTURE_SUMMARY_SCHEMA,
    process: { ...input.process, interrupted: input.process.interrupted === true },
    streams: {
      stdoutBytes: input.streams.stdout.bytes,
      stderrBytes: input.streams.stderr.bytes,
      stdoutExceeded: input.streams.stdout.exceeded,
      stderrExceeded: input.streams.stderr.exceeded,
    },
    jest,
    capture: {
      valid: capture !== undefined,
      terminalStatus: capture?.terminalStatus ?? null,
      source: input.captureSource ?? null,
      diagnostic: capture === undefined ? null : safeTerminalDiagnostic(capture.terminal),
    },
    binding: e4D1SummaryBinding(input.context),
  };
  if (input.process.spawnError) return { ...summaryBase, status: 'UNKNOWN', reason: 'SPAWN_ERROR' };
  if (input.process.signaled || input.process.interrupted === true)
    return { ...summaryBase, status: 'UNKNOWN', reason: 'PROCESS_INTERRUPTED' };
  if (input.streams.stdout.exceeded || input.streams.stderr.exceeded)
    return { ...summaryBase, status: 'UNKNOWN', reason: 'STREAM_LIMIT' };
  if (!capture)
    return {
      ...summaryBase,
      status: 'UNKNOWN',
      reason: input.captureMissing === true ? 'CAPTURE_MISSING' : 'CAPTURE_INVALID',
    };
  if (!jest.valid)
    return {
      ...summaryBase,
      status: 'UNKNOWN',
      reason: jest.artifact === 'MISSING' ? 'JEST_MISSING' : 'JEST_INVALID',
    };
  if (jest.privateDiagnostics)
    return { ...summaryBase, status: 'UNKNOWN', reason: 'JEST_PRIVATE_DIAGNOSTICS' };
  const cleanJestPass =
    jest.success &&
    jest.passed === 1 &&
    jest.failed === 0 &&
    jest.todo === 0 &&
    jest.failedSuites === 0 &&
    jest.passedSuites === 1 &&
    jest.targetPassed;
  if (input.process.exitCode === 0 && cleanJestPass && capture.terminalStatus === 'PASS')
    return { ...summaryBase, status: 'PASS', reason: 'PASS' };
  if (cleanJestPass || capture.terminalStatus === 'PASS')
    return { ...summaryBase, status: 'UNKNOWN', reason: 'EXIT_JEST_MISMATCH' };
  if (capture.terminalStatus === 'UNKNOWN')
    return { ...summaryBase, status: 'UNKNOWN', reason: 'CAPTURE_UNKNOWN' };
  if (input.process.exitCode !== 0 && jest.failed > 0)
    return { ...summaryBase, status: 'FAIL', reason: 'JEST_FAILED' };
  return { ...summaryBase, status: 'UNKNOWN', reason: 'EXIT_JEST_MISMATCH' };
}

function assertE4D1JestSummary(value: unknown): asserts value is E4D1JestSummary {
  if (!isRecord(value)) throw new Error('E4 D1 capture summary jest differs');
  assertExactKeys(
    value,
    [
      'artifact',
      'valid',
      'success',
      'total',
      'passed',
      'failed',
      'pending',
      'todo',
      'totalSuites',
      'passedSuites',
      'failedSuites',
      'privateDiagnostics',
      'targetPassed',
    ],
    'summary.jest',
  );
  assertOneOf(
    value.artifact,
    [
      'IN_MEMORY',
      'MISSING',
      'NOT_FILE',
      'EMPTY',
      'OVERSIZE',
      'UNREADABLE',
      'INVALID_JSON',
      'PARSED',
    ] as const,
    'summary.jest.artifact',
  );
  for (const key of ['valid', 'success', 'privateDiagnostics', 'targetPassed'])
    assertBoolean(value[key], 'summary.jest.' + key);
  for (const key of [
    'total',
    'passed',
    'failed',
    'pending',
    'todo',
    'totalSuites',
    'passedSuites',
    'failedSuites',
  ])
    assertSafeInteger(value[key], 'summary.jest.' + key);
}

/**
 * Validates the exact public summary envelope emitted by the capture CLI.
 * V1 through V3 are read-only compatibility for historical evidence. V4 persists
 * only fixed, allowlisted terminal diagnostics and never private Jest/capture data.
 */
export function assertE4D1CaptureSummary(value: unknown): asserts value is E4D1CaptureSummary {
  if (!isRecord(value)) throw new Error('E4 D1 capture summary differs');
  assertExactKeys(
    value,
    ['schema', 'status', 'reason', 'process', 'streams', 'jest', 'capture', 'binding'],
    'summary',
  );
  const schema = assertOneOf(
    value.schema,
    [
      E4_D1_CAPTURE_SUMMARY_SCHEMA_V1,
      E4_D1_CAPTURE_SUMMARY_SCHEMA_V2,
      E4_D1_CAPTURE_SUMMARY_SCHEMA_V3,
      E4_D1_CAPTURE_SUMMARY_SCHEMA,
    ] as const,
    'summary.schema',
  );
  const v2 = schema === E4_D1_CAPTURE_SUMMARY_SCHEMA_V2;
  const v3 = schema === E4_D1_CAPTURE_SUMMARY_SCHEMA_V3;
  const v4 = schema === E4_D1_CAPTURE_SUMMARY_SCHEMA;
  const hasDiagnostic = v2 || v3 || v4;
  const status = assertOneOf(value.status, ['PASS', 'FAIL', 'UNKNOWN'] as const, 'summary.status');
  const reason = assertOneOf(
    value.reason,
    [
      'PASS',
      'CAPTURE_MISSING',
      'CAPTURE_INVALID',
      'CAPTURE_UNKNOWN',
      'JEST_MISSING',
      'JEST_INVALID',
      'JEST_PRIVATE_DIAGNOSTICS',
      'JEST_FAILED',
      'EXIT_JEST_MISMATCH',
      'PROCESS_INTERRUPTED',
      'STREAM_LIMIT',
      'SPAWN_ERROR',
      'USAGE',
    ] as const,
    'summary.reason',
  );
  if (!isRecord(value.process)) throw new Error('E4 D1 capture summary process differs');
  assertExactKeys(
    value.process,
    ['exitCode', 'signaled', 'spawnError', 'interrupted'],
    'summary.process',
  );
  if (value.process.exitCode !== null)
    assertSafeInteger(value.process.exitCode, 'summary.process.exitCode', 0, 255);
  for (const key of ['signaled', 'spawnError', 'interrupted'])
    assertBoolean(value.process[key], 'summary.process.' + key);
  if (!isRecord(value.streams)) throw new Error('E4 D1 capture summary streams differs');
  assertExactKeys(
    value.streams,
    ['stdoutBytes', 'stderrBytes', 'stdoutExceeded', 'stderrExceeded'],
    'summary.streams',
  );
  assertSafeInteger(value.streams.stdoutBytes, 'summary.streams.stdoutBytes');
  assertSafeInteger(value.streams.stderrBytes, 'summary.streams.stderrBytes');
  assertBoolean(value.streams.stdoutExceeded, 'summary.streams.stdoutExceeded');
  assertBoolean(value.streams.stderrExceeded, 'summary.streams.stderrExceeded');
  assertE4D1JestSummary(value.jest);
  if (!isRecord(value.capture)) throw new Error('E4 D1 capture summary capture differs');
  assertExactKeys(
    value.capture,
    hasDiagnostic
      ? ['valid', 'terminalStatus', 'source', 'diagnostic']
      : ['valid', 'terminalStatus', 'source'],
    'summary.capture',
  );
  assertBoolean(value.capture.valid, 'summary.capture.valid');
  if (value.capture.terminalStatus !== null)
    assertOneOf(
      value.capture.terminalStatus,
      ['PASS', 'FAIL', 'UNKNOWN'] as const,
      'summary.capture.terminalStatus',
    );
  if (value.capture.source !== null)
    assertOneOf(value.capture.source, ['TERMINAL', 'FALLBACK'] as const, 'summary.capture.source');
  let diagnostic:
    | E4D1SafeTerminalDiagnosticV2
    | E4D1SafeTerminalDiagnosticV3
    | E4D1SafeTerminalDiagnostic
    | null = null;
  if (v2) {
    const candidate = value.capture.diagnostic;
    if (candidate !== null) {
      assertSafeTerminalDiagnosticV2(candidate, 'summary.capture.diagnostic');
      diagnostic = candidate;
    }
  } else if (v3) {
    const candidate = value.capture.diagnostic;
    if (candidate !== null) {
      assertSafeTerminalDiagnosticV3(candidate, 'summary.capture.diagnostic');
      diagnostic = candidate;
    }
  } else if (v4) {
    const candidate = value.capture.diagnostic;
    if (candidate !== null) {
      assertSafeTerminalDiagnostic(candidate, 'summary.capture.diagnostic');
      diagnostic = candidate;
    }
  }
  if (
    !value.capture.valid &&
    (value.capture.terminalStatus !== null ||
      value.capture.source !== null ||
      (hasDiagnostic && diagnostic !== null))
  )
    throw new Error('E4 D1 capture summary capture binding differs');
  if (hasDiagnostic && value.capture.valid && diagnostic === null)
    throw new Error('E4 D1 capture summary diagnostic missing');
  if (value.capture.source === 'FALLBACK' && value.capture.terminalStatus === 'PASS')
    throw new Error('E4 D1 capture summary fallback pass differs');
  if (!isRecord(value.binding)) throw new Error('E4 D1 capture summary binding differs');
  assertExactKeys(value.binding, ['runId', 'scopeHash', 'tokenHash'], 'summary.binding');
  if (value.binding.runId !== null) assertHex(value.binding.runId, 32, 'summary.binding.runId');
  const scopeHash = assertHex(value.binding.scopeHash, 64, 'summary.binding.scopeHash');
  if (scopeHash !== hash(E4_D1_SCOPE)) throw new Error('E4 D1 capture summary scope differs');
  if (value.binding.tokenHash !== null)
    assertHex(value.binding.tokenHash, 64, 'summary.binding.tokenHash');
  const diagnosticsPass =
    !hasDiagnostic ||
    (diagnostic !== null &&
      (v4
        ? safeDiagnosticProvesPass(diagnostic as E4D1SafeTerminalDiagnostic)
        : safeDiagnosticV2ProvesPass(diagnostic)));
  if (status === 'PASS') {
    if (
      reason !== 'PASS' ||
      value.process.exitCode !== 0 ||
      value.process.signaled ||
      value.process.spawnError ||
      value.process.interrupted ||
      value.streams.stdoutExceeded ||
      value.streams.stderrExceeded ||
      !value.capture.valid ||
      value.capture.terminalStatus !== 'PASS' ||
      value.capture.source !== 'TERMINAL' ||
      !diagnosticsPass
    )
      throw new Error('E4 D1 capture summary pass differs');
  }
}

export function e4D1CaptureSummaryExitCode(summary: E4D1CaptureSummary): 0 | 1 | 2 {
  return summary.status === 'PASS' ? 0 : summary.status === 'FAIL' ? 1 : 2;
}

export function drainE4D1Stream(stream: Readable, limit: number): Promise<E4D1StreamResult> {
  return new Promise((resolve) => {
    let bytes = 0;
    let exceeded = false;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve({ bytes, exceeded });
    };
    stream.on('data', (chunk: Buffer | string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > limit) exceeded = true;
    });
    stream.once('error', finish);
    stream.once('end', finish);
    stream.resume();
  });
}

function waitForProcess(child: ReturnType<typeof spawn>): Promise<E4D1ProcessResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: E4D1ProcessResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    child.once('error', () => finish({ exitCode: null, signaled: false, spawnError: true }));
    child.once('close', (code, signal) =>
      finish({ exitCode: code, signaled: signal !== null, spawnError: false }),
    );
  });
}

function readJestResult(file: string): { artifact: E4D1JestArtifact; value: unknown } {
  try {
    const stats = lstatSync(file);
    if (!stats.isFile()) return { artifact: 'NOT_FILE', value: undefined };
    if (stats.size <= 0) return { artifact: 'EMPTY', value: undefined };
    if (stats.size > JEST_JSON_MAX_BYTES) return { artifact: 'OVERSIZE', value: undefined };
    try {
      return { artifact: 'PARSED', value: JSON.parse(readFileSync(file, 'utf8')) as unknown };
    } catch {
      return { artifact: 'INVALID_JSON', value: undefined };
    }
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
      return { artifact: 'MISSING', value: undefined };
    return { artifact: 'UNREADABLE', value: undefined };
  }
}

function d1JestConfig(root: string, testTimeout = 30_000, additionalRoot?: string): string {
  assertSafeInteger(testTimeout, 'jest.timeout', 1, 30_000);
  return JSON.stringify({
    rootDir: root,
    testEnvironment: 'node',
    testRegex: '.*\\.e2e-spec\\.ts$',
    moduleFileExtensions: ['ts', 'js', 'json'],
    transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/test/tsconfig.test.json' }] },
    maxWorkers: 1,
    testTimeout,
    setupFiles: ['<rootDir>/test/setup/setup-files.ts'],
    ...(additionalRoot === undefined ? {} : { roots: [root, additionalRoot] }),
  });
}

type E4D1JestTarget = {
  testPath: string;
  testName: string;
  testTimeout: number;
  e4Enabled: boolean;
  helperPath?: string;
  scenario?: string;
  additionalRoot?: string;
  interruptReadyFile?: string;
  interruptMaxMs?: number;
};

function terminateE4D1ChildTree(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
  if (child.exitCode !== null) return;
  if (process.platform !== 'win32' && typeof child.pid === 'number' && child.pid > 0) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall through to the directly-owned process only when the private group is unavailable.
    }
  }
  child.kill(signal);
}

async function runE4D1CaptureTarget(
  session: E4D1RunnerSession,
  scope: string,
  target: E4D1JestTarget,
): Promise<E4D1CaptureSummary> {
  const root = resolve(__dirname, '../..');
  let readyPoll: NodeJS.Timeout | undefined;
  let interruptTimer: NodeJS.Timeout | undefined;
  let forceTimer: NodeJS.Timeout | undefined;
  let interrupted = false;
  try {
    const child = spawn(
      'pnpm',
      [
        'exec',
        'jest',
        '--runInBand',
        '--no-cache',
        '--bail',
        '--silent',
        '--json',
        '--outputFile',
        session.jestFile,
        '--config',
        d1JestConfig(root, target.testTimeout, target.additionalRoot),
        '--runTestsByPath',
        target.testPath,
        '--testNamePattern',
        '^' + target.testName + '$',
      ],
      {
        cwd: root,
        detached: target.interruptReadyFile !== undefined,
        env: {
          ...process.env,
          SRVF_TEST_RUN_SCOPE: scope,
          SRVF_E4_W98: target.e4Enabled ? '1' : '0',
          SRVF_E4_D1_CAPTURE_DIR: session.context.captureDir,
          SRVF_E4_D1_RESULT_FILE: session.context.resultFile,
          SRVF_E4_D1_CAPTURE_TOKEN: session.context.token,
          SRVF_E4_D1_CAPTURE_HELPER: target.helperPath ?? '',
          SRVF_E4_D1_OFFLINE_SCENARIO: target.scenario ?? '',
          SRVF_E4_D1_INTERRUPT_READY_FILE: target.interruptReadyFile ?? '',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const interrupt = () => {
      if (interrupted || child.exitCode !== null) return;
      interrupted = true;
      terminateE4D1ChildTree(child, 'SIGTERM');
      forceTimer = setTimeout(() => terminateE4D1ChildTree(child, 'SIGKILL'), 2_000);
    };
    if (target.interruptReadyFile !== undefined) {
      const ready = () => {
        if (existsSync(target.interruptReadyFile!)) interrupt();
      };
      ready();
      readyPoll = setInterval(ready, 20);
      interruptTimer = setTimeout(interrupt, target.interruptMaxMs ?? 15_000);
    }
    const stdout = drainE4D1Stream(child.stdout, STREAM_MAX_BYTES);
    const stderr = drainE4D1Stream(child.stderr, STREAM_MAX_BYTES);
    const processResult = await waitForProcess(child);
    const streams = await Promise.all([stdout, stderr]);
    const jest = readJestResult(session.jestFile);
    let capture: unknown;
    let captureSource: 'TERMINAL' | 'FALLBACK' | undefined;
    let captureMissing = false;
    try {
      const record = readE4D1CaptureResult(session.context);
      capture = record.result;
      captureSource = record.source;
    } catch {
      capture = undefined;
      captureMissing =
        !existsSync(session.context.resultFile) && !existsSync(session.context.fallbackFile);
    }
    return summarizeE4D1Capture({
      process: { ...processResult, interrupted },
      streams: { stdout: streams[0], stderr: streams[1] },
      jest: jest.value,
      jestArtifact: jest.artifact,
      capture,
      captureSource,
      context: session.context,
      captureMissing,
    });
  } catch {
    return summarizeE4D1Capture({
      process: { exitCode: null, signaled: false, spawnError: true, interrupted },
      streams: {
        stdout: { bytes: 0, exceeded: false },
        stderr: { bytes: 0, exceeded: false },
      },
      jest: undefined,
      jestArtifact: 'MISSING',
      capture: undefined,
      context: session.context,
      captureMissing: true,
    });
  } finally {
    if (readyPoll !== undefined) clearInterval(readyPoll);
    if (interruptTimer !== undefined) clearTimeout(interruptTimer);
    if (forceTimer !== undefined) clearTimeout(forceTimer);
  }
}

export async function runE4D1Capture(scope: string): Promise<E4D1CaptureSummary> {
  const session = createE4D1CaptureSession(scope);
  try {
    return await runE4D1CaptureTarget(session, scope, {
      testPath: 'test/e2e/activity-os-r5-e4-contribution-settlement-migration.e2e-spec.ts',
      testName: E4_D1_JEST_FULL_NAME,
      testTimeout: 30_000,
      e4Enabled: true,
    });
  } finally {
    session.dispose();
  }
}

function summarizeE4N1Admission(
  process: E4D1ProcessResult,
  streams: { stdout: E4D1StreamResult; stderr: E4D1StreamResult },
  jest: E4D1JestSummary,
): E4N1AdmissionSummary {
  const clean =
    process.exitCode === 0 &&
    !process.signaled &&
    !process.spawnError &&
    !streams.stdout.exceeded &&
    !streams.stderr.exceeded &&
    jest.valid &&
    jest.success &&
    jest.passed === 1 &&
    jest.failed === 0 &&
    jest.todo === 0 &&
    jest.failedSuites === 0 &&
    !jest.privateDiagnostics &&
    jest.targetPassed;
  return {
    schema: E4_N1_ADMISSION_SCHEMA,
    status: clean
      ? 'READY'
      : process.spawnError ||
          process.signaled ||
          streams.stdout.exceeded ||
          streams.stderr.exceeded ||
          !jest.valid
        ? 'UNKNOWN'
        : 'REJECTED',
    process: {
      exitCode: process.exitCode,
      signaled: process.signaled,
      spawnError: process.spawnError,
    },
    streams: {
      stdoutBytes: streams.stdout.bytes,
      stderrBytes: streams.stderr.bytes,
      stdoutExceeded: streams.stdout.exceeded,
      stderrExceeded: streams.stderr.exceeded,
    },
    jest,
  };
}

/**
 * This is deliberately separate from runE4D1Capture().  It runs only the
 * read-only admission test; a non-ready result never starts the D1 test child
 * or writes a D1 capture result.
 */
export async function runE4N1AdmissionCheck(scope: string): Promise<E4N1AdmissionSummary> {
  const session = createE4D1CaptureSession(scope);
  const root = resolve(__dirname, '../..');
  try {
    const child = spawn(
      'pnpm',
      [
        'exec',
        'jest',
        '--runInBand',
        '--no-cache',
        '--bail',
        '--silent',
        '--json',
        '--outputFile',
        session.jestFile,
        '--config',
        d1JestConfig(root, 30_000),
        '--runTestsByPath',
        'test/e2e/activity-os-r5-e4-contribution-settlement-migration.e2e-spec.ts',
        '--testNamePattern',
        '^' + E4_N1_ADMISSION_JEST_FULL_NAME + '$',
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          SRVF_TEST_RUN_SCOPE: scope,
          SRVF_E4_W98: '1',
          SRVF_E4_N1_ADMISSION: '1',
          SRVF_E4_D1_CAPTURE_DIR: session.context.captureDir,
          SRVF_E4_D1_RESULT_FILE: session.context.resultFile,
          SRVF_E4_D1_CAPTURE_TOKEN: session.context.token,
          SRVF_E4_D1_CAPTURE_HELPER: '',
          SRVF_E4_D1_OFFLINE_SCENARIO: '',
          SRVF_E4_D1_INTERRUPT_READY_FILE: '',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const stdout = drainE4D1Stream(child.stdout, STREAM_MAX_BYTES);
    const stderr = drainE4D1Stream(child.stderr, STREAM_MAX_BYTES);
    const processResult = await waitForProcess(child);
    const streams = await Promise.all([stdout, stderr]);
    const jestFile = readJestResult(session.jestFile);
    return summarizeE4N1Admission(
      processResult,
      { stdout: streams[0], stderr: streams[1] },
      parseJestSummary(jestFile.value, jestFile.artifact, E4_N1_ADMISSION_JEST_FULL_NAME),
    );
  } catch {
    return summarizeE4N1Admission(
      { exitCode: null, signaled: false, spawnError: true },
      {
        stdout: { bytes: 0, exceeded: false },
        stderr: { bytes: 0, exceeded: false },
      },
      emptyJestSummary('MISSING'),
    );
  } finally {
    session.dispose();
  }
}

export const E4_D1_OFFLINE_SCENARIOS = [
  'success',
  'assertion-failure',
  'proof-missing',
  'eligibility-all-branches',
  'cleanup-unknown-terminal',
  'cleanup-unknown',
  'timeout',
  'interrupted',
  'jest-unavailable',
] as const;
type E4D1OfflineScenario = (typeof E4_D1_OFFLINE_SCENARIOS)[number];

function e4D1OfflineScenarioSource(helperPath: string): string {
  return [
    'const capture = require(' + JSON.stringify(helperPath) + ');',
    "const { writeFileSync } = require('node:fs');",
    "describe('E4 terminal expected retained function-body diagnostic', () => {",
    "  it('pins retained full source and captures the complete current body once', async () => {",
    '    const context = capture.openE4D1CaptureContext(process.env);',
    '    const scenario = process.env.SRVF_E4_D1_OFFLINE_SCENARIO;',
    '    const bodyRecognition = () => {',
    '      const nodeTypeCounts = Object.fromEntries(capture.E4_D1_BODY_RECOGNITION_NODE_TYPES.map((nodeType) => [nodeType, 0]));',
    "      nodeTypeCounts.Result = 2; nodeTypeCounts['CTE Scan'] = 1;",
    "      return { nodeCount: 3, nodeTypeCounts, nodes: [{ ordinal: 0, parentOrdinal: null, nodeType: 'Result', role: 'root', ctePresent: false, cteTargetExact: false, cteTargetPrefix: false, subplanPresent: false, subplanTargetExact: false, subplanTargetPrefix: false }, { ordinal: 1, parentOrdinal: 0, nodeType: 'Result', role: 'producer', ctePresent: false, cteTargetExact: false, cteTargetPrefix: false, subplanPresent: true, subplanTargetExact: true, subplanTargetPrefix: true }, { ordinal: 2, parentOrdinal: 0, nodeType: 'CTE Scan', role: 'consumer', ctePresent: true, cteTargetExact: true, cteTargetPrefix: true, subplanPresent: false, subplanTargetExact: false, subplanTargetPrefix: false }] };",
    '    };',
    '    const terminal = () => {',
    '      const before = { databases: 1, clients: 0, ownerBackends: 1, leaseLocks: 1, leaseOwnerVisible: true, observerVisible: true, planVisible: false, exactScope: true, samePrincipal: true, sameServer: true };',
    '      const after = { ...before, ownerBackends: 0, leaseLocks: 0, leaseOwnerVisible: false };',
    '      return {',
    "        completed: true, failedPhase: null, failureCode: null, temporary: 'ABSENT',",
    '        planClosed: true, observerClosed: true, pending: 0, idle: true, settingsRestored: true, publicUnchanged: true, releaseKnown: true, deadlinePassed: false,',
    '        before, after,',
    '        nullCalibration: { observed: true, eligibility: false, fullCoverageRejected: true },',
    '        fullPlan: { observed: true, eligibility: true, nodeCount: 3, bodyEligibility: { producerMatches: 1, consumerMatches: 1, producer: { actualRows: 8000, loops: 1, tempRead: 10, tempWritten: 10 }, consumer: { actualRows: 8000, loops: 1, tempRead: 10, tempWritten: 0 }, checks: { producerExactlyOne: true, consumerExactlyOne: true, producerRows: true, consumerRows: true, producerLoops: true, consumerLoops: true, temporaryWritten: true, eligible: true }, rejected: [] }, bodyRecognition: bodyRecognition() },',
    "        proofs: capture.E4_D1_PROOF_STEPS.map((step) => ({ outcome: 'PASS', step, durationMs: 1.234, values: { ...capture.E4_D1_PROOF_EXPECTED[step] } })),",
    '      };',
    '    };',
    "    if (scenario === 'success') { capture.writeE4D1SafeResult(context, terminal()); return; }",
    "    if (scenario === 'assertion-failure') {",
    '      const failed = terminal();',
    "      failed.completed = false; failed.failedPhase = 'complete-proof-source-hashes'; failed.failureCode = 'FULL_TRUTH';",
    "      const sourceProof = failed.proofs.find((proof) => proof.step === 'source-hashes');",
    "      if (!sourceProof) throw new Error('synthetic source proof missing');",
    '      sourceProof.values.references = 49999;',
    '      capture.writeE4D1SafeResult(context, failed);',
    "      throw new Error('synthetic assertion must remain private');",
    '    }',
    "    if (scenario === 'proof-missing') {",
    '      const failed = terminal();',
    "      failed.completed = false; failed.failedPhase = 'complete-proof-source-hashes'; failed.failureCode = 'FULL_TRUTH';",
    '      failed.proofs = failed.proofs.slice(0, 4);',
    '      capture.writeE4D1SafeResult(context, failed);',
    "      throw new Error('synthetic missing proof must remain private');",
    '    }',
    "    if (scenario === 'eligibility-all-branches') {",
    '      const failed = terminal();',
    "      failed.completed = false; failed.failedPhase = 'complete-current-body-plan'; failed.failureCode = 'ELIGIBILITY';",
    '      failed.fullPlan = { observed: true, eligibility: false, nodeCount: 3, bodyEligibility: { producerMatches: 2, consumerMatches: 2, producer: null, consumer: null, checks: { producerExactlyOne: false, consumerExactlyOne: false, producerRows: false, consumerRows: false, producerLoops: false, consumerLoops: false, temporaryWritten: false, eligible: false }, rejected: [...capture.E4_D1_BODY_ELIGIBILITY_REJECTIONS] }, bodyRecognition: bodyRecognition() };',
    '      capture.writeE4D1SafeResult(context, failed);',
    "      throw new Error('synthetic eligibility detail must remain private');",
    '    }',
    "    if (scenario === 'cleanup-unknown-terminal') {",
    '      const cleanup = terminal();',
    "      cleanup.completed = false; cleanup.failedPhase = 'plan-close'; cleanup.failureCode = null; cleanup.planClosed = false;",
    '      capture.writeE4D1SafeResult(context, cleanup);',
    "      throw new Error('synthetic cleanup unknown must remain private');",
    '    }',
    "    if (scenario === 'cleanup-unknown') {",
    '      const cleanup = terminal();',
    "      cleanup.completed = false; cleanup.failedPhase = 'plan-close'; cleanup.planClosed = false;",
    '      try {',
    "        throw new Error('synthetic original terminal failure must remain primary');",
    '      } finally {',
    '        const malformed = { ...cleanup, unexpected: true };',
    '        try { capture.writeE4D1SafeResult(context, malformed); } catch {',
    '          try { capture.writeE4D1FallbackUnknownResult(context); } catch {}',
    '        }',
    '      }',
    '    }',
    "    if (scenario === 'interrupted') {",
    "      writeFileSync(process.env.SRVF_E4_D1_INTERRUPT_READY_FILE, 'armed', { encoding: 'utf8', mode: 0o600, flag: 'wx' });",
    '      await new Promise(() => {});',
    '      return;',
    '    }',
    "    if (scenario === 'timeout') { await new Promise(() => {}); return; }",
    "    throw new Error('offline scenario differs');",
    '  });',
    '});',
    '',
  ].join('\n');
}

function writeE4D1OfflineScenarioFile(file: string, helperPath: string): void {
  writeFileSync(file, e4D1OfflineScenarioSource(helperPath), {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
  chmodSync(file, 0o600);
}

async function runE4D1OfflineScenario(scenario: E4D1OfflineScenario): Promise<E4D1CaptureSummary> {
  const session = createE4D1CaptureSession();
  try {
    const synthetic = join(session.context.captureDir, 'offline.e2e-spec.ts');
    const unavailable = scenario === 'jest-unavailable';
    if (!unavailable) writeE4D1OfflineScenarioFile(synthetic, resolve(__filename));
    const interruptReadyFile =
      scenario === 'interrupted' ? join(session.context.captureDir, '.interrupt-ready') : undefined;
    return await runE4D1CaptureTarget(session, E4_D1_SCOPE, {
      testPath: unavailable ? join(session.context.captureDir, 'missing.e2e-spec.ts') : synthetic,
      testName: E4_D1_JEST_FULL_NAME,
      testTimeout: scenario === 'timeout' ? 100 : 30_000,
      e4Enabled: false,
      helperPath: resolve(__filename),
      scenario,
      additionalRoot: session.context.captureDir,
      interruptReadyFile,
      interruptMaxMs: 15_000,
    });
  } finally {
    session.dispose();
  }
}

function runnerUsage(): E4D1CaptureSummary {
  return {
    schema: E4_D1_CAPTURE_SUMMARY_SCHEMA,
    status: 'UNKNOWN',
    reason: 'USAGE',
    process: { exitCode: null, signaled: false, spawnError: false, interrupted: false },
    streams: {
      stdoutBytes: 0,
      stderrBytes: 0,
      stdoutExceeded: false,
      stderrExceeded: false,
    },
    jest: emptyJestSummary('IN_MEMORY'),
    capture: { valid: false, terminalStatus: null, source: null, diagnostic: null },
    binding: e4D1SummaryBinding(),
  };
}

async function main(argv: string[]): Promise<void> {
  const [command, firstValue, secondValue, ...rest] = argv;
  let summary: E4D1CaptureSummary;
  if (
    command === '--execute' &&
    firstValue === '--scope' &&
    rest.length === 0 &&
    secondValue === E4_D1_SCOPE
  )
    summary = await runE4D1Capture(secondValue);
  else if (
    command === '--offline-scenario' &&
    typeof firstValue === 'string' &&
    secondValue === undefined &&
    rest.length === 0 &&
    (E4_D1_OFFLINE_SCENARIOS as readonly string[]).includes(firstValue)
  )
    summary = await runE4D1OfflineScenario(firstValue as E4D1OfflineScenario);
  else summary = runnerUsage();
  process.stdout.write(JSON.stringify(summary) + '\n');
  process.exitCode = summary.status === 'PASS' ? 0 : summary.status === 'FAIL' ? 1 : 2;
}

if (require.main === module) void main(process.argv.slice(2));
