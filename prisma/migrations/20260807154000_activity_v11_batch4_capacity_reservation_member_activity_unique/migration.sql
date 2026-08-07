-- 活动业务改造 v1.1 第 4 批前置微刀(AMENDMENTS-v1.1.1 §1):
-- 为 CapacityReservation 补 member/activity 直接锚点，并由 DB 保证
-- 同一 member/activity 至多一条 active activity_person reservation。
--
-- expand-only:两列均 nullable、无 default、零回填；既有 session / position reservation
-- 不被改写。若存量已有 active activity_person reservation，它会因两锚点仍为 NULL
-- 在下方 CHECK 加载时 fail-safe 失败；不得在本 migration 内自行回填或修复数据。

ALTER TABLE "CapacityReservation"
ADD COLUMN "memberId" TEXT,
ADD COLUMN "activityId" TEXT;

ALTER TABLE "CapacityReservation"
ADD CONSTRAINT "CapacityReservation_memberId_fkey"
FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "CapacityReservation"
ADD CONSTRAINT "CapacityReservation_activityId_fkey"
FOREIGN KEY ("activityId") REFERENCES "Activity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- active activity_person 行必须同时有两个直接锚点。
-- `IS DISTINCT FROM` 与 `IS NOT NULL` 都是二值判定，避免普通 `=` / `<>` 在 SQL NULL
-- 三值逻辑下把缺锚点行静默放过。
ALTER TABLE "CapacityReservation"
ADD CONSTRAINT "capacity_reservation_active_activity_person_anchor_check"
CHECK (
  "status" IS DISTINCT FROM 'active'
  OR "reservationType" IS DISTINCT FROM 'activity_person'
  OR ("memberId" IS NOT NULL AND "activityId" IS NOT NULL)
);

-- 第 71 migration 的 identity/bucket active unique 保持不动。
-- 此索引的 target 谓词由上方 CHECK 保证两个键均非 NULL，故不使用 NULLS NOT DISTINCT:
-- NULL 在该 target 集合里根本不是合法状态；加它不会增加保证，反而掩盖 anchor 形状错误。
CREATE UNIQUE INDEX "capacity_reservation_member_activity_active_activity_person_unique"
ON "CapacityReservation" ("memberId", "activityId")
WHERE "status" = 'active' AND "reservationType" = 'activity_person';
