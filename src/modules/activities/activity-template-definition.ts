import { createHash } from 'node:crypto';

/**
 * Activity OS R1 / A3 模板 Version 定义的 canonical JSON 合同。
 *
 * `definitionJson` 日后会承载强类型蓝图；本文件只规定跨 writer 都必须一致的底层
 * 表示与 hash 口径，不在这里提前定义业务字段。对象 key 按 UTF-16 代码单元排序，数组
 * 保序；数字只允许安全整数，任何小数必须由未来的强类型 definition 用字符串表示，避免
 * 浮点表示差异进入 hash。
 */
export type ActivityTemplateDefinitionJsonValue =
  | string
  | number
  | boolean
  | null
  | readonly ActivityTemplateDefinitionJsonValue[]
  | { readonly [key: string]: ActivityTemplateDefinitionJsonValue };

export type ActivityTemplateDefinitionObject = {
  readonly [key: string]: ActivityTemplateDefinitionJsonValue;
};

export interface ActivityTemplateDefinitionHashInput {
  readonly schemaVersion: number;
  readonly definition: unknown;
}

export interface ActivityTemplateDefinitionFingerprint {
  readonly canonicalText: string;
  readonly definitionHash: string;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

function invalid(path: string, reason: string): never {
  throw new TypeError(`activity template definition: ${path} ${reason}`);
}

function assertSchemaVersion(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    invalid('schemaVersion', 'must be a positive safe integer');
  }
}

function assertNoSymbolKeys(value: object, path: string): void {
  if (Object.getOwnPropertySymbols(value).length > 0) {
    invalid(path, 'must not contain symbol keys');
  }
}

function canonicalizeArray(
  value: readonly unknown[],
  ancestors: Set<object>,
  path: string,
): string {
  if (Object.getPrototypeOf(value) !== Array.prototype) {
    invalid(path, 'must be a plain array');
  }
  assertNoSymbolKeys(value, path);

  const keys = Object.keys(value);
  if (keys.length !== value.length || keys.some((key, index) => key !== String(index))) {
    invalid(path, 'must not be sparse or carry extra enumerable properties');
  }
  const names = Object.getOwnPropertyNames(value);
  if (
    names.length !== value.length + 1 ||
    names.some((name) => name !== 'length' && !keys.includes(name))
  ) {
    invalid(path, 'must not contain non-JSON properties');
  }

  const canonicalItems: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !('value' in descriptor)) {
      invalid(`${path}[${index}]`, 'must be a data property');
    }
    canonicalItems.push(
      canonicalizeJson(descriptor.value as unknown, ancestors, `${path}[${index}]`),
    );
  }
  return `[${canonicalItems.join(',')}]`;
}

function canonicalizeObject(value: object, ancestors: Set<object>, path: string): string {
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null) {
    invalid(path, 'must be a plain JSON object');
  }
  assertNoSymbolKeys(value, path);

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const names = Object.getOwnPropertyNames(record);
  if (names.length !== keys.length) {
    invalid(path, 'must not contain non-enumerable properties');
  }

  return `{${keys
    .map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(record, key);
      if (descriptor === undefined || !('value' in descriptor)) {
        invalid(`${path}.${key}`, 'must be a data property');
      }
      return `${JSON.stringify(key)}:${canonicalizeJson(descriptor.value, ancestors, `${path}.${key}`)}`;
    })
    .join(',')}}`;
}

function canonicalizeJson(value: unknown, ancestors: Set<object>, path: string): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      invalid(path, 'must be a finite safe integer; decimals must be represented as strings');
    }
    return String(value);
  }
  if (typeof value !== 'object') {
    invalid(path, 'must be JSON-compatible');
  }
  if (ancestors.has(value)) {
    invalid(path, 'must not contain a cycle');
  }

  ancestors.add(value);
  try {
    return Array.isArray(value)
      ? canonicalizeArray(value, ancestors, path)
      : canonicalizeObject(value, ancestors, path);
  } finally {
    ancestors.delete(value);
  }
}

function assertDefinitionObject(value: unknown): asserts value is ActivityTemplateDefinitionObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    invalid('definition', 'must be a JSON object');
  }
}

/** 只 canonicalize definition 本体；数组根、Date、undefined、循环引用一律 fail-closed。 */
export function canonicalizeActivityTemplateDefinition(definition: unknown): string {
  assertDefinitionObject(definition);
  return canonicalizeJson(definition, new Set<object>(), 'definition');
}

/**
 * Hash 的唯一输入是 canonical envelope `{ definition, schemaVersion }`。
 * schemaVersion 必须参与 hash：未来 definition 解释变化时，旧版不能被新口径静默重算。
 */
export function buildActivityTemplateDefinitionCanonicalText(
  input: ActivityTemplateDefinitionHashInput,
): string {
  assertSchemaVersion(input.schemaVersion);
  const definition = canonicalizeActivityTemplateDefinition(input.definition);
  return `{"definition":${definition},"schemaVersion":${input.schemaVersion}}`;
}

export function computeActivityTemplateDefinitionHash(
  input: ActivityTemplateDefinitionHashInput,
): string {
  return createHash('sha256')
    .update(buildActivityTemplateDefinitionCanonicalText(input), 'utf8')
    .digest('hex');
}

export function fingerprintActivityTemplateDefinition(
  input: ActivityTemplateDefinitionHashInput,
): ActivityTemplateDefinitionFingerprint {
  const canonicalText = buildActivityTemplateDefinitionCanonicalText(input);
  return {
    canonicalText,
    definitionHash: createHash('sha256').update(canonicalText, 'utf8').digest('hex'),
  };
}

export function isActivityTemplateDefinitionHash(value: unknown): value is string {
  return typeof value === 'string' && SHA256_HEX.test(value);
}

/**
 * DB 只验证 hash 的形状；未来 writer 在入库前必须用这个函数确认 hash 与 definition 一致。
 * A3 没有新增 writer/API，故不能把这项责任伪装成数据库已完成的通用重算能力。
 */
export function matchesActivityTemplateDefinitionHash(
  input: ActivityTemplateDefinitionHashInput,
  definitionHash: unknown,
): boolean {
  return (
    isActivityTemplateDefinitionHash(definitionHash) &&
    computeActivityTemplateDefinitionHash(input) === definitionHash
  );
}
