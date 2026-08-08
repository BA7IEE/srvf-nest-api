import { Prisma } from '@prisma/client';

import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import {
  validateRegistrationFormAnswers,
  type RegistrationAnswerField,
} from './activity-registration-answer-validator';

function field(overrides: Partial<RegistrationAnswerField>): RegistrationAnswerField {
  return {
    id: `field-${overrides.fieldCode ?? 'x'}`,
    fieldCode: 'x',
    typeCode: 'short_text',
    required: false,
    minValue: null,
    maxValue: null,
    minLength: null,
    maxLength: null,
    maxSelections: null,
    optionsJson: null,
    ...overrides,
  };
}

function expectInvalid(fields: RegistrationAnswerField[], answers: unknown): void {
  expect(() => validateRegistrationFormAnswers(fields, answers)).toThrow(BizException);
  try {
    validateRegistrationFormAnswers(fields, answers);
  } catch (error) {
    expect(error).toEqual(new BizException(BizCode.REGISTRATION_FORM_ANSWER_INVALID));
  }
}

describe('validateRegistrationFormAnswers', () => {
  const allFields = [
    field({
      fieldCode: 'short',
      typeCode: 'short_text',
      required: true,
      minLength: 2,
      maxLength: 4,
    }),
    field({ fieldCode: 'long', typeCode: 'long_text', maxLength: 8 }),
    field({
      fieldCode: 'number',
      typeCode: 'number',
      minValue: new Prisma.Decimal('1.5'),
      maxValue: new Prisma.Decimal('2.5'),
    }),
    field({ fieldCode: 'date', typeCode: 'date' }),
    field({
      fieldCode: 'single',
      typeCode: 'single_choice',
      optionsJson: [{ value: 'a', label: 'A' }],
    }),
    field({
      fieldCode: 'multi',
      typeCode: 'multi_choice',
      maxSelections: 2,
      optionsJson: [
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B' },
        { value: 'c', label: 'C' },
      ],
    }),
    field({ fieldCode: 'file', typeCode: 'file' }),
    field({ fieldCode: 'confirm', typeCode: 'confirmation', required: true }),
  ];

  it('normalizes all eight supported types into the only persistence columns allowed', () => {
    const result = validateRegistrationFormAnswers(allFields, [
      { fieldCode: 'long', value: 'long' },
      { fieldCode: 'short', value: '中ab' },
      { fieldCode: 'number', value: 2 },
      { fieldCode: 'date', value: '2099-02-28' },
      { fieldCode: 'single', value: 'a' },
      { fieldCode: 'multi', value: ['b', 'a'] },
      { fieldCode: 'file', uploadSessionId: 'session-12345678' },
      { fieldCode: 'confirm', value: true },
    ]);

    expect(result.map((answer) => answer.fieldCode)).toEqual([
      'confirm',
      'date',
      'file',
      'long',
      'multi',
      'number',
      'short',
      'single',
    ]);
    expect(result.find((answer) => answer.fieldCode === 'multi')?.valueJson).toEqual(['a', 'b']);
    expect(result.find((answer) => answer.fieldCode === 'number')?.valueNumber?.toString()).toBe(
      '2',
    );
    expect(result.find((answer) => answer.fieldCode === 'file')).toMatchObject({
      uploadSessionId: 'session-12345678',
    });
  });

  it.each([
    ['required omitted', allFields, [{ fieldCode: 'confirm', value: true }]],
    ['unknown field', allFields, [{ fieldCode: 'unknown', value: 'x' }]],
    [
      'duplicate field',
      [field({ fieldCode: 'x' })],
      [
        { fieldCode: 'x', value: 'a' },
        { fieldCode: 'x', value: 'b' },
      ],
    ],
    ['short wrong type', [field({ fieldCode: 'x' })], [{ fieldCode: 'x', value: 1 }]],
    [
      'required text blank',
      [field({ fieldCode: 'x', required: true })],
      [{ fieldCode: 'x', value: '' }],
    ],
    [
      'text under min length',
      [field({ fieldCode: 'x', minLength: 2 })],
      [{ fieldCode: 'x', value: 'a' }],
    ],
    [
      'text above max length',
      [field({ fieldCode: 'x', maxLength: 1 })],
      [{ fieldCode: 'x', value: 'ab' }],
    ],
    [
      'number range',
      [field({ fieldCode: 'x', typeCode: 'number', maxValue: new Prisma.Decimal(2) })],
      [{ fieldCode: 'x', value: 3 }],
    ],
    [
      'invalid date',
      [field({ fieldCode: 'x', typeCode: 'date' })],
      [{ fieldCode: 'x', value: '2099-02-30' }],
    ],
    [
      'invalid single option',
      [field({ fieldCode: 'x', typeCode: 'single_choice', optionsJson: [{ value: 'a' }] })],
      [{ fieldCode: 'x', value: 'b' }],
    ],
    [
      'multi over select',
      [
        field({
          fieldCode: 'x',
          typeCode: 'multi_choice',
          maxSelections: 1,
          optionsJson: [{ value: 'a' }, { value: 'b' }],
        }),
      ],
      [{ fieldCode: 'x', value: ['a', 'b'] }],
    ],
    [
      'multi duplicate option',
      [field({ fieldCode: 'x', typeCode: 'multi_choice', optionsJson: [{ value: 'a' }] })],
      [{ fieldCode: 'x', value: ['a', 'a'] }],
    ],
    [
      'required multi empty',
      [
        field({
          fieldCode: 'x',
          typeCode: 'multi_choice',
          required: true,
          optionsJson: [{ value: 'a' }],
        }),
      ],
      [{ fieldCode: 'x', value: [] }],
    ],
    [
      'file receives attachment id',
      [field({ fieldCode: 'x', typeCode: 'file' })],
      [{ fieldCode: 'x', value: 'attachment-12345678' }],
    ],
    [
      'file receives both values',
      [field({ fieldCode: 'x', typeCode: 'file' })],
      [{ fieldCode: 'x', value: 'x', uploadSessionId: 'session-12345678' }],
    ],
    [
      'confirmation required false',
      [field({ fieldCode: 'x', typeCode: 'confirmation', required: true })],
      [{ fieldCode: 'x', value: false }],
    ],
    [
      'non-file includes upload session',
      [field({ fieldCode: 'x' })],
      [{ fieldCode: 'x', value: 'x', uploadSessionId: 'session-12345678' }],
    ],
  ])('%s is rejected with the fixed answer BizCode', (_name, fields, answers) => {
    expectInvalid(fields, answers);
  });
});
