import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CORRECTION_BOUNDARY_FULL_SHAPES,
  CORRECTION_BOUNDARY_NAMED_CONSTRAINTS,
  CORRECTION_BOUNDARY_REQUIRED_CASES,
  CORRECTION_BOUNDARY_WRITERS,
} from '../../../test/helpers/correction-batch-boundary-contract';

// Structural traceability only. These checks do not install SQL or establish
// transaction safety, RLS behavior, equivalence or performance.
describe('local correction boundary candidate traceability', () => {
  const service = readFileSync(
    join(process.cwd(), 'src/modules/activities/correction-application.service.ts'),
    'utf8',
  );
  const sql = readFileSync(
    join(process.cwd(), 'test/helpers/correction-batch-boundary-candidate.sql'),
    'utf8',
  );

  it('keeps complete sources fixed while varying actual changed facts', () => {
    expect(
      CORRECTION_BOUNDARY_FULL_SHAPES.map((shape) => [
        shape.sources,
        shape.changedSegments,
        shape.bindings,
      ]),
    ).toEqual([
      [10000, 1, 10000],
      [10000, 1000, 10000],
      [10000, 10000, 10000],
    ]);
  });

  it('enumerates the direct lifecycle dependencies and operator writer separately', () => {
    expect(new Set(CORRECTION_BOUNDARY_WRITERS.map((row) => row.table)).size).toBe(11);
    expect(CORRECTION_BOUNDARY_WRITERS.find((row) => row.phase === 'legacy-cleanup')?.writer).toBe(
      'cleanup_correction_pending_segment',
    );
    expect(new Set(CORRECTION_BOUNDARY_NAMED_CONSTRAINTS).size).toBe(8);
    expect(new Set(CORRECTION_BOUNDARY_REQUIRED_CASES).size).toBe(
      CORRECTION_BOUNDARY_REQUIRED_CASES.length,
    );
  });

  it('assembles one write gate for each declared dependency and formal writer', () => {
    const relations = [
      ...sql.matchAll(
        /CREATE TRIGGER aa_r5_phase_write_gate BEFORE INSERT OR UPDATE OR DELETE ON public\."([^"]+)"/g,
      ),
    ].map((match) => match[1]);
    const expected = [
      ...CORRECTION_BOUNDARY_WRITERS.map((row) => row.table),
      'ParticipantServiceSegmentRevision',
      'ParticipantTimeAllocationRevision',
      'ParticipantTimeAllocationCommandReceipt',
    ];
    expect(relations.sort()).toEqual(expected.sort());
    expect(new Set(relations).size).toBe(relations.length);
    const preflight = sql.split('fact_relations := ARRAY[')[1]?.split('];')[0];
    if (preflight === undefined) throw new Error('database preflight relation list is missing');
    const qualified = [...preflight.matchAll(/public\."([^"]+)"/g)].map((match) => match[1]);
    expect(qualified.sort()).toEqual(expected.sort());
  });

  it('retains all eight names as phase-root obligations without claiming SQL equivalence', () => {
    const names = [
      ...sql.matchAll(
        /CREATE CONSTRAINT TRIGGER (\w+) AFTER INSERT ON public\."CorrectionWritePhase"/g,
      ),
    ].map((match) => match[1]);
    expect(names.sort()).toEqual([...CORRECTION_BOUNDARY_NAMED_CONSTRAINTS].sort());
    expect(new Set(names).size).toBe(8);
  });

  it('opens prepare before pending rows and seals before the existing last audit', () => {
    const begin = service.indexOf("await beginCorrectionWritePhase(tx, application.id, 'prepare')");
    const pending = service.indexOf(
      'pendingSegmentRevisionCount = await this.prepareV3PendingSegments',
    );
    const seal = service.indexOf("await sealCorrectionWritePhase(tx, application.id, 'prepare')");
    const audit = service.indexOf('await this.audit.logPrepare(');
    expect(begin).toBeGreaterThan(0);
    expect(pending).toBeGreaterThan(begin);
    expect(seal).toBeGreaterThan(pending);
    expect(audit).toBeGreaterThan(seal);
  });

  it('leaves replay before the write phase and audit after state transitions and seal', () => {
    const replay = service.indexOf("if (application.statusCode === 'committed')");
    const begin = service.indexOf("await beginCorrectionWritePhase(tx, application.id, 'commit')");
    const materialize = service.indexOf(
      'const supersededSegmentRevisionCount = await this.materializePendingSegments',
    );
    const applied = service.indexOf(
      'await this.correctionWrites.markRequestApplied(tx, request.id)',
    );
    const seal = service.indexOf("await sealCorrectionWritePhase(tx, application.id, 'commit')");
    const audit = service.indexOf('await this.audit.logCommit(');
    expect(replay).toBeGreaterThan(0);
    expect(begin).toBeGreaterThan(replay);
    expect(materialize).toBeGreaterThan(begin);
    expect(applied).toBeGreaterThan(materialize);
    expect(seal).toBeGreaterThan(applied);
    expect(audit).toBeGreaterThan(seal);
  });
});
