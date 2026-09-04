import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { ActivityWriteService } from './activity-write.service';
import { ActivityAccessService } from './activity-access.service';
import type { EmergencyCreationCommand } from './activity-creation-command';
import { createEmergencyFollowUps } from './activity-emergency-follow-up';
import { ActivityNotificationProducer } from './activity-notification-producer';
import { freezeEmergencyCall } from './activity-recipient-freeze';

@Injectable()
export class ActivityCreationEmergency {
  constructor(
    private readonly activities: ActivityWriteService,
    private readonly access: ActivityAccessService,
    private readonly notifications: ActivityNotificationProducer,
  ) {}

  async createDraft(
    tx: Prisma.TransactionClient,
    command: EmergencyCreationCommand,
    user: CurrentUserPayload,
  ) {
    for (const organizationId of command.organizationIds ?? []) {
      await this.access.assertOrganizationValidAndNonRoot(organizationId, tx);
    }
    return this.activities.createDraftWithinTransaction(tx, command.activity, user);
  }

  async queueCall(
    tx: Prisma.TransactionClient,
    input: {
      command: EmergencyCreationCommand;
      activityId: string;
      receiptId: string;
      requestHash: string;
      user: CurrentUserPayload;
      authorizedOrganizationIds: readonly string[];
    },
  ): Promise<number> {
    const at = new Date();
    const origin = await tx.activityEmergencyInitiation.create({
      data: {
        activityId: input.activityId,
        creationReceiptId: input.receiptId,
        callQueuedAt: at,
      },
    });
    await createEmergencyFollowUps(tx, origin.id, input.user.id, at);
    const cohort = await freezeEmergencyCall(tx, {
      activityId: input.activityId,
      initiationId: origin.id,
      requestHash: input.requestHash,
      at,
      authorizedOrganizationIds: input.authorizedOrganizationIds,
      organizationIds: input.command.organizationIds,
      memberIds: input.command.memberIds,
    });
    await this.notifications.enqueueEmergencyCall(tx, {
      activityId: input.activityId,
      initiationId: origin.id,
      title: input.command.activity.title,
      startAt: new Date(input.command.activity.startAt),
      endAt: new Date(input.command.activity.endAt),
      coarseLocation: input.command.activity.location,
      cohort,
    });
    return cohort.memberIds.length;
  }
}
