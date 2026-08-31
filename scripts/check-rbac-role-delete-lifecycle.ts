/**
 * Role 删除生命周期的静态裁判(C2.2)。
 *
 * 本文件位于 `scripts/check-*.ts` selfGuard 保护面内。它扫描全部生产 TypeScript，
 * 而不是只看 permissions 目录：新增 CLI、worker 或旁路 Service 时也必须被纳入。
 *
 * 首次实测扫描面：789 个 src 下的非测试 TypeScript 文件；地板 = floor(789 × 0.7) = 552。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';

import * as ts from 'typescript';

const ROOT = path.resolve(__dirname, '..');

export const APPROVED_ENTRY = {
  file: 'src/modules/permissions/rbac-roles.service.ts',
  className: 'RbacRolesService',
  methodName: 'softDelete',
  transactionOwner: 'this.prisma',
  transactionVariable: 'tx',
  roleIdVariable: 'id',
} as const;

export const REQUIRED_ANCHOR_FILES = [
  'src/modules/permissions/rbac-roles.service.ts',
  'src/modules/permissions/rbac-role-lifecycle-lock.ts',
  'src/modules/permissions/service-principal-role-eligibility.policy.ts',
  'src/modules/integration-authz/direct-principal-authz.service.ts',
] as const;

export const MIN_SCANNED_PRODUCTION_FILES = 552;
export const EXPECTED_APPROVED_DELETE_WRITES = 1;

export const ALL_RULES = [
  'unauthorized-role-delete-write',
  'raw-sql-role-delete-write',
  'opaque-rbac-role-write',
  'approved-entry-missing',
  'approved-write-count-drift',
  'missing-lifecycle-transaction',
  'transaction-identity-mismatch',
  'missing-lifecycle-lock',
  'missing-lock-scoped-reread',
  'missing-protected-role-check',
  'missing-sp-binding-precondition',
  'invalid-lifecycle-order',
  'missing-delete-audit',
] as const;

type LifecycleRule = (typeof ALL_RULES)[number];

const ROLE_WRITE_METHODS = new Set([
  'create',
  'update',
  'updateMany',
  'upsert',
  'delete',
  'deleteMany',
]);
const RAW_SQL_METHODS = new Set([
  '$executeRaw',
  '$executeRawUnsafe',
  '$queryRaw',
  '$queryRawUnsafe',
]);

export interface LifecycleViolation {
  readonly file: string;
  readonly line: number;
  readonly rule: LifecycleRule;
  readonly detail: string;
}

export interface RoleWriteSite {
  readonly file: string;
  readonly line: number;
  readonly method: string;
  readonly receiver: string;
  readonly lifecycleMutation: boolean;
  readonly opaque: boolean;
}

export interface LifecycleGuardReport {
  readonly scannedFiles: readonly string[];
  readonly roleWriteSites: readonly RoleWriteSite[];
  readonly approvedDeleteWrites: readonly RoleWriteSite[];
  readonly violations: readonly LifecycleViolation[];
  readonly anchorFailures: readonly string[];
}

interface PayloadInspection {
  readonly writesDeletedAt: boolean;
  readonly opaque: boolean;
}

interface FileAnalysis {
  readonly violations: LifecycleViolation[];
  readonly roleWriteSites: RoleWriteSite[];
  readonly approvedDeleteWrites: RoleWriteSite[];
}

interface MutationCase {
  readonly label: string;
  readonly file: string;
  readonly source: string;
  readonly expectedRule: LifecycleRule;
}

function normalized(file: string): string {
  return file.split(path.sep).join('/');
}

function lineOf(source: ts.SourceFile, node: ts.Node): number {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

function violation(
  source: ts.SourceFile,
  node: ts.Node,
  rule: LifecycleRule,
  detail: string,
): LifecycleViolation {
  return { file: normalized(source.fileName), line: lineOf(source, node), rule, detail };
}

function propertyName(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return null;
}

function memberCall(call: ts.CallExpression): { method: string; receiver: ts.Expression } | null {
  if (!ts.isPropertyAccessExpression(call.expression)) return null;
  return { method: call.expression.name.text, receiver: call.expression.expression };
}

function memberTag(tag: ts.Expression): { method: string; receiver: ts.Expression } | null {
  if (!ts.isPropertyAccessExpression(tag)) return null;
  return { method: tag.name.text, receiver: tag.expression };
}

function propertyChain(expression: ts.Expression): string[] {
  if (ts.isPropertyAccessExpression(expression)) {
    return [...propertyChain(expression.expression), expression.name.text];
  }
  if (ts.isElementAccessExpression(expression)) {
    const argument = expression.argumentExpression;
    if (
      argument !== undefined &&
      (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument))
    ) {
      return [...propertyChain(expression.expression), argument.text];
    }
    return [];
  }
  if (ts.isIdentifier(expression)) return [expression.text];
  if (expression.kind === ts.SyntaxKind.ThisKeyword) return ['this'];
  return [];
}

function isThisPrisma(expression: ts.Expression): boolean {
  const chain = propertyChain(expression);
  return chain.length === 2 && chain[0] === 'this' && chain[1] === 'prisma';
}

function isTxRbacRole(expression: ts.Expression, txName: string): boolean {
  const chain = propertyChain(expression);
  return chain.length === 2 && chain[0] === txName && chain[1] === 'rbacRole';
}

function receiverContainsRbacRole(expression: ts.Expression): boolean {
  return propertyChain(expression).includes('rbacRole');
}

function enclosingNames(node: ts.Node): { className: string | null; methodName: string | null } {
  let className: string | null = null;
  let methodName: string | null = null;
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (methodName === null && ts.isMethodDeclaration(current) && current.name) {
      methodName = propertyName(current.name);
    }
    if (className === null && ts.isClassDeclaration(current) && current.name) {
      className = current.name.text;
    }
    current = current.parent;
  }
  return { className, methodName };
}

function isApprovedContainer(source: ts.SourceFile, node: ts.Node): boolean {
  const names = enclosingNames(node);
  return (
    normalized(source.fileName).endsWith(APPROVED_ENTRY.file) &&
    names.className === APPROVED_ENTRY.className &&
    names.methodName === APPROVED_ENTRY.methodName
  );
}

function namedObjectProperty(
  object: ts.ObjectLiteralExpression,
  name: string,
): ts.ObjectLiteralElementLike | undefined {
  return object.properties.find((property) => {
    if (ts.isSpreadAssignment(property)) return false;
    if (!('name' in property) || property.name === undefined) return false;
    return propertyName(property.name) === name;
  });
}

function propertyExpression(
  property: ts.ObjectLiteralElementLike | undefined,
): ts.Expression | null {
  if (property === undefined) return null;
  if (ts.isPropertyAssignment(property)) return property.initializer;
  if (ts.isShorthandPropertyAssignment(property)) return property.name;
  return null;
}

function inspectDataExpression(expression: ts.Expression | null): PayloadInspection {
  if (expression === null || !ts.isObjectLiteralExpression(expression)) {
    return { writesDeletedAt: false, opaque: true };
  }

  let writesDeletedAt = false;
  let opaque = false;
  for (const property of expression.properties) {
    if (ts.isSpreadAssignment(property)) {
      opaque = true;
      continue;
    }
    if (
      !('name' in property) ||
      property.name === undefined ||
      ts.isComputedPropertyName(property.name)
    ) {
      opaque = true;
      continue;
    }
    const name = propertyName(property.name);
    if (name === null) {
      opaque = true;
      continue;
    }
    if (name === 'deletedAt') writesDeletedAt = true;
  }
  return { writesDeletedAt, opaque };
}

function inspectDelegatePayload(call: ts.CallExpression, method: string): PayloadInspection {
  if (method === 'delete' || method === 'deleteMany') {
    return { writesDeletedAt: true, opaque: false };
  }

  const input = call.arguments[0];
  if (input === undefined || !ts.isObjectLiteralExpression(input)) {
    return { writesDeletedAt: false, opaque: true };
  }

  const expectedKeys = method === 'upsert' ? ['create', 'update'] : ['data'];
  let writesDeletedAt = false;
  let opaque = false;
  for (const key of expectedKeys) {
    const property = namedObjectProperty(input, key);
    const inspected = inspectDataExpression(propertyExpression(property));
    writesDeletedAt ||= inspected.writesDeletedAt;
    opaque ||= inspected.opaque;
  }
  return { writesDeletedAt, opaque };
}

function objectValue(object: ts.ObjectLiteralExpression, name: string): ts.Expression | null {
  return propertyExpression(namedObjectProperty(object, name));
}

function isIdentifierNamed(expression: ts.Expression | null, name: string): boolean {
  return expression !== null && ts.isIdentifier(expression) && expression.text === name;
}

function objectHasId(object: ts.ObjectLiteralExpression | null, idName: string): boolean {
  if (object === null) return false;
  const property = namedObjectProperty(object, 'id');
  if (property === undefined) return false;
  if (ts.isShorthandPropertyAssignment(property)) return property.name.text === idName;
  return isIdentifierNamed(propertyExpression(property), idName);
}

function objectHasDeletedAtNull(object: ts.ObjectLiteralExpression | null): boolean {
  if (object === null) return false;
  const value = objectValue(object, 'deletedAt');
  return value?.kind === ts.SyntaxKind.NullKeyword;
}

function asObject(expression: ts.Expression | null): ts.ObjectLiteralExpression | null {
  return expression !== null && ts.isObjectLiteralExpression(expression) ? expression : null;
}

function hasWhereIdAndDeletedAtNull(call: ts.CallExpression, idName: string): boolean {
  const input = asObject(call.arguments[0] ?? null);
  const where = asObject(input === null ? null : objectValue(input, 'where'));
  return objectHasId(where, idName) && objectHasDeletedAtNull(where);
}

function isDeletedAtUpdate(call: ts.CallExpression, txName: string, idName: string): boolean {
  const member = memberCall(call);
  if (member === null || member.method !== 'update' || !isTxRbacRole(member.receiver, txName)) {
    return false;
  }
  const input = asObject(call.arguments[0] ?? null);
  const where = asObject(input === null ? null : objectValue(input, 'where'));
  const data = asObject(input === null ? null : objectValue(input, 'data'));
  const deletedAt = data === null ? null : objectValue(data, 'deletedAt');
  return (
    objectHasId(where, idName) && deletedAt !== null && deletedAt.kind !== ts.SyntaxKind.NullKeyword
  );
}

function rawTemplateText(template: ts.TemplateLiteral): string {
  if (ts.isNoSubstitutionTemplateLiteral(template)) return template.text;
  return [template.head.text, ...template.templateSpans.map((span) => span.literal.text)].join(' ');
}

function rawSqlArgument(expression: ts.Expression | undefined): string | null {
  if (expression === undefined) return null;
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
    return expression.text;
  }
  if (ts.isTaggedTemplateExpression(expression)) return rawTemplateText(expression.template);
  return null;
}

function isRoleDeleteSql(sql: string): boolean {
  const roleTable = '(?:"roles"|roles)';
  const update = new RegExp(`\\bUPDATE\\s+${roleTable}\\b[\\s\\S]*\\bdeleted(?:_|)at\\b`, 'i');
  const remove = new RegExp(`\\bDELETE\\s+FROM\\s+${roleTable}\\b`, 'i');
  return update.test(sql) || remove.test(sql);
}

function isLikelyDynamicRoleSql(
  expression: ts.Expression | undefined,
  source: ts.SourceFile,
): boolean {
  return expression !== undefined && /\brole(?:s)?\b/i.test(expression.getText(source));
}

function findCalls(root: ts.Node): ts.CallExpression[] {
  const calls: ts.CallExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) calls.push(node);
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(root, visit);
  return calls;
}

function findMethods(source: ts.SourceFile): ts.MethodDeclaration[] {
  const methods: ts.MethodDeclaration[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node) && node.name?.text === APPROVED_ENTRY.className) {
      for (const member of node.members) {
        if (
          ts.isMethodDeclaration(member) &&
          member.name &&
          propertyName(member.name) === APPROVED_ENTRY.methodName
        ) {
          methods.push(member);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
  return methods;
}

function transactionCallback(
  call: ts.CallExpression,
): ts.ArrowFunction | ts.FunctionExpression | null {
  for (const argument of call.arguments) {
    if (ts.isArrowFunction(argument) || ts.isFunctionExpression(argument)) return argument;
  }
  return null;
}

function isTransactionCall(call: ts.CallExpression): boolean {
  const member = memberCall(call);
  return member !== null && member.method === '$transaction' && isThisPrisma(member.receiver);
}

function isNamedCall(call: ts.CallExpression, name: string): boolean {
  return ts.isIdentifier(call.expression) && call.expression.text === name;
}

function hasExactArguments(call: ts.CallExpression, names: readonly string[]): boolean {
  return (
    call.arguments.length >= names.length &&
    names.every((name, index) => isIdentifierNamed(call.arguments[index] ?? null, name))
  );
}

function isLockedReread(call: ts.CallExpression, txName: string, idName: string): boolean {
  const member = memberCall(call);
  return (
    member !== null &&
    member.method === 'findFirst' &&
    isTxRbacRole(member.receiver, txName) &&
    hasWhereIdAndDeletedAtNull(call, idName)
  );
}

function isProtectedRoleCheck(call: ts.CallExpression): boolean {
  const member = memberCall(call);
  return member !== null && member.method === 'assertRoleNotProtectedOrThrow';
}

function isSpBindingCheck(call: ts.CallExpression, txName: string, idName: string): boolean {
  const member = memberCall(call);
  return (
    member !== null &&
    member.method === 'assertRoleHasNoUndeletedServicePrincipalBindingsOrThrow' &&
    propertyChain(member.receiver).includes('servicePrincipalRoleEligibility') &&
    hasExactArguments(call, [txName, idName])
  );
}

function isDeleteAudit(call: ts.CallExpression, txName: string, idName: string): boolean {
  if (
    !isNamedCall(call, 'writeConfigAudit') ||
    !isIdentifierNamed(call.arguments[0] ?? null, txName)
  ) {
    return false;
  }
  const audit = asObject(call.arguments[1] ?? null);
  if (audit === null) return false;
  const event = objectValue(audit, 'event');
  if (event === null) return false;
  return (
    (ts.isStringLiteral(event) || ts.isNoSubstitutionTemplateLiteral(event)) &&
    event.text === 'rbac-role.delete' &&
    isIdentifierNamed(objectValue(audit, 'resourceId'), idName)
  );
}

function roleWriteSite(
  source: ts.SourceFile,
  call: ts.CallExpression,
  method: string,
  receiver: ts.Expression,
  lifecycleMutation: boolean,
  opaque: boolean,
): RoleWriteSite {
  return {
    file: normalized(source.fileName),
    line: lineOf(source, call),
    method,
    receiver: receiver.getText(source),
    lifecycleMutation,
    opaque,
  };
}

function analyzeApprovedEntry(source: ts.SourceFile): FileAnalysis {
  const violations: LifecycleViolation[] = [];
  const approvedDeleteWrites: RoleWriteSite[] = [];
  const roleWriteSites: RoleWriteSite[] = [];
  const methods = findMethods(source);
  if (methods.length !== 1) {
    violations.push(
      violation(
        source,
        source,
        'approved-entry-missing',
        `唯一合法入口必须是 ${APPROVED_ENTRY.className}.${APPROVED_ENTRY.methodName}()，当前找到 ${methods.length} 个。`,
      ),
    );
    return { violations, approvedDeleteWrites, roleWriteSites };
  }

  const method = methods[0];
  const calls = findCalls(method);
  const transactions = calls.filter(isTransactionCall);
  if (transactions.length !== 1) {
    violations.push(
      violation(
        source,
        method,
        'missing-lifecycle-transaction',
        `删除入口必须在 ${APPROVED_ENTRY.transactionOwner}.$transaction(async (${APPROVED_ENTRY.transactionVariable}) => ...) 中执行，当前找到 ${transactions.length} 个事务闭包。`,
      ),
    );
    return { violations, approvedDeleteWrites, roleWriteSites };
  }

  const transaction = transactions[0];
  const callback = transactionCallback(transaction);
  const txParameter = callback?.parameters[0];
  if (callback === null || txParameter === undefined || !ts.isIdentifier(txParameter.name)) {
    violations.push(
      violation(
        source,
        transaction,
        'missing-lifecycle-transaction',
        'Role 删除事务必须有可识别的单一 transaction callback 参数。',
      ),
    );
    return { violations, approvedDeleteWrites, roleWriteSites };
  }

  const txName = txParameter.name.text;
  const idName = APPROVED_ENTRY.roleIdVariable;
  if (txName !== APPROVED_ENTRY.transactionVariable) {
    violations.push(
      violation(
        source,
        txParameter,
        'transaction-identity-mismatch',
        `生命周期协议固定使用事务变量 ${APPROVED_ENTRY.transactionVariable}，当前为 ${txName}。`,
      ),
    );
  }

  const scopedCalls = findCalls(callback.body);
  const locks = scopedCalls.filter((call) => isNamedCall(call, 'lockRbacRoleLifecycle'));
  const exactLocks = locks.filter((call) => hasExactArguments(call, [txName, idName]));
  const rereads = scopedCalls.filter((call) => isLockedReread(call, txName, idName));
  const protectedChecks = scopedCalls.filter(isProtectedRoleCheck);
  const spBindingChecks = scopedCalls.filter((call) => isSpBindingCheck(call, txName, idName));
  const audits = scopedCalls.filter((call) => isDeleteAudit(call, txName, idName));

  const lifecycleRoleWrites = scopedCalls.filter((call) => {
    const member = memberCall(call);
    if (member === null || !ROLE_WRITE_METHODS.has(member.method)) return false;
    if (!receiverContainsRbacRole(member.receiver)) return false;
    const payload = inspectDelegatePayload(call, member.method);
    return (
      member.method === 'delete' ||
      member.method === 'deleteMany' ||
      payload.writesDeletedAt ||
      payload.opaque
    );
  });
  const exactDeleteWrites = lifecycleRoleWrites.filter((call) =>
    isDeletedAtUpdate(call, txName, idName),
  );
  const unexpectedLifecycleWrites = lifecycleRoleWrites.filter(
    (call) => !isDeletedAtUpdate(call, txName, idName),
  );

  for (const call of exactDeleteWrites) {
    const member = memberCall(call);
    if (member === null) continue;
    const site = roleWriteSite(source, call, member.method, member.receiver, true, false);
    roleWriteSites.push(site);
    approvedDeleteWrites.push(site);
  }

  if (exactLocks.length === 0) {
    violations.push(
      violation(
        source,
        method,
        'missing-lifecycle-lock',
        `删除入口必须先调用 lockRbacRoleLifecycle(${txName}, ${idName})，不能绕过同一 Role 行锁。`,
      ),
    );
  }
  if (rereads.length === 0) {
    violations.push(
      violation(
        source,
        method,
        'missing-lock-scoped-reread',
        `取得锁后必须用 ${txName}.rbacRole.findFirst({ where: { ${idName}, deletedAt: null } }) 重新读取 Role。`,
      ),
    );
  }
  if (protectedChecks.length === 0) {
    violations.push(
      violation(
        source,
        method,
        'missing-protected-role-check',
        '删除入口缺少系统内置 Role 保护检查。',
      ),
    );
  }
  if (spBindingChecks.length === 0) {
    violations.push(
      violation(
        source,
        method,
        'missing-sp-binding-precondition',
        '删除入口缺少未撤销 Service Principal Binding 的删除前资格检查。',
      ),
    );
  }
  if (audits.length === 0) {
    violations.push(
      violation(
        source,
        method,
        'missing-delete-audit',
        '删除入口必须在同一事务内写入 event = rbac-role.delete 的 Config Audit。',
      ),
    );
  }
  if (exactDeleteWrites.length !== EXPECTED_APPROVED_DELETE_WRITES) {
    violations.push(
      violation(
        source,
        method,
        'approved-write-count-drift',
        `唯一批准的 tx.rbacRole.update({ data: { deletedAt } }) 必须恰好 ${EXPECTED_APPROVED_DELETE_WRITES} 个，当前为 ${exactDeleteWrites.length} 个。`,
      ),
    );
  }
  for (const call of unexpectedLifecycleWrites) {
    violations.push(
      violation(
        source,
        call,
        'unauthorized-role-delete-write',
        'softDelete() 内只允许唯一的 tx.rbacRole.update({ where: { id }, data: { deletedAt: 非 null } })；恢复、物理删除、批量写入或无法静态证明的 Role 生命周期写入必须另行扩展受保护裁判并重新拍板。',
      ),
    );
  }

  const identityMismatch =
    locks.some((call) => !hasExactArguments(call, [txName, idName])) ||
    scopedCalls.some((call) => {
      const member = memberCall(call);
      if (member === null || !ROLE_WRITE_METHODS.has(member.method)) return false;
      if (!receiverContainsRbacRole(member.receiver)) return false;
      const payload = inspectDelegatePayload(call, member.method);
      if (
        !(payload.writesDeletedAt || member.method === 'delete' || member.method === 'deleteMany')
      ) {
        return false;
      }
      return !isTxRbacRole(member.receiver, txName);
    }) ||
    scopedCalls.some(
      (call) => isNamedCall(call, 'writeConfigAudit') && !isDeleteAudit(call, txName, idName),
    );
  if (identityMismatch) {
    violations.push(
      violation(
        source,
        method,
        'transaction-identity-mismatch',
        `锁、锁后复读、资格检查、删除写入和 Audit 必须共用 ${txName} 与 Role ID ${idName}。`,
      ),
    );
  }

  const ordered = [
    exactLocks[0],
    rereads[0],
    protectedChecks[0],
    spBindingChecks[0],
    exactDeleteWrites[0],
    audits[0],
  ];
  if (
    ordered.every((node): node is ts.CallExpression => node !== undefined) &&
    ordered.some(
      (node, index) => index > 0 && node.getStart(source) <= ordered[index - 1]!.getStart(source),
    )
  ) {
    violations.push(
      violation(
        source,
        method,
        'invalid-lifecycle-order',
        '固定顺序必须是锁 → 锁后复读 → 内置 Role 保护 → SP Binding 检查 → deletedAt 写入 → 删除 Audit。',
      ),
    );
  }

  return { violations, approvedDeleteWrites, roleWriteSites };
}

function analyzeFile(file: string, text: string): FileAnalysis {
  const source = ts.createSourceFile(normalized(file), text, ts.ScriptTarget.Latest, true);
  const violations: LifecycleViolation[] = [];
  const roleWriteSites: RoleWriteSite[] = [];
  const approvedDeleteWrites: RoleWriteSite[] = [];

  const inspectRawSql = (
    node: ts.CallExpression | ts.TaggedTemplateExpression,
    method: string,
    sql: string | null,
    dynamicExpression: ts.Expression | undefined,
  ): void => {
    if (sql !== null && isRoleDeleteSql(sql)) {
      violations.push(
        violation(
          source,
          node,
          'raw-sql-role-delete-write',
          '原始 SQL 直接写 roles.deleted_at 或 DELETE FROM roles 会绕过唯一的 RbacRolesService.softDelete() 生命周期协议。',
        ),
      );
      return;
    }
    if (
      sql === null &&
      method.startsWith('$executeRaw') &&
      isLikelyDynamicRoleSql(dynamicExpression, source)
    ) {
      violations.push(
        violation(
          source,
          node,
          'raw-sql-role-delete-write',
          '无法静态读取且看起来涉及 Role 的原始写 SQL 不得默认安全；请改走唯一 softDelete 生命周期入口。',
        ),
      );
    }
  };

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const member = memberCall(node);
      if (member !== null && RAW_SQL_METHODS.has(member.method)) {
        inspectRawSql(node, member.method, rawSqlArgument(node.arguments[0]), node.arguments[0]);
      }
      if (
        member !== null &&
        ROLE_WRITE_METHODS.has(member.method) &&
        receiverContainsRbacRole(member.receiver)
      ) {
        const payload = inspectDelegatePayload(node, member.method);
        const lifecycleMutation =
          member.method === 'delete' ||
          member.method === 'deleteMany' ||
          payload.writesDeletedAt ||
          payload.opaque;
        const site = roleWriteSite(
          source,
          node,
          member.method,
          member.receiver,
          lifecycleMutation,
          payload.opaque,
        );
        roleWriteSites.push(site);

        if (payload.opaque) {
          violations.push(
            violation(
              source,
              node,
              'opaque-rbac-role-write',
              `rbacRole.${member.method}() 的 data/create/update 不是可静态展开的内联对象，无法证明没有写入 deletedAt。`,
            ),
          );
        } else if (
          lifecycleMutation &&
          (!isApprovedContainer(source, node) || member.method !== 'update')
        ) {
          violations.push(
            violation(
              source,
              node,
              'unauthorized-role-delete-write',
              `发现 rbacRole.${member.method}() 的删除事实写入；唯一合法入口是 ${APPROVED_ENTRY.file} 的 ${APPROVED_ENTRY.className}.${APPROVED_ENTRY.methodName}()。`,
            ),
          );
        }
      }
      if (
        ts.isElementAccessExpression(node.expression) &&
        receiverContainsRbacRole(node.expression.expression)
      ) {
        violations.push(
          violation(
            source,
            node,
            'opaque-rbac-role-write',
            'rbacRole delegate 的计算属性调用无法证明实际写方法，必须改为可枚举的直接 Prisma delegate 调用。',
          ),
        );
      }
    }
    if (ts.isTaggedTemplateExpression(node)) {
      const member = memberTag(node.tag);
      if (member !== null && RAW_SQL_METHODS.has(member.method)) {
        inspectRawSql(node, member.method, rawTemplateText(node.template), undefined);
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);

  if (normalized(file).endsWith(APPROVED_ENTRY.file)) {
    const approved = analyzeApprovedEntry(source);
    violations.push(...approved.violations);
    approvedDeleteWrites.push(...approved.approvedDeleteWrites);
  }

  return { violations, roleWriteSites, approvedDeleteWrites };
}

/** 分析单个源码文本，供自证变异与薄 criteria spec 使用。 */
export function analyzeSource(file: string, text: string): LifecycleViolation[] {
  return analyzeFile(file, text).violations;
}

