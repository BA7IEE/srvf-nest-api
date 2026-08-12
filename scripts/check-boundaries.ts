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

function prismaReceiver(expression: ts.Expression): boolean {
  const root = rootOf(expression);
  const text = expression.getText().replace(/\s+/g, '');
  return (
    root.includes('prisma') ||
    root === 'tx' ||
    root === 'transaction' ||
    root === 'client' ||
    root === 'db' ||
    /(?:^|\.)(prisma|tx|transaction|client|db)(?:\.|$)/.test(text)
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
  ordinal: number,
  details: JsonRecord,
): Finding {
  const symbol = symbolOf(node);
  return {
    kind,
    disposition,
    sourceDomain,
    targetDomain,
    prismaModel,
    operation,
    location: { file, line: lineOf(node, source), symbol },
    callSiteId:
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
    const source = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true);
    const emit = (
      kind: string,
      disposition: 'report' | 'allow',
      targetDomain: string,
      model: string | null,
      operation: string,
      node: ts.Node,
      details: JsonRecord,
    ): void => {
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
          next(file, symbolOf(node)),
          details,
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
      if (!prismaReceiver(receiver)) return;
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
          emit('raw-cross-domain-table', 'report', owner.domain, model.name, 'raw', node, {
            physicalTable: model.tableName,
            physicalTableSource: model.tableNameSource,
            sqlHasInterpolation: sql.hasInterpolation,
          });
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
        const delegate = propertyOf(node.expression.expression);
        const receiver = ts.isPropertyAccessExpression(node.expression.expression)
          ? node.expression.expression.expression
          : undefined;
        const model = delegate === null ? undefined : delegates.get(delegate);
        if (model !== undefined && receiver !== undefined && prismaReceiver(receiver)) {
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
              emitRead(model, selection, predicates, operation, node, model.name);
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
            callSiteId: 'cs:' + shortHash(edge.file + '|' + edge.line + '|' + key),
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

function main(): void {
  const metadata = process.argv.includes('--metadata');
  const violations = process.argv.includes('--violations');
  if (metadata === violations) {
    process.stderr.write('Usage: pnpm tsx scripts/check-boundaries.ts --metadata | --violations\n');
    process.exit(2);
  }
  try {
    if (metadata) runMetadata();
    else runViolations();
  } catch (error) {
    process.stderr.write(
      'check-boundaries failed: ' + (error instanceof Error ? error.message : String(error)) + '\n',
    );
    process.exit(2);
  }
}

if (require.main === module) main();
