/**
 * check-boundaries.ts - Phase 0 architecture boundary inventory.
 *
 * Report-only scanner with two physically separate entrances:
 *   --metadata validates registry completeness and freshness.
 *   --violations inventories current findings and always stays report-only.
 *
 * Known gaps: Prisma aliases/destructuring/wrappers and variable forwarding;
 * dynamic delegates and computed property access; tsconfig aliases, re-export
 * chains and runtime module loading; dynamic/non-literal SQL (including template
 * interpolations); dynamic select/include/where shapes; and semantic-read intent
 * beyond the explicit time-window + status-predicate heuristic. Each is reported
 * as uncertain rather than treated as safe.
 *
 * Identity recipe:
 * callSiteId = hash(file + symbol + ordinal + normalized call)
 * violationFingerprint = hash(symbol + target + operation)
 * shapeDigest = hash(statically visible object-key shape)
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

const ROOT = path.resolve(__dirname, '..');
const DOMAIN_MAP = 'harness/domain-map.json';
const STATE_MACHINES = 'harness/state-machines.json';
const ARCHITECTURE_DEBT = 'harness/architecture-debt.json';
/**
 * 架构债**身份基线**——v4 §6 元规则「禁新增代码债」的执行位判据。
 *
 * 与 ARCHITECTURE_DEBT 的分工(别搞混,两者都必须存在):
 *   · architecture-debt.json  = **已策展**的债务身份证(带 classification/reason/desiredExit
 *     等 7 个语义字段),回答「这笔债是什么、打算怎么还」。它是人读的。
 *   · 本文件                  = **全部已知违规的身份集合**,回答「这个违规是不是新写的」。
 *     它是机器读的,只有 id,没有语义。
 *
 * 为什么必须分成两份:策展是慢的(229/641 条完成),而止血不能等策展。
 * 若把「必须登记在 architecture-debt.json」当闸,今天就会红 412 条,
 * 于是闸只能继续挂着 `|| true` —— 那正是过去三个月的实际状态。
 */
const ARCHITECTURE_DEBT_BASELINE = 'harness/architecture-debt-baseline.json';
const VERSION = '1.0.0';

/**
 * R15 —— `src/common` 治理(架构治理 v4 终审【七】)。
 *
 * 为什么单开一条扫描通道:`scan()` 的主循环第一步就是 `moduleOf(file)`,而
 * `moduleOf` 只认 `^src/modules/([^/]+)/` —— `src/common/**` 的每个文件在循环
 * 第一行就被 `continue` 掉。于是违规检测、`raw-cross-domain-table`、import 边收集
 * **全都够不到它**。这不是「规则写了但漏判」,是结构性零执法:把业务 helper 搬进
 * `src/common/foo.ts`,R2(依赖边界)与 R5(跨域写)两边就都能合法 import,
 * 边界规则整体被绕开。R15 堵的正是这条所有边界规则的共同逃生通道。
 *
 * 三条判据(恒 report;存量入基线,新增才是将来 blocking 的对象):
 *   ① `common-business-table-access` —— common 出现业务 Prisma 访问。
 *      **delegate ∪ raw 物理表**两种形态都算(维护者 2026-08-15 拍板):
 *      实测 `src/common` 的 delegate 访问 = 0,6 条真实命中**全是 `$queryRaw`
 *      打物理表**,只查 delegate 会造出一个恒绿的空闸。
 *      例外 = `kernel.kernelReadFields` 白名单内的事实读(显式 select 且字段全在
 *      白名单内)→ 记 `common-kernel-fact-read`(allow),不算违规。
 *   ② `common-business-predicate` —— common 内联业务状态 + 时间窗谓词组合,
 *      复用 R6 三档读的语义读识别口径(statusFields ∧ timeWindowFields)。
 *   ③ `common-to-module-import` —— `common → src/modules/**` 入边,结构判据,恒 0。
 *
 * 刻意不并进 `scan()` 的 `findings`:那个数组喂着 `edgeUsage` / `readTiers` /
 * `byKind`,而 `common` 不是 `domains` 里的域 —— 混进去会凭空多出一条
 * undeclared direction,把既有读数搅浑。两个数组、两个报告块,互不干扰。
 */
const COMMON_PREFIX = 'src/common/';
const COMMON_DOMAIN = 'common';

type JsonRecord = Record<string, unknown>;

interface SchemaModel {
  name: string;
  fields: string[];
  scalarFields: string[];
  relationFields: Record<string, string>;
  stateFields: string[];
  statusPredicateFields: string[];
  dateFields: string[];
  tableName: string;
  tableNameSource: '@@map' | 'prisma-model-default';
}

interface Owner {
  domain: string;
  ownerModule?: string;
  subdomain?: string;
  confirmed?: boolean;
}

interface Edge {
  from: string;
  to: string;
  kind?: string;
}

interface GovernanceConfirmation {
  id: string;
  path: string;
  confirmed: boolean;
}

interface ReadAllowlistEntry extends JsonRecord {
  sourceDomain: string;
  sourceModule: string;
  targetDomain: string;
  prismaModel: string;
  operation: string;
  sourceFile: string;
  sourceSymbol: string;
  accessPath: string;
}

interface DomainMap {
  schemaVersion: string;
  generatorVersion: string;
  inputDigest: string;
  domains: JsonRecord;
  moduleOwnership: Record<string, Owner>;
  modelOwnership: Record<string, Owner>;
  allowedEdges: Edge[];
  decisionsPending: string[];
  confirmations: GovernanceConfirmation[];
  kernel: {
    confirmed?: boolean;
    primitives?: JsonRecord[];
    kernelReadFields?: { confirmed?: boolean; fields?: Record<string, string[]> };
    kernelPredicateFields?: { confirmed?: boolean; fields?: Record<string, string[]> };
  };
  crossDomainReadAllowlist: ReadAllowlistEntry[];
}

interface Location {
  file: string;
  line: number;
  symbol: string;
}

interface Finding {
  kind: string;
  disposition: 'report' | 'allow';
  sourceDomain: string;
  targetDomain: string;
  prismaModel: string | null;
  operation: string;
  location: Location;
  callSiteId: string;
  /**
   * The Phase 0 identity for the same call site, retained only so that the
   * one-off `--migrate-ids` pass can map registered debt entries onto their new
   * `callSiteId` without a human re-identifying 201 rows.  It is not written to
   * any generated artifact.
   */
  legacyCallSiteId: string;
  violationFingerprint: string;
  shapeDigest: string;
  details: JsonRecord;
}

/** How a cross-module dependency was written. */
type ImportForm = 'import' | 'export-from' | 'dynamic-import' | 'import-equals';

interface ImportEdge {
  from: string;
  to: string;
  /**
   * Syntactic form. `import` is the only one with live occurrences today; the
   * other three are parsed so that the first one to appear is caught rather
   * than silently dropped (see the coverage assertions in
   * harness-guards.selftest.ts, which pin the current counts at 0).
   */
  form: ImportForm;
  /**
   * `import type` / all-type named bindings — erased at compile time, so the
   * edge does not exist at runtime. Still counted as a dependency edge
   * (maintainer ruling 2026-08-13: 架构治理管的是域知识耦合，且 v4 §4 的
   * platform-access 反向边「恒 0」若静默豁免 type-only 就当场变成假话),
   * but tagged so the exemption remains a one-line configuration change.
   */
  typeOnly: boolean;
  file: string;
  line: number;
  symbol: string;
  text: string;
}

interface EdgeUsage {
  from: string;
  to: string;
  kind?: string;
  importCount: number;
  crossDomainAccessCount: number;
}

/**
 * R10 Phase 4-1b —— 状态机治理的**执行位**(登记表 `harness/state-machines.json`)。
 *
 * 4-1a 的实测统计决定了本刀守什么(报告 §3.1,`docs/ai-harness/STATE_MACHINE_INVENTORY.md`):
 * 闭集已有 34/56 被 DB CHECK 兜住,而**边有 20 条根本没有任何机器可读的声明、18 条连具名
 * 状态机模块都没有**。一致性检查若只比「闭集 vs CHECK」,会对那 20 条**恒真通过 —— 那是空绿**。
 * 所以门槛的核心不是闭集,是**边与实现映射**。
 *
 * 判据形态是**声明闸**,不是正确性证明:它只回答「这条登记敢不敢自称已治理」,
 * 不声称被治理的代码是对的。结构上 fail-closed —— 拿不出证据就不许标 `governed`,
 * 宁可判不了(goal D1 原话)。
 *
 * `governedEvidence` 是**新增的可选字段**,只有 `governanceStatus === 'governed'` 才要求它,
 * 且 `inventory` 条目**禁止**携带(否则会留下半截声明 / 陈旧证据)。因为它对既有 56 条
 * 全是可选的、既有条目一字不改仍然合法,所以**本刀不 bump `VERSION`** ——
 * `VERSION` 同时校验 domain-map 的 generatorVersion(见 runMetadata),bump 它会强迫
 * 另一条 lane 一起重算 domain-map。
 */
type StateLayer = 'L1' | 'L2' | 'L3';

interface StateEdge {
  from: string;
  to: string;
  action?: string;
}

interface GovernedEvidence {
  /**
   * `unconstrained` = L1 配置/标注列:没有流程语义,因此没有边可守,
   * 它的不变量只有「闭集」,而闭集必须由 DB CHECK 兜底(见 l1GovernedErrors)。
   * `enumerated` = L2/L3 流程列:必须逐条列出边,并与具名实现模块对得上。
   */
  edgeModel: 'unconstrained' | 'enumerated';
  implementationFile?: string;
  implementationSymbol?: string;
  edges?: StateEdge[];
  wrongStateBizCodes: string[];
}

interface StateEntry {
  model: string;
  field: string;
  governanceStatus: 'inventory' | 'governed';
  layer: StateLayer;
  stateSet: { values: string[] | null; source: string; sourceRef: string };
  transitions: string | string[];
  wrongStateBizCode: string;
  implementation: string;
  governedBlockers: string[];
  governedEvidence?: GovernedEvidence;
}

interface MigrationCheck {
  migration: string;
  values: string[];
  constraint: string | null;
}

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function exists(rel: string): boolean {
  return fs.existsSync(path.join(ROOT, rel));
}

function hash(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function shortHash(value: string): string {
  return hash(value).slice(0, 24);
}

function fail(message: string): never {
  throw new Error(message);
}

function objectOf(value: unknown, label: string): JsonRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    fail(label + ' must be an object');
  return value as JsonRecord;
}

function stringOf(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) fail(label + ' must be a non-empty string');
  return value;
}

function booleanOf(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') fail(label + ' must be a boolean');
  return value;
}

function stringsOf(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    fail(label + ' must be a string array');
  }
  return value as string[];
}

function listModules(): string[] {
  return fs
    .readdirSync(path.join(ROOT, 'src/modules'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function walk(rel: string, include: (name: string) => boolean): string[] {
  const files: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const child = path.posix.join(dir, entry.name);
      if (entry.isDirectory()) visit(child);
      else if (include(entry.name)) files.push(child);
    }
  };
  visit(rel);
  return files.sort();
}

function stateLikeString(field: string): boolean {
  // profile attributes such as marital/political status are dictionary facts,
  // not lifecycle state-machine columns.
  if (field === 'maritalStatusCode' || field === 'politicalStatusCode') return false;
  return /(status|state|stage|phase|lifecycle|mode)(Code)?$/i.test(field);
}

function schemaModels(): SchemaModel[] {
  const source = read('prisma/schema.prisma');
  const re = /^model\s+([A-Za-z][A-Za-z0-9_]*)\s*\{([\s\S]*?)^\}/gm;
  const raw: Array<{
    name: string;
    fields: Array<{ name: string; type: string }>;
    mappedTable?: string;
  }> = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    const fields: Array<{ name: string; type: string }> = [];
    for (const line of match[2].split('\n')) {
      const field =
        /^\s*([A-Za-z][A-Za-z0-9_]*)\s+([A-Za-z][A-Za-z0-9_]*)(?:\?|\[\])?(?:\s|$)/.exec(line);
      if (field !== null) fields.push({ name: field[1], type: field[2] });
    }
    raw.push({
      name: match[1],
      fields,
      mappedTable: /@@map\(\s*"([^"]+)"\s*\)/.exec(match[2])?.[1],
    });
  }

  const modelNames = new Set(raw.map((model) => model.name));
  return raw
    .map((model) => {
      const relationFields: Record<string, string> = {};
      const scalarFields: string[] = [];
      const stateFields: string[] = [];
      const statusPredicateFields: string[] = [];
      const dateFields: string[] = [];
      const tableNameSource: SchemaModel['tableNameSource'] =
        model.mappedTable === undefined ? 'prisma-model-default' : '@@map';
      for (const field of model.fields) {
        if (modelNames.has(field.type)) {
          relationFields[field.name] = field.type;
          continue;
        }
        scalarFields.push(field.name);
        if (field.type === 'String' && stateLikeString(field.name)) stateFields.push(field.name);
        if (stateLikeString(field.name)) statusPredicateFields.push(field.name);
        if (field.type === 'DateTime') dateFields.push(field.name);
      }
      return {
        name: model.name,
        fields: model.fields.map((field) => field.name).sort(),
        scalarFields: scalarFields.sort(),
        relationFields,
        stateFields: stateFields.sort(),
        statusPredicateFields: statusPredicateFields.sort(),
        dateFields: dateFields.sort(),
        tableName: model.mappedTable ?? model.name,
        tableNameSource,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function listStringStateColumns(): Array<{ model: string; field: string }> {
  const columns: Array<{ model: string; field: string }> = [];
  for (const model of schemaModels()) {
    for (const field of model.stateFields) columns.push({ model: model.name, field });
  }
  return columns;
}

function metadataInputs(): string[] {
  const files = new Set<string>(['prisma/schema.prisma', 'src/app.module.ts']);
  for (const moduleName of listModules()) {
    const root = 'src/modules/' + moduleName;
    const moduleFiles = walk(root, (name) => name.endsWith('.module.ts'));
    for (const file of moduleFiles) files.add(file);
    if (moduleFiles.length === 0 && exists(root + '/README.md')) files.add(root + '/README.md');
  }
  return [...files].sort();
}

export function computeDomainMapInputDigest(): string {
  const entries = metadataInputs().map((file) => file + '\u0000' + hash(read(file)));
  return 'sha256:' + hash(entries.join('\n'));
}

export function computeStateMachinesInputDigest(): string {
  const file = 'prisma/schema.prisma';
  return 'sha256:' + hash(file + '\u0000' + hash(read(file)));
}

function ownerOf(value: unknown, label: string): Owner {
  const record = objectOf(value, label);
  return {
    domain: stringOf(record.domain, label + '.domain'),
    ownerModule: typeof record.ownerModule === 'string' ? record.ownerModule : undefined,
    subdomain: typeof record.subdomain === 'string' ? record.subdomain : undefined,
    confirmed: booleanOf(record.confirmed, label + '.confirmed'),
  };
}

function ownershipMap(value: unknown, label: string): Record<string, Owner> {
  const record = objectOf(value, label);
  const output: Record<string, Owner> = {};
  for (const [name, owner] of Object.entries(record))
    output[name] = ownerOf(owner, label + '.' + name);
  return output;
}

function edgeList(value: unknown): Edge[] {
  if (!Array.isArray(value)) fail('allowedEdges must be an array');
  return value.map((item, index) => {
    const record = objectOf(item, 'allowedEdges[' + index + ']');
    booleanOf(record.confirmed, 'allowedEdges[' + index + '].confirmed');
    return {
      from: stringOf(record.from, 'allowedEdges[' + index + '].from'),
      to: stringOf(record.to, 'allowedEdges[' + index + '].to'),
      kind: typeof record.kind === 'string' ? record.kind : undefined,
    };
  });
}

function readAllowlist(value: unknown): ReadAllowlistEntry[] {
  if (!Array.isArray(value)) fail('crossDomainReadAllowlist must be an array');
  const required = [
    'sourceDomain',
    'sourceModule',
    'targetDomain',
    'prismaModel',
    'operation',
    'sourceFile',
    'sourceSymbol',
    'accessPath',
  ];
  return value.map((item, index) => {
    const label = `crossDomainReadAllowlist[${index}]`;
    const record = objectOf(item, label);
    for (const field of required) stringOf(record[field], `${label}.${field}`);
    return record as ReadAllowlistEntry;
  });
}

function collectGovernanceConfirmations(
  value: unknown,
  path: string,
  output: GovernanceConfirmation[],
): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      collectGovernanceConfirmations(item, `${path}[${index}]`, output),
    );
    return;
  }
  if (value === null || typeof value !== 'object') return;

  const record = value as JsonRecord;
  if (Object.hasOwn(record, 'confirmed')) {
    const id =
      record.decisionId === undefined ? path : stringOf(record.decisionId, `${path}.decisionId`);
    output.push({
      id,
      path,
      confirmed: booleanOf(record.confirmed, `${path}.confirmed`),
    });
  }
  for (const [key, child] of Object.entries(record)) {
    if (key === 'confirmed' || key === 'decisionId') continue;
    collectGovernanceConfirmations(child, path ? `${path}.${key}` : key, output);
  }
}

