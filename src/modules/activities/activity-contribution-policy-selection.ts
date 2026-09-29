import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import {
  canonicalizeActivityTemplateDefinition,
  computeActivityTemplateDefinitionHash,
} from './activity-template-definition';
import {
  contributionPolicyHash,
  contributionPolicyObject,
  contributionPolicyText,
} from './activity-contribution-policy-command';

export const ACTIVITY_CONTRIBUTION_POLICY_SELECTION_SCHEMA_VERSION = 1 as const;

export type ActivityContributionPolicySelectionLayer = 'activity' | 'position';
export type ActivityContributionPolicySelectionMode = 'inherit' | 'explicit';
export type ActivityContributionPolicySelectionSourceLayer = 'template' | 'activity' | 'position';

export interface ActivityContributionPolicyPointer {
  readonly policyId: string;
  readonly versionId: string;
  readonly definitionHash: string;
  readonly evaluatorVersion: number;
}

export interface ActivityContributionPolicySelectionScope {
  readonly layerCode: ActivityContributionPolicySelectionLayer;
  readonly sessionId: string | null;
  readonly positionId: string | null;
}

export type ActivityContributionPolicySelectionValue =
  | { readonly mode: 'inherit'; readonly pointer: null }
  | { readonly mode: 'explicit'; readonly pointer: ActivityContributionPolicyPointer };

export interface ActivityContributionPolicySelectionItem {
  readonly scope: ActivityContributionPolicySelectionScope;
  readonly selection: ActivityContributionPolicySelectionValue;
}

export interface ActivityContributionPolicySelectionDocument {
  readonly schemaVersion: 1;
  readonly items: Readonly<Record<string, ActivityContributionPolicySelectionItem>>;
}

export interface ActivityContributionPolicySelectionChange {
  readonly scope: ActivityContributionPolicySelectionScope;
  readonly selection: ActivityContributionPolicySelectionValue;
}

export interface ActivityContributionPolicyTemplateSelection {
  readonly activityDefault: ActivityContributionPolicySelectionValue;
  readonly positionOverrides: readonly {
    readonly sessionCode: string;
    readonly positionCode: string;
    readonly pointer: ActivityContributionPolicyPointer;
  }[];
}

export interface ActivityContributionPolicyResolutionTarget {
  readonly sessionId: string;
  readonly sessionCode: string;
  readonly positionId: string;
  readonly positionCode: string;
}

export interface ActivityContributionPolicyResolvedTarget {
  readonly scope: ActivityContributionPolicySelectionScope;
  readonly pointer: ActivityContributionPolicyPointer | null;
  readonly sourceLayerCode: ActivityContributionPolicySelectionSourceLayer | null;
}

function selectionTypeError(message: string): never {
  throw new TypeError(`activity contribution policy selection: ${message}`);
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  return contributionPolicyObject(value, keys);
}

function nullableId(value: unknown): string | null {
  return value === null ? null : contributionPolicyText(value, 64);
}

function positiveInt(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    return selectionTypeError('invalid evaluator version');
  }
  return value;
}

export function parseActivityContributionPolicyPointer(
  value: unknown,
): ActivityContributionPolicyPointer {
  const row = exactRecord(value, ['policyId', 'versionId', 'definitionHash', 'evaluatorVersion']);
  return {
    policyId: contributionPolicyText(row.policyId, 64),
    versionId: contributionPolicyText(row.versionId, 64),
    definitionHash: contributionPolicyHash(row.definitionHash),
    evaluatorVersion: positiveInt(row.evaluatorVersion),
  };
}

export function activityContributionPolicySelectionScopeKey(
  scope: ActivityContributionPolicySelectionScope,
): string {
  const component = (id: string | null) =>
    id === null ? '-' : Buffer.from(id, 'utf8').toString('base64');
  return `${scope.layerCode}:${component(scope.sessionId)}:${component(scope.positionId)}`;
}

export function parseActivityContributionPolicySelectionScope(
  value: unknown,
): ActivityContributionPolicySelectionScope {
  const row = exactRecord(value, ['layerCode', 'sessionId', 'positionId']);
  const layerCode = row.layerCode;
  if (layerCode !== 'activity' && layerCode !== 'position') {
    return selectionTypeError('unknown layer');
  }
  const sessionId = nullableId(row.sessionId);
  const positionId = nullableId(row.positionId);
  if (
    (layerCode === 'activity' && (sessionId !== null || positionId !== null)) ||
    (layerCode === 'position' && (sessionId === null || positionId === null))
  ) {
    return selectionTypeError('invalid scope shape');
  }
  return { layerCode, sessionId, positionId };
}

export function parseActivityContributionPolicySelectionValue(
  value: unknown,
): ActivityContributionPolicySelectionValue {
  const row = exactRecord(value, ['mode', 'pointer']);
  if (row.mode === 'inherit' && row.pointer === null) {
    return { mode: 'inherit', pointer: null };
  }
  if (row.mode === 'explicit') {
    return { mode: 'explicit', pointer: parseActivityContributionPolicyPointer(row.pointer) };
  }
  return selectionTypeError('invalid selection value');
}

