import { metricRequestHash, parseMetricReceipt } from './activity-metric-command';
const receipt = {
  id: 'metric_id',
  code: 'count',
  version: 1,
  schemaVersion: 1,
  statusCode: 'draft',
  definitionHash: 'a'.repeat(64),
};
describe('metric command identity and receipt whitelist', () => {
  it('includes operation, target and canonical input in identity', () => {
    const base = metricRequestHash('update_definition', 'id_one', '{}');
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(base).toBe(metricRequestHash('update_definition', 'id_one', '{}'));
    expect(base).not.toBe(metricRequestHash('update_definition', 'id_two', '{}'));
    expect(base).not.toBe(metricRequestHash('retire_definition', 'id_one', '{}'));
    expect(base).not.toBe(metricRequestHash('update_definition', 'id_one', '{"name":"new"}'));
  });
  it('only returns stable six-field receipt', () => {
    expect(parseMetricReceipt(receipt)).toEqual(receipt);
  });
  it.each([
    null,
    [],
    {},
    { ...receipt, operationKey: 'private' },
    { ...receipt, version: 0 },
    { ...receipt, version: 2147483648 },
    { ...receipt, schemaVersion: 2 },
    { ...receipt, statusCode: 'unknown' },
    { ...receipt, definitionHash: 'A'.repeat(64) },
    { ...receipt, id: null },
  ])('rejects malformed receipt %#', (value) => {
    expect(() => parseMetricReceipt(value)).toThrow('指标命令收据校验失败');
  });
});