function scanProductionFiles(root: string): string[] {
  const sourceRoot = path.join(root, 'src');
  const files: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      const absolute = path.join(directory, entry);
      const stat = statSync(absolute);
      if (stat.isDirectory()) {
        walk(absolute);
        continue;
      }
      if (!stat.isFile() || !entry.endsWith('.ts')) continue;
      if (entry.endsWith('.spec.ts') || entry.endsWith('.e2e-spec.ts')) continue;
      files.push(normalized(path.relative(root, absolute)));
    }
  };
  if (existsSync(sourceRoot)) walk(sourceRoot);
  return files.sort();
}

/** 扫描全部生产 TypeScript，路径与读数排序，供 CLI 与薄 spec 共用。 */
export function analyzeRepository(root: string = ROOT): LifecycleGuardReport {
  const absoluteRoot = path.resolve(root);
  const scannedFiles = scanProductionFiles(absoluteRoot);
  const roleWriteSites: RoleWriteSite[] = [];
  const approvedDeleteWrites: RoleWriteSite[] = [];
  const violations: LifecycleViolation[] = [];
  const anchorFailures: string[] = [];

  for (const anchor of REQUIRED_ANCHOR_FILES) {
    const absolute = path.join(absoluteRoot, anchor);
    if (!existsSync(absolute) || readFileSync(absolute, 'utf8').trim() === '') {
      anchorFailures.push(anchor);
    }
  }

  for (const file of scannedFiles) {
    const result = analyzeFile(file, readFileSync(path.join(absoluteRoot, file), 'utf8'));
    roleWriteSites.push(...result.roleWriteSites);
    approvedDeleteWrites.push(...result.approvedDeleteWrites);
    violations.push(...result.violations);
  }

  const stableViolations = [...violations].sort(
    (left, right) =>
      left.file.localeCompare(right.file) ||
      left.line - right.line ||
      left.rule.localeCompare(right.rule) ||
      left.detail.localeCompare(right.detail),
  );
  return {
    scannedFiles,
    roleWriteSites: [...roleWriteSites].sort(
      (left, right) => left.file.localeCompare(right.file) || left.line - right.line,
    ),
    approvedDeleteWrites: [...approvedDeleteWrites].sort(
      (left, right) => left.file.localeCompare(right.file) || left.line - right.line,
    ),
    violations: stableViolations,
    anchorFailures: [...anchorFailures].sort(),
  };
}

