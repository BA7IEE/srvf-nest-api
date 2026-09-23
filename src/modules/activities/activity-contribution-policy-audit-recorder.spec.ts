import { Test } from '@nestjs/testing';
import { Role, UserStatus } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { ActivityContributionPolicyAuditRecorder } from './activity-contribution-policy-audit-recorder';
import { parseContributionPolicyReceipt } from './activity-contribution-policy-command';

it('E1-2 audit uses the caller transaction and closed event-specific resources', async () => {
  const log = jest.fn().mockResolvedValue(undefined);
  const m = await Test.createTestingModule({
    providers: [
      ActivityContributionPolicyAuditRecorder,
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
  const result = parseContributionPolicyReceipt({
    schemaVersion: 1,
    operationCode: 'create_policy',
    policyId: 'policy',
    versionId: null,
    definitionHash: null,
    evaluatorVersion: null,
    resultStatusCode: null,
    createdAt: '2026-01-01T00:00:00.000Z',
  });
  await m
    .get(PrismaService)
    .$transaction((tx) =>
      m
        .get(ActivityContributionPolicyAuditRecorder)
        .log(tx, actor, { requestId: 'request', ip: null, ua: null }, result, null),
    );
  expect(log).toHaveBeenCalledWith({
    event: 'activity.contribution-policy.command',
    resourceType: 'contribution-policy',
    resourceId: 'policy',
    actorUserId: 'actor',
    actorRoleSnap: Role.USER,
    tx: { marker: 'tx' },
    meta: { requestId: 'request', ip: null, ua: null },
    extra: {
      operationCode: 'create_policy',
      policyId: 'policy',
      versionId: null,
      definitionHash: null,
      evaluatorVersion: null,
      beforeStatusCode: null,
      resultStatusCode: null,
    },
  });

  const versionResult = parseContributionPolicyReceipt({
    schemaVersion: 1,
    operationCode: 'activate_version',
    policyId: 'policy',
    versionId: 'version',
    definitionHash: 'a'.repeat(64),
    evaluatorVersion: 1,
    resultStatusCode: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
  });
  await m.get(PrismaService).$transaction((tx) =>
    m
      .get(ActivityContributionPolicyAuditRecorder)
      .log(tx, actor, { requestId: 'request', ip: null, ua: null }, versionResult, {
        definitionHash: 'a'.repeat(64),
        statusCode: 'draft',
      }),
  );
  expect(log).toHaveBeenLastCalledWith({
    event: 'activity.contribution-policy-version.command',
    resourceType: 'contribution-policy-version',
    resourceId: 'version',
    actorUserId: 'actor',
    actorRoleSnap: Role.USER,
    tx: { marker: 'tx' },
    meta: { requestId: 'request', ip: null, ua: null },
    extra: {
      operationCode: 'activate_version',
      policyId: 'policy',
      versionId: 'version',
      definitionHash: 'a'.repeat(64),
      evaluatorVersion: 1,
      beforeStatusCode: 'draft',
      resultStatusCode: 'active',
    },
  });
});
