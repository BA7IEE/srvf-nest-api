import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import {
  canonicalizeRegistrationFormDefinition,
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
});
