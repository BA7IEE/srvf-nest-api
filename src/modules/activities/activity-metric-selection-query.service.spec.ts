import { Role, type Prisma } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import type { PrismaService } from '../../database/prisma.service';
import type { ActivityMetricSelectionAccess } from './activity-metric-selection-access';
import { ActivityMetricSelectionQueryService } from './activity-metric-selection-query.service';
import type { ActivityMetricSelectionColumns } from './activity-metric-selection';
import type { ActivityMetricSelection } from './activity-metric-selection';
import type { MetricSetRow } from './activity-metric-presenter';
import type { GlobalTemplateVersionRow } from './activity-template-version-presenter';
import { fingerprintActivityMetricDefinition } from './activity-metric-definition';
import { fingerprintActivityMetricSetDefinition } from './activity-metric-set-definition';
import { fingerprintActivityTemplateDefinition } from './activity-template-definition';

const requestActor: CurrentUserPayload = {
  id: 'reader',
  username: 'reader',
  role: Role.ADMIN,
  status: 'ACTIVE',
  memberId: 'old-member',
};
const currentActor: CurrentUserPayload = {
  ...requestActor,
  role: Role.USER,
  memberId: 'current-member',
};

function setup() {
  const row: ActivityMetricSelectionColumns & { id: string } = {
    id: 'activity',
    metricRequirementCode: null,
    selectedMetricSetVersionId: null,
    selectedMetricSetDefinitionHash: null,
    metricSelectionRevision: 0,
  };
  const tx = { activityMetricSetVersion: { findFirst: jest.fn().mockResolvedValue(null) } };
  const client = tx as unknown as Prisma.TransactionClient;
  const current = jest.fn().mockResolvedValue(currentActor);
  const readable = jest.fn().mockResolvedValue(row);
  const transaction = jest.fn(
    async (callback: (tx: Prisma.TransactionClient) => Promise<unknown>) => callback(client),
  );
  const prisma = new Proxy(
    { $transaction: transaction },
    {
      get: (target, key) => {
        if (key === '$transaction') return target.$transaction;
        throw new Error('selection query escaped its transaction');
      },
    },
  );
  const service = new ActivityMetricSelectionQueryService(
    prisma as unknown as PrismaService,
    { current, readable } as unknown as ActivityMetricSelectionAccess,
  );
  return { service, tx, client, current, readable, row };
}

describe('C1 D2b selection query transaction and visibility', () => {
  it.each(['admin', 'app'] as const)(
    '%s passes the fresh actor and the same transaction into visibility',
    async (surface) => {
      const { service, tx, client, current, readable } = setup();
      expect(await service.get('activity', requestActor, surface)).toEqual({
        activityId: 'activity',
        metricRequirementCode: 'unconfigured',
        metricSetPointer: null,
        metricSelectionRevision: 0,
        metricSetName: null,
        selectable: false,
      });
      expect(current).toHaveBeenCalledWith(client, requestActor, surface);
      expect(readable).toHaveBeenCalledWith(client, currentActor, surface, 'activity');
      expect(current.mock.invocationCallOrder[0]).toBeLessThan(
        readable.mock.invocationCallOrder[0],
      );
      expect(tx.activityMetricSetVersion.findFirst).not.toHaveBeenCalled();
    },
  );

  it('does not read visibility or referenced rows after identity rejection', async () => {
    const { service, current, readable, tx } = setup();
    const denied = new BizException(BizCode.UNAUTHORIZED);
    current.mockRejectedValue(denied);
    await expect(service.get('activity', requestActor, 'app')).rejects.toBe(denied);
    expect(readable).not.toHaveBeenCalled();
    expect(tx.activityMetricSetVersion.findFirst).not.toHaveBeenCalled();
  });

  it('does not read referenced catalogue rows when the activity is not visible', async () => {
    const { service, readable, tx } = setup();
    const missing = new BizException(BizCode.ACTIVITY_NOT_FOUND);
    readable.mockRejectedValue(missing);
    await expect(service.get('activity', requestActor, 'app')).rejects.toBe(missing);
    expect(tx.activityMetricSetVersion.findFirst).not.toHaveBeenCalled();
  });

  it('loads the exact historical reference without an active-only filter, with a bounded closure', async () => {
    const { service, row, readable, tx } = setup();
    readable.mockResolvedValue({
      ...row,
      metricRequirementCode: 'required',
      selectedMetricSetVersionId: 'historical-set',
      selectedMetricSetDefinitionHash: 'a'.repeat(64),
      metricSelectionRevision: 3,
    });
    await expect(service.get('activity', requestActor, 'admin')).rejects.toMatchObject({
      biz: BizCode.ACTIVITY_METRIC_REFERENCE_UNAVAILABLE,
    });
    expect(tx.activityMetricSetVersion.findFirst).toHaveBeenCalledWith({
      where: { id: 'historical-set' },
      include: {
        items: { include: { metricDefinition: true }, orderBy: { sortOrder: 'asc' }, take: 101 },
      },
    });
    expect(readable.mock.invocationCallOrder[0]).toBeLessThan(
      tx.activityMetricSetVersion.findFirst.mock.invocationCallOrder[0],
    );
  });

  it('does not query the catalogue for an explicit not_required selection', async () => {
    const { service, row, readable, tx } = setup();
    readable.mockResolvedValue({
      ...row,
      metricRequirementCode: 'not_required',
      metricSelectionRevision: 2,
    });
    expect(await service.get('activity', requestActor, 'app')).toEqual({
      activityId: 'activity',
      metricRequirementCode: 'not_required',
      metricSetPointer: null,
      metricSelectionRevision: 2,
      metricSetName: null,
      selectable: true,
    });
    expect(tx.activityMetricSetVersion.findFirst).not.toHaveBeenCalled();
  });

  it('does not disguise a database failure as an unavailable reference', async () => {
    const { service, row, readable, tx } = setup();
    readable.mockResolvedValue({ ...row, selectedMetricSetVersionId: 'set' });
    const failure = new Error('database unavailable');
    tx.activityMetricSetVersion.findFirst.mockRejectedValue(failure);
    await expect(service.get('activity', requestActor, 'admin')).rejects.toBe(failure);
  });

  it('reauthorizes each read and stops after later revocation', async () => {
    const { service, current, readable } = setup();
    await service.get('activity', requestActor, 'app');
    current.mockRejectedValue(new BizException(BizCode.FORBIDDEN));
    await expect(service.get('activity', requestActor, 'app')).rejects.toMatchObject({
      biz: BizCode.FORBIDDEN,
    });
    expect(current).toHaveBeenCalledTimes(2);
    expect(readable).toHaveBeenCalledTimes(1);
  });
});

