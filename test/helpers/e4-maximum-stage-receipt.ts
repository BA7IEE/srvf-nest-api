import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

export const E4_CAPACITY_CASE_NAMES = [
  'E4 maximum real sources with unchanged transaction and query budgets E4 S13 thin-key exact full-doc probe',
  'E4 maximum real sources with unchanged transaction and query budgets 2,000 identities / 10,000 segments / 50,000 slices yield 8,000 policy units without repeated awards',
] as const;

/** Arm before fixture initialization; unrelated dedicated diagnostics keep their lifecycle. */
export function e4CapacityRetentionRequested(args: readonly string[]): boolean {
  let pattern: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--testNamePattern' || arg === '-t') {
      const next = args[++i];
      if (!next || next.startsWith('-')) return true;
      pattern = next;
    } else if (arg.startsWith('--testNamePattern=') || arg.startsWith('-t=')) {
      pattern = arg.slice(arg.indexOf('=') + 1);
    } else if (arg.startsWith('-t') && !arg.startsWith('--')) return true;
  }
  if (pattern === undefined) return true;
  try {
    const expression = new RegExp(pattern, 'i');
    return E4_CAPACITY_CASE_NAMES.some((name) => expression.test(name));
  } catch {
    return true;
  }
}

export type E4CapacityFinalizationStage =
  | 'fixture'
  | 's13'
  | 'maximum'
  | 'app-close'
  | 'review-close'
  | 'observer-cleanup'
  | 's13-probe';

/** DROP permission is earned by complete pre-finalizer evidence, never by a finally block. */
export class E4CapacityFinalization {
  private armed: boolean;
  private failed = false;
  private pending = 0;
  private readonly started = new Set<E4CapacityFinalizationStage>();
  private readonly completed = new Set<E4CapacityFinalizationStage>();

  constructor(
    private readonly dedicated: boolean,
    selected = true,
  ) {
    this.armed = dedicated && selected;
  }

  fail(): void {
    if (this.dedicated) this.failed = true;
  }

  async run<T>(stage: E4CapacityFinalizationStage, work: () => Promise<T>): Promise<T> {
    if (!this.dedicated) return work();
    if (stage === 's13' || stage === 'maximum') this.armed = true;
    if (this.started.has(stage)) {
      this.fail();
      throw new Error('E4 capacity stage repeated; preserve database');
    }
    this.started.add(stage);
    this.pending++;
    try {
      const value = await work();
      this.completed.add(stage);
      return value;
    } catch (error) {
      this.fail();
      throw error;
    } finally {
      this.pending--;
    }
  }

  assertReadyToFinalize(): void {
    if (!this.armed) return;
    const cases = ['s13', 'maximum'] as const;
    const required = [
      'fixture',
      'app-close',
      'review-close',
      'observer-cleanup',
      's13-probe',
    ] as const;
    if (
      this.failed ||
      this.pending !== 0 ||
      !cases.some((stage) => this.completed.has(stage)) ||
      required.some((stage) => !this.completed.has(stage)) ||
      [...this.started].some((stage) => !this.completed.has(stage))
    ) {
      this.fail();
      throw new Error('E4 capacity FAIL/UNKNOWN; preserve database');
    }
  }
}

// C1-v2 is transaction feasibility evidence, never an HTTP or percentile SLA.
export type E4PrepareTransactionFactsV2 = {
  phases: readonly { phase: string; outcome: string }[];
  starts: readonly {
    timeoutMs: number | null;
    maxWaitMs: number | null;
    isolationLevel: string | null;
  }[];
  pending: number;
  unknown: boolean;
};
export function assertE4PrepareAcceptanceV2(
  facts: E4PrepareTransactionFactsV2,
  methodWallMs: number,
) {
  const options = facts.starts[0];
  if (
    !Number.isFinite(methodWallMs) ||
    methodWallMs < 0 ||
    facts.unknown ||
    facts.pending !== 0 ||
    facts.starts.length !== 1 ||
    options?.timeoutMs !== 60_000 ||
    options.maxWaitMs !== 2_000 ||
    options.isolationLevel !== 'ReadCommitted' ||
    facts.phases.length !== 2 ||
    facts.phases[0].phase !== 'start' ||
    facts.phases[0].outcome !== 'ok' ||
    facts.phases[1].phase !== 'commit' ||
    facts.phases[1].outcome !== 'ok'
  )
    throw new Error('E4 C1-v2 prepare transaction facts refused');
  return {
    schema: 'r5-c1-prepare/v2',
    status: 'COMMITTED',
    transactionTimeoutMs: 60_000,
    connectionMaxWaitMs: 2_000,
    isolationLevel: 'ReadCommitted',
    methodWallMs,
    latencySla: 'UNESTABLISHED',
  };
}

export const E4_MAXIMUM_STAGES = [
  'FIXTURE',
  'FIXTURE_CHECKS',
  'PREPARE_SETUP',
  'PREPARE',
  'PREPARE_RECEIPT',
  'PREPARE_CHECKS',
  'PROOF_READ',
  'PROOF_CHECKS',
  'ORACLE',
  'SUBMIT',
  'SUBMIT_CHECKS',
  'LEDGER',
  'LEDGER_CHECKS',
  'SUMMARY',
  'SUMMARY_CHECKS',
  'FORMAL_PROOF_READ',
  'FINAL_ORACLE_DRAFT',
  'FINAL_ORACLE_FORMAL',
  'POST_BUSINESS_PROBE',
  'CLEANUP',
] as const;
export type E4MaximumStage = (typeof E4_MAXIMUM_STAGES)[number];
type Event = {
  schema: 'e4-maximum-stage/v1';
  sequence: number;
  stage: E4MaximumStage;
  outcome: 'ENTER' | 'COMPLETE' | 'FAILED' | 'INCOMPLETE';
  utc: string;
  elapsedMs: number;
  durationMs: number | null;
  errorCode: string | null;
};

/** Immediate JSONL and an event's own clocks; console/report delivery time is irrelevant.
 * A pending ENTER proves only that completion was not observed. No transaction verdict. */
export class E4MaximumStageReceipt {
  private readonly started: number;
  private previous: number;
  private sequence = 0;
  private bytes = 0;
  private readonly seen = new Set<E4MaximumStage>();
  private readonly completed = new Set<E4MaximumStage>();
  private active: { stage: E4MaximumStage; started: number } | undefined;
  private unavailable = false;
  private failed = false;

  constructor(
    private readonly write: (jsonLine: string) => void,
    private readonly clock = () => performance.now(),
    private readonly utc = () => new Date().toISOString(),
  ) {
    this.started = this.clock();
    if (!Number.isFinite(this.started)) throw new Error('E4 stage clock unavailable');
    this.previous = this.started;
  }

  private emit(stage: E4MaximumStage, outcome: Event['outcome'], error?: unknown) {
    const now = this.clock();
    const utc = this.utc();
    if (
      !Number.isFinite(now) ||
      now < this.previous ||
      now < this.active!.started ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(utc) ||
      this.sequence >= 64
    )
      throw new Error('E4 stage receipt unavailable');
    const code = error && typeof error === 'object' ? Reflect.get(error, 'code') : null;
    const event: Event = {
      schema: 'e4-maximum-stage/v1',
      sequence: this.sequence + 1,
      stage,
      outcome,
      utc,
      elapsedMs: now - this.started,
      durationMs: outcome === 'ENTER' ? null : now - this.active!.started,
      errorCode:
        typeof code === 'string' &&
        [
          'P2028',
          'P2010',
          'P2004',
          'P2034',
          '23514',
          '23503',
          '23505',
          '42501',
          '57014',
          '40P01',
          '40001',
          '55P03',
        ].includes(code)
          ? code
          : null,
    };
    const line = JSON.stringify(event) + '\n';
    const bytes = Buffer.byteLength(line, 'utf8');
    if (this.bytes + bytes > 32 * 1024) throw new Error('E4 stage receipt bound exceeded');
    this.write(line);
    this.previous = now;
    this.sequence++;
    this.bytes += bytes;
  }

  enter(stage: E4MaximumStage) {
    if (
      this.unavailable ||
      (this.failed && stage !== 'CLEANUP') ||
      this.active ||
      this.seen.has(stage) ||
      !E4_MAXIMUM_STAGES.includes(stage)
    )
      throw new Error('E4 stage order refused');
    const index = E4_MAXIMUM_STAGES.indexOf(stage);
    const prior = [...this.seen].at(-1);
    if (prior && index <= E4_MAXIMUM_STAGES.indexOf(prior))
      throw new Error('E4 stage order refused');
    this.active = { stage, started: this.clock() };
    try {
      this.emit(stage, 'ENTER');
    } catch (error) {
      this.failed = true;
      this.unavailable = true;
      throw error;
    }
    this.seen.add(stage);
  }

  complete(stage: E4MaximumStage) {
    if (this.unavailable || this.active?.stage !== stage) throw new Error('E4 stage order refused');
    try {
      this.emit(stage, 'COMPLETE');
    } catch (error) {
      this.unavailable = true;
      throw error;
    }
    this.completed.add(stage);
    this.active = undefined;
  }

  async run<T>(stage: E4MaximumStage, work: () => Promise<T>): Promise<T> {
    this.enter(stage);
    let result: T;
    try {
      result = await work();
    } catch (error) {
      this.failed = true;
      try {
        this.emit(stage, 'FAILED', error);
      } catch {
        this.unavailable = true;
      }
      this.active = undefined;
      throw error;
    }
    // An evidence failure after success is an evidence failure, never a business rollback.
    this.complete(stage);
    return result;
  }

  status() {
    return {
      unavailable: this.unavailable,
      pending: this.active?.stage ?? null,
      events: this.sequence,
    };
  }

  /** Evidence must never prevent original cleanup or replace its primary exception. */
  async cleanup<T>(work: () => Promise<T>): Promise<T> {
    if (!this.unavailable && this.active) {
      this.failed = true;
      try {
        this.emit(this.active.stage, 'INCOMPLETE');
      } catch {
        this.unavailable = true;
      }
    }
    this.active = undefined;
    if (!this.unavailable) {
      try {
        this.enter('CLEANUP');
      } catch {
        this.unavailable = true;
      }
    }
    let result: T;
    try {
      result = await work();
    } catch (error) {
      if (!this.unavailable) {
        try {
          this.emit('CLEANUP', 'FAILED', error);
        } catch {
          this.unavailable = true;
        }
      }
      this.active = undefined;
      throw error;
    }
    if (!this.unavailable) {
      try {
        this.complete('CLEANUP');
      } catch {
        this.unavailable = true;
      }
    }
    return result;
  }

  assertReliable() {
    if (
      this.unavailable ||
      this.failed ||
      this.active ||
      this.completed.size !== E4_MAXIMUM_STAGES.length
    )
      throw new Error('E4 maximum stage evidence incomplete');
  }
}

export function createE4MaximumStageReceipt(
  path = join(mkdtempSync(join(tmpdir(), 'srvf-e4-maximum-')), 'receipt.jsonl'),
) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, '', { flag: 'wx', mode: 0o600 });
  return new E4MaximumStageReceipt((line) => {
    appendFileSync(path, line, { encoding: 'utf8' });
    // Payload timestamps remain authoritative even if the worker/CI transport buffers this line.
    writeSync(2, 'E4_MAXIMUM_STAGE ' + line);
  });
}

/** The prior approved three pin mirrors changed no ordinary oracle function bytes. */
export function restoreE4OrdinaryOracleOpening(source: string): string {
  const hash = (text: string) => createHash('sha256').update(text).digest('hex');
  const opening = '46c31154bfa284f923ab34ca8be651573a8fe3a1f6d6035e1010265371a17e72';
  if (hash(source) === opening) return source;
  if (hash(source) !== '4285d78205ab48726173b228e43ca9669438b060327a06603cdb8e9e87e0e27e')
    throw new Error('E4 ordinary frozen oracle mirror source refused');
  const candidatePin = '40b56bac5a571c56e589cbc549419bfa';
  if (source.split(candidatePin).length !== 4)
    throw new Error('E4 ordinary frozen oracle mirror count refused');
  const restored = source.replaceAll(candidatePin, 'ade4d2af9aa0baf8400a79fc6b62c797');
  if (hash(restored) !== opening)
    throw new Error('E4 ordinary frozen oracle mirror opening refused');
  return restored;
}

