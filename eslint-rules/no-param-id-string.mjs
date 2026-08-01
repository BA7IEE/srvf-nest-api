// @ts-check
// ============================================================================
// srvf/no-param-id-string —— 本仓第二条自定义 ESLint 规则(M4,2026-08-01)。
//
// 它替换的是原先 `no-restricted-syntax` 的第 17 条选择器:
//   "Decorator[expression.callee.name='Param'][expression.arguments.0.value='id']"
//
// 换掉的两个理由(2026-08-01 复审 M4):
//
//  ① **存量豁免的粒度是整文件**。旧做法是给 19 个 controller 各配一个 flat config 块,
//     把**整条规则**从这些文件上摘掉 —— 于是往一个已在名单里的 controller 新增一个
//     裸 `@Param('id')`,lint 依旧全绿。清单头上那句「只减不增」当时没有任何执行位,
//     是一句**谎话**。现在豁免精确到 `类名.方法名.参数名`,新增一个照样红。
//
//  ② **清单缩不下去也没人知道**。某个 controller 全部改完 IdParamDto 之后,那一行
//     豁免继续留着完全无害、完全静默,棘轮于是只剩单向。现在自测按 occurrence 逐条
//     对账:0 命中 = 陈旧行(拒),≥2 命中 = 一行豁免盖住了两处真实违规(拒)。
//
// 顺带关掉的缺口:别名 / namespace / 局部中转 / re-export ——
// 与第 18 条共用 `decorator-identity.mjs` 的解析,不抄第二份。
//
// 存量清单的唯一机读源是 `harness/legacy-param-id-baseline.json`,并登记在
// `harness/ratchet-registry.json` 里,由 base-trusted 裁判做 HEAD ⊆ BASE 的单调性裁决。
// ============================================================================

import { matchDecorator } from './decorator-identity.mjs';

/** `@nestjs/common` 里那个装饰器的导入原名。 */
const PARAM = 'Param';

export const PARAM_ID_STRING_MESSAGE =
  "`:id` 一律走 IdParamDto:@Param('id') id: string 绕过 DTO 白名单,长度/类型全不校验。[AGENTS §1 校验] 正确做法:@Param() params: IdParamDto(src/common/dto/id-param.dto.ts),取 params.id。存量违规在 harness/legacy-param-id-baseline.json 内逐条具名冻结(身份 = 类名.方法名.参数名),**只减不增** —— 往已在清单里的 controller 新增一个照样红,改好一个就删一行。";

/** 装饰器挂在参数上时,取它所属的「类名.方法名.参数名」。任一段取不到 → null。 */
function identityOf(decorator) {
  const param = decorator.parent;
  if (!param) return null;
  // `@Param('id') id: string` 的 AST:Decorator 挂在 Identifier(或 TSParameterProperty)上
  const paramName =
    param.type === 'Identifier'
      ? param.name
      : param.type === 'TSParameterProperty' && param.parameter?.type === 'Identifier'
        ? param.parameter.name
        : null;
  if (paramName === null) return null;

  const fn = param.parent;
  if (!fn || fn.type !== 'FunctionExpression') return null;
  const method = fn.parent;
  if (!method || method.type !== 'MethodDefinition' || method.computed) return null;
  const methodName =
    method.key?.type === 'Identifier'
      ? method.key.name
      : method.key?.type === 'Literal' && typeof method.key.value === 'string'
        ? method.key.value
        : null;
  if (methodName === null) return null;

  const cls = method.parent?.parent;
  if (!cls || (cls.type !== 'ClassDeclaration' && cls.type !== 'ClassExpression')) return null;
  const className = cls.id?.name ?? null;
  if (className === null) return null;

  return `${className}.${methodName}.${paramName}`;
}

/** @type {import('eslint').Rule.RuleModule} */
export const noParamIdString = {
  meta: {
    type: 'problem',
    docs: {
      description: "禁裸 @Param('id');`:id` 一律走 IdParamDto",
    },
    schema: [
      {
        type: 'object',
        properties: {
          /** 具名豁免:`类名.方法名.参数名`,来自 harness/legacy-param-id-baseline.json */
          exempt: { type: 'array', items: { type: 'string' }, uniqueItems: true },
          /** 仅供 scripts/harness-eslint.selftest.ts 全仓对账:把文案换成身份串本身。 */
          identityOnly: { type: 'boolean' },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      paramIdString: PARAM_ID_STRING_MESSAGE,
      identity: '{{identity}}',
    },
  },

  create(context) {
    const options = context.options[0] ?? {};
    const exempt = new Set(options.exempt ?? []);
    const identityOnly = options.identityOnly === true;
    const sourceCode = context.sourceCode;

    return {
      Decorator(node) {
        if (!matchDecorator(sourceCode, node, PARAM).matched) return;
        // 只拦 `@Param('id')`;`@Param()`(整对象走 DTO)与 `@Param('otherKey')` 不在本条范围。
        const expr = /** @type {any} */ (node).expression;
        if (expr?.type !== 'CallExpression') return;
        const first = expr.arguments?.[0];
        if (first?.type !== 'Literal' || first.value !== 'id') return;

        // 身份不可具名(匿名类 / computed key / 解构参数)⇒ **不可豁免**,只能真修。
        // 否则它就成了绕过清单的新逃生门。
        const identity = identityOf(node);
        if (identity !== null && exempt.has(identity)) return;

        context.report(
          identityOnly
            ? { node, messageId: 'identity', data: { identity: identity ?? '(unnamed)' } }
            : { node, messageId: 'paramIdString' },
        );
      },
    };
  },
};
