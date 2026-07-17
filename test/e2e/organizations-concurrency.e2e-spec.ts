import type { INestApplication } from '@nestjs/common';
import { Prisma, Role, UserStatus } from '@prisma/client';
import type { CurrentUserPayload } from '../../src/common/decorators/current-user.decorator';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { BizException } from '../../src/common/exceptions/biz.exception';
import { PrismaService } from '../../src/database/prisma.service';
import {
  lockOrganizationTopology,
  ORGANIZATION_TOPOLOGY_LOCK_KEY,
} from '../../src/modules/organizations/organization-topology-transaction';
import { OrganizationsService } from '../../src/modules/organizations/organizations.service';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// D-ORG 真实 PostgreSQL 并发证据。
//
// mutation kill points:
// - 删除 service 中任一 topology lock（或换成不同 key）→ 外部持有同一 xact lock 时请求会提前完成，
//   `runBlockedPair` 的 settledWhileHeld 断言失败。
// - 把 lock 移到第一条 Organization/OrganizationClosure SQL 之后 →
//   organization-topology-transaction.spec.ts 的五入口顺序断言失败。
// - 把 xact lock 改成 session lock → helper golden-vector/SQL 断言失败，且连接归池后会污染后续 case。
//
// 每个 pair 都先由第三条真实 PostgreSQL transaction 持有 topology lock，再并发启动两个 service
// transaction。释放门闩后，两请求仍是同时在飞的独立 transaction，只能按 PostgreSQL lock 队列串行。

const NODE_TYPE_CODE = 'org-topology-concurrency-type';
const HOLD_WINDOW_MS = 100;

interface TopologyDiffRow {
  missing: bigint;
  extra: bigint;
  wrongDepth: bigint;
  cycles: bigint;
  liveChildOfDeletedParent: bigint;
}

