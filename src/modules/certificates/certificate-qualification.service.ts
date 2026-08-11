import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { normalizeDateOnly } from '../../common/datetime/date-only.util';
import { PrismaService } from '../../database/prisma.service';

type PrismaTx = Prisma.TransactionClient;

export interface CertificateQualificationFact {
  certificateId: string;
  standardId: string;
  issuedAt: Date;
  expiredAt: Date | null;
}

export interface CertificateQualificationFacts {
  coveringCertificates: CertificateQualificationFact[];
  coveringStandardIds: string[];
}

type LockedCertificateRow = {
  id: string;
  standardId: string;
  issuedAt: Date;
  expiredAt: Date | null;
};

/**
 * Certificate-side qualification port.  The interval definition is intentionally
 * shared by certificate and training rules: a verified, live certificate must have
 * been issued by the activity's Beijing start day and cover its Beijing end day.
 */
@Injectable()
export class CertificateQualificationService {
  constructor(private readonly prisma: PrismaService) {}

  async readCoveringFacts(
    memberId: string,
    activity: { startAt: Date; endAt: Date },
    tx?: PrismaTx,
  ): Promise<CertificateQualificationFacts> {
    const client = tx ?? this.prisma;
    const requiredFrom = normalizeDateOnly(activity.startAt.toISOString());
    const requiredThrough = normalizeDateOnly(activity.endAt.toISOString());
    const rows = await client.$queryRaw<LockedCertificateRow[]>(Prisma.sql`
      SELECT "id", "standardId", "issuedAt", "expiredAt"
      FROM "Certificate"
      WHERE "memberId" = ${memberId}
        AND "deletedAt" IS NULL
        AND "certStatusCode" = 'verified'
        AND "issuedAt" <= ${requiredFrom}
        AND ("expiredAt" IS NULL OR "expiredAt" >= ${requiredThrough})
      ORDER BY "standardId" ASC, "issuedAt" ASC, "id" ASC
      FOR SHARE
    `);
    const coveringCertificates = rows.map((row) => ({
      certificateId: row.id,
      standardId: row.standardId,
      issuedAt: row.issuedAt,
      expiredAt: row.expiredAt,
    }));
    return {
      coveringCertificates,
      coveringStandardIds: [...new Set(rows.map((row) => row.standardId))].sort(),
    };
  }

  hasAnyCoveringStandard(
    facts: CertificateQualificationFacts,
    standardIds: readonly string[],
  ): boolean {
    const covered = new Set(facts.coveringStandardIds);
    return standardIds.some((standardId) => covered.has(standardId));
  }
}
