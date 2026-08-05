import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('ActivityBatchWorker process registration', () => {
  const root = join(__dirname, '..', '..', '..');
  const read = (relativePath: string): string => readFileSync(join(root, relativePath), 'utf8');

  it.each([
    'src/modules/notifications/notification-outbox-worker.module.ts',
    'src/modules/attachments/storage-consistency-worker.module.ts',
  ])('%s imports the activity worker provider graph', (relativePath) => {
    expect(read(relativePath)).toMatch(/ActivityBatchWorkerModule/);
  });

  it.each(['src/notification-outbox-worker.ts', 'src/storage-consistency-worker.ts'])(
    '%s starts the activity loop alongside the existing loop',
    (relativePath) => {
      const source = read(relativePath);
      expect(source).toMatch(/app\.get\(ActivityBatchWorker\)/);
      expect(source).toMatch(/Promise\.all\(\[[\s\S]*\.run\(\)[\s\S]*\.run\(\)/);
    },
  );
});
