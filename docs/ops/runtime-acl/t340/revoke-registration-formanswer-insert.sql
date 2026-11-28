-- Companion REVOKE only. Do not execute unless rolling back the t340
-- RegistrationFormAnswer INSERT/SELECT grant to srvf_activity_registration.
REVOKE INSERT ("id","createdAt","registrationRevisionId","fieldId","valueText"),
       SELECT ("id","attachmentId")
  ON TABLE public."RegistrationFormAnswer" FROM "srvf_activity_registration";
