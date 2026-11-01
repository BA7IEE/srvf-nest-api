import type { INestApplication } from '@nestjs/common';
import type { Prisma, PrismaClient } from '@prisma/client';
import type { AppCommitActivityTimeCorrectionDto } from '../../src/modules/activities/dto/app/app-activity-time-correction.dto';

/** One arrival and one explicit release; no sleep, polling, timeout or DB hook. */
export class R5SetmatBarrier<T> {
  private state: 'waiting' | 'arrived' | 'released' | 'aborted' = 'waiting';
  private failure: Error | undefined;
  private signalArrival!: (value: T) => void;
  private rejectArrival!: (error: Error) => void;
  private signalRelease!: () => void;
  private rejectRelease!: (error: Error) => void;
  private readonly arrival = new Promise<T>((resolve, reject) => {
    this.signalArrival = resolve;
    this.rejectArrival = reject;
  });
  private readonly release = new Promise<void>((resolve, reject) => {
    this.signalRelease = resolve;
    this.rejectRelease = reject;
  });

  constructor() {
    // Cleanup can abort a barrier before either side starts waiting. The
    // original promises still reject for their consumers; no unhandled tail.
    void this.arrival.catch(() => undefined);
    void this.release.catch(() => undefined);
  }

  async arrive(value: T): Promise<void> {
    if (this.failure) throw this.failure;
    if (this.state !== 'waiting') throw new Error('R5 barrier arrived more than once');
    this.state = 'arrived';
    this.signalArrival(value);
    await this.release;
  }

  wait(): Promise<T> {
    return this.arrival;
  }

  open(): void {
    if (this.state !== 'arrived') throw new Error('R5 barrier released without an arrival');
    this.state = 'released';
    this.signalRelease();
  }

  abort(error = new Error('R5 test barrier cancelled')): void {
    if (this.state === 'released' || this.state === 'aborted') return;
    this.state = 'aborted';
    this.failure = error;
    this.rejectArrival(error);
    this.rejectRelease(error);
  }

  /** A denied INSERT may finish without arriving; that is a separate branch. */
  async arrivalOrCompletion(work: Promise<unknown>): Promise<'arrived' | 'completed'> {
    return await Promise.race([
      this.arrival.then(() => 'arrived' as const),
      work.then(() => 'completed' as const),
    ]);
  }
}

/** Finish T1 (including its external COMMIT observation) while T2 is paused.
 * Always release/abort and drain T2, including on a failed T1 or assertion.
 * These are scheduling results, never inferred database outcomes.
 */
export async function withR5PausedWriter<T, W>(
  write: (barrier: R5SetmatBarrier<void>) => Promise<W>,
  finishT1: () => Promise<T>,
): Promise<{ arrival: 'arrived' | 'completed'; t1: T; t2: W }> {
  const barrier = new R5SetmatBarrier<void>();
  const writer = Promise.resolve().then(() => write(barrier));
  try {
    const arrival = await barrier.arrivalOrCompletion(writer);
    const t1 = await finishT1();
    if (arrival === 'arrived') barrier.open();
    return { arrival, t1, t2: await writer };
  } finally {
    barrier.abort();
    await Promise.allSettled([writer]);
  }
}

/** Consumer projection of the separately implemented final-outcome observer.
 * The adapter must provide server/fresh-session evidence. It MUST NOT derive
 * databaseOutcome from HTTP status, a callback return, Promise settlement or
 * P2028. UNKNOWN is a failed test, never a rollback or an automatic retry.
 * No classification or timing implementation belongs in this helper.
 */
export interface R5ObservedAttempt<T> {
  client: PromiseSettledResult<T>;
  databaseOutcome: 'COMMITTED' | 'ROLLED_BACK' | 'NO_TRANSACTION' | 'UNKNOWN';
  observationComplete: boolean;
  configuredTimeoutMs: number | null;
  configuredIsolationLevel: string | null;
  evidenceRef: string;
  serverError?: { sqlState: string; message: string };
}

/** Test-layer integration seam, NOT a production API or permission package.
 *
 * Supply a fresh, already prepared V3 application per case, using the existing
 * D13/E4 source fixture shape. B is its real preparer with existing final-review
 * permission; A is an active App member without that permission. Do not grant A
 * anything or grant extra SQL access to make a negative case reachable.
 *
 * app must have one caller-pool connection (to prove physical reuse), callerDb
 * a separate connection under the SAME ordinary DB role, and observerDb a fresh
 * read session. The owner provisions these; this suite creates no DB, roles,
 * grants, trigger replacements, bypass flags or new auth context. Its owner
 * adapter may SET LOCAL ROLE to the existing ordinary caller for each actual
 * transaction; switching to the dedicated writer is never permitted.
 *
 * lateEvidence is an unused, otherwise valid row for the application's pending
 * allocation, referencing an existing permitted attachment and unused ordinal.
 * Pre-seed at least one legitimate evidence row so set comparison is nonempty.
 */
export interface R5SetmatFixture {
  app: INestApplication;
  callerDb: PrismaClient;
  observerDb: PrismaClient;
  a: { id: string; username: string };
  b: { id: string; username: string };
  activityId: string;
  requestId: string;
  command: AppCommitActivityTimeCorrectionDto;
  lateEvidence: Required<
    Pick<
      Prisma.CorrectionPendingTimeAllocationEvidenceUncheckedCreateInput,
      'id' | 'pendingAllocationId' | 'activityId' | 'attachmentId' | 'ordinal'
    >
  >;
  /** Fail closed unless the integrated set materializer, pins and ordinary
   * guards are installed. The handoff's unapplied patch is insufficient. */
  verifyCandidate(): Promise<void>;
  observe<T>(label: string, operation: () => Promise<T>): Promise<R5ObservedAttempt<T>>;
  /** Existing independent business-state observer: complete frozen table
   * manifest, stable ordering, no auth-login telemetry or uncommitted reads. */
  snapshotBusinessState(): Promise<unknown>;
  /** Persist safe branch metadata without tokens, parameters or raw errors. */
  recordCoverage(branch: 'T2_AFTER_GUARD_PAUSED' | 'T2_OPEN_GUARD_REJECTED'): void;
  restoreObservation(): void;
}

export type R5SetmatFixtureFactory = () => Promise<R5SetmatFixture>;
let fixtureFactory: R5SetmatFixtureFactory | undefined;

/** Called by the owner's Jest setupFilesAfterEnv, before spec collection.
 * Merely importing this module cannot connect to a database. */
export function installR5SetmatFixtureFactory(factory: R5SetmatFixtureFactory): void {
  if (fixtureFactory) throw new Error('R5 setmat fixture factory already installed');
  fixtureFactory = factory;
}

export function getR5SetmatFixtureFactory(): R5SetmatFixtureFactory | undefined {
  return fixtureFactory;
}
