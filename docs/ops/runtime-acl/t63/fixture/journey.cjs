const fs = require('node:fs'),
  assert = require('node:assert/strict');
const base = 'https://t63.test',
  fixture = require('/fixture.json'),
  dir = '/state';
const file = dir + '/session.json',
  state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : {};
function save() {
  fs.writeFileSync(file, JSON.stringify(state), { mode: 0o600 });
}
async function call(step, who, route, body, status = 200, code = 0, verify = () => true) {
  if (state[step]) return state[step].data;
  const headers = {
    origin: base,
    'sec-fetch-site': 'same-origin',
    'content-type': 'application/json',
  };
  if (who) {
    const session = state['login-' + who];
    assert(session, 'missing login ' + who);
    headers.authorization = 'Bearer ' + session.data.accessToken;
  }
  const r = await fetch(base + route, {
    method: body === undefined ? 'GET' : 'POST',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = await r.json();
  const reqId = r.headers.get('x-request-id');
  const ok = r.status === status && j.code === code && !!reqId && verify(j.data);
  console.log(
    JSON.stringify({
      step,
      who: who || step.replace('login-', ''),
      route,
      reqId,
      http: r.status,
      code: j.code,
      expected: [status, code],
      ok,
      rows: j.data?.items?.length,
      ledgerPostingBatchId: j.data?.ledgerPostingBatchId,
      closureRevisionId: j.data?.closureRevisionId,
      replayed: j.data?.replayed,
      checksPassed: j.data?.checks?.filter((c) => c.passed).length,
      checksTotal: j.data?.checks?.length,
      at: new Date().toISOString(),
    }),
  );
  assert(ok, step + ' ' + r.status + '/' + j.code);
  state[step] = { reqId, data: j.data || {} };
  save();
  return j.data;
}
async function main() {
  const a = fixture.activity,
    managed = '/api/app/v1/my/managed-activities/' + a,
    path = managed + '/settlement/',
    key = (s) => 't63-' + s + '-' + a;
  for (const who of ['member', 'other', 'owner', 'first', 'final']) {
    const route = '/api/auth/v1/' + (who === 'member' ? 'h5/' : '') + 'login';
    await call(
      'login-' + who,
      null,
      route,
      { username: 't63_' + who, password: process.env['PASS_' + who.toUpperCase()] },
      200,
      0,
      (d) => !!d.accessToken,
    );
  }
  const seal = await call(
    'seal',
    'owner',
    managed + '/evidence-seals',
    {},
    200,
    0,
    (d) => !!d.sealId,
  );
  await call(
    'generate-denied',
    'other',
    path + 'generate',
    { operationKey: key('forbidden') },
    403,
    30100,
  );
  const gen = await call(
    'generate',
    'owner',
    path + 'generate',
    { operationKey: key('generate') },
    200,
    0,
    (d) => d.outcome === 'draft',
  );
  const sub = await call(
    'submit',
    'owner',
    path + 'submit',
    {
      operationKey: key('submit'),
      expectedDraftVersion: gen.settlementVersion,
      evidenceSealId: seal.sealId,
      confirmation: true,
    },
    200,
    0,
    (d) => !!d.settlementVersionId,
  );
  const exp = Object.fromEntries(
    [
      'evidenceSealId',
      'evidenceRevision',
      'populationRevision',
      'workflowRevision',
      'contentHash',
    ].map((k) => [k, sub[k]]),
  );
  const p = '/api/admin/v1/attendance-settlements/' + sub.settlementVersionId + '/';
  await call(
    'first-review-denied',
    'other',
    p + 'first-approve',
    { operationKey: key('denied'), ...exp },
    403,
    30100,
  );
  await call(
    'first-review',
    'first',
    p + 'first-approve',
    { operationKey: key('first'), ...exp },
    200,
    0,
    (d) => d.stageCode === 'first',
  );
  const final = await call(
    'final-review',
    'final',
    p + 'final-approve',
    { operationKey: key('final'), ...exp },
    200,
    0,
    (d) => !!d.ledgerPostingBatchId,
  );
  if (process.argv[2] === 'approve') return;
  const close = {
    operationKey: key('close'),
    expectedSettlementVersionId: sub.settlementVersionId,
    expectedPostingBatchId: final.ledgerPostingBatchId,
  };
  const c = await call(
    'close',
    'owner',
    path + 'close',
    close,
    200,
    0,
    (d) =>
      d.outcome === 'closed' &&
      d.replayed === false &&
      d.checks.length > 0 &&
      d.checks.every((x) => x.passed),
  );
  await call(
    'close-repeat',
    'owner',
    path + 'close',
    close,
    200,
    0,
    (d) =>
      d.replayed === true && d.closureRevisionId === c.closureRevisionId && !!c.closureRevisionId,
  );
  const ledger = '/api/app/v1/my/participation-ledger?activityId=' + a;
  await call(
    'self-ledger',
    'member',
    ledger,
    undefined,
    200,
    0,
    (d) => d.total === 2 && d.items.length === 2 && d.items.every((x) => x.activityId === a),
  );
  await call(
    'other-self-ledger',
    'other',
    ledger,
    undefined,
    200,
    0,
    (d) => d.total === 0 && d.items.length === 0,
  );
  await call(
    'other-member-ledger-denied',
    'other',
    '/api/admin/v1/members/' + fixture.actors.member.member + '/participation-ledger',
    undefined,
    403,
    30100,
  );
  await call('anonymous-denied', null, ledger, undefined, 401, 40100);
}
main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
