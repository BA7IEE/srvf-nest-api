import { instanceToPlain, plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AdminCreateActivityMetricDefinitionDto } from './dto/admin/activity-metric-definition.dto';
import { parseActivityMetricDefinition } from './activity-metric-definition';
const configs = [
  { kindCode: 'non_negative_integer', unit: '人', minimum: 0, maximum: 100 },
  { kindCode: 'non_negative_decimal', unit: '小时', scale: 2, minimum: '0', maximum: '100' },
  { kindCode: 'boolean', unit: null },
  { kindCode: 'short_text', unit: null, maxLength: 100 },
  { kindCode: 'single_choice', unit: null, options: [{ code: 'yes', label: '是' }] },
];
describe('definition HTTP DTO → D1 parser', () => {
  it.each(configs)(
    'preserves $kindCode exact document through class transformation',
    async (configuration) => {
      const definition = {
        schemaVersion: 1,
        code: 'count',
        version: 1,
        name: '指标',
        configuration,
      };
      const dto = plainToInstance(AdminCreateActivityMetricDefinitionDto, {
        operationKey: 'create-one',
        definition,
      });
      expect(await validate(dto, { whitelist: true, forbidNonWhitelisted: true })).toEqual([]);
      expect(parseActivityMetricDefinition(instanceToPlain(dto.definition))).toEqual(definition);
    },
  );
  it('rejects extra fields including wrong-kind configuration fields', async () => {
    const dto = plainToInstance(AdminCreateActivityMetricDefinitionDto, {
      operationKey: 'create-one',
      definition: {
        schemaVersion: 1,
        code: 'count',
        version: 1,
        name: '指标',
        configuration: { kindCode: 'boolean', unit: null, maximum: 1 },
      },
    });
    expect(await validate(dto, { whitelist: true, forbidNonWhitelisted: true })).not.toEqual([]);
  });
});
