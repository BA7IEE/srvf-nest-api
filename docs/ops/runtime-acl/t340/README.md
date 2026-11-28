# t340 runtime ACL

Live, STATEMENT-minimal, reversible grants applied on the official accept database during post-publish path testing on WAVE89. These Prisma files record the already-applied grants; they are not a reason to merge or deploy.

1. `srvf_activity_registration` INSERT/RETURNING SELECT on `public."RegistrationFormAnswer"` after registration POST 503/42501 (request `cmwzok7nx8456902b55fc912b31381460`).
2. `srvf_activity_admission` SELECT on `public.organization_position_role_policies` after list-registrations GET 503/42501 (request `cmwzomcw9c6089e56783cf2c1b1077be8`).

Companion REVOKEs in this directory were not executed. No GRANT OPTION, SUPERUSER, PUBLIC, or other-database changes.
