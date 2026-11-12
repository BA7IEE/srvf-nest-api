import { Role, UserStatus } from '@prisma/client';
import type { PrismaService } from '../../database/prisma.service';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { ActivityTimeCorrectionCommandService } from './activity-time-correction-command.service';
import { CorrectionApplicationService } from './correction-application.service';
import { fingerprintMetricEnvelope } from './activity-metric-definition';
import { parseCorrectionChangeSet } from './correction-change-set';

const actor = {
  id: 'actor',
  username: 'actor',
  role: Role.USER,
  status: UserStatus.ACTIVE,
  memberId: 'member',
};
const meta = { requestId: 'test', ip: null, ua: null };
const result = {
  participationIdentityId: 'identity',
  resultCode: 'present',
  recognizedServiceHours: '4.0',
  recognizedContributionPoints: '1.20',
  adjustmentReason: null,
  lateFlag: false,
  earlyLeaveFlag: false,
};
const change = (results: unknown[]) => ({
  schemaVersion: 2,
  results,
  segments: [],
  timeCorrection: {
    baseSettlementVersionId: 'base',
    baseTimeLedgerHash: 'a'.repeat(64),
    reason: 'reason',
    items: [{ rootEntryId: 'root', recognizedSeconds: 0 }],
  },
});

describe('Human V2 request compatibility across command and application', () => {
  it('accepts and stores a reparsable nonempty result on fresh submit and resubmit', async () => {
    const dto = {
      participationIdentityId: null,
      requestTypeCode: 'time' as const,
      requestedChangeJson: change([result]),
      reason: 'reason',
      operationKey: 'operation',
    };
    const tx = {
      attendanceCorrectionRequest: { findFirst: () => Promise.resolve(null) },
      attendanceSettlementRun: { update: () => Promise.resolve({}) },
    };
    const prisma = {
      $transaction: async (fn: (arg: typeof tx) => Promise<unknown>) => await fn(tx),
    };
    const audit = { logSubmit: () => Promise.resolve(), logResubmit: () => Promise.resolve() };
    const writes = { voidRequest: () => Promise.resolve() };
    const domain = Reflect.construct(CorrectionApplicationService, [
      prisma,
      {},
      {},
      audit,
      { assertV11WriteAllowed: () => undefined },
      {},
      { source: () => Promise.resolve({ changed: true }) },
      {},
      writes,
      { authorizeSubmission: () => Promise.resolve(actor) },
      {},
      {},
    ]) as CorrectionApplicationService;
    const created = {
      id: 'new',
      version: 0,
      activityId: 'activity',
      settlementRunId: 'run',
      baseSettlementVersionId: 'base',
      baseResultRevisionId: null,
      baseClosureRevision: 0,
      statusCode: 'pending',
    };
    const create = jest.fn((tx: unknown, args: { input: { requestedChangeJson: unknown } }) => {
      void tx;
      void args;
      return Promise.resolve(created);
    });
    Reflect.set(domain, 'lockActivity', () => Promise.resolve({ title: 'activity' }));
    Reflect.set(domain, 'lockRun', () =>
      Promise.resolve({ id: 'run', statusCode: 'correction_open' }),
    );
    Reflect.set(domain, 'readRequestAnchor', () => Promise.resolve({ activityId: 'activity' }));
    Reflect.set(domain, 'lockRequest', () =>
      Promise.resolve({
        id: 'previous',
        activityId: 'activity',
        settlementRunId: 'run',
        statusCode: 'returned',
        submittedByUserId: actor.id,
        participationIdentityId: null,
      }),
    );
    Reflect.set(domain, 'detectBaseDrift', () => Promise.resolve(null));
    Reflect.set(domain, 'readPostedVersion', () => Promise.resolve({ id: 'base' }));
    Reflect.set(domain, 'assertContributionCorrectionWrite', () => undefined);
    Reflect.set(domain, 'assertContributionRequestedPoints', () => Promise.resolve());
    Reflect.set(domain, 'readActiveClosure', () => Promise.resolve(null));
    Reflect.set(domain, 'assertChangeSetResolvable', () => Promise.resolve());
    Reflect.set(domain, 'readBaseResults', () => Promise.resolve([]));
    Reflect.set(domain, 'assertNoOpenRequest', () => Promise.resolve());
    Reflect.set(domain, 'createRequest', create);
    const command = new ActivityTimeCorrectionCommandService(
      prisma as unknown as PrismaService,
      domain,
    );
    await expect(command.submit('activity', dto, actor, meta)).resolves.toMatchObject({
      requestId: 'new',
      replayed: false,
    });
    await expect(command.resubmit('activity', 'previous', dto, actor, meta)).resolves.toMatchObject(
      { requestId: 'new', replayed: false },
    );
    expect(create).toHaveBeenCalledTimes(2);
    for (const [, args] of create.mock.calls) {
      expect(parseCorrectionChangeSet(args.input.requestedChangeJson).results[0]).toMatchObject({
        recognizedServiceHours: 4,
        recognizedContributionPoints: 1.2,
      });
    }
  });
  it.each([true, false])(
    'replays submit and resubmit using historical hash projection (results=%s)',
    async (nonempty) => {
      const raw = change(nonempty ? [result] : []);
      const legacyProjection = change(
        nonempty
          ? [{ ...result, recognizedServiceHours: 4, recognizedContributionPoints: 1.2 }]
          : [],
      );
      const dto = {
        participationIdentityId: null,
        requestTypeCode: 'time' as const,
        requestedChangeJson: raw,
        reason: 'reason',
        operationKey: 'operation',
      };
      const businessHash = fingerprintMetricEnvelope('attendance-correction-request-v2', {
        activityId: 'activity',
        participationIdentityId: null,
        requestTypeCode: 'time',
        requestedChangeJson: legacyProjection,
        reason: 'reason',
        attachmentIds: null,
      }).definitionHash;
      const submitHash = fingerprintMetricEnvelope('attendance-correction-human-submit-v1', {
        actorUserId: actor.id,
        activityId: 'activity',
        operationKey: dto.operationKey,
        businessHash,
      }).definitionHash;
      const resubmitHash = fingerprintMetricEnvelope('attendance-correction-resubmit-v1', {
        actorUserId: actor.id,
        activityId: 'activity',
        resubmittedFromRequestId: 'previous',
        participationIdentityId: null,
        requestTypeCode: 'time',
        requestedChangeJson: legacyProjection,
        reason: 'reason',
        attachmentIds: null,
        operationKey: dto.operationKey,
      }).definitionHash;
      const existing = {
        id: 'existing',
        version: 1,
        activityId: 'activity',
        settlementRunId: 'run',
        baseSettlementVersionId: 'base',
        baseResultRevisionId: null,
        baseClosureRevision: 0,
        statusCode: 'pending',
        requestHash: submitHash,
        resubmittedFromRequestId: 'previous',
      };
      const tx = {
        attendanceCorrectionRequest: { findFirst: jest.fn(() => Promise.resolve(existing)) },
      };
      const prisma = {
        $transaction: async (fn: (arg: typeof tx) => Promise<unknown>) => await fn(tx),
      };
      const domain = Reflect.construct(CorrectionApplicationService, [
        prisma,
        {},
        {},
        {},
        { assertV11WriteAllowed: () => undefined },
        {},
        {},
        {},
        {},
        { authorizeSubmission: () => Promise.resolve(actor) },
        {},
        {},
      ]) as CorrectionApplicationService;
      Reflect.set(domain, 'lockActivity', () => Promise.resolve({ title: 'activity' }));
      Reflect.set(domain, 'lockRun', () =>
        Promise.resolve({ id: 'run', statusCode: 'correction_open' }),
      );
      Reflect.set(domain, 'readRequestAnchor', () => Promise.resolve({ activityId: 'activity' }));
      Reflect.set(domain, 'lockRequest', () => Promise.resolve({ id: 'previous' }));
      const command = new ActivityTimeCorrectionCommandService(
        prisma as unknown as PrismaService,
        domain,
      );

      await expect(command.submit('activity', dto, actor, meta)).resolves.toMatchObject({
        requestId: 'existing',
        replayed: true,
      });
      existing.requestHash = resubmitHash;
      await expect(
        command.resubmit('activity', 'previous', dto, actor, meta),
      ).resolves.toMatchObject({ outcome: 'resubmitted', requestId: 'existing', replayed: true });
      await expect(
        command.resubmit('activity', 'previous', { ...dto, reason: 'different' }, actor, meta),
      ).rejects.toMatchObject({ biz: { code: BizCode.CORRECTION_OPERATION_KEY_CONFLICT.code } });
    },
  );
});
