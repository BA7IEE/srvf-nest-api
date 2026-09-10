import { Test } from '@nestjs/testing';
import { Role, UserStatus } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { ActivityTimePolicyAuditRecorder } from './activity-time-policy-audit-recorder';
import { parseTimePolicyReceipt } from './activity-time-policy-command';

it('D1-2 audit uses the caller transaction and a closed non-PII extra object', async () => {
  const log = jest.fn().mockResolvedValue(undefined);
  const m = await Test.createTestingModule({
    providers: [
      ActivityTimePolicyAuditRecorder,
      { provide: AuditLogsService, useValue: { log } },
      {
        provide: PrismaService,
        useValue: { $transaction: (fn: (tx: object) => unknown) => fn({ marker: 'tx' }) },
      },
    ],
  }).compile();
  const actor = {
    id: 'actor',
    username: 'actor',
    role: Role.USER,
    status: UserStatus.ACTIVE,
    memberId: null,
  };
  const result = parseTimePolicyReceipt({
    schemaVersion: 1,
    operationCode: 'create_policy',
    policyId: 'policy',
    versionId: null,
    definitionHash: null,
    resultStatusCode: null,
    createdAt: '2026-01-01T00:00:00.000Z',
  });
  await m
    .get(PrismaService)
    .$transaction((tx) =>
      m
        .get(ActivityTimePolicyAuditRecorder)
        .log(tx, actor, { requestId: 'request', ip: null, ua: null }, result, null),
    );
  expect(log).toHaveBeenCalledWith({
    event: 'activity.time-policy.command',
    resourceType: 'activity-time-policy',
    resourceId: 'policy',
    actorUserId: 'actor',
    actorRoleSnap: Role.USER,
    tx: { marker: 'tx' },
    meta: { requestId: 'request', ip: null, ua: null },
    extra: {
      operationCode: 'create_policy',
      versionId: null,
      beforeHash: null,
      afterHash: null,
      beforeStatus: null,
      afterStatus: null,
    },
  });
});
