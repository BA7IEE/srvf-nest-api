SELECT json_build_object(
  'batches',(SELECT count(*) FROM "LedgerPostingBatch"),
  'batchId',(SELECT id FROM "LedgerPostingBatch"),
  'committed',(SELECT count(*) FROM "LedgerPostingBatch" WHERE "statusCode"='committed'),
  'closed',(SELECT count(*) FROM "ActivitySettlementClosureRevision"),
  'closedRuns',(SELECT count(*) FROM "AttendanceSettlementRun" WHERE "statusCode"='closed' AND "currentClosureRevision"=1),
  'closedPointers',(SELECT count(*) FROM "Activity" WHERE "currentClosureRevision"=1),
  'ledger',(SELECT count(*) FROM "ParticipationLedgerEntry"),
  'uniqueEntries',(SELECT count(DISTINCT "entryKey") FROM "ParticipationLedgerEntry"),
  'memberRows',(SELECT count(*) FROM "ParticipationLedgerEntry" e JOIN "User" u ON u."memberId"=e."memberId" WHERE u.username='t63_member'),
  'otherRows',(SELECT count(*) FROM "ParticipationLedgerEntry" e JOIN "User" u ON u."memberId"=e."memberId" WHERE u.username='t63_other'),
  'inputSeconds',(SELECT extract(epoch from max("occurredAt")-min("occurredAt"))::integer FROM "AttendancePunchEvent"),
  'hours',(SELECT sum("serviceHoursDelta") FROM "ParticipationLedgerEntry"),
  'points',(SELECT sum("creditedPointsDelta") FROM "ParticipationLedgerEntry"),
  'ordinaryUsers',(SELECT count(*) FROM "User" WHERE role='USER'),
  'ordinaryBindings',(SELECT count(*) FROM role_bindings b JOIN "User" u ON b."principalId" IN (u.id,u."memberId") WHERE u.username IN ('t63_member','t63_other')),
  'jobs',(SELECT json_agg(json_build_object('id',id,'status',"statusCode",'failed',failed,'attempts',attempts,'generation',"leaseGeneration")) FROM "ActivityBatchJob" WHERE "jobTypeCode"='settlement_prepare')
);
