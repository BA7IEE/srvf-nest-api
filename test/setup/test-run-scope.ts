export interface TestRunPlan {
  template: string;
  workers: string[];
}

export interface TestRunIntent {
  allowedDatabases?: string;
  planOnly?: string;
  githubActions?: string;
}

// Only database identifiers are displayed. Never echo a supplied URL or invalid input.
const TEST_DB_NAME = /^app_test(?:_[a-z0-9]+)*$/;
function validName(name: string): boolean {
  return name.length <= 63 && TEST_DB_NAME.test(name);
}

export function describeTestRun(plan: TestRunPlan): string {
  if (
    !validName(plan.template) ||
    plan.workers.length === 0 ||
    plan.workers.some((name) => !validName(name))
  ) {
    throw new Error('测试运行计划含非法数据库标识，拒绝执行（不回显输入）。');
  }
  return [
    `[test-run-scope] 模板库: ${plan.template}`,
    `[test-run-scope] worker 库: ${plan.workers.join(', ')}`,
    '动作: 准备模板库、执行 migration、重建 worker 库、清理 tmp/storage-w*；结束时回收 worker 库。',
    '范围: 仅共享 globalSetup/Teardown；具名测试的 scratch 库须另行核对。',
  ].join('\n');
}

export function assertTestRunScope(plan: TestRunPlan, intent: TestRunIntent): void {
  const description = describeTestRun(plan);
  if (intent.planOnly === '1') {
    throw new Error(`仅预览，未运行测试、未操作数据库（预期非零退出）。\n${description}`);
  }
  if (intent.planOnly !== undefined && intent.planOnly !== '0') {
    throw new Error('SRVF_TEST_RUN_PLAN_ONLY 仅接受 0 或 1；拒绝执行。');
  }
  // Compatibility with the existing isolated GitHub Actions jobs. This is an
  // accidental-local-execution guard, not an authentication/authorization boundary.
  if (intent.allowedDatabases === undefined && intent.githubActions === 'true') return;
  if (intent.allowedDatabases === undefined) {
    throw new Error(
      `本地测试缺少 SRVF_TEST_RUN_SCOPE；须使用维护者已批准的库清单，不能自行授权。\n${description}`,
    );
  }
  const allowed = intent.allowedDatabases.split(',').map((name) => name.trim());
  if (allowed.some((name) => !validName(name))) {
    throw new Error(
      'SRVF_TEST_RUN_SCOPE 必须是逗号分隔的完整测试库名，不接受空项、通配符或连接串。',
    );
  }
  const missing = [plan.template, ...plan.workers].filter((name) => !allowed.includes(name));
  if (missing.length > 0) {
    throw new Error(
      `测试目标超出已声明范围: ${missing.join(', ')}。未操作数据库。\n${description}`,
    );
  }
}
