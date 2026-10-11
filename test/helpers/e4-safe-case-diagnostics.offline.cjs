'use strict';
const assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os');
const api = require('./e4-safe-case-diagnostics.cjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'srvf-e4-safe-protocol-selftest-'));
fs.chmodSync(root, 0o700);
const fixture = 'test("passes",()=>{});\ntest("safe assertion",()=>{});\n';
fs.writeFileSync(path.join(root, 'fixture.test.cjs'), fixture, {
  mode: 0o600,
  flag: 'wx',
});
fs.mkdirSync(path.join(root, 'test'));
fs.writeFileSync(path.join(root, 'test/unexecuted.cjs'), '// unexecuted\n', {
  flag: 'wx',
});
const catalog = {
  schema: 'srvf-e4-case-catalog/v1',
  sourceHead: '2e5828715a9fd7238b7ab73416dcffa1d9f32efc',
  files: [{ file: 'fixture.test.cjs', sha256: api.sha(fixture) }],
  cases: [{ file: 'fixture.test.cjs', line: 2, column: 1, name: 'safe assertion' }],
};
const binding = {
  head: catalog.sourceHead,
  run: '38150890270',
  attempt: '1',
  stage: 'd0',
};
const counts = {
  numPassedTests: 1,
  numFailedTests: 1,
  numPendingTests: 1,
  numTotalTestSuites: 1,
  numPassedTestSuites: 0,
  numFailedTestSuites: 1,
  numRuntimeErrorTestSuites: 0,
};
const result = () => ({
  ...counts,
  testResults: [
    {
      testFilePath: path.join(root, 'fixture.test.cjs'),
      testResults: [
        { status: 'passed' },
        { status: 'pending' },
        {
          status: 'failed',
          fullName: 'PRIVATE_DYNAMIC_NAME',
          location: { line: 2, column: 1 },
          failureMessages: ['PRIVATE_MESSAGE'],
          failureDetails: [
            {
              name: 'Error',
              message: 'PRIVATE_BODY',
              stack: 'PRIVATE_STACK',
              matcherResult: {
                actual: 'PRIVATE_ACTUAL',
                expected: 'PRIVATE_EXPECTED',
              },
            },
          ],
        },
      ],
    },
  ],
});
let checks = 0;
const check = (name, fn) => {
  fn();
  checks++;
};
const noPrivate = (r) => assert(!JSON.stringify(r).includes('PRIVATE_'));
check('known case uses catalog name and structural category', () => {
  const r = api.build(result(), catalog, binding, root);
  assert.equal(r.status, 'COMPLETE');
  assert.equal(r.failures[0].name, 'safe assertion');
  assert.equal(r.failures[0].category, 'ASSERTION');
  assert(api.validate(r, catalog, binding));
  noPrivate(r);
});
check('wrong column produces only fixed unreviewed identifier', () => {
  const source = result();
  source.testResults[0].testResults[2].location.column = 2;
  const r = api.build(source, catalog, binding, root);
  assert.equal(r.status, 'UNKNOWN');
  assert.equal(r.reason, 'UNREVIEWED_CASES');
  assert.equal(r.failures[0].name, 'UNREVIEWED_0001');
  assert.equal(r.failures[0].line, 0);
  assert.equal(r.failures[0].column, 0);
  assert(api.validate(r, catalog, binding));
  noPrivate(r);
});
check('missing location is numbered safely', () => {
  const source = result();
  delete source.testResults[0].testResults[2].location;
  const r = api.build(source, catalog, binding, root);
  assert.equal(r.failures[0].name, 'UNREVIEWED_0001');
  assert(api.validate(r, catalog, binding));
  noPrivate(r);
});
check('unknown title never serializes dynamic fullname', () => {
  const source = result();
  source.testResults[0].testResults[2].fullName =
    'PRIVATE_USER person@private.invalid https://private.invalid/token';
  source.testResults[0].testResults[2].location.line = 999;
  const r = api.build(source, catalog, binding, root);
  assert.equal(r.status, 'UNKNOWN');
  assert.equal(r.counts.numFailedTests, 1);
  assert.equal(r.failures.length, 1);
  assert(!JSON.stringify(r).includes('private.invalid'));
  noPrivate(r);
});
check('structured type classifier', () =>
  assert.equal(api.category([{ name: 'TypeError', message: 'PRIVATE_BODY' }]), 'TYPE_ERROR'),
);
check('structured database classifier', () =>
  assert.equal(api.category([{ code: 'P2028', message: 'PRIVATE_BODY' }]), 'DATABASE_TRANSACTION'),
);
check('message text is never used to guess categories', () =>
  assert.equal(api.category([{ name: 'Error', message: 'Timeout PRIVATE_LEASE' }]), 'UNCLASSIFIED'),
);
check('mixed structured categories remain unclassified', () =>
  assert.equal(api.category([{ name: 'TypeError' }, { code: '57014' }]), 'UNCLASSIFIED'),
);
check('count mismatch fails closed', () => {
  const source = result();
  source.numFailedTests = 2;
  assert.equal(api.build(source, catalog, binding, root).reason, 'COUNTS');
});
check('changed source hash fails closed', () => {
  const c = structuredClone(catalog);
  c.files[0].sha256 = '0'.repeat(64);
  assert.equal(api.build(result(), c, binding, root).reason, 'SOURCE_HASH');
});
check('wrong source head rejected', () => {
  const c = structuredClone(catalog);
  c.sourceHead = '0'.repeat(40);
  assert.equal(api.build(result(), c, binding, root).reason, 'CATALOG');
});
check('unlisted filename cannot leak', () => {
  const source = result();
  source.testResults[0].testFilePath = path.join(root, 'PRIVATE_FILE');
  const r = api.build(source, catalog, binding, root);
  assert.equal(r.reason, 'STRUCTURE');
  noPrivate(r);
});
check('duplicate catalog coordinate rejected', () => {
  const c = structuredClone(catalog);
  c.cases.push(c.cases[0]);
  assert.equal(api.build(result(), c, binding, root).reason, 'CATALOG');
});
check('65 failures rejected without truncation', () => {
  const source = result(),
    failed = source.testResults[0].testResults[2];
  source.testResults[0].testResults.push(
    ...Array.from({ length: 64 }, () => structuredClone(failed)),
  );
  source.numFailedTests = 65;
  assert.equal(api.build(source, catalog, binding, root).reason, 'CASE_LIMIT');
});
check('parameterized failures have separate occurrences', () => {
  const source = result();
  source.testResults[0].testResults.push(structuredClone(source.testResults[0].testResults[2]));
  source.numFailedTests = 2;
  const r = api.build(source, catalog, binding, root);
  assert.deepEqual(
    r.failures.map((x) => x.occurrence),
    [1, 2],
  );
  assert(api.validate(r, catalog, binding));
  noPrivate(r);
});
check('suite errors preserve only structural category', () => {
  const source = {
    ...counts,
    numPassedTests: 0,
    numFailedTests: 0,
    numPendingTests: 0,
    numRuntimeErrorTestSuites: 1,
    testResults: [
      {
        testFilePath: path.join(root, 'fixture.test.cjs'),
        testResults: [],
        testExecError: { name: 'SyntaxError', message: 'PRIVATE_SQL' },
      },
    ],
  };
  const r = api.build(source, catalog, binding, root);
  assert.equal(r.suiteFailures[0].category, 'SYNTAX_ERROR');
  assert(api.validate(r, catalog, binding));
  noPrivate(r);
});
check('invalid binding not echoed', () => {
  const r = api.build(result(), catalog, { ...binding, head: 'PRIVATE_BINDING' }, root);
  assert.equal(r.binding, null);
  noPrivate(r);
});
check('unexecuted suite after bail is counted', () => {
  const c = structuredClone(catalog);
  c.files.push({
    file: 'test/unexecuted.cjs',
    sha256: api.sha(fs.readFileSync(path.join(root, 'test/unexecuted.cjs'))),
  });
  const source = result();
  source.numTotalTestSuites = 2;
  const r = api.build(source, c, binding, root);
  assert.equal(r.status, 'COMPLETE');
  assert.equal(r.unexecutedSuites, 1);
  assert(api.validate(r, c, binding));
});
check('64KiB artifact bound rejects entire payload', () => {
  const c = structuredClone(catalog);
  c.cases[0].name = '测'.repeat(768);
  const source = result(),
    failed = source.testResults[0].testResults[2];
  source.testResults[0].testResults.push(
    ...Array.from({ length: 63 }, () => structuredClone(failed)),
  );
  source.numFailedTests = 64;
  assert.equal(api.build(source, c, binding, root).reason, 'ARTIFACT_LIMIT');
});
check('failed table row retains ordinal including passing rows', () => {
  const source = result();
  source.testResults[0].testResults[0].location = { line: 2, column: 1 };
  const r = api.build(source, catalog, binding, root);
  assert.equal(r.failures[0].occurrence, 2);
  assert(api.validate(r, catalog, binding));
});
check('fixed unknown artifact validates as unknown', () => {
  const r = api.unknown(binding, 'STRUCTURE');
  assert.equal(r.status, 'UNKNOWN');
  assert(api.validate(r, catalog, binding));
});
for (const mutate of [
  (r) => (r.binding.head = '0'.repeat(40)),
  (r) => (r.sourceHead = '0'.repeat(40)),
  (r) => (r.failures[0].name = 'PRIVATE_OVERRIDE'),
  (r) => (r.failures[0].message = 'PRIVATE_EXTRA'),
  (r) => (r.failures[0].category = 'PRIVATE_CATEGORY'),
  (r) => (r.failures[0].occurrence = 0),
  (r) => (r.failures = []),
  (r) => (r.sourceDigests[0].sha256 = '0'.repeat(64)),
  (r) => (r.extra = 'PRIVATE_EXTRA'),
  (r) => (r.counts.numFailedTestSuites = 0),
  (r) => (r.failures[0].line = '2'),
])
  check('reader rejects mutated proof', () => {
    const r = api.build(result(), catalog, binding, root);
    mutate(r);
    assert.equal(api.validate(r, catalog, binding), false);
  });
for (const mutate of [
  (r) => (r.failures[0].name = 'PRIVATE_UNKNOWN'),
  (r) => (r.failures[0].column = 2),
  (r) => (r.status = 'COMPLETE'),
])
  check('reader rejects unsafe unknown case', () => {
    const source = result();
    source.testResults[0].testResults[2].location.column = 2;
    const r = api.build(source, catalog, binding, root);
    mutate(r);
    assert.equal(api.validate(r, catalog, binding), false);
  });
// Only the directory created above is cleaned; no repository, database or unknown resource is touched.
fs.rmSync(root, { recursive: true, force: false });
process.stdout.write(JSON.stringify({ status: 'PASS', checks }) + '\n');
