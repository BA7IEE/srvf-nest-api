BEGIN;
REVOKE INSERT ("id","memberNo","realName","nickname","memberSinceDate","memberOriginCode","gradeCode","status","createdAt","updatedAt") ON public."Member" FROM srvf_dp_acceptance_runtime;
COMMIT;
