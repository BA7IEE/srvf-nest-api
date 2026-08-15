// @ts-check
// ============================================================================
// srvf/authz-declaration-closure — R8 declaration ↔ implementation closure.
//
// This rule deliberately consumes the generated Route Authorization Policy and
// generated assertion-pattern registry.  It does not parse decorators or
// invent a second policy normalizer: RouteAuthzDeclaration → manifest is the
// sole canonical path.  The rule is intentionally bounded to:
//
//   T1 handler body, and T2 one direct call to a public method of a service in
//   the same module.  Anything beyond that boundary is a T3 candidate instead
//   of a pretend proof.  A literal assertion only counts when its boolean
//   result reaches a deny/early-return branch (or the pattern's registered
//   equivalent consequence).
//
// Report mode is warning-only. It scans the generated manifest's historical
// [auth] review records, preserving the initial T1/T2/T3 scope without
// reviving the retired classification overlay or making existing debt a hidden
// blocking condition.
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

export const AUTHZ_DECLARATION_CLOSURE_RULE = 'srvf/authz-declaration-closure';
export const AUTHZ_DECLARATION_CLOSURE_MESSAGE =
  'R8 授权声明与实现闭环未获静态证明。声明的每个码、scope、engine 与 app-member 准入都必须有已登记的字面断言模式；' +
  'T1=handler，T2=同模块一层公开 service，超过该边界或动态码一律诚实列为 T3 候选。';

const ROUTE_AUTHZ_PATH = 'docs/ai-harness/ROUTE_AUTHZ.md';
const PATTERNS_PATH = 'harness/authz-assertion-patterns.json';
// Discriminates the structural matcher shape from the call-shape matchers.
const SUBJECT_INPUT_OUTCOME = 'no-caller-controlled-subject';
const ROUTE_AUTHZ_MANIFEST_START = '<!-- route-authz-manifest-json\n';
const ROUTE_AUTHZ_MANIFEST_END = '\n-->';

/** @type {Map<string, SourceIndex>} */
const sourceIndexCache = new Map();

// Building a ts.Program over the whole repository costs ~2s, and nothing about
// that is visible from the outside: a caller that varies `cacheKey` per item
// pays it once per item and still goes green. That is exactly how the R8
// selftest came to rebuild the same Program 30 times without anyone noticing.
// Exposing the count makes the regression assertable instead of merely
// commented about.
let typedProgramBuilds = 0;

/** ts.Program builds this process has paid for. Monotonic; never reset. */
export function authzTypedProgramBuilds() {
  return typedProgramBuilds;
}
// Each entry pins a whole ts.Program (its checker is needed to enumerate what a
// DTO parameter carries). Callers vary cacheKey because the files changed under
// them, so older entries are stale by construction — an unbounded map would just
// hold every superseded Program alive at once. The R8 selftest walks ~30 keys in
// one process, which is exactly where that shows up as heap exhaustion.
const SOURCE_INDEX_CACHE_LIMIT = 2;

/**
 * @typedef {{ code: string, scope: string | null }} PolicyCode
 * @typedef {{ admission: string | null, mode: string, codes: PolicyCode[], require: 'all' | 'any', scopes: string[], engine: string | null }} Policy
 * @typedef {{ routeKey?: string, controller: string, handler: string, legacy?: string, policy: Policy }} PolicyEntry
 * @typedef {{ receiverTypes: string[], methods: string[], actionArgument: number | null, outcome: string }} StaticMatcher
 * @typedef {{ outcome: 'no-caller-controlled-subject', identityParameterDecorators: string[], callerControlledParameterDecorators: string[], subjectIdentifierNames: string[] }} SubjectInputMatcher
 * @typedef {{ id: string, axes: string[], staticMatchers: Array<StaticMatcher | SubjectInputMatcher> }} AssertionPattern
 * @typedef {{ name: string, file: string, moduleKey: string, source: import('typescript').SourceFile, declaration: import('typescript').ClassDeclaration, methods: Map<string, import('typescript').MethodDeclaration>, dependencies: Map<string, string> }} ClassInfo
 * @typedef {{ classesByName: Map<string, ClassInfo[]>, classesByFile: Map<string, ClassInfo[]>, typed: { program: import('typescript').Program, checker: import('typescript').TypeChecker } | null }} SourceIndex
 * @typedef {{ pattern: string, code: string | null, layer: 1 | 2, file: string, line: number }} Observation
 * @typedef {{ target: { receiver: string, receiverType: string | null, method: string }, file: string, line: number }} ServiceCall
 * @typedef {{ observations: Observation[], serviceCalls: ServiceCall[] }} MethodAnalysis
 * @typedef {{ entry: PolicyEntry, tier: 'T1' | 'T2' | 'T3' | 'N/A', closure: 'closed' | 'mismatch' | 'candidate' | 'not-applicable', missing: string[], observations: Observation[] }} ClosureRecord
 */

function rel(root, filename) {
  return path.relative(root, filename).replaceAll(path.sep, '/');
}

function sourceFiles(root) {
  /** @type {string[]} */
  const output = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(absolute);
      } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')) {
        output.push(absolute);
      }
    }
  };
  visit(path.join(root, 'src'));
  return output.sort();
}

function moduleKey(file) {
  const parts = file.split('/');
  const modules = parts.indexOf('modules');
  if (modules >= 0 && parts[modules + 1] !== undefined)
    return parts.slice(0, modules + 2).join('/');
  return path.posix.dirname(file);
}

