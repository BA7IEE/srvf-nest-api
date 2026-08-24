/**
 * check-role-permission-read-preview.ts —— 「preview 与 PUT 的准入判定同源」类闸(P1-32 PR 4b)。
 *
 * ⚠️ 本文件在 `harness/redzone.json` 的 selfGuard 内(`scripts/check-*.ts`)。
 *    判据逻辑刻意放在这里而不是 spec 里:`src/**\/*.spec.ts` 不在 selfGuard,任何 PR 都能顺手
 *    改松它;把**实质逻辑**放在受保护文件里,改松就必须动红区。spec 侧只做薄运行器
 *    (`src/modules/permissions/role-permission-read-preview.criteria.spec.ts`),
 *    这条分工现在由 `scripts/check-criteria-spec-purity.ts` 机器执法。
 *
 * ──────────────────────────────────────────────────────────────────────────
 * 这条闸修的是哪一类缺陷:**「预览说能过、真提交拒绝」没有任何症状**
 *
 * PR 4a(`d1adf853` #1156)刚把三条写路径并进**一条 replace 原语**,理由是「留两条写路径
 * 就是一侧有闸、另一侧裸奔」。4b 加的 `preview` 是**第四个**会回答「这次变更能不能过」的入口 ——
 * 它若自己再算一遍,就是把刚合并掉的那个缺陷家族原地重建一份,而且这一份**更难发现**:
 *
 *   · 预览说能过、`PUT` 拒 ⇒ 用户点了保存才知道,像偶发 bug;
 *   · 预览说不能过、`PUT` 其实能过 ⇒ 管理员**放弃了一次合法变更**,连报错都没有。
 *
 * 两种都不会有编译错误、不会有既有测试变红、不会有日志。⇒ 必须做成不变量。
 *
 * 🔴 **正解不是「让 preview 也调一遍那些闸」** —— 那仍是两份调用序列,任一侧加一道闸、
 *    改一个码、调一次次序,另一侧都不会有症状。正解是**只有一个判定序列**
 *    (`RolePermissionsService.runReplaceSet()`),两个公开方法各只有**一句委托**,
 *    唯一差别是最后一个参数(`AuditMeta` = 真写 / `null` = dry-run 零写入)。
 *    冻结稿 §1.7 结尾逐字点名要复用的正是这个范式(「preview + create 复用同一校验器」,
 *    仓内活样本 `role-bindings.service.preview()`)。
 *
 * ──────────────────────────────────────────────────────────────────────────
 * 判据形状:发现面**结构性**,不写死闸的名单
 *
 * 「哪些方法算闸」= 类内所有 `assert*` 前缀方法(前缀是本类既有的命名约定,今天 4 个)。
 * **不写死 `['assertCanOrThrow', …]` 这样的清单**:写死之后,新加一道闸只挂在 `PUT` 上
 * 而不挂在 preview 上,判据看不见。按前缀动态发现 ⇒ 新闸自动纳管。
 * 扫描面塌了(有人把闸改名成不带 `assert` 前缀)由地板锚点当场报红,而不是静默全绿。
 *
 * 五条 AST 判据 + 两条运行时判据:
 *
 *   ① `same-delegate`      两个公开方法「通向闸的委托」必须是**同一个单元素**私有方法。
 *   ② `own-judgement`      两个公开方法体内不许有 `assert*` 直调,也不许 `new BizException`。
 *   ③ `gate-reach`         两侧可达的 `assert*` 集合必须**逐一相等**。
 *   ④ `conditional-gate`   任何 `assert*` 调用点都不许被包在分支里(否则「preview 时跳过这道闸」
 *                          只需加一个 `if`,而上面三条照样全绿)。
 *   ⑤ `dryrun-exit`        原语里 dry-run 出口必须**排在两个方向闸之后**,且判别 `commit` 为空
 *                          的地方**恰一处**(第二处 = 又一个「preview 时少判一样东西」的入口)。
 *   ⑥ `blocked-relay`      对 **BizCode 全表**逐条跑 presenter 的拦截分支:三个字段必须逐字
 *                          等于入参,`valid=false` / `outcome=null` / 恰一条。任何「某个码特殊处理」
 *                          当场红 —— 这条是「catch 只搬运不判断」的全域证明。
 *   ⑦ `edit-policy`        `editPolicy` 与正在执法的谓词**两向**相等(内建角色全只读 /
 *                          自定义角色不许被标只读),并且读面**不许**过可变性闸
 *                          (过了内建角色就读不到,而「能不能改」本该由数据回答)。
 *
 * ⚠️ 本闸**不**验业务正确性(差集算得对不对、版本号对不对)—— 那些由 e2e 与 4a 的既有断言管。
 *    它只保证**判定只有一处**。闸绿 ≠ 判定本身正确。
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import * as ts from 'typescript';

import { BizCode } from '../src/common/exceptions/biz-code.constant';
import type { BizCodeEntry } from '../src/common/exceptions/biz-code.constant';
import { PROTECTED_ROLE_CODES } from '../src/modules/permissions/protected-role-codes';
import { buildBlockedRolePermissionPreview } from '../src/modules/permissions/role-permission-preview.presenter';
import { classifyRole, rolePermissionEditPolicy } from '../src/modules/permissions/role-classification';

const ROOT = path.resolve(__dirname, '..');

export const SERVICE_FILE = 'src/modules/permissions/role-permissions.service.ts';
export const CONTROLLER_FILE = 'src/modules/permissions/role-permissions.controller.ts';
export const PRESENTER_FILE = 'src/modules/permissions/role-permission-preview.presenter.ts';

export const SERVICE_CLASS = 'RolePermissionsService';
export const CONTROLLER_CLASS = 'RolePermissionsController';

/** 真写入口 / 预览入口 / 读入口 —— 本闸的被测对象。 */
export const WRITE_ENTRY = 'replace';
export const PREVIEW_ENTRY = 'previewReplace';
export const READ_ENTRY = 'findPermissionSet';

