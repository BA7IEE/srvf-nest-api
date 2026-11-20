const {PrismaClient}=require("@prisma/client");
const assert=require("node:assert/strict");
const db=new PrismaClient();
async function fixture(tx){
 const rows=await tx.$queryRaw`select system_identifier::text as id from pg_control_system()`;
 assert.equal(rows[0].id,process.env.ISOLATED_CLUSTER);
 const activity=await tx.activity.findFirstOrThrow({where:{id:process.env.TRIAL_ACTIVITY,title:"T41 单场次变更",statusCode:"published",capacity:null}});
 const activityId=activity.id;
 assert.equal(await tx.activityRegistration.count({where:{activityId}}),0);
 const session=await tx.activitySession.findFirstOrThrow({where:{activityId}});
 const position=await tx.activitySessionPosition.findFirstOrThrow({where:{activityId,sessionId:session.id}});
 const users=await tx.user.findMany({where:{username:{in:["lab","reviewer"]},role:"USER"},select:{memberId:true}});
 assert.equal(new Set(users.map(u=>u.memberId)).size,2);
 const buckets=await tx.activityCapacityBucket.findMany({where:{activityId},select:{id:true,scopeId:true,scopeTypeCode:true,occupied:true,capacity:true}});
 assert.equal(buckets.length,3);
 assert(buckets.every(b=>b.capacity===null && b.occupied===0));
 assert.equal(await tx.capacityReservation.count({where:{bucketId:{in:buckets.map(b=>b.id)}}}),0);
 for(const {memberId} of users){
   assert(memberId);
   const {id:registrationId}=await tx.activityRegistration.create({data:{activityId,memberId,statusCode:"approved"}});
   const {id:identityId}=await tx.activityParticipationIdentity.create({data:{activityId,memberId,registrationId,sessionId:session.id,currentPositionId:position.id,currentStatusCode:"pass"}});
   for(const b of buckets){
     assert(["activity_person","session_participation","position_participation"].includes(b.scopeTypeCode));
     await tx.capacityReservation.create({data:{bucketId:b.id,identityId,status:"active",reservationType:b.scopeTypeCode,...(b.scopeTypeCode==="activity_person"?{activityId,memberId}:{})}});
   }
 }
 for(const b of buckets) await tx.activityCapacityBucket.update({where:{id:b.id},data:{occupied:2}});
}
db.$transaction(fixture).then(()=>console.log("two synthetic participants, three buckets occupied=2, six active reservations")).catch(e=>{console.error(e.name,e.code||"assertion");process.exitCode=1}).finally(()=>db.$disconnect());
