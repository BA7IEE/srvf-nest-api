import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { Prisma, PrismaClient } from '@prisma/client';
import type {
  ActivityContributionPolicySelectionItem,
  ActivityContributionPolicySelectionRevision,
  ContributionShadowMappingApproval,
  ContributionShadowLegacySourceAnchor,
  ContributionPolicyVersion,
} from '@prisma/client';
import appConfig from '../../config/app.config';
import databaseConfig from '../../config/database.config';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import {
  activityContributionPolicySelectionHash,
  createActivityContributionPolicySelectionDocument,
  parseActivityContributionPolicySelectionDocument,
  parseActivityContributionPolicySelectionItem,
} from '../activities/activity-contribution-policy-selection';
import {
  compareContributionShadow,
  type ContributionShadowComparisonResult,
} from '../activities/activity-contribution-shadow-comparison';
import { fingerprintContributionPolicyVersion } from '../activities/activity-contribution-policy-definition';
import {
  hashLegacySource,
  type ShadowMappingApplicationInput,
  type ShadowComparisonInput,
  type ShadowAttemptInput,
} from './contribution-shadow-evidence.write.service';

type PrismaTx = Prisma.TransactionClient;

/**
 * One post-commit invocation budget, never a per-stage five-second reset.
 * Connection establishment still needs its own enforceable transport bound;
 * reserving that time here is not evidence that the driver actually enforces it.
 * The authenticated application caller, not an HTTP input, owns this object.
 */
export class ShadowComparisonBudget {
  private deadline: number;

  constructor(private readonly monotonicNow: () => number = () => performance.now()) {
    const started = monotonicNow();
    if (!Number.isFinite(started)) throw new Error('shadow comparison clock unavailable');
    this.deadline = started + 5000;
  }

  remainingMs(): number {
    const now = this.monotonicNow();
    if (!Number.isFinite(now)) throw new Error('shadow comparison clock unavailable');
    return Math.max(0, Math.floor(this.deadline - now));
  }

  /** A containing transaction may shorten, never renew, this invocation. */
  constrainRemaining(maxMs: number): void {
    if (!Number.isSafeInteger(maxMs) || maxMs < 0)
      throw new Error('shadow comparison containing budget invalid');
    const now = this.monotonicNow();
    if (!Number.isFinite(now)) throw new Error('shadow comparison clock unavailable');
    this.deadline = Math.min(this.deadline, now + maxMs);
  }

  transactionOptions(connectionReserveMs = 0, poolWaitCapMs = 500) {
    if (!Number.isSafeInteger(connectionReserveMs) || connectionReserveMs < 0)
      throw new Error('shadow comparison connection reserve invalid');
    if (!Number.isSafeInteger(poolWaitCapMs) || poolWaitCapMs < 1 || poolWaitCapMs > 500)
      throw new Error('shadow comparison pool wait cap invalid');
    const available = this.remainingMs() - connectionReserveMs;
    if (available < 2) throw new Error('shadow comparison budget exhausted');
    const maxWait = Math.min(poolWaitCapMs, Math.max(1, Math.floor(available / 4)));
    return {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      maxWait,
      timeout: available - maxWait,
    };
  }
}

export interface RegisteredShadowWindow {
  id: string;
  signedMappingVersion: string;
}

/** Fixed-order scalar JSON array, UTF-8/SHA-256; only a diagnostic, never proof. */
function shadowDiagnosticHash(domain: string, fields: readonly (string | number | null)[]): string {
  return createHash('sha256')
    .update(`SRVF:E3-2:${domain}:v1:${JSON.stringify(fields)}`, 'utf8')
    .digest('hex');
}

/**
 * Complete immutable source-set commitment, independent of policy outcomes.
 * Expected IDs must come from the successful legacy transaction, never a client.
 * This verifies correspondence, not Human eligibility or database proof closure.
 */
