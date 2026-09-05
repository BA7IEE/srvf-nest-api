import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { notDeletedWhere } from '../../common/prisma/soft-delete.util';
import type { QuickCreationCommand } from './activity-creation-command';
import { ActivityFromTemplateService } from './activity-from-template.service';
import { writeCreationPlaces } from './activity-place-writer';

@Injectable()
export class ActivityCreationQuick {
  constructor(private readonly templates: ActivityFromTemplateService) {}

  async create(
    tx: Prisma.TransactionClient,
    command: QuickCreationCommand,
    user: CurrentUserPayload,
    requestHash: string,
  ) {
    const materialized = await this.templates.materializeWithinTransaction({
      tx,
      command: command.template,
      user,
      initiatorMode: 'resolve',
      creationContextHash: requestHash,
      confirmedCapacity: command.confirmedCapacity,
    });
    const sessions = await tx.activitySession.findMany({
      where: notDeletedWhere({ activityId: materialized.created.id }),
      select: { id: true, code: true, locationText: true },
    });
    const placeCount = await writeCreationPlaces(tx, {
      activityId: materialized.created.id,
      sessions,
      places: command.places,
      fallback: {
        location: command.template.location,
        visibilityCode: command.defaultPlaceVisibilityCode,
      },
    });
    return { activity: materialized.created, placeCount };
  }
}
