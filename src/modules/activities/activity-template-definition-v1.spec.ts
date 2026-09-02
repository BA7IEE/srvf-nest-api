import {
  ActivityTemplateDefinitionV1Error,
  parseActivityTemplateDefinitionV1,
} from './activity-template-definition-v1';

function validDefinition(overrides: Record<string, unknown> = {}) {
  return {
    activity: {
      allocationModeCode: 'first_come',
      capacity: 30,
      isPublicRegistration: true,
      archiveWaitingDays: 7,
    },
    sessions: [
      {
        code: 'morning',
        name: '上午场',
        startOffsetMinutes: 0,
        endOffsetMinutes: 120,
        locationText: '集合点',
        checkInOpenOffsetMinutes: 0,
        checkInCloseOffsetMinutes: 30,
        checkOutOpenOffsetMinutes: -30,
        checkOutCloseOffsetMinutes: 0,
        locationRequired: false,
        positions: [
          {
            code: 'support',
            name: '现场保障',
            attendanceRoleCode: 'support',
            capacity: 5,
            startOffsetMinutes: 0,
            endOffsetMinutes: 120,
          },
        ],
      },
    ],
    ...overrides,
  };
}

describe('parseActivityTemplateDefinitionV1', () => {
  it('解析严格白名单，并为可省略的场次字段给出既有草稿默认值', () => {
    const parsed = parseActivityTemplateDefinitionV1(validDefinition());

    expect(parsed.activity).toMatchObject({
      allocationModeCode: 'first_come',
      capacity: 30,
      archiveWaitingDays: 7,
    });
    expect(parsed.sessions).toHaveLength(1);
    expect(parsed.sessions[0]).toMatchObject({
      lateGraceMinutes: 15,
      earlyLeaveThresholdMinutes: 15,
      sortOrder: 0,
      locationRequired: false,
    });
    expect(parsed.sessions[0]?.positions[0]).toMatchObject({ sortOrder: 0 });
  });

  it('允许空 sessions：草稿是否可发布由后续 Readiness 处理', () => {
    expect(
      parseActivityTemplateDefinitionV1({
        activity: { allocationModeCode: 'first_come' },
        sessions: [],
      }),
    ).toMatchObject({ sessions: [] });
  });

  it('拒绝未知字段，不静默丢失未来敏感配置', () => {
    const definition = validDefinition({
      activity: { allocationModeCode: 'first_come', registrationSchema: { fields: [] } },
    });

    expect(() => parseActivityTemplateDefinitionV1(definition)).toThrow(
      ActivityTemplateDefinitionV1Error,
    );
  });

  it('拒绝无坐标却要求定位的场次，不能写出当前模型不接受的草稿', () => {
    const definition = validDefinition({
      sessions: [
        {
          ...((validDefinition().sessions as Array<Record<string, unknown>>)[0] ?? {}),
          locationRequired: true,
        },
      ],
    });

    expect(() => parseActivityTemplateDefinitionV1(definition)).toThrow(
      ActivityTemplateDefinitionV1Error,
    );
  });

  it('拒绝同一活动内重复场次 code，以及岗位成对时段的一半输入', () => {
    const baseSession = (validDefinition().sessions as Array<Record<string, unknown>>)[0] ?? {};
    const duplicateSessions = validDefinition({
      sessions: [baseSession, { ...baseSession, name: '下午场' }],
    });
    const incompletePositionWindow = validDefinition({
      sessions: [
        {
          ...baseSession,
          positions: [
            {
              ...((baseSession.positions as Array<Record<string, unknown>>)[0] ?? {}),
              endOffsetMinutes: undefined,
            },
          ],
        },
      ],
    });

    expect(() => parseActivityTemplateDefinitionV1(duplicateSessions)).toThrow(
      ActivityTemplateDefinitionV1Error,
    );
    expect(() => parseActivityTemplateDefinitionV1(incompletePositionWindow)).toThrow(
      ActivityTemplateDefinitionV1Error,
    );
  });
});
