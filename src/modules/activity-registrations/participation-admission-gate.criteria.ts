/**
 * 「正式准入必须锁后重验被录取人」的**结构判据实现**(第六轮评审 C-BLOCKER-1 的执行位)。
 *
 * 缺陷类(不是单个实例):某条路径把参与域永久身份写成 `pass`,却没有在**同一事务内**、
 * **占名额之前**重新确认「被录取的这个人此刻仍是 live 且 ACTIVE 的队员」。
 * 后果是已离队 / 被软删 / 转非 ACTIVE 的人被自动录取,占掉名额并被投影成 `populationIncluded`。
 * 第一个实例是 `activity-allocation.service.ts` 的候补递补路径 —— 兄弟路径都查,唯独它不查。
 *
 * **修实例不修类,下一条准入路径接进来时会照样漏。** 本模块就是那个类闸。
 *
 * ── 为什么「查过 MemberStatus.ACTIVE」这个判法不够 ──
 * 同一个文件里既有**对操作人**的准入复核(`assertAppAdmissionStillLive(tx, currentUser.id,
 * currentUser.memberId)`),也需要**对被录取人**的复核。只问「有没有引用 MemberStatus.ACTIVE」
 * 会被前者满足 —— 上层边界遮蔽下层边界,判据全绿而洞还在。所以本闸要求重验的实参
 * **不是操作人自己**(见 `isActorDerived`),这一条才是它真正的执法力。
 *
 * ── 判据放在 `src/**` 的 spec 而不是 `scripts/` ──
 *   1. `scripts/**` 属执法层红区,新增守卫要维护者授权 + CI 环境审批;
 *   2. 更重要的是**接线**:unit 配置按 `src/.*\.spec\.ts` 自动收集,判据天然进
 *      `pnpm test` / `agent:check:quick` / CI。本仓栽过「命令写在 package.json 却没接 CI
 *      ⇒ 闸红了没人消费 = 没有执法」的账,这里不再造第二条需要单独接线的路。
 *
 * ── 扫描面是**动态现取**的 ──
 * 不存在「五条准入路径」的名单:准入写入点由 AST 现扫(`collectProdFiles()` 走真实目录),
 * 判定用的谓词集合也由全仓现扫得出(见 `buildPredicates`)。写死名单等于「第六条路径
 * 接进来时照样漏」,那正是本闸要根除的东西。反向对照(新增一个写 pass 但不查 ACTIVE 的方法
 * ⇒ 必红)在 spec 里坐实这一点。
 *
 * ── 本闸**不**管什么(边界写在这里,免得「零 finding」被读成「全仓无缺口」)──
 * 1. 只看**参与域永久身份链**(`activityParticipationRevision` / `activityParticipationIdentity`)
 *    上把状态置成字面量 `'pass'` 的写。按 `activity-registrations/CLAUDE.md`,canonical
 *    participation 只由 allocation 链推进,`'pass'` 是它唯一的正式录取值。legacy
 *    `ActivityRegistration` 头链是另一条(自动递补只写 `waitlisted → pending`,由后续 approve
 *    另行准入),不在本闸管辖。
 * 2. 只证明「这条事务路径上**有**一次针对非操作人的锁后 Member 重验」,**不**证明重验的那个人
 *    就是被写成 pass 的那个人 —— 跨栈帧后同一个变量名指的已不是同一个人,文本比对无从成立。
 *    「查的是不是同一个人」由 e2e 的真实时序用例承担。
 * 3. 调用边只解析 `this.foo()` / 同文件函数 / 相对 import / 构造器注入的 `this.svc.foo()`。
 *    解析不出就是**不记功** —— 方向上 fail-closed(判红),不会把没查当成查过。
 *
 * `counts` 会把实际覆盖到的写入点数暴露出来 —— 数字掉到 0 就是判据失明,不是合规。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import * as ts from 'typescript';

export const REPO_ROOT = join(__dirname, '..', '..', '..');
const SRC = join(REPO_ROOT, 'src');

/** 参与域永久身份链 —— canonical participation 的两张表。 */
export const PARTICIPATION_DELEGATES = [
  'activityParticipationRevision',
  'activityParticipationIdentity',
] as const;

