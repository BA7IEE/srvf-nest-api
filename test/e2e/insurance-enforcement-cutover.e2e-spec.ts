import type { INestApplication } from '@nestjs/common';
import { MemberStatus, Role } from '@prisma/client';
import request from 'supertest';

import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { loginAs } from '../fixtures/auth.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

describe('D-INSURANCE v3 PR3 App expectedVersion cutover', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let previousGate: string | undefined;

  beforeAll(async () => {
    previousGate = process.env.INSURANCE_ENFORCEMENT_ENABLED;
    process.env.INSURANCE_ENFORCEMENT_ENABLED = 'true';
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
    if (previousGate === undefined) delete process.env.INSURANCE_ENFORCEMENT_ENABLED;
    else process.env.INSURANCE_ENFORCEMENT_ENABLED = previousGate;
  });

  async function setupOwner(username: string) {
    const user = await createTestUser(app, { username, role: Role.USER });
    const member = await prisma.member.create({
      data: {
        memberNo: `CAS-${username}`,
        displayName: username,
        status: MemberStatus.ACTIVE,
      },
    });
    await prisma.user.update({ where: { id: user.id }, data: { memberId: member.id } });
    const insurance = await prisma.memberInsurance.create({
      data: {
        memberId: member.id,
        insurerName: '原保险公司',
        policyNumber: `POLICY-${username}`,
        coverageEnd: new Date('2099-12-31T00:00:00.000Z'),
      },
    });
    const { authHeader } = await loginAs(app, username);
    return { authHeader, insurance };
  }

  it.each(['PATCH', 'DELETE'] as const)(
    '%s missing expectedVersion -> 40000 before transaction, with zero mutation/audit',
    async (operation) => {
      const { authHeader, insurance } = await setupOwner(`missing-${operation.toLowerCase()}`);
      const before = await prisma.memberInsurance.findUniqueOrThrow({
        where: { id: insurance.id },
      });

      const res =
        operation === 'PATCH'
          ? await request(httpServer(app))
              .patch(`/api/app/v1/me/insurances/${insurance.id}`)
              .set('Authorization', authHeader)
              .send({ insurerName: '不得写入' })
          : await request(httpServer(app))
              .delete(`/api/app/v1/me/insurances/${insurance.id}`)
              .set('Authorization', authHeader);
      expectBizError(res, BizCode.BAD_REQUEST);

      const after = await prisma.memberInsurance.findUniqueOrThrow({ where: { id: insurance.id } });
      expect(after.insurerName).toBe(before.insurerName);
      expect(after.version).toBe(before.version);
      expect(after.deletedAt).toBeNull();
      expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
      expect(
        await prisma.auditLog.count({
          where: {
            resourceId: insurance.id,
            event: {
              in: ['member-insurance.update.self', 'member-insurance.delete.self'],
            },
          },
        }),
      ).toBe(0);
    },
  );

  it('PATCH expectedVersion=null 归一为缺失 → 40000 且零写/零 audit', async () => {
    const { authHeader, insurance } = await setupOwner('missing-patch-null');
    const before = await prisma.memberInsurance.findUniqueOrThrow({ where: { id: insurance.id } });
    const res = await request(httpServer(app))
      .patch(`/api/app/v1/me/insurances/${insurance.id}`)
      .set('Authorization', authHeader)
      .send({ insurerName: '不得写入', expectedVersion: null });
    expectBizError(res, BizCode.BAD_REQUEST);

    const after = await prisma.memberInsurance.findUniqueOrThrow({ where: { id: insurance.id } });
    expect(after.insurerName).toBe(before.insurerName);
    expect(after.version).toBe(before.version);
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
    expect(await prisma.auditLog.count({ where: { resourceId: insurance.id } })).toBe(0);
  });

  it.each([
    ['empty', ''],
    ['whitespace', '%20%20'],
  ] as const)(
    'DELETE expectedVersion=%s 归一为缺失 → 40000 且零写/零 audit',
    async (label, raw) => {
      const { authHeader, insurance } = await setupOwner(`missing-delete-${label}`);
      const res = await request(httpServer(app))
        .delete(`/api/app/v1/me/insurances/${insurance.id}?expectedVersion=${raw}`)
        .set('Authorization', authHeader);
      expectBizError(res, BizCode.BAD_REQUEST);

      const after = await prisma.memberInsurance.findUniqueOrThrow({ where: { id: insurance.id } });
      expect(after.deletedAt).toBeNull();
      expect(after.version).toBe(0);
      expect(await prisma.auditLog.count({ where: { resourceId: insurance.id } })).toBe(0);
    },
  );

  it.each(['PATCH', 'DELETE'] as const)(
    '%s explicit stale expectedVersion remains 26011 with zero mutation/audit',
    async (operation) => {
      const { authHeader, insurance } = await setupOwner(`stale-${operation.toLowerCase()}`);
      await prisma.memberInsurance.update({ where: { id: insurance.id }, data: { version: 3 } });
      const before = await prisma.memberInsurance.findUniqueOrThrow({
        where: { id: insurance.id },
      });

      const res =
        operation === 'PATCH'
          ? await request(httpServer(app))
              .patch(`/api/app/v1/me/insurances/${insurance.id}`)
              .set('Authorization', authHeader)
              .send({ insurerName: '不得写入', expectedVersion: 2 })
          : await request(httpServer(app))
              .delete(`/api/app/v1/me/insurances/${insurance.id}?expectedVersion=2`)
              .set('Authorization', authHeader);
      expectBizError(res, BizCode.MEMBER_INSURANCE_VERSION_CONFLICT);

      const after = await prisma.memberInsurance.findUniqueOrThrow({ where: { id: insurance.id } });
      expect(after.insurerName).toBe(before.insurerName);
      expect(after.version).toBe(3);
      expect(after.deletedAt).toBeNull();
      expect(
        await prisma.auditLog.count({
          where: {
            resourceId: insurance.id,
            event: {
              in: ['member-insurance.update.self', 'member-insurance.delete.self'],
            },
          },
        }),
      ).toBe(0);
    },
  );
});
