import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { E4_MIGRATION_144 } from './e4-migration-prefix';
import {
  E4_REAL_SOURCE_C,
  sourceJoinFunction,
  verifyRealSourceMigrationSource,
} from '../diagnostics/e4-prepare-cost.diagnostic-spec';

describe('E4 source bucket lateral migration144 identity and scope', () => {
  const sql = readFileSync(
    resolve(__dirname, '../../prisma/migrations', E4_MIGRATION_144, 'migration.sql'),
    'utf8',
  );
  it('installs precisely the C definition validated at800f3f3d', () => {
    const definitions = [
      ...sql.matchAll(/CREATE OR REPLACE FUNCTION e4_source_rows\([\s\S]*?\n\$\$;/gu),
    ];
    expect(definitions).toHaveLength(1);
    const definition = definitions[0][0].replace('CREATE OR REPLACE FUNCTION', 'CREATE FUNCTION');
    expect(definition === sourceJoinFunction(true, 'C')).toBe(true);
    expect(createHash('sha256').update(definition).digest('hex')).toBe(
      E4_REAL_SOURCE_C.definitionSha256,
    );
    expect(createHash('md5').update(definition.split('$$')[1]).digest('hex')).toBe(
      E4_REAL_SOURCE_C.sourceFunctionMd5,
    );
    expect(
      sql
        .replace(definitions[0][0], '')
        .split('\n')
        .every(
          (line) => !line.trim() || line.startsWith('--') || ['BEGIN;', 'COMMIT;'].includes(line),
        ),
    ).toBe(true);
  });
  it('keeps143 pinned and adds an independent144 checksum without settings or guard changes', () => {
    expect(() => verifyRealSourceMigrationSource()).not.toThrow();
    expect(createHash('sha256').update(sql).digest('hex')).toBe(E4_REAL_SOURCE_C.migrationSha256);
    expect(sql).not.toMatch(/^(?:ANALYZE|ALTER|DROP|SET|CREATE (?:CONSTRAINT )?TRIGGER)\b/gmu);
  });
});
