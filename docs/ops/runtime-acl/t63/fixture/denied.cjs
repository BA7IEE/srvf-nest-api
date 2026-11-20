const assert = require('node:assert/strict'),
  { PrismaClient } = require('/app/node_modules/@prisma/client');
const db = new PrismaClient();
(async () => {
  const [table, expected] = process.argv.slice(2);
  const [id] =
    await db.$queryRaw`SELECT current_database() AS db,current_user AS role,session_user AS login`;
  assert.deepEqual(id, { db: 't63_lab', role: expected, login: expected });
  assert(['throttler_buckets', 'ActivityBatchJob'].includes(table));
  let state;
  try {
    await db.$queryRawUnsafe('SELECT id FROM public."' + table + '" LIMIT 1');
  } catch (e) {
    state = e.meta?.code;
  }
  assert.equal(state, '42501');
  console.log(JSON.stringify({ ...id, table, sqlstate: state }));
})()
  .catch((e) => {
    console.error(e.name, e.code);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