function kernelFields(
  value: unknown,
  label: string,
): { confirmed?: boolean; fields?: Record<string, string[]> } {
  if (value === undefined) return {};
  const record = objectOf(value, label);
  const fields: Record<string, string[]> = {};
  if (record.fields !== undefined) {
    for (const [model, fieldList] of Object.entries(objectOf(record.fields, label + '.fields'))) {
      fields[model] = stringsOf(fieldList, label + '.fields.' + model);
    }
  }
  return {
    confirmed: booleanOf(record.confirmed, label + '.confirmed'),
    fields,
  };
}

function domainMap(): DomainMap {
  const raw = objectOf(JSON.parse(read(DOMAIN_MAP)) as unknown, DOMAIN_MAP);
  const kernelRaw = objectOf(raw.kernel, 'kernel');
  const primitives = Array.isArray(kernelRaw.primitives)
    ? kernelRaw.primitives.map((item, index) => {
        const primitive = objectOf(item, 'kernel.primitives[' + index + ']');
        booleanOf(primitive.confirmed, 'kernel.primitives[' + index + '].confirmed');
        return primitive;
      })
    : [];
  const domains = objectOf(raw.domains, 'domains');
  for (const [domainName, domain] of Object.entries(domains)) {
    const record = objectOf(domain, 'domains.' + domainName);
    booleanOf(record.confirmed, 'domains.' + domainName + '.confirmed');
    if (record.observedSubdomains === undefined) continue;
    for (const [subdomainName, subdomain] of Object.entries(
      objectOf(record.observedSubdomains, 'domains.' + domainName + '.observedSubdomains'),
    )) {
      const label = 'domains.' + domainName + '.observedSubdomains.' + subdomainName;
      booleanOf(objectOf(subdomain, label).confirmed, label + '.confirmed');
    }
  }
  const publicSurface = objectOf(raw.publicSurface, 'publicSurface');
  booleanOf(publicSurface.confirmed, 'publicSurface.confirmed');
  const confirmations: GovernanceConfirmation[] = [];
  collectGovernanceConfirmations(raw, '', confirmations);
  return {
    schemaVersion: stringOf(raw.schemaVersion, 'schemaVersion'),
    generatorVersion: stringOf(raw.generatorVersion, 'generatorVersion'),
    inputDigest: stringOf(raw.inputDigest, 'inputDigest'),
    domains,
    moduleOwnership: ownershipMap(raw.moduleOwnership, 'moduleOwnership'),
    modelOwnership: ownershipMap(raw.modelOwnership, 'modelOwnership'),
    allowedEdges: edgeList(raw.allowedEdges),
    decisionsPending: stringsOf(raw.decisionsPending, 'decisionsPending'),
    confirmations,
    kernel: {
      confirmed: booleanOf(kernelRaw.confirmed, 'kernel.confirmed'),
      primitives,
      kernelReadFields: kernelFields(kernelRaw.kernelReadFields, 'kernel.kernelReadFields'),
      kernelPredicateFields: kernelFields(
        kernelRaw.kernelPredicateFields,
        'kernel.kernelPredicateFields',
      ),
    },
    crossDomainReadAllowlist: readAllowlist(raw.crossDomainReadAllowlist),
  };
}

function decisionPendingErrors(map: DomainMap): string[] {
  const errors: string[] = [];
  const pending = new Set<string>();
  for (const id of map.decisionsPending) {
    if (pending.has(id)) errors.push('decisionsPending has duplicate decision id: ' + id);
    pending.add(id);
  }

  const byId = new Map<string, GovernanceConfirmation[]>();
  for (const confirmation of map.confirmations) {
    const entries = byId.get(confirmation.id) ?? [];
    entries.push(confirmation);
    byId.set(confirmation.id, entries);
  }
  for (const [id, entries] of byId) {
    const states = new Set(entries.map((entry) => entry.confirmed));
    if (states.size > 1) {
      errors.push(
        'governance decision has mixed confirmed flags: ' +
          id +
          ' (' +
          entries.map((entry) => entry.path).join(', ') +
          ')',
      );
      continue;
    }
    const confirmed = entries[0].confirmed;
    if (confirmed && pending.has(id)) {
      errors.push('decisionsPending lists confirmed governance object: ' + id);
    }
    if (!confirmed && !pending.has(id)) {
      errors.push('confirmed:false governance object missing from decisionsPending: ' + id);
    }
  }
  for (const id of pending) {
    if (!byId.has(id)) errors.push('decisionsPending references unknown governance object: ' + id);
  }
  return errors;
}

// --- R10 4-1b:登记表逐条判据 -------------------------------------------------

/**
 * 迁移语句缓存。**逐语句切分**是刻意的:4-1a 的第一版 CHECK 提取脚本用
 * `ALTER TABLE "X" … [\s\S]*? CHECK (…)` 的惰性通配跨过了 `;`,把后面另一张表的
 * CHECK 认到 `X` 头上(报告 §1.1 缺陷 1)。按 `;` 切开再逐条判目标表,这一整类
 * 跨语句串味在结构上就不可能发生。
 */
let migrationStatementCache: Array<{ migration: string; table: string | null; sql: string }> | null =
  null;

function migrationStatements(): Array<{ migration: string; table: string | null; sql: string }> {
  if (migrationStatementCache !== null) return migrationStatementCache;
  const out: Array<{ migration: string; table: string | null; sql: string }> = [];
  const root = 'prisma/migrations';
  if (!exists(root)) {
    migrationStatementCache = out;
    return out;
  }
  const dirs = fs
    .readdirSync(path.join(ROOT, root), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  for (const dir of dirs) {
    const rel = root + '/' + dir + '/migration.sql';
    if (!exists(rel)) continue;
    const sql = read(rel)
      .replace(/--[^\n]*/g, ' ')
      .replace(/\/\*[\s\S]*?\*\//g, ' ');
    for (const statement of sql.split(';')) {
      const table =
        /\b(?:ALTER|CREATE)\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:ONLY\s+)?(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))/i.exec(
          statement,
        );
      out.push({ migration: dir, table: table?.[1] ?? table?.[2] ?? null, sql: statement });
    }
  }
  migrationStatementCache = out;
  return out;
}

/** `CHECK ( … )` 的括号配平提取 —— 正则数不清嵌套括号。 */
function checkBodies(statement: string): string[] {
  const out: string[] = [];
  const re = /\bCHECK\s*\(/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(statement)) !== null) {
    let depth = 1;
    let cursor = match.index + match[0].length;
    const start = cursor;
    while (cursor < statement.length && depth > 0) {
      if (statement[cursor] === '(') depth += 1;
      else if (statement[cursor] === ')') depth -= 1;
      cursor += 1;
    }
    if (depth === 0) out.push(statement.slice(start, cursor - 1));
  }
  return out;
}

/**
 * 只认**整体**形如 `"col" IN (…)` 或 `"col" IS NULL OR "col" IN (…)` 的 CHECK。
 *
 * 复合 shape 约束里出现的 `IN (…)` 分支**不算闭集**:4-1a 报告 §1.1 缺陷 2 实测过
 * ——`ActivityAllocationBatch` 的 `void_shape_check` 里有一句
 * `"statusCode" IN ('preparing','committed')`,那是「非 voided 分支」的条件,
 * 不是闭集声明;按它读会把 3 值闭集读成 2 值,而且**读数看着完全合理**。
 * 锚 `^…$` 正是把那一整类分支条件挡在门外。
 */
function closedSetFromCheckBody(body: string, column: string): string[] | null {
  const normalized = body.replace(/\s+/g, ' ').trim();
  const inList = "\\(\\s*((?:'[^']*'\\s*,\\s*)*'[^']*')\\s*\\)";
  const col = '"' + column.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"';
  const direct = new RegExp('^' + col + '\\s+IN\\s*' + inList + '$', 'i');
  const nullable = new RegExp(
    '^' + col + '\\s+IS\\s+NULL\\s+OR\\s+' + col + '\\s+IN\\s*' + inList + '$',
    'i',
  );
  const hit = direct.exec(normalized) ?? nullable.exec(normalized);
  if (hit === null) return null;
  return hit[1].split(',').map((value) => value.trim().replace(/^'|'$/g, ''));
}

/**
 * 该表该列的闭集 CHECK 历史。按表名关联而非只按列名 —— `statusCode` / `modeCode`
 * 在几十张表上重名,只按列名找会把别的表的约束认过来。
 */
function closedSetCheckHistory(
  table: string,
  column: string,
): { declarations: MigrationCheck[]; drops: Array<{ migration: string; name: string }> } {
  const declarations: MigrationCheck[] = [];
  const drops: Array<{ migration: string; name: string }> = [];
  for (const statement of migrationStatements()) {
    if (statement.table !== table) continue;
    for (const body of checkBodies(statement.sql)) {
      const values = closedSetFromCheckBody(body, column);
      if (values === null) continue;
      const named = /ADD\s+CONSTRAINT\s+"([^"]+)"/i.exec(statement.sql);
      declarations.push({ migration: statement.migration, values, constraint: named?.[1] ?? null });
    }
    const dropRe = /DROP\s+CONSTRAINT\s+(?:IF\s+EXISTS\s+)?"([^"]+)"/gi;
    let drop: RegExpExecArray | null;
    while ((drop = dropRe.exec(statement.sql)) !== null)
      drops.push({ migration: statement.migration, name: drop[1] });
  }
  return { declarations, drops };
}

let bizCodeCache: Set<string> | null = null;

/** `BizCode` 的成员名全集。走 AST 而不是 grep —— 注释里的码名不是执行位。 */
function bizCodeMembers(): Set<string> {
  if (bizCodeCache !== null) return bizCodeCache;
  const rel = 'src/common/exceptions/biz-code.constant.ts';
  const out = new Set<string>();
  if (!exists(rel)) {
    bizCodeCache = out;
    return out;
  }
  const source = ts.createSourceFile(rel, read(rel), ts.ScriptTarget.Latest, true);
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== 'BizCode') continue;
      let initializer: ts.Expression | undefined = declaration.initializer;
      while (initializer !== undefined && ts.isAsExpression(initializer))
        initializer = initializer.expression;
      if (initializer === undefined || !ts.isObjectLiteralExpression(initializer)) continue;
      for (const property of initializer.properties) {
        const name = property.name;
        if (name === undefined) continue;
        if (ts.isIdentifier(name) || ts.isStringLiteral(name)) out.add(name.text);
      }
    }
  }
  bizCodeCache = out;
  return out;
}

/** 顶层声明的符号名。用于证明 `implementationSymbol` 在那个文件里真的存在。 */
function declaredSymbols(rel: string): Set<string> {
  const out = new Set<string>();
  const source = ts.createSourceFile(rel, read(rel), ts.ScriptTarget.Latest, true);
  const addBinding = (name: ts.BindingName): void => {
    if (ts.isIdentifier(name)) {
      out.add(name.text);
      return;
    }
    for (const element of name.elements)
      if (ts.isBindingElement(element)) addBinding(element.name);
  };
  for (const statement of source.statements) {
    if (
      ts.isClassDeclaration(statement) ||
      ts.isFunctionDeclaration(statement) ||
      ts.isEnumDeclaration(statement) ||
      ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement)
    ) {
      if (statement.name !== undefined) out.add(statement.name.text);
      continue;
    }
    if (ts.isVariableStatement(statement))
      for (const declaration of statement.declarationList.declarations) addBinding(declaration.name);
  }
  return out;
}

/**
 * 文件内的字符串字面量全集。走 AST 是判据的要害:**注释不是执行位** ——
 * 本仓栽过「结构断言 grep 到了自己文件头的散文」的跟头,AST 从源头上排除了它。
 */
