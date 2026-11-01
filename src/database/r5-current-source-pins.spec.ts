import { Prisma } from '@prisma/client';
import {
  r5CurrentBusinessTableNames,
  r5CurrentE4SourcePins,
} from '../../test/helpers/r5-current-source-pins';

describe('SQL155 source expectations and generated client boundary', () => {
  it('derives the current complete-body pin from frozen source, not database metadata', () => {
    expect(r5CurrentE4SourcePins()).toEqual({
      count: 155,
      pin: '8922a6d0c4642ba1c99f679cb9581065',
    });
  });
  it('requires the exact physical table set including both SQL-owned enforcement tables', () => {
    const names = r5CurrentBusinessTableNames();
    expect(names).toContain('CorrectionApprovedInputItem');
    expect(names).toContain('CorrectionWritePhase');
    expect(names).not.toContain('_prisma_migrations');
    expect(new Set(names).size).toBe(names.length);
  });
  it('does not expose SQL-owned tables or revision and relation inputs to the generated client', () => {
    const models = Prisma.dmmf.datamodel.models;
    expect(models.map((model) => model.name)).not.toContain('CorrectionApprovedInputItem');
    expect(models.map((model) => model.name)).not.toContain('CorrectionWritePhase');
    expect(
      models
        .find((model) => model.name === 'AttendanceCorrectionRequest')
        ?.fields.map((field) => field.name),
    ).not.toContain('r5SourceRevision');
    expect(
      models
        .find((model) => model.name === 'CorrectionApplication')
        ?.fields.map((field) => field.name),
    ).not.toContain('writePhases');
  });
});