function optionSet(id = 'set'): MetricSetRow {
  const document = {
    schemaVersion: 1,
    code: 'done',
    version: 1,
    name: '完成',
    configuration: { kindCode: 'boolean', unit: null },
  };
  const hash = fingerprintActivityMetricDefinition(document).definitionHash;
  const item = {
    key: 'done',
    sortOrder: 0,
    required: true,
    metricDefinitionId: 'definition',
    definitionHash: hash,
  };
  return {
    id,
    code: 'completion',
    version: 1,
    name: '完成情况',
    schemaVersion: 1,
    statusCode: 'active',
    activatedAt: new Date(0),
    retiredAt: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    definitionHash: fingerprintActivityMetricSetDefinition({
      schemaVersion: 1,
      code: 'completion',
      version: 1,
      name: '完成情况',
      items: [item],
    }).definitionHash,
    items: [
      {
        id: 'item',
        setVersionId: id,
        createdAt: new Date(0),
        key: 'done',
        sortOrder: 0,
        required: true,
        metricDefinitionId: 'definition',
        metricDefinition: {
          id: 'definition',
          code: 'done',
          version: 1,
          name: '完成',
          kindCode: 'boolean',
          unit: null,
          configurationJson: document.configuration,
          schemaVersion: 1,
          definitionHash: hash,
          statusCode: 'active',
          activatedAt: new Date(0),
          retiredAt: null,
          createdAt: new Date(0),
          updatedAt: new Date(0),
        },
      },
    ],
  };
}
function optionTemplate(
  id = 'template',
  schemaVersion = 3,
  selection: ActivityMetricSelection = {
    metricRequirementCode: 'not_required',
    metricSetPointer: null,
  },
): GlobalTemplateVersionRow {
  const definition = {
    activity: { allocationModeCode: 'first_come' },
    sessions: [],
    ...(schemaVersion > 1 ? { registrationForm: null } : {}),
    ...(schemaVersion === 3
      ? {
          metricSelection: {
            metricRequirementCode: selection.metricRequirementCode,
            metricSetPointer: selection.metricSetPointer ? { ...selection.metricSetPointer } : null,
          },
        }
      : {}),
  };
  return {
    id,
    code: 'template_code',
    name: '模板',
    version: 1,
    activityTypeCode: 'training',
    statusCode: 'active',
    familyId: 'family',
    schemaVersion,
    definitionJson: definition,
    definitionHash: fingerprintActivityTemplateDefinition({ schemaVersion, definition })
      .definitionHash,
    effectiveFrom: new Date('2200-01-01T00:00:00.000Z'),
    effectiveTo: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    defaultRegistrationModeCode: null,
    defaultLocationRequired: null,
    defaultCheckInRadiusMeters: null,
    checkInOpenOffsetMinutes: null,
    checkInCloseOffsetMinutes: null,
    checkOutOpenOffsetMinutes: null,
    checkOutCloseOffsetMinutes: null,
    defaultLateGraceMinutes: null,
    defaultEarlyLeaveThresholdMinutes: null,
    defaultArchiveWaitingDays: null,
    commonPositionTemplates: null,
    family: {
      id: 'family',
      code: 'family_code',
      name: '模板族',
      categoryCode: 'training',
      ownerOrganizationId: null,
      scopeTypeCode: 'global',
      statusCode: 'active',
      createdAt: new Date(0),
      updatedAt: new Date(0),
    },
  };
}
function optionsSetup() {
  const tx = {
    activityTemplate: {
      findMany: jest.fn<Promise<unknown[]>, [Prisma.ActivityTemplateFindManyArgs]>(),
    },
    activityMetricSetVersion: {
      findMany: jest.fn<Promise<unknown[]>, [Prisma.ActivityMetricSetVersionFindManyArgs]>(),
    },
  };
  const client = tx as unknown as Prisma.TransactionClient;
  const authorizeOptions = jest.fn().mockResolvedValue(undefined);
  const transaction = jest.fn(
    async (callback: (tx: Prisma.TransactionClient) => Promise<unknown>) => callback(client),
  );
  const service = new ActivityMetricSelectionQueryService(
    { $transaction: transaction } as unknown as PrismaService,
    { authorizeOptions } as unknown as ActivityMetricSelectionAccess,
  );
  return { tx, client, service, authorizeOptions, transaction };
}
const optionsQuery = { organizationId: 'organization', page: 1, pageSize: 20 };

