/**
 * contract-semantic-diff.ts — R11 契约语义门(Gate L6 / 架构治理 Phase 5 刀 5-2)
 *
 * 管什么:`docs/handoff/openapi.json` 的 base↔head 语义分类。**破坏性变更不得作为
 * 普通契约刷新静默通过** —— 前端会在运行时才发现,而那时已经上线了。
 *
 * ── 与 R14 同安全原则(v4 勘误㉞),两级结构逐字沿用 ─────────────────────────
 *   第一级(硬闸):breaking 必须在 changelog.d 里有完整申报 → 缺申报即**硬失败**,
 *                 approval job 被跳过 ⇒ 没有可点的按钮,点头也盖不掉;
 *   第二级(人闸):申报齐全后仍需维护者在 harness-review 环境点批。
 * 该结构已由 R14 在 2026-08-13 真触发验证过(PR #990 两推),这里不另设一套。
 *
 * ⚠️ **fragment 是申报载体,不构成批准**(DECISIONS 2026-08-09 第 10 条)。
 * ⚠️ fragment 里的 `rollback` 字段填的是「**真回滚怎么做**」——真正的回滚手段是
 *    revert / feature gate / 兼容层。**changelog 文件本身不是回滚**,本脚本与文档
 *    一律不把 fragment 称作 rollback(v4 勘误㉞ 点名删除的正是那种表述)。
 *
 * ── 双运行时(与 authz-semantic-diff 同款约束,别随手破坏)─────────────────
 * 权威裁判必须 base-trusted,而它跑在 `pull_request_target` 里、禁装依赖 ⇒ 跑不了 tsx。
 * 所以本文件同样是**零依赖 + erasable-syntax-only**:
 *   本地 / 管线 : tsx scripts/contract-semantic-diff.ts …
 *   trusted 裁判: node --experimental-strip-types scripts/contract-semantic-diff.ts …
 * 禁 enum / namespace / 参数属性;不用 __dirname 也不用 import.meta。
 *
 * ── breaking 判定表(成文;方向敏感,别按直觉记)────────────────────────────
 * 「破坏」= **既有调用方按旧契约写的代码会开始出错**。请求侧与响应侧方向相反:
 *
 * | id  | 类别                     | 侧   | 判据                                    |
 * |-----|--------------------------|------|-----------------------------------------|
 * | B1  | endpoint-removed         | —    | operation 消失(含 method 变更)         |
 * | B2  | response-field-removed   | 响应 | 成功响应 schema 里的属性被删            |
 * | B3  | request-required-added   | 请求 | 新增必填属性 / 既有参数由选填变必填      |
 * | B4  | type-narrowed            | 双   | 类型改变(string→integer 等)           |
 * | B5  | request-enum-value-removed | 请求 | 请求枚举删值 —— 老客户端在发的值失效     |
 * | B6  | response-enum-value-added  | 响应 | 响应枚举加值 —— 老客户端的分支没覆盖它   |
 * | B7  | request-nullable-revoked | 请求 | 请求字段 nullable true→false            |
 * | B8  | response-nullable-added  | 响应 | 响应字段 nullable false→true            |
 * | B9  | success-status-changed   | —    | 成功状态码变更(2xx 集合变化)          |
 *
 * ⚠️ B5/B6 与 B7/B8 的方向**故意不对称**。goal 的清单写的是「枚举值删除」与
 *    「nullable 翻转为不可空」—— 那是**请求侧**的形状(B5/B7)。响应侧的等价危害
 *    是反方向(B6/B8):响应枚举**加**值会打爆老客户端的 switch,响应字段**变**可空
 *    会打爆没做 null 判断的老代码。只实现请求侧那两条会漏掉一半破坏面,故两侧都收。
 *
 * additive(新增可选请求字段 / 新增响应字段 / 新增端点 / 请求枚举加值 / 响应枚举删值)
 * = 静默放行,但**恒进 gate 报告**(与 R14 的全量迁移清单同一哲学:看得见)。
 *
 * 用法:
 *   tsx scripts/contract-semantic-diff.ts --base origin/main
 *   node --experimental-strip-types scripts/contract-semantic-diff.ts \
 *        --base-contract <file> --head-contract <file> [--fragment-file <f>]… [--json <out>]
 *
 * 退出码:0 = 无阻断项;1 = 有阻断项(申报缺失/申报落空/契约不可解析)。
 * approvalRequired 与退出码正交 —— 申报齐全时脚本绿,但环境审批仍必须过。
 *
 * ⚠️ 本文件在 harness/redzone.json 的 selfGuard 内(scripts/*-semantic-diff.ts)。
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const CONTRACT = 'docs/handoff/openapi.json';
const FRAGMENT_DIR = 'changelog.d';
const FRAGMENT_MARKER = 'contract-breaking';
const METHODS = ['get', 'post', 'put', 'patch', 'delete'];

export type BreakingId = 'B1' | 'B2' | 'B3' | 'B4' | 'B5' | 'B6' | 'B7' | 'B8' | 'B9';

/** 判定表的机读副本 —— 报告与 selftest 都读它,散文与执行位不分家。 */
export const BREAKING_TABLE: ReadonlyArray<{
  readonly id: BreakingId;
  readonly kind: string;
  readonly side: string;
  readonly rule: string;
}> = [
  { id: 'B1', kind: 'endpoint-removed', side: '—', rule: 'operation 消失(含 method 变更)' },
  { id: 'B2', kind: 'response-field-removed', side: '响应', rule: '成功响应 schema 里的属性被删' },
  { id: 'B3', kind: 'request-required-added', side: '请求', rule: '新增必填属性 / 既有参数由选填变必填' },
  { id: 'B4', kind: 'type-narrowed', side: '双', rule: '类型改变(string→integer 等)' },
  { id: 'B5', kind: 'request-enum-value-removed', side: '请求', rule: '请求枚举删值,老客户端在发的值失效' },
  { id: 'B6', kind: 'response-enum-value-added', side: '响应', rule: '响应枚举加值,老客户端分支未覆盖' },
  { id: 'B7', kind: 'request-nullable-revoked', side: '请求', rule: '请求字段 nullable true→false' },
  { id: 'B8', kind: 'response-nullable-added', side: '响应', rule: '响应字段 nullable false→true' },
  { id: 'B9', kind: 'success-status-changed', side: '—', rule: '成功状态码变更(2xx 集合变化)' },
];

