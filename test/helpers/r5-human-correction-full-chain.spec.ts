import { createHash } from 'node:crypto';
import {
  snapshotR5SetmatTables,
  R5_SETMAT_TABLES,
  R5_AUXILIARY_SNAPSHOT120_POLICY,
  type R5TableSnapshotReport,
} from './r5-setmat-manifest';
import {
  assertR5AsyncManifest,
  assertR5AsyncWindow,
  R5_ASYNC_FULL_CHAIN_SCOPE,
  R5_ASYNC_FIRST_LAUNCH_SCOPE,
  R5_ASYNC_CAPACITY1000_UNITS,
  R5_FULL_CHAIN_POLICY,
  R5_FIRST_LAUNCH_POLICY,
  R5_ASYNC_PREPARED240_SCOPE,
  R5_SNAPSHOT120_PUBLICATION_RESERVES,
} from './r5-human-correction-async';
import {
  buildR5FullChainChange,
  R5_FULL_CHAIN_SOURCE,
  runR5NewFullChainRequests,
  readR5FullChainBindings,
  readR5FullChainSource,
  R5_FULL_CHAIN_BINDING_READ_BATCH,
  R5_PREPARED240_PUBLICATION,
  assertR5Prepared240State,
  type R5Prepared240State,
  type R5FullChainSegment,
} from './r5-human-correction-full-chain';
import { nativeLaunchSlices } from './activity-native-launch.fixture';
import { parseCorrectionChangeSet } from '../../src/modules/activities/correction-change-set';
import { Prisma, type PrismaClient } from '@prisma/client';

function input() {
  const segments: R5FullChainSegment[] = Array.from({ length: 10000 }, (_, i) => {
    const start = new Date(Date.UTC(2026, 9, 31, 10, 0, 0) + (i % 5) * 22000);
    const end = new Date(start.getTime() + (i % 10 === 0 ? 19000 : 20000));
    return {
      id: `segment${i}`,
      participationIdentityId: `identity${Math.floor(i / 5)}`,
      segmentKey: `key${i % 5}`,
      allocationId: `allocation${i}`,
      sessionId: 'same-session',
      checkInAt: start,
      checkOutAt: end,
      slices: nativeLaunchSlices(start, end).map((s) => ({
        ...s,
        startAt: new Date(s.startAt),
        endAt: new Date(s.endAt),
        intervalKindCode: 'service_segment',
      })),
    };
  });
  return {
    segments,
    results: Array.from({ length: 2000 }, (_, i) => ({
      participationIdentityId: `identity${i}`,
      resultCode: 'present',
      lateFlag: false,
      earlyLeaveFlag: false,
      recognizedServiceHours: '0.03',
      recognizedContributionPoints: '0.50',
    })),
    roots: Array.from({ length: 8000 }, (_, i) => ({
      id: `root${i}`,
      participationIdentityId: `identity${Math.floor(i / 4)}`,
      categoryCode: ['volunteer_service', 'training', 'organization', 'non_creditable'][i % 4],
    })),
    baseSettlementVersionId: R5_FULL_CHAIN_SOURCE.settlementVersionId,
    baseTimeLedgerHash: 'a'.repeat(64),
    evidenceAttachmentId: 'existing-attachment',
  };
}
function source() {
  const i = input();
  return {
    source: R5_FULL_CHAIN_SOURCE,
    change: buildR5FullChainChange(i),
    anchors: [],
    sourceInputSha256: 'b'.repeat(64),
    participationIdentityId: 'identity0',
  };
}

describe('new full-chain fixed source assembly (no database)', () => {
  it('uses complete mixed published spans and current physical allocation/segment anchors', () => {
    const i = input(),
      c = buildR5FullChainChange(i);
    expect(c.segments).toHaveLength(1000);
    expect(c.allocations).toHaveLength(1000);
    expect(c.timeCorrection.items).toHaveLength(8000);
    const byId = new Map(i.segments.map((s) => [s.id, s]));
    for (const a of c.allocations) {
      const old = byId.get(a.baseSegmentRevisionId)!;
      expect(a.baseAllocationRevisionId).toBe(old.allocationId);
      expect(new Date(a.slices[4].endAt).getTime()).toBe(old.checkOutAt!.getTime() - 1000);
      expect(a.evidenceAttachmentIds).toEqual(['existing-attachment']);
    }
    expect(c.timeCorrection.baseTimeLedgerHash).toBe(i.baseTimeLedgerHash);
    const total = c.timeCorrection.items.reduce((n, r) => n + r.recognizedSeconds, 0);
    expect(total).toBeLessThan(196000);
    // Both disjoint groups now have one shortened segment per identity:
    // 2000 * (39 + 19 + 19 + 19) = 192000 recognized seconds.
    expect(total).toBe(192000);
    expect(c.results.every((r) => r.lateFlag)).toBe(true);
    expect(parseCorrectionChangeSet(c).allocations).toHaveLength(1000);
  });
  it('has order-independent selection and category totals', () => {
    const i = input();
    const original = buildR5FullChainChange(i);
    i.segments.reverse();
    expect(buildR5FullChainChange(i)).toEqual(original);
  });
  it.each([
    'duplicate',
    'changed-span',
    'missing-root',
    'bad-category',
    'missing-identity',
  ] as const)('rejects %s instead of fabricating a new baseline', (kind) => {
    const i = input();
    if (kind === 'duplicate') i.segments[1] = { ...i.segments[0] };
    if (kind === 'changed-span')
      i.segments[0].checkOutAt = new Date(i.segments[0].checkInAt.getTime() + 21000);
    if (kind === 'missing-root') i.roots.pop();
    if (kind === 'bad-category') i.roots[0].categoryCode = 'unexpected';
    if (kind === 'missing-identity') i.results[0].participationIdentityId = 'absent';
    expect(() => buildR5FullChainChange(i)).toThrow();
  });
});

