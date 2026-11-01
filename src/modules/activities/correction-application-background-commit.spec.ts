import {
  pureHumanAuthority,
  pureHumanItemStore,
} from '../../../test/helpers/human-correction-authority-pure';
import { Role, UserStatus } from '@prisma/client';
import { CorrectionApplicationService } from './correction-application.service';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import {
  humanCorrectionJobHash,
  humanCorrectionItemHash,
  HumanCorrectionLeaseLostError,
  type HumanCorrectionJobPayload,
} from './correction-background-job';

const actor = {
  id: 'actor',
  username: 'actor',
  role: Role.USER,
  status: UserStatus.ACTIVE,
  memberId: 'member',
};
const payload: HumanCorrectionJobPayload = {
  action: 'human_correction_commit',
  schemaVersion: 2,
  activityId: 'activity',
  requestId: 'request',
  applicationId: 'application',
  settlementRunId: 'run',
  newSettlementVersionId: 'new-version',
  rootManifestId: 'root',
  postingBatchId: 'batch',
  baseSettlementVersionId: 'base-version',
  actorUserId: 'actor',
  operationKey: 'operation',
  commitRequestHash: 'commit-hash',
  sourceRequestHash: 'source-hash',
  sourceProofHash: null,
  segmentCount: 0,
};
const fence = {
  jobId: 'job',
  leaseOwner: 'worker',
  leaseGeneration: 2,
  payload,
  intentItemId: 'intent',
  intentHash: humanCorrectionItemHash('job', payload),
  itemEpoch: 1,
};
const input = {
  correctionRequestId: 'request',
  operationKey: 'operation',
  requestHash: 'commit-hash',
};
const options = {
  human: true as const,
  backgroundJob: fence,
  expectedActivityId: 'activity',
  expectedBaseSettlementVersionId: 'base-version',
  expectedCorrectionApplicationId: 'application',
  expectedPostingBatchId: 'batch',
};
const meta = { requestId: 'test', ip: null, ua: null };

function fixture(
  settings: {
    itemCount?: number;
    jobCount?: number;
    revoke?: boolean;
    replay?: boolean;
    missingFence?: boolean;
    budget?: { bulkCommit: boolean; bulkPrepare: boolean };
  } = {},
) {
  const calls: string[] = [];
  const request = {
    id: 'request',
    activityId: 'activity',
    settlementRunId: 'run',
    baseSettlementVersionId: 'base-version',
    requestHash: 'source-hash',
    statusCode: settings.replay ? 'applied' : 'applying',
    requestedChangeJson: {
      schemaVersion: 2,
      results: [],
      segments: [],
      timeCorrection: {
        baseSettlementVersionId: 'base-version',
        baseTimeLedgerHash: 'a'.repeat(64),
        reason: 'reason',
        items: [{ rootEntryId: 'entry', recognizedSeconds: 0 }],
      },
    },
  };
  const item = jest.fn(async (args: Parameters<typeof store.items.updateMany>[0]) => {
    calls.push('item');
    if (settings.itemCount === 0) return { count: 0 };
    return store.items.updateMany(args);
  });
  const job = jest.fn(() => {
    calls.push('job');
    return { count: settings.jobCount ?? 1 };
  });
  const query = jest.fn((parts: TemplateStringsArray, ...values: unknown[]) => {
    const routed = profile.query(parts);
    if (routed.handled) return routed.value;
    const locked = store.lockQuery(parts, values);
    if (locked.handled) return locked.value;
    const sql = parts.join('?');
    if (sql.includes('FROM "ActivityBatchJob"')) {
      calls.push('fence');
      return settings.missingFence
        ? []
        : [
            {
              id: 'job',
              payload,
              requestHash: humanCorrectionJobHash(payload),
              createdByUserId: 'actor',
              payloadVersion: 1,
            },
          ];
    }
    if (sql.includes('FROM "CorrectionApplication"')) {
      calls.push('application-lock');
      return [
        {
          id: 'application',
          statusCode: settings.replay ? 'committed' : 'preparing',
          newSettlementVersionId: 'new-version',
          newPostingBatchId: 'batch',
          preparedByUserId: 'actor',
        },
      ];
    }
    if (sql.includes('FROM "AttendanceCorrectionRequest"')) return [request];
    if (sql.includes('FROM "AttendanceSettlementRun"')) return [{ id: 'run' }];
    if (sql.includes('FROM "AttendanceSettlementVersion"'))
      return [{ id: 'base-version', contributionRegimeCode: 'legacy' }];
    if (sql.includes('FROM "Activity"')) return [{ title: 'Activity' }];
    throw new Error('unexpected query');
  });
  function storeProxy() {
    return {
      findMany: (arg: Parameters<typeof store.items.findMany>[0]) => store.items.findMany(arg),
    };
  }
  const tx = {
    $queryRaw: query,
    $executeRawUnsafe: jest.fn(() => 0),
    $executeRaw: jest.fn((input: unknown) => {
      if (profile.execute(input)) return 0;
      calls.push('business-write');
      return 1;
    }),
    correctionSegmentPreparationReceipt: {
      findUnique: jest.fn(() => ({ schemaVersion: 1, preparedSegmentCount: 0 })),
    },
    participationTimeCorrectionManifest: {
      findUnique: jest.fn(() => ({ rootManifestId: 'root' })),
    },
    correctionTimeSourceProof: { findUnique: jest.fn(() => null) },
    correctionPendingSegmentRevision: { findMany: jest.fn(() => []) },
    activitySettlementClosureRevision: { findFirst: jest.fn(() => null) },
    activity: {
      update: jest.fn(() => {
        calls.push('activity-write');
      }),
    },
    attendanceSettlementRun: {
      update: jest.fn(() => {
        calls.push('run-write');
      }),
    },
    activityBatchJobItem: { ...storeProxy(), updateMany: item },
    activityBatchJob: { updateMany: job },
  };
  let callbackReturned = false;
  const prisma = {
    attendanceCorrectionRequest: { findUnique: jest.fn(() => ({ activityId: 'activity' })) },
    $transaction: jest.fn(async (callback: (t: typeof tx) => Promise<unknown>) => {
      const result = await callback(tx);
      callbackReturned = true;
      return result;
    }),
  };
  const profile = pureHumanAuthority(prisma);
  const store = pureHumanItemStore(profile, payload);
  const authority = profile.authority;
  const audit = {
    logCommit: jest.fn((arg: { tx: unknown }) => {
      expect(arg.tx).toBe(tx);
      calls.push('audit');
    }),
  };
  const writes = {
    markApplicationCommitted: jest.fn((t: unknown) => {
      expect(t).toBe(tx);
      calls.push('application-write');
    }),
    markRequestApplied: jest.fn((t: unknown) => {
      expect(t).toBe(tx);
      calls.push('request-write');
    }),
  };
  const access = {
    authorizePrepare: jest.fn((): typeof actor => {
      throw new Error('prepare-auth-revoked');
    }),
    authorizeCommit: jest.fn((t: unknown) => {
      expect(t).toBe(tx);
      calls.push('authorize');
      if (settings.revoke) throw new Error('revoked');
      return actor;
    }),
  };
  const ledger = {
    commitBatchWithin: jest.fn((t: unknown) => {
      expect(t).toBe(tx);
      calls.push('ledger');
      return {};
    }),
  };
  const correction = {
    rethrowConstraint: (error: unknown): never => {
      throw error;
    },
    createCommitReceipt: jest.fn(() => ({})),
    assertComplete: jest.fn(() => {}),
  };
  const args = [
    prisma,
    ledger,
    {},
    audit,
    { assertV11WriteAllowed: jest.fn() },
    {},
    correction,
    { prevalidateFrozenSourceProof: jest.fn(() => undefined) },
    writes,
    access,
    {},
    {},
    undefined,
    authority,
    settings.budget,
  ] as unknown as ConstructorParameters<typeof CorrectionApplicationService>;
  const service = new CorrectionApplicationService(...args);
  return {
    prisma,
    service,
    tx,
    profile,
    store,
    calls,
    audit,
    writes,
    access,
    ledger,
    item,
    job,
    getCallbackReturned: () => callbackReturned,
  };
}

