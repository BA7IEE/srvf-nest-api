import { Inject, Injectable, Optional } from '@nestjs/common';
import { Prisma, type ActivityBatchJobItem } from '@prisma/client';
import type { PrismaService } from '../../database/prisma.service';
import {
  HUMAN_CORRECTION_ITEM_KEY,
  HUMAN_CORRECTION_UNAPPLIED,
  HumanCorrectionAuthorityUnavailableError,
  HumanCorrectionLeaseLostError,
  assertHumanCorrectionFence,
  humanCorrectionItemHash,
  type HumanCorrectionIntent,
  type HumanCorrectionJobFence,
  type HumanCorrectionJobPayload,
} from './human-correction-intent';

/** No default credentials, connection or role. Only an explicitly supplied,
 * independently reviewed connection can enable the new Human queue protocol.
 * This is NOT protection against arbitrary SQL in that trusted P session. */
export const HUMAN_CORRECTION_TRUSTED_CONNECTION = Symbol('HUMAN_CORRECTION_TRUSTED_CONNECTION');
export interface HumanCorrectionTrustedConnection {
  readonly client: PrismaService;
  readonly approvalReference: string;
  readonly sourceQualificationReference: string;
  readonly database: { readonly name: string; readonly oid: number };
  readonly sessionRole: { readonly name: string; readonly oid: number };
  readonly callerRole: { readonly name: string; readonly oid: number };
  readonly source: {
    readonly clusterSystemIdentifier: string;
    readonly expectedCatalogSha256: string;
    readonly installedPreflightBodySha256: string;
  };
  /** Supplied only by the separately reviewed connection/binding installer.
   * No built-in success implementation and no callback from HTTP/Job payload. */
  readonly qualifyInTx: (tx: Prisma.TransactionClient) => Promise<{
    readonly databaseName: string;
    readonly databaseOid: string;
    readonly clusterSystemIdentifier: string;
    readonly expectedCatalogSha256: string;
    readonly installedPreflightBodySha256: string;
  }>;
}
type Tx = Prisma.TransactionClient;
const SELECT = {
  id: true,
  jobId: true,
  itemKey: true,
  statusCode: true,
  attempts: true,
  lastErrorCode: true,
  safeMessage: true,
  resourceType: true,
  resourceId: true,
  payloadHash: true,
  resultReference: true,
} as const;
type Item = Pick<ActivityBatchJobItem, keyof typeof SELECT>;
type Identity = {
  sessionUser: string;
  currentUser: string;
  databaseName: string;
  sessionOid: string;
  callerOid: string;
  databaseOid: string;
  qualified: boolean;
};

/** Exact original draft-exhaustion CTE; no caller-selected SQL/key/type, and no
 * split statements with different READ COMMITTED snapshots. The dedicated
 * Human key cannot match its fixed 'generate' predicate. */
export function draftGenerateExhaustionStatement(now: Date, maxAttempts: number) {
  return Prisma.sql`
      WITH expired AS (
        UPDATE "ActivityBatchJob" SET "statusCode" = 'dead', "failed" = 1,
          "succeeded" = 0, "skipped" = 0, "completedAt" = ${now},
          "leaseOwner" = NULL, "leaseExpiresAt" = NULL, "lastErrorCode" = 'DraftJobAttemptsExhausted'
        WHERE "jobTypeCode" = ${'bulk_proxy'}
          AND "payload"->>'action' = ${'settlement_draft_generate'}
          AND "payload"->>'executionMode' = 'async'
          AND "statusCode" = 'processing' AND "attempts" >= ${maxAttempts}
          AND "leaseExpiresAt" <= ${now} RETURNING id
      ) UPDATE "ActivityBatchJobItem" SET "statusCode" = 'failed',
        "lastErrorCode" = 'DraftJobAttemptsExhausted', "safeMessage" = '草稿生成重试次数已用尽'
        WHERE "jobId" IN (SELECT id FROM expired) AND "itemKey" = 'generate' AND "statusCode" <> 'succeeded'
    `;
}

@Injectable()
export class HumanCorrectionItemAuthority {
  constructor(
    @Optional()
    @Inject(HUMAN_CORRECTION_TRUSTED_CONNECTION)
    private readonly connection: HumanCorrectionTrustedConnection | null = null,
  ) {}

  /** Only selects the new path; a supplied but invalid binding NEVER falls back. */
  get hasConnectionBinding() {
    return this.connection !== null;
  }