function stringLiteralsIn(rel: string): Set<string> {
  const out = new Set<string>();
  const source = ts.createSourceFile(rel, read(rel), ts.ScriptTarget.Latest, true);
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node)) out.add(node.text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

/**
 * L1 配置/标注列的 `governed` 门槛。
 *
 * L1 按定义没有流程、没有边,所以 goal D1 ① 的「实现模块路径可解析」对它**套错了对象**
 * (13 条 L1 里绝大多数的 `implementation` 是散文,因为它的实现就是 CRUD)。
 * 维护者 2026-08-15 拍板改判为:**闭集必须能从 `sourceRef` 指名的那条 migration 的
 * DB CHECK 原样重算出来,且那条 CHECK 是全仓最后一次声明、之后没被 DROP** ——
 * 验证的是「登记声明 = 数据库约束」,正是配置列该守的东西,而且是活体判据:
 * 改 `stateSet.values` 而不改 migration 立刻红。
 */
function l1GovernedErrors(entry: StateEntry, table: string | null, label: string): string[] {
  const errors: string[] = [];
  const evidence = entry.governedEvidence as GovernedEvidence;
  if (entry.transitions !== 'unconstrained')
    errors.push(label + ': L1 governed requires transitions "unconstrained"');
  if (evidence.edgeModel !== 'unconstrained')
    errors.push(label + ': L1 governed requires governedEvidence.edgeModel "unconstrained"');
  if (evidence.edges !== undefined)
    errors.push(label + ': L1 governed must not declare governedEvidence.edges');
  if (evidence.implementationFile !== undefined || evidence.implementationSymbol !== undefined) {
    errors.push(
      label + ': L1 governed must not declare an implementation module (config columns have none)',
    );
  }
  if (entry.wrongStateBizCode !== 'none' || evidence.wrongStateBizCodes.length > 0) {
    errors.push(
      label + ': L1 governed requires wrongStateBizCode "none" and empty wrongStateBizCodes',
    );
  }
  if (entry.stateSet.source !== 'db-check')
    errors.push(label + ': L1 governed requires stateSet.source "db-check"');
  const declared = entry.stateSet.values;
  if (declared === null) return errors;
  if (table === null) {
    errors.push(label + ': model is not present in prisma/schema.prisma, cannot resolve its table');
    return errors;
  }
  const history = closedSetCheckHistory(table, entry.field);
  const inForce = history.declarations[history.declarations.length - 1];
  if (inForce === undefined) {
    errors.push(
      label + ': no closed-set CHECK found for table "' + table + '" column "' + entry.field + '"',
    );
    return errors;
  }
  const want = [...declared].sort().join(',');
  const got = [...inForce.values].sort().join(',');
  if (want !== got) {
    errors.push(
      label +
        ': closed-set CHECK in force (' +
        inForce.migration +
        ') declares [' +
        got +
        '] but registry declares [' +
        want +
        ']',
    );
  }
  if (path.posix.basename(entry.stateSet.sourceRef) !== inForce.migration) {
    errors.push(
      label +
        ': stateSet.sourceRef must name the migration holding the CHECK in force (' +
        inForce.migration +
        ')',
    );
  }
  const droppedLater = history.drops.filter(
    (drop) => drop.name === inForce.constraint && drop.migration > inForce.migration,
  );
  for (const drop of droppedLater) {
    errors.push(
      label +
        ': closed-set CHECK "' +
        String(inForce.constraint) +
        '" was dropped by a later migration (' +
        drop.migration +
        ')',
    );
  }
  return errors;
}

/**
 * L2 / L3 流程列的 `governed` 门槛 —— **本刀的主判据**。
 *
 * 三条缺一不可(goal D1):①具名实现模块存在且符号真在里面 ②合法迁移边逐条机器可读
 * ③非法迁移有专属 BizCode。②的「防登记表写了、代码里没有」是双向的:
 *   正向 —— 每个边端点 / 动作都必须在那个实现文件里作为**字符串字面量**出现;
 *   反向 —— 该实现文件里出现的、属于本列闭集的字面量,必须被某条边覆盖。
 * 只做正向会漏掉「登记表只列了一半的边」,只做反向会漏掉「登记表凭空造边」。
 */
function flowGovernedErrors(entry: StateEntry, label: string): string[] {
  const errors: string[] = [];
  const evidence = entry.governedEvidence as GovernedEvidence;
  if (evidence.edgeModel !== 'enumerated') {
    errors.push(label + ': ' + entry.layer + ' governed requires governedEvidence.edgeModel "enumerated"');
    return errors;
  }
  const file = evidence.implementationFile;
  if (
    file === undefined ||
    !file.startsWith('src/') ||
    !file.endsWith('.ts') ||
    !exists(file) ||
    !fs.statSync(path.join(ROOT, file)).isFile()
  ) {
    errors.push(
      label +
        ': governedEvidence.implementationFile must be an existing src/**.ts file (got ' +
        String(file) +
        ')',
    );
    return errors;
  }
  const symbol = evidence.implementationSymbol;
  if (symbol === undefined || !declaredSymbols(file).has(symbol)) {
    errors.push(
      label +
        ': governedEvidence.implementationSymbol ' +
        JSON.stringify(symbol ?? null) +
        ' is not declared in ' +
        file,
    );
  }
  const edges = evidence.edges;
  if (edges === undefined || edges.length === 0) {
    errors.push(label + ': governedEvidence.edges must be a non-empty array for ' + entry.layer);
    return errors;
  }
  const values = new Set(entry.stateSet.values ?? []);
  const literals = stringLiteralsIn(file);
  const touched = new Set<string>();
  for (const edge of edges) {
    for (const endpoint of [edge.from, edge.to]) {
      touched.add(endpoint);
      if (!values.has(endpoint))
        errors.push(label + ': edge endpoint "' + endpoint + '" is not in stateSet.values');
      else if (!literals.has(endpoint)) {
        errors.push(
          label +
            ': edge endpoint "' +
            endpoint +
            '" never appears as a string literal in ' +
            file +
            ' (registry declares an edge the named module does not mention)',
        );
      }
    }
    if (edge.action !== undefined && !literals.has(edge.action)) {
      errors.push(
        label + ': edge action "' + edge.action + '" never appears as a string literal in ' + file,
      );
    }
  }
  for (const value of [...values].sort()) {
    if (literals.has(value) && !touched.has(value)) {
      errors.push(
        label +
          ': state "' +
          value +
          '" appears in ' +
          file +
          ' but no declared edge touches it (edge list is incomplete)',
      );
    }
  }
  if (evidence.wrongStateBizCodes.length === 0) {
    errors.push(label + ': ' + entry.layer + ' governed requires a non-empty wrongStateBizCodes');
  }
  const known = bizCodeMembers();
  for (const code of evidence.wrongStateBizCodes) {
    if (!known.has(code)) errors.push(label + ': wrongStateBizCodes contains unknown BizCode "' + code + '"');
  }
  return errors;
}

/**
 * 逐条形状校验 —— A 类(登记完整性)。返回 null 表示形状本身就不成立,
 * 后续的 `governed` 判据无从谈起(fail-closed:形状坏了不等于通过)。
 */
function parseStateEntry(raw: JsonRecord, label: string, errors: string[]): StateEntry | null {
  const before = errors.length;
  const model = typeof raw.model === 'string' ? raw.model : '';
  const field = typeof raw.field === 'string' ? raw.field : '';
  if (model === '' || field === '') {
    errors.push(label + ': model and field must be non-empty strings');
    return null;
  }
  const status = raw.governanceStatus;
  if (status !== 'inventory' && status !== 'governed')
    errors.push(label + ': governanceStatus must be "inventory" or "governed"');
  const layer = raw.layer;
  if (layer !== 'L1' && layer !== 'L2' && layer !== 'L3')
    errors.push(label + ': layer must be one of L1 / L2 / L3');
  const stateSet = raw.stateSet;
  let values: string[] | null = null;
  if (stateSet === null || typeof stateSet !== 'object' || Array.isArray(stateSet)) {
    errors.push(label + ': stateSet must be an object');
  } else {
    const record = stateSet as JsonRecord;
    // `values: null` 是 4-1a 刻意的「没有已声明闭集」标记(5 条 closed-set-undeclared),
    // 不是缺字段 —— 但它结构上永远升不了 governed。
    if (record.values === null) values = null;
    else if (Array.isArray(record.values) && record.values.every((item) => typeof item === 'string'))
      values = record.values as string[];
    else errors.push(label + ': stateSet.values must be a string array or null');
    if (typeof record.source !== 'string' || record.source.length === 0)
      errors.push(label + ': stateSet.source must be a non-empty string');
    if (typeof record.sourceRef !== 'string' || record.sourceRef.length === 0)
      errors.push(label + ': stateSet.sourceRef must be a non-empty string');
  }
  const transitions = raw.transitions;
  const transitionsOk =
    transitions === 'unconstrained' ||
    transitions === 'not-derived' ||
    (Array.isArray(transitions) &&
      transitions.length > 0 &&
      transitions.every((item) => typeof item === 'string' && item.length > 0));
  if (!transitionsOk)
    errors.push(
      label + ': transitions must be "unconstrained", "not-derived", or a non-empty string array',
    );
  if (typeof raw.wrongStateBizCode !== 'string' || raw.wrongStateBizCode.length === 0)
    errors.push(label + ': wrongStateBizCode must be a non-empty string');
  if (typeof raw.implementation !== 'string' || raw.implementation.length === 0)
    errors.push(label + ': implementation must be a non-empty string');
  if (typeof raw.notes !== 'string' || raw.notes.length === 0)
    errors.push(label + ': notes must be a non-empty string');
  const blockers = raw.governedBlockers;
  if (!Array.isArray(blockers) || blockers.some((item) => typeof item !== 'string'))
    errors.push(label + ': governedBlockers must be a string array');
  let evidence: GovernedEvidence | undefined;
  if (raw.governedEvidence !== undefined) {
    const record = raw.governedEvidence;
    if (record === null || typeof record !== 'object' || Array.isArray(record)) {
      errors.push(label + ': governedEvidence must be an object');
    } else {
      const item = record as JsonRecord;
      const edgeModel = item.edgeModel;
      if (edgeModel !== 'unconstrained' && edgeModel !== 'enumerated')
        errors.push(label + ': governedEvidence.edgeModel must be "unconstrained" or "enumerated"');
      let edges: StateEdge[] | undefined;
      if (item.edges !== undefined) {
        if (
          !Array.isArray(item.edges) ||
          item.edges.some(
            (edge) =>
              edge === null ||
              typeof edge !== 'object' ||
              Array.isArray(edge) ||
              typeof (edge as JsonRecord).from !== 'string' ||
              typeof (edge as JsonRecord).to !== 'string' ||
              ((edge as JsonRecord).action !== undefined &&
                typeof (edge as JsonRecord).action !== 'string'),
          )
        ) {
          errors.push(label + ': governedEvidence.edges must be an array of {from,to,action?}');
        } else edges = item.edges as unknown as StateEdge[];
      }
      const codes = item.wrongStateBizCodes;
      if (!Array.isArray(codes) || codes.some((code) => typeof code !== 'string'))
        errors.push(label + ': governedEvidence.wrongStateBizCodes must be a string array');
      if (errors.length === before) {
        evidence = {
          edgeModel: edgeModel as GovernedEvidence['edgeModel'],
          implementationFile:
            typeof item.implementationFile === 'string' ? item.implementationFile : undefined,
          implementationSymbol:
            typeof item.implementationSymbol === 'string' ? item.implementationSymbol : undefined,
          edges,
          wrongStateBizCodes: codes as string[],
        };
      }
    }
  }
  if (errors.length !== before) return null;
  return {
    model,
    field,
    governanceStatus: status as StateEntry['governanceStatus'],
    layer: layer as StateLayer,
    stateSet: {
      values,
      source: String((stateSet as JsonRecord).source),
      sourceRef: String((stateSet as JsonRecord).sourceRef),
    },
    transitions: transitions as string | string[],
    wrongStateBizCode: String(raw.wrongStateBizCode),
    implementation: String(raw.implementation),
    governedBlockers: blockers as string[],
    governedEvidence: evidence,
  };
}

/** 已登记条目的 `governed` 声明闸。`inventory` 条目在这里恒零成本。 */
function governedGateErrors(entry: StateEntry, table: string | null): string[] {
  const label = 'state entry ' + entry.model + '.' + entry.field;
  if (entry.governanceStatus === 'inventory') {
    // 陈旧证据比没有证据更危险:它会让下一个人以为门槛已经过了。
    return entry.governedEvidence === undefined
      ? []
      : [label + ': inventory entries must not carry governedEvidence'];
  }
  const errors: string[] = [];
  if (entry.governedBlockers.length > 0) {
    errors.push(
      label + ': governed requires empty governedBlockers (got ' + entry.governedBlockers.join(', ') + ')',
    );
  }
  if (entry.stateSet.values === null)
    errors.push(label + ': governed requires a declared closed set (stateSet.values is null)');
  if (entry.governedEvidence === undefined) {
    errors.push(label + ': governed requires governedEvidence');
    return errors;
  }
  errors.push(
    ...(entry.layer === 'L1'
      ? l1GovernedErrors(entry, table, label)
      : flowGovernedErrors(entry, label)),
  );
  return errors;
}

function stateRegistryErrors(errors: string[]): void {
  if (!exists(STATE_MACHINES)) return;
  let raw: JsonRecord;
  try {
    raw = objectOf(JSON.parse(read(STATE_MACHINES)) as unknown, STATE_MACHINES);
  } catch (error) {
    // 解析不了 = 判不了 ⇒ fail-closed。转成 error 而不是让它抛穿 runMetadata,
    // 这样退出码仍是 1,但消息是可读、可断言的一行。
    errors.push(STATE_MACHINES + ' is unreadable: ' + (error instanceof Error ? error.message : String(error)));
    return;
  }
  if (raw.schemaVersion !== VERSION)
    errors.push(STATE_MACHINES + '.schemaVersion must equal ' + VERSION);
  if (raw.generatorVersion !== VERSION)
    errors.push(STATE_MACHINES + '.generatorVersion must equal ' + VERSION);
  if (raw.inputDigest !== computeStateMachinesInputDigest()) {
    errors.push(
      STATE_MACHINES + '.inputDigest stale: expected ' + computeStateMachinesInputDigest(),
    );
  }
  if (!Array.isArray(raw.entries)) {
    errors.push(STATE_MACHINES + '.entries must be an array');
    return;
  }
  const tables = new Map(schemaModels().map((model) => [model.name, model.tableName]));
  const actual: string[] = [];
  for (const [index, item] of raw.entries.entries()) {
    const label = STATE_MACHINES + '.entries[' + index + ']';
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      errors.push(label + ' must be an object');
      continue;
    }
    const entry = parseStateEntry(item as JsonRecord, label, errors);
    if (entry === null) continue;
    actual.push(entry.model + '.' + entry.field);
    errors.push(...governedGateErrors(entry, tables.get(entry.model) ?? null));
  }
  const expected = listStringStateColumns()
    .map((item) => item.model + '.' + item.field)
    .sort();
  actual.sort();
  if (actual.join('\n') !== expected.join('\n')) {
    errors.push(
      STATE_MACHINES + ' coverage mismatch: expected ' + expected.length + ', got ' + actual.length,
    );
  }
}

/**
 * B 类(存量一致性 / 升格候选)—— **恒 report**,挂在 `--violations` 的 `|| true` 出口上。
 *
 * `closedSetOnlyWouldPass` vs `edgesMachineReadable` 这一对读数是本刀的核心自证:
 * 若判据只比「闭集 vs CHECK」,前者那一堆条目会全部恒真通过,而后者才是真实的边覆盖面。
 * 两个数的差就是 4-1a §3.1 说的**空绿面**。
 */
