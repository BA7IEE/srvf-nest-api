import { E4_PREPARE_PHASES, E4PreparePhaseDiagnostic } from './e4-prepare-phase-diagnostic';

function setup() {
  const targets = E4_PREPARE_PHASES.map((phase) => ({
    phase,
    target: { work: () => Promise.resolve(undefined) },
    method: 'work',
  }));
  let wall = 0;
  return { targets, clock: () => wall++ };
}

describe('E4 process CPU interval observations', () => {
  it('keeps the original Promise while recording cumulative process CPU deltas', async () => {
    const f = setup();
    let counter = 0;
    const result = Promise.resolve(undefined);
    f.targets[0].target.work = () => result;
    const collector = new E4PreparePhaseDiagnostic(f.targets, f.clock, () => ({
      user: ++counter * 10,
      system: counter * 2,
    }));
    collector.begin();
    expect(f.targets[0].target.work()).toBe(result);
    await result;
    collector.finish('FAIL');
    collector.restore();
    expect(collector.snapshot().status).toBe('COMPLETE');
    expect(collector.snapshot().root).toMatchObject({ cpuUserUs: 30, cpuSystemUs: 6 });
    expect(collector.snapshot().phases[0]).toMatchObject({ cpuUserUs: 10, cpuSystemUs: 2 });
    expect(
      collector
        .snapshot()
        .phases.slice(1)
        .every((row) => row.cpuUserUs === 0),
    ).toBe(true);
  });

  it.each([
    () => {
      throw new Error('unrecorded CPU provider payload');
    },
    () => ({ user: Number.NaN, system: 0 }),
    () => ({ user: -1, system: 0 }),
    () => ({ user: 1.5, system: 0 }),
    () => ({ user: 0, system: Number.MAX_SAFE_INTEGER + 1 }),
  ])(
    'marks unavailable/invalid CPU as UNKNOWN without changing the business result',
    async (cpu) => {
      const f = setup();
      const original = Promise.resolve(undefined);
      f.targets[0].target.work = () => original;
      const diagnostic = new E4PreparePhaseDiagnostic(f.targets, f.clock, cpu);
      diagnostic.begin();
      expect(f.targets[0].target.work()).toBe(original);
      await original;
      diagnostic.finish('FAIL');
      diagnostic.restore();
      expect(diagnostic.snapshot().status).toBe('UNKNOWN');
      expect(diagnostic.snapshot().root.cpuUserUs).toBeNull();
      expect(diagnostic.snapshot().root.cpuSystemUs).toBeNull();
      let output = '';
      expect(
        diagnostic.emitTo((value) => {
          output = value;
        }),
      ).toBe(true);
      expect(output).not.toContain('unrecorded CPU provider payload');
    },
  );

  it('rejects a CPU counter regression and preserves the original rejection', async () => {
    const f = setup();
    const failure = new Error('unrecorded business failure');
    const original = Promise.reject(failure);
    f.targets[0].target.work = () => original;
    let reads = 0;
    const diagnostic = new E4PreparePhaseDiagnostic(f.targets, f.clock, () =>
      ++reads === 1 ? { user: 20, system: 10 } : { user: 10, system: 10 },
    );
    diagnostic.begin();
    expect(f.targets[0].target.work()).toBe(original);
    await expect(original).rejects.toBe(failure);
    diagnostic.finish('FAIL');
    diagnostic.restore();
    expect(diagnostic.snapshot().status).toBe('UNKNOWN');
  });
});
