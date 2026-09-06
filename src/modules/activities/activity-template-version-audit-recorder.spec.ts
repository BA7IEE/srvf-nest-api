import { Role, type Prisma } from '@prisma/client';
import type { AuditLogsService } from '../audit-logs/audit-logs.service';
import { ActivityTemplateVersionAuditRecorder } from './activity-template-version-audit-recorder';

const actor = {
  id: 'actor',
  username: 'actor',
  role: Role.ADMIN,
  status: 'ACTIVE',
  memberId: null,
} as const;
const meta = { requestId: 'template-audit', ip: null, ua: null };
const tx = {} as Prisma.TransactionClient;
const result = {
  id: 'template',
  code: 'training',
  version: 7,
  schemaVersion: 3,
  statusCode: 'draft',
  definitionHash: 'a'.repeat(64),
} as const;
function setup() {
  const log = jest
    .fn<ReturnType<AuditLogsService['log']>, Parameters<AuditLogsService['log']>>()
    .mockResolvedValue(undefined);
  return {
    log,
    recorder: new ActivityTemplateVersionAuditRecorder({ log } as unknown as AuditLogsService),
  };
}
describe('C1 D2b minimal template audit', () => {
  it.each([
    ['create_template_version', 'draft', null],
    ['update_template_version', 'draft', { statusCode: 'draft', definitionHash: 'b'.repeat(64) }],
    [
      'activate_template_version',
      'active',
      { statusCode: 'draft', definitionHash: 'a'.repeat(64) },
    ],
    [
      'retire_template_version',
      'retired',
      { statusCode: 'active', definitionHash: 'a'.repeat(64) },
    ],
  ] as const)(
    '%s emits exactly its seven-field projection and exact tx',
    async (operation, statusCode, before) => {
      const { log, recorder } = setup();
      const expanded = {
        ...result,
        statusCode,
        operationKey: 'not-an-audit-field',
        definition: { name: 'not-an-audit-field' },
      };
      await recorder.log(tx, actor, meta, operation, expanded, before);
      expect(log).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenCalledWith({
        event: 'activity.template-version.command',
        actorUserId: actor.id,
        actorRoleSnap: actor.role,
        resourceType: 'activity-template-version',
        resourceId: result.id,
        tx,
        meta,
        extra: {
          operation,
          source: 'admin',
          beforeStatus: before?.statusCode ?? null,
          beforeHash: before?.definitionHash ?? null,
          afterStatus: statusCode,
          afterHash: result.definitionHash,
          version: 7,
        },
      });
    },
  );
  it('propagates an audit failure rather than swallowing it or writing outside the transaction', async () => {
    const { log, recorder } = setup();
    const failure = new Error('synthetic audit rejection');
    log.mockRejectedValueOnce(failure);
    await expect(
      recorder.log(tx, actor, meta, 'create_template_version', result, null),
    ).rejects.toBe(failure);
    expect(log).toHaveBeenCalledTimes(1);
  });
});