function stateGovernanceReport(): JsonRecord {
  if (!exists(STATE_MACHINES)) return { present: false };
  const raw = JSON.parse(read(STATE_MACHINES)) as { entries?: JsonRecord[] };
  const entries = raw.entries ?? [];
  const byStatus: Record<string, number> = {};
  const byLayer: Record<string, number> = {};
  const blockerHistogram: Record<string, number> = {};
  let closedSetDeclared = 0;
  let edgesMachineReadable = 0;
  let edgesNotDerived = 0;
  let edgesUnconstrained = 0;
  const governed: string[] = [];
  const upgradeCandidates: string[] = [];
  for (const entry of entries) {
    const id = String(entry.model) + '.' + String(entry.field);
    const status = String(entry.governanceStatus);
    byStatus[status] = (byStatus[status] ?? 0) + 1;
    byLayer[String(entry.layer)] = (byLayer[String(entry.layer)] ?? 0) + 1;
    const blockers = Array.isArray(entry.governedBlockers) ? (entry.governedBlockers as string[]) : [];
    for (const blocker of blockers)
      blockerHistogram[blocker] = (blockerHistogram[blocker] ?? 0) + 1;
    const stateSet = entry.stateSet as JsonRecord | undefined;
    if (Array.isArray(stateSet?.values)) closedSetDeclared += 1;
    if (Array.isArray(entry.transitions)) edgesMachineReadable += 1;
    else if (entry.transitions === 'not-derived') edgesNotDerived += 1;
    else if (entry.transitions === 'unconstrained') edgesUnconstrained += 1;
    if (status === 'governed') governed.push(id);
    else if (blockers.length === 0) upgradeCandidates.push(id);
  }
  return {
    present: true,
    enforcement: 'report-only',
    total: entries.length,
    byStatus,
    byLayer,
    governed,
    // 零 blocker 但仍是 inventory 的条目:它们**够得着**门槛,但升格仍要补
    // governedEvidence(声明闸不会替人声明)。
    upgradeCandidates,
    edgeCoverage: {
      closedSetOnlyWouldPass: closedSetDeclared,
      edgesMachineReadable,
      edgesNotDerived,
      edgesUnconstrained,
      // 「只比闭集」的空绿面 = 有闭集可比、但边根本没有机器可读声明的条目数。
      vacuousGreenIfClosedSetOnly: entries.filter(
        (entry) =>
          Array.isArray((entry.stateSet as JsonRecord | undefined)?.values) &&
          entry.transitions === 'not-derived',
      ).length,
    },
    blockerHistogram,
  };
}

function runMetadata(): void {
  const errors: string[] = [];
  const modules = listModules();
  const models = schemaModels();
  let map: DomainMap | undefined;
  try {
    map = domainMap();
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  if (map !== undefined) {
    if (map.schemaVersion !== VERSION) errors.push('schemaVersion must equal ' + VERSION);
    if (map.generatorVersion !== VERSION) errors.push('generatorVersion must equal ' + VERSION);
    const expectedDigest = computeDomainMapInputDigest();
    if (map.inputDigest !== expectedDigest)
      errors.push('inputDigest stale: expected ' + expectedDigest);
    const domains = new Set(Object.keys(map.domains));
    for (const moduleName of modules) {
      const owner = map.moduleOwnership[moduleName];
      if (owner === undefined) errors.push('missing module owner: ' + moduleName);
      else if (!domains.has(owner.domain))
        errors.push('module ' + moduleName + ' has unknown domain ' + owner.domain);
    }
    for (const moduleName of Object.keys(map.moduleOwnership)) {
      if (!modules.includes(moduleName)) errors.push('stale module owner: ' + moduleName);
    }
    for (const model of models) {
      const owner = map.modelOwnership[model.name];
      if (owner === undefined) errors.push('missing model owner: ' + model.name);
      else if (!domains.has(owner.domain))
        errors.push('model ' + model.name + ' has unknown domain ' + owner.domain);
      else if (owner.ownerModule === undefined)
        errors.push('model ' + model.name + ' has no ownerModule');
      else {
        const moduleOwner = map.moduleOwnership[owner.ownerModule];
        if (moduleOwner === undefined)
          errors.push('model ' + model.name + ' has unknown ownerModule ' + owner.ownerModule);
        else if (moduleOwner.domain !== owner.domain) {
          errors.push('model ' + model.name + ' ownerModule domain differs: ' + owner.ownerModule);
        }
      }
    }
    for (const modelName of Object.keys(map.modelOwnership)) {
      if (!models.some((model) => model.name === modelName))
        errors.push('stale model owner: ' + modelName);
    }
    // 集合相等,不比个数 —— 散文里写死「恰 N 个」会随登记表增长而变成假话,
    // 而且失败时说不出**是哪一条**多了或少了。R15 加入 member-advisory-lock 时
    // 这里从 4 条变 5 条:共享业务内核必须显式登记 owner,不能靠搬进 src/common
    // 免除归属(架构治理 v4 终审【七】)。
    const expectedPrimitives = [
      'app-identity.resolver',
      'member-advisory-lock',
      'member-lifecycle-lock',
      'membership-term-state-machine',
      'wecom-identity-revoke',
    ];
    const primitiveNames = map.kernel.primitives?.map((item) => String(item.name ?? '')) ?? [];
    const missingPrimitives = expectedPrimitives.filter((name) => !primitiveNames.includes(name));
    const unexpectedPrimitives = primitiveNames.filter(
      (name) => !expectedPrimitives.includes(name),
    );
    if (missingPrimitives.length > 0 || unexpectedPrimitives.length > 0) {
      errors.push(
        'kernel.primitives set mismatch' +
          (missingPrimitives.length > 0 ? '; missing: ' + missingPrimitives.join(', ') : '') +
          (unexpectedPrimitives.length > 0
            ? '; unexpected: ' + unexpectedPrimitives.join(', ')
            : ''),
      );
    }
    errors.push(...decisionPendingErrors(map));
    if (map.kernel.kernelReadFields === undefined)
      errors.push('kernelReadFields governance object is missing');
    if (map.kernel.kernelPredicateFields === undefined)
      errors.push('kernelPredicateFields governance object is missing');
    for (const [modelName, fields] of Object.entries(map.kernel.kernelReadFields?.fields ?? {})) {
      const model = models.find((item) => item.name === modelName);
      if (model === undefined) {
        errors.push('kernelReadFields model missing: ' + modelName);
      } else {
        for (const field of fields) {
          if (!model.fields.includes(field))
            errors.push('kernelReadFields field missing: ' + modelName + '.' + field);
        }
      }
    }
    for (const [modelName, fields] of Object.entries(
      map.kernel.kernelPredicateFields?.fields ?? {},
    )) {
      const readable = map.kernel.kernelReadFields?.fields?.[modelName] ?? [];
      for (const field of fields) {
        if (!readable.includes(field))
          errors.push('kernelPredicateFields must be subset: ' + modelName + '.' + field);
      }
    }
  }
  stateRegistryErrors(errors);
  process.stdout.write(
    JSON.stringify(
      {
        mode: 'metadata',
        ok: errors.length === 0,
        generatorVersion: VERSION,
        inputFiles: metadataInputs(),
        actual: {
          modules: modules.length,
          models: models.length,
          stringStateColumns: listStringStateColumns().length,
        },
        errors,
      },
      null,
      2,
    ) + '\n',
  );
  if (errors.length > 0) process.exit(1);
}

function moduleOf(rel: string): string | null {
  const match = /^src\/modules\/([^/]+)\//.exec(rel);
  return match?.[1] ?? null;
}

function moduleForImport(sourceRel: string, specifier: string): string | null {
  const direct = /(?:^|\/)src\/modules\/([^/]+)(?:\/|$)/.exec(specifier);
  if (direct !== null) return direct[1];
  if (!specifier.startsWith('.')) return null;
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(sourceRel), specifier));
  return moduleOf(resolved + '/index.ts');
}

function lineOf(node: ts.Node, source: ts.SourceFile): number {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

function normalized(node: ts.Node, source: ts.SourceFile): string {
  return node.getText(source).replace(/\s+/g, ' ').trim();
}

function symbolOf(node: ts.Node): string {
  let cursor: ts.Node | undefined = node;
  let method = '<module>';
  let className = '';
  while (cursor !== undefined) {
    if (ts.isMethodDeclaration(cursor) && cursor.name !== undefined) method = cursor.name.getText();
    if (ts.isFunctionDeclaration(cursor) && cursor.name !== undefined) method = cursor.name.text;
    if (ts.isClassDeclaration(cursor) && cursor.name !== undefined) {
      className = cursor.name.text;
      break;
    }
    cursor = cursor.parent;
  }
  return className.length > 0 ? className + '.' + method : method;
}

function propertyOf(expression: ts.Expression): string | null {
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  if (
    ts.isElementAccessExpression(expression) &&
    ts.isStringLiteral(expression.argumentExpression)
  ) {
    return expression.argumentExpression.text;
  }
  return null;
}

function rootOf(expression: ts.Expression): string {
  let cursor: ts.Expression = expression;
  while (ts.isPropertyAccessExpression(cursor) || ts.isElementAccessExpression(cursor))
    cursor = cursor.expression;
  return cursor.getText().replace(/\s+/g, '');
}

// ─── typed AST layer (Phase 3 前置 · v4 EC-COMMON 第 3/4 条) ────────────────
//
// Phase 0 identified Prisma access by the *name* of the receiver ("is this
// variable called prisma/tx/client/db?").  That heuristic is defeated by any
// rename, and it cannot see a delegate reached through destructuring, an
// aliased import, a re-export or a forwarding variable.  The blocking version
// must decide by *type*, so both predicates below resolve through the checker
// and never look at an identifier's spelling.
//
// Detection anchor = the delegate type.  Prisma generates one `<Model>Delegate`
// interface per model, so `x.member` is a Member delegate access no matter what
// `x` is named, how it was obtained, or whether `x`'s own type is PrismaService,
// Prisma.TransactionClient, or a narrow hand-written port such as
// `interface OutboxClient { outboxIntent: Prisma.OutboxIntentDelegate }`.
// Anchoring on the delegate rather than on the receiver is what makes all four
// registered bypass classes structurally unreachable in one move.

interface TypedProgram {
  checker: ts.TypeChecker;
  sourceOf(rel: string): ts.SourceFile | undefined;
}

function buildTypedProgram(): TypedProgram {
  // Scope is the repository tsconfig verbatim (include src/**/*.ts, exclude
  // *.spec.ts) — the same closure R5/R6 are defined over by 终审【十二】.
  // Re-deriving a second glob here would be a second source of truth.
  const configPath = path.join(ROOT, 'tsconfig.json');
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error !== undefined) fail('tsconfig.json 解析失败,无法建立 typed program。');
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, ROOT);
  const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
  const checker = program.getTypeChecker();
  return {
    checker,
    sourceOf: (rel) => program.getSourceFile(path.join(ROOT, rel)),
  };
}

/** True when a symbol is declared by the generated Prisma client, not by src. */
function declaredByPrismaClient(symbol: ts.Symbol): boolean {
  return (symbol.getDeclarations() ?? []).some((declaration) => {
    const name = declaration.getSourceFile().fileName.replace(/\\/g, '/');
    return name.includes('/@prisma/client/') || name.includes('/.prisma/client/');
  });
}

function typeMembers(type: ts.Type): ts.Type[] {
  return type.isUnion() ? type.types : [type];
}

/**
 * Resolve `expression` to the Prisma model whose delegate it is, by type.
 *
 * Catches `this.prisma.member`, `db.member` (forwarded variable), bare `member`
 * (destructured from a client), `tx.member` (transaction parameter) and any
 * aliased / re-exported client — none of which are distinguishable by name.
 */
function delegateModelOf(
  typed: TypedProgram,
  expression: ts.Expression,
  modelsByName: Map<string, SchemaModel>,
): SchemaModel | undefined {
  const matched = new Map<string, SchemaModel>();
  for (const member of typeMembers(typed.checker.getTypeAtLocation(expression))) {
    const symbol = member.getSymbol() ?? member.aliasSymbol;
    if (symbol === undefined) continue;
    const match = /^(\w+)Delegate$/.exec(symbol.getName());
    if (match === null || !declaredByPrismaClient(symbol)) continue;
    const model = modelsByName.get(match[1]);
    if (model !== undefined) matched.set(model.name, model);
  }
  // A computed access with a non-literal key (`client[name]`) types as the union
  // of every delegate. Attributing that to whichever model happens to come first
  // would invent a precise owner for an access we cannot resolve, so it stays
  // unresolved — the honest outcome, and the same one Phase 0 produced. Listed
  // as the `dynamic delegate` known gap rather than silently mis-attributed.
  return matched.size === 1 ? [...matched.values()][0] : undefined;
}

/**
 * True when `expression` is a Prisma client capable of raw SQL — PrismaService,
 * Prisma.TransactionClient (`Omit<PrismaClient, ITXClientDenyList>`, which
 * retains the raw methods) or any wrapper exposing them.  Decided by the
 * presence of the raw members on the type, so it needs no name allowlist.
 */
function rawCapableClient(typed: TypedProgram, expression: ts.Expression): boolean {
  return typeMembers(typed.checker.getTypeAtLocation(expression)).some(
    (member) =>
      member.getProperty('$queryRaw') !== undefined ||
      member.getProperty('$executeRaw') !== undefined,
  );
}

function lowerFirst(value: string): string {
  return value.slice(0, 1).toLowerCase() + value.slice(1);
}

function objectProperty(
  object: ts.ObjectLiteralExpression,
  name: string,
): ts.Expression | undefined {
  for (const property of object.properties) {
    if (ts.isPropertyAssignment(property)) {
      const key =
        ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)
          ? property.name.text
          : '';
      if (key === name) return property.initializer;
    }
    if (ts.isShorthandPropertyAssignment(property) && property.name.text === name) {
      return property.name;
    }
  }
  return undefined;
}