export interface Finding {
  readonly id: BreakingId | 'ADD';
  readonly kind: string;
  readonly operation: string;
  readonly location: string;
  readonly fact: string;
}

interface AnyObject {
  [key: string]: unknown;
}

// ──────────────────────────────────────────────────────────────────────────
// schema 解析($ref + allOf 展开,带环保护)
// ──────────────────────────────────────────────────────────────────────────

/**
 * 把 schema 归一化成「有效形状」:展开 $ref 与 allOf,合并 properties/required。
 *
 * 为什么必须展开:本仓契约大量用 `allOf: [{$ref: PageResultDto}, {…}]` 的分页范式,
 * 不展开的话「响应字段被删」这类判据永远看不见真正的属性集合 —— 那会是一道
 * 看起来在跑、实际上什么都判不出来的门。
 *
 * depth 上限防的是自引用 schema(本仓有嵌套 DTO);超限即停止展开并标记,
 * 由调用方按「无法判定」处理,**不猜**。
 */
export function resolveSchema(
  schema: unknown,
  doc: AnyObject,
  seen: ReadonlySet<string> = new Set(),
  depth = 0,
): AnyObject {
  if (schema === null || typeof schema !== 'object') return {};
  const node = schema as AnyObject;
  if (depth > 12) return { 'x-unresolved': true };

  const ref = node.$ref;
  if (typeof ref === 'string') {
    if (seen.has(ref)) return { 'x-cyclic': true };
    const target = refTarget(ref, doc);
    if (target === null) return { 'x-unresolved': true };
    return resolveSchema(target, doc, new Set([...seen, ref]), depth + 1);
  }

  const allOf = node.allOf;
  if (Array.isArray(allOf)) {
    const merged: AnyObject = { type: 'object', properties: {}, required: [] };
    for (const part of allOf) {
      const piece = resolveSchema(part, doc, seen, depth + 1);
      mergeInto(merged, piece);
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === 'allOf') continue;
      if (key === 'properties' || key === 'required') continue;
      merged[key] = value;
    }
    mergeInto(merged, {
      properties: node.properties ?? {},
      required: node.required ?? [],
    });
    return merged;
  }

  const out: AnyObject = { ...node };
  if (node.properties && typeof node.properties === 'object') {
    const props: AnyObject = {};
    for (const [name, value] of Object.entries(node.properties as AnyObject)) {
      props[name] = resolveSchema(value, doc, seen, depth + 1);
    }
    out.properties = props;
  }
  if (node.items) out.items = resolveSchema(node.items, doc, seen, depth + 1);
  return out;
}

