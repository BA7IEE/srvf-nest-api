import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';

import { beijingDateOnly } from '../../common/datetime/date-only.util';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { CertificateQualificationService } from '../certificates/certificate-qualification.service';
import { InsuranceRequirementService } from '../insurances/insurance-requirement.service';
import {
  MemberQualificationFactsService,
  type MemberQualificationFacts,
} from '../member-profiles/member-qualification-facts.service';

type PrismaTx = Prisma.TransactionClient;

export type QualificationResultCode = 'pass' | 'warn' | 'fail';
export type QualificationEvaluationPhase = 'display' | 'submit' | 'review';

export interface ActivityQualificationTarget {
  sessionId: string;
  positionId: string | null;
}

export interface QualificationUnmetRule {
  ruleId: string;
  enforcementCode: 'block' | 'warn';
  resultCode: 'warn' | 'fail';
  message: string | null;
  warnScore: number | null;
}

export interface QualificationProjection {
  resultCode: QualificationResultCode;
  unmetRules: QualificationUnmetRule[];
}

type QualificationScope =
  | { level: 'activity'; sessionId: null; positionId: null }
  | { level: 'session'; sessionId: string; positionId: null }
  | { level: 'position'; sessionId: string; positionId: string };

type ParsedRule = {
  id: string;
  ruleTypeCode:
    | 'grade'
    | 'gender'
    | 'organization'
    | 'certificate'
    | 'training'
    | 'age'
    | 'insurance';
  enforcementCode: 'block' | 'warn';
  operator: 'in' | 'in_subtree' | 'has_any' | 'between' | 'covers_activity';
  value:
    | { kind: 'codes'; codes: string[] }
    | { kind: 'organizationIds'; organizationIds: string[] }
    | { kind: 'standardIds'; standardIds: string[] }
    | { kind: 'age'; minYears: number | null; maxYears: number | null }
    | { kind: 'none' };
  message: string | null;
  warnScore: number | null;
};

type ParsedRuleSet = {
  id: string;
  version: number;
  scope: QualificationScope;
  rules: ParsedRule[];
};

type EvaluatedRule = ParsedRule & { resultCode: QualificationResultCode };

type EvaluatedRuleSet = {
  ruleSetVersionId: string;
  scope: QualificationScope;
  resultCode: QualificationResultCode;
  rules: EvaluatedRule[];
  inputFactsHash: string;
};

export interface QualificationSnapshotCandidate {
  ruleSetVersionId: string;
  scope: QualificationScope;
  resultCode: QualificationResultCode;
  rules: Array<Pick<EvaluatedRule, 'id' | 'resultCode'>>;
  inputFactsHash: string;
}

export interface ActivityQualificationEvaluation {
  resultCode: QualificationResultCode;
  activity: QualificationProjection;
  sessions: Map<string, QualificationProjection>;
  positions: Map<string, QualificationProjection>;
  snapshotCandidates: QualificationSnapshotCandidate[];
}

type ActiveRuleSetRecord = {
  id: string;
  version: number;
  sessionId: string | null;
  positionId: string | null;
  rules: Array<{
    id: string;
    ruleTypeCode: string;
    enforcementCode: string;
    operator: string;
    valueJson: Prisma.JsonValue | null;
    warnScore: number | null;
    message: string | null;
    sortOrder: number;
  }>;
};

function scopeKey(sessionId: string | null, positionId: string | null): string {
  return `${sessionId ?? ''}\u0000${positionId ?? ''}`;
}

function targetKey(target: ActivityQualificationTarget): string {
  return `${target.sessionId}\u0000${target.positionId ?? ''}`;
}

function worstResult(results: readonly QualificationResultCode[]): QualificationResultCode {
  if (results.includes('fail')) return 'fail';
  if (results.includes('warn')) return 'warn';
  return 'pass';
}

function stableJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(',')}}`;
  }
  throw new TypeError('qualification facts must be canonical JSON values');
}

function dateFact(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

function isRecord(value: Prisma.JsonValue | null): value is Prisma.JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function strictStringArray(value: Prisma.JsonValue | null, key: string): string[] | null {
  if (!isRecord(value) || Object.keys(value).length !== 1 || !(key in value)) return null;
  const array = value[key];
  if (!Array.isArray(array) || array.length === 0) return null;
  const strings: string[] = [];
  for (const item of array) {
    if (typeof item !== 'string' || item.trim() === '' || strings.includes(item)) return null;
    strings.push(item);
  }
  return strings;
}

function strictAgeRange(
  value: Prisma.JsonValue | null,
): { minYears: number | null; maxYears: number | null } | null {
  if (!isRecord(value)) return null;
  const keys = Object.keys(value).sort();
  if (keys.length === 0 || keys.some((key) => key !== 'minYears' && key !== 'maxYears'))
    return null;
  const min = value.minYears;
  const max = value.maxYears;
  if (min !== undefined && (!Number.isInteger(min) || (min as number) < 0)) return null;
  if (max !== undefined && (!Number.isInteger(max) || (max as number) < 0)) return null;
  const minYears = min === undefined ? null : (min as number);
  const maxYears = max === undefined ? null : (max as number);
  if (minYears === null && maxYears === null) return null;
  if (minYears !== null && maxYears !== null && minYears > maxYears) return null;
  return { minYears, maxYears };
}

/**
 * D83's one and only qualification runtime.  It validates the frozen wire before
 * evaluation, composes activity/session/position scopes by AND, and exposes a
 * separate immutable snapshot append step for the caller-owned transaction.
 */
@Injectable()
export class ActivityQualificationEvaluatorService {
  constructor(
    private readonly memberFacts: MemberQualificationFactsService,
    private readonly certificateFacts: CertificateQualificationService,
    private readonly insuranceRequirement: InsuranceRequirementService,
  ) {}

  async evaluate(input: {
    activity: { id: string; startAt: Date; endAt: Date };
    memberId: string;
    targets?: readonly ActivityQualificationTarget[];
    tx: PrismaTx;
  }): Promise<ActivityQualificationEvaluation> {
    const parsedRuleSets = await this.loadAndValidateActiveRuleSets(input.activity.id, input.tx);
    const targets = this.normalizeTargets(input.targets ?? []);
    await this.validateTargets(input.activity.id, targets, input.tx);
    const applicable = this.applicableRuleSets(parsedRuleSets, targets);
    const facts = await this.memberFacts.readForQualification(input.memberId, input.tx);
    const needsCertificates = applicable.some((ruleSet) =>
      ruleSet.rules.some(
        (rule) => rule.ruleTypeCode === 'certificate' || rule.ruleTypeCode === 'training',
      ),
    );
    const needsInsurance = applicable.some((ruleSet) =>
      ruleSet.rules.some((rule) => rule.ruleTypeCode === 'insurance'),
    );
    const certificateFacts = needsCertificates
      ? await this.certificateFacts.readCoveringFacts(input.memberId, input.activity, input.tx)
      : null;
    const insured = needsInsurance
      ? await this.insuranceRequirement.isMemberInsuredForActivity(
          input.memberId,
          input.activity,
          input.tx,
        )
      : null;

    const evaluatedRuleSets = applicable.map((ruleSet) =>
      this.evaluateRuleSet({
        ruleSet,
        facts,
        certificateFacts,
        insured,
        activity: input.activity,
      }),
    );
    const byScope = new Map<string, EvaluatedRuleSet>();
    for (const ruleSet of evaluatedRuleSets) {
      byScope.set(scopeKey(ruleSet.scope.sessionId, ruleSet.scope.positionId), ruleSet);
    }

    const activityRules = byScope.get(scopeKey(null, null))?.rules ?? [];
    const activity = this.toProjection(activityRules);
    const sessions = new Map<string, QualificationProjection>();
    const positions = new Map<string, QualificationProjection>();
    const sessionIds = [...new Set(targets.map((target) => target.sessionId))].sort();
    for (const sessionId of sessionIds) {
      const sessionRules = byScope.get(scopeKey(sessionId, null))?.rules ?? [];
      sessions.set(sessionId, this.toProjection([...activityRules, ...sessionRules]));
    }
    for (const target of targets.filter((candidate) => candidate.positionId !== null)) {
      const sessionRules = byScope.get(scopeKey(target.sessionId, null))?.rules ?? [];
      const positionRules = byScope.get(scopeKey(target.sessionId, target.positionId))?.rules ?? [];
      positions.set(
        target.positionId!,
        this.toProjection([...activityRules, ...sessionRules, ...positionRules]),
      );
    }
    const resultCode = worstResult([
      activity.resultCode,
      ...[...sessions.values()].map((result) => result.resultCode),
      ...[...positions.values()].map((result) => result.resultCode),
    ]);

    return {
      resultCode,
      activity,
      sessions,
      positions,
      snapshotCandidates: evaluatedRuleSets
        .sort((left, right) => left.ruleSetVersionId.localeCompare(right.ruleSetVersionId))
        .map((ruleSet) => ({
          ruleSetVersionId: ruleSet.ruleSetVersionId,
          scope: ruleSet.scope,
          resultCode: ruleSet.resultCode,
          rules: ruleSet.rules.map((rule) => ({ id: rule.id, resultCode: rule.resultCode })),
          inputFactsHash: ruleSet.inputFactsHash,
        })),
    };
  }

  assertNoBlock(evaluation: ActivityQualificationEvaluation): void {
    if (evaluation.resultCode === 'fail') {
      throw new BizException(BizCode.ACTIVITY_QUALIFICATION_NOT_MET);
    }
  }

  async appendSnapshots(input: {
    evaluation: ActivityQualificationEvaluation;
    phase: QualificationEvaluationPhase;
    registrationRevisionId: string | null;
    identityIdBySession?: ReadonlyMap<string, string>;
    tx: PrismaTx;
  }): Promise<void> {
    // A failed aggregate remains displayable as a safe projection, but it is never a successful
    // evaluation event. In particular, display must not turn a block-only failure into durable
    // evidence whose hash later looks like a completed qualification check.
    if (input.evaluation.resultCode === 'fail') return;
    if (input.phase !== 'display' && input.registrationRevisionId === null) {
      this.configurationInvalid();
    }
    for (const candidate of input.evaluation.snapshotCandidates) {
      const identityId =
        input.phase === 'display' || candidate.scope.level === 'activity'
          ? null
          : (input.identityIdBySession?.get(candidate.scope.sessionId) ?? null);
      if (
        input.phase !== 'display' &&
        candidate.scope.level !== 'activity' &&
        identityId === null
      ) {
        this.configurationInvalid();
      }
      await input.tx.qualificationEvaluationSnapshot.create({
        data: {
          identityId,
          registrationRevisionId: input.registrationRevisionId,
          ruleSetVersionId: candidate.ruleSetVersionId,
          evaluatedAt: new Date(),
          evaluationPhaseCode: input.phase,
          resultCode: candidate.resultCode,
          detailsJson: {
            schemaVersion: 1,
            ruleSetVersionId: candidate.ruleSetVersionId,
            scope: candidate.scope,
            rules: candidate.rules.map((rule) => ({
              ruleId: rule.id,
              resultCode: rule.resultCode,
            })),
          },
          inputFactsHash: candidate.inputFactsHash,
        },
      });
    }
  }

  private normalizeTargets(
    targets: readonly ActivityQualificationTarget[],
  ): ActivityQualificationTarget[] {
    const normalized = new Map<string, ActivityQualificationTarget>();
    for (const target of targets) {
      if (!target.sessionId || (target.positionId !== null && !target.positionId)) {
        this.configurationInvalid();
      }
      normalized.set(targetKey(target), {
        sessionId: target.sessionId,
        positionId: target.positionId,
      });
    }
    return [...normalized.values()].sort((left, right) =>
      targetKey(left).localeCompare(targetKey(right)),
    );
  }

  private async loadAndValidateActiveRuleSets(
    activityId: string,
    tx: PrismaTx,
  ): Promise<ParsedRuleSet[]> {
    const [ruleSets, sessions, positions] = await Promise.all([
      tx.activityQualificationRuleSet.findMany({
        where: { activityId, statusCode: 'active' },
        select: {
          id: true,
          version: true,
          sessionId: true,
          positionId: true,
          rules: {
            select: {
              id: true,
              ruleTypeCode: true,
              enforcementCode: true,
              operator: true,
              valueJson: true,
              warnScore: true,
              message: true,
              sortOrder: true,
            },
            orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
          },
        },
        orderBy: [{ sessionId: 'asc' }, { positionId: 'asc' }, { id: 'asc' }],
      }),
      tx.activitySession.findMany({
        where: { activityId, deletedAt: null },
        select: { id: true },
      }),
      tx.activitySessionPosition.findMany({
        where: { activityId, deletedAt: null },
        select: { id: true, sessionId: true, qualificationRuleSetId: true },
      }),
    ]);
    const sessionIds = new Set(sessions.map((session) => session.id));
    const positionById = new Map(positions.map((position) => [position.id, position]));
    const parsed = (ruleSets as ActiveRuleSetRecord[]).map((ruleSet) => this.parseRuleSet(ruleSet));
    const byScope = new Map<string, ParsedRuleSet>();
    for (const ruleSet of parsed) {
      const key = scopeKey(ruleSet.scope.sessionId, ruleSet.scope.positionId);
      if (byScope.has(key)) this.configurationInvalid();
      byScope.set(key, ruleSet);
      if (ruleSet.scope.level !== 'activity' && !sessionIds.has(ruleSet.scope.sessionId)) {
        this.configurationInvalid();
      }
      if (ruleSet.scope.level === 'position') {
        const position = positionById.get(ruleSet.scope.positionId);
        if (
          !position ||
          position.sessionId !== ruleSet.scope.sessionId ||
          position.qualificationRuleSetId !== ruleSet.id
        ) {
          this.configurationInvalid();
        }
      }
    }
    for (const position of positions) {
      if (position.qualificationRuleSetId === null) continue;
      const pointed = parsed.find((ruleSet) => ruleSet.id === position.qualificationRuleSetId);
      if (
        !pointed ||
        pointed.scope.level !== 'position' ||
        pointed.scope.sessionId !== position.sessionId ||
        pointed.scope.positionId !== position.id
      ) {
        this.configurationInvalid();
      }
    }
    return parsed;
  }

  private async validateTargets(
    activityId: string,
    targets: readonly ActivityQualificationTarget[],
    tx: PrismaTx,
  ): Promise<void> {
    if (targets.length === 0) return;
    const sessionIds = [...new Set(targets.map((target) => target.sessionId))];
    const positionTargets = targets.filter(
      (target): target is { sessionId: string; positionId: string } => target.positionId !== null,
    );
    const [sessions, positions] = await Promise.all([
      tx.activitySession.findMany({
        where: { activityId, id: { in: sessionIds }, deletedAt: null },
        select: { id: true },
      }),
      positionTargets.length === 0
        ? Promise.resolve([])
        : tx.activitySessionPosition.findMany({
            where: {
              activityId,
              id: { in: positionTargets.map((target) => target.positionId) },
              deletedAt: null,
            },
            select: { id: true, sessionId: true },
          }),
    ]);
    if (sessions.length !== sessionIds.length || positions.length !== positionTargets.length) {
      this.configurationInvalid();
    }
    const positionsById = new Map(positions.map((position) => [position.id, position]));
    if (
      positionTargets.some(
        (target) => positionsById.get(target.positionId)?.sessionId !== target.sessionId,
      )
    ) {
      this.configurationInvalid();
    }
  }

  private parseRuleSet(ruleSet: ActiveRuleSetRecord): ParsedRuleSet {
    let scope: QualificationScope;
    if (ruleSet.positionId !== null) {
      if (ruleSet.sessionId === null) this.configurationInvalid();
      scope = { level: 'position', sessionId: ruleSet.sessionId, positionId: ruleSet.positionId };
    } else if (ruleSet.sessionId !== null) {
      scope = { level: 'session', sessionId: ruleSet.sessionId, positionId: null };
    } else {
      scope = { level: 'activity', sessionId: null, positionId: null };
    }
    if (ruleSet.rules.length === 0) this.configurationInvalid();
    return {
      id: ruleSet.id,
      version: ruleSet.version,
      scope,
      rules: ruleSet.rules.map((rule) => this.parseRule(rule)),
    };
  }

  private parseRule(rule: ActiveRuleSetRecord['rules'][number]): ParsedRule {
    const enforcementCode = rule.enforcementCode;
    if (enforcementCode !== 'block' && enforcementCode !== 'warn') this.configurationInvalid();
    if (
      (enforcementCode === 'block' && rule.warnScore !== null) ||
      (enforcementCode === 'warn' &&
        (rule.warnScore === null ||
          !Number.isInteger(rule.warnScore) ||
          rule.warnScore < 0 ||
          rule.warnScore > 100))
    ) {
      this.configurationInvalid();
    }
    if (rule.message !== null && typeof rule.message !== 'string') this.configurationInvalid();
    const common = {
      id: rule.id,
      enforcementCode,
      message: rule.message,
      warnScore: rule.warnScore,
    } as const;
    if (
      (rule.ruleTypeCode === 'grade' || rule.ruleTypeCode === 'gender') &&
      rule.operator === 'in'
    ) {
      const codes = strictStringArray(rule.valueJson, 'codes');
      if (codes === null) this.configurationInvalid();
      return {
        ...common,
        ruleTypeCode: rule.ruleTypeCode,
        operator: 'in',
        value: { kind: 'codes', codes },
      };
    }
    if (rule.ruleTypeCode === 'organization' && rule.operator === 'in_subtree') {
      const organizationIds = strictStringArray(rule.valueJson, 'organizationIds');
      if (organizationIds === null) this.configurationInvalid();
      return {
        ...common,
        ruleTypeCode: 'organization',
        operator: 'in_subtree',
        value: { kind: 'organizationIds', organizationIds },
      };
    }
    if (
      (rule.ruleTypeCode === 'certificate' || rule.ruleTypeCode === 'training') &&
      rule.operator === 'has_any'
    ) {
      const standardIds = strictStringArray(rule.valueJson, 'standardIds');
      if (standardIds === null) this.configurationInvalid();
      return {
        ...common,
        ruleTypeCode: rule.ruleTypeCode,
        operator: 'has_any',
        value: { kind: 'standardIds', standardIds },
      };
    }
    if (rule.ruleTypeCode === 'age' && rule.operator === 'between') {
      const age = strictAgeRange(rule.valueJson);
      if (age === null) this.configurationInvalid();
      return {
        ...common,
        ruleTypeCode: 'age',
        operator: 'between',
        value: { kind: 'age', ...age },
      };
    }
    if (
      rule.ruleTypeCode === 'insurance' &&
      rule.operator === 'covers_activity' &&
      rule.valueJson === null
    ) {
      return {
        ...common,
        ruleTypeCode: 'insurance',
        operator: 'covers_activity',
        value: { kind: 'none' },
      };
    }
    this.configurationInvalid();
  }

  private applicableRuleSets(
    ruleSets: ParsedRuleSet[],
    targets: readonly ActivityQualificationTarget[],
  ): ParsedRuleSet[] {
    const applicable = new Map<string, ParsedRuleSet>();
    for (const ruleSet of ruleSets) {
      if (ruleSet.scope.level === 'activity') applicable.set(ruleSet.id, ruleSet);
    }
    const targetSessions = new Set(targets.map((target) => target.sessionId));
    const targetPositions = new Set(
      targets.flatMap((target) => (target.positionId === null ? [] : [target.positionId])),
    );
    for (const ruleSet of ruleSets) {
      if (ruleSet.scope.level === 'session' && targetSessions.has(ruleSet.scope.sessionId)) {
        applicable.set(ruleSet.id, ruleSet);
      }
      if (ruleSet.scope.level === 'position' && targetPositions.has(ruleSet.scope.positionId)) {
        applicable.set(ruleSet.id, ruleSet);
      }
    }
    return [...applicable.values()].sort((left, right) => left.id.localeCompare(right.id));
  }

  private evaluateRuleSet(input: {
    ruleSet: ParsedRuleSet;
    facts: MemberQualificationFacts;
    certificateFacts: Awaited<
      ReturnType<CertificateQualificationService['readCoveringFacts']>
    > | null;
    insured: boolean | null;
    activity: { id: string; startAt: Date; endAt: Date };
  }): EvaluatedRuleSet {
    const rules = input.ruleSet.rules.map((rule) =>
      this.evaluateRule(rule, input.facts, input.certificateFacts, input.insured, input.activity),
    );
    const inputFactsHash = createHash('sha256')
      .update(
        stableJson({
          schemaVersion: 1,
          ruleSetVersionId: input.ruleSet.id,
          activity: {
            id: input.activity.id,
            startAt: input.activity.startAt.toISOString(),
            endAt: input.activity.endAt.toISOString(),
          },
          member: {
            id: input.facts.memberId,
            gradeCode: input.facts.gradeCode,
            profile: input.facts.profile
              ? {
                  genderCode: input.facts.profile.genderCode,
                  birthDate: input.facts.profile.birthDate.toISOString(),
                }
              : null,
            activeOrganizationIds: input.facts.activeOrganizationIds,
            activeOrganizationAncestorIds: input.facts.activeOrganizationAncestorIds,
          },
          certificates:
            input.certificateFacts?.coveringCertificates.map((certificate) => ({
              certificateId: certificate.certificateId,
              standardId: certificate.standardId,
              issuedAt: dateFact(certificate.issuedAt),
              expiredAt: dateFact(certificate.expiredAt),
            })) ?? null,
          insured: input.insured,
        }),
      )
      .digest('hex');
    return {
      ruleSetVersionId: input.ruleSet.id,
      scope: input.ruleSet.scope,
      resultCode: worstResult(rules.map((rule) => rule.resultCode)),
      rules,
      inputFactsHash,
    };
  }

  private evaluateRule(
    rule: ParsedRule,
    facts: MemberQualificationFacts,
    certificateFacts: Awaited<
      ReturnType<CertificateQualificationService['readCoveringFacts']>
    > | null,
    insured: boolean | null,
    activity: { startAt: Date; endAt: Date },
  ): EvaluatedRule {
    let passed = false;
    if (rule.ruleTypeCode === 'grade' && rule.value.kind === 'codes') {
      passed = facts.gradeCode !== null && rule.value.codes.includes(facts.gradeCode);
    } else if (rule.ruleTypeCode === 'gender' && rule.value.kind === 'codes') {
      passed = facts.profile !== null && rule.value.codes.includes(facts.profile.genderCode);
    } else if (rule.ruleTypeCode === 'organization' && rule.value.kind === 'organizationIds') {
      passed = this.memberFacts.hasActiveMembershipInRequiredSubtree(
        facts,
        rule.value.organizationIds,
      );
    } else if (
      (rule.ruleTypeCode === 'certificate' || rule.ruleTypeCode === 'training') &&
      rule.value.kind === 'standardIds'
    ) {
      passed =
        certificateFacts !== null &&
        this.certificateFacts.hasAnyCoveringStandard(certificateFacts, rule.value.standardIds);
    } else if (rule.ruleTypeCode === 'age' && rule.value.kind === 'age') {
      const age =
        facts.profile === null
          ? null
          : this.ageAtActivityStart(facts.profile.birthDate, activity.startAt);
      passed =
        age !== null &&
        (rule.value.minYears === null || age >= rule.value.minYears) &&
        (rule.value.maxYears === null || age <= rule.value.maxYears);
    } else if (rule.ruleTypeCode === 'insurance') {
      passed = insured === true;
    } else {
      this.configurationInvalid();
    }
    return {
      ...rule,
      resultCode: passed ? 'pass' : rule.enforcementCode === 'block' ? 'fail' : 'warn',
    };
  }

  private ageAtActivityStart(birthDate: Date, activityStart: Date): number {
    const birth = beijingDateOnly(birthDate);
    const start = beijingDateOnly(activityStart);
    let years = start.getUTCFullYear() - birth.getUTCFullYear();
    const birthdayThisYear = [birth.getUTCMonth(), birth.getUTCDate()];
    const startDay = [start.getUTCMonth(), start.getUTCDate()];
    if (
      startDay[0] < birthdayThisYear[0] ||
      (startDay[0] === birthdayThisYear[0] && startDay[1] < birthdayThisYear[1])
    ) {
      years -= 1;
    }
    return years;
  }

  private toProjection(rules: readonly EvaluatedRule[]): QualificationProjection {
    return {
      resultCode: worstResult(rules.map((rule) => rule.resultCode)),
      unmetRules: rules
        .filter((rule) => rule.resultCode !== 'pass')
        .map((rule) => ({
          ruleId: rule.id,
          enforcementCode: rule.enforcementCode,
          resultCode: rule.resultCode as 'warn' | 'fail',
          message: rule.message,
          warnScore: rule.warnScore,
        })),
    };
  }

  private configurationInvalid(): never {
    throw new BizException(BizCode.ACTIVITY_QUALIFICATION_CONFIGURATION_INVALID);
  }
}
