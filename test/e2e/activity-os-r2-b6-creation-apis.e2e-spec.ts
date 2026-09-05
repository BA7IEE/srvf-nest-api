import type { INestApplication } from '@nestjs/common';
import { Role } from '@prisma/client';
import request from 'supertest';
import { plainToInstance } from 'class-transformer';
import type { CurrentUserPayload } from '../../src/common/decorators/current-user.decorator';
import { ActivityCreationService } from '../../src/modules/activities/activity-creation.service';
import { ActivityCreationProfessional } from '../../src/modules/activities/activity-creation-professional';
import { mapProfessionalCreation } from '../../src/modules/activities/activity-creation-command';
import { AppProfessionalActivityCreationDto } from '../../src/modules/activities/dto/app/app-managed-activity-creation-professional.dto';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { ActivityAuditRecorder } from '../../src/modules/activities/activity-audit-recorder';
import { ActivityDraftService } from '../../src/modules/activities/activity-draft.service';
import { ActivityWriteService } from '../../src/modules/activities/activity-write.service';
import { RegistrationFormVersionService } from '../../src/modules/activities/registration-form-version.service';
import { QualificationRuleSetVersionService } from '../../src/modules/activities/qualification-rule-set-version.service';
import { computeActivityTemplateDefinitionHash } from '../../src/modules/activities/activity-template-definition';
import * as placeWriter from '../../src/modules/activities/activity-place-writer';
import { createTestUser } from '../fixtures/users.fixture';
import { loginAs } from '../fixtures/auth.fixture';
import { memberIdentityData } from '../helpers/member-identity.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

const ROOT = '/api/app/v1/my/managed-activities';
const START = '2099-09-01T08:00:00.000Z';
const END = '2099-09-01T12:00:00.000Z';
type CreationResponse = {
  data: {
    activity: { activityId: string; createdAt: string; createdStatusCode: string };
    mode: string;
    replayed: boolean;
  };
};

