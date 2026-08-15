import { Role, UserStatus } from '@prisma/client';

import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import type { ActivityDraftAuditRecorder } from './activity-draft-audit-recorder';
import { canonicalizeQualificationRuleSets } from './qualification-rule-set-definition';
import { QualificationRuleSetVersionService } from './qualification-rule-set-version.service';

type DraftAuditInput = Parameters<ActivityDraftAuditRecorder['log']>[0];

const USER: CurrentUserPayload = {
  id: 'qualification-owner-user',
  username: 'qualification-owner',
  role: Role.USER,
  status: UserStatus.ACTIVE,
  memberId: 'qualification-owner-member',
};
const META: AuditMeta = { requestId: 'qualification-version-unit', ip: null, ua: null };

function rules(codes: string[] = ['L1']) {
  return [
    {
      ruleTypeCode: 'grade',
      enforcementCode: 'block',
      operator: 'in',
      valueJson: { codes },
      warnScore: null,
      message: null,
      sortOrder: 10,
    },
  ];
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'qualification-version-1',
    activityId: 'qualification-activity-1',
    sessionId: null,
    positionId: null,
    version: 1,
    statusCode: 'draft',
    rules: rules(),
    ...overrides,
  };
}

function input(codes: string[] = ['L1']) {
  return {
    ruleSets: [
      {
        scope: { sessionId: null, positionId: null },
        rules: [
          {
            ruleTypeCode: 'grade' as const,
            enforcementCode: 'block' as const,
            operator: 'in' as const,
            codes,
            sortOrder: 10,
          },
        ],
      },
    ],
  };
}

function harness(
  options: { draft?: Record<string, unknown>[]; active?: Record<string, unknown>[] } = {},
) {
  const draft = options.draft ?? [row()];
  const active = options.active ?? [];
  let activeRead = 0;
  const refreshedActive = [
    row({ id: 'qualification-version-2', version: 2, statusCode: 'active', rules: rules(['L2']) }),
  ];
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([{ id: 'qualification-activity-1' }]),
    activity: { findFirst: jest.fn().mockResolvedValue({ statusCode: 'draft' }) },
    activitySession: { findMany: jest.fn().mockResolvedValue([]) },
    activitySessionPosition: { findMany: jest.fn().mockResolvedValue([]), updateMany: jest.fn() },
    activityQualificationRuleSet: {
      findMany: jest.fn(({ where }: { where: { statusCode: string } }) => {
        if (where.statusCode === 'draft') return Promise.resolve(draft);
        activeRead += 1;
        return Promise.resolve(activeRead === 1 ? active : refreshedActive);
      }),
      update: jest.fn<Promise<unknown>, [unknown]>().mockResolvedValue({}),
      aggregate: jest
        .fn<Promise<{ _max: { version: number } }>, [unknown]>()
        .mockResolvedValue({ _max: { version: 1 } }),
      create: jest
        .fn<Promise<{ id: string }>, [unknown]>()
        .mockResolvedValue({ id: 'qualification-version-2' }),
    },
  };
  const prisma = {
    $transaction: jest.fn((callback: (value: typeof tx) => Promise<unknown>) => callback(tx)),
    activityQualificationRuleSet: tx.activityQualificationRuleSet,
    activitySessionPosition: tx.activitySessionPosition,
  };
  const audit = {
    log: jest.fn<Promise<void>, [DraftAuditInput]>().mockResolvedValue(undefined),
  };
  return {
    service: new QualificationRuleSetVersionService(prisma as never, audit as never),
    tx,
    audit,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function createdRuleSetData(call: unknown): Record<string, unknown> {
  if (!isRecord(call) || !isRecord(call.data)) {
    throw new Error('expected RuleSet create call with an object data payload');
  }
  return call.data;
}

describe('QualificationRuleSetVersionService', () => {
  it('keeps an exact canonical draft PUT a true no-op with no version/audit write', async () => {
    const { service, tx, audit } = harness();

    await expect(
      service.putManaged('qualification-activity-1', input(['L1']), USER, META),
    ).resolves.toEqual(
      expect.objectContaining({
        ruleSets: [
          expect.objectContaining({ version: 1, scope: { sessionId: null, positionId: null } }),
        ],
      }),
    );
    expect(tx.activityQualificationRuleSet.update).not.toHaveBeenCalled();
    expect(tx.activityQualificationRuleSet.create).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('retires a changed draft scope and records only the existing activity.publish field marker', async () => {
    const { service, tx, audit } = harness();

    await service.putManaged('qualification-activity-1', input(['L2']), USER, META);

    expect(tx.activityQualificationRuleSet.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'qualification-version-1' },
        data: { statusCode: 'retired' },
      }),
    );
    const created = createdRuleSetData(tx.activityQualificationRuleSet.create.mock.calls[0]?.[0]);
    expect(created.statusCode).toBe('draft');
    expect(created.version).toBe(2);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        changedFields: ['qualificationRuleSets'],
        tx,
      }),
    );
    expect(audit.log.mock.calls[0]?.[0]).not.toHaveProperty('operation');
  });

  it('builds changed active versions as a complete draft before the only active transition', async () => {
    const active = [row({ statusCode: 'active' })];
    const { service, tx } = harness({ active });
    const target = canonicalizeQualificationRuleSets(input(['L2'])).definition;

    await expect(
      service.applyPublishedTarget(tx as never, {
        activityId: 'qualification-activity-1',
        requestType: 'change',
        target,
        sessionIds: new Map(),
        positionIds: new Map(),
      }),
    ).resolves.toEqual([
      expect.objectContaining({ ruleSetVersionId: 'qualification-version-2', version: 2 }),
    ]);

    // Mutation target: creating the nested child rules directly below an active parent is
    // rejected by D83's parent-freeze trigger. The create must remain draft, then activate.
    const created = createdRuleSetData(tx.activityQualificationRuleSet.create.mock.calls[0]?.[0]);
    expect(created.statusCode).toBe('draft');
    expect(tx.activityQualificationRuleSet.update).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: { id: 'qualification-version-1' },
        data: { statusCode: 'retired' },
      }),
    );
    expect(tx.activityQualificationRuleSet.update).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: { id: 'qualification-version-2' },
        data: { statusCode: 'active' },
      }),
    );
  });
});
