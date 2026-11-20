#!/bin/sh
set -eu
cd "$(dirname "$0")"
ssh -o BatchMode=yes -o StrictHostKeyChecking=yes srvf 'docker exec srvf-dp-acceptance-runtime-api-1 printenv ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED ACTIVITY_OS_CONTROL_PLANE_MODE ACTIVITY_V11_WORKFLOW_ENABLED'
ssh -o BatchMode=yes -o StrictHostKeyChecking=yes srvf 'docker exec -i -u postgres srvf-dp-acceptance-pg-1 sh -c '\''exec psql -XwAtq -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"'\''' < preflight.sql
