import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import {
  computeActivityTemplateDefinitionHash,
  canonicalizeActivityTemplateDefinition,
} from './activity-template-definition';
import { timePolicyObject, timePolicyText } from './activity-time-policy-command';
import { parseTimePolicyVersionReference } from './activity-time-policy-definition';

/** The persisted selection grammar deliberately has its own version from a policy definition. */
export const ACTIVITY_TIME_POLICY_SELECTION_SCHEMA_VERSION = 1 as const;

export type ActivityTimePolicySelectionLayer = 'template' | 'activity' | 'session' | 'position';
export type ActivityTimePolicySelectionMode = 'inherit' | 'explicit';

export interface ActivityTimePolicyPointer {
  readonly policyId: string;
  readonly versionId: string;
  readonly definitionHash: string;
}

/**
 * Nullability is intentional and is part of the hashable grammar.  A session or position cannot
 * be represented by an ad-hoc string key; the three fields make the layer explicit and are later
 * mirrored by compound database anchors.
 */
export interface ActivityTimePolicySelectionScope {
  readonly layerCode: ActivityTimePolicySelectionLayer;
  readonly sessionId: string | null;
  readonly positionId: string | null;
}

export type ActivityTimePolicySelectionValue =
  | { readonly mode: 'inherit'; readonly pointer: null }
  | { readonly mode: 'explicit'; readonly pointer: ActivityTimePolicyPointer };

export interface ActivityTimePolicySelectionItem {
  readonly scope: ActivityTimePolicySelectionScope;
  readonly selection: ActivityTimePolicySelectionValue;
}

/**
 * `items` is an object keyed by the exact scope tuple, rather than an array.  This removes array
 * order from the persisted semantic representation and lets the migration reject an appended item
 * that was not part of a revision's frozen manifest.
 */
export interface ActivityTimePolicySelectionDocument {
  readonly schemaVersion: 1;
  readonly items: Readonly<Record<string, ActivityTimePolicySelectionItem>>;
}

export interface ActivityTimePolicySelectionChange {
  readonly scope: ActivityTimePolicySelectionScope;
  readonly selection: ActivityTimePolicySelectionValue;
}

export interface ActivityTimePolicySelectionResolutionTarget {
  readonly sessionId: string;
  readonly positionIds: readonly string[];
}

export interface ActivityTimePolicySelectionResolvedTarget {
  readonly scope: ActivityTimePolicySelectionScope;
  readonly pointer: ActivityTimePolicyPointer | null;
  readonly sourceScope: ActivityTimePolicySelectionScope | null;
}

function selectionTypeError(message: string): never {
  throw new TypeError(`activity time policy selection: ${message}`);
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  return timePolicyObject(value, keys);
}

function nullableId(value: unknown): string | null {
  return value === null ? null : timePolicyText(value, 64);
}

export function activityTimePolicySelectionScopeKey(
  scope: ActivityTimePolicySelectionScope,
): string {
  // `-` cannot be produced by standard base64, so this remains injective even if a future ID
  // alphabet broadens. PostgreSQL can reproduce the same tuple key with encode(convert_to(...)),
  // without pretending that jsonb's text rendering is our canonical JSON implementation.
  const component = (id: string | null) =>
    id === null ? '-' : Buffer.from(id, 'utf8').toString('base64');
  return `${scope.layerCode}:${component(scope.sessionId)}:${component(scope.positionId)}`;
}

export function parseActivityTimePolicySelectionScope(
  value: unknown,
): ActivityTimePolicySelectionScope {
  const row = exactRecord(value, ['layerCode', 'sessionId', 'positionId']);
  const layerCode = row.layerCode;
  if (
    layerCode !== 'template' &&
    layerCode !== 'activity' &&
    layerCode !== 'session' &&
    layerCode !== 'position'
  ) {
    return selectionTypeError('unknown layer');
  }
  const sessionId = nullableId(row.sessionId);
  const positionId = nullableId(row.positionId);
  if (
    ((layerCode === 'template' || layerCode === 'activity') &&
      (sessionId !== null || positionId !== null)) ||
    (layerCode === 'session' && (sessionId === null || positionId !== null)) ||
    (layerCode === 'position' && (sessionId === null || positionId === null))
  ) {
    return selectionTypeError('invalid scope shape');
  }
  return { layerCode, sessionId, positionId };
}