describe('real HTTP full-chain protocol orchestration (ports only, no DB proof)', () => {
  function setup() {
    const events: unknown[] = [],
      calls: { path: string; actor: string; body: object; metadata: boolean }[] = [];
    const options = {
      source: source(),
      phaseId: 'r5_async_capacity1000_fullchain_test',
      reviewerUserId: 'reviewerB',
      persist: (v: unknown) => {
        events.push(v);
        return 'durable-receipt';
      },
      checkpoint: jest.fn(),
      post: jest.fn(
        async (
          _label: string,
          path: string,
          actor: 'creator' | 'reviewer',
          body: object,
          metadata: boolean,
        ): Promise<{ status: number; body: { code: number; data: Record<string, unknown> } }> => {
          calls.push({ path, actor, body, metadata });
          return {
            status: 200,
            body: {
              code: 0,
              data:
                calls.length === 1
                  ? {
                      requestId: 'NEW_REQUEST',
                      requestVersion: 1,
                      baseSettlementVersionId: R5_FULL_CHAIN_SOURCE.settlementVersionId,
                      replayed: false,
                    }
                  : calls.length === 2
                    ? {
                        outcome: 'reviewed',
                        statusCode: 'approved',
                        replayed: false,
                        reviewedByUserId: 'reviewerB',
                      }
                    : {
                        requestId: 'NEW_REQUEST',
                        applicationId: 'NEW_APPLICATION',
                        postingBatchId: 'NEW_BATCH',
                        settlementVersionId: 'NEW_VERSION',
                        replayed: false,
                      },
            },
          };
        },
      ),
    };
    return { options, events, calls };
  }
  it('submits a new request, makes one independent review, then one actual HTTP prepare; only its core has prepare observation', async () => {
    const { options, calls } = setup();
    const result = await runR5NewFullChainRequests(options);
    expect(calls.map((x) => [x.actor, x.metadata])).toEqual([
      ['creator', true],
      ['reviewer', true],
      ['reviewer', false],
    ]);
    expect(calls[1].path.endsWith('/NEW_REQUEST/review')).toBe(true);
    expect(calls[2].path.endsWith('/NEW_REQUEST/prepare')).toBe(true);
    expect(options.checkpoint.mock.calls).toEqual([[400000], [360000]]);
    expect(result.command.correctionApplicationId).toBe('NEW_APPLICATION');
    expect(result.command.expectedBaseSettlementVersionId).toBe(
      R5_FULL_CHAIN_SOURCE.settlementVersionId,
    );
  });
  it('refuses an old successful request response before review or prepare', async () => {
    const { options } = setup();
    options.post.mockResolvedValueOnce({
      status: 200,
      body: {
        code: 0,
        data: {
          requestId: R5_FULL_CHAIN_SOURCE.requestId,
          requestVersion: 1,
          baseSettlementVersionId: R5_FULL_CHAIN_SOURCE.settlementVersionId,
          replayed: false,
        },
      },
    });
    await expect(runR5NewFullChainRequests(options)).rejects.toThrow();
    expect(options.post).toHaveBeenCalledTimes(1);
  });
  it('stops at actual reviewer rejection without trying prepare or retry', async () => {
    const { options } = setup();
    const original = options.post.getMockImplementation()!;
    options.post.mockImplementation(async (...args) =>
      args[0].includes('REVIEW')
        ? { status: 403, body: { code: 123, data: {} } }
        : await original(...args),
    );
    await expect(runR5NewFullChainRequests(options)).rejects.toThrow('rejected');
    expect(options.post).toHaveBeenCalledTimes(2);
  });
  it('does not dispatch prepare if the shared stage has insufficient time', async () => {
    const { options } = setup();
    options.checkpoint.mockImplementation((reserve: number) => {
      if (reserve === 360000) throw new Error('closed original stage');
    });
    await expect(runR5NewFullChainRequests(options)).rejects.toThrow('closed original stage');
    expect(options.post).toHaveBeenCalledTimes(2);
  });
  it('does not replay a prepare whose HTTP result is failed or unknown', async () => {
    const { options } = setup();
    const original = options.post.getMockImplementation()!;
    options.post.mockImplementation(async (...args) =>
      args[0].includes('PREPARE')
        ? { status: 500, body: { code: 123, data: {} } }
        : await original(...args),
    );
    await expect(runR5NewFullChainRequests(options)).rejects.toThrow('rejected');
    expect(options.post).toHaveBeenCalledTimes(3);
  });
});

