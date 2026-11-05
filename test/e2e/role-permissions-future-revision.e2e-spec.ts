import { createHash } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Role } from '@prisma/client';
import request from 'supertest';
import { PrismaService } from '../../src/database/prisma.service';
import { loginAs } from '../fixtures/auth.fixture';
import { createTestUser, TEST_PASSWORD } from '../fixtures/users.fixture';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';
import { deriveTestDbName } from '../setup/worktree-db';

// The standard guarded fixture reset isolates this suite from other workers.
describe('R04A future revision and changing high-risk difference', () => {
  let appA: INestApplication;
  let appB: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    appA = await createTestApp();
    await resetDb(appA);
    appB = await createTestApp();
    prisma = appA.get(PrismaService);
  });

  afterAll(async () => {
    await Promise.all([appA?.close(), appB?.close()]);
  });

  it('requires a proof when the locked difference becomes high risk', async () => {
    const [db] = await prisma.$queryRaw<Array<{ name: string }>>`SELECT current_database() AS name`;
    expect(db.name).toBe(deriveTestDbName());
    await createTestUser(appA, { username: 'r04a-future-a', role: Role.SUPER_ADMIN });
    await createTestUser(appA, { username: 'r04a-future-b', role: Role.SUPER_ADMIN });
    const authA = (await loginAs(appA, 'r04a-future-a')).authHeader;
    const authB = (await loginAs(appB, 'r04a-future-b')).authHeader;
    const role = await prisma.rbacRole.create({
      data: { code: 'r04a-future-target', displayName: 'R04A synthetic target' },
      select: { id: true, permissionRevision: true },
    });
    const code = 'rbac.synthetic.read';
    const permission = await prisma.permission.create({
      data: { code, module: 'rbac', action: 'synthetic', resourceType: 'read' },
    });
    await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: permission.id } });
    expect(role.permissionRevision).toBe(0);

    const payloadHash = createHash('sha256').update(JSON.stringify([])).digest('base64url');
    const proof = await request(httpServer(appB))
      .post('/api/auth/v1/step-up/password')
      .set('Authorization', authB)
      .send({
        action: 'RBAC_ROLE_PERMISSION_SET_REPLACE',
        password: TEST_PASSWORD,
        rolePermissionSet: { roleId: role.id, expectedRevision: 0, payloadHash },
      })
      .expect(200);
    expect(typeof proof.body.data.stepUpToken).toBe('string');

    let release!: () => void;
    let ready!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const blockerReady = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const blocker = prisma.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe('LOCK TABLE "role_permissions" IN SHARE MODE');
        ready();
        await released;
      },
      { timeout: 10000 },
    );
    await blockerReady;
    const endpoint = `/api/system/v1/roles/${role.id}/permissions`;
    const waitFor = async (expected: number): Promise<void> => {
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        const [r] = await prisma.$queryRaw<Array<{ count: number }>>`
          SELECT count(*)::int AS count FROM pg_stat_activity
          WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock'
            AND (query LIKE '%"role_permissions"%' OR query LIKE '%"roles"%')
        `;
        if (r.count >= expected) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error(`expected ${expected} independent lock waiters`);
    };

    let b: Promise<request.Response> | undefined;
    let a: Promise<request.Response> | undefined;
    try {
      // B holds the role lock and is stalled before committing the removal.
      b = Promise.resolve(
        request(httpServer(appB)).put(endpoint).set('Authorization', authB).send({
          permissionCodes: [],
          expectedRevision: 0,
          stepUpToken: proof.body.data.stepUpToken,
        }),
      );
      await waitFor(1);
      // A sees the still-committed high-risk permission (no unlocked diff),
      // but submits a future revision without its own proof.
      a = Promise.resolve(
        request(httpServer(appA))
          .put(endpoint)
          .set('Authorization', authA)
          .send({
            permissionCodes: [code],
            expectedRevision: 1,
          }),
      );
      await waitFor(2);
    } finally {
      release();
      await blocker;
    }
    if (a === undefined || b === undefined) throw new Error('both requests must start');
    const [aResponse, bResponse] = await Promise.all([a, b]);
    const stored = await prisma.rbacRole.findUniqueOrThrow({
      where: { id: role.id },
      select: { permissionRevision: true },
    });
    const memberships = await prisma.rolePermission.findMany({
      where: { roleId: role.id },
      select: { permission: { select: { code: true } } },
    });
    const codes = memberships.map((entry) => entry.permission.code).sort();
    // Only closed test codes/statuses are logged; no credentials or proof.
    console.info(
      'R04A_OBSERVED',
      JSON.stringify({
        aStatus: aResponse.status,
        aCode: aResponse.body.code,
        bStatus: bResponse.status,
        bCode: bResponse.body.code,
        revision: stored.permissionRevision,
        codes,
      }),
    );
    expect(bResponse.status).toBe(200);
    expect({ aStatus: aResponse.status, aCode: aResponse.body.code }).toEqual({
      aStatus: 403,
      aCode: 30112,
    });
    expect(stored.permissionRevision).toBe(1);
    expect(codes).toEqual([]);
  }, 30000);
});
