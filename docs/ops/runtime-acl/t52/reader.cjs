const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { PrismaClient } = require('/app/node_modules/@prisma/client');
const { LedgerQueryService } = require('/app/dist/modules/activities/ledger-query.service.js');
const client = new PrismaClient();
async function run() {
  const [identity] = await client.$queryRawUnsafe("SELECT current_database() AS db, current_user AS actor, rolsuper AS superuser, pg_get_userbyid(datdba) = current_user AS owns_db FROM pg_roles, pg_database WHERE rolname = current_user AND datname = current_database()");
  assert.deepEqual(identity, { db: 'app_test', actor: 't52_ledger_reader', superuser: false, owns_db: false });
  const { own, pending, other } = JSON.parse(readFileSync(0, 'utf8'));
  const service = new LedgerQueryService(client);
  const page = (member, extra = {}) => service.listCommittedEntriesForMemberPage(member, { page: 1, pageSize: 20, ...extra });
  if (process.argv[2] === 'revoked') {
    await assert.rejects(page(own.memberId), e => e.code === 'P2010' && e.meta?.code === '42501');
    console.log(JSON.stringify({ after_revoke: '42501', assertion_exit: 0 }));
    return;
  }
  const mine = await page(own.memberId);
  assert.deepEqual(mine.items.map(r => r.entryKey).sort(), own.entryKeys);
  assert.equal(mine.total, 2);
  const independent = await page(other.memberId);
  assert.equal(independent.total, 2);
  assert.deepEqual(independent.items.map(r => r.entryKey).sort(), other.entryKeys);
  for (const activityId of [other.activityId, pending.activityId]) {
    const filtered = await page(own.memberId, { activityId });
    assert.equal(filtered.total, 0); assert.equal(filtered.items.length, 0);
  }
  const first = await page(own.memberId, { pageSize: 1 });
  const second = await page(own.memberId, { pageSize: 1, page: 2 });
  assert.deepEqual([first.items[0].entryKey, second.items[0].entryKey].sort(), own.entryKeys);
  console.log(JSON.stringify({ runtime: identity.actor, owner: false, own_committed: mine.total, second_member_committed: independent.total, ready_hidden: true, other_activity_hidden: true, pagination: true, assertion_exit: 0 }));
}
run().catch(e => { console.error('reader assertion failed', e.code || e.name); process.exitCode = 1; }).finally(() => client.$disconnect());
