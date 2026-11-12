import { readPostedParticipationFactsInTx } from './activity-participation-projection-query';

const anchor = (overrides: Record<string, unknown> = {}) => ({
  activityId: 'a1',
  currentPostedVersion: 2,
  versionId: 'v2',
  expectedCount: 1,
  batchId: 'b2',
  resultId: 'r1',
  identityId: 'i1',
  resultCode: 'present',
  identityActivityId: 'a1',
  ...overrides,
});
const identity = (overrides: Record<string, unknown> = {}) => ({
  id: 'i1',
  activityId: 'a1',
  sessionId: 's1',
  memberId: 'm1',
  registrationId: 'reg1',
  currentRevision: 1,
  currentStatusCode: 'pass',
  populationIncluded: true,
  revisions: [{ revision: 1, statusCode: 'pass', sourceCode: 'onsite' }],
  member: { memberNo: 'M1', realName: '成员', nickname: null },
  registration: { deletedAt: null },
  ...overrides,
});
function fixture(rows: unknown[], identities: unknown[]) {
  const queryRaw = jest.fn().mockResolvedValue(rows);
  const findMany = jest.fn().mockResolvedValue(identities);
  return {
    tx: { $queryRaw: queryRaw, activityParticipationIdentity: { findMany } },
    queryRaw,
    findMany,
  };
}

describe('current posted participation snapshot reader', () => {
  it('reads current committed result even with zero ledger rows and retains identities added later', async () => {
    const f = fixture(
      [anchor()],
      [identity(), identity({ id: 'i2', sessionId: 's2', currentRevision: 0, revisions: [] })],
    );
    const facts = await readPostedParticipationFactsInTx(f.tx as never, ['a1']);
    expect(facts.map((row) => [row.identityId, row.resultCode])).toEqual([
      ['i1', 'present'],
      ['i2', null],
    ]);
    const [query] = f.queryRaw.mock.calls[0] as [{ sql: string; values: unknown[] }];
    expect(query.sql).toContain('r."currentPostedVersion" = v.version');
    expect(query.sql).toContain('b."statusCode" = \'committed\'');
    expect(query.sql).toContain('rr."statusCode" = \'committed\'');
    expect(query.sql).not.toContain('ParticipationLedgerEntry');
    expect(query.sql).not.toContain('ActivitySettlementClosureRevision');
    expect(query.sql).not.toMatch(/(?<![a-z])r\."statusCode"\s*=/u);
    expect(query.values).toEqual(['a1']);
    expect(f.findMany).toHaveBeenCalledTimes(1);
  });

  it('retains a missing posted pointer as undecided rather than inventing absence', async () => {
    const f = fixture(
      [
        anchor({
          currentPostedVersion: null,
          versionId: null,
          expectedCount: null,
          batchId: null,
          resultId: null,
          identityId: null,
          resultCode: null,
          identityActivityId: null,
        }),
      ],
      [identity()],
    );
    expect(
      (await readPostedParticipationFactsInTx(f.tx as never, ['a1']))[0].resultCode,
    ).toBeNull();
  });

  it.each([
    ['missing version', anchor({ versionId: null })],
    ['missing batch', anchor({ batchId: null })],
    ['wrong activity', anchor({ identityActivityId: 'a2' })],
    [
      'missing result',
      anchor({ resultId: null, identityId: null, resultCode: null, identityActivityId: null }),
    ],
    ['missing identity', anchor({ identityId: 'missing' })],
  ])('fails closed on %s', async (_label, row) => {
    const f = fixture([row], [identity()]);
    await expect(readPostedParticipationFactsInTx(f.tx as never, ['a1'])).rejects.toThrow();
  });

  it('fails closed when an authorized requested activity is missing or a result is duplicated', async () => {
    await expect(
      readPostedParticipationFactsInTx(fixture([], []).tx as never, ['a1']),
    ).rejects.toThrow();
    await expect(
      readPostedParticipationFactsInTx(fixture([anchor(), anchor()], [identity()]).tx as never, [
        'a1',
      ]),
    ).rejects.toThrow();
  });

  it.each([0, 2])(
    'rejects revision pointer %s when only revision 1 exists',
    async (currentRevision) => {
      const f = fixture([anchor()], [identity({ currentRevision })]);
      await expect(readPostedParticipationFactsInTx(f.tx as never, ['a1'])).rejects.toThrow(
        'revision pointer',
      );
    },
  );

  it('does not issue a query for an empty activity set', async () => {
    const f = fixture([], []);
    await expect(readPostedParticipationFactsInTx(f.tx as never, [])).resolves.toEqual([]);
    expect(f.queryRaw).not.toHaveBeenCalled();
    expect(f.findMany).not.toHaveBeenCalled();
  });
});
