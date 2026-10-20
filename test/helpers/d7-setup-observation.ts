import { performance } from 'node:perf_hooks';
import { getHeapStatistics } from 'node:v8';

const LABELS = [
  'base',
  'capacity',
  'seal',
  'generate',
  'generateDrain',
  'timePrepare',
  'timeSubmit',
  'postingFixture',
  'ledgerEnsure',
  'ledgerChunk',
  'ledgerFinalize',
  'initialCommit',
  'committedFacts',
  'humanSubmit',
  'humanReview',
  'humanPrepare',
  'proofRead',
  'batchTransaction',
  'batchCallback',
  'batchParents',
  'batchSlices',
  'batchEvidence',
  'batchReceipt',
] as const;
export type D7SetupLabel = (typeof LABELS)[number];
export type D7SetupBatch = {
  family: 'draftAllocations' | 'committedAllocations';
  offset: number;
  total: number;
  parents: number;
  slices: number;
  evidence: number;
  receipts: number;
};
export type D7SetupMeta = D7SetupBatch | { chunkIndex: number; totalChunks: number } | null;
type Heap = { usedBytes: number; limitBytes: number };
type Calibration = {
  timeOriginUnixMs: number;
  beforeMs: number;
  utcMs: number;
  afterMs: number;
  uptimeMs: number;
};
type Span = {
  ordinal: number;
  parent: number | null;
  label: D7SetupLabel;
  meta: D7SetupMeta;
  enteredMs: number | null;
  settledMs: number | null;
  outcome: 'ENTERED' | 'RETURNED' | 'THREW';
  heapBefore: Heap | null;
  heapAfter: Heap | null;
};
function calibration(): Calibration {
  const beforeMs = performance.now();
  const utcMs = Date.now();
  const uptimeMs = process.uptime() * 1000;
  return {
    timeOriginUnixMs: performance.timeOrigin,
    beforeMs,
    utcMs,
    afterMs: performance.now(),
    uptimeMs,
  };
}
function heap(): Heap {
  const value = getHeapStatistics();
  return { usedBytes: value.used_heap_size, limitBytes: value.heap_size_limit };
}

/** Synchronous diagnostic failures never replace the business result or error. */
export function safeD7Diagnostic(work: () => unknown, onFailure?: () => void): boolean {
  try {
    work();
    return true;
  } catch {
    try {
      onFailure?.();
    } catch {
      /* Missing output is UNKNOWN at the external gate. */
    }
    return false;
  }
}

export async function observeD7Receipt<T>(
  original: () => Promise<T>,
  observe: () => Promise<void>,
  report: (error: unknown) => void,
  fault?: () => void,
): Promise<T> {
  try {
    await observe();
  } catch (error) {
    safeD7Diagnostic(() => fault?.());
    safeD7Diagnostic(() => report(error), fault);
  }
  return original();
}
export async function preserveD7Prepare<T>(
  original: () => Promise<T>,
  eligible: () => Promise<boolean>,
  probe: () => Promise<void>,
  report: (error: unknown) => void,
  fault?: () => void,
): Promise<T> {
  try {
    return await original();
  } catch (error) {
    try {
      if (await eligible()) await probe();
    } catch (diagnosticError) {
      safeD7Diagnostic(() => fault?.());
      safeD7Diagnostic(() => report(diagnosticError), fault);
    }
    throw error;
  }
}

/** One bounded whole-setup trace; no timers, observers, clients or transaction output. */
export class D7SetupObservation {
  private faults = 0;
  private dropped = 0;
  private stopped = false;
  private completedToTarget = false;
  private lastMs = 0;
  private readonly stack: number[] = [];
  private readonly spans: Span[] = [];
  private readonly clockCalibration: Calibration | null;

  constructor(
    private readonly clock: () => number = () => performance.now(),
    private readonly readHeap: () => Heap = heap,
    calibrate: () => Calibration = calibration,
  ) {
    try {
      const point = calibrate();
      if (
        Object.keys(point).toSorted().join(',') !==
          'afterMs,beforeMs,timeOriginUnixMs,uptimeMs,utcMs' ||
        !Object.values(point).every((n) => Number.isFinite(n) && n >= 0) ||
        point.beforeMs > point.afterMs
      )
        throw new Error('invalid calibration');
      this.clockCalibration = {
        timeOriginUnixMs: point.timeOriginUnixMs,
        beforeMs: point.beforeMs,
        utcMs: point.utcMs,
        afterMs: point.afterMs,
        uptimeMs: point.uptimeMs,
      };
    } catch {
      this.clockCalibration = null;
      this.fault();
    }
  }

  fault(): void {
    this.faults++;
  }

  private point(): number | null {
    let value: number | null = null;
    safeD7Diagnostic(
      () => {
        const current = this.clock();
        if (!Number.isFinite(current) || current < this.lastMs || current > 1e12)
          throw new Error('invalid monotonic clock');
        this.lastMs = current;
        value = current;
      },
      () => this.fault(),
    );
    return value;
  }

