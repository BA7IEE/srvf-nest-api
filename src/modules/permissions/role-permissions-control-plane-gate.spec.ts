import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import * as ts from 'typescript';

// ===== 「成对操作只有一侧有闸」这一**缺陷类**的执行位(第六轮评审 E-B2,2026-08-21)=====
//
// 缺陷类定义:**同一条不变量有多条写路径,只有其中一部分挂了强制闸。**
//
// 实例:`RolePermissionsService` 的授码 `assign()` 自 #399 F1 起就调
// `assertNoControlPlaneCodesOrThrow()`,而撤码 `revoke()` 一个控制面判定都没有 ——
// 它只查了「有没有 rbac.role-permission.delete 权限 / 角色在不在 / 绑定在不在」。
// 于是持 `rbac.role-permission.delete` 的 ops-admin **授不了**控制面码,**却撤得掉**,
// 包括把某个角色的 `rbac.*` / `role-binding.*` 权限一路撤空。
// 这与 E-B1(#1115,`wecom-setting.reset.credentials` 漏进保留集)是同一家族:
// **一侧有闸、另一侧没有**;不同的只是「另一侧」这次是一条方法,上次是一条码。
//
// 本 spec 不修实例,它让这个类**长不回来**:
//   本类里每一个会改写「角色 ↔ 权限」映射的**公开**方法,都必须能到达控制面闸。
//
// 🔴 **为什么必须动态现取方法名,不能写死 `['assign', 'revoke']`**:
//    写死名单就是把缺陷复制一份 —— RBAC 终态方案 PR 4 计划加原子 `PUT`(整体替换某角色的
//    权限集合),那是第三条写路径。写死名单时,新方法与它漏掉的闸会**一起**不在名单里,
//    判据当场变成摆设,而且**全绿**。所以扫描面从 AST 现取:任何新公开方法只要碰了
//    `rolePermission` 写操作,自动进入判定范围。
//
// **判定口径**(刻意,不是省事):
//   - 「会改写映射」= 该方法(含其嵌套函数体,如 `$transaction` 回调)能到达一次
//     `rolePermission` delegate 上的 Prisma 写调用(create / update / upsert / delete 家族),
//     或一次正文提到该连接表的 `$executeRaw*` / `$queryRaw*`。
//   - 「到达」= 直接出现在方法体内,**或**经由本类内的 `this.<私有方法>()` 传递抵达
//     (带环保护)。故意做成传递闭包:否则「把写操作搬进一个私有 helper」就能绕过判据,
//     而那恰恰是重构时最自然的动作。
//   - 「过了闸」= 能到达对 `isControlPlanePermissionCode` 的引用。锚在**共享谓词**而不是
//     私有 helper 名上 —— helper 可以改名/拆分,谓词是 SoT(role-delegation.policy.ts),
//     换掉它就是「另造判定」,那本来就该红。
//
// **已知扫描面边界**(写出来,不假装没有):
//   - 只解析 role-permissions.service.ts 一份文件。映射若从**别的** service 被改写,
//     本判据看不见 —— 但那已不是「成对操作不对称」,而是「多了一条未登记写面」,
//     属另一条不变量(单一写入口),不在本刀射程内。
//   - `delegate['rolePermission']` 这类元素访问写法不认。本仓零使用,且 typecheck 下
//     它比属性访问更费事,不构成现实规避路径。
//   - 静态判据只证明「执法位在」,不证明「运行时一定执行到」(闸被塞进死分支它看不出)。
//     行为面由 test/e2e/role-permissions.e2e-spec.ts 的 E-B2 三条用例守。

const SERVICE_REL_PATH = 'src/modules/permissions/role-permissions.service.ts';
const CLASS_NAME = 'RolePermissionsService';
/** 控制面判定的单一真相;闸必须落在它身上,而不是某个可改名的私有 helper 上。 */
const GATE_PREDICATE = 'isControlPlanePermissionCode';
const GATE_PREDICATE_MODULE = './role-delegation.policy';
/** 「角色 ↔ 权限」映射的 Prisma delegate。 */
const MAPPING_DELEGATE = 'rolePermission';
/** 该连接表在 raw SQL 里的两种写法。 */
const MAPPING_TABLE_RE = /RolePermission|role_permission/i;

