import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';

// Test-only profile for the frozen137 catalog (the body remains through142).
// This R5 candidate requires its frozen typed-row body. Never infer a pin from the database.
const CURRENT_CATALOG_SHA256 = '730a48ca110f8bf3451e9bd25af4e3b86022da18acd39c6c743a4a022c84d752';
const CURRENT_COMPLETE = "pg_catalog.md5(complete_proc.prosrc)='8922a6d0c4642ba1c99f679cb9581065'";
const FROZEN_COMPLETE = "pg_catalog.md5(complete_proc.prosrc)='21fe9ecf6df989a3f8fa5878df40b93c'";

export function frozen137FirstReviewCatalogQuery(query: Prisma.Sql): Prisma.Sql {
  if (
    query.values.length !== 0 ||
    query.sql.split(CURRENT_COMPLETE).length !== 2 ||
    createHash('sha256').update(query.sql).digest('hex') !== CURRENT_CATALOG_SHA256
  )
    throw new Error('Frozen137 first-review catalog query scope refused');
  return Prisma.raw(query.sql.replace(CURRENT_COMPLETE, FROZEN_COMPLETE));
}

/** Only historical catalog-mutant groups use this profile. Actual proof reads
 * and PostgreSQL results pass through; writes and other SQL refuse. */
export function frozen137FirstReviewCatalogTx(
  tx: Prisma.TransactionClient,
): Prisma.TransactionClient {
  const proof = new Proxy(tx.activitySettlementContributionRevision, {
    get(target, key) {
      if (key !== 'findFirst') throw new Error('Frozen137 first-review proof read scope refused');
      return target.findFirst.bind(target);
    },
  });
  return new Proxy(tx, {
    get(target, key) {
      if (key === 'activitySettlementContributionRevision') return proof;
      if (key !== '$queryRaw') throw new Error('Frozen137 first-review client scope refused');
      return (parts: TemplateStringsArray, ...values: unknown[]) => {
        if (!Array.isArray(parts) || !Array.isArray(parts.raw))
          throw new Error('Frozen137 first-review query tag scope refused');
        return target.$queryRaw(frozen137FirstReviewCatalogQuery(Prisma.sql(parts, ...values)));
      };
    },
  });
}
