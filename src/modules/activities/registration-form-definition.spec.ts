import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import {
  canonicalizeRegistrationFormDefinition,
  canonicalizeRegistrationFormDefinitionForB3,
  registrationFormDefinitionFromStoredFields,
  registrationFormPublicDefinition,
  type RegistrationFormFieldInput,
} from './registration-form-definition';

function field(overrides: Partial<RegistrationFormFieldInput> = {}): RegistrationFormFieldInput {
  return {
    fieldCode: 'field',
    typeCode: 'short_text',
    label: '题目',
    required: false,
    visibilityCode: 'self_only',
    exportable: false,
    sortOrder: 0,
    ...overrides,
  };
}

function expectBad(input: Parameters<typeof canonicalizeRegistrationFormDefinition>[0]): void {
  expect(() => canonicalizeRegistrationFormDefinition(input)).toThrow(BizException);
  try {
    canonicalizeRegistrationFormDefinition(input);
  } catch (error) {
    expect(error).toEqual(new BizException(BizCode.BAD_REQUEST));
  }
}

describe('canonicalizeRegistrationFormDefinition', () => {
  it('normalizes all eight field types in stable sortOrder/fieldCode order without reordering choices', () => {
    const result = canonicalizeRegistrationFormDefinition({
      fields: [
        {
          fieldCode: 'multi',
          typeCode: 'multi_choice',
          label: '可多选',
          required: false,
          visibilityCode: 'self_only',
          exportable: false,
          sortOrder: 2,
          maxSelections: 2,
          options: [
            { value: 'second', label: '第二项' },
            { value: 'first', label: '第一项' },
          ],
        },
        {
          fieldCode: 'short',
          typeCode: 'short_text',
          label: '短文本',
          required: true,
          visibilityCode: 'self_and_owner',
          exportable: true,
          sortOrder: 1,
          minLength: 1,
          maxLength: 20,
        },
        {
          fieldCode: 'long',
          typeCode: 'long_text',
          label: '长文本',
          required: false,
          visibilityCode: 'self_and_registration_staff',
          exportable: false,
          sortOrder: 1,
          maxLength: 200,
        },
        {
          fieldCode: 'number',
          typeCode: 'number',
          label: '数字',
          required: false,
          visibilityCode: 'self_only',
          exportable: false,
          sortOrder: 3,
          minValue: 1,
          maxValue: 9,
        },
        {
          fieldCode: 'date',
          typeCode: 'date',
          label: '日期',
          required: false,
          visibilityCode: 'self_only',
          exportable: false,
          sortOrder: 4,
        },
        {
          fieldCode: 'single',
          typeCode: 'single_choice',
          label: '单选',
          required: false,
          visibilityCode: 'self_only',
          exportable: false,
          sortOrder: 5,
          options: [{ value: 'yes', label: '是' }],
        },
        {
          fieldCode: 'file',
          typeCode: 'file',
          label: '附件',
          required: false,
          visibilityCode: 'self_only',
          exportable: false,
          sortOrder: 6,
        },
        {
          fieldCode: 'confirm',
          typeCode: 'confirmation',
          label: '确认',
          required: true,
          visibilityCode: 'self_only',
          exportable: false,
          sortOrder: 7,
        },
      ],
    });

    expect(result.definition.fields.map((field) => field.fieldCode)).toEqual([
      'long',
      'short',
      'multi',
      'number',
      'date',
      'single',
      'file',
      'confirm',
    ]);
    expect(result.definition.fields[2]?.options).toEqual([
      { value: 'second', label: '第二项' },
      { value: 'first', label: '第一项' },
    ]);
    expect(result.schemaHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rejects irrelevant constraints instead of silently accepting them', () => {
    for (const bad of [
      field({ typeCode: 'short_text', minValue: 1 }),
      field({ typeCode: 'long_text', options: [{ value: 'x', label: 'x' }] }),
      field({ typeCode: 'number', minLength: 1 }),
      field({ typeCode: 'date', maxLength: 10 }),
      field({ typeCode: 'single_choice' }),
      field({ typeCode: 'multi_choice', options: [{ value: 'x', label: 'x' }], minLength: 1 }),
      field({ typeCode: 'file', maxSelections: 1 }),
      field({ typeCode: 'confirmation', options: [{ value: 'yes', label: '是' }] }),
    ]) {
      expectBad({ fields: [bad] });
    }
  });

  it('rejects empty/ambiguous definitions, invalid ranges, and unordered choice aliases', () => {
    expectBad({ fields: [] });
    expectBad({
      fields: [field({ fieldCode: 'same' }), field({ fieldCode: 'same', sortOrder: 1 })],
    });
    expectBad({ fields: [field({ minLength: 9, maxLength: 1 })] });
    expectBad({ fields: [field({ typeCode: 'number', minValue: 9, maxValue: 1 })] });
    expectBad({ fields: [field({ sortOrder: -1 })] });
    expectBad({
      fields: [
        field({
          typeCode: 'number',
          minValue: '999999999999.000002',
          maxValue: '999999999999.000001',
        }),
      ],
    });
    expectBad({ fields: [field({ typeCode: 'number', minValue: '0.0000001' })] });
    expectBad({ fields: [field({ typeCode: 'number', maxValue: '1000000000000' })] });
    expectBad({
      fields: [
        field({
          typeCode: 'single_choice',
          options: [
            { value: 'same', label: '甲' },
            { value: 'same', label: '乙' },
          ],
        }),
      ],
    });
  });

  it('hashes only canonical content: field order normalizes while option order remains semantic', () => {
    const one = canonicalizeRegistrationFormDefinition({
      fields: [
        field({ fieldCode: 'b', sortOrder: 2, label: 'B' }),
        field({ fieldCode: 'a', sortOrder: 1, label: 'A' }),
      ],
    });
    const same = canonicalizeRegistrationFormDefinition({
      fields: [
        field({ fieldCode: 'a', sortOrder: 1, label: 'A' }),
        field({ fieldCode: 'b', sortOrder: 2, label: 'B' }),
      ],
    });
    const choicesA = canonicalizeRegistrationFormDefinition({
      fields: [
        field({
          typeCode: 'single_choice',
          options: [
            { value: 'a', label: '甲' },
            { value: 'b', label: '乙' },
          ],
        }),
      ],
    });
    const choicesB = canonicalizeRegistrationFormDefinition({
      fields: [
        field({
          typeCode: 'single_choice',
          options: [
            { value: 'b', label: '乙' },
            { value: 'a', label: '甲' },
          ],
        }),
      ],
    });

    expect(one.schemaHash).toBe(same.schemaHash);
    expect(choicesA.schemaHash).not.toBe(choicesB.schemaHash);
  });

  it('keeps the exact pre-B3 canonical JSON and hash when all persisted governance columns are null', () => {
    const result = registrationFormDefinitionFromStoredFields([
      {
        fieldCode: 'legacy',
        typeCode: 'short_text',
        label: '旧题',
        helpText: null,
        required: false,
        visibilityCode: 'self_only',
        exportable: false,
        sortOrder: 0,
        minValue: null,
        maxValue: null,
        minLength: null,
        maxLength: null,
        maxSelections: null,
        optionsJson: null,
        purposeCode: null,
        dataClassCode: null,
        retentionPolicyCode: null,
        maskingPolicyCode: null,
        prefillSourceCode: null,
      },
    ]);

    expect(result.mode).toBe('legacy');
    expect(result.canonicalJson).toBe(
      '{"fields":[{"exportable":false,"fieldCode":"legacy","helpText":null,"label":"旧题","maxLength":null,"maxSelections":null,"maxValue":null,"minLength":null,"minValue":null,"options":null,"required":false,"sortOrder":0,"typeCode":"short_text","visibilityCode":"self_only"}]}',
    );
    expect(result.schemaHash).toBe(
      '7c898080723cca2ef3db0fe2f7ad8a42908d0135f7cc2275696347f8d6395950',
    );
    expect(result.definition.fields[0]).not.toHaveProperty('governance');
  });

  it('makes governance definition-level all-or-none and strips it from public projections', () => {
    const governance = {
      purposeCode: 'transport_logistics' as const,
      dataClassCode: 'ordinary' as const,
      retentionPolicyCode: 'activity_lifecycle' as const,
      maskingPolicyCode: 'none' as const,
      prefillSourceCode: null,
    };
    const governed = canonicalizeRegistrationFormDefinition({
      fields: [field({ governance })],
    });

    expect(governed.mode).toBe('governed');
    expect(governed.definition.fields[0]?.governance).toEqual(governance);
    expect(registrationFormPublicDefinition(governed.definition).fields[0]).not.toHaveProperty(
      'governance',
    );
    expectBad({ fields: [field(), field({ fieldCode: 'governed', sortOrder: 1, governance })] });
    expectBad({
      fields: [
        field({
          governance: {
            purposeCode: 'transport_logistics',
            dataClassCode: 'ordinary',
            retentionPolicyCode: 'activity_lifecycle',
            maskingPolicyCode: 'none',
          } as never,
        }),
      ],
    });
  });

  it('keeps sensitive in the canonical grammar but rejects it from all B3 writers', () => {
    const sensitive = {
      purposeCode: 'dietary_accommodation' as const,
      dataClassCode: 'sensitive' as const,
      retentionPolicyCode: 'activity_lifecycle' as const,
      maskingPolicyCode: 'none' as const,
      prefillSourceCode: null,
    };
    expect(
      canonicalizeRegistrationFormDefinition({ fields: [field({ governance: sensitive })] }).mode,
    ).toBe('governed');
    expect(() =>
      canonicalizeRegistrationFormDefinitionForB3({ fields: [field({ governance: sensitive })] }),
    ).toThrow(BizException);
    expect(() =>
      canonicalizeRegistrationFormDefinitionForB3({
        fields: [
          field({ governance: { ...sensitive, dataClassCode: 'ordinary' }, exportable: true }),
        ],
      }),
    ).toThrow(BizException);
  });
});
