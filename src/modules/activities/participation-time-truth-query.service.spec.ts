import type { ActivityTimeCutoverReceipt } from '@prisma/client';

import { BizCode } from '../../common/exceptions/biz-code.constant';
import {
  ACTIVITY_TIME_CUTOVER_RECEIPT_ID,
  activityTimeCutoverReceiptHash,
} from './activity-time-cutover-command';
import {
  ParticipationTimeTruthQueryService,
  allocateSecondsByDate,
  eligibleSecondsToServiceHours,
  splitIntervalByBeijingDate,
} from './participation-time-truth-query.service';

function receipt(): ActivityTimeCutoverReceipt {
  const row = {
    id: ACTIVITY_TIME_CUTOVER_RECEIPT_ID,
    operationKey: 'operation',
    requestHash: 'a'.repeat(64),
    deployedMainSha: 'b'.repeat(40),
    evidenceBundleHash: 'c'.repeat(64),
    actorUserId: 'actor',
    cutoverAt: new Date('2099-09-21T00:00:00.000Z'),
    formatVersion: 1,
    contentHash: '',
    createdAt: new Date('2099-09-21T00:00:00.000Z'),
  };
  return { ...row, contentHash: activityTimeCutoverReceiptHash(row) };
}

function classifiedRoots(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    rootEntryId: `root-entry-${index.toString().padStart(5, '0')}`,
    rootManifestId: `root-manifest-${index.toString().padStart(5, '0')}`,
    activityId: 'activity',
    participationIdentityId: `identity-${index.toString().padStart(5, '0')}`,
    memberId: `member-${index.toString().padStart(5, '0')}`,
    categoryCode: 'volunteer_service',
    recognizedSeconds: 1,
  }));
}

function rootSlices(roots: ReturnType<typeof classifiedRoots>) {
  return roots.map((root) => ({
    rootEntryId: root.rootEntryId,
    proofId: null,
    participationIdentityId: root.participationIdentityId,
    sliceId: `slice-${root.rootEntryId}`,
    categoryCode: root.categoryCode,
    startAt: new Date('2099-09-20T16:00:00.000Z'),
    endAt: new Date('2099-09-20T16:00:01.000Z'),
  }));
}

function correctionManifest(
  overrides: Partial<{
    id: string;
    rootManifestId: string;
    predecessorManifestId: string | null;
    sourceProofId: string | null;
    sourceProofHash: string | null;
    contentHash: string;
    receiptContentHash: string | null;
    createdAt: Date;
  }> = {},
) {
  return {
    id: 'correction',
    rootManifestId: 'root-manifest',
    predecessorManifestId: null,
    sourceProofId: null,
    sourceProofHash: null,
    contentHash: 'a'.repeat(64),
    receiptContentHash: 'a'.repeat(64),
    createdAt: new Date('2099-09-21T00:00:00.000Z'),
    ...overrides,
  };
}

