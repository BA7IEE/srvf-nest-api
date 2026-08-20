import type { INestApplication } from '@nestjs/common';
import { MemberStatus } from '@prisma/client';
import request from 'supertest';

import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { canonicalizeRegistrationFormDefinition } from '../../src/modules/activities/registration-form-definition';
import { loginAs } from '../fixtures/auth.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';
import { memberIdentityData } from '../helpers/member-identity.fixture';

const FORM = {
  fields: [
    {
      fieldCode: 'experience',
      typeCode: 'short_text',
      label: '相关经验',
      required: true,
      visibilityCode: 'self_only',
      exportable: false,
      sortOrder: 1,
      minLength: 1,
      maxLength: 100,
    },
    {
      fieldCode: 'proof',
      typeCode: 'file',
      label: '资质附件',
      required: false,
      visibilityCode: 'self_and_owner',
      exportable: false,
      sortOrder: 2,
    },
  ],
} as const;

describe('activity batch4 Form runtime', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let ownerAuth: string;
  let ownerUserId: string;
  let ownerMemberId: string;
  let otherAuth: string;
  let activityId: string;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);

    const org = await prisma.organization.create({
      data: { name: 'Batch4 Form Runtime', nodeTypeCode: 'team', sortOrder: 0 },
      select: { id: true },
    });
    const owner = await createTestUser(app, { username: 'batch4-form-owner' });
    const other = await createTestUser(app, { username: 'batch4-form-other' });
    ownerUserId = owner.id;
    const [ownerMember, otherMember] = await Promise.all([
      prisma.member.create({
        data: {
          memberNo: 'B4FORM-OWNER',
          ...memberIdentityData('Form Owner'),
          gradeCode: 'level-1',
          status: MemberStatus.ACTIVE,
        },
        select: { id: true },
      }),
      prisma.member.create({
        data: {
          memberNo: 'B4FORM-OTHER',
          ...memberIdentityData('Form Other'),
          gradeCode: 'level-1',
          status: MemberStatus.ACTIVE,
        },
        select: { id: true },
      }),
    ]);
    ownerMemberId = ownerMember.id;
    await Promise.all([
      prisma.user.update({ where: { id: owner.id }, data: { memberId: ownerMember.id } }),
      prisma.user.update({ where: { id: other.id }, data: { memberId: otherMember.id } }),
    ]);
    ownerAuth = (await loginAs(app, owner.username)).authHeader;
    otherAuth = (await loginAs(app, other.username)).authHeader;
    const activity = await prisma.activity.create({
      data: {
        title: 'Batch4 Form Draft',
        activityTypeCode: 'training',
        organizationId: org.id,
        initiatorMemberId: ownerMember.id,
        startAt: new Date('2099-10-01T08:00:00.000Z'),
        endAt: new Date('2099-10-01T12:00:00.000Z'),
        registrationDeadline: new Date('2099-09-30T23:59:59.000Z'),
        location: 'Form Test Field',
        statusCode: 'draft',
      },
      select: { id: true },
    });
    activityId = activity.id;
  });

  afterAll(async () => {
    await app.close();
  });

  it('implements Form PUT semantics, v3 change target nullability, managed ownership, and safe App detail projection', async () => {
    const path = `/api/app/v1/my/managed-activities/${activityId}/registration-form`;
    const initial = await request(httpServer(app)).get(path).set('Authorization', ownerAuth);
    expect(initial.status).toBe(200);
    expect(initial.body.data).toBeNull();

    expectBizError(
      await request(httpServer(app)).get(path).set('Authorization', otherAuth),
      BizCode.ACTIVITY_NOT_FOUND,
    );
    expectBizError(
      await request(httpServer(app))
        .put(path)
        .set('Authorization', ownerAuth)
        .send({ form: { fields: [] } }),
      BizCode.BAD_REQUEST,
      { strictMessage: false },
    );
    expectBizError(
      await request(httpServer(app)).put(path).set('Authorization', ownerAuth).send({}),
      BizCode.BAD_REQUEST,
      { strictMessage: false },
    );

    const created = await request(httpServer(app))
      .put(path)
      .set('Authorization', ownerAuth)
      .send({ form: FORM });
    expect(created.status).toBe(200);
    expect(created.body.data).toEqual({
      version: 1,
      fields: expect.arrayContaining([
        expect.objectContaining({ fieldCode: 'experience', options: null }),
        expect.objectContaining({ fieldCode: 'proof', typeCode: 'file', options: null }),
      ]),
    });
    const auditAfterCreate = await prisma.auditLog.count({
      where: { event: 'activity.publish', resourceId: activityId },
    });
    const versionAfterCreate = await prisma.registrationFormVersion.findFirstOrThrow({
      where: { activityId, version: 1 },
      select: { schemaHash: true, statusCode: true },
    });
    expect(versionAfterCreate).toEqual({ schemaHash: null, statusCode: 'draft' });

    const replay = await request(httpServer(app))
      .put(path)
      .set('Authorization', ownerAuth)
      .send({ form: { fields: [...FORM.fields].reverse() } });
    expect(replay.status).toBe(200);
    expect(replay.body.data.version).toBe(1);
    expect(await prisma.registrationFormVersion.count({ where: { activityId } })).toBe(1);
    expect(
      await prisma.auditLog.count({ where: { event: 'activity.publish', resourceId: activityId } }),
    ).toBe(auditAfterCreate);

    const removed = await request(httpServer(app))
      .put(path)
      .set('Authorization', ownerAuth)
      .send({ form: null });
    expect(removed.status).toBe(200);
    expect(removed.body.data).toBeNull();
    expect(
      await prisma.registrationFormVersion.findFirstOrThrow({
        where: { activityId, version: 1 },
        select: { statusCode: true },
      }),
    ).toEqual({ statusCode: 'retired' });

    const replacementForm = {
      fields: FORM.fields.map((field) =>
        field.fieldCode === 'experience' ? { ...field, label: '新的相关经验' } : field,
      ),
    };
    const replacement = await request(httpServer(app))
      .put(path)
      .set('Authorization', ownerAuth)
      .send({ form: replacementForm });
    expect(replacement.status).toBe(200);
    expect(replacement.body.data.version).toBe(2);

    const replacementHash = canonicalizeRegistrationFormDefinition(replacementForm).schemaHash;
    await prisma.registrationFormVersion.update({
      where: { activityId_version: { activityId, version: 2 } },
      data: {
        statusCode: 'active',
        schemaHash: replacementHash,
        workflowRevision: 3,
        activatedAt: new Date(),
      },
    });
    await prisma.activity.update({
      where: { id: activityId },
      data: { statusCode: 'published', publishedAt: new Date(), workflowRevision: 3 },
    });
    await prisma.activitySession.create({
      data: {
        activityId,
        code: 'batch4-form-runtime-live',
        name: 'Form Runtime Live Session',
        startAt: new Date('2099-10-01T08:00:00.000Z'),
        endAt: new Date('2099-10-01T12:00:00.000Z'),
        locationText: 'Form Test Field',
        checkInOpenAt: new Date('2099-10-01T07:30:00.000Z'),
        checkInCloseAt: new Date('2099-10-01T09:00:00.000Z'),
        checkOutOpenAt: new Date('2099-10-01T11:00:00.000Z'),
        checkOutCloseAt: new Date('2099-10-01T12:00:00.000Z'),
        locationRequired: false,
        locationPolicySourceCode: 'activity',
        statusCode: 'scheduled',
      },
    });
    await prisma.activityResponsibilityAssignment.create({
      data: {
        activityId,
        memberId: ownerMemberId,
        responsibilityType: 'owner',
        canManageRegistrations: true,
        canManageAttendance: true,
        assignedByUserId: ownerUserId,
        source: 'publish',
      },
    });

    const activeManaged = await request(httpServer(app)).get(path).set('Authorization', ownerAuth);
    expect(activeManaged.status).toBe(200);
    expect(activeManaged.body.data).toEqual(
      expect.objectContaining({ version: 2, fields: expect.any(Array) }),
    );
    const rejectedPublishedPut = await request(httpServer(app))
      .put(path)
      .set('Authorization', ownerAuth)
      .send({ form: replacementForm });
    expectBizError(rejectedPublishedPut, BizCode.ACTIVITY_CHANGE_REVIEW_REQUIRED);

    const changeBase = {
      confirmation: true,
      sessions: { create: [], update: [], cancel: [] },
      positions: { create: [], update: [], cancel: [] },
    };
    const omitted = await request(httpServer(app))
      .post(`/api/app/v1/my/managed-activities/${activityId}/change-reviews`)
      .set('Authorization', ownerAuth)
      .send({
        ...changeBase,
        operationKey: 'batch4-form-omitted-0001',
        activityPatch: { title: '保留当前表单的变更' },
      });
    expect(omitted.status).toBe(200);
    expect(omitted.body.data.snapshot).toMatchObject({
      schemaVersion: 4,
      registrationForm: expect.objectContaining({ schemaHash: replacementHash }),
    });
    await request(httpServer(app))
      .post(`/api/app/v1/my/managed-activities/${activityId}/reviews/withdraw`)
      .set('Authorization', ownerAuth)
      .send({})
      .expect(200);

    const remove = await request(httpServer(app))
      .post(`/api/app/v1/my/managed-activities/${activityId}/change-reviews`)
      .set('Authorization', ownerAuth)
      .send({
        ...changeBase,
        operationKey: 'batch4-form-null-0001',
        activityPatch: { title: '移除当前表单的变更' },
        registrationForm: null,
      });
    expect(remove.status).toBe(200);
    expect(remove.body.data.snapshot).toMatchObject({ schemaVersion: 4, registrationForm: null });
    await request(httpServer(app))
      .post(`/api/app/v1/my/managed-activities/${activityId}/reviews/withdraw`)
      .set('Authorization', ownerAuth)
      .send({})
      .expect(200);

    const proposedForm = {
      fields: replacementForm.fields.map((field) =>
        field.fieldCode === 'proof' ? { ...field, label: '新的资质附件' } : field,
      ),
    };
    const proposedHash = canonicalizeRegistrationFormDefinition(proposedForm).schemaHash;
    const replace = await request(httpServer(app))
      .post(`/api/app/v1/my/managed-activities/${activityId}/change-reviews`)
      .set('Authorization', ownerAuth)
      .send({
        ...changeBase,
        operationKey: 'batch4-form-object-0001',
        activityPatch: { title: '替换当前表单的变更' },
        registrationForm: proposedForm,
      });
    expect(replace.status).toBe(200);
    expect(replace.body.data.snapshot).toMatchObject({
      schemaVersion: 4,
      registrationForm: expect.objectContaining({ schemaHash: proposedHash }),
    });

    const detail = await request(httpServer(app))
      .get(`/api/app/v1/activities/${activityId}`)
      .set('Authorization', ownerAuth);
    expect(detail.status).toBe(200);
    expect(detail.body.data.formVersion).toBe(2);
    expect(detail.body.data.registrationForm).toEqual({
      version: 2,
      fields: expect.arrayContaining([
        expect.objectContaining({ fieldCode: 'experience', label: '新的相关经验' }),
        expect.objectContaining({ fieldCode: 'proof', typeCode: 'file' }),
      ]),
    });
    expect(JSON.stringify(detail.body.data.registrationForm)).not.toMatch(
      /schemaHash|workflowRevision|createdAt|updatedAt|"id"/,
    );
  });
});
