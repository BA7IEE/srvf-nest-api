import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { parseTemplateVersionReceipt } from './activity-template-version-command';

const receipt = {
  id: 'template-version',
  code: 'training',
  version: 1,
  schemaVersion: 3,
  statusCode: 'draft',
  definitionHash: 'a'.repeat(64),
};

describe('C1 D2b exact six-field template receipts', () => {
  it.each([
    ['create_template_version', 'draft'],
    ['update_template_version', 'draft'],
    ['activate_template_version', 'active'],
    ['retire_template_version', 'retired'],
  ] as const)('%s accepts only its operation-specific status', (operation, statusCode) => {
    const input = { ...receipt, statusCode };
    expect(parseTemplateVersionReceipt(input, input.id, operation)).toEqual(input);
    for (const wrongStatus of ['draft', 'active', 'retired'].filter((s) => s !== statusCode)) {
      expect(() =>
        parseTemplateVersionReceipt({ ...input, statusCode: wrongStatus }, input.id, operation),
      ).toThrow(new BizException(BizCode.ACTIVITY_METRIC_RECEIPT_INVALID));
    }
  });
  it.each(Object.keys(receipt))(
    'missing %s cannot be defaulted during historical replay',
    (missing) => {
      const invalid = Object.fromEntries(
        Object.entries(receipt).filter(([key]) => key !== missing),
      );
      expect(() => parseTemplateVersionReceipt(invalid)).toThrow(
        new BizException(BizCode.ACTIVITY_METRIC_RECEIPT_INVALID),
      );
    },
  );
  it.each([
    null,
    [],
    'template',
    { ...receipt, id: '' },
    { ...receipt, id: 'x'.repeat(65) },
    { ...receipt, code: ' training' },
    { ...receipt, version: 0 },
    { ...receipt, version: -1 },
    { ...receipt, version: 1.5 },
    { ...receipt, version: 2147483648 },
    { ...receipt, version: '1' },
    { ...receipt, schemaVersion: 1 },
    { ...receipt, schemaVersion: 2 },
    { ...receipt, schemaVersion: '3' },
    { ...receipt, statusCode: 'disabled' },
    { ...receipt, definitionHash: 'A'.repeat(64) },
    { ...receipt, definitionHash: 'a'.repeat(63) },
    { ...receipt, operationKey: 'must-not-leak' },
    { ...receipt, definition: {} },
    { ...receipt, actorUserId: 'must-not-leak' },
  ])('rejects malformed or expanded persistent result %#', (invalid) => {
    expect(() => parseTemplateVersionReceipt(invalid)).toThrow(
      new BizException(BizCode.ACTIVITY_METRIC_RECEIPT_INVALID),
    );
  });
  it('valid result for a different target cannot be replayed', () => {
    expect(() => parseTemplateVersionReceipt(receipt, 'another-version')).toThrow(
      new BizException(BizCode.ACTIVITY_METRIC_RECEIPT_INVALID),
    );
  });
  it('keeps the maximum SQL integer version without silently rounding', () => {
    expect(parseTemplateVersionReceipt({ ...receipt, version: 2147483647 }).version).toBe(
      2147483647,
    );
  });
});
