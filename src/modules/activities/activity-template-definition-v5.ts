import {
  contributionPolicyObject,
  contributionPolicyText,
} from './activity-contribution-policy-command';
import {
  emptyActivityContributionPolicySelectionDocument,
  parseActivityContributionPolicySelectionValue,
  type ActivityContributionPolicyPointer,
  type ActivityContributionPolicySelectionDocument,
  type ActivityContributionPolicySelectionValue,
  type ActivityContributionPolicyTemplateSelection,
} from './activity-contribution-policy-selection';
import {
  parseActivityTemplateDefinitionV4,
  type ActivityTemplateDefinitionV4,
} from './activity-template-definition-v4';

export interface ActivityTemplateContributionPolicyPositionOverride {
  readonly sessionCode: string;
  readonly positionCode: string;
  readonly selection: {
    readonly mode: 'explicit';
    readonly pointer: ActivityContributionPolicyPointer;
  };
}

export interface ActivityTemplateContributionPolicySelection {
  readonly activityDefault: ActivityContributionPolicySelectionValue;
  readonly positionOverrides: readonly ActivityTemplateContributionPolicyPositionOverride[];
}

export interface ActivityTemplateDefinitionV5 extends ActivityTemplateDefinitionV4 {
  readonly contributionPolicySelection: ActivityTemplateContributionPolicySelection;
}

export interface ActivityTemplateContributionPolicyMaterializationTarget {
  readonly id: string;
  readonly code: string;
  readonly positions: readonly { id: string; code: string }[];
}

export interface MaterializedActivityTemplateContributionPolicySelection {
  readonly document: ActivityContributionPolicySelectionDocument;
  readonly templateSelection: ActivityContributionPolicyTemplateSelection;
}

function invalid(message: string): never {
  throw new TypeError(`activity template V5 contribution policy selection: ${message}`);
}

function stableCode(value: unknown): string {
  const parsed = contributionPolicyText(value, 64);
  if (!/^[a-z][a-z0-9_]*$/u.test(parsed)) invalid('invalid stable code');
  return parsed;
}

function positionOverride(value: unknown): ActivityTemplateContributionPolicyPositionOverride {
  const row = contributionPolicyObject(value, ['sessionCode', 'positionCode', 'selection']);
  const selection = parseActivityContributionPolicySelectionValue(row.selection);
  if (selection.mode !== 'explicit') invalid('position override must be explicit');
  return {
    sessionCode: stableCode(row.sessionCode),
    positionCode: stableCode(row.positionCode),
    selection,
  };
}

function parseContributionPolicySelection(
  value: unknown,
): ActivityTemplateContributionPolicySelection {
  const row = contributionPolicyObject(value, ['activityDefault', 'positionOverrides']);
  if (!Array.isArray(row.positionOverrides) || row.positionOverrides.length > 10_000) {
    return invalid('position overrides must be a bounded array');
  }
  const positionOverrides = row.positionOverrides.map(positionOverride);
  if (
    new Set(positionOverrides.map((item) => JSON.stringify([item.sessionCode, item.positionCode])))
      .size !== positionOverrides.length
  ) {
    return invalid('duplicate position override');
  }
  return {
    activityDefault: parseActivityContributionPolicySelectionValue(row.activityDefault),
    positionOverrides: [...positionOverrides].sort(
      (left, right) =>
        left.sessionCode.localeCompare(right.sessionCode) ||
        left.positionCode.localeCompare(right.positionCode),
    ),
  };
}

/** V5 is an independent parser; V1-V4 grammar and canonical hashes remain unchanged. */
export function parseActivityTemplateDefinitionV5(value: unknown): ActivityTemplateDefinitionV5 {
  const root = contributionPolicyObject(value, [
    'activity',
    'sessions',
    'registrationForm',
    'metricSelection',
    'timePolicySelection',
    'contributionPolicySelection',
  ]);
  return {
    ...parseActivityTemplateDefinitionV4({
      activity: root.activity,
      sessions: root.sessions,
      registrationForm: root.registrationForm,
      metricSelection: root.metricSelection,
      timePolicySelection: root.timePolicySelection,
    }),
    contributionPolicySelection: parseContributionPolicySelection(root.contributionPolicySelection),
  };
}

/**
 * A template remains an immutable source layer. The activity revision stores the explicit
 * activity/position overrides only, while the anchored V5 definition supplies template defaults.
 */
export function materializeActivityTemplateContributionPolicySelection(
  selection: ActivityTemplateContributionPolicySelection,
  sessions: readonly ActivityTemplateContributionPolicyMaterializationTarget[],
): MaterializedActivityTemplateContributionPolicySelection {
  const targetKeys = new Set<string>();
  for (const session of sessions) {
    for (const position of session.positions) {
      const key = JSON.stringify([session.code, position.code]);
      if (targetKeys.has(key)) invalid('duplicate materialized position code');
      targetKeys.add(key);
    }
  }
  for (const override of selection.positionOverrides) {
    if (!targetKeys.has(JSON.stringify([override.sessionCode, override.positionCode]))) {
      invalid('unknown position code in override');
    }
  }
  return {
    document: emptyActivityContributionPolicySelectionDocument(),
    templateSelection: activityTemplateContributionPolicyRuntimeSelection(selection),
  };
}

export function activityTemplateContributionPolicyRuntimeSelection(
  selection: ActivityTemplateContributionPolicySelection,
): ActivityContributionPolicyTemplateSelection {
  return {
    activityDefault: selection.activityDefault,
    positionOverrides: selection.positionOverrides.map((item) => ({
      sessionCode: item.sessionCode,
      positionCode: item.positionCode,
      pointer: item.selection.pointer,
    })),
  };
}