// These gates execute before any client construction or command dispatch.
describe('new full-chain manifest is distinct from the closed successful retry', () => {
  const start = Date.parse('2026-10-31T20:00:00Z');
  function manifest(): import('./r5-human-correction-async').R5AsyncManifest {
    return {
      schema: R5_ASYNC_FULL_CHAIN_SCOPE.schema,
      capacity: R5_ASYNC_CAPACITY1000_UNITS,
      firstLaunchCandidate: R5_FULL_CHAIN_POLICY,
      fullChainSource: R5_FULL_CHAIN_SOURCE,
      checkout: '/tmp/offline-checkout',
      sourceBinding: { path: '/tmp/offline-source.json', sha256: 'a'.repeat(64) },
      base: {
        schema: 'srvf-r5-setmat-safety/v1',
        databaseOid: 1998913,
        creatorUserId: 'creator',
        reviewerUserId: 'A',
        finalReviewerUserId: 'B',
        organizationId: 'org',
        expectedCatalogPath: '/tmp/old.json',
        expectedCatalogSha256: 'b'.repeat(64),
        boundPreflightBodySha256: 'c'.repeat(64),
        catalogQueryPath: '/tmp/query.sql',
        catalogQuerySha256: 'd'.repeat(64),
        outputDirectory: '/tmp/offline-fixture',
      },
      supplemental: {
        querySha256: 'e'.repeat(64),
        expectedPath: '/tmp/extra.json',
        expectedSha256: 'f'.repeat(64),
        origin: 'OFFLINE_SOURCE_REVIEWED',
        sourceReviewReference: 'offline-review',
        permissionApprovalReference: 'offline-permission',
        installedBindingReference: 'offline-install',
      },
      approval: {
        approved: true,
        scope: R5_ASYNC_FULL_CHAIN_SCOPE.approvalScope,
        reference: R5_FULL_CHAIN_POLICY.approvalReference,
        phaseId: 'r5_async_capacity1000_fullchain_fake',
        phaseStartedAt: new Date(start).toISOString(),
        phaseDeadline: new Date(start + 600000).toISOString(),
        campaignStartedAt: new Date(start).toISOString(),
        campaignDeadline: new Date(start + 1800000).toISOString(),
        originalFailuresPreserved: true,
      },
      outputDirectory: '/tmp/offline-result',
      control: {
        pid: process.pid + 10000,
        receiptPath: '/tmp/control.json',
        receiptSha256: '1'.repeat(64),
      },
    };
  }
  it('accepts only its exact published source, new approval scope, and enabled240/60 policy', () => {
    expect(() => assertR5AsyncManifest(manifest(), start, R5_ASYNC_FULL_CHAIN_SCOPE)).not.toThrow();
    expect(() => assertR5AsyncManifest(manifest(), start, R5_ASYNC_FIRST_LAUNCH_SCOPE)).toThrow();
  });
  it.each(['source', 'policy', 'oldRetry', 'closedClock', 'lateAdmission'] as const)(
    'rejects %s before any SQL',
    (kind) => {
      const m = manifest();
      let now = start;
      if (kind === 'source')
        Reflect.set(m, 'fullChainSource', { ...R5_FULL_CHAIN_SOURCE, xid: '999999' });
      if (kind === 'policy')
        m.firstLaunchCandidate = { ...R5_FULL_CHAIN_POLICY, prepareEnabledThisStage: false };
      if (kind === 'oldRetry') m.originalJobRetry = {} as NonNullable<typeof m.originalJobRetry>;
      if (kind === 'closedClock') m.approval.campaignStartedAt = '2026-10-31T18:39:00Z';
      if (kind === 'lateAdmission') now += 240001;
      expect(() => assertR5AsyncManifest(m, now, R5_ASYNC_FULL_CHAIN_SCOPE)).toThrow();
    },
  );
  it('requires the new immutable159341 publication scope and cannot dispatch the fresh prepare flow', () => {
    const m = manifest(),
      begin = start + 3600000;
    m.schema = R5_ASYNC_PREPARED240_SCOPE.schema;
    m.approval.scope = R5_ASYNC_PREPARED240_SCOPE.approvalScope;
    m.fullChainSource = undefined;
    m.prepared240 = R5_PREPARED240_PUBLICATION;
    m.auxiliarySnapshot = R5_AUXILIARY_SNAPSHOT120_POLICY;
    m.firstLaunchCandidate = R5_FIRST_LAUNCH_POLICY;
    m.approval.phaseStartedAt = m.approval.campaignStartedAt = new Date(begin).toISOString();
    m.approval.phaseDeadline = new Date(begin + 600000).toISOString();
    m.approval.campaignDeadline = new Date(begin + 1800000).toISOString();
    expect(() => assertR5AsyncManifest(m, begin, R5_ASYNC_PREPARED240_SCOPE)).not.toThrow();
    expect(() => assertR5AsyncManifest(m, begin, R5_ASYNC_FULL_CHAIN_SCOPE)).toThrow();
    expect(() => assertR5AsyncManifest(m, begin + 60000, R5_ASYNC_PREPARED240_SCOPE)).toThrow();
    for (const policy of [
      undefined,
      { ...R5_AUXILIARY_SNAPSHOT120_POLICY, approvalReference: 'unapproved' },
      { ...R5_AUXILIARY_SNAPSHOT120_POLICY, transactionMs: 240000 },
      { ...R5_AUXILIARY_SNAPSHOT120_POLICY, statementMs: 120000 },
      { ...R5_AUXILIARY_SNAPSHOT120_POLICY, automaticRetry: true },
    ]) {
      const rejected = { ...m, auxiliarySnapshot: policy };
      expect(() =>
        assertR5AsyncManifest(rejected as typeof m, begin, R5_ASYNC_PREPARED240_SCOPE),
      ).toThrow();
    }
    expect(R5_SNAPSHOT120_PUBLICATION_RESERVES).toEqual({
      entry: 540000,
      baseline: 450000,
      accept: 330000,
      worker: 300000,
      finalSnapshot: 210000,
    });
    for (const reserve of Object.values(R5_SNAPSHOT120_PUBLICATION_RESERVES)) {
      expect(() =>
        assertR5AsyncWindow(m, begin + 600000 - reserve - 1, reserve, R5_ASYNC_PREPARED240_SCOPE),
      ).not.toThrow();
      expect(() =>
        assertR5AsyncWindow(m, begin + 600000 - reserve, reserve, R5_ASYNC_PREPARED240_SCOPE),
      ).toThrow();
    }
    Reflect.set(m, 'prepared240', { ...R5_PREPARED240_PUBLICATION, xid: '159207' });
    expect(() => assertR5AsyncManifest(m, begin, R5_ASYNC_PREPARED240_SCOPE)).toThrow();
  });
});

