import { Role, type Prisma } from '@prisma/client';
import type { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { ActivityMetricSelectionResult } from './activity-metric-selection';
import { ActivityMetricSelectionAuditRecorder } from './activity-metric-selection-audit-recorder';

const actor = {
  id: 'actor',
  username: 'actor',
  role: Role.ADMIN,
  status: 'ACTIVE',
  memberId: null,
} as const;
const meta = { requestId: 'selection-audit', ip: null, ua: null };
const tx = {} as Prisma.TransactionClient;
const result: ActivityMetricSelectionResult = {
  activityId: 'activity',
  metricRequirementCode: 'required',
  metricSelectionRevision: 2,
  metricSetPointer: {
    id: 'set',
    code: 'training',
    version: 1,
    schemaVersion: 1,
    definitionHash: 'a'.repeat(64),
  },
};
function setup() {
  const log = jest
    .fn<ReturnType<AuditLogsService['log']>, Parameters<AuditLogsService['log']>>()
    .mockResolvedValue(undefined);
  return {
    log,
    recorder: new ActivityMetricSelectionAuditRecorder({ log } as unknown as AuditLogsService),
  };
}
describe('C1 D2b minimal selection audit', () => {
  it.each(['admin', 'app', 'template', 'professional', 'emergency', 'series', 'clone'] as const)(
    '%s records only the fixed eight-field fact projection in the caller transaction',
    async (source) => {
      const { log, recorder } = setup();
      const expanded = {
        ...result,
        operationKey: 'not-an-audit-field',
        definition: { name: 'not-an-audit-field' },
      };
      await recorder.log(tx, actor, meta, source, expanded, {
        metricRequirementCode: 'not_required',
        selectedMetricSetVersionId: null,
        selectedMetricSetDefinitionHash: null,
        metricSelectionRevision: 1,
      });
      expect(log).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenCalledWith({
        event: 'activity.metric-selection.command',
        actorUserId: actor.id,
        actorRoleSnap: actor.role,
        resourceType: 'activity',
        resourceId: result.activityId,
        tx,
        meta,
        extra: {
          operation: 'select_metric_set',
          source,
          beforeMode: 'not_required',
          beforeRevision: 1,
          beforeHash: null,
          afterMode: 'required',
          afterRevision: 2,
          afterHash: 'a'.repeat(64),
        },
      });
    },
  );
  it('initial selection explicitly records the unconfigured before state', async () => {
    const { log, recorder } = setup();
    await recorder.log(
      tx,
      actor,
      meta,
      'professional',
      {
        activityId: 'activity',
        metricRequirementCode: 'not_required',
        metricSetPointer: null,
        metricSelectionRevision: 1,
      },
      null,
    );
    expect(log.mock.calls[0][0].extra).toEqual({
      operation: 'select_metric_set',
      source: 'professional',
      beforeMode: null,
      beforeRevision: 0,
      beforeHash: null,
      afterMode: 'not_required',
      afterRevision: 1,
      afterHash: null,
    });
  });
  it('retains the old selection hash when explicitly changing to not_required', async () => {
    const { log, recorder } = setup();
    await recorder.log(
      tx,
      actor,
      meta,
      'admin',
      {
        activityId: 'activity',
        metricRequirementCode: 'not_required',
        metricSetPointer: null,
        metricSelectionRevision: 3,
      },
      {
        metricRequirementCode: 'required',
        selectedMetricSetVersionId: 'set',
        selectedMetricSetDefinitionHash: 'a'.repeat(64),
        metricSelectionRevision: 2,
      },
    );
    expect(log.mock.calls[0][0].extra).toEqual({
      operation: 'select_metric_set',
      source: 'admin',
      beforeMode: 'required',
      beforeRevision: 2,
      beforeHash: 'a'.repeat(64),
      afterMode: 'not_required',
      afterRevision: 3,
      afterHash: null,
    });
  });
  it('propagates an audit rejection unchanged to the root transaction owner', async () => {
    const { log, recorder } = setup();
    const failure = new Error('synthetic audit rejection');
    log.mockRejectedValueOnce(failure);
    await expect(recorder.log(tx, actor, meta, 'app', result, null)).rejects.toBe(failure);
  });
});
