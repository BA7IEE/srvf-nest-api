import type { ConfigType } from '@nestjs/config';
import { Prisma, PrismaClient } from '@prisma/client';
import appConfig from '../../config/app.config';
import databaseConfig from '../../config/database.config';
import * as comparisonAuthority from '../activities/activity-contribution-shadow-comparison';
import {
  ContributionShadowService,
  ShadowComparisonBudget,
  evaluateShadowFrozenSource,
  prepareShadowEvidence,
  prepareShadowAttempt,
  prepareShadowComparisonSet,
  resolveShadowMappingAtSource,
  resolveShadowSelectionAtSource,
  resolveShadowSelectionsAtSource,
  type ShadowSelectionRevision,
  type ShadowMappingHistoryEvent,
} from './contribution-shadow.service';
import {
  activityContributionPolicySelectionHash,
  createActivityContributionPolicySelectionDocument,
  parseActivityContributionPolicySelectionDocument,
} from '../activities/activity-contribution-policy-selection';
import type { ActivityContributionPolicySelectionItem } from '@prisma/client';
import * as selectionAuthority from '../activities/activity-contribution-policy-selection';
import { fingerprintContributionPolicyVersion } from '../activities/activity-contribution-policy-definition';
import { hashLegacySource } from './contribution-shadow-evidence.write.service';
import { createHash } from 'node:crypto';

jest.mock('@prisma/client', () => {
  const actual = jest.requireActual<typeof import('@prisma/client')>('@prisma/client');
  return { ...actual, PrismaClient: jest.fn() };
});

describe('one monotonic post-commit comparison budget', () => {
  it('shortens pool waiting without increasing the total deadline or dropping connection reserve', () => {
    const budget = new ShadowComparisonBudget(() => 0);
    expect(budget.transactionOptions(1000, 100)).toEqual({
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      maxWait: 100,
      timeout: 3900,
    });
    expect(budget.remainingMs()).toBe(5000);
    const options = budget.transactionOptions(1000, 100);
    expect(options.maxWait + options.timeout + 1000).toBe(5000);
    // The original helper default remains characterized by the old assertions.
    expect(budget.transactionOptions(1000).maxWait).toBe(500);
  });

  it.each([0, -1, 0.5, NaN, Infinity, 501])('rejects invalid pool wait cap %s', (cap) => {
    expect(() => new ShadowComparisonBudget(() => 0).transactionOptions(0, cap)).toThrow(
      'pool wait cap invalid',
    );
  });
  it('only shrinks for a containing transaction, never grants a fresh budget', () => {
    let now = 0;
    const budget = new ShadowComparisonBudget(() => now);
    now = 500;
    budget.constrainRemaining(1000);
    expect(budget.remainingMs()).toBe(1000);
    now = 800;
    budget.constrainRemaining(5000);
    expect(budget.remainingMs()).toBe(700);
    budget.constrainRemaining(0);
    expect(budget.remainingMs()).toBe(0);
  });

  it.each([-1, 0.5, NaN, Infinity])('rejects invalid containing budget %s', (value) => {
    expect(() => new ShadowComparisonBudget(() => 0).constrainRemaining(value)).toThrow(
      'containing budget invalid',
    );
  });

  it('charges qualification, preparation, connection reserve and pool wait to one budget', () => {
    let now = 100;
    const budget = new ShadowComparisonBudget(() => now);
    expect(budget.remainingMs()).toBe(5000);
    now += 900;
    const first = budget.transactionOptions(1000);
    expect(first).toEqual({
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      maxWait: 500,
      timeout: 2600,
    });
    expect(first.maxWait + first.timeout + 1000).toBe(budget.remainingMs());
    now += 1500;
    const recovery = budget.transactionOptions();
    expect(recovery.maxWait + recovery.timeout).toBe(2600);
    expect(budget.remainingMs()).toBe(2600);
  });

  it('does not restart five seconds for replay or failed-terminal recovery stages', () => {
    let now = 0;
    const budget = new ShadowComparisonBudget(() => now);
    now = 4998;
    expect(budget.transactionOptions()).toMatchObject({ maxWait: 1, timeout: 1 });
    now = 4999;
    expect(() => budget.transactionOptions()).toThrow('budget exhausted');
    now = 7000;
    expect(budget.remainingMs()).toBe(0);
    expect(() => budget.transactionOptions()).toThrow('budget exhausted');
  });

  it('refuses a new connection stage when the remaining budget cannot cover its reserve', () => {
    let now = 0;
    const budget = new ShadowComparisonBudget(() => now);
    now = 4000;
    expect(() => budget.transactionOptions(1000)).toThrow('budget exhausted');
  });

  it.each([-1, 0.5, NaN, Infinity])('rejects invalid connection reserve %s', (reserve) => {
    const budget = new ShadowComparisonBudget(() => 0);
    expect(() => budget.transactionOptions(reserve)).toThrow('connection reserve invalid');
  });

  it('rejects a non-finite clock rather than granting an unbounded transaction', () => {
    expect(() => new ShadowComparisonBudget(() => NaN)).toThrow('clock unavailable');
    let now = 0;
    const budget = new ShadowComparisonBudget(() => now);
    now = Infinity;
    expect(() => budget.remainingMs()).toThrow('clock unavailable');
  });
});

