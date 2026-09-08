import { assertCleanupTarget, parseCleanupOptions } from '../scripts/cleanup-correction-pending';

const base = [
  '--application-id',
  'fixture-one',
  '--database',
  'app_test_w98',
  '--host',
  'localhost',
];

describe('correction pending cleanup operator arguments', () => {
  it('defaults to preview', () => {
    expect(parseCleanupOptions(base).apply).toBe(false);
  });
  it.each([
    [],
    [...base, '--all'],
    [...base, '--apply'],
    [...base, '--application-id', 'another'],
    ['--application-id', '*', '--database', 'app_test_w98', '--host', 'localhost'],
    [...base, '--authorization-reference', 'https://invalid.test/approval'],
  ])('rejects incomplete, broad or ambiguous arguments: %j', (...argv) => {
    expect(() => parseCleanupOptions(argv)).toThrow();
  });
  it('requires both approval and explicit retention confirmation for apply', () => {
    const args = [...base, '--apply', '--authorization-reference', 'approval-1295'];
    expect(() => parseCleanupOptions(args)).toThrow();
    expect(parseCleanupOptions([...args, '--confirm-no-retention-hold']).apply).toBe(true);
  });
  it('rejects another database without exposing the configured URL', () => {
    const options = parseCleanupOptions(base);
    expect(() =>
      assertCleanupTarget('postgresql://example:private@localhost/other', options),
    ).toThrow('Configured database does not match the explicitly approved target');
  });
});
