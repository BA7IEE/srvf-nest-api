import { Test } from '@nestjs/testing';
import { Role, UserStatus } from '@prisma/client';
import { ActivityTimePolicyService } from './activity-time-policy.service';
import { ActivityTimePolicyCommand } from './activity-time-policy-command';
import { ActivityTimePolicyAuditRecorder } from './activity-time-policy-audit-recorder';
import { fingerprintTimePolicyVersion } from './activity-time-policy-definition';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AdminCreateTimePolicyVersionDto } from './dto/admin/activity-time-policy-command.dto';

function version() {
  return {
    operationKey: 'key',
    schemaVersion: 1,
    evaluatorVersion: 1,
    effectiveFrom: '2026-01-01T00:00:00.000Z',
    effectiveUntil: null,
    definition: {
      defaultCategory: 'volunteer_service',
      roleMappings: [],
      allowSplit: false,
      specialIntervals: {
        preparation: { mode: 'exclude' },
        duty: { mode: 'exclude' },
        travel: { mode: 'exclude' },
      },
      rounding: { mode: 'floor', quantumSeconds: 1 },
      evidence: { requiredSources: [], requireManualRecognition: false },
      manualAdjustment: { enabled: false },
    },
  };
}

describe('D1-2 catalogue service sequencing', () => {
  async function fixture() {
    const actor = {
      id: 'actor',
      username: 'actor',
      role: Role.USER,
      status: UserStatus.ACTIVE,
      memberId: null,
    };
    const input = version();
    const fp = fingerprintTimePolicyVersion({
      schemaVersion: 1,
      evaluatorVersion: 1,
      definition: input.definition,
      effectiveFrom: input.effectiveFrom,
      effectiveUntil: null,
    });
    const row = {
      id: 'version',
      policyId: 'policy',
      version: 1,
      schemaVersion: 1,
      evaluatorVersion: 1,
      definitionJson: fp.definition,
      definitionHash: fp.definitionHash,
      statusCode: 'draft',
      effectiveFrom: new Date(input.effectiveFrom),
      effectiveUntil: null,
      createdAt: new Date(input.effectiveFrom),
      updatedAt: new Date(input.effectiveFrom),
      activatedAt: null,
      retiredAt: null,
    };
    const db = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      timePolicy: {
        findFirst: jest.fn().mockResolvedValue({ id: 'policy' }),
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'policy', createdAt: row.createdAt }),
      },
      timePolicyVersion: {
        findFirst: jest.fn().mockResolvedValue(row),
        create: jest.fn().mockResolvedValue(row),
        update: jest.fn().mockResolvedValue(row),
      },
    };
    const access = jest.fn().mockResolvedValue(actor);
    const run = jest.fn((args: { execute: (tx: typeof db, user: typeof actor) => unknown }) =>
      args.execute(db, actor),
    );
    const audit = jest.fn().mockResolvedValue(undefined);
    const m = await Test.createTestingModule({
      providers: [
        ActivityTimePolicyService,
        { provide: ActivityTimePolicyCommand, useValue: { run, assertAccess: access } },
        { provide: ActivityTimePolicyAuditRecorder, useValue: { log: audit } },
      ],
    }).compile();
    return {
      actor,
      input,
      row,
      db,
      access,
      run,
      audit,
      service: m.get(ActivityTimePolicyService),
      meta: { requestId: 'request', ip: null, ua: null },
    };
  }
  it('allocates the next version only after policy lock and current access', async () => {
    const f = await fixture();
    await f.service.createVersion('policy', f.input, f.actor, f.meta);
    expect(f.db.timePolicyVersion.create.mock.calls).toMatchObject([
      [
        {
          data: {
            policyId: 'policy',
            version: 2,
            statusCode: 'draft',
            definitionHash: f.row.definitionHash,
          },
        },
      ],
    ]);
    expect(f.db.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      f.access.mock.invocationCallOrder[0],
    );
    expect(f.access.mock.invocationCallOrder[0]).toBeLessThan(
      f.db.timePolicyVersion.findFirst.mock.invocationCallOrder[0],
    );
  });
  it('fails closed when the integer version space is exhausted', async () => {
    const f = await fixture();
    f.db.timePolicyVersion.findFirst.mockResolvedValue({ ...f.row, version: 2147483647 });
    await expect(f.service.createVersion('policy', f.input, f.actor, f.meta)).rejects.toMatchObject(
      { biz: BizCode.ACTIVITY_TIME_POLICY_VERSION_LIMIT },
    );
    expect(f.db.timePolicyVersion.create).not.toHaveBeenCalled();
  });
  it('requires policy then version lock, and rechecks after each', async () => {
    const f = await fixture();
    await f.service.transition(
      'activate',
      'policy',
      'version',
      {
        operationKey: 'key',
        expectedDefinitionHash: f.row.definitionHash,
        expectedStatusCode: 'draft',
      },
      f.actor,
      f.meta,
    );
    expect(f.db.$queryRaw).toHaveBeenCalledTimes(2);
    expect(f.access).toHaveBeenCalledTimes(2);
    expect(f.db.$queryRaw.mock.invocationCallOrder[1]).toBeLessThan(
      f.access.mock.invocationCallOrder[1],
    );
    const activatedAt: unknown = expect.any(Date);
    expect(f.db.timePolicyVersion.update).toHaveBeenCalledWith({
      where: { id: 'version' },
      data: { statusCode: 'active', activatedAt },
    });
    expect(f.audit).toHaveBeenCalledTimes(1);
  });
  it('rejects stale expected state without audit or write', async () => {
    const f = await fixture();
    f.db.timePolicyVersion.findFirst.mockResolvedValue({ ...f.row, statusCode: 'retired' });
    await expect(
      f.service.transition(
        'activate',
        'policy',
        'version',
        {
          operationKey: 'key',
          expectedDefinitionHash: f.row.definitionHash,
          expectedStatusCode: 'draft',
        },
        f.actor,
        f.meta,
      ),
    ).rejects.toMatchObject({ biz: BizCode.ACTIVITY_TIME_POLICY_STALE });
    expect(f.db.timePolicyVersion.update).not.toHaveBeenCalled();
    expect(f.audit).not.toHaveBeenCalled();
  });
  it('surfaces audit failure to the command transaction', async () => {
    const f = await fixture();
    f.audit.mockRejectedValue(new Error('audit unavailable'));
    await expect(
      f.service.createPolicy(
        { operationKey: 'key', code: 'policy', name: 'Policy' },
        f.actor,
        f.meta,
      ),
    ).rejects.toThrow('audit unavailable');
  });
  it('valid transformed nested DTO still satisfies the closed parser', async () => {
    const f = await fixture();
    const dto = plainToInstance(AdminCreateTimePolicyVersionDto, f.input);
    expect(await validate(dto, { whitelist: true, forbidNonWhitelisted: true })).toEqual([]);
    await f.service.createVersion('policy', dto, f.actor, f.meta);
    expect(f.run).toHaveBeenCalled();
  });
  it('rejects client supplied extra version metadata before any write', async () => {
    const f = await fixture();
    expect(() =>
      f.service.createVersion('policy', { ...f.input, version: 99 }, f.actor, f.meta),
    ).toThrow();
    expect(f.run).not.toHaveBeenCalled();
  });
});