describe('comparison from frozen legacy source and exact policy candidates', () => {
  function fixture(): Parameters<typeof evaluateShadowFrozenSource>[0] {
    const definition = {
      defaultResult: { recognizedPoints: '0.00', explanationCode: 'default_zero' },
      roleRules: [
        {
          attendanceRoleCode: 'member',
          categoryRules: [
            {
              timeCategoryCode: 'volunteer_service',
              durationBands: [
                { maxSecondsInclusive: 3600, recognizedPoints: '2.00', explanationCode: 'hour' },
                { maxSecondsInclusive: null, recognizedPoints: '3.00', explanationCode: 'long' },
              ],
            },
          ],
        },
      ],
    };
    const from = new Date('2099-09-01T00:00:00.000Z');
    const hash = fingerprintContributionPolicyVersion({
      schemaVersion: 1,
      evaluatorVersion: 1,
      definition,
      effectiveFrom: from.toISOString(),
      effectiveUntil: null,
    }).definitionHash;
    const source = {
      id: 'source-one',
      windowId: 'window-one',
      auditLogId: 'audit-one',
      sheetId: 'sheet-one',
      sheetVersion: 1,
      activityId: 'activity-one',
      recordId: 'record-one',
      memberId: 'member-one',
      activityTypeCode: 'service',
      attendanceRoleCode: 'member',
      legacyServiceHours: new Prisma.Decimal('1.00'),
      sourceKindCode: 'matched',
      legacyRuleId: 'rule-one',
      durationThreshold: new Prisma.Decimal('1.00'),
      pointsBelow: new Prisma.Decimal('2.00'),
      pointsAbove: new Prisma.Decimal('4.00'),
      legacyPoints: new Prisma.Decimal('2.00'),
      hashAlgorithmCode: 'sha256',
      canonicalVersion: 1,
      legacySourceHash: '',
      createdAt: from,
    };
    source.legacySourceHash = hashLegacySource({
      ...source,
      source: {
        sourceKindCode: 'matched',
        legacyRuleId: 'rule-one',
        durationThreshold: source.durationThreshold,
        pointsBelow: source.pointsBelow,
        pointsAbove: source.pointsAbove,
      },
    });
    return {
      source,
      sourceTime: new Date('2099-10-01T00:00:00.000Z'),
      signedMappingVersion: 'v1',
      mapping: {
        id: 'approval-one',
        approvalNumber: 'approval-one',
        mappingVersion: 'v1',
        manifestHash: 'b'.repeat(64),
        approvalReference: 'isolated-fixture',
        approvedAt: from,
        approvedByUserId: 'human-one',
        registeredByUserId: 'human-one',
        activityId: 'activity-one',
        activityTypeCode: 'service',
        attendanceRoleCode: 'member',
        sessionPositionId: 'position-one',
        policyRoleCode: 'member',
        categoryCode: 'volunteer_service',
        policyVersionId: 'version-one',
        policyDefinitionHash: hash,
        evaluatorVersion: 1,
        durationSourceCode: 'legacy_stored_hours_2',
        effectiveFrom: from,
        effectiveUntil: null,
        eventKindCode: 'approve',
        previousApprovalId: null,
        createdAt: from,
      },
      selectionItem: {
        id: 'item-one',
        selectionRevisionId: 'revision-one',
        activityId: 'activity-one',
        layerCode: 'position',
        sessionId: 'session-one',
        positionId: 'position-one',
        mode: 'explicit',
        policyId: 'policy-one',
        versionId: 'version-one',
        definitionHash: hash,
        evaluatorVersion: 1,
      },
      policyVersion: {
        id: 'version-one',
        policyId: 'policy-one',
        schemaVersion: 1,
        evaluatorVersion: 1,
        definitionJson: definition,
        definitionHash: hash,
        effectiveFrom: from,
        effectiveUntil: null,
      },
    };
  }
  function sourceSet(count = 2) {
    const original = fixture().source;
    const sources = Array.from({ length: count }, (_, index) => {
      const source = {
        ...original,
        id: `source-${index}`,
        recordId: `record-${index}`,
        memberId: `member-${index}`,
      };
      source.legacySourceHash = hashLegacySource({
        ...source,
        source: {
          sourceKindCode: 'matched',
          legacyRuleId: 'rule-one',
          durationThreshold: source.durationThreshold,
          pointsBelow: source.pointsBelow!,
          pointsAbove: source.pointsAbove,
        },
      });
      return source;
    });
    const context = {
      windowId: original.windowId,
      auditLogId: original.auditLogId,
      sheetId: original.sheetId,
      activityId: original.activityId,
      sheetVersion: original.sheetVersion,
      signedMappingVersion: 'v1',
    };
    return { context, sources, ids: sources.map((source) => source.recordId) };
  }

  it('independently reproduces the published full-set canonical fingerprint', () => {
    const f = sourceSet();
    const prepared = prepareShadowAttempt(f.context, f.ids, f.sources);
    const expected = createHash('sha256')
      .update(
        `SRVF:E3-2:committed-facts:v1:${JSON.stringify([
          'window-one',
          'audit-one',
          'sheet-one',
          'activity-one',
          1,
          'v1',
          2,
          [
            ['record-0', 'member-0', 'source-0', f.sources[0].legacySourceHash],
            ['record-1', 'member-1', 'source-1', f.sources[1].legacySourceHash],
          ],
        ])}`,
        'utf8',
      )
      .digest('hex');
    expect(prepared).toEqual({ ...f.context, committedFactHash: expected, expectedRecordCount: 2 });
    expect(prepared).not.toHaveProperty('replayKey');
    expect(prepared).not.toHaveProperty('id');
    expect(prepared).not.toHaveProperty('createdAt');
  });

  it('is order independent for 2,000 actual record IDs without mutating inputs', () => {
    const f = sourceSet(2000);
    const before = JSON.stringify(f);
    const ordered = prepareShadowAttempt(f.context, f.ids, f.sources);
    expect(prepareShadowAttempt(f.context, [...f.ids].reverse(), [...f.sources].reverse())).toEqual(
      ordered,
    );
    expect(ordered.expectedRecordCount).toBe(2000);
    expect(JSON.stringify(f)).toBe(before);
  });

  it.each([
    'empty',
    'missing-source',
    'missing-id',
    'duplicate-id',
    'duplicate-source',
    'duplicate-anchor',
    'foreign-record',
    'changed-value',
    'changed-hash',
    'invalid-kind',
    'invalid-algorithm',
    'invalid-canonical',
  ])('refuses %s in the committed source set', (kind) => {
    const f = sourceSet();
    if (kind === 'empty') {
      f.ids.length = 0;
      f.sources.length = 0;
    }
    if (kind === 'missing-source') f.sources.pop();
    if (kind === 'missing-id') f.ids.pop();
    if (kind === 'duplicate-id') f.ids[1] = f.ids[0];
    if (kind === 'duplicate-source') f.sources[1] = f.sources[0];
    if (kind === 'duplicate-anchor') f.sources[1].id = f.sources[0].id;
    if (kind === 'foreign-record') f.ids[1] = 'outside-record';
    if (kind === 'changed-value') f.sources[1].legacyPoints = new Prisma.Decimal('99.00');
    if (kind === 'changed-hash') f.sources[1].legacySourceHash = 'a'.repeat(64);
    if (kind === 'invalid-kind') f.sources[1].sourceKindCode = 'unknown';
    if (kind === 'invalid-algorithm') f.sources[1].hashAlgorithmCode = 'md5';
    if (kind === 'invalid-canonical') f.sources[1].canonicalVersion = 2;
    expect(() => prepareShadowAttempt(f.context, f.ids, f.sources)).toThrow(
      'shadow committed source set mismatch',
    );
  });

  it.each(['windowId', 'auditLogId', 'sheetId', 'activityId'])(
    'refuses cross-chain %s',
    (field) => {
      const f = sourceSet();
      f.sources[1] = { ...f.sources[1], [field]: 'other-chain' };
      expect(() => prepareShadowAttempt(f.context, f.ids, f.sources)).toThrow(
        'shadow committed source set mismatch',
      );
    },
  );

  it('refuses a different frozen source sheet version', () => {
    const f = sourceSet();
    f.sources[1].sheetVersion += 1;
    expect(() => prepareShadowAttempt(f.context, f.ids, f.sources)).toThrow(
      'shadow committed source set mismatch',
    );
  });

  it('changes the commitment for a different signed mapping version without inventing approval', () => {
    const f = sourceSet();
    expect(
      prepareShadowAttempt({ ...f.context, signedMappingVersion: 'v2' }, f.ids, f.sources)
        .committedFactHash,
    ).not.toBe(prepareShadowAttempt(f.context, f.ids, f.sources).committedFactHash);
  });

  function comparisonSet(count = 2): Parameters<typeof prepareShadowComparisonSet>[0] {
    const f = fixture();
    const set = sourceSet(count);
    const item = f.selectionItem!;
    const json = {
      schemaVersion: 1,
      items: {
        'activity:-:-': {
          scope: { layerCode: 'activity', sessionId: null, positionId: null },
          selection: { mode: 'inherit', pointer: null },
        },
        [`position:${Buffer.from('session-one').toString('base64')}:${Buffer.from('position-one').toString('base64')}`]:
          {
            scope: {
              layerCode: item.layerCode,
              sessionId: item.sessionId,
              positionId: item.positionId,
            },
            selection: {
              mode: item.mode,
              pointer: {
                policyId: item.policyId,
                versionId: item.versionId,
                definitionHash: item.definitionHash,
                evaluatorVersion: item.evaluatorVersion,
              },
            },
          },
      },
    };
    return {
      context: set.context,
      expectedRecordIds: set.ids,
      sources: set.sources,
      sourceTime: f.sourceTime,
      mappingHistory: [f.mapping!],
      policyVersions: [f.policyVersion!],
      positions: [
        {
          id: 'position-one',
          activityId: 'activity-one',
          sessionId: 'session-one',
          attendanceRoleCode: 'member',
        },
      ],
      selectionRevision: {
        id: 'revision-one',
        activityId: 'activity-one',
        revision: 1,
        schemaVersion: 1,
        selectionJson: json,
        selectionHash: activityContributionPolicySelectionHash(
          parseActivityContributionPolicySelectionDocument(json),
        ),
        itemCount: 2,
        createdAt: f.source.createdAt,
        items: [
          {
            ...item,
            id: 'root-item',
            layerCode: 'activity',
            sessionId: null,
            positionId: null,
            mode: 'inherit',
            policyId: null,
            versionId: null,
            definitionHash: null,
            evaluatorVersion: null,
          },
          item,
        ],
      },
    };
  }

  it('prepares a complete same-chain application/comparison set with one immutable commitment', () => {
    const f = comparisonSet();
    const before = JSON.stringify(f);
    const prepared = prepareShadowComparisonSet(f);
    expect(prepared.attempt).toEqual(
      prepareShadowAttempt(f.context, f.expectedRecordIds, f.sources),
    );
    expect(prepared.applications).toHaveLength(2);
    expect(prepared.comparisons).toHaveLength(2);
    expect(prepared.comparisons.map((row) => row.recordId)).toEqual(f.expectedRecordIds);
    expect(
      prepared.comparisons.every((row) => row.comparable && row.classificationCode === 'equal'),
    ).toBe(true);
    expect(JSON.stringify(f)).toBe(before);
  });

  it('reuses only candidate preparation within a 2,000-record call, with no duplicate or lost rows', () => {
    const f = comparisonSet(2000);
    const hash = jest.spyOn(selectionAuthority, 'activityContributionPolicySelectionHash');
    try {
      const prepared = prepareShadowComparisonSet(f);
      expect(prepared.applications).toHaveLength(2000);
      expect(new Set(prepared.comparisons.map((row) => row.recordId)).size).toBe(2000);
      expect(hash).toHaveBeenCalledTimes(2);
    } finally {
      hash.mockRestore();
    }
  });

  it('strictly prepares one policy per call and keeps all 2,000 independent evidence rows', () => {
    const f = comparisonSet(2000);
    const factory = jest.spyOn(comparisonAuthority, 'prepareContributionShadowPolicy');
    try {
      const prepared = prepareShadowComparisonSet(f);
      expect(factory).toHaveBeenCalledTimes(1);
      const expected = f.sources.map((source) =>
        prepareShadowEvidence({
          source,
          sourceTime: f.sourceTime,
          signedMappingVersion: f.context.signedMappingVersion,
          mapping: f.mappingHistory[0],
          selectionItem:
            f.selectionRevision!.items.find((item) => item.mode === 'explicit') ?? null,
          policyVersion: f.policyVersions[0],
        }),
      );
      expect(prepared.applications).toHaveLength(expected.length);
      expected.forEach((row, index) => {
        expect(prepared.applications[index]).toEqual(row.application);
        expect(prepared.comparisons[index]).toEqual(row.comparison);
      });
      factory.mockClear();
      expect(prepareShadowComparisonSet(f)).toEqual(prepared);
      expect(factory).toHaveBeenCalledTimes(1);
    } finally {
      factory.mockRestore();
    }
  });

  it('does not reuse a previous call after a same-key definition changes', () => {
    const f = comparisonSet();
    expect(prepareShadowComparisonSet(f).applications).toHaveLength(2);
    f.policyVersions[0].definitionJson = { invalid: true };
    const next = prepareShadowComparisonSet(f);
    expect(next.applications).toHaveLength(0);
    expect(next.comparisons.map((row) => row.classificationCode)).toEqual([
      'evaluation_error',
      'evaluation_error',
    ]);
  });

  it('keeps two policies separate in one 2,000-source call and validates each policy only once', () => {
    const f = comparisonSet(2000);
    const secondDefinition = JSON.parse(
      JSON.stringify(fixture().policyVersion!.definitionJson),
    ) as Prisma.JsonValue;
    const definition = secondDefinition as {
      roleRules: Array<{
        categoryRules: Array<{ durationBands: Array<{ recognizedPoints: string }> }>;
      }>;
    };
    definition.roleRules[0].categoryRules[0].durationBands[0].recognizedPoints = '3.00';
    const second = {
      ...f.policyVersions[0],
      id: 'version-two',
      policyId: 'policy-two',
      definitionJson: secondDefinition,
    };
    second.definitionHash = fingerprintContributionPolicyVersion({
      schemaVersion: second.schemaVersion,
      evaluatorVersion: second.evaluatorVersion,
      definition: secondDefinition,
      effectiveFrom: second.effectiveFrom.toISOString(),
      effectiveUntil: null,
    }).definitionHash;
    const mapping = {
      ...f.mappingHistory[0],
      id: 'approval-two',
      approvalNumber: 'approval-two',
      attendanceRoleCode: 'leader',
      sessionPositionId: 'position-two',
      policyVersionId: second.id,
      policyDefinitionHash: second.definitionHash,
    };
    const item = {
      ...f.selectionRevision!.items[1],
      id: 'item-two',
      positionId: 'position-two',
      policyId: second.policyId,
      versionId: second.id,
      definitionHash: second.definitionHash,
    };
    const items = [...f.selectionRevision!.items, item];
    const selectionJson = createActivityContributionPolicySelectionDocument(
      items.map((entry) => ({
        scope: {
          layerCode: entry.layerCode === 'position' ? 'position' : 'activity',
          sessionId: entry.sessionId,
          positionId: entry.positionId,
        },
        selection:
          entry.mode === 'explicit'
            ? {
                mode: 'explicit',
                pointer: {
                  policyId: entry.policyId!,
                  versionId: entry.versionId!,
                  definitionHash: entry.definitionHash!,
                  evaluatorVersion: entry.evaluatorVersion!,
                },
              }
            : { mode: 'inherit', pointer: null },
      })),
    );
    f.selectionRevision = {
      ...f.selectionRevision!,
      items,
      itemCount: items.length,
      selectionJson: JSON.parse(JSON.stringify(selectionJson)) as Prisma.JsonValue,
      selectionHash: activityContributionPolicySelectionHash(selectionJson),
    };
    f.mappingHistory = [...f.mappingHistory, mapping];
    f.policyVersions = [...f.policyVersions, second];
    f.positions = [...f.positions, { ...f.positions[0], id: 'position-two' }];
    f.sources.forEach((source, index) => {
      if (index % 2 === 0) return;
      source.attendanceRoleCode = 'leader';
      source.legacySourceHash = hashLegacySource({
        ...source,
        source: {
          sourceKindCode: 'matched',
          legacyRuleId: source.legacyRuleId!,
          durationThreshold: source.durationThreshold,
          pointsBelow: source.pointsBelow!,
          pointsAbove: source.pointsAbove,
        },
      });
    });
    const factory = jest.spyOn(comparisonAuthority, 'prepareContributionShadowPolicy');
    try {
      const actual = prepareShadowComparisonSet(f);
      expect(factory).toHaveBeenCalledTimes(2);
      expect(actual.applications).toHaveLength(2000);
      f.sources.forEach((source, index) => {
        const alternate = index % 2 !== 0;
        const reference = prepareShadowEvidence({
          source,
          sourceTime: f.sourceTime,
          signedMappingVersion: f.context.signedMappingVersion,
          mapping: alternate ? mapping : f.mappingHistory[0],
          selectionItem: alternate ? item : items[1],
          policyVersion: alternate ? second : f.policyVersions[0],
        });
        expect(actual.applications[index]).toEqual(reference.application);
        expect(actual.comparisons[index]).toEqual(reference.comparison);
        expect(actual.comparisons[index].policyPoints).toBe(alternate ? '3.00' : '2.00');
      });
    } finally {
      factory.mockRestore();
    }
  });

  it('does not prepare a malformed policy ahead of an unsigned mapping', () => {
    const f = comparisonSet();
    f.mappingHistory = [];
    f.policyVersions[0].definitionJson = { invalid: true };
    const factory = jest.spyOn(comparisonAuthority, 'prepareContributionShadowPolicy');
    try {
      const actual = prepareShadowComparisonSet(f);
      expect(factory).not.toHaveBeenCalled();
      expect(actual.applications).toEqual([]);
      expect(actual.comparisons.map((row) => row.classificationCode)).toEqual([
        'mapping_hold',
        'mapping_hold',
      ]);
    } finally {
      factory.mockRestore();
    }
  });

  it.each([
    'unsigned',
    'missing-position',
    'position-role-mismatch',
    'missing-selection',
    'missing-version',
  ])('retains every row as non-comparable for %s rather than guessing a replacement', (kind) => {
    const f = comparisonSet();
    if (kind === 'unsigned') f.mappingHistory = [];
    if (kind === 'missing-position') f.positions = [];
    if (kind === 'position-role-mismatch')
      f.positions = [{ ...f.positions[0], attendanceRoleCode: 'other' }];
    if (kind === 'missing-selection') f.selectionRevision = null;
    if (kind === 'missing-version') f.policyVersions = [];
    const prepared = prepareShadowComparisonSet(f);
    expect(prepared.applications).toHaveLength(0);
    expect(prepared.comparisons).toHaveLength(2);
    expect(
      prepared.comparisons.every(
        (row) => !row.comparable && row.policySourceHash === null && row.policyPoints === null,
      ),
    ).toBe(true);
  });

  it('rejects duplicate positions instead of silently overwriting candidate evidence', () => {
    const f = comparisonSet();
    f.positions = [f.positions[0], f.positions[0]];
    expect(() => prepareShadowComparisonSet(f)).toThrow(
      'shadow comparison preparation position mismatch',
    );
  });

  it('rejects foreign positions before interpreting the immutable selection', () => {
    const f = comparisonSet();
    f.positions = [{ ...f.positions[0], activityId: 'foreign' }];
    expect(() => prepareShadowComparisonSet(f)).toThrow(
      'shadow comparison preparation position mismatch',
    );
  });

  it('rejects duplicate exact policy anchors rather than choosing by input order', () => {
    const f = comparisonSet();
    f.policyVersions = [f.policyVersions[0], f.policyVersions[0]];
    expect(() => prepareShadowComparisonSet(f)).toThrow(
      'shadow comparison preparation policy mismatch',
    );
  });

  it('rejects invalid audit time without substituting application time', () => {
    const f = comparisonSet();
    f.sourceTime = new Date('invalid');
    expect(() => prepareShadowComparisonSet(f)).toThrow(
      'shadow comparison preparation instant mismatch',
    );
  });

  it('derives equal and lossless seconds from frozen old input, not current legacy rules', () => {
    expect(evaluateShadowFrozenSource(fixture())).toEqual({
      classification: 'equal',
      comparable: true,
      legacyPoints: '2.00',
      policyPoints: '2.00',
      policyExplanationCode: 'hour',
      durationSeconds: 3600,
    });
  });
  it('prepares matching application and comparison rows without caller write metadata', () => {
    const f = fixture();
    const before = JSON.stringify(f);
    const rows = prepareShadowEvidence(f);
    expect(rows.application).toMatchObject({
      approvalId: 'approval-one',
      legacySourceAnchorId: 'source-one',
      windowId: 'window-one',
      auditLogId: 'audit-one',
      sheetId: 'sheet-one',
      sheetVersion: 1,
      activityId: 'activity-one',
      recordId: 'record-one',
      memberId: 'member-one',
      selectionItemId: 'item-one',
      policyVersionId: 'version-one',
      policyPoints: '2.00',
      durationSeconds: 3600,
    });
    expect(rows.comparison).toMatchObject({
      classificationCode: 'equal',
      comparable: true,
      selectionRevisionId: 'revision-one',
      selectionItemId: 'item-one',
      policyId: 'policy-one',
      policyVersionId: 'version-one',
      durationSeconds: 3600,
      legacySourceHash: f.source.legacySourceHash,
    });
    for (const row of [rows.application, rows.comparison])
      for (const key of ['id', 'createdAt', 'attemptId']) expect(row).not.toHaveProperty(key);
    expect(JSON.stringify(f)).toBe(before);
  });
  it('uses the published fixed fact field order rather than an arbitrary 64-character string', () => {
    const f = fixture();
    const expected = createHash('sha256')
      .update(
        'SRVF:E3-2:shadow-fact:v1:' +
          JSON.stringify([
            'window-one',
            'audit-one',
            'sheet-one',
            1,
            'activity-one',
            'record-one',
            'member-one',
            'service',
            'member',
            '1.00',
            '2.00',
            f.source.legacySourceHash,
            '2099-10-01T00:00:00.000Z',
          ]),
        'utf8',
      )
      .digest('hex');
    expect(prepareShadowEvidence(f).comparison.factHash).toBe(expected);
    expect(prepareShadowEvidence(f).comparison.factHash).toBe(
      prepareShadowEvidence(f).comparison.factHash,
    );
  });
  it('uses the published policy field order, binding the mapping and selection proof anchors', () => {
    const f = fixture();
    const expected = createHash('sha256')
      .update(
        'SRVF:E3-2:shadow-policy:v1:' +
          JSON.stringify([
            'approval-one',
            'v1',
            'b'.repeat(64),
            'revision-one',
            'item-one',
            'policy-one',
            'version-one',
            f.policyVersion!.definitionHash,
            1,
            'member',
            'volunteer_service',
            'legacy_stored_hours_2',
            3600,
            '2.00',
            'hour',
          ]),
        'utf8',
      )
      .digest('hex');
    expect(prepareShadowEvidence(f).comparison.policySourceHash).toBe(expected);
  });
  it('keeps unsigned mappings out of application proofs and clears the complete policy reference group', () => {
    const f = fixture();
    f.mapping = null;
    const rows = prepareShadowEvidence(f);
    expect(rows.application).toBeNull();
    expect(rows.comparison).toMatchObject({
      classificationCode: 'mapping_hold',
      comparable: false,
      policySourceHash: null,
      selectionRevisionId: null,
      selectionItemId: null,
      policyVersionId: null,
      policyId: null,
      definitionHash: null,
      evaluatorVersion: null,
      durationSeconds: null,
      policyPoints: null,
    });
  });
  it('prepares a fixed sanitized evaluation failure code without raw exception data', () => {
    const f = fixture();
    f.policyVersion = { ...f.policyVersion!, definitionJson: { invalid: 'fixture' } };
    const rows = prepareShadowEvidence(f);
    expect(rows.application).toBeNull();
    expect(rows.comparison).toMatchObject({
      classificationCode: 'evaluation_error',
      comparable: false,
      failureCode: 'shadow_evaluation_error',
      policySourceHash: null,
    });
  });
  it('derives mismatch from independently verified policy content', () => {
    const f = fixture();
    const definition = {
      defaultResult: { recognizedPoints: '0.00', explanationCode: 'default_zero' },
      roleRules: [
        {
          attendanceRoleCode: 'member',
          categoryRules: [
            {
              timeCategoryCode: 'volunteer_service',
              durationBands: [
                { maxSecondsInclusive: null, recognizedPoints: '10.00', explanationCode: 'fixed' },
              ],
            },
          ],
        },
      ],
    };
    const hash = fingerprintContributionPolicyVersion({
      schemaVersion: 1,
      evaluatorVersion: 1,
      definition,
      effectiveFrom: f.policyVersion!.effectiveFrom.toISOString(),
      effectiveUntil: null,
    }).definitionHash;
    f.policyVersion = { ...f.policyVersion!, definitionJson: definition, definitionHash: hash };
    f.mapping = { ...f.mapping!, policyDefinitionHash: hash };
    f.selectionItem = { ...f.selectionItem!, definitionHash: hash };
    expect(evaluateShadowFrozenSource(f)).toEqual({
      classification: 'points_mismatch',
      comparable: true,
      legacyPoints: '2.00',
      policyPoints: '10.00',
      policyExplanationCode: 'fixed',
      durationSeconds: 3600,
    });
  });
  it.each([
    { activityId: 'other' },
    { attendanceRoleCode: 'other' },
    { mappingVersion: 'unsigned' },
    { eventKindCode: 'revoke' },
    { approvedAt: new Date('2099-11-01T00:00:00.000Z') },
    { effectiveUntil: new Date('2099-10-01T00:00:00.000Z') },
    { categoryCode: 'training' },
    { policyRoleCode: 'unknown' },
  ])(
    'holds unavailable mapping or missing role/category instead of using defaultResult %p',
    (change) => {
      const f = fixture();
      f.mapping = { ...f.mapping!, ...change };
      expect(evaluateShadowFrozenSource(f).classification).toBe('mapping_hold');
    },
  );
  it('does not guess an unapproved mapping', () => {
    const f = fixture();
    f.mapping = null;
    expect(evaluateShadowFrozenSource(f).comparable).toBe(false);
    expect(evaluateShadowFrozenSource(f).classification).toBe('mapping_hold');
  });
  it.each([
    { mode: 'inherit' },
    { versionId: 'other' },
    { definitionHash: 'a'.repeat(64) },
    { activityId: 'other' },
  ])('does not accept a selection mismatch %p', (change) => {
    const f = fixture();
    f.selectionItem = { ...f.selectionItem!, ...change };
    expect(evaluateShadowFrozenSource(f).classification).toBe(
      'policy_version_missing_or_unapproved',
    );
  });
  it('independently recomputes policy fingerprint instead of accepting matching claimed hashes', () => {
    const f = fixture();
    f.policyVersion = { ...f.policyVersion!, definitionHash: 'a'.repeat(64) };
    f.mapping = { ...f.mapping!, policyDefinitionHash: 'a'.repeat(64) };
    f.selectionItem = { ...f.selectionItem!, definitionHash: 'a'.repeat(64) };
    expect(evaluateShadowFrozenSource(f).classification).toBe('source_drift');
  });
  it('does not turn missing old rules into comparable zero', () => {
    const f = fixture();
    f.source = {
      ...f.source,
      sourceKindCode: 'no_match',
      legacyRuleId: null,
      durationThreshold: null,
      pointsBelow: null,
      pointsAbove: null,
      legacyPoints: new Prisma.Decimal(0),
    };
    f.source.legacySourceHash = hashLegacySource({
      ...f.source,
      source: {
        sourceKindCode: 'no_match',
        legacyRuleId: null,
        durationThreshold: null,
        pointsBelow: null,
        pointsAbove: null,
      },
    });
    expect(evaluateShadowFrozenSource(f).classification).toBe('legacy_rule_missing');
    expect(evaluateShadowFrozenSource(f).comparable).toBe(false);
  });
  it('rejects tampered frozen rules even when current rules could produce the desired answer', () => {
    const f = fixture();
    f.source.pointsBelow = new Prisma.Decimal(20);
    expect(evaluateShadowFrozenSource(f).classification).toBe('source_drift');
  });
  it('rejects a self-consistent source hash when frozen points disagree with the frozen rule calculation', () => {
    const f = fixture();
    f.source.legacyPoints = new Prisma.Decimal('9.00');
    f.source.legacySourceHash = hashLegacySource({
      ...f.source,
      source: {
        sourceKindCode: 'matched',
        legacyRuleId: f.source.legacyRuleId!,
        durationThreshold: f.source.durationThreshold,
        pointsBelow: f.source.pointsBelow!,
        pointsAbove: f.source.pointsAbove,
      },
    });
    expect(evaluateShadowFrozenSource(f).classification).toBe('source_drift');
    expect(evaluateShadowFrozenSource(f).comparable).toBe(false);
  });
  it('uses only the approved stored-hours source, not start/end span guessing', () => {
    const f = fixture();
    f.mapping = { ...f.mapping!, durationSourceCode: 'guessed_span' };
    expect(evaluateShadowFrozenSource(f).classification).toBe('input_source_mismatch');
  });
  it('does not evaluate a source with an invalid audit instant', () => {
    const f = fixture();
    f.sourceTime = new Date('invalid');
    expect(evaluateShadowFrozenSource(f).classification).toBe('input_source_mismatch');
  });
});

