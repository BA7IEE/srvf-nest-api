import {
  materializeActivityTemplateTimePolicySelection,
  parseActivityTemplateDefinitionV4,
} from './activity-template-definition-v4';
import { parseActivityTemplateDefinitionV3 } from './activity-template-definition-v3';
import { fingerprintActivityTemplateDefinition } from './activity-template-definition';

const pointer = {
  policyId: 'policy',
  versionId: 'version',
  definitionHash: 'a'.repeat(64),
};
const base = {
  activity: { allocationModeCode: 'first_come' },
  sessions: [],
  registrationForm: null,
  metricSelection: { metricRequirementCode: 'not_required', metricSetPointer: null },
};
const v4 = {
  ...base,
  timePolicySelection: {
    default: { mode: 'explicit', pointer },
    sessionOverrides: [{ sessionCode: 'session_a', selection: { mode: 'explicit', pointer } }],
    positionOverrides: [
      {
        sessionCode: 'session_a',
        positionCode: 'position_a',
        selection: { mode: 'inherit', pointer: null },
      },
    ],
  },
};

describe('D1-3 template definition V4', () => {
  it('keeps the V3 branch exact while parsing a code-addressed time policy selection', () => {
    const parsed = parseActivityTemplateDefinitionV4(v4);
    const { timePolicySelection, ...v3 } = parsed;
    expect(v3).toEqual(parseActivityTemplateDefinitionV3(base));
    expect(timePolicySelection).toEqual(v4.timePolicySelection);
  });

  it('does not relax V1–V3 grammar or hash interpretation', () => {
    expect(() => parseActivityTemplateDefinitionV3(v4)).toThrow();
    expect(
      fingerprintActivityTemplateDefinition({ schemaVersion: 4, definition: v4 }).definitionHash,
    ).not.toBe(
      fingerprintActivityTemplateDefinition({ schemaVersion: 3, definition: base }).definitionHash,
    );
  });

  it.each([
    { ...v4, timePolicySelection: { ...v4.timePolicySelection, extra: true } },
    {
      ...v4,
      timePolicySelection: {
        ...v4.timePolicySelection,
        sessionOverrides: [
          ...v4.timePolicySelection.sessionOverrides,
          ...v4.timePolicySelection.sessionOverrides,
        ],
      },
    },
    {
      ...v4,
      timePolicySelection: {
        ...v4.timePolicySelection,
        positionOverrides: [
          { ...v4.timePolicySelection.positionOverrides[0], positionCode: ' Bad' },
        ],
      },
    },
  ])('rejects expanded, duplicate or invalid stable-code V4 data %#', (value) =>
    expect(() => parseActivityTemplateDefinitionV4(value)).toThrow(),
  );

  it('maps only exact template codes into a new activity selection document', () => {
    const document = materializeActivityTemplateTimePolicySelection(
      parseActivityTemplateDefinitionV4(v4).timePolicySelection,
      [
        {
          id: 'session-id',
          code: 'session_a',
          positions: [{ id: 'position-id', code: 'position_a' }],
        },
      ],
    );
    expect(document.items).toHaveProperty('activity:-:-');
    expect(document.items).toHaveProperty('template:-:-');
    expect(document.items).toHaveProperty('session:c2Vzc2lvbi1pZA==:-');
    expect(document.items['position:c2Vzc2lvbi1pZA==:cG9zaXRpb24taWQ=']).toBeUndefined();
    expect(() =>
      materializeActivityTemplateTimePolicySelection(
        parseActivityTemplateDefinitionV4(v4).timePolicySelection,
        [],
      ),
    ).toThrow('unknown session');
  });
});
