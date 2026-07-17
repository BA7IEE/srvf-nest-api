import type { ThrottlerStorage } from '@nestjs/throttler';
import type { PrismaService } from '../database/prisma.service';

type ThrottlerIncrementResult = {
  totalHits: number;
  timeToExpire: number;
  isBlocked: boolean;
  timeToBlockExpire: number;
};

/**
 * @nestjs/throttler 6.5.0 compatible shared storage.
 *
 * Each increment first performs an idempotent INSERT, then locks and transitions the
 * single (throttlerName,key) row inside the same transaction. The lock query completes
 * before the transition query captures its clock, so lock wait can never stale the TTL
 * boundary. JavaScript only sequences the lock and transition; it never reads bucket state
 * or performs SELECT -> decide -> UPDATE. All decisions remain inside one SQL transition.
 * Storage failures deliberately bubble to the global 50000 path. There is no local Map
 * fallback because a fail-open quota would recreate the multi-instance vulnerability.
 */
export class PostgresqlThrottlerStorage implements ThrottlerStorage {
  constructor(private readonly prisma: PrismaService) {}

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerIncrementResult> {
    return this.prisma.$transaction(async (tx) => {
      // Prisma supplies the cuid id. skipDuplicates compiles to an atomic
      // INSERT ... ON CONFLICT DO NOTHING; a concurrent first hit waits for the winner,
      // then the UPDATE below observes and locks that committed row.
      await tx.throttlerBucket.createMany({
        data: { throttlerName, key },
        skipDuplicates: true,
      });

      // This statement must complete (and therefore the row lock must be held) before the
      // transition statement is issued. Keeping clock_timestamp() out of this lock query
      // prevents PostgreSQL's planner/executor from capturing time before a hot-key wait.
      await tx.$queryRaw<Array<{ id: string }>>`
        SELECT bucket."id"
        FROM "throttler_buckets" AS bucket
        WHERE bucket."throttlerName" = ${throttlerName}
          AND bucket."key" = ${key}
        FOR UPDATE
      `;

      const rows = await tx.$queryRaw<ThrottlerIncrementResult[]>`
        WITH "capturedClock" AS (
          SELECT clock_timestamp() AS "capturedAt"
        ),
        "currentBucket" AS (
          SELECT bucket.*, clock."capturedAt"
          FROM "throttler_buckets" AS bucket
          CROSS JOIN "capturedClock" AS clock
          WHERE bucket."throttlerName" = ${throttlerName}
            AND bucket."key" = ${key}
        ),
        "normalized" AS (
          SELECT
            locked.*,
            ARRAY(
              SELECT active."expiresAt"
              FROM unnest(locked."hitExpiresAt") AS active("expiresAt")
              WHERE active."expiresAt" > locked."capturedAt"
              ORDER BY active."expiresAt"
            ) AS "activeHits",
            CASE
              WHEN locked."windowExpiresAt" <= locked."capturedAt"
                THEN locked."capturedAt" + (${ttl}::double precision * INTERVAL '1 millisecond')
              ELSE locked."windowExpiresAt"
            END AS "nextWindowExpiresAt",
            locked."blockedUntil" IS NOT NULL
              AND locked."blockedUntil" > locked."capturedAt" AS "stillBlocked",
            locked."blockedUntil" IS NOT NULL
              AND locked."blockedUntil" <= locked."capturedAt" AS "expiredBlock"
          FROM "currentBucket" AS locked
        ),
        "transitioned" AS (
          SELECT
            normalized.*,
            CASE
              WHEN normalized."expiredBlock" THEN ARRAY[
                normalized."capturedAt" + (${ttl}::double precision * INTERVAL '1 millisecond')
              ]
              WHEN normalized."stillBlocked" THEN normalized."activeHits"
              ELSE array_append(
                normalized."activeHits",
                normalized."capturedAt" + (${ttl}::double precision * INTERVAL '1 millisecond')
              )
            END AS "provisionalHits"
          FROM "normalized" AS normalized
        ),
        "provisionalBlock" AS (
          SELECT
            transitioned.*,
            CASE
              WHEN transitioned."expiredBlock" THEN NULL
              WHEN transitioned."stillBlocked" THEN transitioned."blockedUntil"
              WHEN cardinality(transitioned."provisionalHits") > ${limit}
                THEN transitioned."capturedAt"
                  + (${blockDuration}::double precision * INTERVAL '1 millisecond')
              ELSE NULL
            END AS "candidateBlockedUntil"
          FROM "transitioned" AS transitioned
        ),
        "finalized" AS (
          SELECT
            provisional.*,
            CASE
              WHEN provisional."candidateBlockedUntil" IS NOT NULL
                AND provisional."candidateBlockedUntil" <= provisional."capturedAt"
                THEN ARRAY[
                  provisional."capturedAt"
                    + (${ttl}::double precision * INTERVAL '1 millisecond')
                ]
              ELSE provisional."provisionalHits"
            END AS "nextHits",
            CASE
              WHEN provisional."candidateBlockedUntil" IS NOT NULL
                AND provisional."candidateBlockedUntil" <= provisional."capturedAt"
                THEN NULL
              ELSE provisional."candidateBlockedUntil"
            END AS "nextBlockedUntil",
            CASE
              WHEN provisional."expiredBlock" THEN provisional."blockedUntil"
              WHEN provisional."candidateBlockedUntil" IS NOT NULL
                THEN provisional."candidateBlockedUntil"
              ELSE TIMESTAMPTZ '1970-01-01 00:00:00+00'
            END AS "reportedBlockExpiresAt"
          FROM "provisionalBlock" AS provisional
        )
        UPDATE "throttler_buckets" AS bucket
        SET
          "hitExpiresAt" = finalized."nextHits",
          "windowExpiresAt" = finalized."nextWindowExpiresAt",
          "blockedUntil" = finalized."nextBlockedUntil",
          "retentionAt" = GREATEST(
            finalized."capturedAt",
            finalized."nextWindowExpiresAt",
            COALESCE(finalized."nextBlockedUntil", finalized."capturedAt"),
            COALESCE(
              (SELECT MAX(hit."expiresAt") FROM unnest(finalized."nextHits") AS hit("expiresAt")),
              finalized."capturedAt"
            )
          ),
          "updatedAt" = finalized."capturedAt"
        FROM "finalized" AS finalized
        WHERE bucket."id" = finalized."id"
        RETURNING
          cardinality(finalized."nextHits")::integer AS "totalHits",
          CEIL(EXTRACT(EPOCH FROM (
            finalized."nextWindowExpiresAt" - finalized."capturedAt"
          )))::double precision AS "timeToExpire",
          (finalized."nextBlockedUntil" IS NOT NULL) AS "isBlocked",
          CEIL(EXTRACT(EPOCH FROM (
            finalized."reportedBlockExpiresAt" - finalized."capturedAt"
          )))::double precision AS "timeToBlockExpire"
      `;

      const record = rows[0];
      if (!record) {
        throw new Error('PostgreSQL throttler increment did not update its bucket');
      }
      return record;
    });
  }
}