describe('source-time immutable E1 selection preparation', () => {
  const instant = new Date('2099-10-01T00:00:00.000Z');
  const position = { id: 'position-one', activityId: 'activity-one', sessionId: 'session-one' };
  const item = (
    change: Partial<ActivityContributionPolicySelectionItem> = {},
  ): ActivityContributionPolicySelectionItem => ({
    id: 'root-item',
    selectionRevisionId: 'revision-one',
    activityId: 'activity-one',
    layerCode: 'activity',
    sessionId: null,
    positionId: null,
    mode: 'explicit',
    policyId: 'policy-one',
    versionId: 'version-one',
    definitionHash: 'a'.repeat(64),
    evaluatorVersion: 1,
    ...change,
  });
  function revision(items = [item()]): ShadowSelectionRevision {
    const json = {
      schemaVersion: 1,
      items: Object.fromEntries(
        items.map((row) => {
          const component = (id: string | null) =>
            id === null ? '-' : Buffer.from(id).toString('base64');
          return [
            `${row.layerCode}:${component(row.sessionId)}:${component(row.positionId)}`,
            {
              scope: {
                layerCode: row.layerCode,
                sessionId: row.sessionId,
                positionId: row.positionId,
              },
              selection: {
                mode: row.mode,
                pointer:
                  row.mode === 'inherit'
                    ? null
                    : {
                        policyId: row.policyId,
                        versionId: row.versionId,
                        definitionHash: row.definitionHash,
                        evaluatorVersion: row.evaluatorVersion,
                      },
              },
            },
          ];
        }),
      ),
    };
    return {
      id: 'revision-one',
      activityId: 'activity-one',
      revision: 1,
      schemaVersion: 1,
      selectionJson: json,
      selectionHash: activityContributionPolicySelectionHash(
        parseActivityContributionPolicySelectionDocument(json),
      ),
      itemCount: items.length,
      createdAt: instant,
      items,
    };
  }

  it('retains the explicit activity item at the inclusive source-time boundary', () => {
    const source = revision();
    expect(resolveShadowSelectionAtSource(source, position, instant)).toBe(source.items[0]);
  });
  it('validates the complete immutable revision only once for 2,000 Record position references', () => {
    const source = revision();
    const hash = jest.spyOn(selectionAuthority, 'activityContributionPolicySelectionHash');
    try {
      const result = resolveShadowSelectionsAtSource(
        source,
        Array.from({ length: 2000 }, () => position),
        instant,
      );
      expect(result).toHaveLength(2000);
      expect(result.every((entry) => entry === source.items[0])).toBe(true);
      expect(hash).toHaveBeenCalledTimes(2);
    } finally {
      hash.mockRestore();
    }
  });
  it('does not reuse selection validation across separate calls', () => {
    const source = revision();
    expect(resolveShadowSelectionsAtSource(source, [position], instant)[0]).toBe(source.items[0]);
    source.selectionHash = 'b'.repeat(64);
    expect(() => resolveShadowSelectionsAtSource(source, [position], instant)).toThrow();
  });
  it('prefers the exact explicit position over the activity without merging pointers', () => {
    const override = item({
      id: 'position-item',
      layerCode: 'position',
      sessionId: position.sessionId,
      positionId: position.id,
      versionId: 'position-version',
    });
    const source = revision([item(), override]);
    expect(resolveShadowSelectionAtSource(source, position, instant)).toBe(override);
  });
  it('does not use another position override for this position', () => {
    const root = item();
    const source = revision([
      root,
      item({
        id: 'other-item',
        layerCode: 'position',
        sessionId: position.sessionId,
        positionId: 'other-position',
      }),
    ]);
    expect(resolveShadowSelectionAtSource(source, position, instant)).toBe(root);
  });
  it('does not manufacture explicit evidence from inheritance or absent revisions', () => {
    const inherit = item({
      mode: 'inherit',
      policyId: null,
      versionId: null,
      definitionHash: null,
      evaluatorVersion: null,
    });
    expect(resolveShadowSelectionAtSource(revision([inherit]), position, instant)).toBeNull();
    expect(resolveShadowSelectionAtSource(null, position, instant)).toBeNull();
  });
  it.each([
    { activityId: 'other' },
    { revision: 0 },
    { schemaVersion: 2 },
    { itemCount: 2 },
    { createdAt: new Date('invalid') },
    { createdAt: new Date(instant.getTime() + 1) },
    { selectionHash: 'b'.repeat(64) },
  ])('rejects malformed or future revision %p', (change) => {
    expect(() =>
      resolveShadowSelectionAtSource({ ...revision(), ...change }, position, instant),
    ).toThrow();
  });
  it.each([
    { activityId: 'other' },
    { selectionRevisionId: 'other' },
    { id: '' },
    { versionId: 'changed-version' },
    { mode: 'not_required' },
  ])('rejects materialized evidence drift %p', (change) => {
    const source = revision();
    source.items = [item(change)];
    expect(() => resolveShadowSelectionAtSource(source, position, instant)).toThrow();
  });
  it('rejects duplicate scopes and evidence IDs', () => {
    const source = revision();
    source.items = [item(), item()];
    source.itemCount = 2;
    expect(() => resolveShadowSelectionAtSource(source, position, instant)).toThrow();
  });
  it('rejects inherited materialized rows containing a hidden policy pointer', () => {
    const inherited = item({
      mode: 'inherit',
      policyId: null,
      versionId: null,
      definitionHash: null,
      evaluatorVersion: null,
    });
    const source = revision([inherited]);
    source.items = [{ ...inherited, policyId: 'hidden' }];
    expect(() => resolveShadowSelectionAtSource(source, position, instant)).toThrow();
  });
  it('rejects invalid source audit instants even for a missing revision', () => {
    expect(() => resolveShadowSelectionAtSource(null, position, new Date('invalid'))).toThrow();
  });
  it.each([{ id: '' }, { activityId: 'other' }, { sessionId: ' invalid' }])(
    'rejects invalid or cross-activity actual position keys %p',
    (change) => {
      expect(() =>
        resolveShadowSelectionAtSource(revision(), { ...position, ...change }, instant),
      ).toThrow();
    },
  );
});

