import { Inject, Injectable } from '@nestjs/common';
import {
  Prisma,
  type ActivitySettlementContributionRevision,
  type ActivitySettlementTimeRevision,
} from '@prisma/client';
import appConfig, { type AppConfig } from '../../config/app.config';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { ActivityWorkflowGate } from '../../common/activity-workflow/activity-workflow.gate';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { ActivityContributionSettlementQueryService } from './activity-contribution-settlement-query.service';
import {
  ContributionSettlementPolicyError,
  type ContributionEvaluation,
  type ContributionRegimeCode,
} from './activity-contribution-settlement-policy';

type Tx = Prisma.TransactionClient;
type Reauthorize = () => Promise<CurrentUserPayload>;
type Command = { operationKey: string; requestHash: string };

export interface FirstReviewBarrierAnchor {
  activityId: string;
  settlementRunId: string;
  settlementVersionId: string;
  evidenceSealId: string;
  evidenceRevision: number;
  populationRevision: number;
  workflowRevision: number;
}

interface FirstReviewGuardIdentity {
  valid: boolean;
  tableOid: string;
  constraintOid: string;
  triggerOid: string;
  guardFunctionOid: string;
  completeFunctionOid: string;
}

export interface FirstReviewBarrierCandidate {
  proof: ActivitySettlementContributionRevision;
  guard: FirstReviewGuardIdentity;
}

// Exact §12.26 guard137 and complete145 pins, independently extracted from migration SQL.
// A fixed SQL fragment is not a cross-request authorization/identity cache.
const FIRST_REVIEW_GUARD_CATALOG = Prisma.sql`
  SELECT (
    pg_catalog.current_setting('session_replication_role') = 'origin'
    AND (SELECT count(*) FROM pg_catalog.pg_constraint duplicate
      JOIN pg_catalog.pg_namespace ns ON ns.oid=duplicate.connamespace
      WHERE ns.nspname='public' AND duplicate.conname='e4_native_version_complete_guard')=1
    AND constraint_row.contype='t' AND constraint_row.conrelid=relation.oid
    AND constraint_row.condeferrable AND constraint_row.condeferred
    AND NOT trigger_row.tgisinternal AND trigger_row.tgtype=21
    AND trigger_row.tgenabled::text='O'
    AND trigger_row.tgdeferrable AND trigger_row.tginitdeferred
    AND trigger_row.tgqual IS NULL AND trigger_row.tgattr::text=''
    AND trigger_row.tgnargs=0 AND trigger_row.tgargs=''::bytea
    AND guard_proc.pronargs=0 AND guard_proc.prorettype='pg_catalog.trigger'::regtype
    AND guard_proc.prokind='f' AND NOT guard_proc.prosecdef
    AND guard_language.lanname='plpgsql'
    AND guard_proc.proconfig=ARRAY['search_path=pg_catalog, public']::text[]
    AND pg_catalog.md5(guard_proc.prosrc)='fa428e2eb3e733f770cbb31c15dd4720'
    AND complete_proc.pronargs=2 AND complete_proc.pronargdefaults=1
    AND pg_catalog.pg_get_expr(complete_proc.proargdefaults,0)='true'
    AND complete_proc.prorettype='pg_catalog.void'::regtype
    AND complete_proc.prokind='f' AND NOT complete_proc.prosecdef
    AND complete_language.lanname='plpgsql'
    AND complete_proc.proconfig=ARRAY['search_path=pg_catalog, public']::text[]
    AND pg_catalog.md5(complete_proc.prosrc)='b03a7298e625b703fa2f011c0fbcc6c0'
    AND (SELECT count(*) FROM pg_catalog.pg_proc callable
      JOIN pg_catalog.pg_namespace ns ON ns.oid=callable.pronamespace
      WHERE ns.nspname IN ('pg_catalog','public') AND callable.proname='e4_assert_complete'
        AND callable.proargtypes[0]='pg_catalog.text'::regtype
        AND (callable.pronargs=1 OR (callable.pronargs=2 AND callable.pronargdefaults=1)))=1
  ) IS TRUE AS valid,
  relation.oid::text AS "tableOid", constraint_row.oid::text AS "constraintOid",
  trigger_row.oid::text AS "triggerOid", guard_proc.oid::text AS "guardFunctionOid",
  complete_proc.oid::text AS "completeFunctionOid"
  FROM pg_catalog.pg_trigger trigger_row
  JOIN pg_catalog.pg_class relation ON relation.oid=trigger_row.tgrelid
  JOIN pg_catalog.pg_constraint constraint_row ON constraint_row.oid=trigger_row.tgconstraint
  JOIN pg_catalog.pg_namespace constraint_ns ON constraint_ns.oid=constraint_row.connamespace
  JOIN pg_catalog.pg_proc guard_proc ON guard_proc.oid=trigger_row.tgfoid
  JOIN pg_catalog.pg_language guard_language ON guard_language.oid=guard_proc.prolang
  JOIN pg_catalog.pg_proc complete_proc
    ON complete_proc.oid=pg_catalog.to_regprocedure('public.e4_assert_complete(text,boolean)')
  JOIN pg_catalog.pg_language complete_language ON complete_language.oid=complete_proc.prolang
  WHERE relation.oid=pg_catalog.to_regclass('public."AttendanceSettlementVersion"')
    AND trigger_row.tgname='e4_native_version_complete_guard'
    AND constraint_ns.nspname='public' AND constraint_row.conname='e4_native_version_complete_guard'
    AND guard_proc.oid=pg_catalog.to_regprocedure('public.e4_native_version_complete_guard()')
`;