export function parseActivityTimePolicySelectionValue(
  value: unknown,
): ActivityTimePolicySelectionValue {
  const row = exactRecord(value, ['mode', 'pointer']);
  if (row.mode === 'inherit' && row.pointer === null) return { mode: 'inherit', pointer: null };
  if (row.mode === 'explicit') {
    const pointer = parseTimePolicyVersionReference(row.pointer);
    return {
      mode: 'explicit',
      pointer: {
        policyId: pointer.policyId,
        versionId: pointer.versionId,
        definitionHash: pointer.definitionHash,
      },
    };
  }
  return selectionTypeError('invalid selection value');
}

export function parseActivityTimePolicySelectionItem(
  value: unknown,
): ActivityTimePolicySelectionItem {
  const row = exactRecord(value, ['scope', 'selection']);
  return {
    scope: parseActivityTimePolicySelectionScope(row.scope),
    selection: parseActivityTimePolicySelectionValue(row.selection),
  };
}

function canonicalItems(
  items: readonly ActivityTimePolicySelectionItem[],
  options: { requireActivity: boolean; allowTemplate: boolean },
): Readonly<Record<string, ActivityTimePolicySelectionItem>> {
  const result: Record<string, ActivityTimePolicySelectionItem> = {};
  let hasActivity = false;
  for (const item of items) {
    const parsed = parseActivityTimePolicySelectionItem(item);
    if (!options.allowTemplate && parsed.scope.layerCode === 'template') {
      selectionTypeError('template selection is not allowed in this document');
    }
    if (parsed.scope.layerCode === 'activity') hasActivity = true;
    const key = activityTimePolicySelectionScopeKey(parsed.scope);
    if (Object.prototype.hasOwnProperty.call(result, key)) {
      selectionTypeError('duplicate target scope');
    }
    result[key] = parsed;
  }
  if (options.requireActivity && !hasActivity) selectionTypeError('activity root is required');
  return Object.fromEntries(
    Object.entries(result).sort(([left], [right]) => left.localeCompare(right)),
  );
}

export function createActivityTimePolicySelectionDocument(
  items: readonly ActivityTimePolicySelectionItem[],
  options: { requireActivity?: boolean; allowTemplate?: boolean } = {},
): ActivityTimePolicySelectionDocument {
  return {
    schemaVersion: ACTIVITY_TIME_POLICY_SELECTION_SCHEMA_VERSION,
    items: canonicalItems(items, {
      requireActivity: options.requireActivity ?? true,
      allowTemplate: options.allowTemplate ?? true,
    }),
  };
}

/** Parser for an already-persisted full immutable revision. */
export function parseActivityTimePolicySelectionDocument(
  value: unknown,
  options: { requireActivity?: boolean; allowTemplate?: boolean } = {},
): ActivityTimePolicySelectionDocument {
  const root = exactRecord(value, ['schemaVersion', 'items']);
  if (root.schemaVersion !== ACTIVITY_TIME_POLICY_SELECTION_SCHEMA_VERSION) {
    return selectionTypeError('unsupported schema version');
  }
  // Canonicalization rejects accessors, exotic prototypes, symbols and sparse values before we
  // inspect the object.  It also keeps this parser's behavior aligned with all other hashed
  // Activity documents.
  canonicalizeActivityTemplateDefinition({ schemaVersion: root.schemaVersion, items: root.items });
  if (root.items === null || typeof root.items !== 'object' || Array.isArray(root.items)) {
    return selectionTypeError('items must be an object');
  }
  const source = root.items as Record<string, unknown>;
  const items = Object.keys(source).map((key) => {
    const item = parseActivityTimePolicySelectionItem(source[key]);
    if (key !== activityTimePolicySelectionScopeKey(item.scope)) {
      return selectionTypeError('item key does not match scope');
    }
    return item;
  });
  return createActivityTimePolicySelectionDocument(items, options);
}