describe('immutable mapping event resolution at source time', () => {
  const source = {
    activityId: 'activity-one',
    activityTypeCode: 'service',
    attendanceRoleCode: 'member',
    mappingVersion: 'v1',
    sourceTime: new Date('2099-10-01T00:00:00.000Z'),
  };
  const event = (change: Partial<ShadowMappingHistoryEvent> = {}): ShadowMappingHistoryEvent => ({
    id: 'approval-one',
    activityId: 'activity-one',
    activityTypeCode: 'service',
    attendanceRoleCode: 'member',
    mappingVersion: 'v1',
    approvedAt: new Date('2099-09-01T00:00:00.000Z'),
    effectiveFrom: new Date('2099-09-01T00:00:00.000Z'),
    effectiveUntil: null,
    eventKindCode: 'approve',
    previousApprovalId: null,
    ...change,
  });

  it('returns only the sole matching candidate without manufacturing approval', () => {
    const approval = event();
    expect(resolveShadowMappingAtSource([approval], source)).toBe(approval);
    expect(resolveShadowMappingAtSource([], source)).toBeNull();
  });
  it('holds ambiguous mappings instead of choosing the first or newest', () => {
    const a = event();
    const b = event({ id: 'approval-two' });
    expect(resolveShadowMappingAtSource([a, b], source)).toBeNull();
    expect(resolveShadowMappingAtSource([b, a], source)).toBeNull();
  });
  it.each(['revoke', 'replace'])(
    'cross-version %s permanently excludes its predecessor, independent of ordering',
    (kind) => {
      const a = event();
      const b = event({
        id: 'successor',
        mappingVersion: 'v2',
        eventKindCode: kind,
        previousApprovalId: a.id,
        effectiveUntil: new Date('2099-09-15T00:00:00.000Z'),
      });
      expect(resolveShadowMappingAtSource([a, b], source)).toBeNull();
      expect(resolveShadowMappingAtSource([b, a], source)).toBeNull();
    },
  );
  it('resolves a same-version replacement without reviving the predecessor', () => {
    const a = event();
    const b = event({ id: 'replacement', eventKindCode: 'replace', previousApprovalId: a.id });
    expect(resolveShadowMappingAtSource([b, a], source)).toBe(b);
  });
  it.each(['approvedAt', 'effectiveFrom'] as const)(
    'future %s on a successor does not rewrite history',
    (field) => {
      const a = event();
      const b = event({
        id: 'successor',
        eventKindCode: 'revoke',
        previousApprovalId: a.id,
        [field]: new Date('2099-10-01T00:00:00.001Z'),
      });
      expect(resolveShadowMappingAtSource([a, b], source)).toBe(a);
    },
  );
  it('honors inclusive starts and exclusive ends, including same-instant revocation', () => {
    const a = event({ approvedAt: source.sourceTime, effectiveFrom: source.sourceTime });
    expect(resolveShadowMappingAtSource([a], source)).toBe(a);
    expect(
      resolveShadowMappingAtSource([event({ effectiveUntil: source.sourceTime })], source),
    ).toBeNull();
    expect(
      resolveShadowMappingAtSource(
        [
          a,
          event({
            id: 'revoke',
            eventKindCode: 'revoke',
            previousApprovalId: a.id,
            approvedAt: source.sourceTime,
            effectiveFrom: source.sourceTime,
          }),
        ],
        source,
      ),
    ).toBeNull();
  });
  it.each([
    { activityId: 'other' },
    { activityTypeCode: 'other' },
    { attendanceRoleCode: 'other' },
    { mappingVersion: 'v2' },
  ])('does not accept an unrelated candidate %p', (change) => {
    expect(resolveShadowMappingAtSource([event(change)], source)).toBeNull();
  });
  it('ignores a successor from another activity even if its predecessor ID is supplied', () => {
    const a = event();
    const b = event({
      id: 'other-successor',
      activityId: 'other',
      eventKindCode: 'revoke',
      previousApprovalId: a.id,
    });
    expect(resolveShadowMappingAtSource([a, b], source)).toBe(a);
  });
  it.each([
    { eventKindCode: 'unknown' },
    { approvedAt: new Date('invalid') },
    { effectiveUntil: new Date('2099-08-01T00:00:00.000Z') },
    { previousApprovalId: 'unexpected' },
  ])('rejects malformed history rather than presenting a comparable candidate %p', (change) => {
    expect(() => resolveShadowMappingAtSource([event(change)], source)).toThrow();
  });
  it('rejects duplicate evidence IDs and invalid source instants or keys', () => {
    expect(() => resolveShadowMappingAtSource([event(), event()], source)).toThrow();
    expect(() =>
      resolveShadowMappingAtSource([], { ...source, sourceTime: new Date('invalid') }),
    ).toThrow();
    expect(() => resolveShadowMappingAtSource([], { ...source, mappingVersion: '' })).toThrow();
  });
});

