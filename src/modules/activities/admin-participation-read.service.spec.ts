import { Role, UserStatus } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { AdminParticipationReadService } from './admin-participation-read.service';
import { ParticipationReadAuditRecorder } from './participation-read-audit-recorder';

const user: CurrentUserPayload = {
  id: 'reader',
  username: 'reader',
  role: Role.ADMIN,
  status: UserStatus.ACTIVE,
  memberId: null,
};
const meta = { requestId: 'participation-read-test', ip: null, ua: null };
const query = {
  page: 1,
  pageSize: 1,
  dateFrom: '2020-03-01',
  dateTo: '2020-03-02',
  unknownPrivateValue: 'never-log-query-values',
};
const result = {
  items: [{ memberId: 'private-member', entryKey: 'private-entry' }],
  total: 20,
  page: 1,
  pageSize: 1,
};

function harness() {
  const read = jest.fn().mockResolvedValue(result);
  const log = jest.fn().mockResolvedValue(undefined);
  const recorder = new ParticipationReadAuditRecorder({ log } as never);
  return {
    read,
    log,
    service: new AdminParticipationReadService(
      { listForAdminMember: read, listForAdminActivity: read } as never,
      { forAdminMember: read } as never,
      recorder,
    ),
  };
}

const cases = [
  {
    method: 'listForActivity',
    resourceType: 'activity',
    operation: 'participation-ledger',
    fields: [],
  },
  {
    method: 'listForMember',
    resourceType: 'member',
    operation: 'participation-ledger',
    fields: ['dateFrom', 'dateTo'],
  },
  {
    method: 'proofForMember',
    resourceType: 'member',
    operation: 'participation-time-proof',
    fields: ['dateFrom', 'dateTo'],
  },
] as const;

describe.each(cases)('$method', ({ method, resourceType, operation, fields }) => {
  it('does not release queried data until audit succeeds; logs only safe metadata', async () => {
    const { service, read, log } = harness();
    let enterAudit!: () => void;
    let finishAudit!: () => void;
    const entered = new Promise<void>((resolve) => {
      enterAudit = resolve;
    });
    const pendingAudit = new Promise<void>((resolve) => {
      finishAudit = resolve;
    });
    log.mockImplementation(async () => {
      enterAudit();
      await pendingAudit;
    });
    let returned = false;
    const pending = service[method]('resource', query, user, meta).then((page) => {
      returned = true;
      return page;
    });
    await entered;
    expect(returned).toBe(false);
    expect(read).toHaveBeenCalledWith('resource', query, user);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith({
      event: 'attendance-sheet.read.other',
      actorUserId: user.id,
      actorRoleSnap: Role.ADMIN,
      resourceType,
      resourceId: 'resource',
      meta,
      extra: { operation, count: 1, filterFields: fields },
    });
    finishAudit();
    await expect(pending).resolves.toBe(result);
  });

  it('fails closed when audit fails after a successful query', async () => {
    const { service, read, log } = harness();
    const error = new Error('audit unavailable');
    log.mockRejectedValueOnce(error);
    await expect(service[method]('resource', query, user, meta)).rejects.toBe(error);
    expect(read).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('never records a successful read when authorization or the business query rejects', async () => {
    const { service, read, log } = harness();
    const error = new Error('query rejected');
    read.mockRejectedValueOnce(error);
    await expect(service[method]('resource', query, user, meta)).rejects.toBe(error);
    expect(log).not.toHaveBeenCalled();
  });
});
