import { performance } from 'node:perf_hooks';

const PHASES = [
  'transaction',
  'callback',
  'correctionCommit',
  'timeAllocationMaterialization',
  'correctionReceipt',
  'ledgerCommit',
  'applicationCommitted',
  'requestApplied',
  'finalAudit',
  'readBatchDayDeltas',
  'assertPreparedSetConsistent',
] as const;
export type D7TimingPhase = (typeof PHASES)[number];
type Edge = 'ENTERED' | 'RETURNED' | 'THREW';
type Point = {
  monoMs: number;
  mainUserUs: number;
  mainSystemUs: number;
  processUserUs: number;
  processSystemUs: number;
  loopActiveMs: number;
  loopIdleMs: number;
};
type SelfPoint = Pick<Point, 'monoMs' | 'mainUserUs' | 'mainSystemUs'>;
const POINT_KEYS = [
  'monoMs',
  'mainUserUs',
  'mainSystemUs',
  'processUserUs',
  'processSystemUs',
  'loopActiveMs',
  'loopIdleMs',
] as const;

function selfPoint(): SelfPoint {
  if (typeof process.threadCpuUsage !== 'function') throw new Error('thread CPU unavailable');
  const cpu = process.threadCpuUsage();
  return {
    monoMs: Number(process.hrtime.bigint()) / 1e6,
    mainUserUs: cpu.user,
    mainSystemUs: cpu.system,
  };
}
function nativePoint(): Point {
  const main = selfPoint();
  const cpu = process.cpuUsage();
  const loop = performance.eventLoopUtilization();
  return {
    ...main,
    processUserUs: cpu.user,
    processSystemUs: cpu.system,
    loopActiveMs: loop.active,
    loopIdleMs: loop.idle,
  };
}
function validPoint(point: SelfPoint) {
  return Object.values(point).every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0);
}

// Only these fixed statement labels survive. SQL and parameters are never stored.
export function d7StatementKind(query: string) {
  const inserts = [
    ['CorrectionTimeAllocationBinding', 'binding_insert'],
    ['ParticipantTimeAllocationRevision', 'allocation_insert'],
    ['ParticipantTimeAllocationSlice', 'slice_insert'],
    ['ParticipantTimeAllocationEvidence', 'evidence_insert'],
    ['ParticipantTimeAllocationCommandReceipt', 'allocation_receipt_insert'],
    ['ParticipationTimeCorrectionCommitReceipt', 'correction_receipt_insert'],
  ] as const;
  for (const [table, label] of inserts) {
    if (new RegExp('^\\s*INSERT\\s+INTO\\s+(?:"public"\\.)?"' + table + '"', 'iu').test(query))
      return label;
  }
  if (/^\s*(?:SELECT|WITH)\b/iu.test(query)) {
    if (query.includes('unreversed_facts AS') && query.includes('"ParticipationLedgerEntry"'))
      return 'ledger_shape_facts';
    if (query.includes('GROUP BY') && query.includes('"ParticipationLedgerEntry"'))
      return 'ledger_day_deltas';
    if (query.includes('"CorrectionTimeSourceProof"')) return 'source_proof_read';
    if (query.includes('"CorrectionPendingTimeAllocation"')) return 'pending_allocation_read';
    if (query.includes('"ParticipantTimeAllocationRevision"')) return 'allocation_read';
  }
  if (/^\s*(?:BEGIN|START\s+TRANSACTION|SET\s+TRANSACTION|COMMIT|ROLLBACK)(?:\s|;|$)/iu.test(query))
    return 'transaction_control';
  return 'other';
}

type Boundary = { phase: D7TimingPhase; edge: Edge; point: Point | null };
type Received = {
  ordinal: number;
  kind: ReturnType<typeof d7StatementKind>;
  phaseAtReceive: D7TimingPhase | 'outside';
  receivedPoint: Point | null;
  prismaDurationMs: number;
};
type Cost = { calls: number; wallMs: number; mainCpuUs: number };

/** Test-only bounded recording. Every instrumentation fault becomes UNKNOWN. */
export class D7CommitTiming {
  private faults = 0;
  private droppedEvents = 0;
  private droppedBoundaries = 0;
  private totalEvents = 0;
  private lastPoint: Point | undefined;
  private readonly stack: D7TimingPhase[] = [];
  private readonly boundaries: Boundary[] = [];
  private readonly events: Received[] = [];
  private readonly costs: Record<'queryListener' | 'boundary', Cost> = {
    queryListener: { calls: 0, wallMs: 0, mainCpuUs: 0 },
    boundary: { calls: 0, wallMs: 0, mainCpuUs: 0 },
  };
  private readonly calibration: { beforeMonoMs: number; utcMs: number; afterMonoMs: number };