export function prepareShadowAttempt(
  context: Omit<ShadowAttemptInput, 'committedFactHash' | 'expectedRecordCount'>,
  expectedRecordIds: readonly string[],
  sources: readonly ContributionShadowLegacySourceAnchor[],
): ShadowAttemptInput {
  const fail = () => new Error('shadow committed source set mismatch');
  if (
    [
      context.windowId,
      context.auditLogId,
      context.sheetId,
      context.activityId,
      context.signedMappingVersion,
    ].some((key) => typeof key !== 'string' || !key || key.trim() !== key) ||
    context.signedMappingVersion.length > 128 ||
    !Number.isSafeInteger(context.sheetVersion) ||
    context.sheetVersion < 1 ||
    expectedRecordIds.length === 0 ||
    expectedRecordIds.length !== sources.length
  )
    throw fail();
  const expected = new Set(expectedRecordIds);
  if (
    expected.size !== expectedRecordIds.length ||
    expectedRecordIds.some((id) => typeof id !== 'string' || !id || id.trim() !== id)
  )
    throw fail();
  const anchorIds = new Set<string>();
  const tuples = sources.map((source) => {
    if (
      !source.id ||
      anchorIds.has(source.id) ||
      !source.memberId ||
      !expected.delete(source.recordId) ||
      source.windowId !== context.windowId ||
      source.auditLogId !== context.auditLogId ||
      source.sheetId !== context.sheetId ||
      source.activityId !== context.activityId ||
      source.sheetVersion !== context.sheetVersion ||
      source.hashAlgorithmCode !== 'sha256' ||
      source.canonicalVersion !== 1
    )
      throw fail();
    anchorIds.add(source.id);
    const matched = source.sourceKindCode === 'matched';
    if (
      matched
        ? !source.legacyRuleId || source.pointsBelow === null
        : source.sourceKindCode !== 'no_match' ||
          source.legacyRuleId !== null ||
          source.durationThreshold !== null ||
          source.pointsBelow !== null ||
          source.pointsAbove !== null
    )
      throw fail();
    const observed = hashLegacySource({
      ...source,
      source: matched
        ? {
            sourceKindCode: 'matched',
            legacyRuleId: source.legacyRuleId!,
            durationThreshold: source.durationThreshold,
            pointsBelow: source.pointsBelow!,
            pointsAbove: source.pointsAbove,
          }
        : {
            sourceKindCode: 'no_match',
            legacyRuleId: null,
            durationThreshold: null,
            pointsBelow: null,
            pointsAbove: null,
          },
    });
    if (observed !== source.legacySourceHash) throw fail();
    return [source.recordId, source.memberId, source.id, source.legacySourceHash];
  });
  if (expected.size !== 0) throw fail();
  // Explicit code-unit ordering, not locale-dependent or caller/database order.
  tuples.sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0));
  const committedFactHash = createHash('sha256')
    .update(
      `SRVF:E3-2:committed-facts:v1:${JSON.stringify([
        context.windowId,
        context.auditLogId,
        context.sheetId,
        context.activityId,
        context.sheetVersion,
        context.signedMappingVersion,
        expectedRecordIds.length,
        tuples,
      ])}`,
      'utf8',
    )
    .digest('hex');
  return {
    windowId: context.windowId,
    auditLogId: context.auditLogId,
    sheetId: context.sheetId,
    activityId: context.activityId,
    sheetVersion: context.sheetVersion,
    signedMappingVersion: context.signedMappingVersion,
    expectedRecordCount: expectedRecordIds.length,
    committedFactHash,
  };
}

