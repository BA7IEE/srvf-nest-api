SELECT json_build_array(c.relname,p,has_table_privilege('srvf_dp_acceptance_runtime',c.oid,p),coalesce(array_agg(a.attname order by a.attnum) filter(where has_column_privilege('srvf_dp_acceptance_runtime',c.oid,a.attnum,p)),'{}'))
FROM pg_class c join pg_attribute a on c.oid=a.attrelid cross join unnest(array['SELECT','UPDATE','INSERT','REFERENCES']) p
WHERE c.relnamespace='public'::regnamespace AND c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped
AND current_database()='srvf_staging' GROUP BY c.oid,c.relname,p ORDER BY c.relname,p;
