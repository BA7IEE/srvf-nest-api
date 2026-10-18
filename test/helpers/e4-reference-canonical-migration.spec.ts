import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { E4_MIGRATION_137, E4_MIGRATION_139 } from './e4-migration-prefix';

describe('E4 reference canonical migration scope', () => {
  it('changes only the source canonical expression and preserves the frozen function body', () => {
    const original = readFileSync(
      resolve(__dirname, '../../prisma/migrations', E4_MIGRATION_137, 'migration.sql'),
      'utf8',
    );
    const candidate = readFileSync(
      resolve(__dirname, '../../prisma/migrations', E4_MIGRATION_139, 'migration.sql'),
      'utf8',
    );
    const oldDefinitions = [
      ...original.matchAll(
        /CREATE FUNCTION e4_expected_evaluations\(revision_id TEXT\)[\s\S]*?\n\$\$;/gu,
      ),
    ];
    const newDefinitions = [
      ...candidate.matchAll(
        /CREATE OR REPLACE FUNCTION e4_expected_evaluations\(revision_id TEXT\)[\s\S]*?\n\$\$;/gu,
      ),
    ];
    expect(oldDefinitions).toHaveLength(1);
    expect(newDefinitions).toHaveLength(1);
    const oldDefinition = oldDefinitions[0][0];
    expect(createHash('sha256').update(oldDefinition).digest('hex')).toBe(
      '47bbe7aae8da7e51619533ff683a429121f42f0ee4c041bbc7c77d94ea53ddf0',
    );
    const sourceWindow = /\), sources AS MATERIALIZED \([\s\S]*?\n\), groups AS MATERIALIZED \(/gu;
    const oldWindows = [...oldDefinition.matchAll(sourceWindow)];
    const newWindows = [...newDefinitions[0][0].matchAll(sourceWindow)];
    expect(oldWindows).toHaveLength(1);
    expect(newWindows).toHaveLength(1);
    const restored = newDefinitions[0][0]
      .replace('CREATE OR REPLACE FUNCTION', 'CREATE FUNCTION')
      .replace(newWindows[0][0], oldWindows[0][0]);
    expect(restored === oldDefinition).toBe(true);
    expect(
      candidate
        .replace(newDefinitions[0][0], '')
        .split('\n')
        .every((line) => line.trim() === '' || line.startsWith('--')),
    ).toBe(true);
  });
});
