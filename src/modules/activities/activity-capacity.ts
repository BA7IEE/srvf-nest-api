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
  if (activityPositions.some((activityPosition) => activityPosition.capacity === null)) {
    return null;
  }
  return activityPositions.reduce(
    (total, activityPosition) => total + (activityPosition.capacity ?? 0),
    0,
  );
}
