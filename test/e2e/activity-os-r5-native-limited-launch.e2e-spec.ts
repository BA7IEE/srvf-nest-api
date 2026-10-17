import {
  assertNativeLaunchProjection,
  nativeLaunchRawInput,
  nativeLaunchSlices,
} from '../helpers/activity-native-launch.fixture';

// Offline fixture-contract tests. Live execution is explicit and uses the original leased W98
// lifecycle; importing this suite does not create an app or connect to a database.
describe('native launch raw fixture contract', () => {
  let sequence = 0;
  const key = (kind: string) => `${kind}_${++sequence}`;
  const source = {
    activityId: 'activity',
    sessionId: 'session',
    positionId: 'position',
    startsAt: new Date('2020-03-01T08:00:00.000Z'),
    endsAt: new Date('2020-03-01T08:00:36.000Z'),
  };
  const creator = { id: 'creator', memberId: 'member' };
  const input = (population = 1) =>
    nativeLaunchRawInput(source, creator, population, key, new Date(source.endsAt));

  it.each([1, 500])('projects every raw event once for population %s', (population) => {
    const raw = input(population);
    expect(raw.people).toHaveLength(population);
    expect(raw.members).toHaveLength(population - 1);
    expect(raw.registrations).toHaveLength(population);
    expect(raw.events).toHaveLength(population * 2);
    expect(raw.segments).toHaveLength(population);
    expect(() => assertNativeLaunchProjection(raw)).not.toThrow();
    expect(raw.segments.every((segment) => segment.serviceHours === 0.01)).toBe(true);
  });
  it('rejects the original missing-projection 20043 fixture defect before database work', () => {
    expect(() => assertNativeLaunchProjection({ ...input(), segments: [] })).toThrow();
  });
  it('rejects cross-identity punch anchors rather than changing an expected seal status', () => {
    const raw = input(2);
    raw.segments[0].sourceCloseEventId = raw.people[1].checkOutId;
    expect(() => assertNativeLaunchProjection(raw)).toThrow();
  });
  it('rejects a duplicated or open source event', () => {
    const raw = input();
    raw.segments[0].sourceCloseEventId = raw.people[0].checkInId;
    expect(() => assertNativeLaunchProjection(raw)).toThrow();
  });
  it('rejects future observations and population beyond the approved whole-activity boundary', () => {
    expect(() => nativeLaunchRawInput(source, creator, 1, key, source.startsAt)).toThrow();
    expect(() => input(501)).toThrow();
  });
  it.each([5, 6])('partitions the complete span into %s adjacent physical slices', (count) => {
    const slices = nativeLaunchSlices(source.startsAt, source.endsAt, count);
    expect(slices).toHaveLength(count);
    expect(slices[0].startAt).toBe(source.startsAt.toISOString());
    expect(slices.at(-1)?.endAt).toBe(source.endsAt.toISOString());
    expect(new Set(slices.map((slice) => slice.categoryCode)).size).toBe(4);
    for (let index = 1; index < count; index++)
      expect(slices[index].startAt).toBe(slices[index - 1].endAt);
  });
});
