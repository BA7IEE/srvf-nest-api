import {
  ActivityTemplateDefinitionV2Error,
  parseActivityTemplateDefinitionV2,
} from './activity-template-definition-v2';

function governance(overrides: Record<string, unknown> = {}) {
  return {
    purposeCode: 'activity_specific_note',
    dataClassCode: 'ordinary',
    retentionPolicyCode: 'activity_lifecycle',
    maskingPolicyCode: 'none',
    prefillSourceCode: null,
    ...overrides,
  };
}

function field(typeCode: string, sortOrder: number): Record<string, unknown> {
  const base: Record<string, unknown> = {
    fieldCode: `${typeCode}_${sortOrder}`,
    typeCode,
    label: `题目 ${typeCode}`,
    required: false,
    visibilityCode: 'self_only',
    exportable: false,
    sortOrder,
    governance: governance(),
  };
  if (typeCode === 'single_choice' || typeCode === 'multi_choice') {
    base.options = [
      { value: 'yes', label: '是' },
      { value: 'no', label: '否' },
    ];
  }
  if (typeCode === 'multi_choice') base.maxSelections = 2;
  return base;
}

function definition(overrides: Record<string, unknown> = {}) {
  return {
    activity: { allocationModeCode: 'first_come' },
    sessions: [],
    registrationForm: {
      fields: [
        field('short_text', 0),
        field('long_text', 1),
        field('number', 2),
        field('date', 3),
        field('single_choice', 4),
        field('multi_choice', 5),
        field('file', 6),
        field('confirmation', 7),
      ],
    },
    ...overrides,
  };
}

describe('parseActivityTemplateDefinitionV2', () => {
  it('accepts all eight existing form field types as a full governed blueprint', () => {
    const parsed = parseActivityTemplateDefinitionV2(definition());

    expect(parsed.registrationForm?.fields.map((item) => item.typeCode)).toEqual([
      'short_text',
      'long_text',
      'number',
      'date',
      'single_choice',
      'multi_choice',
      'file',
      'confirmation',
    ]);
    expect(parsed.registrationForm?.fields[0]?.governance).toEqual(governance());
  });

  it('keeps sensitive in the grammar for the later B3-S gate instead of deleting a field type', () => {
    const value = definition();
    const fields = value.registrationForm.fields;
    fields[0] = { ...fields[0], governance: governance({ dataClassCode: 'sensitive' }) };

    expect(
      parseActivityTemplateDefinitionV2(value).registrationForm?.fields[0]?.governance,
    ).toMatchObject({
      dataClassCode: 'sensitive',
    });
  });

  it('accepts an explicit null Form but rejects legacy, mixed, exportable, and unknown V2 shapes', () => {
    expect(
      parseActivityTemplateDefinitionV2({
        activity: { allocationModeCode: 'first_come' },
        sessions: [],
        registrationForm: null,
      }).registrationForm,
    ).toBeNull();

    const legacy = definition();
    const legacyFields = legacy.registrationForm.fields;
    legacyFields.forEach((item) => delete item.governance);

    const mixed = definition();
    const mixedFields = mixed.registrationForm.fields;
    delete mixedFields[0]?.governance;

    const exportable = definition();
    const exportableFields = exportable.registrationForm.fields;
    exportableFields[0] = { ...exportableFields[0], exportable: true };

    for (const invalid of [
      legacy,
      mixed,
      exportable,
      definition({ unknown: true }),
      definition({ registrationForm: { fields: [field('short_text', 0)], script: 'x' } }),
    ]) {
      expect(() => parseActivityTemplateDefinitionV2(invalid)).toThrow(
        ActivityTemplateDefinitionV2Error,
      );
    }
  });
});
