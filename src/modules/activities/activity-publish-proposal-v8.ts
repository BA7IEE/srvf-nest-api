import {
  canonicalizeActivityTemplateDefinition,
  computeActivityTemplateDefinitionHash,
} from './activity-template-definition';
import {
  activityTimePolicySelectionHash,
  activityTimePolicySelectionScopeKey,
  parseActivityTimePolicySelectionDocument,
  parseActivityTimePolicySelectionScope,
  parseActivityTimePolicySelectionValue,
  type ActivityTimePolicyPointer,
  type ActivityTimePolicySelectionDocument,
  type ActivityTimePolicySelectionScope,
} from './activity-time-policy-selection';
import { timePolicyObject, timePolicyText } from './activity-time-policy-command';

export interface ActivityPublishProposalV8ResolvedTimePolicy {
  readonly scope: ActivityTimePolicySelectionScope;
  readonly pointer: ActivityTimePolicyPointer;
  readonly evaluatorVersion: 1;
  readonly sourceScope: ActivityTimePolicySelectionScope;
  readonly effectiveFrom: string;
  readonly effectiveUntil: string | null;
}

/** A proposal can refer to an existing row or to a session/position created by the same review.
 * Keeping the kind beside the opaque value prevents a clientRef from being mistaken for an id
 * during the approval materialisation step. */
export interface ActivityPublishProposalV8ScopeReferenceKinds {
  readonly sessionRefKind: 'id' | 'clientRef' | null;
  readonly positionRefKind: 'id' | 'clientRef' | null;
}

/**
 * A proposal hash intentionally belongs to its logical proposal representation.  When newly
 * created sessions/positions are addressed with clientRefs it can differ from the immutable
 * revision's physical selectionHash, so the two values must never be compared as aliases.
 */
export interface ActivityPublishProposalV8TimePolicyPointers {
  readonly schemaVersion: 1;
  readonly selectionRevision: number;
  readonly proposalSelectionHash: string;
  readonly selection: ActivityTimePolicySelectionDocument;
  readonly resolved: readonly ActivityPublishProposalV8ResolvedTimePolicy[];
  readonly referenceKinds: Readonly<Record<string, ActivityPublishProposalV8ScopeReferenceKinds>>;
}

/** RuleSnapshot carries the database revision identity in addition to the review-safe proposal
 * envelope.  The immutable document/hash remain the single source of selection truth. */
export interface ActivityRuleSnapshotV8TimePolicyPointers extends ActivityPublishProposalV8TimePolicyPointers {
  readonly selectionRevisionId: string;
  readonly selectionHash: string;
}

export type ActivityPublishProposalV8TimePolicyFields = {
  readonly timePolicyPointers: ActivityPublishProposalV8TimePolicyPointers | null;
};

function invalid(message: string): never {
  throw new TypeError(`activity publish proposal V8 time policy: ${message}`);
}

function hash(value: unknown): string {
  const parsed = timePolicyText(value, 64);
  if (!/^[a-f0-9]{64}$/u.test(parsed)) invalid('invalid hash');
  return parsed;
}

function instant(value: unknown): string {
  const parsed = timePolicyText(value, 24);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(parsed) ||
    !Number.isFinite(new Date(parsed).getTime()) ||
    new Date(parsed).toISOString() !== parsed
  ) {
    invalid('invalid instant');
  }
  return parsed;
}

function pointer(value: unknown): ActivityTimePolicyPointer {
  const parsed = parseActivityTimePolicySelectionValue({ mode: 'explicit', pointer: value });
  if (parsed.mode !== 'explicit') invalid('missing pointer');
  return parsed.pointer;
}

function parseResolved(value: unknown): ActivityPublishProposalV8ResolvedTimePolicy {
  const row = timePolicyObject(value, [
    'scope',
    'pointer',
    'evaluatorVersion',
    'sourceScope',
    'effectiveFrom',
    'effectiveUntil',
  ]);
  if (row.evaluatorVersion !== 1) invalid('unsupported evaluator');
  const effectiveFrom = instant(row.effectiveFrom);
  const effectiveUntil = row.effectiveUntil === null ? null : instant(row.effectiveUntil);
  if (effectiveUntil !== null && effectiveUntil <= effectiveFrom)
    invalid('invalid effective interval');
  return {
    scope: parseActivityTimePolicySelectionScope(row.scope),
    pointer: pointer(row.pointer),
    evaluatorVersion: 1,
    sourceScope: parseActivityTimePolicySelectionScope(row.sourceScope),
    effectiveFrom,
    effectiveUntil,
  };
}