describe('C1 D2b bounded App options', () => {
  it.each(['metricSetOptions', 'templateVersionOptions'] as const)(
    '%s rejects before catalogue access when current initiation eligibility fails',
    async (method) => {
      const h = optionsSetup();
      const denied = new BizException(BizCode.ACTIVITY_INITIATION_ORG_FORBIDDEN);
      h.authorizeOptions.mockRejectedValue(denied);
      await expect(h.service[method](optionsQuery, requestActor)).rejects.toBe(denied);
      expect(h.authorizeOptions).toHaveBeenCalledWith(
        h.client,
        requestActor,
        optionsQuery.organizationId,
      );
      expect(h.tx.activityTemplate.findMany).not.toHaveBeenCalled();
      expect(h.tx.activityMetricSetVersion.findMany).not.toHaveBeenCalled();
    },
  );
  it.each(['metricSetOptions', 'templateVersionOptions'] as const)(
    '%s fails explicitly at 1001, before loading or filtering candidate definitions',
    async (method) => {
      const h = optionsSetup();
      const query =
        method === 'metricSetOptions'
          ? h.tx.activityMetricSetVersion.findMany
          : h.tx.activityTemplate.findMany;
      query.mockResolvedValueOnce(Array.from({ length: 1001 }, (_, i) => ({ id: `id${i}` })));
      await expect(h.service[method](optionsQuery, requestActor)).rejects.toMatchObject({
        biz: BizCode.ACTIVITY_OPTIONS_CANDIDATE_LIMIT_EXCEEDED,
      });
      expect(query).toHaveBeenCalledTimes(1);
      expect(query.mock.calls[0][0]).toMatchObject({
        select: { id: true },
        take: 1001,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      });
      expect(h.transaction).toHaveBeenCalledWith(expect.any(Function), {
        isolationLevel: 'RepeatableRead',
      });
    },
  );
  it.each(['metricSetOptions', 'templateVersionOptions'] as const)(
    '%s accepts exactly 1000 and paginates without changing total',
    async (method) => {
      const h = optionsSetup();
      const query =
        method === 'metricSetOptions'
          ? h.tx.activityMetricSetVersion.findMany
          : h.tx.activityTemplate.findMany;
      const rows = Array.from({ length: 1000 }, (_, i) =>
        method === 'metricSetOptions' ? optionSet(`id${i}`) : optionTemplate(`id${i}`),
      );
      query.mockResolvedValueOnce(rows.map(({ id }) => ({ id }))).mockResolvedValueOnce(rows);
      const result = await h.service[method](
        { ...optionsQuery, page: 10, pageSize: 100 },
        requestActor,
      );
      expect(result).toMatchObject({ total: 1000, page: 10, pageSize: 100 });
      expect(result.items.map((r) => r.id)).toEqual(rows.slice(900).map((r) => r.id));
      expect(query).toHaveBeenCalledTimes(2);
      expect(query.mock.calls[1][0]).toMatchObject({ take: 1000 });
    },
  );
  it.each(['metricSetOptions', 'templateVersionOptions'] as const)(
    '%s returns an accurate empty page and never loads closures for zero candidates',
    async (method) => {
      const h = optionsSetup();
      const query =
        method === 'metricSetOptions'
          ? h.tx.activityMetricSetVersion.findMany
          : h.tx.activityTemplate.findMany;
      query.mockResolvedValueOnce([]);
      expect(await h.service[method](optionsQuery, requestActor)).toEqual({
        items: [],
        total: 0,
        page: 1,
        pageSize: 20,
      });
      expect(query).toHaveBeenCalledTimes(1);
    },
  );
  it.each(['metricSetOptions', 'templateVersionOptions'] as const)(
    '%s propagates database failures rather than claiming an empty catalogue',
    async (method) => {
      const h = optionsSetup();
      const query =
        method === 'metricSetOptions'
          ? h.tx.activityMetricSetVersion.findMany
          : h.tx.activityTemplate.findMany;
      const error = new Error('database failure');
      query.mockRejectedValueOnce(error);
      await expect(h.service[method](optionsQuery, requestActor)).rejects.toBe(error);
    },
  );
  it('filters invalid metric closures before pagination/count and emits exactly six safe fields', async () => {
    const h = optionsSetup();
    const invalid = optionSet('invalid');
    invalid.items[0].metricDefinition.statusCode = 'retired';
    const corrupt = optionSet('corrupt');
    corrupt.items[0].metricDefinition.configurationJson = { kindCode: 'boolean', unit: 'tampered' };
    const good = [optionSet('newer'), optionSet('older')];
    const rows = [invalid, good[0], corrupt, good[1]];
    h.tx.activityMetricSetVersion.findMany.mockResolvedValueOnce(rows).mockResolvedValueOnce(rows);
    const result = await h.service.metricSetOptions(
      { ...optionsQuery, page: 2, pageSize: 1 },
      requestActor,
    );
    expect(result).toEqual({
      items: [
        {
          id: 'older',
          code: good[1].code,
          version: 1,
          schemaVersion: 1,
          definitionHash: good[1].definitionHash,
          name: good[1].name,
        },
      ],
      total: 2,
      page: 2,
      pageSize: 1,
    });
    expect(h.tx.activityMetricSetVersion.findMany.mock.calls[0][0].where).toEqual({
      statusCode: 'active',
      schemaVersion: 1,
    });
    expect(h.tx.activityMetricSetVersion.findMany.mock.calls[1][0].include?.items).toEqual({
      include: { metricDefinition: true },
      take: 101,
      orderBy: { sortOrder: 'asc' },
    });
  });
  it('filters V3 retired references and tampered definitions before paginating mixed V1/V2/V3 summaries', async () => {
    const h = optionsSetup();
    const set = optionSet();
    set.statusCode = 'retired';
    const selected: ActivityMetricSelection = {
      metricRequirementCode: 'required',
      metricSetPointer: {
        id: set.id,
        code: set.code,
        version: 1,
        schemaVersion: 1,
        definitionHash: set.definitionHash,
      },
    };
    const corrupt = optionTemplate('corrupt');
    corrupt.definitionHash = 'a'.repeat(64);
    const rows = [
      optionTemplate('retired-ref', 3, selected),
      optionTemplate('v3'),
      corrupt,
      optionTemplate('v2', 2),
      optionTemplate('v1', 1),
    ];
    h.tx.activityTemplate.findMany.mockResolvedValueOnce(rows).mockResolvedValueOnce(rows);
    h.tx.activityMetricSetVersion.findMany.mockResolvedValueOnce([set]);
    const result = await h.service.templateVersionOptions(
      { ...optionsQuery, page: 2, pageSize: 1 },
      requestActor,
    );
    expect(result).toMatchObject({
      items: [{ id: 'v2', schemaVersion: 2 }],
      total: 3,
      page: 2,
      pageSize: 1,
    });
    expect(Object.keys(result.items[0]).sort()).toEqual(
      [
        'id',
        'code',
        'name',
        'version',
        'schemaVersion',
        'definitionHash',
        'statusCode',
        'activityTypeCode',
        'family',
        'effectiveFrom',
        'effectiveTo',
        'createdAt',
        'updatedAt',
      ].sort(),
    );
    expect(h.tx.activityTemplate.findMany.mock.calls[0][0].where).toEqual({
      statusCode: 'active',
      schemaVersion: { in: [1, 2, 3] },
      family: { scopeTypeCode: 'global', ownerOrganizationId: null, statusCode: 'active' },
    });
    expect(h.tx.activityMetricSetVersion.findMany).toHaveBeenCalledTimes(1);
    expect(h.tx.activityMetricSetVersion.findMany.mock.calls[0][0]).toMatchObject({
      where: { id: { in: ['set'] } },
      take: 1000,
    });
  });
});