/** Existing classified-settlement codes: no new API/error/permission surface. */
export function contributionSettlementError(error: unknown): never {
  if (error instanceof ContributionSettlementPolicyError) {
    const codes = {
      invalid: BizCode.ACTIVITY_TIME_SETTLEMENT_INVALID,
      source_not_ready: BizCode.ACTIVITY_TIME_SETTLEMENT_SOURCE_NOT_READY,
      overflow: BizCode.CONTRIBUTION_RULE_POINTS_INVALID,
      scale_limit: BizCode.ACTIVITY_TIME_SETTLEMENT_SCALE_LIMIT,
    } as const;
    throw new BizException(codes[error.reason]);
  }
  if (error instanceof TypeError) throw new BizException(BizCode.ACTIVITY_TIME_SETTLEMENT_INVALID);
  throw error;
}

export function frozenContributionRegime(value: string | undefined): ContributionRegimeCode {
  if (value === undefined || value === 'legacy') return 'legacy';
  if (value === 'policy_v1') return value;
  throw new BizException(BizCode.ACTIVITY_TIME_SETTLEMENT_INVALID);
}

/** No independent transaction, lock, role grant, endpoint or alternate contribution ledger. */
@Injectable()
export class ActivityContributionSettlementService {
  constructor(
    @Inject(appConfig.KEY) private readonly config: AppConfig,
    private readonly queries: ActivityContributionSettlementQueryService,
    private readonly activityWorkflowGate: ActivityWorkflowGate,
  ) {}

  assertNativeWriteAllowed(): void {
    if (this.config.env !== 'test' || this.config.contributionSettlementMode !== 'fixture')
      throw new BizException(BizCode.ACTIVITY_TIME_SETTLEMENT_SOURCE_NOT_READY);
    this.activityWorkflowGate.assertV11WriteAllowed();
  }

  draftRegime(previous: ContributionRegimeCode | null): ContributionRegimeCode {
    const regime =
      previous ?? (this.config.contributionSettlementMode === 'fixture' ? 'policy_v1' : 'legacy');
    if (regime === 'policy_v1') this.assertNativeWriteAllowed();
    return regime;
  }

  async ledgerDaysInTx(tx: Tx, settlementVersionId: string, identityIds: readonly string[]) {
    this.assertNativeWriteAllowed();
    const proof = await this.assertVersionInTx(tx, settlementVersionId);
    try {
      return await this.queries.readLedgerDaysInTx(tx, proof.id, identityIds);
    } catch (error) {
      return contributionSettlementError(error);
    }
  }

