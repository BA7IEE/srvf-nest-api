import {
  buildActivityTemplateDefinitionCanonicalText,
  canonicalizeActivityTemplateDefinition,
  computeActivityTemplateDefinitionHash,
  fingerprintActivityTemplateDefinition,
  isActivityTemplateDefinitionHash,
  matchesActivityTemplateDefinitionHash,
  type ActivityTemplateDefinitionHashInput,
} from './activity-template-definition';

function input(
  overrides: Partial<ActivityTemplateDefinitionHashInput> = {},
): ActivityTemplateDefinitionHashInput {
  return {
    schemaVersion: 1,
    definition: {
      activity: { title: '值守', limits: { capacity: 20, minimum: 2 } },
      positions: [
        { code: 'lead', labels: ['负责人', '现场'] },
        { code: 'member', labels: ['队员'] },
      ],
    },
    ...overrides,
  };
}

describe('ActivityTemplate definition canonical/hash (Activity OS R1 / A3)', () => {
  it('递归排序对象 key，但数组顺序仍是定义的一部分', () => {
    const first = input({
      definition: { z: { b: 2, a: 1 }, a: ['first', { y: true, x: null }] },
    });
    const sameMeaningDifferentKeyOrder = input({
      definition: { a: ['first', { x: null, y: true }], z: { a: 1, b: 2 } },
    });
    const differentArrayOrder = input({
      definition: { a: [{ x: null, y: true }, 'first'], z: { a: 1, b: 2 } },
    });

    expect(JSON.stringify(first.definition)).not.toBe(
      JSON.stringify(sameMeaningDifferentKeyOrder.definition),
    );
    expect(computeActivityTemplateDefinitionHash(sameMeaningDifferentKeyOrder)).toBe(
      computeActivityTemplateDefinitionHash(first),
    );
    expect(computeActivityTemplateDefinitionHash(differentArrayOrder)).not.toBe(
      computeActivityTemplateDefinitionHash(first),
    );
  });

  it('把 schemaVersion 纳入 canonical envelope 和 hash', () => {
    const v1 = input({ definition: { a: 1 } });
    const v2 = input({ schemaVersion: 2, definition: { a: 1 } });

    expect(buildActivityTemplateDefinitionCanonicalText(v1)).toBe(
      '{"definition":{"a":1},"schemaVersion":1}',
    );
    expect(computeActivityTemplateDefinitionHash(v2)).not.toBe(
      computeActivityTemplateDefinitionHash(v1),
    );
  });

  it('产生小写 64 位 SHA-256，且可用同一口径验证', () => {
    const fixture = input();
    const fingerprint = fingerprintActivityTemplateDefinition(fixture);

    expect(fingerprint.canonicalText).toBe(buildActivityTemplateDefinitionCanonicalText(fixture));
    expect(fingerprint.definitionHash).toMatch(/^[0-9a-f]{64}$/);
    expect(isActivityTemplateDefinitionHash(fingerprint.definitionHash)).toBe(true);
    expect(matchesActivityTemplateDefinitionHash(fixture, fingerprint.definitionHash)).toBe(true);
    expect(
      matchesActivityTemplateDefinitionHash(
        { ...fixture, schemaVersion: 2 },
        fingerprint.definitionHash,
      ),
    ).toBe(false);
    expect(matchesActivityTemplateDefinitionHash(fixture, 'A'.repeat(64))).toBe(false);
    expect(isActivityTemplateDefinitionHash('a'.repeat(63))).toBe(false);
  });

  it('拒绝 schemaVersion 非正安全整数、非对象根和不稳定数字', () => {
    expect(() => buildActivityTemplateDefinitionCanonicalText(input({ schemaVersion: 0 }))).toThrow(
      TypeError,
    );
    expect(() =>
      buildActivityTemplateDefinitionCanonicalText(input({ schemaVersion: 1.5 })),
    ).toThrow(TypeError);
    expect(() => canonicalizeActivityTemplateDefinition(['not-an-object'])).toThrow(TypeError);
    expect(() => canonicalizeActivityTemplateDefinition(null)).toThrow(TypeError);
    expect(() => canonicalizeActivityTemplateDefinition({ decimal: 1.5 })).toThrow(TypeError);
    expect(() =>
      canonicalizeActivityTemplateDefinition({ infinite: Number.POSITIVE_INFINITY }),
    ).toThrow(TypeError);
    expect(() =>
      canonicalizeActivityTemplateDefinition({ unsafe: Number.MAX_SAFE_INTEGER + 1 }),
    ).toThrow(TypeError);
  });

  it('拒绝非 JSON JavaScript 形状，而不是把它们悄悄序列化成另一份定义', () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    const sparse = ['first', 'third'];
    sparse.length = 3;
    const withSymbol = { title: '值守', [Symbol('hidden')]: 'must-fail' };
    const accessor: Record<string, unknown> = {};
    const accessorArray: unknown[] = [];
    Object.defineProperty(accessor, 'computed', { enumerable: true, get: () => 'must-fail' });
    Object.defineProperty(accessorArray, '0', { enumerable: true, get: () => 'must-fail' });

    expect(() => canonicalizeActivityTemplateDefinition({ createdAt: new Date() })).toThrow(
      TypeError,
    );
    expect(() => canonicalizeActivityTemplateDefinition({ missing: undefined })).toThrow(TypeError);
    expect(() => canonicalizeActivityTemplateDefinition({ bigint: 1n })).toThrow(TypeError);
    expect(() => canonicalizeActivityTemplateDefinition(cyclic)).toThrow(TypeError);
    expect(() => canonicalizeActivityTemplateDefinition({ sparse })).toThrow(TypeError);
    expect(() => canonicalizeActivityTemplateDefinition(withSymbol)).toThrow(TypeError);
    expect(() => canonicalizeActivityTemplateDefinition(accessor)).toThrow(TypeError);
    expect(() => canonicalizeActivityTemplateDefinition({ accessorArray })).toThrow(TypeError);
  });
});
