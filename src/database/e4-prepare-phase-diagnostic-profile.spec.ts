import { Prisma } from '@prisma/client';
import { ActivityContributionSettlementService } from '../modules/activities/activity-contribution-settlement.service';
import { ActivityTimeSettlementQueryService } from '../modules/activities/activity-time-settlement-query.service';
import { ActivityTimeSettlementService } from '../modules/activities/activity-time-settlement.service';
import { ParticipationSegmentFacade } from '../modules/attendances/participation-segment.facade';
import * as PrepareDiagnostic from '../../test/helpers/e4-prepare-phase-diagnostic';
import {
  E4_PREPARE_PHASES,
  E4PreparePhaseDiagnostic,
  type E4PreparePhase,
  type E4PrepareProfile,
} from '../../test/helpers/e4-prepare-phase-diagnostic';

const C3_PHASES: readonly E4PreparePhase[] = [
  'C3_PROOF',
  'C3_SOURCE',
  'C3_EVAL',
  'C3_BUCKET_WRITE',
  'C3_RECEIPT',
];
type Target = { work: (this: object, ...args: unknown[]) => unknown };

function fixture() {
  let tick = 0;
  let cpu = 0;
  const targets = Object.fromEntries(
    E4_PREPARE_PHASES.map((phase) => [phase, { work: () => Promise.resolve(undefined) }]),
  ) as Record<E4PreparePhase, Target>;
  return {
    targets,
    create(phases: readonly E4PreparePhase[], profile: E4PrepareProfile = 'E4_NATIVE') {
      return new E4PreparePhaseDiagnostic(
        phases.map((phase) => ({ phase, target: targets[phase], method: 'work' })),
        () => ++tick,
        () => ({ user: ++cpu, system: ++cpu }),
        profile,
      );
    },
    async run(phases: readonly E4PreparePhase[]) {
      for (const phase of phases) await targets[phase].work();
    },
  };
}

