import { spawn } from 'node:child_process';
import { assertTestDatabaseUrl } from '../setup/test-db';
import { assertNamedTestDatabaseScope } from '../setup/test-run-scope';
import { deriveTestDbName, deriveWorkerTestDbName } from '../setup/worktree-db';

const NODE_TYPES = new Set([
  'Result',
  'Aggregate',
  'Seq Scan',
  'Index Scan',
  'Index Only Scan',
  'Bitmap Heap Scan',
  'Bitmap Index Scan',
  'Function Scan',
  'Nested Loop',
  'Hash Join',
  'Merge Join',
  'Hash',
  'Sort',
  'Incremental Sort',
  'Materialize',
  'Memoize',
  'Append',
  'Subquery Scan',
  'CTE Scan',
  'Limit',
  'WindowAgg',
  'Unique',
  'Gather',
  'Gather Merge',
]);
const METRICS = [
  'Actual Startup Time',
  'Actual Total Time',
  'Actual Rows',
  'Actual Loops',
  'Rows Removed by Filter',
  'Rows Removed by Join Filter',
  'Shared Hit Blocks',
  'Shared Read Blocks',
  'Temp Read Blocks',
  'Temp Written Blocks',
  'Heap Fetches',
];
const MAX_BYTES = 2_000_000;
const MAX_PLANS = 24;

/** Fixed enums and finite numeric metrics only: even allowed-key string values are rejected. */
export function sanitizeGuardPlan(value: unknown, depth = 0): unknown {
  if (depth > 24 || value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  const input = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  if (typeof input['Node Type'] === 'string') {
    output['Node Type'] = NODE_TYPES.has(input['Node Type']) ? input['Node Type'] : 'Other';
  }
  for (const key of METRICS) {
    const item = input[key];
    if (typeof item === 'number' && Number.isFinite(item) && item >= 0 && item <= 1e12)
      output[key] = item;
  }
  if (Array.isArray(input.Plans))
    output.Plans = input.Plans.slice(0, 64).map((plan) => sanitizeGuardPlan(plan, depth + 1));
  return output;
}

/** Parse only bounded auto_explain JSON frames; never return raw notice or query text. */
export function parseGuardPlanTrace(trace: string) {
  if (trace.length > MAX_BYTES) return { plans: [], malformed: true, truncated: true };
  const plans: Array<{ elapsedMs: number; plan: unknown }> = [];
  const header = /NOTICE:\s+duration:\s+(\d+(?:\.\d+)?)\s+ms\s+plan:\s*/g;
  let malformed = false;
  let total = 0;
  let match: RegExpExecArray | null;
  while ((match = header.exec(trace))) {
    const start = header.lastIndex;
    if (trace[start] !== '{') {
      malformed = true;
      continue;
    }
    let level = 0,
      quoted = false,
      escaped = false,
      end = -1;
    for (let cursor = start; cursor < trace.length; cursor++) {
      const char = trace[cursor];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') quoted = false;
      } else if (char === '"') quoted = true;
      else if (char === '{') level++;
      else if (char === '}' && --level === 0) {
        end = cursor + 1;
        break;
      }
    }
    if (end < 0) {
      malformed = true;
      break;
    }
    header.lastIndex = end;
    try {
      const frame: unknown = JSON.parse(trace.slice(start, end));
      if (!frame || typeof frame !== 'object' || !('Plan' in frame)) {
        malformed = true;
        continue;
      }
      total++;
      const elapsedMs = Number(match[1]);
      if (!Number.isFinite(elapsedMs) || elapsedMs > 1e12) {
        malformed = true;
        continue;
      }
      if (plans.length < MAX_PLANS) plans.push({ elapsedMs, plan: sanitizeGuardPlan(frame.Plan) });
    } catch {
      malformed = true;
    }
  }
  return { plans, malformed, truncated: total > MAX_PLANS };
}