function nodeName(node, source) {
  if (node === undefined) return null;
  if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node))
    return node.text;
  return node.getText(source);
}

function typeName(type, source) {
  if (type === undefined || !ts.isTypeReferenceNode(type)) return null;
  return type.typeName.getText(source).split('.').at(-1) ?? null;
}

function isPropertyParameter(parameter) {
  return (parameter.modifiers ?? []).some((modifier) =>
    [
      ts.SyntaxKind.PrivateKeyword,
      ts.SyntaxKind.ProtectedKeyword,
      ts.SyntaxKind.PublicKeyword,
      ts.SyntaxKind.ReadonlyKeyword,
    ].includes(modifier.kind),
  );
}

function isPublicMethod(method) {
  return !(method.modifiers ?? []).some((modifier) =>
    [ts.SyntaxKind.PrivateKeyword, ts.SyntaxKind.ProtectedKeyword].includes(modifier.kind),
  );
}

/**
 * Build a typed program over the repository tsconfig (Phase 3 前置 · D3).
 *
 * The index resolved an injected dependency by the *text* of its type
 * annotation. That reading is defeated by anything that renames the type on the
 * way in — `import { AuthzService as A }`, a re-export under a new name, a
 * local `type X = AuthzService`. The checker instead reports the name at the
 * type's own declaration site, so the registered `receiverTypes` match what the
 * class really is rather than how this file happens to spell it.
 *
 * Returns null when the program cannot be built (caller outside the repo, no
 * tsconfig). The annotation reading then stays in force, so the rule degrades
 * to its Phase 0 accuracy rather than silently finding nothing.
 */
function buildTypedIndex(root) {
  // Deliberately NOT cached by root. Callers vary `cacheKey` precisely because
  // the files on disk changed under them (the R8 selftest rewrites one probe
  // path per case); a program cached by root would hand back the previous
  // probe's source and quietly make later cases assert against stale code.
  // buildSourceIndex already caches per (root, cacheKey), so this is built once
  // per index build, not once per lookup.
  const configPath = path.join(root, 'tsconfig.json');
  if (!fs.existsSync(configPath)) return null;
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error !== undefined) return null;
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  typedProgramBuilds += 1;
  const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
  return { program, checker: program.getTypeChecker() };
}

/** Resolve a declared dependency to the class name at its own declaration site. */
function declaredTypeName(typed, node, fallback) {
  if (typed === null || node === undefined) return fallback;
  const type = typed.checker.getTypeAtLocation(node);
  for (const member of type.isUnion() ? type.types : [type]) {
    const symbol = member.getSymbol() ?? member.aliasSymbol;
    const name = symbol?.getName();
    // `__type` / `__object` are the checker's placeholders for anonymous
    // shapes; they carry no identity, so the written annotation stays better.
    if (name !== undefined && name.length > 0 && !name.startsWith('__')) return name;
  }
  return fallback;
}

function buildSourceIndex(root, cacheKey = '') {
  const key = `${root}\u0000${cacheKey}`;
  const cached = sourceIndexCache.get(key);
  if (cached !== undefined) return cached;

  /** @type {Map<string, ClassInfo[]>} */
  const classesByName = new Map();
  /** @type {Map<string, ClassInfo[]>} */
  const classesByFile = new Map();
  const typed = buildTypedIndex(root);

  for (const absolute of sourceFiles(root)) {
    const file = rel(root, absolute);
    const source =
      typed?.program.getSourceFile(absolute) ??
      ts.createSourceFile(absolute, fs.readFileSync(absolute, 'utf8'), ts.ScriptTarget.Latest, true);
    const visit = (node) => {
      if (ts.isClassDeclaration(node) && node.name !== undefined) {
        /** @type {Map<string, import('typescript').MethodDeclaration>} */
        const methods = new Map();
        /** @type {Map<string, string>} */
        const dependencies = new Map();
        for (const member of node.members) {
          if (ts.isMethodDeclaration(member)) {
            const name = nodeName(member.name, source);
            if (name !== null) methods.set(name, member);
            continue;
          }
          if (ts.isPropertyDeclaration(member) && ts.isIdentifier(member.name)) {
            const written = typeName(member.type, source);
            // Typed resolution first; the written annotation is the fallback so
            // an unresolvable type never silently drops the dependency.
            const dependency = declaredTypeName(typed, member.name, written);
            if (dependency !== null) dependencies.set(member.name.text, dependency);
            continue;
          }
          if (!ts.isConstructorDeclaration(member)) continue;
          for (const parameter of member.parameters) {
            if (!isPropertyParameter(parameter) || !ts.isIdentifier(parameter.name)) continue;
            const written = typeName(parameter.type, source);
            const dependency = declaredTypeName(typed, parameter.name, written);
            if (dependency !== null) dependencies.set(parameter.name.text, dependency);
          }
        }
        /** @type {ClassInfo} */
        const info = {
          name: node.name.text,
          file,
          moduleKey: moduleKey(file),
          source,
          declaration: node,
          methods,
          dependencies,
        };
        const sameName = classesByName.get(info.name) ?? [];
        sameName.push(info);
        classesByName.set(info.name, sameName);
        const sameFile = classesByFile.get(file) ?? [];
        sameFile.push(info);
        classesByFile.set(file, sameFile);
      }
      node.forEachChild(visit);
    };
    visit(source);
  }
  // `typed` rides along on the index because the self-by-construction family
  // needs the checker to enumerate what a DTO parameter carries. It is null when
  // no program could be built; every consumer must treat that as "cannot judge".
  const result = { classesByName, classesByFile, typed };
  // Insertion-ordered eviction: the oldest key is the one least likely to be
  // asked for again, since a new key means the caller rewrote the sources.
  while (sourceIndexCache.size >= SOURCE_INDEX_CACHE_LIMIT) {
    const oldest = sourceIndexCache.keys().next();
    if (oldest.done === true) break;
    sourceIndexCache.delete(oldest.value);
  }
  sourceIndexCache.set(key, result);
  return result;
}