  assertClient(client: PrismaService) {
    const c = this.binding();
    if (c.client !== client) throw new HumanCorrectionAuthorityUnavailableError();
  }

  async assertCallerInTx(tx: Tx) {
    const c = this.binding();
    await this.probe(tx, c.callerRole.name);
    let proof: Awaited<ReturnType<HumanCorrectionTrustedConnection['qualifyInTx']>>;
    try {
      proof = await c.qualifyInTx(tx);
    } catch {
      throw new HumanCorrectionAuthorityUnavailableError();
    }
    if (
      !proof ||
      proof.databaseName !== c.database.name ||
      proof.databaseOid !== String(c.database.oid) ||
      proof.clusterSystemIdentifier !== c.source.clusterSystemIdentifier ||
      proof.expectedCatalogSha256 !== c.source.expectedCatalogSha256 ||
      proof.installedPreflightBodySha256 !== c.source.installedPreflightBodySha256
    )
      throw new HumanCorrectionAuthorityUnavailableError();
    // Metadata admission/recovery locks obey the same existing 4s per-lock
    // ceiling; SET LOCAL never changes a pool/database default or extends 15s.
    await tx.$executeRaw`SET LOCAL lock_timeout = '4s'`;
  }

  async acceptInTx(tx: Tx, jobId: string, payload: HumanCorrectionJobPayload, applied: boolean) {
    return this.asAuthority(tx, async () => {
      const row = await tx.activityBatchJobItem.create({
        data: {
          jobId,
          itemKey: HUMAN_CORRECTION_ITEM_KEY,
          attempts: 0,
          statusCode: applied ? 'succeeded' : 'pending',
          resourceType: 'CorrectionApplication',
          resourceId: payload.applicationId,
          payloadHash: humanCorrectionItemHash(jobId, payload),
          resultReference: applied ? payload.applicationId : null,
        },
        select: SELECT,
      });
      return this.checked(row, jobId, payload);
    });
  }

  async readInTx(tx: Tx, jobId: string, payload: HumanCorrectionJobPayload, lock = false) {
    return this.asAuthority(tx, async () => {
      const rows = lock
        ? await tx.$queryRaw<Item[]>`SELECT id,"jobId","itemKey","statusCode",attempts,
            "lastErrorCode","safeMessage","resourceType","resourceId","payloadHash","resultReference"
            FROM "ActivityBatchJobItem" WHERE "jobId"=${jobId}
              AND "itemKey"=${HUMAN_CORRECTION_ITEM_KEY} FOR UPDATE`
        : await tx.activityBatchJobItem.findMany({
            where: { jobId, itemKey: HUMAN_CORRECTION_ITEM_KEY },
            select: SELECT,
            take: 2,
          });
      if (rows.length !== 1 || !rows[0]) throw new HumanCorrectionLeaseLostError();
      return this.checked(rows[0], jobId, payload);
    });
  }

  async startInTx(tx: Tx, intent: HumanCorrectionIntent, payload: HumanCorrectionJobPayload) {
    this.binding();
    if (intent.statusCode !== 'pending') return null;
    this.checkRef(intent, payload);
    if (intent.itemEpoch >= 2_147_483_647) throw new HumanCorrectionLeaseLostError();
    return this.asAuthority(tx, async () => {
      const result = await tx.activityBatchJobItem.updateMany({
        where: this.where(intent, payload),
        data: {
          statusCode: 'processing',
          attempts: { increment: 1 },
          lastErrorCode: null,
          safeMessage: null,
        },
      });
      if (result.count !== 1) throw new HumanCorrectionLeaseLostError();
      return {
        ...intent,
        itemEpoch: intent.itemEpoch + 1,
        statusCode: 'processing' as const,
        lastErrorCode: null,
      };
    });
  }

  async assertAttemptInTx(tx: Tx, fence: HumanCorrectionJobFence) {
    assertHumanCorrectionFence(fence);
    const row = await this.readInTx(tx, fence.jobId, fence.payload, true);
    if (
      row.id !== fence.intentItemId ||
      row.intentHash !== fence.intentHash ||
      row.itemEpoch !== fence.itemEpoch ||
      row.statusCode !== 'processing'
    )
      throw new HumanCorrectionLeaseLostError();
  }