function propertyName(property: ts.ObjectLiteralElementLike): string | null {
  if (!ts.isPropertyAssignment(property)) return null;
  if (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
    return property.name.text;
  return null;
}

function isFalse(expression: ts.Expression): boolean {
  return expression.kind === ts.SyntaxKind.FalseKeyword;
}

function isTrue(expression: ts.Expression): boolean {
  return expression.kind === ts.SyntaxKind.TrueKeyword;
}

interface PredicateAnalysis {
  fields: string[];
  statusFields: string[];
  timeWindowFields: string[];
  relationFields: string[];
  dynamic: boolean;
}

interface ReadSelection {
  explicitSelect: boolean;
  scalarFields: string[] | null;
  hasOmit: boolean;
  relationAccesses: RelationAccess[];
}

interface RelationAccess {
  model: SchemaModel;
  path: string;
  node: ts.Node;
  selection: ReadSelection;
  predicates: PredicateAnalysis;
}

interface ReadCandidate {
  sourceDomain: string;
  sourceModule: string;
  targetDomain: string;
  prismaModel: string;
  operation: string;
  sourceFile: string;
  sourceSymbol: string;
  accessPath: string;
}

function returnsModelRow(operation: string): boolean {
  return ['findUnique', 'findUniqueOrThrow', 'findFirst', 'findFirstOrThrow', 'findMany'].includes(
    operation,
  );
}

function predicateAnalysis(): PredicateAnalysis {
  return {
    fields: [],
    statusFields: [],
    timeWindowFields: [],
    relationFields: [],
    dynamic: false,
  };
}

function addUnique(values: string[], value: string): void {
  if (!values.includes(value)) values.push(value);
}

function hasTimeWindowOperator(value: ts.Expression): boolean {
  if (ts.isArrayLiteralExpression(value)) {
    return value.elements.some(
      (element) => ts.isExpression(element) && hasTimeWindowOperator(element),
    );
  }
  if (!ts.isObjectLiteralExpression(value)) return false;
  return value.properties.some((property) => {
    const name = propertyName(property);
    return name !== null && ['gt', 'gte', 'lt', 'lte'].includes(name);
  });
}

function collectModelPredicate(
  value: ts.Expression,
  model: SchemaModel,
  output: PredicateAnalysis,
): void {
  if (ts.isArrayLiteralExpression(value)) {
    for (const element of value.elements) {
      if (ts.isExpression(element)) collectModelPredicate(element, model, output);
      else output.dynamic = true;
    }
    return;
  }
  if (!ts.isObjectLiteralExpression(value)) {
    output.dynamic = true;
    return;
  }
  for (const property of value.properties) {
    if (ts.isSpreadAssignment(property)) {
      output.dynamic = true;
      continue;
    }
    const name = propertyName(property);
    if (name === null || !ts.isPropertyAssignment(property)) {
      output.dynamic = true;
      continue;
    }
    if (['AND', 'OR', 'NOT'].includes(name)) {
      collectModelPredicate(property.initializer, model, output);
      continue;
    }
    if (model.scalarFields.includes(name)) {
      addUnique(output.fields, name);
      if (model.statusPredicateFields.includes(name)) addUnique(output.statusFields, name);
      if (model.dateFields.includes(name) && hasTimeWindowOperator(property.initializer)) {
        addUnique(output.timeWindowFields, name);
      }
      continue;
    }
    if (model.relationFields[name] !== undefined) {
      addUnique(output.relationFields, name);
      output.dynamic = true;
      continue;
    }
    // Prisma operator objects occur below a known model field and never arrive here.
    // At the model root an unknown key can be a computed shape or a new field, so do
    // not quietly treat it as a safe predicate.
    output.dynamic = true;
  }
}

function collectDistinctFields(
  value: ts.Expression,
  model: SchemaModel,
  output: PredicateAnalysis,
): void {
  if (ts.isStringLiteral(value)) {
    if (model.scalarFields.includes(value.text)) addUnique(output.fields, value.text);
    else output.dynamic = true;
    return;
  }
  if (ts.isArrayLiteralExpression(value)) {
    for (const element of value.elements) {
      if (ts.isStringLiteral(element)) collectDistinctFields(element, model, output);
      else output.dynamic = true;
    }
    return;
  }
  output.dynamic = true;
}

function analyzePredicates(
  object: ts.ObjectLiteralExpression,
  model: SchemaModel,
): PredicateAnalysis {
  const output = predicateAnalysis();
  for (const name of ['where', 'orderBy', 'cursor', 'having']) {
    const value = objectProperty(object, name);
    if (value !== undefined) collectModelPredicate(value, model, output);
  }
  const distinct = objectProperty(object, 'distinct');
  if (distinct !== undefined) collectDistinctFields(distinct, model, output);
  const by = objectProperty(object, 'by');
  if (by !== undefined) collectDistinctFields(by, model, output);
  return output;
}

function relationAccess(
  value: ts.Expression,
  target: SchemaModel,
  models: ReadonlyMap<string, SchemaModel>,
  path: string,
): RelationAccess | null {
  if (isFalse(value)) return null;
  if (ts.isObjectLiteralExpression(value)) {
    return {
      model: target,
      path,
      node: value,
      selection: analyzeSelection(value, target, models, path),
      predicates: analyzePredicates(value, target),
    };
  }
  return {
    model: target,
    path,
    node: value,
    selection: {
      explicitSelect: false,
      scalarFields: null,
      hasOmit: false,
      relationAccesses: [],
    },
    predicates: { ...predicateAnalysis(), dynamic: !isTrue(value) },
  };
}

function analyzeSelection(
  object: ts.ObjectLiteralExpression,
  model: SchemaModel,
  models: ReadonlyMap<string, SchemaModel>,
  pathPrefix: string,
): ReadSelection {
  const select = objectProperty(object, 'select');
  const include = objectProperty(object, 'include');
  const relationAccesses: RelationAccess[] = [];
  let scalarFields: string[] | null = [];

  const collectSelection = (value: ts.Expression, path: string): void => {
    if (!ts.isObjectLiteralExpression(value)) {
      scalarFields = null;
      return;
    }
    for (const property of value.properties) {
      if (ts.isSpreadAssignment(property)) {
        scalarFields = null;
        continue;
      }
      const name = propertyName(property);
      if (name === null || !ts.isPropertyAssignment(property)) {
        scalarFields = null;
        continue;
      }
      if (model.scalarFields.includes(name)) {
        if (isFalse(property.initializer)) continue;
        if (!isTrue(property.initializer)) scalarFields = null;
        else if (scalarFields !== null) addUnique(scalarFields, name);
        continue;
      }
      const targetName = model.relationFields[name];
      const target = targetName === undefined ? undefined : models.get(targetName);
      if (target !== undefined) {
        const access = relationAccess(property.initializer, target, models, `${path}.${name}`);
        if (access !== null) relationAccesses.push(access);
        continue;
      }
      scalarFields = null;
    }
  };

  if (select !== undefined) collectSelection(select, `${pathPrefix}.select`);
  if (include !== undefined) collectSelection(include, `${pathPrefix}.include`);

  return {
    explicitSelect: select !== undefined,
    scalarFields: scalarFields === null ? null : scalarFields.sort(),
    hasOmit: objectProperty(object, 'omit') !== undefined,
    relationAccesses,
  };
}

function shapeOf(node: ts.Node, source: ts.SourceFile): string {
  const keys: string[] = [];
  const visit = (cursor: ts.Node): void => {
    if (
      ts.isPropertyAssignment(cursor) &&
      (ts.isIdentifier(cursor.name) || ts.isStringLiteral(cursor.name))
    ) {
      keys.push(cursor.name.text);
    }
    if (ts.isShorthandPropertyAssignment(cursor)) keys.push(cursor.name.text);
    cursor.forEachChild(visit);
  };
  visit(node);
  return (
    'keys:' +
    [...new Set(keys)].sort().join(',') +
    '|text:' +
    normalized(node, source).slice(0, 500)
  );
}

interface SqlLiteral {
  text: string;
  hasInterpolation: boolean;
}

function literalSql(node: ts.Expression | ts.TaggedTemplateExpression): SqlLiteral | null {
  if (ts.isTaggedTemplateExpression(node)) {
    if (ts.isNoSubstitutionTemplateLiteral(node.template)) {
      return { text: node.template.text, hasInterpolation: false };
    }
    if (ts.isTemplateExpression(node.template)) {
      // Parameters commonly use interpolation while the table identifier remains
      // literal. Join only literal fragments: this can still prove a physical-table
      // hit, but it never claims to understand an interpolated identifier.
      return {
        text:
          node.template.head.text +
          node.template.templateSpans.map((span) => span.literal.text).join(''),
        hasInterpolation: true,
      };
    }
  }
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return { text: node.text, hasInterpolation: false };
  }
  return null;
}

function escapeRegex(value: string): string {
  return value.replace(/[\\^$.*+?(){}|[\]]/g, '\\$&');
}

function allowedEdge(map: DomainMap, from: string, to: string): boolean {
  return map.allowedEdges.some((edge) => edge.from === from && edge.to === to);
}

function allowedRead(map: DomainMap, candidate: ReadCandidate): ReadAllowlistEntry | undefined {
  return map.crossDomainReadAllowlist.find(
    (entry) =>
      entry.sourceDomain === candidate.sourceDomain &&
      entry.sourceModule === candidate.sourceModule &&
      entry.targetDomain === candidate.targetDomain &&
      entry.prismaModel === candidate.prismaModel &&
      entry.operation === candidate.operation &&
      entry.sourceFile === candidate.sourceFile &&
      entry.sourceSymbol === candidate.sourceSymbol &&
      entry.accessPath === candidate.accessPath,
  );
}

/** Name a single step of the syntactic spine, preferring a declaration's own name. */
function pathStep(node: ts.Node, parent: ts.Node): string {
  if (ts.isClassDeclaration(node) && node.name !== undefined) return 'Class(' + node.name.text + ')';
  if (ts.isFunctionDeclaration(node) && node.name !== undefined)
    return 'Function(' + node.name.text + ')';
  if (
    (ts.isMethodDeclaration(node) ||
      ts.isPropertyDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node)) &&
    (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name))
  ) {
    return 'Member(' + node.name.text + ')';
  }
  if (ts.isConstructorDeclaration(node)) return 'Constructor';
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name))
    return 'Var(' + node.name.text + ')';
  if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name))
    return 'Prop(' + node.name.text + ')';
  // Positional fallback: index among *same-kind* siblings only, so inserting a
  // statement of a different kind above does not renumber this one.
  let index = 0;
  let found = -1;
  parent.forEachChild((child) => {
    if (child.kind === node.kind) {
      if (child === node) found = index;
      index += 1;
    }
  });
  return ts.SyntaxKind[node.kind] + '#' + String(found < 0 ? 0 : found);
}

/**
 * Normalized AST path — the blocking-version call-site identity (终审【九】).
 *
 * Phase 0 hashed `file | symbol | ordinal | node text`. Two of those inputs
 * churn for reasons that are not "this is a different call site": `ordinal` is a
 * per-(file, symbol) counter that shifts whenever an unrelated finding earlier
 * in the same method appears or disappears, and the node text changes on any
 * edit to the call — which is `shapeDigest`'s job to notice, not identity's.
 * Walking the syntactic spine and naming each step keeps the identity anchored
 * to structural position, so reformatting, renaming a local, or gaining a
 * sibling finding all leave it untouched.
 */
function astPath(node: ts.Node): string {
  const steps: string[] = [];
  let cursor: ts.Node = node;
  while (!ts.isSourceFile(cursor)) {
    const parent: ts.Node | undefined = cursor.parent;
    if (parent === undefined) break;
    steps.push(pathStep(cursor, parent));
    cursor = parent;
  }
  return steps.reverse().join('/');
}

function finding(
  kind: string,
  disposition: 'report' | 'allow',
  sourceDomain: string,
  targetDomain: string,
  prismaModel: string | null,
  operation: string,
  file: string,
  source: ts.SourceFile,
  node: ts.Node,
  ordinal: number | string,
  details: JsonRecord,
  channel: 'legacy' | 'new-observation',
): Finding {
  const symbol = symbolOf(node);
  // One AST node can legitimately carry more than one debt item: a cross-owner
  // write also raises a subdomain observation (48 live pairs), and a single raw
  // statement can hit two physical tables (1 live pair). The structural path
  // alone therefore under-identifies. The observation channel, the model and the
  // relation access path are what separate co-located items — all three are
  // properties of *which violation this is*, not of how the code is written, so
  // they do not reintroduce text-driven churn.
  const accessPath = typeof details.accessPath === 'string' ? details.accessPath : '';
  const discriminator = [channel, prismaModel ?? targetDomain, accessPath].join('|');
  return {
    kind,
    disposition,
    sourceDomain,
    targetDomain,
    prismaModel,
    operation,
    location: { file, line: lineOf(node, source), symbol },
    callSiteId: 'cs:' + shortHash(file + '|' + astPath(node) + '|' + discriminator),
    legacyCallSiteId:
      'cs:' + shortHash(file + '|' + symbol + '|' + ordinal + '|' + normalized(node, source)),
    violationFingerprint:
      'vfp:' + shortHash(symbol + '|' + (prismaModel ?? targetDomain) + '|' + operation),
    shapeDigest: 'sdg:' + shortHash(shapeOf(node, source)),
    details,
  };
}