function mergeInto(target: AnyObject, piece: AnyObject): void {
  const props = (piece.properties ?? {}) as AnyObject;
  const targetProps = (target.properties ?? {}) as AnyObject;
  for (const [name, value] of Object.entries(props)) targetProps[name] = value;
  target.properties = targetProps;
  const required = Array.isArray(piece.required) ? (piece.required as string[]) : [];
  const targetRequired = Array.isArray(target.required) ? (target.required as string[]) : [];
  target.required = [...new Set([...targetRequired, ...required])];
  for (const [key, value] of Object.entries(piece)) {
    if (key === 'properties' || key === 'required') continue;
    if (target[key] === undefined) target[key] = value;
  }
}

function refTarget(ref: string, doc: AnyObject): unknown {
  if (!ref.startsWith('#/')) return null;
  let cursor: unknown = doc;
  for (const segment of ref.slice(2).split('/')) {
    if (cursor === null || typeof cursor !== 'object') return null;
    cursor = (cursor as AnyObject)[segment.replace(/~1/g, '/').replace(/~0/g, '~')];
  }
  return cursor ?? null;
}

// ──────────────────────────────────────────────────────────────────────────
// 属性遍历
// ──────────────────────────────────────────────────────────────────────────

interface FlatField {
  readonly type: string;
  readonly nullable: boolean;
  readonly required: boolean;
  readonly enumValues: readonly string[] | null;
}

