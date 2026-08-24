/**
 * check-role-permission-impact.ts —— 「影响标注不许说谎 + step-up proof 不许复用」类闸(P1-32 PR 5)。
 *
 * ⚠️ 本文件在 `harness/redzone.json` 的 selfGuard 内(`scripts/check-*.ts`)。
 *    判据逻辑刻意放在这里而不是 spec 里:`src/**\/*.spec.ts` 不在 selfGuard,任何 PR 都能顺手
 *    改松它;把**实质逻辑**放在受保护文件里,改松就必须动红区。spec 侧只做薄运行器
 *    (`src/modules/permissions/role-permission-impact.criteria.spec.ts`),
 *    这条分工由 `scripts/check-criteria-spec-purity.ts` 机器执法。
 *
 * ──────────────────────────────────────────────────────────────────────────
 * 这条闸修的是哪三类缺陷(**三类各自独立,别用一条代替三条**)
 *
 * ① **「标了 EXACT 其实是估算」** —— 前端据此写「共影响 5 人」,而真值是 500。
 *    这个缺陷**零症状**:响应形状对、字段齐全、没有报错,只是那个数是编的。
 *    冻结稿 §11.4 逐字:「不要为了显示一个好看的数字而把不确定结果写成事实。」
 *
 * ② **「step-up proof 能跨维度复用」** —— 为角色 A / 旧 revision / 低风险 payload 申请的
 *    proof 拿去做另一件事。三条是**三个独立的维度**,任一条漏绑都让二次验证退化成
 *    「刚刚做过一次验证」这种与本次变更无关的证明(冻结稿 §12.2 逐字列了这四种滥用)。
 *    ⚠️ 本闸对三条**各做一次独立变异**,每个反面样本**只在被测那一维上不同** ——
 *    仓内踩过「上层边界遮蔽下层边界」:一条变异同时动两维时,另一维漏绑也照样红,
 *    于是「红了」证明不了「这一维在守」。
 *
 * ③ **「为了保险全都要 step-up」** —— DoD 第三条「低风险普通变更不被无意义加重」。
 *    没有假阳性对照时,把判定写成 `return true` 能让 ② 的三条变异全部通过 ——
 *    那正是这条 DoD 要防的实现倾向。
 *
 * ──────────────────────────────────────────────────────────────────────────
 * 另外两件本闸顺带钉住的事(它们是 ①②③ 成立的前提)
 *
 * ④ **step-up 闸的射程登记**:闸挂在 `runReplaceSet()`(`PUT` + `preview` 的共同委托)上,
 *    **不在** `assign()` / `revoke()` 走的那条增量原语上。这是 goal「不改 replace 原语的
 *    判定」的直接后果,也是一条**真实缺口**:持 `rbac.role-permission.create` 的人仍可用
 *    `POST /roles/:id/permissions` 加一条 CRITICAL 码而不触二次验证。
 *    🔴 **本条断言不是拦住什么,是让这个缺口在机器上可见**:
 *      · 有人把闸挂到原语上(收口缺口)⇒ 本条红 ⇒ 必须显式改这条登记 + 同步台账;
 *      · 冻结稿 PR 8 删掉那两条旧端点 ⇒ `assign` / `revoke` 消失 ⇒ 本条红并点名
 *        「被测对象没了,请重看射程登记」,而**不是**静默变成恒真。
 *    散文写在 PR body 里会被下一个人读成「step-up 已上线」;断言不会。
 *
 * ⑤ **不新造风险分级**:触发面锚在 Catalog 既有的 `riskLevel` / `riskTags` / `grantPolicy`
 *    与正在执法的 `isControlPlanePermissionCode()` 上。策略文件里出现任何权限码字面量
 *    = 又抄了一份清单 = 第二份真相(镜像 `check-role-classification.ts` 对角色 code 的同款禁令)。
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { JwtService } from '@nestjs/jwt';
import { Role, UserStatus } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import * as ts from 'typescript';

import { StepUpAction } from '../src/modules/auth/auth.dto';
import { IdentityStepUpService } from '../src/modules/auth/identity-step-up.service';
import {
  PERMISSION_CATALOG_METADATA,
  PERMISSION_RISK_LEVELS,
} from '../src/modules/permissions/permission-catalog';
import { PROTECTED_ROLE_CODES } from '../src/modules/permissions/protected-role-codes';
import { isControlPlanePermissionCode } from '../src/modules/permissions/role-delegation.policy';
import {
  SUPERVISION_DERIVED_ROLE_CODE,
  emptyPrincipalCounts,
  emptyScopeCounts,
  observedSource,
  summarizeRolePermissionImpact,
  unobservableSource,
} from '../src/modules/permissions/role-permission-impact';
import type { RolePermissionImpactFacts } from '../src/modules/permissions/role-permission-impact';
import {
  ROLE_PERMISSION_STEP_UP_AUDIENCE,
  ROLE_PERMISSION_STEP_UP_HKDF_SALT,
  ROLE_PERMISSION_STEP_UP_SIGNING_INFO,
  ROLE_PERMISSION_STEP_UP_ACTION,
  ROLE_PERMISSION_STEP_UP_SNAPSHOT_INFO,
  RolePermissionStepUpProofService,
} from '../src/common/security/role-permission-step-up-proof';
import type { RolePermissionSetStepUpBinding } from '../src/common/security/role-permission-step-up-proof';
import { SEED_PERMISSION_CODE_SET } from '../src/modules/permissions/seed-permission-codes';
import {
  STEP_UP_TRIGGERING_GRANT_POLICY,
  STEP_UP_TRIGGERING_RISK_LEVEL,
  STEP_UP_TRIGGERING_RISK_TAGS,
  isStepUpTriggeringCode,
  isStepUpTriggeringPermissionCode,
  requiresStepUpForChange,
  rolePermissionSetPayloadHash,
} from '../src/modules/permissions/role-permission-step-up.policy';

const ROOT = path.resolve(__dirname, '..');

// ============================================================================
// 被测对象(全部具名导出 —— 薄运行器只许引名字,不许写字面量)
// ============================================================================

export const SERVICE_FILE = 'src/modules/permissions/role-permissions.service.ts';
export const IMPACT_QUERY_FILE = 'src/modules/permissions/role-permission-impact-query.service.ts';
export const STEP_UP_POLICY_FILE = 'src/modules/permissions/role-permission-step-up.policy.ts';
export const AUTHZ_SERVICE_FILE = 'src/modules/authz/authz.service.ts';
export const AUTH_STEP_UP_FILE = 'src/modules/auth/identity-step-up.service.ts';
export const DOMAIN_MAP_FILE = 'harness/domain-map.json';

/** 本模块所属的域 —— impact 查询只许读**这个域**拥有的模型。 */
export const OWN_DOMAIN = 'platform-access';

export const SERVICE_CLASS = 'RolePermissionsService';

/** step-up 闸的方法名 —— 射程断言(④)的锚点。 */
export const STEP_UP_GATE = 'assertStepUpProofOrThrow';

/** 闸**必须**可达的两个入口(`PUT` 与 `preview`,4b 的同源轴)。 */
export const STEP_UP_IN_SCOPE_ENTRIES = ['replace', 'previewReplace'];

/**
 * 闸**刻意不覆盖**的入口。
 *
 * ⭐ **P1-32 PR 8(2026-08-24)起为空集,这是本闸的设计目的达成,不是判据失效。**
 *    PR 5 交付时这里登记着 `['assign', 'revoke']` —— 两条旧增量端点走同一条写原语
 *    却不经 `runReplaceSet()`,构成一条真实的 step-up 旁路(持
 *    `rbac.role-permission.create` 的人可用 `POST` 加一条 CRITICAL 码而不触二次验证)。
 *    当时那条 `stepup-scope-stale` 地板断言写着「PR 8 退役它们时本闸必红,强制重看登记」——
 *    ⇒ **本次就是那一刻**:端点与两个 service 方法一并删除,登记随之清空,两份台账同步。
 *
 * 🔴 **清空不等于「以后随便加」**:旁路窗口关闭这件事必须继续被机器守住,
 *    否则将来任何人新加一个绕过 `runReplaceSet()` 的写入口都不会有症状。
 *    接替它的是下面那条**禁止型**不变量 `writePathsBypassingStepUp` ——
 *    「凡能到达唯一写原语的方法,都必须能到达 step-up 闸」,**动态发现,不写死名单**。
 *    (仓内教训:接通接缝后必须另立禁止型闸,标注型闸对「接缝回退」失明。)
 */
export const STEP_UP_OUT_OF_SCOPE_ENTRIES: readonly string[] = [];

/**
 * 地板:能到达唯一写原语的方法**至少**这么多条(今天是 `replace` / `previewReplace` /
 * `runReplaceSet` 三条)。低于它说明扫描面塌了 —— 那时「零旁路」会退化成空集恒真。
 */
export const MIN_WRITE_PATHS = 3;

/** 唯一写原语 —— 射程地板:两个旧入口必须仍然经它落库,否则说明端点没了/改道了。 */
export const WRITE_PRIMITIVE = 'replaceRolePermissionSet';

/** 影响查询服务在 service 里的注入属性名 —— 「impact 只在 preview 算」那条的锚点。 */
export const IMPACT_QUERY_PROPERTY = 'impactQuery';