describe('shared prepare diagnostic profiles', () => {
  it('keeps the default E4 profile strict about all eight bindings', () => {
    const f = fixture();
    const original = f.targets.C3_PROOF.work;
    const diagnostic = f.create(C3_PHASES);
    expect(f.targets.C3_PROOF.work).toBe(original);
    diagnostic.begin();
    diagnostic.finish('OK');
    diagnostic.restore();
    expect(diagnostic.snapshot().status).toBe('UNKNOWN');
  });

  it('keeps the default E4 success snapshot and eight-phase coverage unchanged', async () => {
    const f = fixture();
    const diagnostic = f.create(E4_PREPARE_PHASES);
    diagnostic.begin();
    await f.run(E4_PREPARE_PHASES);
    diagnostic.finish('OK');
    diagnostic.restore();
    expect(diagnostic.snapshot().status).toBe('COMPLETE');
    expect(diagnostic.snapshot()).not.toHaveProperty('profile');
    expect(diagnostic.snapshot().phases).toHaveLength(8);
    expect(diagnostic.snapshot().phases.every((phase) => phase.calls === 1)).toBe(true);
  });

  it('requires all five C3 phases without requiring inapplicable E4 evaluations', async () => {
    const f = fixture();
    const diagnostic = f.create(C3_PHASES, 'C3_PREPARE');
    diagnostic.begin();
    await f.run(C3_PHASES);
    diagnostic.finish('OK');
    diagnostic.restore();
    expect(diagnostic.snapshot()).toMatchObject({
      status: 'COMPLETE',
      profile: 'C3_PREPARE',
      requiredPhases: C3_PHASES,
      root: { calls: 1, ok: 1, failed: 0, pending: 0 },
    });
    expect(diagnostic.snapshot().phases.map((phase) => phase.phase)).toEqual(C3_PHASES);
  });

  it('records an optional E4 prepare binding without inventing unobserved evaluation rows', async () => {
    const f = fixture();
    const bound: readonly E4PreparePhase[] = [
      ...C3_PHASES.slice(0, -1),
      'E4_PREPARE',
      'C3_RECEIPT',
    ];
    const diagnostic = f.create(bound, 'C3_PREPARE');
    diagnostic.begin();
    await f.run(bound);
    diagnostic.finish('OK');
    diagnostic.restore();
    expect(diagnostic.snapshot().status).toBe('COMPLETE');
    expect(diagnostic.snapshot().phases.map((phase) => phase.phase)).toEqual(bound);
    expect(
      diagnostic.snapshot().phases.find((phase) => phase.phase === 'E4_PREPARE'),
    ).toMatchObject({
      calls: 1,
      ok: 1,
    });
  });

  it('rejects missing C3 bindings before changing a method', () => {
    const f = fixture();
    const original = f.targets.C3_PROOF.work;
    const diagnostic = f.create(
      C3_PHASES.filter((phase) => phase !== 'C3_RECEIPT'),
      'C3_PREPARE',
    );
    expect(f.targets.C3_PROOF.work).toBe(original);
    diagnostic.begin();
    diagnostic.finish('OK');
    diagnostic.restore();
    expect(diagnostic.snapshot().status).toBe('UNKNOWN');
  });

  it('does not call a successful C3 capture complete when a required phase never ran', async () => {
    const f = fixture();
    const diagnostic = f.create(C3_PHASES, 'C3_PREPARE');
    diagnostic.begin();
    await f.run(C3_PHASES.filter((phase) => phase !== 'C3_RECEIPT'));
    diagnostic.finish('OK');
    diagnostic.restore();
    expect(diagnostic.snapshot().status).toBe('UNKNOWN');
  });

  it('preserves the exact Promise, receiver and opaque arguments in the C3 profile', async () => {
    const f = fixture();
    let reads = 0;
    const opaque = new Proxy(
      {},
      {
        get() {
          reads++;
          throw new Error('PRIVATE_ARGUMENT_CANARY');
        },
      },
    );
    const options = Object.freeze({ timeout: 60000 });
    const response = { unchanged: true };
    const original = Promise.resolve(response);
    const calls: Array<{ receiver: unknown; args: unknown[] }> = [];
    f.targets.C3_PROOF.work = function (...args) {
      calls.push({ receiver: this, args });
      return original;
    };
    const originalMethod = f.targets.C3_PROOF.work;
    const diagnostic = f.create(C3_PHASES, 'C3_PREPARE');
    diagnostic.begin();
    const returned = f.targets.C3_PROOF.work(opaque, options);
    expect(returned).toBe(original);
    await expect(returned).resolves.toBe(response);
    await f.run(C3_PHASES.filter((phase) => phase !== 'C3_PROOF'));
    diagnostic.finish('OK');
    diagnostic.restore();
    expect(calls).toHaveLength(1);
    expect(calls[0].receiver).toBe(f.targets.C3_PROOF);
    expect(calls[0].args[0]).toBe(opaque);
    expect(calls[0].args[1]).toBe(options);
    expect(reads).toBe(0);
    expect(f.targets.C3_PROOF.work).toBe(originalMethod);
    expect(diagnostic.snapshot().status).toBe('COMPLETE');
    expect(JSON.stringify(diagnostic.snapshot())).not.toContain('PRIVATE_');
  });

  it('retains prior phases and the original receipt rejection without inspecting the error', async () => {
    const f = fixture();
    let reads = 0;
    const error = new Error('PRIVATE_RECEIPT_CANARY');
    Object.defineProperty(error, 'code', {
      get() {
        reads++;
        throw new Error('PRIVATE_CODE_CANARY');
      },
    });
    let original: Promise<never> | undefined;
    const originalReceipt = () => {
      original = Promise.reject(error);
      return original;
    };
    f.targets.C3_RECEIPT.work = originalReceipt;
    const captured = f.create(C3_PHASES, 'C3_PREPARE');
    captured.begin();
    await f.run(C3_PHASES.filter((phase) => phase !== 'C3_RECEIPT'));
    const returned = f.targets.C3_RECEIPT.work();
    expect(returned).toBe(original);
    await expect(returned).rejects.toBe(error);
    captured.finish('FAIL');
    captured.restore();
    let output = '';
    expect(captured.emitTo((json) => (output = json))).toBe(true);
    expect(reads).toBe(0);
    expect(output).not.toContain('PRIVATE_');
    expect(Buffer.byteLength(output, 'utf8')).toBeLessThanOrEqual(4096);
    expect(captured.snapshot()).toMatchObject({
      status: 'COMPLETE',
      root: { failed: 1, ok: 0, pending: 0 },
    });
    expect(captured.snapshot().phases.filter((phase) => C3_PHASES.includes(phase.phase))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ phase: 'C3_PROOF', ok: 1 }),
        expect.objectContaining({ phase: 'C3_RECEIPT', calls: 1, failed: 1, pending: 0 }),
      ]),
    );
    expect(f.targets.C3_RECEIPT.work).toBe(originalReceipt);
    expect(
      captured.emitTo(() => {
        throw new Error('PRIVATE_SINK_CANARY');
      }),
    ).toBe(false);
    expect(captured.snapshot().status).toBe('UNKNOWN');
  });

  it('rejects an unknown profile without retaining its value or changing methods', () => {
    const f = fixture();
    const original = f.targets.C3_PROOF.work;
    const diagnostic = f.create(E4_PREPARE_PHASES, 'PRIVATE_PROFILE_CANARY' as never);
    expect(f.targets.C3_PROOF.work).toBe(original);
    expect(diagnostic.snapshot().status).toBe('UNKNOWN');
    expect(JSON.stringify(diagnostic.snapshot())).not.toContain('PRIVATE_');
  });

  it.each(['C3_PREPARE', 'C3_SOURCE_QUERIES'] as const)(
    'binds %s service seams without inspecting a client or invoking a service',
    (profile) => {
      const time = Object.create(ActivityTimeSettlementService.prototype) as object;
      const queries = Object.create(ActivityTimeSettlementQueryService.prototype) as object;
      const contributions = Object.create(
        ActivityContributionSettlementService.prototype,
      ) as object;
      let clientReads = 0;
      Object.defineProperty(time, 'prisma', {
        get() {
          clientReads++;
          throw new Error('PRIVATE_CLIENT_CANARY');
        },
      });
      const original = Reflect.get(time, 'receipt') as unknown;
      const diagnostic = new E4PreparePhaseDiagnostic(
        [
          { phase: 'C3_PROOF', target: time, method: 'lockedProof' },
          { phase: 'C3_SOURCE', target: time, method: 'lockedSources' },
          { phase: 'C3_EVAL', target: queries, method: 'evaluateInTx' },
          { phase: 'C3_BUCKET_WRITE', target: time, method: 'insertBuckets' },
          { phase: 'E4_PREPARE', target: contributions, method: 'prepareTimeInTx' },
          { phase: 'C3_RECEIPT', target: time, method: 'receipt' },
        ],
        undefined,
        undefined,
        profile,
      );
      expect(Reflect.get(time, 'receipt')).not.toBe(original);
      diagnostic.restore();
      expect(Reflect.get(time, 'receipt')).toBe(original);
      expect(Object.hasOwn(time, 'receipt')).toBe(false);
      expect(clientReads).toBe(0);
    },
  );
});