// Exact outer instrumentation inverse. The original complete scale source stays frozen.
const OPENING_SHA = '50a090de9193d80ab659852c0420aed4e05290913be1050b5f5631da9cf17ed6';
const CANDIDATE_SHA = '5408651f58567fe8b9468f93326686ede1b6ac4da1d15028784fd0c3e3e51d87';
const STAGE_BINDINGS: { candidate: string; opening: string; sha256: string }[] = [
  {
    candidate:
      "import {\n  E4SliceReadDiagnostic,\n  e4SliceReadOptions,\n  preflightE4SliceReadDiagnostic,\n} from '../helpers/e4-slice-read-diagnostic';\nimport {\n  createE4MaximumStageReceipt,\n  restoreE4MaximumStageOpening,\n",
    opening: 'import {\n  createE4MaximumStageReceipt,\n  restoreE4MaximumStageOpening,\n',
    sha256: '1824a01dd40645fe67eda9eb9f33fbc5316a7defdb4748b04cce5a8f8b6022a7',
  },
  {
    candidate:
      "}, 75_000);\ndescribe('E4 maximum real sources with unchanged transaction and query budgets', () => {\n  let f: E4Fixture;\n  let sliceReadDiagnostic: E4SliceReadDiagnostic | undefined;\n  let firstReviewOracle:\n    | {\n        db: PrismaClient;\n",
    opening:
      "}, 75_000);\ndescribe('E4 maximum real sources with unchanged transaction and query budgets', () => {\n  let f: E4Fixture;\n  let firstReviewOracle:\n    | {\n        db: PrismaClient;\n",
    sha256: 'b0cab4abb0267a3e1e4aca419f05b90e38549535ac75beacfd458b2cc1810d0c',
  },
  {
    candidate:
      "    }\n  }, 75_000);\n\n  // Independent receipt after both original fixture and review clients have closed.\n  afterAll(async () => {\n    await sliceReadDiagnostic?.collectCleanup();\n  }, 10_000);\n\n  // This owner-bound diagnostic is explicitly local-only; CI still runs the unchanged original full chain.\n  (process.env.SRVF_E4_W98 === '1' ? it : it.skip)(\n    'E4 S13 thin-key exact full-doc probe',\n",
    opening:
      "    }\n  }, 75_000);\n\n  // This owner-bound diagnostic is explicitly local-only; CI still runs the unchanged original full chain.\n  (process.env.SRVF_E4_W98 === '1' ? it : it.skip)(\n    'E4 S13 thin-key exact full-doc probe',\n",
    sha256: 'a7c87eafe7fa55fb0423e6a4ed7c797c84b49069d019cfbd900df12fb7b2edf1',
  },
  {
    candidate:
      "  }, 75_000);\n\n  it('2,000 identities / 10,000 segments / 50,000 slices yield 8,000 policy units without repeated awards', async () => {\n    const sliceObservationDeadline = performance.now() + 600_000;\n    const sliceOptions = e4SliceReadOptions();\n    await preflightE4SliceReadDiagnostic(f.db, sliceOptions);\n    const stages = createE4MaximumStageReceipt();\n    const source = await stages.run('FIXTURE', () => createMaximumE4Source(f));\n    stages.enter('FIXTURE_CHECKS');\n",
    opening:
      "  }, 75_000);\n\n  it('2,000 identities / 10,000 segments / 50,000 slices yield 8,000 policy units without repeated awards', async () => {\n    const stages = createE4MaximumStageReceipt();\n    const source = await stages.run('FIXTURE', () => createMaximumE4Source(f));\n    stages.enter('FIXTURE_CHECKS');\n",
    sha256: '9b9591a7a76678892ba96a11347ab54d3e3f2ec94679dd5a8e0dc5d57324bd92',
  },
  {
    candidate:
      "    ).toBe(50000);\n    stages.complete('FIXTURE_CHECKS');\n    stages.enter('PREPARE_SETUP');\n    const observed = new ObservedE4Database({\n      log: [{ emit: 'event', level: 'query' }],\n      ...sliceOptions.clientOptions,\n    });\n    try {\n      sliceReadDiagnostic = new E4SliceReadDiagnostic(observed, f.db, f.app, {\n        scope: sliceOptions.scope,\n        applicationName: sliceOptions.applicationName,\n        deadlineMs: sliceObservationDeadline,\n        dedicatedLease: process.env.SRVF_E4_W98 === '1',\n      });\n      observed.$on('query', (event) =>\n        sliceReadDiagnostic?.queryEvent(event.query, event.duration),\n      );\n    } catch {\n      console.info('E4_SLICE_READ', '{\"status\":\"UNKNOWN\",\"reason\":\"INSTALL\"}');\n    }\n    const engineObserver = observeEngineTransactions(observed);\n    const engineRequests = new E4EngineRequestWaitDiagnostic(\n      Reflect.get(observed, '_engine') as object,\n",
    opening:
      "    ).toBe(50000);\n    stages.complete('FIXTURE_CHECKS');\n    stages.enter('PREPARE_SETUP');\n    const observed = new ObservedE4Database({ log: [{ emit: 'event', level: 'query' }] });\n    const engineObserver = observeEngineTransactions(observed);\n    const engineRequests = new E4EngineRequestWaitDiagnostic(\n      Reflect.get(observed, '_engine') as object,\n",
    sha256: '7ce40e7b976b466221837dda879552a23cf2c8c13e945a3ecb32a4bbbcf0edee',
  },
  {
    candidate:
      "      preparePhaseDiagnostic = phaseDiagnostic;\n      let prepareBusinessFailure: { error: unknown } | undefined;\n      try {\n        sliceReadDiagnostic?.arm();\n        engineRequests.begin();\n        phaseDiagnostic.begin();\n        stages.complete('PREPARE_SETUP');\n",
    opening:
      "      preparePhaseDiagnostic = phaseDiagnostic;\n      let prepareBusinessFailure: { error: unknown } | undefined;\n      try {\n        engineRequests.begin();\n        phaseDiagnostic.begin();\n        stages.complete('PREPARE_SETUP');\n",
    sha256: 'ba71dbe68e35ccd8443fac961560583e18d57df9a47a9c63c3045ecf89c2042f',
  },
  {
    candidate:
      "        } finally {\n          engineRequests.finish();\n          engineRequests.restore();\n          sliceReadDiagnostic?.restoreEngine();\n          console.info(\n            'E4 maximum engine request waits (fixed counters)',\n            JSON.stringify(engineRequests.snapshot()),\n",
    opening:
      "        } finally {\n          engineRequests.finish();\n          engineRequests.restore();\n          console.info(\n            'E4 maximum engine request waits (fixed counters)',\n            JSON.stringify(engineRequests.snapshot()),\n",
    sha256: 'ccc69511ac1b9c0dac7c2f9d83081575e22f280e8c6a2b90b46954ceb3d9890f',
  },
  {
    candidate:
      '      await stages.run(\'POST_BUSINESS_PROBE\', () => assertPostBusinessPSetProbe(f.db, proof.id));\n    } finally {\n      engineRequests.restore();\n      sliceReadDiagnostic?.restoreEngine();\n      engineObserver.restore();\n      try {\n        await sliceReadDiagnostic?.finishObservation();\n      } catch {\n        console.info(\'E4_SLICE_READ\', \'{"status":"UNKNOWN","reason":"COLLECTION"}\');\n      } finally {\n        await stages.cleanup(() => observed.$disconnect());\n      }\n    }\n    stages.assertReliable();\n  }, 600_000);\n',
    opening:
      "      await stages.run('POST_BUSINESS_PROBE', () => assertPostBusinessPSetProbe(f.db, proof.id));\n    } finally {\n      engineRequests.restore();\n      engineObserver.restore();\n      await stages.cleanup(() => observed.$disconnect());\n    }\n    stages.assertReliable();\n  }, 600_000);\n",
    sha256: 'a20981797503820d5c12fe01e18e4307ef29dbdc95f2c1f7bdb58fed66e13eaa',
  },
  {
    candidate:
      "  it('closes both test files, all original assertions, and the exact shared native implementation', () => {\n    const migration = restoreE4HistoricalCatalogOpening(\n      readFileSync(\n        resolve(__dirname, 'activity-os-r5-e4-contribution-settlement-migration.e2e-spec.ts'),\n        'utf8',\n      ),\n    );\n",
    opening:
      "  it('closes both test files, all original assertions, and the exact shared native implementation', () => {\n    const migration = readFileSync(\n      resolve(__dirname, 'activity-os-r5-e4-contribution-settlement-migration.e2e-spec.ts'),\n      'utf8',\n    );\n",
    sha256: '04472dd9b402c088d50fb1e86df803040c9315f0328d39361588e7364d2d7e87',
  },
  {
    candidate:
      "import {\n  createE4MaximumStageReceipt,\n  restoreE4MaximumStageOpening,\n  restoreE4HistoricalCatalogOpening,\n} from '../helpers/e4-maximum-stage-receipt';\nimport { PrismaClient, Prisma } from '@prisma/client';\nimport { createHash } from 'node:crypto';\nimport { readFileSync } from 'node:fs';\n",
    opening:
      "import { PrismaClient, Prisma } from '@prisma/client';\nimport { createHash } from 'node:crypto';\nimport { readFileSync } from 'node:fs';\n",
    sha256: 'd6f965068eb6db1f89e0659f6fe718c1bca5c5a50b1f57fdb9ad1aa5f5c79ea0',
  },
  {
    candidate:
      '  },\n];\nfunction restoreTerminalScaleOpening(source: string) {\n  source = restoreE4MaximumStageOpening(source);\n  return restoreTerminalSource(\n    source,\n    E4_TERMINAL_OPENING_BINDINGS,\n',
    opening:
      '  },\n];\nfunction restoreTerminalScaleOpening(source: string) {\n  return restoreTerminalSource(\n    source,\n    E4_TERMINAL_OPENING_BINDINGS,\n',
    sha256: '3aacce62e872c6de30aa528665cd497783e420731547661dd1acad25ea1dcf6c',
  },
  {
    candidate:
      "        resolve(__dirname, 'activity-os-r5-e4-contribution-settlement-' + kind + '.e2e-spec.ts'),\n        'utf8',\n      );\n      const opening =\n        kind === 'scale'\n          ? restoreE4MaximumStageOpening(source)\n          : restoreE4HistoricalCatalogOpening(source);\n      expect(terminalRefsTestOpening(opening, kind)).not.toBe(opening);\n      expect(() => terminalRefsTestOpening(source + '\\n', kind)).toThrow();\n      const driver = [...source.matchAll(/^class S13ReadClient \\{[\\s\\S]*?^\\}/gmu)];\n      expect(driver).toHaveLength(1);\n",
    opening:
      "        resolve(__dirname, 'activity-os-r5-e4-contribution-settlement-' + kind + '.e2e-spec.ts'),\n        'utf8',\n      );\n      expect(terminalRefsTestOpening(source, kind)).not.toBe(source);\n      expect(() => terminalRefsTestOpening(source + '\\n', kind)).toThrow();\n      const driver = [...source.matchAll(/^class S13ReadClient \\{[\\s\\S]*?^\\}/gmu)];\n      expect(driver).toHaveLength(1);\n",
    sha256: 'e6614705015a3a5ee9494a70d5cf9efd1eb5955fb373b70ef2230d121004b29f',
  },
  {
    candidate:
      "  }, 75_000);\n\n  it('2,000 identities / 10,000 segments / 50,000 slices yield 8,000 policy units without repeated awards', async () => {\n    const stages = createE4MaximumStageReceipt();\n    const source = await stages.run('FIXTURE', () => createMaximumE4Source(f));\n    stages.enter('FIXTURE_CHECKS');\n    expect(\n      await f.db.activityParticipationIdentity.count({ where: { activityId: source.activityId } }),\n    ).toBe(2000);\n",
    opening:
      "  }, 75_000);\n\n  it('2,000 identities / 10,000 segments / 50,000 slices yield 8,000 policy units without repeated awards', async () => {\n    const source = await createMaximumE4Source(f);\n    expect(\n      await f.db.activityParticipationIdentity.count({ where: { activityId: source.activityId } }),\n    ).toBe(2000);\n",
    sha256: 'aa7bd76d41144066b2b01c4ea1b70955ae2f1c266a32fbef591ba817e3d3e087',
  },
  {
    candidate:
      "    expect(\n      await f.db.participantTimeAllocationSlice.count({ where: { activityId: source.activityId } }),\n    ).toBe(50000);\n    stages.complete('FIXTURE_CHECKS');\n    stages.enter('PREPARE_SETUP');\n    const observed = new ObservedE4Database({ log: [{ emit: 'event', level: 'query' }] });\n    const engineObserver = observeEngineTransactions(observed);\n    const engineRequests = new E4EngineRequestWaitDiagnostic(\n",
    opening:
      "    expect(\n      await f.db.participantTimeAllocationSlice.count({ where: { activityId: source.activityId } }),\n    ).toBe(50000);\n    const observed = new ObservedE4Database({ log: [{ emit: 'event', level: 'query' }] });\n    const engineObserver = observeEngineTransactions(observed);\n    const engineRequests = new E4EngineRequestWaitDiagnostic(\n",
    sha256: '1fad46cf96bd4c58990414eb1fbd5b92f83a4665abf10a64c1f5af8554dee28c',
  },
  {
    candidate:
      "        { phase: 'C3_RECEIPT', target: measured, method: 'receipt' },\n      ]);\n      preparePhaseDiagnostic = phaseDiagnostic;\n      let prepareBusinessFailure: { error: unknown } | undefined;\n      try {\n        engineRequests.begin();\n        phaseDiagnostic.begin();\n        stages.complete('PREPARE_SETUP');\n        let prepareOutcome: 'OK' | 'FAIL' = 'FAIL';\n        try {\n          prepared = await stages.run('PREPARE', async () => {\n            try {\n              const result = await measured.prepare(\n                source.activityId,\n                prepareCommand,\n                e4Actor(f.creator, true),\n                E4_META,\n              );\n              prepareOutcome = 'OK';\n              return result;\n            } catch (error) {\n              prepareBusinessFailure = { error };\n              throw error;\n            }\n          });\n          stages.enter('PREPARE_RECEIPT');\n        } finally {\n          engineRequests.finish();\n          engineRequests.restore();\n",
    opening:
      "        { phase: 'C3_RECEIPT', target: measured, method: 'receipt' },\n      ]);\n      preparePhaseDiagnostic = phaseDiagnostic;\n      try {\n        engineRequests.begin();\n        phaseDiagnostic.begin();\n        let prepareOutcome: 'OK' | 'FAIL' = 'FAIL';\n        try {\n          prepared = await measured.prepare(\n            source.activityId,\n            prepareCommand,\n            e4Actor(f.creator, true),\n            E4_META,\n          );\n          prepareOutcome = 'OK';\n        } finally {\n          engineRequests.finish();\n          engineRequests.restore();\n",
    sha256: 'c3ca5795703892a73dfbb028c9944319a0a97e5cde5e8ce64ca8bf8fe36cb539',
  },
  {
    candidate:
      "          );\n        }\n      } catch (error) {\n        // A receipt failure after COMMIT must not enter business rollback diagnostics.\n        if (!prepareBusinessFailure || !Object.is(prepareBusinessFailure.error, error)) throw error;\n        const prismaCode =\n          error instanceof Prisma.PrismaClientKnownRequestError ? error.code : 'other';\n        console.info(\n",
    opening:
      "          );\n        }\n      } catch (error) {\n        const prismaCode =\n          error instanceof Prisma.PrismaClientKnownRequestError ? error.code : 'other';\n        console.info(\n",
    sha256: 'da6dec42cafd6e1f7063089aabe465b01366032eaae345b2f3e0bc73f37e93da',
  },
  {
    candidate:
      "          enginePhases: engineObserver.phases,\n        }),\n      );\n      stages.complete('PREPARE_RECEIPT');\n      stages.enter('PREPARE_CHECKS');\n      expect(prepareMs).toBeLessThan(30_000);\n      expect(queries).toBeGreaterThan(0);\n      expect(queries).toBeLessThanOrEqual(400);\n",
    opening:
      '          enginePhases: engineObserver.phases,\n        }),\n      );\n      expect(prepareMs).toBeLessThan(30_000);\n      expect(queries).toBeGreaterThan(0);\n      expect(queries).toBeLessThanOrEqual(400);\n',
    sha256: 'b883846b36564185c8581d138da7c8972db433f705de6bc70274e03bf2b7f4df',
  },
  {
    candidate:
      "      expect(barrierQueries).toBe(1);\n      expect(prepared.bucketCount).toBe(8000);\n      expect(prepared.sourceCount).toBe(40000);\n      stages.complete('PREPARE_CHECKS');\n      const proof = await stages.run('PROOF_READ', () =>\n        f.db.activitySettlementContributionRevision.findFirstOrThrow({\n          where: { settlementVersionId: prepared.settlementVersionId },\n        }),\n      );\n      stages.enter('PROOF_CHECKS');\n      expect(proof.evaluationCount).toBe(8000);\n      expect(proof.recognizedPointsTotal.toFixed(2)).toBe('1000.00');\n      // Full old expected documents and the independent abc actual-row root oracle,\n      // before any submit/review/ledger stage. These reads are outside the measured command.\n      stages.complete('PROOF_CHECKS');\n      await stages.run('ORACLE', () => assertFixedE4Oracle(f.db, proof.id, 8000));\n      reset();\n      const submitted = await stages.run('SUBMIT', () =>\n        measured.submit(\n          source.activityId,\n          {\n            expectedDraftVersion: source.expectation.expectedDraftVersion,\n            expectedEvidenceSealId: source.expectation.expectedEvidenceSealId,\n            operationKey: f.key('maximum_submit'),\n            timeRevisionId: prepared.timeRevisionId,\n            expectedBucketContentHash: prepared.bucketContentHash,\n          },\n          e4Actor(f.creator, true),\n          E4_META,\n        ),\n      );\n      stages.enter('SUBMIT_CHECKS');\n      console.info('E4 maximum submit', JSON.stringify({ queries, e4Queries, ...timing }));\n      expect(queries).toBeGreaterThan(0);\n      expect(queries).toBeLessThanOrEqual(950);\n",
    opening:
      "      expect(barrierQueries).toBe(1);\n      expect(prepared.bucketCount).toBe(8000);\n      expect(prepared.sourceCount).toBe(40000);\n      const proof = await f.db.activitySettlementContributionRevision.findFirstOrThrow({\n        where: { settlementVersionId: prepared.settlementVersionId },\n      });\n      expect(proof.evaluationCount).toBe(8000);\n      expect(proof.recognizedPointsTotal.toFixed(2)).toBe('1000.00');\n      // Full old expected documents and the independent abc actual-row root oracle,\n      // before any submit/review/ledger stage. These reads are outside the measured command.\n      await assertFixedE4Oracle(f.db, proof.id, 8000);\n      reset();\n      const submitted = await measured.submit(\n        source.activityId,\n        {\n          expectedDraftVersion: source.expectation.expectedDraftVersion,\n          expectedEvidenceSealId: source.expectation.expectedEvidenceSealId,\n          operationKey: f.key('maximum_submit'),\n          timeRevisionId: prepared.timeRevisionId,\n          expectedBucketContentHash: prepared.bucketContentHash,\n        },\n        e4Actor(f.creator, true),\n        E4_META,\n      );\n      console.info('E4 maximum submit', JSON.stringify({ queries, e4Queries, ...timing }));\n      expect(queries).toBeGreaterThan(0);\n      expect(queries).toBeLessThanOrEqual(950);\n",
    sha256: '6db7f8e45e8ba70852dd1613b73861b97372c997c95e19cb79439f4c3a7c6492',
  },
  {
    candidate:
      "          throw error;\n        }\n      });\n      stages.complete('SUBMIT_CHECKS');\n      let posted: Awaited<ReturnType<typeof postE4Ledger>>;\n      try {\n        posted = await stages.run('LEDGER', () => postE4Ledger(f, submitted));\n      } finally {\n        capture.mockRestore();\n      }\n      stages.enter('LEDGER_CHECKS');\n      expect(posted.committed.replayed).toBe(false);\n      expect(\n        await f.db.participationLedgerEntry.count({\n",
    opening:
      '          throw error;\n        }\n      });\n      let posted: Awaited<ReturnType<typeof postE4Ledger>>;\n      try {\n        posted = await postE4Ledger(f, submitted);\n      } finally {\n        capture.mockRestore();\n      }\n      expect(posted.committed.replayed).toBe(false);\n      expect(\n        await f.db.participationLedgerEntry.count({\n',
    sha256: 'a2be830b44cfd5efa7a179476168e6cf0e01f88e0a436e41f15b544039505f2c',
  },
  {
    candidate:
      "      });\n      expect(total._sum.recognizedPointsDelta?.toFixed(2)).toBe('1000.00');\n      reset();\n      stages.complete('LEDGER_CHECKS');\n      const summary = await stages.run('SUMMARY', () =>\n        observed.$transaction((tx) =>\n          f.app\n            .get(ActivityContributionSettlementQueryService)\n            .readSummaryInTx(tx, submitted.settlementVersionId),\n        ),\n      );\n      stages.enter('SUMMARY_CHECKS');\n      console.info('E4 maximum formal summary', JSON.stringify({ queries, e4Queries }));\n      expect(queries).toBeGreaterThan(0);\n      expect(queries).toBeLessThanOrEqual(3);\n",
    opening:
      "      });\n      expect(total._sum.recognizedPointsDelta?.toFixed(2)).toBe('1000.00');\n      reset();\n      const summary = await observed.$transaction((tx) =>\n        f.app\n          .get(ActivityContributionSettlementQueryService)\n          .readSummaryInTx(tx, submitted.settlementVersionId),\n      );\n      console.info('E4 maximum formal summary', JSON.stringify({ queries, e4Queries }));\n      expect(queries).toBeGreaterThan(0);\n      expect(queries).toBeLessThanOrEqual(3);\n",
    sha256: 'c73c1b94913bba87586ea2db71f8b8e31cbc74a17438372bdaa3da985fdb137d',
  },
  {
    candidate:
      "        recognizedPointsTotal: '1000.00',\n        hasMore: true,\n      });\n      stages.complete('SUMMARY_CHECKS');\n      const formalProof = await stages.run('FORMAL_PROOF_READ', () =>\n        f.db.activitySettlementContributionRevision.findFirstOrThrow({\n          where: { settlementVersionId: submitted.settlementVersionId },\n        }),\n      );\n      // Outside all measured business operations; compares every complete JSON, not a sample.\n      await stages.run('FINAL_ORACLE_DRAFT', () => assertFixedE4Oracle(f.db, proof.id, 8000));\n      await stages.run('FINAL_ORACLE_FORMAL', () =>\n        assertFixedE4Oracle(f.db, formalProof.id, 8000),\n      );\n      console.info(\n        'E4 maximum independent old/new oracle',\n        JSON.stringify({ evaluations: 8000, differences: 0 }),\n      );\n      // Only after every original business budget and full draft/formal oracle has passed.\n      // Reuses this exact immutable root; no extra fixture, prepare, INSERT or pre-business warming.\n      await stages.run('POST_BUSINESS_PROBE', () => assertPostBusinessPSetProbe(f.db, proof.id));\n    } finally {\n      engineRequests.restore();\n      engineObserver.restore();\n      await stages.cleanup(() => observed.$disconnect());\n    }\n    stages.assertReliable();\n  }, 600_000);\n});\n",
    opening:
      "        recognizedPointsTotal: '1000.00',\n        hasMore: true,\n      });\n      const formalProof = await f.db.activitySettlementContributionRevision.findFirstOrThrow({\n        where: { settlementVersionId: submitted.settlementVersionId },\n      });\n      // Outside all measured business operations; compares every complete JSON, not a sample.\n      await assertFixedE4Oracle(f.db, proof.id, 8000);\n      await assertFixedE4Oracle(f.db, formalProof.id, 8000);\n      console.info(\n        'E4 maximum independent old/new oracle',\n        JSON.stringify({ evaluations: 8000, differences: 0 }),\n      );\n      // Only after every original business budget and full draft/formal oracle has passed.\n      // Reuses this exact immutable root; no extra fixture, prepare, INSERT or pre-business warming.\n      await assertPostBusinessPSetProbe(f.db, proof.id);\n    } finally {\n      engineRequests.restore();\n      engineObserver.restore();\n      await observed.$disconnect();\n    }\n  }, 600_000);\n});\n",
    sha256: '1c43fd5a9e6c6545eaf9361878200d01cee26cd982b04edf7624a29efdd1faeb',
  },
];
export function restoreE4MaximumStageOpening(source: string): string {
  source = restoreE4PrepareAcceptanceV2Opening(source);
  const hash = (text: string) => createHash('sha256').update(text).digest('hex');
  if (hash(source) === OPENING_SHA) return source;
  if (hash(source) !== CANDIDATE_SHA) throw new Error('E4 frozen oracle stage source refused');
  for (const binding of STAGE_BINDINGS) {
    if (source.split(binding.candidate).length !== 2 || hash(binding.candidate) !== binding.sha256)
      throw new Error('E4 frozen oracle stage binding refused');
    source = source.replace(binding.candidate, () => binding.opening);
  }
  if (hash(source) !== OPENING_SHA) throw new Error('E4 frozen oracle stage opening refused');
  return source;
}

// The older scale checker reads its frozen counterpart as data only.
const HISTORICAL_CATALOG_OPENING_SHA =
  'd6c887c0b4fba37b8883da63ef70604c64f72bb6401e9553611fd8b7ee959e32';
const HISTORICAL_CATALOG_CANDIDATE_SHA =
  '71d36ed2b3bd13b97eb54f6771f7659f03521a1586662413907dfddb6696165f';
