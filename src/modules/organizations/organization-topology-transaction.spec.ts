import { OrganizationStatus, Prisma, Role, UserStatus } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import type { PrismaService } from '../../database/prisma.service';
import type { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { RbacService } from '../permissions/rbac.service';
import {
  lockOrganizationTopology,
  ORGANIZATION_TOPOLOGY_LOCK_KEY,
  ORGANIZATION_TOPOLOGY_LOCK_NAMESPACE,
} from './organization-topology-transaction';
import { OrganizationsService } from './organizations.service';

const USER: CurrentUserPayload = {
  id: 'user-1',
  username: 'topology-admin',
  role: Role.SUPER_ADMIN,
  status: UserStatus.ACTIVE,
  memberId: null,
};

const META = { requestId: 'topology-lock-order', ip: '127.0.0.1', ua: 'jest' };
const NOW = new Date('2026-07-17T00:00:00.000Z');
const SAFE_ORGANIZATION = {
  id: 'org-target',
  name: 'Target',
  code: null,
  parentId: 'org-old-parent',
  nodeTypeCode: 'test-type',
  sortOrder: 0,
  status: OrganizationStatus.ACTIVE,
  createdAt: NOW,
  updatedAt: NOW,
};

type TopologyCall =
  | '$queryRaw'
  | 'organization.findFirst'
  | 'organization.count'
  | 'organization.create'
  | 'organization.update'
  | 'organizationClosure.findMany'
  | 'organizationClosure.createMany'
  | 'organizationClosure.deleteMany';

function makeService() {
  const calls: TopologyCall[] = [];
  const record = <T>(name: TopologyCall, value: T) =>
    jest.fn().mockImplementation(() => {
      calls.push(name);
      return Promise.resolve(value);
    });

  const tx = {
    $queryRaw: record('$queryRaw', [{ locked: '' }]),
    dictItem: { findFirst: jest.fn().mockResolvedValue({ id: 'dict-item' }) },
    organization: {
      findUnique: jest.fn().mockResolvedValue(null),
      findFirst: record('organization.findFirst', SAFE_ORGANIZATION),
      count: record('organization.count', 0),
      create: record('organization.create', SAFE_ORGANIZATION),
      update: record('organization.update', SAFE_ORGANIZATION),
    },
    organizationClosure: {
      findMany: record('organizationClosure.findMany', [
        { ancestorId: 'org-old-parent', descendantId: 'org-target', depth: 0 },
      ]),
      createMany: record('organizationClosure.createMany', { count: 1 }),
      deleteMany: record('organizationClosure.deleteMany', { count: 1 }),
    },
    memberOrganizationMembership: { count: jest.fn().mockResolvedValue(0) },
  };
  const prisma = {
    $transaction: jest.fn((callback: (client: typeof tx) => Promise<unknown>) => callback(tx)),
  } as unknown as PrismaService;
  const rbac = { can: jest.fn().mockResolvedValue(true) } as unknown as RbacService;
  const audit = { log: jest.fn().mockResolvedValue(undefined) } as unknown as AuditLogsService;

  return { service: new OrganizationsService(prisma, rbac, audit), calls, tx, prisma };
}

describe('organization topology transaction lock', () => {
  it('固定 namespace 派生固定 signed 64-bit golden vector，并只取 transaction lock', async () => {
    expect(ORGANIZATION_TOPOLOGY_LOCK_NAMESPACE).toBe('srvf:organizations:topology:v1');
    expect(ORGANIZATION_TOPOLOGY_LOCK_KEY).toBe(6961426456611932099n);

    const queryRaw = jest
      .fn<Promise<Array<{ locked: string }>>, [Prisma.Sql]>()
      .mockResolvedValue([{ locked: '' }]);
    await lockOrganizationTopology({ $queryRaw: queryRaw } as unknown as Prisma.TransactionClient);

    expect(queryRaw).toHaveBeenCalledTimes(1);
    const sql = queryRaw.mock.calls[0][0];
    expect(sql.values).toEqual([6961426456611932099n]);
    expect(sql.strings.join(' ')).toContain('pg_advisory_xact_lock');
    expect(sql.strings.join(' ')).not.toContain('pg_advisory_lock(');
  });

  it.each([
    {
      name: 'create',
      run: (service: OrganizationsService) =>
        service.create(USER, { name: 'Root', nodeTypeCode: 'test-type' }, META),
    },
    {
      name: 'update',
      run: (service: OrganizationsService) =>
        service.update(USER, 'org-target', { name: 'Renamed' }),
    },
    {
      name: 'updateStatus',
      run: (service: OrganizationsService) =>
        service.updateStatus(USER, 'org-target', { status: OrganizationStatus.ACTIVE }, META),
    },
    {
      name: 'move',
      run: (service: OrganizationsService) =>
        service.move(USER, 'org-target', { parentId: 'org-new-parent' }, META),
    },
    {
      name: 'softDelete',
      run: (service: OrganizationsService) => service.softDelete(USER, 'org-target', META),
    },
  ])('$name 在第一条 Organization/OrganizationClosure SQL 前取得同一把锁', async ({ run }) => {
    const { service, calls } = makeService();

    await run(service);

    expect(calls[0]).toBe('$queryRaw');
    expect(calls.filter((call) => call === '$queryRaw')).toHaveLength(1);
    expect(calls.slice(1).some((call) => call.startsWith('organization'))).toBe(true);
  });

  it('create transaction option:复用调用方事务且仍在首条 topology SQL 前取锁', async () => {
    const { service, calls, tx, prisma } = makeService();

    await service.create(USER, { name: 'Child', nodeTypeCode: 'test-type' }, META, {
      transaction: tx as unknown as Prisma.TransactionClient,
    });

    const transactionMock = (prisma as unknown as { $transaction: jest.Mock }).$transaction;
    expect(transactionMock).not.toHaveBeenCalled();
    expect(calls[0]).toBe('$queryRaw');
    expect(calls.filter((call) => call === '$queryRaw')).toHaveLength(1);
  });
});