describe('Human background correction real commit orchestration', () => {
  it('keeps business writes, audit and the real item/job finish on the same transaction', async () => {
    const f = fixture();
    const result = await f.service.commit(input, actor, meta, options);
    expect(result.applicationStatus).toBe('committed');
    expect(f.getCallbackReturned()).toBe(true);
    expect(f.calls).toEqual(
      expect.arrayContaining([
        'business-write',
        'activity-write',
        'run-write',
        'application-write',
        'request-write',
        'audit',
        'item',
        'job',
      ]),
    );
    expect(f.calls.indexOf('audit')).toBeLessThan(f.calls.indexOf('item'));
    expect(f.calls.indexOf('item')).toBeLessThan(f.calls.indexOf('job'));
    expect(f.item).toHaveBeenCalledTimes(1);
    expect(f.job).toHaveBeenCalledTimes(1);
  });

  it.each([{ itemCount: 0 }, { jobCount: 0 }])(
    'propagates a lost finish fence after audit %#',
    async (settings) => {
      const f = fixture(settings);
      await expect(f.service.commit(input, actor, meta, options)).rejects.toBeInstanceOf(
        HumanCorrectionLeaseLostError,
      );
      expect(f.audit.logCommit).toHaveBeenCalledTimes(1);
      expect(f.getCallbackReturned()).toBe(false);
    },
  );

  it('rejects live authorization after the application lock without finishing the job', async () => {
    const f = fixture({ revoke: true });
    await expect(f.service.commit(input, actor, meta, options)).rejects.toThrow('revoked');
    expect(f.calls.indexOf('application-lock')).toBeLessThan(f.calls.indexOf('authorize'));
    expect(f.item).not.toHaveBeenCalled();
    expect(f.job).not.toHaveBeenCalled();
    expect(f.getCallbackReturned()).toBe(false);
  });

  it('requires the real job fence before a committed replay', async () => {
    const f = fixture({ replay: true, missingFence: true });
    await expect(f.service.commit(input, actor, meta, options)).rejects.toBeInstanceOf(
      HumanCorrectionLeaseLostError,
    );
    expect(f.ledger.commitBatchWithin).not.toHaveBeenCalled();
    expect(f.item).not.toHaveBeenCalled();
    expect(f.job).not.toHaveBeenCalled();
    expect(f.getCallbackReturned()).toBe(false);
  });
});