/** 正式录取值。写成常量是为了让报错文本和判据用同一个字面量,不各写各的。 */
export const ADMISSION_STATUS = 'pass';

/** 承载准入状态的字段(revision 上是 statusCode,identity 投影上是 currentStatusCode)。 */
const STATUS_FIELDS = ['statusCode', 'currentStatusCode'];

const WRITE_METHODS = new Set([
  'create',
  'createMany',
  'createManyAndReturn',
  'upsert',
  'update',
  'updateMany',
]);

/** Member 行锁的结构指纹 —— 谓词种子之一,同时是 G3(必须**锁后**重验)的判据。 */
function locksMemberRow(text: string): boolean {
  return /FROM\s+"Member"/.test(text) && /FOR\s+(UPDATE|SHARE)/.test(text);
}

/**
 * 判据自身按构造必须**指名它所寻找的东西**,否则无从检查 —— 故本文件与其 spec 不参与扫描。
 * 这不是逃生门:两者都不注入 Prisma,写不出任何 participation 事实。
 */
const SELF = [
  'src/modules/activity-registrations/participation-admission-gate.criteria.ts',
  'src/modules/activity-registrations/participation-admission-gate.criteria.spec.ts',
];

/**
 * **已登记的未修复敞口**(open gap)。
 *
 * 本闸接进来时,全仓除候补递补外还剩这一处同类缺陷。它没有在同一刀里顺手修,
 * 因为怎么修是**业务拍板**而不是接线活(见各条 reason)。登记在这里的效果是:
 * 它**可见、且被机器盯住**,而不是留在没人知道的暗处 —— 但也**不会**让闸变绿。
 *
 * 🔴 登记表是**自清洁**的:一旦某条被修好(或方法被改名 / 删除),它就不再是违规,
 * 判据会为这条登记项报 **G4 已过期**并转红,逼这一行被删掉。所以它不可能变成
 * 「冻结名单把新缺陷一起盖住」—— 盖不住新的(新缺陷不在表里,照常 G2 红),
 * 也留不住旧的(修好了就必须清理)。
 */
export const DECLARED_OPEN_ADMISSION_GAPS: Record<string, string> = {
  'src/modules/activity-registrations/activity-allocation.service.ts#persistCommittedCandidate':
    'rank / lottery 批次 commit 路径 —— 与候补递补(C-BLOCKER-1)同类的第二个实例,由本闸接入时扫出。' +
    '刻意不在同一刀内修:批次结果是**冻结并可公开核验**的(candidate 快照 hash + lottery seed + commit 回执),' +
    '「候选在 prepare 到 commit 之间转非 ACTIVE 时应当跳过、判 not_selected、还是整批拒绝」' +
    '会改变已公示的分配结果,属维护者拍板范围,不是接线活。',
};

export type Finding = {
  criterion: 'G2' | 'G3' | 'G4';
  detail: string;
};

export type Counts = {
  /** 扫到的生产文件数 —— 为 0 说明目录遍历本身坏了。 */
  scannedFiles: number;
  /** 识别出的「写 pass」方法数 —— 为 0 说明判据失明,零 finding 是空绿不是合规。 */
  admissionWriters: number;
  /** 其中通过重验的 —— 为 0 说明没有任何正样本,判据没被真正走通过。 */
  guardedWriters: number;
  /** 全仓现扫出的「队员 ACTIVE 谓词」数。 */
  activePredicates: number;
  /** 其中链路能摸到 Member 行锁的 —— 为 0 说明「锁后」这一维没有任何样本。 */
  lockingPredicates: number;
  /** 命中已登记敞口的写入点数 —— 与 `DECLARED_OPEN_ADMISSION_GAPS` 对拍,少一条即 G4 红。 */
  declaredOpenGaps: number;
};

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

