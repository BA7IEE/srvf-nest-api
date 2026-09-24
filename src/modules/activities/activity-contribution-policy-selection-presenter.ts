import {
  activityContributionPolicySelectionHash,
  activityContributionPolicySelectionScopeKey,
  parseActivityContributionPolicySelectionDocument,
  parseActivityContributionPolicySelectionItem,
  resolveActivityContributionPolicySelection,
  type ActivityContributionPolicyResolutionTarget,
  type ActivityContributionPolicySelectionDocument,
  type ActivityContributionPolicyTemplateSelection,
} from './activity-contribution-policy-selection';

export type StoredContributionPolicySelectionItem = {
  layerCode: string;
  sessionId: string | null;
  positionId: string | null;
  mode: string;
  policyId: string | null;
  versionId: string | null;
  definitionHash: string | null;
  evaluatorVersion: number | null;
};

function sameItem(
  left: ReturnType<typeof parseActivityContributionPolicySelectionItem>,
  right: ReturnType<typeof parseActivityContributionPolicySelectionItem>,
): boolean {
  return (
    left.scope.layerCode === right.scope.layerCode &&
    left.scope.sessionId === right.scope.sessionId &&
    left.scope.positionId === right.scope.positionId &&
    left.selection.mode === right.selection.mode &&
    left.selection.pointer?.policyId === right.selection.pointer?.policyId &&
    left.selection.pointer?.versionId === right.selection.pointer?.versionId &&
    left.selection.pointer?.definitionHash === right.selection.pointer?.definitionHash &&
    left.selection.pointer?.evaluatorVersion === right.selection.pointer?.evaluatorVersion
  );
}

export function readStoredActivityContributionPolicySelection(value: {
  selectionJson: unknown;
  selectionHash: string;
  itemCount: number;
}): ActivityContributionPolicySelectionDocument {
  const document = parseActivityContributionPolicySelectionDocument(value.selectionJson);
  if (
    activityContributionPolicySelectionHash(document) !== value.selectionHash ||
    Object.keys(document.items).length !== value.itemCount
  ) {
    throw new TypeError('stored contribution-policy selection is inconsistent');
  }
  return document;
}

export function presentActivityContributionPolicySelectionItem(
  item: StoredContributionPolicySelectionItem,
) {
  return parseActivityContributionPolicySelectionItem({
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
              evaluatorVersion: item.evaluatorVersion,
            },
          },
  });
}

export function presentActivityContributionPolicySelection(args: {
  activityId: string;
  selectionRevisionId: string;
  revision: number;
  selectionHash: string;
  createdAt: Date;
  document: ActivityContributionPolicySelectionDocument;
  pageItems: readonly StoredContributionPolicySelectionItem[];
  total: number;
  page: number;
  pageSize: number;
  templateSelection: ActivityContributionPolicyTemplateSelection | null;
  targets: readonly ActivityContributionPolicyResolutionTarget[];
}) {
  const items = args.pageItems.map((item) => {
    const parsed = presentActivityContributionPolicySelectionItem(item);
    const expected = args.document.items[activityContributionPolicySelectionScopeKey(parsed.scope)];
    if (!expected || !sameItem(expected, parsed)) {
      throw new TypeError('selection item differs from immutable manifest');
    }
    return parsed;
  });
  const resolved = resolveActivityContributionPolicySelection(
    args.document,
    args.templateSelection,
    args.targets,
  );
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
    resolved,
    resolutionSummary: {
      targetCount: resolved.length,
      resolvedTargetCount: resolvedCount,
      unresolvedTargetCount: resolved.length - resolvedCount,
    },
  };
}