/** `authz.service.ts` 里分管推导那个固定角色常量的名字。 */
export const AUTHZ_SUPERVISOR_ROLE_CONST = 'SUPERVISOR_ROLE_CODE';

/** 权限码形态(3-4 段)—— 策略文件禁字面量那条的识别式。 */
export const PERMISSION_CODE_SHAPE = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*){2,3}$/;

// ============================================================================
// 地板锚点(全部具名 —— 「判据失去输入 ≠ 通过」)
// ============================================================================

/** 目录条目地板。目录被读空 ⇒ 下面的全域断言全部退化成空集恒真。 */
export const MIN_CATALOG_ENTRIES = 200;

/**
 * **低风险码地板** —— ③ 的假阳性对照本体。
 * 判定被写成 `return true` 时,不触发 step-up 的码会掉到 0,本条当场红。
 * 用地板不用"恰 N":分类调整会挪动这个数,而摩擦会诱导人把数字调小了事。
 */
export const MIN_NON_TRIGGERING_CODES = 60;

/** 高风险码地板 —— 反过来防「恒 false」。 */
export const MIN_TRIGGERING_CODES = 20;

/** 内建角色地板(与 `check-role-permission-read-preview.ts` 同值同理由)。 */
export const BUILTIN_ROLE_FLOOR = 15;

/**
 * impact 查询层至少要碰到这么多个 Prisma 模型 —— 少于它说明扫描面塌了
 * (查询被搬走 / 改名 / 换成 raw SQL),而不是「它老实待在本域里」。
 */
export const MIN_IMPACT_MODELS = 3;

/** domain-map 的模型归属表地板 —— 表读空会让「只读本域模型」退化成恒真。 */
export const MIN_OWNED_MODELS = 80;

export interface Violation {
  readonly rule: string;
  readonly detail: string;
}

function read(rel: string): string {
  return readFileSync(path.join(ROOT, rel), 'utf8');
}

function parse(rel: string): ts.SourceFile {
  return ts.createSourceFile(rel, read(rel), ts.ScriptTarget.Latest, true);
}

// ============================================================================
// ① 影响标注不许说谎(运行时;纯函数矩阵 + 独立反算真值)
// ============================================================================

export interface ImpactProbe {
  readonly label: string;
  readonly facts: RolePermissionImpactFacts;
}

/**
 * 事实矩阵:8 种「可观测组合」× 3 组读数。
 *
 * 🔴 **三源的数刻意互不相同、且含 0**:全相等的样本会让「求和」退化成"随便挑一个乘三",
 *    含 0 的样本才逼出「0 也要参与求和 / 0 不等于不可观测」这条区分。
 */
export function impactProbes(): ImpactProbe[] {
  const shapes: Array<{ label: string; a: number; b: number; c: number }> = [
    { label: '三源都有量', a: 3, b: 2, c: 5 },
    { label: '含 0 源', a: 0, b: 7, c: 0 },
    { label: '全 0', a: 0, b: 0, c: 0 },
  ];
  const probes: ImpactProbe[] = [];
  for (const shape of shapes) {
    for (let mask = 0; mask < 8; mask += 1) {
      const [oa, ob, oc] = [(mask & 1) === 0, (mask & 2) === 0, (mask & 4) === 0];
      probes.push({
        label: `${shape.label} / 可观测=${oa ? 'D' : '-'}${ob ? 'P' : '-'}${oc ? 'S' : '-'}`,
        facts: {
          roleBinding: oa ? observedSource(shape.a) : unobservableSource(),
          positionPolicy: ob ? observedSource(shape.b) : unobservableSource(),
          supervision: oc ? observedSource(shape.c) : unobservableSource(),
          scopeCounts: emptyScopeCounts(),
          principalCounts: emptyPrincipalCounts(),
        },
      });
    }
  }
  return probes;
}

/**
 * 逐条反算真值比对。
 *
 * 🔴 **真值不是"再调一次被测函数"** —— 那是同义反复。这里用一条**结构上不同**的算法
 *    重新求:三源相加直接由 `+` 取,可观测性直接由三个布尔取与。
 *    被测函数若把 `EXACT` 标在一个含不可观测源的样本上、或把和算错,当场点名。
 */
export function checkImpactHonesty(): Violation[] {
  const violations: Violation[] = [];
  for (const probe of impactProbes()) {
    const { facts } = probe;
    const summary = summarizeRolePermissionImpact(facts);

    const allObservable =
      facts.roleBinding.observable &&
      facts.positionPolicy.observable &&
      facts.supervision.observable;
    const trueTotal =
      facts.roleBinding.grantCount +
      facts.positionPolicy.grantCount +
      facts.supervision.grantCount;

    // ⭐ 靶心:标了 EXACT 就**必须**是精确数,且三源都本域可观测。
    if (summary.completeness === 'EXACT') {
      if (!allObservable) {
        violations.push({
          rule: 'exact-lies',
          detail:
            `[${probe.label}] 有源本域观测不到却标成 EXACT —— ` +
            '标注在说谎。前端会把一个数不出来的东西当成事实展示出去,而这没有任何症状。',
        });
      }
      if (summary.totalGrantCount !== trueTotal) {
        violations.push({
          rule: 'exact-lies',
          detail:
            `[${probe.label}] 标 EXACT 但 totalGrantCount=${summary.totalGrantCount},` +
            `独立反算的精确值是 ${trueTotal}。`,
        });
      }
      if (summary.partialReason !== null) {
        violations.push({
          rule: 'exact-lies',
          detail: `[${probe.label}] 标 EXACT 却同时给了不精确原因码 —— 两个字段互相矛盾。`,
        });
      }
    }

    // 反向:有源观测不到就必须是 PARTIAL,而且要给出原因码。
    if (!allObservable) {
      if (summary.completeness !== 'PARTIAL') {
        violations.push({
          rule: 'partial-missing',
          detail: `[${probe.label}] 有源本域观测不到却标成 ${summary.completeness}。`,
        });
      }
      if (summary.partialReason === null) {
        violations.push({
          rule: 'partial-missing',
          detail: `[${probe.label}] 标 PARTIAL 却没给原因码 —— 前端无从解释这个数为什么不准。`,
        });
      }
    }
    if (summary.totalGrantCount > trueTotal) {
      violations.push({
        rule: 'overstated-total',
        detail:
          `[${probe.label}] 报了 ${summary.totalGrantCount} 条授予,已解析事实只支持 ${trueTotal} 条 —— ` +
          '虚报比少报更危险(管理员会以为自己动了更多东西)。',
      });
    }

    // 每源自己的标注也必须两向一致(整体 EXACT 掩盖不了某一源在说谎)。
    for (const [name, src] of Object.entries(summary.sources)) {
      const raw = facts[name as keyof RolePermissionImpactFacts] as { observable: boolean };
      if ((src.completeness === 'EXACT') !== raw.observable) {
        violations.push({
          rule: 'source-completeness',
          detail: `[${probe.label}] 源 ${name} 的 completeness 与实际可观测状态不符。`,
        });
      }
      if ((src.partialReason === null) !== raw.observable) {
        violations.push({
          rule: 'source-completeness',
          detail: `[${probe.label}] 源 ${name} 的 partialReason 与 completeness 不同步。`,
        });
      }
    }
  }
  return violations;
}

// ============================================================================
// ① 之二:impact 查询**只许读本域自己的模型**(AST × domain-map)
//
// 上面那组断言的输入里,「这一源观测得到吗」是给定的。真实世界里那个布尔由查询层决定 ——
// 若它越界去读 identity-org 的模型,读数看起来更"完整"、断言照样全绿,
// 而代价是一条**架构反向依赖**(`docs:boundaries:newdebt:check` 的「禁新增代码债」)。
//
// 🔴 **发现面从 `harness/domain-map.json` 现取,不写死模型清单**:
//    domain-map 改了归属,本条自己跟上;写死清单则会在归属调整后**静默失效**。
// ============================================================================

export interface ImpactModelFacts {
  /** 本文件碰过的 Prisma 模型(PascalCase,已排序)。 */
  readonly models: readonly string[];
  /** 其中不属本域的(域名 → 模型)。 */
  readonly foreign: ReadonlyArray<{ model: string; domain: string }>;
  /** domain-map 里登记了归属的模型总数(地板自证用)。 */
  readonly ownedModelCount: number;
}

interface ModelOwnership {
  readonly [model: string]: { readonly domain: string } | undefined;
}

export function modelOwnership(): ModelOwnership {
  return (JSON.parse(read(DOMAIN_MAP_FILE)) as { modelOwnership: ModelOwnership }).modelOwnership;
}

/** `this.prisma.<x>` / `tx.<x>` 里的 `<x>` → Prisma 模型名(首字母大写)。 */
function modelNameOf(accessor: string): string {
  return accessor.charAt(0).toUpperCase() + accessor.slice(1);
}