  async finishInTx(tx: Tx, fence: HumanCorrectionJobFence) {
    assertHumanCorrectionFence(fence);
    return this.change(
      tx,
      {
        id: fence.intentItemId,
        jobId: fence.jobId,
        intentHash: fence.intentHash,
        itemEpoch: fence.itemEpoch,
        statusCode: 'processing',
        lastErrorCode: null,
        resultReference: null,
      },
      fence.payload,
      {
        statusCode: 'succeeded',
        lastErrorCode: null,
        safeMessage: null,
        resultReference: fence.payload.applicationId,
      },
    );
  }

  async confirmAppliedInTx(
    tx: Tx,
    intent: HumanCorrectionIntent,
    payload: HumanCorrectionJobPayload,
  ) {
    this.binding();
    this.checkRef(intent, payload);
    await this.assertCallerInTx(tx);
    // The native transaction must have committed Item success together with
    // business/audit. An independently applied target alone does NOT sign an
    // old pending/failed attempt. Cross-entry adoption requires its own reviewed
    // receipt/attribution protocol; until then it remains UNKNOWN here.
    if (intent.statusCode !== 'succeeded' || intent.resultReference !== payload.applicationId)
      throw new Error('HumanCorrectionAppliedIntentUnconfirmed');
    return intent;
  }

  async confirmUnappliedInTx(
    tx: Tx,
    intent: HumanCorrectionIntent,
    payload: HumanCorrectionJobPayload,
  ) {
    this.binding();
    if (!['pending', 'processing'].includes(intent.statusCode) || intent.itemEpoch >= 2_147_483_647)
      throw new HumanCorrectionLeaseLostError();
    return this.change(tx, intent, payload, {
      statusCode: 'failed',
      attempts: { increment: 1 },
      lastErrorCode: HUMAN_CORRECTION_UNAPPLIED,
      safeMessage: null,
      resultReference: null,
    });
  }

  async retryInTx(tx: Tx, intent: HumanCorrectionIntent, payload: HumanCorrectionJobPayload) {
    this.binding();
    if (intent.statusCode !== 'failed' || intent.lastErrorCode !== HUMAN_CORRECTION_UNAPPLIED)
      throw new HumanCorrectionLeaseLostError();
    return this.change(tx, intent, payload, {
      statusCode: 'pending',
      lastErrorCode: null,
      safeMessage: null,
      resultReference: null,
    });
  }

  async sweepDraftGenerateDeadInTx(
    client: PrismaService,
    tx: Tx,
    now: Date,
    maxAttempts: number,
    statement = draftGenerateExhaustionStatement(now, maxAttempts),
  ) {
    this.assertClient(client);
    const expected = draftGenerateExhaustionStatement(now, maxAttempts);
    if (
      statement.sql !== expected.sql ||
      statement.values.length !== expected.values.length ||
      statement.values.some((value, index) => value !== expected.values[index])
    )
      throw new HumanCorrectionAuthorityUnavailableError();
    return this.asAuthority(tx, () =>
      tx.$executeRaw(Prisma.sql`
      WITH expired AS (
        UPDATE "ActivityBatchJob" SET "statusCode" = 'dead', "failed" = 1,
          "succeeded" = 0, "skipped" = 0, "completedAt" = ${now},
          "leaseOwner" = NULL, "leaseExpiresAt" = NULL, "lastErrorCode" = 'DraftJobAttemptsExhausted'
        WHERE "jobTypeCode" = ${'bulk_proxy'}
          AND "payload"->>'action' = ${'settlement_draft_generate'}
          AND "payload"->>'executionMode' = 'async'
          AND "statusCode" = 'processing' AND "attempts" >= ${maxAttempts}
          AND "leaseExpiresAt" <= ${now} RETURNING id
      ) UPDATE "ActivityBatchJobItem" SET "statusCode" = 'failed',
        "lastErrorCode" = 'DraftJobAttemptsExhausted', "safeMessage" = '草稿生成重试次数已用尽'
        WHERE "jobId" IN (SELECT id FROM expired) AND "itemKey" = 'generate' AND "statusCode" <> 'succeeded'
    `),
    );
  }