/** No IDs, attempt IDs or write timestamps are accepted or generated by preparation. */
export function prepareShadowEvidence(input: Parameters<typeof evaluateShadowFrozenSource>[0]): {
  application: ShadowMappingApplicationInput | null;
  comparison: ShadowComparisonInput;
} {
  const evaluated = evaluateShadowFrozenSource(input);
  const { source, mapping, selectionItem: item, policyVersion: version } = input;
  const comparable = evaluated.comparable;
  if (
    comparable &&
    (!mapping ||
      !item ||
      !version ||
      evaluated.durationSeconds === null ||
      evaluated.policyPoints === null ||
      evaluated.policyExplanationCode === null)
  )
    throw new Error('shadow evaluation preparation invariant failed');
  const application: ShadowMappingApplicationInput | null = comparable
    ? {
        approvalId: mapping!.id,
        legacySourceAnchorId: source.id,
        windowId: source.windowId,
        auditLogId: source.auditLogId,
        sheetId: source.sheetId,
        sheetVersion: source.sheetVersion,
        recordId: source.recordId,
        memberId: source.memberId,
        activityId: source.activityId,
        selectionItemId: item!.id,
        policyVersionId: version!.id,
        policyDefinitionHash: version!.definitionHash,
        evaluatorVersion: version!.evaluatorVersion,
        durationSeconds: evaluated.durationSeconds!,
        policyPoints: evaluated.policyPoints!,
        explanationCode: evaluated.policyExplanationCode!,
      }
    : null;
  const factHash = shadowDiagnosticHash('shadow-fact', [
    source.windowId,
    source.auditLogId,
    source.sheetId,
    source.sheetVersion,
    source.activityId,
    source.recordId,
    source.memberId,
    source.activityTypeCode,
    source.attendanceRoleCode,
    source.legacyServiceHours.toFixed(2),
    source.legacyPoints.toFixed(2),
    source.legacySourceHash,
    input.sourceTime.toISOString(),
  ]);
  const policySourceHash = comparable
    ? shadowDiagnosticHash('shadow-policy', [
        mapping!.id,
        mapping!.mappingVersion,
        mapping!.manifestHash,
        item!.selectionRevisionId,
        item!.id,
        version!.policyId,
        version!.id,
        version!.definitionHash,
        version!.evaluatorVersion,
        mapping!.policyRoleCode,
        mapping!.categoryCode,
        mapping!.durationSourceCode,
        evaluated.durationSeconds,
        evaluated.policyPoints,
        evaluated.policyExplanationCode,
      ])
    : null;
  return {
    application,
    comparison: {
      recordId: source.recordId,
      sheetId: source.sheetId,
      memberId: source.memberId,
      activityId: source.activityId,
      classificationCode: evaluated.classification,
      comparable,
      factHash,
      legacySourceHash: source.legacySourceHash,
      policySourceHash,
      legacyRuleId: source.legacyRuleId,
      selectionRevisionId: comparable ? item!.selectionRevisionId : null,
      selectionItemId: comparable ? item!.id : null,
      policyVersionId: comparable ? version!.id : null,
      policyId: comparable ? version!.policyId : null,
      definitionHash: comparable ? version!.definitionHash : null,
      evaluatorVersion: comparable ? version!.evaluatorVersion : null,
      legacyServiceHours: source.legacyServiceHours,
      legacyPoints: source.legacyPoints,
      durationSeconds: comparable ? evaluated.durationSeconds : null,
      policyPoints: comparable ? evaluated.policyPoints : null,
      failureCode:
        evaluated.classification === 'evaluation_error' ? 'shadow_evaluation_error' : null,
      hashAlgorithmCode: 'sha256',
      canonicalVersion: 1,
    },
  };
}