describe('B6 quick and professional creation: real root transactions', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let auth: string;
  let memberId: string;
  let actor: CurrentUserPayload;
  let organizationId: string;
  let sequence = 0;
  const previousGate = process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED;
  const previousControlMode = process.env.ACTIVITY_OS_CONTROL_PLANE_MODE;
  const unique = (label: string) => `b6-create-${label}-${++sequence}`;

  beforeAll(async () => {
    process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED = 'true';
    process.env.ACTIVITY_OS_CONTROL_PLANE_MODE = 'active';
    app = await createTestApp();
    prisma = app.get(PrismaService);
    await resetDb(app);
    const root = await prisma.organization.create({
      data: { name: unique('root'), nodeTypeCode: 'root' },
    });
    const org = await prisma.organization.create({
      data: { name: unique('team'), nodeTypeCode: 'team', parentId: root.id },
    });
    organizationId = org.id;
    const member = await prisma.member.create({
      data: {
        memberNo: unique('member'),
        ...memberIdentityData('B6 创建测试'),
        gradeCode: 'level-3',
      },
    });
    memberId = member.id;
    const user = await createTestUser(app, { username: unique('actor'), role: Role.SUPER_ADMIN });
    await prisma.user.update({ where: { id: user.id }, data: { memberId } });
    actor = {
      id: user.id,
      username: user.username,
      role: Role.SUPER_ADMIN,
      status: 'ACTIVE',
      memberId,
    };
    await prisma.memberOrganizationMembership.create({ data: { memberId, organizationId } });
    auth = (await loginAs(app, user.username)).authHeader;
    const type = await prisma.dictType.create({
      data: { code: 'activity_type', label: '活动类型' },
    });
    await prisma.dictItem.create({ data: { typeId: type.id, code: 'b6-training', label: '训练' } });
    const roles = await prisma.dictType.create({
      data: { code: 'attendance_role', label: '岗位' },
    });
    await prisma.dictItem.create({ data: { typeId: roles.id, code: 'b6-support', label: '保障' } });
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => {
    await app.close();
    if (previousGate === undefined) delete process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED;
    else process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED = previousGate;
    if (previousControlMode === undefined) delete process.env.ACTIVITY_OS_CONTROL_PLANE_MODE;
    else process.env.ACTIVITY_OS_CONTROL_PLANE_MODE = previousControlMode;
  });

  function professional() {
    return {
      operationKey: unique('operation'),
      title: 'B6 专业创建',
      organizationId,
      activityTypeCode: 'b6-training',
      allocationModeCode: 'first_come',
      initiatorMemberId: memberId,
      startAt: START,
      endAt: END,
      location: '粗略地点',
      capacity: 10,
      sessions: [
        {
          session: {
            code: 'morning',
            name: '上午场',
            startAt: START,
            endAt: END,
            locationText: '场次文字',
            checkInOpenAt: START,
            checkInCloseAt: '2099-09-01T08:30:00.000Z',
            checkOutOpenAt: '2099-09-01T11:30:00.000Z',
            checkOutCloseAt: END,
            locationRequired: false,
            capacity: 10,
          },
          positions: [
            { code: 'support', name: '保障岗位', attendanceRoleCode: 'b6-support', capacity: 10 },
          ],
        },
      ],
      places: [
        {
          roleCode: 'primary',
          visibilityCode: 'staff',
          inline: {
            name: '活动地点',
            addressText: '精确活动地址',
            checkInEligible: false,
            coordinate: { longitude: 120.1, latitude: 30.2, coordinateSystemCode: 'wgs84' },
          },
        },
        {
          sessionCode: 'morning',
          roleCode: 'primary',
          visibilityCode: 'accepted',
          inline: {
            name: '场次地点',
            addressText: '精确场次地址',
            checkInEligible: false,
          },
        },
      ],
      form: {
        fields: [
          {
            fieldCode: 'transport',
            typeCode: 'short_text',
            label: '出行说明',
            required: false,
            visibilityCode: 'self_only',
            exportable: false,
            sortOrder: 0,
            governance: {
              purposeCode: 'transport_logistics',
              dataClassCode: 'ordinary',
              retentionPolicyCode: 'activity_lifecycle',
              maskingPolicyCode: 'none',
              prefillSourceCode: null,
            },
          },
        ],
      },
      qualificationRuleSets: [
        {
          sessionCode: 'morning',
          positionCode: 'support',
          rules: [
            {
              ruleTypeCode: 'grade',
              enforcementCode: 'block',
              operator: 'in',
              codes: ['level-3'],
              sortOrder: 0,
            },
          ],
        },
      ],
    };
  }
  const post = (path: string, body: unknown) =>
    request(httpServer(app))
      .post(`${ROOT}/${path}`)
      .set('Authorization', auth)
      .send(body as object);

  async function counts() {
    return Promise.all([
      prisma.activity.count(),
      prisma.activitySession.count(),
      prisma.activitySessionPosition.count(),
      prisma.activityPlace.count(),
      prisma.registrationFormVersion.count(),
      prisma.activityQualificationRuleSet.count(),
      prisma.activityCreationCommandReceipt.count(),
      prisma.auditLog.count({ where: { event: 'activity.publish' } }),
      prisma.notificationOutboxIntent.count(),
    ]);
  }

  async function template() {
    const definition = {
      activity: { allocationModeCode: 'first_come', capacity: 10 },
      sessions: [
        {
          code: 'morning',
          name: '上午场',
          startOffsetMinutes: 0,
          endOffsetMinutes: 120,
          locationText: '模板场次地点',
          capacity: 10,
          checkInOpenOffsetMinutes: 0,
          checkInCloseOffsetMinutes: 30,
          checkOutOpenOffsetMinutes: -30,
          checkOutCloseOffsetMinutes: 0,
          locationRequired: false,
          lateGraceMinutes: 10,
          earlyLeaveThresholdMinutes: 10,
          sortOrder: 0,
          positions: [
            {
              code: 'support',
              name: '保障岗位',
              attendanceRoleCode: 'b6-support',
              capacity: 10,
              sortOrder: 0,
            },
          ],
        },
      ],
    };
    const family = await prisma.activityTemplateFamily.create({
      data: {
        code: unique('family'),
        name: 'B6 模板族',
        categoryCode: 'training',
        scopeTypeCode: 'organization',
        statusCode: 'inventory',
      },
    });
    const row = await prisma.activityTemplate.create({
      data: {
        code: unique('template'),
        name: 'B6 模板',
        activityTypeCode: 'b6-training',
        version: 1,
        familyId: family.id,
        statusCode: 'draft',
        schemaVersion: 1,
        definitionJson: definition,
        definitionHash: computeActivityTemplateDefinitionHash({ schemaVersion: 1, definition }),
        effectiveFrom: new Date('2099-01-01T00:00:00.000Z'),
      },
    });
    await prisma.activityTemplate.update({ where: { id: row.id }, data: { statusCode: 'active' } });
    return row.id;
  }

  it('professional service materializes all supported structures with the caller root transaction', async () => {
    const result = await app
      .get(ActivityCreationService)
      .createProfessional(
        mapProfessionalCreation(
          plainToInstance(AppProfessionalActivityCreationDto, professional()),
        ),
        actor,
        { requestId: 'b6-direct-positive', ip: null, ua: 'jest' },
      );
    expect(result.replayed).toBe(false);
    expect(
      await prisma.activitySession.count({ where: { activityId: result.activity.activityId } }),
    ).toBe(1);
  });

  it('professional commits activity/session/position/places/governed form/qualification/receipt/audit as one creation', async () => {
    const input = professional();
    const before = await counts();
    const response = await post('professional', input).expect(201);
    const result = (response.body as CreationResponse).data;
    expect(result.mode).toBe('professional');
    expect(result.replayed).toBe(false);
    expect(result.activity.createdStatusCode).toBe('draft');
    const after = await counts();
    expect(after.map((count, i) => count - before[i])).toEqual([1, 1, 1, 2, 1, 1, 1, 1, 0]);
    const activity = await prisma.activity.findUniqueOrThrow({
      where: { id: result.activity.activityId },
    });
    expect(activity.statusCode).toBe('draft');
    const receipt = await prisma.activityCreationCommandReceipt.findUniqueOrThrow({
      where: { activityId: activity.id },
    });
    expect(receipt.commandCode).toBe('create_professional');
    expect(activity.location).toBe('精确活动地址');
    expect(activity.locationLongitude?.toString()).toBe('120.1');
    const savedForm = await prisma.registrationFormVersion.findFirstOrThrow({
      where: { activityId: activity.id },
      include: { fields: true },
    });
    expect(savedForm.fields[0]).toMatchObject({
      fieldCode: 'transport',
      purposeCode: 'transport_logistics',
      dataClassCode: 'ordinary',
    });
    const ruleSet = await prisma.activityQualificationRuleSet.findFirstOrThrow({
      where: { activityId: activity.id },
    });
    const position = await prisma.activitySessionPosition.findFirstOrThrow({
      where: { activityId: activity.id },
    });
    expect(ruleSet.positionId).toBe(position.id);
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { resourceId: activity.id } });
    expect(audit.context).toMatchObject({ extra: { operation: 'create_professional' } });
    for (const secret of [input.operationKey, '精确活动地址', '120.1', '交通说明']) {
      expect(JSON.stringify(result)).not.toContain(secret);
      expect(JSON.stringify(audit)).not.toContain(secret);
    }
  });

  it('professional concurrent identical requests converge on one activity and stable creation identity', async () => {
    const input = professional();
    const before = await counts();
    const service = app.get(ActivityCreationProfessional);
    const original = service.create.bind(service);
    let arrivals = 0;
    let release!: () => void;
    const bothMissedReceipt = new Promise<void>((resolve) => {
      release = resolve;
    });
    jest.spyOn(service, 'create').mockImplementation(async (...args) => {
      if (++arrivals === 2) release();
      await bothMissedReceipt;
      return original(...args);
    });
    const [a, b] = await Promise.all([post('professional', input), post('professional', input)]);
    expect(arrivals).toBe(2);
    expect([a.status, b.status]).toEqual([201, 201]);
    const results = [a, b].map((r) => (r.body as CreationResponse).data);
    expect(results[0].activity).toEqual(results[1].activity);
    expect(results.map((r) => r.replayed).sort()).toEqual([false, true]);
    expect((await counts()).map((count, i) => count - before[i])).toEqual([
      1, 1, 1, 2, 1, 1, 1, 1, 0,
    ]);
    const changed = await post('professional', { ...input, title: '同键改意图' });
    expectBizError(changed, BizCode.BAD_REQUEST);
  });

  it.each(['activity', 'session', 'position', 'place', 'form', 'qualification', 'audit'] as const)(
    'rolls back every write if %s fails after its real write',
    async (stage) => {
      const reached: string[] = [];
      const fail = async <T>(work: Promise<T>): Promise<T> => {
        await work;
        reached.push(stage);
        throw new Error('B6 injected rollback');
      };
      if (stage === 'activity') {
        const service = app.get(ActivityWriteService),
          original = service.createDraftWithinTransaction.bind(service);
        jest
          .spyOn(service, 'createDraftWithinTransaction')
          .mockImplementationOnce((...args) => fail(original(...args)));
      } else if (stage === 'session' || stage === 'position') {
        const service = app.get(ActivityDraftService);
        if (stage === 'session') {
          const original = service.createSessionWithinTransaction.bind(service);
          jest
            .spyOn(service, 'createSessionWithinTransaction')
            .mockImplementationOnce((...args) => fail(original(...args)));
        } else {
          const original = service.createPositionWithinTransaction.bind(service);
          jest
            .spyOn(service, 'createPositionWithinTransaction')
            .mockImplementationOnce((...args) => fail(original(...args)));
        }
      } else if (stage === 'place') {
        const original = placeWriter.writeCreationPlaces;
        jest
          .spyOn(placeWriter, 'writeCreationPlaces')
          .mockImplementationOnce((...args) => fail(original(...args)));
      } else if (stage === 'form') {
        const service = app.get(RegistrationFormVersionService),
          original = service.materializeTemplateDraft.bind(service);
        jest
          .spyOn(service, 'materializeTemplateDraft')
          .mockImplementationOnce((...args) => fail(original(...args)));
      } else if (stage === 'qualification') {
        const service = app.get(QualificationRuleSetVersionService),
          original = service.materializeDraftWithinTransaction.bind(service);
        jest
          .spyOn(service, 'materializeDraftWithinTransaction')
          .mockImplementationOnce((...args) => fail(original(...args)));
      } else {
        const service = app.get(ActivityAuditRecorder),
          original = service.logCreationCommand.bind(service);
        jest
          .spyOn(service, 'logCreationCommand')
          .mockImplementationOnce((...args) => fail(original(...args)));
      }
      const before = await counts();
      await post('professional', professional()).expect(500);
      expect(reached).toEqual([stage]);
      expect(await counts()).toEqual(before);
    },
  );

  it('quick uses exact A6 version and text place fallbacks, and replays after template retirement', async () => {
    const templateVersionId = await template();
    const input = {
      operationKey: unique('quick'),
      title: '快速创建',
      organizationId,
      startAt: START,
      endAt: END,
      location: '活动文字',
      templateVersionId,
      confirmedCapacity: 10,
      defaultPlaceVisibilityCode: 'command',
    };
    const response = await post('from-template', input).expect(201);
    const result = (response.body as CreationResponse).data;
    expect(result.mode).toBe('quick');
    const places = await prisma.activityPlace.findMany({
      where: { activityId: result.activity.activityId },
    });
    expect(places).toHaveLength(2);
    for (const place of places)
      expect(place).toMatchObject({
        visibilityCode: 'command',
        sourcePresetId: null,
        longitude: null,
        latitude: null,
        checkInEligible: false,
      });
    expect(
      await prisma.activityCreationCommandReceipt.count({
        where: { activityId: result.activity.activityId },
      }),
    ).toBe(0);
    await prisma.activityTemplate.update({
      where: { id: templateVersionId },
      data: { statusCode: 'retired' },
    });
    const replay = await post('from-template', input).expect(201);
    expect((replay.body as CreationResponse).data).toEqual({ ...result, replayed: true });
    expectBizError(
      await post('from-template', { ...input, defaultPlaceVisibilityCode: 'public' }),
      BizCode.ACTIVITY_CREATE_FROM_TEMPLATE_OPERATION_KEY_CONFLICT,
    );
  });

  it('quick rejects capacity override and a place failure rolls A6 materialization back', async () => {
    const templateVersionId = await template();
    const input = {
      operationKey: unique('quick-fail'),
      title: '快速创建',
      organizationId,
      startAt: START,
      endAt: END,
      location: '活动文字',
      templateVersionId,
      defaultPlaceVisibilityCode: 'staff',
    };
    const before = await counts();
    expectBizError(
      await post('from-template', { ...input, confirmedCapacity: 99 }),
      BizCode.BAD_REQUEST,
    );
    expect(await counts()).toEqual(before);
    expectBizError(
      await post('from-template', {
        ...input,
        places: [{ roleCode: 'primary', visibilityCode: 'staff', presetId: 'missing-preset-0001' }],
      }),
      BizCode.BAD_REQUEST,
    );
    expect(await counts()).toEqual(before);
  });
});