function scan(map: DomainMap): {
  findings: Finding[];
  edges: ImportEdge[];
  commonFindings: Finding[];
  inputDigest: string;
} {
  const models = schemaModels();
  const modelsByName = new Map(models.map((model) => [model.name, model]));
  const delegates = new Map<string, SchemaModel>();
  for (const model of models) delegates.set(lowerFirst(model.name), model);
  const files = walk('src', (name) => name.endsWith('.ts') && !name.endsWith('.spec.ts'));
  const inputs = ['prisma/schema.prisma\u0000' + hash(read('prisma/schema.prisma'))];
  for (const file of files) inputs.push(file + '\u0000' + hash(read(file)));
  const typed = buildTypedProgram();
  const findings: Finding[] = [];
  const edges: ImportEdge[] = [];
  const ordinals = new Map<string, number>();
  const next = (file: string, symbol: string): number => {
    const key = file + '|' + symbol;
    const value = (ordinals.get(key) ?? 0) + 1;
    ordinals.set(key, value);
    return value;
  };
  for (const file of files) {
    const moduleName = moduleOf(file);
    if (moduleName === null) continue;
    const sourceOwner = map.moduleOwnership[moduleName];
    if (sourceOwner === undefined) continue;
    const sourceDomain = sourceOwner.domain;
    // Source comes from the typed program so that every node carries a resolved
    // type; re-parsing the file standalone would silently drop the checker.
    const source = typed.sourceOf(file);
    if (source === undefined) {
      fail(
        `${file} 不在 tsconfig 的编译闭包内,typed 扫描无法覆盖它。` +
          '扫描范围与 tsconfig include/exclude 是同一个单源 —— 请修 tsconfig,不要在扫描器里另开 glob。',
      );
    }
    const emit = (
      kind: string,
      disposition: 'report' | 'allow',
      targetDomain: string,
      model: string | null,
      operation: string,
      node: ts.Node,
      details: JsonRecord,
      identity: 'legacy' | 'new-observation' = 'legacy',
    ): void => {
      // Phase 0 的 callSiteId 以当时扫描到的语法节点序号为输入。新增的
      // relation 观察若继续占用这个序号，会让后续一行未动的存量债改号。
      // 新观察改用节点位置派生的隔离 discriminator，保留已有登记表的身份。
      const ordinal =
        identity === 'legacy'
          ? next(file, symbolOf(node))
          : `new:${node.getStart(source)}:${node.getEnd()}`;
      findings.push(
        finding(
          kind,
          disposition,
          sourceDomain,
          targetDomain,
          model,
          operation,
          file,
          source,
          node,
          ordinal,
          details,
          identity,
        ),
      );
    };
    const raw = (
      node: ts.Expression | ts.TaggedTemplateExpression,
      expression: ts.Expression,
    ): void => {
      const operation = propertyOf(expression);
      if (
        operation === null ||
        (!operation.startsWith('$queryRaw') && !operation.startsWith('$executeRaw'))
      )
        return;
      const receiver = ts.isPropertyAccessExpression(expression)
        ? expression.expression
        : expression;
      if (!rawCapableClient(typed, receiver)) return;
      const sql = literalSql(node);
      if (sql === null) {
        emit('raw-sql-dynamic', 'report', 'unknown', null, 'raw', node, {
          reason: 'non-literal SQL',
        });
        return;
      }
      for (const model of models) {
        const owner = map.modelOwnership[model.name];
        if (owner === undefined || owner.domain === sourceDomain) continue;
        const tableRe = new RegExp(
          '(?:^|[^A-Za-z0-9_])' + escapeRegex(model.tableName) + '(?:$|[^A-Za-z0-9_])',
          'i',
        );
        if (tableRe.test(sql.text)) {
          emit(
            'raw-cross-domain-table',
            'report',
            owner.domain,
            model.name,
            'raw',
            node,
            {
              physicalTable: model.tableName,
              physicalTableSource: model.tableNameSource,
              sqlHasInterpolation: sql.hasInterpolation,
            },
            'legacy',
          );
        }
      }
    };
    const emitRead = (
      targetModel: SchemaModel,
      selection: ReadSelection,
      predicates: PredicateAnalysis,
      operation: string,
      node: ts.Node,
      accessPath: string,
      identity: 'legacy' | 'new-observation',
    ): void => {
      const targetOwner = map.modelOwnership[targetModel.name];
      if (targetOwner === undefined || targetOwner.domain === sourceDomain) return;
      const selectedFields = selection.scalarFields;
      const details: JsonRecord = {
        accessPath,
        explicitSelect: selection.explicitSelect,
        selectedFields,
        predicateFields: predicates.fields,
        statusPredicateFields: predicates.statusFields,
        timeWindowFields: predicates.timeWindowFields,
        relationPredicateFields: predicates.relationFields,
        dynamicShape: selectedFields === null || predicates.dynamic,
      };
      const candidate: ReadCandidate = {
        sourceDomain,
        sourceModule: moduleName,
        targetDomain: targetOwner.domain,
        prismaModel: targetModel.name,
        operation,
        sourceFile: file,
        sourceSymbol: symbolOf(node),
        accessPath,
      };
      const semanticCandidate =
        predicates.statusFields.length > 0 && predicates.timeWindowFields.length > 0;
      if (semanticCandidate) {
        emit(
          'cross-domain-semantic-read-candidate',
          'report',
          targetOwner.domain,
          targetModel.name,
          operation,
          node,
          {
            ...details,
            requiredExit: '应消费属主导出的业务谓词；不得在调用域内联时间窗与状态组合。',
          },
          identity,
        );
        return;
      }

      const modelRow = returnsModelRow(operation);
      if (modelRow && selection.hasOmit) {
        emit(
          'cross-domain-kernel-read-violation',
          'report',
          targetOwner.domain,
          targetModel.name,
          operation,
          node,
          {
            ...details,
            reason: 'omit 不构成 select 白名单出口。',
          },
          identity,
        );
        return;
      }
      if (modelRow && !selection.explicitSelect) {
        emit(
          'cross-domain-kernel-read-violation',
          'report',
          targetOwner.domain,
          targetModel.name,
          operation,
          node,
          {
            ...details,
            reason: '未显式 select；裸 include / 默认 delegate 读会取得目标 model 的整行。',
          },
          identity,
        );
        return;
      }
      if (selectedFields === null || predicates.dynamic) {
        emit(
          'cross-domain-read-dynamic',
          'report',
          targetOwner.domain,
          targetModel.name,
          operation,
          node,
          {
            ...details,
            reason: 'select/include/谓词含动态构造，无法静态证明其属于任何读档。',
          },
          identity,
        );
        return;
      }

      // count / aggregate / groupBy do not return a target-model row, so the
      // kernel select rule does not apply. They still need an explicit factual
      // allowlist entry (and their predicate shape remains observable).
      if (!modelRow) {
        const allowlistEntry = allowedRead(map, candidate);
        if (allowlistEntry !== undefined) {
          emit(
            'cross-domain-fact-read',
            'allow',
            targetOwner.domain,
            targetModel.name,
            operation,
            node,
            {
              ...details,
              allowlist: allowlistEntry,
            },
            identity,
          );
        } else {
          emit(
            'cross-domain-fact-read-candidate',
            'report',
            targetOwner.domain,
            targetModel.name,
            operation,
            node,
            {
              ...details,
              requiredExit: '审核为按 id / schema 可见事实后，精确登记 crossDomainReadAllowlist。',
            },
            identity,
          );
        }
        return;
      }

      const kernelFields = map.kernel.kernelReadFields?.fields?.[targetModel.name] ?? [];
      const kernelPredicateFields =
        map.kernel.kernelPredicateFields?.fields?.[targetModel.name] ?? [];
      const nonKernelSelected = selectedFields.filter((field) => !kernelFields.includes(field));
      const nonKernelPredicates = predicates.fields.filter(
        (field) => !kernelPredicateFields.includes(field),
      );
      if (kernelFields.length > 0 && nonKernelSelected.length === 0) {
        if (nonKernelPredicates.length === 0) {
          emit(
            'cross-domain-kernel-read',
            'allow',
            targetOwner.domain,
            targetModel.name,
            operation,
            node,
            {
              ...details,
            },
            identity,
          );
        } else {
          emit(
            'cross-domain-kernel-predicate-violation',
            'report',
            targetOwner.domain,
            targetModel.name,
            operation,
            node,
            {
              ...details,
              nonKernelPredicateFields: nonKernelPredicates,
              reason: '返回字段合规不等于可作谓词；该条件应改用 kernelPredicateFields 或属主谓词。',
            },
            identity,
          );
        }
        return;
      }

      const allowlistEntry = allowedRead(map, candidate);
      if (allowlistEntry !== undefined) {
        emit(
          'cross-domain-fact-read',
          'allow',
          targetOwner.domain,
          targetModel.name,
          operation,
          node,
          {
            ...details,
            allowlist: allowlistEntry,
          },
          identity,
        );
      } else {
        emit(
          'cross-domain-fact-read-candidate',
          'report',
          targetOwner.domain,
          targetModel.name,
          operation,
          node,
          {
            ...details,
            requiredExit: '审核为按 id / schema 可见事实后，精确登记 crossDomainReadAllowlist。',
          },
          identity,
        );
      }
    };
    const inspectRelationAccesses = (
      accesses: readonly RelationAccess[],
      operation: string,
    ): void => {
      for (const access of accesses) {
        emitRead(
          access.model,
          access.selection,
          access.predicates,
          operation,
          access.node,
          access.path,
          'new-observation',
        );
        inspectRelationAccesses(access.selection.relationAccesses, operation);
      }
    };
    // Every syntactic form that creates a module dependency funnels through
    // here, so adding a form cannot accidentally skip the boundary verdict.
    const moduleDependency = (
      node: ts.Node,
      specifier: string,
      form: ImportForm,
      typeOnly: boolean,
    ): void => {
      const targetModule = moduleForImport(file, specifier);
      if (targetModule === null || targetModule === moduleName) return;
      const targetOwner = map.moduleOwnership[targetModule];
      if (targetOwner === undefined || targetOwner.domain === sourceDomain) return;
      edges.push({
        from: sourceDomain,
        to: targetOwner.domain,
        form,
        typeOnly,
        file,
        line: lineOf(node, source),
        symbol: symbolOf(node),
        text: specifier,
      });
      if (!allowedEdge(map, sourceDomain, targetOwner.domain)) {
        emit('cross-domain-import', 'report', targetOwner.domain, null, 'import', node, {
          targetModule,
          specifier,
          form,
          typeOnly,
        });
      }
    };

    /** `import type {X}` or `import {type X, type Y}` — both fully erased. */
    const importIsTypeOnly = (clause: ts.ImportClause | undefined): boolean => {
      if (clause === undefined) return false;
      if (clause.isTypeOnly) return true;
      const bindings = clause.namedBindings;
      return (
        bindings !== undefined &&
        ts.isNamedImports(bindings) &&
        bindings.elements.length > 0 &&
        bindings.elements.every((element) => element.isTypeOnly)
      );
    };

    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        moduleDependency(
          node,
          node.moduleSpecifier.text,
          'import',
          importIsTypeOnly(node.importClause),
        );
      }
      // `export { X } from '...'` / `export * from '...'` — a real dependency
      // the declaration-only walk never saw.
      if (
        ts.isExportDeclaration(node) &&
        node.moduleSpecifier !== undefined &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        const bindings = node.exportClause;
        const typeOnly =
          node.isTypeOnly ||
          (bindings !== undefined &&
            ts.isNamedExports(bindings) &&
            bindings.elements.length > 0 &&
            bindings.elements.every((element) => element.isTypeOnly));
        moduleDependency(node, node.moduleSpecifier.text, 'export-from', typeOnly);
      }
      // `await import('...')` with a literal specifier.
      if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments[0] !== undefined &&
        ts.isStringLiteral(node.arguments[0])
      ) {
        moduleDependency(node, node.arguments[0].text, 'dynamic-import', false);
      }
      // `import X = require('...')`.
      if (
        ts.isImportEqualsDeclaration(node) &&
        ts.isExternalModuleReference(node.moduleReference) &&
        ts.isStringLiteral(node.moduleReference.expression)
      ) {
        moduleDependency(
          node,
          node.moduleReference.expression.text,
          'import-equals',
          node.isTypeOnly,
        );
      }
      if (ts.isTaggedTemplateExpression(node)) raw(node, node.tag);
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const operation = node.expression.name.text;
        if (operation.startsWith('$queryRaw') || operation.startsWith('$executeRaw')) {
          raw(node.arguments[0] ?? node.expression, node.expression);
        }
        // Typed resolution of the delegate expression itself. No constraint on
        // the receiver's shape or name: `this.prisma.member`, `db.member` and a
        // bare destructured `member` all resolve to the same MemberDelegate.
        const model = delegateModelOf(typed, node.expression.expression, modelsByName);
        if (model !== undefined) {
          const targetOwner = map.modelOwnership[model.name];
          if (targetOwner !== undefined) {
            const writes = new Set([
              'create',
              'createMany',
              'update',
              'updateMany',
              'upsert',
              'delete',
              'deleteMany',
            ]);
            const reads = new Set([
              'findUnique',
              'findUniqueOrThrow',
              'findFirst',
              'findFirstOrThrow',
              'findMany',
              'count',
              'aggregate',
              'groupBy',
            ]);
            if (writes.has(operation) && targetOwner.ownerModule !== moduleName) {
              emit('cross-owner-write', 'report', targetOwner.domain, model.name, operation, node, {
                sourceModule: moduleName,
                ownerModule: targetOwner.ownerModule ?? null,
              });
              if (
                sourceOwner.domain === targetOwner.domain &&
                sourceOwner.subdomain !== undefined &&
                targetOwner.subdomain !== undefined &&
                sourceOwner.subdomain !== targetOwner.subdomain
              ) {
                emit(
                  'observed-subdomain-cross-owner-write',
                  'report',
                  targetOwner.domain,
                  model.name,
                  operation,
                  node,
                  {
                    sourceModule: moduleName,
                    sourceSubdomain: sourceOwner.subdomain,
                    ownerModule: targetOwner.ownerModule ?? null,
                    targetSubdomain: targetOwner.subdomain,
                    purpose: '治理大域内的观察记录；不改变当前域边界或业务行为。',
                  },
                  'new-observation',
                );
              }
            } else if (reads.has(operation)) {
              const first = node.arguments[0];
              const argument =
                first !== undefined && ts.isObjectLiteralExpression(first) ? first : undefined;
              const selection =
                argument === undefined
                  ? {
                      explicitSelect: false,
                      scalarFields: null,
                      hasOmit: false,
                      relationAccesses: [],
                    }
                  : analyzeSelection(argument, model, modelsByName, model.name);
              const predicates =
                argument === undefined
                  ? { ...predicateAnalysis(), dynamic: true }
                  : analyzePredicates(argument, model);
              emitRead(model, selection, predicates, operation, node, model.name, 'legacy');
              inspectRelationAccesses(selection.relationAccesses, operation);
            }
          }
        }
      }
      node.forEachChild(visit);
    };
    visit(source);
  }
  return {
    findings,
    edges,
    commonFindings: scanCommon(map, models, modelsByName, typed, files),
    inputDigest: 'sha256:' + hash(inputs.sort().join('\n')),
  };
}

/**
 * R15 的三条判据(见文件头 COMMON_PREFIX 处的说明)。
 *
 * 复用 `scan()` 已经建好的 `typed` program —— 不另建第二个:#1019 刚把
 * ts.Program 的构建次数从 32 压到 2,再建一个会把那笔收益原样吐回去。
 */