describe('Human protected epoch real callback rejection', () => {
  it('uses60 only for a server-enabled bulk worker and retains locked live authorization', async () => {
    const f = fixture({ revoke: true, budget: { bulkCommit: true, bulkPrepare: false } });
    const bulk = {
      ...options,
      backgroundJob: {
        ...fence,
        payload: { ...payload, schemaVersion: 3 as const, segmentCount: 1000 },
      },
    };
    await expect(f.service.commit(input, actor, meta, bulk)).rejects.toThrow('revoked');
    expect(f.prisma.$transaction).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ timeout: 60000, isolationLevel: 'ReadCommitted' }),
    );
    expect(f.tx.$executeRawUnsafe).toHaveBeenCalledWith('SET LOCAL lock_timeout = 4000');
    expect(f.item).not.toHaveBeenCalled();
    expect(f.ledger.commitBatchWithin).not.toHaveBeenCalled();
  });
  it('keeps synchronous and small background Human on15 even with the candidate enabled', async () => {
    for (const execution of [{ ...options, backgroundJob: undefined }, options]) {
      const f = fixture({ revoke: true, budget: { bulkCommit: true, bulkPrepare: false } });
      await expect(f.service.commit(input, actor, meta, execution)).rejects.toThrow('revoked');
      expect(f.prisma.$transaction).toHaveBeenCalledWith(
        expect.any(Function),
        expect.objectContaining({ timeout: 15000 }),
      );
    }
  });
  it('does not let large worker metadata replace the locked actual source classification', async () => {
    const f = fixture({ budget: { bulkCommit: true, bulkPrepare: false } });
    const bulk = {
      ...options,
      backgroundJob: {
        ...fence,
        payload: { ...payload, schemaVersion: 3 as const, segmentCount: 1000 },
      },
    };
    await expect(f.service.commit(input, actor, meta, bulk)).rejects.toMatchObject({
      biz: BizCode.CORRECTION_OPERATION_KEY_CONFLICT,
    });
    expect(f.ledger.commitBatchWithin).not.toHaveBeenCalled();
    expect(f.item).not.toHaveBeenCalled();
    expect(f.calls).not.toContain('business-write');
  });
  it('selects prepare240 only with server candidate AND bound bulk source; defaults stay120', async () => {
    for (const enabled of [false, true])
      for (const bound of [false, true]) {
        const f = fixture({ budget: { bulkCommit: false, bulkPrepare: enabled } });
        await expect(
          f.service.prepare(input, actor, meta, {
            ...options,
            ...(bound
              ? { backgroundBulkPrepare: { segmentCount: 1000, requestHash: 'source-hash' } }
              : {}),
          }),
        ).rejects.toThrow('prepare-auth-revoked');
        expect(f.prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
          timeout: enabled && bound ? 240000 : 120000,
        });
        expect(f.item).not.toHaveBeenCalled();
        expect(f.calls).not.toContain('business-write');
      }
  });
  it('rechecks actual prepare source after live authorization before granting the bulk candidate', async () => {
    const f = fixture({ budget: { bulkCommit: false, bulkPrepare: true } });
    f.access.authorizePrepare.mockReturnValue(actor);
    await expect(
      f.service.prepare(input, actor, meta, {
        ...options,
        backgroundBulkPrepare: { segmentCount: 1000, requestHash: 'source-hash' },
      }),
    ).rejects.toMatchObject({ biz: BizCode.CORRECTION_OPERATION_KEY_CONFLICT });
    expect(f.calls).not.toContain('business-write');
    expect(f.item).not.toHaveBeenCalled();
  });
  it('rejects a stale protected epoch before business or finish, including committed replay', async () => {
    const f = fixture({ replay: true });
    f.store.row.attempts = 2;
    await expect(f.service.commit(input, actor, meta, options)).rejects.toBeInstanceOf(
      HumanCorrectionLeaseLostError,
    );
    expect(f.ledger.commitBatchWithin).not.toHaveBeenCalled();
    expect(f.item).not.toHaveBeenCalled();
    expect(f.getCallbackReturned()).toBe(false);
  });
  it('rejects a P role restoration failure after audit instead of reporting callback success', async () => {
    const f = fixture();
    f.audit.logCommit.mockImplementation(() => {
      f.calls.push('audit');
      f.profile.state.restoreFails = true;
    });
    await expect(f.service.commit(input, actor, meta, options)).rejects.toThrow(
      'PURE_RESTORE_FAILURE',
    );
    expect(f.calls).toContain('audit');
    expect(f.item).toHaveBeenCalledTimes(1);
    expect(f.job).not.toHaveBeenCalled();
    expect(f.getCallbackReturned()).toBe(false);
    // The model does not prove PostgreSQL rollback of preceding writes.
  });
});