  private heapPoint(): Heap | null {
    let point: Heap | null = null;
    safeD7Diagnostic(
      () => {
        const raw = this.readHeap();
        if (
          !Number.isSafeInteger(raw.usedBytes) ||
          raw.usedBytes < 0 ||
          !Number.isSafeInteger(raw.limitBytes) ||
          raw.limitBytes < raw.usedBytes
        )
          throw new Error('invalid heap counters');
        point = { usedBytes: raw.usedBytes, limitBytes: raw.limitBytes };
      },
      () => this.fault(),
    );
    return point;
  }

  private metadata(meta: D7SetupMeta): D7SetupMeta {
    if (meta === null) return null;
    if ('family' in meta) {
      if (
        !['draftAllocations', 'committedAllocations'].includes(meta.family) ||
        Object.keys(meta).toSorted().join(',') !==
          'evidence,family,offset,parents,receipts,slices,total' ||
        ![meta.offset, meta.total, meta.parents, meta.slices, meta.evidence, meta.receipts].every(
          (n) => Number.isSafeInteger(n) && n >= 0 && n <= 100000,
        )
      )
        throw new Error('invalid fixed batch metadata');
      return {
        family: meta.family,
        offset: meta.offset,
        total: meta.total,
        parents: meta.parents,
        slices: meta.slices,
        evidence: meta.evidence,
        receipts: meta.receipts,
      };
    }
    if (
      Object.keys(meta).toSorted().join(',') !== 'chunkIndex,totalChunks' ||
      !Number.isInteger(meta.chunkIndex) ||
      !Number.isInteger(meta.totalChunks) ||
      meta.chunkIndex < 1 ||
      meta.chunkIndex > meta.totalChunks ||
      meta.totalChunks > 100
    )
      throw new Error('invalid fixed chunk metadata');
    return { chunkIndex: meta.chunkIndex, totalChunks: meta.totalChunks };
  }

  run<T>(label: D7SetupLabel, meta: D7SetupMeta, work: () => PromiseLike<T>): PromiseLike<T> {
    if (this.stopped) return work();
    let span: Span | undefined;
    safeD7Diagnostic(
      () => {
        if (!LABELS.includes(label)) throw new Error('invalid fixed phase');
        if (this.spans.length === 4096) {
          this.dropped++;
          return;
        }
        span = {
          ordinal: this.spans.length + 1,
          parent: this.stack.at(-1) ?? null,
          label,
          meta: this.metadata(meta),
          enteredMs: this.point(),
          settledMs: null,
          outcome: 'ENTERED',
          heapBefore: label.startsWith('batch') ? null : this.heapPoint(),
          heapAfter: null,
        };
        this.spans.push(span);
        this.stack.push(span.ordinal);
        if (this.stack.length > 8) this.fault();
      },
      () => this.fault(),
    );
    const finish = (outcome: 'RETURNED' | 'THREW') =>
      safeD7Diagnostic(
        () => {
          if (!span) return;
          span.settledMs = this.point();
          span.outcome = outcome;
          span.heapAfter = label.startsWith('batch') ? null : this.heapPoint();
          if (this.stack.pop() !== span.ordinal) this.fault();
        },
        () => this.fault(),
      );
    return (async () => {
      try {
        const result = await work();
        finish('RETURNED');
        return result;
      } catch (error) {
        finish('THREW');
        throw error;
      }
    })();
  }

  stop(): void {
    if (this.stack.length !== 0) this.fault();
    this.stopped = true;
  }

  complete(): void {
    if (this.stack.length !== 0) this.fault();
    else this.completedToTarget = true;
    this.stop();
  }

  report() {
    return {
      schemaVersion: 1,
      status:
        this.faults === 0 && this.dropped === 0 && this.stack.length === 0 && this.stopped
          ? 'KNOWN'
          : 'UNKNOWN',
      semantics:
        'inclusive performance.now wall spans; heap sizes are observations; no CPU or exclusive waiting partition',
      cpuEvidence: 'NOT_COLLECTED',
      receiptSqlPlanEvidence: 'UNKNOWN_HISTORICAL_121_138_REFERENCE',
      calibration: this.clockCalibration ? { ...this.clockCalibration } : null,
      faults: this.faults,
      dropped: this.dropped,
      openSpans: this.stack.length,
      stopped: this.stopped,
      completedToTarget: this.completedToTarget,
      spans: this.spans.map((span) => ({
        ...span,
        meta: span.meta ? { ...span.meta } : null,
        heapBefore: span.heapBefore ? { ...span.heapBefore } : null,
        heapAfter: span.heapAfter ? { ...span.heapAfter } : null,
      })),
    };
  }

  emit(
    sink: (report: ReturnType<D7SetupObservation['report']>) => void = (report) => {
      const encoded = JSON.stringify(report);
      if (Buffer.byteLength(encoded) > 4 * 1024 * 1024)
        throw new Error('bounded diagnostic output exceeded');
      console.info('[d7-setup-observation]', encoded);
    },
  ): boolean {
    this.stop();
    return safeD7Diagnostic(
      () => sink(this.report()),
      () => this.fault(),
    );
  }
}

export function observeD7Setup<T>(
  recorder: D7SetupObservation | undefined,
  label: D7SetupLabel,
  meta: D7SetupMeta,
  work: () => PromiseLike<T>,
): PromiseLike<T> {
  return recorder ? recorder.run(label, meta, work) : work();
}
