BEGIN READ ONLY;
SELECT json_build_object('database',current_database(),'runtime','srvf_dp_acceptance_runtime','table',c.relname,
 'select_columns',array_agg(a.attname ORDER BY a.attnum) FILTER (WHERE has_column_privilege('srvf_dp_acceptance_runtime',c.oid,a.attnum,'SELECT')),
 'insert_columns',array_agg(a.attname ORDER BY a.attnum) FILTER (WHERE has_column_privilege('srvf_dp_acceptance_runtime',c.oid,a.attnum,'INSERT')),
 'update_columns',array_agg(a.attname ORDER BY a.attnum) FILTER (WHERE has_column_privilege('srvf_dp_acceptance_runtime',c.oid,a.attnum,'UPDATE')))
FROM pg_class c JOIN pg_namespace ns ON ns.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
WHERE ns.nspname='public' AND c.relname IN ('Activity','ActivityRegistration','ActivityParticipationIdentity','ActivityRegistrationRevision',
'ActivityParticipationRevision','RegistrationFormVersion','RegistrationFormAnswer','ActivityPositionPreference','ActivitySession','ActivitySessionPosition','ActivityCapacityBucket','CapacityReservation','audit_logs')
GROUP BY c.oid ORDER BY c.relname;
ROLLBACK;