describe('actual full-chain HTTP and worker module prepare profiles (no DB)', () => {
  beforeAll(async () => {
    const { loadTestEnv } = await import('../setup/load-env');
    loadTestEnv();
  });
  it.each(['http', 'worker'] as const)(
    '%s constructs actual command/domain services; bulk240 and ordinary/small120 remain separate',
    async (kind) => {
      const { Test } = await import('@nestjs/testing');
      const { AppModule } = await import('../../src/app.module');
      const { ActivitiesModule } = await import('../../src/modules/activities/activities.module');
      const { NotificationOutboxWorkerModule } =
        await import('../../src/modules/notifications/notification-outbox-worker.module');
      const { ActivityBatchWorkerModule } =
        await import('../../src/modules/activities/activity-batch-worker.module');
      const { PrismaService } = await import('../../src/database/prisma.service');
      const { ActivityTimeCorrectionCommandService } =
        await import('../../src/modules/activities/activity-time-correction-command.service');
      const { CorrectionApplicationService } =
        await import('../../src/modules/activities/correction-application.service');
      const { HUMAN_CORRECTION_BACKGROUND_BUDGET } =
        await import('../../src/modules/activities/human-correction-background-budget');
      const { default: appConfig } = await import('../../src/config/app.config');
      const { Role, UserStatus } = await import('@prisma/client');
      const stop = new Error('OFFLINE_FULL_CHAIN_BEFORE_ACTUAL_TX_CALLBACK');
      let count = 1000;
      const connect = jest.fn(),
        transaction = jest.fn(async () => {
          throw stop;
        });
      const prisma = {
        $connect: connect,
        $disconnect: jest.fn(),
        $transaction: transaction,
        attendanceCorrectionRequest: {
          findUnique: jest.fn(async () => ({ activityId: 'activity' })),
          findFirst: jest.fn(async () => ({
            requestHash: 'hash',
            requestedChangeJson: {
              schemaVersion: 3,
              segments: Array.from({ length: count }, () => ({})),
            },
          })),
        },
      };
      const module = await Test.createTestingModule({
        imports: [kind === 'http' ? AppModule : NotificationOutboxWorkerModule],
      })
        .overrideProvider(appConfig.KEY)
        .useValue({
          ...appConfig(),
          contributionSettlementMode: 'active',
          activityV11Workflow: { enabled: true, readonlyMaintenance: false },
        })
        .overrideProvider(PrismaService)
        .useValue(prisma)
        .overrideProvider(HUMAN_CORRECTION_BACKGROUND_BUDGET)
        .useValue(Object.freeze({ bulkCommit: true, bulkPrepare: true }))
        .compile();
      try {
        const graph = module.select(kind === 'http' ? ActivitiesModule : ActivityBatchWorkerModule);
        const human = graph.get(ActivityTimeCorrectionCommandService, { strict: true }),
          core = graph.get(CorrectionApplicationService, { strict: true });
        expect(Reflect.get(human, 'corrections')).toBe(core);
        expect(Reflect.get(core, 'prisma')).toBe(prisma);
        for (const service of [human, core])
          expect(Reflect.get(service, 'backgroundBudget')).toEqual({
            bulkCommit: true,
            bulkPrepare: true,
          });
        const actor = {
          id: 'actor',
          username: 'offline',
          role: Role.USER,
          status: UserStatus.ACTIVE,
          memberId: 'member',
        };
        const meta = { requestId: 'offline', ip: null, ua: null };
        for (const n of [1000, 999]) {
          count = n;
          transaction.mockClear();
          await expect(
            human.prepare(
              'activity',
              'request',
              { operationKey: 'new-operation', expectedBaseSettlementVersionId: 'base' },
              actor,
              meta,
            ),
          ).rejects.toBe(stop);
          expect(transaction).toHaveBeenCalledTimes(1);
          expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
            timeout: n === 1000 ? 240000 : 120000,
          });
        }
        transaction.mockClear();
        await expect(
          core.prepare(
            { correctionRequestId: 'request', operationKey: 'new-operation', requestHash: 'hash' },
            actor,
            meta,
          ),
        ).rejects.toBe(stop);
        expect(transaction).toHaveBeenCalledWith(expect.any(Function), { timeout: 120000 });
        expect(connect).not.toHaveBeenCalled();
      } finally {
        await module.close();
      }
    },
    30000,
  );
});

