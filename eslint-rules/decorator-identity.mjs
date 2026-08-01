// @ts-check
// ============================================================================
// 装饰器身份解析 —— 两条自定义规则(第 18 条 null 契约 / `:id` 走 IdParamDto)共用。
//
// 为什么要有它:`no-restricted-syntax` 匹配的是**语法树的字面形状**。于是
// 「换个名字就绕过」有一串写法,两轮复审逐条点名:
//
//   ① import 别名        `import { IsOptional as Opt }` + `@Opt()`
//   ② namespace 中转     `import * as CV from 'class-validator'` + `@CV.IsOptional()`
//   ③ 局部变量中转       `const Opt = IsOptional;` + `@Opt()`
//   ④ re-export 转一手   `export { IsOptional } from 'class-validator'` 后再 import
//   ⑤ 计算属性           `@(CV['IsOptional']())`          ← R2/R3 轮(2026-08-01)
//   ⑥ namespace → 局部   `const Opt = CV.IsOptional;`     ← 同上
//   ⑦ 解构中转           `const { IsOptional: Opt } = CV;`← 同上
//   ⑧ **改名** re-export `export { IsOptional as Opt } from 'class-validator'` ← 同上
//
// ①在第五轮关掉;②③④在 M4 关掉;⑤⑥⑦本轮在本文件关掉。
// ⑧关不进本文件 —— 名字是在**另一个模块**被换掉的,而 eslint 规则只看得见当前文件。
// 它由第三条规则 `srvf/no-decorator-realias` 从**源头**关掉:改名导出本身就是错。
// 两件事合起来才成立:本文件保证「同一文件内换名字看得穿」,那条规则保证
// 「跨文件换名字根本不许发生」——于是任何抵达装饰器位置的名字都必然是原名。
//
// 抽成共享模块的理由很直接:两条规则各写一份解析,迟早一份先长出缺口 ——
// 而「有一半防线」的自测输出看起来和「防线完整」一模一样。
//
// ⚠️ 判据一律**宁可多判不可漏判**:
//   · 解析不到 binding(全局 / 合成片段 / default 导入)→ 退回字面名;
//   · **不校验来源模块**。校验它就会在 re-export(④)上漏判,而漏判是静默的;
//     多判则会被真可空类型 / IdParamDto / 具名基线正常放行,代价可见且有限;
//   · 计算属性的键**算不出静态值**(`CV[k]`)→ 判成命中。理由同上:算不出来
//     不等于没命中,而 `const k = 'IsOptional'; @(CV[k]())` 和 ⑤ 一样好写。
//     全仓实测 0 处动态键装饰器,所以这条多判当前零代价。
// ============================================================================

/**
 * 顺作用域链找标识符对应的 variable。
 *
 * 不用 `@eslint-community/eslint-utils` 的 findVariable:那是幻影依赖(不在本仓
 * package.json 里,只是被 pnpm 提升后偶然解析得到)—— 提升策略一变,执法规则会在
 * CI 上直接崩,而不是安静地降级。本模块只用 eslint 自带的 scope 结构,零额外依赖。
 *
 * @param {import('eslint').Scope.Scope | null} startScope
 * @param {string} name
 * @returns {import('eslint').Scope.Variable | null}
 */
function findVariable(startScope, name) {
  for (let scope = startScope; scope; scope = scope.upper) {
    const found = scope.set.get(name);
    if (found) return found;
  }
  return null;
}

/** 中转链的最大跳数。纯粹是防御性上限:`a = b; b = a;` 这类环不该把 lint 卡死。 */
const MAX_RELAY_HOPS = 8;

/**
 * 「这里确实取了某个成员,但键是算出来的,静态看不出是哪一个」的哨兵。
 *
 * 刻意用一个不可能与真实标识符相等的串:调用方把它当成**命中**处理
 * (宁可多判不可漏判),而不是当成「解析失败 → 退回字面名」。
 * 两者的区别正是本轮修的缺口:上一版把 `callee.computed` 直接判成 not matched。
 */
export const DYNAMIC_MEMBER_IDENTITY = '\u0000dynamic-member';

/**
 * 取成员访问的属性名(`X.foo` / `X['foo']` / `X[`foo`]` 三种写法同解)。
 *
 * @param {any} node
 * @returns {string | null} 静态属性名;非成员访问返回 null;键算不出静态值返回哨兵
 */
function memberPropertyName(node) {
  if (!node || node.type !== 'MemberExpression') return null;
  const property = node.property;
  if (!node.computed) {
    return property?.type === 'Identifier' ? property.name : null;
  }
  // `X['foo']`
  if (property?.type === 'Literal' && typeof property.value === 'string') return property.value;
  // `X[`foo`]` —— 无插值的模板串同样是静态的
  if (
    property?.type === 'TemplateLiteral' &&
    property.expressions.length === 0 &&
    property.quasis.length === 1
  ) {
    return property.quasis[0].value.cooked;
  }
  return DYNAMIC_MEMBER_IDENTITY;
}

