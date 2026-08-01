// @ts-check
// ============================================================================
// srvf/no-decorator-realias —— 本仓第三条自定义 ESLint 规则(R3,2026-08-01)。
//
// 它关的是 `decorator-identity.mjs` **结构上关不掉**的那一种绕过:改名 re-export。
//
//   a.ts:  export { IsOptional as Opt } from 'class-validator';
//   b.dto.ts:  import { Opt } from './a';
//              export class D { @Opt() foo?: string; }   ← 修复前:lint 全绿
//
// 为什么 decorator-identity 关不掉:名字是在**另一个模块**被换掉的。b.dto.ts 里
// 顺着 scope 只能解析到 `import { Opt } from './a'`,导入原名就是 `Opt` ——
// 要看穿它必须跨模块解析,而那要么依赖 TS type checker(自测里拿不到 parserServices,
// 阳性对照就没法做),要么自己写一套模块图(第二把尺子,迟早与真实解析漂移)。
//
// 所以判据换个方向:**不让改名这件事发生**。任何把受守护装饰器以另一个名字导出
// 的写法,在它自己那一行就是错。于是任何抵达装饰器位置的名字都必然是原名,
// decorator-identity 的同文件解析就足够了 —— 两条规则拼起来才是完整防线,
// 各自单独都只是半条。
//
// 覆盖四种「换名字导出」的写法(四种都能让下游拿到一个 decorator-identity 认不出的名字):
//   ① `export { IsOptional as Opt } from 'class-validator'`  改名 re-export
//   ② `export { Opt }`(Opt 由本文件解析得到 IsOptional)      本地改名导出
//   ③ `export const Opt = IsOptional` / `= CV.IsOptional`     变量改名导出
//   ④ `export default IsOptional`                             默认导出(下游可任意命名)
//
// 反向不误杀:**同名**导出全部放行(`export { IsOptional } from 'class-validator'`、
// `export * from 'class-validator'`)—— 同名转一手不制造新名字,下游解析得到的
// 依旧是 `IsOptional`,decorator-identity 认得。落地时全仓实测 0 处违规,
// 所以这条规则是零代价的(不是「零风险」,是「当前零暴露」)。
//
// ⚠️ 本规则没有 `exempt` 选项,**刻意的**:一旦可以具名豁免,「先豁免自己、再改名」
//    就是一条完整的绕过路径 —— 而本条要防的正是「给自己发许可」。真需要改名转发时,
//    正确做法是不转发(直接从原模块 import)。
// ============================================================================

import { DYNAMIC_MEMBER_IDENTITY, resolveImportedName } from './decorator-identity.mjs';
import { IS_OPTIONAL_DECORATOR } from './no-nullable-is-optional.mjs';
import { PARAM_DECORATOR } from './no-param-id-string.mjs';

/**
 * 受守护的装饰器原名。**直接引另外两条规则导出的同一个常量**,不抄字符串 ——
 * 抄一份就会出现「加了第三条守护目标、这里没跟上」的静默半防线,
 * 而半防线的自测输出与完整防线一模一样。
 */
export const GUARDED_DECORATOR_NAMES = [IS_OPTIONAL_DECORATOR, PARAM_DECORATOR];

export const DECORATOR_REALIAS_MESSAGE =
  '禁把受执法守护的装饰器改名导出(`export { IsOptional as Opt }` / `export const Opt = IsOptional` / `export default Param` 等)。改名发生在**另一个模块**,下游文件顺着 scope 只解析得到新名字,srvf/no-nullable-is-optional 与 srvf/no-param-id-string 的身份解析会静默漏判 —— 这正是「换个名字就绕过」最后一条没关的路。[AGENTS §1 字面语法拦截] 正确做法:需要用这些装饰器就**直接从原模块 import**(class-validator / @nestjs/common),不要在本仓内转发;确需转发也必须**同名**转发(`export { IsOptional } from ...` / `export *`),同名不制造新名字。本条无具名豁免:可豁免的守护等于可自发许可的守护。';

/** 取 `export { X as Y }` 里 X / Y 的名字(Identifier 或字符串 Literal 两种形态)。 */
function specifierName(node) {
  if (!node) return null;
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  return null;
}

/** @type {import('eslint').Rule.RuleModule} */
export const noDecoratorRealias = {
  meta: {
    type: 'problem',
    docs: {
      description: '禁把受守护的装饰器(@IsOptional / @Param)以另一个名字导出',
    },
    schema: [],
    messages: {
      decoratorRealias: DECORATOR_REALIAS_MESSAGE,
    },
  },

  create(context) {
    const sourceCode = context.sourceCode;
    const guarded = new Set(GUARDED_DECORATOR_NAMES);

    /** 解析一个表达式指向的**原名**;拿不到返回 null。 */
    const originalNameOf = (expr) => {
      if (!expr) return null;
      if (expr.type === 'Identifier') return resolveImportedName(sourceCode, expr) ?? expr.name;
      if (expr.type === 'MemberExpression') {
        // `CV.IsOptional` / `CV['IsOptional']` —— 与 decorator-identity 同解。
        const property = expr.property;
        if (!expr.computed) return property?.type === 'Identifier' ? property.name : null;
        if (property?.type === 'Literal' && typeof property.value === 'string') {
          return property.value;
        }
        return DYNAMIC_MEMBER_IDENTITY;
      }
      return null;
    };

    /** 命中判据:指向的原名受守护(或算不出静态键 ⇒ 宁可多判)。 */
    const isGuarded = (name) => name !== null && (guarded.has(name) || name === DYNAMIC_MEMBER_IDENTITY);

    return {
      ExportNamedDeclaration(node) {
        // ③ `export const Opt = IsOptional;`
        const declaration = /** @type {any} */ (node).declaration;
        if (declaration?.type === 'VariableDeclaration') {
          for (const declarator of declaration.declarations) {
            if (declarator.id?.type !== 'Identifier') continue;
            const original = originalNameOf(declarator.init);
            if (isGuarded(original) && declarator.id.name !== original) {
              context.report({ node: declarator, messageId: 'decoratorRealias' });
            }
          }
        }

        for (const spec of /** @type {any} */ (node).specifiers ?? []) {
          if (spec.type !== 'ExportSpecifier') continue;
          const localName = specifierName(spec.local);
          const exportedName = specifierName(spec.exported);
          if (localName === null || exportedName === null) continue;
          // ① 带 source:`local` 就是**源模块里的原名**,不必再解析 scope。
          // ② 不带 source:`local` 是本文件的绑定,顺着 scope 解析到原名。
          const original = /** @type {any} */ (node).source
            ? localName
            : (resolveImportedName(sourceCode, spec.local) ?? localName);
          if (isGuarded(original) && exportedName !== original) {
            context.report({ node: spec, messageId: 'decoratorRealias' });
          }
        }
      },

      // ④ `export default IsOptional;` —— 下游 default import 可以叫任何名字。
      ExportDefaultDeclaration(node) {
        const original = originalNameOf(/** @type {any} */ (node).declaration);
        if (isGuarded(original)) {
          context.report({ node, messageId: 'decoratorRealias' });
        }
      },
    };
  },
};