  /** Reads remain available when fixture mode is off; write owners check the mode separately. */
  async assertVersionInTx(tx: Tx, settlementVersionId: string, postingBatchId?: string) {
    const proof = await tx.activitySettlementContributionRevision.findFirst({
      where: {
        settlementVersionId,
        kindCode: { in: ['submitted', 'correction'] },
        regimeCode: 'policy_v1',
      },
      orderBy: { revision: 'desc' },
    });
    if (!proof) throw new BizException(BizCode.ACTIVITY_TIME_SETTLEMENT_SOURCE_NOT_READY);
    if (postingBatchId !== undefined)
      await tx.$queryRaw`SELECT e4_assert_complete(${proof.id})::text,
        e4_assert_ledger_complete(${proof.id}, ${postingBatchId})::text`;
    else await tx.$queryRaw`SELECT e4_assert_complete(${proof.id})::text`;
    return proof;
  }

  /** First/approve only: latest selection matches the general validator, with no good-row filter. */
  async readFirstReviewBarrierCandidateInTx(
    tx: Tx,
    anchor: FirstReviewBarrierAnchor,
  ): Promise<FirstReviewBarrierCandidate | null> {
    const proof = await tx.activitySettlementContributionRevision.findFirst({
      where: {
        settlementVersionId: anchor.settlementVersionId,
        kindCode: { in: ['submitted', 'correction'] },
        regimeCode: 'policy_v1',
      },
      orderBy: { revision: 'desc' },
    });
    if (
      !proof ||
      proof.schemaVersion !== 1 ||
      proof.regimeCode !== 'policy_v1' ||
      proof.kindCode !== 'submitted' ||
      proof.sourceKindCode !== 'time_revision' ||
      proof.activityId !== anchor.activityId ||
      proof.settlementRunId !== anchor.settlementRunId ||
      proof.settlementVersionId !== anchor.settlementVersionId ||
      proof.effectiveTimeSettlementVersionId !== anchor.settlementVersionId ||
      proof.evidenceSealId !== anchor.evidenceSealId ||
      proof.evidenceRevision !== anchor.evidenceRevision ||
      proof.populationRevision !== anchor.populationRevision ||
      proof.workflowRevision !== anchor.workflowRevision ||
      !proof.timeRevisionId ||
      !proof.sourceDraftContributionRevisionId ||
      proof.correctionApplicationId !== null ||
      proof.correctionPostingBatchId !== null ||
      proof.baseSettlementVersionId !== null ||
      proof.correctionManifestId !== null ||
      proof.correctionTimeSourceProofId !== null ||
      proof.rootTimeManifestId !== null ||
      proof.correctionSourceSetHash !== null ||
      proof.previousContributionRevisionId !== null
    )
      return null;

    const rows = await tx.$queryRaw<FirstReviewGuardIdentity[]>`${FIRST_REVIEW_GUARD_CATALOG}`;
    if (rows.length !== 1 || rows[0].valid !== true)
      throw new BizException(BizCode.ACTIVITY_TIME_SETTLEMENT_SOURCE_NOT_READY);
    return { proof, guard: rows[0] };
  }

  /** Called after the owner has executed the single original version UPDATE, before any decision. */
  async assertFirstReviewBarrierInTx(
    tx: Tx,
    anchor: FirstReviewBarrierAnchor,
    candidate: FirstReviewBarrierCandidate,
  ): Promise<void> {
    const expected = JSON.stringify({
      ...anchor,
      id: candidate.proof.id,
      revision: candidate.proof.revision,
      schemaVersion: 1,
      regimeCode: 'policy_v1',
      kindCode: 'submitted',
      sourceKindCode: 'time_revision',
      effectiveTimeSettlementVersionId: anchor.settlementVersionId,
      timeRevisionId: candidate.proof.timeRevisionId,
      sourceDraftContributionRevisionId: candidate.proof.sourceDraftContributionRevisionId,
      correctionApplicationId: null,
      correctionPostingBatchId: null,
      baseSettlementVersionId: null,
      correctionManifestId: null,
      correctionTimeSourceProofId: null,
      rootTimeManifestId: null,
      correctionSourceSetHash: null,
      previousContributionRevisionId: null,
    });
    const rows = await tx.$queryRaw<(FirstReviewGuardIdentity & { anchorValid: boolean })[]>`
      WITH latest AS (
        SELECT * FROM public."ActivitySettlementContributionRevision"
        WHERE "settlementVersionId"=${anchor.settlementVersionId}
          AND "kindCode" IN ('submitted','correction') AND "regimeCode"='policy_v1'
        ORDER BY revision DESC LIMIT 1
      )
      SELECT catalog.*, coalesce((SELECT to_jsonb(latest) @> ${expected}::jsonb FROM latest),false) AS "anchorValid"
      FROM (${FIRST_REVIEW_GUARD_CATALOG}) catalog
    `;
    const after = rows[0];
    if (
      rows.length !== 1 ||
      after.valid !== true ||
      after.anchorValid !== true ||
      after.tableOid !== candidate.guard.tableOid ||
      after.constraintOid !== candidate.guard.constraintOid ||
      after.triggerOid !== candidate.guard.triggerOid ||
      after.guardFunctionOid !== candidate.guard.guardFunctionOid ||
      after.completeFunctionOid !== candidate.guard.completeFunctionOid
    )
      throw new BizException(BizCode.ACTIVITY_TIME_SETTLEMENT_SOURCE_NOT_READY);
    // Consume the real queued constraint trigger; leave it IMMEDIATE for this transaction.
    await tx.$executeRaw`SET CONSTRAINTS public.e4_native_version_complete_guard IMMEDIATE`;
  }