export const CONTROL_VALID_SOURCE = `
class RbacRolesService {
  softDelete(user: unknown, id: string, meta: unknown) {
    return this.prisma.$transaction(async (tx) => {
      await lockRbacRoleLifecycle(tx, id);
      const existing = await tx.rbacRole.findFirst({ where: { id, deletedAt: null } });
      this.assertRoleNotProtectedOrThrow(existing.code, BizCode.PROTECTED_ROLE_DELETE_FORBIDDEN);
      await this.servicePrincipalRoleEligibility.assertRoleHasNoUndeletedServicePrincipalBindingsOrThrow(tx, id);
      await tx.rbacRole.update({ where: { id }, data: { deletedAt: new Date() } });
      await writeConfigAudit(tx, { event: 'rbac-role.delete', resourceId: id, actor: user, meta });
      return existing;
    });
  }
}
`;

const SOURCE_WITHOUT_LOCK = CONTROL_VALID_SOURCE.replace(
  '      await lockRbacRoleLifecycle(tx, id);\n',
  '',
);
const SOURCE_REREAD_BEFORE_LOCK = CONTROL_VALID_SOURCE.replace(
  '      await lockRbacRoleLifecycle(tx, id);\n      const existing = await tx.rbacRole.findFirst({ where: { id, deletedAt: null } });',
  '      const existing = await tx.rbacRole.findFirst({ where: { id, deletedAt: null } });\n      await lockRbacRoleLifecycle(tx, id);',
);
const SOURCE_SP_CHECK_AFTER_WRITE = CONTROL_VALID_SOURCE.replace(
  '      await this.servicePrincipalRoleEligibility.assertRoleHasNoUndeletedServicePrincipalBindingsOrThrow(tx, id);\n      await tx.rbacRole.update({ where: { id }, data: { deletedAt: new Date() } });',
  '      await tx.rbacRole.update({ where: { id }, data: { deletedAt: new Date() } });\n      await this.servicePrincipalRoleEligibility.assertRoleHasNoUndeletedServicePrincipalBindingsOrThrow(tx, id);',
);
const SOURCE_WITHOUT_AUDIT = CONTROL_VALID_SOURCE.replace(
  "      await writeConfigAudit(tx, { event: 'rbac-role.delete', resourceId: id, actor: user, meta });\n",
  '',
);
const SOURCE_WITH_UNAPPROVED_RESTORE = CONTROL_VALID_SOURCE.replace(
  '      return existing;',
  '      await tx.rbacRole.update({ where: { id }, data: { deletedAt: null } });\n      return existing;',
);