  constructor(
    private readonly capture: () => Point = nativePoint,
    private readonly costClock: () => SelfPoint = selfPoint,
  ) {
    this.calibration = {
      beforeMonoMs: Number(process.hrtime.bigint()) / 1e6,
      utcMs: Date.now(),
      afterMonoMs: Number(process.hrtime.bigint()) / 1e6,
    };
  }

  private point(): Point | null {
    try {
      const raw = this.capture();
      const point = Object.fromEntries(POINT_KEYS.map((key) => [key, raw[key]])) as Point;
      if (
        !validPoint(point) ||
        POINT_KEYS.some((key) => this.lastPoint && point[key] < this.lastPoint[key])
      )
        throw new Error('invalid or regressed timing point');
      this.lastPoint = point;
      return point;
    } catch {
      this.faults++;
      return null;
    }
  }

  private observe(kind: keyof D7CommitTiming['costs'], work: () => void): void {
    let before: SelfPoint | undefined;
    try {
      before = this.costClock();
      if (!validPoint(before)) throw new Error('invalid recorder clock');
    } catch {
      before = undefined;
      this.faults++;
    }
    try {
      work();
    } catch {
      this.faults++;
    } finally {
      const cost = this.costs[kind];
      cost.calls++;
      try {
        const after = this.costClock();
        if (!before || !validPoint(after)) this.faults++;
        else {
          const wall = after.monoMs - before.monoMs;
          const cpu =
            after.mainUserUs + after.mainSystemUs - before.mainUserUs - before.mainSystemUs;
          if (wall < 0 || cpu < 0) this.faults++;
          else {
            cost.wallMs += wall;
            cost.mainCpuUs += cpu;
          }
        }
      } catch {
        this.faults++;
      }
    }
  }

  boundary(phase: D7TimingPhase, edge: Edge): void {
    this.observe('boundary', () => {
      if (!PHASES.includes(phase) || !['ENTERED', 'RETURNED', 'THREW'].includes(edge))
        throw new Error('unknown fixed phase or edge');
      const point = this.point();
      if (edge === 'ENTERED') this.stack.push(phase);
      else if (this.stack.pop() !== phase) this.faults++;
      if (this.boundaries.length < 32) this.boundaries.push({ phase, edge, point });
      else this.droppedBoundaries++;
    });
  }

  query(query: string, durationMs: number, existingListener: () => void): void {
    this.observe('queryListener', () => {
      // Preserve the prior aggregates even if the new sampler later fails.
      existingListener();
      this.totalEvents++;
      if (!Number.isFinite(durationMs) || durationMs < 0) throw new Error('invalid duration');
      const receivedPoint = this.point();
      if (this.events.length === 96) {
        this.droppedEvents++;
        return;
      }
      this.events.push({
        ordinal: this.totalEvents,
        kind: d7StatementKind(query),
        phaseAtReceive: this.stack.at(-1) ?? 'outside',
        receivedPoint,
        prismaDurationMs: durationMs,
      });
    });
  }

  report() {
    return {
      schemaVersion: 1,
      status:
        this.faults === 0 &&
        this.droppedEvents === 0 &&
        this.droppedBoundaries === 0 &&
        this.stack.length === 0
          ? 'KNOWN'
          : 'UNKNOWN',
      semantics:
        'receive clocks and inclusive method spans; durations do not partition callback wall',
      calibration: { ...this.calibration },
      faults: this.faults,
      totalEvents: this.totalEvents,
      retainedEvents: this.events.length,
      droppedEvents: this.droppedEvents,
      droppedBoundaries: this.droppedBoundaries,
      openPhases: this.stack.length,
      recorderCosts: structuredClone(this.costs),
      boundaries: structuredClone(this.boundaries),
      receivedEvents: structuredClone(this.events),
    };
  }
}

export async function observeD7Span<T>(
  recorder: D7CommitTiming | undefined,
  phase: D7TimingPhase,
  work: () => Promise<T>,
): Promise<T> {
  recorder?.boundary(phase, 'ENTERED');
  try {
    const result = await work();
    recorder?.boundary(phase, 'RETURNED');
    return result;
  } catch (error) {
    recorder?.boundary(phase, 'THREW');
    throw error;
  }
}

export function d7ObservedMethod<TThis, TArgs extends unknown[], TResult>(
  recorder: D7CommitTiming | undefined,
  phase: D7TimingPhase,
  original: (this: TThis, ...args: TArgs) => Promise<TResult>,
) {
  return function (this: TThis, ...args: TArgs): Promise<TResult> {
    return observeD7Span(recorder, phase, () => original.apply(this, args));
  };
}