  async prepareCorrectionInTx(
    tx: Tx,
    input: {
      applicationId: string;
      activityId: string;
      settlementRunId: string;
      settlementVersionId: string;
      postingBatchId: string;
      baseSettlementVersionId: string;
      timeChanged: boolean;
    },
    command: Command,
    reauthorize: Reauthorize,
  ): Promise<ActivitySettlementContributionRevision> {
    this.assertNativeWriteAllowed();
    const previous = await this.assertVersionInTx(tx, input.baseSettlementVersionId);
    if (
      previous.activityId !== input.activityId ||
      previous.settlementRunId !== input.settlementRunId
    )
      throw new BizException(BizCode.ACTIVITY_TIME_SETTLEMENT_STALE);
    const timeProof = input.timeChanged
      ? await tx.correctionTimeSourceProof.findUnique({
          where: { applicationId: input.applicationId },
        })
      : null;
    if (
      input.timeChanged &&
      (!timeProof ||
        timeProof.activityId !== input.activityId ||
        timeProof.settlementRunId !== input.settlementRunId ||
        timeProof.baseSettlementVersionId !== input.baseSettlementVersionId ||
        timeProof.settlementVersionId !== input.settlementVersionId ||
        timeProof.postingBatchId !== input.postingBatchId)
    )
      throw new BizException(BizCode.ACTIVITY_TIME_SETTLEMENT_SOURCE_NOT_READY);
    try {
      const evaluation = timeProof
        ? await this.queries.readCorrectionEvaluationInTx(tx, timeProof, previous)
        : null;
      const latest = await tx.activitySettlementContributionRevision.findFirst({
        where: { settlementRunId: input.settlementRunId },
        orderBy: { revision: 'desc' },
        select: { revision: true },
      });
      if (!latest || latest.revision >= 2_147_483_647)
        throw new BizException(BizCode.ACTIVITY_TIME_SETTLEMENT_STALE);
      const actor = await reauthorize();
      const correction = await tx.activitySettlementContributionRevision.create({
        data: {
          activityId: input.activityId,
          settlementRunId: input.settlementRunId,
          settlementVersionId: input.settlementVersionId,
          effectiveTimeSettlementVersionId: timeProof
            ? input.settlementVersionId
            : previous.effectiveTimeSettlementVersionId,
          revision: latest.revision + 1,
          kindCode: 'correction',
          sourceKindCode: timeProof ? 'correction_time_proof' : 'unchanged_time',
          timeRevisionId: null,
          sourceDraftContributionRevisionId: null,
          previousContributionRevisionId: previous.id,
          correctionApplicationId: input.applicationId,
          correctionPostingBatchId: input.postingBatchId,
          baseSettlementVersionId: input.baseSettlementVersionId,
          correctionManifestId: timeProof?.correctionManifestId ?? null,
          correctionTimeSourceProofId: timeProof?.id ?? null,
          rootTimeManifestId: timeProof?.rootManifestId ?? null,
          correctionSourceSetHash: timeProof?.sourceSetHash ?? null,
          evidenceSealId: previous.evidenceSealId,
          evidenceRevision: previous.evidenceRevision,
          populationRevision: previous.populationRevision,
          workflowRevision: previous.workflowRevision,
          draftContentHash: previous.draftContentHash,
          ruleSnapshotId: previous.ruleSnapshotId,
          ruleSnapshotHash: previous.ruleSnapshotHash,
          selectionRevisionId: previous.selectionRevisionId,
          selectionRevisionHash: previous.selectionRevisionHash,
          sourceSetHash: evaluation?.sourceSetHash ?? previous.sourceSetHash,
          evaluationSetHash: evaluation?.evaluationSetHash ?? previous.evaluationSetHash,
          recognizedPointsTotal:
            evaluation?.recognizedPointsTotal ?? previous.recognizedPointsTotal,
          evaluationCount: evaluation?.evaluationCount ?? previous.evaluationCount,
          operationKey: command.operationKey,
          requestHash: command.requestHash,
          createdByUserId: actor.id,
        },
      });
      if (evaluation) await this.insertEvaluations(tx, correction, evaluation.evaluations);
      else await this.copyEvaluations(tx, previous, correction);
      await reauthorize();
      return correction;
    } catch (error) {
      return contributionSettlementError(error);
    }
  }