type ReadBinding = Awaited<ReturnType<typeof readR5FullChainBindings>>[number];
function relationRows() {
  return input().segments.map((s, i) => ({
    id: `binding${String(i).padStart(5, '0')}`,
    proofId: R5_FULL_CHAIN_SOURCE.proofId,
    activityId: R5_FULL_CHAIN_SOURCE.activityId,
    participationIdentityId: s.participationIdentityId,
    segmentKey: s.segmentKey,
    sourceSegmentId: s.id,
    sourceSegmentRevision: 1,
    allocationRevisionId: s.allocationId,
    sourceHash: 'a'.repeat(64),
    pendingAllocationId: null,
    createdAt: new Date('2026-10-31T10:00:00Z'),
    sourceSegment: {
      ...s,
      revision: 1,
      resultCode: 'valid',
      statusCode: 'committed',
      serviceHours: new Prisma.Decimal('0.01'),
    },
    allocationRevision: {
      id: s.allocationId,
      sourceSegmentId: s.id,
      sourceSegmentRevision: 1,
      sessionId: s.sessionId,
      policyVersionId: 'policy',
      allocationJson: { unchangedOpaqueField: [i, 'full-value'] },
      policyVersion: {
        id: 'policy',
        definitionJson: { rounding: { mode: 'floor', quantumSeconds: 1 } },
        extraField: 'not-projected-away',
      },
      slices: s.slices.map((slice, ordinal) => ({
        ...slice,
        id: `slice${i}-${ordinal}`,
        ordinal,
        allocationRevisionId: s.allocationId,
        activityId: R5_FULL_CHAIN_SOURCE.activityId,
      })),
    },
  })) as unknown as ReadBinding[];
}
function transactionPages(rows: ReadBinding[]) {
  const ordered = [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const findMany = jest.fn(
    async (args: {
      where: { proofId: string };
      take: number;
      orderBy: { id: string };
      cursor?: { id: string };
      skip?: number;
      include: unknown;
    }) => {
      expect(args.where).toEqual({ proofId: R5_FULL_CHAIN_SOURCE.proofId });
      expect(args.take).toBe(R5_FULL_CHAIN_BINDING_READ_BATCH);
      expect(args.orderBy).toEqual({ id: 'asc' });
      expect(args.include).toEqual({
        sourceSegment: true,
        allocationRevision: { include: { slices: true, policyVersion: true } },
      });
      const offset = args.cursor ? ordered.findIndex((r) => r.id === args.cursor!.id) + 1 : 0;
      if (args.cursor) {
        expect(offset).toBeGreaterThan(0);
        expect(args.skip).toBe(1);
      } else expect(args.skip).toBeUndefined();
      return ordered.slice(offset, offset + args.take);
    },
  );
  const tx = {
    correctionTimeAllocationBinding: { findMany },
  } as unknown as Prisma.TransactionClient;
  return { tx, findMany, ordered };
}

describe('bounded full-root relation reads in the supplied snapshot, no database', () => {
  it('retains every scalar and nested field of all10000 rows/50000 slices in deterministic cursor order', async () => {
    const rows = relationRows().reverse(),
      { tx, findMany, ordered } = transactionPages(rows);
    const actual = await readR5FullChainBindings(tx, R5_FULL_CHAIN_SOURCE.proofId);
    expect(actual).toEqual(ordered);
    expect(actual).toHaveLength(10000);
    actual.forEach((row, i) => expect(row).toBe(ordered[i]));
    expect(actual.reduce((n, r) => n + r.allocationRevision.slices.length, 0)).toBe(50000);
    expect(findMany).toHaveBeenCalledTimes(101);
    expect(findMany.mock.calls[0][0].cursor).toBeUndefined();
    expect(findMany.mock.calls[100][0].cursor).toEqual({ id: 'binding09999' });
  });
  it.each([
    'omitted',
    'extra',
    'repeated',
    'wrong-proof',
    'segment-link',
    'allocation-link',
    'policy-link',
    'slice-link',
  ] as const)('rejects %s without accepting a partial or mismatched root', async (kind) => {
    const rows = relationRows();
    if (kind === 'omitted') rows.pop();
    if (kind === 'extra') rows.push({ ...rows[9999], id: 'binding10000' });
    if (kind === 'wrong-proof') rows[100].proofId = 'different-proof';
    if (kind === 'segment-link') rows[100].sourceSegment.id = 'different-segment';
    if (kind === 'allocation-link') rows[100].allocationRevision.id = 'different-allocation';
    if (kind === 'policy-link') rows[100].allocationRevision.policyVersion.id = 'different-policy';
    if (kind === 'slice-link')
      rows[100].allocationRevision.slices[0].allocationRevisionId = 'different-allocation';
    const { tx, findMany } = transactionPages(rows);
    if (kind === 'repeated') {
      const read = findMany.getMockImplementation()!;
      findMany.mockImplementation(async (args) => {
        const page = await read(args);
        return args.cursor ? [rows[0], ...page.slice(1)] : page;
      });
    }
    await expect(readR5FullChainBindings(tx, R5_FULL_CHAIN_SOURCE.proofId)).rejects.toThrow();
    expect(findMany.mock.calls.length).toBeLessThanOrEqual(101);
  });
  it('preserves the original reader rejection and never retries a failed page', async () => {
    const { tx, findMany } = transactionPages(relationRows());
    const read = findMany.getMockImplementation()!;
    const original = Object.assign(new Error('ORIGINAL_READ_FAILURE'), { sqlState: '54001' });
    let count = 0;
    findMany.mockImplementation(async (args) => {
      if (++count === 2) throw original;
      return await read(args);
    });
    await expect(readR5FullChainBindings(tx, R5_FULL_CHAIN_SOURCE.proofId)).rejects.toBe(original);
    expect(findMany).toHaveBeenCalledTimes(2);
  });
  it('executes the actual full-source reader in one unchanged RO/RepeatableRead30s transaction', async () => {
    const snapshot = relationRows(),
      { tx, findMany } = transactionPages(snapshot),
      i = input(),
      p = R5_FULL_CHAIN_SOURCE;
    let active = false;
    const read = findMany.getMockImplementation()!;
    findMany.mockImplementation(async (args) => {
      expect(active).toBe(true);
      return await read(args);
    });
    const inTx = <T>(value: T) =>
      jest.fn(async () => {
        expect(active).toBe(true);
        return value;
      });
    const execute = jest.fn(async (query: TemplateStringsArray) => {
      expect(query.join('')).toBe('SET TRANSACTION READ ONLY');
      expect(active).toBe(true);
      return 0;
    });
    Object.assign(tx, {
      $executeRaw: execute,
      $queryRaw: jest.fn(async (query: TemplateStringsArray) => {
        expect(active).toBe(true);
        const sql = query.join('');
        if (sql.includes('pg_xact_status')) return [{ status: 'committed' }];
        if (sql.includes('UNION ALL'))
          return [
            ['request', p.requestId, 'applied'],
            ['application', p.applicationId, 'committed'],
            ['batch', p.batchId, 'committed'],
            ['job', p.jobId, 'succeeded'],
            ['item', p.itemId, 'succeeded'],
          ].map(([object, id, state]) => ({ object, id, state, xmin: p.xid }));
        if (sql.includes('DISTINCT ON'))
          return snapshot.map((r) => ({ id: r.allocationRevisionId }));
        throw new Error('unexpected SQL in source reader');
      }),
      attendanceSettlementVersion: {
        findUniqueOrThrow: inTx({ id: p.settlementVersionId, version: 4, statusCode: 'approved' }),
      },
      attendanceSettlementRun: {
        findUniqueOrThrow: inTx({ activityId: p.activityId, currentPostedVersion: 4 }),
      },
      correctionApplication: {
        findUniqueOrThrow: inTx({
          newSettlementVersionId: p.settlementVersionId,
          newPostingBatchId: p.batchId,
          correctionRequestId: p.requestId,
        }),
      },
      attendanceCorrectionRequest: { count: inTx(0) },
      participationTimeCorrectionManifest: {
        findUniqueOrThrow: inTx({
          rootManifestId: p.timeRootManifestId,
          settlementVersionId: p.settlementVersionId,
          sourceProofId: p.proofId,
          contentHash: 'a'.repeat(64),
        }),
      },
      activitySettlementContributionRevision: {
        findUniqueOrThrow: inTx({
          settlementVersionId: p.settlementVersionId,
          correctionTimeSourceProofId: p.proofId,
          evaluationCount: 8000,
        }),
      },
      participantServiceSegmentRevision: {
        findMany: inTx(snapshot.map((r) => ({ id: r.sourceSegmentId }))),
      },
      participantSettlementResultRevision: {
        findMany: inTx(
          i.results.map((r) => ({
            ...r,
            recognizedServiceHours: new Prisma.Decimal(r.recognizedServiceHours),
            recognizedContributionPoints: new Prisma.Decimal(r.recognizedContributionPoints),
          })),
        ),
      },
      participationTimeLedgerEntry: { findMany: inTx(i.roots) },
      correctionPendingTimeAllocationEvidence: {
        findFirstOrThrow: inTx({ attachmentId: i.evidenceAttachmentId }),
      },
    });
    const transaction = jest.fn(
      async (work: (t: Prisma.TransactionClient) => Promise<unknown>, options: unknown) => {
        expect(active).toBe(false);
        expect(options).toEqual({
          isolationLevel: 'RepeatableRead',
          timeout: 30000,
          maxWait: 2000,
        });
        active = true;
        try {
          return await work(tx);
        } finally {
          active = false;
        }
      },
    );
    const actual = await readR5FullChainSource({
      $transaction: transaction,
    } as unknown as PrismaClient);
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: 'RepeatableRead',
      timeout: 30000,
      maxWait: 2000,
    });
    expect(execute.mock.calls[0][0].join('')).toContain('SET TRANSACTION READ ONLY');
    expect(findMany).toHaveBeenCalledTimes(101);
    expect(actual.change).toEqual(buildR5FullChainChange(i));
    expect(active).toBe(false);
  });
});

