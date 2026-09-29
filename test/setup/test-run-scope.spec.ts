import { execSync } from 'child_process';
import * as fs from 'fs';
import globalSetup from './global-setup';
import { loadTestEnv } from './load-env';
import * as db from './test-db';
import { assertTestRunScope, describeTestRun } from './test-run-scope';

jest.mock('child_process', () => ({ execSync: jest.fn() }));
jest.mock('fs', () => ({ existsSync: jest.fn(() => false), rmSync: jest.fn() }));
jest.mock('./load-env', () => ({ loadTestEnv: jest.fn() }));
jest.mock('./test-db', () => ({
  assertTestDatabaseUrl: jest.fn(),
  ensureTemplateDatabaseExists: jest.fn(),
  assertConnectionCapacity: jest.fn(),
  assertTemplateHasNoConnections: jest.fn(),
  recreateWorkerDatabase: jest.fn(),
}));
jest.mock('./worktree-db', () => ({
  deriveTemplateTestDbName: () => 'app_test',
  deriveWorkerTestDbName: (id: number) => `app_test_w${id}`,
}));

const plan = { template: 'app_test', workers: ['app_test_w1', 'app_test_w2'] };
const complete = 'app_test,app_test_w1,app_test_w2';

describe('test run scope (no database)', () => {
  const originalEnv = process.env;
  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.SRVF_TEST_RUN_SCOPE;
    delete process.env.SRVF_TEST_RUN_PLAN_ONLY;
    delete process.env.GITHUB_ACTIONS;
    process.env.DATABASE_URL = 'postgresql://localhost/app_test';
    jest.resetAllMocks();
    jest.spyOn(console, 'info').mockImplementation(() => undefined);
  });
  afterEach(() => {
    process.env = originalEnv;
    jest.restoreAllMocks();
  });

  function expectNoMutation(): void {
    expect(db.ensureTemplateDatabaseExists).not.toHaveBeenCalled();
    expect(db.recreateWorkerDatabase).not.toHaveBeenCalled();
    expect(execSync).not.toHaveBeenCalled();
    expect(fs.rmSync).not.toHaveBeenCalled();
  }

  it.each([
    undefined,
    'app_test_w98',
    'app_test_w1,app_test_w2',
    'app_test,app_test_w1',
    '',
    'app_test,*',
    'app_test,',
    'postgresql://private-value',
  ])('rejects missing, partial or malformed local intent before mutation: %s', async (scope) => {
    if (scope !== undefined) process.env.SRVF_TEST_RUN_SCOPE = scope;
    await expect(globalSetup({ maxWorkers: 2 })).rejects.toThrow();
    expectNoMutation();
  });

  it('previews without mutation even with complete scope and GitHub Actions', async () => {
    process.env.SRVF_TEST_RUN_SCOPE = complete;
    process.env.SRVF_TEST_RUN_PLAN_ONLY = '1';
    process.env.GITHUB_ACTIONS = 'true';
    await expect(globalSetup({ maxWorkers: 2 })).rejects.toThrow('仅预览');
    expectNoMutation();
  });

  it('rejects invalid preview flags before mutation', async () => {
    process.env.SRVF_TEST_RUN_SCOPE = complete;
    process.env.SRVF_TEST_RUN_PLAN_ONLY = 'yes';
    await expect(globalSetup({ maxWorkers: 2 })).rejects.toThrow('仅接受');
    expectNoMutation();
  });

  it('preserves existing startup operations for complete local scope', async () => {
    process.env.SRVF_TEST_RUN_SCOPE = complete;
    await globalSetup({ maxWorkers: 2 });
    expect(db.assertTestDatabaseUrl).toHaveBeenCalledTimes(1);
    expect(db.ensureTemplateDatabaseExists).toHaveBeenCalledTimes(1);
    expect(execSync).toHaveBeenCalledWith('pnpm prisma migrate deploy', expect.any(Object));
    expect(db.assertConnectionCapacity).toHaveBeenCalledWith(2);
    expect(db.assertTemplateHasNoConnections).toHaveBeenCalledTimes(1);
    expect(db.recreateWorkerDatabase).toHaveBeenNthCalledWith(1, 1);
    expect(db.recreateWorkerDatabase).toHaveBeenNthCalledWith(2, 2);
  });

  it('does not let dotenv supply missing invocation intent', async () => {
    jest.mocked(loadTestEnv).mockImplementation(() => {
      process.env.SRVF_TEST_RUN_SCOPE = complete;
      process.env.GITHUB_ACTIONS = 'true';
    });
    await expect(globalSetup({ maxWorkers: 2 })).rejects.toThrow('缺少');
    expectNoMutation();
  });

  it('retains the existing database target safety check before allowing CI', async () => {
    process.env.GITHUB_ACTIONS = 'true';
    jest.mocked(db.assertTestDatabaseUrl).mockImplementation(() => {
      throw new Error('unsafe target');
    });
    await expect(globalSetup({ maxWorkers: 2 })).rejects.toThrow('目标库安全检查失败');
    expectNoMutation();
  });

  it('does not expose connection details from environment loading failures', async () => {
    jest.mocked(loadTestEnv).mockImplementation(() => {
      throw new Error('postgresql://private-connection');
    });
    await expect(globalSetup({ maxWorkers: 2 })).rejects.toThrow(
      '测试环境加载或目标库安全检查失败；请核对本机测试配置，不回显连接信息。',
    );
    expectNoMutation();
  });

  it('rejects a derived worker URL when globalSetup requires the template', async () => {
    process.env.SRVF_TEST_RUN_SCOPE = complete;
    process.env.DATABASE_URL = 'postgresql://localhost/app_test_w1';
    await expect(globalSetup({ maxWorkers: 2 })).rejects.toThrow('不是计划模板库');
    expectNoMutation();
  });

  it('keeps the established GitHub Actions startup without a local scope', async () => {
    process.env.GITHUB_ACTIONS = 'true';
    await globalSetup({ maxWorkers: 2 });
    expect(db.ensureTemplateDatabaseExists).toHaveBeenCalledTimes(1);
    expect(db.recreateWorkerDatabase).toHaveBeenCalledTimes(2);
  });

  it.each(['', 'app_test_w98'])(
    'enforces an explicit scope even on GitHub Actions: %s',
    async (scope) => {
      process.env.GITHUB_ACTIONS = 'true';
      process.env.SRVF_TEST_RUN_SCOPE = scope;
      await expect(globalSetup({ maxWorkers: 2 })).rejects.toThrow();
      expectNoMutation();
    },
  );

  it('does not mistake generic CI=true for the GitHub Actions execution mode', async () => {
    process.env.CI = 'true';
    await expect(globalSetup({ maxWorkers: 2 })).rejects.toThrow('缺少');
    expectNoMutation();
  });

  it('does not echo malformed input in errors', () => {
    expect(() =>
      assertTestRunScope(plan, { allowedDatabases: 'postgresql://private-value' }),
    ).toThrow('不接受空项、通配符或连接串');
    try {
      assertTestRunScope(plan, { allowedDatabases: 'postgresql://private-value' });
    } catch (error) {
      expect(String(error)).not.toContain('private-value');
    }
  });

  it('accepts whitespace and a previously authorized superset', () => {
    expect(() =>
      assertTestRunScope(plan, { allowedDatabases: ` ${complete}, app_test_w3 ` }),
    ).not.toThrow();
  });

  it('reports only the plan and names, not a success claim', () => {
    expect(describeTestRun(plan)).toContain('模板库: app_test');
    expect(describeTestRun(plan)).toContain('重建 worker 库');
    expect(describeTestRun(plan)).toContain('scratch 库须另行核对');
  });
});
