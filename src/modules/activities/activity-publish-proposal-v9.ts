import {
  canonicalizeActivityTemplateDefinition,
  computeActivityTemplateDefinitionHash,
} from './activity-template-definition';
import {
  activityContributionPolicySelectionHash,
  activityContributionPolicySelectionScopeKey,
  parseActivityContributionPolicyPointer,
  parseActivityContributionPolicySelectionDocument,
  parseActivityContributionPolicySelectionScope,
  type ActivityContributionPolicyPointer,
  type ActivityContributionPolicySelectionDocument,
  type ActivityContributionPolicySelectionScope,
  type ActivityContributionPolicySelectionSourceLayer,
} from './activity-contribution-policy-selection';
import {
  contributionPolicyObject,
  contributionPolicyText,
} from './activity-contribution-policy-command';

export interface ActivityPublishProposalV9ResolvedContributionPolicy {
  readonly scope: ActivityContributionPolicySelectionScope;
  readonly pointer: ActivityContributionPolicyPointer;
  readonly sourceLayerCode: ActivityContributionPolicySelectionSourceLayer;
  readonly effectiveFrom: string;
  readonly effectiveUntil: string | null;
}

export interface ActivityPublishProposalV9ScopeReferenceKinds {
  readonly sessionRefKind: 'id' | 'clientRef' | null;
  readonly positionRefKind: 'id' | 'clientRef' | null;
}

export interface ActivityPublishProposalV9ContributionPolicyPointers {
  readonly schemaVersion: 1;
  readonly selectionRevision: number;
  readonly proposalSelectionHash: string;
  readonly selection: ActivityContributionPolicySelectionDocument;
  readonly resolved: readonly ActivityPublishProposalV9ResolvedContributionPolicy[];
  readonly referenceKinds: Readonly<Record<string, ActivityPublishProposalV9ScopeReferenceKinds>>;
}

export interface ActivityRuleSnapshotV9ContributionPolicyPointers extends ActivityPublishProposalV9ContributionPolicyPointers {
  readonly selectionRevisionId: string;
  readonly selectionHash: string;
}

export type ActivityPublishProposalV9ContributionPolicyFields = {
  readonly contributionPolicyPointers: ActivityPublishProposalV9ContributionPolicyPointers | null;
};

function invalid(message: string): never {
  throw new TypeError(`activity publish proposal V9 contribution policy: ${message}`);
}

function hash(value: unknown): string {
  const parsed = contributionPolicyText(value, 64);
  if (!/^[a-f0-9]{64}$/u.test(parsed)) invalid('invalid hash');
  return parsed;
}

function instant(value: unknown): string {
  const parsed = contributionPolicyText(value, 24);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(parsed) ||
    !Number.isFinite(new Date(parsed).getTime()) ||
    new Date(parsed).toISOString() !== parsed
  ) {
    invalid('invalid instant');
  }
  return parsed;
}

function parseResolved(value: unknown): ActivityPublishProposalV9ResolvedContributionPolicy {
  const row = contributionPolicyObject(value, [
    'scope',
    'pointer',
    'sourceLayerCode',
    'effectiveFrom',
    'effectiveUntil',
  ]);
  const sourceLayerCode = row.sourceLayerCode;
  if (
    sourceLayerCode !== 'template' &&
    sourceLayerCode !== 'activity' &&
    sourceLayerCode !== 'position'
  ) {
    invalid('invalid source layer');
  }
  const effectiveFrom = instant(row.effectiveFrom);
  const effectiveUntil = row.effectiveUntil === null ? null : instant(row.effectiveUntil);
  if (effectiveUntil !== null && effectiveUntil <= effectiveFrom) {
    invalid('invalid effective interval');
  }
  return {
    scope: parseActivityContributionPolicySelectionScope(row.scope),
    pointer: parseActivityContributionPolicyPointer(row.pointer),
    sourceLayerCode,
    effectiveFrom,
    effectiveUntil,
  };
}

function parseReferenceKinds(
  value: unknown,
  scopes: readonly ActivityContributionPolicySelectionScope[],
): Readonly<Record<string, ActivityPublishProposalV9ScopeReferenceKinds>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    invalid('reference kinds must be an object');
  }
  const source = value as Record<string, unknown>;
  const expected = new Map<string, ActivityContributionPolicySelectionScope>();
  for (const scope of scopes) {
    expected.set(activityContributionPolicySelectionScopeKey(scope), scope);
  }
  const keys = Object.keys(source).sort();
  if (keys.length !== expected.size || keys.some((key) => !expected.has(key))) {
    invalid('reference kinds do not match proposal scopes');
  }
  const parsed: Record<string, ActivityPublishProposalV9ScopeReferenceKinds> = {};
  for (const key of keys) {
    const scope = expected.get(key)!;
    const row = contributionPolicyObject(source[key], ['sessionRefKind', 'positionRefKind']);
    const sessionRefKind = row.sessionRefKind;
    const positionRefKind = row.positionRefKind;
    const validSession =
      scope.sessionId === null
        ? sessionRefKind === null
        : sessionRefKind === 'id' || sessionRefKind === 'clientRef';
    const validPosition =
      scope.positionId === null
        ? positionRefKind === null
        : positionRefKind === 'id' || positionRefKind === 'clientRef';
    if (!validSession || !validPosition) invalid('invalid reference kind for scope');
    parsed[key] = {
      sessionRefKind: sessionRefKind as 'id' | 'clientRef' | null,
      positionRefKind: positionRefKind as 'id' | 'clientRef' | null,
    };
  }
  return parsed;
}

