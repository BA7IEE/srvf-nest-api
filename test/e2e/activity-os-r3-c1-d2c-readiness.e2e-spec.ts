import type { INestApplication } from '@nestjs/common';
import { Role } from '@prisma/client';

import { PrismaService } from '../../src/database/prisma.service';
import { fingerprintActivityMetricDefinition } from '../../src/modules/activities/activity-metric-definition';
import { fingerprintActivityMetricSetDefinition } from '../../src/modules/activities/activity-metric-set-definition';
import {
  ActivityPublishReadinessService,
  type ActivityPublishReadinessResult,
} from '../../src/modules/activities/activity-publish-readiness.service';
import { computeActivityTemplateDefinitionHash } from '../../src/modules/activities/activity-template-definition';
import { createTestUser } from '../fixtures/users.fixture';
import { memberIdentityData } from '../helpers/member-identity.fixture';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

const REFERENCE_TIME = new Date('2099-04-01T00:00:00.000Z');

describe('C1 D2c metric readiness facts', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let readiness: ActivityPublishReadinessService;
  let organizationId: string;
  let initiatorMemberId: string;
  let sequence = 0;
  const unique = (label: string): string => `c1-d2c-readiness-${label}-${++sequence}`;
  const metricCode = (label: string): string => `c1d2c_readiness_${label}_${++sequence}`;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);
    readiness = app.get(ActivityPublishReadinessService);
    const user = await createTestUser(app, { username: unique('user'), role: Role.SUPER_ADMIN });
    const member = await prisma.member.create({
      data: {
        memberNo: unique('member'),
        ...memberIdentityData('C1 D2c Readiness 负责人'),
        gradeCode: 'level-3',
      },
    });
    initiatorMemberId = member.id;
    await prisma.user.update({ where: { id: user.id }, data: { memberId: member.id } });
    const root = await prisma.organization.create({
      data: { name: unique('root'), nodeTypeCode: unique('root-type') },
    });
    const organization = await prisma.organization.create({
      data: { name: unique('organization'), nodeTypeCode: unique('team-type'), parentId: root.id },
    });
    organizationId = organization.id;
  });

  afterAll(async () => {
    await app?.close();
  });

  async function createCatalogue(statusCode: 'active' | 'retired' = 'active') {
    const definitionDocument = {
      schemaVersion: 1,
      code: metricCode('definition'),
      version: 1,
      name: 'Readiness 指标定义',
      configuration: { kindCode: 'boolean' as const, unit: null },
    };
    const definitionHash = fingerprintActivityMetricDefinition(definitionDocument).definitionHash;
    const createdDefinition = await prisma.activityMetricDefinition.create({
      data: {
        code: definitionDocument.code,
        version: 1,
        name: definitionDocument.name,
        kindCode: 'boolean',
        unit: null,
        configurationJson: definitionDocument.configuration,
        schemaVersion: 1,
        definitionHash,
        statusCode: 'draft',
      },
    });
    const definition = await prisma.activityMetricDefinition.update({
      where: { id: createdDefinition.id },
      data: { statusCode: 'active', activatedAt: REFERENCE_TIME },
    });
    const setDocument = {
      schemaVersion: 1,
      code: metricCode('set'),
      version: 1,
      name: 'Readiness 指标集',
      items: [
        {
          key: 'completed',
          sortOrder: 0,
          required: true,
          metricDefinitionId: definition.id,
          definitionHash,
        },
      ],
    };
    const setHash = fingerprintActivityMetricSetDefinition(setDocument).definitionHash;
    const createdSet = await prisma.activityMetricSetVersion.create({
      data: {
        code: setDocument.code,
        version: 1,
        name: setDocument.name,
        schemaVersion: 1,
        definitionHash: setHash,
        statusCode: 'draft',
        items: {
          create: setDocument.items.map((item) => ({
            key: item.key,
            sortOrder: item.sortOrder,
            required: item.required,
            metricDefinitionId: item.metricDefinitionId,
          })),
        },
      },
    });
    const activeSet = await prisma.activityMetricSetVersion.update({
      where: { id: createdSet.id },
      data: { statusCode: 'active', activatedAt: REFERENCE_TIME },
    });
    if (statusCode === 'active') return { set: activeSet, setHash };
    const set = await prisma.activityMetricSetVersion.update({
      where: { id: activeSet.id },
      data: { statusCode: 'retired', retiredAt: REFERENCE_TIME },
    });
    await prisma.activityMetricDefinition.update({
      where: { id: definition.id },
      data: { statusCode: 'retired', retiredAt: REFERENCE_TIME },
    });
    return { set, setHash };
  }

  async function createV3Template() {
    const definition = {
      activity: { allocationModeCode: 'first_come' },
      sessions: [],
      registrationForm: null,
      metricSelection: { metricRequirementCode: 'not_required', metricSetPointer: null },
    };
    return prisma.activityTemplate.create({
      data: {
        code: unique('template'),
        name: 'Readiness V3 模板',
        activityTypeCode: 'event_support',
        statusCode: 'active',
        version: 1,
        schemaVersion: 3,
        definitionJson: definition,
        definitionHash: computeActivityTemplateDefinitionHash({ schemaVersion: 3, definition }),
        defaultRegistrationModeCode: 'open_apply',
      },
    });
  }

  async function createActivity(input: {
    metricRequirementCode: 'not_required' | 'required' | null;
    selectedMetricSetVersionId?: string | null;
    selectedMetricSetDefinitionHash?: string | null;
    metricSelectionRevision: number;
    statusCode?: 'draft' | 'published';
    selectedTemplateVersionId?: string | null;
  }) {
    const activity = await prisma.activity.create({
      data: {
        title: unique('activity'),
        activityTypeCode: 'event_support',
        allocationModeCode: 'first_come',
        organizationId,
        initiatorMemberId,
        selectedTemplateVersionId: input.selectedTemplateVersionId ?? null,
        metricRequirementCode: input.metricRequirementCode,
        selectedMetricSetVersionId: input.selectedMetricSetVersionId ?? null,
        selectedMetricSetDefinitionHash: input.selectedMetricSetDefinitionHash ?? null,
        metricSelectionRevision: input.metricSelectionRevision,
        startAt: new Date('2099-05-01T08:00:00.000Z'),
        endAt: new Date('2099-05-01T10:00:00.000Z'),
        registrationDeadline: new Date('2099-04-30T12:00:00.000Z'),
        location: 'Readiness 集合点',
        registrationModeCode: 'open_apply',
        visibilityCode: 'internal',
        statusCode: input.statusCode ?? 'draft',
        ...(input.statusCode === 'published' ? { publishedAt: REFERENCE_TIME } : {}),
      },
    });
    await prisma.activitySession.create({
      data: {
        activityId: activity.id,
        code: unique('session'),
        name: 'Readiness 场次',
        startAt: new Date('2099-05-01T08:00:00.000Z'),
        endAt: new Date('2099-05-01T10:00:00.000Z'),
        locationText: 'Readiness 集合点',
        checkInOpenAt: new Date('2099-05-01T07:30:00.000Z'),
        checkInCloseAt: new Date('2099-05-01T08:30:00.000Z'),
        checkOutOpenAt: new Date('2099-05-01T09:00:00.000Z'),
        checkOutCloseAt: new Date('2099-05-01T10:00:00.000Z'),
        locationRequired: false,
        radiusMeters: null,
        locationPolicySourceCode: 'system',
        statusCode: 'scheduled',
      },
    });
    return activity.id;
  }

  function metricIssueCodes(result: ActivityPublishReadinessResult): string[] {
    return result.blockers
      .filter((issue) => issue.fieldPath === 'metrics.requiredSet')
      .map((issue) => issue.code);
  }

  it('derives all metric states from bounded persisted facts, recognizes V3 templates, and stays read-only', async () => {
    const active = await createCatalogue('active');
    const retired = await createCatalogue('retired');
    const v3Template = await createV3Template();
    const activityIds = {
      unconfigured: await createActivity({
        metricRequirementCode: null,
        metricSelectionRevision: 0,
      }),
      notRequired: await createActivity({
        metricRequirementCode: 'not_required',
        metricSelectionRevision: 1,
        selectedTemplateVersionId: v3Template.id,
      }),
      requiredActive: await createActivity({
        metricRequirementCode: 'required',
        selectedMetricSetVersionId: active.set.id,
        selectedMetricSetDefinitionHash: active.setHash,
        metricSelectionRevision: 1,
      }),
      draftRetired: await createActivity({
        metricRequirementCode: 'required',
        selectedMetricSetVersionId: retired.set.id,
        selectedMetricSetDefinitionHash: retired.setHash,
        metricSelectionRevision: 1,
      }),
      publishedRetired: await createActivity({
        metricRequirementCode: 'required',
        selectedMetricSetVersionId: retired.set.id,
        selectedMetricSetDefinitionHash: retired.setHash,
        metricSelectionRevision: 1,
        statusCode: 'published',
      }),
    };
    const before = {
      activities: await prisma.activity.findMany({
        where: { id: { in: Object.values(activityIds) } },
        orderBy: { id: 'asc' },
        select: {
          id: true,
          updatedAt: true,
          metricRequirementCode: true,
          selectedMetricSetVersionId: true,
          selectedMetricSetDefinitionHash: true,
          metricSelectionRevision: true,
        },
      }),
      audits: await prisma.auditLog.count(),
    };

    const results = await Promise.all(
      Object.values(activityIds).map((activityId) =>
        readiness.evaluate(activityId, REFERENCE_TIME),
      ),
    );
    const byName = Object.fromEntries(
      Object.keys(activityIds).map((name, index) => [name, results[index]]),
    ) as Record<keyof typeof activityIds, ActivityPublishReadinessResult>;
    expect(metricIssueCodes(byName.unconfigured)).toEqual(['METRIC_SELECTION_MISSING']);
    expect(metricIssueCodes(byName.notRequired)).toEqual([]);
    expect(metricIssueCodes(byName.requiredActive)).toEqual([]);
    expect(metricIssueCodes(byName.draftRetired)).toEqual(['METRIC_REFERENCE_UNAVAILABLE']);
    expect(metricIssueCodes(byName.publishedRetired)).toEqual([]);
    expect(byName.notRequired.blockers.map((issue) => issue.code)).not.toContain(
      'TEMPLATE_DEFINITION_INVALID',
    );
    expect(await readiness.evaluate(activityIds.notRequired, REFERENCE_TIME)).toEqual(
      byName.notRequired,
    );
    expect({
      activities: await prisma.activity.findMany({
        where: { id: { in: Object.values(activityIds) } },
        orderBy: { id: 'asc' },
        select: {
          id: true,
          updatedAt: true,
          metricRequirementCode: true,
          selectedMetricSetVersionId: true,
          selectedMetricSetDefinitionHash: true,
          metricSelectionRevision: true,
        },
      }),
      audits: await prisma.auditLog.count(),
    }).toEqual(before);
  });
});
