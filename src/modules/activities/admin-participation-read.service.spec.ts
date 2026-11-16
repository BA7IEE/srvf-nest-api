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
  const review = jest.fn().mockResolvedValue({
    version: { id: 'version' },
    contributionProof: { evaluations: [{ participationIdentityId: 'private-person' }] },
  });
  const log = jest.fn().mockResolvedValue(undefined);
  const recorder = new ParticipationReadAuditRecorder({ log } as never);
  return {
    read,
    review,
    log,
    service: new AdminParticipationReadService(
      { listForAdminMember: read, listForAdminActivity: read } as never,
      { forAdminMember: read } as never,
      recorder,
      { reviewDetail: review } as never,
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

describe('settlement review detail', () => {
  it('waits for audit and records only the returned version anchor, never proof contents', async () => {
    const { service, review, log } = harness();
    let enterAudit!: () => void;
    let finishAudit!: () => void;
    const entered = new Promise<void>((resolve) => {
      enterAudit = resolve;
    });
    const auditing = new Promise<void>((resolve) => {
      finishAudit = resolve;
    });
    log.mockImplementation(async () => {
      enterAudit();
      await auditing;
    });
    let returned = false;
    const pending = service.reviewDetail('requested-version', user, meta).then((detail) => {
      returned = true;
      return detail;
    });
    await entered;
    expect(returned).toBe(false);
    expect(review).toHaveBeenCalledWith('requested-version', user);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith({
      event: 'attendance-sheet.read.other',
      actorUserId: user.id,
      actorRoleSnap: user.role,
      resourceType: 'attendance_settlement_version',
      resourceId: 'version',
      meta,
      extra: { operation: 'settlement-review-detail', count: 1, filterFields: [] },
    });
    finishAudit();
    await expect(pending).resolves.toEqual({
      version: { id: 'version' },
      contributionProof: { evaluations: [{ participationIdentityId: 'private-person' }] },
    });
  });

  it('does not return the queried proof if audit fails', async () => {
    const { service, review, log } = harness();
    const error = new Error('review audit failed');
    log.mockRejectedValueOnce(error);
    await expect(service.reviewDetail('version', user, meta)).rejects.toBe(error);
    expect(review).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('does not audit a denied, missing or unavailable version read', async () => {
    const { service, review, log } = harness();
    const error = new Error('version query rejected');
    review.mockRejectedValueOnce(error);
    await expect(service.reviewDetail('version', user, meta)).rejects.toBe(error);
    expect(log).not.toHaveBeenCalled();
  });
});
