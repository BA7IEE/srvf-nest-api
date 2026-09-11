import type { Prisma } from '@prisma/client';
import { fingerprintActivityTemplateDefinition } from './activity-template-definition';
import {
  parseStoredTemplateVersion,
  presentTemplateVersion,
  presentTemplateVersionSummary,
  type GlobalTemplateVersionRow,
} from './activity-template-version-presenter';

function fixture(schemaVersion = 3) {
  const v1 = { activity: { allocationModeCode: 'first_come' }, sessions: [] };
  const v2 = { ...v1, registrationForm: null };
  const v3 = {
    ...v2,
    metricSelection: { metricRequirementCode: 'not_required', metricSetPointer: null },
  };
  const definition = schemaVersion === 1 ? v1 : schemaVersion === 2 ? v2 : v3;
  const row: GlobalTemplateVersionRow = {
    id: 'template',
    code: 'template_code',
    name: '模板',
    version: 7,
    activityTypeCode: 'training',
    statusCode: 'active',
    familyId: 'family',
    schemaVersion,
    definitionJson: definition,
    definitionHash: fingerprintActivityTemplateDefinition({ schemaVersion, definition })
      .definitionHash,
    effectiveFrom: new Date('2200-01-01T00:00:00.000Z'),
    effectiveTo: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    defaultRegistrationModeCode: null,
    defaultLocationRequired: null,
    defaultCheckInRadiusMeters: null,
    checkInOpenOffsetMinutes: null,
    checkInCloseOffsetMinutes: null,
    checkOutOpenOffsetMinutes: null,
    checkOutCloseOffsetMinutes: null,
    defaultLateGraceMinutes: null,
    defaultEarlyLeaveThresholdMinutes: null,
    defaultArchiveWaitingDays: null,
    commonPositionTemplates: null,
    family: {
      id: 'family',
      code: 'family_code',
      name: '模板族',
      categoryCode: 'training',
      ownerOrganizationId: null,
      scopeTypeCode: 'global',
      statusCode: 'active',
      createdAt: new Date(0),
      updatedAt: new Date(0),
    },
  };
  return { row, definition };
}

describe('C1 D2b template presenter and independent historical parsers', () => {
  it.each([1, 2, 3])(
    'V%s detail preserves its own grammar without manufacturing newer fields',
    (schemaVersion) => {
      const { row, definition } = fixture(schemaVersion);
      const result = presentTemplateVersion(row);
      expect(result.definition).toEqual(definition);
      expect(Object.keys(result).sort()).toEqual(
        [
          'id',
          'code',
          'name',
          'version',
          'schemaVersion',
          'definitionHash',
          'statusCode',
          'activityTypeCode',
          'family',
          'effectiveFrom',
          'effectiveTo',
          'createdAt',
          'updatedAt',
          'definition',
        ].sort(),
      );
      expect(Object.keys(result.family).sort()).toEqual(
        ['id', 'code', 'name', 'categoryCode'].sort(),
      );
      expect(result.definitionHash).toBe(row.definitionHash);
      if (schemaVersion < 3) expect(result.definition).not.toHaveProperty('metricSelection');
      if (schemaVersion === 1) expect(result.definition).not.toHaveProperty('registrationForm');
    },
  );

  it('summary returns exactly thirteen fields and never echoes raw storage, relations or internal keys', () => {
    const { row } = fixture();
    const expanded = {
      ...row,
      operationKey: 'internal',
      metricCommandReceipts: [{ resultJson: 'internal' }],
    };
    expect(presentTemplateVersionSummary(expanded)).toEqual({
      id: row.id,
      code: row.code,
      name: row.name,
      version: 7,
      schemaVersion: 3,
      definitionHash: row.definitionHash,
      statusCode: 'active',
      activityTypeCode: 'training',
      family: { id: 'family', code: 'family_code', name: '模板族', categoryCode: 'training' },
      effectiveFrom: row.effectiveFrom,
      effectiveTo: null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  });

  it.each(['draft', 'retired'])(
    'Admin historical %s remains readable, independently of effective wall-clock windows',
    (statusCode) => {
      const { row, definition } = fixture();
      row.statusCode = statusCode;
      expect(presentTemplateVersion(row)).toMatchObject({
        statusCode,
        definition,
        effectiveFrom: row.effectiveFrom,
      });
    },
  );

  it.each(['missing', 'organization', 'owner', 'retired'] as const)(
    'rejects invisible Family: %s',
    (kind) => {
      const { row } = fixture();
      if (!row.family) throw new Error('fixture requires Family');
      if (kind === 'organization') row.family.scopeTypeCode = 'organization';
      if (kind === 'owner') row.family.ownerOrganizationId = 'organization';
      if (kind === 'retired') row.family.statusCode = 'retired';
      if (kind === 'missing') row.family = null;
      expect(() => presentTemplateVersionSummary(row)).toThrow(TypeError);
      expect(() => presentTemplateVersion(row)).toThrow(TypeError);
    },
  );

  it.each(['familyId', 'schemaVersion', 'definitionJson', 'definitionHash'] as const)(
    'rejects missing stored %s',
    (key) => {
      const { row } = fixture();
      row[key] = null;
      expect(() => parseStoredTemplateVersion(row)).toThrow(TypeError);
    },
  );

  it('rejects an unsupported schema even when its canonical hash is valid', () => {
    const { row, definition } = fixture(3);
    row.schemaVersion = 5;
    row.definitionHash = fingerprintActivityTemplateDefinition({
      schemaVersion: row.schemaVersion,
      definition,
    }).definitionHash;
    expect(() => parseStoredTemplateVersion(row)).toThrow('unsupported template schema');
  });

  it.each([1, 2, 3])(
    'V%s rejects content changed without a corresponding hash',
    (schemaVersion) => {
      const { row, definition } = fixture(schemaVersion);
      row.definitionJson = { ...definition, sessions: [{ unexpected: true }] };
      expect(() => parseStoredTemplateVersion(row)).toThrow('invalid template definition hash');
    },
  );

  it.each([1, 2, 3])(
    'V%s rejects correctly hashed but grammatically invalid content',
    (schemaVersion) => {
      const { row, definition } = fixture(schemaVersion);
      const invalid: Prisma.JsonObject = { ...definition, unknownField: true };
      row.definitionJson = invalid;
      row.definitionHash = fingerprintActivityTemplateDefinition({
        schemaVersion,
        definition: invalid,
      }).definitionHash;
      expect(() => parseStoredTemplateVersion(row)).toThrow();
    },
  );
});
