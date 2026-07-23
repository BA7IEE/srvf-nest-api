import type { Prisma } from '@prisma/client';

export interface ActivityProposalActivity {
  title: string;
  activityTypeCode: string;
  organizationId: string;
  startAt: string;
  endAt: string;
  location: string;
  description: string | null;
  capacity: number | null;
  genderRequirementCode: string | null;
  registrationDeadline: string | null;
  registrationNotes: string | null;
  isPublicRegistration: boolean;
  requiresInsurance: boolean;
  registrationSchema: Prisma.JsonValue | null;
  coverImageUrl: string | null;
  galleryImageUrls: Prisma.JsonValue | null;
  content: Prisma.JsonValue | null;
  locationLongitude: string | number | null;
  locationLatitude: string | number | null;
}

export interface ActivityProposalPosition {
  activityPositionId: string | null;
  clientRef: string | null;
  name: string;
  attendanceRoleCode: string;
  capacity: number | null;
  startAt: string | null;
  endAt: string | null;
  genderRequirementCode: string | null;
  description: string | null;
  sortOrder: number;
}

export interface ActivityProposalSnapshot {
  schemaVersion: 1;
  activity: ActivityProposalActivity;
  positions: ActivityProposalPosition[];
}

export function parseActivityProposalSnapshot(value: Prisma.JsonValue): ActivityProposalSnapshot {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('invalid activity proposal snapshot');
  }
  const record = value as Record<string, unknown>;
  if (
    record.schemaVersion !== 1 ||
    record.activity === null ||
    typeof record.activity !== 'object' ||
    Array.isArray(record.activity) ||
    !Array.isArray(record.positions)
  ) {
    throw new TypeError('invalid activity proposal snapshot');
  }
  return value as unknown as ActivityProposalSnapshot;
}
