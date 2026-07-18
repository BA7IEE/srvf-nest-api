export interface ActivityCapacityPositionInput {
  capacity: number | null;
}

// P4：活动存在 live 岗位时，读侧 capacity 由岗位名额派生；任一岗位不限则整体不限。
// 调用方必须只传 live ActivityPosition，避免把软删岗位继续计入有效名额。
export function deriveEffectiveActivityCapacity(
  activityCapacity: number | null,
  activityPositions: readonly ActivityCapacityPositionInput[],
): number | null {
  if (activityPositions.length === 0) return activityCapacity;
  const positionCapacity = activityPositions.some(
    (activityPosition) => activityPosition.capacity === null,
  )
    ? null
    : activityPositions.reduce(
        (total, activityPosition) => total + (activityPosition.capacity ?? 0),
        0,
      );
  if (activityCapacity === null) return positionCapacity;
  if (positionCapacity === null) return activityCapacity;
  return Math.min(activityCapacity, positionCapacity);
}

export interface ActivityCapacityAdmissionInput {
  activityCapacity: number | null;
  activityPassCount: number;
  activityPositionCapacity: number | null;
  activityPositionPassCount: number;
}

// Activity.capacity 始终是聚合硬上限；岗位 capacity 只会进一步收紧，不能替代父上限。
export function hasActivityCapacity(input: ActivityCapacityAdmissionInput): boolean {
  const activityHasRoom =
    input.activityCapacity === null || input.activityPassCount < input.activityCapacity;
  const activityPositionHasRoom =
    input.activityPositionCapacity === null ||
    input.activityPositionPassCount < input.activityPositionCapacity;
  return activityHasRoom && activityPositionHasRoom;
}

export function getActivityCapacityHeadroom(
  activityCapacity: number | null,
  activityPassCount: number,
): number | null {
  return activityCapacity === null ? null : Math.max(activityCapacity - activityPassCount, 0);
}
