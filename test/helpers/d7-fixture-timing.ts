import { performance } from 'node:perf_hooks';

const PHASES = [
  'transaction',
  'callback',
  'member',
  'memberArgs',
  'registration',
  'registrationArgs',
  'identity',
  'identityArgs',
  'punch',
  'segment',
] as const;
export type D7FixturePhase = (typeof PHASES)[number];
type Edge = 'ENTERED' | 'RETURNED' | 'THREW';
export type D7FixturePoint = {
  monoBeforeMs: number;
  monoAfterMs: number;
  mainUserUs: number;
  mainSystemUs: number;
  processUserUs: number;
  processSystemUs: number;
  loopActiveMs: number;
  loopIdleMs: number;
};
const KEYS: readonly (keyof D7FixturePoint)[] = [
  'monoBeforeMs',
  'monoAfterMs',
  'mainUserUs',
  'mainSystemUs',
  'processUserUs',
  'processSystemUs',
  'loopActiveMs',
  'loopIdleMs',
];
function capturePoint(): D7FixturePoint {
  const monoBeforeMs = Number(process.hrtime.bigint()) / 1e6;
  const main = process.threadCpuUsage();
  const all = process.cpuUsage();
  const loop = performance.eventLoopUtilization();
  const monoAfterMs = Number(process.hrtime.bigint()) / 1e6;
  return {
    monoBeforeMs,
    monoAfterMs,
    mainUserUs: main.user,
    mainSystemUs: main.system,
    processUserUs: all.user,
    processSystemUs: all.system,
    loopActiveMs: loop.active,
    loopIdleMs: loop.idle,
  };
}
function validPoint(point: D7FixturePoint): boolean {
  return (
    KEYS.every((key) => Number.isFinite(point[key]) && point[key] >= 0) &&
    point.monoBeforeMs <= point.monoAfterMs
  );
}

/** Bounded, test-only fixture timing. CPU counters remain unvalidated raw observations. */
export class D7FixtureTiming {
  private faults = 0;
  private droppedBoundaries = 0;
  private readonly stack: D7FixturePhase[] = [];
  private readonly boundaries: Array<{
    phase: D7FixturePhase;
    edge: Edge;
    point: D7FixturePoint | null;
  }> = [];
  private previous: D7FixturePoint | undefined;
  private readonly calibration: { beforeMonoMs: number; utcMs: number; afterMonoMs: number } | null;

  constructor(
    private readonly offset: number,
    private readonly people: number,
    private readonly capture: () => D7FixturePoint = capturePoint,
  ) {
    if (
      !Number.isInteger(offset) ||
      offset < 0 ||
      offset > 1900 ||
      offset % 100 !== 0 ||
      people !== (offset === 1900 ? 99 : 100)
    )
      this.faults++;
    try {
      this.calibration = {
        beforeMonoMs: Number(process.hrtime.bigint()) / 1e6,
        utcMs: Date.now(),
        afterMonoMs: Number(process.hrtime.bigint()) / 1e6,
      };
      if (
        !Object.values(this.calibration).every((n) => Number.isFinite(n) && n >= 0) ||
        this.calibration.beforeMonoMs > this.calibration.afterMonoMs
      )
        this.faults++;
    } catch {
      this.calibration = null;
      this.faults++;
    }
  }

  boundary(phase: D7FixturePhase, edge: Edge): void {
    try {
      if (!PHASES.includes(phase) || !['ENTERED', 'RETURNED', 'THREW'].includes(edge))
        throw new Error('invalid fixed boundary');
      let point: D7FixturePoint | null = null;
      try {
        const raw = this.capture();
        point = Object.fromEntries(KEYS.map((key) => [key, raw[key]])) as D7FixturePoint;
        if (
          !validPoint(point) ||
          (this.previous &&
            (point.monoBeforeMs < this.previous.monoAfterMs ||
              KEYS.some((key) => point && this.previous && point[key] < this.previous[key])))
        )
          throw new Error('invalid or regressed point');
        this.previous = point;
      } catch {
        point = null;
        this.faults++;
      }
      if (edge === 'ENTERED') this.stack.push(phase);
      else if (this.stack.pop() !== phase) this.faults++;
      if (this.stack.length > 4) {
        this.stack.length = 4;
        this.faults++;
      }
      if (this.boundaries.length < 32) this.boundaries.push({ phase, edge, point });
      else this.droppedBoundaries++;
    } catch {
      this.faults++;
    }
  }

  report() {
    return {
      schemaVersion: 1,
      status:
        this.faults === 0 && this.droppedBoundaries === 0 && this.stack.length === 0
          ? 'KNOWN'
          : 'UNKNOWN',
      semantics:
        'inclusive call spans include argument construction; map spans are synchronous; raw CPU UNVALIDATED; ELU is not CPU',
      cpuValidity: 'UNVALIDATED',
      batch: {
        offset: this.offset,
        ordinal: this.offset / 100 + 1,
        people: this.people,
        last: this.offset === 1900,
        maximumBatches: 20,
      },
      calibration: this.calibration ? { ...this.calibration } : null,
      faults: this.faults,
      droppedBoundaries: this.droppedBoundaries,
      openPhases: this.stack.length,
      boundaries: this.boundaries.map((boundary) => ({
        ...boundary,
        point: boundary.point ? { ...boundary.point } : null,
      })),
    };
  }

  // Called only after the original transaction Promise settles; output failures never mask it.
  emit(
    sink: (report: ReturnType<D7FixtureTiming['report']>) => void = (report) => {
      console.info('[d7-fixture-diagnostic]', JSON.stringify(report));
    },
  ): void {
    try {
      sink(this.report());
    } catch {
      this.faults++;
    }
  }
}

export function observeD7FixtureSync<T>(
  recorder: D7FixtureTiming | undefined,
  phase: D7FixturePhase,
  work: () => T,
): T {
  if (!recorder) return work();
  recorder?.boundary(phase, 'ENTERED');
  try {
    const result = work();
    recorder?.boundary(phase, 'RETURNED');
    return result;
  } catch (error) {
    recorder?.boundary(phase, 'THREW');
    throw error;
  }
}

export function observeD7FixtureAsync<T>(
  recorder: D7FixtureTiming | undefined,
  phase: D7FixturePhase,
  work: () => Promise<T>,
): Promise<T> {
  if (!recorder) return work();
  return (async () => {
    recorder.boundary(phase, 'ENTERED');
    try {
      const result = await work();
      recorder.boundary(phase, 'RETURNED');
      return result;
    } catch (error) {
      recorder.boundary(phase, 'THREW');
      throw error;
    }
  })();
}
