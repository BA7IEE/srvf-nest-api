import { Injectable } from '@nestjs/common';
import { Prisma, Role } from '@prisma/client';

import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { ActivityDraftAuditRecorder } from './activity-draft-audit-recorder';
import type {
  AppActivityQualificationRulesDto,
  PutAppManagedActivityQualificationRulesDto,
} from './dto/app/app-activity-qualification-rules.dto';
import {
  canonicalizeQualificationRuleSets,
  qualificationRuleSetPublicDefinition,
  qualificationRuleSetsInputFromCanonical,
  qualificationRuleSetsFromStored,
  qualificationRuleStoredValue,
  type CanonicalQualificationRuleSet,
  type CanonicalQualificationRuleSetsDefinition,
  type CanonicalQualificationRuleSetsResult,
  type QualificationRuleScope,
} from './qualification-rule-set-definition';

type PrismaTx = Prisma.TransactionClient;

const ruleSelect = {
  ruleTypeCode: true,
  enforcementCode: true,
  operator: true,
  valueJson: true,
  warnScore: true,
  message: true,
  sortOrder: true,
} as const satisfies Prisma.ActivityQualificationRuleSelect;

const ruleSetSelect = {
  id: true,
  activityId: true,
  sessionId: true,
  positionId: true,
  version: true,
  statusCode: true,
  rules: {
    select: ruleSelect,
    orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
  },
} as const satisfies Prisma.ActivityQualificationRuleSetSelect;

type RuleSetRow = Prisma.ActivityQualificationRuleSetGetPayload<{
  select: typeof ruleSetSelect;
}>;

export interface QualificationRuleSetResolvedConfig {
  scope: QualificationRuleScope;
  ruleSetVersionId: string;
  version: number;
  definitionHash: string;
}

function scopeKey(scope: QualificationRuleScope): string {
  return `${scope.sessionId ?? ''}\u0000${scope.positionId ?? ''}`;
}