  async contributionTotalsInTx(tx: Tx, proofId: string): Promise<Map<string, string>> {
    const totals = await tx.participantContributionEvaluation.groupBy({
      by: ['participationIdentityId'],
      where: { contributionRevisionId: proofId },
      _sum: { recognizedPoints: true },
    });
    return new Map(
      totals.map((row) => [
        row.participationIdentityId,
        (row._sum.recognizedPoints ?? new Prisma.Decimal(0)).toFixed(2),
      ]),
    );
  }

  /** Only the newly created correction version/results, before this transaction becomes visible. */
  async freezeCorrectionResultsInTx(
    tx: Tx,
    proof: ActivitySettlementContributionRevision,
  ): Promise<void> {
    this.assertNativeWriteAllowed();
    this.activityWorkflowGate.assertV11WriteAllowed();
    if (proof.kindCode !== 'correction')
      throw new BizException(BizCode.ACTIVITY_TIME_SETTLEMENT_INVALID);
    await tx.$executeRaw`
      WITH wanted AS MATERIALIZED (
        SELECT r.id, CASE WHEN r."resultCode" = 'present' THEN COALESCE(e.amount, 0) ELSE 0 END AS amount
        FROM "ParticipantSettlementResultRevision" r
        JOIN "CorrectionApplication" a ON a."newSettlementVersionId" = r."settlementVersionId"
          AND a.id = ${proof.correctionApplicationId} AND a."statusCode" = 'preparing'
        LEFT JOIN (
          SELECT "participationIdentityId", SUM("recognizedPoints") AS amount
          FROM "ParticipantContributionEvaluation" WHERE "contributionRevisionId" = ${proof.id}
          GROUP BY "participationIdentityId"
        ) e ON e."participationIdentityId" = r."participationIdentityId"
        WHERE r."settlementVersionId" = ${proof.settlementVersionId} AND r."statusCode" = 'draft'
      ) UPDATE "ParticipantSettlementResultRevision" r
      SET "recognizedContributionPoints" = wanted.amount, "calculatedContributionPoints" = wanted.amount
      FROM wanted WHERE r.id = wanted.id
    `;
    const [content] = await tx.$queryRaw<
      { hash: string }[]
    >`SELECT e4_version_content_hash(${proof.id}) AS hash`;
    if (!content?.hash) throw new BizException(BizCode.ACTIVITY_TIME_SETTLEMENT_INVALID);
    await tx.attendanceSettlementVersion.update({
      where: { id: proof.settlementVersionId },
      data: { contentHash: content.hash },
    });
  }