describe('D8-1 truth selector', () => {
  it('converts exact eligible seconds to the existing two-decimal service-hours shape', () => {
    expect(eligibleSecondsToServiceHours(5_400).toString()).toBe('1.5');
    expect(eligibleSecondsToServiceHours(18).toString()).toBe('0.01');
    expect(eligibleSecondsToServiceHours(17).toString()).toBe('0');
  });

  it('splits at Beijing midnight and uses deterministic largest remainder', () => {
    const startAt = new Date('2099-09-20T15:59:30.000Z');
    const endAt = new Date('2099-09-20T16:00:30.000Z');
    expect(splitIntervalByBeijingDate(startAt, endAt)).toEqual([
      { ledgerDate: '2099-09-20', milliseconds: 30_000n },
      { ledgerDate: '2099-09-21', milliseconds: 30_000n },
    ]);
    expect(allocateSecondsByDate(61, [{ sliceId: 'slice', startAt, endAt }])).toEqual([
      { ledgerDate: '2099-09-20', recognizedSeconds: 31 },
      { ledgerDate: '2099-09-21', recognizedSeconds: 30 },
    ]);
  });

  it('converts legacy hundredth-hours to exact integer seconds', async () => {
    const tx = {
      activityTimeCutoverReceipt: { findUnique: jest.fn().mockResolvedValue(receipt()) },
      $queryRaw: jest
        .fn()
        .mockResolvedValueOnce([
          {
            ledgerDate: '2099-09-20',
            activityId: 'activity',
            rootManifestId: null,
            participationIdentityId: 'identity',
            sourceEntryId: 'entry',
            recognizedSeconds: 5400n,
          },
        ])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ asOf: new Date('2099-09-21T01:00:00.000Z') }]),
    };
    const service = new ParticipationTimeTruthQueryService();
    await expect(
      service.readMemberTruthInTx(tx as never, {
        memberId: 'member',
        dateFrom: '2099-01-01',
        dateTo: '2099-12-31',
      }),
    ).resolves.toMatchObject({
      items: [
        {
          sourceCategoryCode: 'legacy_recognized_service',
          recognizedSeconds: 5400,
          sourceMode: 'legacy_ledger',
        },
      ],
    });
  });

  it('fails closed before cutover instead of exposing shadow data', async () => {
    const service = new ParticipationTimeTruthQueryService();
    await expect(
      service.readMemberTruthInTx(
        {
          activityTimeCutoverReceipt: { findUnique: jest.fn().mockResolvedValue(null) },
        } as never,
        { memberId: 'member', dateFrom: '2099-01-01', dateTo: '2099-12-31' },
      ),
    ).rejects.toMatchObject({ biz: BizCode.ACTIVITY_TIME_PROOF_UNAVAILABLE });
  });

  it('materializes an uncorrected classified root without treating its null latest manifest as proof-backed', async () => {
    const tx = {
      activityTimeCutoverReceipt: { findUnique: jest.fn().mockResolvedValue(receipt()) },
      $queryRaw: jest
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          {
            rootEntryId: 'root-entry',
            rootManifestId: 'root-manifest',
            activityId: 'activity',
            participationIdentityId: 'identity',
            categoryCode: 'volunteer_service',
            recognizedSeconds: 3600,
          },
        ])
        .mockResolvedValueOnce([{ asOf: new Date('2099-09-21T01:00:00.000Z') }])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          {
            rootEntryId: 'root-entry',
            proofId: null,
            participationIdentityId: 'identity',
            sliceId: 'slice',
            categoryCode: 'volunteer_service',
            startAt: new Date('2099-09-20T16:00:00.000Z'),
            endAt: new Date('2099-09-20T17:00:00.000Z'),
          },
        ]),
    };
    await expect(
      new ParticipationTimeTruthQueryService().readMemberTruthInTx(tx as never, {
        memberId: 'member',
        dateFrom: '2099-01-01',
        dateTo: '2099-12-31',
      }),
    ).resolves.toMatchObject({
      items: [
        {
          ledgerDate: '2099-09-21',
          sourceCategoryCode: 'volunteer_service',
          recognizedSeconds: 3600,
          latestCorrectionManifestId: null,
        },
      ],
    });
  });

  it('validates a legacy-regime D7-1 chain and exposes its latest committed manifest', async () => {
    const tx = {
      activityTimeCutoverReceipt: { findUnique: jest.fn().mockResolvedValue(receipt()) },
      $queryRaw: jest
        .fn()
        .mockResolvedValueOnce([
          {
            ledgerDate: '2099-09-20',
            activityId: 'activity',
            rootManifestId: 'root-manifest',
            participationIdentityId: 'identity',
            sourceEntryId: 'entry',
            recognizedSeconds: 5400n,
          },
        ])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ asOf: new Date('2099-09-21T01:00:00.000Z') }])
        .mockResolvedValueOnce([correctionManifest()]),
    };

    await expect(
      new ParticipationTimeTruthQueryService().readMemberTruthInTx(tx as never, {
        memberId: 'member',
        dateFrom: '2099-01-01',
        dateTo: '2099-12-31',
      }),
    ).resolves.toMatchObject({
      items: [
        {
          sourceMode: 'legacy_ledger',
          rootManifestId: 'root-manifest',
          latestCorrectionManifestId: 'correction',
          recognizedSeconds: 5400,
        },
      ],
    });
  });

  it.each(['missing receipt', 'mismatched receipt', 'forked predecessor chain'])(
    'fails closed for a legacy-regime correction with %s',
    async (failure) => {
      const manifests =
        failure === 'forked predecessor chain'
          ? [
              correctionManifest({ id: 'correction-1' }),
              correctionManifest({
                id: 'correction-2',
                createdAt: new Date('2099-09-21T00:01:00.000Z'),
              }),
            ]
          : [
              correctionManifest({
                receiptContentHash: failure === 'missing receipt' ? null : 'b'.repeat(64),
              }),
            ];
      const tx = {
        activityTimeCutoverReceipt: { findUnique: jest.fn().mockResolvedValue(receipt()) },
        $queryRaw: jest
          .fn()
          .mockResolvedValueOnce([
            {
              ledgerDate: '2099-09-20',
              activityId: 'activity',
              rootManifestId: 'root-manifest',
              participationIdentityId: 'identity',
              sourceEntryId: 'entry',
              recognizedSeconds: 3600n,
            },
          ])
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([{ asOf: new Date('2099-09-21T01:00:00.000Z') }])
          .mockResolvedValueOnce(manifests),
      };

      await expect(
        new ParticipationTimeTruthQueryService().readMemberTruthInTx(tx as never, {
          memberId: 'member',
          dateFrom: '2099-01-01',
          dateTo: '2099-12-31',
        }),
      ).rejects.toMatchObject({ biz: BizCode.ACTIVITY_TIME_PROOF_INVALID });
    },
  );

  it('materializes D7-1 from root slices and D7-2 only from its frozen proof slices', async () => {
    const tx = {
      activityTimeCutoverReceipt: { findUnique: jest.fn().mockResolvedValue(receipt()) },
      $queryRaw: jest
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          {
            rootEntryId: 'root-entry-1',
            rootManifestId: 'root-manifest-1',
            activityId: 'activity-1',
            participationIdentityId: 'identity-1',
            categoryCode: 'volunteer_service',
            recognizedSeconds: 3600,
          },
          {
            rootEntryId: 'root-entry-2',
            rootManifestId: 'root-manifest-2',
            activityId: 'activity-2',
            participationIdentityId: 'identity-2',
            categoryCode: 'training',
            recognizedSeconds: 1800,
          },
        ])
        .mockResolvedValueOnce([{ asOf: new Date('2099-09-21T01:00:00.000Z') }])
        .mockResolvedValueOnce([
          correctionManifest({ id: 'correction-1', rootManifestId: 'root-manifest-1' }),
          correctionManifest({
            id: 'correction-2',
            rootManifestId: 'root-manifest-2',
            sourceProofId: 'proof-2',
            sourceProofHash: 'b'.repeat(64),
          }),
        ])
        .mockResolvedValueOnce([
          {
            manifestId: 'correction-1',
            rootEntryId: 'root-entry-1',
            entryRootManifestId: 'root-manifest-1',
            entryIdentityId: 'identity-1',
            entryCategoryCode: 'volunteer_service',
            entryRecognizedSeconds: 3600,
            participationIdentityId: 'identity-1',
            categoryCode: 'volunteer_service',
            secondsDelta: -3600,
          },
          {
            manifestId: 'correction-1',
            rootEntryId: 'root-entry-1',
            entryRootManifestId: 'root-manifest-1',
            entryIdentityId: 'identity-1',
            entryCategoryCode: 'volunteer_service',
            entryRecognizedSeconds: 3600,
            participationIdentityId: 'identity-1',
            categoryCode: 'volunteer_service',
            secondsDelta: 5400,
          },
          {
            manifestId: 'correction-2',
            rootEntryId: 'root-entry-2',
            entryRootManifestId: 'root-manifest-2',
            entryIdentityId: 'identity-2',
            entryCategoryCode: 'training',
            entryRecognizedSeconds: 1800,
            participationIdentityId: 'identity-2',
            categoryCode: 'training',
            secondsDelta: -1800,
          },
          {
            manifestId: 'correction-2',
            rootEntryId: 'root-entry-2',
            entryRootManifestId: 'root-manifest-2',
            entryIdentityId: 'identity-2',
            entryCategoryCode: 'training',
            entryRecognizedSeconds: 1800,
            participationIdentityId: 'identity-2',
            categoryCode: 'training',
            secondsDelta: 2400,
          },
        ])
        .mockResolvedValueOnce([
          {
            rootEntryId: 'root-entry-1',
            rootManifestId: 'root-manifest-1',
            activityId: 'activity-1',
            participationIdentityId: 'identity-1',
            memberId: 'member',
            categoryCode: 'volunteer_service',
            recognizedSeconds: 3600,
            rootExpectedEntryCount: 1,
          },
          {
            rootEntryId: 'root-entry-2',
            rootManifestId: 'root-manifest-2',
            activityId: 'activity-2',
            participationIdentityId: 'identity-2',
            memberId: 'member',
            categoryCode: 'training',
            recognizedSeconds: 1800,
            rootExpectedEntryCount: 1,
          },
        ])
        .mockResolvedValueOnce([
          {
            rootEntryId: 'root-entry-1',
            proofId: null,
            participationIdentityId: 'identity-1',
            sliceId: 'root-slice-1',
            categoryCode: 'volunteer_service',
            startAt: new Date('2099-09-20T16:00:00.000Z'),
            endAt: new Date('2099-09-20T17:00:00.000Z'),
          },
          {
            rootEntryId: 'root-entry-2',
            proofId: null,
            participationIdentityId: 'identity-2',
            sliceId: 'stale-root-slice-2',
            categoryCode: 'training',
            startAt: new Date('2099-09-20T17:00:00.000Z'),
            endAt: new Date('2099-09-20T18:00:00.000Z'),
          },
        ])
        .mockResolvedValueOnce([
          {
            id: 'proof-2',
            rootManifestId: 'root-manifest-2',
            sourceSetHash: 'b'.repeat(64),
            expectedBindingCount: 1,
            actualBindingCount: 1n,
          },
        ])
        .mockResolvedValueOnce([
          {
            rootEntryId: null,
            proofId: 'proof-2',
            participationIdentityId: 'identity-2',
            sliceId: 'proof-slice-2',
            categoryCode: 'training',
            startAt: new Date('2099-09-20T15:59:30.000Z'),
            endAt: new Date('2099-09-20T16:00:30.000Z'),
          },
        ]),
    };

    const result = await new ParticipationTimeTruthQueryService().readMemberTruthInTx(tx as never, {
      memberId: 'member',
      dateFrom: '2099-01-01',
      dateTo: '2099-12-31',
    });
    expect(result.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ledgerDate: '2099-09-21',
          rootManifestId: 'root-manifest-1',
          latestCorrectionManifestId: 'correction-1',
          sourceCategoryCode: 'volunteer_service',
          recognizedSeconds: 5400,
        }),
        expect.objectContaining({
          ledgerDate: '2099-09-20',
          rootManifestId: 'root-manifest-2',
          latestCorrectionManifestId: 'correction-2',
          sourceCategoryCode: 'training',
          recognizedSeconds: 1200,
        }),
        expect.objectContaining({
          ledgerDate: '2099-09-21',
          rootManifestId: 'root-manifest-2',
          latestCorrectionManifestId: 'correction-2',
          sourceCategoryCode: 'training',
          recognizedSeconds: 1200,
        }),
      ]),
    );
  });

  it('fails closed when a D7-2 proof has no frozen slice instead of falling back to root slices', async () => {
    const tx = {
      activityTimeCutoverReceipt: { findUnique: jest.fn().mockResolvedValue(receipt()) },
      $queryRaw: jest
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          {
            rootEntryId: 'root-entry',
            rootManifestId: 'root-manifest',
            activityId: 'activity',
            participationIdentityId: 'identity',
            categoryCode: 'volunteer_service',
            recognizedSeconds: 3600,
          },
        ])
        .mockResolvedValueOnce([{ asOf: new Date('2099-09-21T01:00:00.000Z') }])
        .mockResolvedValueOnce([
          correctionManifest({
            sourceProofId: 'proof',
            sourceProofHash: 'b'.repeat(64),
          }),
        ])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          {
            rootEntryId: 'root-entry',
            rootManifestId: 'root-manifest',
            activityId: 'activity',
            participationIdentityId: 'identity',
            memberId: 'member',
            categoryCode: 'volunteer_service',
            recognizedSeconds: 3600,
            rootExpectedEntryCount: 1,
          },
        ])
        .mockResolvedValueOnce([
          {
            rootEntryId: 'root-entry',
            proofId: null,
            participationIdentityId: 'identity',
            sliceId: 'root-slice',
            categoryCode: 'volunteer_service',
            startAt: new Date('2099-09-20T16:00:00.000Z'),
            endAt: new Date('2099-09-20T17:00:00.000Z'),
          },
        ])
        .mockResolvedValueOnce([
          {
            id: 'proof',
            rootManifestId: 'root-manifest',
            sourceSetHash: 'b'.repeat(64),
            expectedBindingCount: 1,
            actualBindingCount: 1n,
          },
        ])
        .mockResolvedValueOnce([]),
    };

    await expect(
      new ParticipationTimeTruthQueryService().readMemberTruthInTx(tx as never, {
        memberId: 'member',
        dateFrom: '2099-01-01',
        dateTo: '2099-12-31',
      }),
    ).rejects.toMatchObject({ biz: BizCode.ACTIVITY_TIME_PROOF_INVALID });
  });

  it.each([1, 100, 2_000])(
    'keeps the classified truth query budget constant for %i identities',
    async (count) => {
      const roots = classifiedRoots(count);
      const tx = {
        activityTimeCutoverReceipt: { findUnique: jest.fn().mockResolvedValue(receipt()) },
        $queryRaw: jest
          .fn()
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce(roots)
          .mockResolvedValueOnce([{ asOf: new Date('2099-09-21T01:00:00.000Z') }])
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce(rootSlices(roots)),
      };

      const result = await new ParticipationTimeTruthQueryService().readMemberTruthInTx(
        tx as never,
        { memberId: 'member', dateFrom: '2099-01-01', dateTo: '2099-12-31' },
      );

      expect(result.items).toHaveLength(count);
      expect(tx.$queryRaw).toHaveBeenCalledTimes(5);
    },
  );

  it('accepts an exact 10,000-row proof set with the same fixed query budget', async () => {
    const roots = classifiedRoots(10_000);
    const tx = {
      activityTimeCutoverReceipt: { findUnique: jest.fn().mockResolvedValue(receipt()) },
      $queryRaw: jest
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce(roots)
        .mockResolvedValueOnce([{ asOf: new Date('2099-09-21T01:00:00.000Z') }])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce(rootSlices(roots)),
    };

    const result = await new ParticipationTimeTruthQueryService().readMemberTruthInTx(tx as never, {
      memberId: 'member',
      dateFrom: '2099-01-01',
      dateTo: '2099-12-31',
    });

    expect(result.items).toHaveLength(10_000);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(5);
  });

  it('rejects 10,001 combined legacy and classified rows instead of truncating either regime', async () => {
    const roots = classifiedRoots(10_000);
    const tx = {
      activityTimeCutoverReceipt: { findUnique: jest.fn().mockResolvedValue(receipt()) },
      $queryRaw: jest
        .fn()
        .mockResolvedValueOnce([
          {
            ledgerDate: '2099-09-20',
            activityId: 'legacy-activity',
            rootManifestId: null,
            participationIdentityId: 'legacy-identity',
            sourceEntryId: 'legacy-entry',
            recognizedSeconds: 3600n,
          },
        ])
        .mockResolvedValueOnce(roots)
        .mockResolvedValueOnce([{ asOf: new Date('2099-09-21T01:00:00.000Z') }])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce(rootSlices(roots)),
    };

    await expect(
      new ParticipationTimeTruthQueryService().readMemberTruthInTx(tx as never, {
        memberId: 'member',
        dateFrom: '2099-01-01',
        dateTo: '2099-12-31',
      }),
    ).rejects.toMatchObject({ biz: BizCode.ACTIVITY_TIME_PROOF_SCALE_LIMIT });
  });

  it('rejects an unsafe correction delta accumulation', async () => {
    const roots = classifiedRoots(1).map((root) => ({
      ...root,
      rootEntryId: 'root-entry',
      rootManifestId: 'root-manifest',
      participationIdentityId: 'identity',
      recognizedSeconds: 1,
    }));
    const tx = {
      activityTimeCutoverReceipt: { findUnique: jest.fn().mockResolvedValue(receipt()) },
      $queryRaw: jest
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce(roots)
        .mockResolvedValueOnce([{ asOf: new Date('2099-09-21T01:00:00.000Z') }])
        .mockResolvedValueOnce([correctionManifest()])
        .mockResolvedValueOnce([
          {
            manifestId: 'correction',
            rootEntryId: 'root-entry',
            entryRootManifestId: 'root-manifest',
            entryIdentityId: 'identity',
            entryCategoryCode: 'volunteer_service',
            entryRecognizedSeconds: 1,
            participationIdentityId: 'identity',
            categoryCode: 'volunteer_service',
            secondsDelta: Number.MAX_SAFE_INTEGER,
          },
          {
            manifestId: 'correction',
            rootEntryId: 'root-entry',
            entryRootManifestId: 'root-manifest',
            entryIdentityId: 'identity',
            entryCategoryCode: 'volunteer_service',
            entryRecognizedSeconds: 1,
            participationIdentityId: 'identity',
            categoryCode: 'volunteer_service',
            secondsDelta: 1,
          },
        ])
        .mockResolvedValueOnce(roots.map((root) => ({ ...root, rootExpectedEntryCount: 1 })))
        .mockResolvedValueOnce(rootSlices(roots)),
    };

    await expect(
      new ParticipationTimeTruthQueryService().readMemberTruthInTx(tx as never, {
        memberId: 'member',
        dateFrom: '2099-01-01',
        dateTo: '2099-12-31',
      }),
    ).rejects.toMatchObject({ biz: BizCode.ACTIVITY_TIME_PROOF_INVALID });
  });

  describe('member-scoped corrections for a shared manifest', () => {
    const roots = classifiedRoots(2).map((root) => ({
      ...root,
      rootManifestId: 'root-manifest',
      recognizedSeconds: 100,
    }));
    const manifests = [
      correctionManifest({ id: 'correction-1' }),
      correctionManifest({ id: 'correction-2', predecessorManifestId: 'correction-1' }),
    ];
    const entry = (
      root: (typeof roots)[number],
      manifestId: string,
      secondsDelta: number,
      entryTypeCode: 'reversal' | 'credit',
      reversesCorrectionEntryId: string | null = null,
    ) => ({
      id: `${manifestId}-${root.rootEntryId}-${entryTypeCode}`,
      manifestId,
      rootEntryId: root.rootEntryId,
      participationIdentityId: root.participationIdentityId,
      categoryCode: root.categoryCode,
      entryTypeCode,
      reversesCorrectionEntryId,
      secondsDelta,
      entryRootManifestId: root.rootManifestId as string | null,
      entryIdentityId: root.participationIdentityId as string | null,
      entryCategoryCode: root.categoryCode as string | null,
      entryRecognizedSeconds: root.recognizedSeconds as number | null,
    });
    const corrections = [
      entry(roots[0], 'correction-1', -100, 'reversal'),
      entry(roots[0], 'correction-1', 100, 'credit'),
      entry(roots[1], 'correction-1', -100, 'reversal'),
      entry(roots[1], 'correction-1', 200, 'credit'),
      entry(
        roots[0],
        'correction-2',
        -100,
        'reversal',
        `correction-1-${roots[0].rootEntryId}-credit`,
      ),
      entry(roots[0], 'correction-2', 300, 'credit'),
      entry(
        roots[1],
        'correction-2',
        -200,
        'reversal',
        `correction-1-${roots[1].rootEntryId}-credit`,
      ),
      entry(roots[1], 'correction-2', 200, 'credit'),
    ];
    const txFor = (
      selected: (typeof roots)[number],
      official: boolean,
      correctionRows = corrections,
      manifestRows = manifests,
      manifestRootRows = roots.map((root) => ({ ...root, rootExpectedEntryCount: roots.length })),
      slices = rootSlices(roots),
      proofSlices?: ReturnType<typeof rootSlices>,
    ) => {
      const query = jest.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([selected]);
      if (!official) query.mockResolvedValueOnce([{ asOf: new Date('2099-09-21T01:00:00Z') }]);
      query
        .mockResolvedValueOnce(manifestRows)
        .mockResolvedValueOnce(correctionRows)
        .mockResolvedValueOnce(manifestRootRows)
        .mockResolvedValueOnce(slices);
      if (proofSlices) {
        query
          .mockResolvedValueOnce([
            {
              id: 'proof',
              rootManifestId: 'root-manifest',
              sourceSetHash: 'b'.repeat(64),
              expectedBindingCount: 2,
              actualBindingCount: 2n,
            },
          ])
          .mockResolvedValueOnce(
            proofSlices.map((slice) => ({ ...slice, rootEntryId: null, proofId: 'proof' })),
          );
      }
      return {
        activityTimeCutoverReceipt: { findUnique: jest.fn().mockResolvedValue(receipt()) },
        $queryRaw: query,
      };
    };

    it.each([
      [0, 100],
      [1, 200],
    ])('returns member %i when only one member is corrected', async (index, expectedSeconds) => {
      const selected = roots[index];
      const service = new ParticipationTimeTruthQueryService();
      const proofTx = txFor(selected, false, corrections.slice(0, 4), manifests.slice(0, 1));
      const proof = await service.readMemberTruthInTx(proofTx as never, {
        memberId: selected.memberId,
        dateFrom: '2099-01-01',
        dateTo: '2099-12-31',
      });
      expect(proof.items).toMatchObject([
        {
          participationIdentityId: selected.participationIdentityId,
          recognizedSeconds: expectedSeconds,
        },
      ]);
      const totalTx = txFor(selected, true, corrections.slice(0, 4), manifests.slice(0, 1));
      const snapshot = await service.readOfficialTotalsInTx(totalTx as never, {
        memberIds: [selected.memberId],
      });
      expect(snapshot?.totals).toEqual([
        {
          activityId: selected.activityId,
          memberId: selected.memberId,
          eligibleSeconds: expectedSeconds,
        },
      ]);
    });

    it.each([
      [0, 300],
      [1, 200],
    ])(
      'projects member %i after validating both members across successive corrections',
      async (index, expectedSeconds) => {
        const selected = roots[index];
        const service = new ParticipationTimeTruthQueryService();
        const proofTx = txFor(selected, false);
        const proof = await service.readMemberTruthInTx(proofTx as never, {
          memberId: selected.memberId,
          dateFrom: '2099-01-01',
          dateTo: '2099-12-31',
        });
        expect(proof.items).toMatchObject([
          {
            participationIdentityId: selected.participationIdentityId,
            recognizedSeconds: expectedSeconds,
            latestCorrectionManifestId: 'correction-2',
          },
        ]);
        expect(proofTx.$queryRaw).toHaveBeenCalledTimes(7);

        const totalTx = txFor(selected, true);
        const snapshot = await service.readOfficialTotalsInTx(totalTx as never, {
          memberIds: [selected.memberId],
        });
        expect(snapshot?.totals).toEqual([
          {
            activityId: selected.activityId,
            memberId: selected.memberId,
            eligibleSeconds: expectedSeconds,
          },
        ]);
        expect(totalTx.$queryRaw).toHaveBeenCalledTimes(6);
      },
    );

    it.each([
      ['missing root', { entryRootManifestId: null }],
      ['another manifest root', { entryRootManifestId: 'other-manifest' }],
      ['identity mismatch', { entryIdentityId: 'other-identity' }],
      ['category mismatch', { entryCategoryCode: 'training' }],
      ['unsafe delta', { secondsDelta: Number.MAX_SAFE_INTEGER + 1 }],
      ['negative final balance', { secondsDelta: -301 }],
    ])('rejects an out-of-scope member correction with %s', async (_label, change) => {
      const malformed = corrections.map((row, index) =>
        index === 2 ? { ...row, ...change } : row,
      );
      const tx = txFor(roots[0], false, malformed);
      await expect(
        new ParticipationTimeTruthQueryService().readMemberTruthInTx(tx as never, {
          memberId: roots[0].memberId,
          dateFrom: '2099-01-01',
          dateTo: '2099-12-31',
        }),
      ).rejects.toMatchObject({ biz: BizCode.ACTIVITY_TIME_PROOF_INVALID });
    });

    it('rejects a missing root in the complete manifest', async () => {
      const incomplete = [{ ...roots[0], rootExpectedEntryCount: 2 }];
      const tx = txFor(roots[0], false, corrections, manifests, incomplete);
      await expect(
        new ParticipationTimeTruthQueryService().readMemberTruthInTx(tx as never, {
          memberId: roots[0].memberId,
          dateFrom: '2099-01-01',
          dateTo: '2099-12-31',
        }),
      ).rejects.toMatchObject({ biz: BizCode.ACTIVITY_TIME_PROOF_INVALID });
    });

    it('rejects missing original slices for another member', async () => {
      const tx = txFor(roots[0], false, corrections, manifests, undefined, rootSlices([roots[0]]));
      await expect(
        new ParticipationTimeTruthQueryService().readMemberTruthInTx(tx as never, {
          memberId: roots[0].memberId,
          dateFrom: '2099-01-01',
          dateTo: '2099-12-31',
        }),
      ).rejects.toMatchObject({ biz: BizCode.ACTIVITY_TIME_PROOF_INVALID });
    });

    it('accepts complete frozen slices and projects only the requested member', async () => {
      const latest = { ...manifests[1], sourceProofId: 'proof', sourceProofHash: 'b'.repeat(64) };
      const slices = rootSlices(roots);
      const tx = txFor(
        roots[0],
        false,
        corrections,
        [manifests[0], latest],
        undefined,
        slices,
        slices,
      );
      const result = await new ParticipationTimeTruthQueryService().readMemberTruthInTx(
        tx as never,
        {
          memberId: roots[0].memberId,
          dateFrom: '2099-01-01',
          dateTo: '2099-12-31',
        },
      );
      expect(result.items).toMatchObject([
        { participationIdentityId: roots[0].participationIdentityId, recognizedSeconds: 300 },
      ]);
      expect(result.items).toHaveLength(1);
      expect(tx.$queryRaw).toHaveBeenCalledTimes(9);
    });

    it.each(['missing', 'invalid interval'])(
      'rejects %s frozen slices for another member',
      async (failure) => {
        const latest = { ...manifests[1], sourceProofId: 'proof', sourceProofHash: 'b'.repeat(64) };
        const slices = rootSlices(roots);
        const proofSlices =
          failure === 'missing'
            ? slices.slice(0, 1)
            : [slices[0], { ...slices[1], endAt: slices[1].startAt }];
        const tx = txFor(
          roots[0],
          false,
          corrections,
          [manifests[0], latest],
          undefined,
          slices,
          proofSlices,
        );
        await expect(
          new ParticipationTimeTruthQueryService().readMemberTruthInTx(tx as never, {
            memberId: roots[0].memberId,
            dateFrom: '2099-01-01',
            dateTo: '2099-12-31',
          }),
        ).rejects.toMatchObject({ biz: BizCode.ACTIVITY_TIME_PROOF_INVALID });
      },
    );

    it.each([1, 100, 2_000])(
      'keeps a fixed query count with %i corrected members',
      async (count) => {
        const all = classifiedRoots(count).map((root) => ({
          ...root,
          rootManifestId: 'root-manifest',
        }));
        const entries = all.flatMap((root, index) => [
          entry(root, 'correction-1', -1, 'reversal'),
          entry(root, 'correction-1', index === 0 ? 2 : 1, 'credit'),
        ]);
        const tx = txFor(
          all[0],
          false,
          entries,
          manifests.slice(0, 1),
          all.map((root) => ({ ...root, rootExpectedEntryCount: count })),
          rootSlices(all),
        );
        const result = await new ParticipationTimeTruthQueryService().readMemberTruthInTx(
          tx as never,
          {
            memberId: all[0].memberId,
            dateFrom: '2099-01-01',
            dateTo: '2099-12-31',
          },
        );
        expect(result.items).toHaveLength(1);
        expect(tx.$queryRaw).toHaveBeenCalledTimes(7);
        const calls = tx.$queryRaw.mock.calls as unknown as Array<[unknown]>;
        expect(calls[6][0]).toMatchObject({ values: ['root-manifest'] });
      },
    );

    it.each([
      ['broken predecessor', [manifests[0], { ...manifests[1], predecessorManifestId: 'missing' }]],
      ['invalid receipt', [manifests[0], { ...manifests[1], receiptContentHash: 'wrong' }]],
    ])('rejects %s before projecting a member', async (_label, invalidManifests) => {
      const tx = txFor(roots[0], false, corrections, invalidManifests);
      await expect(
        new ParticipationTimeTruthQueryService().readMemberTruthInTx(tx as never, {
          memberId: roots[0].memberId,
          dateFrom: '2099-01-01',
          dateTo: '2099-12-31',
        }),
      ).rejects.toMatchObject({ biz: BizCode.ACTIVITY_TIME_PROOF_INVALID });
    });
  });

  it('keeps legacy eligible time, counts classified non-eligible-only pairs as zero, and folds by activity/member', async () => {
    const roots = [
      {
        rootEntryId: 'root-volunteer',
        rootManifestId: 'manifest-volunteer',
        activityId: 'activity-1',
        participationIdentityId: 'identity-1',
        memberId: 'member-1',
        categoryCode: 'volunteer_service',
        recognizedSeconds: 7_200,
      },
      {
        rootEntryId: 'root-training',
        rootManifestId: 'manifest-training',
        activityId: 'activity-2',
        participationIdentityId: 'identity-2',
        memberId: 'member-2',
        categoryCode: 'training',
        recognizedSeconds: 3_600,
      },
    ];
    const tx = {
      activityTimeCutoverReceipt: { findUnique: jest.fn().mockResolvedValue(receipt()) },
      $queryRaw: jest
        .fn()
        .mockResolvedValueOnce([
          {
            ledgerDate: '2099-09-20',
            activityId: 'activity-1',
            memberId: 'member-1',
            rootManifestId: null,
            participationIdentityId: 'identity-1',
            sourceEntryId: 'legacy-entry',
            recognizedSeconds: 3_600n,
          },
        ])
        .mockResolvedValueOnce(roots)
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce(rootSlices(roots)),
    };

    await expect(
      new ParticipationTimeTruthQueryService().readOfficialTotalsInTx(tx as never),
    ).resolves.toMatchObject({
      totals: [
        { activityId: 'activity-1', memberId: 'member-1', eligibleSeconds: 10_800 },
        { activityId: 'activity-2', memberId: 'member-2', eligibleSeconds: 0 },
      ],
    });
  });

  it('keeps official aggregate query count constant for 1, 100, and 2,000 identities', async () => {
    for (const count of [1, 100, 2_000]) {
      const roots = classifiedRoots(count);
      const tx = {
        activityTimeCutoverReceipt: { findUnique: jest.fn().mockResolvedValue(receipt()) },
        $queryRaw: jest
          .fn()
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce(roots)
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce(rootSlices(roots)),
      };
      const result = await new ParticipationTimeTruthQueryService().readOfficialTotalsInTx(
        tx as never,
        { activityIds: ['activity'] },
      );
      expect(result?.totals).toHaveLength(count);
      expect(tx.$queryRaw).toHaveBeenCalledTimes(4);
    }
  });

  it('returns null before cutover without touching either ledger regime', async () => {
    const tx = {
      activityTimeCutoverReceipt: { findUnique: jest.fn().mockResolvedValue(null) },
      $queryRaw: jest.fn(),
    };
    await expect(
      new ParticipationTimeTruthQueryService().readOfficialTotalsInTx(tx as never, {
        memberIds: ['member'],
      }),
    ).resolves.toBeNull();
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });
});