export function impactModelFacts(): ImpactModelFacts {
  const source = parse(IMPACT_QUERY_FILE);
  const ownership = modelOwnership();
  const models = new Set<string>();

  const visit = (node: ts.Node): void => {
    // 形如 `this.prisma.roleBinding.count(...)`:取 `prisma` 后面那一段。
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'prisma'
    ) {
      models.add(modelNameOf(node.name.text));
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);

  const foreign: Array<{ model: string; domain: string }> = [];
  for (const model of models) {
    const owner = ownership[model];
    // 归属表里查不到 ⇒ 当作越界处理(fail-close):要么模型名解析错了,要么它没登记,
    // 两种都不该被当成"属于本域"。
    const domain = owner?.domain ?? 'UNKNOWN';
    if (domain !== OWN_DOMAIN) foreign.push({ model, domain });
  }
  return {
    models: [...models].sort(),
    foreign: foreign.sort((a, b) => a.model.localeCompare(b.model)),
    ownedModelCount: Object.keys(ownership).length,
  };
}

export function checkImpactCrossDomain(facts: ImpactModelFacts): Violation[] {
  const violations: Violation[] = [];
  if (facts.foreign.length > 0) {
    violations.push({
      rule: 'impact-cross-domain-read',
      detail:
        `${IMPACT_QUERY_FILE} 读了不属 ${OWN_DOMAIN} 的模型:` +
        `${facts.foreign.map((f) => `${f.model}(${f.domain})`).join(' / ')} —— ` +
        '`harness/domain-map.json` 的 allowedEdges 里 **没有** ' +
        `\`${OWN_DOMAIN} → identity-org\` 这条边,越界读是架构反向依赖,` +
        '会当场触 `docs:boundaries:newdebt:check` 的「禁新增代码债」棘轮。' +
        '⇒ 要么只报本域能证明的事实(本刀的选择),要么把那部分做成属主域的能力再顺着允许边取。',
    });
  }
  return violations;
}

// ============================================================================
// ③ 分管源那个固定角色的 src 侧副本没漂(跨文件 AST)
// ============================================================================

/** 从 `authz.service.ts` 现取 `SUPERVISOR_ROLE_CODE` 的字面量;取不到返 null(⇒ 扫描面塌)。 */
export function authzSupervisorRoleCode(): string | null {
  const source = parse(AUTHZ_SERVICE_FILE);
  let found: string | null = null;
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === AUTHZ_SUPERVISOR_ROLE_CONST &&
      node.initializer !== undefined &&
      ts.isStringLiteral(node.initializer)
    ) {
      found = node.initializer.text;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
  return found;
}

export function checkSupervisionAnchor(): Violation[] {
  const violations: Violation[] = [];
  const authzCode = authzSupervisorRoleCode();
  if (authzCode === null) {
    violations.push({
      rule: 'supervision-anchor',
      detail:
        `从 ${AUTHZ_SERVICE_FILE} 里取不到 \`${AUTHZ_SUPERVISOR_ROLE_CONST}\` 的字面量 —— ` +
        '扫描面塌了(常量被改名 / 改成计算构造)。这是红,不是「没有漂移」。',
    });
    return violations;
  }
  if (authzCode !== SUPERVISION_DERIVED_ROLE_CODE) {
    violations.push({
      rule: 'supervision-anchor',
      detail:
        `分管推导角色漂了:判权链算的是 '${authzCode}',影响预览按的是 ` +
        `'${SUPERVISION_DERIVED_ROLE_CODE}' —— 两边不是同一个角色,` +
        'supervision 那一源的读数会对着错误的角色算,而两边都不会报错。',
    });
  }
  if (!PROTECTED_ROLE_CODES.includes(authzCode as (typeof PROTECTED_ROLE_CODES)[number])) {
    violations.push({
      rule: 'supervision-anchor',
      detail:
        `'${authzCode}' 不在内建角色清单里了 —— 「supervision 源对一切可编辑角色恒为 0」` +
        '这条依据当场失效(它靠的是该角色权限集只读、任何编辑先返 30108)。' +
        '要么恢复它的内建身份,要么把 impact 头注里那条依据改掉并重新论证精确性。',
    });
  }
  return violations;
}

// ============================================================================
// ③ 之二:高风险判定锚在既有字段上,且**两向**都成立
// ============================================================================

export interface RiskReport {
  readonly catalogSize: number;
  readonly triggering: readonly string[];
  readonly nonTriggering: readonly string[];
  /** 应该触发却没触发的码(逐条点名)。 */
  readonly missedHighRisk: readonly string[];
  /** 不该触发却触发了的码(假阳性;逐条点名)。 */
  readonly overReach: readonly string[];
  /** 目录外的码有没有 fail-close。 */
  /** 「在 seed 闭包里、却缺目录元数据」是否 fail-close(目录漏登记 ⇒ 必须拦)。 */
  readonly seedGapFailsClosed: boolean;
  /** 「压根不在 seed 闭包里」是否**不**加重(不是本系统的码,弹二次验证是无意义加重)。 */
  readonly outOfClosureNotEscalated: boolean;
  /** seed 闭包里缺目录元数据的码 —— 必须为空集,否则上面那条 fail-close 就在真数据上可达了。 */
  readonly catalogClosureGap: readonly string[];
  /** 空差集(no-op)有没有被无意义加重。 */
  readonly noOpTriggers: boolean;
  /** 撤销高风险码有没有同样触发(授撤对称)。 */
  readonly removalSymmetric: boolean;
}

export function analyzeRisk(): RiskReport {
  const entries = Object.entries(PERMISSION_CATALOG_METADATA);
  const triggering: string[] = [];
  const nonTriggering: string[] = [];
  const missedHighRisk: string[] = [];
  const overReach: string[] = [];

  for (const [code, meta] of entries) {
    const actual = isStepUpTriggeringPermissionCode(code);
    // 独立重算「该不该触发」:四条锚点各查各的既有字段,与被测函数的写法无关。
    const expected =
      isControlPlanePermissionCode(code) ||
      meta.riskLevel === STEP_UP_TRIGGERING_RISK_LEVEL ||
      meta.grantPolicy === STEP_UP_TRIGGERING_GRANT_POLICY ||
      meta.riskTags.some((tag) => STEP_UP_TRIGGERING_RISK_TAGS.includes(tag));
    (actual ? triggering : nonTriggering).push(code);
    if (expected && !actual) missedHighRisk.push(code);
    if (!expected && actual) overReach.push(code);
  }

  // 🔴 「目录里查不到」的**两档**,结论相反,必须分别驱动 —— 用参数化谓词直接喂,
  //    因为「闭包内缺元数据」在真数据上是空集(见下面 catalogClosureGap),
  //    不参数化的话那条 fail-close 分支永远测不到,等于没有。
  const probeCode = 'harness-probe.unknown.code';
  const seedGapFailsClosed = isStepUpTriggeringCode(probeCode, undefined, true);
  const outOfClosureNotEscalated = !isStepUpTriggeringCode(probeCode, undefined, false);
  // ② 那一档今天必须是空集:seed 闭包里的每条码都要有目录元数据。
  const catalogClosureGap = [...SEED_PERMISSION_CODE_SET].filter(
    (code) => PERMISSION_CATALOG_METADATA[code] === undefined,
  );
  // 高风险 / 低风险各现取一条,**不写死码名** —— 分类调整时判据自己跟上。
  const criticalCode = triggering.find(
    (code) => PERMISSION_CATALOG_METADATA[code].riskLevel === STEP_UP_TRIGGERING_RISK_LEVEL,
  );

  return {
    catalogSize: entries.length,
    triggering,
    nonTriggering,
    missedHighRisk: missedHighRisk.sort(),
    overReach: overReach.sort(),
    seedGapFailsClosed,
    outOfClosureNotEscalated,
    catalogClosureGap: catalogClosureGap.sort(),
    noOpTriggers: requiresStepUpForChange([], []),
    removalSymmetric:
      criticalCode === undefined ? false : requiresStepUpForChange([], [criticalCode]),
  };
}

