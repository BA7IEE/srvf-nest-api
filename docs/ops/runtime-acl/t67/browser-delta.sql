-- Included by ../t63/acl.py after the lab guards, exact base contract and effective ACL view.
CREATE TEMP TABLE browser_delta (LIKE desired INCLUDING ALL) ON COMMIT DROP;
INSERT INTO browser_delta (role_name, tbl, op, col) VALUES
  ('t63_api', 'activity_responsibility_assignments', 'SELECT', 'canManageRegistrations'),
  ('t63_api', 'activity_responsibility_assignments', 'SELECT', 'canManageAttendance'),
  ('t63_api', 'refresh_tokens', 'UPDATE', 'rotatedAt'),
  ('t63_api', 'refresh_tokens', 'UPDATE', 'revokedAt'),
  ('t63_api', 'refresh_tokens', 'UPDATE', 'revokedReason'),
  ('t63_api', 'refresh_tokens', 'UPDATE', 'replacedById');

-- Accept the complete base or the complete extension. Any partial or unrelated ACL fails.
INSERT INTO desired SELECT d.* FROM browser_delta d
WHERE EXISTS (SELECT FROM actual JOIN browser_delta USING (role_name, tbl, op, col));
SELECT pg_temp.validate_acl('preflight', true);

-- Build the expected end state before changing any grants. Preflight requires the extension.
DELETE FROM desired USING browser_delta d
WHERE (desired.role_name, desired.tbl, desired.op, desired.col) = (d.role_name, d.tbl, d.op, d.col);
INSERT INTO desired SELECT * FROM browser_delta WHERE :'mode' <> 'rollback';

SELECT format(
  CASE :'mode' WHEN 'setup' THEN 'GRANT %s (%s) ON TABLE public.%I TO %I'
               WHEN 'rollback' THEN 'REVOKE %s (%s) ON TABLE public.%I FROM %I RESTRICT' END,
  d.op, string_agg(quote_ident(d.col), ', ' ORDER BY d.col), d.tbl, d.role_name)
FROM browser_delta d LEFT JOIN actual a USING (role_name, tbl, op, col)
WHERE (:'mode' = 'setup' AND a.col IS NULL) OR (:'mode' = 'rollback' AND a.col IS NOT NULL)
GROUP BY d.role_name, d.tbl, d.op
\gexec
SELECT pg_temp.validate_acl('preflight', true);
COMMIT;
