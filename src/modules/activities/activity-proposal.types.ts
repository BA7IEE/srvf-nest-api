import type { Prisma } from '@prisma/client';

export interface ActivityProposalActivity {
  title: string;
  activityTypeCode: string;
  // Historical v1 snapshots did not freeze allocation mode. New compatible v1 change snapshots
  // may carry it only when the caller explicitly requested a mode change.
  allocationModeCode?: string;
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
  // 🔴 **不是漏改** —— 维护者 2026-08-25 拍板「留着不动」(P2-14 刀 B)。
  //
  // 对应的 DB 列 `Activity.coverImageUrl` / `Activity.galleryImageUrls` 已被
  // migration `20260825170000_activity_drop_legacy_image_url_columns` DROP 掉;
  // 这两个键**故意**留在快照类型里,构造时一律写字面 `null`。
  //
  // 为什么不能顺手删:审批快照是**已持久化**的 JSON,而它的完整性靠
  //   - v1:`canonicalJson(重建的快照) === canonicalJson(库里那份)`
  //         (`activity-publish-review.service.ts` 的 initial 审批分支)
  //   - v2–v5:`sha256(unsigned)` 重算后比对
  //         (`activity-publish-proposal-v2.service.ts`)
  // 少两个键 ⇒ 规范化串 / 哈希与存量那份不再相等 ⇒ 在途审核单**全部**当场
  // `ACTIVITY_PUBLISH_REVIEW_SNAPSHOT_INVALID`。仓内房规「历史快照逐字兼容」
  // (`src/modules/activities/CLAUDE.md`)说的就是这件事。
  //
  // 要删得单独立项:先把存量快照迁移 / 作废,再删键 —— 本刀没有那份授权。
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