export const MUTATION_CASES: readonly MutationCase[] = [
  {
    label: '旁路 Service 直接写 deletedAt 必须被拒绝',
    file: 'src/modules/other/role-bypass.service.ts',
    source: `class OtherService { async remove(tx: unknown, id: string) { await tx.rbacRole.update({ where: { id }, data: { deletedAt: new Date() } }); } }`,
    expectedRule: 'unauthorized-role-delete-write',
  },
  {
    label: '删除 Role 生命周期锁必须报错',
    file: APPROVED_ENTRY.file,
    source: SOURCE_WITHOUT_LOCK,
    expectedRule: 'missing-lifecycle-lock',
  },
  {
    label: '锁后复读移到锁前必须报错',
    file: APPROVED_ENTRY.file,
    source: SOURCE_REREAD_BEFORE_LOCK,
    expectedRule: 'invalid-lifecycle-order',
  },
  {
    label: 'SP Binding 检查移到删除后必须报错',
    file: APPROVED_ENTRY.file,
    source: SOURCE_SP_CHECK_AFTER_WRITE,
    expectedRule: 'invalid-lifecycle-order',
  },
  {
    label: '事务外 this.prisma 写 deletedAt 必须报身份错配',
    file: APPROVED_ENTRY.file,
    source: CONTROL_VALID_SOURCE.replace(
      'await tx.rbacRole.update',
      'await this.prisma.rbacRole.update',
    ),
    expectedRule: 'transaction-identity-mismatch',
  },
  {
    label: 'updateMany 批量写 deletedAt 必须被拒绝',
    file: APPROVED_ENTRY.file,
    source: CONTROL_VALID_SOURCE.replace('tx.rbacRole.update({', 'tx.rbacRole.updateMany({'),
    expectedRule: 'unauthorized-role-delete-write',
  },
  {
    label: '对象展开隐藏 Role 写入必须 fail-closed',
    file: APPROVED_ENTRY.file,
    source: CONTROL_VALID_SOURCE.replace(
      'data: { deletedAt: new Date() }',
      'data: { ...deletePatch }',
    ),
    expectedRule: 'opaque-rbac-role-write',
  },
  {
    label: '计算属性调用 Role delegate 必须 fail-closed',
    file: 'src/modules/other/role-computed-bypass.service.ts',
    source: `class OtherService { async remove(tx: unknown, id: string) { await tx['rbacRole']['update']({ where: { id }, data: { deletedAt: new Date() } }); } }`,
    expectedRule: 'opaque-rbac-role-write',
  },
  {
    label: '原始 SQL 写 roles.deleted_at 必须被拒绝',
    file: 'src/modules/other/role-sql-bypass.service.ts',
    source: `async function remove(tx: unknown) { await tx.$executeRawUnsafe('UPDATE roles SET deleted_at = now()'); }`,
    expectedRule: 'raw-sql-role-delete-write',
  },
  {
    label: '删除 Audit 必须存在',
    file: APPROVED_ENTRY.file,
    source: SOURCE_WITHOUT_AUDIT,
    expectedRule: 'missing-delete-audit',
  },
  {
    label: 'softDelete 内私自恢复 Role 必须被拒绝',
    file: APPROVED_ENTRY.file,
    source: SOURCE_WITH_UNAPPROVED_RESTORE,
    expectedRule: 'unauthorized-role-delete-write',
  },
];

