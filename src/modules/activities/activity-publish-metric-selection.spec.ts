import { BizCode } from '../../common/exceptions/biz-code.constant';
import { fingerprintActivityMetricDefinition } from './activity-metric-definition';
import { fingerprintActivityMetricSetDefinition } from './activity-metric-set-definition';
import { lockActivityPublishMetricSelections } from './activity-publish-metric-selection';
import type { MetricSetRow } from './activity-metric-presenter';

const definitionDocument = {
  schemaVersion: 1,
  code: 'completion_rate',
  version: 1,
  name: '完成率',
  configuration: {
    kindCode: 'non_negative_integer' as const,
    unit: 'percent',
    minimum: 0,
    maximum: 100,
  },
};
const definitionHash = fingerprintActivityMetricDefinition(definitionDocument).definitionHash;
const setDocument = {
  schemaVersion: 1,
  code: 'completion_set',
  version: 1,
  name: '完成情况',
  items: [
    {
      key: 'completion_rate',
      sortOrder: 0,
      required: true,
      metricDefinitionId: 'definition-a',
      definitionHash,
    },
  ],
};
const setHash = fingerprintActivityMetricSetDefinition(setDocument).definitionHash;

function metricSet(statusCode: 'active' | 'retired' = 'active'): MetricSetRow {
  return {
    id: 'set-a',
    code: setDocument.code,
    version: 1,
    schemaVersion: 1,
    name: setDocument.name,
    definitionHash: setHash,
    statusCode,
    items: [
      {
        key: 'completion_rate',
        sortOrder: 0,
        required: true,
        metricDefinitionId: 'definition-a',
        metricDefinition: {
          id: 'definition-a',
          code: definitionDocument.code,
          version: 1,
          schemaVersion: 1,
          name: definitionDocument.name,
          configurationJson: definitionDocument.configuration,
          definitionHash,
          statusCode,
        },
      },
    ],
  } as unknown as MetricSetRow;
}

function requiredReference(historical = false) {
  return {
    selection: {
      metricRequirementCode: 'required' as const,
      metricSetPointer: {
        id: 'set-a',
        code: setDocument.code,
        version: 1,
        schemaVersion: 1 as const,
        definitionHash: setHash,
      },
    },
    historical,
  };
}

function subject(row = metricSet()) {
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    activityMetricSetItem: {
      findMany: jest.fn().mockResolvedValue([{ metricDefinitionId: 'definition-a' }]),
    },
    activityMetricSetVersion: { findFirst: jest.fn().mockResolvedValue(row) },
  };
  const revalidate = jest.fn().mockResolvedValue(undefined);
  return { tx, revalidate };
}

describe('C1 D2c publish metric selection lock', () => {
  it('locks the set then sorted definitions and revalidates after each wait', async () => {
    const { tx, revalidate } = subject();

    await expect(
      lockActivityPublishMetricSelections(tx as never, [requiredReference()], revalidate),
    ).resolves.toBeUndefined();

    expect(tx.activityMetricSetItem.findMany).toHaveBeenCalledWith({
      where: { setVersionId: 'set-a' },
      select: { metricDefinitionId: true },
      take: 101,
    });
    expect(tx.activityMetricSetVersion.findFirst).toHaveBeenCalledWith({
      where: { id: 'set-a' },
      include: {
        items: {
          include: { metricDefinition: true },
          take: 101,
          orderBy: { sortOrder: 'asc' },
        },
      },
    });
    expect(tx.$queryRaw).toHaveBeenCalledTimes(2);
    expect(revalidate).toHaveBeenCalledTimes(2);
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      revalidate.mock.invocationCallOrder[0],
    );
    expect(revalidate.mock.invocationCallOrder[0]).toBeLessThan(
      tx.activityMetricSetItem.findMany.mock.invocationCallOrder[0],
    );
    expect(tx.activityMetricSetItem.findMany.mock.invocationCallOrder[0]).toBeLessThan(
      tx.$queryRaw.mock.invocationCallOrder[1],
    );
    expect(tx.$queryRaw.mock.invocationCallOrder[1]).toBeLessThan(
      revalidate.mock.invocationCallOrder[1],
    );
  });

  it('does not acquire catalogue locks for an explicit not_required selection', async () => {
    const { tx, revalidate } = subject();

    await lockActivityPublishMetricSelections(
      tx as never,
      [
        {
          selection: { metricRequirementCode: 'not_required', metricSetPointer: null },
          historical: false,
        },
      ],
      revalidate,
    );

    expect(revalidate).toHaveBeenCalledTimes(1);
    expect(tx.$queryRaw).not.toHaveBeenCalled();
    expect(tx.activityMetricSetItem.findMany).not.toHaveBeenCalled();
  });

  it('allows a retained retired reference only on the historical branch', async () => {
    const historical = subject(metricSet('retired'));
    await expect(
      lockActivityPublishMetricSelections(
        historical.tx as never,
        [requiredReference(true)],
        historical.revalidate,
      ),
    ).resolves.toBeUndefined();

    const newSelection = subject(metricSet('retired'));
    await expect(
      lockActivityPublishMetricSelections(
        newSelection.tx as never,
        [requiredReference(false)],
        newSelection.revalidate,
      ),
    ).rejects.toMatchObject({ biz: BizCode.ACTIVITY_METRIC_REFERENCE_UNAVAILABLE });
  });

  it('bounds the closure at 100 definitions before taking any definition lock', async () => {
    const { tx, revalidate } = subject();
    tx.activityMetricSetItem.findMany.mockResolvedValue(
      Array.from({ length: 101 }, (_, index) => ({ metricDefinitionId: `definition-${index}` })),
    );

    await expect(
      lockActivityPublishMetricSelections(tx as never, [requiredReference()], revalidate),
    ).rejects.toMatchObject({ biz: BizCode.ACTIVITY_METRIC_REFERENCE_UNAVAILABLE });
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(revalidate).toHaveBeenCalledTimes(1);
    expect(tx.activityMetricSetVersion.findFirst).not.toHaveBeenCalled();
  });
});
