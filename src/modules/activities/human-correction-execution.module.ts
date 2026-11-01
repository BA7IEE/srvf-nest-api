import {
  Module,
  type FactoryProvider,
  type INestApplicationContext,
  type InjectionToken,
  type Type,
} from '@nestjs/common';
import {
  OPTIONAL_DEPS_METADATA,
  PARAMTYPES_METADATA,
  SELF_DECLARED_DEPS_METADATA,
} from '@nestjs/common/constants';
import { ActivityWorkflowModule } from '../../common/activity-workflow/activity-workflow.module';
import { PrismaService } from '../../database/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { AttachmentsService } from '../attachments/attachments.service';
import { attachmentReferenceBoundary } from '../attachments/attachment-reference-boundary';
import { AttendanceCorrectionWriteService } from '../attendances/attendance-correction-write.service';
import { AuthzService } from '../authz/authz.service';
import { ResourceResolverService } from '../authz/resource-resolver.service';
import { NotificationOutboxService } from '../notifications/notification-outbox.service';
import { RbacService } from '../permissions/rbac.service';
import { AppIdentityResolver } from '../users/app-identity.resolver';
import { ActivityClosureAuditRecorder } from './activity-closure-audit-recorder';
import { ActivityClosureNotificationProducer } from './activity-closure-notification-producer';
import { ActivityClosureService } from './activity-closure.service';
import { ActivityContributionSettlementQueryService } from './activity-contribution-settlement-query.service';
import { ActivityContributionSettlementService } from './activity-contribution-settlement.service';
import { ACTIVITY_BATCH_AUTO_COMMIT_ENABLED, ActivityBatchWorker } from './activity-batch.worker';
import { ActivityResponsibilityPolicy } from './activity-responsibility-policy';
import { ActivityTimeCorrectionAccessService } from './activity-time-correction-access.service';
import { ActivityTimeCorrectionBackgroundService } from './activity-time-correction-background.service';
import { ActivityTimeCorrectionCommandService } from './activity-time-correction-command.service';
import { ActivityTimeSettlementAccessService } from './activity-time-settlement-access.service';
import { CorrectionApplicationService } from './correction-application.service';
import { CorrectionAuditRecorder } from './correction-audit-recorder';
import { CorrectionTimeAllocationService } from './correction-time-allocation.service';
import { HUMAN_CORRECTION_BACKGROUND_BUDGET } from './human-correction-background-budget';
import {
  HUMAN_CORRECTION_TRUSTED_CONNECTION,
  HumanCorrectionItemAuthority,
  type HumanCorrectionTrustedConnection,
} from './human-correction-item-authority';
import {
  humanCorrectionRuntimeProviders,
  HumanCorrectionRuntimeSetupError,
} from './human-correction-runtime-bootstrap';
import { HUMAN_CORRECTION_CLIENT } from './human-correction-runtime-client';
import { LedgerPostingAuditRecorder } from './ledger-posting-audit-recorder';
import { LedgerPostingService } from './ledger-posting.service';
import { LedgerPreparationService } from './ledger-preparation.service';
import { LedgerReadyBatchCommitter } from './ledger-ready-batch-committer.service';
import { ParticipationTimeCorrectionService } from './participation-time-correction.service';
import { ParticipationTimeLedgerAccessService } from './participation-time-ledger-access.service';
import { ParticipationTimeLedgerService } from './participation-time-ledger.service';
import { ParticipationTimeTruthQueryService } from './participation-time-truth-query.service';
import { SettlementNotificationProducer } from './settlement-notification-producer';

export const HUMAN_CORRECTION_EXECUTION = Symbol('HUMAN_CORRECTION_EXECUTION');
export interface HumanCorrectionExecution {
  readonly client: PrismaService;
  readonly database: HumanCorrectionTrustedConnection['database'];
  readonly commands: ActivityTimeCorrectionCommandService;
  readonly background: ActivityTimeCorrectionBackgroundService;
  readonly worker: ActivityBatchWorker;
}