/**
 * 在解构模式里找出「哪个属性绑定了 `binding` 这个标识符」,返回该属性的**键名**。
 *
 * `const { IsOptional: Opt } = CV;` ⇒ 传入 `Opt` 的 Identifier 节点,得到 `'IsOptional'`。
 * 嵌套模式(`const { a: { IsOptional: Opt } } = X`)递归下去。
 *
 * @param {any} pattern
 * @param {any} binding 被定义的那个 Identifier 节点
 * @returns {string | null}
 */
function destructuredKeyName(pattern, binding) {
  if (!pattern || pattern.type !== 'ObjectPattern') return null;
  for (const prop of pattern.properties) {
    if (prop.type !== 'Property') continue; // RestElement 拿不到具名键
    const value = prop.value?.type === 'AssignmentPattern' ? prop.value.left : prop.value;
    const keyName = prop.computed
      ? memberPropertyName({ type: 'MemberExpression', computed: true, property: prop.key })
      : prop.key?.type === 'Identifier'
        ? prop.key.name
        : prop.key?.type === 'Literal' && typeof prop.key.value === 'string'
          ? prop.key.value
          : null;
    if (value === binding) return keyName;
    if (value && (value.type === 'ObjectPattern' || value.type === 'ArrayPattern')) {
      const nested = destructuredKeyName(value, binding);
      if (nested !== null) return nested;
    }
  }
  return null;
}

/**
 * 把一个标识符解析成它的**导入原名**,穿透具名别名、局部变量中转、
 * namespace 成员中转与解构中转。
 *
 * @param {import('eslint').SourceCode} sourceCode
 * @param {any} identifier
 * @param {number} [hops]
 * @returns {string | null} 解析得到的原名;拿不到(default / namespace / 非导入)返回 null
 */
export function resolveImportedName(sourceCode, identifier, hops = 0) {
  if (hops > MAX_RELAY_HOPS) return null;
  const variable = findVariable(sourceCode.getScope(identifier), identifier.name);
  if (!variable) return null;
  for (const def of variable.defs) {
    if (def.type === 'ImportBinding') {
      const spec = /** @type {any} */ (def.node);
      if (spec.type !== 'ImportSpecifier') return null; // default / namespace 拿不到具名原名
      const imported = spec.imported;
      return imported.type === 'Identifier' ? imported.name : imported.value;
    }
    if (def.type === 'Variable') {
      const declarator = /** @type {any} */ (def.node);
      // ⑦ 解构中转:`const { IsOptional: Opt } = CV;` —— 原名是**键名**,不在 init 上。
      const key = destructuredKeyName(declarator.id, def.name);
      if (key !== null) return key;
      const init = declarator.init;
      if (!init) continue;
      // ③ 局部中转:`const Opt = IsOptional;` —— 顺着 init 再解析一跳。
      if (init.type === 'Identifier') {
        return resolveImportedName(sourceCode, init, hops + 1);
      }
      // ⑥ namespace → 局部:`const Opt = CV.IsOptional;` / `CV['IsOptional']`。
      const memberName = memberPropertyName(init);
      if (memberName !== null) return memberName;
    }
  }
  return null;
}

/**
 * 装饰器是不是目标装饰器(**看穿别名 / namespace / 局部中转 / 解构 / 计算属性**)。
 *
 * `@X()`(调用)与 `@X`(裸引用)两种写法都认;`@NS.X()` 与 `@(NS['X']())` 按属性名认。
 *
 * @param {import('eslint').SourceCode} sourceCode
 * @param {any} decorator
 * @param {string} wantedName 装饰器在其源模块中的**原名**(如 'IsOptional' / 'Param')
 * @returns {{ matched: boolean, callee: any }}
 */
export function matchDecorator(sourceCode, decorator, wantedName) {
  const expr = decorator.expression;
  const callee = expr?.type === 'CallExpression' ? expr.callee : expr;
  if (!callee) return { matched: false, callee: null };

  // ② `@CV.IsOptional()` / ⑤ `@(CV['IsOptional']())` —— namespace 或任意对象中转,
  //    一律按属性名判。刻意不要求 object 必须解析成 namespace import:要求它就等于给
  //    `const CV = require('class-validator')` 之类的写法留一扇门。
  if (callee.type === 'MemberExpression') {
    const name = memberPropertyName(callee);
    return { matched: name === wantedName || name === DYNAMIC_MEMBER_IDENTITY, callee };
  }

  if (callee.type !== 'Identifier') return { matched: false, callee };

  const resolved = resolveImportedName(sourceCode, callee);
  // 解析得到具名原名 ⇒ **以原名为准**,本地叫什么无关紧要;
  // 解析不到(全局 / 合成片段 / default 导入)⇒ 退回字面名,宁可多判不可漏判。
  return {
    matched: resolved === DYNAMIC_MEMBER_IDENTITY || (resolved ?? callee.name) === wantedName,
    callee,
  };
}