const PRISMA_WRITE_METHODS: ReadonlySet<string> = new Set([
  'create',
  'createMany',
  'createManyAndReturn',
  'update',
  'updateMany',
  'updateManyAndReturn',
  'upsert',
  'delete',
  'deleteMany',
]);

const PRISMA_RAW_METHODS: ReadonlySet<string> = new Set([
  '$executeRaw',
  '$executeRawUnsafe',
  '$queryRaw',
  '$queryRawUnsafe',
]);

const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const SERVICE_SOURCE = readFileSync(join(REPO_ROOT, SERVICE_REL_PATH), 'utf8');
const SERVICE_AST = ts.createSourceFile(
  SERVICE_REL_PATH,
  SERVICE_SOURCE,
  ts.ScriptTarget.Latest,
  true,
);

function lineOf(node: ts.Node): number {
  return SERVICE_AST.getLineAndCharacterOfPosition(node.getStart(SERVICE_AST)).line + 1;
}

/** 闸谓词的 import 来源 —— 用来挡「本地另写一个同名函数冒充闸」。 */
function findGatePredicateImportModule(): string | null {
  for (const statement of SERVICE_AST.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings === undefined || !ts.isNamedImports(bindings)) continue;
    const hit = bindings.elements.some((element) => element.name.text === GATE_PREDICATE);
    if (hit && ts.isStringLiteral(statement.moduleSpecifier)) {
      return statement.moduleSpecifier.text;
    }
  }
  return null;
}

function findClass(name: string): ts.ClassDeclaration | null {
  let found: ts.ClassDeclaration | null = null;
  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node) && node.name?.text === name) found = node;
    ts.forEachChild(node, visit);
  };
  visit(SERVICE_AST);
  return found;
}

interface MethodFacts {
  readonly name: string;
  readonly isPublic: boolean;
  readonly line: number;
  /** 方法体内直接出现的 `this.<x>(...)` 被调方法名(用于传递闭包)。 */
  readonly selfCalls: readonly string[];
  /** 方法体内直接出现的映射写点,形如 `tx.rolePermission.delete @ 189`。 */
  readonly directWrites: readonly string[];
  /** 方法体内是否直接引用了控制面谓词。 */
  readonly referencesGatePredicate: boolean;
}

/** 取 `X.rolePermission` 里的 `rolePermission`,或 `tx` 里的 `tx`。 */
function targetName(node: ts.Expression): string | null {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isIdentifier(node)) return node.text;
  return null;
}

function collectMethodFacts(method: ts.MethodDeclaration): MethodFacts {
  const selfCalls: string[] = [];
  const directWrites: string[] = [];
  let referencesGatePredicate = false;

  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === GATE_PREDICATE) {
      referencesGatePredicate = true;
    }

    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const callee = node.expression.name.text;
      const receiver = node.expression.expression;

      // `this.<x>(...)` —— 传递闭包的边
      if (receiver.kind === ts.SyntaxKind.ThisKeyword) {
        selfCalls.push(callee);
      }

      // `<any>.rolePermission.<写方法>(...)`(涵盖 this.prisma.rolePermission.* 与 tx.rolePermission.*)
      if (PRISMA_WRITE_METHODS.has(callee) && targetName(receiver) === MAPPING_DELEGATE) {
        directWrites.push(`${MAPPING_DELEGATE}.${callee}() @ ${SERVICE_REL_PATH}:${lineOf(node)}`);
      }

      // raw SQL 旁路:正文提到该连接表即计入写点(宁可误报,不可漏)
      if (PRISMA_RAW_METHODS.has(callee) && MAPPING_TABLE_RE.test(node.getText(SERVICE_AST))) {
        directWrites.push(`${callee}(<${MAPPING_DELEGATE}>) @ ${SERVICE_REL_PATH}:${lineOf(node)}`);
      }
    }

    ts.forEachChild(node, visit);
  };
  // 从方法节点整棵子树走:`$transaction(async (tx) => …)` 这类嵌套函数体天然被覆盖。
  ts.forEachChild(method, visit);

  const modifiers = ts.getModifiers(method) ?? [];
  const isPublic =
    !ts.isPrivateIdentifier(method.name) &&
    !modifiers.some(
      (modifier) =>
        modifier.kind === ts.SyntaxKind.PrivateKeyword ||
        modifier.kind === ts.SyntaxKind.ProtectedKeyword,
    );

  return {
    name: ts.isIdentifier(method.name) ? method.name.text : method.name.getText(SERVICE_AST),
    isPublic,
    line: lineOf(method),
    selfCalls,
    directWrites,
    referencesGatePredicate,
  };
}