// Nest's non-strict app.get() can see unexported class providers. Register the
// P graph under distinct tokens so ordinary fixture/runtime lookups never pick
// a later P (or off/null) Prisma, authorization, attachment or domain instance.
const scopedServices: readonly Type<object>[] = [
  RbacService,
  AuthzService,
  ResourceResolverService,
  AppIdentityResolver,
  AuditLogsService,
  HumanCorrectionItemAuthority,
  ActivityTimeSettlementAccessService,
  ActivityTimeCorrectionAccessService,
  ActivityResponsibilityPolicy,
  ParticipationTimeLedgerAccessService,
  ParticipationTimeLedgerService,
  ParticipationTimeCorrectionService,
  ParticipationTimeTruthQueryService,
  ActivityContributionSettlementQueryService,
  ActivityContributionSettlementService,
  CorrectionTimeAllocationService,
  AttendanceCorrectionWriteService,
  LedgerPostingService,
  LedgerPostingAuditRecorder,
  NotificationOutboxService,
  SettlementNotificationProducer,
  ActivityClosureService,
  ActivityClosureAuditRecorder,
  ActivityClosureNotificationProducer,
  CorrectionAuditRecorder,
  CorrectionApplicationService,
  ActivityTimeCorrectionCommandService,
  ActivityTimeCorrectionBackgroundService,
  LedgerPreparationService,
  LedgerReadyBatchCommitter,
  ActivityBatchWorker,
];
const scopedTokens = new Map(
  scopedServices.map((service) => [service, Symbol(`Human:${service.name}`)]),
);
const attachmentToken = Symbol('Human:AttachmentReferenceBoundary');
function scopedToken(token: InjectionToken): InjectionToken {
  if (token === PrismaService) return HUMAN_CORRECTION_CLIENT;
  if (token === AttachmentsService) return attachmentToken;
  return typeof token === 'function' ? (scopedTokens.get(token as Type<object>) ?? token) : token;
}
function scopedProvider(service: Type<object>): FactoryProvider<object> {
  // Preserve Nest constructor @Inject and @Optional metadata exactly. Only
  // this closed graph's token identity changes; constructors/tx/logic do not.
  const parameters = [
    ...((Reflect.getMetadata(PARAMTYPES_METADATA, service) ?? []) as InjectionToken[]),
  ];
  const declared = (Reflect.getMetadata(SELF_DECLARED_DEPS_METADATA, service) ?? []) as Array<{
    index: number;
    param: InjectionToken;
  }>;
  const optional = (Reflect.getMetadata(OPTIONAL_DEPS_METADATA, service) ?? []) as number[];
  for (const entry of declared) parameters[entry.index] = entry.param;
  return {
    provide: scopedTokens.get(service)!,
    inject: parameters.map((token, index) =>
      optional.includes(index) ? { token: scopedToken(token), optional: true } : scopedToken(token),
    ),
    useFactory: (...dependencies: unknown[]) => Reflect.construct(service, dependencies),
  };
}

/** Trusted test/component inspection only. No public/ordinary class-token
 * lookup is used to select a private P collaborator. */
export function getHumanCorrectionService<T extends object>(
  context: Pick<INestApplicationContext, 'get'>,
  service: Type<T>,
): T {
  const token = scopedTokens.get(service);
  if (!token) throw new HumanCorrectionRuntimeSetupError('UNKNOWN_SCOPED_SERVICE');
  return context.get<T>(token, { strict: true });
}

/** Private DI boundary: every collaborator, including its tx-outside reads,
 * uses P. Do not export Prisma, the generic CorrectionApplication or authority.
 * No domain module is imported: that would reconstruct HTTP/Storage lifecycle.
 * Off constructs no Human client; the null bundle is selected before a call,
 * never as a fallback after a qualification or business failure. */
@Module({
  imports: [ActivityWorkflowModule],
  providers: [
    ...humanCorrectionRuntimeProviders,
    { provide: attachmentToken, useValue: attachmentReferenceBoundary },
    ...scopedServices.map(scopedProvider),
    { provide: ACTIVITY_BATCH_AUTO_COMMIT_ENABLED, useValue: true },
    {
      provide: HUMAN_CORRECTION_EXECUTION,
      inject: [
        HUMAN_CORRECTION_CLIENT,
        HUMAN_CORRECTION_TRUSTED_CONNECTION,
        scopedTokens.get(ActivityTimeCorrectionCommandService)!,
        scopedTokens.get(ActivityTimeCorrectionBackgroundService)!,
        scopedTokens.get(ActivityBatchWorker)!,
      ],
      useFactory: (
        client: PrismaService | null,
        connection: HumanCorrectionTrustedConnection | null,
        commands: ActivityTimeCorrectionCommandService,
        background: ActivityTimeCorrectionBackgroundService,
        worker: ActivityBatchWorker,
      ): HumanCorrectionExecution | null => {
        if (client === null && connection === null) return null;
        if (!client || !connection || connection.client !== client)
          throw new HumanCorrectionRuntimeSetupError('SCOPED_CLIENT_BINDING');
        return Object.freeze({
          client,
          database: connection.database,
          commands,
          background,
          worker,
        });
      },
    },
  ],
  exports: [HUMAN_CORRECTION_EXECUTION, HUMAN_CORRECTION_BACKGROUND_BUDGET],
})
export class HumanCorrectionExecutionModule {}