function scanCommon(
  map: DomainMap,
  models: readonly SchemaModel[],
  modelsByName: Map<string, SchemaModel>,
  typed: TypedProgram,
  files: readonly string[],
): Finding[] {
  const out: Finding[] = [];
  const ordinals = new Map<string, number>();
  for (const file of files) {
    if (!file.startsWith(COMMON_PREFIX)) continue;
    const source = typed.sourceOf(file);
    if (source === undefined) {
      fail(
        `${file} 不在 tsconfig 的编译闭包内,R15 扫描无法覆盖它。` +
          '扫描范围与 tsconfig include/exclude 是同一个单源 —— 请修 tsconfig,不要在扫描器里另开 glob。',
      );
    }
    const emit = (
      kind: string,
      disposition: 'report' | 'allow',
      targetDomain: string,
      model: string | null,
      operation: string,
      node: ts.Node,
      details: JsonRecord,
    ): void => {
      const symbol = symbolOf(node);
      const key = file + '|' + symbol;
      const ordinal = (ordinals.get(key) ?? 0) + 1;
      ordinals.set(key, ordinal);
      out.push(
        finding(
          kind,
          disposition,
          COMMON_DOMAIN,
          targetDomain,
          model,
          operation,
          file,
          source,
          node,
          ordinal,
          details,
          'new-observation',
        ),
      );
    };

    // ── 判据③:common → src/modules/** 入边(结构判据,恒 0)──
    const moduleDependency = (node: ts.Node, specifier: string, form: ImportForm): void => {
      const targetModule = moduleForImport(file, specifier);
      if (targetModule === null) return;
      const targetOwner = map.moduleOwnership[targetModule];
      emit(
        'common-to-module-import',
        'report',
        targetOwner?.domain ?? 'unknown',
        null,
        'import',
        node,
        {
          targetModule,
          specifier,
          form,
          requiredExit:
            'src/common 只放技术无关横切件;需要业务能力就由属主模块导出,不得反向 import。',
        },
      );
    };

    // ── 判据①(raw 形态):common 内的 raw SQL 打到业务物理表 ──
    const raw = (node: ts.Expression | ts.TaggedTemplateExpression, expression: ts.Expression): void => {
      const operation = propertyOf(expression);
      if (
        operation === null ||
        (!operation.startsWith('$queryRaw') && !operation.startsWith('$executeRaw'))
      )
        return;
      const receiver = ts.isPropertyAccessExpression(expression) ? expression.expression : expression;
      if (!rawCapableClient(typed, receiver)) return;
      const sql = literalSql(node);
      if (sql === null) {
        emit('common-raw-sql-dynamic', 'report', 'unknown', null, 'raw', node, {
          reason: 'non-literal SQL — 无法证明它没有碰业务表。',
        });
        return;
      }
      for (const model of models) {
        const owner = map.modelOwnership[model.name];
        if (owner === undefined) continue;
        const tableRe = new RegExp(
          '(?:^|[^A-Za-z0-9_])' + escapeRegex(model.tableName) + '(?:$|[^A-Za-z0-9_])',
          'i',
        );
        if (!tableRe.test(sql.text)) continue;
        emit('common-business-table-access', 'report', owner.domain, model.name, 'raw', node, {
          form: 'raw',
          accessPath: model.name,
          physicalTable: model.tableName,
          physicalTableSource: model.tableNameSource,
          sqlHasInterpolation: sql.hasInterpolation,
          ownerModule: owner.ownerModule ?? null,
          requiredExit: '表名参数化,common 不留业务表知识。',
        });
      }
    };

    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        moduleDependency(node, node.moduleSpecifier.text, 'import');
      }
      if (
        ts.isExportDeclaration(node) &&
        node.moduleSpecifier !== undefined &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        moduleDependency(node, node.moduleSpecifier.text, 'export-from');
      }
      if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments.length > 0 &&
        ts.isStringLiteral(node.arguments[0])
      ) {
        moduleDependency(node, node.arguments[0].text, 'dynamic-import');
      }
      if (
        ts.isImportEqualsDeclaration(node) &&
        ts.isExternalModuleReference(node.moduleReference) &&
        ts.isStringLiteral(node.moduleReference.expression)
      ) {
        moduleDependency(node, node.moduleReference.expression.text, 'import-equals');
      }
      if (ts.isTaggedTemplateExpression(node)) raw(node, node.tag);
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const operation = node.expression.name.text;
        if (operation.startsWith('$queryRaw') || operation.startsWith('$executeRaw')) {
          raw(node.arguments[0] ?? node.expression, node.expression);
        }
        const model = delegateModelOf(typed, node.expression.expression, modelsByName);
        const owner = model === undefined ? undefined : map.modelOwnership[model.name];
        if (model !== undefined && owner !== undefined) {
          const reads = new Set([
            'findUnique',
            'findUniqueOrThrow',
            'findFirst',
            'findFirstOrThrow',
            'findMany',
            'count',
            'aggregate',
            'groupBy',
          ]);
          const first = node.arguments[0];
          const argument = first !== undefined && ts.isObjectLiteralExpression(first) ? first : undefined;
          const base: JsonRecord = {
            form: 'delegate',
            accessPath: model.name,
            ownerModule: owner.ownerModule ?? null,
          };
          if (reads.has(operation)) {
            const predicates =
              argument === undefined ? { ...predicateAnalysis(), dynamic: true } : analyzePredicates(argument, model);
            // ── 判据②:内联业务状态 + 时间窗谓词组合(复用 R6 三档读口径)──
            if (predicates.statusFields.length > 0 && predicates.timeWindowFields.length > 0) {
              emit('common-business-predicate', 'report', owner.domain, model.name, operation, node, {
                ...base,
                statusPredicateFields: predicates.statusFields,
                timeWindowFields: predicates.timeWindowFields,
                requiredExit:
                  '应消费属主导出的业务谓词;common 内不得内联时间窗与状态组合。',
              });
              node.forEachChild(visit);
              return;
            }
            const selection =
              argument === undefined
                ? { explicitSelect: false, scalarFields: null, hasOmit: false, relationAccesses: [] }
                : analyzeSelection(argument, model, modelsByName, model.name);
            const kernelFields = map.kernel.kernelReadFields?.fields?.[model.name] ?? [];
            const selected = selection.scalarFields;
            // 例外:kernel 白名单内的事实读。必须是**显式 select**、非 omit、
            // 且每个字段都在白名单内 —— 少任何一条都不算「形似而合法」。
            const kernelFactRead =
              selection.explicitSelect &&
              !selection.hasOmit &&
              selected !== null &&
              selected.length > 0 &&
              kernelFields.length > 0 &&
              selected.every((field) => kernelFields.includes(field));
            if (kernelFactRead) {
              emit('common-kernel-fact-read', 'allow', owner.domain, model.name, operation, node, {
                ...base,
                selectedFields: selected,
                kernelReadFields: kernelFields,
              });
              node.forEachChild(visit);
              return;
            }
          }
          emit('common-business-table-access', 'report', owner.domain, model.name, operation, node, {
            ...base,
            requiredExit: '表名参数化,common 不留业务表知识。',
          });
        }
      }
      node.forEachChild(visit);
    };
    visit(source);
  }
  return out;
}

function cycles(map: DomainMap, edges: ImportEdge[], findings: Finding[]): void {
  const adjacency = new Map<string, ImportEdge[]>();
  for (const edge of edges) {
    const list = adjacency.get(edge.from) ?? [];
    list.push(edge);
    adjacency.set(edge.from, list);
  }
  const visited = new Set<string>();
  const active = new Set<string>();
  const stack: string[] = [];
  const emitted = new Set<string>();
  const visit = (domain: string): void => {
    visited.add(domain);
    active.add(domain);
    stack.push(domain);
    for (const edge of adjacency.get(domain) ?? []) {
      if (!visited.has(edge.to)) visit(edge.to);
      else if (active.has(edge.to)) {
        const cycle = [...stack.slice(stack.indexOf(edge.to)), edge.to];
        const key = cycle.join('>');
        if (!emitted.has(key)) {
          emitted.add(key);
          findings.push({
            kind: 'cross-domain-cycle',
            disposition: 'report',
            sourceDomain: edge.from,
            targetDomain: edge.to,
            prismaModel: null,
            operation: 'import-cycle',
            location: { file: edge.file, line: edge.line, symbol: edge.symbol },
            // A cycle's identity is the cycle itself plus the file that closes
            // it — deliberately not the line, which drifts on unrelated edits.
            // 19 such findings exist today; none is registered in
            // architecture-debt.json, so re-anchoring them migrates nothing.
            callSiteId: 'cs:' + shortHash(edge.file + '|cycle|' + key),
            legacyCallSiteId: 'cs:' + shortHash(edge.file + '|' + edge.line + '|' + key),
            violationFingerprint: 'vfp:' + shortHash(key),
            shapeDigest: 'sdg:' + shortHash(cycle.join('|')),
            details: { cycle, source: edge.text },
          });
        }
      }
    }
    stack.pop();
    active.delete(domain);
  };
  for (const domain of Object.keys(map.domains).sort()) {
    if (!visited.has(domain)) visit(domain);
  }
}

function edgeUsage(
  map: DomainMap,
  imports: ImportEdge[],
  findings: Finding[],
): { declaredEdges: EdgeUsage[]; undeclaredDirections: EdgeUsage[] } {
  const usage = new Map<string, EdgeUsage>();
  const keyOf = (from: string, to: string): string => `${from}\u0000${to}`;
  const observe = (from: string, to: string): EdgeUsage => {
    const key = keyOf(from, to);
    const current = usage.get(key);
    if (current !== undefined) return current;
    const created: EdgeUsage = {
      from,
      to,
      importCount: 0,
      crossDomainAccessCount: 0,
    };
    usage.set(key, created);
    return created;
  };

  // `findings` deliberately contains only undeclared import violations. Keep
  // the raw import-edge list separate so confirmed edges have observable usage
  // too; otherwise deleting a declaration would be the only way to measure it.
  for (const edge of imports) observe(edge.from, edge.to).importCount += 1;
  for (const finding of findings) {
    if (finding.kind === 'cross-domain-import' || finding.kind === 'cross-domain-cycle') continue;
    if (finding.sourceDomain === finding.targetDomain || finding.targetDomain === 'unknown') continue;
    observe(finding.sourceDomain, finding.targetDomain).crossDomainAccessCount += 1;
  }

  const declaredEdges = map.allowedEdges.map((edge) => {
    const current = usage.get(keyOf(edge.from, edge.to));
    return {
      from: edge.from,
      to: edge.to,
      ...(edge.kind === undefined ? {} : { kind: edge.kind }),
      importCount: current?.importCount ?? 0,
      crossDomainAccessCount: current?.crossDomainAccessCount ?? 0,
    };
  });
  const undeclaredDirections = [...usage.values()]
    .filter((entry) => !allowedEdge(map, entry.from, entry.to))
    .sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
  return { declaredEdges, undeclaredDirections };
}

function architectureDebtReport(): JsonRecord {
  const requiredSemanticFields = [
    'classification',
    'reason',
    'risk',
    'desiredExit',
    'ownerApiTarget',
    'reviewTrigger',
    'introducedAt',
  ];
  const errors: string[] = [];
  const pendingEntries: string[] = [];
  const byClassification: Record<string, number> = {};
  try {
    const raw = objectOf(JSON.parse(read(ARCHITECTURE_DEBT)) as unknown, ARCHITECTURE_DEBT);
    if (!Array.isArray(raw.entries)) throw new Error('entries must be an array');
    for (const [index, value] of raw.entries.entries()) {
      const entry = objectOf(value, `${ARCHITECTURE_DEBT}.entries[${index}]`);
      const id = typeof entry.id === 'string' ? entry.id : `entry#${index + 1}`;
      const classification =
        typeof entry.classification === 'string' ? entry.classification : 'unknown';
      byClassification[classification] = (byClassification[classification] ?? 0) + 1;
      const missing = requiredSemanticFields.filter(
        (field) => typeof entry[field] !== 'string' || (entry[field] as string).trim().length === 0,
      );
      const pending = Object.entries(entry).some(
        ([, field]) => typeof field === 'string' && field.includes('pending-phase2'),
      );
      if (missing.length > 0) errors.push(`${id} missing semantic fields: ${missing.join(', ')}`);
      if (pending) pendingEntries.push(id);
    }
    return {
      path: ARCHITECTURE_DEBT,
      entries: raw.entries.length,
      byClassification,
      requiredSemanticFields,
      pendingPhase2Entries: pendingEntries,
      semanticFieldsComplete: errors.length === 0 && pendingEntries.length === 0,
      errors,
    };
  } catch (error) {
    return {
      path: ARCHITECTURE_DEBT,
      entries: 0,
      byClassification,
      requiredSemanticFields,
      pendingPhase2Entries: pendingEntries,
      semanticFieldsComplete: false,
      errors: [error instanceof Error ? error.message : String(error)],
    };
  }
}

function runViolations(): void {
  const map = domainMap();
  const result = scan(map);
  cycles(map, result.edges, result.findings);
  const findings = result.findings.sort((a, b) => {
    const file = a.location.file.localeCompare(b.location.file);
    if (file !== 0) return file;
    const line = a.location.line - b.location.line;
    if (line !== 0) return line;
    return a.kind.localeCompare(b.kind);
  });
  const byKind: Record<string, number> = {};
  for (const item of findings) byKind[item.kind] = (byKind[item.kind] ?? 0) + 1;
  const usage = edgeUsage(map, result.edges, findings);
  const count = (kind: string, disposition?: 'report' | 'allow'): number =>
    findings.filter(
      (item) =>
        item.kind === kind && (disposition === undefined || item.disposition === disposition),
    ).length;
  const commonFindings = result.commonFindings.sort((a, b) => {
    const file = a.location.file.localeCompare(b.location.file);
    if (file !== 0) return file;
    const line = a.location.line - b.location.line;
    if (line !== 0) return line;
    return a.kind.localeCompare(b.kind);
  });
  const commonCount = (kind: string): number =>
    commonFindings.filter((item) => item.kind === kind && item.disposition === 'report').length;
  process.stdout.write(
    JSON.stringify(
      {
        mode: 'violations',
        enforcement: 'report-only',
        reportOnly: true,
        generatorVersion: VERSION,
        inputDigest: result.inputDigest,
        knownGaps: [
          'Prisma aliases, destructuring, wrappers and variable forwarding are not proven.',
          'Dynamic delegates and computed property access stay report-only unknowns.',
          'tsconfig aliases, re-exports and runtime module loading are not resolved.',
          'Dynamic select/include/where shapes cannot be proven into a read tier.',
          'Semantic-read detection only recognises a static time-window plus status-predicate combination.',
          'Raw SQL only matches literal physical table names derived from Prisma @@map or Prisma default table names.',
        ],
        summary: {
          findings: findings.length,
          reportFindings: findings.filter((item) => item.disposition === 'report').length,
          allowedObservations: findings.filter((item) => item.disposition === 'allow').length,
          byKind,
        },
        edgeUsage: {
          // Two independent report-only views: declared edges use the raw
          // import inventory; undeclared directions remain visible alongside
          // their direct cross-domain read/write/raw observations.
          declaredEdges: usage.declaredEdges,
          undeclaredDirections: usage.undeclaredDirections,
        },
        readTiers: {
          kernelFactsAllowed: count('cross-domain-kernel-read', 'allow'),
          crossDomainFactsAllowed: count('cross-domain-fact-read', 'allow'),
          crossDomainFactCandidates: count('cross-domain-fact-read-candidate', 'report'),
          semanticPredicateCandidates: count('cross-domain-semantic-read-candidate', 'report'),
          kernelSelectionViolations: count('cross-domain-kernel-read-violation', 'report'),
          kernelPredicateViolations: count('cross-domain-kernel-predicate-violation', 'report'),
          dynamicReadCandidates: count('cross-domain-read-dynamic', 'report'),
        },
        observedSubdomainWrites: {
          total: count('observed-subdomain-cross-owner-write', 'report'),
          identityOrg: findings.filter(
            (item) =>
              item.kind === 'observed-subdomain-cross-owner-write' &&
              item.sourceDomain === 'identity-org',
          ).length,
          participation: findings.filter(
            (item) =>
              item.kind === 'observed-subdomain-cross-owner-write' &&
              item.sourceDomain === 'participation',
          ).length,
        },
        // R15 —— src/common 治理(架构治理 v4 终审【七】)。恒 report。
        // 与上面的 findings 分开报:common 不是 domains 里的域,混进去会凭空
        // 多出一条 undeclared direction,把既有读数搅浑。
        commonGovernance: {
          scope: COMMON_PREFIX,
          enforcement: 'report-only',
          businessTableAccess: commonCount('common-business-table-access'),
          businessPredicate: commonCount('common-business-predicate'),
          moduleImportEdges: commonCount('common-to-module-import'),
          rawSqlDynamic: commonCount('common-raw-sql-dynamic'),
          kernelFactReadsAllowed: result.commonFindings.filter(
            (item) => item.kind === 'common-kernel-fact-read',
          ).length,
          findings: commonFindings,
        },
        // R10 4-1b —— 状态机治理面(恒 report)。A 类的声明闸在 `--metadata` 里阻断,
        // 这里只给存量分布与升格候选,不参与退出码。
        stateGovernance: stateGovernanceReport(),
        debtRegistry: architectureDebtReport(),
        findings,
      },
      null,
      2,
    ) + '\n',
  );
}