/** Single-call batch preparation only; no query, transaction or access decision. */
export function prepareShadowComparisonSet(input: {
  context: Omit<ShadowAttemptInput, 'committedFactHash' | 'expectedRecordCount'>;
  expectedRecordIds: readonly string[];
  sources: readonly ContributionShadowLegacySourceAnchor[];
  sourceTime: Date;
  mappingHistory: readonly ContributionShadowMappingApproval[];
  selectionRevision: ShadowSelectionRevision | null;
  positions: readonly {
    id: string;
    activityId: string;
    sessionId: string;
    attendanceRoleCode: string;
  }[];
  policyVersions: readonly NonNullable<
    Parameters<typeof evaluateShadowFrozenSource>[0]['policyVersion']
  >[];
}) {
  const attempt = prepareShadowAttempt(input.context, input.expectedRecordIds, input.sources);
  if (!(input.sourceTime instanceof Date) || !Number.isFinite(input.sourceTime.getTime()))
    throw new Error('shadow comparison preparation instant mismatch');
  const positions = new Map<string, (typeof input.positions)[number]>();
  for (const position of input.positions) {
    if (
      !position.id ||
      !position.sessionId ||
      position.activityId !== input.context.activityId ||
      positions.has(position.id)
    )
      throw new Error('shadow comparison preparation position mismatch');
    positions.set(position.id, position);
  }
  const items = resolveShadowSelectionsAtSource(
    input.selectionRevision,
    input.positions,
    input.sourceTime,
  );
  const selected = new Map(input.positions.map((position, index) => [position.id, items[index]]));
  const versionKey = (id: string, hash: string, evaluator: number) =>
    JSON.stringify([id, hash, evaluator]);
  const versions = new Map<string, (typeof input.policyVersions)[number]>();
  for (const version of input.policyVersions) {
    const key = versionKey(version.id, version.definitionHash, version.evaluatorVersion);
    if (versions.has(key)) throw new Error('shadow comparison preparation policy mismatch');
    versions.set(key, version);
  }
  // Candidate lookup reuse stays inside this pure call, never authorization caching.
  const mappings = new Map<string, ContributionShadowMappingApproval | null>();
  const applications: ShadowMappingApplicationInput[] = [];
  const comparisons: ShadowComparisonInput[] = [];
  for (const source of input.sources) {
    const key = JSON.stringify([source.activityTypeCode, source.attendanceRoleCode]);
    if (!mappings.has(key))
      mappings.set(
        key,
        resolveShadowMappingAtSource(input.mappingHistory, {
          activityId: source.activityId,
          activityTypeCode: source.activityTypeCode,
          attendanceRoleCode: source.attendanceRoleCode,
          mappingVersion: input.context.signedMappingVersion,
          sourceTime: input.sourceTime,
        }),
      );
    const mapping = mappings.get(key) ?? null;
    const position = mapping ? positions.get(mapping.sessionPositionId) : undefined;
    const usable =
      mapping && position && position.attendanceRoleCode === mapping.policyRoleCode
        ? mapping
        : null;
    const prepared = prepareShadowEvidence({
      source,
      sourceTime: input.sourceTime,
      signedMappingVersion: input.context.signedMappingVersion,
      mapping: usable,
      selectionItem: usable ? (selected.get(usable.sessionPositionId) ?? null) : null,
      policyVersion: usable
        ? (versions.get(
            versionKey(
              usable.policyVersionId,
              usable.policyDefinitionHash,
              usable.evaluatorVersion,
            ),
          ) ?? null)
        : null,
    });
    if (prepared.application) applications.push(prepared.application);
    comparisons.push(prepared.comparison);
  }
  return { attempt, applications, comparisons };
}

/**
 * Evaluate candidate inputs from frozen source only, never current legacy rules.
 * Mapping/selection must already be source-time candidates from the preparation
 * helpers. This result is not persisted evidence or Human authorization: final
 * database guards independently prove registration, precedence and evaluation.
 */
