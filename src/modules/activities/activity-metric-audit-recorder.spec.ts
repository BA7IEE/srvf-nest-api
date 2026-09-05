import { Test } from '@nestjs/testing';
import { PrismaClient, Role, UserStatus } from '@prisma/client';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { ActivityMetricAuditRecorder } from './activity-metric-audit-recorder';
describe('metric audit whitelist', () => {
  it.each(['definition', 'set'] as const)(
    'logs %s command with caller transaction and safe summary only',
    async (kind) => {
      const log = jest.fn().mockResolvedValue(undefined);
      const module = await Test.createTestingModule({
        providers: [ActivityMetricAuditRecorder, { provide: AuditLogsService, useValue: { log } }],
      }).compile();
      const tx = new PrismaClient();
      const result = {
        id: 'metric_id',
        code: 'one',
        version: 1,
        schemaVersion: 1 as const,
        statusCode: 'draft' as const,
        definitionHash: 'a'.repeat(64),
      };
      try {
        await module.get(ActivityMetricAuditRecorder).log({
          tx,
          actor: {
            id: 'user_one',
            username: 'test',
            role: Role.USER,
            status: UserStatus.ACTIVE,
            memberId: null,
          },
          meta: { requestId: 'request', ip: null, ua: null },
          operation: `create_${kind}`,
          result,
          before: null,
        });
        expect(log).toHaveBeenCalledWith({
          event: `activity.metric-${kind}.command`,
          actorUserId: 'user_one',
          actorRoleSnap: Role.USER,
          resourceType: `activity-metric-${kind}`,
          resourceId: result.id,
          tx,
          meta: { requestId: 'request', ip: null, ua: null },
          extra: {
            operation: `create_${kind}`,
            code: 'one',
            version: 1,
            beforeHash: null,
            beforeStatus: null,
            afterHash: result.definitionHash,
            afterStatus: 'draft',
          },
        });
      } finally {
        await tx.$disconnect();
        await module.close();
      }
    },
  );
});