const GATE_PREDICATE_IMPORT_MODULE = findGatePredicateImportModule();
const SERVICE_CLASS = findClass(CLASS_NAME);
const METHODS = new Map<string, MethodFacts>();
for (const member of SERVICE_CLASS?.members ?? []) {
  if (!ts.isMethodDeclaration(member)) continue;
  const facts = collectMethodFacts(member);
  METHODS.set(facts.name, facts);
}

/** 从 `start` 出发,沿本类内的 `this.<x>()` 边做传递闭包,问「有没有一处满足 predicate」。 */
function reaches(start: string, predicate: (facts: MethodFacts) => boolean): boolean {
  const seen = new Set<string>();
  const stack: string[] = [start];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    if (seen.has(current)) continue;
    seen.add(current);
    const facts = METHODS.get(current);
    if (facts === undefined) continue;
    if (predicate(facts)) return true;
    stack.push(...facts.selfCalls);
  }
  return false;
}

const MUTATING_PUBLIC_METHODS: readonly MethodFacts[] = [...METHODS.values()]
  .filter((facts) => facts.isPublic)
  .filter((facts) => reaches(facts.name, (m) => m.directWrites.length > 0))
  .sort((a, b) => a.line - b.line);

describe(`${CLASS_NAME}:改写角色权限映射的公开方法必须全部过控制面闸(E-B2)`, () => {
  // 判据自证:先证明「这次运行真的解析到了东西」,再报数。
  // 沿本仓教训:扫描器坏掉(路径变了 / walker 抛空 / 类改名)时,下面那条主断言会因为
  // 「一个方法都没发现」而**全绿**,恰好在最需要它的时候失效。
  it('判据自证:解析到类与方法、闸谓词确实来自 SoT、写方法非空', () => {
    expect(SERVICE_CLASS).not.toBeNull();
    expect(METHODS.size).toBeGreaterThanOrEqual(2);

    // 闸必须是从 role-delegation.policy 导入的那一个;本地另写同名函数冒充即红。
    expect(GATE_PREDICATE_IMPORT_MODULE).toBe(GATE_PREDICATE_MODULE);

    // 锚点(地板值,不是「恰 N 条」):证明 walker 真的钻进了 `$transaction` 回调,
    // 也证明它认得 `this.prisma.<delegate>` 与 `tx.<delegate>` 两种接收者写法。
    // 将来加了原子 PUT,这里只会多一个,不会红。
    const names = MUTATING_PUBLIC_METHODS.map((facts) => facts.name);
    expect(names).toContain('assign');
    expect(names).toContain('revoke');
    expect(names.length).toBeGreaterThanOrEqual(2);

    // 私有 helper 不该被当成公开写方法混进来。
    expect(names).not.toContain('buildDetailResponse');
  });

  it('每个会改写映射的公开方法都必须到达控制面闸(漏一个即红并点名)', () => {
    const unguarded = MUTATING_PUBLIC_METHODS.filter(
      (facts) => !reaches(facts.name, (m) => m.referencesGatePredicate),
    ).map(
      (facts) =>
        `${CLASS_NAME}.${facts.name}()(${SERVICE_REL_PATH}:${facts.line})` +
        ` 改写了角色权限映射(${facts.directWrites.join(' / ') || '经由私有 helper'}),` +
        `但既未直接引用 ${GATE_PREDICATE},也无法经 this.<私有方法>() 到达它 —— ` +
        '非 SUPER_ADMIN 可借此改动控制面权限映射(E-B2 同款洞)。' +
        `修法:照抄 assign()/revoke() 调 assertNoControlPlaneCodesOrThrow(user, codes),` +
        '不要另造判定。',
    );
    expect(unguarded).toEqual([]);
  });
});
