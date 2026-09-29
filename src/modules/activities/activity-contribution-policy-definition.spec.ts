import {
  evaluateContributionPolicy,
  fingerprintContributionPolicyVersion,
  parseContributionPolicyDefinition,
} from './activity-contribution-policy-definition';

function result(recognizedPoints = '0.00', explanationCode = 'default_zero') {
  return { recognizedPoints, explanationCode };
}

function definition() {
  return {
    defaultResult: result(),
    roleRules: [
      {
        attendanceRoleCode: 'service',
        categoryRules: [
          {
            timeCategoryCode: 'volunteer_service',
            durationBands: [
              { maxSecondsInclusive: 3599, ...result('0.50', 'service_under_hour') },
              { maxSecondsInclusive: 7199, ...result('1.00', 'service_under_two_hours') },
              { maxSecondsInclusive: null, ...result('2.00', 'service_two_hours_plus') },
            ],
          },
        ],
      },
    ],
  };
}

function version() {
  return {
    schemaVersion: 1,
    evaluatorVersion: 1,
    definition: definition(),
    effectiveFrom: '2099-09-22T00:00:00.000Z',
    effectiveUntil: null,
  };
}

describe('contribution policy definition v1', () => {
  it('normalizes role and category ordering without mutating input', () => {
    const input = {
      defaultResult: result(),
      roleRules: [
        {
          attendanceRoleCode: 'z',
          categoryRules: [
            {
              timeCategoryCode: 'organization',
              durationBands: [{ maxSecondsInclusive: null, ...result('2.00', 'organization') }],
            },
            {
              timeCategoryCode: 'training',
              durationBands: [{ maxSecondsInclusive: null, ...result('1.00', 'training') }],
            },
          ],
        },
        { attendanceRoleCode: 'a', categoryRules: [] },
      ],
    };
    const before = JSON.stringify(input);
    const parsed = parseContributionPolicyDefinition(input);
    expect(parsed.roleRules.map((item) => item.attendanceRoleCode)).toEqual(['a', 'z']);
    expect(parsed.roleRules[1].categoryRules.map((item) => item.timeCategoryCode)).toEqual([
      'training',
      'organization',
    ]);
    expect(JSON.stringify(input)).toBe(before);
  });

  it('accepts every closed time category', () => {
    for (const timeCategoryCode of [
      'volunteer_service',
      'training',
      'organization',
      'non_creditable',
    ]) {
      expect(
        parseContributionPolicyDefinition({
          defaultResult: result(),
          roleRules: [
            {
              attendanceRoleCode: 'service',
              categoryRules: [
                {
                  timeCategoryCode,
                  durationBands: [{ maxSecondsInclusive: null, ...result() }],
                },
              ],
            },
          ],
        }).roleRules[0].categoryRules[0].timeCategoryCode,
      ).toBe(timeCategoryCode);
    }
  });

  it('accepts the declared role and band limits', () => {
    const roleRules = Array.from({ length: 64 }, (_, roleIndex) => ({
      attendanceRoleCode: `role_${roleIndex}`,
      categoryRules: [
        {
          timeCategoryCode: 'training',
          durationBands: Array.from({ length: 16 }, (_, bandIndex) => ({
            maxSecondsInclusive: bandIndex === 15 ? null : bandIndex,
            ...result(`${String(bandIndex).padStart(1, '0')}.00`, `band_${bandIndex}`),
          })),
        },
      ],
    }));
    expect(
      parseContributionPolicyDefinition({ defaultResult: result(), roleRules }).roleRules,
    ).toHaveLength(64);
  });

  it.each(['0.00', '0.01', '12.30', '999.99'])('accepts canonical points %s', (points) => {
    expect(
      parseContributionPolicyDefinition({ ...definition(), defaultResult: result(points) }),
    ).toEqual(expect.objectContaining({ defaultResult: result(points) }));
  });

  it.each(['0', '0.0', '00.00', '01.00', '1.000', '-0.01', '1000.00', 1, NaN])(
    'rejects non-canonical points %p',
    (recognizedPoints) => {
      expect(() =>
        parseContributionPolicyDefinition({
          ...definition(),
          defaultResult: { recognizedPoints, explanationCode: 'default_zero' },
        }),
      ).toThrow();
    },
  );

  it.each([
    { durationBands: [] },
    {
      durationBands: [
        { maxSecondsInclusive: 10, ...result() },
        { maxSecondsInclusive: 10, ...result() },
        { maxSecondsInclusive: null, ...result() },
      ],
    },
    {
      durationBands: [
        { maxSecondsInclusive: null, ...result() },
        { maxSecondsInclusive: 10, ...result() },
      ],
    },
    { durationBands: [{ maxSecondsInclusive: 10, ...result() }] },
    {
      durationBands: [
        { maxSecondsInclusive: -1, ...result() },
        { maxSecondsInclusive: null, ...result() },
      ],
    },
    {
      durationBands: [
        { maxSecondsInclusive: 1.5, ...result() },
        { maxSecondsInclusive: null, ...result() },
      ],
    },
  ])('rejects malformed duration bands %#', ({ durationBands }) => {
    const value = definition();
    value.roleRules[0].categoryRules[0].durationBands = durationBands;
    expect(() => parseContributionPolicyDefinition(value)).toThrow();
  });

  it('rejects duplicate roles, duplicate categories and declared limits + 1', () => {
    const duplicateRole = definition();
    duplicateRole.roleRules.push(structuredClone(duplicateRole.roleRules[0]));
    expect(() => parseContributionPolicyDefinition(duplicateRole)).toThrow();

    const duplicateCategory = definition();
    duplicateCategory.roleRules[0].categoryRules.push(
      structuredClone(duplicateCategory.roleRules[0].categoryRules[0]),
    );
    expect(() => parseContributionPolicyDefinition(duplicateCategory)).toThrow();

    const tooManyRoles = {
      ...definition(),
      roleRules: Array.from({ length: 65 }, (_, index) => ({
        attendanceRoleCode: `role_${index}`,
        categoryRules: [],
      })),
    };
    expect(() => parseContributionPolicyDefinition(tooManyRoles)).toThrow();

    const tooManyBands = definition();
    tooManyBands.roleRules[0].categoryRules[0].durationBands = Array.from(
      { length: 17 },
      (_, index) => ({
        maxSecondsInclusive: index === 16 ? null : index,
        ...result(),
      }),
    );
    expect(() => parseContributionPolicyDefinition(tooManyBands)).toThrow();
  });

  it.each([
    { ...definition(), extra: true },
    { ...definition(), defaultResult: { ...result(), label: 'free text' } },
    { ...definition(), defaultResult: result('1.00', 'Not Stable') },
    { ...definition(), roleRules: 'service' },
  ])('rejects unknown keys, free text and wrong types %#', (value) => {
    expect(() => parseContributionPolicyDefinition(value)).toThrow();
  });

  it('rejects accessors, cycles, sparse arrays and non-JSON values', () => {
    const accessor = definition();
    Object.defineProperty(accessor, 'defaultResult', { enumerable: true, get: () => result() });
    expect(() => parseContributionPolicyDefinition(accessor)).toThrow();

    const cycle = definition() as ReturnType<typeof definition> & { cycle?: unknown };
    cycle.cycle = cycle;
    expect(() => parseContributionPolicyDefinition(cycle)).toThrow();

    const sparse = definition();
    sparse.roleRules.length = 0;
    sparse.roleRules.length = 1;
    expect(() => parseContributionPolicyDefinition(sparse)).toThrow();

    expect(() =>
      parseContributionPolicyDefinition({ ...definition(), roleRules: [undefined] }),
    ).toThrow();
  });

  it('fingerprints normalized semantic input deterministically', () => {
    const first = fingerprintContributionPolicyVersion(version());
    const reordered = version();
    reordered.definition.roleRules.unshift({ attendanceRoleCode: 'alpha', categoryRules: [] });
    reordered.definition.roleRules.reverse();
    const second = fingerprintContributionPolicyVersion(reordered);
    expect(first.definitionHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(second.definition.roleRules.map((item) => item.attendanceRoleCode)).toEqual([
      'alpha',
      'service',
    ]);
    expect(fingerprintContributionPolicyVersion(JSON.parse(JSON.stringify(version())))).toEqual(
      first,
    );
  });

  it.each([
    { ...version(), schemaVersion: 2 },
    { ...version(), evaluatorVersion: 2 },
    { ...version(), effectiveFrom: '2099-09-22T00:00:00Z' },
    { ...version(), effectiveUntil: '2099-09-21T00:00:00.000Z' },
    { ...version(), extra: true },
  ])('rejects unknown version metadata or invalid intervals %#', (value) => {
    expect(() => fingerprintContributionPolicyVersion(value)).toThrow();
  });

  it.each([
    [0, result('0.50', 'service_under_hour')],
    [3599, result('0.50', 'service_under_hour')],
    [3600, result('1.00', 'service_under_two_hours')],
    [7199, result('1.00', 'service_under_two_hours')],
    [7200, result('2.00', 'service_two_hours_plus')],
  ])('evaluates boundary second %s', (durationSeconds, expected) => {
    expect(
      evaluateContributionPolicy(definition(), {
        attendanceRoleCode: 'service',
        timeCategoryCode: 'volunteer_service',
        durationSeconds,
      }),
    ).toEqual(expected);
  });

  it('uses explicit default for missing role or category and returns a copy', () => {
    const value = definition();
    const missingRole = evaluateContributionPolicy(value, {
      attendanceRoleCode: 'unknown',
      timeCategoryCode: 'training',
      durationSeconds: 1,
    });
    const missingCategory = evaluateContributionPolicy(value, {
      attendanceRoleCode: 'service',
      timeCategoryCode: 'training',
      durationSeconds: 1,
    });
    expect(missingRole).toEqual(result());
    expect(missingCategory).toEqual(result());
    expect(missingRole).not.toBe(value.defaultResult);
  });

  it.each([-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid evaluation seconds %p',
    (durationSeconds) => {
      expect(() =>
        evaluateContributionPolicy(definition(), {
          attendanceRoleCode: 'service',
          timeCategoryCode: 'volunteer_service',
          durationSeconds,
        }),
      ).toThrow();
    },
  );
});
