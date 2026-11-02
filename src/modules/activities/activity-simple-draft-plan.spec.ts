import { BizCode, type BizCodeEntry } from '../../common/exceptions/biz-code.constant';
import {
  creationRequestHash,
  mapQuickCreation,
  quickCreationRequestHash,
} from './activity-creation-command';
import {
  parseSimpleActivityInstance,
  simpleDraftHash,
  simpleDraftLayout,
} from './activity-simple-draft-plan';
import type { ActivityTemplateDefinitionV1 } from './activity-template-definition-v1';

const definition: ActivityTemplateDefinitionV1 = {
  activity: { allocationModeCode: 'first_come', capacity: 2 },
  sessions: [
    {
      code: 'main',
      name: '场次',
      startOffsetMinutes: 0,
      endOffsetMinutes: 120,
      locationText: '地点',
      capacity: 2,
      checkInOpenOffsetMinutes: 0,
      checkInCloseOffsetMinutes: 20,
      checkOutOpenOffsetMinutes: -20,
      checkOutCloseOffsetMinutes: 0,
      locationRequired: false,
      lateGraceMinutes: 5,
      earlyLeaveThresholdMinutes: 5,
      sortOrder: 0,
      positions: [
        {
          code: 'participant',
          name: '参与',
          attendanceRoleCode: 'volunteer',
          capacity: 2,
          sortOrder: 0,
        },
      ],
    },
  ],
};
function expectBiz(action: () => unknown, biz: BizCodeEntry) {
  let captured: unknown;
  try {
    action();
  } catch (error) {
    captured = error;
  }
  expect(captured).toMatchObject({ biz });
}

const start = new Date('2099-09-01T00:00:00.000Z');
const end = new Date('2099-09-01T03:00:00.000Z');
const instance = {
  capacity: 5,
  registrationDeadline: null,
  description: '本次说明',
  registrationNotes: '准备事项',
};

