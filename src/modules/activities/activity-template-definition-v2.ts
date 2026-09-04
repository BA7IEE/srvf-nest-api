/**
 * Activity OS R2 / B3：模板 Definition V2 的唯一解释器。
 *
 * V2 只在 V1 的 activity / sessions 根上增加 registrationForm；绝不放宽 V1 的未知键、
 * 数值或场次校验。Form 采用共享 canonicalizer，从而与 managed writer、发布审核和持久化
 * Field 保持同一个 hash / 题型解释。
 */
import {
  ActivityTemplateDefinitionV1Error,
  parseActivityTemplateDefinitionV1,
  type ActivityTemplateDefinitionV1,
} from './activity-template-definition-v1';
import {
  canonicalizeRegistrationFormDefinition,
  type CanonicalRegistrationFormDefinition,
} from './registration-form-definition';

export interface ActivityTemplateDefinitionV2 extends ActivityTemplateDefinitionV1 {
  /** null = 创建活动时不建自定义报名表；非空永远是完整 governed definition。 */
  readonly registrationForm: CanonicalRegistrationFormDefinition | null;
}

/** Service 将 V1/V2 结构异常统一映射为模板 Version 不可选择，避免泄露解析细节。 */
export class ActivityTemplateDefinitionV2Error extends ActivityTemplateDefinitionV1Error {
  constructor(path: string, reason: string) {
    super(path, reason);
    this.name = 'ActivityTemplateDefinitionV2Error';
  }
}

type JsonRecord = Record<string, unknown>;

function fail(path: string, reason: string): never {
  throw new ActivityTemplateDefinitionV2Error(path, reason);
}

function has(record: JsonRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function object(value: unknown, path: string): JsonRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(path, 'must be an object');
  }
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null) {
    fail(path, 'must be a plain object');
  }
  return value as JsonRecord;
}

function exactKeys(record: JsonRecord, path: string, allowed: readonly string[]): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) fail(`${path}.${key}`, 'is not allowed in definition V2');
  }
}

/**
 * Parse a hashed V2 JSON definition. This deliberately accepts a structurally valid sensitive
 * grammar; materialization and managed writers apply the B3 sensitive-use gate separately.
 */
export function parseActivityTemplateDefinitionV2(value: unknown): ActivityTemplateDefinitionV2 {
  const record = object(value, 'definition');
  exactKeys(record, 'definition', ['activity', 'sessions', 'registrationForm']);
  if (!has(record, 'activity')) fail('definition.activity', 'is required');
  if (!has(record, 'sessions')) fail('definition.sessions', 'is required');
  if (!has(record, 'registrationForm')) fail('definition.registrationForm', 'is required');

  // Reuse V1 as the sole authority for its existing root members. Passing a freshly assembled
  // two-key object means V2 cannot sneak registrationForm into V1's strict whitelist.
  const base = parseActivityTemplateDefinitionV1({
    activity: record.activity,
    sessions: record.sessions,
  });

  if (record.registrationForm === null) return { ...base, registrationForm: null };
  const form = object(record.registrationForm, 'definition.registrationForm');
  exactKeys(form, 'definition.registrationForm', ['fields']);
  if (!has(form, 'fields')) fail('definition.registrationForm.fields', 'is required');
  try {
    const canonical = canonicalizeRegistrationFormDefinition({ fields: form.fields as never });
    if (canonical.mode !== 'governed') {
      fail('definition.registrationForm', 'must use complete governed fields');
    }
    // V2's blueprint never declares answers exportable. Legacy runtime Forms retain their existing
    // exportable semantics; this rule is only for new template definitions.
    if (canonical.definition.fields.some((field) => field.exportable)) {
      fail('definition.registrationForm.fields', 'governed fields must set exportable=false');
    }
    return { ...base, registrationForm: canonical.definition };
  } catch (error) {
    if (error instanceof ActivityTemplateDefinitionV2Error) throw error;
    if (error instanceof Error) {
      fail('definition.registrationForm', 'is not a valid governed registration form');
    }
    throw error;
  }
}
