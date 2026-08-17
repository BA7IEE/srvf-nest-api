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
      // B6 的 worker-only graph 会嵌入一份 ActivitiesModule；全局 app.get() 会错误取到
      // autoCommit=false 的 HTTP provider，入口必须精确选择 ActivityBatchWorkerModule 实例。
      expect(source).toMatch(
        /select\(ActivityBatchWorkerModule\)[\s\S]*get\(ActivityBatchWorker, \{ strict: true \}\)/,
      );
      // 性质一:两个循环都被启动。
      expect(source).toMatch(/allSettled\(\[[\s\S]*\.run\(\)[\s\S]*\.run\(\)/);
      // 性质二 🔴:**两个循环的失败模式不得耦合**。
      //   初版这条断言钉的是 `Promise.all([` —— 钉的是**机制**不是**性质**,
      //   而那个机制恰恰就是缺陷本身:`Promise.all` 任一方 reject ⇒ `bootstrap()`
      //   立刻 reject ⇒ 进程当场退出、**另一个 worker 陪葬**。
      //   实测代价:`notification-outbox.e2e-spec.ts` 那条「真实 OS child SIGKILL」
      //   收到 `null` 而不是 `SIGKILL`(子进程在被杀之前就自己没了),CI 变红。
      //   ⇒ 改为**正面钉 allSettled + 反面禁 Promise.all**,把教训编进判据。
      expect(source).not.toMatch(/Promise\.all\(/);
    },
  );
});
