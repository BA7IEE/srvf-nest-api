/**
 * check-sms-sent-semantics.ts —— 「`SmsSendStatus.SENT` 是**提交态**不是**送达态**」类闸。
 *
 * ⚠️ 本文件在 `harness/redzone.json` 的 selfGuard 内(`scripts/check-*.ts`)。
 *    这不是巧合 —— 判据的价值就在于**改松它很麻烦**。`src/**\/*.criteria.spec.ts`
 *    不在 selfGuard,任何 PR 都能顺手把 spec 改成恒绿;所以实质逻辑必须住在这里,
 *    spec 侧只留薄运行器(`src/modules/sms/sms-sent-semantics.criteria.spec.ts`)。
 *
 * ──────────────────────────────────────────────────────────────────────────
 * 立项理由:零故障,但**运营会误判**(P2-10 项 1,2026-08-24)
 *
 * 维护者 2026-08-20 真机实测拿到的反例:
 *
 *   | 系统侧留痕                                                      | 腾讯云控制台                                   |
 *   | `status=SENT` · `providerMsgId` 非空 · `errCode/errMsg = null` | 提交**成功** / 送达**失败** / 运营商免打扰名单 |
 *
 *   **手机始终没收到。** 换第二个号码后正常收到 ⇒ 链路没问题,问题在**状态语义**。
 *
 * `SmsSendStatus` 只有 `SENT` / `FAILED` 两态,全仓**无任何送达回执 / 状态回调链路** ——
 * `SENT` 只覆盖到「腾讯云受理了 SendSms 请求」那一段。而当时面向人的描述只写「发送状态」,
 * 没说清它是提交态 ⇒ 运营照字面读成「已经发到用户手机上了」。
 *
 * ──────────────────────────────────────────────────────────────────────────
 * 本闸钉两件事(缺一不可)
 *
 * ① **免责说明还在**:每一处**面向人**描述该状态的地方,都必须同时讲清三层语义 ——
 *    「已提交」+ 否定词 +「送达」。见 `DISCLAIMER_ANCHOR_GROUPS`。
 *    ⇒ 防「后人顺手改回『发送状态』」与「新加一处描述却漏了这句」。
 *
 * ② ⭐ **枚举仍是两态**:`SmsSendStatus` 一旦出现第三态(`DELIVERED` /
 *    `DELIVERY_FAILED` / `SUBMITTED`),本闸**当场红**。
 *    这条不是为了阻止项 2,恰恰相反 —— 项 2(三态细化 + 腾讯云回调)落地那天,
 *    这些免责说明**全部需要重写**(那时 `SENT` 不再是「唯一的成功态」)。
 *    ⇒ 这条红是**提醒**:回来重看这份文案,别把过期的免责说明留在 API 契约里。
 *    失败信息里写明了该怎么做,不需要读本文件。
 *
 * ──────────────────────────────────────────────────────────────────────────
 * 为什么不逐字匹配一整句中文
 *
 * 逐字匹配「改个标点就红」,而假红会诱导人把闸删掉。这里改用**三组短锚点**:
 * 每组给若干等价写法,**三组必须同时命中**。任何一层语义被删掉都会红,
 * 而改写措辞 / 加粗 / 换标点不会。
 *
 * ──────────────────────────────────────────────────────────────────────────
 * 明确**不**管辖的两处(免得后人以为是漏了)
 *
 * - 企微侧的 `SENT`(`NotificationDelivery.status='sent'`)是**另一个枚举、另一条域**,
 *   且 `docs/ops/wecom-message-channel-rollout.md` 已自带「SENT ≠ 已读,也 ≠ 已送达」。
 * - `prisma/schema.prisma` 的 `enum SmsSendStatus` **本身零注释** —— 它不是「描述了
 *   这个状态的地方」,是沉默处;且它是 D 档不可逆红区。本闸只**读**它(数成员),不要求它写注释。
 */
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';

import * as ts from 'typescript';

const ROOT = path.resolve(__dirname, '..');

// ============================================================================
// 口径:锚点与登记表
// ============================================================================

/** 本判据自身的路径 —— 失败信息里直接指路,免得人去翻 CI 配置找是谁红的。 */
export const JUDGE_FILE = 'scripts/check-sms-sent-semantics.ts';

/** 枚举的事实源(只读;本闸不要求改它)。 */
export const SCHEMA_FILE = 'prisma/schema.prisma';

/** 被钉住的枚举名。 */
export const ENUM_NAME = 'SmsSendStatus';