  private async change(
    tx: Tx,
    intent: HumanCorrectionIntent,
    payload: HumanCorrectionJobPayload,
    data: Prisma.ActivityBatchJobItemUpdateManyMutationInput,
  ) {
    this.checkRef(intent, payload);
    return this.asAuthority(tx, async () => {
      const result = await tx.activityBatchJobItem.updateMany({
        where: this.where(intent, payload),
        data,
      });
      if (result.count !== 1) throw new HumanCorrectionLeaseLostError();
      const rows = await tx.activityBatchJobItem.findMany({
        where: { id: intent.id },
        select: SELECT,
        take: 2,
      });
      if (rows.length !== 1 || !rows[0]) throw new HumanCorrectionLeaseLostError();
      return this.checked(rows[0], intent.jobId, payload);
    });
  }

  private where(intent: HumanCorrectionIntent, payload: HumanCorrectionJobPayload) {
    return {
      id: intent.id,
      jobId: intent.jobId,
      itemKey: HUMAN_CORRECTION_ITEM_KEY,
      resourceType: 'CorrectionApplication',
      resourceId: payload.applicationId,
      payloadHash: intent.intentHash,
      attempts: intent.itemEpoch,
      statusCode: intent.statusCode,
    };
  }

  private checkRef(intent: HumanCorrectionIntent, payload: HumanCorrectionJobPayload) {
    if (
      !intent.id ||
      !Number.isSafeInteger(intent.itemEpoch) ||
      intent.itemEpoch < 0 ||
      intent.intentHash !== humanCorrectionItemHash(intent.jobId, payload)
    )
      throw new HumanCorrectionLeaseLostError();
  }

  private checked(
    row: Item,
    jobId: string,
    payload: HumanCorrectionJobPayload,
  ): HumanCorrectionIntent {
    if (
      !row.id ||
      row.jobId !== jobId ||
      row.itemKey !== HUMAN_CORRECTION_ITEM_KEY ||
      row.resourceType !== 'CorrectionApplication' ||
      row.resourceId !== payload.applicationId ||
      row.payloadHash !== humanCorrectionItemHash(jobId, payload) ||
      !Number.isSafeInteger(row.attempts) ||
      row.attempts < 0 ||
      !['pending', 'processing', 'failed', 'succeeded'].includes(row.statusCode)
    )
      throw new HumanCorrectionLeaseLostError();
    return {
      id: row.id,
      jobId,
      intentHash: row.payloadHash,
      itemEpoch: row.attempts,
      statusCode: row.statusCode as HumanCorrectionIntent['statusCode'],
      lastErrorCode: row.lastErrorCode,
      resultReference: row.resultReference,
    };
  }

  private binding() {
    const c = this.connection;
    if (
      !c ||
      !c.client ||
      !c.approvalReference?.trim() ||
      !c.sourceQualificationReference?.trim() ||
      !c.database.name ||
      !c.sessionRole.name ||
      !c.callerRole.name ||
      c.sessionRole.name === c.callerRole.name ||
      typeof c.qualifyInTx !== 'function' ||
      !c.source ||
      !/^[1-9][0-9]*$/.test(c.source.clusterSystemIdentifier) ||
      !/^[a-f0-9]{64}$/.test(c.source.expectedCatalogSha256) ||
      !/^[a-f0-9]{64}$/.test(c.source.installedPreflightBodySha256) ||
      [c.database.oid, c.sessionRole.oid, c.callerRole.oid].some(
        (x) => !Number.isSafeInteger(x) || x <= 0 || x > 4_294_967_295,
      )
    )
      throw new HumanCorrectionAuthorityUnavailableError();
    return c;
  }

