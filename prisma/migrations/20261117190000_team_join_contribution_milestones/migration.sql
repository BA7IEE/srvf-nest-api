-- New postings only. No history scan/backfill, role creation, membership change
-- or production activation. Existing applications remain protocol NULL.
BEGIN;
SET LOCAL lock_timeout = '4s';

ALTER TABLE public.team_join_applications
  ADD COLUMN "contributionNoticeProtocol" integer,
  ADD CONSTRAINT team_join_contribution_notice_protocol_check
    CHECK ("contributionNoticeProtocol" IS NULL OR "contributionNoticeProtocol" = 1);

CREATE UNIQUE INDEX team_join_application_id_member_cycle_key
  ON public.team_join_applications(id, "memberId", "cycleId");
CREATE UNIQUE INDEX participation_ledger_entry_id_batch_member_key
  ON public."ParticipationLedgerEntry"(id, "postingBatchId", "memberId");

CREATE TABLE public."TeamJoinContributionMilestone" (
  id text PRIMARY KEY,
  "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "applicationId" text NOT NULL,
  "memberId" text NOT NULL,
  "cycleId" text NOT NULL,
  "cycleYear" integer NOT NULL,
  threshold integer NOT NULL,
  "sourceEntryId" text NOT NULL,
  "postingBatchId" text NOT NULL,
  "beforePoints" numeric(18,2) NOT NULL,
  "afterPoints" numeric(18,2) NOT NULL,
  "outcomeCode" text NOT NULL,
  "payloadVersion" integer NOT NULL,
  "intentId" text,
  "payloadHash" text,
  CONSTRAINT team_join_contribution_milestone_application_threshold_key
    UNIQUE ("applicationId", threshold),
  CONSTRAINT "TeamJoinContributionMilestone_intentId_key" UNIQUE ("intentId"),
  CONSTRAINT team_join_contribution_milestone_shape CHECK (
    threshold = 5 AND "payloadVersion" = 1
    AND "beforePoints" < 5 AND "afterPoints" >= 5
    AND "afterPoints" <> 'NaN'::numeric
    AND (
      ("outcomeCode" = 'history_pending' AND "intentId" IS NULL AND "payloadHash" IS NULL)
      OR
      ("outcomeCode" = 'notice_registered' AND "intentId" IS NOT NULL
        AND "payloadHash" IS NOT NULL AND "payloadHash" ~ '^[0-9a-f]{64}$')
    )
  ),
  CONSTRAINT tjc_milestone_application_fk
    FOREIGN KEY ("applicationId", "memberId", "cycleId")
    REFERENCES public.team_join_applications(id, "memberId", "cycleId")
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT tjc_milestone_source_fk
    FOREIGN KEY ("sourceEntryId", "postingBatchId", "memberId")
    REFERENCES public."ParticipationLedgerEntry"(id, "postingBatchId", "memberId")
    ON UPDATE RESTRICT ON DELETE RESTRICT
);
CREATE INDEX tjc_milestone_source_idx
  ON public."TeamJoinContributionMilestone"("sourceEntryId", "postingBatchId", "memberId");

-- Lifecycle fields may still change. The creation protocol never changes,
-- including NULL -> 1: an unknown historical application cannot be relabelled.
CREATE FUNCTION public.team_join_notice_protocol_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF NEW."contributionNoticeProtocol" IS DISTINCT FROM OLD."contributionNoticeProtocol" THEN
    RAISE EXCEPTION 'immutable application contribution notice protocol' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER team_join_notice_protocol_immutable
  BEFORE UPDATE ON public.team_join_applications
  FOR EACH ROW EXECUTE FUNCTION public.team_join_notice_protocol_immutable();

CREATE FUNCTION public.team_join_milestone_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'immutable contribution milestone fact' USING ERRCODE = '23514';
END $$;
CREATE TRIGGER team_join_milestone_immutable
  BEFORE UPDATE OR DELETE ON public."TeamJoinContributionMilestone"
  FOR EACH ROW EXECUTE FUNCTION public.team_join_milestone_immutable();
CREATE TRIGGER team_join_milestone_no_truncate
  BEFORE TRUNCATE ON public."TeamJoinContributionMilestone"
  FOR EACH STATEMENT EXECUTE FUNCTION public.team_join_milestone_immutable();

-- Invoker guard: never borrow an owner connection or expand a definer's power.
-- U can SET ROLE C; current_user=C is therefore NOT evidence of trusted P.
CREATE FUNCTION public.team_join_milestone_insert_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  protocol integer;
  application_year integer;
  batch_state text;
  batch_xmin xid;
  own_xid xid := ((pg_current_xact_id()::text::numeric % 4294967296)::text)::xid;