export function evaluateShadowFrozenSource(input: {
  source: ContributionShadowLegacySourceAnchor;
  sourceTime: Date;
  signedMappingVersion: string;
  mapping: ContributionShadowMappingApproval | null;
  selectionItem: ActivityContributionPolicySelectionItem | null;
  policyVersion: Pick<
    ContributionPolicyVersion,
    | 'id'
    | 'policyId'
    | 'schemaVersion'
    | 'evaluatorVersion'
    | 'definitionJson'
    | 'definitionHash'
    | 'effectiveFrom'
    | 'effectiveUntil'
  > | null;
}): ContributionShadowComparisonResult & { durationSeconds: number | null } {
  const { source, sourceTime, mapping, selectionItem: item, policyVersion: version } = input;
  const hold = (classification: ContributionShadowComparisonResult['classification']) => ({
    classification,
    comparable: false,
    legacyPoints: null,
    policyPoints: null,
    policyExplanationCode: null,
    durationSeconds: null,
  });
  if (!(sourceTime instanceof Date) || !Number.isFinite(sourceTime.getTime()))
    return hold('input_source_mismatch');
  if (source.hashAlgorithmCode !== 'sha256' || source.canonicalVersion !== 1)
    return hold('source_drift');
  const matched = source.sourceKindCode === 'matched';
  if (
    matched
      ? !source.legacyRuleId || source.pointsBelow === null
      : source.sourceKindCode !== 'no_match' ||
        source.legacyRuleId !== null ||
        source.durationThreshold !== null ||
        source.pointsBelow !== null ||
        source.pointsAbove !== null
  )
    return hold('source_drift');
  try {
    const observed = hashLegacySource({
      ...source,
      source: matched
        ? {
            sourceKindCode: 'matched',
            legacyRuleId: source.legacyRuleId!,
            durationThreshold: source.durationThreshold,
            pointsBelow: source.pointsBelow!,
            pointsAbove: source.pointsAbove,
          }
        : {
            sourceKindCode: 'no_match',
            legacyRuleId: null,
            durationThreshold: null,
            pointsBelow: null,
            pointsAbove: null,
          },
    });
    if (observed !== source.legacySourceHash) return hold('source_drift');
    if (!matched)
      return hold(source.legacyPoints.isZero() ? 'legacy_rule_missing' : 'source_drift');
    const time = sourceTime.getTime();
    if (
      !mapping ||
      !input.signedMappingVersion ||
      mapping.mappingVersion !== input.signedMappingVersion ||
      mapping.activityId !== source.activityId ||
      mapping.activityTypeCode !== source.activityTypeCode ||
      mapping.attendanceRoleCode !== source.attendanceRoleCode ||
      mapping.eventKindCode === 'revoke' ||
      !['approve', 'replace'].includes(mapping.eventKindCode) ||
      !Number.isFinite(mapping.approvedAt.getTime()) ||
      !Number.isFinite(mapping.effectiveFrom.getTime()) ||
      mapping.approvedAt.getTime() > time ||
      mapping.effectiveFrom.getTime() > time ||
      (mapping.effectiveUntil !== null &&
        (!Number.isFinite(mapping.effectiveUntil.getTime()) ||
          mapping.effectiveUntil.getTime() <= time))
    )
      return hold('mapping_hold');
    if (mapping.durationSourceCode !== 'legacy_stored_hours_2')
      return hold('input_source_mismatch');
    if (
      !item ||
      !version ||
      item.mode !== 'explicit' ||
      item.activityId !== source.activityId ||
      !['activity', 'position'].includes(item.layerCode) ||
      (item.layerCode === 'activity' && (item.sessionId !== null || item.positionId !== null)) ||
      (item.layerCode === 'position' && !item.sessionId) ||
      (item.layerCode === 'position' && item.positionId !== mapping.sessionPositionId) ||
      item.versionId !== mapping.policyVersionId ||
      item.definitionHash !== mapping.policyDefinitionHash ||
      item.evaluatorVersion !== mapping.evaluatorVersion ||
      item.policyId !== version.policyId ||
      version.id !== mapping.policyVersionId ||
      version.definitionHash !== mapping.policyDefinitionHash ||
      version.evaluatorVersion !== mapping.evaluatorVersion
    )
      return hold('policy_version_missing_or_unapproved');
    const seconds = source.legacyServiceHours.mul(100).mul(36);
    if (!seconds.isInteger() || !Number.isSafeInteger(seconds.toNumber()) || seconds.isNegative())
      return hold('input_source_mismatch');
    const fingerprint = fingerprintContributionPolicyVersion({
      schemaVersion: version.schemaVersion,
      evaluatorVersion: version.evaluatorVersion,
      definition: version.definitionJson,
      effectiveFrom: version.effectiveFrom.toISOString(),
      effectiveUntil: version.effectiveUntil?.toISOString() ?? null,
    });
    if (fingerprint.definitionHash !== version.definitionHash) return hold('source_drift');
    const category = fingerprint.definition.roleRules
      .find((role) => role.attendanceRoleCode === mapping.policyRoleCode)
      ?.categoryRules.find((rule) => rule.timeCategoryCode === mapping.categoryCode);
    if (!category) return hold('mapping_hold');
    const result = compareContributionShadow({
      fact: {
        activityId: source.activityId,
        memberId: source.memberId,
        attendanceId: source.recordId,
        occurredAt: sourceTime.toISOString(),
        sourceCode: mapping.durationSourceCode,
        legacyServiceHours: source.legacyServiceHours.toNumber(),
        durationSeconds: seconds.toNumber(),
        durationSourceCode: mapping.durationSourceCode,
      },
      mapping: {
        approved: true,
        signedVersion: input.signedMappingVersion,
        activityTypeCode: mapping.activityTypeCode,
        legacyRoleCode: mapping.attendanceRoleCode,
        policyRoleCode: mapping.policyRoleCode,
        timeCategoryCode: category.timeCategoryCode,
        sourceCode: mapping.durationSourceCode,
        precisionCode: 'decimal_hours_2',
        missingRuleIsZero: false,
      },
      legacy: {
        activityTypeCode: source.activityTypeCode,
        roleCode: source.attendanceRoleCode,
        serviceHours: source.legacyServiceHours.toNumber(),
        expectedSourceFingerprint: source.legacySourceHash,
        observedSourceFingerprint: observed,
        rules: [
          {
            id: source.legacyRuleId!,
            activityTypeCode: source.activityTypeCode,
            attendanceRoleCode: source.attendanceRoleCode,
            durationThreshold: source.durationThreshold?.toFixed(2) ?? null,
            pointsBelow: source.pointsBelow!.toFixed(2),
            pointsAbove: source.pointsAbove?.toFixed(2) ?? null,
          },
        ],
      },
      policy: {
        approved: true,
        definition: fingerprint.definition,
        versionHash: version.definitionHash,
        schemaVersion: version.schemaVersion,
        evaluatorVersion: version.evaluatorVersion,
        effectiveFrom: version.effectiveFrom.toISOString(),
        effectiveUntil: version.effectiveUntil?.toISOString() ?? null,
      },
    });
    if (result.comparable && !source.legacyPoints.equals(result.legacyPoints!))
      return hold('source_drift');
    return { ...result, durationSeconds: seconds.toNumber() };
  } catch {
    return hold('evaluation_error');
  }
}