@Injectable()
export class QualificationRuleSetVersionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: ActivityDraftAuditRecorder,
  ) {}

  async getManaged(
    activityId: string,
    user: CurrentUserPayload,
  ): Promise<AppActivityQualificationRulesDto> {
    const activity = await this.prisma.activity.findFirst({
      where: this.managedActivityWhere(activityId, user),
      select: { statusCode: true },
    });
    if (!activity) throw new BizException(BizCode.ACTIVITY_NOT_FOUND);
    if (activity.statusCode !== 'draft' && activity.statusCode !== 'published') {
      throw new BizException(BizCode.ACTIVITY_STATUS_INVALID);
    }
    const statusCode = activity.statusCode === 'draft' ? 'draft' : 'active';
    const versions = await this.currentVersions(this.prisma, activityId, statusCode);
    if (statusCode === 'active') {
      await this.assertActivePositionPointers(this.prisma, activityId, versions);
    }
    return this.toDto(versions);
  }

  async putManaged(
    activityId: string,
    dto: PutAppManagedActivityQualificationRulesDto,
    user: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<AppActivityQualificationRulesDto> {
    const target = canonicalizeQualificationRuleSets(dto);
    return await this.prisma.$transaction(async (tx) => {
      const activity = await this.lockManagedActivity(tx, activityId, user);
      if (activity.statusCode !== 'draft') {
        throw new BizException(
          activity.statusCode === 'published'
            ? BizCode.ACTIVITY_CHANGE_REVIEW_REQUIRED
            : BizCode.ACTIVITY_STATUS_INVALID,
        );
      }
      await this.assertDraftScopeTargets(tx, activityId, target.definition);
      const existing = await this.currentVersions(tx, activityId, 'draft');
      const existingTarget = this.targetFromRows(existing);
      if (existingTarget.targetHash === target.targetHash) return this.toDto(existing);

      const existingByScope = new Map(
        existing.map((row) => [
          scopeKey({ sessionId: row.sessionId, positionId: row.positionId }),
          row,
        ]),
      );
      const targetByScope = new Map(
        target.definition.ruleSets.map((ruleSet) => [scopeKey(ruleSet.scope), ruleSet]),
      );
      for (const [key, row] of existingByScope) {
        const desired = targetByScope.get(key);
        const current = existingTarget.definition.ruleSets.find(
          (ruleSet) => scopeKey(ruleSet.scope) === key,
        );
        if (!desired || !current || desired.definitionHash !== current.definitionHash) {
          await tx.activityQualificationRuleSet.update({
            where: { id: row.id },
            data: { statusCode: 'retired' },
          });
        }
      }
      for (const desired of target.definition.ruleSets) {
        const key = scopeKey(desired.scope);
        const current = existingTarget.definition.ruleSets.find(
          (ruleSet) => scopeKey(ruleSet.scope) === key,
        );
        if (current && current.definitionHash === desired.definitionHash) continue;
        await this.createVersion(tx, activityId, desired, 'draft');
      }
      await this.audit.log({
        activityId,
        actorUserId: user.id,
        actorRoleSnap: user.role,
        auditMeta,
        tx,
        changedFields: ['qualificationRuleSets'],
      });
      return this.toDto(await this.currentVersions(tx, activityId, 'draft'));
    });
  }

  async currentTarget(
    tx: PrismaTx,
    activityId: string,
    activityStatus: string,
  ): Promise<CanonicalQualificationRuleSetsDefinition> {
    const statusCode = activityStatus === 'draft' ? 'draft' : 'active';
    const versions = await this.currentVersions(tx, activityId, statusCode);
    // A V5 stale guard must reject an active pointer drift before proposal application changes
    // any session/position rows. This is intentionally skipped for draft, whose pointers are
    // required to remain null by the direct-write path instead.
    if (statusCode === 'active') {
      await this.assertActivePositionPointers(tx, activityId, versions);
    }
    return this.targetFromRows(versions).definition;
  }

  /** Compact active pointers only; the full rule definitions stay in the proposal snapshot. */
  async activeResolvedConfig(
    tx: PrismaTx,
    activityId: string,
  ): Promise<QualificationRuleSetResolvedConfig[]> {
    const active = await this.currentVersions(tx, activityId, 'active');
    const target = this.targetFromRows(active).definition;
    await this.assertActivePositionPointers(tx, activityId, active);
    const byScope = new Map(
      active.map((row) => [
        scopeKey({ sessionId: row.sessionId, positionId: row.positionId }),
        row,
      ]),
    );
    return target.ruleSets.map((ruleSet) => {
      const row = byScope.get(scopeKey(ruleSet.scope));
      if (!row) throw new BizException(BizCode.ACTIVITY_QUALIFICATION_CONFIGURATION_INVALID);
      return {
        scope: ruleSet.scope,
        ruleSetVersionId: row.id,
        version: row.version,
        definitionHash: ruleSet.definitionHash,
      };
    });
  }

  /**
   * V4 proposals intentionally retain their historic rule-free snapshot/hash envelope.  They may
   * still cancel a persisted session or position, so check just the active scope metadata before
   * accepting that command: an affected RuleSet must be explicitly retired through a V5 command.
   */
  async assertNoActiveRuleSetForCancelledTargets(
    tx: PrismaTx,
    input: { activityId: string; sessionIds: readonly string[]; positionIds: readonly string[] },
  ): Promise<void> {
    const conditions: Prisma.ActivityQualificationRuleSetWhereInput[] = [];
    if (input.sessionIds.length > 0) conditions.push({ sessionId: { in: [...input.sessionIds] } });
    if (input.positionIds.length > 0) {
      conditions.push({ positionId: { in: [...input.positionIds] } });
    }
    if (conditions.length === 0) return;
    const active = await tx.activityQualificationRuleSet.findFirst({
      where: { activityId: input.activityId, statusCode: 'active', OR: conditions },
      select: { id: true },
    });
    if (active) throw new BizException(BizCode.ACTIVITY_PUBLISH_REVIEW_SNAPSHOT_INVALID);
  }

  /**
   * Called after Activity → Session → Position application under the already-held Activity root lock.
   * Active versions are frozen by D83; a changed definition is therefore retire + append, never update.
   */
  async applyPublishedTarget(
    tx: PrismaTx,
    input: {
      activityId: string;
      requestType: 'initial' | 'change';
      target: CanonicalQualificationRuleSetsDefinition;
      sessionIds: ReadonlyMap<string, string>;
      positionIds: ReadonlyMap<string, string>;
    },
  ): Promise<QualificationRuleSetResolvedConfig[]> {
    const normalized = this.remapProposalTarget(input.target, input.sessionIds, input.positionIds);
    await this.assertPublishedScopeTargets(tx, input.activityId, normalized.definition);
    const active = await this.currentVersions(tx, input.activityId, 'active');
    if (input.requestType === 'initial') {
      if (active.length !== 0)
        throw new BizException(BizCode.ACTIVITY_PUBLISH_REVIEW_SNAPSHOT_INVALID);
      const draft = await this.currentVersions(tx, input.activityId, 'draft');
      if (this.targetFromRows(draft).targetHash !== normalized.targetHash) {
        throw new BizException(BizCode.ACTIVITY_PUBLISH_REVIEW_EXPECTED_SNAPSHOT_MISMATCH);
      }
      for (const row of draft) {
        await tx.activityQualificationRuleSet.update({
          where: { id: row.id },
          data: { statusCode: 'active' },
        });
      }
      const activated = await this.currentVersions(tx, input.activityId, 'active');
      await this.assignActivePositionPointers(tx, input.activityId, activated);
      return await this.resolvedConfigFromActive(tx, input.activityId, activated);
    }

    // `rebuildCurrent` validates every active pointer before `applyPositions` can cancel or
    // replace a position. Do not re-run that precondition here: an explicit rule-set cancel for
    // a just-cancelled position must be able to retire its formerly valid active version.
    const activeTarget = this.targetFromRows(active).definition;
    const activeByScope = new Map(
      active.map((row) => [
        scopeKey({ sessionId: row.sessionId, positionId: row.positionId }),
        row,
      ]),
    );
    const currentByScope = new Map(
      activeTarget.ruleSets.map((ruleSet) => [scopeKey(ruleSet.scope), ruleSet]),
    );
    const targetByScope = new Map(
      normalized.definition.ruleSets.map((ruleSet) => [scopeKey(ruleSet.scope), ruleSet]),
    );
    for (const [key, row] of activeByScope) {
      const desired = targetByScope.get(key);
      const current = currentByScope.get(key);
      if (!desired || !current || desired.definitionHash !== current.definitionHash) {
        if (row.positionId !== null) {
          await this.clearPositionPointer(tx, input.activityId, row.positionId, row.id);
        }
        await tx.activityQualificationRuleSet.update({
          where: { id: row.id },
          data: { statusCode: 'retired' },
        });
      }
    }
    for (const desired of normalized.definition.ruleSets) {
      const key = scopeKey(desired.scope);
      const current = currentByScope.get(key);
      if (current && current.definitionHash === desired.definitionHash) continue;
      await this.createVersion(tx, input.activityId, desired, 'active');
    }
    const refreshed = await this.currentVersions(tx, input.activityId, 'active');
    await this.assignActivePositionPointers(tx, input.activityId, refreshed);
    return await this.resolvedConfigFromActive(tx, input.activityId, refreshed);
  }

  /** Clone carries definition only and intentionally leaves every target position pointer null. */
  async cloneFromSource(
    tx: PrismaTx,
    input: {
      sourceActivityId: string;
      sourceStatus: string;
      targetActivityId: string;
      sessionIds: ReadonlyMap<string, string>;
      positionIds: ReadonlyMap<string, string>;
    },
  ): Promise<void> {
    const source = await this.currentVersions(
      tx,
      input.sourceActivityId,
      input.sourceStatus === 'draft' ? 'draft' : 'active',
    );
    if (source.length === 0) return;
    if (input.sourceStatus !== 'draft') {
      await this.assertActivePositionPointers(tx, input.sourceActivityId, source);
    }
    const target = this.targetFromRows(source).definition;
    const remapped = canonicalizeQualificationRuleSets(
      {
        ruleSets: target.ruleSets.map((ruleSet) => ({
          scope: {
            sessionId:
              ruleSet.scope.sessionId === null
                ? null
                : (input.sessionIds.get(ruleSet.scope.sessionId) ?? null),
            positionId:
              ruleSet.scope.positionId === null
                ? null
                : (input.positionIds.get(ruleSet.scope.positionId) ?? null),
          },
          rules: qualificationRuleSetsInputFromCanonical({ ruleSets: [ruleSet] }).ruleSets[0].rules,
        })),
      },
      'ACTIVITY_QUALIFICATION_CONFIGURATION_INVALID',
    );
    if (
      target.ruleSets.some(
        (ruleSet) =>
          (ruleSet.scope.sessionId !== null && !input.sessionIds.has(ruleSet.scope.sessionId)) ||
          (ruleSet.scope.positionId !== null && !input.positionIds.has(ruleSet.scope.positionId)),
      )
    ) {
      throw new BizException(BizCode.ACTIVITY_QUALIFICATION_CONFIGURATION_INVALID);
    }
    await this.assertDraftScopeTargets(tx, input.targetActivityId, remapped.definition);
    for (const ruleSet of remapped.definition.ruleSets) {
      await this.createVersion(tx, input.targetActivityId, ruleSet, 'draft');
    }
  }

  private targetFromRows(rows: RuleSetRow[]): CanonicalQualificationRuleSetsResult {
    return qualificationRuleSetsFromStored(
      rows.map((row) => ({
        sessionId: row.sessionId,
        positionId: row.positionId,
        rules: row.rules,
      })),
    );
  }

  private remapProposalTarget(
    target: CanonicalQualificationRuleSetsDefinition,
    sessionIds: ReadonlyMap<string, string>,
    positionIds: ReadonlyMap<string, string>,
  ): CanonicalQualificationRuleSetsResult {
    const resolve = (value: string | null, ids: ReadonlyMap<string, string>): string | null => {
      if (value === null) return null;
      const resolved = ids.get(value);
      if (!resolved) throw new BizException(BizCode.ACTIVITY_PUBLISH_REVIEW_SNAPSHOT_INVALID);
      return resolved;
    };
    const input = qualificationRuleSetsInputFromCanonical(target);
    return canonicalizeQualificationRuleSets(
      {
        ruleSets: input.ruleSets.map((ruleSet) => ({
          ...ruleSet,
          scope: {
            sessionId: resolve(ruleSet.scope.sessionId, sessionIds),
            positionId: resolve(ruleSet.scope.positionId, positionIds),
          },
        })),
      },
      'ACTIVITY_PUBLISH_REVIEW_SNAPSHOT_INVALID',
    );
  }

  private async currentVersions(
    client: PrismaTx | PrismaService,
    activityId: string,
    statusCode: 'draft' | 'active',
  ): Promise<RuleSetRow[]> {
    return await client.activityQualificationRuleSet.findMany({
      where: { activityId, statusCode },
      select: ruleSetSelect,
      orderBy: [{ sessionId: 'asc' }, { positionId: 'asc' }, { id: 'asc' }],
    });
  }

  private async createVersion(
    tx: PrismaTx,
    activityId: string,
    definition: CanonicalQualificationRuleSet,
    statusCode: 'draft' | 'active',
  ): Promise<void> {
    const latest = await tx.activityQualificationRuleSet.aggregate({
      where: {
        activityId,
        sessionId: definition.scope.sessionId,
        positionId: definition.scope.positionId,
      },
      _max: { version: true },
    });
    // D83 freezes the parent before child-rule INSERTs. Build every immutable version as a
    // complete draft first, then flip the fully populated parent to active in this same root
    // transaction when publishing a changed target.
    const created = await tx.activityQualificationRuleSet.create({
      data: {
        activityId,
        sessionId: definition.scope.sessionId,
        positionId: definition.scope.positionId,
        version: (latest._max.version ?? 0) + 1,
        statusCode: 'draft',
        rules: {
          create: definition.rules.map((rule) => ({
            ruleTypeCode: rule.ruleTypeCode,
            enforcementCode: rule.enforcementCode,
            operator: rule.operator,
            valueJson: qualificationRuleStoredValue(rule),
            warnScore: rule.warnScore,
            message: rule.message,
            sortOrder: rule.sortOrder,
          })),
        },
      },
      select: { id: true },
    });
    if (statusCode === 'active') {
      await tx.activityQualificationRuleSet.update({
        where: { id: created.id },
        data: { statusCode: 'active' },
      });
    }
  }

  private async resolvedConfigFromActive(
    tx: PrismaTx,
    activityId: string,
    active: RuleSetRow[],
  ): Promise<QualificationRuleSetResolvedConfig[]> {
    const target = this.targetFromRows(active).definition;
    const byScope = new Map(
      active.map((row) => [
        scopeKey({ sessionId: row.sessionId, positionId: row.positionId }),
        row,
      ]),
    );
    await this.assertActivePositionPointers(tx, activityId, active);
    return target.ruleSets.map((ruleSet) => {
      const row = byScope.get(scopeKey(ruleSet.scope));
      if (!row) throw new BizException(BizCode.ACTIVITY_QUALIFICATION_CONFIGURATION_INVALID);
      return {
        scope: ruleSet.scope,
        ruleSetVersionId: row.id,
        version: row.version,
        definitionHash: ruleSet.definitionHash,
      };
    });
  }

  private async assertPublishedScopeTargets(
    tx: PrismaTx,
    activityId: string,
    definition: CanonicalQualificationRuleSetsDefinition,
  ): Promise<void> {
    const sessionIds = [
      ...new Set(
        definition.ruleSets
          .map((ruleSet) => ruleSet.scope.sessionId)
          .filter((id): id is string => id !== null),
      ),
    ];
    const positionScopes = definition.ruleSets.filter(
      (
        ruleSet,
      ): ruleSet is CanonicalQualificationRuleSet & {
        scope: { sessionId: string; positionId: string };
      } => ruleSet.scope.sessionId !== null && ruleSet.scope.positionId !== null,
    );
    const sessions: Array<{ id: string; statusCode: string }> =
      sessionIds.length === 0
        ? []
        : await tx.activitySession.findMany({
            where: { activityId, id: { in: sessionIds }, deletedAt: null },
            select: { id: true, statusCode: true },
          });
    const positions: Array<{ id: string; sessionId: string }> =
      positionScopes.length === 0
        ? []
        : await tx.activitySessionPosition.findMany({
            where: {
              activityId,
              id: { in: positionScopes.map((ruleSet) => ruleSet.scope.positionId) },
              deletedAt: null,
            },
            select: { id: true, sessionId: true },
          });
    if (
      sessions.length !== sessionIds.length ||
      sessions.some((session) => session.statusCode !== 'scheduled') ||
      positions.length !== positionScopes.length
    ) {
      throw new BizException(BizCode.ACTIVITY_PUBLISH_REVIEW_SNAPSHOT_INVALID);
    }
    const positionById = new Map(positions.map((position) => [position.id, position.sessionId]));
    if (
      positionScopes.some(
        (ruleSet) => positionById.get(ruleSet.scope.positionId) !== ruleSet.scope.sessionId,
      )
    ) {
      throw new BizException(BizCode.ACTIVITY_PUBLISH_REVIEW_SNAPSHOT_INVALID);
    }
  }

  private async assertActivePositionPointers(
    tx: PrismaTx | PrismaService,
    activityId: string,
    active: RuleSetRow[],
  ): Promise<void> {
    const positionRuleSets = active.filter(
      (row): row is RuleSetRow & { sessionId: string; positionId: string } =>
        row.sessionId !== null && row.positionId !== null,
    );
    const positions = await tx.activitySessionPosition.findMany({
      where: { activityId, deletedAt: null },
      select: { id: true, sessionId: true, qualificationRuleSetId: true },
    });
    const expected = new Map(positionRuleSets.map((row) => [row.positionId, row]));
    for (const position of positions) {
      const ruleSet = expected.get(position.id);
      if (ruleSet) {
        if (
          position.sessionId !== ruleSet.sessionId ||
          position.qualificationRuleSetId !== ruleSet.id
        ) {
          throw new BizException(BizCode.ACTIVITY_QUALIFICATION_CONFIGURATION_INVALID);
        }
      } else if (position.qualificationRuleSetId !== null) {
        throw new BizException(BizCode.ACTIVITY_QUALIFICATION_CONFIGURATION_INVALID);
      }
    }
    if (positions.length < positionRuleSets.length) {
      throw new BizException(BizCode.ACTIVITY_QUALIFICATION_CONFIGURATION_INVALID);
    }
  }

  private async assignActivePositionPointers(
    tx: PrismaTx,
    activityId: string,
    active: RuleSetRow[],
  ): Promise<void> {
    const positionRuleSets = active.filter(
      (row): row is RuleSetRow & { sessionId: string; positionId: string } =>
        row.sessionId !== null && row.positionId !== null,
    );
    for (const ruleSet of positionRuleSets) {
      const position = await tx.activitySessionPosition.findFirst({
        where: { id: ruleSet.positionId, activityId, deletedAt: null },
        select: { sessionId: true, qualificationRuleSetId: true },
      });
      if (!position || position.sessionId !== ruleSet.sessionId) {
        throw new BizException(BizCode.ACTIVITY_PUBLISH_REVIEW_SNAPSHOT_INVALID);
      }
      if (position.qualificationRuleSetId === ruleSet.id) continue;
      if (position.qualificationRuleSetId !== null) {
        throw new BizException(BizCode.ACTIVITY_QUALIFICATION_CONFIGURATION_INVALID);
      }
      const updated = await tx.activitySessionPosition.updateMany({
        where: { id: ruleSet.positionId, activityId, qualificationRuleSetId: null },
        data: { qualificationRuleSetId: ruleSet.id },
      });
      if (updated.count !== 1) {
        throw new BizException(BizCode.ACTIVITY_QUALIFICATION_CONFIGURATION_INVALID);
      }
    }
    await this.assertActivePositionPointers(tx, activityId, active);
  }

  private async clearPositionPointer(
    tx: PrismaTx,
    activityId: string,
    positionId: string,
    ruleSetId: string,
  ): Promise<void> {
    const cleared = await tx.activitySessionPosition.updateMany({
      where: { id: positionId, activityId, qualificationRuleSetId: ruleSetId },
      data: { qualificationRuleSetId: null },
    });
    if (cleared.count !== 1) {
      throw new BizException(BizCode.ACTIVITY_QUALIFICATION_CONFIGURATION_INVALID);
    }
  }

  private async assertDraftScopeTargets(
    tx: PrismaTx,
    activityId: string,
    definition: CanonicalQualificationRuleSetsDefinition,
  ): Promise<void> {
    const sessionIds = [
      ...new Set(
        definition.ruleSets
          .map((ruleSet) => ruleSet.scope.sessionId)
          .filter((id): id is string => id !== null),
      ),
    ];
    const positionScopes = definition.ruleSets.filter(
      (
        ruleSet,
      ): ruleSet is CanonicalQualificationRuleSet & {
        scope: { sessionId: string; positionId: string };
      } => ruleSet.scope.positionId !== null && ruleSet.scope.sessionId !== null,
    );
    const [sessions, positions, pointedDraftPositions] = await Promise.all([
      sessionIds.length === 0
        ? Promise.resolve([])
        : tx.activitySession.findMany({
            where: { activityId, id: { in: sessionIds }, deletedAt: null },
            select: { id: true },
          }),
      positionScopes.length === 0
        ? Promise.resolve([])
        : tx.activitySessionPosition.findMany({
            where: {
              activityId,
              id: { in: positionScopes.map((ruleSet) => ruleSet.scope.positionId) },
              deletedAt: null,
            },
            select: { id: true, sessionId: true },
          }),
      tx.activitySessionPosition.findMany({
        where: { activityId, deletedAt: null, qualificationRuleSetId: { not: null } },
        select: { id: true },
      }),
    ]);
    if (sessions.length !== sessionIds.length || pointedDraftPositions.length !== 0) {
      throw new BizException(BizCode.ACTIVITY_QUALIFICATION_CONFIGURATION_INVALID);
    }
    const positionById = new Map(positions.map((position) => [position.id, position.sessionId]));
    if (
      positionScopes.some(
        (ruleSet) => positionById.get(ruleSet.scope.positionId) !== ruleSet.scope.sessionId,
      )
    ) {
      throw new BizException(BizCode.ACTIVITY_QUALIFICATION_CONFIGURATION_INVALID);
    }
  }

  private async lockManagedActivity(
    tx: PrismaTx,
    activityId: string,
    user: CurrentUserPayload,
  ): Promise<{ statusCode: string }> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id" FROM "Activity"
      WHERE "id" = ${activityId} AND "deletedAt" IS NULL
      FOR UPDATE
    `);
    if (rows.length !== 1) throw new BizException(BizCode.ACTIVITY_NOT_FOUND);
    const activity = await tx.activity.findFirst({
      where: this.managedActivityWhere(activityId, user),
      select: { statusCode: true },
    });
    if (!activity) throw new BizException(BizCode.ACTIVITY_NOT_FOUND);
    return activity;
  }

  private managedActivityWhere(
    activityId: string,
    user: CurrentUserPayload,
  ): Prisma.ActivityWhereInput {
    if (user.role === Role.SUPER_ADMIN) return { id: activityId, deletedAt: null };
    if (!user.memberId) throw new BizException(BizCode.FORBIDDEN);
    return { id: activityId, deletedAt: null, initiatorMemberId: user.memberId };
  }

  private toDto(rows: RuleSetRow[]): AppActivityQualificationRulesDto {
    const definition = this.targetFromRows(rows).definition;
    const versions = new Map(
      rows.map((row) => [
        scopeKey({ sessionId: row.sessionId, positionId: row.positionId }),
        row.version,
      ]),
    );
    return {
      ruleSets: definition.ruleSets.map((ruleSet) => ({
        ...qualificationRuleSetPublicDefinition(ruleSet),
        version: versions.get(scopeKey(ruleSet.scope))!,
      })),
    };
  }
}
