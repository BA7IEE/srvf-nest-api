# t342 runtime ACL

Live, STATEMENT-minimal, reversible SELECT grant applied on the official accept database when creating an isolated draft to test transfer-initiator.

- Role: `srvf_activity_draft` (oid 25222)
- Table: `public.organization_position_role_policies`
- Why: POST /api/app/v1/my/managed-activities returned 503/42501 (request `cmwzpdhm1374a1845969c78f1e3bd8bd2`).

Companion REVOKE in this directory was not executed. After the grant, a single create retry returned 20020 (no org membership / no cross-org). No GRANT OPTION, SUPERUSER, PUBLIC, or other-database changes. These files record an already-applied grant; they are not a reason to merge or deploy.
