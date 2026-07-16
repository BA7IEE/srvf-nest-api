import type { PrismaService } from '../../database/prisma.service';
import { ActivityRegistrationWaitlistQueryService } from './activity-registration-waitlist-query.service';

describe('ActivityRegistrationWaitlistQueryService', () => {
  const registeredAt = new Date('2026-07-15T00:00:00.000Z');

  it('detail:非 waitlisted 恒 null 且零查询；waitlisted = ahead + 1', async () => {
    const prisma = {
      activityRegistration: {
        count: jest.fn<Promise<number>, [unknown]>().mockResolvedValue(2),
        findMany: jest.fn<Promise<unknown[]>, [unknown]>(),
      },
    };
    const service = new ActivityRegistrationWaitlistQueryService(
      prisma as unknown as PrismaService,
    );

    await expect(
      service.getPosition({ id: 'r0', activityId: 'a1', statusCode: 'pending', registeredAt }),
    ).resolves.toBeNull();
    expect(prisma.activityRegistration.count).not.toHaveBeenCalled();

    await expect(
      service.getPosition({
        id: 'r3',
        activityId: 'a1',
        activityPositionId: null,
        statusCode: 'waitlisted',
        registeredAt,
      }),
    ).resolves.toBe(3);
    const countArg = prisma.activityRegistration.count.mock.calls[0][0] as {
      where: Record<string, unknown>;
    };
    expect(countArg.where).toEqual({
      activityId: 'a1',
      activityPositionId: null,
      statusCode: 'waitlisted',
      deletedAt: null,
      OR: [{ registeredAt: { lt: registeredAt } }, { registeredAt, id: { lt: 'r3' } }],
    });
  });

  it('list:页面内多活动仅一次批量查询，并按 activityId + registeredAt + id 给位置', async () => {
    const prisma = {
      activityRegistration: {
        count: jest.fn<Promise<number>, [unknown]>(),
        findMany: jest
          .fn<
            Promise<Array<{ id: string; activityId: string; activityPositionId: string | null }>>,
            [unknown]
          >()
          .mockResolvedValue([
            { id: 'a1-r1', activityId: 'a1', activityPositionId: 'ap1' },
            { id: 'a1-r2', activityId: 'a1', activityPositionId: 'ap1' },
            { id: 'a1-r3', activityId: 'a1', activityPositionId: 'ap2' },
            { id: 'a2-r1', activityId: 'a2', activityPositionId: null },
          ]),
      },
    };
    const service = new ActivityRegistrationWaitlistQueryService(
      prisma as unknown as PrismaService,
    );

    const positions = await service.getPositions([
      {
        id: 'a1-r2',
        activityId: 'a1',
        activityPositionId: 'ap1',
        statusCode: 'waitlisted',
        registeredAt,
      },
      {
        id: 'a1-r3',
        activityId: 'a1',
        activityPositionId: 'ap2',
        statusCode: 'waitlisted',
        registeredAt,
      },
      {
        id: 'a2-r1',
        activityId: 'a2',
        activityPositionId: null,
        statusCode: 'waitlisted',
        registeredAt,
      },
      {
        id: 'pending',
        activityId: 'a1',
        activityPositionId: 'ap1',
        statusCode: 'pending',
        registeredAt,
      },
    ]);

    expect(prisma.activityRegistration.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.activityRegistration.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [
          { activityId: 'asc' },
          { activityPositionId: 'asc' },
          { registeredAt: 'asc' },
          { id: 'asc' },
        ],
      }),
    );
    expect(positions).toEqual(
      new Map([
        ['a1-r2', 2],
        ['a1-r3', 1],
        ['a2-r1', 1],
        ['pending', null],
      ]),
    );
  });
});
