import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import * as ts from 'typescript';

// ===== 「成对操作只有一侧有闸」这一**缺陷类**的执行位(第六轮评审 E-B2,2026-08-21)=====
//
// 缺陷类定义:**同一条不变量有多条写路径,只有其中一部分挂了强制闸。**
//
// 实例一(E-B2):`RolePermissionsService` 的授码 `assign()` 自 #399 F1 起就调控制面闸,
// 而撤码 `revoke()` 一个控制面判定都没有 —— 持 `rbac.role-permission.delete` 的 ops-admin
// **授不了**控制面码,**却撤得掉**,包括把某个角色的 `rbac.*` / `role-binding.*` 权限撤空。
//
// 实例二(P1-32 PR 3a,2026-08-23):`PROTECTED_ROLE_CODE_SET` 从 #578 落地起
// **只被 `RbacRolesService.softDelete()` 查过一次**。于是 15 个系统内置角色删不掉,
// 但改名、加权限、减权限**全无拦阻** —— 持 `rbac.role-permission.create` 的 ops-admin
// 可以把 `member-profile.read.sensitive`(明文证件号 / 手机)加到 `member` 角色上,
// 控制面闸拦不住它(它不是那 7 条保留码),全体队员当场能看彼此明文 PII。
// 同一家族、同一形状:一处写路径挂了闸,兄弟写路径没挂。
//
// 实例三(P1-32 PR 3b,2026-08-23):`PermissionsService` 的三条写路径里,
// `create()` 查 `assertPermissionCodeCreatable`、`delete()` 查 `assertSeedPermissionDeletable`,
// 两者都锚在同一个谓词 `isSeedPermissionCode` 上;而 `update()` **一个都不查** ——
// 于是 237 条系统权限码造不出、删不掉,`description` 却人人可改,
// 且 `prisma/seed.ts` 的 `update: {}` 保证 seed 永不把它拉回来。
// 第三次同一形状:两条腿挂了闸,第三条腿裸奔。
//
// ⚠️ 实例三与前两个的差别值得写下来:它**不是**「漏接」,是**推翻一条刻意设计** ——
//    那句 `update: {}` 的注释当年逐字写着「防止运营运行时调整被 seed 回退」。
//    改立场的理由见 biz-code 30110 的注释块(PR 0 之后 description 有了代码侧权威源)。
//
// 本 spec 不修实例,它让这个类**长不回来**:
//   下列三份 service 里,每一个会改写「角色行」「角色 ↔ 权限映射」或「Permission 行」的
//   **公开**方法,都必须能到达该写面对应的**全部**闸。
//
// 🔴 **为什么必须动态现取方法名,不能写死 `['assign', 'revoke']`**:
//    写死名单就是把缺陷复制一份 —— RBAC 终态方案 PR 4 计划加原子 `PUT`(整体替换某角色的
//    权限集合),那是第三条写路径。写死名单时,新方法与它漏掉的闸会**一起**不在名单里,
//    判据当场变成摆设,而且**全绿**。所以扫描面从 AST 现取:任何新公开方法只要碰了
//    被登记的写面,自动进入判定范围。
//
// **判定口径**(刻意,不是省事):
//   - 「会改写」= 该方法(含其嵌套函数体,如 `$transaction` 回调)能到达一次该写面 delegate
//     上的 Prisma 写调用,或一次正文提到该表的 `$executeRaw*` / `$queryRaw*`。
//   - 「到达」= 直接出现在方法体内,**或**经由本类内的 `this.<私有方法>()` 传递抵达
//     (带环保护)。故意做成传递闭包:否则「把写操作/把闸搬进一个私有 helper」就能绕过判据,
//     而那恰恰是重构时最自然的动作。发现侧与满足侧走的是**同一个**闭包函数。
//   - 「过了闸」= 能到达对该闸**共享谓词**的引用。锚在谓词而不是私有 helper 名上 ——
//     helper 可以改名/拆分,谓词是 SoT(role-delegation.policy.ts / protected-role-codes.ts),
//     换掉它就是「另造判定」,那本来就该红。
//
// **各写面的口径差**(这一条最容易被后来者改错,写清楚):
//   - `rolePermission`:**任何**写方法都算(含 `create` 家族)。新建一条映射的目标角色
//     本来就是既有角色,加一条码和减一条码是同一条不变量的两条腿。
//   - `rbacRole`:只有**改既有行**的写方法算(`update` / `upsert` / `delete` 家族),
//     `create` 家族**不算**。理由不是「懒得管」:新建角色时 code 由调用方给,
//     撞上任何内置角色 code 都会先被 code unique 预检查判成 30004 —— 结构上不可能
//     用 `create` 改到一个内置角色。把 `create` 拉进来只会产出恒定的误红。
//     👉 判据自证里有一条**专门钉住这个区分是活的**(`create` 必须不在名单里),
//        否则「口径退化成认所有写方法」会静默通过。
//   - `permission`:**任何**写方法都算(含 `create` 家族),与 `rbacRole` 面**刻意相反**。
//     差别是结构性的:`permission.create` 恰恰**只对闭包内的码有意义**(闭包外的码是惰性的,
//     30106),它必须查同一个谓词才知道该拒哪边;而 `rbacRole.create` 结构上够不到内建角色。
//
// **已知扫描面边界**(写出来,不假装没有):
//   - 只解析下面 SCAN_TARGETS 列的那几份文件。角色 / 映射 / Permission 行若从**别的**
//     service 被改写,本判据看不见 —— 但那已不是「兄弟写路径漏挂闸」,而是「多了一条未登记
//     写面」,属另一条不变量(单一写入口),不在本刀射程内。
//   - `delegate['rbacRole']` 这类元素访问写法不认。本仓零使用,且 typecheck 下
//     它比属性访问更费事,不构成现实规避路径。
//   - 静态判据只证明「执法位在」,不证明「运行时一定执行到」(闸被塞进死分支它看不出)。
//     行为面由 test/e2e/role-permissions.e2e-spec.ts(E-B2 三条)与
//     test/e2e/rbac-delegation-safety.e2e-spec.ts(D3 / PR 3a 两组)守。