const HISTORICAL_CATALOG_BINDINGS: { candidate: string; opening: string; sha256: string }[] = [
  {
    candidate:
      "import { e4HistoricalMigrationPrefix } from '../helpers/e4-migration-prefix';\nimport { frozen137FirstReviewCatalogTx } from '../helpers/e4-frozen137-first-review-catalog';\nimport { Prisma, PrismaClient } from '@prisma/client';\nimport { createHash } from 'node:crypto';\n// E4_TERMINAL_REPLACE_CHILD_IMPORT_BEGIN\n",
    opening:
      "import { e4HistoricalMigrationPrefix } from '../helpers/e4-migration-prefix';\nimport { Prisma, PrismaClient } from '@prisma/client';\nimport { createHash } from 'node:crypto';\n// E4_TERMINAL_REPLACE_CHILD_IMPORT_BEGIN\n",
    sha256: 'fabd7aaed3c49cbee3789b539dd5b3ba592bf3682245427f934a3db8b6760305',
  },
  {
    candidate:
      "    throw new Error('Native worker opening source kind differs');\n  const bindings = {\n    migration: [\n      {\n        candidate: '      return terminalFrozen137SharedOpening(source.slice(from, to));\\n',\n        candidateHash: 'ba552412e43b304133f3ef6314bf54dbaf8039afc2e0c576da529710f5303dbb',\n        opening: '      return source.slice(from, to);\\n',\n      },\n      {\n        candidate:\n          \"import { frozen137FirstReviewCatalogTx } from '../helpers/e4-frozen137-first-review-catalog';\\n\",\n        candidateHash: '4ac68662c2d65dd50b93e0c3ee9ad2ca14d5da60929de3302d0937ecb2df6dff',\n        opening: '',\n      },\n      {\n        candidate:\n          '                    // Current production client still rejects this frozen137 catalog.\\n                    await expect(\\n                      contributions.readFirstReviewBarrierCandidateInTx(tx, anchor),\\n                    ).rejects.toMatchObject({\\n                      biz: BizCode.ACTIVITY_TIME_SETTLEMENT_SOURCE_NOT_READY,\\n                    });\\n                    const historicalCatalogTx = frozen137FirstReviewCatalogTx(tx);\\n',\n        candidateHash: '0a8bafd0141237fd732e487699a33eb04fbf267e92f612ac57cef10246aac91a',\n        opening: '',\n      },\n      {\n        candidate:\n          '                      await contributions.readFirstReviewBarrierCandidateInTx(\\n                        historicalCatalogTx,\\n                        anchor,\\n                      ),\\n',\n        candidateHash: 'ab0bc327ad5360c1d71d813bfee46e4abc9a2ed603531016d86205cc5ea773ad',\n        opening:\n          '                      await contributions.readFirstReviewBarrierCandidateInTx(tx, anchor),\\n',\n      },\n      {\n        candidate:\n          '                      contributions.readFirstReviewBarrierCandidateInTx(\\n                        historicalCatalogTx,\\n                        anchor,\\n                      ),\\n',\n        candidateHash: '0a9c2ae47ecc3be5fdd817eb2ef44f5e817aecbaec51b704de79d3cdf775f31b',\n        opening:\n          '                      contributions.readFirstReviewBarrierCandidateInTx(tx, anchor),\\n',\n      },\n      {\n        candidate:\n          '                  // Current production client still rejects this frozen137 catalog.\\n                  await expect(\\n                    contributions.readFirstReviewBarrierCandidateInTx(tx, anchor),\\n                  ).rejects.toMatchObject({\\n                    biz: BizCode.ACTIVITY_TIME_SETTLEMENT_SOURCE_NOT_READY,\\n                  });\\n                  const historicalCatalogTx = frozen137FirstReviewCatalogTx(tx);\\n',\n        candidateHash: '9f172d529c555dc82a64d93be98959d91d484ae163f4fd0b11f38a90eacff11f',\n        opening: '',\n      },\n      {\n        candidate:\n          '                    await contributions.readFirstReviewBarrierCandidateInTx(\\n                      historicalCatalogTx,\\n                      anchor,\\n                    ),\\n',\n        candidateHash: '27c37ba60e6838efe740f02b0a42c2e8c0e4abc7b6c8f4d733a1b14c085db5b5',\n        opening:\n          '                    await contributions.readFirstReviewBarrierCandidateInTx(tx, anchor),\\n',\n      },\n      {\n        candidate:\n          '                    contributions.readFirstReviewBarrierCandidateInTx(historicalCatalogTx, anchor),\\n',\n        candidateHash: '5c8c24500ec6a6e7b0388a5f19958fd68c09ccb9d493c452abebd32087d4ebe0',\n        opening:\n          '                    contributions.readFirstReviewBarrierCandidateInTx(tx, anchor),\\n',\n      },\n      {\n        candidate:\n          \"import { e4HistoricalMigrationPrefix } from '../helpers/e4-migration-prefix';\\n\",\n",
    opening:
      "    throw new Error('Native worker opening source kind differs');\n  const bindings = {\n    migration: [\n      {\n        candidate:\n          \"import { e4HistoricalMigrationPrefix } from '../helpers/e4-migration-prefix';\\n\",\n",
    sha256: 'a85e4797b6d0210035b9fedf962a03a172a49d723aa485a11535ee76bd6e0f1f',
  },
  {
    candidate:
      "      const to = source.indexOf('\\ntype TerminalOpeningBinding', from);\n      expect(from).toBeGreaterThan(0);\n      expect(to).toBeGreaterThan(from);\n      return terminalFrozen137SharedOpening(source.slice(from, to));\n    };\n    expect(helpers(migration)).toBe(helpers(scale));\n  });\n",
    opening:
      "      const to = source.indexOf('\\ntype TerminalOpeningBinding', from);\n      expect(from).toBeGreaterThan(0);\n      expect(to).toBeGreaterThan(from);\n      return source.slice(from, to);\n    };\n    expect(helpers(migration)).toBe(helpers(scale));\n  });\n",
    sha256: '95ee90e04dfc84dc6a56a984c4e30ef6b5a3a0e60461e1617526fe64ae730cbb',
  },
  {
    candidate:
      "  });\n});\n// E4_TERMINAL_REFS_BODY_OFFLINE_BEGIN\nimport { restoreE4MaximumStageOpening } from '../helpers/e4-maximum-stage-receipt';\n// Only the exact migration-only catalog profile bindings may differ in shared facilities.\nfunction terminalFrozen137SharedOpening(source: string): string {\n  const opening = 'bcc4fabb397bb510355694364e64927f73119ed7f9539508ca18c8559c1410ba';\n  if (terminalHash(source) === opening) return source;\n  if (terminalHash(source) !== '42020afefbe051567087e3f3672d68f978bb5f790d07a503f0d6f2cf3af50a2b')\n    throw new Error('Frozen137 shared helper candidate bytes differ');\n  const from = '    migration: [\\n';\n  const to = '      {\\n        candidate:\\n          \"import { e4HistoricalMigrationPrefix }';\n  if (source.split(from).length !== 2 || source.split(to).length !== 2)\n    throw new Error('Frozen137 shared helper addition boundary differs');\n  const start = source.indexOf(from) + from.length;\n  const end = source.indexOf(to, start);\n  if (\n    end <= start ||\n    terminalHash(source.slice(start, end)) !==\n      'be82188adc7643260c96a84bd4911c904f81997502aa5e08582a5743fabc2f6d'\n  )\n    throw new Error('Frozen137 shared helper addition bytes differ');\n  const restored = source.slice(0, start) + source.slice(end);\n  if (terminalHash(restored) !== opening)\n    throw new Error('Frozen137 shared helper opening bytes differ');\n  return restored;\n}\nconst e4D1EvidenceModules = async () => {\n  const [fs, os, path] = await Promise.all([\n    import('node:fs'),\n",
    opening:
      "  });\n});\n// E4_TERMINAL_REFS_BODY_OFFLINE_BEGIN\nconst e4D1EvidenceModules = async () => {\n  const [fs, os, path] = await Promise.all([\n    import('node:fs'),\n",
    sha256: 'a8e45c3626eadf3237bced7cde2dc57374b9dc12bb2b603e42d165d958dffe25',
  },
  {
    candidate:
      "  return { fs, os, path };\n};\ndescribe('E4 terminal source projection offline', () => {\n  it.each(['binding', 'adjacent', 'missing_boundary', 'duplicate_boundary'] as const)(\n    'refuses frozen137 shared helper damage: %s',\n    (kind) => {\n      const source = readFileSync(__filename, 'utf8');\n      const shared = source.slice(\n        source.indexOf('\\nfunction terminalHash('),\n        source.indexOf('\\ntype TerminalOpeningBinding'),\n      );\n      const marker = '    migration: [\\n';\n      const invalid =\n        kind === 'binding'\n          ? shared.replace('candidateHash:', 'candidateHashX:')\n          : kind === 'adjacent'\n            ? shared + '\\n'\n            : kind === 'missing_boundary'\n              ? shared.replace(marker, '')\n              : shared + marker;\n      expect(invalid).not.toBe(shared);\n      expect(() => terminalFrozen137SharedOpening(invalid)).toThrow();\n    },\n  );\n  it.each(['missing_import', 'duplicate_import', 'changed_profile', 'removed_rejection'] as const)(\n    'refuses frozen137 catalog adapter source damage: %s',\n    (kind) => {\n      const source = readFileSync(__filename, 'utf8');\n      const addedImport =\n        \"import { frozen137FirstReviewCatalogTx } from '../helpers/e4-frozen137-first-review-catalog';\\n\";\n      const invalid =\n        kind === 'missing_import'\n          ? source.replace(addedImport, '')\n          : kind === 'duplicate_import'\n            ? source + addedImport\n            : kind === 'changed_profile'\n              ? source.replace(\n                  '                    const historicalCatalogTx = frozen137FirstReviewCatalogTx(tx);\\n',\n                  '                    const historicalCatalogTx = tx;\\n',\n                )\n              : source.replace(\n                  '                    // Current production client still rejects this frozen137 catalog.\\n',\n                  '',\n                );\n      expect(invalid).not.toBe(source);\n      expect(() => restoreTerminalMigrationOpening(invalid)).toThrow();\n      expect(() => terminalRefsTestOpening(invalid, 'migration')).toThrow();\n    },\n  );\n  it('restores both complete current test openings and the unchanged native driver', () => {\n    for (const kind of ['migration', 'scale'] as const) {\n      const source = readFileSync(\n        resolve(__dirname, 'activity-os-r5-e4-contribution-settlement-' + kind + '.e2e-spec.ts'),\n        'utf8',\n      );\n      const opening = kind === 'scale' ? restoreE4MaximumStageOpening(source) : source;\n      expect(terminalRefsTestOpening(opening, kind)).not.toBe(opening);\n      expect(() => terminalRefsTestOpening(source + '\\n', kind)).toThrow();\n      const driver = [...source.matchAll(/^class S13ReadClient \\{[\\s\\S]*?^\\}/gmu)];\n      expect(driver).toHaveLength(1);\n",
    opening:
      "  return { fs, os, path };\n};\ndescribe('E4 terminal source projection offline', () => {\n  it('restores both complete current test openings and the unchanged native driver', () => {\n    for (const kind of ['migration', 'scale'] as const) {\n      const source = readFileSync(\n        resolve(__dirname, 'activity-os-r5-e4-contribution-settlement-' + kind + '.e2e-spec.ts'),\n        'utf8',\n      );\n      expect(terminalRefsTestOpening(source, kind)).not.toBe(source);\n      expect(() => terminalRefsTestOpening(source + '\\n', kind)).toThrow();\n      const driver = [...source.matchAll(/^class S13ReadClient \\{[\\s\\S]*?^\\}/gmu)];\n      expect(driver).toHaveLength(1);\n",
    sha256: '89c24c90e02650626dfc469aec5f2fef9aa61fe8e3b04a851b027281c376bfac',
  },
  {
    candidate:
      "                const rollback = new Error('Boolean collection controlled catalog rollback');\n                await expect(\n                  f.db.$transaction(async (tx) => {\n                    // Current production client still rejects this frozen137 catalog.\n                    await expect(\n                      contributions.readFirstReviewBarrierCandidateInTx(tx, anchor),\n                    ).rejects.toMatchObject({\n                      biz: BizCode.ACTIVITY_TIME_SETTLEMENT_SOURCE_NOT_READY,\n                    });\n                    const historicalCatalogTx = frozen137FirstReviewCatalogTx(tx);\n                    expect(\n                      await contributions.readFirstReviewBarrierCandidateInTx(\n                        historicalCatalogTx,\n                        anchor,\n                      ),\n                    ).not.toBeNull();\n                    if (point === 'historical_body' || point === 'same_name_fake_body') {\n                      const definitions = [\n",
    opening:
      "                const rollback = new Error('Boolean collection controlled catalog rollback');\n                await expect(\n                  f.db.$transaction(async (tx) => {\n                    expect(\n                      await contributions.readFirstReviewBarrierCandidateInTx(tx, anchor),\n                    ).not.toBeNull();\n                    if (point === 'historical_body' || point === 'same_name_fake_body') {\n                      const definitions = [\n",
    sha256: '0d5df6c945813e5c6b870763fb0f2b77883b3c5c29b9e60bae8381100ebb9fad',
  },
  {
    candidate:
      '                      await tx.$executeRaw`ALTER FUNCTION public.e4_assert_complete(text,boolean) SET search_path = public, pg_catalog`;\n                    }\n                    await expect(\n                      contributions.readFirstReviewBarrierCandidateInTx(\n                        historicalCatalogTx,\n                        anchor,\n                      ),\n                    ).rejects.toMatchObject({\n                      biz: BizCode.ACTIVITY_TIME_SETTLEMENT_SOURCE_NOT_READY,\n                    });\n',
    opening:
      '                      await tx.$executeRaw`ALTER FUNCTION public.e4_assert_complete(text,boolean) SET search_path = public, pg_catalog`;\n                    }\n                    await expect(\n                      contributions.readFirstReviewBarrierCandidateInTx(tx, anchor),\n                    ).rejects.toMatchObject({\n                      biz: BizCode.ACTIVITY_TIME_SETTLEMENT_SOURCE_NOT_READY,\n                    });\n',
    sha256: 'c31a72195bc617504e975d26c852106ace580b8c5eab403a9ebad3cd6272b488',
  },
  {
    candidate:
      "              const rollback = new Error('Boolean collection controlled catalog rollback');\n              await expect(\n                f.db.$transaction(async (tx) => {\n                  // Current production client still rejects this frozen137 catalog.\n                  await expect(\n                    contributions.readFirstReviewBarrierCandidateInTx(tx, anchor),\n                  ).rejects.toMatchObject({\n                    biz: BizCode.ACTIVITY_TIME_SETTLEMENT_SOURCE_NOT_READY,\n                  });\n                  const historicalCatalogTx = frozen137FirstReviewCatalogTx(tx);\n                  expect(\n                    await contributions.readFirstReviewBarrierCandidateInTx(\n                      historicalCatalogTx,\n                      anchor,\n                    ),\n                  ).not.toBeNull();\n                  if (point === 'historical_body' || point === 'same_name_fake_body') {\n                    const definitions = [\n",
    opening:
      "              const rollback = new Error('Boolean collection controlled catalog rollback');\n              await expect(\n                f.db.$transaction(async (tx) => {\n                  expect(\n                    await contributions.readFirstReviewBarrierCandidateInTx(tx, anchor),\n                  ).not.toBeNull();\n                  if (point === 'historical_body' || point === 'same_name_fake_body') {\n                    const definitions = [\n",
    sha256: '3d232a3fd352a4d2a452c8ecb9fe1aa2a1a2139676d1bc63f38b431dabe873be',
  },
  {
    candidate:
      '                    await tx.$executeRaw`ALTER FUNCTION public.e4_assert_complete(text,boolean) SET search_path = public, pg_catalog`;\n                  }\n                  await expect(\n                    contributions.readFirstReviewBarrierCandidateInTx(historicalCatalogTx, anchor),\n                  ).rejects.toMatchObject({\n                    biz: BizCode.ACTIVITY_TIME_SETTLEMENT_SOURCE_NOT_READY,\n                  });\n',
    opening:
      '                    await tx.$executeRaw`ALTER FUNCTION public.e4_assert_complete(text,boolean) SET search_path = public, pg_catalog`;\n                  }\n                  await expect(\n                    contributions.readFirstReviewBarrierCandidateInTx(tx, anchor),\n                  ).rejects.toMatchObject({\n                    biz: BizCode.ACTIVITY_TIME_SETTLEMENT_SOURCE_NOT_READY,\n                  });\n',
    sha256: '1bc75334744e1e801334101d463c75a2587b00568a0e37c1d0f5906a16694ebd',
  },
];
// Undo only the exact approved CI fixture/phase and reader wiring changes.
const HISTORICAL_CI_FIXTURE_CANDIDATE_SHA =
  '30a764e2b72776dd2185b97ad7e95628740acc340d3d0356fd9aa3eb2daa9fef';
const HISTORICAL_CI_FIXTURE_BINDINGS: { candidate: string; opening: string; sha256: string }[] = [
  {
    candidate:
      "  });\n});\n// E4_TERMINAL_REFS_BODY_OFFLINE_BEGIN\nimport {\n  restoreE4MaximumStageOpening,\n  restoreE4HistoricalCiFixtureOpening,\n} from '../helpers/e4-maximum-stage-receipt';\n// Only the exact migration-only catalog profile bindings may differ in shared facilities.\nfunction terminalFrozen137SharedOpening(source: string): string {\n  const opening = 'bcc4fabb397bb510355694364e64927f73119ed7f9539508ca18c8559c1410ba';\n",
    opening:
      "  });\n});\n// E4_TERMINAL_REFS_BODY_OFFLINE_BEGIN\nimport { restoreE4MaximumStageOpening } from '../helpers/e4-maximum-stage-receipt';\n// Only the exact migration-only catalog profile bindings may differ in shared facilities.\nfunction terminalFrozen137SharedOpening(source: string): string {\n  const opening = 'bcc4fabb397bb510355694364e64927f73119ed7f9539508ca18c8559c1410ba';\n",
    sha256: '9ea5f30234e24963b7db6377fac74ca9d82593725a2c22b74433aa55403a7859',
  },
  {
    candidate:
      "        resolve(__dirname, 'activity-os-r5-e4-contribution-settlement-' + kind + '.e2e-spec.ts'),\n        'utf8',\n      );\n      const opening =\n        kind === 'scale'\n          ? restoreE4MaximumStageOpening(source)\n          : restoreE4HistoricalCiFixtureOpening(source);\n      expect(terminalRefsTestOpening(opening, kind)).not.toBe(opening);\n      expect(() => terminalRefsTestOpening(source + '\\n', kind)).toThrow();\n      const driver = [...source.matchAll(/^class S13ReadClient \\{[\\s\\S]*?^\\}/gmu)];\n",
    opening:
      "        resolve(__dirname, 'activity-os-r5-e4-contribution-settlement-' + kind + '.e2e-spec.ts'),\n        'utf8',\n      );\n      const opening = kind === 'scale' ? restoreE4MaximumStageOpening(source) : source;\n      expect(terminalRefsTestOpening(opening, kind)).not.toBe(opening);\n      expect(() => terminalRefsTestOpening(source + '\\n', kind)).toThrow();\n      const driver = [...source.matchAll(/^class S13ReadClient \\{[\\s\\S]*?^\\}/gmu)];\n",
    sha256: 'ffc4682894ddb2bdf3c8d9972010289bb87ce91602ad71f7827b5981bedb1fc4',
  },
  {
    candidate:
      "          let fixture: E4Fixture | undefined;\n          let draftId: string;\n          let submittedId: string;\n          let thirdRootId: string;\n          const previousGate = process.env.ACTIVITY_V11_WORKFLOW_ENABLED;\n          const recordGenuinePhase = (phase: string, started: number) =>\n            console.info(\n              'E4_GENUINE_BAG_PHASE',\n              JSON.stringify({ phase, elapsedMs: performance.now() - started }),\n            );\n          const catalog = (tx: Prisma.TransactionClient) => tx.$queryRaw<\n            {\n              body: string;\n",
    opening:
      '          let fixture: E4Fixture | undefined;\n          let draftId: string;\n          let submittedId: string;\n          const previousGate = process.env.ACTIVITY_V11_WORKFLOW_ENABLED;\n          const catalog = (tx: Prisma.TransactionClient) => tx.$queryRaw<\n            {\n              body: string;\n',
    sha256: 'd682efea200e92997378e85d3631ac8b3156dbcb1603c21ac56dc03bb49b9215',
  },
  {
    candidate:
      "                  },\n                });\n              submittedId = proof.id;\n              const thirdStarted = performance.now();\n              try {\n                const thirdSource = await createE4Source(fixture);\n                const third = await prepareE4Time(fixture, thirdSource);\n                const thirdRoot =\n                  await fixture.db.activitySettlementContributionRevision.findFirstOrThrow({\n                    where: { settlementVersionId: third.settlementVersionId, kindCode: 'draft' },\n                  });\n                thirdRootId = thirdRoot.id;\n              } finally {\n                recordGenuinePhase('third-fixture', thirdStarted);\n              }\n            } catch (error) {\n              terminalMigrationFailed = true;\n              firstFailure = error;\n",
    opening:
      '                  },\n                });\n              submittedId = proof.id;\n            } catch (error) {\n              terminalMigrationFailed = true;\n              firstFailure = error;\n',
    sha256: '336a7e023f405fdc55c16640b04f6f5c0ed6b2146920a55928f392ea91e3c14b',
  },
  {
    candidate:
      "            prove(async () => {\n              if (!fixture) throw new Error('Terminal genuine small fixture missing');\n              const f = fixture;\n              const oracleStarted = performance.now();\n              try {\n                for (const rootId of [draftId, submittedId, thirdRootId])\n                  await assertFixedE4Oracle(f.db, rootId);\n              } finally {\n                recordGenuinePhase('three-oracles', oracleStarted);\n              }\n              const nativeStarted = performance.now();\n              await withTerminalNative(f.db, async (client, deadline, identity) => {\n                const before = await terminalNativeIdentity(client, deadline);\n                terminalAssertIdentity(before, identity);\n",
    opening:
      "            prove(async () => {\n              if (!fixture) throw new Error('Terminal genuine small fixture missing');\n              const f = fixture;\n              const source = await createE4Source(f);\n              const third = await prepareE4Time(f, source);\n              const thirdRoot = await f.db.activitySettlementContributionRevision.findFirstOrThrow({\n                where: { settlementVersionId: third.settlementVersionId, kindCode: 'draft' },\n              });\n              for (const rootId of [draftId, submittedId, thirdRoot.id])\n                await assertFixedE4Oracle(f.db, rootId);\n              await withTerminalNative(f.db, async (client, deadline, identity) => {\n                const before = await terminalNativeIdentity(client, deadline);\n                terminalAssertIdentity(before, identity);\n",
    sha256: '561a492d81aebcd9b6a5ad43ba757555532c14f4361bfc36796c354c384c6b45',
  },
  {
    candidate:
      '                  terminalRemaining(deadline),\n                );\n                expect(readonly.rows).toEqual([{ readonly: true }]);\n                for (const rootId of [draftId, submittedId, thirdRootId]) {\n                  const root = await f.db.activitySettlementContributionRevision.findUniqueOrThrow({\n                    where: { id: rootId },\n                  });\n',
    opening:
      '                  terminalRemaining(deadline),\n                );\n                expect(readonly.rows).toEqual([{ readonly: true }]);\n                for (const rootId of [draftId, submittedId, thirdRoot.id]) {\n                  const root = await f.db.activitySettlementContributionRevision.findUniqueOrThrow({\n                    where: { id: rootId },\n                  });\n',
    sha256: 'bb2e4675e071eff34422dd150204d7b59b29dd6dc1014867b68f40f2178c78df',
  },
  {
    candidate:
      "                expect(query).not.toHaveBeenCalled();\n                query.mockRestore();\n                await client.query('ROLLBACK', [], terminalRemaining(deadline));\n              }).finally(() => recordGenuinePhase('native-with-cleanup', nativeStarted));\n            }));\n          it('proves raw PG16 temporary/public NULL plans on the actual native session without accepting zero-row coverage', () =>\n            prove(async () => {\n",
    opening:
      "                expect(query).not.toHaveBeenCalled();\n                query.mockRestore();\n                await client.query('ROLLBACK', [], terminalRemaining(deadline));\n              });\n            }));\n          it('proves raw PG16 temporary/public NULL plans on the actual native session without accepting zero-row coverage', () =>\n            prove(async () => {\n",
    sha256: '083deb3ae1420469355cece3d00cfaebcd511f52b3e28ab07e6db42b5b00ef17',
  },
];
export function restoreE4HistoricalCiFixtureOpening(source: string): string {
  source = restoreE4LiveCatalog140Opening(source, 'migration');
  const hash = (text: string) => createHash('sha256').update(text).digest('hex');
  if (hash(source) === HISTORICAL_CATALOG_CANDIDATE_SHA) return source;
  if (hash(source) !== HISTORICAL_CI_FIXTURE_CANDIDATE_SHA)
    throw new Error('E4 frozen counterpart CI fixture source refused');
  for (const binding of HISTORICAL_CI_FIXTURE_BINDINGS) {
    if (source.split(binding.candidate).length !== 2 || hash(binding.candidate) !== binding.sha256)
      throw new Error('E4 frozen counterpart CI fixture binding refused');
    source = source.replace(binding.candidate, () => binding.opening);
  }
  if (hash(source) !== HISTORICAL_CATALOG_CANDIDATE_SHA)
    throw new Error('E4 frozen counterpart CI fixture opening refused');
  return source;
}
export function restoreE4HistoricalCatalogOpening(source: string): string {
  const hash = (text: string) => createHash('sha256').update(text).digest('hex');
  if (hash(source) === HISTORICAL_CATALOG_OPENING_SHA) return source;
  source = restoreE4HistoricalCiFixtureOpening(source);
  if (hash(source) !== HISTORICAL_CATALOG_CANDIDATE_SHA)
    throw new Error('E4 frozen counterpart source refused');
  for (const binding of HISTORICAL_CATALOG_BINDINGS) {
    if (source.split(binding.candidate).length !== 2 || hash(binding.candidate) !== binding.sha256)
      throw new Error('E4 frozen counterpart binding refused');
    source = source.replace(binding.candidate, () => binding.opening);
  }
  if (hash(source) !== HISTORICAL_CATALOG_OPENING_SHA)
    throw new Error('E4 frozen counterpart opening refused');
  return source;
}

