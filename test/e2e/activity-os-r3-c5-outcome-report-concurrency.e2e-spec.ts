import type { INestApplication } from '@nestjs/common';
import { Role } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { PrismaService } from '../../src/database/prisma.service';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { createTestApp } from '../setup/test-app';
import { resetDb } from '../setup/reset-db';
import { assertConnectedTestDatabase } from '../setup/test-db';
import { createTestUser } from '../fixtures/users.fixture';
import { loginAs } from '../fixtures/auth.fixture';
import { memberIdentityData } from '../helpers/member-identity.fixture';
import { httpServer } from '../helpers/http-server';
import { expectBizError } from '../helpers/biz-code.assert';
import { waitFor } from '../helpers/wait-for';

describe('C5 independent-pool lock waits', () => {
  let app: INestApplication;
  let peer: INestApplication;
  let prisma: PrismaService;
  let auth: string;
  let userId: string;
  let memberId: string;
  let organizationId: string;
  let roleId: string;
  const key = () => `c5lock_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
  beforeAll(async () => {
    app = await createTestApp();
    peer = await createTestApp();
    prisma = app.get(PrismaService);
    await assertConnectedTestDatabase(prisma);
    await assertConnectedTestDatabase(peer.get(PrismaService));
    await resetDb(app);
    const user = await createTestUser(app, { username: key(), role: Role.SUPER_ADMIN });
    userId = user.id;
    memberId = (
      await prisma.member.create({
        data: { memberNo: key(), ...memberIdentityData('并发读取'), gradeCode: 'level-3' },
      })
    ).id;
    await prisma.user.update({ where: { id: userId }, data: { memberId } });
    auth = (await loginAs(app, user.username)).authHeader;
    const root = await prisma.organization.create({ data: { name: key(), nodeTypeCode: 'root' } });
    organizationId = (
      await prisma.organization.create({
        data: { name: key(), nodeTypeCode: 'team', parentId: root.id },
      })
    ).id;
    roleId = (await prisma.rbacRole.create({ data: { code: key(), displayName: 'C5并发读' } })).id;
    const permission = await prisma.permission.upsert({
      where: { code: 'activity.outcome.read' },
      update: {},
      create: {
        code: 'activity.outcome.read',
        module: 'activity',
        action: 'outcome',
        resourceType: 'read',
        description: '测试',
        servicePrincipalAllowed: false,
        delegatedAccessAllowed: false,
      },
    });
    await prisma.rolePermission.create({ data: { roleId, permissionId: permission.id } });
  });
  afterAll(async () => {
    await peer?.close();
    await app?.close();
  });

  it.each(['selection', 'grant', 'initiator', 'owner'] as const)(
    're-reads %s after an actual Activity lock wait',
    async (mode) => {
      const binding = await prisma.roleBinding.create({
        data: { principalType: 'USER', principalId: userId, roleId, scopeType: 'GLOBAL' },
      });
      const row = await prisma.activity.create({
        data: {
          title: key(),
          activityTypeCode: 'training',
          allocationModeCode: 'first_come',
          organizationId,
          initiatorMemberId: memberId,
          statusCode: 'draft',
          startAt: new Date('2099-09-01'),
          endAt: new Date('2099-09-02'),
          location: '测试',
        },
      });
      const second = await prisma.activity.create({
        data: {
          title: key(),
          activityTypeCode: 'training',
          allocationModeCode: 'first_come',
          organizationId,
          initiatorMemberId: memberId,
          statusCode: 'draft',
          startAt: new Date('2099-09-01'),
          endAt: new Date('2099-09-02'),
          location: '测试',
        },
      });
      if (mode === 'owner') {
        await prisma.activityResponsibilityAssignment.create({
          data: {
            activityId: row.id,
            memberId,
            responsibilityType: 'owner',
            status: 'active',
            assignedByUserId: userId,
            source: 'publish',
            canManageRegistrations: true,
            canManageAttendance: true,
          },
        });
        await prisma.activity.update({ where: { id: row.id }, data: { statusCode: 'completed' } });
      }
      let unlock!: () => void;
      let ready!: (pid: number) => void;
      const released = new Promise<void>((resolve) => {
        unlock = resolve;
      });
      const acquired = new Promise<number>((resolve) => {
        ready = resolve;
      });
      const holder = prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT "id" FROM "Activity" WHERE "id" = ${row.id} FOR UPDATE`;
          const [pid] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
          ready(pid.pid);
          await released;
          if (mode === 'selection')
            await tx.activity.update({
              where: { id: row.id },
              data: { metricRequirementCode: 'not_required', metricSelectionRevision: 1 },
            });
          if (mode === 'initiator') {
            const other = await tx.member.create({
              data: { memberNo: key(), ...memberIdentityData('另一发起人'), gradeCode: 'level-3' },
            });
            await tx.activity.update({
              where: { id: row.id },
              data: { initiatorMemberId: other.id },
            });
          }
          if (mode === 'grant')
            await tx.roleBinding.update({
              where: { id: binding.id },
              data: { status: 'SUSPENDED' },
            });
          if (mode === 'owner')
            await tx.activityResponsibilityAssignment.updateMany({
              where: {
                activityId: row.id,
                memberId,
                responsibilityType: 'owner',
                status: 'active',
              },
              data: { status: 'revoked', endedAt: new Date() },
            });
        },
        { timeout: 15000 },
      );
      const pid = await Promise.race([
        acquired,
        holder.then(() => {
          throw new Error('holder ended before lock');
        }),
      ]);
      const result = request(httpServer(peer))
        .post('/api/app/v1/my/managed-activities/outcome-reports/query')
        .send({ activityIds: [second.id, row.id].sort().reverse() })
        .set('Authorization', auth)
        .then((value) => value);
      const opposite = request(httpServer(app))
        .post('/api/app/v1/my/managed-activities/outcome-reports/query')
        .send({ activityIds: [second.id, row.id].sort() })
        .set('Authorization', auth)
        .then((value) => value);
      try {
        await waitFor(
          async () => {
            const [waiting] = await prisma.$queryRaw<{ count: bigint }[]>`
          SELECT count(*) FROM pg_stat_activity AS a WHERE a.datname = current_database()
          AND a.wait_event_type = 'Lock' AND ${pid} = ANY(pg_blocking_pids(a.pid))`;
            return waiting.count > 0n;
          },
          { timeoutMs: 5000, message: 'C5 did not wait on the held Activity lock' },
        );
        unlock();
        await holder;
        const response = await result;
        const otherResponse = await opposite;
        expect(otherResponse.status).toBe(response.status);
        expect(otherResponse.body).toEqual(response.body);
        if (mode === 'selection') {
          expect(response.status).toBe(200);
          expect(
            response.body.data.items.map((item: { activityId: string }) => item.activityId),
          ).toEqual([row.id, second.id].sort());
          const report = response.body.data.items.find(
            (item: { activityId: string }) => item.activityId === row.id,
          );
          expect(report.metricRequirementCode).toBe('not_required');
          expect(report.metricSelectionRevision).toBe(1);
          expect(report.currentConfirmed).toBeNull();
        } else expectBizError(response, BizCode.ACTIVITY_OUTCOME_REFERENCE_UNAVAILABLE);
      } finally {
        unlock();
        await holder;
        await result;
        await opposite;
        await prisma.roleBinding.update({
          where: { id: binding.id },
          data: { status: 'SUSPENDED' },
        });
      }
    },
  );
});