function rel(file: string): string {
  return relative(REPO_ROOT, file).split('\\').join('/');
}

/** 生产代码 = src 下排除 spec。测试里直插夹具、绕过重验都是正常的,不对它们执法。 */
export function collectProdFiles(): string[] {
  return walk(SRC).filter((f) => !f.endsWith('.spec.ts') && !SELF.includes(rel(f)));
}

type CallSite = {
  name: string;
  /** 解析后的目标 unit key;解析不出为 null(不记功)。 */
  target: string | null;
  args: string[];
};

type Unit = {
  file: string;
  name: string;
  /** 体内直接把 participation 状态写成 'pass'。 */
  writesAdmission: boolean;
  /** 体内直接引用 MemberStatus.ACTIVE。 */
  refsActiveEnum: boolean;
  /** 体内直接对 Member 行加锁。 */
  locksMember: boolean;
  callSites: CallSite[];
};

const unitKey = (file: string, name: string): string => `${file}#${name}`;

/**
 * 实参里像「某个队员」的表达式:必须是**简单表达式**(标识符 / 属性访问)且名字里含 member。
 * 刻意排除对象字面量 —— `{ memberId: x, ... }` 整块也含 "member",把它当成「查了谁」
 * 会让判据把「传了个含 memberId 的配置对象」误读成「重验过这个人」。
 */
function isMemberish(text: string): boolean {
  return /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/.test(text) && /member/i.test(text);
}

/**
 * 这个队员表达式指的是**操作人自己**吗。
 * 对操作人的准入复核是另一件事(防的是「审批人自己已离队还在审批」),它满足不了
 * 「被录取的人还在不在」。不区分这两者,判据就会被上层边界遮蔽而全绿。
 */
export function isActorDerived(text: string): boolean {
  return /(current|actor)user/i.test(text) || /actormember/i.test(text);
}

/** 相对 import 的模块解析:`./foo` / `../bar/baz` → repo 相对 .ts 路径。 */
function resolveImportPath(fromRel: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const dir = fromRel.split('/').slice(0, -1);
  for (const part of specifier.split('/')) {
    if (part === '.') continue;
    else if (part === '..') dir.pop();
    else dir.push(part);
  }
  return `${dir.join('/')}.ts`;
}

