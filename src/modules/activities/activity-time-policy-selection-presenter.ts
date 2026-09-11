import {
  activityTimePolicySelectionHash,
  activityTimePolicySelectionScopeKey,
  parseActivityTimePolicySelectionDocument,
  parseActivityTimePolicySelectionItem,
  resolveActivityTimePolicySelection,
  type ActivityTimePolicySelectionDocument,
} from './activity-time-policy-selection';

type StoredSelectionItem = {
  layerCode: string;
  sessionId: string | null;
  positionId: string | null;
  mode: string;
  policyId: string | null;
  versionId: string | null;
  definitionHash: string | null;
};

function sameItem(
  left: ReturnType<typeof parseActivityTimePolicySelectionItem>,
  right: ReturnType<typeof parseActivityTimePolicySelectionItem>,
): boolean {
  return (
    left.scope.layerCode === right.scope.layerCode &&
    left.scope.sessionId === right.scope.sessionId &&
    left.scope.positionId === right.scope.positionId &&
    left.selection.mode === right.selection.mode &&
    left.selection.pointer?.policyId === right.selection.pointer?.policyId &&
    left.selection.pointer?.versionId === right.selection.pointer?.versionId &&
    left.selection.pointer?.definitionHash === right.selection.pointer?.definitionHash
  );
}

export function readStoredActivityTimePolicySelection(value: {
  selectionJson: unknown;
  selectionHash: string;
  itemCount: number;
}): ActivityTimePolicySelectionDocument {
  const document = parseActivityTimePolicySelectionDocument(value.selectionJson);
  if (
    activityTimePolicySelectionHash(document) !== value.selectionHash ||
    Object.keys(document.items).length !== value.itemCount
  ) {
    throw new TypeError('stored time-policy selection is inconsistent');
  }
  return document;
}

export function presentActivityTimePolicySelectionItem(item: StoredSelectionItem) {
  const parsed = parseActivityTimePolicySelectionItem({
    scope: {
      layerCode: item.layerCode,
      sessionId: item.sessionId,
      positionId: item.positionId,
    },
    selection:
      item.mode === 'inherit'
        ? { mode: 'inherit', pointer: null }
        : {
            mode: item.mode,
            pointer: {
              policyId: item.policyId,
              versionId: item.versionId,
              definitionHash: item.definitionHash,
            },
          },
  });
  return parsed;
}

export function presentActivityTimePolicySelection(args: {
  activityId: string;
  selectionRevisionId: string;
  revision: number;
  selectionHash: string;
  createdAt: Date;
  document: ActivityTimePolicySelectionDocument;
  pageItems: readonly StoredSelectionItem[];
  total: number;
  page: number;
  pageSize: number;
  targets: readonly { sessionId: string; positionIds: readonly string[] }[];
}) {
  const items = args.pageItems.map((item) => {
    const parsed = presentActivityTimePolicySelectionItem(item);
    const expected = args.document.items[activityTimePolicySelectionScopeKey(parsed.scope)];
    if (!expected || !sameItem(expected, parsed))
      throw new TypeError('selection item differs from immutable manifest');
    return parsed;
  });
  const resolved = resolveActivityTimePolicySelection(args.document, args.targets);
  const resolvedCount = resolved.filter((entry) => entry.pointer !== null).length;
  return {
    activityId: args.activityId,
    selectionRevisionId: args.selectionRevisionId,
    revision: args.revision,
    selectionHash: args.selectionHash,
    createdAt: args.createdAt.toISOString(),
    items,
    total: args.total,
    page: args.page,
    pageSize: args.pageSize,
    resolutionSummary: {
      targetCount: resolved.length,
      resolvedTargetCount: resolvedCount,
      unresolvedTargetCount: resolved.length - resolvedCount,
    },
  };
}
