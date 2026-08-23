import { Role, UserStatus } from '@prisma/client';

import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import type { PrismaService } from '../../database/prisma.service';
import type { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import type { RbacService } from '../permissions/rbac.service';
import { MemberInsurancesWorkbenchService } from './member-insurances-workbench.service';

// 工作台 service 的判据。与 `member-insurance-projection.spec.ts` 的分工:
// 那份证明**投影本身**不泄漏,这份证明 **service 真的走了那个投影** ——
// 少了这份,把 service 改成自己拼一份出参、绕开 presenter,投影判据依然全绿。

const META: AuditMeta = { requestId: 'req-workbench-1', ip: '127.0.0.1', ua: 'jest' };
const USER: CurrentUserPayload = {
  id: 'admin-1',
  username: 'admin',
  role: Role.ADMIN,
  status: UserStatus.ACTIVE,
  memberId: null,
};

const RAW_POLICY_NUMBER = 'PICC-SERVICE-RAW-SECRET-0002';

function buildRow() {
  return {
    id: 'insurance-1',
    memberId: 'member-1',
    insurerName: '中国人保',
    policyNumber: RAW_POLICY_NUMBER,
    coverageStart: new Date('2026-01-01T00:00:00.000Z'),
    coverageEnd: new Date('2099-01-01T00:00:00.000Z'),
    createdAt: new Date('2026-01-02T00:00:00.000Z'),
    updatedAt: new Date('2026-01-03T00:00:00.000Z'),
    reviewStatusCode: 'pending',
    version: 0,
    reviewedAt: null,
    member: { id: 'member-1', memberNo: 'SRVF-0007', realName: '张三', nickname: null },
  };
}

/** findMany / count 的入参形状;断言只关心这几个键。 */
interface QueryArgs {
  where: Record<string, unknown>;
  skip?: number;
  take?: number;
}

function buildService(options: { can?: boolean } = {}) {
  const findMany = jest.fn<Promise<unknown[]>, [QueryArgs]>().mockResolvedValue([buildRow()]);
  const count = jest.fn<Promise<number>, [QueryArgs]>().mockResolvedValue(1);
  const prisma = {
    memberInsurance: { findMany, count },
    $transaction: jest.fn().mockImplementation((ops: Array<Promise<unknown>>) => Promise.all(ops)),
  };
  const auditLogs = {
    log: jest.fn<Promise<void>, [Record<string, unknown>]>().mockResolvedValue(undefined),
  };
  const rbac = { can: jest.fn().mockResolvedValue(options.can ?? true) };
  const service = new MemberInsurancesWorkbenchService(
    prisma as unknown as PrismaService,
    auditLogs as unknown as AuditLogsService,
    rbac as unknown as RbacService,
  );
  return { service, prisma, auditLogs, rbac, findMany, count };
}

describe('MemberInsurancesWorkbenchService.list', () => {
  it('不持 member-insurance.read.other → RBAC_FORBIDDEN,且一行也不查', async () => {
    const { service, rbac, findMany } = buildService({ can: false });

    await expect(service.list({ page: 1, pageSize: 20 }, USER, META)).rejects.toMatchObject({
      biz: BizCode.RBAC_FORBIDDEN,
    });
    expect(rbac.can).toHaveBeenCalledWith(USER, 'member-insurance.read.other');
    expect(findMany).not.toHaveBeenCalled();
  });

  it('⭐ 出参不含保单号原值 —— service 确实走了共用投影,没有自己拼一份', async () => {
    const { service } = buildService();

    const page = await service.list({ page: 1, pageSize: 20 }, USER, META);

    expect(JSON.stringify(page)).not.toContain(RAW_POLICY_NUMBER);
    expect(page.items[0]).not.toHaveProperty('policyNumber');
    expect(page.items[0].policyNumberMasked).toBe('PI****02');
  });

  it('传 reviewStatusCode 时下推为 where 条件', async () => {
    const { service, findMany, count } = buildService();

    await service.list({ page: 1, pageSize: 20, reviewStatusCode: 'pending' }, USER, META);

    expect(findMany.mock.calls[0][0].where).toMatchObject({ reviewStatusCode: 'pending' });
    // total 与 items 必须同一个 where —— 否则计数会把筛掉的行算进去。
    expect(count.mock.calls[0][0].where).toEqual(findMany.mock.calls[0][0].where);
  });

  it('不传 reviewStatusCode 时不筛(返回全部状态)', async () => {
    const { service, findMany } = buildService();

    await service.list({ page: 1, pageSize: 20 }, USER, META);

    expect(findMany.mock.calls[0][0].where).not.toHaveProperty('reviewStatusCode');
  });

  it('软删记录与软删队员都不出', async () => {
    const { service, findMany } = buildService();

    await service.list({ page: 1, pageSize: 20 }, USER, META);

    expect(findMany.mock.calls[0][0].where).toMatchObject({
      deletedAt: null,
      member: { deletedAt: null },
    });
  });

  it('分页换算为 skip/take', async () => {
    const { service, findMany } = buildService();

    await service.list({ page: 3, pageSize: 25 }, USER, META);

    expect(findMany.mock.calls[0][0]).toMatchObject({ skip: 50, take: 25 });
  });

  it('audit fail-closed:落账失败则整体失败,不返数据', async () => {
    const { service, auditLogs } = buildService();
    auditLogs.log.mockRejectedValueOnce(new BizException(BizCode.INTERNAL_ERROR));

    await expect(service.list({ page: 1, pageSize: 20 }, USER, META)).rejects.toBeInstanceOf(
      BizException,
    );
  });

  it('audit extra 只记安全元数据 —— 不含保单号/保险公司/id 列表', async () => {
    const { service, auditLogs } = buildService();

    await service.list({ page: 1, pageSize: 20, reviewStatusCode: 'pending' }, USER, META);

    const logged = auditLogs.log.mock.calls[0][0];
    expect(logged).toMatchObject({
      event: 'member-insurance.read.other',
      actorUserId: USER.id,
      extra: {
        operation: 'workbench-list',
        filterFields: ['reviewStatusCode'],
        count: 1,
        total: 1,
      },
    });
    expect(JSON.stringify(logged)).not.toContain(RAW_POLICY_NUMBER);
    expect(JSON.stringify(logged)).not.toContain('中国人保');
    expect(JSON.stringify(logged)).not.toContain('insurance-1');
  });
});
