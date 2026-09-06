import { instanceToPlain, plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AdminCreateActivityMetricSetDto } from './dto/admin/activity-metric-set.dto';
import { parseActivityMetricSetDefinition } from './activity-metric-set-definition';
describe('set HTTP DTO → D1 parser', () => {
  it('preserves empty draft and exact references', async () => {
    for (const items of [
      [],
      [
        {
          key: 'count',
          sortOrder: 0,
          required: true,
          metricDefinitionId: 'metric_id',
          definitionHash: 'a'.repeat(64),
        },
      ],
    ]) {
      const definition = { schemaVersion: 1, code: 'set_one', version: 1, name: '指标集', items };
      const dto = plainToInstance(AdminCreateActivityMetricSetDto, {
        operationKey: 'one',
        definition,
      });
      expect(await validate(dto, { whitelist: true, forbidNonWhitelisted: true })).toEqual([]);
      expect(parseActivityMetricSetDefinition(instanceToPlain(dto.definition))).toEqual(definition);
    }
  });
  it('rejects unbounded items at DTO and parser boundaries', async () => {
    const definition = {
      schemaVersion: 1,
      code: 'set_one',
      version: 1,
      name: '指标集',
      items: Array.from({ length: 101 }, (_, i) => ({
        key: 'k_' + i,
        sortOrder: i,
        required: true,
        metricDefinitionId: 'id_' + i,
        definitionHash: 'a'.repeat(64),
      })),
    };
    const dto = plainToInstance(AdminCreateActivityMetricSetDto, {
      operationKey: 'one',
      definition,
    });
    expect(await validate(dto, { whitelist: true, forbidNonWhitelisted: true })).not.toEqual([]);
    expect(() => parseActivityMetricSetDefinition(instanceToPlain(dto.definition))).toThrow();
  });
});
