import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertCapacityAdmission,
  capacityClock,
  capacityConfig,
  claimCapacityAttempt,
  capacityHash,
  R5_CAPACITY_PINS,
  type CapacityConfig,
  type CapacityComponentResult,
} from './r5-setmat-capacity.protocol';
import {
  assertCapacityBags,
  assertCapacityCensusDelta,
  type CapacityBag,
} from './r5-setmat-capacity-projection';
import {
  capacityMethod,
  capacityTerminalReceipt,
  capacityDiagnostics,
} from './r5-setmat-capacity.measurement';

describe('capacity actual error boundaries (NO DATABASE)', () => {
  it('installs the profile on actual service instances and restores after the native closed-gate rejection without SQL', async () => {
    const { PrismaService } = await import('../../src/database/prisma.service');
    const { ActivityWorkflowGate } =
      await import('../../src/common/activity-workflow/activity-workflow.gate');
    const { ActivityTimeSettlementService: Time } =
      await import('../../src/modules/activities/activity-time-settlement.service');
    const { ActivityTimeSettlementQueryService: TimeQuery } =
      await import('../../src/modules/activities/activity-time-settlement-query.service');
    const { ActivityContributionSettlementService: Contribution } =
      await import('../../src/modules/activities/activity-contribution-settlement.service');
    const { ActivityContributionSettlementQueryService: ContributionQuery } =
      await import('../../src/modules/activities/activity-contribution-settlement-query.service');
    const { ActivityTimeSettlementAccessService: Access } =
      await import('../../src/modules/activities/activity-time-settlement-access.service');
    const { ActivityTimeSettlementAuditRecorder: Audit } =
      await import('../../src/modules/activities/activity-time-settlement-audit-recorder');
    const { installR5MainPrepareProfile } = await import('./r5-main-prepare-profile');
    const { BizCode } = await import('../../src/common/exceptions/biz-code.constant');
    const db = new PrismaService({ datasourceUrl: 'postgresql://pure@127.0.0.1:1/not_connected' });
    const gate = Reflect.construct(ActivityWorkflowGate, [
      { activityV11Workflow: { enabled: false, readonlyMaintenance: false } },
    ]);
    const access = Reflect.construct(Access, []);
    const audit = Reflect.construct(Audit, []);
    const contributionQueries = Reflect.construct(ContributionQuery, []);
    const contributions = Reflect.construct(Contribution, [
      { env: 'test', contributionSettlementMode: 'active' },
      contributionQueries,
      gate,
    ]);
    const timeQueries = Reflect.construct(TimeQuery, [db, access, undefined, contributionQueries]);
    const timeSettlement = Reflect.construct(Time, [
      db,
      access,
      timeQueries,
      undefined,
      undefined,
      undefined,
      audit,
      gate,
      contributions,
    ]);
    const engine: unknown = Reflect.get(db, '_engine');
    assert(engine && typeof engine === 'object');
    const descriptors = [
      Object.getOwnPropertyDescriptor(timeSettlement, 'prepare'),
      Object.getOwnPropertyDescriptor(db, '$transaction'),
      Object.getOwnPropertyDescriptor(engine, 'transaction'),
    ];
    const requestSpy = jest
      .spyOn(engine as { request: () => Promise<unknown> }, 'request')
      .mockRejectedValue(new Error('pure SQL forbidden'));
    const connectSpy = jest
      .spyOn(db, '$connect')
      .mockRejectedValue(new Error('pure connect forbidden'));
    const observe = jest.fn(() => Promise.reject(new Error('pure observer must not query')));
    const rows: unknown[] = [];
    const profile = installR5MainPrepareProfile(
      {
        prisma: db,
        timeSettlement,
        timeQueries,
        contributions,
        contributionQueries,
        access,
        audit,
      },
      {
        activityId: 'pure-actual-profile',
        persist: (v) => {
          rows.push(v);
          return 'pure';
        },
        observeOutcome: observe,
      },
    );
    try {
      const method: unknown = Reflect.get(timeSettlement, 'prepare');
      assert(typeof method === 'function');
      const pending: unknown = Reflect.apply(method, timeSettlement, ['pure-actual-profile']);
      assert(pending instanceof Promise);
      expect(() => profile.restore()).toThrow('still active');
      await expect(pending).rejects.toMatchObject({
        biz: BizCode.ACTIVITY_V11_WORKFLOW_NOT_ENABLED,
      });
      expect(profile.snapshot().consumed).toBe(true);
      expect(profile.snapshot().complete).toBe(false);
      expect(profile.snapshot().transactions).toHaveLength(0);
      expect(observe).not.toHaveBeenCalled();
      expect(requestSpy).not.toHaveBeenCalled();
      expect(connectSpy).not.toHaveBeenCalled();
      expect(rows).toHaveLength(1);
    } finally {
      profile.restore();
      requestSpy.mockRestore();
      connectSpy.mockRestore();
      await db.$disconnect();
    }
    expect(Object.getOwnPropertyDescriptor(timeSettlement, 'prepare')).toEqual(descriptors[0]);
    expect(Object.getOwnPropertyDescriptor(db, '$transaction')).toEqual(descriptors[1]);
    expect(Object.getOwnPropertyDescriptor(engine, 'transaction')).toEqual(descriptors[2]);
  });

  it('preserves a rejection from an actual Prisma engine object and all sanitized native causes', async () => {
    const { Prisma } = await import('@prisma/client');
    const { PrismaService } = await import('../../src/database/prisma.service');
    const db = new PrismaService({ datasourceUrl: 'postgresql://pure@127.0.0.1:1/not_connected' });
    const engine: unknown = Reflect.get(db, '_engine');
    assert(engine && typeof engine === 'object');
    const descriptor = Object.getOwnPropertyDescriptor(engine, 'request');
    const secret = 'pure-credential-not-real';
    const failure = new Prisma.PrismaClientKnownRequestError(
      'pure postgres://pure:password@localhost/pure ' + secret,
      {
        code: 'P2028',
        clientVersion: '6.19.3',
        meta: { code: '57014', parameters: secret },
      },
    );
    Object.defineProperty(failure, 'cause', {
      value: new AggregateError([new Error(secret)], 'pure cause'),
    });
    const rows: unknown[] = [];
    const diagnostic = capacityDiagnostics(
      (v) => {
        rows.push(v);
        return 'pure';
      },
      () => 'PURE_PREPARE',
      () => [secret],
    );
    const spy = jest
      .spyOn(engine as { request: () => Promise<unknown> }, 'request')
      .mockRejectedValue(failure);
    try {
      const requestMethod: unknown = Reflect.get(engine, 'request');
      assert(typeof requestMethod === 'function');
      await expect(
        diagnostic.run('PURE_REAL_ENGINE', () => {
          const value: unknown = Reflect.apply(requestMethod, engine, []);
          assert(value instanceof Promise);
          return value;
        }),
      ).rejects.toBe(failure);
      const encoded = JSON.stringify(rows);
      expect(encoded).toContain('P2028');
      expect(encoded).toContain('57014');
      expect(encoded).toContain('stack');
      expect(encoded).toContain('pure cause');
      expect(encoded).not.toContain(secret);
      expect(encoded).not.toContain('postgres://');
      expect(encoded).not.toContain('parameters');
      diagnostic.assertHealthy();
    } finally {
      spy.mockRestore();
      await db.$disconnect();
    }
    expect(Object.getOwnPropertyDescriptor(engine, 'request')).toEqual(descriptor);
  });

  it('keeps the original failure when real receipt storage fails and prevents a success result', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'r5-capacity-write-fault-'));
    const fallback: string[] = [];
    const original = new Error('pure original prepare rejection');
    const diagnostic = capacityDiagnostics(
      () => {
        writeFileSync(dir, 'invalid-file');
        return 'unreachable';
      },
      () => 'PURE',
      () => [],
      (v) => {
        fallback.push(v);
      },
    );
    await expect(diagnostic.run('PURE_WRITE_FAULT', () => Promise.reject(original))).rejects.toBe(
      original,
    );
    expect(fallback.join('')).toContain('CAPACITY_DIAGNOSTIC_WRITE_FAILED');
    expect(fallback.join('')).toContain('pure original prepare rejection');
    expect(() => diagnostic.assertHealthy()).toThrow();
  });

  it('retains full nonsecret HTTP failure fields and still rejects every bad response', () => {
    const rows: unknown[] = [];
    const diagnostic = capacityDiagnostics(
      (v) => {
        rows.push(v);
        return 'pure';
      },
      () => 'MAIN_PREPARE',
      () => ['pure-secret-value'],
    );
    const response = {
      status: 500,
      body: {
        code: 50000,
        message: 'pure-secret-value',
        detail: { phase: 'prepare', sqlState: '57014' },
        data: { accessToken: 'never-save-token' },
      },
    };
    expect(() => diagnostic.http(response, '/time-settlement/prepare')).toThrow(
      'NATIVE_CAPACITY_HTTP_500_50000',
    );
    const encoded = JSON.stringify(rows);
    expect(encoded).toContain('57014');
    expect(encoded).toContain('/time-settlement/prepare');
    expect(encoded).not.toContain('pure-secret-value');
    expect(encoded).not.toContain('never-save-token');
    expect(response.body.message).toBe('pure-secret-value');
    expect(() => diagnostic.http({ status: 200, body: { code: 123 } }, 'pure')).toThrow();
    expect(() => diagnostic.http({ status: 200, body: { code: 0 } }, 'pure')).not.toThrow();
  });

  it('observes the actual Nest filter before its unchanged Express mapping and restores its descriptor', async () => {
    const local = createRequire(__filename);
    const express = createRequire(local.resolve('@nestjs/platform-express'))(
      'express',
    ) as typeof import('express');
    const request = (await import('supertest')).default;
    const { ExecutionContextHost } = await import('@nestjs/core/helpers/execution-context-host');
    const { Logger } = await import('@nestjs/common');
    const { AllExceptionsFilter } = await import('../../src/common/filters/all-exceptions.filter');
    const descriptor = Object.getOwnPropertyDescriptor(AllExceptionsFilter.prototype, 'catch');
    const rows: unknown[] = [];
    const diagnostic = capacityDiagnostics(
      (v) => {
        rows.push(v);
        return 'pure';
      },
      () => 'PURE_HTTP',
      () => [],
    );
    const restore = diagnostic.filter(AllExceptionsFilter.prototype, () => true);
    const quiet = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      const filter = new AllExceptionsFilter(false);
      const failure = Object.assign(new Error('pure native rejection'), {
        code: 'P2028',
        cause: new Error('pure nested cause'),
      });
      const app = express();
      app.get('/pure', (req, res) => filter.catch(failure, new ExecutionContextHost([req, res])));
      const reply = await request(app).get('/pure');
      expect(reply.status).toBe(500);
      expect(reply.body.code).toBe(50000);
      expect(reply.body.message).toBe('pure native rejection');
      expect(JSON.stringify(rows)).toContain('NATIVE_EXCEPTION_BEFORE_MAPPING');
      expect(JSON.stringify(rows)).toContain('pure nested cause');
    } finally {
      restore();
      quiet.mockRestore();
    }
    expect(Object.getOwnPropertyDescriptor(AllExceptionsFilter.prototype, 'catch')).toEqual(
      descriptor,
    );
  });
});

