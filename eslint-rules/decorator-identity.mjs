// @ts-check
// ============================================================================
// 装饰器身份解析 —— 两条自定义规则(第 18 条 null 契约 / `:id` 走 IdParamDto)共用。
//
// 为什么要有它:`no-restricted-syntax` 匹配的是**语法树的字面形状**。于是
// 「换个名字就绕过」有三种写法,2026-08-01 复审(M4)逐条点名:
//
//   ① import 别名        `import { IsOptional as Opt }` + `@Opt()`
//   ② namespace 中转     `import * as CV from 'class-validator'` + `@CV.IsOptional()`
//   ③ 局部变量中转       `const Opt = IsOptional;` + `@Opt()`
//   ④ re-export 转一手   `export { IsOptional } from 'class-validator'` 后再 import
//
// ①在第五轮已由 no-nullable-is-optional 自己关掉;②③④ 到本轮才关。
// 抽成共享模块的理由很直接:两条规则各写一份解析,迟早一份先长出缺口 ——
// 而「有一半防线」的自测输出看起来和「防线完整」一模一样。
//
// ⚠️ 判据一律**宁可多判不可漏判**:
//   · 解析不到 binding(全局 / 合成片段 / default 导入)→ 退回字面名;
//   · **不校验来源模块**。校验它就会在 re-export(④)上漏判,而漏判是静默的;
//     多判则会被真可空类型 / IdParamDto / 具名基线正常放行,代价可见且有限。
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
 * 把一个标识符解析成它的**导入原名**,穿透具名别名与局部变量中转。
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
    // ③ 局部中转:`const Opt = IsOptional;` —— 顺着 init 再解析一跳。
    if (def.type === 'Variable') {
      const init = /** @type {any} */ (def.node).init;
      if (init && init.type === 'Identifier') {
        return resolveImportedName(sourceCode, init, hops + 1);
      }
    }
  }
  return null;
}

/**
 * 装饰器是不是目标装饰器(**看穿别名 / namespace / 局部中转**)。
 *
 * `@X()`(调用)与 `@X`(裸引用)两种写法都认;`@NS.X()` 按属性名认。
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

  // ② `@CV.IsOptional()` —— namespace / 任意对象中转,一律按属性名判。
  //    刻意不要求 object 必须解析成 namespace import:要求它就等于给
  //    `const CV = require('class-validator')` 之类的写法留一扇门。
  if (callee.type === 'MemberExpression') {
    if (callee.computed) return { matched: false, callee };
    const property = callee.property;
    const name = property?.type === 'Identifier' ? property.name : null;
    return { matched: name === wantedName, callee };
  }

  if (callee.type !== 'Identifier') return { matched: false, callee };

  const resolved = resolveImportedName(sourceCode, callee);
  // 解析得到具名原名 ⇒ **以原名为准**,本地叫什么无关紧要;
  // 解析不到(全局 / 合成片段 / default 导入)⇒ 退回字面名,宁可多判不可漏判。
  return { matched: (resolved ?? callee.name) === wantedName, callee };
}
