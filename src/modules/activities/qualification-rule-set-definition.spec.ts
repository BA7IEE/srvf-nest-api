import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import {
  canonicalizeQualificationRuleSets,
  qualificationRuleSetsFromStored,
  qualificationRuleStoredValue,
  type QualificationRuleSetsInput,
} from './qualification-rule-set-definition';

function input(overrides: Partial<QualificationRuleSetsInput> = {}): QualificationRuleSetsInput {
  return {
    ruleSets: [
      {
        scope: { sessionId: null, positionId: null },
        rules: [
          {
            ruleTypeCode: 'grade',
            enforcementCode: 'block',
            operator: 'in',
            codes: ['L2', 'L1'],
            sortOrder: 10,
          },
          {
            ruleTypeCode: 'age',
            enforcementCode: 'warn',
            operator: 'between',
            minYears: 18,
            warnScore: 0,
            sortOrder: 20,
          },
        ],
      },
    ],
    ...overrides,
  };
}

function expectBad(value: QualificationRuleSetsInput): void {
  expect(() => canonicalizeQualificationRuleSets(value)).toThrow(BizException);
  try {
    canonicalizeQualificationRuleSets(value);
  } catch (error) {
    expect(error).toEqual(new BizException(BizCode.BAD_REQUEST));
  }
}

describe('canonicalizeQualificationRuleSets', () => {
  it('canonicalizes typed #22 wire, UTF-8 scope order, arrays, and zero-score warnings', () => {
    const result = canonicalizeQualificationRuleSets({
      ruleSets: [
        {
          scope: { sessionId: 'é-session', positionId: 'z-position' },
          rules: [
            {
              ruleTypeCode: 'certificate',
              enforcementCode: 'warn',
              operator: 'has_any',
              standardIds: ['标准-z', '标准-a', '标准-z'],
              warnScore: 0,
              message: '可补交',
              sortOrder: 8,
            },
          ],
        },
        {
          scope: { sessionId: 'a-session', positionId: null },
          rules: [
            {
              ruleTypeCode: 'organization',
              enforcementCode: 'block',
              operator: 'in_subtree',
              organizationIds: ['org-z', 'org-a'],
              sortOrder: 1,
            },
          ],
        },
        input().ruleSets[0]!,
      ],
    });

    expect(result.definition.ruleSets.map((ruleSet) => ruleSet.scope)).toEqual([
      { sessionId: null, positionId: null },
      { sessionId: 'a-session', positionId: null },
      { sessionId: 'é-session', positionId: 'z-position' },
    ]);
    expect(result.definition.ruleSets[0]?.rules).toEqual([
      expect.objectContaining({ codes: ['L1', 'L2'], warnScore: null, message: null }),
      expect.objectContaining({ minYears: 18, maxYears: null, warnScore: 0 }),
    ]);
    expect(result.definition.ruleSets[2]?.rules[0]).toEqual(
      expect.objectContaining({ standardIds: ['标准-a', '标准-z'], warnScore: 0 }),
    );
    expect(result.targetHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.definition.ruleSets.every((ruleSet) => /^[a-f0-9]{64}$/.test(ruleSet.definitionHash))).toBe(
      true,
    );
  });

  it('hashes only canonical semantics while rule sortOrder remains a deliberate semantic choice', () => {
    const first = canonicalizeQualificationRuleSets(input());
    const reordered = canonicalizeQualificationRuleSets({
      ruleSets: [
        {
          ...input().ruleSets[0]!,
          rules: [...input().ruleSets[0]!.rules].reverse(),
        },
      ],
    });
    const changedOrder = canonicalizeQualificationRuleSets({
      ruleSets: [
        {
          ...input().ruleSets[0]!,
          rules: input().ruleSets[0]!.rules.map((rule) =>
            rule.ruleTypeCode === 'grade' ? { ...rule, sortOrder: 11 } : rule,
          ),
        },
      ],
    });

    expect(reordered.targetHash).toBe(first.targetHash);
    expect(changedOrder.targetHash).not.toBe(first.targetHash);
  });

  it('permits an explicit empty replacement yet rejects ambiguous scopes, duplicate sort order, valueJson-shaped drift, and invalid warning scores', () => {
    expect(canonicalizeQualificationRuleSets({ ruleSets: [] }).definition).toEqual({ ruleSets: [] });
    expectBad({
      ruleSets: [input().ruleSets[0]!, input().ruleSets[0]!],
    });
    expectBad({
      ruleSets: [
        {
          ...input().ruleSets[0]!,
          rules: input().ruleSets[0]!.rules.map((rule) => ({ ...rule, sortOrder: 1 })),
        },
      ],
    });
    expectBad({
      ruleSets: [
        {
          scope: { sessionId: null, positionId: null },
          rules: [
            {
              ruleTypeCode: 'insurance',
              enforcementCode: 'warn',
              operator: 'covers_activity',
              warnScore: 101,
              sortOrder: 1,
            },
          ],
        },
      ],
    });
    expectBad({
      ruleSets: [
        {
          scope: { sessionId: null, positionId: null },
          rules: [
            {
              ruleTypeCode: 'age',
              enforcementCode: 'block',
              operator: 'between',
              minYears: 18,
              warnScore: 0,
              sortOrder: 1,
            },
          ],
        },
      ],
    });
    expectBad({
      ruleSets: [
        {
          scope: { sessionId: null, positionId: null },
          rules: [
            {
              ruleTypeCode: 'grade',
              enforcementCode: 'block',
              operator: 'in',
              codes: ['L1'],
              standardIds: ['must-not-fit-grade'],
              sortOrder: 1,
            },
          ],
        },
      ],
    });
  });

  it('round-trips the storage shape without null age keys and fails closed for a malformed frozen row', () => {
    const canonical = canonicalizeQualificationRuleSets(input()).definition.ruleSets[0]!;
    const age = canonical.rules.find((rule) => rule.ruleTypeCode === 'age');
    if (!age) throw new Error('fixture age rule missing');
    expect(qualificationRuleStoredValue(age)).toEqual({ minYears: 18 });

    expect(() =>
      qualificationRuleSetsFromStored([
        {
          sessionId: null,
          positionId: null,
          rules: [
            {
              ruleTypeCode: 'grade',
              enforcementCode: 'block',
              operator: 'in',
              valueJson: { codes: ['L1'] },
              warnScore: 1,
              message: null,
              sortOrder: 1,
            },
          ],
        },
      ]),
    ).toThrow(BizException);
    try {
      qualificationRuleSetsFromStored([
        {
          sessionId: null,
          positionId: null,
          rules: [
            {
              ruleTypeCode: 'grade',
              enforcementCode: 'block',
              operator: 'in',
              valueJson: { codes: ['L1'] },
              warnScore: 1,
              message: null,
              sortOrder: 1,
            },
          ],
        },
      ]);
    } catch (error) {
      expect(error).toEqual(new BizException(BizCode.ACTIVITY_QUALIFICATION_CONFIGURATION_INVALID));
    }
  });
});
