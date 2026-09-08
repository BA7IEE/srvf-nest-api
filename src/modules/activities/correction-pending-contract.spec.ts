import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Structural checks only. Transactional correctness is covered by real PG E2E.
describe('pending segment storage boundary (structural)', () => {
  const schema = readFileSync(join(process.cwd(), 'prisma/schema.prisma'), 'utf8');
  it.each([
    'CorrectionPendingSegmentRevision',
    'CorrectionSegmentPreparationReceipt',
    'CorrectionSegmentCleanupReceipt',
  ])('%s does not invent a parallel state machine', (model) => {
    const body = schema.split(`model ${model} {`)[1]?.split('\n}')[0];
    expect(body).toBeDefined();
    expect(body).not.toMatch(/\bstatusCode\b/);
  });
  it('durable receipts contain neither personal intervals nor per-person identifiers', () => {
    for (const model of [
      'CorrectionSegmentPreparationReceipt',
      'CorrectionSegmentCleanupReceipt',
    ]) {
      const body = schema.split(`model ${model} {`)[1]?.split('\n}')[0];
      expect(body).toBeDefined();
      expect(body).not.toMatch(/\b(checkInAt|checkOutAt|participationIdentityId|payloadHash)\b/);
    }
  });
});