function runDebtCheck(): void {
  const debtRegistry = architectureDebtReport();
  process.stdout.write(
    JSON.stringify(
      {
        mode: 'debt-check',
        enforcement: 'registry-integrity-only',
        // 2026-08-15 由 true 改正为 false。原值与紧接其后的 `process.exitCode = 1`
        // **自相矛盾** —— 它从来就不是 report-only,只是此前没接 CI,于是那句谎话
        // 一直没人撞上(两头不靠:既不阻断也不被跑)。现已接进 Fast checks 的
        // A-metadata gate 且无 `|| true`,故如实标 false。
        // 注意 runViolations 里那处 `reportOnly: true` 是**对的**,不要一起改。
        reportOnly: false,
        debtRegistry,
      },
      null,
      2,
    ) + '\n',
  );
  if (debtRegistry.semanticFieldsComplete !== true) process.exitCode = 1;
}

/**
 * 已知违规的身份集合(callSiteId ∪ legacyCallSiteId)。
 *
 * 两个 id 都收:它们是**同一处调用的两种编码**(当前方案 / 迁移前方案),
 * 641 条实测各自唯一且一一对应。都收进来,是为了将来再换一次 id 方案时
 * 不会整片假红 —— 那正是 legacyCallSiteId 这个字段存在的理由。
 */
function knownDebtIdentities(): Set<string> {
  let doc: unknown;
  try {
    doc = JSON.parse(read(ARCHITECTURE_DEBT_BASELINE));
  } catch (error) {
    throw new Error(
      `${ARCHITECTURE_DEBT_BASELINE} 读不出 / 不是合法 JSON:${String(error)} —— ` +
        '基线读不到时**不得**当成空集合放行:空集合会让每一条现存违规都变成"新增",' +
        '于是闸恒红、下一个人只会把它关掉。fail-closed 的正确形态是抛,不是"当没有"。',
    );
  }
  const raw = objectOf(doc, ARCHITECTURE_DEBT_BASELINE);
  if (!Array.isArray(raw.callSiteIds)) {
    throw new Error(`${ARCHITECTURE_DEBT_BASELINE} 缺 callSiteIds 数组`);
  }
  const set = new Set<string>();
  for (const id of raw.callSiteIds) {
    if (typeof id !== 'string' || id === '') {
      throw new Error(`${ARCHITECTURE_DEBT_BASELINE} 的 callSiteIds 有非字符串 / 空成员`);
    }
    set.add(id);
  }
  return set;
}

/**
 * **禁新增代码债**(v4 §6 元规则)的执行位。
 *
 * 判据:本次扫描出的每一条 finding,其 `callSiteId` 或 `legacyCallSiteId`
 * 必须已在身份基线中。出现两者都不在册的 ⇒ 这是本 PR 新写的违规 ⇒ 红。
 *
 * ⚠️ 与 `--debt-check` 的区别(它们**不能互相顶替**):
 *   `--debt-check`     判「已登记的那些条目,语义字段填全没有」——台账卫生。
 *   `--new-debt-check` 判「有没有出现没登记过的违规」——棘轮本身。
 * 前者此前是唯一接 CI 的那个,于是「禁新增」这句话三个月没有执行位。
 *
 * ⚠️ 已知代价(写在明处,EC-6 的残余误报来源):
 *   `callSiteId = hash(file + AST 路径 + 判别符)` **含文件路径**,所以把一处
 *   既有违规**搬到别的文件**会换身份、被本闸判成新增。那是真实成本,不是缺陷 ——
 *   它与「搬走后顺手写了个新违规」在扫描结果上确实无法区分。
 *   处置路径是既有的:`pnpm docs:boundaries:ids`(--migrate-ids)重映射身份,
 *   基线随之更新,并因基线在 selfGuard 红区而必须过维护者审批。
 */
function runNewDebtCheck(): void {
  const map = domainMap();
  const result = scan(map);
  cycles(map, result.edges, result.findings);
  const all = [...result.findings, ...result.commonFindings];
  let known: Set<string>;
  try {
    known = knownDebtIdentities();
  } catch (error) {
    process.stdout.write(
      JSON.stringify(
        { mode: 'new-debt-check', enforcement: 'ratchet', ok: false, error: String(error) },
        null,
        2,
      ) + '\n',
    );
    process.exitCode = 1;
    return;
  }
  const unknown = all.filter(
    (item) => !known.has(item.callSiteId) && !known.has(item.legacyCallSiteId),
  );
  const ok = unknown.length === 0;
  process.stdout.write(
    JSON.stringify(
      {
        mode: 'new-debt-check',
        // 这里**不是** report-only:它没有 `|| true`,红了就是红了。
        enforcement: 'ratchet',
        baseline: ARCHITECTURE_DEBT_BASELINE,
        ok,
        scanned: all.length,
        baselineSize: known.size,
        unknownCount: unknown.length,
        unknown: unknown.slice(0, 50).map((item) => ({
          kind: item.kind,
          callSiteId: item.callSiteId,
          file: item.location.file,
          line: item.location.line,
          symbol: item.location.symbol,
          sourceDomain: item.sourceDomain,
          targetDomain: item.targetDomain,
          prismaModel: item.prismaModel,
        })),
      },
      null,
      2,
    ) + '\n',
  );
  if (!ok) {
    process.stderr.write(
      `\n✗ 架构债棘轮:发现 ${unknown.length} 条**不在身份基线里**的违规。\n` +
        `  判据:${ARCHITECTURE_DEBT_BASELINE}(按 callSiteId ∪ legacyCallSiteId 比身份集合)\n` +
        '\n' +
        '  这意味着本次改动写出了新的跨域违规。v4 §6 元规则:**禁新增代码债**。\n' +
        '\n' +
        '  正确做法(按代价从低到高):\n' +
        '    ① 走属主导出的 public API / Query API / tx 原语 / owner 谓词,不直接跨域读写;\n' +
        '    ② 若确属域内错切,把代码移回属主模块;\n' +
        '    ③ 若确属「扫描能力提升后新发现的存量历史债」(v4 勘误②允许登记入册)——\n' +
        '       须维护者授权改基线,并在 PR 里写明为什么它是存量而非新增。\n' +
        '\n' +
        '  ⚠️ 基线本身在 selfGuard 红区:把身份加进基线需要维护者授权 + 环境审批,\n' +
        '     且 base-trusted 裁判会按 set-monotonic 棘轮判「集合只减不增」——\n' +
        '     也就是说「顺手把自己登进基线」这条路是被两道闸同时挡住的。\n',
    );
    process.exitCode = 1;
  }
}

/**
 * One-off migration of registered debt onto the normalized-AST identity.
 *
 * The danger this guards against is not a bad hash — it is a *silent* one. If
 * the old ids simply stopped matching, the ratchet would read the result as
 * "every historical debt was repaid, and an equal pile of brand-new debt
 * appeared", which is both false and exactly the shape a real regression takes.
 * So the pass refuses to write unless every registered call-site entry maps to
 * exactly one new identity, and it records the old id under `supersedes` so the
 * migration stays auditable after the fact (§8 身份三层分工).
 *
 * `--check` verifies the mapping without writing; that is the form the selftest
 * and CI run, so a later edit that breaks the identity scheme fails loudly.
 */
function runMigrateIds(write: boolean): void {
  const map = domainMap();
  // 身份对账必须覆盖**全部**已登记债务,含 R15 的 src/common findings。
  // `--violations` 把 commonFindings 单独成块,是为了不污染 edgeUsage / readTiers
  // 的读数(common 不是 domains 里的域);而这里问的是另一个问题 ——
  // 「每条登记在案的 call site 是否还活着」—— 那就该看所有 findings。
  // 少了这一并,登记 R15 的 6 条债会全部落进 unmatched 并把本闸打红(实测退出码 1),
  // 结果是「想登记就登记不了」,债务台账反而被判据的报告结构挡在门外。
  const { findings, commonFindings } = scan(map);
  const allFindings = [...findings, ...commonFindings];
  const byLegacy = new Map<string, Set<string>>();
  for (const item of allFindings) {
    const set = byLegacy.get(item.legacyCallSiteId) ?? new Set<string>();
    set.add(item.callSiteId);
    byLegacy.set(item.legacyCallSiteId, set);
  }
  const registry = JSON.parse(read(ARCHITECTURE_DEBT)) as {
    entries: (JsonRecord & { id: string; callSiteId?: string; supersedes?: string })[];
  };
  const live = new Set(allFindings.map((item) => item.callSiteId));
  const migrated: string[] = [];
  const alreadyCurrent: string[] = [];
  const unmatched: string[] = [];
  const ambiguous: string[] = [];
  const notApplicable: string[] = [];
  for (const entry of registry.entries) {
    if (typeof entry.callSiteId !== 'string') {
      // Domain-level records (undeclared edges) have no call site by
      // construction; they are not in scope for a call-site identity.
      notApplicable.push(entry.id);
      continue;
    }
    // Already on the current scheme. Checking this first is what makes the pass
    // idempotent: after the one-off migration the registered id *is* the new
    // id, and a legacy-only lookup would then report every row as unmatched.
    // In `--check` form this is also the standing invariant worth enforcing —
    // every registered call-site entry still resolves to a live call site.
    if (live.has(entry.callSiteId)) {
      alreadyCurrent.push(entry.id);
      continue;
    }
    const candidates = byLegacy.get(entry.callSiteId);
    if (candidates === undefined) unmatched.push(entry.id);
    else if (candidates.size !== 1) ambiguous.push(entry.id);
    else {
      const next = [...candidates][0];
      if (write) {
        entry.supersedes = entry.callSiteId;
        entry.callSiteId = next;
      }
      migrated.push(entry.id);
    }
  }
  const collisions = new Map<string, number>();
  for (const item of allFindings)
    collisions.set(item.callSiteId, (collisions.get(item.callSiteId) ?? 0) + 1);
  const collided = [...collisions.values()].filter((count) => count > 1).length;
  process.stdout.write(
    JSON.stringify(
      {
        mode: write ? 'migrate-ids' : 'migrate-ids-check',
        totalEntries: registry.entries.length,
        callSiteEntries: registry.entries.length - notApplicable.length,
        alreadyCurrent: alreadyCurrent.length,
        migrated: migrated.length,
        unmatched,
        ambiguous,
        notApplicable: notApplicable.length,
        callSiteIdCollisions: collided,
      },
      null,
      2,
    ) + '\n',
  );
  if (unmatched.length > 0 || ambiguous.length > 0 || collided > 0) {
    process.stderr.write(
      'callSiteId 迁移未达成一一对应,拒绝写入 —— 强行迁移会把台账伪装成「旧债全消失 + 新债全出现」。\n',
    );
    process.exit(1);
  }
  if (write) {
    fs.writeFileSync(
      path.join(ROOT, ARCHITECTURE_DEBT),
      JSON.stringify(registry, null, 2) + '\n',
      'utf8',
    );
  }
}

function main(): void {
  const metadata = process.argv.includes('--metadata');
  const violations = process.argv.includes('--violations');
  const debtCheck = process.argv.includes('--debt-check');
  const migrateIds = process.argv.includes('--migrate-ids');
  const migrateCheck = process.argv.includes('--migrate-ids-check');
  const newDebtCheck = process.argv.includes('--new-debt-check');
  if (
    [metadata, violations, debtCheck, migrateIds, migrateCheck, newDebtCheck].filter(Boolean)
      .length !== 1
  ) {
    process.stderr.write(
      'Usage: pnpm tsx scripts/check-boundaries.ts ' +
        '--metadata | --violations | --debt-check | --new-debt-check | ' +
        '--migrate-ids | --migrate-ids-check\n',
    );
    process.exit(2);
  }
  try {
    if (metadata) runMetadata();
    else if (violations) runViolations();
    else if (migrateIds) runMigrateIds(true);
    else if (migrateCheck) runMigrateIds(false);
    else if (newDebtCheck) runNewDebtCheck();
    else runDebtCheck();
  } catch (error) {
    process.stderr.write(
      'check-boundaries failed: ' + (error instanceof Error ? error.message : String(error)) + '\n',
    );
    process.exit(2);
  }
}

/**
 * Run the *real* delegate/raw resolution over an explicit file set.
 *
 * Exported so `harness-guards.selftest.ts` can drive the bypass-class matrix
 * through the same code path production uses. A selftest that re-implemented
 * the resolver would keep passing after the resolver regressed — the assertion
 * has to be wired to the shipped function, not to a copy of it.
 */
export interface DelegateProbe {
  file: string;
  line: number;
  /** Model name when the access resolved to exactly one Prisma delegate. */
  model: string | null;
  /** True when the receiver is a raw-SQL capable Prisma client. */
  rawCapable: boolean;
}

export function probeDelegateResolution(
  rootNames: string[],
  modelNames: string[],
  compilerOptions: ts.CompilerOptions,
): DelegateProbe[] {
  const program = ts.createProgram({ rootNames, options: compilerOptions });
  const typed: TypedProgram = {
    checker: program.getTypeChecker(),
    sourceOf: (rel) => program.getSourceFile(rel),
  };
  const modelsByName = new Map<string, SchemaModel>(
    modelNames.map((name) => [
      name,
      {
        name,
        fields: [],
        scalarFields: [],
        relationFields: {},
        stateFields: [],
        statusPredicateFields: [],
        dateFields: [],
        tableName: name.toLowerCase(),
        tableNameSource: 'prisma-model-default',
      },
    ]),
  );
  const results: DelegateProbe[] = [];
  for (const source of program.getSourceFiles()) {
    if (source.isDeclarationFile || !rootNames.includes(source.fileName)) continue;
    const visit = (node: ts.Node): void => {
      // `x.member.create(...)` is a CallExpression; `x.$queryRaw\`...\`` is a
      // TaggedTemplateExpression. The raw channel lives entirely in the latter,
      // so a probe that only walked calls would report the raw channel as dead.
      const accessed = ts.isCallExpression(node)
        ? node.expression
        : ts.isTaggedTemplateExpression(node)
          ? node.tag
          : undefined;
      if (accessed !== undefined && ts.isPropertyAccessExpression(accessed)) {
        const receiver = accessed.expression;
        const model = delegateModelOf(typed, receiver, modelsByName);
        const rawCapable = rawCapableClient(typed, receiver);
        if (model !== undefined || rawCapable) {
          results.push({
            file: path.basename(source.fileName),
            line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
            model: model?.name ?? null,
            rawCapable,
          });
        }
      }
      node.forEachChild(visit);
    };
    visit(source);
  }
  return results;
}

export { astPath };

if (require.main === module) main();