  private async probe(tx: Tx, role: string) {
    const c = this.binding();
    const rows = await tx.$queryRaw<Identity[]>`/* human-correction-authority:profile */
      SELECT session_user::text AS "sessionUser",current_user::text AS "currentUser",
        current_database() AS "databaseName",p.oid::text AS "sessionOid",c.oid::text AS "callerOid",
        (SELECT oid::text FROM pg_catalog.pg_database WHERE datname=current_database()) AS "databaseOid",
        (p.rolcanlogin AND NOT c.rolcanlogin AND p.oid<>c.oid
          AND NOT (p.rolsuper OR p.rolcreaterole OR p.rolcreatedb OR p.rolbypassrls OR p.rolreplication)
          AND NOT (c.rolsuper OR c.rolcreaterole OR c.rolcreatedb OR c.rolbypassrls OR c.rolreplication)
          AND NOT c.rolinherit
          AND (SELECT count(*) FROM pg_catalog.pg_auth_members WHERE member=p.oid)=1
          AND EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=p.oid AND roleid=c.oid
            AND set_option AND inherit_option AND NOT admin_option)
          AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=c.oid)
          AND NOT pg_catalog.pg_has_role(c.oid,p.oid,'SET')
          AND NOT pg_catalog.has_any_column_privilege(c.oid,'public."ActivityBatchJobItem"','INSERT,UPDATE')
          AND NOT pg_catalog.has_table_privilege(c.oid,'public."ActivityBatchJobItem"','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES')
          AND NOT pg_catalog.has_table_privilege(p.oid,'public."ActivityBatchJobItem"','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES')
          AND NOT pg_catalog.has_schema_privilege(c.oid,'public','CREATE')
          AND NOT pg_catalog.has_schema_privilege(p.oid,'public','CREATE')
          AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_database d WHERE d.datname=current_database()
            AND (pg_catalog.pg_has_role(p.oid,d.datdba,'MEMBER') OR pg_catalog.pg_has_role(c.oid,d.datdba,'MEMBER')))
          AND (SELECT count(*) FROM pg_catalog.pg_attribute WHERE attrelid='public."ActivityBatchJobItem"'::regclass
            AND attnum>0 AND NOT attisdropped)=13
          AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a
            WHERE a.attrelid='public."ActivityBatchJobItem"'::regclass AND a.attnum>0 AND NOT a.attisdropped AND (
              pg_catalog.has_column_privilege(p.oid,a.attrelid,a.attnum,'SELECT') IS DISTINCT FROM TRUE
              OR pg_catalog.has_column_privilege(p.oid,a.attrelid,a.attnum,'INSERT') IS DISTINCT FROM
                (a.attname=ANY(ARRAY['id','createdAt','updatedAt','jobId','itemKey','statusCode','attempts','resourceType','resourceId','payloadHash','resultReference']))
              OR pg_catalog.has_column_privilege(p.oid,a.attrelid,a.attnum,'UPDATE') IS DISTINCT FROM
                (a.attname=ANY(ARRAY['updatedAt','statusCode','attempts','lastErrorCode','safeMessage','resultReference']))
              OR pg_catalog.has_column_privilege(p.oid,a.attrelid,a.attnum,'REFERENCES')
              OR pg_catalog.has_column_privilege(c.oid,a.attrelid,a.attnum,'SELECT,INSERT,UPDATE,REFERENCES')
            ))
          AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class WHERE oid IN
              ('public."ActivityBatchJobItem"'::regclass,'public."ActivityBatchJob"'::regclass)
            AND (relowner IN (p.oid,c.oid) OR relrowsecurity OR relforcerowsecurity))
          AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger WHERE tgrelid IN
              ('public."ActivityBatchJobItem"'::regclass,'public."ActivityBatchJob"'::regclass) AND NOT tgisinternal)
        ) AS qualified
      FROM pg_catalog.pg_roles p CROSS JOIN pg_catalog.pg_roles c
      WHERE p.rolname=session_user AND c.rolname=${c.callerRole.name}`;
    const r = rows[0];
    if (
      rows.length !== 1 ||
      !r ||
      r.sessionUser !== c.sessionRole.name ||
      r.currentUser !== role ||
      r.databaseName !== c.database.name ||
      r.sessionOid !== String(c.sessionRole.oid) ||
      r.callerOid !== String(c.callerRole.oid) ||
      r.databaseOid !== String(c.database.oid) ||
      r.qualified !== true
    )
      throw new HumanCorrectionAuthorityUnavailableError();
  }

  private async asAuthority<T>(tx: Tx, operation: () => Promise<T>): Promise<T> {
    const c = this.binding();
    await this.assertCallerInTx(tx);
    await tx.$executeRaw`SET LOCAL ROLE NONE`;
    try {
      await this.probe(tx, c.sessionRole.name);
      const result = await operation();
      await tx.$queryRaw`SELECT pg_catalog.set_config('role',${c.callerRole.name},true)`;
      await this.probe(tx, c.callerRole.name);
      return result;
    } catch (error) {
      // SQL errors may already have aborted the transaction. Never turn a
      // failed restore into success or continue this callback as P.
      try {
        await tx.$queryRaw`SELECT pg_catalog.set_config('role',${c.callerRole.name},true)`;
      } catch {
        /* The enclosing callback must reject and the engine must roll back. */
      }
      throw error;
    }
  }
}
