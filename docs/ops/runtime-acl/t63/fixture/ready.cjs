const fs = require('node:fs'),
  crypto = require('node:crypto'),
  assert = require('node:assert/strict');
(async () => {
  const base = 'https://t63.test';
  let ready;
  for (let i = 0; i < 90; i++) {
    try {
      const r = await fetch(base + '/api/system/v1/health/ready');
      const j = await r.json();
      if (r.status === 200 && j.code === 0 && j.data.db === 'up') {
        ready = {
          http: r.status,
          code: j.code,
          db: j.data.db,
          reqId: r.headers.get('x-request-id'),
        };
        break;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert(ready?.reqId, 'API not ready');
  const staticFiles = {};
  for (const [prefix, name] of [
    ['/', 'admin-26261168'],
    ['/h5/', 'h5-ae2e3b0a'],
  ]) {
    const lines = fs
      .readFileSync('/archive/' + name + '.files', 'utf8')
      .trimEnd()
      .split('\n');
    for (const line of lines) {
      const [, expected, path] = line.match(/^([0-9a-f]{64})  (.+)$/);
      const r = await fetch(
        base +
          prefix +
          (path === 'index.html' ? '' : path.split('/').map(encodeURIComponent).join('/')),
      );
      assert.equal(r.status, 200);
      assert.equal(
        crypto
          .createHash('sha256')
          .update(Buffer.from(await r.arrayBuffer()))
          .digest('hex'),
        expected,
        path,
      );
    }
    staticFiles[name] = lines.length;
  }
  assert.deepEqual(Object.values(staticFiles), [310, 40]);
  console.log(JSON.stringify({ ready, staticFiles }));
})().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
