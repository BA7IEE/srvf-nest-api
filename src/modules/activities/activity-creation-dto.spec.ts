import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  AppEmergencyActivityCreationDto,
  AppQuickActivityCreationDto,
} from './dto/app/app-managed-activity-creation.dto';
import { AppProfessionalActivityCreationDto } from './dto/app/app-managed-activity-creation-professional.dto';
import {
  creationRequestHash,
  mapEmergencyCreation,
  mapProfessionalCreation,
  mapQuickCreation,
} from './activity-creation-command';
import { canonicalizeRegistrationFormDefinitionForB3 } from './registration-form-definition';
import { presentActivityCreation } from './activity-creation-presenter';

const base = {
  operationKey: 'b6-operation-0001',
  title: '创建活动',
  organizationId: 'organization-0001',
  startAt: '2099-09-01T08:00:00.000Z',
  endAt: '2099-09-01T12:00:00.000Z',
  location: '集合点',
};
const quick = { ...base, templateVersionId: 'template-0001', defaultPlaceVisibilityCode: 'staff' };
const emergency = {
  ...base,
  initiatorMemberId: 'member-0001',
  activityTypeCode: 'training',
  allocationModeCode: 'first_come',
  memberIds: ['member-0002'],
};
const professional = {
  ...base,
  activityTypeCode: 'training',
  allocationModeCode: 'first_come',
  sessions: [
    {
      session: {
        code: 'morning',
        name: '上午场',
        startAt: base.startAt,
        endAt: base.endAt,
        locationText: '集合点',
        checkInOpenAt: base.startAt,
        checkInCloseAt: base.startAt,
        checkOutOpenAt: base.endAt,
        checkOutCloseAt: base.endAt,
        locationRequired: false,
      },
      positions: [],
    },
  ],
};
const validation = { whitelist: true, forbidNonWhitelisted: true, forbidUnknownValues: true };

