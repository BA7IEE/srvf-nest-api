WITH shapes AS (
 SELECT calls, regexp_match(query,'^INSERT INTO "public"\."(ActivityParticipationIdentity|ActivityEvidenceState)"\s*\(([^)]+)\)') ins,
 regexp_match(query,'^UPDATE "public"\."(ActivityParticipationIdentity|ActivityEvidenceState)" SET (.*?) WHERE ') upd
 FROM pg_stat_statements WHERE userid=(SELECT oid FROM pg_roles WHERE rolname='srvf_dp_acceptance_runtime') AND dbid=(SELECT oid FROM pg_database WHERE datname=current_database())
), cols AS (
 SELECT calls,coalesce(ins[1],upd[1]) AS relation, CASE WHEN ins IS NOT NULL THEN 'INSERT' ELSE 'UPDATE' END AS op,
 CASE WHEN ins IS NOT NULL THEN ARRAY(SELECT m[1] FROM regexp_matches(ins[2],'"([A-Za-z][A-Za-z0-9_]*)"','g') m)
 ELSE ARRAY(SELECT m[1] FROM regexp_matches(upd[2],'(?:^|,\s*)"([A-Za-z][A-Za-z0-9_]*)"\s*=','g') m) END AS cols
 FROM shapes WHERE ins IS NOT NULL OR upd IS NOT NULL)
SELECT json_build_object('table',relation,'op',op,'columns',cols,'calls',sum(calls)) FROM cols GROUP BY relation,op,cols ORDER BY relation,op,cols;