function parseReferenceKinds(
  value: unknown,
  scopes: readonly ActivityTimePolicySelectionScope[],
): Readonly<Record<string, ActivityPublishProposalV8ScopeReferenceKinds>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    invalid('reference kinds must be an object');
  }
  const source = value as Record<string, unknown>;
  const expected = new Map<string, ActivityTimePolicySelectionScope>();
  for (const scope of scopes) expected.set(activityTimePolicySelectionScopeKey(scope), scope);
  const keys = Object.keys(source).sort();
  if (keys.length !== expected.size || keys.some((key) => !expected.has(key))) {
    invalid('reference kinds do not match proposal scopes');
  }
  const parsed: Record<string, ActivityPublishProposalV8ScopeReferenceKinds> = {};
  for (const key of keys) {
    const scope = expected.get(key)!;
    const row = timePolicyObject(source[key], ['sessionRefKind', 'positionRefKind']);
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

export function parseActivityPublishProposalV8TimePolicyFields(
  value: unknown,
): ActivityPublishProposalV8TimePolicyFields {
  const root = timePolicyObject(value, ['timePolicyPointers']);
  if (root.timePolicyPointers === null) return { timePolicyPointers: null };
  const row = timePolicyObject(root.timePolicyPointers, [
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
    selectionRevision > 2147483647 ||
    !Array.isArray(row.resolved)
  ) {
    invalid('invalid pointer envelope');
  }
  const selection = parseActivityTimePolicySelectionDocument(row.selection);
  const proposalSelectionHash = hash(row.proposalSelectionHash);
  // The proposal hash names the logical selection fact.  For the first V8 implementation every
  // proposal target is already materialised (new clientRef targets are added by the change branch
  // below), so it must equal the canonical immutable-document hash rather than merely look like
  // one.  This closes the otherwise tempting "hash from another selection" substitution.
  if (proposalSelectionHash !== activityTimePolicySelectionHash(selection)) {
    invalid('proposal selection hash does not match selection');
  }
  const resolved = row.resolved.map(parseResolved);
  const seen = new Set<string>();
  for (const entry of resolved) {
    const key = activityTimePolicySelectionScopeKey(entry.scope);
    if (seen.has(key)) invalid('duplicate resolved target');
    seen.add(key);
    if (entry.scope.layerCode === 'template') invalid('template is not a runtime target');
  }
  const referenceKinds = parseReferenceKinds(row.referenceKinds, [
    ...Object.values(selection.items).map((item) => item.scope),
    ...resolved.flatMap((entry) => [entry.scope, entry.sourceScope]),
  ]);
  return {
    timePolicyPointers: {
      schemaVersion: 1,
      selectionRevision,
      proposalSelectionHash,
      selection,
      resolved: [...resolved].sort((left, right) =>
        activityTimePolicySelectionScopeKey(left.scope).localeCompare(
          activityTimePolicySelectionScopeKey(right.scope),
        ),
      ),
      referenceKinds,
    },
  };
}

export function activityPublishProposalV8TimePolicyHash(
  fields: ActivityPublishProposalV8TimePolicyFields,
): string {
  return computeActivityTemplateDefinitionHash({
    schemaVersion: 1,
    definition: parseActivityPublishProposalV8TimePolicyFields(fields),
  });
}

export function sameActivityPublishProposalV8TimePolicyFields(
  left: ActivityPublishProposalV8TimePolicyFields,
  right: ActivityPublishProposalV8TimePolicyFields,
): boolean {
  const first = parseActivityPublishProposalV8TimePolicyFields(left);
  const second = parseActivityPublishProposalV8TimePolicyFields(right);
  return (
    canonicalizeActivityTemplateDefinition(first) === canonicalizeActivityTemplateDefinition(second)
  );
}

/**
 * A proposal can retain an old configured selection, or advance it by exactly one real change.
 * Null is only historical representation; no V8 write can clear a configured activity back to it.
 */
export function assertActivityPublishProposalV8TimePolicyTransition(
  base: ActivityPublishProposalV8TimePolicyFields,
  target: ActivityPublishProposalV8TimePolicyFields,
): boolean {
  const parsedBase = parseActivityPublishProposalV8TimePolicyFields(base).timePolicyPointers;
  const parsedTarget = parseActivityPublishProposalV8TimePolicyFields(target).timePolicyPointers;
  if (parsedTarget === null) {
    if (parsedBase === null) return false;
    invalid('configured time policy cannot clear to legacy null');
  }
  if (parsedBase === null) {
    if (parsedTarget.selectionRevision !== 1)
      invalid('legacy migration must start at revision one');
    return true;
  }
  if (parsedTarget.selectionRevision === parsedBase.selectionRevision) {
    // Session dates/topology can legitimately change in the same review while the immutable
    // selection fact is retained.  `resolved` is therefore recomputed and frozen again, but it
    // must not be mistaken for a new selection revision.
    if (
      parsedTarget.proposalSelectionHash !== parsedBase.proposalSelectionHash ||
      canonicalizeActivityTemplateDefinition(parsedTarget.selection) !==
        canonicalizeActivityTemplateDefinition(parsedBase.selection)
    ) {
      invalid('retained revision changed');
    }
    return false;
  }
  if (parsedTarget.selectionRevision !== parsedBase.selectionRevision + 1) {
    invalid('invalid revision transition');
  }
  if (
    parsedTarget.proposalSelectionHash === parsedBase.proposalSelectionHash &&
    canonicalizeActivityTemplateDefinition(parsedTarget.selection) ===
      canonicalizeActivityTemplateDefinition(parsedBase.selection)
  ) {
    invalid('revision advanced without a selection change');
  }
  return true;
}