export function checkRisk(report: RiskReport): Violation[] {
  const violations: Violation[] = [];
  if (report.missedHighRisk.length > 0) {
    violations.push({
      rule: 'risk-underreach',
      detail:
        `这些码按 Catalog 既有字段属于高风险,却不触发二次验证:${report.missedHighRisk.join(' / ')}。` +
        '触发面必须是那四条锚点的**并**,少一条就有一族高风险变更悄悄免检。',
    });
  }
  if (report.overReach.length > 0) {
    violations.push({
      rule: 'risk-overreach',
      detail:
        `这些码在四条锚点上都不算高风险,却触发了二次验证:${report.overReach.join(' / ')} —— ` +
        '这是 DoD 第三条要防的「无意义加重」,也说明触发面另开了一套判据。',
    });
  }
  if (!report.seedGapFailsClosed) {
    violations.push({
      rule: 'risk-fail-open',
      detail:
        '**在 seed 闭包里、却缺目录元数据**的码被当成低风险放行 —— 那是目录漏登记,' +
        '而「查不到就当低风险」在这一档是一条**零症状**的放行路:新码进了闭包却漏挂元数据,' +
        '二次验证就对它悄悄失效。这一档必须 fail-close。',
    });
  }
  if (!report.outOfClosureNotEscalated) {
    violations.push({
      rule: 'risk-overreach',
      detail:
        '**压根不在 seed 闭包里**的码也被要求二次验证 —— 它不是这个系统拥有的权限码' +
        '(`POST /permissions` 对闭包外的码返 30106),那条变更真提交时会因 30001 整批拒绝。' +
        '在此之前先弹一个二次验证框是**无意义加重**,还会让人以为「验证过就能加」。' +
        '⚠️ 测试夹具里这类合成码大量存在,把它判成高风险会让 DoD 第三条在最常见的路径上当场失效。',
    });
  }
  if (report.catalogClosureGap.length > 0) {
    violations.push({
      rule: 'catalog-closure-gap',
      detail:
        `seed 闭包里有 ${report.catalogClosureGap.length} 条码缺目录元数据:` +
        `${report.catalogClosureGap.slice(0, 5).join(' / ')}… —— ` +
        '上面那条 fail-close 分支本来是空集(靠 PR 1/2 的「闭包 ↔ 元数据双向集合相等」撑着),' +
        '现在它在真数据上可达了:这些码会被一律当高风险,而真正的问题是**目录漏登记**。' +
        '⇒ 去补目录,别来放宽这条判据。',
    });
  }
  if (report.noOpTriggers) {
    violations.push({
      rule: 'no-op-escalated',
      detail: '空差集(什么都没改)也要求二次验证 —— 纯粹的无意义加重。',
    });
  }
  if (!report.removalSymmetric) {
    violations.push({
      rule: 'revoke-asymmetric',
      detail:
        '**撤销**一条高风险码不触发二次验证,只有授予触发 —— ' +
        '把终审 / 账本 / 控制面能力从一批人手上撤掉,damage 方向相反但同属高风险变更。' +
        '「一侧有闸、另一侧裸奔」正是本仓反复吃亏的形态。',
    });
  }
  return violations;
}

// ============================================================================
// ⑤ 策略文件里不许出现权限码字面量(AST)
// ============================================================================

export function checkNoSecondRiskScale(): Violation[] {
  const source = parse(STEP_UP_POLICY_FILE);
  const violations: Violation[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) && PERMISSION_CODE_SHAPE.test(node.text)) {
      violations.push({
        rule: 'second-risk-scale',
        detail:
          `${STEP_UP_POLICY_FILE} 里出现了权限码字面量 '${node.text}' —— ` +
          '触发面必须由 Catalog 既有字段与正在执法的谓词算出来。抄一份码清单进来就是' +
          '第二份分级:它与目录第一天一致,此后目录调整不会让它有任何症状。' +
          '(镜像 `role-classification.ts` 对角色 code 的同款禁令。)',
      });
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
  return violations;
}

// ============================================================================
// ⑥ payload 指纹的三条性质(运行时)
// ============================================================================

export function checkPayloadHash(): Violation[] {
  const violations: Violation[] = [];
  const base = ['b.read.x', 'a.read.y', 'c.read.z'];

  // 规范化:去重 + 乱序 ⇒ 同一个指纹(否则 preview 拿到的 proof 会在 PUT 时莫名失效)。
  const shuffled = ['c.read.z', 'a.read.y', 'b.read.x', 'a.read.y'];
  if (rolePermissionSetPayloadHash(base) !== rolePermissionSetPayloadHash(shuffled)) {
    violations.push({
      rule: 'payload-hash-normalization',
      detail:
        '同一个权限码**集合**(乱序 / 含重复)算出了不同指纹 —— ' +
        'service 侧本来就先去重排序再落库,指纹不跟着规范化会让 proof 无故失效,而原因无从解释。',
    });
  }

  // 区分:任何真正不同的集合 ⇒ 不同指纹。
  const variants: Array<[string, string[]]> = [
    ['多一条', [...base, 'd.read.w']],
    ['少一条', base.slice(1)],
    ['换一条', [...base.slice(1), 'd.read.w']],
    ['空集', []],
  ];
  const baseHash = rolePermissionSetPayloadHash(base);
  for (const [label, variant] of variants) {
    if (rolePermissionSetPayloadHash(variant) === baseHash) {
      violations.push({
        rule: 'payload-hash-collision',
        detail: `「${label}」的目标集合与基准集合算出了同一个指纹 —— payload 那一维形同虚设。`,
      });
    }
  }

  // 稳定:同一输入两次调用同结果(带随机 salt 的实现会让 proof 一次性作废)。
  if (rolePermissionSetPayloadHash(base) !== baseHash) {
    violations.push({
      rule: 'payload-hash-unstable',
      detail: '同一输入两次调用得到不同指纹 —— 指纹里混进了随机量,proof 永远对不上。',
    });
  }
  return violations;
}

// ============================================================================
// ④ step-up 闸的**射程登记**(AST;本闸最容易被误读成"多余"的一条,理由见文件头 ④)
// ============================================================================

interface MethodFacts {
  readonly name: string;
  readonly line: number;
  readonly selfCalls: readonly string[];
  readonly directGates: readonly string[];
  readonly conditionalGates: readonly string[];
  readonly identifiers: ReadonlySet<string>;
}

function selfCallName(node: ts.CallExpression): string | null {
  const callee = node.expression;
  if (!ts.isPropertyAccessExpression(callee)) return null;
  if (callee.expression.kind !== ts.SyntaxKind.ThisKeyword) return null;
  return callee.name.text;
}

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

function serviceMethods(): ReadonlyMap<string, MethodFacts> {
  const source = parse(SERVICE_FILE);
  const methods = new Map<string, MethodFacts>();
  let declaration: ts.ClassDeclaration | null = null;
  const findClass = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node) && node.name?.text === SERVICE_CLASS) declaration = node;
    ts.forEachChild(node, findClass);
  };
  ts.forEachChild(source, findClass);
  if (declaration === null) return methods;

  for (const member of (declaration as ts.ClassDeclaration).members) {
    if (!ts.isMethodDeclaration(member) || !ts.isIdentifier(member.name)) continue;
    const selfCalls = new Set<string>();
    const directGates = new Set<string>();
    const conditionalGates = new Set<string>();
    const identifiers = new Set<string>();
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node)) identifiers.add(node.text);
      if (ts.isCallExpression(node)) {
        const name = selfCallName(node);
        if (name !== null) {
          selfCalls.add(name);
          if (name.startsWith('assert')) {
            directGates.add(name);
            if (underCondition(node, member)) conditionalGates.add(name);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    if (member.body !== undefined) ts.forEachChild(member.body, visit);
    methods.set(member.name.text, {
      name: member.name.text,
      line: source.getLineAndCharacterOfPosition(member.getStart(source)).line + 1,
      selfCalls: [...selfCalls].sort(),
      directGates: [...directGates].sort(),
      conditionalGates: [...conditionalGates].sort(),
      identifiers,
    });
  }
  return methods;
}

/** 沿 `this.<x>()` 边做传递闭包,收集途中所有 `assert*`。 */
function gateReach(methods: ReadonlyMap<string, MethodFacts>, start: string): string[] {
  const gates = new Set<string>();
  const seen = new Set<string>();
  const stack = [start];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    if (seen.has(current)) continue;
    seen.add(current);
    const facts = methods.get(current);
    if (facts === undefined) continue;
    for (const gate of facts.directGates) gates.add(gate);
    stack.push(...facts.selfCalls);
  }
  return [...gates].sort();
}

/** 沿 `this.<x>()` 边判断 `start` 能不能到达某个方法(不限于闸)。 */
function reachesMethod(
  methods: ReadonlyMap<string, MethodFacts>,
  start: string,
  target: string,
): boolean {
  const seen = new Set<string>();
  const stack = [start];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    if (current === target) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    const facts = methods.get(current);
    if (facts === undefined) continue;
    stack.push(...facts.selfCalls);
  }
  return false;
}

export interface JurisdictionReport {
  readonly inScopeReach: Readonly<Record<string, boolean>>;
  readonly outOfScopeReach: Readonly<Record<string, boolean>>;
  /** 旧入口是否仍然存在并经唯一写原语落库。PR 8 退役后恒为空对象(登记已清空)。 */
  readonly legacyEntriesStillWired: Readonly<Record<string, boolean>>;
  /** 能到达唯一写原语的全部方法(动态发现;地板 `MIN_WRITE_PATHS`)。 */
  readonly writePathsToPrimitive: readonly string[];
  /** 其中**到不了** step-up 闸的 —— 即绕过二次验证的写路径。**必须恒为空**。 */
  readonly writePathsBypassingStepUp: readonly string[];
  readonly gateIsConditional: boolean;
  readonly gateExists: boolean;
  /** `impactQuery` 出现在哪些方法里(应当恰是 preview 那一个)。 */
  readonly impactQueryUsers: readonly string[];
}

