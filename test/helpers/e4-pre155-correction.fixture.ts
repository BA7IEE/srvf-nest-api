import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import { strict as assert } from 'node:assert';
import { CorrectionApplicationService as FrozenCorrection } from '../fixtures/r5-pre155/correction-application.service';
import { LedgerPostingService } from '../../src/modules/activities/ledger-posting.service';
import { ActivityClosureService } from '../../src/modules/activities/activity-closure.service';
import { CorrectionAuditRecorder } from '../../src/modules/activities/correction-audit-recorder';
import { ActivityWorkflowGate } from '../../src/common/activity-workflow/activity-workflow.gate';
import { ParticipationTimeLedgerService } from '../../src/modules/activities/participation-time-ledger.service';
import { ParticipationTimeCorrectionService } from '../../src/modules/activities/participation-time-correction.service';
import { CorrectionTimeAllocationService } from '../../src/modules/activities/correction-time-allocation.service';
import { AttendanceCorrectionWriteService } from '../../src/modules/attendances/attendance-correction-write.service';
import { ActivityTimeCorrectionAccessService } from '../../src/modules/activities/activity-time-correction-access.service';
import { RbacService } from '../../src/modules/permissions/rbac.service';
import { AppIdentityResolver } from '../../src/modules/users/app-identity.resolver';
import { ActivityContributionSettlementService } from '../../src/modules/activities/activity-contribution-settlement.service';
import type { E4Fixture } from './activity-contribution-policy.fixture';

export type E4Pre155Prefix = 146 | 149 | 150 | 151 | 152 | 153;
const currentPin = "pg_catalog.md5(complete_proc.prosrc)='8922a6d0c4642ba1c99f679cb9581065'";
const frozenPin = "pg_catalog.md5(complete_proc.prosrc)='40b56bac5a571c56e589cbc549419bfa'";

/** Two exact shipped query shapes only. Original bind values and every other
 * predicate survive; catalog results are never manufactured or overwritten. */
export function pre155FirstReviewQuery(query: Prisma.Sql) {
  const hash = createHash('sha256').update(query.sql).digest('hex');
  const base =
    hash === '730a48ca110f8bf3451e9bd25af4e3b86022da18acd39c6c743a4a022c84d752' &&
    query.values.length === 0;
  const barrier =
    hash === '512426b7abf2ff9e15805ca0b1a174e61e18d89492ff2f256d3e41913723203f' &&
    query.values.length === 2 &&
    query.values.every((value) => typeof value === 'string');
  if ((!base && !barrier) || query.sql.split(currentPin).length !== 2)
    throw new Error('PRE155_REVIEW_QUERY_SCOPE_REFUSED');
  return Prisma.sql(
    query.strings.map((part) => part.replace(currentPin, frozenPin)),
    ...query.values,
  );
}

function pre155FirstReviewTx(tx: Prisma.TransactionClient): Prisma.TransactionClient {
  return new Proxy(tx, {
    get(target, key) {
      if (key === 'activitySettlementContributionRevision')
        return new Proxy(target.activitySettlementContributionRevision, {
          get(delegate, operation) {
            if (operation !== 'findFirst') throw new Error('PRE155_PROOF_SCOPE_REFUSED');
            return delegate.findFirst.bind(delegate);
          },
        });
      if (key === '$queryRaw' || key === '$executeRaw')
        return (parts: TemplateStringsArray, ...values: unknown[]) => {
          if (!Array.isArray(parts) || !Array.isArray(parts.raw))
            throw new Error('PRE155_QUERY_TAG_REFUSED');
          const query = Prisma.sql(parts, ...values);
          if (key === '$queryRaw') return target.$queryRaw(pre155FirstReviewQuery(query));
          if (
            query.sql !== 'SET CONSTRAINTS public.e4_native_version_complete_guard IMMEDIATE' ||
            query.values.length
          )
            throw new Error('PRE155_CONSTRAINT_SCOPE_REFUSED');
          return target.$executeRaw(query);
        };
      throw new Error('PRE155_CLIENT_SCOPE_REFUSED');
    },
  });
}

export function pre155CorrectionService(f: E4Fixture) {
  return new FrozenCorrection(
    f.db,
    f.app.get(LedgerPostingService),
    f.app.get(ActivityClosureService),
    f.app.get(CorrectionAuditRecorder),
    f.app.get(ActivityWorkflowGate),
    f.app.get(ParticipationTimeLedgerService),
    f.app.get(ParticipationTimeCorrectionService),
    f.app.get(CorrectionTimeAllocationService),
    f.app.get(AttendanceCorrectionWriteService),
    f.app.get(ActivityTimeCorrectionAccessService),
    f.app.get(RbacService),
    f.app.get(AppIdentityResolver),
    f.app.get(ActivityContributionSettlementService),
  );
}

/** Only explicit historical migration fixtures may select the old catalog.
 * Both first-review methods still execute their real implementations and PG
 * constraint checks; production continues to require the current pin. */
export async function withPre155Review<T>(
  f: E4Fixture,
  prefix: E4Pre155Prefix,
  work: () => Promise<T>,
): Promise<T> {
  if (![146, 149, 150, 151, 152, 153].includes(prefix)) throw new Error('PRE155_PREFIX_REFUSED');
  const [actual] = await f.db.$queryRaw<
    Array<{ count: number; pin: string; uninstalled: boolean }>
  >`
    SELECT (SELECT count(*)::int FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL) AS count,
      md5(prosrc) AS pin, to_regclass('public."CorrectionWritePhase"') IS NULL
        AND to_regclass('public."CorrectionApprovedInputItem"') IS NULL AS uninstalled
    FROM pg_proc WHERE oid='public.e4_assert_complete(text,boolean)'::regprocedure`;
  assert.deepEqual(actual, {
    count: prefix,
    pin: '40b56bac5a571c56e589cbc549419bfa',
    uninstalled: true,
  });
  const service = f.app.get(ActivityContributionSettlementService);
  const candidate = service.readFirstReviewBarrierCandidateInTx.bind(service);
  const barrier = service.assertFirstReviewBarrierInTx.bind(service);
  const spies: Array<{ mockRestore: () => void }> = [];
  try {
    spies.push(
      jest
        .spyOn(service, 'readFirstReviewBarrierCandidateInTx')
        .mockImplementation((tx, ...args) => candidate(pre155FirstReviewTx(tx), ...args)),
    );
    spies.push(
      jest
        .spyOn(service, 'assertFirstReviewBarrierInTx')
        .mockImplementation((tx, ...args) => barrier(pre155FirstReviewTx(tx), ...args)),
    );
    return await work();
  } finally {
    for (const spy of spies.reverse()) spy.mockRestore();
  }
}