/**
 * 冻结的成员集合。**顺序敏感**(prisma 里的声明序即对外序)。
 * 出现第三态 ⇒ `enum-arity` 红 ⇒ 逼人回来重看全部免责说明。
 */
export const EXPECTED_ENUM_MEMBERS = ['SENT', 'FAILED'];

export interface AnchorGroup {
  /** 组名 —— 失败信息里报的就是它,人一眼知道缺了哪一层语义。 */
  name: string;
  /** 等价写法;命中任意一个即算该组满足。 */
  tokens: string[];
}

/**
 * 免责说明的三层语义。**三组必须同时命中**,单组命中不算。
 *
 * - `submitted`:说清 `SENT` 到底走到哪一步了。只收「已提交」一种写法 ——
 *   这是本刀统一的口径词,不给同义词是**刻意**的(否则「已发送」也能过,而
 *   「已发送」正是当初造成误判的那个说法)。
 * - `negation`:否定词有多种自然写法,并列进同一组是刻意的 —— 本闸要管的是
 *   「三层语义都在」,不是「用了哪个否定词」。
 * - `delivery`:说清**没**走到哪一步。「送达」是运营与腾讯云控制台的共同用词。
 *
 * 三组同时命中的组合非常特异,单个常用否定词偶然出现不足以放行。
 */
export const DISCLAIMER_ANCHOR_GROUPS: AnchorGroup[] = [
  { name: 'submitted', tokens: ['已提交'] },
  { name: 'negation', tokens: ['不代表', '不等于', '不是', '≠'] },
  { name: 'delivery', tokens: ['送达'] },
];

export interface DtoSite {
  file: string;
  className: string;
  property: string;
  /** 为什么这处要钉 —— 失败信息直接带出去。 */
  why: string;
}

/**
 * 面向人的 DTO 描述(typed-AST 定位,不用正则)。
 * 这是**对外契约**上的文案:Swagger UI、`docs/handoff/openapi.json`、生成的前端 client
 * 全部由它派生 ⇒ 改这一处就等于同时改了四份生成物。
 */
export const DTO_SITES: DtoSite[] = [
  {
    file: 'src/modules/sms/sms.dto.ts',
    className: 'SmsSendLogResponseDto',
    property: 'status',
    why: '短信发送日志列表的出参字段 —— 运营在后台看到的就是它',
  },
  {
    file: 'src/modules/sms/sms.dto.ts',
    className: 'SmsSendLogQueryDto',
    property: 'status',
    why: '按状态筛选的入参 —— 筛 SENT 得到的是「提交成功」的流水,不是「用户收到了」的流水',
  },
];

export interface DocSite {
  file: string;
  /**
   * 定位锚:文件里**唯一**能标出这段话在哪的稳定子串。
   * 用锚 + 窗口而不是全文搜索 —— 全文搜索会被文件里别处偶然出现的同名词汇喂成假绿。
   */
  lineAnchor: string;
  why: string;
}

/**
 * 面向人的文档 / 运维手册 / 前端交接说明。
 *
 * ⚠️ 只改 DTO 就是**修实例不修类** —— 运营看的是后台页面,值班的人看的是 runbook,
 * 两者都不读 Swagger。所以这三处必须一起钉。
 */
export const DOC_SITES: DocSite[] = [
  {
    file: 'docs/handoff/admin-web.md',
    lineAnchor: '`system/v1/sms-send-logs`',
    why: '后台「短信日志」页的前端页面规格 —— **后台 UI 文案的出处**,只改 DTO 会漏掉它',
  },
  {
    file: 'docs/ops/sms-production-rollout-checklist.md',
    lineAnchor: '期望:status=SENT',
    why: '上线验收清单第 4 步 —— 照单打勾的人会把 status=SENT 当作「发成功了」',
  },
  {
    file: 'docs/ops/sms-closed-loop-test.md',
    lineAnchor: '请先读 §6.5',
    why: '实证反例的出处(§6.5)。本闸只**读**不改 —— 它是这条口径的证据来源,删掉即红',
  },
];

/**
 * 文档锚点的判定窗口:锚点行 + 其后 N 行。
 *
 * 为什么要窗口而不是「必须同一行」:markdown 表格行天然一行写完,而代码块 / 引用块里
 * 的说明天然写在下一行。窗口取小值,免得把隔壁段落的用词算进来。
 */
export const DOC_ANCHOR_WINDOW = 2;

