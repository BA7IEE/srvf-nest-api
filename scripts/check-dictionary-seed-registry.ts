import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import * as ts from 'typescript';

import {
  MEMBER_ORIGIN_DICT_TYPE,
  MEMBER_ORIGIN_IMPORT,
  MEMBER_ORIGIN_MANUAL,
  MEMBER_ORIGIN_RECRUITMENT,
} from '../src/common/identity/member-origin.constant';

/**
 * 字典 seed 登记表(`docs/ai-harness/DICTIONARY_SEED_REGISTRY.md`)的双向对拍判据 —— P2-23 字典半。
 *
 * ─── 这条闸修的是哪一类缺陷 ────────────────────────────────────────────────
 * 合同 ④ 要求「字典…生成并对账」,而机器侧此前只有 `seed-sha256-12`(整份 seed 的摘要):
 * 它证明「你签字时看的那份 seed 还是这一份」,证明不了**里面有哪些字典项**。
 * 新增 / 删除一个字典项不会让任何读数动一下 —— ④-b 的签字只能写「接受现状」。
 * 本表 + 本判据把那一半变成:逐条点名、双向集合相等、CI 红。
 *
 * ─── 为什么读 AST,不 grep、不 import ─────────────────────────────────────
 * 字典项在 seed 里是**数据字面量**:grep 会把注释与示例一起吃进来;
 * import 只看得见已导出的 V2_DICT_SEED,而 activity_type 层级与招新进度态
 * 的数据住在函数体内的未导出数组里 —— 只有 AST 能做**全量普查**。
 * 提取器读不了的东西(新标识符 / 非字面量)一律当缺陷红,方向 fail-closed。
 *
 * ─── 形态(2026-08-27 收编)─────────────────────────────────────────────────
 * 本文件是判据本体,住 selfGuard 红区(`scripts/check-*.ts`)—— 改松判据必须过人闸;
 * `src/modules/dictionaries/seed-dictionary-registry.spec.ts` 是**薄运行器**
 * (真读数 + 常驻变异对拍),不承载实质逻辑。P2-23a 首发时的零红区形态
 * (逻辑留 spec)随维护者 2026-08-27 令牌收编升级 —— 详见 NEXT_TASKS P2-23a 形态取舍。
 *
 * ─── 仪器纪律 ──────────────────────────────────────────────────────────────
 * 薄运行器每次执行都带常驻变异对拍(M1–M6):六维判决函数是纯函数,变异在内存里
 * 喂假输入,断言**红集精确**(只红目标维、其余五维全绿)—— 判据没判别力
 * 会被当场抓到,而不是等真事故才发现。
 */

/** seed.ts 里**允许**出现 dictType/dictItem upsert 的函数,及各函数的站点数(改 seed 布局 ⇒ 同步改)。 */
const EXPECTED_SITES: Readonly<Record<string, { dictType: number; dictItem: number }>> = {
  seedV2Dictionaries: { dictType: 1, dictItem: 1 },
  seedActivityTypeHierarchy: { dictType: 1, dictItem: 2 },
  seedRecruitmentStageDict: { dictType: 1, dictItem: 1 },
};

// ─── 提取器(纯函数;输入 = seed.ts 源码文本)────────────────────────────────

interface ExtractorConfig {
  /** 平铺字典数组:条目自带 type + items。 */
  readonly flatArrays: readonly string[];
  /** 层级/单类型字典:type 来自该函数 dictType.upsert 的 create 字面量,items 来自具名数组。 */
  readonly siteTyped: readonly { fn: string; typeCode: string; arrays: readonly string[] }[];
}

/** 真源配置(改 seed 的字典布局 ⇒ 同步改这里 + 登记表)。 */
const REAL_CONFIG: ExtractorConfig = {
  flatArrays: ['V2_DICT_SEED'],
  siteTyped: [
    { fn: 'seedActivityTypeHierarchy', typeCode: 'activity_type', arrays: ['parents', 'children'] },
    {
      fn: 'seedRecruitmentStageDict',
      typeCode: 'recruitment_stage',
      arrays: ['RECRUITMENT_STAGE_SEED'],
    },
  ],
};