// E4_LIVE140_CATALOG_INVERSE_BEGIN
const LIVE140_PROFILES: Record<
  'scale' | 'migration',
  {
    candidateSha: string;
    openingSha: string;
    bindings: { candidate: string; opening: string; sha256: string }[];
  }
> = {
  scale: {
    candidateSha: '59671ffd3409d9ced328357138f0fd9f77435058e76a77675acc9f73a44bebf2',
    openingSha: '175a4997a170887daa6095eda23106334534a1756521f7ce0b3d65bca1e79fa4',
    bindings: [
      {
        candidate:
          "import {\n  createE4MaximumStageReceipt,\n  E4CapacityFinalization,\n  e4CapacityRetentionRequested,\n  assertE4PrepareAcceptanceV2,\n  restoreE4MaximumStageOpening,\n  restoreE4LiveCatalog140Opening,\n  restoreE4HistoricalCatalogOpening,\n} from '../helpers/e4-maximum-stage-receipt';\n",
        opening:
          "import {\n  createE4MaximumStageReceipt,\n  assertE4PrepareAcceptanceV2,\n  restoreE4MaximumStageOpening,\n  restoreE4HistoricalCatalogOpening,\n} from '../helpers/e4-maximum-stage-receipt';\n",
        sha256: '6119f47ca2b7cfe5d6d62ba14dbb2e6dc259f6faebbc831637c567a4868794f7',
      },
      {
        candidate:
          "const E4_TERMINAL_REFS_BODY_BYTES = 4070;\nconst E4_TERMINAL_NEW_BODY_BYTES = 4362;\n// E4_LIVE140_CATALOG_BEGIN\n// Frozen137 projections above remain historical inputs; live probes bind the approved140 successor.\nfunction terminalLiveExpectedCatalog(\n  source = readFileSync(\n    resolve(\n      __dirname,\n      '../../prisma/migrations/20261012020000_activity_contribution_evaluation_canonical_fast_path/migration.sql',\n    ),\n    'utf8',\n  ),\n) {\n  if (terminalHash(source) !== '5d7ff28a64a638440aaa1e9a798a2602f933fc9d6f8b23b68355199dad143513')\n    throw new Error('Terminal live140 migration source mismatch');\n  const from = 'CREATE OR REPLACE FUNCTION e4_expected_evaluations(';\n  if (source.split(from).length !== 2)\n    throw new Error('Terminal live140 function boundary mismatch');\n  const { body } = terminalExpectedDefinition(\n    source.replace(from, 'CREATE FUNCTION e4_expected_evaluations('),\n  );\n  if (terminalHash(body) !== 'bbabd3144fb7639e856b3e4b349e017d0eacad6799bf02b5014b52e6cf521761')\n    throw new Error('Terminal live140 function source mismatch');\n  return { md5: terminalHash(body, 'md5'), bytes: Buffer.byteLength(body, 'utf8') };\n}\n// E4_LIVE140_CATALOG_END\nfunction terminalExpectedDefinition(source: string) {\n  const matches = [\n",
        opening:
          'const E4_TERMINAL_REFS_BODY_BYTES = 4070;\nconst E4_TERMINAL_NEW_BODY_BYTES = 4362;\nfunction terminalExpectedDefinition(source: string) {\n  const matches = [\n',
        sha256: 'df83c8dfacf56e7a623e575ea5c6fcc4ee23d49b09adc2a37072d977dc7de708',
      },
      {
        candidate:
          "  )\n    throw new Error('Terminal actual catalog namespace mismatch');\n  const live = terminalLiveExpectedCatalog();\n  for (const [row, body, bytes] of [\n    [current, live.md5, live.bytes],\n    [opening, E4_TERMINAL_OLD_BODY_MD5, 4044],\n  ] as const) {\n",
        opening:
          "  )\n    throw new Error('Terminal actual catalog namespace mismatch');\n  for (const [row, body, bytes] of [\n    [current, E4_TERMINAL_NEW_BODY_MD5, E4_TERMINAL_NEW_BODY_BYTES],\n    [opening, E4_TERMINAL_OLD_BODY_MD5, 4044],\n  ] as const) {\n",
        sha256: '1d0341fe273b6447a3b9605beb61774868ce7eead14d5ad6607bb608b8cc0c8f',
      },
      {
        candidate:
          "      ),\n    );\n    const scale = restoreE4LiveCatalog140Opening(\n      readFileSync(\n        resolve(__dirname, 'activity-os-r5-e4-contribution-settlement-scale.e2e-spec.ts'),\n        'utf8',\n      ),\n    );\n    const local = readFileSync(__filename, 'utf8');\n",
        opening:
          "      ),\n    );\n    const scale = readFileSync(\n      resolve(__dirname, 'activity-os-r5-e4-contribution-settlement-scale.e2e-spec.ts'),\n      'utf8',\n    );\n    const local = readFileSync(__filename, 'utf8');\n",
        sha256: 'cc9e6afb2d4f2aa781cc68a239d7bece06f1474669157eaae41fe4d7c1bb45d2',
      },
      {
        candidate:
          "        scope: 'public',\n        schema: 'public',\n        body: terminalLiveExpectedCatalog().md5,\n        bytes: terminalLiveExpectedCatalog().bytes,\n        temporary: false,\n      },\n",
        opening:
          "        scope: 'public',\n        schema: 'public',\n        body: E4_TERMINAL_NEW_BODY_MD5,\n        bytes: E4_TERMINAL_NEW_BODY_BYTES,\n        temporary: false,\n      },\n",
        sha256: 'fe7bae489bdf102275c2e7c7dc165b57e8b14ad26d2edede46f4bf622d752562',
      },
      {
        candidate:
          "\nlet restoreS13Lifecycle: (() => void) | undefined;\nconst capacityFinalization = new E4CapacityFinalization(\n  process.env.SRVF_E4_W98 === '1',\n  e4CapacityRetentionRequested(process.argv),\n);\nbeforeAll(() => {\n  if (process.env.SRVF_E4_W98 === '1') restoreS13Lifecycle = observeS13Lifecycle();\n});\ninstallE4ValidationDatabase({\n  assertReadyToFinalize: () => capacityFinalization.assertReadyToFinalize(),\n});\nafterAll(async () => {\n  try {\n",
        opening:
          "\nlet restoreS13Lifecycle: (() => void) | undefined;\nbeforeAll(() => {\n  if (process.env.SRVF_E4_W98 === '1') restoreS13Lifecycle = observeS13Lifecycle();\n});\ninstallE4ValidationDatabase();\nafterAll(async () => {\n  try {\n",
        sha256: '25f828239324722002482cd98c379035881d999f9b99ad918e8eaaace1ebe875',
      },
      {
        candidate:
          "  }\n  const previousGate = process.env.ACTIVITY_V11_WORKFLOW_ENABLED;\n  beforeAll(\n    () =>\n      capacityFinalization.run('fixture', async () => {\n        process.env.ACTIVITY_V11_WORKFLOW_ENABLED = 'true';\n        f = await createE4Fixture();\n      }),\n    120_000,\n  );\n  afterAll(() =>\n    capacityFinalization.run('app-close', async () => {\n      await closeE13Fixture(f);\n      if (previousGate === undefined) delete process.env.ACTIVITY_V11_WORKFLOW_ENABLED;\n      else process.env.ACTIVITY_V11_WORKFLOW_ENABLED = previousGate;\n    }),\n  );\n  // Runs after the original app.close(), before the installer's ordinary DROP/lease release.\n  // This independent 75-second read-only hook is outside every original business budget.\n  afterAll(\n    () =>\n      capacityFinalization.run('review-close', async () => {\n        if (!firstReviewOracle) return;\n        try {\n          const facts = await firstReviewFacts();\n          console.info(\n            'E4 first-review after app close',\n            JSON.stringify({ outcome: firstReviewOracle.outcome, ...facts }),\n          );\n          if (firstReviewOracle.outcome === 'pending')\n            throw new Error('First-review response terminal is unknown');\n          assertReviewCounts(facts, firstReviewOracle.outcome === 'fulfilled' ? 1 : 0);\n        } finally {\n          await firstReviewOracle.db.$disconnect();\n        }\n      }),\n    75_000,\n  );\n\n  // Independent receipt after both original fixture and review clients have closed.\n  afterAll(\n    () =>\n      capacityFinalization.run('observer-cleanup', async () => {\n        await sliceReadDiagnostic?.collectCleanup();\n        if (sliceReadDiagnostic) {\n          const snapshot = sliceReadDiagnostic.snapshot();\n          const cleanup = snapshot.cleanup;\n          if (\n            snapshot.status !== 'OBSERVED' ||\n            snapshot.observedClose !== 'COMPLETE' ||\n            snapshot.appClose !== 'COMPLETE' ||\n            !cleanup ||\n            Reflect.get(cleanup, 'databases') !== 1 ||\n            Reflect.get(cleanup, 'clients') !== 0 ||\n            Reflect.get(cleanup, 'capturedBackends') !== 0\n          )\n            capacityFinalization.fail();\n        }\n      }),\n    10_000,\n  );\n\n  // This owner-bound diagnostic is explicitly local-only; CI still runs the unchanged original full chain.\n",
        opening:
          "  }\n  const previousGate = process.env.ACTIVITY_V11_WORKFLOW_ENABLED;\n  beforeAll(async () => {\n    process.env.ACTIVITY_V11_WORKFLOW_ENABLED = 'true';\n    f = await createE4Fixture();\n  }, 120_000);\n  afterAll(async () => {\n    await closeE13Fixture(f);\n    if (previousGate === undefined) delete process.env.ACTIVITY_V11_WORKFLOW_ENABLED;\n    else process.env.ACTIVITY_V11_WORKFLOW_ENABLED = previousGate;\n  });\n  // Runs after the original app.close(), before the installer's ordinary DROP/lease release.\n  // This independent 75-second read-only hook is outside every original business budget.\n  afterAll(async () => {\n    if (!firstReviewOracle) return;\n    try {\n      const facts = await firstReviewFacts();\n      console.info(\n        'E4 first-review after app close',\n        JSON.stringify({ outcome: firstReviewOracle.outcome, ...facts }),\n      );\n      if (firstReviewOracle.outcome === 'pending')\n        throw new Error('First-review response terminal is unknown');\n      assertReviewCounts(facts, firstReviewOracle.outcome === 'fulfilled' ? 1 : 0);\n    } finally {\n      await firstReviewOracle.db.$disconnect();\n    }\n  }, 75_000);\n\n  // Independent receipt after both original fixture and review clients have closed.\n  afterAll(async () => {\n    await sliceReadDiagnostic?.collectCleanup();\n  }, 10_000);\n\n  // This owner-bound diagnostic is explicitly local-only; CI still runs the unchanged original full chain.\n",
        sha256: 'd829e0d17f9806ffeb20e7a76fc2cffb4ba415e03cb29ec57ab7c42f78b6aabb',
      },
      {
        candidate:
          "  (process.env.SRVF_E4_W98 === '1' ? it : it.skip)(\n    'E4 S13 thin-key exact full-doc probe',\n    () =>\n      capacityFinalization.run('s13', async () => {\n        s13Probe.active = true;\n        const originalClose: unknown = Reflect.get(f.app, 'close');\n        if (typeof originalClose !== 'function') throw new Error('S13 original app close missing');\n        const descriptor = Object.getOwnPropertyDescriptor(f.app, 'close');\n        Object.defineProperty(f.app, 'close', {\n          configurable: true,\n          writable: true,\n          value: function (this: object, ...args: unknown[]) {\n            const promise = Reflect.apply(originalClose, this, args) as Promise<void>;\n            void promise.then(\n              () => {\n                s13Probe.appClosed = true;\n              },\n              () => {\n                s13Probe.failed = true;\n              },\n            );\n            return promise;\n          },\n        });\n        s13Probe.restoreApp = () => {\n          if (descriptor) Object.defineProperty(f.app, 'close', descriptor);\n          else Reflect.deleteProperty(f.app, 'close');\n          expect(Reflect.get(f.app, 'close')).toBe(originalClose);\n        };\n        // E4_TERMINAL_REPLACE_S13_PRINCIPAL_BEGIN\n        terminalS13Principal = await terminalBusinessPrincipal(f.db);\n        let observedForClose: ObservedE4Database | undefined;\n        // E4_TERMINAL_REPLACE_S13_PRINCIPAL_END\n        let restoreEngine: (() => void) | undefined;\n        try {\n          const source = await createMaximumE4Source(f);\n          expect(\n            await f.db.activityParticipationIdentity.count({\n              where: { activityId: source.activityId },\n            }),\n          ).toBe(2000);\n          expect(\n            await f.db.participantTimeAllocationRevision.count({\n              where: { activityId: source.activityId },\n            }),\n          ).toBe(10000);\n          expect(\n            await f.db.participantTimeAllocationSlice.count({\n              where: { activityId: source.activityId },\n            }),\n          ).toBe(50000);\n          const observed = new ObservedE4Database({ log: [{ emit: 'event', level: 'query' }] });\n          const engineObserver = observeEngineTransactions(observed);\n          let queries = 0;\n          let e4Queries = 0;\n          let barrierQueries = 0;\n          const timing = { readMs: 0, writeMs: 0, largestMs: 0 };\n          let s13PhaseDiagnostic: E4PreparePhaseDiagnostic | undefined;\n          observed.$on('query', (event) => {\n            if (!/^\\s*(BEGIN|COMMIT|ROLLBACK|SET TRANSACTION)\\b/iu.test(event.query)) {\n              queries++;\n              s13PhaseDiagnostic?.query(\n                /^\\s*(SELECT|WITH)\\b/iu.test(event.query) ? 'READ' : 'WRITE',\n                event.duration,\n              );\n            }\n            if (\n              /(?:ActivitySettlementContributionRevision|ParticipantContributionEvaluation|e4_assert_|e4_revision_complete_guard)/u.test(\n                event.query,\n              )\n            )\n              e4Queries++;\n            if (/^\\s*SET CONSTRAINTS public\\.astr_parent_complete_guard,/u.test(event.query))\n              barrierQueries++;\n            if (/^\\s*(SELECT|WITH)\\b/iu.test(event.query)) timing.readMs += event.duration;\n            else timing.writeMs += event.duration;\n            timing.largestMs = Math.max(timing.largestMs, event.duration);\n          });\n          const reset = () => {\n            queries = 0;\n            e4Queries = 0;\n            barrierQueries = 0;\n            timing.readMs = 0;\n            timing.writeMs = 0;\n            timing.largestMs = 0;\n            engineObserver.reset();\n          };\n          const contributions = f.app.get(ActivityContributionSettlementService);\n          const access = f.app.get(ActivityTimeSettlementAccessService);\n          const segments = f.app.get(ParticipationSegmentFacade);\n          const reader = new ActivityTimeSettlementQueryService(\n            observed,\n            access,\n            segments,\n            f.app.get(ActivityContributionSettlementQueryService),\n          );\n          const measured = new ActivityTimeSettlementService(\n            observed,\n            access,\n            reader,\n            segments,\n            f.app.get(ActivityTimeAllocationService),\n            f.app.get(SettlementSubmitService),\n            f.app.get(ActivityTimeSettlementAuditRecorder),\n            f.app.get(ActivityWorkflowGate),\n            contributions,\n          );\n\n          observedForClose = observed;\n          restoreEngine = engineObserver.restore;\n          await assertConnectedTestDatabase(observed);\n          reset();\n          const phaseDiagnostic = new E4PreparePhaseDiagnostic([\n            { phase: 'C3_PROOF', target: measured, method: 'lockedProof' },\n            { phase: 'C3_SOURCE', target: measured, method: 'lockedSources' },\n            { phase: 'C3_EVAL', target: reader, method: 'evaluateInTx' },\n            { phase: 'C3_BUCKET_WRITE', target: measured, method: 'insertBuckets' },\n            { phase: 'E4_PREPARE', target: contributions, method: 'prepareTimeInTx' },\n            {\n              phase: 'E4_EVAL',\n              target: f.app.get(ActivityContributionSettlementQueryService),\n              method: 'readTimeEvaluationInTx',\n            },\n            { phase: 'E4_EVAL_WRITE', target: contributions, method: 'insertEvaluations' },\n            { phase: 'C3_RECEIPT', target: measured, method: 'receipt' },\n          ]);\n          s13PhaseDiagnostic = phaseDiagnostic;\n          let prepared: Awaited<ReturnType<ActivityTimeSettlementService['prepare']>>;\n          let prepareMs = 0;\n          phaseDiagnostic.begin();\n          const started = performance.now();\n          try {\n            prepared = await measured.prepare(\n              source.activityId,\n              {\n                expectedDraftVersion: source.expectation.expectedDraftVersion,\n                expectedEvidenceSealId: source.expectation.expectedEvidenceSealId,\n                operationKey: f.key('s13_prepare'),\n                expectedTimeRevision: 0,\n              },\n              e4Actor(f.creator, true),\n              E4_META,\n            );\n            prepareMs = performance.now() - started;\n            phaseDiagnostic.finish('OK');\n          } catch (error) {\n            prepareMs = performance.now() - started;\n            phaseDiagnostic.finish('FAIL');\n            throw error;\n          } finally {\n            phaseDiagnostic.restore();\n            s13PhaseDiagnostic = undefined;\n            phaseDiagnostic.emitTo((safeJson) => console.info('E4_C1_V2_S13_PHASES', safeJson));\n            console.info('E4_C1_V2_S13_METHOD', JSON.stringify({ methodWallMs: prepareMs }));\n          }\n          console.info(\n            'E4_S13_FRESH_PREPARE',\n            JSON.stringify({\n              prepareMs,\n              queries,\n              e4Queries,\n              barrierQueries,\n              ...timing,\n              enginePhases: engineObserver.phases,\n            }),\n          );\n          expect(phaseDiagnostic.snapshot().status).toBe('COMPLETE');\n          console.info('E4_C1_V2_PREPARE', JSON.stringify(engineObserver.assertPrepare(prepareMs)));\n          expect(queries).toBeGreaterThan(0);\n          expect(queries).toBeLessThanOrEqual(400);\n          expect(e4Queries).toBeLessThanOrEqual(12);\n          expect(barrierQueries).toBe(1);\n          expect(prepared.bucketCount).toBe(8000);\n          expect(prepared.sourceCount).toBe(40000);\n          const proof = await f.db.activitySettlementContributionRevision.findFirstOrThrow({\n            where: { settlementVersionId: prepared.settlementVersionId },\n          });\n          expect(proof.evaluationCount).toBe(8000);\n          expect(proof.recognizedPointsTotal.toFixed(2)).toBe('1000.00');\n          await assertFixedE4Oracle(f.db, proof.id, 8000);\n          reset();\n          const submitted = await measured.submit(\n            source.activityId,\n            {\n              expectedDraftVersion: source.expectation.expectedDraftVersion,\n              expectedEvidenceSealId: source.expectation.expectedEvidenceSealId,\n              operationKey: f.key('s13_submit'),\n              timeRevisionId: prepared.timeRevisionId,\n              expectedBucketContentHash: prepared.bucketContentHash,\n            },\n            e4Actor(f.creator, true),\n            E4_META,\n          );\n          console.info(\n            'E4_S13_FRESH_SUBMIT',\n            JSON.stringify({\n              queries,\n              e4Queries,\n              ...timing,\n              enginePhases: engineObserver.phases,\n            }),\n          );\n          expect(queries).toBeGreaterThan(0);\n          expect(queries).toBeLessThanOrEqual(950);\n          expect(e4Queries).toBeLessThanOrEqual(12);\n          expect(submitted.kindCode).toBe('submitted');\n          const submittedProofs = await f.db.activitySettlementContributionRevision.findMany({\n            where: {\n              activityId: source.activityId,\n              settlementRunId: submitted.settlementRunId,\n              settlementVersionId: submitted.settlementVersionId,\n              timeRevisionId: submitted.timeRevisionId,\n              kindCode: 'submitted',\n              sourceKindCode: 'time_revision',\n              sourceDraftContributionRevisionId: proof.id,\n            },\n            take: 2,\n          });\n          expect(submittedProofs).toHaveLength(1);\n          const submittedProof = submittedProofs[0];\n          expect(submittedProof.evaluationCount).toBe(8000);\n          expect(submittedProof.recognizedPointsTotal.toFixed(2)).toBe('1000.00');\n          await assertFixedE4Oracle(f.db, submittedProof.id, 8000);\n          s13Probe.rootId = submittedProof.id;\n          s13Probe.businessPassed = true;\n        } catch (error) {\n          s13Probe.failed = true;\n          throw error;\n        } finally {\n          restoreEngine?.();\n          if (observedForClose) {\n            try {\n              await observedForClose.$disconnect();\n              s13Probe.measuredClosed = true;\n            } catch {\n              s13Probe.failed = true;\n              s13Probe.expired = true;\n            }\n          }\n        }\n      }),\n    600_000,\n  );\n  // E4_C1_V2_S13_END\n\n  afterAll(\n    () =>\n      capacityFinalization.run('s13-probe', async () => {\n        if (!s13Probe.active) return;\n        if (s13Probe.failed)\n          throw new Error('S13 business first red; no plan rerun or cleanup allowed');\n        await runS13IndependentProbe();\n        if (\n          s13Probe.failed ||\n          s13Probe.expired ||\n          s13Probe.pending !== 0 ||\n          !s13Probe.appClosed ||\n          !s13Probe.measuredClosed ||\n          !s13Probe.planClosed\n        ) {\n          capacityFinalization.fail();\n          throw new Error('S13 terminal state UNKNOWN; preserve database');\n        }\n      }),\n    75_000,\n  );\n\n  it(\n    '2,000 identities / 10,000 segments / 50,000 slices yield 8,000 policy units without repeated awards',\n    () =>\n      capacityFinalization.run('maximum', async () => {\n        const sliceObservationDeadline = performance.now() + 600_000;\n        const sliceOptions = e4SliceReadOptions();\n        await preflightE4SliceReadDiagnostic(f.db, sliceOptions);\n        const stages = createE4MaximumStageReceipt();\n        const source = await stages.run('FIXTURE', () => createMaximumE4Source(f));\n        stages.enter('FIXTURE_CHECKS');\n        expect(\n          await f.db.activityParticipationIdentity.count({\n",
        opening:
          "  (process.env.SRVF_E4_W98 === '1' ? it : it.skip)(\n    'E4 S13 thin-key exact full-doc probe',\n    async () => {\n      s13Probe.active = true;\n      const originalClose: unknown = Reflect.get(f.app, 'close');\n      if (typeof originalClose !== 'function') throw new Error('S13 original app close missing');\n      const descriptor = Object.getOwnPropertyDescriptor(f.app, 'close');\n      Object.defineProperty(f.app, 'close', {\n        configurable: true,\n        writable: true,\n        value: function (this: object, ...args: unknown[]) {\n          const promise = Reflect.apply(originalClose, this, args) as Promise<void>;\n          void promise.then(\n            () => {\n              s13Probe.appClosed = true;\n            },\n            () => {\n              s13Probe.failed = true;\n            },\n          );\n          return promise;\n        },\n      });\n      s13Probe.restoreApp = () => {\n        if (descriptor) Object.defineProperty(f.app, 'close', descriptor);\n        else Reflect.deleteProperty(f.app, 'close');\n        expect(Reflect.get(f.app, 'close')).toBe(originalClose);\n      };\n      // E4_TERMINAL_REPLACE_S13_PRINCIPAL_BEGIN\n      terminalS13Principal = await terminalBusinessPrincipal(f.db);\n      let observedForClose: ObservedE4Database | undefined;\n      // E4_TERMINAL_REPLACE_S13_PRINCIPAL_END\n      let restoreEngine: (() => void) | undefined;\n      try {\n        const source = await createMaximumE4Source(f);\n        expect(\n          await f.db.activityParticipationIdentity.count({\n",
        sha256: '06c0c5316f655388cc20b82a08aa28633f8064b17e2c15188d5bb4157d046c8a',
      },
      {
        candidate:
          "          }),\n        ).toBe(50000);\n        stages.complete('FIXTURE_CHECKS');\n        stages.enter('PREPARE_SETUP');\n        const observed = new ObservedE4Database({\n          log: [{ emit: 'event', level: 'query' }],\n          ...sliceOptions.clientOptions,\n        });\n        try {\n          sliceReadDiagnostic = new E4SliceReadDiagnostic(observed, f.db, f.app, {\n            scope: sliceOptions.scope,\n            applicationName: sliceOptions.applicationName,\n            deadlineMs: sliceObservationDeadline,\n            dedicatedLease: process.env.SRVF_E4_W98 === '1',\n          });\n          observed.$on('query', (event) =>\n            sliceReadDiagnostic?.queryEvent(event.query, event.duration),\n          );\n        } catch {\n          capacityFinalization.fail();\n          console.info('E4_SLICE_READ', '{\"status\":\"UNKNOWN\",\"reason\":\"INSTALL\"}');\n        }\n        const engineObserver = observeEngineTransactions(observed);\n        const engineRequests = new E4EngineRequestWaitDiagnostic(\n          Reflect.get(observed, '_engine') as object,\n        );\n        let queries = 0;\n        let e4Queries = 0;\n        let barrierQueries = 0;\n        const timing = { readMs: 0, writeMs: 0, largestMs: 0 };\n        let preparePhaseDiagnostic: E4PreparePhaseDiagnostic | undefined;\n        observed.$on('query', (event) => {\n          if (!/^\\s*(BEGIN|COMMIT|ROLLBACK|SET TRANSACTION)\\b/iu.test(event.query)) {\n            queries++;\n            preparePhaseDiagnostic?.query(\n              /^\\s*(SELECT|WITH)\\b/iu.test(event.query) ? 'READ' : 'WRITE',\n              event.duration,\n",
        opening:
          "          }),\n        ).toBe(50000);\n        const observed = new ObservedE4Database({ log: [{ emit: 'event', level: 'query' }] });\n        const engineObserver = observeEngineTransactions(observed);\n        let queries = 0;\n        let e4Queries = 0;\n        let barrierQueries = 0;\n        const timing = { readMs: 0, writeMs: 0, largestMs: 0 };\n        let s13PhaseDiagnostic: E4PreparePhaseDiagnostic | undefined;\n        observed.$on('query', (event) => {\n          if (!/^\\s*(BEGIN|COMMIT|ROLLBACK|SET TRANSACTION)\\b/iu.test(event.query)) {\n            queries++;\n            s13PhaseDiagnostic?.query(\n              /^\\s*(SELECT|WITH)\\b/iu.test(event.query) ? 'READ' : 'WRITE',\n              event.duration,\n",
        sha256: '50c88d3a033b28c3449328fdc68abe40296b3cab11e47763fce9fc4961c85776',
      },
      {
        candidate:
          '          timing.writeMs = 0;\n          timing.largestMs = 0;\n          // E4_C1_V2_MAX_RESET_BEGIN\n          engineObserver.reset();\n          // E4_C1_V2_MAX_RESET_END\n        };\n        const contributions = f.app.get(ActivityContributionSettlementService);\n',
        opening:
          '          timing.writeMs = 0;\n          timing.largestMs = 0;\n          engineObserver.reset();\n        };\n        const contributions = f.app.get(ActivityContributionSettlementService);\n',
        sha256: 'b2edf7b1fc08517be18a93fd2f8053cddc5bc6939f0466053d3eb1636377d3b4',
      },
      {
        candidate:
          "          contributions,\n        );\n        try {\n          await assertConnectedTestDatabase(observed);\n          const prepareCommand = {\n            expectedDraftVersion: source.expectation.expectedDraftVersion,\n            expectedEvidenceSealId: source.expectation.expectedEvidenceSealId,\n            operationKey: f.key('maximum_prepare'),\n            expectedTimeRevision: 0,\n          };\n          const prepareRequestHash = timeSettlementPrepareRequestHash(\n            source.activityId,\n            f.creator.id,\n            prepareCommand,\n          );\n          reset();\n          const started = Date.now();\n          // E4_GUARD_FUNCTION_INSTANCE_BEGIN\n          const guardFunctionDiagnostic = guardFunctionDiagnosticEnabled()\n            ? new E4GuardFunctionDiagnostic(\n                contributions,\n                resolve(process.cwd(), 'tmp/e4-guard-functions-evidence/functions.json'),\n              )\n            : undefined;\n          // E4_GUARD_FUNCTION_INSTANCE_END\n          // E4_GUARD_PLAN_INSTANCE_BEGIN\n          const guardPlanDiagnostic = guardPlanDiagnosticEnabled()\n            ? new E4GuardPlanDiagnostic(\n                contributions,\n                resolve(process.cwd(), 'tmp/e4-guard-plan-evidence/guard-plan.json'),\n              )\n            : undefined;\n          // E4_GUARD_PLAN_INSTANCE_END\n          let prepared;\n          const phaseDiagnostic = new E4PreparePhaseDiagnostic([\n            { phase: 'C3_PROOF', target: measured, method: 'lockedProof' },\n            { phase: 'C3_SOURCE', target: measured, method: 'lockedSources' },\n            { phase: 'C3_EVAL', target: reader, method: 'evaluateInTx' },\n            { phase: 'C3_BUCKET_WRITE', target: measured, method: 'insertBuckets' },\n            { phase: 'E4_PREPARE', target: contributions, method: 'prepareTimeInTx' },\n            {\n              phase: 'E4_EVAL',\n              target: f.app.get(ActivityContributionSettlementQueryService),\n              method: 'readTimeEvaluationInTx',\n            },\n            { phase: 'E4_EVAL_WRITE', target: contributions, method: 'insertEvaluations' },\n            { phase: 'C3_RECEIPT', target: measured, method: 'receipt' },\n          ]);\n          preparePhaseDiagnostic = phaseDiagnostic;\n          // E4_C1_V2_MAX_METHOD_STATE_BEGIN\n          let prepareBusinessFailure: { error: unknown } | undefined;\n          let prepareMethodWallMs = 0;\n          // E4_C1_V2_MAX_METHOD_STATE_END\n          try {\n            sliceReadDiagnostic?.arm();\n            engineRequests.begin();\n            phaseDiagnostic.begin();\n            stages.complete('PREPARE_SETUP');\n            let prepareOutcome: 'OK' | 'FAIL' = 'FAIL';\n            try {\n              // E4_C1_V2_MAX_METHOD_CALL_BEGIN\n              prepared = await stages.run('PREPARE', async () => {\n                const methodStarted = Date.now();\n                try {\n                  const result = await measured.prepare(\n                    source.activityId,\n                    prepareCommand,\n                    e4Actor(f.creator, true),\n                    E4_META,\n                  );\n                  prepareOutcome = 'OK';\n                  return result;\n                } catch (error) {\n                  prepareBusinessFailure = { error };\n                  throw error;\n                } finally {\n                  prepareMethodWallMs = Date.now() - methodStarted;\n                }\n              });\n              // E4_C1_V2_MAX_METHOD_CALL_END\n\n              stages.enter('PREPARE_RECEIPT');\n            } finally {\n              engineRequests.finish();\n              engineRequests.restore();\n              sliceReadDiagnostic?.restoreEngine();\n              console.info(\n                'E4 maximum engine request waits (fixed counters)',\n                JSON.stringify(engineRequests.snapshot()),\n              );\n              phaseDiagnostic.finish(prepareOutcome);\n              phaseDiagnostic.restore();\n              // E4_GUARD_FUNCTION_RESTORE_BEGIN\n              guardFunctionDiagnostic?.restore();\n              await guardFunctionDiagnostic?.collect(observed);\n              guardFunctionDiagnostic?.emit();\n              // E4_GUARD_FUNCTION_RESTORE_END\n              // E4_GUARD_PLAN_RESTORE_BEGIN\n              guardPlanDiagnostic?.restore();\n              guardPlanDiagnostic?.emit();\n              // E4_GUARD_PLAN_RESTORE_END\n              preparePhaseDiagnostic = undefined;\n              phaseDiagnostic.emitTo((safeJson) =>\n                console.info('E4 maximum prepare phases (fixed counters)', safeJson),\n              );\n            }\n          } catch (error) {\n            // A receipt failure after COMMIT must not enter business rollback diagnostics.\n            if (!prepareBusinessFailure || !Object.is(prepareBusinessFailure.error, error))\n              throw error;\n            const prismaCode =\n              error instanceof Prisma.PrismaClientKnownRequestError ? error.code : 'other';\n            console.info(\n              'E4 maximum prepare failure (fixed redacted counters)',\n              JSON.stringify({\n                elapsedMs: Date.now() - started,\n                queries,\n                e4Queries,\n                barrierQueries,\n                ...timing,\n                enginePhases: engineObserver.phases,\n                prismaCode: ['P2028', 'P2010', 'P2002', 'P2003'].includes(prismaCode)\n                  ? prismaCode\n                  : 'other',\n              }),\n            );\n            // Independent connection, exact original actor/command/hash/version anchors; counters only.\n            const [sameCommandFacts] = await f.db.$queryRaw<\n              {\n                roots: number;\n                evaluations: number;\n                timeRoots: number;\n                buckets: number;\n                sources: number;\n                receipts: number;\n                audits: number;\n              }[]\n            >`\n          WITH roots AS MATERIALIZED (\n            SELECT id,\"timeRevisionId\" FROM \"ActivitySettlementContributionRevision\"\n",
        opening:
          "          contributions,\n        );\n\n        observedForClose = observed;\n        restoreEngine = engineObserver.restore;\n        await assertConnectedTestDatabase(observed);\n        reset();\n        const phaseDiagnostic = new E4PreparePhaseDiagnostic([\n          { phase: 'C3_PROOF', target: measured, method: 'lockedProof' },\n          { phase: 'C3_SOURCE', target: measured, method: 'lockedSources' },\n          { phase: 'C3_EVAL', target: reader, method: 'evaluateInTx' },\n          { phase: 'C3_BUCKET_WRITE', target: measured, method: 'insertBuckets' },\n          { phase: 'E4_PREPARE', target: contributions, method: 'prepareTimeInTx' },\n          {\n            phase: 'E4_EVAL',\n            target: f.app.get(ActivityContributionSettlementQueryService),\n            method: 'readTimeEvaluationInTx',\n          },\n          { phase: 'E4_EVAL_WRITE', target: contributions, method: 'insertEvaluations' },\n          { phase: 'C3_RECEIPT', target: measured, method: 'receipt' },\n        ]);\n        s13PhaseDiagnostic = phaseDiagnostic;\n        let prepared: Awaited<ReturnType<ActivityTimeSettlementService['prepare']>>;\n        let prepareMs = 0;\n        phaseDiagnostic.begin();\n        const started = performance.now();\n        try {\n          prepared = await measured.prepare(\n            source.activityId,\n            {\n              expectedDraftVersion: source.expectation.expectedDraftVersion,\n              expectedEvidenceSealId: source.expectation.expectedEvidenceSealId,\n              operationKey: f.key('s13_prepare'),\n              expectedTimeRevision: 0,\n            },\n            e4Actor(f.creator, true),\n            E4_META,\n          );\n          prepareMs = performance.now() - started;\n          phaseDiagnostic.finish('OK');\n        } catch (error) {\n          prepareMs = performance.now() - started;\n          phaseDiagnostic.finish('FAIL');\n          throw error;\n        } finally {\n          phaseDiagnostic.restore();\n          s13PhaseDiagnostic = undefined;\n          phaseDiagnostic.emitTo((safeJson) => console.info('E4_C1_V2_S13_PHASES', safeJson));\n          console.info('E4_C1_V2_S13_METHOD', JSON.stringify({ methodWallMs: prepareMs }));\n        }\n        console.info(\n          'E4_S13_FRESH_PREPARE',\n          JSON.stringify({\n            prepareMs,\n            queries,\n            e4Queries,\n            barrierQueries,\n            ...timing,\n            enginePhases: engineObserver.phases,\n          }),\n        );\n        expect(phaseDiagnostic.snapshot().status).toBe('COMPLETE');\n        console.info('E4_C1_V2_PREPARE', JSON.stringify(engineObserver.assertPrepare(prepareMs)));\n        expect(queries).toBeGreaterThan(0);\n        expect(queries).toBeLessThanOrEqual(400);\n        expect(e4Queries).toBeLessThanOrEqual(12);\n        expect(barrierQueries).toBe(1);\n        expect(prepared.bucketCount).toBe(8000);\n        expect(prepared.sourceCount).toBe(40000);\n        const proof = await f.db.activitySettlementContributionRevision.findFirstOrThrow({\n          where: { settlementVersionId: prepared.settlementVersionId },\n        });\n        expect(proof.evaluationCount).toBe(8000);\n        expect(proof.recognizedPointsTotal.toFixed(2)).toBe('1000.00');\n        await assertFixedE4Oracle(f.db, proof.id, 8000);\n        reset();\n        const submitted = await measured.submit(\n          source.activityId,\n          {\n            expectedDraftVersion: source.expectation.expectedDraftVersion,\n            expectedEvidenceSealId: source.expectation.expectedEvidenceSealId,\n            operationKey: f.key('s13_submit'),\n            timeRevisionId: prepared.timeRevisionId,\n            expectedBucketContentHash: prepared.bucketContentHash,\n          },\n          e4Actor(f.creator, true),\n          E4_META,\n        );\n        console.info(\n          'E4_S13_FRESH_SUBMIT',\n          JSON.stringify({\n            queries,\n            e4Queries,\n            ...timing,\n            enginePhases: engineObserver.phases,\n          }),\n        );\n        expect(queries).toBeGreaterThan(0);\n        expect(queries).toBeLessThanOrEqual(950);\n        expect(e4Queries).toBeLessThanOrEqual(12);\n        expect(submitted.kindCode).toBe('submitted');\n        const submittedProofs = await f.db.activitySettlementContributionRevision.findMany({\n          where: {\n            activityId: source.activityId,\n            settlementRunId: submitted.settlementRunId,\n            settlementVersionId: submitted.settlementVersionId,\n            timeRevisionId: submitted.timeRevisionId,\n            kindCode: 'submitted',\n            sourceKindCode: 'time_revision',\n            sourceDraftContributionRevisionId: proof.id,\n          },\n          take: 2,\n        });\n        expect(submittedProofs).toHaveLength(1);\n        const submittedProof = submittedProofs[0];\n        expect(submittedProof.evaluationCount).toBe(8000);\n        expect(submittedProof.recognizedPointsTotal.toFixed(2)).toBe('1000.00');\n        await assertFixedE4Oracle(f.db, submittedProof.id, 8000);\n        s13Probe.rootId = submittedProof.id;\n        s13Probe.businessPassed = true;\n      } catch (error) {\n        s13Probe.failed = true;\n        throw error;\n      } finally {\n        restoreEngine?.();\n        if (observedForClose) {\n          try {\n            await observedForClose.$disconnect();\n            s13Probe.measuredClosed = true;\n          } catch {\n            s13Probe.failed = true;\n            s13Probe.expired = true;\n          }\n        }\n      }\n    },\n    600_000,\n  );\n  // E4_C1_V2_S13_END\n\n  afterAll(async () => {\n    if (!s13Probe.active) return;\n    if (s13Probe.failed)\n      throw new Error('S13 business first red; no plan rerun or cleanup allowed');\n    await runS13IndependentProbe();\n  }, 75_000);\n\n  it('2,000 identities / 10,000 segments / 50,000 slices yield 8,000 policy units without repeated awards', async () => {\n    const sliceObservationDeadline = performance.now() + 600_000;\n    const sliceOptions = e4SliceReadOptions();\n    await preflightE4SliceReadDiagnostic(f.db, sliceOptions);\n    const stages = createE4MaximumStageReceipt();\n    const source = await stages.run('FIXTURE', () => createMaximumE4Source(f));\n    stages.enter('FIXTURE_CHECKS');\n    expect(\n      await f.db.activityParticipationIdentity.count({ where: { activityId: source.activityId } }),\n    ).toBe(2000);\n    expect(\n      await f.db.participantTimeAllocationRevision.count({\n        where: { activityId: source.activityId },\n      }),\n    ).toBe(10000);\n    expect(\n      await f.db.participantTimeAllocationSlice.count({ where: { activityId: source.activityId } }),\n    ).toBe(50000);\n    stages.complete('FIXTURE_CHECKS');\n    stages.enter('PREPARE_SETUP');\n    const observed = new ObservedE4Database({\n      log: [{ emit: 'event', level: 'query' }],\n      ...sliceOptions.clientOptions,\n    });\n    try {\n      sliceReadDiagnostic = new E4SliceReadDiagnostic(observed, f.db, f.app, {\n        scope: sliceOptions.scope,\n        applicationName: sliceOptions.applicationName,\n        deadlineMs: sliceObservationDeadline,\n        dedicatedLease: process.env.SRVF_E4_W98 === '1',\n      });\n      observed.$on('query', (event) =>\n        sliceReadDiagnostic?.queryEvent(event.query, event.duration),\n      );\n    } catch {\n      console.info('E4_SLICE_READ', '{\"status\":\"UNKNOWN\",\"reason\":\"INSTALL\"}');\n    }\n    const engineObserver = observeEngineTransactions(observed);\n    const engineRequests = new E4EngineRequestWaitDiagnostic(\n      Reflect.get(observed, '_engine') as object,\n    );\n    let queries = 0;\n    let e4Queries = 0;\n    let barrierQueries = 0;\n    const timing = { readMs: 0, writeMs: 0, largestMs: 0 };\n    let preparePhaseDiagnostic: E4PreparePhaseDiagnostic | undefined;\n    observed.$on('query', (event) => {\n      if (!/^\\s*(BEGIN|COMMIT|ROLLBACK|SET TRANSACTION)\\b/iu.test(event.query)) {\n        queries++;\n        preparePhaseDiagnostic?.query(\n          /^\\s*(SELECT|WITH)\\b/iu.test(event.query) ? 'READ' : 'WRITE',\n          event.duration,\n        );\n      }\n      if (\n        /(?:ActivitySettlementContributionRevision|ParticipantContributionEvaluation|e4_assert_|e4_revision_complete_guard)/u.test(\n          event.query,\n        )\n      )\n        e4Queries++;\n      if (/^\\s*SET CONSTRAINTS public\\.astr_parent_complete_guard,/u.test(event.query))\n        barrierQueries++;\n      if (/^\\s*(SELECT|WITH)\\b/iu.test(event.query)) timing.readMs += event.duration;\n      else timing.writeMs += event.duration;\n      timing.largestMs = Math.max(timing.largestMs, event.duration);\n    });\n    const reset = () => {\n      queries = 0;\n      e4Queries = 0;\n      barrierQueries = 0;\n      timing.readMs = 0;\n      timing.writeMs = 0;\n      timing.largestMs = 0;\n      // E4_C1_V2_MAX_RESET_BEGIN\n      engineObserver.reset();\n      // E4_C1_V2_MAX_RESET_END\n    };\n    const contributions = f.app.get(ActivityContributionSettlementService);\n    const access = f.app.get(ActivityTimeSettlementAccessService);\n    const segments = f.app.get(ParticipationSegmentFacade);\n    const reader = new ActivityTimeSettlementQueryService(\n      observed,\n      access,\n      segments,\n      f.app.get(ActivityContributionSettlementQueryService),\n    );\n    const measured = new ActivityTimeSettlementService(\n      observed,\n      access,\n      reader,\n      segments,\n      f.app.get(ActivityTimeAllocationService),\n      f.app.get(SettlementSubmitService),\n      f.app.get(ActivityTimeSettlementAuditRecorder),\n      f.app.get(ActivityWorkflowGate),\n      contributions,\n    );\n    try {\n      await assertConnectedTestDatabase(observed);\n      const prepareCommand = {\n        expectedDraftVersion: source.expectation.expectedDraftVersion,\n        expectedEvidenceSealId: source.expectation.expectedEvidenceSealId,\n        operationKey: f.key('maximum_prepare'),\n        expectedTimeRevision: 0,\n      };\n      const prepareRequestHash = timeSettlementPrepareRequestHash(\n        source.activityId,\n        f.creator.id,\n        prepareCommand,\n      );\n      reset();\n      const started = Date.now();\n      // E4_GUARD_FUNCTION_INSTANCE_BEGIN\n      const guardFunctionDiagnostic = guardFunctionDiagnosticEnabled()\n        ? new E4GuardFunctionDiagnostic(\n            contributions,\n            resolve(process.cwd(), 'tmp/e4-guard-functions-evidence/functions.json'),\n          )\n        : undefined;\n      // E4_GUARD_FUNCTION_INSTANCE_END\n      // E4_GUARD_PLAN_INSTANCE_BEGIN\n      const guardPlanDiagnostic = guardPlanDiagnosticEnabled()\n        ? new E4GuardPlanDiagnostic(\n            contributions,\n            resolve(process.cwd(), 'tmp/e4-guard-plan-evidence/guard-plan.json'),\n          )\n        : undefined;\n      // E4_GUARD_PLAN_INSTANCE_END\n      let prepared;\n      const phaseDiagnostic = new E4PreparePhaseDiagnostic([\n        { phase: 'C3_PROOF', target: measured, method: 'lockedProof' },\n        { phase: 'C3_SOURCE', target: measured, method: 'lockedSources' },\n        { phase: 'C3_EVAL', target: reader, method: 'evaluateInTx' },\n        { phase: 'C3_BUCKET_WRITE', target: measured, method: 'insertBuckets' },\n        { phase: 'E4_PREPARE', target: contributions, method: 'prepareTimeInTx' },\n        {\n          phase: 'E4_EVAL',\n          target: f.app.get(ActivityContributionSettlementQueryService),\n          method: 'readTimeEvaluationInTx',\n        },\n        { phase: 'E4_EVAL_WRITE', target: contributions, method: 'insertEvaluations' },\n        { phase: 'C3_RECEIPT', target: measured, method: 'receipt' },\n      ]);\n      preparePhaseDiagnostic = phaseDiagnostic;\n      // E4_C1_V2_MAX_METHOD_STATE_BEGIN\n      let prepareBusinessFailure: { error: unknown } | undefined;\n      let prepareMethodWallMs = 0;\n      // E4_C1_V2_MAX_METHOD_STATE_END\n      try {\n        sliceReadDiagnostic?.arm();\n        engineRequests.begin();\n        phaseDiagnostic.begin();\n        stages.complete('PREPARE_SETUP');\n        let prepareOutcome: 'OK' | 'FAIL' = 'FAIL';\n        try {\n          // E4_C1_V2_MAX_METHOD_CALL_BEGIN\n          prepared = await stages.run('PREPARE', async () => {\n            const methodStarted = Date.now();\n            try {\n              const result = await measured.prepare(\n                source.activityId,\n                prepareCommand,\n                e4Actor(f.creator, true),\n                E4_META,\n              );\n              prepareOutcome = 'OK';\n              return result;\n            } catch (error) {\n              prepareBusinessFailure = { error };\n              throw error;\n            } finally {\n              prepareMethodWallMs = Date.now() - methodStarted;\n            }\n          });\n          // E4_C1_V2_MAX_METHOD_CALL_END\n\n          stages.enter('PREPARE_RECEIPT');\n        } finally {\n          engineRequests.finish();\n          engineRequests.restore();\n          sliceReadDiagnostic?.restoreEngine();\n          console.info(\n            'E4 maximum engine request waits (fixed counters)',\n            JSON.stringify(engineRequests.snapshot()),\n          );\n          phaseDiagnostic.finish(prepareOutcome);\n          phaseDiagnostic.restore();\n          // E4_GUARD_FUNCTION_RESTORE_BEGIN\n          guardFunctionDiagnostic?.restore();\n          await guardFunctionDiagnostic?.collect(observed);\n          guardFunctionDiagnostic?.emit();\n          // E4_GUARD_FUNCTION_RESTORE_END\n          // E4_GUARD_PLAN_RESTORE_BEGIN\n          guardPlanDiagnostic?.restore();\n          guardPlanDiagnostic?.emit();\n          // E4_GUARD_PLAN_RESTORE_END\n          preparePhaseDiagnostic = undefined;\n          phaseDiagnostic.emitTo((safeJson) =>\n            console.info('E4 maximum prepare phases (fixed counters)', safeJson),\n          );\n        }\n      } catch (error) {\n        // A receipt failure after COMMIT must not enter business rollback diagnostics.\n        if (!prepareBusinessFailure || !Object.is(prepareBusinessFailure.error, error)) throw error;\n        const prismaCode =\n          error instanceof Prisma.PrismaClientKnownRequestError ? error.code : 'other';\n        console.info(\n          'E4 maximum prepare failure (fixed redacted counters)',\n          JSON.stringify({\n            elapsedMs: Date.now() - started,\n            queries,\n            e4Queries,\n            barrierQueries,\n            ...timing,\n            enginePhases: engineObserver.phases,\n            prismaCode: ['P2028', 'P2010', 'P2002', 'P2003'].includes(prismaCode)\n              ? prismaCode\n              : 'other',\n          }),\n        );\n        // Independent connection, exact original actor/command/hash/version anchors; counters only.\n        const [sameCommandFacts] = await f.db.$queryRaw<\n          {\n            roots: number;\n            evaluations: number;\n            timeRoots: number;\n            buckets: number;\n            sources: number;\n            receipts: number;\n            audits: number;\n          }[]\n        >`\n          WITH roots AS MATERIALIZED (\n            SELECT id,\"timeRevisionId\" FROM \"ActivitySettlementContributionRevision\"\n",
        sha256: '294355653f5104012876e630bd497eec37670fecc391c148cd65bd1b421e6929',
      },
      {
        candidate:
          "                AND context->'extra'->>'contributionRevisionId' IN (SELECT id FROM roots)) AS audits\n        `;\n            console.info(\n              'E4 maximum failure exact same-command facts',\n              JSON.stringify(sameCommandFacts),\n            );\n            if (sameCommandFacts.roots === 1) {\n              const roots = await f.db.activitySettlementContributionRevision.findMany({\n                where: {\n                  activityId: source.activityId,\n                  settlementRunId: source.generated.settlementRunId,\n                  settlementVersionId: source.generated.settlementVersionId,\n                  createdByUserId: f.creator.id,\n                  operationKey: prepareCommand.operationKey,\n                  requestHash: prepareRequestHash,\n                },\n                select: { id: true, sourceKindCode: true },\n                take: 2,\n              });\n              expect(roots).toHaveLength(1);\n              const actualRoot = roots[0];\n              const candidate = fixedE4RootAggregateSql(\n                actualRoot.id,\n                actualRoot.sourceKindCode,\n              ).candidate;\n              const probes = [\n                {\n                  name: 'actual_complete_false',\n                  sql: Prisma.sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT e4_assert_complete(${actualRoot.id},FALSE)`,\n                },\n                {\n                  name: 'actual_root_aggregate',\n                  sql: Prisma.sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${candidate}`,\n                },\n              ];\n              // At most two plans on this same failed root. READ ONLY and explicit rollback;\n              // never reproduce INSERT/COMMIT, create a new root or alter the business budget.\n              for (const probe of probes) {\n                let plan: unknown;\n                const rollback = new Error('E4 authorized read-only plan rollback');\n                try {\n                  await f.db.$transaction(\n                    async (tx) => {\n                      await tx.$executeRaw`SET TRANSACTION READ ONLY`;\n                      await tx.$executeRaw`SET LOCAL statement_timeout='30s'`;\n                      plan = await tx.$queryRaw(probe.sql);\n                      throw rollback;\n                    },\n                    { timeout: 35_000 },\n                  );\n                } catch (diagnosticError) {\n                  if (diagnosticError !== rollback) {\n                    const code =\n                      diagnosticError instanceof Prisma.PrismaClientKnownRequestError\n                        ? diagnosticError.code\n                        : 'other';\n                    console.info(\n                      'E4 bounded same-root plan not completed',\n                      JSON.stringify({\n                        name: probe.name,\n                        code: ['P2028', 'P2010'].includes(code) ? code : 'other',\n                      }),\n                    );\n                    continue;\n                  }\n                  const rows = Array.isArray(plan) ? plan : [];\n                  const row = rows[0] as Record<string, unknown> | undefined;\n                  const documents = row?.['QUERY PLAN'];\n                  const document = Array.isArray(documents)\n                    ? (documents[0] as Record<string, unknown> | undefined)\n                    : undefined;\n                  const rootPlan = document?.Plan as Record<string, unknown> | undefined;\n                  // Fixed numeric fields only, not SQL text, parameter values or arbitrary plan strings.\n                  const numeric = (value: unknown) =>\n                    typeof value === 'number' && Number.isFinite(value) ? value : null;\n                  console.info(\n                    'E4 bounded same-root rollback plan',\n                    JSON.stringify({\n                      name: probe.name,\n                      planningMs: numeric(document?.['Planning Time']),\n                      executionMs: numeric(document?.['Execution Time']),\n                      actualTotalMs: numeric(rootPlan?.['Actual Total Time']),\n                      rows: numeric(rootPlan?.['Actual Rows']),\n                      loops: numeric(rootPlan?.['Actual Loops']),\n                      sharedHit: numeric(rootPlan?.['Shared Hit Blocks']),\n                      sharedRead: numeric(rootPlan?.['Shared Read Blocks']),\n                      tempRead: numeric(rootPlan?.['Temp Read Blocks']),\n                      tempWritten: numeric(rootPlan?.['Temp Written Blocks']),\n                    }),\n                  );\n                }\n              }\n            }\n            expect(\n              await f.db.activitySettlementContributionRevision.count({\n                where: { activityId: source.activityId },\n              }),\n            ).toBe(0);\n            expect(\n              await f.db.activitySettlementTimeRevision.count({\n                where: { activityId: source.activityId },\n              }),\n            ).toBe(0);\n            throw error;\n          }\n          expect(phaseDiagnostic.snapshot().status).toBe('COMPLETE');\n          if (engineRequests.snapshot().status !== 'COMPLETE')\n            throw new Error('E4 engine request waits UNKNOWN; stop before next stage');\n          const prepareMs = Date.now() - started;\n          console.info(\n            'E4 maximum prepare',\n            JSON.stringify({\n              prepareMs,\n              queries,\n              e4Queries,\n              barrierQueries,\n              ...timing,\n              enginePhases: engineObserver.phases,\n            }),\n          );\n          stages.complete('PREPARE_RECEIPT');\n          stages.enter('PREPARE_CHECKS');\n          // E4_C1_V2_MAX_ACCEPTANCE_BEGIN\n          console.info(\n            'E4_C1_V2_PREPARE',\n            JSON.stringify(engineObserver.assertPrepare(prepareMethodWallMs)),\n          );\n          // E4_C1_V2_MAX_ACCEPTANCE_END\n          expect(queries).toBeGreaterThan(0);\n          expect(queries).toBeLessThanOrEqual(400);\n          expect(e4Queries).toBeLessThanOrEqual(12);\n          expect(barrierQueries).toBe(1);\n          expect(prepared.bucketCount).toBe(8000);\n          expect(prepared.sourceCount).toBe(40000);\n          stages.complete('PREPARE_CHECKS');\n          const proof = await stages.run('PROOF_READ', () =>\n            f.db.activitySettlementContributionRevision.findFirstOrThrow({\n              where: { settlementVersionId: prepared.settlementVersionId },\n            }),\n          );\n          stages.enter('PROOF_CHECKS');\n          expect(proof.evaluationCount).toBe(8000);\n          expect(proof.recognizedPointsTotal.toFixed(2)).toBe('1000.00');\n          // Full old expected documents and the independent abc actual-row root oracle,\n          // before any submit/review/ledger stage. These reads are outside the measured command.\n          stages.complete('PROOF_CHECKS');\n          await stages.run('ORACLE', () => assertFixedE4Oracle(f.db, proof.id, 8000));\n          reset();\n          const submitted = await stages.run('SUBMIT', () =>\n            measured.submit(\n              source.activityId,\n              {\n                expectedDraftVersion: source.expectation.expectedDraftVersion,\n                expectedEvidenceSealId: source.expectation.expectedEvidenceSealId,\n                operationKey: f.key('maximum_submit'),\n                timeRevisionId: prepared.timeRevisionId,\n                expectedBucketContentHash: prepared.bucketContentHash,\n              },\n              e4Actor(f.creator, true),\n              E4_META,\n            ),\n          );\n          stages.enter('SUBMIT_CHECKS');\n          console.info('E4 maximum submit', JSON.stringify({ queries, e4Queries, ...timing }));\n          expect(queries).toBeGreaterThan(0);\n          expect(queries).toBeLessThanOrEqual(950);\n          expect(e4Queries).toBeLessThanOrEqual(12);\n          expect(submitted.kindCode).toBe('submitted');\n          const review = f.app.get(SettlementReviewService);\n          const originalFirstReview = review.firstReview.bind(review);\n          const capture = jest.spyOn(review, 'firstReview').mockImplementation(async function (\n            this: SettlementReviewService,\n            ...args\n          ) {\n            const [originalInput] = args;\n            // Capture the actual helper-generated key; never call f.key a second time.\n            const input = {\n              ...originalInput,\n              expectedSettlementVersionId: submitted.settlementVersionId,\n            };\n            const db = new PrismaClient();\n            firstReviewOracle = { db, input, runId: submitted.settlementRunId, outcome: 'pending' };\n            await assertConnectedTestDatabase(db);\n            const before = await firstReviewFacts();\n            console.info('E4 first-review before request', JSON.stringify(before));\n            assertReviewCounts(before, 0);\n            expect(before.runStatus).toBe('pending_first_review');\n            const started = performance.now();\n            try {\n              // Original this/arguments/options; the original service owns its unchanged 15s tx.\n              expect(this).toBe(review);\n              const result = await originalFirstReview(...args);\n              firstReviewOracle.outcome = 'fulfilled';\n              console.info(\n                'E4 first-review response',\n                JSON.stringify({ outcome: 'fulfilled', elapsedMs: performance.now() - started }),\n              );\n              const after = await firstReviewFacts();\n              console.info('E4 first-review after response', JSON.stringify(after));\n              assertReviewCounts(after, 1);\n              expect(after.runStatus).toBe('pending_final_review');\n              expect(after.versionStatus).toBe('submitted');\n              return result;\n            } catch (error) {\n              // Do not convert a failed transaction to success; independently retain its real facts.\n              if (firstReviewOracle.outcome !== 'fulfilled') firstReviewOracle.outcome = 'rejected';\n              const code =\n                error instanceof Prisma.PrismaClientKnownRequestError ? error.code : 'other';\n              console.info(\n                'E4 first-review response',\n                JSON.stringify({\n                  outcome: firstReviewOracle.outcome,\n                  elapsedMs: performance.now() - started,\n                  code: ['P2028', 'P2010', 'P2004'].includes(code) ? code : 'other',\n                }),\n              );\n              console.info(\n                'E4 first-review after response',\n                JSON.stringify(await firstReviewFacts()),\n              );\n              throw error;\n            }\n          });\n          stages.complete('SUBMIT_CHECKS');\n          let posted: Awaited<ReturnType<typeof postE4Ledger>>;\n          try {\n            posted = await stages.run('LEDGER', () => postE4Ledger(f, submitted));\n          } finally {\n            capture.mockRestore();\n          }\n          stages.enter('LEDGER_CHECKS');\n          expect(posted.committed.replayed).toBe(false);\n          expect(\n            await f.db.participationLedgerEntry.count({\n              where: { postingBatchId: posted.batchId, entryTypeCode: 'contribution_credit' },\n            }),\n          ).toBe(2000);\n          const total = await f.db.participationLedgerEntry.aggregate({\n            where: { postingBatchId: posted.batchId, entryTypeCode: 'contribution_credit' },\n            _sum: { recognizedPointsDelta: true },\n          });\n          expect(total._sum.recognizedPointsDelta?.toFixed(2)).toBe('1000.00');\n          reset();\n          stages.complete('LEDGER_CHECKS');\n          const summary = await stages.run('SUMMARY', () =>\n            observed.$transaction((tx) =>\n              f.app\n                .get(ActivityContributionSettlementQueryService)\n                .readSummaryInTx(tx, submitted.settlementVersionId),\n            ),\n          );\n          stages.enter('SUMMARY_CHECKS');\n          console.info('E4 maximum formal summary', JSON.stringify({ queries, e4Queries }));\n          expect(queries).toBeGreaterThan(0);\n          expect(queries).toBeLessThanOrEqual(3);\n          expect(summary).toMatchObject({\n            evaluationCount: 8000,\n            recognizedPointsTotal: '1000.00',\n            hasMore: true,\n          });\n          stages.complete('SUMMARY_CHECKS');\n          const formalProof = await stages.run('FORMAL_PROOF_READ', () =>\n            f.db.activitySettlementContributionRevision.findFirstOrThrow({\n              where: { settlementVersionId: submitted.settlementVersionId },\n            }),\n          );\n          // Outside all measured business operations; compares every complete JSON, not a sample.\n          await stages.run('FINAL_ORACLE_DRAFT', () => assertFixedE4Oracle(f.db, proof.id, 8000));\n          await stages.run('FINAL_ORACLE_FORMAL', () =>\n            assertFixedE4Oracle(f.db, formalProof.id, 8000),\n          );\n          console.info(\n            'E4 maximum independent old/new oracle',\n            JSON.stringify({ evaluations: 8000, differences: 0 }),\n          );\n          // Only after every original business budget and full draft/formal oracle has passed.\n          // Reuses this exact immutable root; no extra fixture, prepare, INSERT or pre-business warming.\n          await stages.run('POST_BUSINESS_PROBE', () =>\n            assertPostBusinessPSetProbe(f.db, proof.id),\n          );\n        } finally {\n          engineRequests.restore();\n          sliceReadDiagnostic?.restoreEngine();\n          engineObserver.restore();\n          try {\n            await sliceReadDiagnostic?.finishObservation();\n          } catch {\n            capacityFinalization.fail();\n            console.info('E4_SLICE_READ', '{\"status\":\"UNKNOWN\",\"reason\":\"COLLECTION\"}');\n          } finally {\n            await stages.cleanup(() => observed.$disconnect());\n          }\n        }\n        stages.assertReliable();\n      }),\n    600_000,\n  );\n});\n",
        opening:
          "                AND context->'extra'->>'contributionRevisionId' IN (SELECT id FROM roots)) AS audits\n        `;\n        console.info(\n          'E4 maximum failure exact same-command facts',\n          JSON.stringify(sameCommandFacts),\n        );\n        if (sameCommandFacts.roots === 1) {\n          const roots = await f.db.activitySettlementContributionRevision.findMany({\n            where: {\n              activityId: source.activityId,\n              settlementRunId: source.generated.settlementRunId,\n              settlementVersionId: source.generated.settlementVersionId,\n              createdByUserId: f.creator.id,\n              operationKey: prepareCommand.operationKey,\n              requestHash: prepareRequestHash,\n            },\n            select: { id: true, sourceKindCode: true },\n            take: 2,\n          });\n          expect(roots).toHaveLength(1);\n          const actualRoot = roots[0];\n          const candidate = fixedE4RootAggregateSql(\n            actualRoot.id,\n            actualRoot.sourceKindCode,\n          ).candidate;\n          const probes = [\n            {\n              name: 'actual_complete_false',\n              sql: Prisma.sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT e4_assert_complete(${actualRoot.id},FALSE)`,\n            },\n            {\n              name: 'actual_root_aggregate',\n              sql: Prisma.sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${candidate}`,\n            },\n          ];\n          // At most two plans on this same failed root. READ ONLY and explicit rollback;\n          // never reproduce INSERT/COMMIT, create a new root or alter the business budget.\n          for (const probe of probes) {\n            let plan: unknown;\n            const rollback = new Error('E4 authorized read-only plan rollback');\n            try {\n              await f.db.$transaction(\n                async (tx) => {\n                  await tx.$executeRaw`SET TRANSACTION READ ONLY`;\n                  await tx.$executeRaw`SET LOCAL statement_timeout='30s'`;\n                  plan = await tx.$queryRaw(probe.sql);\n                  throw rollback;\n                },\n                { timeout: 35_000 },\n              );\n            } catch (diagnosticError) {\n              if (diagnosticError !== rollback) {\n                const code =\n                  diagnosticError instanceof Prisma.PrismaClientKnownRequestError\n                    ? diagnosticError.code\n                    : 'other';\n                console.info(\n                  'E4 bounded same-root plan not completed',\n                  JSON.stringify({\n                    name: probe.name,\n                    code: ['P2028', 'P2010'].includes(code) ? code : 'other',\n                  }),\n                );\n                continue;\n              }\n              const rows = Array.isArray(plan) ? plan : [];\n              const row = rows[0] as Record<string, unknown> | undefined;\n              const documents = row?.['QUERY PLAN'];\n              const document = Array.isArray(documents)\n                ? (documents[0] as Record<string, unknown> | undefined)\n                : undefined;\n              const rootPlan = document?.Plan as Record<string, unknown> | undefined;\n              // Fixed numeric fields only, not SQL text, parameter values or arbitrary plan strings.\n              const numeric = (value: unknown) =>\n                typeof value === 'number' && Number.isFinite(value) ? value : null;\n              console.info(\n                'E4 bounded same-root rollback plan',\n                JSON.stringify({\n                  name: probe.name,\n                  planningMs: numeric(document?.['Planning Time']),\n                  executionMs: numeric(document?.['Execution Time']),\n                  actualTotalMs: numeric(rootPlan?.['Actual Total Time']),\n                  rows: numeric(rootPlan?.['Actual Rows']),\n                  loops: numeric(rootPlan?.['Actual Loops']),\n                  sharedHit: numeric(rootPlan?.['Shared Hit Blocks']),\n                  sharedRead: numeric(rootPlan?.['Shared Read Blocks']),\n                  tempRead: numeric(rootPlan?.['Temp Read Blocks']),\n                  tempWritten: numeric(rootPlan?.['Temp Written Blocks']),\n                }),\n              );\n            }\n          }\n        }\n        expect(\n          await f.db.activitySettlementContributionRevision.count({\n            where: { activityId: source.activityId },\n          }),\n        ).toBe(0);\n        expect(\n          await f.db.activitySettlementTimeRevision.count({\n            where: { activityId: source.activityId },\n          }),\n        ).toBe(0);\n        throw error;\n      }\n      expect(phaseDiagnostic.snapshot().status).toBe('COMPLETE');\n      if (engineRequests.snapshot().status !== 'COMPLETE')\n        throw new Error('E4 engine request waits UNKNOWN; stop before next stage');\n      const prepareMs = Date.now() - started;\n      console.info(\n        'E4 maximum prepare',\n        JSON.stringify({\n          prepareMs,\n          queries,\n          e4Queries,\n          barrierQueries,\n          ...timing,\n          enginePhases: engineObserver.phases,\n        }),\n      );\n      stages.complete('PREPARE_RECEIPT');\n      stages.enter('PREPARE_CHECKS');\n      // E4_C1_V2_MAX_ACCEPTANCE_BEGIN\n      console.info(\n        'E4_C1_V2_PREPARE',\n        JSON.stringify(engineObserver.assertPrepare(prepareMethodWallMs)),\n      );\n      // E4_C1_V2_MAX_ACCEPTANCE_END\n      expect(queries).toBeGreaterThan(0);\n      expect(queries).toBeLessThanOrEqual(400);\n      expect(e4Queries).toBeLessThanOrEqual(12);\n      expect(barrierQueries).toBe(1);\n      expect(prepared.bucketCount).toBe(8000);\n      expect(prepared.sourceCount).toBe(40000);\n      stages.complete('PREPARE_CHECKS');\n      const proof = await stages.run('PROOF_READ', () =>\n        f.db.activitySettlementContributionRevision.findFirstOrThrow({\n          where: { settlementVersionId: prepared.settlementVersionId },\n        }),\n      );\n      stages.enter('PROOF_CHECKS');\n      expect(proof.evaluationCount).toBe(8000);\n      expect(proof.recognizedPointsTotal.toFixed(2)).toBe('1000.00');\n      // Full old expected documents and the independent abc actual-row root oracle,\n      // before any submit/review/ledger stage. These reads are outside the measured command.\n      stages.complete('PROOF_CHECKS');\n      await stages.run('ORACLE', () => assertFixedE4Oracle(f.db, proof.id, 8000));\n      reset();\n      const submitted = await stages.run('SUBMIT', () =>\n        measured.submit(\n          source.activityId,\n          {\n            expectedDraftVersion: source.expectation.expectedDraftVersion,\n            expectedEvidenceSealId: source.expectation.expectedEvidenceSealId,\n            operationKey: f.key('maximum_submit'),\n            timeRevisionId: prepared.timeRevisionId,\n            expectedBucketContentHash: prepared.bucketContentHash,\n          },\n          e4Actor(f.creator, true),\n          E4_META,\n        ),\n      );\n      stages.enter('SUBMIT_CHECKS');\n      console.info('E4 maximum submit', JSON.stringify({ queries, e4Queries, ...timing }));\n      expect(queries).toBeGreaterThan(0);\n      expect(queries).toBeLessThanOrEqual(950);\n      expect(e4Queries).toBeLessThanOrEqual(12);\n      expect(submitted.kindCode).toBe('submitted');\n      const review = f.app.get(SettlementReviewService);\n      const originalFirstReview = review.firstReview.bind(review);\n      const capture = jest.spyOn(review, 'firstReview').mockImplementation(async function (\n        this: SettlementReviewService,\n        ...args\n      ) {\n        const [originalInput] = args;\n        // Capture the actual helper-generated key; never call f.key a second time.\n        const input = {\n          ...originalInput,\n          expectedSettlementVersionId: submitted.settlementVersionId,\n        };\n        const db = new PrismaClient();\n        firstReviewOracle = { db, input, runId: submitted.settlementRunId, outcome: 'pending' };\n        await assertConnectedTestDatabase(db);\n        const before = await firstReviewFacts();\n        console.info('E4 first-review before request', JSON.stringify(before));\n        assertReviewCounts(before, 0);\n        expect(before.runStatus).toBe('pending_first_review');\n        const started = performance.now();\n        try {\n          // Original this/arguments/options; the original service owns its unchanged 15s tx.\n          expect(this).toBe(review);\n          const result = await originalFirstReview(...args);\n          firstReviewOracle.outcome = 'fulfilled';\n          console.info(\n            'E4 first-review response',\n            JSON.stringify({ outcome: 'fulfilled', elapsedMs: performance.now() - started }),\n          );\n          const after = await firstReviewFacts();\n          console.info('E4 first-review after response', JSON.stringify(after));\n          assertReviewCounts(after, 1);\n          expect(after.runStatus).toBe('pending_final_review');\n          expect(after.versionStatus).toBe('submitted');\n          return result;\n        } catch (error) {\n          // Do not convert a failed transaction to success; independently retain its real facts.\n          if (firstReviewOracle.outcome !== 'fulfilled') firstReviewOracle.outcome = 'rejected';\n          const code = error instanceof Prisma.PrismaClientKnownRequestError ? error.code : 'other';\n          console.info(\n            'E4 first-review response',\n            JSON.stringify({\n              outcome: firstReviewOracle.outcome,\n              elapsedMs: performance.now() - started,\n              code: ['P2028', 'P2010', 'P2004'].includes(code) ? code : 'other',\n            }),\n          );\n          console.info('E4 first-review after response', JSON.stringify(await firstReviewFacts()));\n          throw error;\n        }\n      });\n      stages.complete('SUBMIT_CHECKS');\n      let posted: Awaited<ReturnType<typeof postE4Ledger>>;\n      try {\n        posted = await stages.run('LEDGER', () => postE4Ledger(f, submitted));\n      } finally {\n        capture.mockRestore();\n      }\n      stages.enter('LEDGER_CHECKS');\n      expect(posted.committed.replayed).toBe(false);\n      expect(\n        await f.db.participationLedgerEntry.count({\n          where: { postingBatchId: posted.batchId, entryTypeCode: 'contribution_credit' },\n        }),\n      ).toBe(2000);\n      const total = await f.db.participationLedgerEntry.aggregate({\n        where: { postingBatchId: posted.batchId, entryTypeCode: 'contribution_credit' },\n        _sum: { recognizedPointsDelta: true },\n      });\n      expect(total._sum.recognizedPointsDelta?.toFixed(2)).toBe('1000.00');\n      reset();\n      stages.complete('LEDGER_CHECKS');\n      const summary = await stages.run('SUMMARY', () =>\n        observed.$transaction((tx) =>\n          f.app\n            .get(ActivityContributionSettlementQueryService)\n            .readSummaryInTx(tx, submitted.settlementVersionId),\n        ),\n      );\n      stages.enter('SUMMARY_CHECKS');\n      console.info('E4 maximum formal summary', JSON.stringify({ queries, e4Queries }));\n      expect(queries).toBeGreaterThan(0);\n      expect(queries).toBeLessThanOrEqual(3);\n      expect(summary).toMatchObject({\n        evaluationCount: 8000,\n        recognizedPointsTotal: '1000.00',\n        hasMore: true,\n      });\n      stages.complete('SUMMARY_CHECKS');\n      const formalProof = await stages.run('FORMAL_PROOF_READ', () =>\n        f.db.activitySettlementContributionRevision.findFirstOrThrow({\n          where: { settlementVersionId: submitted.settlementVersionId },\n        }),\n      );\n      // Outside all measured business operations; compares every complete JSON, not a sample.\n      await stages.run('FINAL_ORACLE_DRAFT', () => assertFixedE4Oracle(f.db, proof.id, 8000));\n      await stages.run('FINAL_ORACLE_FORMAL', () =>\n        assertFixedE4Oracle(f.db, formalProof.id, 8000),\n      );\n      console.info(\n        'E4 maximum independent old/new oracle',\n        JSON.stringify({ evaluations: 8000, differences: 0 }),\n      );\n      // Only after every original business budget and full draft/formal oracle has passed.\n      // Reuses this exact immutable root; no extra fixture, prepare, INSERT or pre-business warming.\n      await stages.run('POST_BUSINESS_PROBE', () => assertPostBusinessPSetProbe(f.db, proof.id));\n    } finally {\n      engineRequests.restore();\n      sliceReadDiagnostic?.restoreEngine();\n      engineObserver.restore();\n      try {\n        await sliceReadDiagnostic?.finishObservation();\n      } catch {\n        console.info('E4_SLICE_READ', '{\"status\":\"UNKNOWN\",\"reason\":\"COLLECTION\"}');\n      } finally {\n        await stages.cleanup(() => observed.$disconnect());\n      }\n    }\n    stages.assertReliable();\n  }, 600_000);\n});\n",
        sha256: '32181e003149970679a179581249c7097781080514b930dc27f064b9592c7f5d',
      },
    ],
  },
  migration: {
    candidateSha: 'c8c4e2d402da46208c21775759dc413598bbc9aa92f1acf3928466997eeba6ba',
    openingSha: '30a764e2b72776dd2185b97ad7e95628740acc340d3d0356fd9aa3eb2daa9fef',
    bindings: [
      {
        candidate:
          "import { buildParticipationTimeLedger } from '../../src/modules/activities/participation-time-ledger-policy';\nimport { hashCanonical } from '../../src/modules/activities/activity-publish-review-idempotency';\nimport { restoreE4LiveCatalog140Opening } from '../helpers/e4-maximum-stage-receipt';\n\n// E4_TERMINAL_HELPERS_BEGIN\n",
        opening:
          "import { buildParticipationTimeLedger } from '../../src/modules/activities/participation-time-ledger-policy';\nimport { hashCanonical } from '../../src/modules/activities/activity-publish-review-idempotency';\n\n// E4_TERMINAL_HELPERS_BEGIN\n",
        sha256: '82294e11c6fc30511f753a659419a7ba31cf37f5804d273561244708515b2b60',
      },
      {
        candidate:
          "];\nfunction restoreTerminalMigrationOpening(source: string) {\n  source = restoreE4LiveCatalog140Opening(source, 'migration');\n  return restoreTerminalSource(\n    source,\n",
        opening:
          '];\nfunction restoreTerminalMigrationOpening(source: string) {\n  return restoreTerminalSource(\n    source,\n',
        sha256: 'a3fc3a1f81ef5c2d01bf4ea7bfde0cdbc53359550fb5b116a48c7993e6568f91',
      },
      {
        candidate:
          "      'utf8',\n    );\n    const scale = restoreE4LiveCatalog140Opening(\n      readFileSync(\n        resolve(__dirname, 'activity-os-r5-e4-contribution-settlement-scale.e2e-spec.ts'),\n        'utf8',\n      ),\n    );\n    const local = readFileSync(__filename, 'utf8');\n",
        opening:
          "      'utf8',\n    );\n    const scale = readFileSync(\n      resolve(__dirname, 'activity-os-r5-e4-contribution-settlement-scale.e2e-spec.ts'),\n      'utf8',\n    );\n    const local = readFileSync(__filename, 'utf8');\n",
        sha256: 'c9c952e1462302c73c6e27a498729338f84dd564e230eccf4c32c2c876bd44ab',
      },
    ],
  },
};

