import {
  fingerprintMetricEnvelope,
  metricInteger,
  metricObject,
  metricText,
} from './activity-metric-definition';
import {
  assertMetricResultBudget,
  boundedMetricCommandEnvelope,
  candidateCreationTime,
  candidateHash,
} from './activity-metric-candidate-command';
import { ActivityMetricRuleCode, getActivityMetricRule } from './activity-metric-rule';

export interface MetricRuleBindingCommandInput {
  schemaVersion: 1;
  operationKey: string;
  metricDefinitionId: string;
  definitionHash: string;
  ruleCode: ActivityMetricRuleCode;
  evaluatorVersion: number;
}

export interface MetricRuleBindingCommandResult {
  schemaVersion: 1;
  bindingId: string;
  bindingHash: string;
  metricDefinitionId: string;
  definitionHash: string;
  ruleCode: ActivityMetricRuleCode;
  evaluatorVersion: number;
  unitCode: 'count' | 'hours';
  scale: number;
  createdAt: string;
}

export function parseMetricRuleBindingCommand(input: unknown): MetricRuleBindingCommandInput {
  const v = metricObject(input, [
    'schemaVersion',
    'operationKey',
    'metricDefinitionId',
    'definitionHash',
    'ruleCode',
    'evaluatorVersion',
  ]);
  if (v.schemaVersion !== 1) throw new TypeError('unsupported binding command schema');
  const rule = getActivityMetricRule(v.ruleCode, v.evaluatorVersion);
  return {
    schemaVersion: 1,
    operationKey: metricText(v.operationKey, 128),
    metricDefinitionId: metricText(v.metricDefinitionId, 64),
    definitionHash: candidateHash(v.definitionHash),
    ruleCode: rule.ruleCode,
    evaluatorVersion: rule.evaluatorVersion,
  };
}

export function metricRuleBindingRequestHash(input: unknown): string {
  const command = parseMetricRuleBindingCommand(input);
  return boundedMetricCommandEnvelope('activity-metric-rule-binding-command-v1', {
    schemaVersion: command.schemaVersion,
    metricDefinitionId: command.metricDefinitionId,
    definitionHash: command.definitionHash,
    ruleCode: command.ruleCode,
    evaluatorVersion: command.evaluatorVersion,
  }).definitionHash;
}

export function parseMetricRuleBindingReceipt(
  input: unknown,
  bindingId: string,
): MetricRuleBindingCommandResult {
  const v = metricObject(input, [
    'schemaVersion',
    'bindingId',
    'bindingHash',
    'metricDefinitionId',
    'definitionHash',
    'ruleCode',
    'evaluatorVersion',
    'unitCode',
    'scale',
    'createdAt',
  ]);
  const rule = getActivityMetricRule(v.ruleCode, v.evaluatorVersion);
  const scale = metricInteger(v.scale, 0, 6);
  const unitCode = rule.ruleCode === 'actual_participant_count_v1' ? 'count' : 'hours';
  if (
    v.schemaVersion !== 1 ||
    v.bindingId !== bindingId ||
    v.unitCode !== unitCode ||
    (unitCode === 'count' && scale !== 0)
  )
    throw new TypeError('invalid binding receipt anchors');
  const result: MetricRuleBindingCommandResult = {
    schemaVersion: 1,
    bindingId: metricText(v.bindingId, 64),
    bindingHash: candidateHash(v.bindingHash),
    metricDefinitionId: metricText(v.metricDefinitionId, 64),
    definitionHash: candidateHash(v.definitionHash),
    ruleCode: rule.ruleCode,
    evaluatorVersion: rule.evaluatorVersion,
    unitCode,
    scale,
    createdAt: candidateCreationTime(v.createdAt),
  };
  const expectedHash = fingerprintMetricEnvelope('activity-metric-rule-binding-v1', {
    schemaVersion: 1,
    metricDefinitionId: result.metricDefinitionId,
    definitionHash: result.definitionHash,
    ...rule,
    unitCode,
    scale,
  }).definitionHash;
  if (expectedHash !== result.bindingHash) throw new TypeError('invalid binding receipt hash');
  assertMetricResultBudget(result);
  return result;
}