/** 唯一写原语。PR 4a 落地的名字,`role-permissions-control-plane-gate.spec.ts` 也钉着它。 */
export const WRITE_PRIMITIVE = 'replaceRolePermissionSet';

/**
 * 闸的命名约定 —— 发现面按**前缀**,不按名单。
 * 新增一道 `assertXxxOrThrow` 自动纳管;把闸改名成不带前缀会让扫描面塌到地板以下(⇒ 红)。
 */
export const GATE_PREFIX = 'assert';

/**
 * 闸的地板锚点。今天类内 4 个:`assertCanOrThrow` / `assertControlPlaneCodesOrThrow` /
 * `assertRoleMutableOrThrow` / `assertRoleRowMutableOrThrow`。
 * 用地板不用「恰 4」:加一道闸不该要改判据,而改判据的摩擦会诱导人把数字调大了事。
 */
export const MIN_GATES = 4;

/** 读面必须持有的判权码(复用既有码,零新增)。 */
export const READ_PERMISSION_CODE = 'rbac.role.read';

/** BizCode 全表地板 —— 搬运判据要在全域上跑,表被读空就是仪器失效而不是「零违规」。 */
export const MIN_BIZ_CODES = 300;

/** 内建角色地板。与 `check-role-classification.ts` 的 `BUILTIN_ROLE_FLOOR` 同值同理由。 */
export const BUILTIN_ROLE_FLOOR = 15;

/**
 * 反向对照探针 —— **不是**内建角色的 code。
 * 没有它,`editPolicy` 那条正向断言可以被一行「恒返回 canEdit:false」骗过(全绿而毫无意义)。
 * 与 `check-role-classification.ts` 同款合成名,理由一致:真角色可能哪天被收编进内建清单。
 */
export const CUSTOM_ROLE_PROBES = ['harness-probe-custom-role', 'harness-probe-another-role'];

export interface Violation {
  readonly rule: string;
  readonly detail: string;
}

interface MethodFacts {
  readonly name: string;
  readonly isPublic: boolean;
  readonly line: number;
  /** 方法体内直接出现的 `this.<x>(...)` 被调方法名。 */
  readonly selfCalls: readonly string[];
  /** 方法体内直接出现的 `this.<assert*>(...)` 调用名。 */
  readonly directGates: readonly string[];
  /** 直接出现的 `this.<assert*>(...)` 调用中,被包在分支里的(rule ④)。 */
  readonly conditionalGates: readonly string[];
  /** 方法体内直接出现的 `new BizException(...)` 次数。 */
  readonly bizThrows: number;
  /** `this.assertCanOrThrow('<code>')` 的字符串实参。 */
  readonly assertedCodes: readonly string[];
}

interface ParsedClass {
  readonly relPath: string;
  readonly source: ts.SourceFile;
  readonly text: string;
  readonly classFound: boolean;
  readonly methods: ReadonlyMap<string, MethodFacts>;
  readonly declaration: ts.ClassDeclaration | null;
}

// ============================================================================
// 解析
// ============================================================================

function read(rel: string): string {
  return readFileSync(path.join(ROOT, rel), 'utf8');
}

function findClass(source: ts.SourceFile, name: string): ts.ClassDeclaration | null {
  let found: ts.ClassDeclaration | null = null;
  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node) && node.name?.text === name) found = node;
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
  return found;
}

/** `this.<x>` 形态的被调方法名;不是 `this.` 接收者则返 null。 */
function selfCallName(node: ts.CallExpression): string | null {
  const callee = node.expression;
  if (!ts.isPropertyAccessExpression(callee)) return null;
  if (callee.expression.kind !== ts.SyntaxKind.ThisKeyword) return null;
  return callee.name.text;
}

