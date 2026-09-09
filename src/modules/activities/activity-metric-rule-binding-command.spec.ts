import { fingerprintActivityMetricDefinition } from './activity-metric-definition';
import { resolveActivityMetricRuleBinding } from './activity-metric-rule';
import {
  metricRuleBindingRequestHash,
  parseMetricRuleBindingCommand,
  parseMetricRuleBindingReceipt,
} from './activity-metric-rule-binding-command';

describe('C3-1 independent binding command', () => {
  const definition = {
    schemaVersion: 1,
    code: 'people',
    version: 1,
    name: '人数',
    configuration: { kindCode: 'non_negative_integer', unit: '人', minimum: 0, maximum: 2000 },
  };
  const definitionHash = fingerprintActivityMetricDefinition(definition).definitionHash;
  const request = {
    schemaVersion: 1,
    operationKey: 'key',
    metricDefinitionId: 'definition',
    definitionHash,
    ruleCode: 'actual_participant_count_v1',
    evaluatorVersion: 1,
  };
  const binding = resolveActivityMetricRuleBinding(
    'definition',
    definition,
    definitionHash,
    request.ruleCode,
    1,
  );
  const receipt = {
    schemaVersion: 1,
    bindingId: 'binding',
    bindingHash: binding.bindingHash,
    metricDefinitionId: 'definition',
    definitionHash,
    ruleCode: binding.ruleCode,
    evaluatorVersion: 1,
    unitCode: 'count',
    scale: 0,
    createdAt: '2025-01-01T00:00:00.000Z',
  };
  it('hashes all business fields but not the operation key', () => {
    expect(parseMetricRuleBindingCommand(request)).toEqual(request);
    const hash = metricRuleBindingRequestHash(request);
    expect(metricRuleBindingRequestHash({ ...request, operationKey: 'other' })).toBe(hash);
    expect(metricRuleBindingRequestHash({ ...request, definitionHash: 'b'.repeat(64) })).not.toBe(
      hash,
    );
    expect(metricRuleBindingRequestHash({ ...request, metricDefinitionId: 'other' })).not.toBe(
      hash,
    );
    expect(
      metricRuleBindingRequestHash({ ...request, ruleCode: 'actual_participation_hours_v1' }),
    ).not.toBe(hash);
  });
  it.each([
    { schemaVersion: 2 },
    { evaluatorVersion: 2 },
    { ruleCode: 'user_script' },
    { scale: 2 },
    { unitCode: 'count' },
    { definitionHash: 'invalid' },
  ])('rejects unknown or client-derived fields: %j', (change) => {
    expect(() => parseMetricRuleBindingCommand({ ...request, ...change })).toThrow(TypeError);
  });
  it('rejects a getter without executing it', () => {
    const input = { ...request };
    const getter = jest.fn(() => 'actual_participant_count_v1');
    Object.defineProperty(input, 'ruleCode', { enumerable: true, get: getter });
    expect(() => parseMetricRuleBindingCommand(input)).toThrow(TypeError);
    expect(getter).not.toHaveBeenCalled();
  });
  it('preserves the original binding creation timestamp on replay', () => {
    expect(parseMetricRuleBindingReceipt(receipt, 'binding')).toEqual(receipt);
  });
  it.each([
    { bindingId: 'other' },
    { bindingHash: '0'.repeat(64) },
    { definitionHash: 'b'.repeat(64) },
    { unitCode: 'hours' },
    { scale: 1 },
    { createdAt: 'invalid' },
    { rawSources: [] },
  ])('rejects corrupted binding receipts: %j', (change) => {
    expect(() => parseMetricRuleBindingReceipt({ ...receipt, ...change }, 'binding')).toThrow(
      TypeError,
    );
  });
});
