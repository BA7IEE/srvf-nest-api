import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import type { ProfessionalCreationCommand } from './activity-creation-command';
import { ActivityWriteService } from './activity-write.service';
import { ActivityDraftService } from './activity-draft.service';
import { RegistrationFormVersionService } from './registration-form-version.service';
import { QualificationRuleSetVersionService } from './qualification-rule-set-version.service';
import { canonicalizeRegistrationFormDefinitionForB3 } from './registration-form-definition';
import { writeCreationPlaces, type CreationSessionPlaceScope } from './activity-place-writer';

@Injectable()
export class ActivityCreationProfessional {
  constructor(
    private readonly activities: ActivityWriteService,
    private readonly drafts: ActivityDraftService,
    private readonly forms: RegistrationFormVersionService,
    private readonly qualifications: QualificationRuleSetVersionService,
  ) {}

  async create(
    tx: Prisma.TransactionClient,
    command: ProfessionalCreationCommand,
    user: CurrentUserPayload,
  ) {
    const activity = await this.activities.createDraftWithinTransaction(tx, command.activity, user);
    const sessions: CreationSessionPlaceScope[] = [];
    const positions = new Map<string, string>();
    for (const input of command.sessions) {
      const session = await this.drafts.createSessionWithinTransaction(tx, activity, input.session);
      sessions.push({
        id: session.sessionId,
        code: input.session.code,
        locationText: input.session.locationText,
      });
      for (const position of input.positions) {
        const created = await this.drafts.createPositionWithinTransaction(
          tx,
          activity.id,
          session.sessionId,
          position,
        );
        positions.set(JSON.stringify([input.session.code, position.code]), created.positionId);
      }
    }
    const placeCount = await writeCreationPlaces(tx, {
      activityId: activity.id,
      sessions,
      places: command.places,
    });
    if (command.form) {
      const form = canonicalizeRegistrationFormDefinitionForB3(command.form);
      if (form.mode !== 'governed') throw new BizException(BizCode.BAD_REQUEST);
      await this.forms.materializeTemplateDraft(tx, activity.id, form.definition);
    }
    const sessionIds = new Map(sessions.map((s) => [s.code, s.id]));
    await this.qualifications.materializeDraftWithinTransaction(tx, activity.id, {
      ruleSets: command.qualificationRuleSets.map((set) => {
        const sessionId = set.sessionCode === undefined ? null : sessionIds.get(set.sessionCode);
        const positionId =
          set.positionCode === undefined
            ? null
            : positions.get(JSON.stringify([set.sessionCode, set.positionCode]));
        if (
          sessionId === undefined ||
          positionId === undefined ||
          (positionId !== null && sessionId === null)
        ) {
          throw new BizException(BizCode.ACTIVITY_QUALIFICATION_CONFIGURATION_INVALID);
        }
        return { scope: { sessionId, positionId }, rules: set.rules };
      }),
    });
    return { activity, placeCount };
  }
}