const start = Date.parse('2026-10-30T02:00:00Z');
const config: CapacityConfig = {
  schema: 'srvf-r5-capacity/v1',
  mode: 'component1000',
  base: {
    schema: 'srvf-r5-setmat-safety/v1',
    databaseOid: 1998913,
    creatorUserId: 'creator',
    reviewerUserId: 'A',
    finalReviewerUserId: 'B',
    organizationId: 'org',
    expectedCatalogPath: '/pure/expected.json',
    expectedCatalogSha256: R5_CAPACITY_PINS.catalog,
    boundPreflightBodySha256: R5_CAPACITY_PINS.body,
    catalogQueryPath: '/pure/query.sql',
    catalogQuerySha256: R5_CAPACITY_PINS.query,
    outputDirectory: '/pure/consumed-safety',
  },
  outputDirectory: '/pure/unique-capacity',
  dispatchFile: '/pure/new-coordinator-dispatch.json',
  window: {
    id: 'coordinator-new-phase',
    startedAt: new Date(start).toISOString(),
    deadline: new Date(start + 1800000).toISOString(),
    dispatchReference: 'new explicit coordinator dispatch',
    previousWindow: 'SIX_SAFETY_PASS_CAPACITY_NOT_RUN',
  },
  safetyControl: {
    handoffLibraryId: R5_CAPACITY_PINS.handoff,
    actualCommitMaxMs: 36.51422900002217,
    sourceReceiptSha256: '58fb014ab799a72c3627547448a25faa5c57a539626f861157243b7a4052f14b',
    actualCommitSamples: 3,
    coverage: 'EARLY_OPEN_REJECT_NOT_LATE_PAUSE',
  },
};
const component: CapacityComponentResult = {
  schema: 'srvf-r5-capacity-component/v1',
  outcome: 'PASS',
  pins: R5_CAPACITY_PINS,
  runId: 'new-run',
  sourceCount: 10000,
  delta: 1000,
  bindingCount: 10000,
  referenceMs: 100,
  candidateMs: 70,
  ledgerAuditTailMs: 600,
  callbackElapsedMs: 1000,
  databaseOutcome: 'ROLLED_BACK',
  fullManifestRollback: true,
  exactBagParity: true,
  includedLedgerAudit: true,
  includedDeferredTerminalChecks: false,
  includedRealCommit: false,
};
const bytes = Buffer.from(JSON.stringify(component));
const admission = {
  schema: 'srvf-r5-capacity-admission/v1',
  componentSha256: capacityHash(bytes),
  decision: 'ONE_FRESH_FULL_REAL_MEASUREMENT',
  rationale: 'Coordinator explicitly accepts measuring unknown large commit costs once.',
  unknownLargeCommitTailAcknowledged: true,
};