export function analyzeJurisdiction(): JurisdictionReport {
  const methods = serviceMethods();
  const inScopeReach: Record<string, boolean> = {};
  for (const entry of STEP_UP_IN_SCOPE_ENTRIES) {
    inScopeReach[entry] = gateReach(methods, entry).includes(STEP_UP_GATE);
  }
  const outOfScopeReach: Record<string, boolean> = {};
  const legacyEntriesStillWired: Record<string, boolean> = {};
  for (const entry of STEP_UP_OUT_OF_SCOPE_ENTRIES) {
    outOfScopeReach[entry] = gateReach(methods, entry).includes(STEP_UP_GATE);
    legacyEntriesStillWired[entry] =
      methods.has(entry) && reachesMethod(methods, entry, WRITE_PRIMITIVE);
  }
  // 🔴 禁止型不变量:凡能到达唯一写原语的方法,都必须能到达 step-up 闸。
  //    写原语自身排除(它是终点,闸挂在它上游的 runReplaceSet 上)。
  const writePathsToPrimitive = [...methods.keys()]
    .filter((name) => name !== WRITE_PRIMITIVE && reachesMethod(methods, name, WRITE_PRIMITIVE))
    .sort();
  const writePathsBypassingStepUp = writePathsToPrimitive
    .filter((name) => !gateReach(methods, name).includes(STEP_UP_GATE))
    .sort();
  const impactQueryUsers = [...methods.values()]
    .filter((m) => m.identifiers.has(IMPACT_QUERY_PROPERTY))
    .map((m) => m.name)
    .sort();
  const gateIsConditional = [...methods.values()].some((m) =>
    m.conditionalGates.includes(STEP_UP_GATE),
  );
  return {
    inScopeReach,
    outOfScopeReach,
    legacyEntriesStillWired,
    writePathsToPrimitive,
    writePathsBypassingStepUp,
    gateIsConditional,
    gateExists: methods.has(STEP_UP_GATE),
    impactQueryUsers,
  };
}

export function checkJurisdiction(report: JurisdictionReport): Violation[] {
  const violations: Violation[] = [];
  if (!report.gateExists) {
    return [
      {
        rule: 'stepup-gate-missing',
        detail:
          `${SERVICE_FILE} 里找不到 \`${STEP_UP_GATE}()\` —— 被测对象没了,射程判据失去输入。`,
      },
    ];
  }
  for (const [entry, reached] of Object.entries(report.inScopeReach)) {
    if (!reached) {
      violations.push({
        rule: 'stepup-scope-shrunk',
        detail:
          `\`${entry}()\` 到不了 \`${STEP_UP_GATE}\` —— ` +
          '高风险变更从这条路进来就免检了。两个入口必须**都**可达:' +
          '只挂 PUT 会让预览说能过而真提交拒;只挂 preview 则等于没挂。',
      });
    }
  }
  for (const [entry, reached] of Object.entries(report.outOfScopeReach)) {
    if (reached) {
      violations.push({
        rule: 'stepup-scope-grew',
        detail:
          `\`${entry}()\`(旧增量端点)现在也到得了 \`${STEP_UP_GATE}\` —— ` +
          '射程变了。这**可能是好事**(把那条旧缺口收口了),但它是**行为破坏**:' +
          `\`${entry}\` 的入参 DTO 里没有 proof 字段,持高风险码的既有调用方会当场开始失败。` +
          '⇒ 请显式改本闸的射程登记(STEP_UP_OUT_OF_SCOPE_ENTRIES)、同步两份台账、' +
          '并在 PR body 里申报契约破坏 —— 不许静默扩大。',
      });
    }
  }
  for (const [entry, wired] of Object.entries(report.legacyEntriesStillWired)) {
    if (!wired) {
      violations.push({
        rule: 'stepup-scope-stale',
        detail:
          `\`${entry}()\` 已经不存在、或不再经唯一写原语 \`${WRITE_PRIMITIVE}\` 落库 —— ` +
          '本闸的射程登记建立在「该入口仍在、且不受 step-up 管辖」这个事实上。' +
          '⇒ 请**重看射程登记**:那条缺口窗口已经关闭,' +
          '把它从 STEP_UP_OUT_OF_SCOPE_ENTRIES 里删掉并同步台账。' +
          '本条存在的全部意义就是让这一刻**必须被看见**,而不是悄悄失效。',
      });
    }
  }
  // 🔴 禁止型不变量(P1-32 PR 8 接替 `stepup-scope-*` 的登记):零旁路。
  if (report.writePathsToPrimitive.length < MIN_WRITE_PATHS) {
    violations.push({
      rule: 'writepath-scan-collapsed',
      detail:
        `只发现 ${report.writePathsToPrimitive.length} 条通往 \`${WRITE_PRIMITIVE}\` 的路径,` +
        `低于地板 ${MIN_WRITE_PATHS} —— 扫描面塌了。` +
        '这一条**必须先于**下面那条零旁路断言:扫描面塌掉时「零旁路」会退化成空集恒真,' +
        '判据看起来全绿而实际上什么都没看。',
    });
  }
  if (report.writePathsBypassingStepUp.length > 0) {
    violations.push({
      rule: 'stepup-bypass',
      detail:
        `这些方法能改写 role_permissions 却到不了 \`${STEP_UP_GATE}\`:` +
        report.writePathsBypassingStepUp.join(' / ') +
        ' —— 高风险变更从这条路进来就免检了。' +
        'P1-32 PR 8 退役旧增量端点之后,写面收成 \`replace\` / \`previewReplace\` 两条、' +
        '两条都在闸内;**新增写入口必须同样经 \`runReplaceSet()\`**,' +
        '否则就是把 PR 8 刚关上的那扇旁路重新打开(而且不会有任何运行时症状)。',
    });
  }
  if (report.gateIsConditional) {
    violations.push({
      rule: 'stepup-conditional',
      detail:
        `\`${STEP_UP_GATE}\` 的调用点被包在了分支里 —— ` +
        '「dry-run 时跳过二次验证」只需要一个 `if`,而射程断言照样全绿。' +
        '闸必须是无条件语句;要不要真拦由闸内部按差集决定。',
    });
  }
  if (report.impactQueryUsers.length !== 1 || report.impactQueryUsers[0] !== 'previewReplace') {
    violations.push({
      rule: 'impact-scope',
      detail:
        `影响查询(\`${IMPACT_QUERY_PROPERTY}\`)出现在 [${report.impactQueryUsers.join(' / ') || '无'}],` +
        '应当**恰好**只在 `previewReplace()` 里。冻结稿风险表逐字「只在 preview 执行」——' +
        '挂到写路径上会让每次真提交多跑一轮统计查询,而那是在角色行锁的临界区附近。',
    });
  }
  return violations;
}

// ============================================================================
// ② step-up proof 的**三条不许复用** —— 本闸的靶心(运行时;跑真实签发 + 真实验签)
//
// 🔴 **三条各做一次独立变异,每个反面样本只在被测那一维上不同。**
//    仓内踩过「上层边界遮蔽下层边界」:一次变异同时动两维时,即便其中一维根本没绑,
//    另一维也会让它红 —— 于是"红了"证明不了"这一维在守"。
//
// 🔴 **必须有正向对照(原样复用必须通过)**:没有它,一句 `throw` 就能让三条变异全绿。
//    这条与 ③「低风险不加重」是同一个道理的两个落点。
//
// ⚠️ 走的是**真实代码**:proof 由 `IdentityStepUpService.stepUpWithPassword()` 签发
//    (依赖全部用哑元替身,零 DB;它内部**委托** `RolePermissionStepUpProofService` 签发),
//    再由 `RolePermissionStepUpProofService.verify()` 校验 —— 后者正是
//    `RolePermissionsService` 生产路径上调的那一个。不是照着算法重算一遍。
// ============================================================================

/** 变异矩阵里的基准绑定。三个维度各有一个"只改这一维"的孪生样本。 */
export const PROOF_BASE_BINDING: RolePermissionSetStepUpBinding = {
  roleId: 'harness-probe-role-a',
  expectedRevision: 7,
  payloadHash: rolePermissionSetPayloadHash(['a.read.x', 'b.read.y']),
};

/**
 * 三条维度的反面样本。**每条只改一个字段**,其余两个与基准逐字相同。
 * 名字进报告,变异对拍按它比对。
 */
export const PROOF_REUSE_MUTATIONS: ReadonlyArray<{
  readonly dimension: string;
  readonly why: string;
  readonly binding: RolePermissionSetStepUpBinding;
}> = [
  {
    dimension: 'cross-role',
    why: '为角色 A 申请的 proof 拿去改角色 B',
    binding: { ...PROOF_BASE_BINDING, roleId: 'harness-probe-role-b' },
  },
  {
    dimension: 'cross-revision',
    why: 'revision 已经前进,旧 proof 仍被复用',
    binding: { ...PROOF_BASE_BINDING, expectedRevision: PROOF_BASE_BINDING.expectedRevision + 1 },
  },
  {
    dimension: 'cross-payload',
    why: '为低风险差异申请的 proof 换成另一套目标权限码',
    binding: {
      ...PROOF_BASE_BINDING,
      payloadHash: rolePermissionSetPayloadHash(['a.read.x', 'b.read.y', 'c.write.z']),
    },
  },
];

const PROBE_SECRET = 'harness-probe-step-up-secret';
const PROBE_PASSWORD = 'harness-probe-password-1';

function probeCredential() {
  return {
    id: 'harness-probe-user-1',
    // 真 bcrypt 哈希(cost 4,只为让 `bcrypt.compare` 走真实分支;不是任何真实口令)
    passwordHash: bcrypt.hashSync(PROBE_PASSWORD, 4),
    phone: '13800000001',
    phoneVerifiedAt: new Date('2026-08-01T00:00:00.000Z'),
    openid: null,
    status: UserStatus.ACTIVE,
    deletedAt: null,
  };
}