export type ShadowSelectionRevision = Pick<
  ActivityContributionPolicySelectionRevision,
  | 'id'
  | 'activityId'
  | 'revision'
  | 'schemaVersion'
  | 'selectionHash'
  | 'selectionJson'
  | 'itemCount'
  | 'createdAt'
> & { items: readonly ActivityContributionPolicySelectionItem[] };

/**
 * Candidate preparation only. The caller must supply the latest revision at the
 * source audit instant; the database independently rechecks that fact after locks.
 * Never invent a template pointer or use an inherited item as explicit evidence.
 */
export function resolveShadowSelectionAtSource(
  revision: ShadowSelectionRevision | null,
  position: { id: string; activityId: string; sessionId: string },
  sourceTime: Date,
): ActivityContributionPolicySelectionItem | null {
  return resolveShadowSelectionsAtSource(revision, [position], sourceTime)[0] ?? null;
}

/** Validate a revision once per preparation call, not once per legacy Record. */
export function resolveShadowSelectionsAtSource(
  revision: ShadowSelectionRevision | null,
  positions: readonly { id: string; activityId: string; sessionId: string }[],
  sourceTime: Date,
): readonly (ActivityContributionPolicySelectionItem | null)[] {
  const fail = () => new TypeError('Invalid shadow immutable selection evidence');
  for (const position of positions)
    for (const key of [position.id, position.activityId, position.sessionId])
      if (!key || key.trim() !== key) throw fail();
  if (!(sourceTime instanceof Date) || !Number.isFinite(sourceTime.getTime())) throw fail();
  if (!revision) return positions.map(() => null);
  if (
    !revision.id ||
    positions.some((position) => revision.activityId !== position.activityId) ||
    revision.schemaVersion !== 1 ||
    !Number.isSafeInteger(revision.revision) ||
    revision.revision < 1 ||
    !(revision.createdAt instanceof Date) ||
    !Number.isFinite(revision.createdAt.getTime()) ||
    revision.createdAt > sourceTime ||
    revision.itemCount !== revision.items.length
  )
    throw fail();
  const ids = new Set<string>();
  const materialized = revision.items.map((item) => {
    if (
      !item.id ||
      ids.has(item.id) ||
      item.activityId !== revision.activityId ||
      item.selectionRevisionId !== revision.id
    )
      throw fail();
    ids.add(item.id);
    const pointer = [
      item.policyId,
      item.versionId,
      item.definitionHash,
      item.evaluatorVersion,
    ].every((value) => value === null)
      ? null
      : {
          policyId: item.policyId,
          versionId: item.versionId,
          definitionHash: item.definitionHash,
          evaluatorVersion: item.evaluatorVersion,
        };
    return parseActivityContributionPolicySelectionItem({
      scope: { layerCode: item.layerCode, sessionId: item.sessionId, positionId: item.positionId },
      selection: { mode: item.mode, pointer },
    });
  });
  const stored = parseActivityContributionPolicySelectionDocument(revision.selectionJson);
  const reconstructed = createActivityContributionPolicySelectionDocument(materialized);
  if (
    activityContributionPolicySelectionHash(stored) !== revision.selectionHash ||
    activityContributionPolicySelectionHash(reconstructed) !== revision.selectionHash
  )
    throw fail();
  const byPosition = new Map<string, ActivityContributionPolicySelectionItem>();
  let root: ActivityContributionPolicySelectionItem | null = null;
  for (const item of revision.items) {
    if (item.mode !== 'explicit') continue;
    if (item.layerCode === 'activity') root = item;
    else byPosition.set(JSON.stringify([item.sessionId, item.positionId]), item);
  }
  return positions.map(
    (position) => byPosition.get(JSON.stringify([position.sessionId, position.id])) ?? root,
  );
}

