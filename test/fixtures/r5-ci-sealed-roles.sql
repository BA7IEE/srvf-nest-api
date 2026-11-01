-- Disposable GitHub Actions PostgreSQL only, before Prisma migrations.
-- This is a TEST fixture, never imported/executed by a production migration.
-- No LOGIN/password credential, HBA, role owner, admin or application data.
BEGIN;
DO $ci_target$
BEGIN
  IF current_database() NOT IN ('app_test', 'app_smoke')
    OR current_setting('server_version_num')::integer NOT BETWEEN 160000 AND 169999
    OR EXISTS (
      SELECT 1 FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind IN ('r','p','S','v','m')
    )
    OR EXISTS (
      SELECT 1 FROM pg_catalog.pg_roles
      WHERE rolname IN ('r5_boundary_owner_h7c6', 'r5_boundary_caller_h7c6',
        'r5_mat_writer_20261029_q1', 'r5_human_queue_login_20261030_q1',
        'r5_untrusted_caller_login_20261030_q1')
    )
  THEN
    RAISE EXCEPTION 'fresh isolated CI target and absent source roles required'
      USING ERRCODE='42501';
  END IF;
END
$ci_target$;

CREATE ROLE "r5_boundary_owner_h7c6" NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD NULL;
CREATE ROLE "r5_boundary_caller_h7c6" NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD NULL;
CREATE ROLE "r5_mat_writer_20261029_q1" NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD NULL;
CREATE ROLE "r5_human_queue_login_20261030_q1" NOLOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD NULL;
CREATE ROLE "r5_untrusted_caller_login_20261030_q1" NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD NULL;

GRANT "r5_boundary_caller_h7c6" TO "r5_human_queue_login_20261030_q1" WITH INHERIT TRUE;
GRANT "r5_boundary_caller_h7c6" TO "r5_human_queue_login_20261030_q1" WITH SET TRUE;
GRANT "r5_boundary_caller_h7c6" TO "r5_human_queue_login_20261030_q1" WITH ADMIN FALSE;
GRANT "r5_boundary_caller_h7c6" TO "r5_untrusted_caller_login_20261030_q1" WITH INHERIT FALSE;
GRANT "r5_boundary_caller_h7c6" TO "r5_untrusted_caller_login_20261030_q1" WITH SET TRUE;
GRANT "r5_boundary_caller_h7c6" TO "r5_untrusted_caller_login_20261030_q1" WITH ADMIN FALSE;
-- psql's connected database identifier; never a second or guessed target.
GRANT CONNECT ON DATABASE :"DBNAME" TO "r5_human_queue_login_20261030_q1", "r5_untrusted_caller_login_20261030_q1";
COMMIT;
