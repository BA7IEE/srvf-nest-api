import { Prisma } from '@prisma/client';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { mapCreationPlace } from './activity-creation-command';
import { writeCreationPlaces } from './activity-place-writer';
import type { AppActivityCreationPlaceDto } from './dto/app/app-managed-activity-creation-place.dto';

function fixture() {
  const writes: Prisma.ActivityPlaceUncheckedCreateInput[] = [];
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([{ id: 'preset-0001' }]),
    placePreset: { findUnique: jest.fn() },
    activityPlace: {
      count: jest.fn().mockResolvedValue(0),
      create: jest
        .fn()
        .mockImplementation(({ data }: { data: Prisma.ActivityPlaceUncheckedCreateInput }) => {
          writes.push(data);
          return Promise.resolve({ id: `place-${writes.length}`, ...data });
        }),
    },
    activity: { update: jest.fn() },
    activitySession: { update: jest.fn() },
  };
  return { tx, writes, client: tx as unknown as Prisma.TransactionClient };
}
const inline = (overrides: Partial<AppActivityCreationPlaceDto> = {}) =>
  mapCreationPlace({
    roleCode: 'primary',
    visibilityCode: 'staff',
    inline: { name: '集合点', addressText: '地点文字', checkInEligible: false },
    ...overrides,
  });

describe('B6 creation place snapshot writer', () => {
  it('copies each supplied preset field, not caller overrides or mutable preset references', async () => {
    const { client, tx, writes } = fixture();
    const preset = {
      id: 'preset-0001',
      name: '预设集合点',
      addressText: '预设地址',
      instruction: '沿北门进入',
      longitude: new Prisma.Decimal('120.1000000'),
      latitude: new Prisma.Decimal('30.2000000'),
      coordinateSystemCode: 'wgs84',
      providerCode: 'provider',
      providerPlaceId: 'provider-place-1',
      checkInEligible: true,
      radiusMeters: 100,
    };
    tx.placePreset.findUnique.mockResolvedValue(preset);
    const count = await writeCreationPlaces(client, {
      activityId: 'activity-1',
      sessions: [],
      places: [
        mapCreationPlace({ roleCode: 'primary', visibilityCode: 'command', presetId: preset.id }),
      ],
    });
    expect(count).toBe(1);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(writes[0]).toEqual({
      activityId: 'activity-1',
      sessionId: null,
      roleCode: 'primary',
      visibilityCode: 'command',
      sourcePresetId: preset.id,
      workflowRevision: 0,
      name: preset.name,
      addressText: preset.addressText,
      instruction: preset.instruction,
      longitude: preset.longitude,
      latitude: preset.latitude,
      coordinateSystemCode: preset.coordinateSystemCode,
      providerCode: preset.providerCode,
      providerPlaceId: preset.providerPlaceId,
      checkInEligible: true,
      radiusMeters: 100,
    });
    preset.name = '以后改名';
    expect(writes[0].name).toBe('预设集合点');
    expect(tx.activity.update).toHaveBeenCalledWith({
      where: { id: 'activity-1' },
      data: {
        location: '预设地址',
        locationLongitude: '120.1000000',
        locationLatitude: '30.2000000',
      },
    });
  });

  it.each([
    [inline(), inline()],
    [inline({ roleCode: 'parking' })],
    [inline(), inline({ roleCode: 'meeting' }), inline({ roleCode: 'meeting' })],
    [inline({ presetId: 'preset-0001' })],
    [inline({ sessionCode: 'missing' })],
  ])('rejects ambiguous/invalid scope before any place writes', async (...places) => {
    const { client, tx } = fixture();
    await expect(
      writeCreationPlaces(client, { activityId: 'activity-1', sessions: [], places }),
    ).rejects.toEqual(new BizException(BizCode.BAD_REQUEST));
    expect(tx.activityPlace.create).not.toHaveBeenCalled();
    expect(tx.activity.update).not.toHaveBeenCalled();
  });

  it('creates template text fallbacks per scope with explicit visibility, null coordinates, and no preset', async () => {
    const { client, tx, writes } = fixture();
    expect(
      await writeCreationPlaces(client, {
        activityId: 'activity-1',
        sessions: [{ id: 'session-1', code: 'morning', locationText: '场次集合点' }],
        places: [],
        fallback: { location: '活动集合点', visibilityCode: 'accepted' },
      }),
    ).toBe(2);
    expect(writes.map((row) => [row.sessionId, row.addressText])).toEqual([
      [null, '活动集合点'],
      ['session-1', '场次集合点'],
    ]);
    for (const row of writes)
      expect(row).toMatchObject({
        roleCode: 'primary',
        visibilityCode: 'accepted',
        checkInEligible: false,
        sourcePresetId: null,
        longitude: null,
        latitude: null,
        coordinateSystemCode: null,
      });
    expect(tx.activitySession.update).toHaveBeenCalledWith({
      where: { id: 'session-1' },
      data: { locationText: '场次集合点' },
    });
  });

  it('does not project parking/other text and leaves unsafe legacy coordinates untouched', async () => {
    const { client, tx } = fixture();
    const primary = inline({
      sessionCode: 'morning',
      inline: {
        name: '场次地点',
        addressText: '主地点',
        checkInEligible: false,
        coordinate: { longitude: 10, latitude: 70, coordinateSystemCode: 'gcj02' },
      },
    });
    await writeCreationPlaces(client, {
      activityId: 'activity-1',
      sessions: [{ id: 'session-1', code: 'morning', locationText: '旧地点' }],
      places: [
        primary,
        inline({ sessionCode: 'morning', roleCode: 'meeting' }),
        inline({ sessionCode: 'morning', roleCode: 'parking' }),
      ],
    });
    expect(tx.activitySession.update).toHaveBeenCalledWith({
      where: { id: 'session-1' },
      data: { locationText: '主地点', meetingPoint: '地点文字' },
    });
    expect(tx.activity.update).not.toHaveBeenCalled();
  });

  it.each([
    ['execution', 'executionPoint'],
    ['evacuation', 'evacuationPoint'],
  ] as const)(
    'projects one session %s place into its exact legacy field',
    async (roleCode, field) => {
      const { client, tx } = fixture();
      await writeCreationPlaces(client, {
        activityId: 'activity-1',
        sessions: [{ id: 'session-1', code: 'morning', locationText: '旧地点' }],
        places: [inline({ sessionCode: 'morning' }), inline({ sessionCode: 'morning', roleCode })],
      });
      expect(tx.activitySession.update).toHaveBeenCalledWith({
        where: { id: 'session-1' },
        data: { locationText: '地点文字', [field]: '地点文字' },
      });
    },
  );

  it('fails closed if the preset is missing or an existing snapshot would be overlaid', async () => {
    const missing = fixture();
    missing.tx.$queryRaw.mockResolvedValue([]);
    await expect(
      writeCreationPlaces(missing.client, {
        activityId: 'activity-1',
        sessions: [],
        places: [
          mapCreationPlace({
            roleCode: 'primary',
            visibilityCode: 'staff',
            presetId: 'preset-missing',
          }),
        ],
      }),
    ).rejects.toThrow();
    expect(missing.tx.activityPlace.create).not.toHaveBeenCalled();
    const existing = fixture();
    existing.tx.activityPlace.count.mockResolvedValue(1);
    await expect(
      writeCreationPlaces(existing.client, {
        activityId: 'activity-1',
        sessions: [],
        places: [inline()],
      }),
    ).rejects.toThrow();
    expect(existing.tx.activityPlace.create).not.toHaveBeenCalled();
  });
});
