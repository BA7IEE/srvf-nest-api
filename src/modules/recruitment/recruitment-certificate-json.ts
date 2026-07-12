import { Prisma } from '@prisma/client';

export interface RecruitmentCertificateIssuance {
  issuingOrg: string;
  issuedAt: string;
}

export interface RecruitmentCertificateReview {
  status: 'approved' | 'rejected';
  at: string;
  by: string;
  note?: string;
}

export function certificateJsonRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function certificateIssuanceForCategory(
  value: unknown,
  category: string,
): RecruitmentCertificateIssuance | null {
  const item = certificateJsonRecord(value)[category];
  if (item === null || typeof item !== 'object' || Array.isArray(item)) return null;
  const { issuingOrg, issuedAt } = item as Record<string, unknown>;
  return typeof issuingOrg === 'string' && typeof issuedAt === 'string'
    ? { issuingOrg, issuedAt }
    : null;
}

export function certificateReviewForCategory(
  value: unknown,
  category: string,
): RecruitmentCertificateReview | null {
  const item = certificateJsonRecord(value)[category];
  if (item === null || typeof item !== 'object' || Array.isArray(item)) return null;
  const { status, at, by, note } = item as Record<string, unknown>;
  if (
    (status !== 'approved' && status !== 'rejected') ||
    typeof at !== 'string' ||
    typeof by !== 'string'
  ) {
    return null;
  }
  return {
    status,
    at,
    by,
    ...(typeof note === 'string' ? { note } : {}),
  };
}

/** 证书相关 JSON 对象写库归一：空对象落 SQL NULL，非空对象保留 JSON。 */
export function certificateJsonOrDbNull(value: Record<string, unknown>) {
  return Object.keys(value).length > 0 ? (value as Prisma.InputJsonValue) : Prisma.DbNull;
}