  async prepareTimeInTx(
    tx: Tx,
    time: ActivitySettlementTimeRevision,
    regime: ContributionRegimeCode,
    command: Command,
    reauthorize: Reauthorize,
  ): Promise<ActivitySettlementContributionRevision | null> {
    if (regime === 'legacy') return null;
    this.assertNativeWriteAllowed();
    if (time.kindCode !== 'draft') throw new BizException(BizCode.ACTIVITY_TIME_SETTLEMENT_STALE);
    try {
      const evaluated = await this.queries.readTimeEvaluationInTx(tx, time);
      const previous = await tx.activitySettlementContributionRevision.findFirst({
        where: { settlementRunId: time.settlementRunId },
        orderBy: { revision: 'desc' },
      });
      // Equivalent immutable D4 proofs may share contribution content; each D4 request retains its original audit/receipt.
      if (
        previous?.kindCode === 'draft' &&
        previous.sourceKindCode === 'time_revision' &&
        previous.settlementVersionId === time.settlementVersionId &&
        previous.draftContentHash === time.draftContentHash &&
        previous.evidenceSealId === time.evidenceSealId &&
        previous.evidenceRevision === time.evidenceRevision &&
        previous.populationRevision === time.populationRevision &&
        previous.workflowRevision === time.workflowRevision &&
        previous.ruleSnapshotId === evaluated.ruleSnapshotId &&
        previous.ruleSnapshotHash === evaluated.ruleSnapshotHash &&
        previous.selectionRevisionId === evaluated.selectionRevisionId &&
        previous.selectionRevisionHash === evaluated.selectionRevisionHash &&
        previous.sourceSetHash === evaluated.sourceSetHash &&
        previous.evaluationSetHash === evaluated.evaluationSetHash &&
        previous.evaluationCount === evaluated.evaluationCount &&
        previous.recognizedPointsTotal.toFixed(2) === evaluated.recognizedPointsTotal
      ) {
        await reauthorize();
        return previous;
      }
      if ((previous?.revision ?? 0) >= 2_147_483_647)
        throw new BizException(BizCode.ACTIVITY_TIME_SETTLEMENT_SCALE_LIMIT);
      const actor = await reauthorize();
      const revision = await tx.activitySettlementContributionRevision.create({
        data: {
          activityId: time.activityId,
          settlementRunId: time.settlementRunId,
          settlementVersionId: time.settlementVersionId,
          effectiveTimeSettlementVersionId: time.settlementVersionId,
          revision: (previous?.revision ?? 0) + 1,
          kindCode: 'draft',
          sourceKindCode: 'time_revision',
          timeRevisionId: time.id,
          evidenceSealId: time.evidenceSealId,
          evidenceRevision: time.evidenceRevision,
          populationRevision: time.populationRevision,
          workflowRevision: time.workflowRevision,
          draftContentHash: time.draftContentHash,
          ruleSnapshotId: evaluated.ruleSnapshotId,
          ruleSnapshotHash: evaluated.ruleSnapshotHash,
          selectionRevisionId: evaluated.selectionRevisionId,
          selectionRevisionHash: evaluated.selectionRevisionHash,
          sourceSetHash: evaluated.sourceSetHash,
          evaluationSetHash: evaluated.evaluationSetHash,
          recognizedPointsTotal: evaluated.recognizedPointsTotal,
          evaluationCount: evaluated.evaluationCount,
          operationKey: command.operationKey,
          requestHash: command.requestHash,
          createdByUserId: actor.id,
        },
      });
      // Parameter-specific plans apply to this native draft's remaining validation work.
      // PostgreSQL restores the previous mode when the owner's transaction ends.
      await tx.$queryRaw`
        SELECT pg_catalog.set_config('plan_cache_mode', 'force_custom_plan', true)
      `;
      await this.insertEvaluations(tx, revision, evaluated.evaluations);
      await reauthorize();
      return revision;
    } catch (error) {
      return contributionSettlementError(error);
    }
  }