BEGIN
  IF pg_has_role(session_user, 'r5_boundary_caller_h7c6', 'MEMBER')
     AND session_user <> 'r5_human_queue_login_20261030_q1'
     -- pg_has_role reports universal membership for superusers. They are the
     -- existing schema/fixture authority, never an untrusted runtime identity.
     AND NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = session_user AND rolsuper) THEN
    RAISE EXCEPTION 'untrusted milestone writer' USING ERRCODE = '42501';
  END IF;
  SELECT a."contributionNoticeProtocol", c.year INTO protocol, application_year
  FROM public.team_join_applications a
  JOIN public.team_join_cycles c ON c.id = a."cycleId"
  WHERE a.id = NEW."applicationId" AND a."memberId" = NEW."memberId"
    AND a."cycleId" = NEW."cycleId" AND a."statusCode" = 'joining'
    AND a."deletedAt" IS NULL;
  IF NOT FOUND OR application_year IS DISTINCT FROM NEW."cycleYear" THEN
    RAISE EXCEPTION 'invalid milestone application anchor' USING ERRCODE = '23514';
  END IF;
  SELECT b."statusCode", b.xmin INTO batch_state, batch_xmin
  FROM public."LedgerPostingBatch" b WHERE b.id = NEW."postingBatchId";
  IF NOT FOUND OR batch_state IS DISTINCT FROM 'committed' OR batch_xmin <> own_xid THEN
    RAISE EXCEPTION 'milestone requires a newly committed batch in this transaction'
      USING ERRCODE = '23514';
  END IF;
  IF NEW."outcomeCode" = 'history_pending' THEN
    IF protocol IS NOT NULL THEN
      RAISE EXCEPTION 'invalid historical milestone classification' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW."outcomeCode" = 'notice_registered' THEN
    IF protocol IS DISTINCT FROM 1 OR NOT EXISTS (
      SELECT 1 FROM public.notification_outbox_intents o
      WHERE o.id = NEW."intentId" AND o.xmin = own_xid AND o.status = 'pending'
        AND o."eventKey" = 'team-join-contribution-met:' || NEW."applicationId" || ':5'
        AND o."eventType" = 'notification.targeted' AND o."payloadVersion" = 1
        AND o."aggregateType" = 'team_join_application' AND o."aggregateId" = NEW."applicationId"
        AND o."destinationType" = 'member' AND o."destinationRef" = NEW."memberId"
        AND o.payload = jsonb_build_object(
          'recipientMemberId', NEW."memberId", 'notificationTypeCode', 'recruitment',
          'title', '入队贡献值已达标',
          'body', '您的贡献值已达到入队要求（5 分）。管理员核对其他门槛后将安排综合评估，请留意后续通知。',
          'channels', jsonb_build_array('in-app')
        )
    ) THEN
      RAISE EXCEPTION 'invalid milestone notification anchor' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER team_join_milestone_insert_guard
  BEFORE INSERT ON public."TeamJoinContributionMilestone"
  FOR EACH ROW EXECUTE FUNCTION public.team_join_milestone_insert_guard();

-- Same trusted NOLOGIN owner as the installed R5 boundary. No C/U DDL or
-- mutation privilege on permanent facts. Production N needs reviewed SELECT,
-- INSERT on this table; no wildcard grant or role bootstrap here.
ALTER TABLE public."TeamJoinContributionMilestone" OWNER TO r5_boundary_owner_h7c6;
ALTER FUNCTION public.team_join_notice_protocol_immutable() OWNER TO r5_boundary_owner_h7c6;
ALTER FUNCTION public.team_join_milestone_immutable() OWNER TO r5_boundary_owner_h7c6;
ALTER FUNCTION public.team_join_milestone_insert_guard() OWNER TO r5_boundary_owner_h7c6;
REVOKE ALL ON public."TeamJoinContributionMilestone" FROM PUBLIC, r5_boundary_caller_h7c6,
  r5_human_queue_login_20261030_q1, r5_untrusted_caller_login_20261030_q1;
GRANT SELECT, INSERT ON public."TeamJoinContributionMilestone" TO r5_boundary_caller_h7c6;
GRANT SELECT (id, "memberId", "cycleId", "createdAt", "deletedAt", "statusCode",
  "contributionNoticeProtocol") ON public.team_join_applications TO r5_boundary_caller_h7c6;
GRANT SELECT (id, year) ON public.team_join_cycles TO r5_boundary_caller_h7c6;
-- PostgreSQL row locking requires UPDATE on at least one column. This column
-- is immutable for every row; the grant permits FOR SHARE, not changing state,
-- applicant, cycle, or upgrading an unknown protocol.
GRANT UPDATE ("contributionNoticeProtocol") ON public.team_join_applications
  TO r5_boundary_caller_h7c6;
REVOKE ALL ON FUNCTION public.team_join_notice_protocol_immutable() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.team_join_milestone_immutable() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.team_join_milestone_insert_guard() FROM PUBLIC;
COMMIT;
