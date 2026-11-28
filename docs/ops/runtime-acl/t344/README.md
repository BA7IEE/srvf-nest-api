# t344 runtime ACL

Live, STATEMENT-minimal, reversible column grants applied on the official accept database when filling WAVE89 and observing waitlist.

- Role: `srvf_activity_registration` (oid 25228)
- Table: `public."ActivityEvidenceState"`
- Why: `POST /api/app/v1/activities/:id/registrations` returned 503/42501 (requests `cmwzpv2fl6bcf3ad9dec9c41fa26fdf0b`, `cmwzpv2osf970d194c1f52ad87e0c62a9`). The statement updates `populationRevision`, `version`, `lastPopulationAt`, and `updatedAt`. `updatedAt` already had UPDATE and was left untouched.

Two grants, both `is_grantable=NO`:

1. 09:14:15.894 Asia/Shanghai — `UPDATE ("populationRevision","version","lastPopulationAt")`. A retry of the same statement still 42501 (requests `cmwzpwv4wc5ba137c4bf047b8e381b971`, `cmwzpwvbuc4532f832d29a2a70cfa3e59`) because the increment expression also reads `populationRevision`.
2. 09:16:18.695 Asia/Shanghai — `SELECT ("populationRevision")`. A `SET ROLE` probe updated 1 row and rolled back. The next registration then returned 201.

Companion REVOKE in this directory was not executed. No GRANT OPTION, SUPERUSER, PUBLIC, or other-database changes. These files record an already-applied grant; they are not a reason to merge or deploy.
