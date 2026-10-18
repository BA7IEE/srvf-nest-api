import type { AppConfig } from '../../config/app.config';
import { ContributionRuleStatus, Prisma } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import type { PrismaService } from '../../database/prisma.service';
import type { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { RbacService } from '../permissions/rbac.service';
import { ContributionRulesService } from './contribution-rules.service';

const actor = { id: 'actor-one', role: 'SUPER_ADMIN' } as CurrentUserPayload;
const meta = { requestId: 'request-one', ip: null, ua: null };
function fixture(mode: AppConfig['contributionSettlementMode'] = 'off') {
  const config = { env: 'test', contributionSettlementMode: mode } as AppConfig;
  const row = {
    id: 'rule-one',
    activityTypeCode: 'service',
    attendanceRoleCode: 'member',
    durationThreshold: new Prisma.Decimal(1),
    pointsBelow: new Prisma.Decimal(1),
    pointsAbove: new Prisma.Decimal(2),
    dailyCap: null,
    status: ContributionRuleStatus.ACTIVE,
    remark: null,
    createdAt: new Date('2026-10-15T00:00:00Z'),
    updatedAt: new Date('2026-10-15T00:00:00Z'),
    createdByUserId: actor.id,
    updatedByUserId: null,
  };
  const tx = {
    dictItem: { findFirst: jest.fn().mockResolvedValue({ id: 'dict-one' }) },
    contributionRule: {
      count: jest.fn().mockResolvedValue(0),
      findFirst: jest.fn().mockResolvedValue(row),
      findMany: jest.fn().mockResolvedValue([row]),
      create: jest.fn().mockResolvedValue(row),
      update: jest.fn().mockResolvedValue(row),
    },
  };
  const db = {
    ...tx,
    $transaction: jest.fn((work: unknown) =>
      Array.isArray(work) ? Promise.all(work) : (work as (client: unknown) => Promise<unknown>)(tx),
    ),
  };
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  const rbac = { can: jest.fn().mockResolvedValue(true) };
  const service = new ContributionRulesService(
    db as unknown as PrismaService,
    audit as unknown as AuditLogsService,
    rbac as unknown as RbacService,
    config,
  );
  const writes = {
    create: () =>
      service.create(
        {
          activityTypeCode: 'service',
          attendanceRoleCode: 'member',
          durationThreshold: 1,
          pointsBelow: 1,
          pointsAbove: 2,
        },
        actor,
        meta,
      ),
    update: () => service.update(row.id, { remark: 'updated' }, actor, meta),
    softDelete: () => service.softDelete(row.id, actor, meta),
  };
  return { service, db, tx, audit, rbac, row, writes, config };
}

describe('legacy contribution rule management characterization', () => {
  it.each(['create', 'update', 'softDelete'] as const)(
    'retains the original %s write and audit transaction',
    async (operation) => {
      const f = fixture();
      await f.writes[operation]();
      expect(f.db.$transaction).toHaveBeenCalledTimes(1);
      expect(f.audit.log).toHaveBeenCalledTimes(1);
      expect(f.audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          tx: f.tx,
          actorUserId: actor.id,
          resourceType: 'contribution_rule',
        }),
      );
      expect(
        f.tx.contributionRule[operation === 'create' ? 'create' : 'update'],
      ).toHaveBeenCalledTimes(1);
    },
  );
  it.each(['create', 'update', 'softDelete'] as const)(
    'keeps RBAC first for %s',
    async (operation) => {
      const f = fixture();
      f.rbac.can.mockResolvedValue(false);
      await expect(f.writes[operation]()).rejects.toMatchObject({ biz: BizCode.RBAC_FORBIDDEN });
      expect(f.db.$transaction).not.toHaveBeenCalled();
      expect(f.audit.log).not.toHaveBeenCalled();
    },
  );
  it('retains list/detail reads, normalized fields and no write audit', async () => {
    const f = fixture();
    f.tx.contributionRule.count.mockResolvedValue(1);
    await expect(f.service.findOne(actor, f.row.id)).resolves.toMatchObject({
      id: f.row.id,
      pointsBelow: 1,
      pointsAbove: 2,
    });
    await expect(f.service.list(actor, { page: 1, pageSize: 10 })).resolves.toMatchObject({
      total: 1,
      items: [expect.objectContaining({ id: f.row.id })],
    });
    expect(f.tx.contributionRule.create).not.toHaveBeenCalled();
    expect(f.tx.contributionRule.update).not.toHaveBeenCalled();
    expect(f.audit.log).not.toHaveBeenCalled();
  });
});

describe('E5 old rule management write boundary', () => {
  it.each(['create', 'update', 'softDelete'] as const)(
    'rejects active %s after RBAC and before any query, write or audit',
    async (operation) => {
      const f = fixture('active');
      await expect(f.writes[operation]()).rejects.toMatchObject({
        biz: BizCode.CONTRIBUTION_RULE_READONLY,
      });
      expect(BizCode.CONTRIBUTION_RULE_READONLY.httpStatus).toBe(409);
      expect(f.rbac.can).toHaveBeenCalledTimes(1);
      expect(f.db.$transaction).not.toHaveBeenCalled();
      for (const query of Object.values(f.tx.contributionRule))
        expect(query).not.toHaveBeenCalled();
      expect(f.tx.dictItem.findFirst).not.toHaveBeenCalled();
      expect(f.audit.log).not.toHaveBeenCalled();
    },
  );
  it.each(['create', 'update', 'softDelete'] as const)(
    'keeps RBAC refusal ahead of active read-only for %s',
    async (operation) => {
      const f = fixture('active');
      f.rbac.can.mockResolvedValue(false);
      await expect(f.writes[operation]()).rejects.toMatchObject({ biz: BizCode.RBAC_FORBIDDEN });
      expect(f.db.$transaction).not.toHaveBeenCalled();
      expect(f.audit.log).not.toHaveBeenCalled();
    },
  );
  it.each([undefined, 'off', 'fixture'] as const)(
    'retains pre-cutover writes for mode %s',
    async (mode) => {
      const f = fixture(mode);
      for (const operation of ['create', 'update', 'softDelete'] as const)
        await f.writes[operation]();
      expect(f.db.$transaction).toHaveBeenCalledTimes(3);
      expect(f.audit.log).toHaveBeenCalledTimes(3);
    },
  );
  it('keeps active list and detail available without changing legacy calculation data', async () => {
    const f = fixture('active');
    f.tx.contributionRule.count.mockResolvedValue(1);
    await expect(f.service.findOne(actor, f.row.id)).resolves.toMatchObject({
      id: f.row.id,
      pointsBelow: 1,
    });
    await expect(f.service.list(actor, { page: 1, pageSize: 10 })).resolves.toMatchObject({
      total: 1,
    });
    expect(f.tx.contributionRule.create).not.toHaveBeenCalled();
    expect(f.tx.contributionRule.update).not.toHaveBeenCalled();
    expect(f.audit.log).not.toHaveBeenCalled();
  });
  it('preserves the frozen off contract on active-to-off; this is no persistent cutover latch', async () => {
    const f = fixture('active');
    await expect(f.writes.create()).rejects.toMatchObject({
      biz: BizCode.CONTRIBUTION_RULE_READONLY,
    });
    f.config.contributionSettlementMode = 'off';
    await f.writes.create();
    expect(f.audit.log).toHaveBeenCalledTimes(1);
  });
});