/** 从 `node` 往上走到 `stop`,途中有没有分支结构(rule ④ 的判定本体)。 */
function underCondition(node: ts.Node, stop: ts.Node): boolean {
  let current: ts.Node | undefined = node.parent;
  while (current !== undefined && current !== stop) {
    if (
      ts.isIfStatement(current) ||
      ts.isConditionalExpression(current) ||
      ts.isSwitchStatement(current) ||
      ts.isCaseClause(current) ||
      (ts.isBinaryExpression(current) &&
        (current.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
          current.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
          current.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken))
    ) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

function isGate(name: string): boolean {
  return name.startsWith(GATE_PREFIX);
}

/** 沿类内 `this.<x>()` 边做传递闭包,收集途中所有 `assert*`(含 `start` 自己身上的)。 */
function gateReach(parsed: ParsedClass, start: string): string[] {
  const gates = new Set<string>();
  const seen = new Set<string>();
  const stack = [start];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    if (seen.has(current)) continue;
    seen.add(current);
    const facts = parsed.methods.get(current);
    if (facts === undefined) continue;
    for (const gate of facts.directGates) gates.add(gate);
    stack.push(...facts.selfCalls);
  }
  return [...gates].sort();
}

/** `start` 体内那些「能通向闸」的 `this.<x>()` —— 委托边。 */
function gateDelegates(parsed: ParsedClass, start: string): string[] {
  const facts = parsed.methods.get(start);
  if (facts === undefined) return [];
  return facts.selfCalls.filter((callee) => gateReach(parsed, callee).length > 0).sort();
}

// ============================================================================
// AST 判据
// ============================================================================

/**
 * 五条 AST 判据。**导出**是为了让自证能把它跑在两条对照样本上
 * (真阳性 / 假阳性各一份),证明规则确实是活的。
 */
export function analyzeServiceSource(relPath: string, text: string): Violation[] {
  const source = ts.createSourceFile(relPath, text, ts.ScriptTarget.Latest, true);
  const declaration = findClass(source, SERVICE_CLASS);
  if (declaration === null) {
    return [{ rule: 'class-missing', detail: `${relPath} 里找不到 class ${SERVICE_CLASS}` }];
  }
  const parsed = parseSourceIntoClass(relPath, text, source, declaration);
  const violations: Violation[] = [];

  const writeFacts = parsed.methods.get(WRITE_ENTRY);
  const previewFacts = parsed.methods.get(PREVIEW_ENTRY);
  if (writeFacts === undefined || previewFacts === undefined) {
    return [
      {
        rule: 'entry-missing',
        detail:
          `${relPath} 里找不到 ${WRITE_ENTRY}() / ${PREVIEW_ENTRY}() —— ` +
          '被测对象没了,判据失去输入。这是红,不是「零违规」。',
      },
    ];
  }

  // ── ② own-judgement:两个入口不许自己判 ──────────────────────────────
  for (const facts of [writeFacts, previewFacts]) {
    if (facts.directGates.length > 0) {
      violations.push({
        rule: 'own-judgement',
        detail:
          `${facts.name}()(${relPath}:${facts.line})方法体内直接调了闸 ` +
          `${facts.directGates.join(' / ')} —— 准入判定必须**只**存在于那一句共同委托背后。` +
          '照抄一份进来,第一天两侧相同,此后任一侧改动另一侧都不会有症状。',
      });
    }
    if (facts.bizThrows > 0) {
      violations.push({
        rule: 'own-judgement',
        detail:
          `${facts.name}()(${relPath}:${facts.line})方法体内 new BizException ——` +
          '入口自己下结论就是第二份真相。判定搬进共同委托里。',
      });
    }
  }

  // ── ① same-delegate:通向闸的委托必须是同一个单元素 ───────────────────
  const writeDelegates = gateDelegates(parsed, WRITE_ENTRY);
  const previewDelegates = gateDelegates(parsed, PREVIEW_ENTRY);
  const sameSingleDelegate =
    writeDelegates.length === 1 &&
    previewDelegates.length === 1 &&
    writeDelegates[0] === previewDelegates[0];
  if (!sameSingleDelegate) {
    violations.push({
      rule: 'same-delegate',
      detail:
        `${WRITE_ENTRY}() 通向闸的委托是 [${writeDelegates.join(' / ') || '无'}],` +
        `${PREVIEW_ENTRY}() 是 [${previewDelegates.join(' / ') || '无'}] —— ` +
        '两者必须是**同一个**私有方法、且各只有一条这样的边。' +
        '各走一条(哪怕今天内容一样)就是两份判定序列,漂了没有任何症状。',
    });
  }

  // ── ③ gate-reach:两侧可达的闸集合逐一相等 ───────────────────────────
  const writeGates = gateReach(parsed, WRITE_ENTRY);
  const previewGates = gateReach(parsed, PREVIEW_ENTRY);
  const onlyWrite = writeGates.filter((g) => !previewGates.includes(g));
  const onlyPreview = previewGates.filter((g) => !writeGates.includes(g));
  if (onlyWrite.length > 0 || onlyPreview.length > 0) {
    violations.push({
      rule: 'gate-reach',
      detail:
        `两侧可达的闸不相等:只有 ${WRITE_ENTRY}() 到得了 [${onlyWrite.join(' / ') || '—'}],` +
        `只有 ${PREVIEW_ENTRY}() 到得了 [${onlyPreview.join(' / ') || '—'}]。` +
        '后果:预览与真提交对同一次变更给出不同结论,而两边都返 200 / 都不报错。',
    });
  }

  // ── ④ conditional-gate:闸不许被包在分支里 ───────────────────────────
  for (const facts of parsed.methods.values()) {
    if (facts.conditionalGates.length === 0) continue;
    violations.push({
      rule: 'conditional-gate',
      detail:
        `${facts.name}()(${relPath}:${facts.line})把闸 ${facts.conditionalGates.join(' / ')} ` +
        '包在了分支里 —— 「dry-run 时跳过这道闸」只需要一个 `if`,而同源那三条判据照样全绿。' +
        '闸必须是无条件语句;要按方向分口径,分口径写在闸内部(见 assertControlPlaneCodesOrThrow)。',
    });
  }

  // ── ⑤ dryrun-exit:出口在方向闸之后,且判别恰一处 ─────────────────────
  violations.push(...analyzeDryRunExit(parsed));

  // ── 读面两向 ────────────────────────────────────────────────────────
  const readFacts = parsed.methods.get(READ_ENTRY);
  if (readFacts === undefined) {
    violations.push({
      rule: 'read-entry-missing',
      detail: `${relPath} 里找不到 ${READ_ENTRY}() —— 读面判据失去被测对象。`,
    });
  } else {
    const readGates = gateReach(parsed, READ_ENTRY);
    const mutabilityGates = readGates.filter((gate) => gate.includes('Mutable'));
    if (mutabilityGates.length > 0) {
      violations.push({
        rule: 'read-path-mutability-gate',
        detail:
          `${READ_ENTRY}() 到达了可变性闸 ${mutabilityGates.join(' / ')} —— ` +
          '那道闸对 15 个内建角色抛 30108,挂在读面上会让内建角色的权限集**读不到**。' +
          '「能不能改」应当由 editPolicy 以数据形态回答,不是靠让读操作失败来表达。',
      });
    }
    if (!readFacts.assertedCodes.includes(READ_PERMISSION_CODE)) {
      violations.push({
        rule: 'read-path-permission-code',
        detail:
          `${READ_ENTRY}() 的判权码不含 ${READ_PERMISSION_CODE}` +
          `(读到:[${readFacts.assertedCodes.join(' / ') || '无'}])—— ` +
          '读面复用既有码是「零新增权限码」的落点;换成别的码等于悄悄改了判权粒度。',
      });
    }
  }

  return violations;
}

function parseSourceIntoClass(
  relPath: string,
  text: string,
  source: ts.SourceFile,
  declaration: ts.ClassDeclaration,
): ParsedClass {
  const methods = new Map<string, MethodFacts>();
  for (const member of declaration.members) {
    if (!ts.isMethodDeclaration(member) || !ts.isIdentifier(member.name)) continue;
    const selfCalls = new Set<string>();
    const directGates = new Set<string>();
    const conditionalGates = new Set<string>();
    const assertedCodes: string[] = [];
    let bizThrows = 0;
    const visit = (node: ts.Node): void => {
      if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)) {
        if (node.expression.text === 'BizException') bizThrows += 1;
      }
      if (ts.isCallExpression(node)) {
        const name = selfCallName(node);
        if (name !== null) {
          selfCalls.add(name);
          if (isGate(name)) {
            directGates.add(name);
            if (underCondition(node, member)) conditionalGates.add(name);
            for (const arg of node.arguments) {
              if (ts.isStringLiteral(arg)) assertedCodes.push(arg.text);
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    if (member.body !== undefined) ts.forEachChild(member.body, visit);
    const isPublic = !member.modifiers?.some(
      (m) => m.kind === ts.SyntaxKind.PrivateKeyword || m.kind === ts.SyntaxKind.ProtectedKeyword,
    );
    methods.set(member.name.text, {
      name: member.name.text,
      isPublic,
      line: source.getLineAndCharacterOfPosition(member.getStart(source)).line + 1,
      selfCalls: [...selfCalls].sort(),
      directGates: [...directGates].sort(),
      conditionalGates: [...conditionalGates].sort(),
      bizThrows,
      assertedCodes,
    });
  }
  return { relPath, source, text, classFound: true, methods, declaration };
}

/**
 * rule ⑤:dry-run 出口的位置与个数。
 *
 * 判的是**源码位置**:原语里那个「`commit` 为空就 return」的分支,必须排在两次
 * 方向闸调用**之后**。排在前面 = 预览对「非 SA 撤控制面码」这类情形报能过,而真提交 30103。
 * 个数必须恰一处:第二处判别就是又一个「preview 时少判一样东西」的入口。
 */
function analyzeDryRunExit(parsed: ParsedClass): Violation[] {
  const violations: Violation[] = [];
  const primitive = parsed.declaration?.members.find(
    (member): member is ts.MethodDeclaration =>
      ts.isMethodDeclaration(member) &&
      ts.isIdentifier(member.name) &&
      member.name.text === WRITE_PRIMITIVE,
  );
  if (primitive === undefined || primitive.body === undefined) {
    return [
      {
        rule: 'primitive-missing',
        detail:
          `${parsed.relPath} 里找不到唯一写原语 ${WRITE_PRIMITIVE}() —— ` +
          'dry-run 出口判据失去被测对象。',
      },
    ];
  }

  const gateCallPositions: number[] = [];
  const commitNullTests: number[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const name = selfCallName(node);
      if (name !== null && isGate(name)) gateCallPositions.push(node.getStart(parsed.source));
    }
    // `input.commit === null` / `!== null` 之类的判别。
    if (ts.isBinaryExpression(node) && isCommitNullTest(node)) {
      commitNullTests.push(node.getStart(parsed.source));
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(primitive.body, visit);

  if (commitNullTests.length !== 1) {
    violations.push({
      rule: 'dryrun-exit',
      detail:
        `${WRITE_PRIMITIVE}() 里判别「落库意图为空」的地方有 ${commitNullTests.length} 处,` +
        '必须恰一处。多一处就是多一个「dry-run 时少判 / 少做一样东西」的分支,' +
        '而它与真提交的差异不会有任何症状;零处则说明 dry-run 分支被删了(preview 会真写库)。',
    });
    return violations;
  }
  if (gateCallPositions.length === 0) {
    violations.push({
      rule: 'dryrun-exit',
      detail:
        `${WRITE_PRIMITIVE}() 里一个闸调用都没扫到 —— 扫描面塌了,` +
        '「出口在闸之后」这条比较会退化成恒真。',
    });
    return violations;
  }
  const lastGate = Math.max(...gateCallPositions);
  if (commitNullTests[0] < lastGate) {
    violations.push({
      rule: 'dryrun-exit',
      detail:
        `${WRITE_PRIMITIVE}() 的 dry-run 出口排在最后一道闸**之前**` +
        `(出口 @${commitNullTests[0]} < 闸 @${lastGate})—— ` +
        '预览会对「本该被闸拦下」的变更报能过,而真提交拒。这正是本闸要消灭的形状。',
    });
  }
  return violations;
}

function isCommitNullTest(node: ts.BinaryExpression): boolean {
  const eq =
    node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
    node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken;
  if (!eq) return false;
  const mentionsCommit = (side: ts.Expression): boolean =>
    ts.isPropertyAccessExpression(side) && side.name.text === 'commit';
  const isNull = (side: ts.Expression): boolean => side.kind === ts.SyntaxKind.NullKeyword;
  return (
    (mentionsCommit(node.left) && isNull(node.right)) ||
    (mentionsCommit(node.right) && isNull(node.left))
  );
}

// ============================================================================
// controller 侧:入参同一个类 + 路由闸逐字相同
// ============================================================================

interface RouteFacts {
  readonly bodyType: string | null;
  readonly requiresPermission: string | null;
}

function routeFacts(parsed: ParsedClass, method: string): RouteFacts | null {
  const member = parsed.declaration?.members.find(
    (m): m is ts.MethodDeclaration =>
      ts.isMethodDeclaration(m) && ts.isIdentifier(m.name) && m.name.text === method,
  );
  if (member === undefined) return null;

  let bodyType: string | null = null;
  for (const param of member.parameters) {
    const hasBody = ts
      .getDecorators(param)
      ?.some(
        (dec) =>
          ts.isCallExpression(dec.expression) &&
          ts.isIdentifier(dec.expression.expression) &&
          dec.expression.expression.text === 'Body',
      );
    if (hasBody === true && param.type !== undefined) bodyType = param.type.getText(parsed.source);
  }

  let requiresPermission: string | null = null;
  for (const dec of ts.getDecorators(member) ?? []) {
    if (!ts.isCallExpression(dec.expression)) continue;
    if (!ts.isIdentifier(dec.expression.expression)) continue;
    if (dec.expression.expression.text !== 'RequiresPermission') continue;
    requiresPermission = dec.expression.arguments
      .map((arg) => arg.getText(parsed.source).replace(/\s+/g, ''))
      .join(',');
  }
  return { bodyType, requiresPermission };
}

export function analyzeController(): Violation[] {
  const text = read(CONTROLLER_FILE);
  const source = ts.createSourceFile(CONTROLLER_FILE, text, ts.ScriptTarget.Latest, true);
  const declaration = findClass(source, CONTROLLER_CLASS);
  if (declaration === null) {
    return [
      { rule: 'class-missing', detail: `${CONTROLLER_FILE} 里找不到 class ${CONTROLLER_CLASS}` },
    ];
  }
  const parsed = parseSourceIntoClass(CONTROLLER_FILE, text, source, declaration);
  const violations: Violation[] = [];

  const write = routeFacts(parsed, WRITE_ENTRY);
  const preview = routeFacts(parsed, PREVIEW_ENTRY);
  if (write === null || preview === null) {
    return [
      {
        rule: 'route-missing',
        detail:
          `${CONTROLLER_FILE} 里找不到 ${WRITE_ENTRY}() / ${PREVIEW_ENTRY}() 两个 handler —— ` +
          'controller 侧判据失去被测对象。',
      },
    ];
  }

  if (write.bodyType === null || preview.bodyType === null || write.bodyType !== preview.bodyType) {
    violations.push({
      rule: 'body-dto',
      detail:
        `PUT 的 @Body() 类型是 ${write.bodyType ?? '无'},preview 的是 ${preview.bodyType ?? '无'} —— ` +
        '必须是**同一个类**。另起一个「同形状的预览 DTO」之后,两者的字段与校验分家不会有任何症状' +
        '(预览校验松一格,提交时才 40000)。',
    });
  }

  if (
    write.requiresPermission === null ||
    preview.requiresPermission === null ||
    write.requiresPermission !== preview.requiresPermission
  ) {
    violations.push({
      rule: 'route-gate',
      detail:
        `PUT 的 @RequiresPermission(${write.requiresPermission ?? '无'}) 与 ` +
        `preview 的 @RequiresPermission(${preview.requiresPermission ?? '无'}) 不同 —— ` +
        '「能预览 ⟺ 能真改」是本刀的一条同源轴;放宽预览侧等于让不能改的人也能问出' +
        '「这次变更会动哪些码」,而那正是变更本身的信息。',
    });
  }

  return violations;
}

// ============================================================================
// presenter:只搬运不判断(运行时全域证明)
// ============================================================================

export interface RelayFailure {
  readonly code: number;
  readonly reason: string;
}

/**
 * rule ⑥:对 **BizCode 全表**逐条跑拦截分支。
 *
 * 🔴 这条刻意做成**运行时全域**而不是 AST:AST 只能证明「没写 `if (code === 30111)`」这种
 *    具体形状,而搬运的正确性是一条**对全部码都成立**的性质。全表跑一遍,任何
 *    「某个码特殊处理 / 文案被重写 / httpStatus 被填死」都当场红并点名是哪个码。
 */
export function checkBlockedRelay(): RelayFailure[] {
  const failures: RelayFailure[] = [];
  for (const entry of Object.values(BizCode) as BizCodeEntry[]) {
    const rendered = buildBlockedRolePermissionPreview(entry);
    if (rendered.valid !== false) {
      failures.push({ code: entry.code, reason: 'valid 不是 false' });
    }
    if (rendered.outcome !== null) {
      failures.push({ code: entry.code, reason: 'outcome 不是 null(被拦下却给了预览结论)' });
    }
    if (rendered.blockingIssues.length !== 1) {
      failures.push({
        code: entry.code,
        reason: `blockingIssues 有 ${rendered.blockingIssues.length} 条,应恰 1 条`,
      });
      continue;
    }
    const issue = rendered.blockingIssues[0];
    if (issue.bizCode !== entry.code) {
      failures.push({ code: entry.code, reason: `bizCode 被改写成 ${issue.bizCode}` });
    }
    if (issue.message !== entry.message) {
      failures.push({ code: entry.code, reason: 'message 被重写(不是原样搬运)' });
    }
    if (issue.httpStatus !== entry.httpStatus) {
      failures.push({ code: entry.code, reason: `httpStatus 被改写成 ${issue.httpStatus}` });
    }
  }
  return failures;
}

/** presenter 文件不许 import `BizCode` 值(只许 `type BizCodeEntry`)—— 引到值就能按码分类。 */
export function checkPresenterHasNoCodeTable(): Violation[] {
  const text = read(PRESENTER_FILE);
  const source = ts.createSourceFile(PRESENTER_FILE, text, ts.ScriptTarget.Latest, true);
  const violations: Violation[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && node.importClause?.isTypeOnly !== true) {
      const named = node.importClause?.namedBindings;
      if (named !== undefined && ts.isNamedImports(named)) {
        for (const spec of named.elements) {
          if (spec.isTypeOnly) continue;
          if (spec.name.text === 'BizCode') {
            violations.push({
              rule: 'presenter-judges',
              detail:
                `${PRESENTER_FILE} import 了 BizCode 值表 —— presenter 只许**搬运** ` +
                '`error.biz` 的三个字段。引到码表就能按码分类,而「哪些算 blocking」' +
                '一旦在这里回答,就是第二份真相。只许 `import type { BizCodeEntry }`。',
            });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
  return violations;
}

// ============================================================================
// editPolicy 两向(运行时)
// ============================================================================

export interface EditPolicyReport {
  readonly builtinMarkedEditable: readonly string[];
  readonly builtinMissingReason: readonly string[];
  readonly customMarkedReadOnly: readonly string[];
  readonly customHasReason: readonly string[];
  readonly disagreesWithClassification: readonly string[];
}

export function checkEditPolicy(): EditPolicyReport {
  const builtinMarkedEditable: string[] = [];
  const builtinMissingReason: string[] = [];
  const customMarkedReadOnly: string[] = [];
  const customHasReason: string[] = [];
  const disagreesWithClassification: string[] = [];

  const agrees = (code: string): boolean => {
    const policy = rolePermissionEditPolicy(code);
    const editable = classifyRole(code).permissionManagementMode === 'ADMIN_EDITABLE';
    return policy.canEdit === editable && (policy.readOnlyReason === null) === editable;
  };

  for (const code of PROTECTED_ROLE_CODES) {
    const policy = rolePermissionEditPolicy(code);
    if (policy.canEdit) builtinMarkedEditable.push(code);
    if (policy.readOnlyReason === null) builtinMissingReason.push(code);
    if (!agrees(code)) disagreesWithClassification.push(code);
  }
  for (const code of CUSTOM_ROLE_PROBES) {
    const policy = rolePermissionEditPolicy(code);
    if (!policy.canEdit) customMarkedReadOnly.push(code);
    if (policy.readOnlyReason !== null) customHasReason.push(code);
    if (!agrees(code)) disagreesWithClassification.push(code);
  }

  return {
    builtinMarkedEditable: builtinMarkedEditable.sort(),
    builtinMissingReason: builtinMissingReason.sort(),
    customMarkedReadOnly: customMarkedReadOnly.sort(),
    customHasReason: customHasReason.sort(),
    disagreesWithClassification: [...new Set(disagreesWithClassification)].sort(),
  };
}

// ============================================================================
// 对照样本:证明规则是活的(真阳性 / 假阳性各一份)
// ============================================================================

/**
 * 假阳性对照 —— **同源**的标准形态(两个入口各一句委托)。
 * 本闸若在这上面报违规,它就把正确形态也判成违规,不可用。
 */
export const CONTROL_SAME_SOURCE = `
class RolePermissionsService {
  private async assertCanOrThrow(user: unknown, action: string): Promise<void> {
    if (action === '') throw new BizException(BizCode.RBAC_FORBIDDEN);
  }
  private assertControlPlaneCodesOrThrow(user: unknown, codes: string[]): void {
    if (codes.length < 0) throw new BizException(BizCode.RBAC_FORBIDDEN);
  }
  private async assertRoleMutableOrThrow(roleId: string): Promise<void> {
    if (roleId === '') throw new BizException(BizCode.ROLE_NOT_FOUND);
  }
  private assertRoleRowMutableOrThrow(row: unknown): unknown {
    if (row === null) throw new BizException(BizCode.ROLE_NOT_FOUND);
    return row;
  }
  private async replaceRolePermissionSet(user: unknown, roleId: string, input: { commit: unknown }) {
    await this.assertRoleMutableOrThrow(roleId);
    return this.prisma.$transaction(async (tx) => {
      this.assertRoleRowMutableOrThrow(await tx.rbacRole.findUnique({ where: { id: roleId } }));
      this.assertControlPlaneCodesOrThrow(user, ['a']);
      this.assertControlPlaneCodesOrThrow(user, ['b']);
      if (input.commit === null) return { noOp: false };
      return { noOp: false };
    });
  }
  private async runReplaceSet(user: unknown, roleId: string, dto: unknown, commitMeta: unknown) {
    await this.assertCanOrThrow(user, 'rbac.role-permission.create');
    await this.assertCanOrThrow(user, 'rbac.role-permission.delete');
    await this.assertRoleMutableOrThrow(roleId);
    this.assertControlPlaneCodesOrThrow(user, ['a']);
    return this.replaceRolePermissionSet(user, roleId, { commit: commitMeta });
  }
  async replace(user: unknown, roleId: string, dto: unknown, meta: unknown) {
    await this.runReplaceSet(user, roleId, dto, meta);
    return this.buildDetailResponse(roleId);
  }
  async previewReplace(user: unknown, roleId: string, dto: unknown) {
    return buildRolePermissionPreview(await this.runReplaceSet(user, roleId, dto, null));
  }
  async findPermissionSet(user: unknown, roleId: string) {
    await this.assertCanOrThrow(user, 'rbac.role.read');
    return { roleId };
  }
  private async buildDetailResponse(roleId: string) {
    if (roleId === '') throw new BizException(BizCode.ROLE_NOT_FOUND);
    return { roleId };
  }
}
`;

/**
 * 真阳性对照 —— **preview 自己判一遍**的形态(本闸未来唯一要干的活的样本)。
 * 它把 `CONTROL_SAME_SOURCE` 的 preview 改成「照抄一部分判定 + 直接调原语」,
 * 于是**漏掉了判权那一道**(现实中最容易发生的形态:照抄时少抄一行);
 * 再把一道闸包进 `if`、把 dry-run 出口挪到闸之前、给读面挂上可变性闸并换掉判权码。
 * 七条规则各命中一次。
 */
export const CONTROL_DIVERGENT = `
class RolePermissionsService {
  private async assertCanOrThrow(user: unknown, action: string): Promise<void> {
    if (action === '') throw new BizException(BizCode.RBAC_FORBIDDEN);
  }
  private assertControlPlaneCodesOrThrow(user: unknown, codes: string[]): void {
    if (codes.length < 0) throw new BizException(BizCode.RBAC_FORBIDDEN);
  }
  private async assertRoleMutableOrThrow(roleId: string): Promise<void> {
    if (roleId === '') throw new BizException(BizCode.ROLE_NOT_FOUND);
  }
  private assertRoleRowMutableOrThrow(row: unknown): unknown {
    if (row === null) throw new BizException(BizCode.ROLE_NOT_FOUND);
    return row;
  }
  private async replaceRolePermissionSet(user: unknown, roleId: string, input: { commit: unknown }) {
    await this.assertRoleMutableOrThrow(roleId);
    return this.prisma.$transaction(async (tx) => {
      this.assertRoleRowMutableOrThrow(await tx.rbacRole.findUnique({ where: { id: roleId } }));
      if (input.commit === null) return { noOp: false };
      if (roleId !== '') this.assertControlPlaneCodesOrThrow(user, ['a']);
      return { noOp: false };
    });
  }
  private async runReplaceSet(user: unknown, roleId: string, dto: unknown, commitMeta: unknown) {
    await this.assertCanOrThrow(user, 'rbac.role-permission.create');
    await this.assertCanOrThrow(user, 'rbac.role-permission.delete');
    await this.assertRoleMutableOrThrow(roleId);
    this.assertControlPlaneCodesOrThrow(user, ['a']);
    return this.replaceRolePermissionSet(user, roleId, { commit: commitMeta });
  }
  async replace(user: unknown, roleId: string, dto: unknown, meta: unknown) {
    await this.runReplaceSet(user, roleId, dto, meta);
    return this.buildDetailResponse(roleId);
  }
  async previewReplace(user: unknown, roleId: string, dto: unknown) {
    await this.assertRoleMutableOrThrow(roleId);
    if (dto === null) throw new BizException(BizCode.BAD_REQUEST);
    return this.replaceRolePermissionSet(user, roleId, { commit: null });
  }
  async findPermissionSet(user: unknown, roleId: string) {
    await this.assertCanOrThrow(user, 'rbac.permission.read');
    await this.assertRoleMutableOrThrow(roleId);
    return { roleId };
  }
  private async buildDetailResponse(roleId: string) {
    if (roleId === '') throw new BizException(BizCode.ROLE_NOT_FOUND);
    return { roleId };
  }
}
`;

/** 本闸会命中的全部规则名 —— 自证与变异对拍按它比对。 */
export const ALL_RULES = [
  'conditional-gate',
  'dryrun-exit',
  'gate-reach',
  'own-judgement',
  'read-path-mutability-gate',
  'read-path-permission-code',
  'same-delegate',
];

// ============================================================================
// 报告
// ============================================================================

export interface ReadPreviewReport {
  /** 类内 `assert*` 闸的个数(自证用)。 */
  readonly gateCount: number;
  /** 真文件上的 AST 违规。 */
  readonly serviceViolations: readonly Violation[];
  readonly controllerViolations: readonly Violation[];
  readonly presenterViolations: readonly Violation[];
  readonly relayFailures: readonly RelayFailure[];
  readonly editPolicy: EditPolicyReport;
  readonly bizCodeCount: number;
  readonly builtinRoleCount: number;
  /** 两侧可达的闸集合(读数,给人看)。 */
  readonly writeGates: readonly string[];
  readonly previewGates: readonly string[];
}

export function analyzeReadPreview(): ReadPreviewReport {
  const text = read(SERVICE_FILE);
  const source = ts.createSourceFile(SERVICE_FILE, text, ts.ScriptTarget.Latest, true);
  const declaration = findClass(source, SERVICE_CLASS);
  const parsed: ParsedClass =
    declaration === null
      ? {
          relPath: SERVICE_FILE,
          source,
          text,
          classFound: false,
          methods: new Map(),
          declaration: null,
        }
      : parseSourceIntoClass(SERVICE_FILE, text, source, declaration);

  return {
    gateCount: [...parsed.methods.keys()].filter(isGate).length,
    serviceViolations: analyzeServiceSource(SERVICE_FILE, text),
    controllerViolations: analyzeController(),
    presenterViolations: checkPresenterHasNoCodeTable(),
    relayFailures: checkBlockedRelay(),
    editPolicy: checkEditPolicy(),
    bizCodeCount: Object.keys(BizCode).length,
    builtinRoleCount: PROTECTED_ROLE_CODES.length,
    writeGates: parsed.classFound ? gateReach(parsed, WRITE_ENTRY) : [],
    previewGates: parsed.classFound ? gateReach(parsed, PREVIEW_ENTRY) : [],
  };
}

/**
 * 自证 —— 先证明仪器没瞎,再报数。
 *
 * 「判据失去输入 ≠ 通过」:类被改名 / 闸被改成不带 `assert` 前缀 / BizCode 表读空 /
 * 内建角色清单删空 / 反向探针被收编,五种形态都会让上面的判据**全部退化成空集比空集**。
 */
export function selfCheck(report: ReadPreviewReport): string[] {
  const problems: string[] = [];

  if (report.gateCount < MIN_GATES) {
    problems.push(
      `类内只扫到 ${report.gateCount} 个 \`${GATE_PREFIX}*\` 闸,地板是 ${MIN_GATES} —— ` +
        '扫描面塌了(闸被改名成不带前缀,或类被改名),' +
        '「两侧可达的闸集合相等」会退化成「空集 == 空集」而全绿。',
    );
  }
  if (report.writeGates.length < MIN_GATES) {
    problems.push(
      `${WRITE_ENTRY}() 只可达 ${report.writeGates.length} 个闸(地板 ${MIN_GATES})—— ` +
        '真写入口自己都到不了全部闸,传递闭包多半坏了。',
    );
  }
  if (report.bizCodeCount < MIN_BIZ_CODES) {
    problems.push(
      `BizCode 表只读到 ${report.bizCodeCount} 条(地板 ${MIN_BIZ_CODES})—— ` +
        '搬运判据要在全域上跑,表读空就是仪器失效,不是「零违规」。',
    );
  }
  if (report.builtinRoleCount < BUILTIN_ROLE_FLOOR) {
    problems.push(
      `内建角色清单只有 ${report.builtinRoleCount} 条(地板 ${BUILTIN_ROLE_FLOOR})—— ` +
        'editPolicy 的正向断言会在空集上恒真。',
    );
  }
  if (CUSTOM_ROLE_PROBES.length === 0) {
    problems.push('反向对照探针为空 ⇒ 「自定义角色不许被标只读」恒不命中。');
  }
  const builtinCodes = new Set<string>(PROTECTED_ROLE_CODES);
  for (const probe of CUSTOM_ROLE_PROBES) {
    if (builtinCodes.has(probe)) {
      problems.push(
        `反向探针 ${probe} 已被收编进内建角色清单 —— 它不再是反向样本,换一个合成名。`,
      );
    }
  }

  // 两条对照必须一正一反。放在 selfCheck 里,`--check` 与薄运行器都会跑到。
  const clean = analyzeServiceSource('control-same-source.ts', CONTROL_SAME_SOURCE);
  if (clean.length > 0) {
    problems.push(
      `假阳性对照失败:同源的标准形态被判成违规(${clean.map((v) => v.rule).join(' / ')})—— ` +
        '本闸会把正确形态也报成违规,不可用。',
    );
  }
  const dirty = analyzeServiceSource('control-divergent.ts', CONTROL_DIVERGENT);
  const hit = [...new Set(dirty.map((v) => v.rule))].sort();
  const missed = ALL_RULES.filter((rule) => !hit.includes(rule));
  if (missed.length > 0) {
    problems.push(
      `真阳性对照失败:这些规则在「preview 自己判一遍」的样本上一条都没命中 —— ` +
        `${missed.join(' / ')}(规则被改瞎了)。`,
    );
  }

  return problems;
}

// ============================================================================
// CLI
// ============================================================================

function main(): void {
  const report = analyzeReadPreview();
  const problems = selfCheck(report);
  for (const problem of problems) console.error(`🔴 自证失败:${problem}`);

  console.log(
    `扫描面:${report.gateCount} 个闸 / BizCode ${report.bizCodeCount} 条 / 内建角色 ${report.builtinRoleCount} 个`,
  );
  console.log(`  ${WRITE_ENTRY}() 可达闸:${report.writeGates.join(' · ') || '无'}`);
  console.log(`  ${PREVIEW_ENTRY}() 可达闸:${report.previewGates.join(' · ') || '无'}`);

  const buckets: [string, string[]][] = [
    ['service 侧同源违规', report.serviceViolations.map((v) => `[${v.rule}] ${v.detail}`)],
    ['controller 侧同源违规', report.controllerViolations.map((v) => `[${v.rule}] ${v.detail}`)],
    ['presenter 越权判断', report.presenterViolations.map((v) => `[${v.rule}] ${v.detail}`)],
    [
      '拦截原因没有原样搬运',
      report.relayFailures.map((f) => `${f.code}:${f.reason}`),
    ],
    ['内建角色被标成可改', [...report.editPolicy.builtinMarkedEditable]],
    ['内建角色只读却没给原因码', [...report.editPolicy.builtinMissingReason]],
    ['自定义角色被标成只读', [...report.editPolicy.customMarkedReadOnly]],
    ['自定义角色可改却带了只读原因', [...report.editPolicy.customHasReason]],
    ['editPolicy 与分类字段不一致', [...report.editPolicy.disagreesWithClassification]],
  ];

  let broken = problems.length;
  for (const [label, offenders] of buckets) {
    if (offenders.length === 0) continue;
    broken += offenders.length;
    console.error(`🔴 ${label}:`);
    for (const offender of offenders) console.error(`   - ${offender}`);
  }

  if (broken === 0) {
    console.log('✓ preview 与 PUT 的准入判定同源(同一委托、同一闸集合、dry-run 出口在闸之后)。');
  }
  process.exit(broken === 0 ? 0 : 1);
}

if (require.main === module) main();