/**
 * 字典数组里允许出现的**标识符**绑定(活 import,常量改值判据跟着走)。
 * 🔴 出现闭集外的标识符 ⇒ 缺陷(fail-closed):新外部化的常量必须来这里登记,
 * 否则提取器读不了的那一项会静默失踪。
 */
const IDENTIFIER_BINDINGS: Readonly<Record<string, unknown>> = {
  MEMBER_ORIGIN_DICT_TYPE,
  MEMBER_ORIGIN_RECRUITMENT,
  MEMBER_ORIGIN_MANUAL,
  MEMBER_ORIGIN_IMPORT,
};

export const DICT_REGISTRY_PATH = 'docs/ai-harness/DICTIONARY_SEED_REGISTRY.md';
export const DICT_SEED_PATH = 'prisma/seed.ts';
const DECLARATION_RE = /^\*\*字典 type\(机器核对\):(\d+) 个 · item\(机器核对\):(\d+) 项\*\*$/;
const EMPTY_MARKER_RE = /^>\s*seed 不预置/;
const TYPE_HEADER_RE = /^## ([a-z][a-z0-9_]*) — (.+)$/;
const ITEM_CODE_RE = /^[a-z0-9_-]+$/;

interface DictItem {
  readonly code: string;
  readonly label: string;
}
interface DictType {
  readonly label: string;
  readonly items: readonly DictItem[];
}
interface UpsertSite {
  readonly model: 'dictType' | 'dictItem';
  readonly fn: string;
  /** dictItem 站点的 create.code 是否为字面量(= 提取器结构性失明)。null = 形状读不出。 */
  readonly itemCodeLiteral: boolean | null;
}
interface SeedExtraction {
  readonly types: ReadonlyMap<string, DictType>;
  readonly sites: readonly UpsertSite[];
  readonly defects: readonly string[];
}

function unwrap(node: ts.Expression): ts.Expression {
  let cur = node;
  while (
    ts.isAsExpression(cur) ||
    ts.isParenthesizedExpression(cur) ||
    ts.isTypeAssertionExpression(cur) ||
    ts.isSatisfiesExpression(cur)
  ) {
    cur = cur.expression;
  }
  return cur;
}