function makeService(mode: 'off' | 'shadow' | undefined) {
  const query = jest
    .fn<Promise<Array<{ id: string; signedMappingVersion: string }>>, [unknown]>()
    .mockResolvedValue([]);
  const tx = { $queryRaw: query } as unknown as Prisma.TransactionClient;
  const config = { contributionShadowMode: mode } as ConfigType<typeof appConfig>;
  const database: ConfigType<typeof databaseConfig> = {
    url: undefined,
    contributionShadowUrl: undefined,
  };
  return { service: new ContributionShadowService(config, database), tx, query };
}

describe('E3-2 D2 registered shadow window candidate', () => {
  it.each(['off', undefined] as const)('does not query a window when mode is %s', async (mode) => {
    const { service, tx, query } = makeService(mode);
    await expect(service.findCurrentRegisteredWindow(tx)).resolves.toBeNull();
    expect(query).not.toHaveBeenCalled();
  });

  it('returns the registered window from the caller transaction', async () => {
    const { service, tx, query } = makeService('shadow');
    query.mockResolvedValue([{ id: 'window-1', signedMappingVersion: 'signed-v1' }]);
    await expect(service.findCurrentRegisteredWindow(tx)).resolves.toEqual({
      id: 'window-1',
      signedMappingVersion: 'signed-v1',
    });
    expect(query).toHaveBeenCalledTimes(1);
    const queryParts = query.mock.calls[0][0] as TemplateStringsArray;
    expect(queryParts.join('')).toContain('transaction_timestamp()');
    expect(queryParts.join('')).toContain("::timestamp(3) AT TIME ZONE 'UTC'");
    expect(queryParts.join('')).toContain('FOR SHARE');
  });

  it('fails closed if the supposedly exclusive windows overlap', async () => {
    const { service, tx, query } = makeService('shadow');
    query.mockResolvedValue([
      { id: 'window-1', signedMappingVersion: 'signed-v1' },
      { id: 'window-2', signedMappingVersion: 'signed-v2' },
    ]);
    await expect(service.findCurrentRegisteredWindow(tx)).rejects.toThrow('overlapping');
  });
});