/** 本域自有的 proof service —— **生产路径上验签的就是它**。零 DB、零 DI 容器。 */
function probeProofService(): RolePermissionStepUpProofService {
  return new RolePermissionStepUpProofService(new JwtService(), {
    get: () => ({ secret: PROBE_SECRET }),
  } as never);
}

/**
 * 用哑元依赖起一个真的 `IdentityStepUpService`(零 DB;镜像既有 spec 的 harness 形态)。
 *
 * ⭐ **它内部自己 new 一个 proof service** —— 与 `probeProofService()` 给出的那个是
 *    **两个独立实例**,正如生产里 auth 侧签、permissions 侧验就是两个实例。
 *    ⇒ 下面的「签得出、验得过」同时也是 `proof-instance-interop` 的实测:
 *    proof service 一旦带上任何实例态(随机量 / 内存缓存),这两侧立刻对不上。
 */
function probeStepUpService(row: ReturnType<typeof probeCredential>): IdentityStepUpService {
  const prisma = {
    user: { findFirst: async () => ({ ...row, role: Role.USER, wecomIdentityVersion: 0 }) },
    wecomIdentity: { findFirst: async () => null },
  };
  const auditLogs = { log: async () => undefined };
  const config = { get: () => ({ secret: PROBE_SECRET }) };
  return new IdentityStepUpService(
    prisma as never,
    new JwtService(),
    {} as never,
    {} as never,
    auditLogs as never,
    config as never,
  );
}

function rejected(run: () => void): boolean {
  try {
    run();
    return false;
  } catch {
    return true;
  }
}

export async function checkStepUpProofReuse(): Promise<Violation[]> {
  const violations: Violation[] = [];
  const row = probeCredential();
  const proof = probeProofService();
  const service = probeStepUpService(row);
  const currentUser = {
    id: row.id,
    username: 'harness-probe',
    role: Role.USER,
    status: UserStatus.ACTIVE,
    memberId: null,
  };
  const meta = { requestId: 'harness-probe', ip: null, ua: null };

  // 真实签发路径:验密码 → 委托本域 proof service 签。
  const { stepUpToken } = await service.stepUpWithPassword(
    currentUser as never,
    {
      action: StepUpAction.RBAC_ROLE_PERMISSION_SET_REPLACE,
      password: PROBE_PASSWORD,
      rolePermissionSet: PROOF_BASE_BINDING,
    } as never,
    meta as never,
  );

  // ⭐ 正向对照:原样复用**必须通过**。没有它,「恒拒绝」能让下面三条变异全绿。
  if (rejected(() => proof.verify(row.id, stepUpToken, PROOF_BASE_BINDING))) {
    violations.push({
      rule: 'proof-false-positive',
      detail:
        '刚签发的 proof 拿原样的三元组去验都不通过 —— 验签把合法 proof 也拒了。' +
        '这条一红,下面三条「必红」全部失去意义(恒拒绝当然三条都红)。',
    });
  }

  // ⭐ 三条各自单独变异:每个样本只在被测那一维上与基准不同。
  for (const mutation of PROOF_REUSE_MUTATIONS) {
    const differing = (['roleId', 'expectedRevision', 'payloadHash'] as const).filter(
      (key) => mutation.binding[key] !== PROOF_BASE_BINDING[key],
    );
    if (differing.length !== 1) {
      violations.push({
        rule: 'mutation-not-isolated',
        detail:
          `变异 ${mutation.dimension} 与基准相差 ${differing.length} 个维度` +
          `(${differing.join(' / ') || '零'})—— 必须**恰好一个**。` +
          '一次动两维时,另一维根本没绑也照样红,「红了」就证明不了这一维在守' +
          '(仓内「上层边界遮蔽下层边界」的同款形态)。',
      });
      continue;
    }
    if (!rejected(() => proof.verify(row.id, stepUpToken, mutation.binding))) {
      violations.push({
        rule: `proof-reuse-${mutation.dimension}`,
        detail:
          `只改 ${differing[0]} 一个字段(${mutation.why})之后,同一条 proof **仍然验得过** —— ` +
          `这一维没有进签名快照。冻结稿 §12.2 逐字点名要挡住的就是它。`,
      });
    }
  }

  // 附加维度(不属 DoD 三条,但同属「proof 必须绑定具体变更」):换个人不许通用。
  if (!rejected(() => proof.verify('harness-probe-user-2', stepUpToken, PROOF_BASE_BINDING))) {
    violations.push({
      rule: 'proof-reuse-cross-subject',
      detail:
        '甲的 proof 能给乙用 —— 主体没进签名快照。二次验证证明的是"**这个人**刚验过身份",' +
        '换个人还能用就等于谁验一次全体通行。',
    });
  }
  return violations;
}

// ============================================================================
// ② 之三:**两族 proof 互相冒充不了**(运行时;真签发 × 交叉验签)
//
// 🔴 本刀把配置变更 proof 从 auth 的身份绑定 proof 里**分了出去**(各有各的 HKDF 盐 /
//    info 域与 audience),理由是依赖方向:platform-access 不能反向依赖 identity-org。
//    那次拆分**顺带带来一层更强的保证** —— 两族在结构上互相冒充不了,
//    而不是靠 `action` 字段这种"同一把钥匙签、靠一个声明区分"的形态。
//
// ⚠️ 这条断言存在的意义是把那层保证**钉住**:哪天有人图省事把两族并回同一把密钥
//    (或同一个 audience),身份绑定 proof 就能拿来改角色权限集,而**不会有任何症状**。
//
// 🔴 **两条断言分工要说清楚,别把强度算重**:
//    · `checkProofFamilyIsolation`(字符串层)—— 证明「密钥域 / audience 确实分开了」。
//      **它才是密钥域隔离的执行位。**
//    · `checkProofFamilyForgery`(行为层)—— 证明「此刻确实冒充不了」。
//      ⚠️ 它今天被**两层**同时保护着:密钥域隔离 **与** `action` 声明比对。
//      也就是说单看它红不红,**推不出**密钥域还在不在(把密钥并回去、只留 action 判别,
//      它照样绿)。所以两条都要留 —— 行为层证「现在是安全的」,字符串层证「靠的是哪一层」。
// ============================================================================

export function checkProofFamilyIsolation(): Violation[] {
  const violations: Violation[] = [];

  // 🔴 action 字面量现在住在**两处**:`auth.dto.ts` 的枚举(签发侧)与本 proof 的常量(验签侧)。
  //    它们不在同一个文件里(域中立层不该 import auth 的 DTO),所以必须钉住相等 ——
  //    漂了的症状是「所有 proof 都验不过」,而排查会先去怀疑密钥。
  if (ROLE_PERMISSION_STEP_UP_ACTION !== StepUpAction.RBAC_ROLE_PERMISSION_SET_REPLACE) {
    violations.push({
      rule: 'proof-action-literal-drift',
      detail:
        `验签侧的 action 常量是 '${ROLE_PERMISSION_STEP_UP_ACTION}',` +
        `签发侧的枚举值是 '${StepUpAction.RBAC_ROLE_PERMISSION_SET_REPLACE}' —— 两处必须逐字相同。`,
    });
  }

  // 字符串层:密钥域与 audience 必须逐字不同(先证明"分开了"这件事本身)。
  const authConstants = read(AUTH_STEP_UP_FILE);
  for (const own of [
    ROLE_PERMISSION_STEP_UP_AUDIENCE,
    ROLE_PERMISSION_STEP_UP_HKDF_SALT,
    ROLE_PERMISSION_STEP_UP_SIGNING_INFO,
    ROLE_PERMISSION_STEP_UP_SNAPSHOT_INFO,
  ]) {
    if (authConstants.includes(`'${own}'`)) {
      violations.push({
        rule: 'proof-family-shared-domain',
        detail:
          `配置变更 proof 的域串 '${own}' 同时出现在 ${AUTH_STEP_UP_FILE} 里 —— ` +
          '两族共用同一个密钥域 / audience,一族的 token 就能冒充另一族。',
      });
    }
  }
  return violations;
}

/** 行为层:身份绑定族签的 token,配置变更族**必须**验不过(异步,要真签发)。 */
export async function checkProofFamilyForgery(): Promise<Violation[]> {
  const violations: Violation[] = [];
  const row = probeCredential();
  const proof = probeProofService();
  const service = probeStepUpService(row);
  const currentUser = {
    id: row.id,
    username: 'harness-probe',
    role: Role.USER,
    status: UserStatus.ACTIVE,
    memberId: null,
  };
  const meta = { requestId: 'harness-probe', ip: null, ua: null };

  const identityProof = await service.stepUpWithPassword(
    currentUser as never,
    { action: StepUpAction.PHONE_BIND, password: PROBE_PASSWORD } as never,
    meta as never,
  );
  if (!rejected(() => proof.verify(row.id, identityProof.stepUpToken, PROOF_BASE_BINDING))) {
    violations.push({
      rule: 'proof-family-forgery',
      detail:
        '为 `PHONE_BIND`(身份绑定族)签的 proof **能当**配置变更 proof 用 —— 族隔离失效。' +
        '「刚刚做过一次二次验证」不是"这次角色权限集变更"的证明。',
    });
  }

  const configProof = await service.stepUpWithPassword(
    currentUser as never,
    {
      action: StepUpAction.RBAC_ROLE_PERMISSION_SET_REPLACE,
      password: PROBE_PASSWORD,
      rolePermissionSet: PROOF_BASE_BINDING,
    } as never,
    meta as never,
  );
  // 反方向:配置变更 proof 也不许拿去做身份绑定。
  if (
    !rejected(() =>
      service.verifyProof(configProof.stepUpToken, row, StepUpAction.PHONE_BIND),
    )
  ) {
    violations.push({
      rule: 'proof-family-forgery',
      detail:
        '配置变更 proof **能当**身份绑定 proof 用 —— 反方向的族隔离也失效了。' +
        '两族必须双向互斥,只挡一边等于没挡。',
    });
  }
  return violations;
}