/** 把字面量 AST 求值成 JS 值;读不了的形态记缺陷而不是抛(采集与判定分离)。 */
function evalLiteral(
  node: ts.Node,
  sf: ts.SourceFile,
  bindings: Readonly<Record<string, unknown>>,
  defects: string[],
): unknown {
  const at = `L${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
  if (ts.isStringLiteral(node) || ts.isNumericLiteral(node)) return node.text;
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  const u = unwrap(node as ts.Expression);
  if (u !== node) return evalLiteral(u, sf, bindings, defects);
  if (ts.isArrayLiteralExpression(u))
    return u.elements.map((e) => evalLiteral(e, sf, bindings, defects));
  if (ts.isObjectLiteralExpression(u)) {
    const o: Record<string, unknown> = {};
    for (const p of u.properties) {
      if (ts.isPropertyAssignment(p))
        o[p.name.getText(sf)] = evalLiteral(p.initializer, sf, bindings, defects);
    }
    return o;
  }
  if (ts.isIdentifier(node)) {
    if (!(node.text in bindings)) {
      defects.push(
        `字典数组里出现未绑定的标识符 '${node.text}'(${at})⇒ 提取器读不了,先在 IDENTIFIER_BINDINGS 登记它`,
      );
      return undefined;
    }
    return bindings[node.text];
  }
  defects.push(
    `字典数组里有非字面量节点(${at},${ts.SyntaxKind[node.kind]})⇒ 提取器读不了,fail-closed`,
  );
  return undefined;
}

/** 全文件查找具名 const 数组;恰好一处才是可定位的,零处 / 多处都记缺陷。 */
function findConstArray(
  sf: ts.SourceFile,
  name: string,
  defects: string[],
): ts.ArrayLiteralExpression | null {
  const hits: ts.ArrayLiteralExpression[] = [];
  (function visit(node: ts.Node): void {
    if (ts.isVariableStatement(node)) {
      for (const d of node.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.name.text === name && d.initializer) {
          const u = unwrap(d.initializer);
          if (ts.isArrayLiteralExpression(u)) hits.push(u);
        }
      }
    }
    ts.forEachChild(node, visit);
  })(sf);
  if (hits.length === 0) {
    defects.push(`seed.ts 里找不到 const ${name} 数组 ⇒ 字典提取失去输入`);
    return null;
  }
  if (hits.length > 1) {
    defects.push(`seed.ts 里 const ${name} 有 ${hits.length} 处 ⇒ 提取器无法定位唯一真源`);
    return null;
  }
  return hits[0];
}

export function extractSeedDictionaries(
  source: string,
  bindings: Readonly<Record<string, unknown>>,
  config: ExtractorConfig = REAL_CONFIG,
): SeedExtraction {
  const defects: string[] = [];
  const sf = ts.createSourceFile('seed.ts', source, ts.ScriptTarget.Latest, true);
  const types = new Map<string, DictType>();
  const sites: UpsertSite[] = [];

  const enclosingFn = (node: ts.Node): string => {
    let cur: ts.Node = node;
    while (cur !== sf) {
      if (ts.isFunctionDeclaration(cur) && cur.name) return cur.name.text;
      if (ts.isMethodDeclaration(cur) && cur.name) return cur.name.getText(sf);
      cur = cur.parent;
    }
    return '(top)';
  };
  const createCodeLiteral = (call: ts.CallExpression): boolean | null => {
    const arg = call.arguments[0];
    if (arg === undefined || !ts.isObjectLiteralExpression(arg)) return null;
    const create = arg.properties.find(
      (p): p is ts.PropertyAssignment =>
        ts.isPropertyAssignment(p) && p.name.getText(sf) === 'create',
    );
    if (create === undefined || !ts.isObjectLiteralExpression(create.initializer)) return null;
    const code = create.initializer.properties.find(
      (p): p is ts.PropertyAssignment =>
        ts.isPropertyAssignment(p) && p.name.getText(sf) === 'code',
    );
    if (code === undefined) return null;
    return ts.isStringLiteral(unwrap(code.initializer));
  };
  (function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const e = node.expression;
      if (ts.isPropertyAccessExpression(e) && e.name.text === 'upsert') {
        const obj = e.expression;
        if (
          ts.isPropertyAccessExpression(obj) &&
          (obj.name.text === 'dictType' || obj.name.text === 'dictItem')
        ) {
          sites.push({
            model: obj.name.text,
            fn: enclosingFn(node),
            itemCodeLiteral: obj.name.text === 'dictItem' ? createCodeLiteral(node) : null,
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  })(sf);

  // 平铺字典(V2_DICT_SEED):条目自带 type + items。
  for (const arrName of config.flatArrays) {
    const arr = findConstArray(sf, arrName, defects);
    if (arr === null) continue;
    const entries = evalLiteral(arr, sf, bindings, defects) as {
      type?: { code?: unknown; label?: unknown };
      items?: { code?: unknown; label?: unknown }[];
    }[];
    for (const entry of entries) {
      const tCode = entry?.type?.code;
      const tLabel = entry?.type?.label;
      if (typeof tCode !== 'string' || typeof tLabel !== 'string') {
        defects.push(`${arrName} 里有条目的 type.code/label 不是字符串 ⇒ 提取器读不了`);
        continue;
      }
      const items: DictItem[] = [];
      for (const it of entry.items ?? []) {
        if (typeof it?.code !== 'string' || typeof it?.label !== 'string') {
          defects.push(`${arrName} 的 ${tCode} 里有 item 的 code/label 不是字符串 ⇒ 提取器读不了`);
          continue;
        }
        items.push({ code: it.code, label: it.label });
      }
      types.set(tCode, { label: tLabel, items });
    }
  }

  // 层级/单类型字典:type 取该函数 dictType.upsert 的 create 字面量,items 取具名数组。
  for (const src of config.siteTyped) {
    const typeSite = sites.find((s) => s.model === 'dictType' && s.fn === src.fn);
    if (typeSite === undefined) {
      defects.push(
        `在 ${src.fn} 里找不到 dictType.upsert 站点 ⇒ ${src.typeCode} 的 type 提取失去输入`,
      );
      continue;
    }
    // create 字面量直接从源码里读(该函数的 type code/label 是字面量;变成变量 ⇒ 读不了即红)。
    const typeCall = (function findTypeCall(node: ts.Node): ts.CallExpression | null {
      let found: ts.CallExpression | null = null;
      (function v(n: ts.Node): void {
        if (found !== null) return;
        if (ts.isCallExpression(n)) {
          const e = n.expression;
          if (
            ts.isPropertyAccessExpression(e) &&
            e.name.text === 'upsert' &&
            ts.isPropertyAccessExpression(e.expression) &&
            e.expression.name.text === 'dictType' &&
            enclosingFn(n) === src.fn
          ) {
            found = n;
            return;
          }
        }
        ts.forEachChild(n, v);
      })(node);
      return found;
    })(sf);
    if (typeCall === null) {
      defects.push(`${src.fn} 的 dictType.upsert 站点定位失败(结构与 census 不一致)`);
      continue;
    }
    const arg = typeCall.arguments[0];
    const create =
      arg !== undefined && ts.isObjectLiteralExpression(arg)
        ? arg.properties.find(
            (p): p is ts.PropertyAssignment =>
              ts.isPropertyAssignment(p) && p.name.getText(sf) === 'create',
          )
        : undefined;
    const codeProp =
      create !== undefined && ts.isObjectLiteralExpression(create.initializer)
        ? create.initializer.properties.find(
            (p): p is ts.PropertyAssignment =>
              ts.isPropertyAssignment(p) && p.name.getText(sf) === 'code',
          )
        : undefined;
    const labelProp =
      create !== undefined && ts.isObjectLiteralExpression(create.initializer)
        ? create.initializer.properties.find(
            (p): p is ts.PropertyAssignment =>
              ts.isPropertyAssignment(p) && p.name.getText(sf) === 'label',
          )
        : undefined;
    const tCode =
      codeProp !== undefined && ts.isStringLiteral(unwrap(codeProp.initializer))
        ? (unwrap(codeProp.initializer) as ts.StringLiteral).text
        : null;
    const tLabel =
      labelProp !== undefined && ts.isStringLiteral(unwrap(labelProp.initializer))
        ? (unwrap(labelProp.initializer) as ts.StringLiteral).text
        : null;
    if (tCode === null || tLabel === null || tCode !== src.typeCode) {
      defects.push(
        `${src.fn} 的 dictType.upsert create.code/label 不是字符串字面量(或 code ≠ ${src.typeCode})⇒ 提取器读不了`,
      );
      continue;
    }
    const items: DictItem[] = [];
    for (const arrName of src.arrays) {
      const arr = findConstArray(sf, arrName, defects);
      if (arr === null) continue;
      const rows = evalLiteral(arr, sf, bindings, defects) as { code?: unknown; label?: unknown }[];
      for (const it of rows) {
        if (typeof it?.code !== 'string' || typeof it?.label !== 'string') {
          defects.push(`${arrName} 里有条目的 code/label 不是字符串 ⇒ 提取器读不了`);
          continue;
        }
        items.push({ code: it.code, label: it.label });
      }
    }
    types.set(tCode, { label: tLabel, items });
  }

  return { types, sites, defects };
}

// ─── 登记表解析器(纯函数;输入 = 登记表文本)──────────────────────────────

interface RegistrySection {
  readonly label: string;
  readonly items: readonly DictItem[];
  readonly emptyMarked: boolean;
}
interface RegistryParse {
  readonly declaredTypes: number | null;
  readonly declaredItems: number | null;
  readonly sections: ReadonlyMap<string, RegistrySection>;
  readonly defects: readonly string[];
}

export function parseRegistry(text: string | null): RegistryParse {
  const defects: string[] = [];
  if (text === null) {
    return {
      declaredTypes: null,
      declaredItems: null,
      sections: new Map(),
      defects: ['登记表文件不存在'],
    };
  }
  let declaredTypes: number | null = null;
  let declaredItems: number | null = null;
  const sections = new Map<string, RegistrySection>();
  let cur: { label: string; items: DictItem[]; emptyMarked: boolean } | null = null;
  let inFence = false;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trimEnd();
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const decl = DECLARATION_RE.exec(line);
    if (decl !== null) {
      if (declaredTypes !== null) defects.push('声明行出现两处 ⇒ 解析歧义');
      declaredTypes = Number(decl[1]);
      declaredItems = Number(decl[2]);
      continue;
    }
    const head = TYPE_HEADER_RE.exec(line);
    if (head !== null) {
      if (sections.has(head[1])) defects.push(`type '${head[1]}' 有两个小节 ⇒ 哪节作数无从判断`);
      cur = { label: head[2].trim(), items: [], emptyMarked: false };
      sections.set(head[1], cur);
      continue;
    }
    if (EMPTY_MARKER_RE.test(line)) {
      if (cur !== null) cur.emptyMarked = true;
      continue;
    }
    if (!line.trim().startsWith('|')) continue;
    // 表格行:列头 / 分隔线 / 数据行;其余任何竖线行都是坏行(fail-closed)。
    if (/^\|\s*code\s*\|\s*label\s*\|$/.test(line)) continue;
    if (/^\|\s*:?-{3,}:?\s*\|\s*:?-{3,}:?\s*\|$/.test(line)) continue;
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((c) => c.trim());
    if (cells.length !== 2 || cells[0].length === 0 || cells[1].length === 0) {
      defects.push(`登记表有无法解析的表格行:'${line.slice(0, 60)}'`);
      continue;
    }
    if (!ITEM_CODE_RE.test(cells[0])) {
      defects.push(`登记表 item code 形状非法:'${cells[0]}'`);
      continue;
    }
    if (cur === null) {
      defects.push(`表格行出现在任何小节之外:'${line.slice(0, 60)}'`);
      continue;
    }
    cur.items.push({ code: cells[0], label: cells[1] });
  }
  if (declaredTypes === null)
    defects.push('登记表缺「字典 type(机器核对)」声明行 ⇒ 表被清空也看不见');
  return { declaredTypes, declaredItems, sections, defects };
}

// ─── 六维判决(纯函数,红集互不重叠)──────────────────────────────────────

/** D1 站点闭集:upsert 站点只许出现在三个已知函数、数量精确;item 的 code 不许是字面量。 */
function censusDefects(e: SeedExtraction): string[] {
  const out: string[] = [];
  const byFn = new Map<string, { dictType: number; dictItem: number }>();
  for (const s of e.sites) {
    const cur = byFn.get(s.fn) ?? { dictType: 0, dictItem: 0 };
    cur[s.model] += 1;
    byFn.set(s.fn, cur);
    if (s.model === 'dictItem') {
      if (s.itemCodeLiteral === true) {
        out.push(
          `${s.fn} 里有 dictItem.upsert 的 create.code 是字符串字面量 ⇒ 该项对提取器不可见,必须走具名数组`,
        );
      } else if (s.itemCodeLiteral === null) {
        out.push(`${s.fn} 里有 dictItem.upsert 的形状读不出 create.code ⇒ 判据失明,fail-closed`);
      }
    }
  }
  const expected = new Map(Object.entries(EXPECTED_SITES).map(([fn, c]) => [fn, { ...c }]));
  for (const [fn, c] of byFn) {
    const exp = expected.get(fn);
    if (exp === undefined) {
      out.push(
        `在未知函数 ${fn} 里发现 ${c.dictType + c.dictItem} 个字典 upsert 站点 ⇒ 新的 seed 落点,判据与登记表都没覆盖`,
      );
    } else if (exp.dictType !== c.dictType || exp.dictItem !== c.dictItem) {
      out.push(
        `${fn} 的 upsert 站点数变了(期望 dictType=${exp.dictType}/dictItem=${exp.dictItem},实读 ${c.dictType}/${c.dictItem})⇒ 同步改 EXPECTED_SITES 与登记表`,
      );
    }
    expected.delete(fn);
  }
  for (const fn of expected.keys()) {
    out.push(`已知函数 ${fn} 的 upsert 站点消失了 ⇒ seed 布局变了,判据与登记表都没跟上`);
  }
  return out;
}

/** D2 声明行 + 非退化:登记表自报的计数与解析数一致;全集不许为空。 */
function declarationDefects(e: SeedExtraction, r: RegistryParse): string[] {
  const out: string[] = [];
  const totalItems = [...r.sections.values()].reduce((s, sec) => s + sec.items.length, 0);
  if (r.declaredTypes === null || r.declaredItems === null) {
    out.push('声明行缺失或改坏 ⇒ 拒绝当绿(空表恒「零漂移」是空绿)');
  } else {
    if (r.declaredTypes !== r.sections.size) {
      out.push(
        `声明 ${r.declaredTypes} 个 type,实际解析到 ${r.sections.size} 个 ⇒ 有小节被删/被改坏`,
      );
    }
    if (r.declaredItems !== totalItems) {
      out.push(`声明 ${r.declaredItems} 项 item,实际解析到 ${totalItems} 项 ⇒ 有行被删/被改坏`);
    }
  }
  if (r.sections.size === 0) out.push('登记表一个小节都解析不到 ⇒ 解析塌了或表被清空,不许当绿');
  if (e.types.size === 0)
    out.push('seed 侧一个字典 type 都提取不到 ⇒ 提取器失去输入,双向对拍没有意义');
  if (totalItems === 0) out.push('登记表解析到 0 项 item ⇒ 空集恒等于空集会静默变绿,不许当绿');
  return out;
}

/** D3 正向:seed 的每条字典项都已登记(漏登记即红,逐条点名)。 */
function forwardDefects(e: SeedExtraction, r: RegistryParse): string[] {
  const out: string[] = [];
  for (const [tCode, t] of e.types) {
    const sec = r.sections.get(tCode);
    if (sec === undefined) {
      out.push(`seed 字典 '${tCode}'(${t.label})没有登记 ⇒ 漏了一整个字典`);
      continue;
    }
    const registered = new Set(sec.items.map((i) => i.code));
    for (const item of t.items) {
      if (!registered.has(item.code)) {
        out.push(`seed 字典 '${tCode}' 的 item '${item.code}'(${item.label})没有登记`);
      }
    }
  }
  return out;
}

/** D4 反向:登记表的每一条都真的在 seed 里(多登记/已消失即红)。 */
function reverseDefects(e: SeedExtraction, r: RegistryParse): string[] {
  const out: string[] = [];
  for (const [tCode, sec] of r.sections) {
    const seedType = e.types.get(tCode);
    if (seedType === undefined) {
      out.push(`登记表里的 '${tCode}'(${sec.label})在 seed 里不存在 ⇒ 登记了一个没有的东西`);
      continue;
    }
    const seedItems = new Set(seedType.items.map((i) => i.code));
    for (const item of sec.items) {
      if (!seedItems.has(item.code)) {
        out.push(`登记表里 '${tCode}' 的 item '${item.code}'(${item.label})在 seed 里不存在`);
      }
    }
  }
  return out;
}

/** D5 label 镜像:type 与 item 的 label 与 seed 逐字相等(漂移即红)。 */
function labelDefects(e: SeedExtraction, r: RegistryParse): string[] {
  const out: string[] = [];
  for (const [tCode, sec] of r.sections) {
    const seedType = e.types.get(tCode);
    if (seedType === undefined) continue; // D4 已报
    if (seedType.label !== sec.label) {
      out.push(`字典 '${tCode}' 的 label 漂移:登记表 '${sec.label}' ≠ seed '${seedType.label}'`);
    }
    const seedLabels = new Map(seedType.items.map((i) => [i.code, i.label]));
    for (const item of sec.items) {
      const seedLabel = seedLabels.get(item.code);
      if (seedLabel !== undefined && seedLabel !== item.label) {
        out.push(
          `'${tCode}' 的 item '${item.code}' label 漂移:登记表 '${item.label}' ≠ seed '${seedLabel}'`,
        );
      }
    }
  }
  return out;
}

/** D6 空表标注:seed 空字典必须显式标注「不预置」,非空字典不得带标注。 */
function emptyMarkDefects(e: SeedExtraction, r: RegistryParse): string[] {
  const out: string[] = [];
  for (const [tCode, t] of e.types) {
    const sec = r.sections.get(tCode);
    if (sec === undefined) continue; // D3 已报
    if (t.items.length === 0 && !sec.emptyMarked) {
      out.push(`字典 '${tCode}' seed 不预置 items,但登记表没写「seed 不预置」标注 ⇒ 空得不明不白`);
    }
    if (t.items.length > 0 && sec.emptyMarked) {
      out.push(
        `字典 '${tCode}' seed 有 ${t.items.length} 项,登记表却标着「seed 不预置」⇒ 标注与现实矛盾`,
      );
    }
  }
  return out;
}

// ─── 对外出口:六维 + 读数 + CLI ────────────────────────────────────────────

export type DictRegistryDimensions = Record<
  'D0' | 'D1' | 'D2' | 'D3' | 'D4' | 'D5' | 'D6',
  string[]
>;

export function allDimensions(seedSource: string, registryText: string): DictRegistryDimensions {
  const e = extractSeedDictionaries(seedSource, IDENTIFIER_BINDINGS);
  const r = parseRegistry(registryText);
  return {
    D0: [...e.defects, ...r.defects],
    D1: censusDefects(e),
    D2: declarationDefects(e, r),
    D3: forwardDefects(e, r),
    D4: reverseDefects(e, r),
    D5: labelDefects(e, r),
    D6: emptyMarkDefects(e, r),
  };
}

export interface DictRegistryJudgement {
  readonly ok: boolean;
  readonly evidence: readonly string[];
  /** cutover:check ④ 的对拍读数(type/item 计数;提取塌了给 -1,由计数型判据判红)。 */
  readonly counts: { readonly types: number; readonly items: number };
}

/** 六维全绿才 ok;evidence 逐条点名,供签字与 CI 输出直接引用。 */
export function judgeDictionaryRegistry(
  seedSource: string | null,
  registryText: string | null,
): DictRegistryJudgement {
  if (seedSource === null || registryText === null) {
    return {
      ok: false,
      evidence: ['seed.ts 或登记表读不到 ⇒ 判据失去输入'],
      counts: { types: -1, items: -1 },
    };
  }
  const dims = allDimensions(seedSource, registryText);
  const e = extractSeedDictionaries(seedSource, IDENTIFIER_BINDINGS);
  const r = parseRegistry(registryText);
  const items = [...r.sections.values()].reduce((s, sec) => s + sec.items.length, 0);
  const defects = Object.values(dims).flat();
  return {
    ok: defects.length === 0,
    evidence: defects.length === 0 ? ['六维全绿:D0–D6 零缺陷'] : defects,
    counts: { types: e.types.size, items },
  };
}

// ─── CLI(pnpm exec tsx scripts/check-dictionary-seed-registry.ts)──────────

function main(): void {
  const repoRoot = path.resolve(__dirname, '..');
  const seed = readFileSync(path.join(repoRoot, DICT_SEED_PATH), 'utf8');
  const registry = readFileSync(path.join(repoRoot, DICT_REGISTRY_PATH), 'utf8');
  const j = judgeDictionaryRegistry(seed, registry);
  console.log(`dict-registry-types = ${j.counts.types}`);
  console.log(`dict-registry-items = ${j.counts.items}`);
  if (j.ok) {
    console.log(`✓ 字典 seed 登记表六维全绿(${j.evidence[0]})`);
    return;
  }
  for (const d of j.evidence) console.error(`✕ ${d}`);
  process.exit(1);
}

if (require.main === module) main();