export type ShadowMappingHistoryEvent = Pick<
  ContributionShadowMappingApproval,
  | 'id'
  | 'activityId'
  | 'activityTypeCode'
  | 'attendanceRoleCode'
  | 'mappingVersion'
  | 'approvedAt'
  | 'effectiveFrom'
  | 'effectiveUntil'
  | 'eventKindCode'
  | 'previousApprovalId'
>;

/**
 * Resolve a candidate from complete immutable history, not an approval decision.
 * Successors across mapping versions still revoke their predecessor. The final
 * database guard independently proves registration closure, source and policy.
 */
export function resolveShadowMappingAtSource<T extends ShadowMappingHistoryEvent>(
  events: readonly T[],
  source: {
    activityId: string;
    activityTypeCode: string;
    attendanceRoleCode: string;
    mappingVersion: string;
    sourceTime: Date;
  },
): T | null {
  for (const value of [
    source.activityId,
    source.activityTypeCode,
    source.attendanceRoleCode,
    source.mappingVersion,
  ])
    if (!value || value.trim() !== value) throw new TypeError('Invalid shadow mapping source key');
  const instant = (value: Date) => {
    if (!(value instanceof Date) || !Number.isFinite(value.getTime()))
      throw new TypeError('Invalid shadow mapping history instant');
    return value.getTime();
  };
  const time = instant(source.sourceTime);
  const ids = new Set<string>();
  const successors = new Set<string>();
  const candidates: T[] = [];
  for (const event of events) {
    if (
      !event.id ||
      ids.has(event.id) ||
      !['approve', 'replace', 'revoke'].includes(event.eventKindCode)
    )
      throw new TypeError('Invalid shadow mapping history event');
    ids.add(event.id);
    const approvedAt = instant(event.approvedAt);
    const effectiveFrom = instant(event.effectiveFrom);
    const effectiveUntil = event.effectiveUntil === null ? null : instant(event.effectiveUntil);
    if (
      (effectiveUntil !== null && effectiveUntil <= effectiveFrom) ||
      (event.eventKindCode === 'approve') !== (event.previousApprovalId === null)
    )
      throw new TypeError('Invalid shadow mapping history event');
    if (event.activityId !== source.activityId || approvedAt > time || effectiveFrom > time)
      continue;
    if (event.eventKindCode === 'revoke' || event.eventKindCode === 'replace')
      successors.add(event.previousApprovalId!);
    if (
      event.eventKindCode !== 'revoke' &&
      event.activityTypeCode === source.activityTypeCode &&
      event.attendanceRoleCode === source.attendanceRoleCode &&
      event.mappingVersion === source.mappingVersion &&
      (effectiveUntil === null || effectiveUntil > time)
    )
      candidates.push(event);
  }
  const available = candidates.filter((event) => !successors.has(event.id));
  return available.length === 1 ? available[0] : null;
}

@Injectable()
export class ContributionShadowService implements OnModuleDestroy {
  private runtimeClient: PrismaClient | undefined;
  private destroyed = false;

