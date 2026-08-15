import { createHash } from 'node:crypto';

import { RegistrationReconciliationService } from './registration-reconciliation.service';

describe('RegistrationReconciliationService activity-start job scan', () => {
  const now = new Date('2099-12-15T08:00:00.000Z');

  function createSubject(input: {
    activities: Array<{ id: string }>;
    createResults: Array<unknown | Error>;
  }) {
    const create = jest.fn();
    for (const result of input.createResults) {
      if (result instanceof Error) create.mockRejectedValueOnce(result);
      else create.mockResolvedValueOnce(result);
    }
    const prisma = {
      activity: { findMany: jest.fn().mockResolvedValue(input.activities) },
      activityBatchJob: { create },
    };
    const service = new RegistrationReconciliationService(prisma as never, {} as never, {} as never);
    return { service, prisma };
  }

  it('scans only due published activities with unresolved canonical work and writes deterministic jobs', async () => {
    const { service, prisma } = createSubject({
      activities: [{ id: 'activity-a' }, { id: 'activity-b' }],
      createResults: [{ id: 'job-a' }, { id: 'job-b' }],
    });

    await expect(service.enqueueDueActivityStartExpiryJobs(now)).resolves.toBe(2);
    expect(prisma.activity.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          statusCode: 'published',
          batchJobs: { none: { jobTypeCode: 'reconciliation' } },
          AND: [
            {
              OR: [
                {
                  participationIdentities: {
                    some: { currentStatusCode: { in: ['pending', 'waitlisted'] } },
                  },
                },
                { invitations: { some: { statusCode: 'pending' } } },
              ],
            },
          ],
        }),
        orderBy: [{ startAt: 'asc' }, { id: 'asc' }],
        take: 20,
      }),
    );
    expect(prisma.activityBatchJob.create).toHaveBeenNthCalledWith(1, {
      data: {
        jobTypeCode: 'reconciliation',
        activityId: 'activity-a',
        statusCode: 'pending',
        operationKey: 'reconciliation:activity-start-expiry:activity-a',
        requestHash: createHash('sha256')
          .update(JSON.stringify({ kind: 'activity_start_expiry', activityId: 'activity-a' }), 'utf8')
          .digest('hex'),
        payloadVersion: 1,
        payload: { kind: 'activity_start_expiry', activityId: 'activity-a' },
        availableAt: now,
      },
      select: { id: true },
    });
  });

  it('treats only the unique P2002 race as an already-created job and propagates other failures', async () => {
    const uniqueRace = Object.assign(new Error('unique'), { code: 'P2002' });
    const { service, prisma } = createSubject({
      activities: [{ id: 'activity-a' }, { id: 'activity-b' }],
      createResults: [{ id: 'job-a' }, uniqueRace],
    });
    await expect(service.enqueueDueActivityStartExpiryJobs(now)).resolves.toBe(1);
    expect(prisma.activityBatchJob.create).toHaveBeenCalledTimes(2);

    const databaseFailure = Object.assign(new Error('db unavailable'), { code: 'P1001' });
    const broken = createSubject({
      activities: [{ id: 'activity-c' }],
      createResults: [databaseFailure],
    });
    await expect(broken.service.enqueueDueActivityStartExpiryJobs(now)).rejects.toBe(databaseFailure);
  });
});
