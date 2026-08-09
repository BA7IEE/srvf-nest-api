/**
 * generate-authz-manifest.ts - Phase 0 Route Authorization Policy inventory.
 *
 * It inventories controller routes only. No decorator, Guard, ALS, or runtime
 * authorization behavior is changed here.
 *
 * Modes:
 *   --bootstrap: create the provisional classification overlay and ROUTE_AUTHZ.
 *   --write: regenerate ROUTE_AUTHZ from the existing overlay.
 *   --check: verify controller coverage and generated-document freshness.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

const ROOT = path.resolve(__dirname, '..');
const CLASSIFICATION = 'harness/route-authz-classification.json';
const DOCUMENT = 'docs/ai-harness/ROUTE_AUTHZ.md';
const VERSION = '1.0.0';
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
  evidence: Evidence[];
}

interface Policy {
  admission: 'app-member' | null;
  mode: Mode;
  codes: Array<{ code: string; scope: string | null }>;
  require: 'all' | 'any';
  scopes: string[];
  engine: 'rbac-global' | 'authz-scoped' | null;
}

interface OverlayEntry {
  routeKey: string;
  method: string;
  path: string;
  controller: string;
  handler: string;
  tags: string[];
  sourceSummary: string;
  policy: Policy;
  decisionStatus: 'needs-decision';
  evidence: Evidence[];
  implementationSignals: string[];
  unresolvedImplementationEvidence: string[];
}

interface Overlay {
  schemaVersion: string;
  generatorVersion: string;
  inputDigest: string;
  truthSource: 'classification-overlay';
  coverage: { endpoints: number; authDeclared: number };
  entries: OverlayEntry[];
}

interface ClassInfo {
  name: string;
  file: string;
  source: ts.SourceFile;
  declaration: ts.ClassDeclaration;
  methods: Map<string, ts.MethodDeclaration>;
  dependencies: Map<string, string>;
}

interface AuthorizationSignal {
  kind: 'app-identity' | 'rbac' | 'authz' | 'visibility-scope';
  file: string;
  line: number;
  symbol: string;
  action: string | null;
  call: string;
}

interface ClassificationResult {
  policy: Policy;
  evidence: Evidence[];
  implementationSignals: string[];
  unresolvedImplementationEvidence: string[];
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

function stringArgument(call: ts.CallExpression | undefined): string {
  const first = call?.arguments[0];
  return first !== undefined && ts.isStringLiteral(first) ? first.text : '';
}

function lineOf(node: ts.Node, source: ts.SourceFile): number {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

let classCache: Map<string, ClassInfo> | undefined;

function typeName(type: ts.TypeNode | undefined, source: ts.SourceFile): string | undefined {
  if (type === undefined || !ts.isTypeReferenceNode(type)) return undefined;
  if (ts.isIdentifier(type.typeName)) return type.typeName.text;
  return type.typeName.getText(source).split('.').at(-1);
}

function classes(): Map<string, ClassInfo> {
  if (classCache !== undefined) return classCache;
  const output = new Map<string, ClassInfo>();
  for (const file of sourceFiles()) {
    const source = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      if (!ts.isClassDeclaration(node) || node.name === undefined) {
        node.forEachChild(visit);
        return;
      }
      const methods = new Map<string, ts.MethodDeclaration>();
      const dependencies = new Map<string, string>();
      for (const member of node.members) {
        if (ts.isMethodDeclaration(member) && member.name !== undefined) {
          methods.set(member.name.getText(source), member);
          continue;
        }
        if (!ts.isConstructorDeclaration(member)) continue;
        for (const parameter of member.parameters) {
          if (!ts.isIdentifier(parameter.name)) continue;
          const propertyParameter = (parameter.modifiers ?? []).some((modifier) =>
            [
              ts.SyntaxKind.PrivateKeyword,
              ts.SyntaxKind.ProtectedKeyword,
              ts.SyntaxKind.PublicKeyword,
              ts.SyntaxKind.ReadonlyKeyword,
            ].includes(modifier.kind),
          );
          const dependency = typeName(parameter.type, source);
          if (propertyParameter && dependency !== undefined)
            dependencies.set(parameter.name.text, dependency);
        }
      }
      if (!output.has(node.name.text)) {
        output.set(node.name.text, {
          name: node.name.text,
          file,
          source,
          declaration: node,
          methods,
          dependencies,
        });
      }
      node.forEachChild(visit);
    };
    visit(source);
  }
  classCache = output;
  return output;
}

function propertyChain(expression: ts.Expression): string[] {
  if (expression.kind === ts.SyntaxKind.ThisKeyword) return ['this'];
  if (ts.isIdentifier(expression)) return [expression.text];
  if (ts.isPropertyAccessExpression(expression))
    return [...propertyChain(expression.expression), expression.name.text];
  return [];
}

function literalAction(call: ts.CallExpression): string | null {
  const action = call.arguments[1];
  if (action === undefined) return null;
  if (ts.isStringLiteral(action) || ts.isNoSubstitutionTemplateLiteral(action)) return action.text;
  return null;
}

function classifyEndpoint(endpoint: Endpoint): ClassificationResult {
  const index = classes();
  const root = index.get(endpoint.controller);
  const evidence = [...endpoint.evidence];
  const signals: AuthorizationSignal[] = [];
  const unresolved = new Set<string>();
  const visited = new Set<string>();

  const addEvidence = (item: Evidence): void => {
    if (
      !evidence.some(
        (existing) =>
          existing.file === item.file &&
          existing.line === item.line &&
          existing.assertion === item.assertion,
      )
    ) {
      evidence.push(item);
    }
  };

  const addSignal = (
    kind: AuthorizationSignal['kind'],
    info: ClassInfo,
    methodName: string,
    call: ts.CallExpression,
  ): void => {
    const action = kind === 'app-identity' ? null : literalAction(call);
    const callText = call.expression.getText(info.source);
    const line = lineOf(call, info.source);
    if (
      !signals.some(
        (signal) => signal.kind === kind && signal.file === info.file && signal.line === line,
      )
    ) {
      signals.push({
        kind,
        file: info.file,
        line,
        symbol: info.name + '.' + methodName,
        action,
        call: callText,
      });
      addEvidence({
        file: info.file,
        line,
        symbol: info.name + '.' + methodName,
        assertion:
          kind === 'app-identity'
            ? 'Implementation invokes ' + callText + ' for app admission.'
            : action === null
              ? 'Implementation invokes ' + callText + ' with a non-literal action.'
              : 'Implementation invokes ' + callText + " for '" + action + "'.",
      });
    }
    if (kind !== 'app-identity' && action === null) {
      unresolved.add(
        info.file + ':' + line + ' uses a non-literal authorization action (' + callText + ').',
      );
    }
  };

  const visitMethod = (
    info: ClassInfo,
    methodName: string,
    trail: string[],
    depth: number,
  ): void => {
    const method = info.methods.get(methodName);
    const key = info.name + '.' + methodName;
    if (method === undefined || visited.has(key) || depth > 4) return;
    visited.add(key);
    if (depth > 0) {
      addEvidence({
        file: info.file,
        line: lineOf(method, info.source),
        symbol: key,
        assertion: 'Reached through static call chain: ' + trail.join(' -> ') + '.',
      });
    }
    const inspect = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const chain = propertyChain(node.expression);
        const operation = chain.at(-1);
        const receiver = chain.at(-2);
        if (receiver === 'rbac' && operation === 'can') addSignal('rbac', info, methodName, node);
        if (receiver === 'authz' && (operation === 'can' || operation === 'explain'))
          addSignal('authz', info, methodName, node);
        if (receiver === 'authz' && operation === 'getVisibleOrganizationScope')
          addSignal('visibility-scope', info, methodName, node);

        if (chain[0] === 'this') {
          if (chain.length === 2) {
            visitMethod(info, chain[1], [...trail, key + '.' + chain[1]], depth + 1);
          } else if (chain.length === 3) {
            const dependencyName = info.dependencies.get(chain[1]);
            const target = dependencyName === undefined ? undefined : index.get(dependencyName);
            if (dependencyName === 'AppIdentityResolver' && chain[2] === 'resolve') {
              addSignal('app-identity', info, methodName, node);
            }
            if (
              target !== undefined &&
              !['PrismaService', 'RbacService', 'AuthzService', 'AppIdentityResolver'].includes(
                dependencyName ?? '',
              )
            ) {
              visitMethod(
                target,
                chain[2],
                [...trail, key + '.' + chain[1] + '.' + chain[2]],
                depth + 1,
              );
            }
          }
        }
      }
      node.forEachChild(inspect);
    };
    method.forEachChild(inspect);
  };

  if (root === undefined) {
    unresolved.add(
      'Controller class could not be resolved from source index: ' + endpoint.controller + '.',
    );
  } else {
    visitMethod(root, endpoint.handler, [endpoint.controller + '.' + endpoint.handler], 0);
  }

  const actionCodes = [
    ...new Set(
      signals
        .filter(
          (signal) => (signal.kind === 'rbac' || signal.kind === 'authz') && signal.action !== null,
        )
        .map((signal) => signal.action as string),
    ),
  ].sort();
  const hasRbac = signals.some((signal) => signal.kind === 'rbac');
  const hasScoped = signals.some(
    (signal) => signal.kind === 'authz' || signal.kind === 'visibility-scope',
  );
  const hasIdentity = signals.some((signal) => signal.kind === 'app-identity');
  const appRoute = endpoint.path.startsWith('/api/app/');
  const scopes = signals.some((signal) => signal.kind === 'visibility-scope')
    ? ['visibility:organization']
    : [];
  let mode: Mode = 'LOGIN_ONLY';
  let engine: Policy['engine'] = null;
  if (hasScoped || appRoute) {
    mode = 'LOGIN_SCOPED';
    engine = 'authz-scoped';
  } else if (hasRbac) {
    mode = 'RBAC';
    engine = 'rbac-global';
  }
  if (signals.length === 0)
    unresolved.add(
      'No recognized authorization signal found in the explored static implementation path.',
    );
  if (appRoute && !hasIdentity)
    unresolved.add(
      'App admission is inferred from the route surface; resolver path still needs maintainer review.',
    );
  if (scopes.length === 0)
    unresolved.add(
      'No statically provable scope was inferred; empty scopes are provisional pending review.',
    );

  return {
    policy: {
      admission: appRoute ? 'app-member' : null,
      mode,
      codes: actionCodes.map((code) => ({ code, scope: null })),
      require: 'all',
      scopes,
      engine,
    },
    evidence,
    implementationSignals: signals
      .sort((left, right) =>
        (left.file + ':' + left.line).localeCompare(right.file + ':' + right.line),
      )
      .map(
        (signal) =>
          signal.kind +
          ' ' +
          signal.file +
          ':' +
          signal.line +
          ' ' +
          signal.call +
          (signal.action === null ? ' [dynamic action]' : " ['" + signal.action + "']"),
      ),
    unresolvedImplementationEvidence: [...unresolved].sort(),
  };
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
  return summary !== undefined && ts.isStringLiteral(summary) ? summary.text : '';
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

function bootstrap(endpointList: Endpoint[]): Overlay {
  const auth = endpointList.filter((endpoint) => endpoint.legacy === 'auth');
  return {
    schemaVersion: VERSION,
    generatorVersion: VERSION,
    inputDigest: computeControllerInputDigest(),
    truthSource: 'classification-overlay',
    coverage: { endpoints: endpointList.length, authDeclared: auth.length },
    entries: auth.map((endpoint) => {
      const classified = classifyEndpoint(endpoint);
      return {
        routeKey: endpoint.key,
        method: endpoint.method,
        path: endpoint.path,
        controller: endpoint.controller,
        handler: endpoint.handler,
        tags: endpoint.tags,
        sourceSummary: endpoint.summary,
        policy: classified.policy,
        decisionStatus: 'needs-decision',
        evidence: classified.evidence,
        implementationSignals: classified.implementationSignals,
        unresolvedImplementationEvidence: classified.unresolvedImplementationEvidence,
      };
    }),
  };
}

function overlay(): Overlay {
  const raw = JSON.parse(read(CLASSIFICATION)) as unknown;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error(CLASSIFICATION + ' must be an object');
  const value = raw as Overlay;
  if (value.schemaVersion !== VERSION || value.generatorVersion !== VERSION)
    throw new Error('classification version mismatch');
  if (value.truthSource !== 'classification-overlay')
    throw new Error('classification truthSource mismatch');
  if (!Array.isArray(value.entries)) throw new Error('classification entries missing');
  return value;
}

function validate(endpointList: Endpoint[], input: Overlay): void {
  const auth = endpointList.filter((endpoint) => endpoint.legacy === 'auth');
  if (input.inputDigest !== computeControllerInputDigest())
    throw new Error('classification inputDigest stale');
  if (
    input.coverage.endpoints !== endpointList.length ||
    input.coverage.authDeclared !== auth.length
  ) {
    throw new Error('classification coverage stale');
  }
  const actual = new Map(auth.map((endpoint) => [endpoint.key, endpoint]));
  const declared = new Map<string, OverlayEntry>();
  for (const entry of input.entries) {
    if (declared.has(entry.routeKey))
      throw new Error('duplicate classification entry: ' + entry.routeKey);
    if (!actual.has(entry.routeKey))
      throw new Error('stale classification entry: ' + entry.routeKey);
    if (entry.decisionStatus !== 'needs-decision')
      throw new Error('decision status must remain needs-decision: ' + entry.routeKey);
    if (
      entry.policy === undefined ||
      !Object.hasOwn(entry.policy, 'admission') ||
      !['PUBLIC', 'LOGIN_ONLY', 'LOGIN_SCOPED', 'RESPONSIBILITY_SCOPED', 'RBAC'].includes(
        entry.policy.mode,
      ) ||
      !Array.isArray(entry.policy.codes) ||
      !entry.policy.codes.every(
        (item) =>
          typeof item.code === 'string' && (typeof item.scope === 'string' || item.scope === null),
      ) ||
      !Array.isArray(entry.policy.scopes) ||
      !entry.policy.scopes.every((scope) => typeof scope === 'string') ||
      (entry.policy.require !== 'all' && entry.policy.require !== 'any') ||
      !Object.hasOwn(entry.policy, 'engine') ||
      !['rbac-global', 'authz-scoped', null].includes(entry.policy.engine) ||
      !Array.isArray(entry.evidence) ||
      entry.evidence.length === 0 ||
      !entry.evidence.every(
        (item) =>
          typeof item.file === 'string' &&
          Number.isInteger(item.line) &&
          typeof item.symbol === 'string',
      ) ||
      !Array.isArray(entry.implementationSignals) ||
      !Array.isArray(entry.unresolvedImplementationEvidence)
    ) {
      throw new Error('incomplete structured policy/evidence: ' + entry.routeKey);
    }
    declared.set(entry.routeKey, entry);
  }
  for (const endpoint of auth) {
    if (!declared.has(endpoint.key))
      throw new Error('missing classification entry: ' + endpoint.key);
  }
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

function decisionRows(auth: Endpoint[], byKey: Map<string, OverlayEntry>): string[] {
  const rows: string[] = [];
  for (const endpoint of auth.filter((item) => item.path.startsWith('/api/admin/'))) {
    const entry = byKey.get(endpoint.key);
    if (entry === undefined) continue;
    rows.push(
      '| admin individual | ' +
        endpoint.method +
        ' ' +
        endpoint.path +
        ' | ' +
        cell(label(entry.policy)) +
        ' | needs-decision | ' +
        cell(entry.evidence.map((item) => item.file + ':' + item.line).join('; ')) +
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
    const entry = byKey.get(endpoints[0].key);
    if (entry === undefined) continue;
    rows.push(
      '| app tag family | ' +
        cell(family) +
        ' (' +
        endpoints.length +
        ') | ' +
        cell(label(entry.policy)) +
        ' | needs-decision | ' +
        cell(entry.evidence[0].file + ':' + entry.evidence[0].line) +
        ' |',
    );
  }
  for (const endpoint of auth.filter(
    (item) => item.path.startsWith('/api/auth/') || item.path.startsWith('/api/system/'),
  )) {
    const entry = byKey.get(endpoint.key);
    if (entry === undefined) continue;
    rows.push(
      '| auth/system individual | ' +
        endpoint.method +
        ' ' +
        endpoint.path +
        ' | ' +
        cell(label(entry.policy)) +
        ' | needs-decision | ' +
        cell(entry.evidence.map((item) => item.file + ':' + item.line).join('; ')) +
        ' |',
    );
  }
  return rows;
}

function render(endpointList: Endpoint[], input: Overlay): string {
  const byKey = new Map<string, OverlayEntry>(
    input.entries.map((entry) => [entry.routeKey, entry]),
  );
  const counts = endpointList.reduce<Record<string, number>>((all, endpoint) => {
    all[endpoint.legacy] = (all[endpoint.legacy] ?? 0) + 1;
    return all;
  }, {});
  const documentDigest = digest([
    ...sourceFiles(),
    'test/contract/openapi.contract-spec.ts',
    CLASSIFICATION,
  ]);
  const auth = endpointList.filter((endpoint) => endpoint.legacy === 'auth');
  const allRows = endpointList.map((endpoint) => {
    const entry = byKey.get(endpoint.key);
    const policy =
      entry === undefined
        ? endpoint.legacy === 'public'
          ? 'PUBLIC'
          : endpoint.legacy === 'rbac'
            ? 'RBAC; codes=' + endpoint.rbacCodes.join(',')
            : 'UNCLASSIFIED'
        : label(entry.policy);
    const evidence = entry === undefined ? endpoint.evidence : entry.evidence;
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
      cell(policy) +
      ' | ' +
      (entry === undefined ? 'code' : 'classification-overlay') +
      ' | ' +
      cell(evidence.map((item) => item.file + ':' + item.line).join('; ')) +
      ' |'
    );
  });
  return [
    '# Route Authorization Policy - Phase 0 inventory',
    '',
    '> Generated by scripts/generate-authz-manifest.ts. Do not hand-edit.',
    '> Phase 0 is inventory only: no decorator, Guard, ALS, or runtime behavior is changed.',
    '',
    '## Registry',
    '',
    '| field | value |',
    '|---|---|',
    '| schemaVersion | ' + VERSION + ' |',
    '| generatorVersion | ' + VERSION + ' |',
    '| inputDigest | ' + documentDigest + ' |',
    '| endpoint count | ' + endpointList.length + ' |',
    '| legacy [auth] count | ' + auth.length + ' |',
    '| classification JSON | ' + CLASSIFICATION + ' |',
    '| truth source for [auth] | classification-overlay |',
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
    '## Maintainer decision table',
    '',
    '> All legacy [auth] entries have a complete structured policy shape, but remain needs-decision until the maintainer confirms semantics. Evidence records the handler, statically reached implementation methods, and recognized authorization signals; it is not a formal whole-program proof.',
    '',
    '| review scope | endpoint or family | provisional policy | status | evidence |',
    '|---|---|---|---|---|',
    ...decisionRows(auth, byKey),
    '',
    '## All endpoints',
    '',
    '| method | path | tag family | legacy declaration | structured policy | truth source | evidence |',
    '|---|---|---|---|---|---|',
    ...allRows,
    '',
  ].join('\n');
}

function main(): void {
  const bootstrapMode = process.argv.includes('--bootstrap');
  const checkMode = process.argv.includes('--check');
  const writeMode = process.argv.includes('--write') || (!bootstrapMode && !checkMode);
  if ((bootstrapMode ? 1 : 0) + (checkMode ? 1 : 0) + (writeMode ? 1 : 0) !== 1) {
    throw new Error('use exactly one of --bootstrap, --write, or --check');
  }
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
  let input: Overlay;
  if (bootstrapMode) {
    input = bootstrap(endpointList);
    write(CLASSIFICATION, JSON.stringify(input, null, 2) + '\n');
  } else {
    input = overlay();
  }
  validate(endpointList, input);
  const next = render(endpointList, input);
  if (checkMode) {
    if (!fs.existsSync(path.join(ROOT, DOCUMENT)) || read(DOCUMENT) !== next) {
      throw new Error(DOCUMENT + ' is stale; run generator with --write');
    }
    process.stdout.write(
      'Route Authorization Policy current: ' +
        endpointList.length +
        ' endpoints, ' +
        input.entries.length +
        ' [auth] entries.\n',
    );
    return;
  }
  write(DOCUMENT, next);
  process.stdout.write(
    'Generated Route Authorization Policy: ' +
      endpointList.length +
      ' endpoints, ' +
      input.entries.length +
      ' [auth] entries.\n',
  );
}

try {
  main();
} catch (error) {
  process.stderr.write(
    'generate-authz-manifest failed: ' +
      (error instanceof Error ? error.message : String(error)) +
      '\n',
  );
  process.exit(1);
}