/**
 * 登记表规模地板。低于它说明有人把站点删了 / 登记表被清空,
 * 而不是「仓库真的只剩这么几处」。用地板(≥N)而非「恰 N 条」——
 * 后者每加一处都要改数字,那份摩擦会诱导人把数字调小了事。
 */
export const MIN_PINNED_SITES = 5;

// ============================================================================
// 结论形状
// ============================================================================

export interface Finding {
  /** 站点标识(file#class.prop 或 file@anchor)。 */
  site: string;
  /** 规则名(稳定标识,变异对拍按它比对)。 */
  rule: string;
  detail: string;
}

export interface Report {
  /** 实际纳管的站点标识(已排序)。 */
  pinnedSites: string[];
  /** 从 schema 读到的枚举成员;解析不到为 null。 */
  enumMembers: string[] | null;
  /** 每个站点解析到的待判文本;解析不到为 null(=仪器问题,由 selfCheck 报)。 */
  resolved: { site: string; text: string | null }[];
  /** 实质违规。空数组 = 口径完好。 */
  findings: Finding[];
}

// ============================================================================
// 纯判定:每个函数都吃文本、吐结论 —— 便于变异对拍与永久对照
// ============================================================================

/** 返回**没有**命中的锚点组名(空数组 = 三层语义齐全)。 */
export function missingAnchorGroups(text: string): string[] {
  return DISCLAIMER_ANCHOR_GROUPS.filter(
    (group) => !group.tokens.some((token) => text.includes(token)),
  ).map((group) => group.name);
}

/**
 * 从 prisma schema 文本里读出某个 enum 的成员(声明序)。
 * 解析不到返回 null —— **不返回空数组**:空数组会与「枚举被清空」混淆,
 * 而「解析器坏了」必须与「枚举真的变了」区分开(前者是仪器问题,后者是违规)。
 */
export function parseEnumMembers(schemaText: string, enumName: string = ENUM_NAME): string[] | null {
  const lines = schemaText.split('\n');
  const header = `enum ${enumName} {`;
  const start = lines.findIndex((line) => line.trim() === header);
  if (start < 0) return null;

  const members: string[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const raw = lines[i].trim();
    if (raw === '}') return members;
    if (raw === '' || raw.startsWith('//')) continue;
    // 成员行形如 `SENT` 或 `SENT // 注释`;取第一个 token。
    const token = raw.split(/[\s/]+/)[0];
    if (token !== '') members.push(token);
  }
  // 没读到收尾的 `}` ⇒ 结构不是预期的,当作解析失败。
  return null;
}

/** 把字符串字面量 / 模板字面量 / `+` 拼接折成一个字符串;折不动返回 null。 */
function foldStringish(node: ts.Expression): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = foldStringish(node.left);
    const right = foldStringish(node.right);
    return left === null || right === null ? null : left + right;
  }
  return null;
}

function decoratorCallee(decorator: ts.Decorator): ts.Expression {
  return ts.isCallExpression(decorator.expression) ? decorator.expression.expression : decorator.expression;
}

/** Swagger 文档装饰器 —— 描述文案只可能挂在这两个上。 */
export const API_PROPERTY_DECORATORS = ['ApiProperty', 'ApiPropertyOptional'];

/**
 * typed-AST 读出 `@ApiProperty({ description })` 的描述文案。
 * 类找不到 / 属性找不到 / 装饰器没有 description ⇒ 返回 null(仪器问题,不是「描述为空」)。
 */