// ============================================================================
// ② 之四:域中立层那个文件**只许装这一件事**(AST;窄但真的一条)
//
// 🔴 `src/common/security/role-permission-step-up-proof.ts` 落在域中立层是**可达性**的要求
//    (签发方在 identity-org、验签方在 platform-access,两个方向的 import 都过不了架构闸),
//    **不是**因为它是公共设施。它的语义归属仍然是 platform-access。
//
// ⚠️ **这条约束原本只是散文,而 `commonGovernance` 的五类检查覆盖不到它** —— 实测:
//    往那个文件里加一个与角色权限集无关的通用工具,业务表访问 / 业务谓词 / 模块 import 边 /
//    动态 raw SQL / kernel 事实读**一条都不会红**。⇒ 这里有一个真实(虽窄)的缺口。
//
// ⇒ 能做成机器形态的只有**导出面的命名**:每一个导出符号都必须属于这一件事。
//    ⚠️ **如实说清它挡不住什么**:它挡的是**漂移**(顺手把不相关的东西放进来),
//    挡不住**蓄意规避**(把不相关的东西命名成 `RolePermissionXxx`)。
//    也挡不住「另建 `src/common/security/foo.ts`」—— 那是新文件的归属问题,归 commonGovernance。
// ============================================================================

export const PROOF_FILE = 'src/common/security/role-permission-step-up-proof.ts';
/** 导出符号必须以此开头 —— 「这个文件只装角色权限集 step-up proof」的命名执行位。 */
export const PROOF_EXPORT_PREFIXES = ['ROLE_PERMISSION_', 'RolePermission'];
/** 导出面地板:低于它说明文件被掏空或改名,规则会退化成空集恒真。 */
export const MIN_PROOF_EXPORTS = 5;

export interface ProofExportFacts {
  readonly exported: readonly string[];
  readonly offenders: readonly string[];
}

