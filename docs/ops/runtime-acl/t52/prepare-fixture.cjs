const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(process.argv[2]);
const load = name => fs.readFileSync(path.join(root, name), 'utf8');
const ts = require(require.resolve('typescript', { paths: [root] }));
const spec = load('test/e2e/activity-batch2-9b-ledger-read.e2e-spec.ts');
const start = spec.indexOf('  async function createLedgerFixture(');
const end = spec.indexOf("  describe('A3/A4", start);
if (start < 0 || end < start) throw Error('fixture source differs');
const helper = load('test/helpers/member-identity.fixture.ts').replace(/^import .*;$/m,'').replace(/^export /gm,'');
const program = `
const { PrismaClient, MemberStatus } = require('/app/node_modules/@prisma/client');
const { MEMBER_ORIGIN_MANUAL } = require('/app/dist/common/identity/member-origin.constant.js');
const prisma = new PrismaClient();
let organizationId, adminUserId, sequence = 0;
const SESSION_START = new Date('2020-03-01T01:00:00Z'), SESSION_END = new Date('2020-03-01T05:00:00Z');
` + helper + spec.slice(start,end) + `
async function setup() {
 const [identity] = await prisma.$queryRawUnsafe('SELECT current_database() AS db, current_user AS actor');
 if (identity.db !== 'app_test' || identity.actor !== 'postgres') throw Error('wrong fixture target');
 organizationId = (await prisma.organization.create({data:{name:'t52 isolated fixture',nodeTypeCode:'trial'}})).id;
 adminUserId = (await prisma.user.create({data:{username:'t52-disabled-reference',passwordHash:'!',status:'DISABLED'}})).id;
 const own = await createLedgerFixture({batchStatus:'committed',ledgerDate:'2020-07-01'});
 const pending = await createLedgerFixture({batchStatus:'ready',ledgerDate:'2020-07-02',memberId:own.memberId});
 const other = await createLedgerFixture({batchStatus:'committed',ledgerDate:'2020-07-03'});
 console.log(JSON.stringify({own,pending,other}));
}
setup().catch(e=>{console.error('setup failed',e.code || e.name);process.exitCode=1}).finally(()=>prisma.$disconnect());
`;
fs.writeFileSync(process.argv[3],ts.transpileModule(program,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText);