function onlyClass(index, name) {
  const candidates = index.classesByName.get(name) ?? [];
  return candidates.length === 1 ? candidates[0] : null;
}

function readJson(root, file) {
  return JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
}

function routeAuthzManifestEntries(root) {
  const document = fs.readFileSync(path.join(root, ROUTE_AUTHZ_PATH), 'utf8');
  const start = document.indexOf(ROUTE_AUTHZ_MANIFEST_START);
  if (start < 0) {
    throw new Error(`R8 generated route manifest is missing; run pnpm docs:authz`);
  }
  const jsonStart = start + ROUTE_AUTHZ_MANIFEST_START.length;
  const end = document.indexOf(ROUTE_AUTHZ_MANIFEST_END, jsonStart);
  if (end < 0) {
    throw new Error(`R8 generated route manifest is unterminated; run pnpm docs:authz`);
  }
  let manifest;
  try {
    manifest = JSON.parse(document.slice(jsonStart, end));
  } catch (error) {
    throw new Error(
      `R8 generated route manifest is invalid JSON; run pnpm docs:authz (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  if (manifest === null || typeof manifest !== 'object' || !Array.isArray(manifest.entries)) {
    throw new Error(`R8 generated route manifest is invalid; run pnpm docs:authz`);
  }
  return manifest.entries;
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function normalizeEntry(input) {
  if (input === null || typeof input !== 'object')
    throw new Error('R8 policy entry must be an object');
  const entry = /** @type {PolicyEntry} */ (input);
  const policy = entry.policy;
  if (
    typeof entry.controller !== 'string' ||
    typeof entry.handler !== 'string' ||
    policy === null ||
    typeof policy !== 'object' ||
    !Array.isArray(policy.codes) ||
    !isStringArray(policy.scopes) ||
    (policy.require !== 'all' && policy.require !== 'any')
  ) {
    throw new Error('R8 policy entry is not a canonical Route Authorization Policy');
  }
  for (const code of policy.codes) {
    if (
      code === null ||
      typeof code !== 'object' ||
      typeof code.code !== 'string' ||
      (typeof code.scope !== 'string' && code.scope !== null)
    ) {
      throw new Error('R8 policy code entry is invalid');
    }
  }
  return entry;
}

/** The registry carries two matcher shapes; each is validated against its own
 * required fields so a malformed entry cannot pass by satisfying the other's.
 * @param {unknown} matcher */
function isValidMatcher(matcher) {
  if (matcher === null || typeof matcher !== 'object') return false;
  const candidate = /** @type {Record<string, unknown>} */ (matcher);
  if (candidate.outcome === SUBJECT_INPUT_OUTCOME) {
    return (
      isStringArray(candidate.identityParameterDecorators) &&
      isStringArray(candidate.callerControlledParameterDecorators) &&
      isStringArray(candidate.subjectIdentifierNames)
    );
  }
  return (
    isStringArray(candidate.receiverTypes) &&
    isStringArray(candidate.methods) &&
    (typeof candidate.actionArgument === 'number' || candidate.actionArgument === null) &&
    typeof candidate.outcome === 'string'
  );
}

function assertionPatterns(root) {
  const document = readJson(root, PATTERNS_PATH);
  if (!Array.isArray(document.families)) {
    throw new Error(`R8 assertion pattern registry is invalid; run pnpm docs:authz`);
  }
  /** @type {Map<string, AssertionPattern>} */
  const byId = new Map();
  for (const raw of document.families) {
    if (raw === null || typeof raw !== 'object') throw new Error('R8 assertion pattern is invalid');
    const pattern = /** @type {AssertionPattern} */ (raw);
    if (
      typeof pattern.id !== 'string' ||
      !isStringArray(pattern.axes) ||
      !Array.isArray(pattern.staticMatchers) ||
      !pattern.staticMatchers.every((matcher) => isValidMatcher(matcher))
    ) {
      throw new Error(
        `R8 assertion pattern ${String(pattern.id)} lacks static matcher metadata; run pnpm docs:authz`,
      );
    }
    byId.set(pattern.id, pattern);
  }
  for (const required of [
    'rbac-can',
    'authz-can-explain',
    'visible-organization-scope',
    'app-identity-resolve',
    'responsibility-check',
    'self-by-construction',
  ]) {
    if (!byId.has(required)) throw new Error(`R8 assertion pattern registry misses ${required}`);
  }
  return byId;
}

function policyEntries(root, options) {
  if (options.entries !== undefined) return options.entries.map(normalizeEntry);
  return routeAuthzManifestEntries(root)
    .filter((entry) => entry !== null && typeof entry === 'object' && entry.legacy === 'auth')
    .map(normalizeEntry);
}

function unwrap(expression) {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function literalString(expression, strings) {
  if (expression === undefined) return null;
  const value = unwrap(expression);
  if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) return value.text;
  if (ts.isIdentifier(value)) return strings.get(value.text) ?? null;
  return null;
}

function resolvedReceiver(expression, receiverAliases) {
  const value = unwrap(expression);
  if (ts.isIdentifier(value)) {
    let receiver = value.text;
    const visited = new Set();
    while (receiverAliases.has(receiver) && !visited.has(receiver)) {
      visited.add(receiver);
      receiver = receiverAliases.get(receiver);
    }
    return receiver;
  }
  if (ts.isPropertyAccessExpression(value) && value.expression.kind === ts.SyntaxKind.ThisKeyword) {
    let receiver = value.name.text;
    const visited = new Set();
    while (receiverAliases.has(receiver) && !visited.has(receiver)) {
      visited.add(receiver);
      receiver = receiverAliases.get(receiver);
    }
    return receiver;
  }
  return null;
}

function targetOf(expression, info, receiverAliases, targetAliases) {
  const value = unwrap(expression);
  if (ts.isIdentifier(value)) return targetAliases.get(value.text) ?? null;
  if (
    ts.isCallExpression(value) &&
    ts.isPropertyAccessExpression(value.expression) &&
    value.expression.name.text === 'bind'
  ) {
    return targetOf(value.expression.expression, info, receiverAliases, targetAliases);
  }
  if (!ts.isPropertyAccessExpression(value)) return null;
  const receiver = resolvedReceiver(value.expression, receiverAliases);
  if (receiver === null) return null;
  return {
    receiver,
    receiverType: info.dependencies.get(receiver) ?? null,
    method: value.name.text,
  };
}

function localBindings(method, info) {
  /** @type {Array<import('typescript').VariableDeclaration>} */
  const declarations = [];
  /** @type {Array<import('typescript').VariableDeclaration>} */
  const destructurings = [];
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && node.initializer !== undefined) {
      if (ts.isIdentifier(node.name)) declarations.push(node);
      // `const { can } = this.authz` — the method is lifted off the service and
      // called bare, so there is no receiver left in the call expression for the
      // property-access reading to match. Collected separately below.
      else if (ts.isObjectBindingPattern(node.name)) destructurings.push(node);
    }
    node.forEachChild(visit);
  };
  method.forEachChild(visit);

  /** @type {Map<string, string>} */
  const strings = new Map();
  /** @type {Map<string, string>} */
  const receiverAliases = new Map();
  /** @type {Map<string, { receiver: string, receiverType: string | null, method: string }>} */
  const targetAliases = new Map();
  for (let pass = 0; pass < declarations.length + 1; pass++) {
    let changed = false;
    for (const declaration of declarations) {
      const name = /** @type {import('typescript').Identifier} */ (declaration.name).text;
      const value = declaration.initializer;
      const literal = literalString(value, strings);
      if (literal !== null && strings.get(name) !== literal) {
        strings.set(name, literal);
        changed = true;
      }
      const receiver = resolvedReceiver(value, receiverAliases);
      if (receiver !== null && receiver !== name && receiverAliases.get(name) !== receiver) {
        receiverAliases.set(name, receiver);
        changed = true;
      }
      const target = targetOf(value, info, receiverAliases, targetAliases);
      if (target !== null) {
        const previous = targetAliases.get(name);
        if (
          previous?.receiver !== target.receiver ||
          previous?.receiverType !== target.receiverType ||
          previous?.method !== target.method
        ) {
          targetAliases.set(name, target);
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
  // Destructured methods resolve after the alias fixed point, so that
  // `const svc = this.authz; const { can } = svc;` also lands. Each bound name
  // becomes the same {receiver, receiverType, method} triple a property access
  // would have produced — the registered matcher is unchanged, only the way the
  // call is written differs.
  for (const declaration of destructurings) {
    const receiver = resolvedReceiver(declaration.initializer, receiverAliases);
    if (receiver === null) continue;
    const receiverType = info.dependencies.get(receiver) ?? null;
    for (const element of /** @type {import('typescript').ObjectBindingPattern} */ (
      declaration.name
    ).elements) {
      if (!ts.isIdentifier(element.name)) continue;
      // `const { can: check } = ...` — the *property* is the method name.
      const method =
        element.propertyName !== undefined && ts.isIdentifier(element.propertyName)
          ? element.propertyName.text
          : element.name.text;
      targetAliases.set(element.name.text, { receiver, receiverType, method });
    }
  }
  return { strings, receiverAliases, targetAliases };
}

function contains(root, target) {
  let found = false;
  const visit = (node) => {
    if (found) return;
    if (node === target) {
      found = true;
      return;
    }
    node.forEachChild(visit);
  };
  visit(root);
  return found;
}

function containsIdentifier(root, name) {
  let found = false;
  const visit = (node) => {
    if (found) return;
    if (ts.isIdentifier(node) && node.text === name) {
      found = true;
      return;
    }
    node.forEachChild(visit);
  };
  visit(root);
  return found;
}

function hasThrowOrReturn(node) {
  let found = false;
  const visit = (child) => {
    if (found) return;
    if (ts.isThrowStatement(child) || ts.isReturnStatement(child)) {
      found = true;
      return;
    }
    child.forEachChild(visit);
  };
  visit(node);
  return found;
}

function isBooleanFalse(expression) {
  return expression.kind === ts.SyntaxKind.FalseKeyword;
}

function isBooleanTrue(expression) {
  return expression.kind === ts.SyntaxKind.TrueKeyword;
}

function negatedWithin(subject, condition) {
  let current = subject;
  while (current !== condition) {
    const parent = current.parent;
    if (parent === undefined) return false;
    if (ts.isPrefixUnaryExpression(parent) && parent.operator === ts.SyntaxKind.ExclamationToken) {
      return true;
    }
    if (ts.isBinaryExpression(parent)) {
      const equal = [
        ts.SyntaxKind.EqualsEqualsToken,
        ts.SyntaxKind.EqualsEqualsEqualsToken,
        ts.SyntaxKind.ExclamationEqualsToken,
        ts.SyntaxKind.ExclamationEqualsEqualsToken,
      ].includes(parent.operatorToken.kind);
      if (equal) {
        const other = parent.left === current ? parent.right : parent.left;
        const equality = [
          ts.SyntaxKind.EqualsEqualsToken,
          ts.SyntaxKind.EqualsEqualsEqualsToken,
        ].includes(parent.operatorToken.kind);
        if ((equality && isBooleanFalse(other)) || (!equality && isBooleanTrue(other))) return true;
      }
    }
    current = parent;
  }
  return false;
}

function bindingName(call, method) {
  let current = call;
  while (current !== method) {
    const parent = current.parent;
    if (parent === undefined) return null;
    if (
      ts.isVariableDeclaration(parent) &&
      parent.initializer !== undefined &&
      contains(parent.initializer, call) &&
      ts.isIdentifier(parent.name)
    ) {
      return parent.name.text;
    }
    current = parent;
  }
  return null;
}

function hasDenyBranch(call, method) {
  const bound = bindingName(call, method);
  let found = false;
  const visit = (node) => {
    if (found) return;
    if (ts.isIfStatement(node)) {
      /** @type {import('typescript').Node[]} */
      const subjects = [];
      if (contains(node.expression, call)) subjects.push(call);
      if (bound !== null) {
        const collect = (child) => {
          if (ts.isIdentifier(child) && child.text === bound) subjects.push(child);
          child.forEachChild(collect);
        };
        collect(node.expression);
      }
      if (
        subjects.some((subject) => negatedWithin(subject, node.expression)) &&
        hasThrowOrReturn(node.thenStatement)
      ) {
        found = true;
        return;
      }
    }
    node.forEachChild(visit);
  };
  method.forEachChild(visit);
  return found;
}

function isUnderWhere(node, method) {
  let current = node;
  while (current !== method) {
    const parent = current.parent;
    if (parent === undefined) return false;
    if (
      ts.isPropertyAssignment(parent) &&
      nodeName(parent.name, method.getSourceFile()) === 'where'
    )
      return true;
    current = parent;
  }
  return false;
}

function hasQueryFilterPushdown(call, method) {
  if (isUnderWhere(call, method)) return true;
  const bound = bindingName(call, method);
  if (bound === null) return false;
  let found = false;
  const visit = (node) => {
    if (found) return;
    if (ts.isIdentifier(node) && node.text === bound && isUnderWhere(node, method)) {
      found = true;
      return;
    }
    node.forEachChild(visit);
  };
  method.forEachChild(visit);
  return found;
}

function lineOf(node, source) {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

function matcherFor(target, patterns) {
  /** @type {Array<{ pattern: AssertionPattern, matcher: StaticMatcher }>} */
  const output = [];
  if (target.receiverType === null) return output;
  for (const pattern of patterns.values()) {
    for (const matcher of pattern.staticMatchers) {
      // Structural matchers describe a parameter surface, not a call. They carry
      // no receiver type, so they are never a candidate for call matching.
      if (matcher.outcome === SUBJECT_INPUT_OUTCOME) continue;
      if (
        matcher.receiverTypes.includes(target.receiverType) &&
        matcher.methods.includes(target.method)
      ) {
        output.push({ pattern, matcher });
      }
    }
  }
  return output;
}

function analyzeMethod(info, method, layer, patterns) {
  const bindings = localBindings(method, info);
  /** @type {Observation[]} */
  const observations = [];
  /** @type {ServiceCall[]} */
  const serviceCalls = [];
  const visit = (node) => {
    if (!ts.isCallExpression(node)) {
      node.forEachChild(visit);
      return;
    }
    const target = targetOf(
      node.expression,
      info,
      bindings.receiverAliases,
      bindings.targetAliases,
    );
    if (target !== null) {
      for (const { pattern, matcher } of matcherFor(target, patterns)) {
        const code =
          matcher.actionArgument === null
            ? null
            : literalString(node.arguments[matcher.actionArgument], bindings.strings);
        const outcome =
          matcher.outcome === 'boolean-deny-branch' || matcher.outcome === 'app-admission-branch'
            ? hasDenyBranch(node, method)
            : matcher.outcome === 'query-filter-pushdown'
              ? hasQueryFilterPushdown(node, method)
              : matcher.outcome === 'throwing-assertion';
        if (outcome) {
          observations.push({
            pattern: pattern.id,
            code,
            layer,
            file: info.file,
            line: lineOf(node, info.source),
          });
        }
      }
      if (
        layer === 1 &&
        target.receiverType !== null &&
        matcherFor(target, patterns).length === 0
      ) {
        serviceCalls.push({ target, file: info.file, line: lineOf(node, info.source) });
      }
    }
    node.forEachChild(visit);
  };
  method.forEachChild(visit);
  return { observations, serviceCalls };
}

/** The registered structural matcher, or null when the family is absent. */
function subjectInputMatcher(patterns) {
  for (const pattern of patterns.values()) {
    for (const matcher of pattern.staticMatchers) {
      if (matcher.outcome === SUBJECT_INPUT_OUTCOME) return matcher;
    }
  }
  return null;
}

function decoratorName(decorator) {
  const expression = decorator.expression;
  const callee = ts.isCallExpression(expression) ? expression.expression : expression;
  return ts.isIdentifier(callee)
    ? callee.text
    : ts.isPropertyAccessExpression(callee)
      ? callee.name.text
      : null;
}

/** `@Param('id')` names exactly one field; anything else has no literal key. */
function decoratorLiteralKey(decorator) {
  const expression = decorator.expression;
  if (!ts.isCallExpression(expression) || expression.arguments.length === 0) return null;
  const first = unwrap(expression.arguments[0]);
  return ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first) ? first.text : null;
}

/**
 * Every name a caller-controlled parameter can carry, or null when that set
 * cannot be established. Resolution goes through the checker so class
 * inheritance and `PickType` / `OmitType` derivations are expanded by the
 * compiler rather than re-implemented here. null means "cannot judge" and the
 * caller must fall to T3 — never "carries nothing".
 */
function carriedParameterNames(typed, parameter, decorator) {
  const literal = decoratorLiteralKey(decorator);
  if (literal !== null) return [literal];
  if (typed === null) return null;
  const type = typed.checker.getTypeAtLocation(parameter);
  /** @type {string[]} */
  const names = [];
  for (const member of type.isUnion() ? type.types : [type]) {
    // `dto?: X` widens to `X | undefined`; the absent arm carries no field.
    if ((member.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null)) !== 0) continue;
    if ((member.flags & ts.TypeFlags.Object) === 0) return null;
    const symbol = member.getSymbol();
    if (symbol === undefined) return null;
    const declarations = symbol.getDeclarations() ?? [];
    // Anonymous shapes and mapped-type placeholders carry no reviewable
    // declaration, so their field list is not evidence of anything.
    if (
      !declarations.some(
        (declaration) =>
          ts.isClassDeclaration(declaration) || ts.isInterfaceDeclaration(declaration),
      )
    ) {
      return null;
    }
    for (const property of typed.checker.getPropertiesOfType(member)) {
      names.push(property.getName());
    }
  }
  return names;
}

/**
 * Prove that `scope: self` closes by construction: the handler receives the
 * caller's identity from the framework and exposes no input the caller could
 * use to name a different subject.
 *
 * This is a negative proof, so it is written to fail closed. Each parameter must
 * be positively classified as identity or as caller-controlled-and-enumerable;
 * anything else — an unknown decorator, no decorator, an unexpandable type, a
 * missing checker — returns a reason instead of a pass. There is deliberately no
 * "nothing matched, so it must be safe" path.
 *
 * @returns {string | null} null when proven, otherwise why it could not be.
 */
function selfByConstructionGap(index, controller, handler, matcher) {
  if (matcher === null) return 'scope self has no registered static assertion pattern';
  // A vocabulary this family cannot judge with must not degrade into blanket
  // approval: an empty name set would make every caller-controlled input look
  // harmless. Guarding the structure, not the contents, of the name set.
  if (matcher.subjectIdentifierNames.length === 0) {
    return 'scope self matcher declares no subject identifier names';
  }
  if (matcher.identityParameterDecorators.length === 0) {
    return 'scope self matcher declares no identity parameter decorators';
  }
  const identityDecorators = new Set(matcher.identityParameterDecorators);
  const controlledDecorators = new Set(matcher.callerControlledParameterDecorators);
  const subjectNames = new Set(matcher.subjectIdentifierNames.map((name) => name.toLowerCase()));

  /** @type {import('typescript').ParameterDeclaration | null} */
  let identity = null;
  for (const parameter of handler.parameters) {
    const written = parameter.name.getText(controller.source);
    const decorators = ts.getDecorators(parameter) ?? [];
    if (decorators.length === 0) {
      return `scope self cannot classify parameter ${written} (no parameter decorator)`;
    }
    for (const decorator of decorators) {
      const name = decoratorName(decorator);
      if (name === null) {
        return `scope self cannot classify parameter ${written} (unreadable decorator)`;
      }
      if (identityDecorators.has(name)) {
        identity = parameter;
        continue;
      }
      if (!controlledDecorators.has(name)) {
        // The whole proof rests on this branch. @Req / @Headers / @Session hand
        // over the entire request, and a custom decorator can inject anything;
        // neither can be shown to exclude a subject, so neither may pass.
        return `scope self cannot classify parameter ${written} (unregistered decorator @${name})`;
      }
      const carried = carriedParameterNames(index.typed, parameter, decorator);
      if (carried === null) {
        return `scope self cannot enumerate what @${name} ${written} carries`;
      }
      const hit = carried.find((field) => subjectNames.has(field.toLowerCase()));
      if (hit !== undefined) {
        return `scope self has caller-controlled subject input @${name} ${written}.${hit}`;
      }
    }
  }
  if (identity === null) return 'scope self has no framework-injected identity parameter';
  // A declared-but-unused identity would leave the subject to be chosen
  // somewhere the handler never looks at.
  const bound = identity.name
    .getText(controller.source)
    .replace(/^\{|\}$/g, '')
    .trim();
  if (handler.body === undefined || !containsIdentifier(handler.body, bound)) {
    return `scope self identity parameter ${bound} is never passed downward`;
  }
  return null;
}

function requiredScopeChecks(policy) {
  return [
    ...policy.scopes.map((scope) => ({ scope, code: null })),
    ...policy.codes
      .filter((code) => code.scope !== null)
      .map((code) => ({ scope: /** @type {string} */ (code.scope), code: code.code })),
  ];
}

// Registered engines and the assertion family each one owes.
//
// `none` maps to no family on purpose: it is a declared absence — the decision
// is carried by the scopes / admission axes, so there is no engine assertion to
// find. That is different from an *unreadable* engine value, which is handled
// below by refusing to judge rather than by owing nothing.
const ENGINE_ASSERTIONS = new Map([
  ['rbac-global', 'rbac-can'],
  ['authz-scoped', 'authz-can-explain'],
  ['none', null],
]);

/**
 * @returns the owed assertion family, or null when the engine owes none.
 * Callers must check {@link isRegisteredEngine} first: this returns null for an
 * unregistered value too, and those two nulls mean opposite things.
 */
function patternForEngine(engine) {
  return ENGINE_ASSERTIONS.get(engine) ?? null;
}

/**
 * A null engine is legitimate (PUBLIC / LOGIN_ONLY declare no engine). Any other
 * unregistered value is not an absence — it is a declaration this rule cannot
 * read, e.g. a typo like `authz-scopedd`. Before this check such a value fell
 * through to "owes no assertion", making a misspelling indistinguishable from
 * "nothing to prove" — the axis silently passed. It must fall to T3 instead.
 */
function isRegisteredEngine(engine) {
  return engine === null || ENGINE_ASSERTIONS.has(engine);
}

function findObservation(observations, pattern, code = null) {
  return observations.find(
    (item) => item.pattern === pattern && (code === null || item.code === code),
  );
}

function classifyEntry(index, patterns, entry) {
  const policy = entry.policy;
  const hasAxes =
    policy.admission !== null ||
    policy.codes.length > 0 ||
    policy.scopes.length > 0 ||
    policy.codes.some((code) => code.scope !== null) ||
    policy.engine !== null;
  if (!hasAxes) {
    return { entry, tier: 'N/A', closure: 'not-applicable', missing: [], observations: [] };
  }

  const controller = onlyClass(index, entry.controller);
  if (controller === null) {
    return {
      entry,
      tier: 'T3',
      closure: 'candidate',
      missing: [`controller ${entry.controller} is absent or ambiguous`],
      observations: [],
    };
  }
  const handler = controller.methods.get(entry.handler);
  if (handler === undefined) {
    return {
      entry,
      tier: 'T3',
      closure: 'candidate',
      missing: [`handler ${entry.controller}.${entry.handler} is absent`],
      observations: [],
    };
  }

  const direct = analyzeMethod(controller, handler, 1, patterns);
  const observations = [...direct.observations];
  let unresolvedDelegation = false;
  const visited = new Set();
  for (const call of direct.serviceCalls) {
    const targetClass = onlyClass(index, call.target.receiverType);
    if (targetClass === null || targetClass.moduleKey !== controller.moduleKey) {
      if (
        call.target.receiverType.endsWith('Service') ||
        call.target.receiverType.endsWith('Policy')
      ) {
        unresolvedDelegation = true;
      }
      continue;
    }
    const targetMethod = targetClass.methods.get(call.target.method);
    const identity = `${targetClass.file}\u0000${call.target.method}`;
    if (targetMethod === undefined || !isPublicMethod(targetMethod) || visited.has(identity)) {
      unresolvedDelegation = true;
      continue;
    }
    visited.add(identity);
    observations.push(...analyzeMethod(targetClass, targetMethod, 2, patterns).observations);
  }

  /** @type {string[]} */
  const missing = [];
  let unsupportedAxis = false;
  const subjectInput = subjectInputMatcher(patterns);
  if (
    policy.admission !== null &&
    findObservation(observations, 'app-identity-resolve') === undefined
  ) {
    missing.push('admission app-member has no AppIdentityResolver.resolve deny branch');
  }

  if (!isRegisteredEngine(policy.engine)) {
    missing.push(`engine ${policy.engine} is not a registered engine`);
    unsupportedAxis = true;
  }
  const codePattern = patternForEngine(policy.engine);
  if (policy.codes.length > 0 && codePattern === null) {
    missing.push('permission codes have no declared engine');
    unsupportedAxis = true;
  }
  if (codePattern !== null) {
    for (const code of policy.codes) {
      if (findObservation(observations, codePattern, code.code) === undefined) {
        missing.push(`code ${code.code} has no ${codePattern} literal deny branch`);
      }
    }
    if (findObservation(observations, codePattern) === undefined) {
      missing.push(`engine ${policy.engine} has no ${codePattern} assertion`);
    }
  }

  for (const requirement of requiredScopeChecks(policy)) {
    if (requirement.scope === 'self') {
      // The only axis proved by structure rather than by an observed call: the
      // intersection of resource and identity is a where-clause, so there is no
      // assertion to see. What is provable instead is that the handler exposes
      // nothing a caller could use to name someone else.
      const gap = selfByConstructionGap(index, controller, handler, subjectInput);
      if (gap !== null) {
        unsupportedAxis = true;
        missing.push(gap);
      }
      // Proven needs no bookkeeping: this axis contributes no observation, so an
      // empty `missing` is already the closed condition below.
      continue;
    }
    if (requirement.scope === 'responsibility') {
      if (findObservation(observations, 'responsibility-check') === undefined) {
        missing.push('scope responsibility has no registered responsibility assertion');
      }
      continue;
    }
    if (requirement.scope === 'org-scope' || requirement.scope.startsWith('visibility:')) {
      if (
        findObservation(observations, 'visible-organization-scope', requirement.code) === undefined
      ) {
        missing.push(
          `scope ${requirement.scope}${requirement.code === null ? '' : ` for ${requirement.code}`} has no visible-organization filter pushdown`,
        );
      }
      continue;
    }
    unsupportedAxis = true;
    missing.push(`scope ${requirement.scope} has no registered static assertion pattern`);
  }

  if (missing.length === 0) {
    const tier = observations.some((item) => item.layer === 2) ? 'T2' : 'T1';
    return { entry, tier, closure: 'closed', missing, observations };
  }

  const expectedPatterns = new Set(
    [
      policy.admission !== null ? 'app-identity-resolve' : null,
      codePattern,
      ...requiredScopeChecks(policy).map((item) =>
        item.scope === 'responsibility'
          ? 'responsibility-check'
          : item.scope === 'org-scope' || item.scope.startsWith('visibility:')
            ? 'visible-organization-scope'
            : null,
      ),
    ].filter((item) => item !== null),
  );
  const observedExpected = observations.filter((item) => expectedPatterns.has(item.pattern));
  const hasDynamicCode =
    policy.codes.length > 0 &&
    observedExpected.some((item) => item.pattern === codePattern && item.code === null);
  if (unsupportedAxis || unresolvedDelegation || hasDynamicCode || observedExpected.length === 0) {
    return { entry, tier: 'T3', closure: 'candidate', missing, observations };
  }
  const tier = observedExpected.some((item) => item.layer === 2) ? 'T2' : 'T1';
  return { entry, tier, closure: 'mismatch', missing, observations };
}

/**
 * Shared scanner for the ESLint visitor and the full-repository report.  This
 * is intentionally exported so the selftest verifies the exact logic that
 * produces the warning diagnostics, rather than re-implementing a report-only
 * second scanner.
 *
 * @param {{ rootDir?: string, entries?: PolicyEntry[], cacheKey?: string }} [options]
 * @returns {ClosureRecord[]}
 */
export function scanRouteAuthzClosure(options = {}) {
  const root = path.resolve(options.rootDir ?? process.cwd());
  const index = buildSourceIndex(root, options.cacheKey ?? '');
  const patterns = assertionPatterns(root);
  return policyEntries(root, options).map((entry) => classifyEntry(index, patterns, entry));
}

function routeLabel(entry) {
  return entry.routeKey ?? `${entry.controller}.${entry.handler}`;
}

/** @type {import('eslint').Rule.RuleModule} */
export const authzDeclarationClosure = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'R8 Route Authorization Policy 与 T1/T2 字面授权断言逐轴闭环；不确定路径诚实报告为 T3',
    },
    schema: [
      {
        type: 'object',
        properties: {
          rootDir: { type: 'string' },
          cacheKey: { type: 'string' },
          entries: { type: 'array', items: { type: 'object' } },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      t3Candidate:
        AUTHZ_DECLARATION_CLOSURE_MESSAGE +
        ' {{route}} → T3 candidate: {{detail}}. 正确做法:补可判的已登记断言，或在后续 T3 标注机制上线后走具名核验。',
      t1t2Mismatch:
        AUTHZ_DECLARATION_CLOSURE_MESSAGE +
        ' {{route}} → {{tier}} literal mismatch: {{detail}}. 正确做法:让声明的每一轴与实际字面断言逐项对应。',
    },
  },
  create(context) {
    if (!context.filename.endsWith('.controller.ts')) return {};
    const options = context.options[0] ?? {};
    const root = path.resolve(context.cwd, options.rootDir ?? '.');
    const filename = rel(root, context.filename);
    let records;
    try {
      records = scanRouteAuthzClosure({ ...options, rootDir: root });
    } catch (error) {
      throw new Error(
        `R8 cannot load canonical Route Authorization Policy: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const index = buildSourceIndex(root, options.cacheKey ?? '');
    for (const record of records) {
      if (record.closure === 'closed' || record.closure === 'not-applicable') continue;
      const controller = onlyClass(index, record.entry.controller);
      if (controller === null || controller.file !== filename) continue;
      const handler = controller.methods.get(record.entry.handler);
      if (handler === undefined) continue;
      const detail = record.missing.join('; ');
      context.report({
        loc: {
          start: { line: lineOf(handler, controller.source), column: 0 },
          end: { line: lineOf(handler, controller.source), column: 1 },
        },
        messageId: record.tier === 'T3' ? 't3Candidate' : 't1t2Mismatch',
        data: { route: routeLabel(record.entry), tier: record.tier, detail },
      });
    }
    return {};
  },
};
