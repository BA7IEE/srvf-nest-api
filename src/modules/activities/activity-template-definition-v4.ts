import { timePolicyObject, timePolicyText } from './activity-time-policy-command';
import {
  createActivityTimePolicySelectionDocument,
  parseActivityTimePolicySelectionValue,
  type ActivityTimePolicySelectionDocument,
  type ActivityTimePolicySelectionItem,
  type ActivityTimePolicySelectionValue,
} from './activity-time-policy-selection';
import {
  parseActivityTemplateDefinitionV3,
  type ActivityTemplateDefinitionV3,
} from './activity-template-definition-v3';

export interface ActivityTemplateTimePolicySessionOverride {
  readonly sessionCode: string;
  readonly selection: ActivityTimePolicySelectionValue;
}

export interface ActivityTemplateTimePolicyPositionOverride {
  readonly sessionCode: string;
  readonly positionCode: string;
  readonly selection: ActivityTimePolicySelectionValue;
}

/**
 * Codes, not database IDs, make a V4 template independently portable.  The copy path resolves
 * these codes to the new Activity's stable IDs inside its existing outer transaction.
 */
export interface ActivityTemplateTimePolicySelection {
  readonly default: ActivityTimePolicySelectionValue;
  readonly sessionOverrides: readonly ActivityTemplateTimePolicySessionOverride[];
  readonly positionOverrides: readonly ActivityTemplateTimePolicyPositionOverride[];
}

export interface ActivityTemplateDefinitionV4 extends ActivityTemplateDefinitionV3 {
  readonly timePolicySelection: ActivityTemplateTimePolicySelection;
}

function invalid(message: string): never {
  throw new TypeError(`activity template V4 time policy selection: ${message}`);
}

function code(value: unknown): string {
  const parsed = timePolicyText(value, 64);
  if (!/^[a-z][a-z0-9_]*$/u.test(parsed)) invalid('invalid stable code');
  return parsed;
}

function sessionOverride(value: unknown): ActivityTemplateTimePolicySessionOverride {
  const row = timePolicyObject(value, ['sessionCode', 'selection']);
  return {
    sessionCode: code(row.sessionCode),
    selection: parseActivityTimePolicySelectionValue(row.selection),
  };
}

function positionOverride(value: unknown): ActivityTemplateTimePolicyPositionOverride {
  const row = timePolicyObject(value, ['sessionCode', 'positionCode', 'selection']);
  return {
    sessionCode: code(row.sessionCode),
    positionCode: code(row.positionCode),
    selection: parseActivityTimePolicySelectionValue(row.selection),
  };
}

function parseTimePolicySelection(value: unknown): ActivityTemplateTimePolicySelection {
  const row = timePolicyObject(value, ['default', 'sessionOverrides', 'positionOverrides']);
  if (!Array.isArray(row.sessionOverrides) || !Array.isArray(row.positionOverrides)) {
    return invalid('overrides must be arrays');
  }
  const sessionOverrides = row.sessionOverrides.map(sessionOverride);
  const positionOverrides = row.positionOverrides.map(positionOverride);
  if (new Set(sessionOverrides.map((item) => item.sessionCode)).size !== sessionOverrides.length) {
    return invalid('duplicate session override');
  }
  if (
    new Set(positionOverrides.map((item) => JSON.stringify([item.sessionCode, item.positionCode])))
      .size !== positionOverrides.length
  ) {
    return invalid('duplicate position override');
  }
  return {
    default: parseActivityTimePolicySelectionValue(row.default),
    sessionOverrides: [...sessionOverrides].sort((left, right) =>
      left.sessionCode.localeCompare(right.sessionCode),
    ),
    positionOverrides: [...positionOverrides].sort(
      (left, right) =>
        left.sessionCode.localeCompare(right.sessionCode) ||
        left.positionCode.localeCompare(right.positionCode),
    ),
  };
}

/** V4 is a strict independent parser; V1–V3 retain their exact grammar and hash branches. */
export function parseActivityTemplateDefinitionV4(value: unknown): ActivityTemplateDefinitionV4 {
  const root = timePolicyObject(value, [
    'activity',
    'sessions',
    'registrationForm',
    'metricSelection',
    'timePolicySelection',
  ]);
  return {
    ...parseActivityTemplateDefinitionV3({
      activity: root.activity,
      sessions: root.sessions,
      registrationForm: root.registrationForm,
      metricSelection: root.metricSelection,
    }),
    timePolicySelection: parseTimePolicySelection(root.timePolicySelection),
  };
}

export interface ActivityTemplateTimePolicyMaterializationSession {
  readonly id: string;
  readonly code: string;
  readonly positions: readonly { id: string; code: string }[];
}

/**
 * Converts stable template codes into this Activity's IDs.  All supplied overrides must map
 * exactly once; accepting an unmatched code would silently make a template's policy disappear.
 */
export function materializeActivityTemplateTimePolicySelection(
  selection: ActivityTemplateTimePolicySelection,
  sessions: readonly ActivityTemplateTimePolicyMaterializationSession[],
): ActivityTimePolicySelectionDocument {
  const bySessionCode = new Map<string, ActivityTemplateTimePolicyMaterializationSession>();
  const byPositionCode = new Map<string, { id: string; sessionId: string }>();
  for (const session of sessions) {
    if (bySessionCode.has(session.code)) invalid('duplicate materialized session code');
    bySessionCode.set(session.code, session);
    for (const position of session.positions) {
      const key = JSON.stringify([session.code, position.code]);
      if (byPositionCode.has(key)) invalid('duplicate materialized position code');
      byPositionCode.set(key, { id: position.id, sessionId: session.id });
    }
  }
  const items: ActivityTimePolicySelectionItem[] = [
    {
      scope: { layerCode: 'template' as const, sessionId: null, positionId: null },
      selection: selection.default,
    },
    {
      scope: { layerCode: 'activity' as const, sessionId: null, positionId: null },
      selection: { mode: 'inherit' as const, pointer: null },
    },
  ];
  for (const override of selection.sessionOverrides) {
    const target = bySessionCode.get(override.sessionCode);
    if (!target) invalid('unknown session code in override');
    // An inherit override has no distinct semantic effect at this layer, so omit it from the
    // activity revision rather than create an unnecessary immutable item.
    if (override.selection.mode === 'inherit') continue;
    items.push({
      scope: { layerCode: 'session' as const, sessionId: target.id, positionId: null },
      selection: override.selection,
    });
  }
  for (const override of selection.positionOverrides) {
    const target = byPositionCode.get(
      JSON.stringify([override.sessionCode, override.positionCode]),
    );
    if (!target) invalid('unknown position code in override');
    if (override.selection.mode === 'inherit') continue;
    items.push({
      scope: {
        layerCode: 'position' as const,
        sessionId: target.sessionId,
        positionId: target.id,
      },
      selection: override.selection,
    });
  }
  return createActivityTimePolicySelectionDocument(items, { allowTemplate: true });
}
