import { ActivityContributionSettlementService } from '../modules/activities/activity-contribution-settlement.service';
import { ActivityTimeSettlementQueryService } from '../modules/activities/activity-time-settlement-query.service';
import { ActivityTimeSettlementService } from '../modules/activities/activity-time-settlement.service';
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

  it('binds the actual C3 service seams without inspecting a client or invoking a service', () => {
    const time = Object.create(ActivityTimeSettlementService.prototype) as object;
    const queries = Object.create(ActivityTimeSettlementQueryService.prototype) as object;
    const contributions = Object.create(ActivityContributionSettlementService.prototype) as object;
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
      'C3_PREPARE',
    );
    expect(Reflect.get(time, 'receipt')).not.toBe(original);
    diagnostic.restore();
    expect(Reflect.get(time, 'receipt')).toBe(original);
    expect(Object.hasOwn(time, 'receipt')).toBe(false);
    expect(clientReads).toBe(0);
  });
});
