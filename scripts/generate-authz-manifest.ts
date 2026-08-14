/**
 * generate-authz-manifest.ts - Route Authorization Policy manifest generator.
 *
 * Phase 1 has retired the Phase 0 classification overlay. Normalized route
 * declarations in controller code are now the only authorization policy source
 * of truth.
 *
 * Modes:
 *   --write: regenerate ROUTE_AUTHZ from controller declarations (default).
 *   --check: verify full declaration coverage and generated-document freshness.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import {
  AUTHZ_ASSERTION_PATTERNS,
  AUTHZ_VISIBILITY_PREDICATES,
  isRouteAuthzEngine,
  normalizeRouteAuthzDeclaration,
  type RouteAuthzDeclarationFragment,
  type RouteAuthzEngine,
} from '../src/common/authz/authz-context';

const ROOT = path.resolve(__dirname, '..');
const RETIRED_CLASSIFICATION = 'harness/route-authz-classification.json';
const ASSERTION_PATTERNS = 'harness/authz-assertion-patterns.json';
const DOCUMENT = 'docs/ai-harness/ROUTE_AUTHZ.md';
const SCHEMA_VERSION = '1.0.0';
const GENERATOR_VERSION = '2.0.0';
const HTTP_NAMES = new Set(['Get', 'Post', 'Put', 'Patch', 'Delete']);
const HTTP: Record<string, string> = {
  Get: 'GET',
  Post: 'POST',
  Put: 'PUT',
  Patch: 'PATCH',
  Delete: 'DELETE',
};

type Legacy = 'auth' | 'public' | 'rbac' | 'unclassified';
type Mode = 'PUBLIC' | 'LOGIN_ONLY' | 'LOGIN_SCOPED' | 'RESPONSIBILITY_SCOPED' | 'RBAC';

interface Evidence {
  file: string;
  line: number;
  symbol: string;
  assertion: string;
}

interface Endpoint {
  key: string;
  method: string;
  path: string;
  controller: string;
  handler: string;
  file: string;
  line: number;
  tags: string[];
  summary: string;
  legacy: Legacy;
  rbacCodes: string[];
  codePolicy: Policy | null;
  evidence: Evidence[];
}

interface Policy {
  admission: 'app-member' | null;
  mode: Mode;
  codes: Array<{ code: string; scope: string | null }>;
  require: 'all' | 'any';
  scopes: string[];
  engine: RouteAuthzEngine | null;
}

type Surface = 'admin' | 'app' | 'system' | 'auth' | 'open' | 'other';

function assertionPatternsDocument(): string {
  return (
    JSON.stringify(
      {
        version: '1.0.0',
        families: AUTHZ_ASSERTION_PATTERNS,
      },
      null,
      2,
    ) + '\n'
  );
}

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function write(rel: string, value: string): void {
  fs.writeFileSync(path.join(ROOT, rel), value, 'utf8');
}

function hash(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function files(): string[] {
  const output: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = path.posix.join(dir, entry.name);
      if (entry.isDirectory()) visit(rel);
      else if (entry.name.endsWith('.controller.ts')) output.push(rel);
    }
  };
  visit('src');
  return output.sort();
}

function sourceFiles(): string[] {
  const output: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = path.posix.join(dir, entry.name);
      if (entry.isDirectory()) visit(rel);
      else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')) output.push(rel);
    }
  };
  visit('src');
  return output.sort();
}

function digest(input: string[]): string {
  return (
    'sha256:' +
    hash(
      input
        .map((file) => file + '\u0000' + hash(read(file)))
        .sort()
        .join('\n'),
    )
  );
}

export function computeControllerInputDigest(): string {
  return digest([...sourceFiles(), 'test/contract/openapi.contract-spec.ts']);
}

function decorators(node: ts.Node): readonly ts.Decorator[] {
  return ts.canHaveDecorators(node) ? (ts.getDecorators(node) ?? []) : [];
}

function callOf(decorator: ts.Decorator): ts.CallExpression | undefined {
  return ts.isCallExpression(decorator.expression) ? decorator.expression : undefined;
}

function nameOf(decorator: ts.Decorator): string | null {
  const expression = callOf(decorator)?.expression ?? decorator.expression;
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return null;
}

function literalProperty(
  object: ts.ObjectLiteralExpression,
  key: string,
): ts.Expression | undefined {
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const name =
      ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) ? property.name.text : '';
    if (name === key) return property.initializer;
  }
  return undefined;
}

function literalString(expression: ts.Expression | undefined, label: string): string {
  if (
    expression !== undefined &&
    (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression))
  ) {
    return expression.text;
  }
  throw new Error(label + ' must be a string literal');
}

function staticString(expression: ts.Expression | undefined): string | undefined {
  if (expression === undefined) return undefined;
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression))
    return expression.text;
  if (
    ts.isBinaryExpression(expression) &&
    expression.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    const left = staticString(expression.left);
    const right = staticString(expression.right);
    return left === undefined || right === undefined ? undefined : left + right;
  }
  return undefined;
}

function routeAuthzOptions(
  expression: ts.Expression | undefined,
  label: string,
): RouteAuthzDeclarationFragment {
  if (expression === undefined) return {};
  if (!ts.isObjectLiteralExpression(expression))
    throw new Error(label + ' must be an object literal');

  const output: RouteAuthzDeclarationFragment = {};
  for (const property of expression.properties) {
    if (!ts.isPropertyAssignment(property))
      throw new Error(label + ' cannot contain spread properties');
    const key =
      ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) ? property.name.text : '';
    if (key === 'admission') {
      const admission = literalString(property.initializer, label + '.admission');
      if (admission !== 'app-member') throw new Error(label + '.admission is invalid');
      output.admission = admission;
      continue;
    }
    if (key === 'require') {
      const require = literalString(property.initializer, label + '.require');
      if (require !== 'all' && require !== 'any') throw new Error(label + '.require is invalid');
      output.require = require;
      continue;
    }
    if (key === 'scopes') {
      if (!ts.isArrayLiteralExpression(property.initializer))
        throw new Error(label + '.scopes must be an array literal');
      output.scopes = property.initializer.elements.map((item) => {
        if (!ts.isExpression(item)) throw new Error(label + '.scopes cannot contain spread');
        return literalString(item, label + '.scopes item');
      });
      continue;
    }
    if (key === 'engine') {
      const engine = literalString(property.initializer, label + '.engine');
      // Checked against the single source rather than a second literal list:
      // a copy here would let the two vocabularies drift, and this parser is
      // what decides whether a declaration is even readable.
      if (!isRouteAuthzEngine(engine)) throw new Error(label + '.engine is invalid');
      output.engine = engine;
      continue;
    }
    throw new Error(label + ' has unsupported option: ' + key);
  }
  return output;
}

function permissionCode(
  expression: ts.Expression,
  label: string,
): { code: string; scope: string | null } {
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
    return { code: expression.text, scope: null };
  }
  if (!ts.isObjectLiteralExpression(expression))
    throw new Error(label + ' must be a code string or object literal');
  const code = literalString(literalProperty(expression, 'code'), label + '.code');
  const scopeExpression = literalProperty(expression, 'scope');
  const scope =
    scopeExpression === undefined || scopeExpression.kind === ts.SyntaxKind.NullKeyword
      ? null
      : literalString(scopeExpression, label + '.scope');
  return { code, scope };
}

function declarationPolicy(
  classDecorators: readonly ts.Decorator[],
  methodDecorators: readonly ts.Decorator[],
  label: string,
): Policy | null {
  let isPublic = false;
  let hasDeclaration = false;
  const fragments: RouteAuthzDeclarationFragment[] = [];

  for (const decorator of [...methodDecorators, ...classDecorators]) {
    const name = nameOf(decorator);
    if (name === 'Public') {
      isPublic = true;
      hasDeclaration = true;
      continue;
    }
    if (
      !['LoginOnly', 'LoginScoped', 'ResponsibilityScoped', 'RequiresPermission'].includes(
        name ?? '',
      )
    ) {
      continue;
    }
    hasDeclaration = true;
    const call = callOf(decorator);
    if (call === undefined) throw new Error(label + ': ' + name + ' must be called');

    if (name === 'LoginOnly') {
      if (call.arguments.length > 1)
        throw new Error(label + ': LoginOnly accepts at most one options object');
      fragments.push({
        ...routeAuthzOptions(call.arguments[0], label + ': LoginOnly'),
        mode: 'LOGIN_ONLY',
      });
      continue;
    }
    if (name === 'LoginScoped') {
      if (call.arguments.length > 2)
        throw new Error(label + ': LoginScoped accepts a rule name and options');
      const first = call.arguments[0];
      const optionsOnly = first !== undefined && ts.isObjectLiteralExpression(first);
      const options = routeAuthzOptions(
        optionsOnly ? first : call.arguments[1],
        label + ': LoginScoped options',
      );
      const scopes = [...(options.scopes ?? [])];
      if (!optionsOnly && first !== undefined) {
        scopes.push('visibility:' + literalString(first, label + ': LoginScoped rule name'));
      }
      fragments.push({
        ...options,
        ...(scopes.length === 0 ? {} : { scopes }),
        mode: 'LOGIN_SCOPED',
        engine: options.engine ?? 'authz-scoped',
      });
      continue;
    }
    if (name === 'ResponsibilityScoped') {
      if (call.arguments.length > 1)
        throw new Error(label + ': ResponsibilityScoped accepts at most one options object');
      const options = routeAuthzOptions(call.arguments[0], label + ': ResponsibilityScoped');
      fragments.push({
        ...options,
        scopes: [...new Set([...(options.scopes ?? []), 'responsibility'])],
        mode: 'RESPONSIBILITY_SCOPED',
        engine: options.engine ?? 'authz-scoped',
      });
      continue;
    }

    const argumentsList = [...call.arguments];
    const last = argumentsList.at(-1);
    const hasOptions =
      last !== undefined &&
      ts.isObjectLiteralExpression(last) &&
      literalProperty(last, 'code') === undefined;
    const options = routeAuthzOptions(
      hasOptions ? argumentsList.pop() : undefined,
      label + ': RequiresPermission options',
    );
    if (argumentsList.length === 0) throw new Error(label + ': RequiresPermission needs a code');
    fragments.push({
      ...options,
      codes: argumentsList.map((argument, index) =>
        permissionCode(argument, label + ': RequiresPermission[' + index + ']'),
      ),
    });
  }

  if (!hasDeclaration) return null;
  const normalized = normalizeRouteAuthzDeclaration({ isPublic, fragments });
  if (normalized === null) throw new Error(label + ': declaration unexpectedly normalized to null');
  return normalized;
}

function stringArgument(call: ts.CallExpression | undefined): string {
  const first = call?.arguments[0];
  return first !== undefined && ts.isStringLiteral(first) ? first.text : '';
}

function lineOf(node: ts.Node, source: ts.SourceFile): number {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

function property(object: ts.ObjectLiteralExpression, key: string): ts.Expression | undefined {
  for (const item of object.properties) {
    if (!ts.isPropertyAssignment(item)) continue;
    const name = ts.isIdentifier(item.name) || ts.isStringLiteral(item.name) ? item.name.text : '';
    if (name === key) return item.initializer;
  }
  return undefined;
}

function summaryOf(items: readonly ts.Decorator[]): string {
  const decorator = items.find((item) => nameOf(item) === 'ApiOperation');
  if (decorator === undefined) return '';
  const first = callOf(decorator)?.arguments[0];
  if (first === undefined || !ts.isObjectLiteralExpression(first)) return '';
  const summary = property(first, 'summary');
  return staticString(summary) ?? '';
}

function tagsOf(items: readonly ts.Decorator[]): string[] {
  const decorator = items.find((item) => nameOf(item) === 'ApiTags');
  if (decorator === undefined) return [];
  return (
    callOf(decorator)
      ?.arguments.filter(ts.isStringLiteral)
      .map((item) => item.text) ?? []
  );
}

function joinRoute(controller: string, child: string): string {
  const parts = [controller, child].filter(Boolean).map((item) => item.replace(/^\/+|\/+$/g, ''));
  return '/api/' + parts.join('/');
}

function marker(summary: string): { legacy: Legacy; rbacCodes: string[] } {
  if (summary.includes('[auth]')) return { legacy: 'auth', rbacCodes: [] };
  if (summary.includes('[public]')) return { legacy: 'public', rbacCodes: [] };
  const match = /\[rbac:\s*([^\]]+)\]/.exec(summary);
  if (match === null) return { legacy: 'unclassified', rbacCodes: [] };
  return {
    legacy: 'rbac',
    rbacCodes: match[1]
      .split(/[,&]/)
      .map((item) => item.trim())
      .filter(Boolean),
  };
}

function evidenceFor(
  file: string,
  source: ts.SourceFile,
  className: string,
  method: ts.MethodDeclaration,
  summary: string,
): Evidence[] {
  const output: Evidence[] = [
    {
      file,
      line: lineOf(method, source),
      symbol: className + '.' + method.name.getText(source),
      assertion:
        summary.length > 0
          ? 'Handler ApiOperation summary declares legacy policy.'
          : 'Handler has no ApiOperation summary.',
    },
  ];
  let delegate: ts.CallExpression | undefined;
  const visit = (node: ts.Node): void => {
    if (
      delegate === undefined &&
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isPropertyAccessExpression(node.expression.expression) &&
      node.expression.expression.expression.kind === ts.SyntaxKind.ThisKeyword
    ) {
      delegate = node;
    }
    node.forEachChild(visit);
  };
  method.forEachChild(visit);
  if (delegate !== undefined) {
    output.push({
      file,
      line: lineOf(delegate, source),
      symbol: className + '.' + method.name.getText(source),
      assertion: 'Handler delegates to ' + delegate.expression.getText(source) + '.',
    });
  }
  return output;
}

function endpoints(): Endpoint[] {
  const output: Endpoint[] = [];
  for (const file of files()) {
    const source = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      if (!ts.isClassDeclaration(node) || node.name === undefined) {
        node.forEachChild(visit);
        return;
      }
      const classDecorators = decorators(node);
      const controllerDecorator = classDecorators.find((item) => nameOf(item) === 'Controller');
      if (controllerDecorator === undefined) {
        node.forEachChild(visit);
        return;
      }
      const prefix = stringArgument(callOf(controllerDecorator));
      const tags = tagsOf(classDecorators);
      for (const member of node.members) {
        if (!ts.isMethodDeclaration(member) || member.name === undefined) continue;
        const methodDecorators = decorators(member);
        for (const decorator of methodDecorators) {
          const name = nameOf(decorator);
          if (name === null || !HTTP_NAMES.has(name)) continue;
          const route = joinRoute(prefix, stringArgument(callOf(decorator)));
          const summary = summaryOf(methodDecorators);
          const classified = marker(summary);
          const codePolicy = declarationPolicy(
            classDecorators,
            methodDecorators,
            file +
              ':' +
              lineOf(member, source) +
              ' ' +
              node.name.text +
              '.' +
              member.name.getText(source),
          );
          output.push({
            key: HTTP[name] + ' ' + route,
            method: HTTP[name],
            path: route,
            controller: node.name.text,
            handler: member.name.getText(source),
            file,
            line: lineOf(member, source),
            tags,
            summary,
            legacy: classified.legacy,
            rbacCodes: classified.rbacCodes,
            codePolicy,
            evidence: evidenceFor(file, source, node.name.text, member, summary),
          });
        }
      }
      node.forEachChild(visit);
    };
    visit(source);
  }
  const keys = new Set<string>();
  for (const endpoint of output) {
    if (keys.has(endpoint.key)) throw new Error('duplicate parsed endpoint: ' + endpoint.key);
    keys.add(endpoint.key);
  }
  return output.sort((a, b) => a.key.localeCompare(b.key));
}

function contractCount(): number {
  const source = ts.createSourceFile(
    'contract.ts',
    read('test/contract/openapi.contract-spec.ts'),
    ts.ScriptTarget.Latest,
    true,
  );
  let count: number | undefined;
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'EXPECTED_ROUTES' &&
      node.initializer !== undefined
    ) {
      let value: ts.Expression = node.initializer;
      while (
        ts.isAsExpression(value) ||
        ts.isParenthesizedExpression(value) ||
        ts.isSatisfiesExpression(value)
      ) {
        value = value.expression;
      }
      if (ts.isArrayLiteralExpression(value)) {
        if (value.elements.some(ts.isSpreadElement))
          throw new Error('EXPECTED_ROUTES contains spread');
        count = value.elements.length;
      }
    }
    node.forEachChild(visit);
  };
  visit(source);
  if (count === undefined) throw new Error('EXPECTED_ROUTES not found');
  return count;
}

function rejectRetiredOverlay(): void {
  if (fs.existsSync(path.join(ROOT, RETIRED_CLASSIFICATION))) {
    throw new Error('retired classification overlay must not exist: ' + RETIRED_CLASSIFICATION);
  }
}

function validateDeclarations(endpointList: Endpoint[]): void {
  const missing = endpointList
    .filter((endpoint) => endpoint.codePolicy === null)
    .map((endpoint) => endpoint.key);
  if (missing.length > 0) {
    throw new Error(
      'route authorization declaration missing:\n' + missing.map((key) => '- ' + key).join('\n'),
    );
  }
}

function surfaceOf(endpoint: Endpoint): Surface {
  if (endpoint.path.startsWith('/api/admin/')) return 'admin';
  if (endpoint.path.startsWith('/api/app/')) return 'app';
  if (endpoint.path.startsWith('/api/system/')) return 'system';
  if (endpoint.path.startsWith('/api/auth/')) return 'auth';
  if (endpoint.path.startsWith('/api/open/')) return 'open';
  return 'other';
}

function cell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function label(policy: Policy): string {
  return (
    policy.mode +
    '; admission=' +
    (policy.admission ?? '-') +
    '; codes=' +
    (policy.codes.map((item) => item.code).join(',') || '-') +
    '; require=' +
    policy.require +
    '; scopes=' +
    (policy.scopes.join(',') || '-') +
    '; engine=' +
    (policy.engine ?? '-')
  );
}

function declaredPolicy(endpoint: Endpoint): Policy {
  if (endpoint.codePolicy === null)
    throw new Error('decision row lacks route declaration: ' + endpoint.key);
  return endpoint.codePolicy;
}

function decisionRows(auth: Endpoint[]): string[] {
  const rows: string[] = [];
  for (const endpoint of auth.filter((item) => item.path.startsWith('/api/admin/'))) {
    const policy = declaredPolicy(endpoint);
    rows.push(
      '| admin individual | ' +
        endpoint.method +
        ' ' +
        endpoint.path +
        ' | ' +
        cell(label(policy)) +
        ' | ' +
        'code' +
        ' | ' +
        cell(endpoint.evidence.map((item) => item.file + ':' + item.line).join('; ')) +
        ' |',
    );
  }
  const groups = new Map<string, Endpoint[]>();
  for (const endpoint of auth.filter((item) => item.path.startsWith('/api/app/'))) {
    const family = endpoint.tags.join(' / ') || 'untagged';
    const list = groups.get(family) ?? [];
    list.push(endpoint);
    groups.set(family, list);
  }
  for (const [family, endpoints] of [...groups.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    const policy = declaredPolicy(endpoints[0]);
    rows.push(
      '| app tag family | ' +
        cell(family) +
        ' (' +
        endpoints.length +
        ') | ' +
        cell(label(policy)) +
        ' | ' +
        'code' +
        ' | ' +
        cell(endpoints[0].evidence[0].file + ':' + endpoints[0].evidence[0].line) +
        ' |',
    );
  }
  for (const endpoint of auth.filter(
    (item) => item.path.startsWith('/api/auth/') || item.path.startsWith('/api/system/'),
  )) {
    const policy = declaredPolicy(endpoint);
    rows.push(
      '| auth/system individual | ' +
        endpoint.method +
        ' ' +
        endpoint.path +
        ' | ' +
        cell(label(policy)) +
        ' | ' +
        'code' +
        ' | ' +
        cell(endpoint.evidence.map((item) => item.file + ':' + item.line).join('; ')) +
        ' |',
    );
  }
  return rows;
}

function declarationCoverageRows(endpointList: Endpoint[]): string[] {
  const surfaces: Surface[] = ['admin', 'app', 'system', 'auth', 'open', 'other'];
  return surfaces.flatMap((surface) => {
    const routes = endpointList.filter((endpoint) => surfaceOf(endpoint) === surface);
    if (routes.length === 0) return [];
    const declarations = routes.filter((endpoint) => endpoint.codePolicy !== null).length;
    const undeclared = routes.length - declarations;
    return [
      '| ' + surface + ' | ' + routes.length + ' | ' + declarations + ' | ' + undeclared + ' |',
    ];
  });
}

function machineReadableManifest(endpointList: Endpoint[]): string {
  return JSON.stringify(
    {
      schemaVersion: SCHEMA_VERSION,
      generatorVersion: GENERATOR_VERSION,
      inputDigest: computeControllerInputDigest(),
      entries: endpointList.map((endpoint) => ({
        routeKey: endpoint.key,
        controller: endpoint.controller,
        handler: endpoint.handler,
        legacy: endpoint.legacy,
        policy: declaredPolicy(endpoint),
      })),
    },
    null,
    2,
  );
}

function render(endpointList: Endpoint[]): string {
  const counts = endpointList.reduce<Record<string, number>>((all, endpoint) => {
    all[endpoint.legacy] = (all[endpoint.legacy] ?? 0) + 1;
    return all;
  }, {});
  const documentDigest = computeControllerInputDigest();
  const auth = endpointList.filter((endpoint) => endpoint.legacy === 'auth');
  const allRows = endpointList.map((endpoint) => {
    const policy = declaredPolicy(endpoint);
    return (
      '| ' +
      endpoint.method +
      ' | ' +
      cell(endpoint.path) +
      ' | ' +
      cell(endpoint.tags.join(' / ') || '-') +
      ' | ' +
      endpoint.legacy +
      ' | ' +
      cell(label(policy)) +
      ' | ' +
      'code' +
      ' | ' +
      cell(endpoint.evidence.map((item) => item.file + ':' + item.line).join('; ')) +
      ' |'
    );
  });
  return [
    '# Route Authorization Policy',
    '',
    '> Generated by scripts/generate-authz-manifest.ts. Do not hand-edit.',
    '> Phase 1 canonical source: each route has a normalized declaration in controller code. The Phase 0 classification overlay is retired.',
    '',
    '## Declaration conventions',
    '',
    '- Policy scopes are canonicalized only by `normalizeRouteAuthzDeclaration`; endpoint and code-bound scopes share the same rules.',
    '- `visibility:<predicate>` is reserved for a named business-domain visibility predicate. A predicate belongs to the domain owning its implementation, and one name maps to one implementation (predicate ownership). Registered predicates: ' +
      AUTHZ_VISIBILITY_PREDICATES.map((predicate) => '`' + predicate + '`').join(', ') +
      '.',
    '- Bare `visibility`, unregistered predicates, and self-referential `visibility:visibility` are invalid.',
    '- `org-scope` is the sole canonical form for authorization-engine visible-organization expansion, whether endpoint or code-bound; it requires `engine=authz-scoped`.',
    '',
    '## Registry',
    '',
    '| field | value |',
    '|---|---|',
    '| schemaVersion | ' + SCHEMA_VERSION + ' |',
    '| generatorVersion | ' + GENERATOR_VERSION + ' |',
    '| inputDigest | ' + documentDigest + ' |',
    '| endpoint count | ' + endpointList.length + ' |',
    '| legacy [auth] count | ' + auth.length + ' |',
    '| source of truth | normalized controller declarations |',
    '| retired overlay | ' + RETIRED_CLASSIFICATION + ' must be absent |',
    '| per-route truth source | code |',
    '',
    '## Declaration coverage',
    '',
    '> Every route must carry a normalized declaration. `undeclared` is therefore the Guard startup inventory of routes that would be rejected in enforce mode.',
    '',
    '| surface | routes | declared in code | undeclared |',
    '|---|---:|---:|---:|',
    ...declarationCoverageRows(endpointList),
    '',
    '## Legacy declaration summary',
    '',
    '| marker | count |',
    '|---|---:|',
    '| public | ' + (counts.public ?? 0) + ' |',
    '| rbac | ' + (counts.rbac ?? 0) + ' |',
    '| auth | ' + (counts.auth ?? 0) + ' |',
    '| unclassified | ' + (counts.unclassified ?? 0) + ' |',
    '',
    '## Phase 0 decision record',
    '',
    '> All legacy [auth] entries were maintainer-decided in Phase 0 and are now represented by code declarations. Evidence records the handler and its direct delegate; it is not a formal whole-program proof.',
    '',
    '| review scope | endpoint or family | declared policy | status | evidence |',
    '|---|---|---|---|---|',
    ...decisionRows(auth),
    '',
    '## Machine-readable manifest',
    '',
    '> This generated JSON is the R8 scanner input. It preserves the historical `[auth]` review scope without reviving the retired overlay.',
    '',
    '<!-- route-authz-manifest-json',
    machineReadableManifest(endpointList),
    '-->',
    '',
    '## All endpoints',
    '',
    '| method | path | tag family | legacy declaration | structured policy | truth source | evidence |',
    '|---|---|---|---|---|---|',
    ...allRows,
    '',
  ].join('\n');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const checkMode = args.length === 1 && args[0] === '--check';
  const writeMode = args.length === 0 || (args.length === 1 && args[0] === '--write');
  if (!checkMode && !writeMode) {
    throw new Error('use --write or --check; overlay transition modes are retired');
  }

  rejectRetiredOverlay();
  const endpointList = endpoints();
  const expected = contractCount();
  if (endpointList.length !== expected) {
    throw new Error(
      'controller endpoint count ' +
        endpointList.length +
        ' does not equal contract count ' +
        expected,
    );
  }
  validateDeclarations(endpointList);
  const next = render(endpointList);
  const assertionPatterns = assertionPatternsDocument();
  if (checkMode) {
    if (!fs.existsSync(path.join(ROOT, DOCUMENT)) || read(DOCUMENT) !== next) {
      throw new Error(DOCUMENT + ' is stale; run generator with --write');
    }
    if (
      !fs.existsSync(path.join(ROOT, ASSERTION_PATTERNS)) ||
      read(ASSERTION_PATTERNS) !== assertionPatterns
    ) {
      throw new Error(ASSERTION_PATTERNS + ' is stale; run generator with --write');
    }
    process.stdout.write(
      'Route Authorization Policy current: ' +
        endpointList.length +
        ' endpoints, all code-declared.\n',
    );
    return;
  }
  write(DOCUMENT, next);
  write(ASSERTION_PATTERNS, assertionPatterns);
  process.stdout.write(
    'Generated Route Authorization Policy: ' +
      endpointList.length +
      ' endpoints, all code-declared.\n',
  );
}

void main().catch((error) => {
  process.stderr.write(
    'generate-authz-manifest failed: ' +
      (error instanceof Error ? error.message : String(error)) +
      '\n',
  );
  process.exit(1);
});
