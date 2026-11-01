import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ActivityWorkflowGate } from '../../common/activity-workflow/activity-workflow.gate';
import type { DatabaseConfig } from '../../config/database.config';
import { PrismaService } from '../../database/prisma.service';
import { ActivityTimeCorrectionAccessService } from './activity-time-correction-access.service';
import { ActivityTimeCorrectionBackgroundService } from './activity-time-correction-background.service';
import { ActivityTimeCorrectionCommandService } from './activity-time-correction-command.service';
import { CorrectionApplicationService } from './correction-application.service';
import {
  HUMAN_CORRECTION_BACKGROUND_BUDGET,
  type HumanCorrectionBackgroundBudget,
} from './human-correction-background-budget';
import {
  HUMAN_CORRECTION_EXECUTION,
  type HumanCorrectionExecution,
} from './human-correction-execution.module';
import { HumanCorrectionItemAuthority } from './human-correction-item-authority';
import {
  assertHumanCorrectionPoolBudget,
  HumanCorrectionClientSetupError,
} from './human-correction-runtime-client';

@Injectable()
export class HumanCorrectionHttpBoundary implements OnModuleInit {
  constructor(
    private readonly normal: PrismaService,
    config: ConfigService,
    @Inject(HUMAN_CORRECTION_EXECUTION) private readonly scope: HumanCorrectionExecution | null,
  ) {
    if (scope) {
      if (normal === scope.client) throw new HumanCorrectionClientSetupError('SHARED_CLIENT');
      if (config.get('app.contributionShadowMode') === 'shadow')
        throw new HumanCorrectionClientSetupError('UNBUDGETED_SHADOW_CLIENT');
      const database = config.get<DatabaseConfig>('database');
      assertHumanCorrectionPoolBudget(database?.url, database?.humanCorrectionUrl);
    }
  }

  async onModuleInit(): Promise<void> {
    const scope = this.scope;
    if (!scope) return;
    try {
      // N is not presumed to be U, nor is its configured username a proof.
      // Check BOTH current and reset/session identity. Direct Item authority or
      // ability to become P makes the split invalid and startup fails closed.
      await this.normal.$transaction(async (tx) => {
        await tx.$executeRaw`SET TRANSACTION READ ONLY`;
        const rows = await tx.$queryRaw<Array<{ safe: boolean }>>`
          WITH identities AS (
            SELECT r.oid FROM (VALUES (session_user::text),(current_user::text)) AS i(name)
            JOIN pg_catalog.pg_roles r ON r.rolname=i.name
          )
          SELECT current_database()=${scope.database.name}
          AND (SELECT oid::text FROM pg_catalog.pg_database WHERE datname=current_database())=${String(scope.database.oid)}
          AND (SELECT count(*) FROM identities)=2 AND NOT EXISTS (
            SELECT 1 FROM pg_catalog.pg_roles r
            WHERE EXISTS (SELECT 1 FROM identities i WHERE pg_catalog.pg_has_role(i.oid,r.oid,'SET'))
            AND (
              r.rolsuper OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication OR r.rolbypassrls
              OR r.rolname='r5_human_queue_login_20261030_q1'
              OR EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.member=r.oid AND m.admin_option)
              OR pg_catalog.pg_has_role(r.oid,(SELECT relowner FROM pg_catalog.pg_class WHERE oid='public."ActivityBatchJobItem"'::regclass),'USAGE')
              OR pg_catalog.pg_has_role(r.oid,(SELECT datdba FROM pg_catalog.pg_database WHERE datname=current_database()),'USAGE')
              OR pg_catalog.pg_has_role(r.oid,(SELECT nspowner FROM pg_catalog.pg_namespace WHERE nspname='public'),'USAGE')
              OR pg_catalog.has_schema_privilege(r.oid,'public','CREATE')
              OR pg_catalog.has_table_privilege(r.oid,'public."ActivityBatchJobItem"','INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER')
              OR pg_catalog.has_any_column_privilege(r.oid,'public."ActivityBatchJobItem"','INSERT,UPDATE')
            )
          ) AS safe
        `;
        if (rows.length !== 1 || rows[0].safe !== true)
          throw new HumanCorrectionClientSetupError('ORDINARY_ITEM_AUTHORITY');
      });
    } catch {
      try {
        await scope.client.$disconnect();
      } catch {
        throw new HumanCorrectionClientSetupError('ORDINARY_BOUNDARY_CLEANUP');
      }
      throw new HumanCorrectionClientSetupError('ORDINARY_ITEM_AUTHORITY');
    }
  }
}

/** Selection happens once while constructing the graph. An enabled Human call
 * can never fall back to the ordinary client after any rejection. */
export const humanCorrectionHttpProviders = [
  HumanCorrectionHttpBoundary,
  {
    provide: ActivityTimeCorrectionCommandService,
    inject: [
      HUMAN_CORRECTION_EXECUTION,
      PrismaService,
      CorrectionApplicationService,
      HUMAN_CORRECTION_BACKGROUND_BUDGET,
    ],
    useFactory: (
      scope: HumanCorrectionExecution | null,
      normal: PrismaService,
      corrections: CorrectionApplicationService,
      budget: HumanCorrectionBackgroundBudget,
    ) =>
      scope
        ? scope.commands
        : new ActivityTimeCorrectionCommandService(normal, corrections, budget),
  },
  {
    provide: ActivityTimeCorrectionBackgroundService,
    inject: [
      HUMAN_CORRECTION_EXECUTION,
      PrismaService,
      ActivityTimeCorrectionCommandService,
      ActivityTimeCorrectionAccessService,
      ActivityWorkflowGate,
      HumanCorrectionItemAuthority,
    ],
    useFactory: (
      scope: HumanCorrectionExecution | null,
      normal: PrismaService,
      commands: ActivityTimeCorrectionCommandService,
      access: ActivityTimeCorrectionAccessService,
      workflow: ActivityWorkflowGate,
      items: HumanCorrectionItemAuthority,
    ) =>
      scope
        ? scope.background
        : new ActivityTimeCorrectionBackgroundService(normal, commands, access, workflow, items),
  },
];