export function emptyActivityTimePolicySelectionDocument(): ActivityTimePolicySelectionDocument {
  return createActivityTimePolicySelectionDocument([
    {
      scope: { layerCode: 'activity', sessionId: null, positionId: null },
      selection: { mode: 'inherit', pointer: null },
    },
  ]);
}

export function activityTimePolicySelectionHash(
  document: ActivityTimePolicySelectionDocument,
): string {
  const parsed = parseActivityTimePolicySelectionDocument(document);
  return computeActivityTemplateDefinitionHash({
    schemaVersion: ACTIVITY_TIME_POLICY_SELECTION_SCHEMA_VERSION,
    definition: parsed,
  });
}

export function sameActivityTimePolicySelection(
  left: ActivityTimePolicySelectionDocument,
  right: ActivityTimePolicySelectionDocument,
): boolean {
  return activityTimePolicySelectionHash(left) === activityTimePolicySelectionHash(right);
}

/**
 * A session/position `inherit` removes its current override from the *new* immutable revision;
 * it never deletes any historic row.  The activity root must remain explicit so an all-inherit
 * aggregate is distinguishable from pre-D1-3 legacy data.
 */
export function applyActivityTimePolicySelectionChanges(
  current: ActivityTimePolicySelectionDocument,
  changes: readonly ActivityTimePolicySelectionChange[],
): ActivityTimePolicySelectionDocument {
  const parsed = parseActivityTimePolicySelectionDocument(current);
  if (changes.length < 1 || changes.length > 100) selectionTypeError('change count out of range');
  const next = new Map(Object.entries(parsed.items));
  const seen = new Set<string>();
  for (const raw of changes) {
    const change = parseActivityTimePolicySelectionItem(raw);
    if (change.scope.layerCode === 'template') {
      selectionTypeError('template root is immutable through activity changes');
    }
    const key = activityTimePolicySelectionScopeKey(change.scope);
    if (seen.has(key)) selectionTypeError('duplicate change target');
    seen.add(key);
    if (
      (change.scope.layerCode === 'session' || change.scope.layerCode === 'position') &&
      change.selection.mode === 'inherit'
    ) {
      next.delete(key);
    } else {
      next.set(key, change);
    }
  }
  return createActivityTimePolicySelectionDocument([...next.values()], {
    requireActivity: true,
    allowTemplate: true,
  });
}

function itemAt(
  document: ActivityTimePolicySelectionDocument,
  scope: ActivityTimePolicySelectionScope,
): ActivityTimePolicySelectionItem | null {
  return document.items[activityTimePolicySelectionScopeKey(scope)] ?? null;
}

function resolvedFrom(
  document: ActivityTimePolicySelectionDocument,
  scopes: readonly ActivityTimePolicySelectionScope[],
): {
  pointer: ActivityTimePolicyPointer | null;
  sourceScope: ActivityTimePolicySelectionScope | null;
} {
  for (let index = scopes.length - 1; index >= 0; index -= 1) {
    const item = itemAt(document, scopes[index]);
    if (item?.selection.mode === 'explicit') {
      return { pointer: item.selection.pointer, sourceScope: item.scope };
    }
  }
  return { pointer: null, sourceScope: null };
}

/**
 * Resolves the nearest explicit pointer.  It intentionally does not fetch policy records or make
 * an unavailable pointer look valid; catalogue/interval validation belongs to the transactional
 * writer and readiness facts.  Unknown target IDs are rejected rather than silently ignored.
 */
