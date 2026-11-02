import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { notDeletedWhere } from '../../common/prisma/soft-delete.util';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
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
    simple = false,
  ) {
    if (
      simple &&
      (command.places.some((place) => place.sessionCode !== undefined) ||
        new Set(command.places.map((place) => place.roleCode)).size !== command.places.length)
    ) {
      throw new BizException(BizCode.BAD_REQUEST);
    }
    const materialized = await this.templates.materializeWithinTransaction({
      tx,
      command: command.template,
      user,
      initiatorMode: 'resolve',
      creationContextHash: requestHash,
      confirmedCapacity: command.confirmedCapacity,
      ...(simple
        ? { simple: true, instance: command.instance, creationSurface: 'admin' as const }
        : {}),
    });
    const sessions = await tx.activitySession.findMany({
      where: notDeletedWhere({ activityId: materialized.created.id }),
      select: { id: true, code: true, locationText: true },
    });
    let actor = materialized.actor;
    const placeCount = await writeCreationPlaces(tx, {
      activityId: materialized.created.id,
      sessions,
      places: simple
        ? command.places.flatMap((place) => {
            if (place.sessionCode !== undefined) throw new BizException(BizCode.BAD_REQUEST);
            return [place, { ...place, sessionCode: sessions[0].code }];
          })
        : command.places,
      fallback: {
        location: command.template.location,
        visibilityCode: command.defaultPlaceVisibilityCode,
      },
      ...(simple
        ? {
            revalidate: async () => {
              actor = await materialized.revalidateSimpleCreation!();
            },
          }
        : {}),
    });
    return {
      activity: materialized.created,
      placeCount,
      actor,
      timePolicySelectionInitialization: materialized.timePolicySelectionInitialization,
      contributionPolicySelectionInitialization:
        materialized.contributionPolicySelectionInitialization,
    };
  }
}
