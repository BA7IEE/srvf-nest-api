import { parseActivityTemplateDefinitionV3 } from './activity-template-definition-v3';
import { parseActivityTemplateDefinitionV2 } from './activity-template-definition-v2';
import { parseActivityTemplateDefinitionV1 } from './activity-template-definition-v1';
import { fingerprintActivityTemplateDefinition } from './activity-template-definition';

const base = {
  activity: { allocationModeCode: 'first_come' },
  sessions: [],
  registrationForm: null,
};
const v3 = {
  ...base,
  metricSelection: { metricRequirementCode: 'not_required', metricSetPointer: null },
};
describe('C1 D2b Template V3 independent grammar', () => {
  it('reuses exact V2 semantics while preserving explicit selection', () => {
    const { metricSelection, ...parsed } = parseActivityTemplateDefinitionV3(v3);
    expect(parsed).toEqual(parseActivityTemplateDefinitionV2(base));
    expect(metricSelection).toEqual(v3.metricSelection);
  });
  it('keeps old parsers strict and old hash branches unchanged', () => {
    expect(() => parseActivityTemplateDefinitionV2(v3)).toThrow();
    expect(() => parseActivityTemplateDefinitionV1(v3)).toThrow();
    const v2Hash = fingerprintActivityTemplateDefinition({ schemaVersion: 2, definition: base });
    expect(fingerprintActivityTemplateDefinition({ schemaVersion: 2, definition: base })).toEqual(
      v2Hash,
    );
    expect(
      fingerprintActivityTemplateDefinition({ schemaVersion: 3, definition: v3 }).definitionHash,
    ).not.toBe(v2Hash.definitionHash);
  });
  it.each([
    base,
    { ...v3, metricSelection: null },
    { ...v3, resultValues: [] },
    { ...v3, sessions: null },
  ])('rejects incomplete or expanded V3 %#', (value) =>
    expect(() => parseActivityTemplateDefinitionV3(value)).toThrow(),
  );
});