interface ScanTarget {
  readonly relPath: string;
  readonly className: string;
}

const SCAN_TARGETS: readonly ScanTarget[] = [
  {
    relPath: 'src/modules/permissions/role-permissions.service.ts',
    className: 'RolePermissionsService',
  },
  { relPath: 'src/modules/permissions/rbac-roles.service.ts', className: 'RbacRolesService' },
  { relPath: 'src/modules/permissions/permissions.service.ts', className: 'PermissionsService' },
];

/** 闸 = 一个共享谓词 + 它必须来自的 SoT 模块。 */
interface GateSpec {
  readonly id: string;
  readonly predicate: string;
  readonly module: string;
  /** 漏挂时打给人看的一句话(说清后果,不只是「没过闸」)。 */
  readonly damage: string;
}

const GATES: readonly GateSpec[] = [
  {
    id: 'controlPlane',
    predicate: 'isControlPlanePermissionCode',
    module: './role-delegation.policy',
    damage:
      '控制面权限码(SA-only 保留码 ∪ rbac.* ∪ role-binding.*)的角色映射可被绕过闸改动 —— ' +
      '授码方向等于把 SA-only 能力沉淀成某角色的常驻权限(E-B2 / #399 F1 同款洞)',
  },
  {
    id: 'protectedRole',
    predicate: 'isProtectedRoleCode',
    module: './protected-role-codes',
    damage:
      '15 个 seed 内置角色可被运行时改动 —— 例如把 member-profile.read.sensitive(明文证件号 / 手机)' +
      '加到 member 角色上,全体队员当场能看彼此明文 PII(P1-32 PR 3a 同款洞)',
  },
  {
    id: 'seedPermission',
    predicate: 'isSeedPermissionCode',
    module: './seed-permission-codes',
    damage:
      'seed 事实闭包内的 237 条权限码行可被运行时改写 —— 这些行的 description 权威源是代码' +
      '(permission-catalog.ts 各 *_PERMISSION_SEED 的 description),而 prisma/seed.ts 的 ' +
      'upsert 用 `update: {}` 永不回写 ⇒ 改过之后 DB 与代码常量各存一份、无人比对,' +
      '且没有任何入口能把它拉回来(P1-32 PR 3b)',
  },
];

const GATE_BY_ID = new Map(GATES.map((gate) => [gate.id, gate]));

