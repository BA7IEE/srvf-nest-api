import { Prisma, Role, UserStatus } from '@prisma/client';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import { RbacService } from '../permissions/rbac.service';
import { fingerprintActivityMetricDefinition } from './activity-metric-definition';
import { resolveActivityMetricRuleBinding } from './activity-metric-rule';
import { ActivityMetricRuleBindingAuditRecorder } from './activity-metric-rule-binding-audit-recorder';
import { ActivityMetricRuleBindingService } from './activity-metric-rule-binding.service';
import { metricRuleBindingRequestHash } from './activity-metric-rule-binding-command';

describe('C3-1 explicit binding transaction', () => {
  function fixture() {
    const actor = {
      id: 'actor',
      username: 'actor',
      role: Role.SUPER_ADMIN,
      status: UserStatus.ACTIVE,
      memberId: null,
    };
    const definition = {
      schemaVersion: 1,
      code: 'people',
      version: 1,
      name: '人数',
      configuration: { kindCode: 'non_negative_integer', unit: '人', minimum: 0, maximum: 2000 },
    };
    const hash = fingerprintActivityMetricDefinition(definition).definitionHash;
    const command = {
      schemaVersion: 1,
      operationKey: 'key',
      metricDefinitionId: 'definition',
      definitionHash: hash,
      ruleCode: 'actual_participant_count_v1',
      evaluatorVersion: 1,
    };
    const binding = {
      id: 'binding',
      ...resolveActivityMetricRuleBinding('definition', definition, hash, command.ruleCode, 1),
      createdAt: new Date('2025-01-01T00:00:00.000Z'),
      createdByUserId: actor.id,
    };
    const db = {
      user: { findFirst: jest.fn().mockResolvedValue(actor) },
      $queryRaw: jest.fn().mockResolvedValue([]),
      activityMetricRuleBindingCommandReceipt: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({}),
      },
      activityMetricDefinition: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'definition',
          ...definition,
          configurationJson: definition.configuration,
          definitionHash: hash,
          statusCode: 'active',
        }),
      },
      activityMetricRuleBinding: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue(binding),
      },
    };
    const tx = db as unknown as Prisma.TransactionClient;
    const prisma = {
      $transaction: jest.fn((run: (client: Prisma.TransactionClient) => unknown) => run(tx)),
    };
    const rbac = {
      can: jest.fn().mockResolvedValue(true),
      getUserPermissionCodes: jest
        .fn()
        .mockImplementation(() =>
          Promise.resolve(new Set(['activity-metric.manage.rule-binding'])),
        ),
    };
    const audit = { log: jest.fn().mockResolvedValue(undefined) };
    const service = new ActivityMetricRuleBindingService(
      prisma as unknown as PrismaService,
      rbac as unknown as RbacService,
      audit as unknown as ActivityMetricRuleBindingAuditRecorder,
    );
    const run = () =>
      service.create(command, actor, { requestId: 'test-request', ip: null, ua: null });
    return { db, tx, prisma, rbac, audit, command, actor, binding, service, run };
  }
  it('creates immutable binding, receipt and audit in the same READ COMMITTED transaction', async () => {
    const f = fixture();
    const result = await f.run();
    expect(result.bindingId).toBe('binding');
    expect(f.prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
    });
    expect(f.db.user.findFirst).toHaveBeenCalledTimes(3);
    expect(f.rbac.can).toHaveBeenCalledWith(
      f.actor,
      'activity-metric.manage.rule-binding',
      undefined,
      f.tx,
    );
    expect(f.rbac.getUserPermissionCodes).toHaveBeenCalledWith(f.actor.id, undefined, f.tx);
    expect(f.db.activityMetricRuleBindingCommandReceipt.create).toHaveBeenCalledWith({
      data: {
        actorId: f.actor.id,
        operation: 'create_metric_rule_binding',
        operationKey: 'key',
        requestHash: metricRuleBindingRequestHash(f.command),
        bindingId: 'binding',
        resultJson: result,
      },
    });
    expect(f.audit.log).toHaveBeenCalledWith(
      f.tx,
      f.actor,
      { requestId: 'test-request', ip: null, ua: null },
      result,
      false,
    );
  });
  it('does not permit SUPER_ADMIN without the explicit GLOBAL code', async () => {
    const f = fixture();
    f.rbac.getUserPermissionCodes.mockResolvedValue(new Set());
    await expect(f.run()).rejects.toThrow(new BizException(BizCode.RBAC_FORBIDDEN));
    expect(f.db.activityMetricRuleBinding.create).not.toHaveBeenCalled();
  });
  it.each([2, 3])('rechecks identity after lock wait %i', async (call) => {
    const f = fixture();
    for (let i = 1; i < call; i++) f.db.user.findFirst.mockResolvedValueOnce(f.actor);
    f.db.user.findFirst.mockResolvedValueOnce(null);
    await expect(f.run()).rejects.toThrow(new BizException(BizCode.UNAUTHORIZED));
    expect(f.db.activityMetricRuleBinding.create).not.toHaveBeenCalled();
  });
  it('rejects a definition retired while waiting for its lock', async () => {
    const f = fixture();
    f.db.activityMetricDefinition.findFirst.mockResolvedValue({ statusCode: 'retired' });
    await expect(f.run()).rejects.toThrow(
      new BizException(BizCode.ACTIVITY_METRIC_CANDIDATE_REFERENCE_UNAVAILABLE),
    );
  });
  it('reuses the immutable binding for a new key but writes its own receipt and audit', async () => {
    const f = fixture();
    f.db.activityMetricRuleBinding.findUnique.mockResolvedValue(f.binding);
    const result = await f.run();
    expect(f.db.activityMetricRuleBinding.create).not.toHaveBeenCalled();
    expect(f.db.activityMetricRuleBindingCommandReceipt.create).toHaveBeenCalledTimes(1);
    expect(f.audit.log).toHaveBeenCalledWith(
      f.tx,
      f.actor,
      { requestId: 'test-request', ip: null, ua: null },
      result,
      true,
    );
  });
  it('replays its original result without consulting current definitions or adding audit entries', async () => {
    const f = fixture();
    const original = await f.run();
    const receipt = {
      requestHash: metricRuleBindingRequestHash(f.command),
      bindingId: 'binding',
      resultJson: original,
    };
    f.db.activityMetricRuleBindingCommandReceipt.findUnique.mockResolvedValue(receipt);
    f.db.activityMetricDefinition.findFirst.mockClear();
    f.audit.log.mockClear();
    expect(await f.run()).toEqual(original);
    expect(f.db.activityMetricDefinition.findFirst).not.toHaveBeenCalled();
    expect(f.audit.log).not.toHaveBeenCalled();
  });
  it('rejects a reused key with different business input', async () => {
    const f = fixture();
    f.db.activityMetricRuleBindingCommandReceipt.findUnique.mockResolvedValue({
      requestHash: 'other',
    });
    await expect(f.run()).rejects.toThrow(
      new BizException(BizCode.ACTIVITY_METRIC_CANDIDATE_COMMAND_CONFLICT),
    );
  });
  it('propagates audit failure to the transaction instead of committing a success', async () => {
    const f = fixture();
    const error = new Error('test audit failure');
    f.audit.log.mockRejectedValue(error);
    await expect(f.run()).rejects.toBe(error);
  });
});
