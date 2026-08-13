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
const VERSION = '1.0.0';

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

interface ImportEdge {
  from: string;
  to: string;
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

function stateRegistryErrors(errors: string[]): void {
  if (!exists(STATE_MACHINES)) return;
  const raw = objectOf(JSON.parse(read(STATE_MACHINES)) as unknown, STATE_MACHINES);
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
  const actual: string[] = [];
  for (const [index, item] of raw.entries.entries()) {
    const entry = objectOf(item, STATE_MACHINES + '.entries[' + index + ']');
    const model = stringOf(entry.model, 'state model');
    const field = stringOf(entry.field, 'state field');
    if (entry.governanceStatus !== 'inventory')
      errors.push('state entry ' + model + '.' + field + ' must be inventory');
    actual.push(model + '.' + field);
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
    const expectedPrimitives = [
      'app-identity.resolver',
      'member-lifecycle-lock',
      'membership-term-state-machine',
      'wecom-identity-revoke',
    ];
    const primitiveNames = map.kernel.primitives?.map((item) => String(item.name ?? '')) ?? [];
    if (
      primitiveNames.length !== expectedPrimitives.length ||
      expectedPrimitives.some((name) => !primitiveNames.includes(name))
    ) {
      errors.push('kernel.primitives must declare exactly the four Phase 0 primitives');
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

function scan(map: DomainMap): { findings: Finding[]; edges: ImportEdge[]; inputDigest: string } {
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
    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const targetModule = moduleForImport(file, node.moduleSpecifier.text);
        if (targetModule !== null && targetModule !== moduleName) {
          const targetOwner = map.moduleOwnership[targetModule];
          if (targetOwner !== undefined && targetOwner.domain !== sourceDomain) {
            const edge: ImportEdge = {
              from: sourceDomain,
              to: targetOwner.domain,
              file,
              line: lineOf(node, source),
              symbol: symbolOf(node),
              text: node.moduleSpecifier.text,
            };
            edges.push(edge);
            if (!allowedEdge(map, sourceDomain, targetOwner.domain)) {
              emit('cross-domain-import', 'report', targetOwner.domain, null, 'import', node, {
                targetModule,
                specifier: node.moduleSpecifier.text,
              });
            }
          }
        }
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
  return { findings, edges, inputDigest: 'sha256:' + hash(inputs.sort().join('\n')) };
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
        reportOnly: true,
        debtRegistry,
      },
      null,
      2,
    ) + '\n',
  );
  if (debtRegistry.semanticFieldsComplete !== true) process.exitCode = 1;
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
  const { findings } = scan(map);
  const byLegacy = new Map<string, Set<string>>();
  for (const item of findings) {
    const set = byLegacy.get(item.legacyCallSiteId) ?? new Set<string>();
    set.add(item.callSiteId);
    byLegacy.set(item.legacyCallSiteId, set);
  }
  const registry = JSON.parse(read(ARCHITECTURE_DEBT)) as {
    entries: (JsonRecord & { id: string; callSiteId?: string; supersedes?: string })[];
  };
  const live = new Set(findings.map((item) => item.callSiteId));
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
  for (const item of findings)
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
  if ([metadata, violations, debtCheck, migrateIds, migrateCheck].filter(Boolean).length !== 1) {
    process.stderr.write(
      'Usage: pnpm tsx scripts/check-boundaries.ts ' +
        '--metadata | --violations | --debt-check | --migrate-ids | --migrate-ids-check\n',
    );
    process.exit(2);
  }
  try {
    if (metadata) runMetadata();
    else if (violations) runViolations();
    else if (migrateIds) runMigrateIds(true);
    else if (migrateCheck) runMigrateIds(false);
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
