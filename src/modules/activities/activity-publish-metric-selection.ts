import { Prisma } from '@prisma/client';

import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import {
  assertMetricSelectionReference,
  type ActivityMetricSelection,
} from './activity-metric-selection';

type PrismaTx = Prisma.TransactionClient;

export interface ActivityPublishMetricSelectionReference {
  readonly selection: ActivityMetricSelection;
  /** A retained published selection may be retired, but a newly selected reference may not. */
  readonly historical: boolean;
}

function requiredMetricSetId(reference: ActivityPublishMetricSelectionReference): string {
  if (
    reference.selection.metricRequirementCode !== 'required' ||
    reference.selection.metricSetPointer === null
  ) {
    throw new BizException(BizCode.ACTIVITY_METRIC_REFERENCE_UNAVAILABLE);
  }
  return reference.selection.metricSetPointer.id;
}

/**
 * Caller already owns the Activity root lock.  Keep catalogue locking separate from D2b's draft
 * writer primitive: this branch freezes/approves proposal references and must never mutate an
 * Activity outside the existing review apply path.
 */
export async function lockActivityPublishMetricSelections(
  tx: PrismaTx,
  references: readonly ActivityPublishMetricSelectionReference[],
  revalidate: () => Promise<void>,
): Promise<void> {
  const bySetId = new Map<string, ActivityPublishMetricSelectionReference>();
  for (const reference of references) {
    if (reference.selection.metricRequirementCode === 'not_required') continue;
    const id = requiredMetricSetId(reference);
    const existing = bySetId.get(id);
    // A strict new selection wins over a retained historical interpretation of the same pointer.
    if (!existing || (existing.historical && !reference.historical)) {
      bySetId.set(id, reference);
    }
  }
  if (bySetId.size === 0) {
    await revalidate();
    return;
  }

  for (const reference of [...bySetId.values()].sort((left, right) => {
    return requiredMetricSetId(left).localeCompare(requiredMetricSetId(right));
  })) {
    const id = requiredMetricSetId(reference);
    await tx.$queryRaw`SELECT "id" FROM "ActivityMetricSetVersion" WHERE "id" = ${id} FOR SHARE`;
    await revalidate();

    const items = await tx.activityMetricSetItem.findMany({
      where: { setVersionId: id },
      select: { metricDefinitionId: true },
      take: 101,
    });
    if (items.length < 1 || items.length > 100) {
      throw new BizException(BizCode.ACTIVITY_METRIC_REFERENCE_UNAVAILABLE);
    }
    const definitionIds = items.map((item) => item.metricDefinitionId).sort();
    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM "ActivityMetricDefinition" WHERE "id" IN (${Prisma.join(definitionIds)}) ORDER BY "id" FOR SHARE`,
    );
    await revalidate();

    const row = await tx.activityMetricSetVersion.findFirst({
      where: { id },
      include: {
        items: {
          include: { metricDefinition: true },
          take: 101,
          orderBy: { sortOrder: 'asc' },
        },
      },
    });
    try {
      assertMetricSelectionReference(reference.selection, row, reference.historical);
    } catch (error) {
      if (error instanceof TypeError) {
        throw new BizException(BizCode.ACTIVITY_METRIC_REFERENCE_UNAVAILABLE);
      }
      throw error;
    }
  }
}
