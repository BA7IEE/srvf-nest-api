import { ParticipationTimeProofPresenter } from './participation-time-proof.presenter';

const truth = {
  receipt: {
    id: 'activity-time-v1' as const,
    operationKey: 'op',
    deployedMainSha: 'a'.repeat(40),
    evidenceBundleHash: 'b'.repeat(64),
    actorUserId: 'actor',
    cutoverAt: '2099-09-21T00:00:00.000Z',
    formatVersion: 1 as const,
    contentHash: 'c'.repeat(64),
    replayed: false,
  },
  asOf: '2099-09-21T01:00:00.000Z',
  items: [
    {
      ledgerDate: '2099-09-20',
      activityId: 'a1',
      rootManifestId: null,
      participationIdentityId: 'p1',
      sourceCategoryCode: 'legacy_recognized_service' as const,
      sourceEntryId: 'e1',
      latestCorrectionManifestId: null,
      sourceMode: 'legacy_ledger' as const,
      recognizedSeconds: 3600,
    },
    {
      ledgerDate: '2099-09-21',
      activityId: 'a2',
      rootManifestId: 'root',
      participationIdentityId: 'p1',
      sourceCategoryCode: 'volunteer_service' as const,
      sourceEntryId: 'e2',
      latestCorrectionManifestId: 'correction',
      sourceMode: 'classified_time_ledger' as const,
      recognizedSeconds: 1800,
    },
    {
      ledgerDate: '2099-09-21',
      activityId: 'a2',
      rootManifestId: 'root',
      participationIdentityId: 'p1',
      sourceCategoryCode: 'training' as const,
      sourceEntryId: 'e3',
      latestCorrectionManifestId: 'correction',
      sourceMode: 'classified_time_ledger' as const,
      recognizedSeconds: 900,
    },
    {
      ledgerDate: '2099-09-21',
      activityId: 'a2',
      rootManifestId: 'root',
      participationIdentityId: 'p1',
      sourceCategoryCode: 'organization' as const,
      sourceEntryId: 'e4',
      latestCorrectionManifestId: null,
      sourceMode: 'classified_time_ledger' as const,
      recognizedSeconds: 600,
    },
    {
      ledgerDate: '2099-09-21',
      activityId: 'a2',
      rootManifestId: 'root',
      participationIdentityId: 'p1',
      sourceCategoryCode: 'non_creditable' as const,
      sourceEntryId: 'e5',
      latestCorrectionManifestId: null,
      sourceMode: 'classified_time_ledger' as const,
      recognizedSeconds: 300,
    },
  ],
};

describe('D8-1 proof presenter', () => {
  it('keeps full-set totals/hash independent of the selected page', () => {
    const presenter = new ParticipationTimeProofPresenter();
    const first = presenter.present({
      memberId: 'member',
      dateFrom: '2099-01-01',
      dateTo: '2099-12-31',
      page: 1,
      pageSize: 1,
      truth,
    });
    const second = presenter.present({
      memberId: 'member',
      dateFrom: '2099-01-01',
      dateTo: '2099-12-31',
      page: 2,
      pageSize: 1,
      truth,
    });
    expect(first.proofSetHash).toBe(second.proofSetHash);
    expect(first.items).not.toEqual(second.items);
    expect(first).toMatchObject({
      legacyRecognizedSeconds: 3600,
      volunteerServiceSeconds: 1800,
      trainingSeconds: 900,
      organizationSeconds: 600,
      nonCreditableSeconds: 300,
      eligibleServiceSeconds: 5400,
      total: 5,
      isPubliclyVerifiable: false,
    });
  });
});
