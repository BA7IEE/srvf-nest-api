import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { AppModule } from './src/app.module';
import { PrismaService } from './src/database/prisma.service';
import { AppManagedActivitiesService } from './src/modules/activities/app-managed-activities.service';
import { strict as assert } from 'node:assert';
import { appendFileSync } from 'node:fs';
async function run() {
 const root=new PrismaClient({datasourceUrl:process.env.LAB_OWNER});
 const db=new PrismaClient({log:[{emit:'event',level:'query'}]});
 db.$on('query', e=>appendFileSync(process.env.TRACE!,e.query+'\n'));
 const mod=await Test.createTestingModule({imports:[AppModule]}).overrideProvider(PrismaService).useValue(db).compile();
 try {
 const svc=mod.get(AppManagedActivitiesService);
 const rootOrg=await root.organization.create({data:{name:'Lab',nodeTypeCode:'group'}});
 const org=await root.organization.create({data:{name:'Lab team',nodeTypeCode:'group',parentId:rootOrg.id}});
 const m=await root.member.create({data:{memberNo:'lab',realName:'fixture',memberOriginCode:'manual',memberSinceDate:new Date(),gradeCode:'level-1'}});
 const u=await root.user.create({data:{username:'lab',passwordHash:'nonlogin',memberId:m.id}});
 await root.memberOrganizationMembership.create({data:{memberId:m.id,organizationId:org.id}});
 await root.dictType.create({data:{code:'activity_type',label:'Training',items:{create:{code:'training',label:'Training'}}}});
 const actor={id:u.id,memberId:m.id,role:'USER'} as any;
 const create=(title:string)=>svc.create({title,organizationId:org.id,activityTypeCode:'training',allocationModeCode:'first_come',startAt:'2099-01-01T00:00:00Z',endAt:'2099-01-02T00:00:00Z',location:'lab',isPublicRegistration:false},actor,{} as any);
 const ddl=(s:string)=>root.$executeRawUnsafe(s);
 async function reject(title:string,pattern:RegExp) {
   try {await create(title)} catch(e:any){assert(pattern.test(String(e)) || pattern.test(JSON.stringify(e))); return}
   throw Error('unexpected success');
 }
 const updateColumns = () => db.$queryRawUnsafe("SELECT attname::text AS col FROM pg_attribute WHERE attrelid='public.\"Activity\"'::regclass AND attnum>0 AND NOT attisdropped AND has_column_privilege(current_user,attrelid,attnum,'UPDATE') ORDER BY attnum");
 const beforeUpdate = await updateColumns();
 const ins=process.env.INS!, sel=process.env.SEL!;
 await reject('baseline',/permission denied|denied access/i);
 assert.equal(await root.activity.count(),0);
 await ddl(ins);
 await reject('read-gap',/permission denied|denied access/i);
 assert.equal(await root.activity.count({where:{title:'read-gap'}}),1);
 await ddl(sel);
 assert.deepEqual(await updateColumns(),beforeUpdate);
 console.log('PASS effective UPDATE columns unchanged');
 const result=await create('positive');
 const id=result.activity.id;
 assert.equal(result.initiator?.id,m.id);
 assert.equal(await root.activity.count({where:{id,title:'positive',initiatorMemberId:m.id,organizationId:org.id,statusCode:'draft'}}),1);
 assert.equal(await root.auditLog.count({where:{resourceId:id,actorUserId:u.id,event:'activity.publish'}}),1);
 assert.equal(await root.activity.count({where:{title:'positive'}}),1);
 console.log('PASS create/detail, unique draft, initiator, organization, audit');
 await ddl("CREATE FUNCTION lab_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'lab forced audit failure'; END$$");
 await ddl("CREATE TRIGGER lab_fail BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION lab_audit_failure()");
 await reject('audit-failure',/lab forced audit failure/);
 assert.equal(await root.activity.count({where:{title:'audit-failure'}}),0);
 await ddl("DROP TRIGGER lab_fail ON audit_logs");
 await root.member.update({where:{id:m.id},data:{gradeCode:null}});
 await reject('not-formal',/20019|正式队员/);
 assert.equal(await root.activity.count({where:{title:'not-formal'}}),0);
 await root.member.update({where:{id:m.id},data:{gradeCode:'level-1'}});
 await ddl(process.env.UNSEL!);await ddl(process.env.UNINS!);
 await reject('revoked',/permission denied|denied access/i);
 assert.equal(await root.activity.count({where:{title:'revoked'}}),0);
 console.log('PASS forced audit rollback, ineligible actor, revoke');
 }finally{await db.$disconnect();await root.$disconnect();await mod.close()}
}
run().catch(e=>{console.error(String(e).replace(/postgresql:\/\/[^ ]+/g,'[redacted]').slice(-1200));process.exitCode=1});