  constructor(
    @Inject(appConfig.KEY) private readonly config: ConfigType<typeof appConfig>,
    @Inject(databaseConfig.KEY) private readonly database: ConfigType<typeof databaseConfig>,
  ) {}

  /**
   * Internal connection lifecycle only, not Human authorization or mapping proof.
   * The caller must own the post-commit transaction and qualification checks;
   * database guards still verify the exact runtime identity on evidence writes.
   * This method does not retry, enable shadow or borrow the legacy Prisma client.
   */
  async withRuntimeClient<T>(work: (client: PrismaClient) => Promise<T>): Promise<T | null> {
    if (this.destroyed) throw new Error('shadow runtime client is closed');
    if (this.config.contributionShadowMode !== 'shadow') return null;
    const url = this.database.contributionShadowUrl;
    if (!url || url.trim() !== url || url === this.database.url)
      throw new Error('independent shadow runtime connection is unavailable');
    let boundedUrl: URL;
    try {
      boundedUrl = new URL(url);
      if (!['postgresql:', 'postgres:'].includes(boundedUrl.protocol)) throw new Error();
    } catch {
      // Never expose a connection string through URL parser errors.
      throw new Error('independent shadow runtime connection is invalid');
    }
    // Only this dedicated pool is changed. Do not inherit unlimited or default
    // five/ten-second transport waits into a five-second post-commit invocation.
    boundedUrl.searchParams.set('connect_timeout', '1');
    boundedUrl.searchParams.set('pool_timeout', '1');
    this.runtimeClient ??= new PrismaClient({
      datasources: { db: { url: boundedUrl.toString() } },
    });
    return work(this.runtimeClient);
  }

  /**
   * AttendancesService remains transaction owner and must requalify the Human.
   * The reserve covers new connection establishment; maxWait is accounted
   * separately by the single budget. No timer, Promise.race or background work.
   * This entry alone is not proof of a five-second cold-network end-to-end bound.
   */
  async withBoundedRuntimeClient<T>(
    budget: ShadowComparisonBudget,
    work: (
      client: PrismaClient,
      options: ReturnType<ShadowComparisonBudget['transactionOptions']>,
    ) => Promise<T>,
  ): Promise<T | null> {
    if (this.config.contributionShadowMode !== 'shadow') return null;
    budget.transactionOptions(1000);
    return this.withRuntimeClient(async (client) => {
      // Pay connection establishment on this same monotonic countdown. After
      // it settles, use the actual remainder, not another unspent whole second.
      // The caller still owns the transaction; no retry or background race.
      await client.$connect();
      const result = await work(client, budget.transactionOptions(0, 100));
      if (budget.remainingMs() === 0) throw new Error('shadow comparison budget exhausted');
      return result;
    });
  }

  async onModuleDestroy(): Promise<void> {
    this.destroyed = true;
    const client = this.runtimeClient;
    this.runtimeClient = undefined;
    if (client) await client.$disconnect();
  }

  // This is only the registered-window candidate, not proof that a policy is
  // signed or that a comparison may be marked equal. The caller owns the old
  // attendance transaction and must verify those conditions separately.
  async findCurrentRegisteredWindow(tx: PrismaTx): Promise<RegisteredShadowWindow | null> {
    if (this.config.contributionShadowMode !== 'shadow') return null;
    // AuditLog.createdAt is TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP, and the
    // database proof guard interprets that value as UTC. Match both the stored
    // millisecond precision and interpretation, even if a DB session is not UTC.
    // Application time or clock_timestamp() may choose another window.
    const windows = await tx.$queryRaw<RegisteredShadowWindow[]>`
      SELECT "id", "signedMappingVersion"
      FROM "ContributionShadowObservationWindow"
      WHERE "startsAt" <= (transaction_timestamp()::timestamp(3) AT TIME ZONE 'UTC')
        AND "endsAt" > (transaction_timestamp()::timestamp(3) AT TIME ZONE 'UTC')
      LIMIT 2
      FOR SHARE
    `;
    if (windows.length > 1) throw new Error('overlapping contribution shadow windows');
    return windows[0] ?? null;
  }
}
