import { fingerprintActivityTemplateDefinition } from './activity-template-definition';
import { parseActivityTemplateDefinitionV4 } from './activity-template-definition-v4';
import {
  activityTemplateContributionPolicyRuntimeSelection,
  materializeActivityTemplateContributionPolicySelection,
  parseActivityTemplateDefinitionV5,
} from './activity-template-definition-v5';

const pointer = {
  policyId: 'policy-one',
  versionId: 'version-one',
  definitionHash: 'a'.repeat(64),
  evaluatorVersion: 1,
};
const v4 = {
  activity: { allocationModeCode: 'first_come' },
  sessions: [],
  registrationForm: null,
  metricSelection: { metricRequirementCode: 'not_required', metricSetPointer: null },
  timePolicySelection: {
    default: { mode: 'inherit', pointer: null },
    sessionOverrides: [],
    positionOverrides: [],
  },
};
const v5 = {
  ...v4,
  contributionPolicySelection: {
    activityDefault: { mode: 'explicit', pointer },
    positionOverrides: [
      {
        sessionCode: 'session_a',
        positionCode: 'position_a',
        selection: { mode: 'explicit', pointer },
      },
    ],
  },
};

describe('E1-3 template definition V5', () => {
  it('adds only the code-addressed contribution selection to the exact V4 shape', () => {
    const parsed = parseActivityTemplateDefinitionV5(v5);
    const { contributionPolicySelection, ...legacy } = parsed;
    expect(legacy).toEqual(parseActivityTemplateDefinitionV4(v4));
    expect(contributionPolicySelection).toEqual(v5.contributionPolicySelection);
    expect(() => parseActivityTemplateDefinitionV4(v5)).toThrow();
    expect(
      fingerprintActivityTemplateDefinition({ schemaVersion: 5, definition: v5 }).definitionHash,
    ).not.toBe(
      fingerprintActivityTemplateDefinition({ schemaVersion: 4, definition: v4 }).definitionHash,
    );
  });

  it('keeps template defaults separate while materializing an immutable activity root', () => {
    const parsed = parseActivityTemplateDefinitionV5(v5).contributionPolicySelection;
    const materialized = materializeActivityTemplateContributionPolicySelection(parsed, [
      {
        id: 'session-id',
        code: 'session_a',
        positions: [{ id: 'position-id', code: 'position_a' }],
      },
    ]);
    expect(Object.values(materialized.document.items)).toEqual([
      {
        scope: { layerCode: 'activity', sessionId: null, positionId: null },
        selection: { mode: 'inherit', pointer: null },
      },
    ]);
    expect(materialized.templateSelection).toEqual(
      activityTemplateContributionPolicyRuntimeSelection(parsed),
    );
  });

  it.each([
    { ...v5, contributionPolicySelection: { ...v5.contributionPolicySelection, extra: true } },
    {
      ...v5,
      contributionPolicySelection: {
        ...v5.contributionPolicySelection,
        positionOverrides: [
          ...v5.contributionPolicySelection.positionOverrides,
          ...v5.contributionPolicySelection.positionOverrides,
        ],
      },
    },
    {
      ...v5,
      contributionPolicySelection: {
        ...v5.contributionPolicySelection,
        positionOverrides: [
          {
            ...v5.contributionPolicySelection.positionOverrides[0],
            selection: { mode: 'inherit', pointer: null },
          },
        ],
      },
    },
  ])('rejects expanded, duplicate or inherited position overrides %#', (value) => {
    expect(() => parseActivityTemplateDefinitionV5(value)).toThrow();
  });

  it('rejects template overrides that do not map to the exact stable position code', () => {
    expect(() =>
      materializeActivityTemplateContributionPolicySelection(
        parseActivityTemplateDefinitionV5(v5).contributionPolicySelection,
        [],
      ),
    ).toThrow('unknown position');
  });
});
