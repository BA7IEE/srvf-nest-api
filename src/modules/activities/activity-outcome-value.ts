import {
  fingerprintMetricEnvelope,
  fingerprintParsedMetricMetadata,
  metricInteger,
  metricText,
  parseActivityMetricDefinition,
} from './activity-metric-definition';

/** Pure data validation only; accepting a shape does not authorize collection or persistence. */
export function fingerprintActivityOutcomeValue(
  definitionInput: unknown,
  expectedDefinitionHash: string,
  input: unknown,
): { valueJson: string | number | boolean; canonicalText: string; valueHash: string } {
  const definition = parseActivityMetricDefinition(definitionInput);
  const { definitionHash } = fingerprintParsedMetricMetadata(definition);
  if (definitionHash !== expectedDefinitionHash)
    throw new TypeError('metric definition hash mismatch');
  const config = definition.configuration;
  let valueJson: string | number | boolean;
  switch (config.kindCode) {
    case 'non_negative_integer':
      valueJson = metricInteger(input, config.minimum, config.maximum);
      if (Object.is(valueJson, -0)) throw new TypeError('negative zero is not canonical');
      break;
    case 'non_negative_decimal': {
      if (typeof input !== 'string' || input.length > 20)
        throw new TypeError('decimal value must be a bounded string');
      if (!/^(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$/.test(input))
        throw new TypeError('decimal value is not canonical');
      const [integer, fraction = ''] = input.split('.');
      if (integer.length > 18 - config.scale || fraction.length > config.scale)
        throw new TypeError('decimal value exceeds precision');
      const scaled = (value: string): bigint => {
        const [whole, part = ''] = value.split('.');
        return BigInt(whole + part.padEnd(config.scale, '0'));
      };
      const value = scaled(input);
      if (value < scaled(config.minimum) || value > scaled(config.maximum))
        throw new TypeError('decimal value is out of bounds');
      valueJson = input;
      break;
    }
    case 'boolean':
      if (typeof input !== 'boolean') throw new TypeError('boolean value required');
      valueJson = input;
      break;
    case 'short_text':
      valueJson = metricText(input, config.maxLength);
      break;
    case 'single_choice':
      if (typeof input !== 'string' || !config.options.some((option) => option.code === input))
        throw new TypeError('unknown metric choice');
      valueJson = input;
      break;
  }
  const fingerprint = fingerprintMetricEnvelope('activity-outcome-value-v1', {
    definitionHash,
    value: valueJson,
  });
  return {
    valueJson,
    canonicalText: fingerprint.canonicalText,
    valueHash: fingerprint.definitionHash,
  };
}
