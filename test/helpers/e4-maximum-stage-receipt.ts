import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

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
const CANDIDATE_SHA = '576eb7cd5edd0d30160c83161fbeb99d3dfeee6f614e78915b96ea8f03697442';
const STAGE_BINDINGS: { candidate: string; opening: string; sha256: string }[] = [
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
export function restoreE4HistoricalCatalogOpening(source: string): string {
  const hash = (text: string) => createHash('sha256').update(text).digest('hex');
  if (hash(source) === HISTORICAL_CATALOG_OPENING_SHA) return source;
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