export function parseActivityPublishProposalV9ContributionPolicyFields(
  value: unknown,
): ActivityPublishProposalV9ContributionPolicyFields {
  const root = contributionPolicyObject(value, ['contributionPolicyPointers']);
  if (root.contributionPolicyPointers === null) return { contributionPolicyPointers: null };
  const row = contributionPolicyObject(root.contributionPolicyPointers, [
    'schemaVersion',
    'selectionRevision',
    'proposalSelectionHash',
    'selection',
    'resolved',
    'referenceKinds',
  ]);
  const selectionRevision = row.selectionRevision;
  if (
    row.schemaVersion !== 1 ||
    typeof selectionRevision !== 'number' ||
    !Number.isInteger(selectionRevision) ||
    selectionRevision < 1 ||
    selectionRevision > 2_147_483_647 ||
    !Array.isArray(row.resolved)
  ) {
    invalid('invalid pointer envelope');
  }
  const selection = parseActivityContributionPolicySelectionDocument(row.selection);
  const proposalSelectionHash = hash(row.proposalSelectionHash);
  if (proposalSelectionHash !== activityContributionPolicySelectionHash(selection)) {
    invalid('proposal selection hash does not match selection');
  }
  const resolved = row.resolved.map(parseResolved);
  const seen = new Set<string>();
  for (const entry of resolved) {
    const key = activityContributionPolicySelectionScopeKey(entry.scope);
    if (seen.has(key)) invalid('duplicate resolved target');
    seen.add(key);
  }
  const referenceKinds = parseReferenceKinds(row.referenceKinds, [
    ...Object.values(selection.items).map((item) => item.scope),
    ...resolved.map((entry) => entry.scope),
  ]);
  return {
    contributionPolicyPointers: {
      schemaVersion: 1,
      selectionRevision,
      proposalSelectionHash,
      selection,
      resolved: [...resolved].sort((left, right) =>
        activityContributionPolicySelectionScopeKey(left.scope).localeCompare(
          activityContributionPolicySelectionScopeKey(right.scope),
        ),
      ),
      referenceKinds,
    },
  };
}

export function activityPublishProposalV9ContributionPolicyHash(
  fields: ActivityPublishProposalV9ContributionPolicyFields,
): string {
  return computeActivityTemplateDefinitionHash({
    schemaVersion: 1,
    definition: parseActivityPublishProposalV9ContributionPolicyFields(fields),
  });
}

export function sameActivityPublishProposalV9ContributionPolicyFields(
  left: ActivityPublishProposalV9ContributionPolicyFields,
  right: ActivityPublishProposalV9ContributionPolicyFields,
): boolean {
  return (
    canonicalizeActivityTemplateDefinition(
      parseActivityPublishProposalV9ContributionPolicyFields(left),
    ) ===
    canonicalizeActivityTemplateDefinition(
      parseActivityPublishProposalV9ContributionPolicyFields(right),
    )
  );
}

/** Configured activities can retain or advance a revision, never silently clear it. */
export function assertActivityPublishProposalV9ContributionPolicyTransition(
  base: ActivityPublishProposalV9ContributionPolicyFields,
  target: ActivityPublishProposalV9ContributionPolicyFields,
): boolean {
  const parsedBase =
    parseActivityPublishProposalV9ContributionPolicyFields(base).contributionPolicyPointers;
  const parsedTarget =
    parseActivityPublishProposalV9ContributionPolicyFields(target).contributionPolicyPointers;
  if (parsedTarget === null) {
    if (parsedBase === null) return false;
    invalid('configured contribution policy cannot be cleared');
  }
  if (parsedBase === null) return true;
  if (
    parsedTarget.selectionRevision !== parsedBase.selectionRevision &&
    parsedTarget.selectionRevision !== parsedBase.selectionRevision + 1
  ) {
    invalid('selection revision must be retained or advance exactly once');
  }
  return !sameActivityPublishProposalV9ContributionPolicyFields(base, target);
}

export function parseActivityRuleSnapshotV9ContributionPolicyPointers(
  value: unknown,
): ActivityRuleSnapshotV9ContributionPolicyPointers | null {
  if (value === null) return null;
  const row = contributionPolicyObject(value, [
    'schemaVersion',
    'selectionRevision',
    'proposalSelectionHash',
    'selection',
    'resolved',
    'referenceKinds',
    'selectionRevisionId',
    'selectionHash',
  ]);
  const parsed = parseActivityPublishProposalV9ContributionPolicyFields({
    contributionPolicyPointers: {
      schemaVersion: row.schemaVersion,
      selectionRevision: row.selectionRevision,
      proposalSelectionHash: row.proposalSelectionHash,
      selection: row.selection,
      resolved: row.resolved,
      referenceKinds: row.referenceKinds,
    },
  }).contributionPolicyPointers;
  if (!parsed) invalid('snapshot pointer cannot be null');
  const selectionHash = hash(row.selectionHash);
  if (selectionHash !== activityContributionPolicySelectionHash(parsed.selection)) {
    invalid('snapshot selection hash does not match selection');
  }
  return {
    ...parsed,
    selectionRevisionId: contributionPolicyText(row.selectionRevisionId, 64),
    selectionHash,
  };
}