  /** The owner's current D4 source checks remain mandatory; native adds its own actual-set proof. */
  async loadPreparedTimeInTx(
    tx: Tx,
    time: ActivitySettlementTimeRevision,
    regime: ContributionRegimeCode,
  ): Promise<ActivitySettlementContributionRevision | null> {
    if (regime === 'legacy') return null;
    this.assertNativeWriteAllowed();
    const contribution = await tx.activitySettlementContributionRevision.findFirst({
      where: {
        settlementRunId: time.settlementRunId,
        settlementVersionId: time.settlementVersionId,
        effectiveTimeSettlementVersionId: time.settlementVersionId,
        kindCode: 'draft',
      },
      orderBy: { revision: 'desc' },
    });
    if (
      !contribution ||
      contribution.activityId !== time.activityId ||
      contribution.sourceKindCode !== 'time_revision' ||
      contribution.regimeCode !== 'policy_v1' ||
      !contribution.timeRevisionId ||
      contribution.evidenceSealId !== time.evidenceSealId ||
      contribution.evidenceRevision !== time.evidenceRevision ||
      contribution.populationRevision !== time.populationRevision ||
      contribution.workflowRevision !== time.workflowRevision ||
      contribution.draftContentHash !== time.draftContentHash
    )
      throw new BizException(BizCode.ACTIVITY_TIME_SETTLEMENT_SOURCE_NOT_READY);
    if (contribution.timeRevisionId !== time.id) {
      const basis = await tx.activitySettlementTimeRevision.findFirst({
        where: {
          id: contribution.timeRevisionId,
          activityId: time.activityId,
          settlementRunId: time.settlementRunId,
          settlementVersionId: time.settlementVersionId,
          kindCode: 'draft',
        },
        select: { bucketContentHash: true, sourceSetHash: true },
      });
      if (
        !basis ||
        basis.bucketContentHash !== time.bucketContentHash ||
        basis.sourceSetHash !== time.sourceSetHash
      )
        throw new BizException(BizCode.ACTIVITY_TIME_SETTLEMENT_STALE);
    }
    await tx.$queryRaw`SELECT e4_assert_complete(${contribution.id})::text`;
    return contribution;
  }

  /** Called only after the owner has copied D4 buckets to the new submitted version in this tx. */
  async copySubmittedTimeInTx(
    tx: Tx,
    draft: ActivitySettlementContributionRevision,
    time: ActivitySettlementTimeRevision,
    command: Command,
    reauthorize: Reauthorize,
  ): Promise<ActivitySettlementContributionRevision> {
    this.assertNativeWriteAllowed();
    if (
      time.kindCode !== 'submitted' ||
      draft.kindCode !== 'draft' ||
      draft.sourceKindCode !== 'time_revision' ||
      draft.activityId !== time.activityId ||
      draft.settlementRunId !== time.settlementRunId ||
      draft.evidenceSealId !== time.evidenceSealId ||
      draft.evidenceRevision !== time.evidenceRevision ||
      draft.populationRevision !== time.populationRevision ||
      draft.workflowRevision !== time.workflowRevision ||
      draft.draftContentHash !== time.draftContentHash
    )
      throw new BizException(BizCode.ACTIVITY_TIME_SETTLEMENT_STALE);
    const latest = await tx.activitySettlementContributionRevision.findFirst({
      where: { settlementRunId: time.settlementRunId },
      orderBy: { revision: 'desc' },
      select: { revision: true },
    });
    if (!latest || latest.revision >= 2_147_483_647)
      throw new BizException(BizCode.ACTIVITY_TIME_SETTLEMENT_STALE);
    const actor = await reauthorize();
    const { id: _id, createdAt: _createdAt, createdByUserId: _actor, ...basis } = draft;
    void _id;
    void _createdAt;
    void _actor;
    const submitted = await tx.activitySettlementContributionRevision.create({
      data: {
        ...basis,
        settlementVersionId: time.settlementVersionId,
        effectiveTimeSettlementVersionId: time.settlementVersionId,
        timeRevisionId: time.id,
        revision: latest.revision + 1,
        kindCode: 'submitted',
        sourceDraftContributionRevisionId: draft.id,
        operationKey: command.operationKey,
        requestHash: command.requestHash,
        createdByUserId: actor.id,
      },
    });
    await this.copyEvaluations(tx, draft, submitted);
    await reauthorize();
    return submitted;
  }