describe('C3 source query classification', () => {
  const profile = 'C3_SOURCE_QUERIES' as E4PrepareProfile;
  const semantics = 'RECEIVED_EVENTS_IN_C3_SOURCE_ONLY_NOT_DATABASE_EXECUTION_PROOF';
  function classify(sql: unknown): string {
    const classifyQuery: unknown = Reflect.get(PrepareDiagnostic, 'classifyC3SourceReadQuery');
    expect(typeof classifyQuery).toBe('function');
    return (classifyQuery as (value: unknown) => string)(sql);
  }
  function record(
    diagnostic: E4PreparePhaseDiagnostic,
    family: unknown,
    ms: number,
    kind: 'READ' | 'WRITE' = 'READ',
  ) {
    const query: unknown = Reflect.get(diagnostic, 'query');
    Reflect.apply(query as (...args: unknown[]) => unknown, diagnostic, [kind, ms, family]);
  }
  function sqlText(query: TemplateStringsArray | Prisma.Sql): string {
    return 'sql' in query ? query.sql : query.join('?');
  }

  it('recognizes the actual current-segment query without collecting its parameters', async () => {
    const statements: string[] = [];
    const tx = {
      $queryRaw: (query: TemplateStringsArray | Prisma.Sql) => {
        statements.push(sqlText(query));
        return Promise.resolve([]);
      },
    } as unknown as Prisma.TransactionClient;
    const reader = Object.create(
      ParticipationSegmentFacade.prototype,
    ) as ParticipationSegmentFacade;
    await reader.readActivityCurrentSegmentsTrusted(tx, 'PRIVATE_ACTIVITY_CANARY');
    expect(statements).toHaveLength(1);
    expect(classify(statements[0])).toBe('CURRENT_SEGMENTS');
    expect(statements[0]).not.toContain('PRIVATE_ACTIVITY_CANARY');
  });

  it.each([false, true])(
    'recognizes the actual allocation query (forLocking=%s)',
    async (forLocking) => {
      const statements: string[] = [];
      const tx = {
        activityParticipationIdentity: { findMany: () => Promise.resolve([]) },
        participantSettlementResultRevision: { findMany: () => Promise.resolve([]) },
        $queryRaw: (query: TemplateStringsArray | Prisma.Sql) => {
          statements.push(sqlText(query));
          return Promise.resolve([]);
        },
      } as unknown as Prisma.TransactionClient;
      const reader = new ActivityTimeSettlementQueryService(
        {} as ConstructorParameters<typeof ActivityTimeSettlementQueryService>[0],
        {} as ConstructorParameters<typeof ActivityTimeSettlementQueryService>[1],
        {
          readActivityCurrentSegmentsTrusted: () => Promise.resolve([]),
        } as unknown as ParticipationSegmentFacade,
      );
      const proof = {
        activityId: 'activity',
        settlementRunId: 'run',
        settlementDraftVersionId: 'draft',
        evidenceSealId: 'seal',
        evidenceRevision: 0,
        populationRevision: 0,
        workflowRevision: 0,
        draftContentHash: 'a'.repeat(64),
      };
      if (forLocking) await reader.readSourceSetInTx(tx, proof, true);
      else await reader.readSourceSetInTx(tx, proof);
      expect(statements).toHaveLength(1);
      expect(classify(statements[0])).toBe('LATEST_ALLOCATIONS');
    },
  );

  it('recognizes all four actual source-lock statements and retains the two reads', async () => {
    const statements: string[] = [];
    const read = jest.fn().mockResolvedValue({ segments: [], latest: [] });
    const reauthorize = jest.fn().mockResolvedValue({});
    const tx = {
      $queryRaw: (query: TemplateStringsArray | Prisma.Sql) => {
        statements.push(sqlText(query));
        return Promise.resolve([]);
      },
    };
    const method: unknown = Reflect.get(ActivityTimeSettlementService.prototype, 'lockedSources');
    await Reflect.apply(
      method as (...args: unknown[]) => unknown,
      { queries: { readSourceSetInTx: read } },
      [tx, { activityId: 'PRIVATE_ACTIVITY_CANARY' }, reauthorize],
    );
    expect(statements).toHaveLength(4);
    expect(statements.map(classify)).toEqual(Array(4).fill('SOURCE_ROW_LOCKS'));
    expect(statements.join('')).not.toContain('PRIVATE_ACTIVITY_CANARY');
    expect(read).toHaveBeenCalledTimes(2);
    expect(reauthorize).toHaveBeenCalledTimes(4);
  });

  it.each([
    [
      'SELECT "public"."ActivityParticipationIdentity"."id", "public"."ActivityParticipationIdentity"."memberId" FROM "public"."ActivityParticipationIdentity" WHERE ("public"."ActivityParticipationIdentity"."activityId" = $1 AND "public"."ActivityParticipationIdentity"."populationIncluded" = $2) ORDER BY "public"."ActivityParticipationIdentity"."id" ASC LIMIT $3 OFFSET $4',
      'POPULATION',
    ],
    [
      'SELECT "t0"."id", "t0"."memberId" FROM "public"."ActivityParticipationIdentity" AS "t0" WHERE ("t0"."activityId" = $1 AND "t0"."populationIncluded" = $2) LIMIT $3',
      'POPULATION',
    ],
    [
      'SELECT "public"."ParticipantSettlementResultRevision"."participationIdentityId", "public"."ParticipantSettlementResultRevision"."exceptionFlagsJson" FROM "public"."ParticipantSettlementResultRevision" WHERE "public"."ParticipantSettlementResultRevision"."settlementVersionId" = $1 LIMIT $2',
      'SETTLEMENT_RESULTS',
    ],
    [
      'SELECT "t0"."participationIdentityId", "t0"."exceptionFlagsJson" FROM "public"."ParticipantSettlementResultRevision" AS "t0" WHERE "t0"."settlementVersionId" = $1 LIMIT $2',
      'SETTLEMENT_RESULTS',
    ],
  ])('classifies the supported ORM projection %#', (sql, family) => {
    expect(classify(sql)).toBe(family);
  });

  it.each([
    'SELECT id FROM "User" WHERE id = $1',
    'SELECT id FROM "ActivityParticipationIdentity" WHERE id = $1',
    'SELECT \'FROM "ActivityParticipationIdentity" "populationIncluded"\' AS text',
    'SELECT \'FROM "ParticipantSettlementResultRevision" "settlementVersionId"\' AS text',
    '/* private SQL */ SELECT id FROM "ActivityRuleSnapshot" ORDER BY id FOR SHARE',
    'SELECT id FROM "ActivityRuleSnapshot" ORDER BY id FOR SHARE; SELECT 1',
    'x'.repeat(32769),
    null,
    undefined,
  ])('leaves unsupported or ambiguous input unclassified', (sql) => {
    expect(classify(sql)).toBe('OTHER');
  });

  it('does not coerce an opaque query object', () => {
    let reads = 0;
    const opaque = new Proxy(
      {},
      {
        get() {
          reads++;
          throw new Error('PRIVATE_QUERY_CANARY');
        },
      },
    );
    expect(classify(opaque)).toBe('OTHER');
    expect(reads).toBe(0);
  });

  it('partitions only received source-window events and omits unobserved families', async () => {
    const f = fixture();
    f.targets.C3_SOURCE.work = () => {
      expect(Reflect.get(diagnostic, 'sourceQueryWindowOpen')).toBe(true);
      record(diagnostic, 'CURRENT_SEGMENTS', 13);
      record(diagnostic, 'LATEST_ALLOCATIONS', 7);
      record(diagnostic, 'SOURCE_ROW_LOCKS', 0);
      record(diagnostic, 'OTHER', 2);
      record(diagnostic, 'OTHER', 3, 'WRITE');
      return Promise.resolve();
    };
    const diagnostic = f.create(C3_PHASES, profile);
    record(diagnostic, 'CURRENT_SEGMENTS', 99);
    diagnostic.begin();
    record(diagnostic, 'CURRENT_SEGMENTS', 100);
    await f.run(C3_PHASES);
    expect(Reflect.get(diagnostic, 'sourceQueryWindowOpen')).toBe(false);
    record(diagnostic, 'CURRENT_SEGMENTS', 101);
    diagnostic.finish('OK');
    record(diagnostic, 'CURRENT_SEGMENTS', 102);
    diagnostic.restore();
    expect(diagnostic.snapshot()).toMatchObject({
      status: 'COMPLETE',
      profile,
      requiredPhases: C3_PHASES,
      sourceQueries: {
        status: 'OBSERVED',
        classification: 'PARTIAL',
        semantics,
        events: 5,
        families: [
          { family: 'CURRENT_SEGMENTS', kind: 'READ', events: 1, totalMs: 13, largestMs: 13 },
          { family: 'LATEST_ALLOCATIONS', kind: 'READ', events: 1, totalMs: 7, largestMs: 7 },
          { family: 'SOURCE_ROW_LOCKS', kind: 'READ', events: 1, totalMs: 0, largestMs: 0 },
          { family: 'OTHER', kind: 'READ', events: 1, totalMs: 2, largestMs: 2 },
          { family: 'OTHER', kind: 'WRITE', events: 1, totalMs: 3, largestMs: 3 },
        ],
      },
    });
    expect(diagnostic.snapshot().phases.find((row) => row.phase === 'C3_SOURCE')).toMatchObject({
      queryCount: 5,
      readMs: 22,
      writeMs: 3,
      largestMs: 13,
    });
    let output = '';
    expect(diagnostic.emitTo((json) => (output = json))).toBe(true);
    expect(Buffer.byteLength(output, 'utf8')).toBeLessThanOrEqual(4096);
  });

  it('does not call an unobserved source query capture complete or invent zero families', async () => {
    const f = fixture();
    const diagnostic = f.create(C3_PHASES, profile);
    diagnostic.begin();
    await f.run(C3_PHASES);
    diagnostic.finish('OK');
    diagnostic.restore();
    expect(diagnostic.snapshot()).toMatchObject({
      status: 'COMPLETE',
      sourceQueries: { status: 'UNKNOWN', classification: 'UNKNOWN', events: 0, families: [] },
    });
  });

  it('reports classified received events without claiming database execution coverage', async () => {
    const f = fixture();
    f.targets.C3_SOURCE.work = () => {
      record(diagnostic, 'CURRENT_SEGMENTS', 13);
      record(diagnostic, 'CURRENT_SEGMENTS', 7);
      return Promise.resolve();
    };
    const diagnostic = f.create(C3_PHASES, profile);
    diagnostic.begin();
    await f.run(C3_PHASES);
    diagnostic.finish('OK');
    diagnostic.restore();
    expect(diagnostic.snapshot()).toMatchObject({
      status: 'COMPLETE',
      sourceQueries: {
        status: 'OBSERVED',
        classification: 'COMPLETE',
        semantics,
        events: 2,
        families: [
          { family: 'CURRENT_SEGMENTS', kind: 'READ', events: 2, totalMs: 20, largestMs: 13 },
        ],
      },
    });
  });

  it.each(['E4_NATIVE', 'C3_PREPARE'] as const)(
    'leaves the %s snapshot unchanged',
    async (mode) => {
      const f = fixture();
      const phases = mode === 'E4_NATIVE' ? E4_PREPARE_PHASES : C3_PHASES;
      const diagnostic = f.create(phases, mode);
      diagnostic.begin();
      await f.run(phases);
      diagnostic.finish('OK');
      diagnostic.restore();
      expect(diagnostic.snapshot().status).toBe('COMPLETE');
      expect(diagnostic.snapshot()).not.toHaveProperty('sourceQueries');
      expect(diagnostic.snapshot().phases).toHaveLength(phases.length);
    },
  );

  it('never serializes a forged family and keeps the original rejection and Promise', async () => {
    const f = fixture();
    const error = new Error('PRIVATE_REJECTION_CANARY');
    let original: Promise<never> | undefined;
    f.targets.C3_SOURCE.work = () => {
      record(diagnostic, 'PRIVATE_SQL_PARAMETERS_ID_CREDENTIAL_CANARY', 10);
      original = Promise.reject(error);
      return original;
    };
    const method = f.targets.C3_SOURCE.work;
    const diagnostic = f.create(C3_PHASES, profile);
    diagnostic.begin();
    await f.run(['C3_PROOF']);
    const returned = f.targets.C3_SOURCE.work();
    expect(returned).toBe(original);
    await expect(returned).rejects.toBe(error);
    diagnostic.finish('FAIL');
    diagnostic.restore();
    expect(f.targets.C3_SOURCE.work).toBe(method);
    expect(diagnostic.snapshot().status).toBe('UNKNOWN');
    let output = '';
    expect(diagnostic.emitTo((json) => (output = json))).toBe(true);
    expect(output).not.toContain('PRIVATE_');
    expect(JSON.parse(output) as unknown).toMatchObject({
      sourceQueries: { events: 1, families: [{ family: 'OTHER', events: 1 }] },
    });
  });
});
