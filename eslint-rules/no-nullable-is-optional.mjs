// @ts-check
// ============================================================================
// srvf/no-nullable-is-optional —— 本仓**第一条真自定义 ESLint 规则**。
//
// 它替换的是原先第 18 条 `no-restricted-syntax` 选择器:
//   "PropertyDefinition:has(Decorator[expression.callee.name='IsOptional'])
//    :not(:has(TSNullKeyword))"
//
// 换掉的三个理由(2026-07-31 第五轮跨模型评审 J2,三条都已实测复现):
//
//  ① **嵌套 null 冒充可空**:`:not(:has(TSNullKeyword))` 判的是「整棵子树里
//     有没有出现过 null 这个词」。于是 `foo?: Array<string | null>` /
//     `{ v: string | null }` / `Promise<string | null>` 全部被当成「已经可空」
//     而放行 —— 而它们的**顶层**类型依然不含 null,显式 `null` 照样穿过契约层。
//     本规则改判**属性顶层类型**,嵌套里的 null 不再算数。
//
//  ② **inline disable 连坐**:18 条规则共用 `no-restricted-syntax` 一个 ruleId,
//     一句 `// eslint-disable-next-line no-restricted-syntax` 会把该行的
//     **全部 18 条**一起关掉。独立 ruleId 之后,想关这一条就得**具名**关它,
//     且 DTO 范围已配 `linterOptions.noInlineConfig: true`,连具名也关不掉。
//
//  ③ **import 别名缺口**:选择器只认字面名 `IsOptional`,
//     `import { IsOptional as Opt }` + `@Opt()` 直接绕过。自定义规则拿得到
//     scope,顺着 binding 解析到**导入原名**,别名不再是逃生门。
//     ⚠️ 这条缺口只在本规则内关闭;其余 17 条选择器的同类缺口仍登记在
//     `scripts/harness-eslint.selftest.ts` 的「已知缺口」段,不假装已解决。
//
// 存量豁免走 `options[0].exempt`(`类名.字段名` 具名清单),真源是
// `harness/is-optional-null-baseline.json`,由 `eslint.harness.mjs` 加载并分发。
// 豁免**不做整文件通配**:往已在基线的文件新增一个违规字段照样红。
// ============================================================================

/**
 * 规则一句话 + AGENTS 出处 + 正确做法(三段式,与其余 17 条同格式)。
 * 单独导出:`eslint.harness.mjs` 与自测都引**同一个字符串**,不抄第二份 ——
 * 抄第二份就会出现「规则改了、别处没跟上」的静默失效。
 */
export const NULLABLE_IS_OPTIONAL_MESSAGE =
  '`@IsOptional()` 对 null 与 undefined **都**跳过后续校验,而本仓 service 判「传没传」用的是 `=== undefined` —— 显式 null 会穿过整个契约层(实测:审核 issuedAt:null → new Date(null) = 1970-01-01 落成正式事实;Policy/Certificate PATCH → 500 而非 400)。[AGENTS §1 校验] 正确做法:字段**真能清空** → 保留 @IsOptional() 并把 TS 类型标成 `T | null`(同时 @ApiPropertyOptional({ nullable: true, type: X }),让 DTO/OpenAPI/DB 三处一致);字段**只是可省略** → 改用 @OmittableOnly()(src/common/decorators/omittable-only.decorator.ts),null 稳定 400。⚠️ 判的是**顶层**类型:`Array<string | null>` / `{ v: string | null }` / `Promise<string | null>` 都**不算**可空。存量违规在 harness/is-optional-null-baseline.json 内逐条具名冻结,**只减不增**。';

/** class-validator 里那个装饰器的**导入原名**(别名解析后与它比对)。 */
const IS_OPTIONAL = 'IsOptional';
const CLASS_VALIDATOR = 'class-validator';

/**
 * 顺作用域链找标识符对应的 variable。
 *
 * 不用 `@eslint-community/eslint-utils` 的 findVariable:那是幻影依赖
 * (不在本仓 package.json 里,只是被 pnpm 提升后偶然解析得到)——
 * 提升策略一变,执法规则会在 CI 上直接崩,而不是安静地降级。
 * 本规则只用 eslint 自带的 scope 结构,零额外依赖。
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

/**
 * 取变量的**导入原名**与来源模块;不是 import 绑定则返回 null。
 *
 * @param {import('eslint').Scope.Variable} variable
 * @returns {{ name: string | null, source: unknown } | null}
 */
function importBindingOf(variable) {
  for (const def of variable.defs) {
    if (def.type !== 'ImportBinding') continue;
    const spec = /** @type {any} */ (def.node);
    const source = /** @type {any} */ (def.parent)?.source?.value;
    if (spec.type === 'ImportSpecifier') {
      const imported = spec.imported;
      const name = imported.type === 'Identifier' ? imported.name : imported.value;
      return { name, source };
    }
    // default / namespace 导入:拿不到具名原名,交给调用方按 null 处理
    return { name: null, source };
  }
  return null;
}

/**
 * 这个装饰器是不是 class-validator 的 `@IsOptional`(**看穿 import 别名**)。
 *
 * @param {import('eslint').SourceCode} sourceCode
 * @param {any} decorator
 */