export function resolveActivityTimePolicySelection(
  value: ActivityTimePolicySelectionDocument,
  targets: readonly ActivityTimePolicySelectionResolutionTarget[],
): readonly ActivityTimePolicySelectionResolvedTarget[] {
  const document = parseActivityTimePolicySelectionDocument(value);
  const targetSessions = new Set<string>();
  const targetPositions = new Set<string>();
  for (const session of targets) {
    if (targetSessions.has(session.sessionId)) selectionTypeError('duplicate session target');
    targetSessions.add(session.sessionId);
    for (const positionId of session.positionIds) {
      if (targetPositions.has(positionId)) selectionTypeError('duplicate position target');
      targetPositions.add(positionId);
    }
  }
  for (const item of Object.values(document.items)) {
    if (item.scope.layerCode === 'session' && !targetSessions.has(item.scope.sessionId!)) {
      selectionTypeError('selection references an unknown session');
    }
    if (item.scope.layerCode === 'position' && !targetPositions.has(item.scope.positionId!)) {
      selectionTypeError('selection references an unknown position');
    }
  }
  const template = { layerCode: 'template', sessionId: null, positionId: null } as const;
  const activity = { layerCode: 'activity', sessionId: null, positionId: null } as const;
  const result: ActivityTimePolicySelectionResolvedTarget[] = [];
  result.push({
    scope: activity,
    ...resolvedFrom(document, [template, activity]),
  });
  for (const session of [...targets].sort((left, right) =>
    left.sessionId.localeCompare(right.sessionId),
  )) {
    const sessionScope = {
      layerCode: 'session' as const,
      sessionId: session.sessionId,
      positionId: null,
    };
    result.push({
      scope: sessionScope,
      ...resolvedFrom(document, [template, activity, sessionScope]),
    });
    for (const positionId of [...session.positionIds].sort()) {
      const positionScope = {
        layerCode: 'position' as const,
        sessionId: session.sessionId,
        positionId,
      };
      result.push({
        scope: positionScope,
        ...resolvedFrom(document, [template, activity, sessionScope, positionScope]),
      });
    }
  }
  return result;
}

export interface ActivityTimePolicySelectionReceiptResult {
  readonly activityId: string;
  readonly selectionRevisionId: string;
  readonly revision: number;
  readonly selectionHash: string;
  readonly createdAt: string;
}

/** Exact, safe result shape returned for a replay; neither operation key nor actor leaks out. */
export function parseActivityTimePolicySelectionReceipt(
  value: unknown,
  activityId: string,
): ActivityTimePolicySelectionReceiptResult {
  try {
    const row = exactRecord(value, [
      'activityId',
      'selectionRevisionId',
      'revision',
      'selectionHash',
      'createdAt',
    ]);
    if (timePolicyText(row.activityId, 64) !== activityId)
      selectionTypeError('wrong receipt activity');
    const revision = row.revision;
    if (
      typeof revision !== 'number' ||
      !Number.isInteger(revision) ||
      revision < 1 ||
      revision > 2147483647
    ) {
      selectionTypeError('invalid receipt revision');
    }
    const createdAt = timePolicyText(row.createdAt, 24);
    if (
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(createdAt) ||
      !Number.isFinite(new Date(createdAt).getTime()) ||
      new Date(createdAt).toISOString() !== createdAt
    ) {
      selectionTypeError('invalid receipt instant');
    }
    return {
      activityId,
      selectionRevisionId: timePolicyText(row.selectionRevisionId, 64),
      revision,
      selectionHash: (() => {
        const hash = timePolicyText(row.selectionHash, 64);
        if (!/^[a-f0-9]{64}$/u.test(hash)) selectionTypeError('invalid receipt hash');
        return hash;
      })(),
      createdAt,
    };
  } catch (error) {
    if (error instanceof TypeError) {
      throw new BizException(BizCode.ACTIVITY_TIME_POLICY_SELECTION_RECEIPT_INVALID);
    }
    throw error;
  }
}
