import { Role, type Prisma } from '@prisma/client';
import type { PrismaService } from '../../database/prisma.service';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import type { ActivityTemplateVersionCommand } from './activity-template-version-command';
import { ActivityTemplateVersionQueryService } from './activity-template-version-query.service';

const actor: CurrentUserPayload = {
  id: 'reader',
  username: 'reader',
  role: Role.USER,
  status: 'ACTIVE',
  memberId: null,
};
const visibleFamily = { scopeTypeCode: 'global', ownerOrganizationId: null, statusCode: 'active' };
function setup() {
  const tx = {
    activityTemplate: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(17),
      findFirst: jest.fn().mockResolvedValue(null),
    },
  };
  const client = tx as unknown as Prisma.TransactionClient;
  const assertAccess = jest
    .fn<
      ReturnType<ActivityTemplateVersionCommand['assertAccess']>,
      Parameters<ActivityTemplateVersionCommand['assertAccess']>
    >()
    .mockResolvedValue(actor);
  const transaction = jest.fn(
    async (callback: (client: Prisma.TransactionClient) => Promise<unknown>) => callback(client),
  );
  const prisma = new Proxy(
    { $transaction: transaction },
    {
      get: (target, property) => {
        if (property === '$transaction') return target.$transaction;
        throw new Error('query escaped its authorized transaction');
      },
    },
  );
  const service = new ActivityTemplateVersionQueryService(
    prisma as unknown as PrismaService,
    { assertAccess } as unknown as ActivityTemplateVersionCommand,
  );
  return { tx, client, assertAccess, service };
}

describe('C1 D2b template catalogue query scope and pagination', () => {
  it('uses identical eligibility predicates for rows and count before paginating', async () => {
    const { service, tx, client, assertAccess } = setup();
    const query = {
      page: 9,
      pageSize: 7,
      familyId: 'family',
      statusCode: 'retired',
      schemaVersion: 2,
    };
    expect(await service.list(query, actor)).toEqual({
      items: [],
      total: 17,
      page: 9,
      pageSize: 7,
    });
    const where = {
      family: visibleFamily,
      familyId: 'family',
      statusCode: 'retired',
      schemaVersion: 2,
    };
    expect(tx.activityTemplate.findMany).toHaveBeenCalledWith({
      where,
      include: { family: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: 56,
      take: 7,
    });
    expect(tx.activityTemplate.count).toHaveBeenCalledWith({ where });
    expect(assertAccess).toHaveBeenCalledWith(client, actor, 'activity-template.read.catalog');
    expect(assertAccess.mock.invocationCallOrder[0]).toBeLessThan(
      tx.activityTemplate.findMany.mock.invocationCallOrder[0],
    );
    expect(assertAccess.mock.invocationCallOrder[0]).toBeLessThan(
      tx.activityTemplate.count.mock.invocationCallOrder[0],
    );
  });
  it('omitted schema filter includes V1–V4 and still excludes legacy/non-global/inactive Families', async () => {
    const { service, tx } = setup();
    await service.list({ page: 1, pageSize: 20 }, actor);
    const where = {
      family: visibleFamily,
      familyId: undefined,
      statusCode: undefined,
      schemaVersion: { in: [1, 2, 3, 4] },
    };
    expect(tx.activityTemplate.findMany).toHaveBeenCalledWith({
      where,
      include: { family: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: 0,
      take: 20,
    });
    expect(tx.activityTemplate.count).toHaveBeenCalledWith({ where });
  });
  it.each(['list', 'get'] as const)(
    '%s never reads targets when current read permission is denied',
    async (mode) => {
      const { service, tx, assertAccess } = setup();
      assertAccess.mockRejectedValue(new BizException(BizCode.RBAC_FORBIDDEN));
      const pending =
        mode === 'list'
          ? service.list({ page: 1, pageSize: 20 }, actor)
          : service.get('missing', actor);
      await expect(pending).rejects.toMatchObject({ biz: BizCode.RBAC_FORBIDDEN });
      for (const query of Object.values(tx.activityTemplate)) expect(query).not.toHaveBeenCalled();
    },
  );
  it('detail lookup applies the same Family and V1–V4 schema boundary after explicit read authorization', async () => {
    const { service, tx, client, assertAccess } = setup();
    await expect(service.get('missing', actor)).rejects.toMatchObject({
      biz: BizCode.ACTIVITY_TEMPLATE_VERSION_NOT_FOUND,
    });
    expect(assertAccess).toHaveBeenCalledWith(client, actor, 'activity-template.read.catalog');
    expect(tx.activityTemplate.findFirst).toHaveBeenCalledWith({
      where: { id: 'missing', family: visibleFamily, schemaVersion: { in: [1, 2, 3, 4] } },
      include: { family: true },
    });
    expect(assertAccess.mock.invocationCallOrder[0]).toBeLessThan(
      tx.activityTemplate.findFirst.mock.invocationCallOrder[0],
    );
  });
  it('a later read reauthorizes rather than reusing an earlier GLOBAL decision', async () => {
    const { service, tx, assertAccess } = setup();
    await service.list({ page: 1, pageSize: 20 }, actor);
    assertAccess.mockRejectedValue(new BizException(BizCode.UNAUTHORIZED));
    await expect(service.list({ page: 1, pageSize: 20 }, actor)).rejects.toMatchObject({
      biz: BizCode.UNAUTHORIZED,
    });
    expect(assertAccess).toHaveBeenCalledTimes(2);
    expect(tx.activityTemplate.findMany).toHaveBeenCalledTimes(1);
    expect(tx.activityTemplate.count).toHaveBeenCalledTimes(1);
  });
});
