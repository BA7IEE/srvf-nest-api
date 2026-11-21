import { currentMigrationInventory } from '../../test/helpers/migration-inventory';
import {
  assertCurrentTestTablePolicies,
  assertFixtureTruncateTriggers,
  assertTestTableManifest,
  CURRENT_TEST_TABLE_POLICIES,
  testTableNames,
} from '../../test/helpers/test-table-policy';

const policy = CURRENT_TEST_TABLE_POLICIES[0];
const triggerPairs = [
  { table: 'TeamJoinContributionMilestone', trigger: 'team_join_milestone_no_truncate' },
  { table: 'CorrectionWritePhase', trigger: 'r5_phase_no_truncate' },
];

describe('current test table policy (no database)', () => {
  it('accepts the declared additive policy without changing historical profiles', () => {
    expect(() => assertCurrentTestTablePolicies(CURRENT_TEST_TABLE_POLICIES)).not.toThrow();
    expect(testTableNames('current155')).toHaveLength(199);
    expect(testTableNames('pre155')).not.toContain('CorrectionWritePhase');
    expect(testTableNames('pre155')).not.toContain('CorrectionApprovedInputItem');
    expect(testTableNames('pre155')).toHaveLength(197);
    const current = testTableNames();
    expect(current).toHaveLength(200);
    expect(current).toContain(policy.table);
    expect(new Set(current).size).toBe(current.length);
    expect(current).toEqual([...current].sort());
    expect(() => testTableNames('pre154' as never)).toThrow('R5_TABLE_PROFILE_REFUSED');
  });

  it('binds the declared table to a registered migration source', () => {
    expect(currentMigrationInventory().names).toContain(policy.sourceMigration);
    expect(policy.profiles).toEqual(['current']);
    expect(policy.rollback).toBe('all-rows-and-columns');
  });

  it.each([
    { name: 'empty list', value: [] },
    {
      name: 'duplicate table',
      value: [policy, { ...policy, cleanup: { ...policy.cleanup } }],
    },
    {
      name: 'table already in the frozen manifest',
      value: [{ ...policy, table: 'Activity' }],
    },
    {
      name: 'unregistered source migration',
      value: [{ ...policy, sourceMigration: '20990101000000_unregistered' }],
    },
    { name: 'non-current profile', value: [{ ...policy, profiles: ['current155'] }] },
    {
      name: 'widened profile list',
      value: [{ ...policy, profiles: ['current', 'current155'] }],
    },
    { name: 'missing rollback', value: [{ ...policy, rollback: undefined }] },
    { name: 'extra field', value: [{ ...policy, note: 'loose' }] },
    {
      name: 'cascade root not in frozen set',
      value: [{ ...policy, cleanup: { ...policy.cleanup, cascadeFrom: 'unreviewed_parent' } }],
    },
    {
      name: 'migration ledger as cascade root',
      value: [{ ...policy, cleanup: { ...policy.cleanup, cascadeFrom: '_prisma_migrations' } }],
    },
    {
      name: 'unsafe identifier',
      value: [{ ...policy, table: 'x;DROP TABLE users' }],
    },
    { name: 'null entry', value: [null] },
  ])('rejects $name declarations', ({ value }) => {
    expect(() => assertCurrentTestTablePolicies(value)).toThrow('TEST_TABLE_POLICY_INVALID');
  });

  it.each([
    { name: 'empty list', value: [] },
    {
      name: 'declared table missing its trigger',
      value: triggerPairs.filter(({ table }) => table !== policy.table),
    },
    {
      name: 'duplicate table',
      value: [...triggerPairs, { ...triggerPairs[1] }],
    },
    {
      name: 'duplicate trigger on different tables',
      value: [
        ...triggerPairs,
        { table: 'CorrectionApprovedInputItem', trigger: triggerPairs[1].trigger },
      ],
    },
    {
      name: 'table outside the approved set',
      value: [...triggerPairs, { table: 'unreviewed_table', trigger: 'x' }],
    },
    {
      name: 'migration ledger trigger',
      value: [...triggerPairs, { table: '_prisma_migrations', trigger: 'x' }],
    },
    {
      name: 'extra field',
      value: [...triggerPairs, { ...triggerPairs[0], note: 'loose' }],
    },
    { name: 'null entry', value: [...triggerPairs, null] },
  ])('rejects fixture trigger descriptors with $name', ({ value }) => {
    expect(() => assertFixtureTruncateTriggers(value)).toThrow('FIXTURE_TRIGGER_POLICY');
  });

  it('matches declared physical sets exactly and refuses unknown, missing or duplicated tables', () => {
    const approved = testTableNames();
    expect(() => assertTestTableManifest(approved)).not.toThrow();
    expect(() => assertTestTableManifest(approved.slice(1))).toThrow();
    expect(() => assertTestTableManifest([...approved, 'unreviewed'])).toThrow();
    expect(() => assertTestTableManifest([...approved, approved[0]])).toThrow(
      'duplicate table names are invalid',
    );
    expect(() => assertTestTableManifest(approved, 'current155')).toThrow();
    expect(() =>
      assertTestTableManifest(
        approved.filter((name) => name !== policy.table),
        'current155',
      ),
    ).not.toThrow();
  });
});