const ALL_PRISMA_WRITE_METHODS: ReadonlySet<string> = new Set([
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

/** 只改**既有行**的写方法(不含 create 家族);上面「两个写面的口径差」解释了为什么要分。 */
const EXISTING_ROW_WRITE_METHODS: ReadonlySet<string> = new Set([
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

/** 一个「写面」= 一个 Prisma delegate + 算数的写方法集 + 它必须过的闸。 */
interface WriteSurface {
  readonly id: string;
  readonly delegate: string;
  readonly writeMethods: ReadonlySet<string>;
  readonly tablePattern: RegExp;
  readonly requiredGateIds: readonly string[];
  readonly what: string;
}

const WRITE_SURFACES: readonly WriteSurface[] = [
  {
    id: 'roleMapping',
    delegate: 'rolePermission',
    writeMethods: ALL_PRISMA_WRITE_METHODS,
    tablePattern: /RolePermission|role_permission/i,
    requiredGateIds: ['controlPlane', 'protectedRole'],
    what: '角色 ↔ 权限映射',
  },
  {
    id: 'roleRow',
    delegate: 'rbacRole',
    writeMethods: EXISTING_ROW_WRITE_METHODS,
    tablePattern: /RbacRole|rbac_role/i,
    requiredGateIds: ['protectedRole'],
    what: '既有角色行',
  },
  {
    id: 'permissionRow',
    delegate: 'permission',
    // 三条腿都算(含 create 家族)—— 与 `rbacRole` 面的口径**刻意相反**,理由是结构性的:
    // `rbacRole.create` 撞内建 code 会先被 unique 预检查判掉,改不到内建角色;
    // 而 `permission.create` 恰恰**只对闭包内的码有意义**(闭包外的码是惰性的,30106),
    // 它必须查同一个谓词才知道该拒哪边。现网三条腿(create/update/delete)确实都查它。
    writeMethods: ALL_PRISMA_WRITE_METHODS,
    // ⚠️ 不能写成 /Permission|permissions/i —— 那会连 `RolePermission` / `role_permissions`
    //    一起吃掉,把映射面的 raw SQL 误算成本面的写点。`\b` 在这两个串里都不成立
    //    (`RolePermission` 的 e|P 与 `role_permissions` 的 _|p 都是词内相邻)。
    tablePattern: /\bPermission\b|\bpermissions\b/,
    requiredGateIds: ['seedPermission'],
    what: 'Permission 行(权限码定义)',
  },
];

/**
 * **只给判据自证用的探针面**:`rbacRole` 上的**全部**写方法(含 create 家族)。
 *
 * 它不参与主断言(不在 WRITE_SURFACES 里,没有 requiredGateIds),存在的唯一目的是让
 * 「roleRow 面刻意排除 create」这件事**两个方向都可证**:
 *   - create 确实写了 rbacRole（本面能看见它）
 *   - 但它确实不在受闸名单里（roleRow 面看不见它）
 * 少了这条,口径退化成「认所有写方法」时全套判据照样绿。
 */
const SELF_PROOF_ANY_ROLE_ROW_WRITE: WriteSurface = {
  id: 'roleRowAnyWrite',
  delegate: 'rbacRole',
  writeMethods: ALL_PRISMA_WRITE_METHODS,
  tablePattern: /RbacRole|rbac_role/i,
  requiredGateIds: [],
  what: '角色行(任意写,仅自证用)',
};

/** walker 扫描面 = 受闸写面 + 自证探针面;主断言只遍历 WRITE_SURFACES。 */
const SCANNED_SURFACES: readonly WriteSurface[] = [
  ...WRITE_SURFACES,
  SELF_PROOF_ANY_ROLE_ROW_WRITE,
];

const REPO_ROOT = resolve(__dirname, '..', '..', '..');

interface MethodFacts {
  readonly name: string;
  readonly isPublic: boolean;
  readonly line: number;
  /** 方法体内直接出现的 `this.<x>(...)` 被调方法名(用于传递闭包)。 */
  readonly selfCalls: readonly string[];
  /** surfaceId → 方法体内直接出现的写点,形如 `rolePermission.createMany() @ …:146`。 */
  readonly directWrites: ReadonlyMap<string, readonly string[]>;
  /** 方法体内直接引用到的闸谓词 id 集合。 */
  readonly gateRefs: ReadonlySet<string>;
}

interface ParsedFile {
  readonly target: ScanTarget;
  readonly ast: ts.SourceFile;
  readonly classFound: boolean;
  readonly methods: ReadonlyMap<string, MethodFacts>;
  /** 谓词名 → 它在本文件里的 import 来源(未 import 则不在表里)。 */
  readonly predicateImports: ReadonlyMap<string, string>;
}

function findClassDeclaration(ast: ts.SourceFile, name: string): ts.ClassDeclaration | null {
  let found: ts.ClassDeclaration | null = null;
  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node) && node.name?.text === name) found = node;
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return found;
}

function parseTarget(target: ScanTarget): ParsedFile {
  const source = readFileSync(join(REPO_ROOT, target.relPath), 'utf8');
  const ast = ts.createSourceFile(target.relPath, source, ts.ScriptTarget.Latest, true);
  const lineOf = (node: ts.Node): number =>
    ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1;

  // 闸谓词的 import 来源 —— 用来挡「本地另写一个同名函数冒充闸」。
  const predicateImports = new Map<string, string>();
  for (const statement of ast.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings === undefined || !ts.isNamedImports(bindings)) continue;
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
    for (const element of bindings.elements) {
      if (GATES.some((gate) => gate.predicate === element.name.text)) {
        predicateImports.set(element.name.text, statement.moduleSpecifier.text);
      }
    }
  }

  const classNode = findClassDeclaration(ast, target.className);

  const collect = (method: ts.MethodDeclaration): MethodFacts => {
    const selfCalls: string[] = [];
    const directWrites = new Map<string, string[]>();
    const gateRefs = new Set<string>();

    // 取 `X.rbacRole` 里的 `rbacRole`,或 `tx` 里的 `tx`。
    const targetName = (node: ts.Expression): string | null => {
      if (ts.isPropertyAccessExpression(node)) return node.name.text;
      if (ts.isIdentifier(node)) return node.text;
      return null;
    };

    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node)) {
        for (const gate of GATES) {
          if (node.text === gate.predicate) gateRefs.add(gate.id);
        }
      }

      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const callee = node.expression.name.text;
        const receiver = node.expression.expression;

        // `this.<x>(...)` —— 传递闭包的边
        if (receiver.kind === ts.SyntaxKind.ThisKeyword) selfCalls.push(callee);

        for (const surface of SCANNED_SURFACES) {
          const push = (label: string): void => {
            const arr = directWrites.get(surface.id) ?? [];
            arr.push(label);
            directWrites.set(surface.id, arr);
          };

          // `<any>.<delegate>.<写方法>(...)`(涵盖 this.prisma.X.* 与 tx.X.* 两种接收者)
          if (surface.writeMethods.has(callee) && targetName(receiver) === surface.delegate) {
            push(`${surface.delegate}.${callee}() @ ${target.relPath}:${lineOf(node)}`);
          }

          // raw SQL 旁路:正文提到该表即计入写点(宁可误报,不可漏)
          if (PRISMA_RAW_METHODS.has(callee) && surface.tablePattern.test(node.getText(ast))) {
            push(`${callee}(<${surface.delegate}>) @ ${target.relPath}:${lineOf(node)}`);
          }
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
      name: ts.isIdentifier(method.name) ? method.name.text : method.name.getText(ast),
      isPublic,
      line: lineOf(method),
      selfCalls,
      directWrites,
      gateRefs,
    };
  };

  const methods = new Map<string, MethodFacts>();
  for (const member of classNode?.members ?? []) {
    if (!ts.isMethodDeclaration(member)) continue;
    const facts = collect(member);
    methods.set(facts.name, facts);
  }

  return { target, ast, classFound: classNode !== null, methods, predicateImports };
}