describe('simple instance facts and approved single-session layout', () => {
  it('keeps the pre-L2 Quick hash byte-exact when the optional instance block is absent', () => {
    // Computed from untouched e37aadb7, not from the candidate mapper.
    const command = mapQuickCreation({
      operationKey: 'simple-characterization-1',
      title: '旧 Quick',
      organizationId: 'organization-0001',
      startAt: '2099-09-01T00:00:00Z',
      endAt: '2099-09-01T02:00:00Z',
      location: '集合点',
      templateVersionId: 'template-0001',
      defaultPlaceVisibilityCode: 'staff',
    });
    expect(Object.hasOwn(command, 'instance')).toBe(false);
    expect(quickCreationRequestHash('actor-0001', command, false)).toBe(
      creationRequestHash('quick', 'actor-0001', command),
    );
    expect(quickCreationRequestHash('actor-0001', command, true)).not.toBe(
      quickCreationRequestHash('actor-0001', command, false),
    );
    expect(creationRequestHash('quick', 'actor-0001', command)).toBe(
      'bb2e1a29772f80cbc55d05a46868b38a39bd64a13ba656df30f38d7be3ea1034',
    );
    const withInstance = { ...command, instance };
    for (const changes of [
      { capacity: 6 },
      { capacity: null },
      { description: null },
      { registrationNotes: null },
      { registrationDeadline: start.toISOString() },
    ]) {
      expect(
        creationRequestHash('quick', 'actor-0001', {
          ...withInstance,
          instance: { ...instance, ...changes },
        }),
      ).not.toBe(creationRequestHash('quick', 'actor-0001', withInstance));
    }
  });

  it('normalizes dates, distinguishes explicit unlimited/null, and rejects partial or open-ended blocks', () => {
    expect(
      parseSimpleActivityInstance({
        ...instance,
        capacity: null,
        registrationDeadline: '2099-09-01T08:00:00+08:00',
      }),
    ).toEqual({ ...instance, capacity: null, registrationDeadline: start.toISOString() });
    for (const value of [
      undefined,
      null,
      { ...instance, unknown: true },
      { capacity: 1 },
      { ...instance, capacity: 0 },
      { ...instance, capacity: 1.5 },
      { ...instance, capacity: 2147483648 },
      { ...instance, description: 'a'.repeat(2001) },
    ]) {
      expectBiz(() => parseSimpleActivityInstance(value), BizCode.BAD_REQUEST);
    }
  });

  it('moves parent/session and explicit full-session duty together using approved relative windows', () => {
    const explicit = {
      ...definition,
      sessions: [
        {
          ...definition.sessions[0],
          positions: [
            {
              ...definition.sessions[0].positions[0],
              startOffsetMinutes: 0,
              endOffsetMinutes: 120,
            },
          ],
        },
      ],
    };
    const plan = simpleDraftLayout(explicit, start, end, 5, '新地点');
    expect(plan.session).toMatchObject({
      startAt: start,
      endAt: end,
      capacity: 5,
      locationText: '新地点',
      checkInOpenAt: start,
      checkInCloseAt: new Date('2099-09-01T00:20:00Z'),
      checkOutOpenAt: new Date('2099-09-01T02:40:00Z'),
      checkOutCloseAt: end,
    });
    expect(plan.position).toEqual({ startAt: start, endAt: end, capacity: 5 });
    expect(simpleDraftLayout(definition, start, end, null, '地点').position).toEqual({
      startAt: null,
      endAt: null,
      capacity: null,
    });
    expect(definition.sessions[0].endOffsetMinutes).toBe(120);
    expect(definition.activity.capacity).toBe(2);
  });

  it('uses the shared Beijing day boundary, independently of the UTC calendar date', () => {
    expect(
      simpleDraftLayout(
        definition,
        new Date('2099-09-01T23:30:00Z'),
        new Date('2099-09-02T01:30:00Z'),
        2,
        '地点',
      ).session.startAt.toISOString(),
    ).toBe('2099-09-01T23:30:00.000Z');
    expectBiz(
      () =>
        simpleDraftLayout(
          definition,
          new Date('2099-09-01T14:00:00Z'),
          new Date('2099-09-01T16:00:00Z'),
          2,
          '地点',
        ),
      BizCode.BAD_REQUEST,
    );
  });

  it.each([
    { ...definition, activity: { ...definition.activity, allocationModeCode: 'lottery' as const } },
    { ...definition, sessions: [...definition.sessions, definition.sessions[0]] },
    {
      ...definition,
      sessions: [
        {
          ...definition.sessions[0],
          positions: [...definition.sessions[0].positions, definition.sessions[0].positions[0]],
        },
      ],
    },
    { ...definition, sessions: [{ ...definition.sessions[0], capacity: null }] },
    {
      ...definition,
      sessions: [
        {
          ...definition.sessions[0],
          positions: [
            {
              ...definition.sessions[0].positions[0],
              startOffsetMinutes: 20,
              endOffsetMinutes: 100,
            },
          ],
        },
      ],
    },
    { ...definition, timePolicySelection: { sessionOverrides: [{}] } },
  ])('rejects complex structure without deleting or simplifying it', (value) => {
    expectBiz(() => simpleDraftLayout(value, start, end, 5, '地点'), BizCode.BAD_REQUEST);
  });

  it('does not widen the activity envelope to accommodate an illegal approved window', () => {
    const invalid = {
      ...definition,
      sessions: [{ ...definition.sessions[0], checkInOpenOffsetMinutes: -5 }],
    };
    expectBiz(
      () => simpleDraftLayout(invalid, start, end, 5, '地点'),
      BizCode.ACTIVITY_SESSION_WINDOW_INVALID,
    );
    expectBiz(
      () => simpleDraftLayout(definition, start, new Date('2099-09-02T01:00:00Z'), 5, '地点'),
      BizCode.BAD_REQUEST,
    );
  });

  it('uses stable key ordering and binds all provided draft dependency facts', () => {
    expect(simpleDraftHash({ parent: { capacity: 2, title: 'A' }, children: [{ id: '1' }] })).toBe(
      simpleDraftHash({ children: [{ id: '1' }], parent: { title: 'A', capacity: 2 } }),
    );
    expect(simpleDraftHash({ templateHash: 'A', revision: 1 })).not.toBe(
      simpleDraftHash({ templateHash: 'B', revision: 1 }),
    );
  });
});