/** 把 resolve 后的 schema 摊成 `a.b[].c → 形状` 的平表,便于逐字段对比。 */
export function flattenFields(
  schema: AnyObject,
  prefix = '',
  out: Map<string, FlatField> = new Map(),
  depth = 0,
): Map<string, FlatField> {
  if (depth > 8) return out;
  const props = (schema.properties ?? {}) as AnyObject;
  const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
  for (const [name, raw] of Object.entries(props)) {
    const field = (raw ?? {}) as AnyObject;
    const key = prefix === '' ? name : prefix + '.' + name;
    const enumValues = Array.isArray(field.enum) ? (field.enum as unknown[]).map(String) : null;
    out.set(key, {
      type: typeof field.type === 'string' ? field.type : 'unknown',
      nullable: field.nullable === true,
      required: required.has(name),
      enumValues,
    });
    if (field.type === 'array' && field.items && typeof field.items === 'object') {
      flattenFields(field.items as AnyObject, key + '[]', out, depth + 1);
    } else if (field.properties) {
      flattenFields(field, key, out, depth + 1);
    }
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────────
// 契约比较
// ──────────────────────────────────────────────────────────────────────────

interface Operation {
  readonly key: string;
  readonly node: AnyObject;
}

export function operations(doc: AnyObject): Map<string, Operation> {
  const out = new Map<string, Operation>();
  const paths = (doc.paths ?? {}) as AnyObject;
  for (const [route, item] of Object.entries(paths)) {
    if (item === null || typeof item !== 'object') continue;
    for (const [method, node] of Object.entries(item as AnyObject)) {
      if (!METHODS.includes(method)) continue;
      const key = method.toUpperCase() + ' ' + route;
      out.set(key, { key, node: node as AnyObject });
    }
  }
  return out;
}

function successCodes(operation: AnyObject): string[] {
  const responses = (operation.responses ?? {}) as AnyObject;
  return Object.keys(responses)
    .filter((code) => /^2\d\d$/.test(code))
    .sort();
}

function successSchema(operation: AnyObject, doc: AnyObject): AnyObject {
  const responses = (operation.responses ?? {}) as AnyObject;
  for (const code of successCodes(operation)) {
    const response = (responses[code] ?? {}) as AnyObject;
    const content = (response.content ?? {}) as AnyObject;
    const json = (content['application/json'] ?? {}) as AnyObject;
    if (json.schema) return resolveSchema(json.schema, doc);
  }
  return {};
}

function requestSchema(operation: AnyObject, doc: AnyObject): AnyObject {
  const body = (operation.requestBody ?? {}) as AnyObject;
  const content = (body.content ?? {}) as AnyObject;
  const json = (content['application/json'] ?? {}) as AnyObject;
  if (json.schema) return resolveSchema(json.schema, doc);
  return {};
}

/** 参数(query/path/header)单独走一遍 —— 它们不在 requestBody 里,漏掉就少半个请求面。 */
function parameterFields(operation: AnyObject, doc: AnyObject): Map<string, FlatField> {
  const out = new Map<string, FlatField>();
  const params = Array.isArray(operation.parameters) ? (operation.parameters as AnyObject[]) : [];
  for (const param of params) {
    const name = typeof param.name === 'string' ? param.name : '?';
    const schema = resolveSchema(param.schema ?? {}, doc);
    const enumValues = Array.isArray(schema.enum) ? (schema.enum as unknown[]).map(String) : null;
    out.set(String(param.in ?? 'query') + ':' + name, {
      type: typeof schema.type === 'string' ? schema.type : 'unknown',
      nullable: schema.nullable === true,
      required: param.required === true,
      enumValues,
    });
  }
  return out;
}

function compareFieldSets(
  base: Map<string, FlatField>,
  head: Map<string, FlatField>,
  side: 'request' | 'response',
  operationKey: string,
  findings: Finding[],
): void {
  const push = (id: BreakingId | 'ADD', kind: string, field: string, fact: string): void => {
    findings.push({ id, kind, operation: operationKey, location: side + ' ' + field, fact });
  };

  for (const [field, baseField] of base) {
    const headField = head.get(field);
    if (!headField) {
      if (side === 'response') {
        push('B2', 'response-field-removed', field, '响应字段被删除,依赖它的调用方会拿到 undefined');
      }
      continue;
    }
    if (baseField.type !== headField.type && headField.type !== 'unknown' && baseField.type !== 'unknown') {
      push(
        'B4',
        'type-narrowed',
        field,
        '类型由 ' + baseField.type + ' 变为 ' + headField.type,
      );
    }
    if (side === 'request' && !baseField.required && headField.required) {
      push('B3', 'request-required-added', field, '既有请求字段由选填变必填,老调用方不会发它');
    }
    if (side === 'request' && baseField.nullable && !headField.nullable) {
      push('B7', 'request-nullable-revoked', field, '请求字段不再接受 null,老调用方发 null 会被拒');
    }
    if (side === 'response' && !baseField.nullable && headField.nullable) {
      push('B8', 'response-nullable-added', field, '响应字段变为可空,没做 null 判断的老代码会炸');
    }
    if (baseField.enumValues && headField.enumValues) {
      const baseSet = new Set(baseField.enumValues);
      const headSet = new Set(headField.enumValues);
      const removed = baseField.enumValues.filter((v) => !headSet.has(v));
      const added = headField.enumValues.filter((v) => !baseSet.has(v));
      if (side === 'request' && removed.length > 0) {
        push('B5', 'request-enum-value-removed', field, '请求枚举删值 ' + removed.join(',') + ',老调用方在发的值将被拒');
      }
      if (side === 'response' && added.length > 0) {
        push('B6', 'response-enum-value-added', field, '响应枚举加值 ' + added.join(',') + ',老客户端分支未覆盖');
      }
      if (side === 'request' && added.length > 0) {
        push('ADD', 'request-enum-value-added', field, '请求枚举加值 ' + added.join(','));
      }
      if (side === 'response' && removed.length > 0) {
        push('ADD', 'response-enum-value-removed', field, '响应枚举删值 ' + removed.join(','));
      }
    }
  }

  for (const [field, headField] of head) {
    if (base.has(field)) continue;
    if (side === 'request' && headField.required) {
      push('B3', 'request-required-added', field, '新增必填请求字段,老调用方不会发它');
    } else {
      push(
        'ADD',
        side === 'request' ? 'request-optional-field-added' : 'response-field-added',
        field,
        '新增' + (side === 'request' ? '可选请求' : '响应') + '字段',
      );
    }
  }
}

export function diffContracts(base: AnyObject, head: AnyObject): Finding[] {
  const findings: Finding[] = [];
  const baseOps = operations(base);
  const headOps = operations(head);

  for (const [key, baseOp] of baseOps) {
    const headOp = headOps.get(key);
    if (!headOp) {
      findings.push({
        id: 'B1',
        kind: 'endpoint-removed',
        operation: key,
        location: key,
        fact: '端点从契约中消失,调用方会收到 404',
      });
      continue;
    }
    const baseCodes = successCodes(baseOp.node);
    const headCodes = successCodes(headOp.node);
    if (baseCodes.join(',') !== headCodes.join(',')) {
      findings.push({
        id: 'B9',
        kind: 'success-status-changed',
        operation: key,
        location: key,
        fact: '成功状态码由 [' + baseCodes.join(',') + '] 变为 [' + headCodes.join(',') + ']',
      });
    }
    compareFieldSets(
      flattenFields(requestSchema(baseOp.node, base)),
      flattenFields(requestSchema(headOp.node, head)),
      'request',
      key,
      findings,
    );
    compareFieldSets(
      parameterFields(baseOp.node, base),
      parameterFields(headOp.node, head),
      'request',
      key,
      findings,
    );
    compareFieldSets(
      flattenFields(successSchema(baseOp.node, base)),
      flattenFields(successSchema(headOp.node, head)),
      'response',
      key,
      findings,
    );
  }

  for (const [key] of headOps) {
    if (baseOps.has(key)) continue;
    findings.push({
      id: 'ADD',
      kind: 'endpoint-added',
      operation: key,
      location: key,
      fact: '新增端点',
    });
  }
  return findings;
}

// ──────────────────────────────────────────────────────────────────────────
// fragment 申报
// ──────────────────────────────────────────────────────────────────────────

const DECLARATION_KEYS = ['operation', 'reason', 'impact', 'migration', 'rollback'] as const;

export interface Declaration {
  readonly operation: string;
  readonly reason: string;
  readonly impact: string;
  readonly migration: string;
  readonly rollback: string;
  readonly file: string;
  readonly line: number;
}

export interface Problem {
  readonly rule: string;
  readonly layer: string;
  readonly location: string;
  readonly fact: string;
  readonly basis: string;
  readonly remedy: string;
}

/**
 * 解析 changelog.d fragment 里的申报块:
 *
 *   <!-- contract-breaking
 *   operation: DELETE /api/admin/v1/foo
 *   reason: 为什么必须破坏
 *   impact: 影响面(哪些调用方 / 哪些前端页面)
 *   migration: 迁移方式(调用方要改什么)
 *   rollback: **真回滚**怎么做 —— revert / feature gate / 兼容层;本文件不是回滚手段
 *   -->
 */
export function parseDeclarations(
  files: ReadonlyArray<{ readonly path: string; readonly content: string }>,
): { declarations: Declaration[]; problems: Problem[] } {
  const declarations: Declaration[] = [];
  const problems: Problem[] = [];
  for (const file of files) {
    const lines = file.content.split('\n');
    for (let index = 0; index < lines.length; index++) {
      if (lines[index].trim() !== '<!-- ' + FRAGMENT_MARKER) continue;
      const startLine = index + 1;
      const fields = new Map<string, string>();
      let cursor = index + 1;
      let closed = false;
      while (cursor < lines.length) {
        const line = lines[cursor].trim();
        if (line === '-->') {
          closed = true;
          break;
        }
        const separator = line.indexOf(':');
        if (separator > 0) fields.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
        cursor++;
      }
      index = cursor;
      if (!closed) {
        problems.push({
          rule: 'R11',
          layer: 'L6 API Contract',
          location: file.path + ':' + startLine,
          fact: 'contract-breaking 申报块没有 --> 闭合',
          basis: 'R11 申报格式(scripts/contract-semantic-diff.ts 头注)',
          remedy: '补上闭合行 -->',
        });
        continue;
      }
      const missing = DECLARATION_KEYS.filter((key) => !(fields.get(key) ?? '').trim());
      if (missing.length > 0) {
        problems.push({
          rule: 'R11',
          layer: 'L6 API Contract',
          location: file.path + ':' + startLine,
          fact: 'contract-breaking 申报块缺少非空字段: ' + missing.join(', '),
          basis: 'R11 申报字段(为什么破坏 / 迁移方式 / 影响面 / 回滚方式)—— v4 §R11',
          remedy:
            '补齐 operation / reason / impact / migration / rollback 五行。' +
            'rollback 写的是**真回滚手段**(revert / feature gate / 兼容层);' +
            'fragment 本身既不是回滚,也不构成批准(DECISIONS 第 10 条)。',
        });
        continue;
      }
      declarations.push({
        operation: (fields.get('operation') as string).trim(),
        reason: (fields.get('reason') as string).trim(),
        impact: (fields.get('impact') as string).trim(),
        migration: (fields.get('migration') as string).trim(),
        rollback: (fields.get('rollback') as string).trim(),
        file: file.path,
        line: startLine,
      });
    }
  }
  return { declarations, problems };
}

export function judgeDeclarations(
  findings: readonly Finding[],
  declarations: readonly Declaration[],
): Problem[] {
  const problems: Problem[] = [];
  const breaking = findings.filter((finding) => finding.id !== 'ADD');
  const declared = new Set(declarations.map((declaration) => declaration.operation));
  const breakingOps = [...new Set(breaking.map((finding) => finding.operation))];
  for (const operation of breakingOps) {
    if (declared.has(operation)) continue;
    const own = breaking.filter((finding) => finding.operation === operation);
    problems.push({
      rule: 'R11',
      layer: 'L6 API Contract',
      location: operation,
      fact:
        '破坏性契约变更 ' +
        own.length +
        ' 处:' +
        own.map((finding) => '[' + finding.id + '/' + finding.kind + '] ' + finding.location + ' — ' + finding.fact).join(';'),
      basis: CONTRACT + ' 的 base↔head 语义分类;判定表见 scripts/contract-semantic-diff.ts 头注',
      remedy:
        '① 若非本意 —— 改回契约,或用兼容写法(新增可选字段 / 并行新端点)让它变成 additive;' +
        '② 若确需破坏 —— 在 changelog.d/ 的 fragment 里补 contract-breaking 申报块' +
        '(operation/reason/impact/migration/rollback 五行),并由维护者在 harness-review 环境点批。' +
        '申报是记录载体,不构成批准;rollback 填真回滚手段(revert / feature gate / 兼容层),' +
        'changelog 文件本身不是回滚。',
    });
  }
  const breakingSet = new Set(breakingOps);
  for (const declaration of declarations) {
    if (breakingSet.has(declaration.operation)) continue;
    problems.push({
      rule: 'R11',
      layer: 'L6 API Contract',
      location: declaration.file + ':' + declaration.line,
      fact: '申报了 ' + declaration.operation + ' 的破坏性变更,但本次 diff 里该端点没有 breaking',
      basis: CONTRACT + ' 的 base↔head 比对结果',
      remedy:
        '删掉这个申报块,或核对 operation 是否写错(须与契约的 "METHOD /path" 逐字一致)。' +
        '不实的破坏申报会污染审计记录。',
    });
  }
  return problems;
}

// ──────────────────────────────────────────────────────────────────────────
// 渲染 + CLI
// ──────────────────────────────────────────────────────────────────────────

export function renderReport(findings: readonly Finding[], problems: readonly Problem[]): string {
  const lines: string[] = [];
  const breaking = findings.filter((finding) => finding.id !== 'ADD');
  const additive = findings.filter((finding) => finding.id === 'ADD');
  lines.push('[L6/R11] 契约语义 diff —— ' + CONTRACT + ' base ↔ head');
  lines.push('  breaking=' + breaking.length + '  additive=' + additive.length);
  lines.push('');
  if (breaking.length > 0) {
    lines.push('  ── 破坏性变更 ──');
    for (const finding of breaking) {
      lines.push('  · [' + finding.id + '/' + finding.kind + '] ' + finding.operation);
      lines.push('      ' + finding.location + ' — ' + finding.fact);
    }
    lines.push('');
  }
  // additive 静默放行,但恒可见(与 R14 全量迁移清单同一哲学)。
  if (additive.length > 0) {
    lines.push('  ── additive 变更(放行,恒进报告)──');
    for (const finding of additive.slice(0, 60)) {
      lines.push('  · [' + finding.kind + '] ' + finding.operation + '  ' + finding.location);
    }
    if (additive.length > 60) lines.push('  · …另有 ' + (additive.length - 60) + ' 条');
    lines.push('');
  }
  if (findings.length === 0) lines.push('  契约无语义变化。');
  if (problems.length === 0) {
    lines.push('  ✓ 无阻断项。');
  } else {
    lines.push('  ── 阻断项 ' + problems.length + ' 条 ──');
    for (const problem of problems) {
      lines.push('');
      lines.push('[L6/' + problem.rule + '] ' + problem.location);
      lines.push('  事实: ' + problem.fact);
      lines.push('  依据: ' + problem.basis);
      lines.push('  处置: ' + problem.remedy);
    }
  }
  return lines.join('\n');
}

function readFile(file: string): string {
  return fs.readFileSync(file, 'utf8');
}

function git(root: string, args: readonly string[]): string {
  return execFileSync('git', args as string[], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
}

function optionValue(argv: readonly string[], name: string): string | null {
  const index = argv.indexOf(name);
  if (index < 0 || index + 1 >= argv.length) return null;
  return argv[index + 1];
}

function optionValues(argv: readonly string[], name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === name && index + 1 < argv.length) values.push(argv[index + 1]);
  }
  return values;
}

function main(): void {
  const argv = process.argv.slice(2);
  const root = optionValue(argv, '--root') ?? process.cwd();

  let baseDoc: string;
  let headDoc: string;
  let fragmentFiles: Array<{ path: string; content: string }>;

  const explicitBase = optionValue(argv, '--base-contract');
  const explicitHead = optionValue(argv, '--head-contract');
  if (explicitBase && explicitHead) {
    baseDoc = readFile(explicitBase);
    headDoc = readFile(explicitHead);
    fragmentFiles = optionValues(argv, '--fragment-file').map((file) => ({
      path: file,
      content: readFile(file),
    }));
  } else {
    const baseRef = optionValue(argv, '--base') ?? 'origin/main';
    baseDoc = git(root, ['show', baseRef + ':' + CONTRACT]);
    headDoc = readFile(path.join(root, CONTRACT));
    const changed = new Set<string>();
    for (const line of git(root, ['diff', '--name-only', baseRef, '--', FRAGMENT_DIR]).split('\n')) {
      if (line.trim()) changed.add(line.trim());
    }
    for (const line of git(root, ['ls-files', '--others', '--exclude-standard', FRAGMENT_DIR]).split('\n')) {
      if (line.trim()) changed.add(line.trim());
    }
    fragmentFiles = [...changed]
      .filter((file) => file.endsWith('.md') && !file.endsWith('README.md'))
      .filter((file) => fs.existsSync(path.join(root, file)))
      .map((file) => ({ path: file, content: readFile(path.join(root, file)) }));
  }

  const base = JSON.parse(baseDoc) as AnyObject;
  const head = JSON.parse(headDoc) as AnyObject;
  const findings = diffContracts(base, head);
  const parsed = parseDeclarations(fragmentFiles);
  const problems = [...parsed.problems, ...judgeDeclarations(findings, parsed.declarations)];
  const approvalRequired = findings.some((finding) => finding.id !== 'ADD');

  const jsonOut = optionValue(argv, '--json');
  if (jsonOut) {
    fs.writeFileSync(
      jsonOut,
      JSON.stringify(
        {
          rule: 'R11',
          layer: 'L6 API Contract',
          approvalRequired,
          blocking: problems.length > 0,
          breaking: findings.filter((finding) => finding.id !== 'ADD'),
          additive: findings.filter((finding) => finding.id === 'ADD'),
          problems,
        },
        null,
        2,
      ) + '\n',
      'utf8',
    );
  }

  process.stdout.write(renderReport(findings, problems) + '\n');
  if (approvalRequired) {
    process.stdout.write(
      '\n⚠️ 本次含破坏性契约变更 —— 除申报外,还必须由维护者在 harness-review 环境点批。\n' +
        '   权威裁决在 Red-zone (trusted) 工作流(跑 base 版判据),本地/管线只是快速反馈。\n',
    );
  }
  if (problems.length > 0) process.exit(1);
}

const invokedDirectly =
  process.argv[1] !== undefined && /contract-semantic-diff\.ts$/.test(process.argv[1]);
if (invokedDirectly) {
  try {
    main();
  } catch (error) {
    process.stderr.write(
      'contract-semantic-diff failed: ' + (error instanceof Error ? error.message : String(error)) + '\n',
    );
    process.exit(1);
  }
}