const PARSED: readonly ParsedFile[] = SCAN_TARGETS.map(parseTarget);
const PARSED_BY_PATH = new Map(PARSED.map((file) => [file.target.relPath, file]));

const ROLE_PERMISSIONS_FILE = 'src/modules/permissions/role-permissions.service.ts';
const RBAC_ROLES_FILE = 'src/modules/permissions/rbac-roles.service.ts';
const PERMISSIONS_FILE = 'src/modules/permissions/permissions.service.ts';

/**
 * 从 `start` 出发,沿本类内的 `this.<x>()` 边做传递闭包,问「有没有一处满足 predicate」。
 * 发现侧(哪些方法算写方法)与满足侧(它过没过闸)共用本函数 —— 两侧口径必须同一份,
 * 否则「把写操作搬进私有 helper」会同时造成漏抓与误红(仓内踩过)。
 */
function reaches(
  file: ParsedFile,
  start: string,
  predicate: (facts: MethodFacts) => boolean,
): boolean {
  const seen = new Set<string>();
  const stack: string[] = [start];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    if (seen.has(current)) continue;
    seen.add(current);
    const facts = file.methods.get(current);
    if (facts === undefined) continue;
    if (predicate(facts)) return true;
    stack.push(...facts.selfCalls);
  }
  return false;
}