/**
 * 先验证仪器自身，再允许使用仓库扫描结论。
 *
 * 变异必须逐条各自命中：不能只看「随便改一下会红」，否则前一条断言先抛时，
 * 后续维度其实从未执行。这里每个变异只否定一个协议维度。
 */
export function selfCheck(report: LifecycleGuardReport): string[] {
  const problems: string[] = [];
  if (report.scannedFiles.length < MIN_SCANNED_PRODUCTION_FILES) {
    problems.push(
      `生产 TypeScript 扫描面只有 ${report.scannedFiles.length} 个文件，低于地板 ${MIN_SCANNED_PRODUCTION_FILES}。`,
    );
  }
  if (report.anchorFailures.length > 0) {
    problems.push(`关键锚点缺失或为空:${report.anchorFailures.join(', ')}`);
  }
  if (report.approvedDeleteWrites.length !== EXPECTED_APPROVED_DELETE_WRITES) {
    problems.push(
      `批准的 Role 删除写入口为 ${report.approvedDeleteWrites.length} 个，应为 ${EXPECTED_APPROVED_DELETE_WRITES} 个。`,
    );
  }
  if (new Set(ALL_RULES).size !== ALL_RULES.length) {
    problems.push('稳定规则名存在重复，无法作为 CI 与变异对照的可靠锚点。');
  }

  const controlViolations = analyzeSource(APPROVED_ENTRY.file, CONTROL_VALID_SOURCE);
  if (controlViolations.length > 0) {
    problems.push(
      `正确生命周期对照被误报:${controlViolations.map((item) => item.rule).join(', ')}`,
    );
  }
  if (MUTATION_CASES.length < 10) {
    problems.push(`变异样本只有 ${MUTATION_CASES.length} 条，少于 C2.2 要求的 10 条。`);
  }
  for (const mutation of MUTATION_CASES) {
    const rules = analyzeSource(mutation.file, mutation.source).map((item) => item.rule);
    if (!rules.includes(mutation.expectedRule)) {
      problems.push(
        `变异「${mutation.label}」未命中 ${mutation.expectedRule}，实际:${rules.join(', ') || '无'}。`,
      );
    }
  }
  return problems;
}

function main(): void {
  const report = analyzeRepository();
  const problems = selfCheck(report);
  for (const problem of problems) console.error(`🔴 自证失败:${problem}`);

  console.log(`扫描生产 TypeScript 文件:${report.scannedFiles.length}`);
  console.log(`Role 写入口:${report.roleWriteSites.length}`);
  console.log(`批准删除写入口:${report.approvedDeleteWrites.length}`);

  for (const item of report.violations) {
    console.error(`${item.file}:${item.line} ${item.rule} ${item.detail}`);
  }
  if (problems.length > 0 || report.violations.length > 0) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}