function isIsOptionalDecorator(sourceCode, decorator) {
  const expr = decorator.expression;
  // `@IsOptional()`(调用)与 `@IsOptional`(裸引用)两种写法都要认
  const callee = expr?.type === 'CallExpression' ? expr.callee : expr;
  if (!callee || callee.type !== 'Identifier') return false;

  const variable = findVariable(sourceCode.getScope(callee), callee.name);
  const binding = variable ? importBindingOf(variable) : null;

  if (binding && binding.name !== null) {
    // 解析得到具名 import:**以导入原名为准**,本地叫什么无关紧要。
    // 来源模块只在能拿到时才校验 —— 拿不到(re-export 链等)不因此漏判。
    if (binding.source !== undefined && binding.source !== CLASS_VALIDATOR) return false;
    return binding.name === IS_OPTIONAL;
  }
  // 解析不到 binding(全局 / 合成片段 / default 导入)→ 退回字面名。
  // 宁可多判不可漏判:多判会被真可空类型或具名豁免正常放行。
  return callee.name === IS_OPTIONAL;
}

/**
 * 属性的**顶层**类型是否含 null。
 *
 * 只看顶层是这条规则的全部要害:
 *   `string | null` ✅ · `Array<string> | null` ✅
 *   `Array<string | null>` ❌ · `{ v: string | null }` ❌ · `Promise<string | null>` ❌
 *
 * @param {any} propertyDefinition
 */
function topLevelHasNull(propertyDefinition) {
  const annotation = propertyDefinition.typeAnnotation?.typeAnnotation;
  if (!annotation) return false; // 没标类型 = 顶层不可能含 null
  if (annotation.type === 'TSNullKeyword') return true;
  if (annotation.type === 'TSUnionType') {
    return annotation.types.some((/** @type {any} */ t) => t.type === 'TSNullKeyword');
  }
  return false;
}

/** 所属类名;匿名类返回 null(→ 身份不可具名 ⇒ 永远不能被豁免)。 */
function classNameOf(propertyDefinition) {
  const cls = propertyDefinition.parent?.parent;
  if (!cls) return null;
  if (cls.type !== 'ClassDeclaration' && cls.type !== 'ClassExpression') return null;
  return cls.id?.name ?? null;
}

/** 字段名;computed key 返回 null(同上)。 */
function fieldNameOf(propertyDefinition) {
  if (propertyDefinition.computed) return null;
  const key = propertyDefinition.key;
  if (key?.type === 'Identifier') return key.name;
  if (key?.type === 'Literal' && typeof key.value === 'string') return key.value;
  return null;
}

/** @type {import('eslint').Rule.RuleModule} */
export const noNullableIsOptional = {
  meta: {
    type: 'problem',
    docs: {
      description:
        '带 @IsOptional() 的属性,其**顶层** TS 类型必须含 `| null`;否则改用 @OmittableOnly()',
    },
    schema: [
      {
        type: 'object',
        properties: {
          /** 具名豁免:`类名.字段名`,来自 harness/is-optional-null-baseline.json */
          exempt: { type: 'array', items: { type: 'string' }, uniqueItems: true },
          /**
           * **仅供 scripts/harness-eslint.selftest.ts 全仓扫描用**:
           * 把上报文案换成身份串本身(`类名.字段名`),让自测拿到身份
           * 不必再走「报告行号 → 反查 AST」那条平行实现。
           * 「两把刻错的尺子读数相同」是本仓 2026-07-29 评审原话,不再重蹈。
           */
          identityOnly: { type: 'boolean' },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      nullableIsOptional: NULLABLE_IS_OPTIONAL_MESSAGE,
      identity: '{{identity}}',
    },
  },

  create(context) {
    const options = context.options[0] ?? {};
    const exempt = new Set(options.exempt ?? []);
    const identityOnly = options.identityOnly === true;
    const sourceCode = context.sourceCode;

    return {
      PropertyDefinition(node) {
        const decorators = /** @type {any} */ (node).decorators ?? [];
        if (!decorators.some((/** @type {any} */ d) => isIsOptionalDecorator(sourceCode, d))) {
          return;
        }
        if (topLevelHasNull(node)) return;

        const className = classNameOf(node);
        const fieldName = fieldNameOf(node);
        // 具名不全 ⇒ 身份不可寻址 ⇒ **不可豁免**(否则匿名类 / computed key
        // 会变成绕过基线的新逃生门)。自测按 `(anonymous)` / `(computed)` 报出来。
        const identity = `${className ?? '(anonymous)'}.${fieldName ?? '(computed)'}`;
        if (className !== null && fieldName !== null && exempt.has(identity)) return;

        context.report(
          identityOnly
            ? { node, messageId: 'identity', data: { identity } }
            : { node, messageId: 'nullableIsOptional' },
        );
      },
    };
  },
};

/** 供 flat config 以 `plugins: { srvf: srvfEslintPlugin }` 挂载。 */
export const srvfEslintPlugin = {
  rules: { 'no-nullable-is-optional': noNullableIsOptional },
};

export default srvfEslintPlugin;
