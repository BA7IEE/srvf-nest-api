import type { AppActivityCreationResultDto } from './dto/app/app-managed-activity-creation.dto';

/** Only immutable creation identity and current obligation status; never sign or expose locations. */
export function presentActivityCreation(input: {
  activity: { id: string; createdAt: Date };
  mode: 'quick' | 'professional' | 'emergency';
  replayed: boolean;
  followUpItems?: readonly { itemCode: string; statusCode: string }[];
}): AppActivityCreationResultDto {
  return {
    activity: {
      activityId: input.activity.id,
      createdAt: input.activity.createdAt,
      createdStatusCode: 'draft',
    },
    mode: input.mode,
    replayed: input.replayed,
    followUpItems: (input.followUpItems ?? []).map((item) => ({
      itemCode: item.itemCode,
      statusCode: item.statusCode,
    })),
  };
}