describe('R5 capacity admission and execution seams (NO DATABASE)', () => {
  it('accepts the pinned source configuration without opening a connection', () => {
    expect(capacityConfig(config, start + 1)).toBe(config);
  });
  it('rejects the historical control after current-source safety is qualified', () => {
    expect(() =>
      capacityConfig(
        {
          ...config,
          safetyControl: {
            ...config.safetyControl,
            handoffLibraryId: 'libfile_561ac111ac04819190e51f79bf568c16',
            actualCommitMaxMs: 32.133268000005046,
            sourceReceiptSha256: '31059dfbcc81b20dd3b0db7fa29ba6f66cfcd469382f325c951fe9a7e8e9c93b',
          },
        },
        start + 1,
      ),
    ).toThrow();
  });
  it.each([
    'databaseOid',
    'expectedCatalogSha256',
    'boundPreflightBodySha256',
    'catalogQuerySha256',
  ] as const)('rejects a different installed %s', (key) => {
    const base = { ...config.base };
    Object.assign(base, { [key]: key === 'databaseOid' ? 1971161 : 'a'.repeat(64) });
    expect(() => capacityConfig({ ...config, base }, start + 1)).toThrow();
  });
  it.each([
    'actualCommitMaxMs',
    'sourceReceiptSha256',
    'actualCommitSamples',
    'handoffLibraryId',
    'coverage',
  ] as const)('rejects unbound safety evidence %s', (key) => {
    const control = { ...config.safetyControl };
    Object.assign(control, { [key]: 'unbound' });
    expect(() => capacityConfig({ ...config, safetyControl: control }, start + 1)).toThrow();
  });
  it('requires an explicit new dispatch rather than relabeling the old window', () => {
    const w = {
      ...config.window,
      startedAt: R5_CAPACITY_PINS.originalWindowStart,
      deadline: R5_CAPACITY_PINS.originalDeadline,
    };
    expect(() => capacityClock({ ...config, window: w }, Date.parse(w.startedAt) + 1)).toThrow();
  });
  it('refuses expiration before the next native operation', () => {
    expect(() => capacityClock(config, start + 1800000)).toThrow();
  });
  it('refuses insufficient time for the next operation', () => {
    expect(() => capacityClock(config, start + 1790000, 120000)).toThrow();
  });
  it('refuses starting before the explicit phase', () => {
    expect(() => capacityClock(config, start - 1)).toThrow();
  });
  it('does not increase the total1800s window', () => {
    expect(() =>
      capacityClock(
        {
          ...config,
          window: { ...config.window, deadline: new Date(start + 1800001).toISOString() },
        },
        start + 1,
      ),
    ).toThrow();
  });
  it('requires a coordinator dispatch reference', () => {
    expect(() =>
      capacityClock({ ...config, window: { ...config.window, dispatchReference: '' } }, start + 1),
    ).toThrow();
  });
  it('admits only an independently rolled-back full1000 component with explicit unknown-tail decision', () => {
    expect(() =>
      assertCapacityAdmission(component, admission, bytes, 32.133268000005046),
    ).not.toThrow();
  });
  it.each([
    { referenceMs: 0 },
    { candidateMs: 81 },
    { bindingCount: 1000 },
    { sourceCount: 1000 },
    { delta: 1 },
    { databaseOutcome: 'UNKNOWN' },
    { databaseOutcome: 'COMMITTED' },
    { fullManifestRollback: false },
    { exactBagParity: false },
    { includedLedgerAudit: false },
    { includedDeferredTerminalChecks: true },
    { includedRealCommit: true },
    { callbackElapsedMs: 11990 },
    { callbackElapsedMs: NaN },
  ])('blocks scaling on invalid component evidence %j', (change) => {
    const input = { ...component };
    Object.assign(input, change);
    expect(() => assertCapacityAdmission(input, admission, bytes, 32.133268000005046)).toThrow();
  });
  it('does not accept a changed candidate version', () => {
    const pins = { ...component.pins };
    Object.assign(pins, { body: 'a'.repeat(64) });
    expect(() =>
      assertCapacityAdmission({ ...component, pins }, admission, bytes, 32.133268000005046),
    ).toThrow();
  });
  it.each([
    { componentSha256: 'a'.repeat(64) },
    { decision: 'AUTO_SCALE' },
    { rationale: 'yes' },
    { unknownLargeCommitTailAcknowledged: false },
  ])('rejects incomplete admission %j', (change) => {
    expect(() =>
      assertCapacityAdmission(component, { ...admission, ...change }, bytes, 32.133268000005046),
    ).toThrow();
  });
  const bags: CapacityBag[] = [
    ['allocation', 1000],
    ['baseSegment', 1000],
    ['binding', 10000],
    ['evidence', 1000],
    ['receipt', 1000],
    ['slice', 5000],
    ['targetSegment', 1000],
  ].map(([kind, count]) => ({ kind: String(kind), count: String(count), hash: 'a'.repeat(64) }));
  it('requires complete10000 bindings when delta is1000', () => {
    expect(() => assertCapacityBags(bags, 1000)).not.toThrow();
  });
  it.each([
    'allocation',
    'baseSegment',
    'binding',
    'evidence',
    'receipt',
    'slice',
    'targetSegment',
  ])('detects multiplicity loss in %s', (kind) => {
    expect(() =>
      assertCapacityBags(
        bags.map((row) =>
          row.kind === kind ? { ...row, count: String(Number(row.count) - 1) } : row,
        ),
        1000,
      ),
    ).toThrow();
  });
  it('rejects missing or duplicate bag kinds', () => {
    expect(() => assertCapacityBags(bags.slice(1), 1000)).toThrow();
    expect(() => assertCapacityBags([...bags, bags[0]], 1000)).toThrow();
  });
  it('counts all fresh-activity rows to reject facts outside pending targets', () => {
    const before = [
      { kind: 'allocation', count: 20000 },
      { kind: 'binding', count: 0 },
      { kind: 'evidence', count: 0 },
      { kind: 'receipt', count: 20000 },
      { kind: 'segment', count: 10000 },
      { kind: 'slice', count: 100000 },
    ];
    const after = [
      { kind: 'allocation', count: 21000 },
      { kind: 'binding', count: 10000 },
      { kind: 'evidence', count: 1000 },
      { kind: 'receipt', count: 21000 },
      { kind: 'segment', count: 11000 },
      { kind: 'slice', count: 105000 },
    ];
    expect(() => assertCapacityCensusDelta(before, after, 1000)).not.toThrow();
    expect(() =>
      assertCapacityCensusDelta(
        before,
        after.map((row) => (row.kind === 'allocation' ? { ...row, count: 21001 } : row)),
        1000,
      ),
    ).toThrow();
  });
  it('restores an instance-local seam and forwards the native receiver/arguments/result', async () => {
    class Native {
      value = 4;
      async method(n: number) {
        return this.value + n;
      }
    }
    const obj = new Native();
    const original: unknown = Reflect.get(obj, 'method');
    const restore = capacityMethod(obj, 'method', async (call, args) => {
      expect(args).toEqual([3]);
      return await call(...args);
    });
    expect(await obj.method(3)).toBe(7);
    restore();
    expect(Reflect.get(obj, 'method')).toBe(original);
  });
  it('propagates native refusal without fallback or retry', async () => {
    const refusal = new Error('original guard refuses');
    const native = jest.fn(async () => {
      throw refusal;
    });
    const object = { method: native };
    const restore = capacityMethod(object, 'method', async (call, args) => await call(...args));
    try {
      await expect(object.method()).rejects.toBe(refusal);
      expect(native).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  });
  it('refuses consuming a dispatch/mode twice even with a fresh output directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'r5-capacity-claim-')),
      dispatchFile = join(dir, 'dispatch.json');
    writeFileSync(dispatchFile, JSON.stringify(config.window), { flag: 'wx' });
    claimCapacityAttempt({ ...config, dispatchFile });
    expect(() =>
      claimCapacityAttempt({
        ...config,
        dispatchFile,
        outputDirectory: join(dir, 'different-new-output'),
      }),
    ).toThrow();
  });
  it('refuses using one component result to admit another full attempt in a new dispatch', () => {
    const dir = mkdtempSync(join(tmpdir(), 'r5-capacity-full-')),
      first = join(dir, 'first.json'),
      second = join(dir, 'second.json');
    for (const p of [first, second])
      writeFileSync(p, JSON.stringify(config.window), { flag: 'wx' });
    const full = {
      ...config,
      mode: 'full10000' as const,
      componentResultPath: join(dir, 'component-RESULT.json'),
    };
    claimCapacityAttempt({ ...full, dispatchFile: first });
    expect(() => claimCapacityAttempt({ ...full, dispatchFile: second })).toThrow();
  });
  it('refuses a configuration clock that differs from the external dispatch record', () => {
    const dir = mkdtempSync(join(tmpdir(), 'r5-capacity-clock-')),
      dispatchFile = join(dir, 'dispatch.json');
    writeFileSync(
      dispatchFile,
      JSON.stringify({ ...config.window, dispatchReference: 'another dispatch' }),
      { flag: 'wx' },
    );
    expect(() => claimCapacityAttempt({ ...config, dispatchFile })).toThrow();
  });
  const terminalReceipt = (terminal: 'commit' | 'rollback') => ({
    entry: { elapsedMs: 125 },
    transactions: [
      {
        callback: terminal === 'commit' ? 'FULFILLED' : 'REJECTED',
        transactionPromise: terminal === 'commit' ? 'FULFILLED' : 'REJECTED',
        callbackStartedMs: 2,
        callbackEndedMs: 100,
        transactionStartedMs: 1,
        transactionSettledMs: 121,
      },
    ],
    engine: {
      status: 'COMPLETE',
      pending: 0,
      phases: [
        { phase: 'start', outcome: 'ok', elapsedMs: 1 },
        { phase: terminal, outcome: 'ok', elapsedMs: 20 },
      ],
    },
    server: [{ status: terminal === 'commit' ? 'committed' : 'aborted' }],
  });
  it.each(['commit', 'rollback'] as const)(
    'requires separate callback/promise/engine/server %s evidence',
    (terminal) => {
      expect(capacityTerminalReceipt(terminalReceipt(terminal), terminal)).toEqual({
        callbackElapsedMs: 98,
        terminalMs: 20,
        transactionPromiseElapsedMs: 120,
        entryElapsedMs: 125,
      });
    },
  );
  it.each([
    { transactions: [] },
    {
      transactions: [
        {
          callback: 'FULFILLED',
          transactionPromise: 'PENDING',
          callbackStartedMs: 2,
          callbackEndedMs: 100,
        },
      ],
    },
    { engine: { status: 'COMPLETE', pending: 0, phases: [] } },
    {
      engine: {
        status: 'COMPLETE',
        pending: 0,
        phases: [
          { phase: 'start', outcome: 'ok' },
          { phase: 'commit', outcome: 'error' },
        ],
      },
    },
    { server: [{ status: 'in progress' }] },
  ])('cannot infer completion from partial terminal receipts %j', (change) => {
    expect(() =>
      capacityTerminalReceipt({ ...terminalReceipt('commit'), ...change }, 'commit'),
    ).toThrow();
  });
});