  private async copyEvaluations(
    tx: Tx,
    source: ActivitySettlementContributionRevision,
    target: ActivitySettlementContributionRevision,
  ): Promise<void> {
    const count = await tx.$executeRaw`
      INSERT INTO "ParticipantContributionEvaluation" (
        id, "contributionRevisionId", "activityId", "settlementVersionId", "participationIdentityId", "memberId", "sessionId",
        "ruleSnapshotId", "selectionItemId", "policyId", "policyVersionId", "definitionHash", "evaluatorVersion", mode,
        "attendanceRoleCode", "timeCategoryCode", "evaluationUnitKey", "durationSeconds", "sourceRefsJson", "sourceFingerprint",
        "calculatedPoints", "recognizedPoints", "explanationCode", "beijingDayPointsJson", "evaluationHash"
      ) SELECT 'e4_eval_' || md5(random()::text || clock_timestamp()::text || e.id || ${target.id}),
        ${target.id}, e."activityId", ${target.settlementVersionId}, e."participationIdentityId", e."memberId", e."sessionId",
        e."ruleSnapshotId", e."selectionItemId", e."policyId", e."policyVersionId", e."definitionHash", e."evaluatorVersion", e.mode,
        e."attendanceRoleCode", e."timeCategoryCode", e."evaluationUnitKey", e."durationSeconds", e."sourceRefsJson", e."sourceFingerprint",
        e."calculatedPoints", e."recognizedPoints", e."explanationCode", e."beijingDayPointsJson", e."evaluationHash"
      FROM "ParticipantContributionEvaluation" e
      WHERE e."contributionRevisionId" = ${source.id} AND e."activityId" = ${target.activityId} AND e."settlementVersionId" = ${source.settlementVersionId}
    `;
    if (count !== source.evaluationCount)
      throw new BizException(BizCode.ACTIVITY_TIME_SETTLEMENT_INVALID);
  }

  private async insertEvaluations(
    tx: Tx,
    root: ActivitySettlementContributionRevision,
    evaluations: readonly ContributionEvaluation[],
  ): Promise<void> {
    if (evaluations.length === 0) return;
    const json = JSON.stringify(evaluations);
    const count = await tx.$executeRaw`
      INSERT INTO "ParticipantContributionEvaluation" (
        id, "contributionRevisionId", "activityId", "settlementVersionId", "participationIdentityId", "memberId", "sessionId",
        "ruleSnapshotId", "selectionItemId", "policyId", "policyVersionId", "definitionHash", "evaluatorVersion", mode,
        "attendanceRoleCode", "timeCategoryCode", "evaluationUnitKey", "durationSeconds", "sourceRefsJson", "sourceFingerprint",
        "calculatedPoints", "recognizedPoints", "explanationCode", "beijingDayPointsJson", "evaluationHash"
      ) SELECT 'e4_eval_' || md5(random()::text || clock_timestamp()::text || e."evaluationUnitKey" || ${root.id}),
        ${root.id}, ${root.activityId}, ${root.settlementVersionId}, e."participationIdentityId", e."memberId", e."sessionId",
        e."ruleSnapshotId", e."selectionItemId", e."policyId", e."policyVersionId", e."definitionHash", e."evaluatorVersion", e.mode,
        e."attendanceRoleCode", e."timeCategoryCode", e."evaluationUnitKey", e."durationSeconds", e."sourceRefsJson", e."sourceFingerprint",
        e."calculatedPoints", e."recognizedPoints", e."explanationCode", e."beijingDayPointsJson", e."evaluationHash"
      FROM jsonb_to_recordset(${json}::jsonb) AS e(
        "participationIdentityId" TEXT, "memberId" TEXT, "sessionId" TEXT, "ruleSnapshotId" TEXT, "selectionItemId" TEXT,
        "policyId" TEXT, "policyVersionId" TEXT, "definitionHash" TEXT, "evaluatorVersion" INTEGER, mode TEXT,
        "attendanceRoleCode" TEXT, "timeCategoryCode" TEXT, "evaluationUnitKey" TEXT, "durationSeconds" INTEGER,
        "sourceRefsJson" JSONB, "sourceFingerprint" TEXT, "calculatedPoints" NUMERIC, "recognizedPoints" NUMERIC,
        "explanationCode" TEXT, "beijingDayPointsJson" JSONB, "evaluationHash" TEXT
      )
    `;
    if (count !== evaluations.length)
      throw new BizException(BizCode.ACTIVITY_TIME_SETTLEMENT_INVALID);
  }
}
