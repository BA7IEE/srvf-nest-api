import type { INestApplication } from '@nestjs/common';
import { MemberStatus, Role } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import request from 'supertest';

import { PrismaService } from '../../src/database/prisma.service';
import { ActivityQualificationEvaluatorService } from '../../src/modules/activity-registrations/activity-qualification-evaluator.service';
import { MemberQualificationFactsService } from '../../src/modules/member-profiles/member-qualification-facts.service';
import { loginAs } from '../fixtures/auth.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { httpServer } from '../helpers/http-server';
import { memberIdentityData } from '../helpers/member-identity.fixture';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// This is an isolated CI worker database role, not a deployment ACL recommendation.
// The owner creates fixtures and obtains the ordinary USER token; every detail
// request runs through a second real Nest app whose DB current_user is SELECT-only.
describe('App activity detail with a SELECT-only database role', () => {
  let ownerApp: INestApplication | undefined;
  let readerApp: INestApplication | undefined;
  let owner: PrismaService;
  let reader: PrismaService;
  let roleCreated = false;
  const roleName = `qa_detail_read_${randomBytes(8).toString('hex')}`;
  const quotedRole = `"${roleName}"`;
  let activityId: string;
  let memberId: string;
  let auth: string;

  beforeAll(async () => {
    ownerApp = await createTestApp();
    owner = ownerApp.get(PrismaService);
    const databases = await owner.$queryRaw<
      Array<{ name: string }>
    >`SELECT current_database() AS name`;
    expect(databases[0].name).toMatch(/^app_test(?:_[a-zA-Z0-9_]+)?$/);
    await resetDb(ownerApp);
    const org = await owner.organization.create({
      data: { name: 'Detail read role fixture', nodeTypeCode: 'detail-read-root' },
    });
    const user = await createTestUser(ownerApp, {
      username: 'detail-read-member',
      role: Role.USER,
    });
    const member = await owner.member.create({
      data: {
        memberNo: 'DETAIL-READ-1',
        ...memberIdentityData('Detail read fixture'),
        gradeCode: 'level-1',
        status: MemberStatus.ACTIVE,
      },
    });
    memberId = member.id;
    await owner.user.update({ where: { id: user.id }, data: { memberId } });
    await owner.memberOrganizationMembership.create({ data: { memberId, organizationId: org.id } });
    auth = (await loginAs(ownerApp, user.username)).authHeader;
    const activity = await owner.activity.create({
      data: {
        title: 'No rule read role',
        activityTypeCode: 'training',
        organizationId: org.id,
        startAt: new Date('2199-01-01T00:00:00Z'),
        endAt: new Date('2199-01-01T02:00:00Z'),
        location: 'Synthetic fixture',
        statusCode: 'published',
        publishedAt: new Date(),
        isPublicRegistration: true,
      },
    });
    activityId = activity.id;
    // Generated hexadecimal identifier only; no user input, password, membership or owner grant.
    await owner.$executeRawUnsafe(
      `CREATE ROLE ${quotedRole} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`,
    );
    roleCreated = true;
    await owner.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO ${quotedRole}`);
    await owner.$executeRawUnsafe(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${quotedRole}`);
    const originalUrl = process.env.DATABASE_URL;
    if (!originalUrl) throw new Error('isolated worker database URL required');
    const url = new URL(originalUrl);
    // PostgreSQL startup role is checked below: an ignored options parameter must fail.
    url.searchParams.set('options', `-c role=${roleName}`);
    try {
      process.env.DATABASE_URL = url.toString();
      readerApp = await createTestApp();
    } finally {
      process.env.DATABASE_URL = originalUrl;
    }
    reader = readerApp.get(PrismaService);
    const identities = await reader.$queryRaw<Array<{ role: string }>>`SELECT current_user AS role`;
    expect(identities).toEqual([{ role: roleName }]);
  });

  afterAll(async () => {
    try {
      await readerApp?.close();
    } finally {
      try {
        if (roleCreated) {
          await owner.$executeRawUnsafe(
            `REVOKE SELECT ON ALL TABLES IN SCHEMA public FROM ${quotedRole}`,
          );
          await owner.$executeRawUnsafe(`REVOKE USAGE ON SCHEMA public FROM ${quotedRole}`);
          await owner.$executeRawUnsafe(`DROP ROLE ${quotedRole}`);
        }
      } finally {
        await ownerApp?.close();
      }
    }
  });

  it('denies the old member fact lock but serves no-rule detail over real HTTP without snapshots', async () => {
    const facts = readerApp!.get(MemberQualificationFactsService);
    await expect(facts.readForQualification(memberId)).rejects.toMatchObject({
      code: 'P2010',
      meta: expect.objectContaining({ code: '42501' }) as unknown,
    });
    const before = await owner.qualificationEvaluationSnapshot.count();
    const response = await request(httpServer(readerApp!))
      .get(`/api/app/v1/activities/${activityId}`)
      .set('Authorization', auth)
      .expect(200);
    expect(response.body).toMatchObject({
      code: 0,
      data: { id: activityId, qualification: { resultCode: 'pass', unmetRules: [] } },
    });
    expect(await owner.qualificationEvaluationSnapshot.count()).toBe(before);
  });

  it('retains real member locks when an active rule applies rather than silently bypassing it', async () => {
    const ruleSet = await owner.activityQualificationRuleSet.create({
      data: {
        activityId,
        version: 1,
        statusCode: 'draft',
        rules: {
          create: {
            ruleTypeCode: 'grade',
            enforcementCode: 'block',
            operator: 'in',
            valueJson: { codes: ['level-1'] },
            sortOrder: 1,
          },
        },
      },
    });
    await owner.activityQualificationRuleSet.update({
      where: { id: ruleSet.id },
      data: { statusCode: 'active' },
    });
    const evaluator = readerApp!.get(ActivityQualificationEvaluatorService);
    const activity = await owner.activity.findUniqueOrThrow({ where: { id: activityId } });
    await expect(
      reader.$transaction((tx) => evaluator.evaluate({ activity, memberId, tx })),
    ).rejects.toMatchObject({
      code: 'P2010',
      meta: expect.objectContaining({
        code: '42501',
        message: expect.stringContaining('Member') as unknown,
      }) as unknown,
    });
    const before = await owner.qualificationEvaluationSnapshot.count();
    const response = await request(httpServer(readerApp!))
      .get(`/api/app/v1/activities/${activityId}`)
      .set('Authorization', auth)
      .expect(500);
    expect(response.body).toMatchObject({ code: 50000 });
    expect(await owner.qualificationEvaluationSnapshot.count()).toBe(before);
    // Positive control uses the real owner-backed app, not mocks or weakened locks.
    const control = await request(httpServer(ownerApp!))
      .get(`/api/app/v1/activities/${activityId}`)
      .set('Authorization', auth)
      .expect(200);
    expect(control.body).toMatchObject({
      code: 0,
      data: { qualification: { resultCode: 'pass' } },
    });
    expect(await owner.qualificationEvaluationSnapshot.count()).toBe(before + 1);
  });
});