describe('independent shadow connection lifecycle', () => {
  const construct = jest.mocked(PrismaClient);
  const disconnect = jest.fn<Promise<void>, []>();
  const connect = jest.fn<Promise<void>, []>();
  const client = { $disconnect: disconnect, $connect: connect } as unknown as PrismaClient;

  beforeEach(() => {
    construct.mockReset();
    disconnect.mockReset().mockResolvedValue(undefined);
    connect.mockReset().mockResolvedValue(undefined);
    construct.mockReturnValue(client);
  });

  function service(mode: 'off' | 'shadow', url?: string) {
    return new ContributionShadowService(
      { contributionShadowMode: mode } as ConfigType<typeof appConfig>,
      { url: 'postgresql://primary.invalid/db', contributionShadowUrl: url },
    );
  }

  it('off creates no client, runs no work and disconnects nothing', async () => {
    const subject = service('off', 'postgresql://runtime.invalid/db');
    const work = jest.fn<Promise<string>, [PrismaClient]>();
    await expect(subject.withRuntimeClient(work)).resolves.toBeNull();
    await subject.onModuleDestroy();
    expect(work).not.toHaveBeenCalled();
    expect(construct).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
    expect(disconnect).not.toHaveBeenCalled();
  });

  it.each([
    undefined,
    '',
    ' ',
    ' postgresql://runtime.invalid/db',
    'postgresql://primary.invalid/db',
  ])('rejects unavailable or non-independent input %j without creating a client', async (url) => {
    const work = jest.fn<Promise<string>, [PrismaClient]>();
    await expect(service('shadow', url).withRuntimeClient(work)).rejects.toThrow(
      'independent shadow runtime connection is unavailable',
    );
    expect(work).not.toHaveBeenCalled();
    expect(construct).not.toHaveBeenCalled();
  });

  it('lazily uses only the independent datasource and closes its pool once', async () => {
    const subject = service('shadow', 'postgresql://runtime.invalid/db');
    expect(construct).not.toHaveBeenCalled();
    const work = jest.fn<Promise<string>, [PrismaClient]>().mockResolvedValue('evidence');
    await expect(subject.withRuntimeClient(work)).resolves.toBe('evidence');
    await expect(subject.withRuntimeClient(work)).resolves.toBe('evidence');
    expect(construct).toHaveBeenCalledTimes(1);
    expect(construct).toHaveBeenCalledWith({
      datasources: {
        db: { url: 'postgresql://runtime.invalid/db?connect_timeout=1&pool_timeout=1' },
      },
    });
    expect(work).toHaveBeenNthCalledWith(1, client);
    expect(work).toHaveBeenNthCalledWith(2, client);
    await subject.onModuleDestroy();
    await subject.onModuleDestroy();
    expect(disconnect).toHaveBeenCalledTimes(1);
    await expect(subject.withRuntimeClient(work)).rejects.toThrow('closed');
    expect(work).toHaveBeenCalledTimes(2);
  });

  it('propagates work failure without retry or switching to the primary connection', async () => {
    const subject = service('shadow', 'postgresql://runtime.invalid/db');
    const failure = new Error('synthetic runtime rejection');
    const work = jest.fn<Promise<string>, [PrismaClient]>().mockRejectedValue(failure);
    await expect(subject.withRuntimeClient(work)).rejects.toBe(failure);
    expect(work).toHaveBeenCalledTimes(1);
    expect(construct).toHaveBeenCalledTimes(1);
    await subject.onModuleDestroy();
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it('bounds only transport waits, retaining independent identity and all other URL options', async () => {
    const url =
      'postgres://runtime.invalid/db?schema=public&sslmode=require&connect_timeout=0&pool_timeout=99';
    const subject = service('shadow', url);
    await subject.withRuntimeClient(() => Promise.resolve('done'));
    expect(construct).toHaveBeenCalledWith({
      datasources: {
        db: {
          url: 'postgres://runtime.invalid/db?schema=public&sslmode=require&connect_timeout=1&pool_timeout=1',
        },
      },
    });
  });

  it.each(['not-a-url', 'https://runtime.invalid/db'])(
    'rejects malformed or non-PostgreSQL input without exposing it or creating a client',
    async (url) => {
      await expect(
        service('shadow', url).withRuntimeClient(() => Promise.resolve('done')),
      ).rejects.toThrow('independent shadow runtime connection is invalid');
      expect(construct).not.toHaveBeenCalled();
    },
  );

  it('does no work or budget inspection in off mode', async () => {
    const budget = new ShadowComparisonBudget(() => 0);
    const inspect = jest.spyOn(budget, 'transactionOptions');
    const work = jest.fn();
    await expect(service('off').withBoundedRuntimeClient(budget, work)).resolves.toBeNull();
    expect(inspect).not.toHaveBeenCalled();
    expect(work).not.toHaveBeenCalled();
    expect(construct).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  });

  it('refuses a connection stage before construction when its reserve is exhausted', async () => {
    let now = 0;
    const budget = new ShadowComparisonBudget(() => now);
    now = 4000;
    const work = jest.fn();
    await expect(
      service('shadow', 'postgresql://runtime.invalid/db').withBoundedRuntimeClient(budget, work),
    ).rejects.toThrow('budget exhausted');
    expect(construct).not.toHaveBeenCalled();
    expect(work).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  });

  it('passes the same client and actual post-connect allowance to the caller owner', async () => {
    let now = 0;
    const budget = new ShadowComparisonBudget(() => now);
    now = 600;
    connect.mockImplementationOnce(() => {
      now = 800;
      return Promise.resolve();
    });
    const work = jest
      .fn<
        Promise<string>,
        [PrismaClient, ReturnType<ShadowComparisonBudget['transactionOptions']>]
      >()
      .mockResolvedValue('done');
    await expect(
      service('shadow', 'postgresql://runtime.invalid/db').withBoundedRuntimeClient(budget, work),
    ).resolves.toBe('done');
    expect(work).toHaveBeenCalledTimes(1);
    expect(work).toHaveBeenCalledWith(client, {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      maxWait: 100,
      timeout: 4100,
    });
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('propagates connection failure without work, retry or primary fallback', async () => {
    const failure = new Error('isolated connection failure');
    connect.mockRejectedValueOnce(failure);
    const work = jest.fn();
    await expect(
      service('shadow', 'postgresql://runtime.invalid/db').withBoundedRuntimeClient(
        new ShadowComparisonBudget(() => 0),
        work,
      ),
    ).rejects.toBe(failure);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(construct).toHaveBeenCalledTimes(1);
    expect(work).not.toHaveBeenCalled();
  });

  it('does not grant a new allowance after connection consumed the deadline', async () => {
    let now = 0;
    const budget = new ShadowComparisonBudget(() => now);
    connect.mockImplementationOnce(() => {
      now = 5000;
      return Promise.resolve();
    });
    const work = jest.fn();
    await expect(
      service('shadow', 'postgresql://runtime.invalid/db').withBoundedRuntimeClient(budget, work),
    ).rejects.toThrow('budget exhausted');
    expect(work).not.toHaveBeenCalled();
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('does not retry, or label an over-budget callback as timely completion', async () => {
    let now = 0;
    const budget = new ShadowComparisonBudget(() => now);
    const work = jest.fn(() => {
      now = 5000;
      return Promise.resolve('committed but late');
    });
    await expect(
      service('shadow', 'postgresql://runtime.invalid/db').withBoundedRuntimeClient(budget, work),
    ).rejects.toThrow('budget exhausted');
    expect(work).toHaveBeenCalledTimes(1);
    expect(construct).toHaveBeenCalledTimes(1);
  });
});
