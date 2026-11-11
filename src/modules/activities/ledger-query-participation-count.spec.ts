import type { PrismaService } from '../../database/prisma.service';
import type { AuthzService } from '../authz/authz.service';
import type { RbacService } from '../permissions/rbac.service';
import type { AppIdentityResolver } from '../users/app-identity.resolver';
import { LedgerQueryService } from './ledger-query.service';

describe('committed participation count query', () => {
  it('counts only the current posted result and its committed credit identity-days', async () => {
    const queryRaw = jest.fn().mockResolvedValue([{ activityCount: 1n, recordCount: 2n }]);
    const service = new LedgerQueryService(
      { $queryRaw: queryRaw } as unknown as PrismaService,
      {} as AuthzService,
      {} as RbacService,
      {} as AppIdentityResolver,
    );

    await expect(service.countCommittedParticipationForMember('member-a')).resolves.toEqual({
      activityCount: 1,
      recordCount: 2,
    });
    const [parts, ...values] = queryRaw.mock.calls[0] as [TemplateStringsArray, ...unknown[]];
    const sql = parts.join('?');
    expect(values).toEqual(['member-a']);
    expect(sql).toContain('COUNT(DISTINCT (e."participationIdentityId", e."ledgerDate"))');
    expect(sql).toContain('JOIN "ParticipantSettlementResultRevision" rr');
    expect(sql).toContain('JOIN "AttendanceSettlementVersion" v');
    expect(sql).toContain('JOIN "AttendanceSettlementRun" r');
    expect(sql).toContain('b."statusCode" = \'committed\'');
    expect(sql).toContain('rr."statusCode" = \'committed\'');
    expect(sql).toContain('r."currentPostedVersion" = v.version');
    expect(sql).toContain('b."settlementVersionId" = v.id');
    expect(sql).toContain('b."settlementRunId" = r.id');
    expect(sql).toContain("e.\"entryTypeCode\" IN ('service_credit', 'contribution_credit')");
    // A preparing correction can set the run to posting while the previous version stays current.
    expect(sql).not.toMatch(/(?<![a-z])r\."statusCode"/u);
  });
});
