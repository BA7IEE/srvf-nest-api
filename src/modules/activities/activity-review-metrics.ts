import type { ReviewMetricSetDto } from './activity-publish-review.dto';

import type { Prisma } from '@prisma/client';
import {
  parseActivityMetricSetPointer,
  assertMetricSelectionReference,
} from './activity-metric-selection';
import { metricDefinitionDocument, metricSetDocument } from './activity-metric-presenter';

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Resolve only immutable references in the already authorized, stored review. Missing evidence
 * leaves the review readable for return, without supplying an approvable metric projection. */
export async function readFrozenReviewMetrics(
  db: Pick<Prisma.TransactionClient, 'activityMetricSetVersion'>,
  snapshot: unknown,
) {
  if (!record(snapshot) || ![7, 8, 9].includes(Number(snapshot.schemaVersion))) return [];
  const documents: ReviewMetricSetDto[] = [];
  for (const side of [snapshot.base, snapshot]) {
    if (!record(side) || side.metricRequirementCode !== 'required') continue;
    try {
      const pointer = parseActivityMetricSetPointer(side.metricSetPointer);
      if (
        documents.some(
          (doc) => doc.id === pointer.id && doc.definitionHash === pointer.definitionHash,
        )
      )
        continue;
      const row = await db.activityMetricSetVersion.findUnique({
        where: { id: pointer.id },
        include: {
          items: { include: { metricDefinition: true }, orderBy: { sortOrder: 'asc' }, take: 101 },
        },
      });
      if (!row) continue;
      assertMetricSelectionReference(
        { metricRequirementCode: 'required', metricSetPointer: pointer },
        row,
        true,
      );
      documents.push({
        ...pointer,
        definition: metricSetDocument(row),
        metrics: row.items.map(({ metricDefinition }) => ({
          id: metricDefinition.id,
          definitionHash: metricDefinition.definitionHash,
          definition: metricDefinitionDocument(metricDefinition),
        })),
      });
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
    }
  }
  return documents;
}