describe('organizations topology serialization', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let organizations: OrganizationsService;
  let actor: CurrentUserPayload;
  let requestSequence = 0;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);
    organizations = app.get(OrganizationsService);

    const user = await prisma.user.create({
      data: {
        username: 'org-topology-concurrency-admin',
        passwordHash: '$2a$10$service-level-e2e-does-not-login',
        role: Role.SUPER_ADMIN,
        status: UserStatus.ACTIVE,
      },
    });
    actor = {
      id: user.id,
      username: user.username,
      role: user.role,
      status: user.status,
      memberId: user.memberId,
    };

    const type = await prisma.dictType.create({
      data: { code: 'node_type', label: '组织节点类型' },
      select: { id: true },
    });
    await prisma.dictItem.create({
      data: { typeId: type.id, code: NODE_TYPE_CODE, label: '并发测试节点' },
    });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe('TRUNCATE TABLE "Organization" RESTART IDENTITY CASCADE');
    await prisma.auditLog.deleteMany({ where: { resourceType: 'organization' } });
  });

  function meta(operation: string) {
    requestSequence += 1;
    return {
      requestId: `org-topology-${operation}-${requestSequence}`,
      ip: '127.0.0.1',
      ua: 'jest/30 organizations-concurrency',
    };
  }

  async function createNode(name: string, parentId?: string) {
    return organizations.create(
      actor,
      { name, parentId, nodeTypeCode: NODE_TYPE_CODE },
      meta(`seed-${name}`),
    );
  }

  async function runBlockedPair<T>(
    left: () => Promise<T>,
    right: () => Promise<T>,
  ): Promise<PromiseSettledResult<T>[]> {
    let releaseHolder: (() => void) | undefined;
    const releaseSignal = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });
    let markAcquired: (() => void) | undefined;
    const lockAcquired = new Promise<void>((resolve) => {
      markAcquired = resolve;
    });

    const holder = prisma.$transaction(async (tx) => {
      await lockOrganizationTopology(tx);
      markAcquired?.();
      await releaseSignal;
    });
    await lockAcquired;

    const pending = [left(), right()];
    let settled = 0;
    for (const operation of pending) {
      void operation.then(
        () => {
          settled += 1;
        },
        () => {
          settled += 1;
        },
      );
    }

    await new Promise((resolve) => setTimeout(resolve, HOLD_WINDOW_MS));
    const settledWhileHeld = settled;
    releaseHolder?.();
    await holder;
    const results = await Promise.allSettled(pending);

    // Wrong/deleted lock key mutation completes here while the golden topology lock is still held.
    expect({ lockKey: ORGANIZATION_TOPOLOGY_LOCK_KEY, settledWhileHeld }).toEqual({
      lockKey: 6961426456611932099n,
      settledWhileHeld: 0,
    });
    return results;
  }

  function fulfilledCount(results: PromiseSettledResult<unknown>[]): number {
    return results.filter((result) => result.status === 'fulfilled').length;
  }

  function rejectedBizCodes(results: PromiseSettledResult<unknown>[]): number[] {
    return results.flatMap((result) => {
      if (result.status === 'fulfilled') return [];
      const reason: unknown = result.reason;
      return reason instanceof BizException ? [reason.biz.code] : [];
    });
  }

  async function assertTopologyEquivalent(label: string): Promise<void> {
    // 只读审计：以 live Organization.parentId 邻接关系递归生成 expected closure，再和存量
    // organization_closure 比 missing / extra / wrong-depth；同时独立检查环和 live→deleted parent。
    // 若部署前对存量数据跑出非零，只上报并另立 D 档，禁止在本 lane 修复/回填。
    const rows = await prisma.$queryRaw<TopologyDiffRow[]>(Prisma.sql`
      WITH RECURSIVE adjacency AS (
        SELECT
          organization.id AS "ancestorId",
          organization.id AS "descendantId",
          0 AS depth,
          ARRAY[organization.id]::text[] AS path
        FROM "Organization" organization
        WHERE organization."deletedAt" IS NULL

        UNION ALL

        SELECT
          adjacency."ancestorId",
          child.id AS "descendantId",
          adjacency.depth + 1 AS depth,
          adjacency.path || child.id
        FROM adjacency
        JOIN "Organization" child
          ON child."parentId" = adjacency."descendantId"
         AND child."deletedAt" IS NULL
        WHERE NOT child.id = ANY(adjacency.path)
      ),
      expected AS (
        SELECT "ancestorId", "descendantId", MIN(depth) AS depth
        FROM adjacency
        GROUP BY "ancestorId", "descendantId"
      ),
      actual AS (
        SELECT closure."ancestorId", closure."descendantId", closure.depth
        FROM organization_closure closure
        JOIN "Organization" ancestor
          ON ancestor.id = closure."ancestorId" AND ancestor."deletedAt" IS NULL
        JOIN "Organization" descendant
          ON descendant.id = closure."descendantId" AND descendant."deletedAt" IS NULL
      ),
      cycle_edges AS (
        SELECT 1
        FROM adjacency
        JOIN "Organization" child
          ON child."parentId" = adjacency."descendantId"
         AND child."deletedAt" IS NULL
        WHERE child.id = ANY(adjacency.path)
      )
      SELECT
        (
          SELECT COUNT(*)::bigint
          FROM expected
          LEFT JOIN actual USING ("ancestorId", "descendantId")
          WHERE actual."ancestorId" IS NULL
        ) AS missing,
        (
          SELECT COUNT(*)::bigint
          FROM actual
          LEFT JOIN expected USING ("ancestorId", "descendantId")
          WHERE expected."ancestorId" IS NULL
        ) AS extra,
        (
          SELECT COUNT(*)::bigint
          FROM expected
          JOIN actual USING ("ancestorId", "descendantId")
          WHERE expected.depth <> actual.depth
        ) AS "wrongDepth",
        (SELECT COUNT(*)::bigint FROM cycle_edges) AS cycles,
        (
          SELECT COUNT(*)::bigint
          FROM "Organization" child
          JOIN "Organization" parent ON parent.id = child."parentId"
          WHERE child."deletedAt" IS NULL AND parent."deletedAt" IS NOT NULL
        ) AS "liveChildOfDeletedParent"
    `);
    const diff = rows[0];
    expect({
      label,
      missing: Number(diff.missing),
      extra: Number(diff.extra),
      wrongDepth: Number(diff.wrongDepth),
      cycles: Number(diff.cycles),
      liveChildOfDeletedParent: Number(diff.liveChildOfDeletedParent),
    }).toEqual({
      label,
      missing: 0,
      extra: 0,
      wrongDepth: 0,
      cycles: 0,
      liveChildOfDeletedParent: 0,
    });
  }

  it('A→B × B→A：恰一成功、另一方 11012，最终无环且 closure 等价', async () => {
    const root = await createNode('root');
    const a = await createNode('A', root.id);
    const b = await createNode('B', root.id);

    const results = await runBlockedPair(
      () => organizations.move(actor, a.id, { parentId: b.id }, meta('a-to-b')),
      () => organizations.move(actor, b.id, { parentId: a.id }, meta('b-to-a')),
    );

    expect(fulfilledCount(results)).toBe(1);
    expect(rejectedBizCodes(results)).toEqual([BizCode.ORGANIZATION_PARENT_CYCLE.code]);
    await assertTopologyEquivalent('A→B × B→A');
  });

  it('A→B × C→A：串行后两方均成功，missing/extra/wrong-depth=0', async () => {
    const root = await createNode('root');
    const a = await createNode('A', root.id);
    const b = await createNode('B', root.id);
    const d = await createNode('D', root.id);
    const c = await createNode('C', d.id);

    const results = await runBlockedPair(
      () => organizations.move(actor, a.id, { parentId: b.id }, meta('a-to-b')),
      () => organizations.move(actor, c.id, { parentId: a.id }, meta('c-to-a')),
    );

    expect(fulfilledCount(results)).toBe(2);
    await assertTopologyEquivalent('A→B × C→A');
  });

  it('softDelete(P) × move(C→P)：只允许一个业务结果生效，绝不留下 live child→deleted parent', async () => {
    const root = await createNode('root');
    const p = await createNode('P', root.id);
    const q = await createNode('Q', root.id);
    const c = await createNode('C', q.id);

    const results = await runBlockedPair(
      () => organizations.softDelete(actor, p.id, meta('delete-p')),
      () => organizations.move(actor, c.id, { parentId: p.id }, meta('c-to-p')),
    );

    expect(fulfilledCount(results)).toBe(1);
    expect([
      BizCode.ORGANIZATION_PARENT_NOT_FOUND.code,
      BizCode.ORGANIZATION_HAS_CHILDREN.code,
    ]).toContain(rejectedBizCodes(results)[0]);
    await assertTopologyEquivalent('softDelete(P) × move(C→P)');
  });

  it('create child × move parent：两方均成功且新 child 继承最终祖先链', async () => {
    const root = await createNode('root');
    const parent = await createNode('P', root.id);
    const target = await createNode('Q', root.id);

    const results = await runBlockedPair(
      () => createNode('new-child', parent.id),
      () => organizations.move(actor, parent.id, { parentId: target.id }, meta('move-parent')),
    );

    expect(fulfilledCount(results)).toBe(2);
    await assertTopologyEquivalent('create child × move parent');
  });

  it('并发 root create：恰一成功，另一方命中既有 11032', async () => {
    const results = await runBlockedPair(
      () => createNode('root-a'),
      () => createNode('root-b'),
    );

    expect(fulfilledCount(results)).toBe(1);
    expect(rejectedBizCodes(results)).toEqual([BizCode.ORGANIZATION_ROOT_ALREADY_EXISTS.code]);
    expect(await prisma.organization.count({ where: { parentId: null, deletedAt: null } })).toBe(1);
    await assertTopologyEquivalent('concurrent root create');
  });

  it('同节点双 move：两方串行成功，最终 parent 为任一目标且 closure 等价', async () => {
    const root = await createNode('root');
    const node = await createNode('A', root.id);
    const b = await createNode('B', root.id);
    const c = await createNode('C', root.id);

    const results = await runBlockedPair(
      () => organizations.move(actor, node.id, { parentId: b.id }, meta('a-to-b')),
      () => organizations.move(actor, node.id, { parentId: c.id }, meta('a-to-c')),
    );

    expect(fulfilledCount(results)).toBe(2);
    const final = await prisma.organization.findUniqueOrThrow({ where: { id: node.id } });
    expect([b.id, c.id]).toContain(final.parentId);
    await assertTopologyEquivalent('same node double move');
  });

  it('不相交 moves：两方均成功且各自 parent/closure 正确', async () => {
    const root = await createNode('root');
    const a = await createNode('A', root.id);
    const b = await createNode('B', root.id);
    const c = await createNode('C', root.id);
    const d = await createNode('D', root.id);

    const results = await runBlockedPair(
      () => organizations.move(actor, a.id, { parentId: b.id }, meta('a-to-b')),
      () => organizations.move(actor, c.id, { parentId: d.id }, meta('c-to-d')),
    );

    expect(fulfilledCount(results)).toBe(2);
    const [finalA, finalC] = await Promise.all([
      prisma.organization.findUniqueOrThrow({ where: { id: a.id } }),
      prisma.organization.findUniqueOrThrow({ where: { id: c.id } }),
    ]);
    expect(finalA.parentId).toBe(b.id);
    expect(finalC.parentId).toBe(d.id);
    await assertTopologyEquivalent('disjoint moves');
  });
});