export function parseActivityContributionPolicySelectionItem(
  value: unknown,
): ActivityContributionPolicySelectionItem {
  const row = exactRecord(value, ['scope', 'selection']);
  return {
    scope: parseActivityContributionPolicySelectionScope(row.scope),
    selection: parseActivityContributionPolicySelectionValue(row.selection),
  };
}

function canonicalItems(
  items: readonly ActivityContributionPolicySelectionItem[],
): Readonly<Record<string, ActivityContributionPolicySelectionItem>> {
  const result: Record<string, ActivityContributionPolicySelectionItem> = {};
  let hasActivity = false;
  for (const item of items) {
    const parsed = parseActivityContributionPolicySelectionItem(item);
    if (parsed.scope.layerCode === 'activity') hasActivity = true;
    const key = activityContributionPolicySelectionScopeKey(parsed.scope);
    if (Object.prototype.hasOwnProperty.call(result, key)) {
      selectionTypeError('duplicate target scope');
    }
    result[key] = parsed;
  }
  if (!hasActivity) selectionTypeError('activity root is required');
  return Object.fromEntries(
    Object.entries(result).sort(([left], [right]) => left.localeCompare(right)),
  );
}

export function createActivityContributionPolicySelectionDocument(
  items: readonly ActivityContributionPolicySelectionItem[],
): ActivityContributionPolicySelectionDocument {
  return {
    schemaVersion: ACTIVITY_CONTRIBUTION_POLICY_SELECTION_SCHEMA_VERSION,
    items: canonicalItems(items),
  };
}

export function parseActivityContributionPolicySelectionDocument(
  value: unknown,
): ActivityContributionPolicySelectionDocument {
  const root = exactRecord(value, ['schemaVersion', 'items']);
  if (root.schemaVersion !== ACTIVITY_CONTRIBUTION_POLICY_SELECTION_SCHEMA_VERSION) {
    return selectionTypeError('unsupported schema version');
  }
  canonicalizeActivityTemplateDefinition({ schemaVersion: root.schemaVersion, items: root.items });
  if (root.items === null || typeof root.items !== 'object' || Array.isArray(root.items)) {
    return selectionTypeError('items must be an object');
  }
  const source = root.items as Record<string, unknown>;
  const items = Object.keys(source).map((key) => {
    const item = parseActivityContributionPolicySelectionItem(source[key]);
    if (key !== activityContributionPolicySelectionScopeKey(item.scope)) {
      return selectionTypeError('item key does not match scope');
    }
    return item;
  });
  return createActivityContributionPolicySelectionDocument(items);
}

export function emptyActivityContributionPolicySelectionDocument(): ActivityContributionPolicySelectionDocument {
  return createActivityContributionPolicySelectionDocument([
    {
      scope: { layerCode: 'activity', sessionId: null, positionId: null },
      selection: { mode: 'inherit', pointer: null },
    },
  ]);
}

export function activityContributionPolicySelectionHash(
  document: ActivityContributionPolicySelectionDocument,
): string {
  return computeActivityTemplateDefinitionHash({
    schemaVersion: ACTIVITY_CONTRIBUTION_POLICY_SELECTION_SCHEMA_VERSION,
    definition: parseActivityContributionPolicySelectionDocument(document),
  });
}

export function sameActivityContributionPolicySelection(
  left: ActivityContributionPolicySelectionDocument,
  right: ActivityContributionPolicySelectionDocument,
): boolean {
  return (
    activityContributionPolicySelectionHash(left) === activityContributionPolicySelectionHash(right)
  );
}

export function applyActivityContributionPolicySelectionChanges(
  current: ActivityContributionPolicySelectionDocument,
  changes: readonly ActivityContributionPolicySelectionChange[],
): ActivityContributionPolicySelectionDocument {
  const parsed = parseActivityContributionPolicySelectionDocument(current);
  if (changes.length < 1 || changes.length > 10_001) {
    selectionTypeError('change count out of range');
  }
  const next = new Map(Object.entries(parsed.items));
  const seen = new Set<string>();
  for (const raw of changes) {
    const change = parseActivityContributionPolicySelectionItem(raw);
    const key = activityContributionPolicySelectionScopeKey(change.scope);
    if (seen.has(key)) selectionTypeError('duplicate change target');
    seen.add(key);
    if (change.scope.layerCode === 'position' && change.selection.mode === 'inherit') {
      next.delete(key);
    } else {
      next.set(key, change);
    }
  }
  return createActivityContributionPolicySelectionDocument([...next.values()]);
}

function itemAt(
  document: ActivityContributionPolicySelectionDocument,
  scope: ActivityContributionPolicySelectionScope,
): ActivityContributionPolicySelectionItem | null {
  return document.items[activityContributionPolicySelectionScopeKey(scope)] ?? null;
}

function templatePositionKey(sessionCode: string, positionCode: string): string {
  return JSON.stringify([sessionCode, positionCode]);
}