export function readApiPropertyDescription(
  sourceText: string,
  fileName: string,
  className: string,
  property: string,
): string | null {
  const source = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true);
  let found: string | null = null;

  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node) && node.name?.text === className) {
      for (const member of node.members) {
        if (!ts.isPropertyDeclaration(member)) continue;
        if (!ts.isIdentifier(member.name) || member.name.text !== property) continue;
        for (const decorator of ts.getDecorators(member) ?? []) {
          const callee = decoratorCallee(decorator);
          if (!ts.isIdentifier(callee) || !API_PROPERTY_DECORATORS.includes(callee.text)) continue;
          if (!ts.isCallExpression(decorator.expression)) continue;
          const [arg] = decorator.expression.arguments;
          if (arg === undefined || !ts.isObjectLiteralExpression(arg)) continue;
          for (const prop of arg.properties) {
            if (!ts.isPropertyAssignment(prop)) continue;
            if (!ts.isIdentifier(prop.name) || prop.name.text !== 'description') continue;
            found = foldStringish(prop.initializer);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(source);
  return found;
}

/**
 * 取锚点行 + 其后 `DOC_ANCHOR_WINDOW` 行拼成待判文本。
 * 锚点找不到返回 null(仪器问题:说明那段话被整段搬走或改写了标题)。
 */
export function windowAround(
  fileText: string,
  lineAnchor: string,
  window: number = DOC_ANCHOR_WINDOW,
): string | null {
  const lines = fileText.split('\n');
  const at = lines.findIndex((line) => line.includes(lineAnchor));
  if (at < 0) return null;
  return lines.slice(at, at + window + 1).join('\n');
}

// ============================================================================
// 组装
// ============================================================================

function dtoSiteId(site: DtoSite): string {
  return `${site.file}#${site.className}.${site.property}`;
}

function docSiteId(site: DocSite): string {
  return `${site.file}@${site.lineAnchor}`;
}

export function analyzeSmsSentSemantics(root: string = ROOT): Report {
  const resolved: { site: string; text: string | null }[] = [];
  const findings: Finding[] = [];

  // ── ① 枚举仍是两态 ───────────────────────────────────────────────────
  const schemaPath = path.join(root, SCHEMA_FILE);
  const enumMembers = existsSync(schemaPath)
    ? parseEnumMembers(readFileSync(schemaPath, 'utf8'))
    : null;

  if (enumMembers !== null && enumMembers.join(',') !== EXPECTED_ENUM_MEMBERS.join(',')) {
    findings.push({
      site: `${SCHEMA_FILE}#enum ${ENUM_NAME}`,
      rule: 'enum-arity',
      detail:
        `${ENUM_NAME} 现在是 [${enumMembers.join(', ')}],冻结值是 [${EXPECTED_ENUM_MEMBERS.join(', ')}]。` +
        '这条红**不是**要拦住状态细化 —— 恰恰相反:多了送达态之后,' +
        '仓内那几处「SENT = 已提交 Provider,不代表终端已送达」的免责说明**全部过期**,' +
        `必须逐处重写(登记表见 ${JUDGE_FILE} 的 DTO_SITES / DOC_SITES),` +
        '再把本文件的 EXPECTED_ENUM_MEMBERS 与锚点口径一起更新。别只改这一行数字。',
    });
  }

  // ── ② 每处面向人的描述都带免责说明 ───────────────────────────────────
  for (const site of DTO_SITES) {
    const id = dtoSiteId(site);
    const filePath = path.join(root, site.file);
    const text = existsSync(filePath)
      ? readApiPropertyDescription(readFileSync(filePath, 'utf8'), site.file, site.className, site.property)
      : null;
    resolved.push({ site: id, text });
    if (text === null) continue;

    const missing = missingAnchorGroups(text);
    if (missing.length > 0) {
      findings.push({
        site: id,
        rule: 'missing-disclaimer',
        detail:
          `@ApiProperty 描述缺了 [${missing.join(', ')}] 这几层语义。${site.why}。` +
          '写成「`SENT` = 已提交 Provider,不代表终端已送达」即可 —— ' +
          '措辞可改、标点可改,但「已提交」/ 否定词 /「送达」三层必须都在。',
      });
    }
  }

  for (const site of DOC_SITES) {
    const id = docSiteId(site);
    const filePath = path.join(root, site.file);
    const text = existsSync(filePath)
      ? windowAround(readFileSync(filePath, 'utf8'), site.lineAnchor)
      : null;
    resolved.push({ site: id, text });
    if (text === null) continue;

    const missing = missingAnchorGroups(text);
    if (missing.length > 0) {
      findings.push({
        site: id,
        rule: 'missing-disclaimer',
        detail:
          `锚点「${site.lineAnchor}」起 ${DOC_ANCHOR_WINDOW + 1} 行内缺了 [${missing.join(', ')}] 这几层语义。${site.why}。` +
          '把「SENT = 已提交 Provider,不代表终端已送达」补回锚点行或紧随其后的一两行。',
      });
    }
  }

  return {
    pinnedSites: resolved.map((entry) => entry.site).sort(),
    enumMembers,
    resolved,
    findings: findings.sort((a, b) => a.site.localeCompare(b.site) || a.rule.localeCompare(b.rule)),
  };
}

// ============================================================================
// 自证:先证明仪器没瞎,再报数
//
// 「站点解析不到 ⇒ 零违规 ⇒ 全绿」是本仓已登记的假绿形状(事实源被饿死)。
// 这里把它单独拎成一组断言:任何一处解析失败都算**仪器红**,与「口径被改回去」
// 分开报 —— 两者的下一步动作不同(前者修判据,后者补文案)。
// ============================================================================

export function selfCheck(report: Report): string[] {
  const problems: string[] = [];

  if (report.enumMembers === null) {
    problems.push(
      `解析不到 ${SCHEMA_FILE} 里的 \`enum ${ENUM_NAME}\` —— 枚举被改名 / 搬走 / 结构变了。` +
        '本闸的第二条(「仍是两态」)在这种状态下**恒绿**,必须先修解析。',
    );
  }

  for (const entry of report.resolved) {
    if (entry.text === null) {
      problems.push(
        `站点 ${entry.site} 解析不到待判文本 —— 类 / 属性 / 装饰器 / 文档锚点被改名或搬走。` +
          '这一处此刻**不受任何保护**,先把登记表更新到与仓库实况一致。',
      );
    }
  }

  if (report.pinnedSites.length < MIN_PINNED_SITES) {
    problems.push(
      `纳管站点只剩 ${report.pinnedSites.length} 处,低于地板 ${MIN_PINNED_SITES} —— 登记表被删过。`,
    );
  }

  return problems;
}

// ============================================================================
// 对照:假阳性 / 真阳性各一组
//
// 假阳性对照是本闸**可用性的前提**:它若把正确形态也判成违规,人只会把闸关掉。
// 真阳性对照是本闸「未来唯一要干的活」的样本 —— 尤其是第三态那条:
// 它让「加了 DELIVERED 就必须回来重看文案」这件事**每次 CI 都被验一遍**,
// 而不是只在交付当天由某个人手动对拍过一次。
// ============================================================================

/** 假阳性对照:当前形态的 schema 片段 —— 必须判绿。 */
export const CONTROL_SCHEMA_TWO_STATES = ['enum SmsSendStatus {', '  SENT', '  FAILED', '}'].join(
  '\n',
);

/** 真阳性对照:项 2(状态细化)落地后的形态 —— 必须判红。 */
export const CONTROL_SCHEMA_THIRD_STATE = [
  'enum SmsSendStatus {',
  '  SENT',
  '  FAILED',
  '  DELIVERED',
  '}',
].join('\n');

/** 假阳性对照:带完整免责说明的描述 —— 三组锚点全中,必须判绿。 */
export const CONTROL_DESCRIPTION_WITH_DISCLAIMER =
  '发送状态。⚠️ `SENT` = **已提交 Provider**,**不代表**终端已送达';

/**
 * 假阳性对照之二:**换了一套措辞与标点**的等价写法 —— 也必须判绿。
 * 它守的是「判据没写死到某一句话上」这条可用性要求。
 */
export const CONTROL_DESCRIPTION_REWORDED =
  '流水状态;这里的 SENT 表示请求已提交给腾讯云、并不等于用户手机送达成功';

/** 真阳性对照:被改回去的原始描述 —— 三组全落空,必须判红。 */
export const CONTROL_DESCRIPTION_WITHOUT_DISCLAIMER = '发送状态';

/** 真阳性对照之二:只说了一半(有「已提交」,没说「不代表送达」)—— 仍须判红。 */
export const CONTROL_DESCRIPTION_HALF = '发送状态;SENT 表示已提交 Provider';

// ============================================================================
// CLI:`tsx scripts/check-sms-sent-semantics.ts [--root <dir>]`
//
// spec 是常跑通道;这个入口只为**变异对拍**存在 —— 它能把判据指到一份镜像根上,
// 从而在不写 `prisma/schema.prisma`(D 档红区)的前提下,走通「第三态落盘 ⇒ 红」
// 的完整读盘 + 解析 + 判定链路。
// ============================================================================

function main(argv: string[]): number {
  const flag = argv.indexOf('--root');
  const report = analyzeSmsSentSemantics(flag < 0 ? ROOT : path.resolve(argv[flag + 1]));
  const problems = selfCheck(report);

  console.log(`enum ${ENUM_NAME} = [${(report.enumMembers ?? ['<解析失败>']).join(', ')}]`);
  console.log(`纳管站点 ${report.pinnedSites.length} 处(地板 ${MIN_PINNED_SITES})`);

  for (const problem of problems) console.log(`✗ 仪器 ${problem}`);
  for (const finding of report.findings) console.log(`✗ ${finding.rule} ${finding.site}\n  ${finding.detail}`);

  const failed = problems.length + report.findings.length;
  console.log(failed === 0 ? '✅ SENT 语义口径完好' : `❌ ${failed} 条`);
  return failed === 0 ? 0 : 1;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