function analyzeFile(relPath: string, text: string): Unit[] {
  const source = ts.createSourceFile(relPath, text, ts.ScriptTarget.Latest, true);
  const units: Unit[] = [];

  // 本文件从相对模块 import 进来的名字 → 目标文件。把调用解析到真正的定义处,而不是按裸名字
  // 全仓匹配 —— 裸名字闭包会被 `create` / `update` 这类通名瞬间撑爆(实测传播到 1279 个名字,
  // 等于「所有入口都查过 ACTIVE」,判据全绿且毫无意义)。
  const imported = new Map<string, string>();
  for (const stmt of source.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    const target = resolveImportPath(relPath, stmt.moduleSpecifier.text);
    if (target === null) continue;
    const bindings = stmt.importClause?.namedBindings;
    if (bindings !== undefined && ts.isNamedImports(bindings)) {
      for (const el of bindings.elements) imported.set(el.name.text, target);
    }
  }
  const localFunctions = new Set(
    source.statements
      .filter((s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s))
      .map((s) => s.name?.text)
      .filter((n): n is string => n !== undefined),
  );

  const build = (name: string, body: ts.Node, injected: Map<string, string>): Unit => {
    const unit: Unit = {
      file: relPath,
      name,
      writesAdmission: false,
      refsActiveEnum: false,
      locksMember: false,
      callSites: [],
    };

    const scan = (node: ts.Node): void => {
      // MemberStatus.ACTIVE —— 按 AST 节点判而不是裸文本,散文注释不会误报。
      if (
        ts.isPropertyAccessExpression(node) &&
        node.name.text === 'ACTIVE' &&
        node.expression.getText(source) === 'MemberStatus'
      ) {
        unit.refsActiveEnum = true;
      }
      if (
        (ts.isTemplateExpression(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
        locksMemberRow(node.getText(source))
      ) {
        unit.locksMember = true;
      }
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        const fnName = ts.isPropertyAccessExpression(callee)
          ? callee.name.getText(source)
          : ts.isIdentifier(callee)
            ? callee.text
            : null;
        if (fnName !== null) {
          unit.callSites.push({
            name: fnName,
            target: resolveTarget(callee, fnName),
            args: node.arguments.map((a) => a.getText(source)),
          });
          if (
            WRITE_METHODS.has(fnName) &&
            ts.isPropertyAccessExpression(callee) &&
            ts.isPropertyAccessExpression(callee.expression) &&
            (PARTICIPATION_DELEGATES as readonly string[]).includes(
              callee.expression.name.getText(source),
            )
          ) {
            const arg = node.arguments[0];
            if (arg !== undefined && ts.isObjectLiteralExpression(arg)) {
              for (const prop of arg.properties) {
                if (!ts.isPropertyAssignment(prop)) continue;
                if (prop.name.getText(source) !== 'data') continue;
                if (writesAdmissionPayload(prop.initializer, source)) unit.writesAdmission = true;
              }
            }
          }
        }
      }
      ts.forEachChild(node, scan);
    };

    /** `this.foo()` / 裸 `foo()` / `this.svc.foo()`(构造器注入)三种可解析形态。 */
    function resolveTarget(callee: ts.Expression, fnName: string): string | null {
      if (ts.isIdentifier(callee)) {
        if (localFunctions.has(fnName)) return unitKey(relPath, fnName);
        const from = imported.get(fnName);
        return from === undefined ? null : unitKey(from, fnName);
      }
      if (!ts.isPropertyAccessExpression(callee)) return null;
      const receiver = callee.expression;
      if (receiver.kind === ts.SyntaxKind.ThisKeyword) return unitKey(relPath, fnName);
      if (
        ts.isPropertyAccessExpression(receiver) &&
        receiver.expression.kind === ts.SyntaxKind.ThisKeyword
      ) {
        const typeName = injected.get(receiver.name.text);
        const from = typeName === undefined ? undefined : imported.get(typeName);
        return from === undefined ? null : unitKey(from, fnName);
      }
      return null;
    }

    ts.forEachChild(body, scan);
    return unit;
  };

  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node)) {
      // 构造器注入的属性名 → 类型名,用来解析 `this.allocations.foo()` 这类跨服务调用。
      const injected = new Map<string, string>();
      for (const member of node.members) {
        if (!ts.isConstructorDeclaration(member)) continue;
        for (const param of member.parameters) {
          if (!ts.isIdentifier(param.name) || param.type === undefined) continue;
          if (ts.isTypeReferenceNode(param.type)) {
            injected.set(param.name.text, param.type.typeName.getText(source));
          }
        }
      }
      for (const member of node.members) {
        if (!ts.isMethodDeclaration(member) || member.name === undefined || !member.body) continue;
        units.push(build(member.name.getText(source), member.body, injected));
      }
    }
    if (ts.isFunctionDeclaration(node) && node.name !== undefined && node.body) {
      units.push(build(node.name.text, node.body, new Map()));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return units;
}

