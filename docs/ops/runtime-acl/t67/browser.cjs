// Run inside the Chrome container's private network namespace against the real HTTPS gateway.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('/playwright');
const phase = process.argv[2];
assert.ok(['installed', 'withdrawn'].includes(phase));
const origin = 'https://t63.test';
const login = '/api/auth/v1/h5/login';
const me = '/api/app/v1/me';
const capabilities = me + '/capabilities';
const refresh = '/api/auth/v1/h5/refresh';

async function main() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const context = await browser.newContext({
    serviceWorkers: 'block',
    viewport: { width: 1120, height: 800 },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const report = { phase, chrome: browser.version(), origin, responses: [], pageChecks: [] };
  const body = {};
  async function capture(paths, action) {
    const pending = paths.map((path) => page.waitForResponse((r) => r.url() === origin + path));
    const [responses] = await Promise.all([Promise.all(pending), action()]);
    for (const response of responses) {
      const path = new URL(response.url()).pathname;
      const data = await response.json();
      const reqId = await response.headerValue('x-request-id');
      assert.ok(reqId);
      report.responses.push({ path, http: response.status(), code: data.code, reqId });
      const denied = phase === 'withdrawn' && [capabilities, refresh].includes(path);
      assert.deepEqual([response.status(), data.code], denied ? [500, 50000] : [200, 0]);
      if (path === me) {
        assert.equal(data.data.username, 't63_member');
        assert.equal(data.data.role, 'USER');
        assert.ok(data.data.memberId && data.data.userId);
        if (body.memberId) assert.equal(data.data.memberId, body.memberId);
        body.memberId = data.data.memberId;
      }
      if (path === capabilities && !denied) {
        assert.equal(data.data.account.canUseApp, true);
        assert.equal(data.data.managed.canManageManagedRegistrations, false);
        assert.equal(data.data.managed.canSubmitManagedAttendance, false);
      }
    }
  }
  async function accountPage(step) {
    await page.waitForURL('**/#/my');
    await page.getByRole('heading', { name: 't63_member', exact: true }).waitFor();
    assert.equal(await page.getByPlaceholder('请输入账号').count(), 0);
    report.pageChecks.push({ step, route: '/my', syntheticMemberVisible: true });
    await page.screenshot({ path: '/out/' + step + '.png' });
  }
  try {
    await page.goto(origin + '/h5/#/my');
    const username = page.getByPlaceholder('请输入账号');
    await username.fill('t63_member');
    await page.getByPlaceholder('请输入密码').fill(process.env.PASS_MEMBER);
    assert.ok(await page.evaluate(() => isSecureContext && !!navigator.locks));
    await capture([login, me, capabilities], () =>
      page.getByRole('button', { name: '登录', exact: true }).click(),
    );
    if (phase === 'installed') {
      await accountPage('after-login');
      const cookies = (await context.cookies()).filter((c) => c.httpOnly);
      assert.equal(cookies.length, 1);
      const original = cookies[0];
      assert.ok(original.secure && original.sameSite === 'Strict');
      await capture([refresh, me, capabilities], () => page.reload());
      await accountPage('after-refresh');
      const rotated = (await context.cookies()).find((c) => c.name === original.name);
      assert.ok(
        rotated &&
          rotated.value !== original.value &&
          rotated.httpOnly &&
          rotated.secure &&
          rotated.sameSite === 'Strict',
      );
      report.rotatedCookie = true;
    } else {
      await page.getByText('服务拒绝当前操作，请重新核对状态', { exact: true }).waitFor();
      await capture([refresh], () => page.reload());
      await username.waitFor();
      report.pageChecks.push({ step: 'withdrawn', loginFormVisible: true });
    }
  } finally {
    fs.writeFileSync('/out/' + phase + '.json', JSON.stringify(report, null, 2) + '\n');
    await context.close();
    await browser.close();
  }
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
