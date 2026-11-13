import { Role } from '@prisma/client';
import { AppManagedActivitiesService } from './app-managed-activities.service';
import { AppManagedActivitiesController } from './controllers/app-managed-activities.controller';

describe('managed write responses do not add a settlement read dependency', () => {
  const user = { id: 'user-1', memberId: 'member-1', role: Role.USER };
  const meta = { requestId: 'request-1', ip: null, ua: null };

  function serviceFixture() {
    const activities = {
      create: jest.fn().mockResolvedValue({ id: 'activity-1' }),
      update: jest.fn().mockResolvedValue(undefined),
    };
    const reviews = { compatibilityPublish: jest.fn().mockResolvedValue(undefined) };
    const workflow = {
      detail: jest.fn().mockResolvedValue({ settlement: { availability: 'not-requested' } }),
    };
    const service = new AppManagedActivitiesService(
      undefined as never,
      undefined as never,
      activities as never,
      undefined as never,
      undefined as never,
      reviews as never,
      undefined as never,
      workflow as never,
      undefined as never,
      { activityResponsibilityWorkflow: { enabled: true } } as never,
    );
    return { service, activities, reviews, workflow };
  }

  it('creates before returning a base detail without requesting settlement', async () => {
    const f = serviceFixture();
    await f.service.create({ allocationModeCode: 'first_come' } as never, user as never, meta);
    expect(f.activities.create).toHaveBeenCalledTimes(1);
    expect(f.workflow.detail).toHaveBeenCalledWith('activity-1', 'member-1', user, false);
    expect(f.activities.create.mock.invocationCallOrder[0]).toBeLessThan(
      f.workflow.detail.mock.invocationCallOrder[0],
    );
  });

  it('updates before returning a base detail without requesting settlement', async () => {
    const f = serviceFixture();
    await f.service.update('activity-1', {}, user as never, meta);
    expect(f.activities.update).toHaveBeenCalledTimes(1);
    expect(f.workflow.detail).toHaveBeenCalledWith('activity-1', 'member-1', user, false);
    expect(f.activities.update.mock.invocationCallOrder[0]).toBeLessThan(
      f.workflow.detail.mock.invocationCallOrder[0],
    );
  });

  it('keeps direct-publish response independent of the settlement read', async () => {
    const f = serviceFixture();
    await f.service.directPublish('activity-1', user as never, meta);
    expect(f.reviews.compatibilityPublish).toHaveBeenCalledTimes(1);
    expect(f.workflow.detail).toHaveBeenCalledWith('activity-1', 'member-1', user, false);
    expect(f.reviews.compatibilityPublish.mock.invocationCallOrder[0]).toBeLessThan(
      f.workflow.detail.mock.invocationCallOrder[0],
    );
  });

  it.each(['cover', 'gallery'] as const)('returns a base detail after writing %s', async (kind) => {
    const identity = {
      resolve: jest.fn().mockResolvedValue({ canUseApp: true, member: { id: 'member-1' } }),
    };
    const service = {
      detail: jest.fn().mockResolvedValue({ settlement: { availability: 'not-requested' } }),
    };
    const covers = {
      setCoverManaged: jest.fn().mockResolvedValue(undefined),
      setGalleryManaged: jest.fn().mockResolvedValue(undefined),
    };
    const controller = new AppManagedActivitiesController(
      identity as never,
      service as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      covers as never,
      undefined as never,
      undefined as never,
    );
    const request = { id: 'request-1', ip: null, headers: {} };
    if (kind === 'cover') {
      await controller.setCover(
        user as never,
        { activityId: 'activity-1' },
        { attachmentId: null },
        request as never,
      );
    } else {
      await controller.setGallery(
        user as never,
        { activityId: 'activity-1' },
        { attachmentIds: [] },
        request as never,
      );
    }
    const write = kind === 'cover' ? covers.setCoverManaged : covers.setGalleryManaged;
    expect(write).toHaveBeenCalledTimes(1);
    expect(service.detail).toHaveBeenCalledWith('activity-1', 'member-1', user, false);
    expect(write.mock.invocationCallOrder[0]).toBeLessThan(
      service.detail.mock.invocationCallOrder[0],
    );
  });
});
