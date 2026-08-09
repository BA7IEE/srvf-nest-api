/**
 * check-boundaries.ts - Phase 0 architecture boundary inventory.
 *
 * Report-only scanner with two physically separate entrances:
 *   --metadata validates registry completeness and freshness.
 *   --violations inventories current findings and always stays report-only.
 *
 * Known gaps: aliases/destructuring/wrappers and variable forwarding; dynamic
 * delegates and SQL; tsconfig aliases/re-export chains/runtime loading; semantic
 * read intent; and non-literal raw SQL. Each is reported as uncertain rather
 * than treated as safe.
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
const VERSION = '1.0.0';

type JsonRecord = Record<string, unknown>;

interface SchemaModel {
  name: string;
  fields: string[];
  stateFields: string[];
  tableName: string;
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

interface DomainMap {
  schemaVersion: string;
  generatorVersion: string;
  inputDigest: string;
  domains: JsonRecord;
  moduleOwnership: Record<string, Owner>;
  modelOwnership: Record<string, Owner>;
  allowedEdges: Edge[];
  kernel: {
    confirmed?: boolean;
    primitives?: JsonRecord[];
    kernelReadFields?: { confirmed?: boolean; fields?: Record<string, string[]> };
    kernelPredicateFields?: { confirmed?: boolean; fields?: Record<string, string[]> };
  };
  crossDomainReadAllowlist?: JsonRecord[];
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
  const models: SchemaModel[] = [];
  const source = read('prisma/schema.prisma');
  const re = /^model\s+([A-Za-z][A-Za-z0-9_]*)\s*\{([\s\S]*?)^\}/gm;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    const fields: string[] = [];
    const stateFields: string[] = [];
    for (const line of match[2].split('\n')) {
      const field =
        /^\s*([A-Za-z][A-Za-z0-9_]*)\s+([A-Za-z][A-Za-z0-9_]*)(?:\?|\[\])?(?:\s|$)/.exec(line);
      if (field === null) continue;
      fields.push(field[1]);
      if (field[2] === 'String' && stateLikeString(field[1])) stateFields.push(field[1]);
    }
    const mapped = /@@map\(\s*"([^"]+)"\s*\)/.exec(match[2]);
    models.push({
      name: match[1],
      fields: fields.sort(),
      stateFields: stateFields.sort(),
      tableName: mapped?.[1] ?? match[1],
    });
  }
  return models.sort((a, b) => a.name.localeCompare(b.name));
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
    confirmed: typeof record.confirmed === 'boolean' ? record.confirmed : undefined,
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
    return {
      from: stringOf(record.from, 'allowedEdges[' + index + '].from'),
      to: stringOf(record.to, 'allowedEdges[' + index + '].to'),
      kind: typeof record.kind === 'string' ? record.kind : undefined,
    };
  });
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
    confirmed: typeof record.confirmed === 'boolean' ? record.confirmed : undefined,
    fields,
  };
}

function domainMap(): DomainMap {
  const raw = objectOf(JSON.parse(read(DOMAIN_MAP)) as unknown, DOMAIN_MAP);
  const kernelRaw = objectOf(raw.kernel, 'kernel');
  const primitives = Array.isArray(kernelRaw.primitives)
    ? kernelRaw.primitives.map((item, index) => objectOf(item, 'kernel.primitives[' + index + ']'))
    : [];
  return {
    schemaVersion: stringOf(raw.schemaVersion, 'schemaVersion'),
    generatorVersion: stringOf(raw.generatorVersion, 'generatorVersion'),
    inputDigest: stringOf(raw.inputDigest, 'inputDigest'),
    domains: objectOf(raw.domains, 'domains'),
    moduleOwnership: ownershipMap(raw.moduleOwnership, 'moduleOwnership'),
    modelOwnership: ownershipMap(raw.modelOwnership, 'modelOwnership'),
    allowedEdges: edgeList(raw.allowedEdges),
    kernel: {
      confirmed: typeof kernelRaw.confirmed === 'boolean' ? kernelRaw.confirmed : undefined,
      primitives,
      kernelReadFields: kernelFields(kernelRaw.kernelReadFields, 'kernel.kernelReadFields'),
      kernelPredicateFields: kernelFields(
        kernelRaw.kernelPredicateFields,
        'kernel.kernelPredicateFields',
      ),
    },
    crossDomainReadAllowlist: Array.isArray(raw.crossDomainReadAllowlist)
      ? raw.crossDomainReadAllowlist.map((item, index) =>
          objectOf(item, 'crossDomainReadAllowlist[' + index + ']'),
        )
      : [],
  };
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
    if (map.kernel.confirmed !== false) errors.push('kernel.confirmed must be false');
    // 2026-08-10 maintainer decision confirms these two field-list proposals only.
    // The kernel root and its four primitives remain separately pending.
    if (map.kernel.kernelReadFields?.confirmed !== true)
      errors.push('kernelReadFields.confirmed must be true after maintainer decision');
    if (map.kernel.kernelPredicateFields?.confirmed !== true) {
      errors.push('kernelPredicateFields.confirmed must be true after maintainer decision');
    }
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
    if (!ts.isPropertyAssignment(property)) continue;
    const key =
      ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) ? property.name.text : '';
    if (key === name) return property.initializer;
  }
  return undefined;
}

function selectedFields(call: ts.CallExpression): string[] | null {
  const first = call.arguments[0];
  if (first === undefined || !ts.isObjectLiteralExpression(first)) return null;
  const select = objectProperty(first, 'select');
  if (select === undefined) return [];
  if (!ts.isObjectLiteralExpression(select)) return null;
  const result: string[] = [];
  for (const property of select.properties) {
    if (
      ts.isPropertyAssignment(property) &&
      (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
    ) {
      result.push(property.name.text);
    } else if (ts.isShorthandPropertyAssignment(property)) {
      result.push(property.name.text);
    }
  }
  return result.sort();
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

function literalSql(node: ts.Expression | ts.TaggedTemplateExpression): string | null {
  if (ts.isTaggedTemplateExpression(node)) {
    if (ts.isNoSubstitutionTemplateLiteral(node.template)) return node.template.text;
    if (ts.isTemplateExpression(node.template)) {
      return (
        node.template.head.text +
        node.template.templateSpans.map((span) => span.literal.text).join('')
      );
    }
  }
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return null;
}

function escapeRegex(value: string): string {
  return value.replace(/[\\^$.*+?(){}|[\]]/g, '\\$&');
}

function allowedEdge(map: DomainMap, from: string, to: string): boolean {
  return map.allowedEdges.some((edge) => edge.from === from && edge.to === to);
}

function allowedRead(
  map: DomainMap,
  source: string,
  target: string,
  model: string,
  operation: string,
): boolean {
  return (map.crossDomainReadAllowlist ?? []).some(
    (entry) =>
      entry.sourceDomain === source &&
      entry.targetDomain === target &&
      entry.prismaModel === model &&
      (entry.operation === undefined || entry.operation === operation),
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
        if (tableRe.test(sql)) {
          emit('raw-cross-domain-table', 'report', owner.domain, model.name, 'raw', node, {
            physicalTable: model.tableName,
          });
        }
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
            } else if (reads.has(operation) && targetOwner.domain !== sourceDomain) {
              const selected = selectedFields(node);
              const kernel = map.kernel.kernelReadFields?.fields?.[model.name] ?? [];
              if (
                selected !== null &&
                selected.length > 0 &&
                selected.every((field) => kernel.includes(field))
              ) {
                emit(
                  'cross-domain-kernel-read',
                  'allow',
                  targetOwner.domain,
                  model.name,
                  operation,
                  node,
                  {
                    selectedFields: selected,
                  },
                );
              } else if (
                allowedRead(map, sourceDomain, targetOwner.domain, model.name, operation)
              ) {
                emit(
                  'cross-domain-fact-read',
                  'allow',
                  targetOwner.domain,
                  model.name,
                  operation,
                  node,
                  {
                    selectedFields: selected,
                  },
                );
              } else {
                emit(
                  selected === null
                    ? 'cross-domain-read-dynamic'
                    : 'cross-domain-semantic-read-candidate',
                  'report',
                  targetOwner.domain,
                  model.name,
                  operation,
                  node,
                  { selectedFields: selected },
                );
              }
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
          'Dynamic delegates and computed SQL stay report-only unknowns.',
          'tsconfig aliases, re-exports and runtime module loading are not resolved.',
          'Read tiers are structural candidates, not semantic proof.',
          'Raw SQL only matches literal physical table names from Prisma @@map.',
        ],
        summary: {
          findings: findings.length,
          reportFindings: findings.filter((item) => item.disposition === 'report').length,
          allowedObservations: findings.filter((item) => item.disposition === 'allow').length,
          byKind,
        },
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