/**
 * Resolve the three governed layers without merging pointer fields. Template references are read
 * from the immutable V5 definition; the activity revision stores only activity/position intent.
 */
export function resolveActivityContributionPolicySelection(
  value: ActivityContributionPolicySelectionDocument,
  template: ActivityContributionPolicyTemplateSelection | null,
  targets: readonly ActivityContributionPolicyResolutionTarget[],
): readonly ActivityContributionPolicyResolvedTarget[] {
  const document = parseActivityContributionPolicySelectionDocument(value);
  const activityScope = { layerCode: 'activity', sessionId: null, positionId: null } as const;
  const activityItem = itemAt(document, activityScope);
  if (!activityItem) selectionTypeError('activity root is required');

  const templatePositions = new Map<string, ActivityContributionPolicyPointer>();
  if (template) {
    for (const override of template.positionOverrides) {
      const key = templatePositionKey(override.sessionCode, override.positionCode);
      if (templatePositions.has(key)) selectionTypeError('duplicate template position override');
      templatePositions.set(key, parseActivityContributionPolicyPointer(override.pointer));
    }
  }

  const targetIds = new Set<string>();
  const targetCodes = new Set<string>();
  for (const target of targets) {
    if (targetIds.has(target.positionId)) selectionTypeError('duplicate position target');
    targetIds.add(target.positionId);
    const codeKey = templatePositionKey(target.sessionCode, target.positionCode);
    if (targetCodes.has(codeKey)) selectionTypeError('duplicate stable position target');
    targetCodes.add(codeKey);
  }
  for (const item of Object.values(document.items)) {
    if (item.scope.layerCode === 'position' && !targetIds.has(item.scope.positionId!)) {
      selectionTypeError('selection references an unknown position');
    }
  }
  for (const key of templatePositions.keys()) {
    if (!targetCodes.has(key)) selectionTypeError('template references an unknown position');
  }

  const templateDefault =
    template?.activityDefault.mode === 'explicit' ? template.activityDefault.pointer : null;
  const rootPointer =
    activityItem.selection.mode === 'explicit' ? activityItem.selection.pointer : templateDefault;
  const rootSource =
    activityItem.selection.mode === 'explicit'
      ? ('activity' as const)
      : rootPointer
        ? ('template' as const)
        : null;
  const result: ActivityContributionPolicyResolvedTarget[] = [
    { scope: activityScope, pointer: rootPointer, sourceLayerCode: rootSource },
  ];

  for (const target of [...targets].sort(
    (left, right) =>
      left.sessionId.localeCompare(right.sessionId) ||
      left.positionId.localeCompare(right.positionId),
  )) {
    const scope = {
      layerCode: 'position' as const,
      sessionId: target.sessionId,
      positionId: target.positionId,
    };
    const item = itemAt(document, scope);
    if (item?.selection.mode === 'explicit') {
      result.push({ scope, pointer: item.selection.pointer, sourceLayerCode: 'position' });
      continue;
    }
    if (activityItem.selection.mode === 'explicit') {
      result.push({ scope, pointer: activityItem.selection.pointer, sourceLayerCode: 'activity' });
      continue;
    }
    const templatePosition = templatePositions.get(
      templatePositionKey(target.sessionCode, target.positionCode),
    );
    result.push({
      scope,
      pointer: templatePosition ?? templateDefault,
      sourceLayerCode: templatePosition || templateDefault ? 'template' : null,
    });
  }
  return result;
}

export interface ActivityContributionPolicySelectionReceiptResult {
  readonly activityId: string;
  readonly selectionRevisionId: string;
  readonly revision: number;
  readonly selectionHash: string;
  readonly createdAt: string;
}

export function parseActivityContributionPolicySelectionReceipt(
  value: unknown,
  activityId: string,
): ActivityContributionPolicySelectionReceiptResult {
  try {
    const row = exactRecord(value, [
      'activityId',
      'selectionRevisionId',
      'revision',
      'selectionHash',
      'createdAt',
    ]);
    if (contributionPolicyText(row.activityId, 64) !== activityId) {
      selectionTypeError('wrong receipt activity');
    }
    const revision = row.revision;
    if (
      typeof revision !== 'number' ||
      !Number.isInteger(revision) ||
      revision < 1 ||
      revision > 2_147_483_647
    ) {
      selectionTypeError('invalid receipt revision');
    }
    const createdAt = contributionPolicyText(row.createdAt, 24);
    if (
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(createdAt) ||
      !Number.isFinite(new Date(createdAt).getTime()) ||
      new Date(createdAt).toISOString() !== createdAt
    ) {
      selectionTypeError('invalid receipt instant');
    }
    return {
      activityId,
      selectionRevisionId: contributionPolicyText(row.selectionRevisionId, 64),
      revision,
      selectionHash: contributionPolicyHash(row.selectionHash),
      createdAt,
    };
  } catch (error) {
    if (error instanceof TypeError) {
      throw new BizException(BizCode.ACTIVITY_CONTRIBUTION_POLICY_SELECTION_RECEIPT_INVALID);
    }
    throw error;
  }
}