function mutatingPublicMethods(file: ParsedFile, surface: WriteSurface): readonly MethodFacts[] {
  return [...file.methods.values()]
    .filter((facts) => facts.isPublic)
    .filter((facts) =>
      reaches(file, facts.name, (m) => (m.directWrites.get(surface.id)?.length ?? 0) > 0),
    )
    .sort((a, b) => a.line - b.line);
}

function namesOf(relPath: string, surfaceId: string): string[] {
  const file = PARSED_BY_PATH.get(relPath) as ParsedFile;
  const surface = SCANNED_SURFACES.find((s) => s.id === surfaceId) as WriteSurface;
  return mutatingPublicMethods(file, surface).map((facts) => facts.name);
}

describe('RBAC 写路径必须全部过闸:控制面授码闸(E-B2)+ 系统内置角色只读闸(PR 3a)+ 权限目录闸(PR 3b)', () => {
  // 判据自证:先证明「这次运行真的解析到了东西」,再报数。
  // 沿本仓教训:扫描器坏掉(路径变了 / walker 抛空 / 类改名)时,下面那条主断言会因为
  // 「一个方法都没发现」而**全绿**,恰好在最需要它的时候失效。
  it('判据自证:两份 service 都解析到了类与方法,闸谓词确实来自 SoT', () => {
    for (const file of PARSED) {
      expect(file.classFound).toBe(true);
      expect(file.methods.size).toBeGreaterThanOrEqual(2);
    }

    // 三条已知的「闸必须来自 SoT」配对(地板值);本地另写同名函数冒充即红。
    const rolePermissions = PARSED_BY_PATH.get(ROLE_PERMISSIONS_FILE) as ParsedFile;
    const rbacRoles = PARSED_BY_PATH.get(RBAC_ROLES_FILE) as ParsedFile;
    expect(rolePermissions.predicateImports.get('isControlPlanePermissionCode')).toBe(
      './role-delegation.policy',
    );
    expect(rolePermissions.predicateImports.get('isProtectedRoleCode')).toBe(
      './protected-role-codes',
    );
    expect(rbacRoles.predicateImports.get('isProtectedRoleCode')).toBe('./protected-role-codes');
    const permissions = PARSED_BY_PATH.get(PERMISSIONS_FILE) as ParsedFile;
    expect(permissions.predicateImports.get('isSeedPermissionCode')).toBe(
      './seed-permission-codes',
    );
  });

  it('判据自证:两个写面各自的发现结果非空且点名正确(地板锚点,不是「恰 N 个」)', () => {
    // 映射面:证明 walker 真的钻进了 `$transaction` 回调,
    // 也证明它认得 `this.prisma.<delegate>` 与 `tx.<delegate>` 两种接收者写法。
    // 将来加了原子 PUT,这里只会多一个,不会红。
    const mapping = namesOf(ROLE_PERMISSIONS_FILE, 'roleMapping');
    expect(mapping).toContain('assign');
    expect(mapping).toContain('revoke');
    expect(mapping.length).toBeGreaterThanOrEqual(2);

    // 角色行面:update / softDelete 都改既有行。
    const roleRow = namesOf(RBAC_ROLES_FILE, 'roleRow');
    expect(roleRow).toContain('update');
    expect(roleRow).toContain('softDelete');
    expect(roleRow.length).toBeGreaterThanOrEqual(2);

    // Permission 行面(P1-32 PR 3b):三条腿都必须被发现。
    // ⭐ `update` 在这里是**本刀的靶子** —— 它此前不在任何受闸名单里,
    //    发现侧看得见它、满足侧要求它过闸,两件事合起来才是这一刀的执行位。
    const permissionRow = namesOf(PERMISSIONS_FILE, 'permissionRow');
    expect(permissionRow).toContain('create');
    expect(permissionRow).toContain('update');
    expect(permissionRow).toContain('delete');
    expect(permissionRow.length).toBeGreaterThanOrEqual(3);
  });

  it('判据自证:`rbacRole` 面的「只认改既有行」口径是活的 —— create 必须不在名单里', () => {
    // 🔴 这条**不能省**。口径若退化成「认所有写方法」(例如有人把 EXISTING_ROW_WRITE_METHODS
    //    换成 ALL_PRISMA_WRITE_METHODS 图省事),上面两条自证与主断言**照样全绿**,
    //    代价是 create() 恒定误红、后来者随手加个 eslint-disable 或把闸削软来止血。
    //    这里正面钉住:create 确实写了 rbacRole,但确实不该进名单。
    // 方向一:create 确实写了 rbacRole —— 由「任意写」探针面看见它。
    //   (若这条为假,下面那条 not.toContain 就是在一个空集上做断言,恒绿且毫无意义。)
    expect(namesOf(RBAC_ROLES_FILE, 'roleRowAnyWrite')).toContain('create');
    // 方向二:但它确实不在受闸名单里。
    expect(namesOf(RBAC_ROLES_FILE, 'roleRow')).not.toContain('create');
    // 两个方向都成立 ⇒ 差别只可能来自「排除了 create 家族」这一条口径。
    expect(EXISTING_ROW_WRITE_METHODS.has('create')).toBe(false);
    expect(ALL_PRISMA_WRITE_METHODS.has('create')).toBe(true);
  });

  it('判据自证:isPublic 两个方向都有覆盖(恒 true 也必须红)', () => {
    // - 恒 false ⇒ 上面 toContain('assign') 会红(assign 是公开的);
    // - 恒 true  ⇒ 上面那些**照样全绿**(两个类当前都没有会写这两个面的私有方法,
    //   坏掉的过滤器不会把任何东西多放进来)。故这里单独钉住「确实认出了私有」。
    const privateNames = (relPath: string): string[] =>
      [...(PARSED_BY_PATH.get(relPath) as ParsedFile).methods.values()]
        .filter((facts) => !facts.isPublic)
        .map((facts) => facts.name);

    expect(privateNames(ROLE_PERMISSIONS_FILE)).toContain('assertControlPlaneCodesOrThrow');
    expect(privateNames(ROLE_PERMISSIONS_FILE)).toContain('assertRoleMutableOrThrow');
    expect(privateNames(RBAC_ROLES_FILE)).toContain('assertRoleNotProtectedOrThrow');
    expect(privateNames(PERMISSIONS_FILE)).toContain('assertSeedPermissionUpdatable');
  });

  it('判据自证:`permission` 面的表名正则不吃 `RolePermission` / `role_permissions`', () => {
    // 🔴 这条钉住上面那段注释里的断言本身。写成 /Permission|permissions/i 时,
    //    映射面的 raw SQL 会被同时算成 Permission 行的写点 —— 那是一个**恒定误红**的来源,
    //    而止血手法通常是把闸削软。这里正面证明两个方向:该匹配的匹配、不该的不匹配。
    const surface = SCANNED_SURFACES.find((s) => s.id === 'permissionRow') as WriteSurface;
    // 取样一律用**raw SQL 里真会出现的形态** —— 这个正则只被喂 `$executeRaw*` / `$queryRaw*`
    // 调用的正文,拿 `Prisma.PermissionSelect` 这种类型名当样本是在测一件不会发生的事。
    //
    // 方向一:真表名 / 真模型名认得(否则下面的否定是在一个恒 false 的正则上做的,毫无意义)。
    expect(surface.tablePattern.test('SELECT * FROM "permissions"')).toBe(true);
    expect(surface.tablePattern.test('UPDATE permissions SET description = $1')).toBe(true);
    expect(surface.tablePattern.test('DELETE FROM Permission WHERE id = $1')).toBe(true);
    // 方向二:兄弟写面的名字一律不认(词内相邻,`\b` 不成立)。
    expect(surface.tablePattern.test('SELECT * FROM "role_permissions"')).toBe(false);
    expect(surface.tablePattern.test('DELETE FROM RolePermission WHERE roleId = $1')).toBe(false);
  });

  it('每个会改写角色 / 角色权限映射 / Permission 行的公开方法,都必须到达该写面的全部闸(漏一个即红并点名)', () => {
    const unguarded: string[] = [];

    for (const file of PARSED) {
      for (const surface of WRITE_SURFACES) {
        for (const facts of mutatingPublicMethods(file, surface)) {
          for (const gateId of surface.requiredGateIds) {
            const gate = GATE_BY_ID.get(gateId) as GateSpec;
            if (reaches(file, facts.name, (m) => m.gateRefs.has(gateId))) continue;
            unguarded.push(
              `${file.target.className}.${facts.name}()(${file.target.relPath}:${facts.line})` +
                ` 改写了${surface.what}` +
                `(${facts.directWrites.get(surface.id)?.join(' / ') ?? '经由私有 helper'}),` +
                `但既未直接引用 ${gate.predicate},也无法经 this.<私有方法>() 到达它。` +
                `后果:${gate.damage}。` +
                `修法:照抄同类方法调那道闸(不要另造判定,谓词只能是 ${gate.module} 里的 ${gate.predicate})。`,
            );
          }
        }
      }
    }

    expect(unguarded).toEqual([]);
  });
});
