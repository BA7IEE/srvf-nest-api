import {
  projectPlaceCoordinate,
  selectActivityLegacyCoordinate,
  selectSessionLegacyCoordinate,
  type ActivityPlaceCoordinateCandidate,
} from './activity-place-coordinate-projection';

const activityId = 'activity-a';
const sessionId = 'session-a';

function candidate(
  id: string,
  overrides: Partial<ActivityPlaceCoordinateCandidate> = {},
): ActivityPlaceCoordinateCandidate {
  return {
    id,
    activityId,
    sessionId: null,
    roleCode: 'primary',
    longitude: '116.3971280',
    latitude: '39.9165270',
    coordinateSystemCode: 'wgs84',
    ...overrides,
  };
}

describe('ActivityPlace coordinate projection', () => {
  it('WGS84 恒等投影，并以 Decimal(10,7) half-up 固化', () => {
    expect(
      projectPlaceCoordinate({
        longitude: '116.3971280',
        latitude: '39.9165270',
        coordinateSystemCode: 'wgs84',
      }),
    ).toEqual({
      kind: 'projectable',
      longitude: '116.3971280',
      latitude: '39.9165270',
    });
    expect(
      projectPlaceCoordinate({
        longitude: '116.12345675',
        latitude: '-39.12345675',
        coordinateSystemCode: 'wgs84',
      }),
    ).toEqual({
      kind: 'projectable',
      longitude: '116.1234568',
      latitude: '-39.1234568',
    });
  });

  it('GCJ-02 走固定迭代逆变换，而不是把原值当 WGS84', () => {
    // 冻结独立样例：wandergis/coordtransform README 的 WGS84(116.404,39.915)
    // 前向 GCJ-02 值为 (116.41024449916938,39.91640428150164)。输入受 DB 的 7 位
    // 小数限制，期望 WGS84 由该样例及前向残差人工复核后固定。
    expect(
      projectPlaceCoordinate({
        longitude: '116.4102445',
        latitude: '39.9164043',
        coordinateSystemCode: 'gcj02',
      }),
    ).toEqual({
      kind: 'projectable',
      longitude: '116.4040000',
      latitude: '39.9150000',
    });
  });

  it('BD-09 必须先转 GCJ-02，再逆变换到 WGS84', () => {
    // 同一独立样例的 GCJ-02(116.404,39.915) → BD-09
    // (116.41036949371029,39.92133699351021)，按 DB 7 位小数输入后人工复核。
    expect(
      projectPlaceCoordinate({
        longitude: '116.4103695',
        latitude: '39.9213370',
        coordinateSystemCode: 'bd09',
      }),
    ).toEqual({
      kind: 'projectable',
      longitude: '116.3977562',
      latitude: '39.9135958',
    });
  });

  it('只在闭合中国转换包络内变换，边界包含在内', () => {
    expect(
      projectPlaceCoordinate({
        longitude: '72.0040000',
        latitude: '0.8293000',
        coordinateSystemCode: 'gcj02',
      }).kind,
    ).toBe('projectable');
    expect(
      projectPlaceCoordinate({
        longitude: '137.8347000',
        latitude: '55.8271000',
        coordinateSystemCode: 'bd09',
      }).kind,
    ).toBe('projectable');
    expect(
      projectPlaceCoordinate({
        longitude: '72.0039999',
        latitude: '0.8293000',
        coordinateSystemCode: 'gcj02',
      }),
    ).toEqual({ kind: 'not_projectable', reason: 'outside-transform-envelope' });
    expect(
      projectPlaceCoordinate({
        longitude: '137.8347001',
        latitude: '55.8271000',
        coordinateSystemCode: 'bd09',
      }),
    ).toEqual({ kind: 'not_projectable', reason: 'outside-transform-envelope' });
  });

  it('缺对、未知坐标系、非有限数和全球越界均 fail-closed', () => {
    expect(
      projectPlaceCoordinate({
        longitude: null,
        latitude: '39.9',
        coordinateSystemCode: 'wgs84',
      }),
    ).toEqual({ kind: 'not_projectable', reason: 'coordinate-pair-incomplete' });
    expect(
      projectPlaceCoordinate({
        longitude: '116.4',
        latitude: '39.9',
        coordinateSystemCode: 'WGS84',
      }),
    ).toEqual({ kind: 'not_projectable', reason: 'invalid-coordinate-system' });
    expect(
      projectPlaceCoordinate({
        longitude: Number.POSITIVE_INFINITY,
        latitude: 39.9,
        coordinateSystemCode: 'wgs84',
      }),
    ).toEqual({ kind: 'not_projectable', reason: 'invalid-coordinate' });
    expect(
      projectPlaceCoordinate({
        longitude: '180.0000001',
        latitude: '39.9',
        coordinateSystemCode: 'wgs84',
      }),
    ).toEqual({ kind: 'not_projectable', reason: 'invalid-coordinate' });
  });

  it('活动级只接受唯一的 primary，不依赖候选数组顺序', () => {
    const primary = candidate('activity-primary');
    const otherRole = candidate('activity-meeting', { roleCode: 'meeting' });
    const anotherActivity = candidate('other-activity', { activityId: 'activity-b' });

    expect(
      selectActivityLegacyCoordinate(activityId, [otherRole, anotherActivity, primary]),
    ).toEqual({
      kind: 'projectable',
      sourcePlaceId: 'activity-primary',
      longitude: '116.3971280',
      latitude: '39.9165270',
    });
    expect(
      selectActivityLegacyCoordinate(activityId, [primary, otherRole, anotherActivity]),
    ).toEqual({
      kind: 'projectable',
      sourcePlaceId: 'activity-primary',
      longitude: '116.3971280',
      latitude: '39.9165270',
    });
  });

  it('活动级遇到零条、多条或不可投影 primary 均不产生旧字段候选', () => {
    expect(
      selectActivityLegacyCoordinate(activityId, [
        candidate('meeting-only', { roleCode: 'meeting' }),
      ]),
    ).toEqual({ kind: 'not_projectable', reason: 'no-primary-place' });
    expect(
      selectActivityLegacyCoordinate(activityId, [candidate('first'), candidate('second')]),
    ).toEqual({ kind: 'not_projectable', reason: 'ambiguous-primary-place' });
    expect(
      selectActivityLegacyCoordinate(activityId, [
        candidate('missing-coordinate', { longitude: null, latitude: null }),
      ]),
    ).toEqual({ kind: 'not_projectable', reason: 'coordinate-pair-incomplete' });
  });

  it('场次级只选择同活动、同场次的唯一 primary', () => {
    const target = candidate('session-primary', { sessionId });
    const otherSession = candidate('other-session', { sessionId: 'session-b' });
    const activityLevel = candidate('activity-level');

    expect(
      selectSessionLegacyCoordinate(activityId, sessionId, [activityLevel, otherSession, target]),
    ).toEqual({
      kind: 'projectable',
      sourcePlaceId: 'session-primary',
      longitude: '116.3971280',
      latitude: '39.9165270',
    });
    expect(
      selectSessionLegacyCoordinate(activityId, sessionId, [
        target,
        candidate('duplicate', { sessionId }),
      ]),
    ).toEqual({ kind: 'not_projectable', reason: 'ambiguous-primary-place' });
  });
});
