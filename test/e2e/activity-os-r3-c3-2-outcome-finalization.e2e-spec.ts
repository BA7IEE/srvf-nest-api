import type { INestApplication } from '@nestjs/common';
import { ActivityWorkflowGate } from '../../src/common/activity-workflow/activity-workflow.gate';
import { AttendanceSegmentProjectorService } from '../../src/modules/activities/attendance-segment-projector.service';
import { randomUUID } from 'node:crypto';
import { Role } from '@prisma/client';
import request from 'supertest';
import { PrismaService } from '../../src/database/prisma.service';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { parseMetricReceipt } from '../../src/modules/activities/activity-metric-command';
import { createTestUser } from '../fixtures/users.fixture';
import { loginAs } from '../fixtures/auth.fixture';
import { memberIdentityData } from '../helpers/member-identity.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';
import { assertConnectedTestDatabase } from '../setup/test-db';

describe('C3-2 formal outcome HTTP lifecycle', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let auth: string;
  let actorId: string;
  let memberId: string;
  let organizationId: string;
  let setId: string;
  let setHash: string;
  let definitionId: string;
  let sequence = 0;
  const runId = randomUUID().replaceAll('-', '').slice(0, 12);
  const key = () => `finalization_${runId}_${++sequence}`;
  const base = (id: string) => `/api/app/v1/my/managed-activities/${id}/outcomes`;
  const post = (path: string, body: object, authorization = auth) =>
    request(httpServer(app)).post(path).set('Authorization', authorization).send(body);
  const get = (path: string, authorization = auth) =>
    request(httpServer(app)).get(path).set('Authorization', authorization);
  const command = (expectedRevision = 0) => ({
    operationKey: key(),
    expectedRevision,
    metricSetVersionId: setId,
    metricSetDefinitionHash: setHash,
    values: [{ metricDefinitionId: definitionId, value: true, evidenceAttachmentIds: [] }],
  });
  const activity = () =>
    prisma.activity.create({
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
        metricRequirementCode: 'required',
        selectedMetricSetVersionId: setId,
        selectedMetricSetDefinitionHash: setHash,
        metricSelectionRevision: 1,
      },
    });
  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    await assertConnectedTestDatabase(prisma);
    await resetDb(app);
    const actor = await createTestUser(app, { username: key(), role: Role.SUPER_ADMIN });
    actorId = actor.id;
    const member = await prisma.member.create({
      data: { memberNo: key(), ...memberIdentityData('成果测试'), gradeCode: 'level-3' },
    });
    memberId = member.id;
    await prisma.user.update({ where: { id: actorId }, data: { memberId } });
    auth = (await loginAs(app, actor.username)).authHeader;
    const parent = await prisma.organization.create({
      data: { name: key(), nodeTypeCode: 'root' },
    });
    organizationId = (
      await prisma.organization.create({
        data: { name: key(), nodeTypeCode: 'team', parentId: parent.id },
      })
    ).id;
    const definition = parseMetricReceipt(
      (
        await post('/api/admin/v1/activity-metric-definitions', {
          operationKey: key(),
          definition: {
            schemaVersion: 1,
            code: key(),
            version: 1,
            name: '完成',
            configuration: { kindCode: 'boolean', unit: null },
          },
        }).expect(201)
      ).body.data,
    );
    definitionId = definition.id;
    await post(`/api/admin/v1/activity-metric-definitions/${definitionId}/activate`, {
      operationKey: key(),
      expectedDefinitionHash: definition.definitionHash,
    }).expect(200);
    const set = parseMetricReceipt(
      (
        await post('/api/admin/v1/activity-metric-sets', {
          operationKey: key(),
          definition: {
            schemaVersion: 1,
            code: key(),
            version: 1,
            name: '成果集',
            items: [
              {
                key: 'done',
                sortOrder: 0,
                required: true,
                metricDefinitionId: definitionId,
                definitionHash: definition.definitionHash,
              },
            ],
          },
        }).expect(201)
      ).body.data,
    );
    setId = set.id;
    setHash = set.definitionHash;
    await post(`/api/admin/v1/activity-metric-sets/${setId}/activate`, {
      operationKey: key(),
      expectedDefinitionHash: setHash,
    }).expect(200);
  });
  afterAll(async () => {
    await app?.close();
  });

  async function grant(userId: string) {
    const role = await prisma.rbacRole.create({
      data: { code: key(), displayName: '成果显式授权' },
    });
    for (const action of ['read', 'record', 'confirm', 'correct', 'calculate']) {
      const code = `activity.outcome.${action}`;
      const permission = await prisma.permission.upsert({
        where: { code },
        update: {},
        create: {
          code,
          module: 'activity',
          action: 'outcome',
          resourceType: action,
          description: 'test',
          servicePrincipalAllowed: false,
          delegatedAccessAllowed: false,
        },
      });
      await prisma.rolePermission.create({
        data: { roleId: role.id, permissionId: permission.id },
      });
    }
    await prisma.roleBinding.create({
      data: { principalType: 'USER', principalId: userId, roleId: role.id, scopeType: 'GLOBAL' },
    });
  }

  async function addSource(activityId: string, participantId: string, early = false, open = false) {
    const startAt = new Date('2025-01-01T00:00:00.000Z');
    const endAt = new Date('2025-01-01T02:00:00.000Z');
    const session = await prisma.activitySession.create({
      data: {
        activityId,
        code: key(),
        name: `参与测试_${key()}`,
        startAt,
        endAt,
        locationText: '测试',
        checkInOpenAt: startAt,
        checkInCloseAt: endAt,
        checkOutOpenAt: startAt,
        checkOutCloseAt: endAt,
        locationRequired: false,
        locationPolicySourceCode: 'session',
        statusCode: 'scheduled',
      },
    });
    const registration = await prisma.activityRegistration.upsert({
      where: { activityId_memberId: { activityId, memberId: participantId } },
      update: {},
      create: { activityId, memberId: participantId, statusCode: 'pass' },
    });
    const identity = await prisma.activityParticipationIdentity.create({
      data: {
        activityId,
        sessionId: session.id,
        registrationId: registration.id,
        memberId: participantId,
        currentStatusCode: 'pass',
        populationIncluded: true,
      },
    });
    const events = [];
    for (const eventTypeCode of open
      ? ['check_in']
      : ['check_in', early ? 'early_departure_close' : 'check_out']) {
      const occurredAt =
        eventTypeCode === 'check_in'
          ? startAt
          : new Date(startAt.getTime() + (early ? 600000 : 3600000));
      events.push(
        await prisma.attendancePunchEvent.create({
          data: {
            activityId,
            sessionId: session.id,
            participationIdentityId: identity.id,
            memberId: participantId,
            operatorUserId: actorId,
            eventTypeCode,
            sourceCode: 'proxy',
            occurredAt,
            receivedAt: occurredAt,
            eventKey: key(),
            requestHash: key(),
            evidenceRevision: 0,
            reason: '隔离测试夹具',
          },
        }),
      );
    }
    const projected = app.get(AttendanceSegmentProjectorService).rebuild(events, {
      sessionStartAt: startAt,
      sessionEndAt: endAt,
      lateGraceMinutes: session.lateGraceMinutes,
      earlyLeaveThresholdMinutes: session.earlyLeaveThresholdMinutes,
    });
    expect(projected.chainAnomalies).toEqual([]);
    for (const segment of projected.segments) {
      const { exceptionFlags, ...fields } = segment;
      await prisma.participantServiceSegmentRevision.create({
        data: {
          ...fields,
          exceptionFlagsJson: exceptionFlags,
          participationIdentityId: identity.id,
          revision: 1,
          statusCode: 'draft',
        },
      });
    }
    return { identity, session };
  }

  it('denies confirmation without an explicit grant, including SUPER_ADMIN', async () => {
    const row = await activity();
    expectBizError(
      await post(`/api/app/v1/my/managed-activities/${row.id}/outcome-confirmations`, {
        operationKey: key(),
        expectedLatestRevision: 0,
        expectedConfirmedRevision: 0,
        metricSetVersionId: setId,
        metricSetDefinitionHash: setHash,
        candidateId: 'unavailable',
        values: [
          {
            metricDefinitionId: definitionId,
            sourceKind: 'system',
            sourceValueId: 'unavailable',
            evidenceAttachmentIds: ['unavailable'],
          },
        ],
      }),
      BizCode.ACTIVITY_OUTCOME_REFERENCE_UNAVAILABLE,
    );
    expect(
      await prisma.activityOutcomeFinalizationReceipt.count({ where: { activityId: row.id } }),
    ).toBe(0);
  });

  async function systemFixture(mixed: boolean) {
    await grant(actorId);
    const rulePermission = await prisma.permission.upsert({
      where: { code: 'activity-metric.manage.rule-binding' },
      update: {},
      create: {
        code: 'activity-metric.manage.rule-binding',
        module: 'activity',
        action: 'test',
        resourceType: 'test',
        description: '隔离测试规则授权',
        servicePrincipalAllowed: false,
        delegatedAccessAllowed: false,
      },
    });
    const ruleRole = await prisma.rbacRole.create({
      data: { code: key(), displayName: '系统成果规则夹具' },
    });
    await prisma.rolePermission.create({
      data: { roleId: ruleRole.id, permissionId: rulePermission.id },
    });
    await prisma.roleBinding.create({
      data: {
        principalType: 'USER',
        principalId: actorId,
        roleId: ruleRole.id,
        scopeType: 'GLOBAL',
      },
    });
    const numeric = parseMetricReceipt(
      (
        await post('/api/admin/v1/activity-metric-definitions', {
          operationKey: key(),
          definition: {
            schemaVersion: 1,
            code: key(),
            version: 1,
            name: '参与人数',
            configuration: {
              kindCode: 'non_negative_integer',
              unit: '人',
              minimum: 0,
              maximum: 2000,
            },
          },
        }).expect(201)
      ).body.data,
    );
    await post(`/api/admin/v1/activity-metric-definitions/${numeric.id}/activate`, {
      operationKey: key(),
      expectedDefinitionHash: numeric.definitionHash,
    }).expect(200);
    const items = [
      {
        key: 'people',
        sortOrder: 0,
        required: true,
        metricDefinitionId: numeric.id,
        definitionHash: numeric.definitionHash,
      },
    ];
    if (mixed) {
      const manual = await prisma.activityMetricDefinition.findUniqueOrThrow({
        where: { id: definitionId },
      });
      items.push({
        key: 'done',
        sortOrder: 1,
        required: true,
        metricDefinitionId: definitionId,
        definitionHash: manual.definitionHash,
      });
    }
    const set = parseMetricReceipt(
      (
        await post('/api/admin/v1/activity-metric-sets', {
          operationKey: key(),
          definition: { schemaVersion: 1, code: key(), version: 1, name: '系统成果集', items },
        }).expect(201)
      ).body.data,
    );
    await post(`/api/admin/v1/activity-metric-sets/${set.id}/activate`, {
      operationKey: key(),
      expectedDefinitionHash: set.definitionHash,
    }).expect(200);
    const binding = (
      await post('/api/admin/v1/activity-metric-rule-bindings', {
        schemaVersion: 1,
        operationKey: key(),
        metricDefinitionId: numeric.id,
        definitionHash: numeric.definitionHash,
        ruleCode: 'actual_participant_count_v1',
        evaluatorVersion: 1,
      }).expect(201)
    ).body.data as { bindingId: string };
    const row = await activity();
    await prisma.activity.update({
      where: { id: row.id },
      data: {
        selectedMetricSetVersionId: set.id,
        selectedMetricSetDefinitionHash: set.definitionHash,
      },
    });
    const root = `/api/app/v1/my/managed-activities/${row.id}`;
    let manualDraftId: string | undefined;
    let manualValueId: string | undefined;
    if (mixed) {
      manualDraftId = (
        (
          await post(base(row.id), {
            ...command(),
            metricSetVersionId: set.id,
            metricSetDefinitionHash: set.definitionHash,
          }).expect(201)
        ).body.data as { outcomeRevisionId: string }
      ).outcomeRevisionId;
      manualValueId = (
        await prisma.activityMetricValueRevision.findFirstOrThrow({
          where: { outcomeRevisionId: manualDraftId },
        })
      ).id;
    }
    await addSource(row.id, memberId);
    await prisma.activityResponsibilityAssignment.create({
      data: {
        activityId: row.id,
        memberId,
        responsibilityType: 'owner',
        status: 'active',
        assignedByUserId: actorId,
        source: 'publish',
        canManageRegistrations: true,
        canManageAttendance: true,
      },
    });
    await prisma.activity.update({ where: { id: row.id }, data: { statusCode: 'completed' } });
    const attachment = await prisma.attachment.create({
      data: {
        key: `attachments/c3-system/${key()}.txt`,
        originalName: 'evidence.txt',
        mime: 'text/plain',
        size: 7,
        uploadedBy: actorId,
        ownerType: 'activity',
        ownerId: row.id,
      },
    });
    await prisma.storageObject.create({
      data: {
        key: attachment.key,
        state: 'available',
        source: 'attachment_signed_upload',
        providerType: 'LOCAL',
        localNamespace: 'c3-system-test',
        expectedSize: 7n,
        actualSize: 7n,
        expectedMime: 'text/plain',
        resourceType: 'attachment',
        resourceId: attachment.id,
        verifiedAt: new Date(),
        presentAt: new Date(),
        lastProviderCheckedAt: new Date(),
      },
    });
    const calculate = async (
      expectedOutcomeRevision: number,
      expectedCandidateRevision: number,
    ) => {
      const result = await post(`${root}/metric-candidates`, {
        schemaVersion: 1,
        operationKey: key(),
        expectedCandidateRevision,
        expectedOutcomeRevision,
        metricSetVersionId: set.id,
        metricSetDefinitionHash: set.definitionHash,
        bindingIds: [binding.bindingId],
      }).expect(201);
      const candidateId = (result.body.data as { candidateId: string }).candidateId;
      const value = await prisma.activityMetricCandidateValue.findFirstOrThrow({
        where: { candidateId },
      });
      return { candidateId, value };
    };
    const candidate = await calculate(mixed ? 1 : 0, 0);
    const values = [
      {
        metricDefinitionId: numeric.id,
        sourceKind: 'system',
        sourceValueId: candidate.value.id,
        evidenceAttachmentIds: [attachment.id],
      },
    ];
    if (mixed && manualValueId)
      values.push({
        metricDefinitionId: definitionId,
        sourceKind: 'manual',
        sourceValueId: manualValueId,
        evidenceAttachmentIds: [attachment.id],
      });
    return {
      row,
      root,
      numeric,
      set,
      attachment,
      calculate,
      candidate,
      confirmation: {
        operationKey: key(),
        expectedLatestRevision: mixed ? 1 : 0,
        expectedConfirmedRevision: 0,
        metricSetVersionId: set.id,
        metricSetDefinitionHash: set.definitionHash,
        ...(manualDraftId ? { manualDraftId } : {}),
        candidateId: candidate.candidateId,
        values,
      },
    };
  }

  it.each([false, true])('confirms real retained system values with mixed=%s', async (mixed) => {
    // Instance-only source visibility stub, identical to C3-1; no deployment Gate changes.
    const gate = jest.spyOn(app.get(ActivityWorkflowGate), 'isV11Enabled').mockReturnValue(true);
    try {
      const fixture = await systemFixture(mixed);
      expect(fixture.candidate.value.valueJson).toBe(1);
      const sourcesBefore = await prisma.activityMetricCandidateSource.findMany({
        where: { candidateId: fixture.candidate.candidateId },
        orderBy: { id: 'asc' },
      });
      const result = await post(
        `${fixture.root}/outcome-confirmations`,
        fixture.confirmation,
      ).expect(201);
      expect(result.body.data).toMatchObject({
        createdStatusCode: 'confirmed',
        valueCount: mixed ? 2 : 1,
        evidenceCount: mixed ? 2 : 1,
      });
      const formal = (await get(`${fixture.root}/outcome-confirmed`).expect(200)).body.data as {
        values: { value: unknown; sourceCode: string }[];
      };
      expect(formal.values).toEqual(
        expect.arrayContaining([expect.objectContaining({ value: 1, sourceCode: 'system' })]),
      );
      if (mixed)
        expect(formal.values).toEqual(
          expect.arrayContaining([expect.objectContaining({ value: true, sourceCode: 'manual' })]),
        );
      expect(
        await prisma.activityMetricCandidateSource.findMany({
          where: { candidateId: fixture.candidate.candidateId },
          orderBy: { id: 'asc' },
        }),
      ).toEqual(sourcesBefore);
      expect(
        await prisma.activityOutcomeValueSource.count({
          where: { activityId: fixture.row.id, sourceKind: 'system' },
        }),
      ).toBe(1);
    } finally {
      gate.mockRestore();
    }
  });

  it.each([false, true])(
    'exempts only the correction draft advance, changed-source=%s',
    async (changedSource) => {
      const gate = jest.spyOn(app.get(ActivityWorkflowGate), 'isV11Enabled').mockReturnValue(true);
      try {
        const fixture = await systemFixture(false);
        await post(`${fixture.root}/outcome-confirmations`, fixture.confirmation).expect(201);
        const initial = (await get(`${fixture.root}/outcome-confirmed`).expect(200)).body.data;
        const candidate = await fixture.calculate(1, 1);
        const prepared = await post(`${fixture.root}/outcome-corrections`, {
          operationKey: key(),
          expectedLatestRevision: 1,
          expectedConfirmedRevision: 1,
          metricSetVersionId: fixture.set.id,
          metricSetDefinitionHash: fixture.set.definitionHash,
          candidateId: candidate.candidateId,
          values: [
            {
              metricDefinitionId: fixture.numeric.id,
              sourceKind: 'system',
              sourceValueId: candidate.value.id,
              evidenceAttachmentIds: [],
            },
          ],
        }).expect(201);
        expect(prepared.body.data.revision).toBe(2);
        expect((await get(`${fixture.root}/outcome-confirmed`).expect(200)).body.data).toEqual(
          initial,
        );
        const preparedSources = await prisma.activityOutcomeValueSource.findMany({
          where: { outcomeRevisionId: prepared.body.data.outcomeRevisionId as string },
        });
        expect(preparedSources).toHaveLength(1);
        expect(preparedSources[0]).toMatchObject({
          sourceKind: 'system',
          candidateValueId: candidate.value.id,
          preparedAgainstRevision: 1,
        });
        if (changedSource) await addSource(fixture.row.id, memberId);
        const input = {
          ...fixture.confirmation,
          operationKey: key(),
          expectedLatestRevision: 2,
          expectedConfirmedRevision: 1,
          candidateId: candidate.candidateId,
          values: [{ ...fixture.confirmation.values[0], sourceValueId: candidate.value.id }],
        };
        if (changedSource) {
          const before = await prisma.activityOutcomeRevision.findMany({
            where: { activityId: fixture.row.id },
            orderBy: { revision: 'asc' },
          });
          expectBizError(
            await post(`${fixture.root}/outcome-confirmations`, input),
            BizCode.ACTIVITY_METRIC_CANDIDATE_STALE,
          );
          expect(
            await prisma.activityOutcomeRevision.findMany({
              where: { activityId: fixture.row.id },
              orderBy: { revision: 'asc' },
            }),
          ).toEqual(before);
          expect((await get(`${fixture.root}/outcome-confirmed`).expect(200)).body.data).toEqual(
            initial,
          );
          expect(
            await prisma.activityOutcomeFinalizationReceipt.count({
              where: { activityId: fixture.row.id },
            }),
          ).toBe(2);
        } else {
          const confirmed = await post(`${fixture.root}/outcome-confirmations`, input).expect(201);
          expect(confirmed.body.data.revision).toBe(3);
          expect(
            (await get(`${fixture.root}/outcome-confirmed`).expect(200)).body.data,
          ).toMatchObject({ revision: 3, values: [{ sourceCode: 'system', value: 1 }] });
          expect(
            await prisma.activityOutcomeValueSource.findFirstOrThrow({
              where: { outcomeRevisionId: confirmed.body.data.outcomeRevisionId as string },
            }),
          ).toMatchObject({ candidateValueId: candidate.value.id, preparedAgainstRevision: 1 });
        }
      } finally {
        gate.mockRestore();
      }
    },
  );

  it('confirms the real 100-value 2000-evidence capacity and rejects cap plus one without writes', async () => {
    await grant(actorId);
    const items: {
      key: string;
      sortOrder: number;
      required: boolean;
      metricDefinitionId: string;
      definitionHash: string;
    }[] = [];
    for (let i = 0; i < 100; i++) {
      const definition = parseMetricReceipt(
        (
          await post('/api/admin/v1/activity-metric-definitions', {
            operationKey: key(),
            definition: {
              schemaVersion: 1,
              code: key(),
              version: 1,
              name: `完成${i}`,
              configuration: { kindCode: 'boolean', unit: null },
            },
          }).expect(201)
        ).body.data,
      );
      await post(`/api/admin/v1/activity-metric-definitions/${definition.id}/activate`, {
        operationKey: key(),
        expectedDefinitionHash: definition.definitionHash,
      }).expect(200);
      items.push({
        key: `done_${i}`,
        sortOrder: i,
        required: true,
        metricDefinitionId: definition.id,
        definitionHash: definition.definitionHash,
      });
    }
    const set = parseMetricReceipt(
      (
        await post('/api/admin/v1/activity-metric-sets', {
          operationKey: key(),
          definition: { schemaVersion: 1, code: key(), version: 1, name: '满额成果集', items },
        }).expect(201)
      ).body.data,
    );
    await post(`/api/admin/v1/activity-metric-sets/${set.id}/activate`, {
      operationKey: key(),
      expectedDefinitionHash: set.definitionHash,
    }).expect(200);
    const row = await activity();
    await prisma.activity.update({
      where: { id: row.id },
      data: {
        selectedMetricSetVersionId: set.id,
        selectedMetricSetDefinitionHash: set.definitionHash,
      },
    });
    const root = `/api/app/v1/my/managed-activities/${row.id}`;
    const draft = (
      await post(base(row.id), {
        operationKey: key(),
        expectedRevision: 0,
        metricSetVersionId: set.id,
        metricSetDefinitionHash: set.definitionHash,
        values: items.map((item) => ({
          metricDefinitionId: item.metricDefinitionId,
          value: true,
          evidenceAttachmentIds: [],
        })),
      }).expect(201)
    ).body.data as { outcomeRevisionId: string };
    const detail = (await get(`${base(row.id)}/${draft.outcomeRevisionId}`).expect(200)).body
      .data as { values: { valueRevisionId: string; metricDefinitionId: string }[] };
    expect(detail.values).toHaveLength(100);
    await prisma.activityResponsibilityAssignment.create({
      data: {
        activityId: row.id,
        memberId,
        responsibilityType: 'owner',
        status: 'active',
        canManageRegistrations: true,
        canManageAttendance: true,
        assignedByUserId: actorId,
        source: 'publish',
      },
    });
    await prisma.activity.update({ where: { id: row.id }, data: { statusCode: 'completed' } });
    const evidenceAttachmentIds: string[] = [];
    for (let i = 0; i < 21; i++) {
      const attachment = await prisma.attachment.create({
        data: {
          key: `attachments/c3-finalization/${key()}.txt`,
          originalName: 'evidence.txt',
          mime: 'text/plain',
          size: 7,
          uploadedBy: actorId,
          ownerType: 'activity',
          ownerId: row.id,
        },
      });
      await prisma.storageObject.create({
        data: {
          key: attachment.key,
          state: 'available',
          source: 'attachment_signed_upload',
          providerType: 'LOCAL',
          localNamespace: 'c3-finalization-test',
          expectedSize: 7n,
          actualSize: 7n,
          expectedMime: 'text/plain',
          resourceType: 'attachment',
          resourceId: attachment.id,
          verifiedAt: new Date(),
          presentAt: new Date(),
          lastProviderCheckedAt: new Date(),
        },
      });
      evidenceAttachmentIds.push(attachment.id);
    }
    const confirmation = {
      operationKey: key(),
      expectedLatestRevision: 1,
      expectedConfirmedRevision: 0,
      metricSetVersionId: set.id,
      metricSetDefinitionHash: set.definitionHash,
      manualDraftId: draft.outcomeRevisionId,
      values: detail.values.map((value) => ({
        metricDefinitionId: value.metricDefinitionId,
        sourceKind: 'manual',
        sourceValueId: value.valueRevisionId,
        evidenceAttachmentIds: evidenceAttachmentIds.slice(0, 20),
      })),
    };
    for (const values of [
      [...confirmation.values, confirmation.values[0]],
      confirmation.values.map((value, i) =>
        i === 0 ? { ...value, evidenceAttachmentIds } : value,
      ),
    ]) {
      const response = await post(`${root}/outcome-confirmations`, {
        ...confirmation,
        operationKey: key(),
        values,
      });
      expectBizError(response, BizCode.BAD_REQUEST, { strictMessage: false });
      expect(
        await prisma.activityOutcomeFinalizationReceipt.count({ where: { activityId: row.id } }),
      ).toBe(0);
      expect(await prisma.activityOutcomeRevision.count({ where: { activityId: row.id } })).toBe(1);
    }
    const result = await post(`${root}/outcome-confirmations`, confirmation).expect(201);
    expect(result.body.data).toMatchObject({
      valueCount: 100,
      evidenceCount: 2000,
      createdStatusCode: 'confirmed',
    });
    const formal = (await get(`${root}/outcome-confirmed`).expect(200)).body.data as {
      values: { evidenceAttachmentIds: string[] }[];
    };
    expect(formal.values).toHaveLength(100);
    expect(
      await prisma.activityMetricValueEvidence.count({
        where: { outcomeRevisionId: result.body.data.outcomeRevisionId as string },
      }),
    ).toBe(2000);
    expect(
      await prisma.activityOutcomeValueSource.count({
        where: { outcomeRevisionId: result.body.data.outcomeRevisionId as string },
      }),
    ).toBe(100);
  });

  it('preserves archived formal history for the new authorized owner after the original member departs', async () => {
    const gate = jest.spyOn(app.get(ActivityWorkflowGate), 'isV11Enabled').mockReturnValue(true);
    try {
      const fixture = await systemFixture(false);
      const confirmed = await post(
        `${fixture.root}/outcome-confirmations`,
        fixture.confirmation,
      ).expect(201);
      const formal = (await get(`${fixture.root}/outcome-confirmed`).expect(200)).body.data;
      const historyPath = `${base(fixture.row.id)}/${confirmed.body.data.outcomeRevisionId}`;
      const history = (await get(historyPath).expect(200)).body.data;
      const retained = async () => ({
        values: await prisma.activityMetricValueRevision.findMany({
          where: { activityId: fixture.row.id },
          orderBy: { id: 'asc' },
        }),
        sources: await prisma.activityOutcomeValueSource.findMany({
          where: { activityId: fixture.row.id },
          orderBy: { id: 'asc' },
        }),
        evidence: await prisma.activityMetricValueEvidence.findMany({
          where: { activityId: fixture.row.id },
          orderBy: { id: 'asc' },
        }),
        receipts: await prisma.activityOutcomeFinalizationReceipt.findMany({
          where: { activityId: fixture.row.id },
          orderBy: { id: 'asc' },
        }),
      });
      const before = await retained();
      const replacement = await createTestUser(app, { username: key(), role: Role.USER });
      const replacementMember = await prisma.member.create({
        data: { memberNo: key(), ...memberIdentityData('新负责人'), gradeCode: 'level-3' },
      });
      await prisma.user.update({
        where: { id: replacement.id },
        data: { memberId: replacementMember.id },
      });
      await grant(replacement.id);
      const replacementAuth = (await loginAs(app, replacement.username)).authHeader;
      await prisma.$transaction(async (tx) => {
        await tx.activityResponsibilityAssignment.updateMany({
          where: { activityId: fixture.row.id, status: 'active', responsibilityType: 'owner' },
          data: { status: 'ended', endedAt: new Date(), endedByUserId: actorId },
        });
        await tx.activityResponsibilityAssignment.create({
          data: {
            activityId: fixture.row.id,
            memberId: replacementMember.id,
            responsibilityType: 'owner',
            status: 'active',
            canManageRegistrations: true,
            canManageAttendance: true,
            assignedByUserId: actorId,
            source: 'transfer',
          },
        });
        await tx.member.update({ where: { id: memberId }, data: { status: 'INACTIVE' } });
        await tx.activity.update({
          where: { id: fixture.row.id },
          data: {
            statusCode: 'archived',
            archivedFromStatusCode: 'completed',
            archivedAt: new Date(),
            archivedByUserId: actorId,
            archiveReasonCode: 'completed',
          },
        });
      });
      expect(
        (await get(`${fixture.root}/outcome-confirmed`, replacementAuth).expect(200)).body.data,
      ).toEqual(formal);
      expect((await get(historyPath, replacementAuth).expect(200)).body.data).toEqual(history);
      expectBizError(await get(`${fixture.root}/outcome-confirmed`), BizCode.FORBIDDEN);
      expectBizError(
        await post(`${fixture.root}/outcome-confirmations`, fixture.confirmation),
        BizCode.FORBIDDEN,
      );
      expect(await retained()).toEqual(before);
    } finally {
      await prisma.member.update({ where: { id: memberId }, data: { status: 'ACTIVE' } });
      gate.mockRestore();
    }
  });

  it('keeps the formal result through preparation and cancellation, then replaces it atomically', async () => {
    await grant(actorId);
    const row = await activity();
    const root = `/api/app/v1/my/managed-activities/${row.id}`;
    expect((await get(`${root}/outcome-confirmed`).expect(200)).body.data).toBeNull();
    const draft = (await post(base(row.id), command()).expect(201)).body.data as {
      outcomeRevisionId: string;
    };
    const detail = (await get(`${base(row.id)}/${draft.outcomeRevisionId}`).expect(200)).body
      .data as { values: { valueRevisionId: string }[] };
    await prisma.activityResponsibilityAssignment.create({
      data: {
        activityId: row.id,
        memberId,
        responsibilityType: 'owner',
        status: 'active',
        canManageRegistrations: true,
        canManageAttendance: true,
        assignedByUserId: actorId,
        source: 'publish',
      },
    });
    await prisma.activity.update({ where: { id: row.id }, data: { statusCode: 'completed' } });
    const attachment = await prisma.attachment.create({
      data: {
        key: `attachments/c3-finalization/${key()}.txt`,
        originalName: 'evidence.txt',
        mime: 'text/plain',
        size: 7,
        uploadedBy: actorId,
        ownerType: 'activity',
        ownerId: row.id,
      },
    });
    await prisma.storageObject.create({
      data: {
        key: attachment.key,
        state: 'available',
        source: 'attachment_signed_upload',
        providerType: 'LOCAL',
        localNamespace: 'c3-finalization-test',
        expectedSize: 7n,
        actualSize: 7n,
        expectedMime: 'text/plain',
        resourceType: 'attachment',
        resourceId: attachment.id,
        verifiedAt: new Date(),
        presentAt: new Date(),
        lastProviderCheckedAt: new Date(),
      },
    });
    const confirmation = {
      operationKey: key(),
      expectedLatestRevision: 1,
      expectedConfirmedRevision: 0,
      metricSetVersionId: setId,
      metricSetDefinitionHash: setHash,
      manualDraftId: draft.outcomeRevisionId,
      values: [
        {
          metricDefinitionId: definitionId,
          sourceKind: 'manual',
          sourceValueId: detail.values[0].valueRevisionId,
          evidenceAttachmentIds: [attachment.id],
        },
      ],
    };
    const [first, concurrentReplay] = await Promise.all([
      post(`${root}/outcome-confirmations`, confirmation).expect(201),
      post(`${root}/outcome-confirmations`, confirmation).expect(201),
    ]);
    expect(concurrentReplay.body).toEqual(first.body);
    expect(
      await prisma.activityOutcomeFinalizationReceipt.count({ where: { activityId: row.id } }),
    ).toBe(1);
    expect(first.body.data).toMatchObject({
      revision: 2,
      createdStatusCode: 'confirmed',
      operationCode: 'confirm_outcome',
      valueCount: 1,
      evidenceCount: 1,
    });
    expect((await post(`${root}/outcome-confirmations`, confirmation).expect(201)).body).toEqual(
      first.body,
    );
    const formal = (await get(`${root}/outcome-confirmed`).expect(200)).body.data;
    expect(formal).toMatchObject({
      revision: 2,
      isCurrentConfirmed: true,
      values: [{ value: true }],
    });
    const prepare = {
      operationKey: key(),
      expectedLatestRevision: 2,
      expectedConfirmedRevision: 2,
      metricSetVersionId: setId,
      metricSetDefinitionHash: setHash,
      values: [
        {
          metricDefinitionId: definitionId,
          sourceKind: 'manual',
          value: false,
          evidenceAttachmentIds: [],
        },
      ],
    };
    const prepared = await post(`${root}/outcome-corrections`, prepare).expect(201);
    expect(prepared.body.data).toMatchObject({
      revision: 3,
      createdStatusCode: 'draft',
      evidenceCount: 0,
    });
    expect((await get(`${root}/outcome-confirmed`).expect(200)).body.data).toEqual(formal);
    const cancellation = {
      operationKey: key(),
      expectedLatestRevision: 3,
      expectedConfirmedRevision: 2,
    };
    const cancelPath = `${root}/outcome-corrections/${prepared.body.data.outcomeRevisionId}/cancel`;
    const cancelled = await post(cancelPath, cancellation).expect(200);
    expect(cancelled.body.data).toMatchObject({
      revision: 3,
      createdStatusCode: 'superseded',
      operationCode: 'cancel_outcome_correction',
    });
    expect((await post(cancelPath, cancellation).expect(200)).body).toEqual(cancelled.body);
    expect((await get(`${root}/outcome-confirmed`).expect(200)).body.data).toEqual(formal);
    const next = await post(`${root}/outcome-corrections`, {
      ...prepare,
      operationKey: key(),
      expectedLatestRevision: 3,
    }).expect(201);
    expect(next.body.data.revision).toBe(4);
    const nextDetail = (
      await get(`${base(row.id)}/${next.body.data.outcomeRevisionId}`).expect(200)
    ).body.data as { values: { valueRevisionId: string }[] };
    const replacement = await post(`${root}/outcome-confirmations`, {
      ...confirmation,
      operationKey: key(),
      expectedLatestRevision: 4,
      expectedConfirmedRevision: 2,
      manualDraftId: next.body.data.outcomeRevisionId,
      values: [{ ...confirmation.values[0], sourceValueId: nextDetail.values[0].valueRevisionId }],
    }).expect(201);
    expect(replacement.body.data).toMatchObject({ revision: 5, createdStatusCode: 'confirmed' });
    expect((await get(`${root}/outcome-confirmed`).expect(200)).body.data).toMatchObject({
      revision: 5,
      values: [{ value: false }],
    });
    expect(await prisma.activityOutcomeRevision.count({ where: { activityId: row.id } })).toBe(5);
    expect(
      await prisma.activityOutcomeRevision.count({
        where: { activityId: row.id, statusCode: 'confirmed' },
      }),
    ).toBe(1);
    expect(await prisma.activityMetricValueRevision.count({ where: { activityId: row.id } })).toBe(
      5,
    );
    expect(
      await prisma.activityOutcomeFinalizationReceipt.count({ where: { activityId: row.id } }),
    ).toBe(5);
  });
});