export function restoreE4LiveCatalog140Opening(
  source: string,
  kind: 'scale' | 'migration' = 'scale',
): string {
  const hash = (text: string) => createHash('sha256').update(text).digest('hex');
  const digest = hash(source);
  const prior =
    kind === 'scale'
      ? [C1_V2_SCALE_SHA, C1_V1_SCALE_SHA, OPENING_SHA]
      : [
          HISTORICAL_CI_FIXTURE_CANDIDATE_SHA,
          HISTORICAL_CATALOG_CANDIDATE_SHA,
          HISTORICAL_CATALOG_OPENING_SHA,
          '7682abceaaf185b1b54beaffdd1ecddc1fe30745193059cce3da5aeb3518282a',
        ];
  if (prior.includes(digest)) return source;
  const profile = LIVE140_PROFILES[kind];
  if (digest !== profile.candidateSha) throw new Error('E4 live140 catalog source refused');
  for (const binding of profile.bindings) {
    if (source.split(binding.candidate).length !== 2 || hash(binding.candidate) !== binding.sha256)
      throw new Error('E4 live140 catalog binding refused');
    source = source.replace(binding.candidate, () => binding.opening);
  }
  if (hash(source) !== profile.openingSha) throw new Error('E4 live140 catalog inverse refused');
  return source;
}
// E4_LIVE140_CATALOG_INVERSE_END