export function proofExportFacts(): ProofExportFacts {
  const source = parse(PROOF_FILE);
  const exported: string[] = [];
  const collect = (name: string | undefined): void => {
    if (name !== undefined) exported.push(name);
  };
  const visit = (node: ts.Node): void => {
    const isExported = ts
      .getModifiers(node as ts.HasModifiers)
      ?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (isExported === true) {
      if (ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node)) collect(node.name?.text);
      if (ts.isTypeAliasDeclaration(node) || ts.isFunctionDeclaration(node)) {
        collect(node.name?.text);
      }
      if (ts.isVariableStatement(node)) {
        for (const decl of node.declarationList.declarations) {
          if (ts.isIdentifier(decl.name)) collect(decl.name.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
  return {
    exported: exported.sort(),
    offenders: exported
      .filter((name) => !PROOF_EXPORT_PREFIXES.some((prefix) => name.startsWith(prefix)))
      .sort(),
  };
}

export function checkProofFileSinglePurpose(facts: ProofExportFacts): Violation[] {
  const violations: Violation[] = [];
  if (facts.offenders.length > 0) {
    violations.push({
      rule: 'proof-file-single-purpose',
      detail:
        `${PROOF_FILE} 导出了与角色权限集 step-up proof 无关的符号:` +
        `${facts.offenders.join(' / ')} —— 那个文件落在域中立层是**可达性**的要求,` +
        '不是把它变成了公共设施。它的语义归属仍是 platform-access;' +
        '通用件请另找位置,别让这里长成杂物间。' +
        `(导出名须以 ${PROOF_EXPORT_PREFIXES.join(' / ')} 开头。)`,
    });
  }
  return violations;
}

// ============================================================================
// ② 之二:step-up 签发端点的**显式字段白名单**与 DTO 字段集必须相等(AST)
//
// 🔴 `auth.controller.ts` 三处 step-up handler 各写了一行
//    `const safeDto: StepUpXxxDto = { action: dto.action, ... };`
//    —— 那是**显式白名单**:DTO 新增字段没同步加进这一行就被**静默丢弃且零报错**。
//    本刀实测踩到过(proof 的绑定三元组差点被丢掉),而症状是"proof 永远对不上",
//    没人会往这一行上想。
// ⇒ 钉成不变量:两个集合逐一相等,多一个少一个都点名。
// ============================================================================

export const AUTH_CONTROLLER_FILE = 'src/modules/auth/auth.controller.ts';
export const AUTH_DTO_FILE = 'src/modules/auth/auth.dto.ts';
/** 三处 step-up handler ⇒ 至少三个 `safeDto` 白名单。少于它说明扫描面塌了。 */
export const MIN_SAFE_DTO_SITES = 3;

/**
 * proof 复用变异的条数地板 —— DoD 逐字三条(跨角色 / 跨 revision / 跨 payload)。
 * ⭐ 用地板而不是内联数字:薄运行器只许引这个名字,不许自己写 `3`
 * (否则改松判据只要在 spec 里把 3 改成 1,diff 一个字符)。
 */
export const MIN_PROOF_REUSE_MUTATIONS = 3;

export interface SafeDtoSite {
  readonly dtoName: string;
  readonly fields: readonly string[];
}

/** 现取 `const safeDto: X = { ... }` 的类型名与重构出来的字段集。 */
export function safeDtoSites(): SafeDtoSite[] {
  const source = parse(AUTH_CONTROLLER_FILE);
  const sites: SafeDtoSite[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'safeDto' &&
      node.type !== undefined &&
      ts.isTypeReferenceNode(node.type) &&
      ts.isIdentifier(node.type.typeName) &&
      node.initializer !== undefined &&
      ts.isObjectLiteralExpression(node.initializer)
    ) {
      sites.push({
        dtoName: node.type.typeName.text,
        fields: node.initializer.properties
          .map((prop) => (prop.name !== undefined && ts.isIdentifier(prop.name) ? prop.name.text : ''))
          .filter((name) => name.length > 0)
          .sort(),
      });
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
  return sites;
}

/** 现取 `auth.dto.ts` 里某个类声明的属性名。 */
export function dtoFields(className: string): string[] {
  const source = parse(AUTH_DTO_FILE);
  const fields: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node) && node.name?.text === className) {
      for (const member of node.members) {
        if (ts.isPropertyDeclaration(member) && ts.isIdentifier(member.name)) {
          fields.push(member.name.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
  return fields.sort();
}

export function checkStepUpDtoWhitelist(): Violation[] {
  const sites = safeDtoSites();
  const violations: Violation[] = [];
  if (sites.length < MIN_SAFE_DTO_SITES) {
    violations.push({
      rule: 'stepup-dto-whitelist',
      detail:
        `${AUTH_CONTROLLER_FILE} 里只扫到 ${sites.length} 处 \`const safeDto: X = {...}\`` +
        `(要 ${MIN_SAFE_DTO_SITES} 处)—— 扫描面塌了(变量改名 / 白名单被去掉),` +
        '而不是「没有不一致」。',
    });
    return violations;
  }
  for (const site of sites) {
    const declared = dtoFields(site.dtoName);
    if (declared.length === 0) {
      violations.push({
        rule: 'stepup-dto-whitelist',
        detail: `${AUTH_DTO_FILE} 里找不到 class ${site.dtoName} 的属性 —— 扫描面塌了。`,
      });
      continue;
    }
    const missing = declared.filter((f) => !site.fields.includes(f));
    const extra = site.fields.filter((f) => !declared.includes(f));
    if (missing.length > 0 || extra.length > 0) {
      violations.push({
        rule: 'stepup-dto-whitelist',
        detail:
          `${site.dtoName} 的显式白名单与 DTO 字段集不相等:白名单漏了 ` +
          `[${missing.join(' / ') || '—'}],多了 [${extra.join(' / ') || '—'}]。` +
          '🔴 漏掉的字段会被**静默丢弃且零报错** —— 症状是"这个字段怎么没生效",' +
          '而没人会往 controller 那一行重构上想。加字段时必须同步这一行。',
      });
    }
  }
  return violations;
}

// ============================================================================
// 报告 + 自证
// ============================================================================

export interface ImpactCriteriaReport {
  readonly impactViolations: readonly Violation[];
  readonly crossDomainViolations: readonly Violation[];
  readonly supervisionViolations: readonly Violation[];
  readonly riskViolations: readonly Violation[];
  readonly secondScaleViolations: readonly Violation[];
  readonly payloadHashViolations: readonly Violation[];
  readonly familyIsolationViolations: readonly Violation[];
  readonly proofFileViolations: readonly Violation[];
  readonly proofExports: ProofExportFacts;
  readonly jurisdictionViolations: readonly Violation[];
  readonly dtoWhitelistViolations: readonly Violation[];
  readonly safeDtoSiteCount: number;
  readonly risk: RiskReport;
  readonly jurisdiction: JurisdictionReport;
  readonly impactModels: ImpactModelFacts;
  readonly probeCount: number;
  readonly builtinRoleCount: number;
}

export function analyzeRolePermissionImpact(): ImpactCriteriaReport {
  const risk = analyzeRisk();
  const jurisdiction = analyzeJurisdiction();
  const impactModels = impactModelFacts();
  const proofExports = proofExportFacts();
  return {
    impactViolations: checkImpactHonesty(),
    crossDomainViolations: checkImpactCrossDomain(impactModels),
    supervisionViolations: checkSupervisionAnchor(),
    riskViolations: checkRisk(risk),
    secondScaleViolations: checkNoSecondRiskScale(),
    payloadHashViolations: checkPayloadHash(),
    familyIsolationViolations: checkProofFamilyIsolation(),
    proofFileViolations: checkProofFileSinglePurpose(proofExports),
    proofExports,
    jurisdictionViolations: checkJurisdiction(jurisdiction),
    dtoWhitelistViolations: checkStepUpDtoWhitelist(),
    safeDtoSiteCount: safeDtoSites().length,
    risk,
    jurisdiction,
    impactModels,
    probeCount: impactProbes().length,
    builtinRoleCount: PROTECTED_ROLE_CODES.length,
  };
}

/**
 * 自证 —— 先证明仪器没瞎,再报数。
 *
 * 「判据失去输入 ≠ 通过」:目录读空 / 高风险码或低风险码掉到 0 / 事实矩阵为空 /
 * 内建角色清单删空,四种形态都会让上面的断言退化成空集比空集。
 */
export function selfCheck(report: ImpactCriteriaReport): string[] {
  const problems: string[] = [];
  if (report.risk.catalogSize < MIN_CATALOG_ENTRIES) {
    problems.push(
      `权限目录只读到 ${report.risk.catalogSize} 条(地板 ${MIN_CATALOG_ENTRIES})—— ` +
        '风险判定要在全域上跑,目录读空就是仪器失效,不是「零违规」。',
    );
  }
  if (report.risk.triggering.length < MIN_TRIGGERING_CODES) {
    problems.push(
      `只有 ${report.risk.triggering.length} 条码触发二次验证(地板 ${MIN_TRIGGERING_CODES})—— ` +
        '判定多半被写成了恒 false,「高风险必须触发」那一向会全绿而毫无意义。',
    );
  }
  if (report.risk.nonTriggering.length < MIN_NON_TRIGGERING_CODES) {
    problems.push(
      `只有 ${report.risk.nonTriggering.length} 条码**不**触发二次验证` +
        `(地板 ${MIN_NON_TRIGGERING_CODES})—— 判定多半被写成了恒 true。` +
        '⭐ 这条就是 DoD 第三条「低风险不被无意义加重」的假阳性对照本体:' +
        '没有它,「三条不许复用」的变异用一句 `return true` 就能全部通过。',
    );
  }
  if (report.probeCount === 0) {
    problems.push('影响事实矩阵为空 ⇒ 「标 EXACT 必须精确」恒不命中。');
  }
  if (report.builtinRoleCount < BUILTIN_ROLE_FLOOR) {
    problems.push(
      `内建角色清单只有 ${report.builtinRoleCount} 条(地板 ${BUILTIN_ROLE_FLOOR})—— ` +
        'supervision 恒 0 的依据(该角色权限集只读)会在空集上恒真。',
    );
  }
  // `size()` 而不是直接 `.length === 0`:两个常量都是 `as const`,TS 把长度收窄成字面量类型,
  // 直接比较会被判成"不可能相等"而编译不过 —— 但清空数组恰恰是本条要发现的事。
  const size = (values: readonly unknown[]): number => values.length;
  if (size(PERMISSION_RISK_LEVELS) === 0 || size(STEP_UP_TRIGGERING_RISK_TAGS) === 0) {
    problems.push('风险等级或风险标签集合被读空 ⇒ 触发面判据退化成恒 false。');
  }
  if (report.impactModels.models.length < MIN_IMPACT_MODELS) {
    problems.push(
      `影响查询只碰到 ${report.impactModels.models.length} 个 Prisma 模型` +
        `(地板 ${MIN_IMPACT_MODELS})—— 扫描面塌了(查询被搬走 / 改名 / 换成 raw SQL),` +
        '「只读本域模型」会退化成空集恒真。',
    );
  }
  if (report.proofExports.exported.length < MIN_PROOF_EXPORTS) {
    problems.push(
      `域中立层那个 proof 文件只扫到 ${report.proofExports.exported.length} 个导出` +
        `(地板 ${MIN_PROOF_EXPORTS})—— 文件被掏空 / 改名,「只装这一件事」会退化成空集恒真。`,
    );
  }
  if (report.impactModels.ownedModelCount < MIN_OWNED_MODELS) {
    problems.push(
      `domain-map 的模型归属表只读到 ${report.impactModels.ownedModelCount} 条` +
        `(地板 ${MIN_OWNED_MODELS})—— 归属表读空会让「不属本域」判不出来。`,
    );
  }
  if (report.safeDtoSiteCount < MIN_SAFE_DTO_SITES) {
    problems.push(
      `step-up 显式白名单只扫到 ${report.safeDtoSiteCount} 处(地板 ${MIN_SAFE_DTO_SITES})—— ` +
        '「白名单与 DTO 字段集相等」会退化成空集比空集。',
    );
  }
  if (PROOF_REUSE_MUTATIONS.length < MIN_PROOF_REUSE_MUTATIONS) {
    problems.push(
      `proof 复用变异只有 ${PROOF_REUSE_MUTATIONS.length} 条 —— ` +
        'DoD 逐字要求「不能跨角色 / 跨 revision / 跨 payload 复用」三条,' +
        '**三条各自单独变异**,用一条代替三条就是「上层边界遮蔽下层边界」。',
    );
  }
  return problems;
}

// ============================================================================
// CLI
// ============================================================================

async function main(): Promise<void> {
  const report = analyzeRolePermissionImpact();
  const proofViolations = await checkStepUpProofReuse();
  const forgeryViolations = await checkProofFamilyForgery();
  const problems = selfCheck(report);
  for (const problem of problems) console.error(`🔴 自证失败:${problem}`);

  console.log(
    `扫描面:目录 ${report.risk.catalogSize} 条(高风险 ${report.risk.triggering.length} / ` +
      `低风险 ${report.risk.nonTriggering.length})/ 影响事实矩阵 ${report.probeCount} 组 / ` +
      `内建角色 ${report.builtinRoleCount} 个`,
  );
  console.log(
    `  影响查询碰到的模型(${report.impactModels.models.length} 个,归属表 ` +
      `${report.impactModels.ownedModelCount} 条):${report.impactModels.models.join(' · ')} ` +
      `⇒ 越界 ${report.impactModels.foreign.length} 个`,
  );
  console.log(
    `  step-up 射程:管辖 [${Object.entries(report.jurisdiction.inScopeReach)
      .filter(([, v]) => v)
      .map(([k]) => k)
      .join(' · ')}] / 不管辖 [${STEP_UP_OUT_OF_SCOPE_ENTRIES.join(' · ')}]`,
  );
  console.log(
    `  step-up proof 变异:${PROOF_REUSE_MUTATIONS.map((m) => m.dimension).join(' · ')}` +
      `(各自单独变异,+1 条正向对照)/ 显式白名单 ${report.safeDtoSiteCount} 处`,
  );

  const buckets: [string, readonly Violation[]][] = [
    ['影响标注说谎', report.impactViolations],
    ['影响查询越过域边界', report.crossDomainViolations],
    ['分管源锚点漂移', report.supervisionViolations],
    ['风险触发面两向不成立', report.riskViolations],
    ['策略文件里出现第二份分级', report.secondScaleViolations],
    ['payload 指纹性质不成立', report.payloadHashViolations],
    ['step-up proof 可以跨维度复用', proofViolations],
    ['两族 proof 可以互相冒充', [...report.familyIsolationViolations, ...forgeryViolations]],
    ['域中立层那个文件长成了杂物间', report.proofFileViolations],
    ['step-up 签发白名单与 DTO 字段集不符', report.dtoWhitelistViolations],
    ['step-up 射程与登记不符', report.jurisdictionViolations],
  ];

  let broken = problems.length;
  for (const [label, violations] of buckets) {
    if (violations.length === 0) continue;
    broken += violations.length;
    console.error(`🔴 ${label}:`);
    for (const v of violations) console.error(`   - [${v.rule}] ${v.detail}`);
  }

  if (broken === 0) {
    console.log(
      '✓ 影响标注不说谎(标 EXACT 即精确、零跨域)· step-up proof 三条维度各自不可复用 · ' +
        '两族 proof 互不冒充 · 高风险触发面两向成立(低风险不加重)· 射程与登记一致。',
    );
  }
  process.exit(broken === 0 ? 0 : 1);
}

if (require.main === module) {
  void main();
}