describe('B6 physical App DTO and explicit command mapping', () => {
  it('accepts all three minimal closed requests', async () => {
    expect(await validate(plainToInstance(AppQuickActivityCreationDto, quick), validation)).toEqual(
      [],
    );
    expect(
      await validate(plainToInstance(AppEmergencyActivityCreationDto, emergency), validation),
    ).toEqual([]);
    expect(
      await validate(plainToInstance(AppProfessionalActivityCreationDto, professional), validation),
    ).toEqual([]);
  });

  it.each(['operationKey', 'templateVersionId', 'defaultPlaceVisibilityCode'])(
    'quick requires %s',
    async (field) => {
      const input: Record<string, unknown> = { ...quick };
      delete input[field];
      expect(
        (await validate(plainToInstance(AppQuickActivityCreationDto, input), validation)).length,
      ).toBeGreaterThan(0);
    },
  );

  it.each([
    'safetyPolicy',
    'incidentId',
    'registrationSchema',
    'content',
    'statusCode',
    'createdBy',
  ])('professional rejects unsupported field %s', async (field) => {
    expect(
      (
        await validate(
          plainToInstance(AppProfessionalActivityCreationDto, {
            ...professional,
            [field]: {},
          }),
          validation,
        )
      ).length,
    ).toBeGreaterThan(0);
  });

  it.each([null, [], ['short'], ['member-0002', 'member-0002']])(
    'rejects invalid emergency audience %j',
    async (memberIds) => {
      expect(
        (
          await validate(
            plainToInstance(AppEmergencyActivityCreationDto, { ...emergency, memberIds }),
            validation,
          )
        ).length,
      ).toBeGreaterThan(0);
    },
  );

  it('rejects unknown nested place/coordinate keys, incomplete coordinates and nullable optional objects', async () => {
    for (const inline of [
      null,
      { name: '地点', addressText: '地址', checkInEligible: false, coordinate: { longitude: 120 } },
      {
        name: '地点',
        addressText: '地址',
        checkInEligible: false,
        coordinate: {
          longitude: 120,
          latitude: 30,
          coordinateSystemCode: 'wgs84',
          secret: 'rejected',
        },
      },
    ]) {
      expect(
        (
          await validate(
            plainToInstance(AppQuickActivityCreationDto, {
              ...quick,
              places: [{ roleCode: 'primary', visibilityCode: 'staff', inline }],
            }),
            validation,
          )
        ).length,
      ).toBeGreaterThan(0);
    }
  });

  it('canonical hash ignores object key order and normalizes equivalent date instants/audience ordering', () => {
    const a = mapEmergencyCreation(
      plainToInstance(AppEmergencyActivityCreationDto, {
        ...emergency,
        memberIds: ['member-0003', 'member-0002'],
      }),
    );
    const b = mapEmergencyCreation(
      plainToInstance(AppEmergencyActivityCreationDto, {
        ...emergency,
        startAt: '2099-09-01T16:00:00+08:00',
        memberIds: ['member-0002', 'member-0003'],
      }),
    );
    expect(creationRequestHash('emergency', 'actor-1', a)).toBe(
      creationRequestHash('emergency', 'actor-1', b),
    );
    expect(creationRequestHash('emergency', 'actor-1', { a: 1, b: 2 })).toBe(
      creationRequestHash('emergency', 'actor-1', { b: 2, a: 1 }),
    );
  });

  it('hash binds actor, mode, capacity confirmation, and explicit place visibility', () => {
    const command = mapQuickCreation(plainToInstance(AppQuickActivityCreationDto, quick));
    const original = creationRequestHash('quick', 'actor-1', command);
    expect(creationRequestHash('quick', 'actor-2', command)).not.toBe(original);
    expect(creationRequestHash('professional', 'actor-1', command)).not.toBe(original);
    expect(creationRequestHash('quick', 'actor-1', { ...command, confirmedCapacity: 10 })).not.toBe(
      original,
    );
    expect(
      creationRequestHash('quick', 'actor-1', { ...command, defaultPlaceVisibilityCode: 'public' }),
    ).not.toBe(original);
  });

  it('hash preserves decimal precision and numeric types without settlement rounding', () => {
    const command = {
      coordinate: { longitude: 120.1234567, latitude: 30.2 },
      formBounds: { minValue: 0.01, maxValue: 1.5 },
    };
    const original = creationRequestHash('professional', 'actor-1', command);
    expect(
      creationRequestHash('professional', 'actor-1', {
        formBounds: { maxValue: 1.5, minValue: 0.01 },
        coordinate: { latitude: 30.2, longitude: 120.1234567 },
      }),
    ).toBe(original);
    expect(
      creationRequestHash('professional', 'actor-1', {
        ...command,
        coordinate: { ...command.coordinate, longitude: 120.1234568 },
      }),
    ).not.toBe(original);
    expect(
      creationRequestHash('professional', 'actor-1', {
        ...command,
        formBounds: { ...command.formBounds, minValue: '0.01' },
      }),
    ).not.toBe(original);
  });

  it.each([NaN, Infinity, -Infinity])('hash rejects non-finite number %s', (value) => {
    expect(() => creationRequestHash('professional', 'actor-1', { value })).toThrow();
  });

  it('preserves governed form fields and rejects unapproved sensitive governance at canonical validation', () => {
    const input = plainToInstance(AppProfessionalActivityCreationDto, {
      ...professional,
      form: {
        fields: [
          {
            fieldCode: 'transport',
            typeCode: 'short_text',
            label: '交通说明',
            required: false,
            visibilityCode: 'self_only',
            exportable: false,
            sortOrder: 0,
            governance: {
              purposeCode: 'transport_logistics',
              dataClassCode: 'ordinary',
              retentionPolicyCode: 'activity_lifecycle',
              maskingPolicyCode: 'none',
              prefillSourceCode: null,
            },
          },
        ],
      },
    });
    const mapped = mapProfessionalCreation(input);
    expect(canonicalizeRegistrationFormDefinitionForB3(mapped.form!).mode).toBe('governed');
    input.form!.fields[0].governance!.dataClassCode = 'sensitive';
    expect(() =>
      canonicalizeRegistrationFormDefinitionForB3(mapProfessionalCreation(input).form!),
    ).toThrow();
  });

  it('creation presenter never projects credentials, raw audiences, or location details on replay', () => {
    const activity = {
      id: 'activity-1',
      createdAt: new Date(base.startAt),
      signedUrl: 'never-return',
      location: 'private',
      operationKey: 'private',
    };
    const result = presentActivityCreation({
      activity,
      mode: 'emergency',
      replayed: true,
      followUpItems: [{ itemCode: 'session', statusCode: 'pending' }],
    });
    expect(result).toEqual({
      activity: {
        activityId: 'activity-1',
        createdAt: activity.createdAt,
        createdStatusCode: 'draft',
      },
      mode: 'emergency',
      replayed: true,
      followUpItems: [{ itemCode: 'session', statusCode: 'pending' }],
    });
  });
});