// E4_C1_V2_INVERSE_BEGIN
// Only these approved v2 blocks normalize to the complete, unchanged v1 source.
const C1_V2_SCALE_SHA = '175a4997a170887daa6095eda23106334534a1756521f7ce0b3d65bca1e79fa4';
const C1_V1_SCALE_SHA = '5408651f58567fe8b9468f93326686ede1b6ac4da1d15028784fd0c3e3e51d87';
const C1_V2_BINDINGS: { candidate: string; opening: string; sha256: string }[] = [
  {
    candidate:
      "// E4_C1_V2_IMPORT_BEGIN\nimport {\n  E4SliceReadDiagnostic,\n  e4SliceReadOptions,\n  preflightE4SliceReadDiagnostic,\n} from '../helpers/e4-slice-read-diagnostic';\nimport {\n  createE4MaximumStageReceipt,\n  assertE4PrepareAcceptanceV2,\n  restoreE4MaximumStageOpening,\n  restoreE4HistoricalCatalogOpening,\n} from '../helpers/e4-maximum-stage-receipt';\n// E4_C1_V2_IMPORT_END\n",
    opening:
      "import {\n  E4SliceReadDiagnostic,\n  e4SliceReadOptions,\n  preflightE4SliceReadDiagnostic,\n} from '../helpers/e4-slice-read-diagnostic';\nimport {\n  createE4MaximumStageReceipt,\n  restoreE4MaximumStageOpening,\n  restoreE4HistoricalCatalogOpening,\n} from '../helpers/e4-maximum-stage-receipt';\n",
    sha256: '5e9bf5a9717cea931dd5e49135d94212fc25709f7f15186b9f7969ce47a2feea',
  },
  {
    candidate:
      "// E4_C1_V2_ENGINE_BEGIN\nfunction observeEngineTransactions(db: PrismaClient) {\n  const engine: unknown = Reflect.get(db, '_engine');\n  if (engine === null || typeof engine !== 'object')\n    throw new Error('Actual Prisma engine missing');\n  const original: unknown = Reflect.get(engine, 'transaction');\n  if (typeof original !== 'function') throw new Error('Actual engine transaction bridge missing');\n  const descriptor = Object.getOwnPropertyDescriptor(engine, 'transaction');\n  const phases: { phase: string; elapsedMs: number; outcome: string }[] = [];\n  const starts: {\n    timeoutMs: number | null;\n    maxWaitMs: number | null;\n    isolationLevel: string | null;\n  }[] = [];\n  let pending = 0;\n  let unknown = false;\n  Object.defineProperty(engine, 'transaction', {\n    configurable: true,\n    writable: true,\n    value: function (this: object, ...args: unknown[]) {\n      const started = performance.now();\n      const phase = ['start', 'commit', 'rollback'].includes(String(args[0]))\n        ? String(args[0])\n        : 'other';\n      if (phase === 'start') {\n        const options = args[2];\n        const fields = options !== null && typeof options === 'object' ? options : {};\n        const timeout = Reflect.get(fields, 'timeout');\n        const maxWait = Reflect.get(fields, 'maxWait');\n        const isolation = Reflect.get(fields, 'isolationLevel');\n        if (starts.length < 32)\n          starts.push({\n            timeoutMs: typeof timeout === 'number' ? timeout : null,\n            maxWaitMs: typeof maxWait === 'number' ? maxWait : null,\n            isolationLevel: isolation === 'ReadCommitted' ? isolation : null,\n          });\n        else unknown = true;\n      }\n      pending++;\n      const settle = (outcome: string) => {\n        pending--;\n        if (phases.length < 32)\n          phases.push({ phase, elapsedMs: performance.now() - started, outcome });\n        else unknown = true;\n      };\n      try {\n        const result = Reflect.apply(original, this, args) as Promise<unknown>;\n        void result.then(\n          () => settle('ok'),\n          () => settle('error'),\n        );\n        return result;\n      } catch (error) {\n        settle('error');\n        throw error;\n      }\n    },\n  });\n  return {\n    phases,\n    reset: () => {\n      if (pending || unknown) throw new Error('E4 C1-v2 transaction observation UNKNOWN');\n      phases.length = 0;\n      starts.length = 0;\n    },\n    assertPrepare: (methodWallMs: number) =>\n      assertE4PrepareAcceptanceV2({ phases, starts, pending, unknown }, methodWallMs),\n    restore: () => {\n      if (descriptor) Object.defineProperty(engine, 'transaction', descriptor);\n      else Reflect.deleteProperty(engine, 'transaction');\n      expect(Reflect.get(engine, 'transaction')).toBe(original);\n    },\n  };\n}\n// E4_C1_V2_ENGINE_END\n",
    opening:
      "function observeEngineTransactions(db: PrismaClient) {\n  const engine: unknown = Reflect.get(db, '_engine');\n  if (engine === null || typeof engine !== 'object')\n    throw new Error('Actual Prisma engine missing');\n  const original: unknown = Reflect.get(engine, 'transaction');\n  if (typeof original !== 'function') throw new Error('Actual engine transaction bridge missing');\n  const descriptor = Object.getOwnPropertyDescriptor(engine, 'transaction');\n  const phases: { phase: string; elapsedMs: number; outcome: string }[] = [];\n  Object.defineProperty(engine, 'transaction', {\n    configurable: true,\n    writable: true,\n    value: function (this: object, ...args: unknown[]) {\n      const started = performance.now();\n      const result = Reflect.apply(original, this, args) as Promise<unknown>;\n      const phase = ['start', 'commit', 'rollback'].includes(String(args[0]))\n        ? String(args[0])\n        : 'other';\n      void result.then(\n        () => {\n          phases.push({ phase, elapsedMs: performance.now() - started, outcome: 'ok' });\n        },\n        () => {\n          phases.push({ phase, elapsedMs: performance.now() - started, outcome: 'error' });\n        },\n      );\n      return result;\n    },\n  });\n  return {\n    phases,\n    restore: () => {\n      if (descriptor) Object.defineProperty(engine, 'transaction', descriptor);\n      else Reflect.deleteProperty(engine, 'transaction');\n      expect(Reflect.get(engine, 'transaction')).toBe(original);\n    },\n  };\n}\n",
    sha256: '7e26028ef87df648610482376896b388e7a70bef130c3399242131a29ff30086',
  },
  {
    candidate:
      "  // E4_C1_V2_S13_BEGIN\n  (process.env.SRVF_E4_W98 === '1' ? it : it.skip)(\n    'E4 S13 thin-key exact full-doc probe',\n    async () => {\n      s13Probe.active = true;\n      const originalClose: unknown = Reflect.get(f.app, 'close');\n      if (typeof originalClose !== 'function') throw new Error('S13 original app close missing');\n      const descriptor = Object.getOwnPropertyDescriptor(f.app, 'close');\n      Object.defineProperty(f.app, 'close', {\n        configurable: true,\n        writable: true,\n        value: function (this: object, ...args: unknown[]) {\n          const promise = Reflect.apply(originalClose, this, args) as Promise<void>;\n          void promise.then(\n            () => {\n              s13Probe.appClosed = true;\n            },\n            () => {\n              s13Probe.failed = true;\n            },\n          );\n          return promise;\n        },\n      });\n      s13Probe.restoreApp = () => {\n        if (descriptor) Object.defineProperty(f.app, 'close', descriptor);\n        else Reflect.deleteProperty(f.app, 'close');\n        expect(Reflect.get(f.app, 'close')).toBe(originalClose);\n      };\n      // E4_TERMINAL_REPLACE_S13_PRINCIPAL_BEGIN\n      terminalS13Principal = await terminalBusinessPrincipal(f.db);\n      let observedForClose: ObservedE4Database | undefined;\n      // E4_TERMINAL_REPLACE_S13_PRINCIPAL_END\n      let restoreEngine: (() => void) | undefined;\n      try {\n        const source = await createMaximumE4Source(f);\n        expect(\n          await f.db.activityParticipationIdentity.count({\n            where: { activityId: source.activityId },\n          }),\n        ).toBe(2000);\n        expect(\n          await f.db.participantTimeAllocationRevision.count({\n            where: { activityId: source.activityId },\n          }),\n        ).toBe(10000);\n        expect(\n          await f.db.participantTimeAllocationSlice.count({\n            where: { activityId: source.activityId },\n          }),\n        ).toBe(50000);\n        const observed = new ObservedE4Database({ log: [{ emit: 'event', level: 'query' }] });\n        const engineObserver = observeEngineTransactions(observed);\n        let queries = 0;\n        let e4Queries = 0;\n        let barrierQueries = 0;\n        const timing = { readMs: 0, writeMs: 0, largestMs: 0 };\n        let s13PhaseDiagnostic: E4PreparePhaseDiagnostic | undefined;\n        observed.$on('query', (event) => {\n          if (!/^\\s*(BEGIN|COMMIT|ROLLBACK|SET TRANSACTION)\\b/iu.test(event.query)) {\n            queries++;\n            s13PhaseDiagnostic?.query(\n              /^\\s*(SELECT|WITH)\\b/iu.test(event.query) ? 'READ' : 'WRITE',\n              event.duration,\n            );\n          }\n          if (\n            /(?:ActivitySettlementContributionRevision|ParticipantContributionEvaluation|e4_assert_|e4_revision_complete_guard)/u.test(\n              event.query,\n            )\n          )\n            e4Queries++;\n          if (/^\\s*SET CONSTRAINTS public\\.astr_parent_complete_guard,/u.test(event.query))\n            barrierQueries++;\n          if (/^\\s*(SELECT|WITH)\\b/iu.test(event.query)) timing.readMs += event.duration;\n          else timing.writeMs += event.duration;\n          timing.largestMs = Math.max(timing.largestMs, event.duration);\n        });\n        const reset = () => {\n          queries = 0;\n          e4Queries = 0;\n          barrierQueries = 0;\n          timing.readMs = 0;\n          timing.writeMs = 0;\n          timing.largestMs = 0;\n          engineObserver.reset();\n        };\n        const contributions = f.app.get(ActivityContributionSettlementService);\n        const access = f.app.get(ActivityTimeSettlementAccessService);\n        const segments = f.app.get(ParticipationSegmentFacade);\n        const reader = new ActivityTimeSettlementQueryService(\n          observed,\n          access,\n          segments,\n          f.app.get(ActivityContributionSettlementQueryService),\n        );\n        const measured = new ActivityTimeSettlementService(\n          observed,\n          access,\n          reader,\n          segments,\n          f.app.get(ActivityTimeAllocationService),\n          f.app.get(SettlementSubmitService),\n          f.app.get(ActivityTimeSettlementAuditRecorder),\n          f.app.get(ActivityWorkflowGate),\n          contributions,\n        );\n\n        observedForClose = observed;\n        restoreEngine = engineObserver.restore;\n        await assertConnectedTestDatabase(observed);\n        reset();\n        const phaseDiagnostic = new E4PreparePhaseDiagnostic([\n          { phase: 'C3_PROOF', target: measured, method: 'lockedProof' },\n          { phase: 'C3_SOURCE', target: measured, method: 'lockedSources' },\n          { phase: 'C3_EVAL', target: reader, method: 'evaluateInTx' },\n          { phase: 'C3_BUCKET_WRITE', target: measured, method: 'insertBuckets' },\n          { phase: 'E4_PREPARE', target: contributions, method: 'prepareTimeInTx' },\n          {\n            phase: 'E4_EVAL',\n            target: f.app.get(ActivityContributionSettlementQueryService),\n            method: 'readTimeEvaluationInTx',\n          },\n          { phase: 'E4_EVAL_WRITE', target: contributions, method: 'insertEvaluations' },\n          { phase: 'C3_RECEIPT', target: measured, method: 'receipt' },\n        ]);\n        s13PhaseDiagnostic = phaseDiagnostic;\n        let prepared: Awaited<ReturnType<ActivityTimeSettlementService['prepare']>>;\n        let prepareMs = 0;\n        phaseDiagnostic.begin();\n        const started = performance.now();\n        try {\n          prepared = await measured.prepare(\n            source.activityId,\n            {\n              expectedDraftVersion: source.expectation.expectedDraftVersion,\n              expectedEvidenceSealId: source.expectation.expectedEvidenceSealId,\n              operationKey: f.key('s13_prepare'),\n              expectedTimeRevision: 0,\n            },\n            e4Actor(f.creator, true),\n            E4_META,\n          );\n          prepareMs = performance.now() - started;\n          phaseDiagnostic.finish('OK');\n        } catch (error) {\n          prepareMs = performance.now() - started;\n          phaseDiagnostic.finish('FAIL');\n          throw error;\n        } finally {\n          phaseDiagnostic.restore();\n          s13PhaseDiagnostic = undefined;\n          phaseDiagnostic.emitTo((safeJson) => console.info('E4_C1_V2_S13_PHASES', safeJson));\n          console.info('E4_C1_V2_S13_METHOD', JSON.stringify({ methodWallMs: prepareMs }));\n        }\n        console.info(\n          'E4_S13_FRESH_PREPARE',\n          JSON.stringify({\n            prepareMs,\n            queries,\n            e4Queries,\n            barrierQueries,\n            ...timing,\n            enginePhases: engineObserver.phases,\n          }),\n        );\n        expect(phaseDiagnostic.snapshot().status).toBe('COMPLETE');\n        console.info('E4_C1_V2_PREPARE', JSON.stringify(engineObserver.assertPrepare(prepareMs)));\n        expect(queries).toBeGreaterThan(0);\n        expect(queries).toBeLessThanOrEqual(400);\n        expect(e4Queries).toBeLessThanOrEqual(12);\n        expect(barrierQueries).toBe(1);\n        expect(prepared.bucketCount).toBe(8000);\n        expect(prepared.sourceCount).toBe(40000);\n        const proof = await f.db.activitySettlementContributionRevision.findFirstOrThrow({\n          where: { settlementVersionId: prepared.settlementVersionId },\n        });\n        expect(proof.evaluationCount).toBe(8000);\n        expect(proof.recognizedPointsTotal.toFixed(2)).toBe('1000.00');\n        await assertFixedE4Oracle(f.db, proof.id, 8000);\n        reset();\n        const submitted = await measured.submit(\n          source.activityId,\n          {\n            expectedDraftVersion: source.expectation.expectedDraftVersion,\n            expectedEvidenceSealId: source.expectation.expectedEvidenceSealId,\n            operationKey: f.key('s13_submit'),\n            timeRevisionId: prepared.timeRevisionId,\n            expectedBucketContentHash: prepared.bucketContentHash,\n          },\n          e4Actor(f.creator, true),\n          E4_META,\n        );\n        console.info(\n          'E4_S13_FRESH_SUBMIT',\n          JSON.stringify({\n            queries,\n            e4Queries,\n            ...timing,\n            enginePhases: engineObserver.phases,\n          }),\n        );\n        expect(queries).toBeGreaterThan(0);\n        expect(queries).toBeLessThanOrEqual(950);\n        expect(e4Queries).toBeLessThanOrEqual(12);\n        expect(submitted.kindCode).toBe('submitted');\n        const submittedProofs = await f.db.activitySettlementContributionRevision.findMany({\n          where: {\n            activityId: source.activityId,\n            settlementRunId: submitted.settlementRunId,\n            settlementVersionId: submitted.settlementVersionId,\n            timeRevisionId: submitted.timeRevisionId,\n            kindCode: 'submitted',\n            sourceKindCode: 'time_revision',\n            sourceDraftContributionRevisionId: proof.id,\n          },\n          take: 2,\n        });\n        expect(submittedProofs).toHaveLength(1);\n        const submittedProof = submittedProofs[0];\n        expect(submittedProof.evaluationCount).toBe(8000);\n        expect(submittedProof.recognizedPointsTotal.toFixed(2)).toBe('1000.00');\n        await assertFixedE4Oracle(f.db, submittedProof.id, 8000);\n        s13Probe.rootId = submittedProof.id;\n        s13Probe.businessPassed = true;\n      } catch (error) {\n        s13Probe.failed = true;\n        throw error;\n      } finally {\n        restoreEngine?.();\n        if (observedForClose) {\n          try {\n            await observedForClose.$disconnect();\n            s13Probe.measuredClosed = true;\n          } catch {\n            s13Probe.failed = true;\n            s13Probe.expired = true;\n          }\n        }\n      }\n    },\n    600_000,\n  );\n  // E4_C1_V2_S13_END\n",
    opening:
      "  (process.env.SRVF_E4_W98 === '1' ? it : it.skip)(\n    'E4 S13 thin-key exact full-doc probe',\n    async () => {\n      s13Probe.active = true;\n      const originalClose: unknown = Reflect.get(f.app, 'close');\n      if (typeof originalClose !== 'function') throw new Error('S13 original app close missing');\n      const descriptor = Object.getOwnPropertyDescriptor(f.app, 'close');\n      Object.defineProperty(f.app, 'close', {\n        configurable: true,\n        writable: true,\n        value: function (this: object, ...args: unknown[]) {\n          const promise = Reflect.apply(originalClose, this, args) as Promise<void>;\n          void promise.then(\n            () => {\n              s13Probe.appClosed = true;\n            },\n            () => {\n              s13Probe.failed = true;\n            },\n          );\n          return promise;\n        },\n      });\n      s13Probe.restoreApp = () => {\n        if (descriptor) Object.defineProperty(f.app, 'close', descriptor);\n        else Reflect.deleteProperty(f.app, 'close');\n        expect(Reflect.get(f.app, 'close')).toBe(originalClose);\n      };\n      // E4_TERMINAL_REPLACE_S13_PRINCIPAL_BEGIN\n      terminalS13Principal = await terminalBusinessPrincipal(f.db);\n      let observedForClose: ObservedE4Database | undefined;\n      // E4_TERMINAL_REPLACE_S13_PRINCIPAL_END\n      let restoreEngine: (() => void) | undefined;\n      try {\n        const source = await createMaximumE4Source(f);\n        expect(\n          await f.db.activityParticipationIdentity.count({\n            where: { activityId: source.activityId },\n          }),\n        ).toBe(2000);\n        expect(\n          await f.db.participantTimeAllocationRevision.count({\n            where: { activityId: source.activityId },\n          }),\n        ).toBe(10000);\n        expect(\n          await f.db.participantTimeAllocationSlice.count({\n            where: { activityId: source.activityId },\n          }),\n        ).toBe(50000);\n        const observed = new ObservedE4Database({ log: [{ emit: 'event', level: 'query' }] });\n        const engineObserver = observeEngineTransactions(observed);\n        let queries = 0;\n        let e4Queries = 0;\n        let barrierQueries = 0;\n        const timing = { readMs: 0, writeMs: 0, largestMs: 0 };\n        observed.$on('query', (event) => {\n          if (!/^\\s*(BEGIN|COMMIT|ROLLBACK|SET TRANSACTION)\\b/iu.test(event.query)) queries++;\n          if (\n            /(?:ActivitySettlementContributionRevision|ParticipantContributionEvaluation|e4_assert_|e4_revision_complete_guard)/u.test(\n              event.query,\n            )\n          )\n            e4Queries++;\n          if (/^\\s*SET CONSTRAINTS public\\.astr_parent_complete_guard,/u.test(event.query))\n            barrierQueries++;\n          if (/^\\s*(SELECT|WITH)\\b/iu.test(event.query)) timing.readMs += event.duration;\n          else timing.writeMs += event.duration;\n          timing.largestMs = Math.max(timing.largestMs, event.duration);\n        });\n        const reset = () => {\n          queries = 0;\n          e4Queries = 0;\n          barrierQueries = 0;\n          timing.readMs = 0;\n          timing.writeMs = 0;\n          timing.largestMs = 0;\n          engineObserver.phases.length = 0;\n        };\n        const contributions = f.app.get(ActivityContributionSettlementService);\n        const access = f.app.get(ActivityTimeSettlementAccessService);\n        const segments = f.app.get(ParticipationSegmentFacade);\n        const reader = new ActivityTimeSettlementQueryService(\n          observed,\n          access,\n          segments,\n          f.app.get(ActivityContributionSettlementQueryService),\n        );\n        const measured = new ActivityTimeSettlementService(\n          observed,\n          access,\n          reader,\n          segments,\n          f.app.get(ActivityTimeAllocationService),\n          f.app.get(SettlementSubmitService),\n          f.app.get(ActivityTimeSettlementAuditRecorder),\n          f.app.get(ActivityWorkflowGate),\n          contributions,\n        );\n\n        observedForClose = observed;\n        restoreEngine = engineObserver.restore;\n        await assertConnectedTestDatabase(observed);\n        reset();\n        const started = performance.now();\n        const prepared = await measured.prepare(\n          source.activityId,\n          {\n            expectedDraftVersion: source.expectation.expectedDraftVersion,\n            expectedEvidenceSealId: source.expectation.expectedEvidenceSealId,\n            operationKey: f.key('s13_prepare'),\n            expectedTimeRevision: 0,\n          },\n          e4Actor(f.creator, true),\n          E4_META,\n        );\n        const prepareMs = performance.now() - started;\n        console.info(\n          'E4_S13_FRESH_PREPARE',\n          JSON.stringify({\n            prepareMs,\n            queries,\n            e4Queries,\n            barrierQueries,\n            ...timing,\n            enginePhases: engineObserver.phases,\n          }),\n        );\n        expect(prepareMs).toBeLessThan(30_000);\n        expect(queries).toBeGreaterThan(0);\n        expect(queries).toBeLessThanOrEqual(400);\n        expect(e4Queries).toBeLessThanOrEqual(12);\n        expect(barrierQueries).toBe(1);\n        expect(prepared.bucketCount).toBe(8000);\n        expect(prepared.sourceCount).toBe(40000);\n        const proof = await f.db.activitySettlementContributionRevision.findFirstOrThrow({\n          where: { settlementVersionId: prepared.settlementVersionId },\n        });\n        expect(proof.evaluationCount).toBe(8000);\n        expect(proof.recognizedPointsTotal.toFixed(2)).toBe('1000.00');\n        await assertFixedE4Oracle(f.db, proof.id, 8000);\n        reset();\n        const submitted = await measured.submit(\n          source.activityId,\n          {\n            expectedDraftVersion: source.expectation.expectedDraftVersion,\n            expectedEvidenceSealId: source.expectation.expectedEvidenceSealId,\n            operationKey: f.key('s13_submit'),\n            timeRevisionId: prepared.timeRevisionId,\n            expectedBucketContentHash: prepared.bucketContentHash,\n          },\n          e4Actor(f.creator, true),\n          E4_META,\n        );\n        console.info(\n          'E4_S13_FRESH_SUBMIT',\n          JSON.stringify({\n            queries,\n            e4Queries,\n            ...timing,\n            enginePhases: engineObserver.phases,\n          }),\n        );\n        expect(queries).toBeGreaterThan(0);\n        expect(queries).toBeLessThanOrEqual(950);\n        expect(e4Queries).toBeLessThanOrEqual(12);\n        expect(submitted.kindCode).toBe('submitted');\n        const submittedProofs = await f.db.activitySettlementContributionRevision.findMany({\n          where: {\n            activityId: source.activityId,\n            settlementRunId: submitted.settlementRunId,\n            settlementVersionId: submitted.settlementVersionId,\n            timeRevisionId: submitted.timeRevisionId,\n            kindCode: 'submitted',\n            sourceKindCode: 'time_revision',\n            sourceDraftContributionRevisionId: proof.id,\n          },\n          take: 2,\n        });\n        expect(submittedProofs).toHaveLength(1);\n        const submittedProof = submittedProofs[0];\n        expect(submittedProof.evaluationCount).toBe(8000);\n        expect(submittedProof.recognizedPointsTotal.toFixed(2)).toBe('1000.00');\n        await assertFixedE4Oracle(f.db, submittedProof.id, 8000);\n        s13Probe.rootId = submittedProof.id;\n        s13Probe.businessPassed = true;\n      } catch (error) {\n        s13Probe.failed = true;\n        throw error;\n      } finally {\n        restoreEngine?.();\n        if (observedForClose) {\n          try {\n            await observedForClose.$disconnect();\n            s13Probe.measuredClosed = true;\n          } catch {\n            s13Probe.failed = true;\n            s13Probe.expired = true;\n          }\n        }\n      }\n    },\n    600_000,\n  );",
    sha256: '11b65cc9ef863ce5299862f2102b8562f31fdc6d0f7f70eb9fadd7e6ca93bb93',
  },
  {
    candidate:
      '      // E4_C1_V2_MAX_RESET_BEGIN\n      engineObserver.reset();\n      // E4_C1_V2_MAX_RESET_END\n',
    opening: '      engineObserver.phases.length = 0;\n',
    sha256: '1ed25eec801759505dbe415af9ee3fa4311e83c2e96a5596beaa75604d6a7c01',
  },
  {
    candidate:
      '      // E4_C1_V2_MAX_METHOD_STATE_BEGIN\n      let prepareBusinessFailure: { error: unknown } | undefined;\n      let prepareMethodWallMs = 0;\n      // E4_C1_V2_MAX_METHOD_STATE_END\n',
    opening: '      let prepareBusinessFailure: { error: unknown } | undefined;\n',
    sha256: '51f07b2343753de8b11b77b1c6275d673186c225f012aaa9bf67cea8e82e4e7f',
  },
  {
    candidate:
      "          // E4_C1_V2_MAX_METHOD_CALL_BEGIN\n          prepared = await stages.run('PREPARE', async () => {\n            const methodStarted = Date.now();\n            try {\n              const result = await measured.prepare(\n                source.activityId,\n                prepareCommand,\n                e4Actor(f.creator, true),\n                E4_META,\n              );\n              prepareOutcome = 'OK';\n              return result;\n            } catch (error) {\n              prepareBusinessFailure = { error };\n              throw error;\n            } finally {\n              prepareMethodWallMs = Date.now() - methodStarted;\n            }\n          });\n          // E4_C1_V2_MAX_METHOD_CALL_END\n",
    opening:
      "          prepared = await stages.run('PREPARE', async () => {\n            try {\n              const result = await measured.prepare(\n                source.activityId,\n                prepareCommand,\n                e4Actor(f.creator, true),\n                E4_META,\n              );\n              prepareOutcome = 'OK';\n              return result;\n            } catch (error) {\n              prepareBusinessFailure = { error };\n              throw error;\n            }\n          });",
    sha256: '26d877baa5f744119bad7eafd56903b0962d34ff0a7102a41a744b7e6a3b7cb6',
  },
  {
    candidate:
      "      // E4_C1_V2_MAX_ACCEPTANCE_BEGIN\n      console.info(\n        'E4_C1_V2_PREPARE',\n        JSON.stringify(engineObserver.assertPrepare(prepareMethodWallMs)),\n      );\n      // E4_C1_V2_MAX_ACCEPTANCE_END\n",
    opening: '      expect(prepareMs).toBeLessThan(30_000);\n',
    sha256: '7607cbbfc066eb2b59c6d6db8d4d21c7314dfb9b5c69ca861254464010658f4e',
  },
];
export function restoreE4PrepareAcceptanceV2Opening(source: string): string {
  source = restoreE4LiveCatalog140Opening(source);
  const hash = (text: string) => createHash('sha256').update(text).digest('hex');
  const digest = hash(source);
  if (digest === C1_V1_SCALE_SHA || digest === OPENING_SHA) return source;
  if (digest !== C1_V2_SCALE_SHA) throw new Error('E4 C1-v2 source refused');
  for (const binding of C1_V2_BINDINGS) {
    if (source.split(binding.candidate).length !== 2 || hash(binding.candidate) !== binding.sha256)
      throw new Error('E4 C1-v2 source refused');
    source = source.replace(binding.candidate, () => binding.opening);
  }
  if (hash(source) !== C1_V1_SCALE_SHA) throw new Error('E4 C1-v2 source refused');
  return source;
}
// E4_C1_V2_INVERSE_END