const CHANNEL_SQL = `BEGIN READ ONLY;
SET LOCAL statement_timeout = 5000;
SET LOCAL lock_timeout = 1000;
SET LOCAL log_min_messages = panic;
SET LOCAL log_min_error_statement = panic;
SET LOCAL log_statement = none;
SET LOCAL log_duration = off;
SET LOCAL log_min_duration_statement = -1;
SET LOCAL log_min_duration_sample = -1;
SET LOCAL log_transaction_sample_rate = 0;
LOAD 'auto_explain';
SET LOCAL auto_explain.log_min_duration = 0;
SET LOCAL auto_explain.log_level = notice;
SET LOCAL auto_explain.log_format = json;
SET LOCAL auto_explain.log_analyze = on;
SET LOCAL auto_explain.log_buffers = on;
SET LOCAL auto_explain.log_timing = on;
SET LOCAL auto_explain.log_nested_statements = on;
SET LOCAL client_min_messages = notice;
DO $$BEGIN
 IF current_setting('log_min_messages') <> 'panic'
 OR current_setting('log_min_error_statement') <> 'panic'
 OR current_setting('log_statement') <> 'none'
 OR current_setting('log_duration') <> 'off'
 OR current_setting('log_min_duration_statement') <> '-1'
 OR current_setting('log_min_duration_sample') <> '-1'
 OR current_setting('log_transaction_sample_rate')::numeric <> 0
 OR current_setting('auto_explain.log_level') <> 'notice'
 OR current_setting('auto_explain.log_nested_statements') <> 'on' THEN
   RAISE EXCEPTION 'diagnostic channel refused';
 END IF;
END$$;
SELECT 1;
\\echo SRVF_GUARD_CHANNEL_VERIFIED
`;

export async function runD7GuardPlanDiagnostic(postingBatchId?: string) {
  // This path is opt-in test evidence only; never enable it on a normal CI or business connection.
  if (process.env.SRVF_D7_GUARD_INTERNAL_DIAGNOSTIC !== '1' || process.env.SRVF_D7_2_W98 !== '1') {
    throw new Error('D7 guard diagnostic requires explicit isolated mode');
  }
  const database = deriveWorkerTestDbName(98);
  assertNamedTestDatabaseScope([database]);
  assertTestDatabaseUrl(process.env.DATABASE_URL);
  if (
    deriveTestDbName() !== database ||
    (postingBatchId !== undefined && !/^[a-zA-Z0-9_-]{1,128}$/.test(postingBatchId))
  ) {
    throw new Error('D7 guard diagnostic fixture anchor mismatch');
  }
  return new Promise<{
    sample: 'separate_session_rollback';
    evidence: 'not_failed_transaction';
    channel: 'verified' | 'unavailable';
    outcome: 'success' | 'rejected' | 'timeout' | 'overflow';
    plans: ReturnType<typeof parseGuardPlanTrace>;
  }>((resolve) => {
    const child = spawn(
      'docker',
      [
        'exec',
        '-i',
        'u-nest-api-postgres',
        'psql',
        '--no-psqlrc',
        '-qtA',
        '-U',
        'postgres',
        '-d',
        database,
        '-v',
        'ON_ERROR_STOP=1',
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let stdout = '',
      stderr = '',
      bytes = 0,
      done = false;
    const finish = (outcome: 'success' | 'rejected' | 'timeout' | 'overflow') => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const parsed = parseGuardPlanTrace(stderr);
      resolve({
        sample: 'separate_session_rollback',
        evidence: 'not_failed_transaction',
        channel:
          stdout.split(/\r?\n/).includes('SRVF_GUARD_CHANNEL_VERIFIED') &&
          parsed.plans.length > 0 &&
          !parsed.malformed
            ? 'verified'
            : 'unavailable',
        outcome,
        plans: parsed,
      });
      stdout = '';
      stderr = '';
    };
    const timer = setTimeout(() => {
      child.kill();
      finish('timeout');
    }, 20_000);
    const capture = (target: 'stdout' | 'stderr', chunk: Buffer) => {
      if (done) return;
      bytes += chunk.length;
      if (bytes > MAX_BYTES) {
        child.kill();
        finish('overflow');
        return;
      }
      if (target === 'stdout') stdout += chunk.toString();
      else stderr += chunk.toString();
    };
    child.stdout.on('data', (chunk: Buffer) => capture('stdout', chunk));
    child.stderr.on('data', (chunk: Buffer) => capture('stderr', chunk));
    child.on('error', () => finish('rejected'));
    child.stdin.on('error', () => {
      child.kill();
      finish('rejected');
    });
    child.on('close', (code) => finish(code === 0 ? 'success' : 'rejected'));
    child.stdin.end(
      CHANNEL_SQL +
        (postingBatchId === undefined
          ? ''
          : `SELECT public.ptc_assert_complete('${postingBatchId}');\nSELECT public.ctsp_assert_complete('${postingBatchId}', TRUE);\n`) +
        'ROLLBACK;\n',
    );
  });
}
