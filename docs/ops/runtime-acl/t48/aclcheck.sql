WITH scope(rel,col) AS (
 SELECT 'ParticipationLedgerEntry',unnest(ARRAY['activityId','cappedOutPointsDelta','creditedPointsDelta','entryKey','entryTypeCode','ledgerDate','memberId','participationIdentityId','postingBatchId','recognizedPointsDelta','resultRevisionId','serviceHoursDelta','sessionId'])
 UNION ALL SELECT 'LedgerPostingBatch',unnest(ARRAY['id','statusCode'])
)
SELECT json_build_object('table',rel,'column',col,'select',has_column_privilege('srvf_dp_acceptance_runtime',format('public.%I',rel),col,'SELECT')) FROM scope ORDER BY rel,col;