describe('complete table snapshot diagnostics keep original data and budgets', () => {
  function db(failAt = -1, transactionMs = 30000) {
    const rows = R5_SETMAT_TABLES.map((name, i) => ({
      name,
      count: String(i),
      hash: String(i).padStart(64, '0'),
    }));
    let cursor = 0,
      settled = false;
    const original = Object.assign(new Error('ORIGINAL_SNAPSHOT_EXPIRED'), { code: 'P2028' });
    const tx = {
      $executeRaw: jest.fn(async (sql: TemplateStringsArray) => {
        expect(['SET TRANSACTION READ ONLY', "SET LOCAL statement_timeout='30s'"]).toContain(
          sql.join(''),
        );
        return 0;
      }),
      $queryRaw: jest.fn(async () => R5_SETMAT_TABLES.map((name) => ({ name }))),
      $queryRawUnsafe: jest.fn(async (sql: string) => {
        expect(sql).toContain('to_jsonb(t)::text');
        expect(sql).toContain('ORDER BY c.row_text COLLATE "C"');
        expect(sql).toContain('OFFSET 0');
        if (cursor === failAt) throw original;
        const { count, hash } = rows[cursor++];
        return [{ count, hash }];
      }),
    };
    const transaction = jest.fn(
      async (work: (t: typeof tx) => Promise<unknown>, options: unknown) => {
        expect(options).toEqual({
          isolationLevel: 'RepeatableRead',
          timeout: transactionMs,
          maxWait: 2000,
        });
        try {
          return await work(tx);
        } finally {
          settled = true;
        }
      },
    );
    return {
      get settled() {
        return settled;
      },
      client: { $transaction: transaction } as unknown as PrismaClient,
      tx,
      rows,
      transaction,
      original,
    };
  }
  it('returns the exact complete original fingerprint and reports199 table spans separately', async () => {
    const f = db(),
      reports: R5TableSnapshotReport[] = [];
    const actual = await snapshotR5SetmatTables(f.client, (r) => {
      reports.push(r);
    });
    expect(actual.rows).toEqual(f.rows);
    expect(actual.tables).toEqual(R5_SETMAT_TABLES);
    expect(actual.hash).toBe(createHash('sha256').update(JSON.stringify(f.rows)).digest('hex'));
    expect(f.transaction).toHaveBeenCalledTimes(1);
    expect(f.tx.$queryRawUnsafe).toHaveBeenCalledTimes(199);
    expect(reports).toHaveLength(1);
    expect(reports[0].tables.map((r) => r.name)).toEqual(R5_SETMAT_TABLES);
    expect(
      reports[0].tables.every((r) => r.status === 'FULFILLED' && r.promiseElapsedMs >= 0),
    ).toBe(true);
    expect(reports[0].timingBoundary).toBe('CLIENT_TABLE_QUERY_PROMISE_NOT_SERVER_EXECUTION');
    expect(reports[0].databaseOutcome).toBe('NOT_INFERRED_FROM_CLIENT_RESULT');
    expect(reports[0].configuredTransactionMs).toBe(30000);
    expect(reports[0].auxiliaryApprovalReference).toBeNull();
    expect(Object.keys(actual.rows[0])).toEqual(['name', 'count', 'hash']);
  });
  it('retains all completed spans and identifies the rejected query boundary, without inferring its server cost', async () => {
    const f = db(87),
      reports: R5TableSnapshotReport[] = [];
    await expect(
      snapshotR5SetmatTables(f.client, (r) => {
        reports.push(r);
      }),
    ).rejects.toBe(f.original);
    expect(reports[0].status).toBe('REJECTED');
    expect(reports[0].tables).toHaveLength(88);
    expect(reports[0].tables[86].status).toBe('FULFILLED');
    expect(reports[0].tables[87]).toMatchObject({ name: R5_SETMAT_TABLES[87], status: 'REJECTED' });
    expect(f.tx.$queryRawUnsafe).toHaveBeenCalledTimes(88);
  });
  it('preserves the first error if diagnostic persistence also fails', async () => {
    const f = db(0);
    await expect(
      snapshotR5SetmatTables(f.client, () => {
        throw new Error('RECORD_FAILURE');
      }),
    ).rejects.toBe(f.original);
  });
  it('fails closed when successful data cannot be accompanied by its requested report', async () => {
    const f = db(),
      failure = new Error('RECORD_FAILURE');
    await expect(
      snapshotR5SetmatTables(f.client, () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
  });
  it('opts in to one120s RO/RR transaction, keeps every SQL byte and reports after settlement', async () => {
    const normal = db(),
      candidate = db(-1, 120000);
    const original = await snapshotR5SetmatTables(normal.client);
    let report: R5TableSnapshotReport | undefined;
    const result = await snapshotR5SetmatTables(
      candidate.client,
      (r) => {
        report = r;
        expect(candidate.tx.$queryRawUnsafe).toHaveBeenCalledTimes(199);
        expect(candidate.settled).toBe(true);
      },
      R5_AUXILIARY_SNAPSHOT120_POLICY,
    );
    expect(result).toEqual(original);
    expect(candidate.tx.$queryRawUnsafe.mock.calls).toEqual(normal.tx.$queryRawUnsafe.mock.calls);
    expect(candidate.tx.$executeRaw.mock.calls).toEqual(normal.tx.$executeRaw.mock.calls);
    expect(report).toMatchObject({
      configuredTransactionMs: 120000,
      configuredStatementMs: 30000,
      auxiliaryApprovalReference: R5_AUXILIARY_SNAPSHOT120_POLICY.approvalReference,
      readOnly: true,
      isolationLevel: 'RepeatableRead',
    });
    expect(candidate.transaction).toHaveBeenCalledTimes(1);
  });
  it('rejects a changed or incomplete120 policy before constructing a transaction', async () => {
    const f = db();
    for (const change of [
      { transactionMs: 120001 },
      { statementMs: 120000 },
      { readOnly: false },
      { automaticRetry: true },
      { approvalReference: 'not-approved' },
    ])
      await expect(
        snapshotR5SetmatTables(f.client, undefined, {
          ...R5_AUXILIARY_SNAPSHOT120_POLICY,
          ...change,
        } as typeof R5_AUXILIARY_SNAPSHOT120_POLICY),
      ).rejects.toThrow();
    expect(f.transaction).not.toHaveBeenCalled();
  });
  it('does not retry a candidate rejection or infer a database outcome from it', async () => {
    const f = db(123, 120000),
      reports: R5TableSnapshotReport[] = [];
    await expect(
      snapshotR5SetmatTables(f.client, (r) => reports.push(r), R5_AUXILIARY_SNAPSHOT120_POLICY),
    ).rejects.toBe(f.original);
    expect(f.transaction).toHaveBeenCalledTimes(1);
    expect(f.tx.$queryRawUnsafe).toHaveBeenCalledTimes(124);
    expect(reports[0].databaseOutcome).toBe('NOT_INFERRED_FROM_CLIENT_RESULT');
    expect(reports[0].configuredTransactionMs).toBe(120000);
  });
});

describe('frozen committed prepare240 qualification, no new commands', () => {
  function state(): R5Prepared240State {
    const p = R5_PREPARED240_PUBLICATION;
    return {
      xidStatus: 'committed',
      anchors: [
        ['application', p.applicationId, 'preparing'],
        ['batch', p.batchId, 'ready'],
        ['phase', p.applicationId, 'SEALED'],
        ['proof', p.proofId, 'frozen'],
        ['request', p.requestId, 'applying'],
        ['root', p.rootId, 'correction_time_proof'],
        ['version', p.settlementVersionId, 'approved'],
      ].map(([object, id, state]) => ({ object, id, state, xmin: p.xid })),
      counts: {
        segments: 1000,
        allocations: 1000,
        evidence: 1000,
        bindings: 0,
        ledger: 8000,
        commitPhases: 0,
        newJobs: 0,
      },
    };
  }
  it('accepts only the independently committed, unpublished exact prepared anchors', () => {
    expect(() => assertR5Prepared240State(state())).not.toThrow();
  });
  it.each(['unknown', 'consumed', 'missing', 'xmin', 'job', 'binding', 'ledger'] as const)(
    'rejects %s without preparing or accepting a task',
    (kind) => {
      const s = state();
      if (kind === 'unknown') s.xidStatus = null;
      if (kind === 'consumed') s.anchors[1].state = 'committed';
      if (kind === 'missing') s.anchors.pop();
      if (kind === 'xmin') s.anchors[0].xmin = '159309';
      if (kind === 'job') s.counts.newJobs = 1;
      if (kind === 'binding') s.counts.bindings = 10000;
      if (kind === 'ledger') s.counts.ledger = 7999;
      expect(() => assertR5Prepared240State(s)).toThrow();
    },
  );
});