/** `data` 载荷里 statusCode / currentStatusCode 能取到字面量 'pass' 吗(含三元的任一分支)。 */
function writesAdmissionPayload(initializer: ts.Node, source: ts.SourceFile): boolean {
  if (!ts.isObjectLiteralExpression(initializer)) return false;
  for (const prop of initializer.properties) {
    if (!ts.isPropertyAssignment(prop)) continue;
    if (!STATUS_FIELDS.includes(prop.name.getText(source))) continue;
    let hit = false;
    const findLiteral = (node: ts.Node): void => {
      if (ts.isStringLiteralLike(node) && node.text === ADMISSION_STATUS) hit = true;
      ts.forEachChild(node, findLiteral);
    };
    findLiteral(prop.initializer);
    if (hit) return true;
  }
  return false;
}

/**
 * 全仓现扫「队员 ACTIVE 谓词」:自己引用了 `MemberStatus.ACTIVE`,或自己锁了 Member 行,
 * 或(传递地)调用了这样的 unit。这些 helper 本来就散在 `member-lifecycle-lock.ts` 与各
 * service 的私有 `assert*` 里 —— 写死清单就退回名单式判据了,所以现扫。
 */
function buildPredicates(units: readonly Unit[]): {
  predicates: Set<string>;
  locking: Set<string>;
} {
  const predicates = new Set<string>();
  const locking = new Set<string>();
  for (const unit of units) {
    const key = unitKey(unit.file, unit.name);
    if (unit.refsActiveEnum || unit.locksMember) predicates.add(key);
    if (unit.locksMember) locking.add(key);
  }
  for (let i = 0; i <= units.length; i += 1) {
    let changed = false;
    for (const unit of units) {
      const key = unitKey(unit.file, unit.name);
      for (const site of unit.callSites) {
        if (site.target === null || site.target === key) continue;
        if (predicates.has(site.target) && !predicates.has(key)) {
          predicates.add(key);
          changed = true;
        }
        if (locking.has(site.target) && !locking.has(key)) {
          locking.add(key);
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
  return { predicates, locking };
}

/** 某个 unit 体内对**非操作人**队员做的重验:是否存在、是否锁后。 */
function memberRecheck(
  unit: Unit,
  predicates: Set<string>,
  locking: Set<string>,
): { checked: boolean; locked: boolean } {
  let checked = false;
  let locked = false;
  for (const site of unit.callSites) {
    if (site.target === null || !predicates.has(site.target)) continue;
    const targets = site.args.filter((a) => isMemberish(a) && !isActorDerived(a));
    if (targets.length === 0) continue;
    checked = true;
    if (locking.has(site.target)) locked = true;
  }
  return { checked, locked };
}

/**
 * 跑判据。
 *
 * @param overrides repo 相对路径 → 替换后的源码(也可给出**当前不存在**的新文件,供反向对照用)。
 *   正反对照在内存里变异、不落盘 —— 避免「变异脚本超时停在半路留下脏工作区」和
 *   「git checkout 把未提交实现一起抹掉」这两类既有事故。
 */
export function runCriteria(overrides: Record<string, string> = {}): {
  findings: Finding[];
  counts: Counts;
  /** 命中登记表的敞口 key —— spec 与登记表逐条对拍,新缺陷绝不会落进这里。 */
  openGaps: string[];
} {
  const findings: Finding[] = [];
  const openGaps: string[] = [];
  const readSource = (f: string): string => overrides[rel(f)] ?? readFileSync(f, 'utf8');

  const unitsByFile = new Map<string, Unit[]>();
  for (const file of collectProdFiles()) {
    const r = rel(file);
    unitsByFile.set(r, analyzeFile(r, readSource(file)));
  }
  for (const [r, text] of Object.entries(overrides)) {
    if (unitsByFile.has(r) || r.endsWith('.spec.ts') || !r.startsWith('src/')) continue;
    unitsByFile.set(r, analyzeFile(r, text));
  }

  const allUnits = [...unitsByFile.values()].flat();
  const byKey = new Map(allUnits.map((u) => [unitKey(u.file, u.name), u]));
  const { predicates, locking } = buildPredicates(allUnits);

  // 反向调用边:写入点自己不查时,允许由**它的每一个调用方**在同一事务里查过来。
  // 「每一个」是刻意的 —— 只要有一条调用路径没查,这条路径就是敞口。
  const callers = new Map<string, string[]>();
  for (const unit of allUnits) {
    const from = unitKey(unit.file, unit.name);
    for (const site of unit.callSites) {
      if (site.target === null || site.target === from || !byKey.has(site.target)) continue;
      const list = callers.get(site.target) ?? [];
      if (!list.includes(from)) list.push(from);
      callers.set(site.target, list);
    }
  }

  const counts: Counts = {
    scannedFiles: unitsByFile.size,
    admissionWriters: 0,
    guardedWriters: 0,
    activePredicates: predicates.size,
    lockingPredicates: locking.size,
    declaredOpenGaps: 0,
  };

  const stillViolating = new Set<string>();

  for (const unit of allUnits) {
    if (!unit.writesAdmission) continue;
    counts.admissionWriters += 1;
    const key = unitKey(unit.file, unit.name);
    const where = `${unit.file} 的 ${unit.name}()`;

    const self = memberRecheck(unit, predicates, locking);
    if (self.locked) {
      counts.guardedWriters += 1;
      continue;
    }

    const upstream = (callers.get(key) ?? []).map((callerKey) => ({
      key: callerKey,
      recheck: memberRecheck(byKey.get(callerKey)!, predicates, locking),
    }));
    if (upstream.length > 0 && upstream.every((c) => c.recheck.locked)) {
      counts.guardedWriters += 1;
      continue;
    }

    stillViolating.add(key);
    // 已登记的未修复敞口:不重复报红,但也不算「通过」—— 它进 openGaps,由 spec 与登记表对拍。
    if (key in DECLARED_OPEN_ADMISSION_GAPS) {
      counts.declaredOpenGaps += 1;
      openGaps.push(key);
      continue;
    }

    // 查了,但没锁 —— 「锁前过滤」不是「锁后重验」,读完到写入之间的窗口还在。
    if (self.checked || (upstream.length > 0 && upstream.every((c) => c.recheck.checked))) {
      findings.push({
        criterion: 'G3',
        detail: `${where} 会写出正式录取(${STATUS_FIELDS.join(' / ')} = '${ADMISSION_STATUS}'),重验了被录取人但**没有走 Member 行锁** —— 不加锁只是「锁前过滤」,读完到写入之间的竞态窗口还在。请改用会锁 Member 聚合的谓词(如 \`lockAndReadLiveMemberLifecycle\` / \`assertActiveMemberLifecycle\`)。`,
      });
      continue;
    }

    const seen =
      upstream.length === 0 ? '(它没有可解析的调用方)' : upstream.map((c) => c.key).join(' · ');
    findings.push({
      criterion: 'G2',
      detail: `${where} 会写出正式录取(${STATUS_FIELDS.join(' / ')} = '${ADMISSION_STATUS}'),但同一事务内没有对**被录取人**做锁后队员 ACTIVE 重验 —— 该队员在被选中到写入之间若已离队 / 被软删 / 转非 ACTIVE,仍会被自动录取、占掉名额并投影成 populationIncluded。注意:对**操作人自己**的准入复核(\`currentUser.memberId\` 一类)满足不了这一条。已检查的调用方:${seen}。`,
    });
  }

  // 登记表自清洁:登记项一旦不再违规(修好了 / 改名了 / 删掉了),必须报红逼它被清理。
  // 没有这一条,登记表会慢慢腐烂成一张「谁也不敢删」的免死名单。
  for (const [key, reason] of Object.entries(DECLARED_OPEN_ADMISSION_GAPS)) {
    if (stillViolating.has(key)) continue;
    findings.push({
      criterion: 'G4',
      detail: `已登记敞口 ${key} 已经不再违规(或该方法已改名 / 删除),登记表这一行已过期,请删掉它。登记理由原文:${reason}`,
    });
  }

  return { findings, counts, openGaps };
}
