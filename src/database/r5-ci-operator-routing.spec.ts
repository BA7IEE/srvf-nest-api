import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import config from '../../test/jest-e2e.config';
import suites from '../../test/r5-operator-suites.json';
import authenticated from '../../test/r5-authenticated-ci-suites.json';
import authenticatedConfig, {
  R5_HISTORICAL_CAPACITY_TESTS,
} from '../../test/jest-r5-ci-authenticated.config';
import historicalConfig from '../../test/jest-r5-ci-authenticated-historical.config';

describe('R5 operator suites keep explicit configs and complete CI accounting', () => {
  const matchesIgnore = (file: string) =>
    (config.testPathIgnorePatterns ?? []).some((p) =>
      new RegExp(p.replace('<rootDir>', process.cwd())).test(resolve('test/e2e', file)),
    );
  it('routes exactly six existing operator suites, retaining each dedicated config', async () => {
    expect(suites).toHaveLength(6);
    expect(new Set(suites.map((s) => s.file)).size).toBe(6);
    for (const { file, config: dedicated } of suites) {
      expect(existsSync(resolve('test/e2e', file))).toBe(true);
      expect(matchesIgnore(file)).toBe(true);
      const entry = (await import(resolve(dedicated))) as { default: { testRegex: string } };
      expect(resolve('test/e2e', file)).toMatch(new RegExp(entry.default.testRegex));
    }
  });
  it.each([
    ['activity-os-r4-d7-time-correction.e2e-spec.ts', true],
    ['activity-os-r5-e4-contribution-settlement-correction.e2e-spec.ts', true],
    ['activity-os-r5-setmat-concurrency.e2e-spec.ts', false],
    ['activity-os-r5-new-ordinary-regression.e2e-spec.ts', false],
  ] as const)('routes V3 files while retaining ordinary/pure neighbours: %s', (file, dedicated) => {
    expect(matchesIgnore(file)).toBe(dedicated);
    expect(
      resolve('test/e2e', file).match(new RegExp(authenticatedConfig.testRegex as string)) !== null,
    ).toBe(dedicated);
  });
  it('assigns all four complete ordinary V3 files exactly once to required authenticated CI', () => {
    expect(authenticated.map(({ file }) => file).sort()).toEqual([
      'activity-os-r4-d7-time-correction.e2e-spec.ts',
      'activity-os-r5-adv010-contribution-progress.e2e-spec.ts',
      'activity-os-r5-e4-contribution-settlement-correction.e2e-spec.ts',
      'activity-os-r5-native-admission.e2e-spec.ts',
    ]);
    for (const { file, config: dedicated } of authenticated) {
      expect(existsSync(resolve('test/e2e', file))).toBe(true);
      expect(dedicated).toBe('test/jest-r5-ci-authenticated.config.ts');
      expect(matchesIgnore(file)).toBe(true);
      expect(resolve('test/e2e', file)).toMatch(
        new RegExp(authenticatedConfig.testRegex as string),
      );
      expect(suites.some((suite) => suite.file === file)).toBe(false);
    }
    expect(authenticatedConfig.globalSetup).toBeUndefined();
    expect(authenticatedConfig.globalTeardown).toBeUndefined();
    expect(authenticatedConfig.maxWorkers).toBe(1);
  });
  it('keeps the small V3 case in required CI and preserves all three historical cases explicitly', () => {
    const required = new RegExp(authenticatedConfig.testNamePattern!);
    expect(R5_HISTORICAL_CAPACITY_TESTS).toHaveLength(3);
    for (const name of R5_HISTORICAL_CAPACITY_TESTS) expect(required.test(name)).toBe(false);
    expect(
      required.test(
        'active native full capacity: applicable business boundaries, original guards and budgets rejects one-person policy/bytes and approved long-source correction, and completes real unchanged/V3 gate paths',
      ),
    ).toBe(true);
    expect(
      required.test(
        'D7-1 recognition correction real transaction runs the Human V3 write chain against a complete 2000-identity source proof',
      ),
    ).toBe(true);
    expect(
      required.test(
        'D7-1 recognition correction real transaction runs the Human V3 write chain against a complete 100-identity source proof',
      ),
    ).toBe(true);
    expect(historicalConfig.testNamePattern).toBeUndefined();
    expect(resolve('test/e2e/activity-os-r5-native-admission.e2e-spec.ts')).toMatch(
      new RegExp(historicalConfig.testRegex as string),
    );
    expect(historicalConfig.globalSetup).toBeUndefined();
  });
  it('accounts for every disk suite in a regular shard or the exact operator inventory', () => {
    const output = execFileSync(process.execPath, ['scripts/e2e-shard-plan.mjs', '--verify'], {
      encoding: 'utf8',
    });
    expect(output).toContain('每个 spec 恰好落进一片');
    expect(output).toContain('另 6 个专用实验保留独立配置');
  });
  it('preserves historical ordering without returning dedicated suites to ordinary nightly shards', () => {
    execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `
        import assert from 'node:assert/strict';
        import path from 'node:path';
        import { createHash } from 'node:crypto';
        import Sequencer, {
          CONTEXT_ORDER, NIGHTLY_CONTEXT_ORDER, allSpecs, specsFor, shardFor, familyFor, patternFor,
        } from './scripts/e2e-shard-plan.mjs';
        assert.equal(createHash('sha256').update(CONTEXT_ORDER.join('\\n')).digest('hex'),
          'aabcb0685f8bbb6db785a7820d6e737457c733230466a95ddffca6ed3b04ac93');
        assert.deepEqual(NIGHTLY_CONTEXT_ORDER, CONTEXT_ORDER.filter(s => allSpecs().includes(s)));
        assert(!NIGHTLY_CONTEXT_ORDER.includes('test/e2e/activity-os-r4-d7-time-correction.e2e-spec.ts'));
        const groups = [1, 2, 3, 4].map(specsFor);
        assert.deepEqual(groups.flat().sort(), allSpecs());
        assert.equal(new Set(groups.flat()).size, allSpecs().length);
        assert.deepEqual(groups[0], [...NIGHTLY_CONTEXT_ORDER].sort());
        const families = new Map();
        for (const spec of allSpecs().filter(s => !NIGHTLY_CONTEXT_ORDER.includes(s))) {
          const family = familyFor(spec), shard = shardFor(spec);
          if (families.has(family)) assert.equal(shard, families.get(family));
          families.set(family, shard);
          assert(new RegExp(patternFor(shard)).test('/' + spec));
          assert(!new RegExp(patternFor(shard)).test('/' + spec + '/nested.e2e-spec.ts'));
        }
        assert.equal(shardFor('test/e2e/activity-new-feature.e2e-spec.ts'), 2);
        assert.equal(shardFor('test/e2e/new-platform-feature.e2e-spec.ts'), 4);
        assert.throws(() => patternFor(0));
        const tests = NIGHTLY_CONTEXT_ORDER.map(spec => ({path: path.resolve(spec)}));
        const sequencer = new Sequencer();
        assert.deepEqual(sequencer.sort([...tests].reverse()), tests);
        assert.throws(() => sequencer.sort(tests.slice(1)));
        assert.throws(() => sequencer.sort([...tests, tests[0]]));
        assert.throws(() => sequencer.sort([...tests, {path: path.resolve('test/e2e/extra.e2e-spec.ts')}]));
        `,
      ],
      { stdio: 'pipe' },
    );
  });
});
