// @ts-check
// ============================================================================
// srvf/no-audience-primitive-import —— 第五条自定义规则:通知模块内受众判定唯一入口。
//
// 出处(D-WC-19 + T5A #887 挂账,2026-08-02 维护者拍板):受众可见性原语
// (canSeeContent / buildVisibilityWhere / DEPARTMENT_VISIBILITY_MEMBERSHIP_TYPES …)
// 全部住在 src/modules/content/content.visibility.ts。T5A 已把通知侧的受众判定归一到
// notification-recipient-authorization.service.ts 的两个入口(渠道无关批量判定 +
// Provider 前最终闸)。「新渠道必须消费这两个入口」若只是散文,T5B 起的任何新通道
// (WeCom 及以后)都可以自己 import 原语重写一套判定 —— 那正是 D-WC-19 要防的
// 「两套可见性 / RBAC 漂移」,也是并发审计里 S1 形状三轮清零后又在全新代码里
// 重生的既往剧本(维护者无法审代码,靠 AI 自觉 = 没有防线)。
//
// 因此:src/modules/notifications/** 内,任何对 content.visibility 的 import ——
// 含 `import {x} from`、`import type`、`export {x} from`、`export * from`(改名转发
// 是一条完整绕过路径,R3 教训)与动态 `import()` —— 一律拒,白名单只有两个常驻文件:
//   · notification-recipient-authorization.service.ts(判定服务本体);
//   · notification-read.service.ts(读侧 list where 需 isManagement 恒求值,
//     T5A 报告明确不并入 —— 强行归一会改行为)。
//
// 白名单**刻意不进棘轮注册表**:棘轮语义是「只减不增的欠账」,这两处是永久合法的
// 设计位,不是待清偿的债。硬套棘轮会让未来新增第三个合法读面撞裁判硬失败
// (基线新增 = base-trusted judge 恒拒,审批盖不掉)。白名单以 `allow` 选项写在
// eslint.harness.mjs —— 该文件本身在红区,改白名单天然要维护者 grant + 环境审批。
//
// inline disable 不是逃生门:全仓扫描拒一切指向 srvf/ 的 disable 指令与规则配置注释
// (R2 / Q2)。**spec 文件不在辖区**(config 块 ignores):parity spec 引原语做对拍
// 本身就是防漂移守护 —— 首跑 CI 冷 lint 在 notification.visibility-reuse.spec.ts 上
// 实抓后收窄,本规则只管运行时代码。已知残留面:整段复制原语实现(不 import)
// 本规则拦不住 —— 那一档由 characterization 矩阵(#886)的语义分叉与评审兜,
// import 层是本执行位的诚实边界。
// ============================================================================

export const AUDIENCE_PRIMITIVE_IMPORT_MESSAGE =
  '通知模块内禁止直接 import content.visibility 的受众原语:受众判定唯一入口是 ' +
  'notification-recipient-authorization.service.ts 的 authorizeBroadcastRecipients / ' +
  'authorizeRecipientForEffect(D-WC-19:防两套可见性与 RBAC 漂移;S1 形状曾三轮清零后在新代码重生)。' +
  '[冻结稿 §10.4/§4.1 · T5A #887] 正确做法:新通道 / 新面消费上述两个入口;确属新的合法读面 → ' +
  '由维护者授权修改 eslint.harness.mjs 的 allow 白名单(红区)。';

/** content.visibility 的模块说明符:相对路径任意深度,带不带扩展名都算。 */
const VISIBILITY_SOURCE_RE = /(^|\/)content\.visibility(\.(js|ts|mjs|cjs))?$/;

/**
 * @param {string} cwd
 * @param {string} filename
 * @param {readonly string[]} allow 仓库相对路径后缀白名单
 */
function isAllowedFile(cwd, filename, allow) {
  const rel = (filename.startsWith(cwd) ? filename.slice(cwd.length) : filename).replaceAll(
    '\\',
    '/',
  );
  return allow.some((suffix) => rel.endsWith(suffix));
}

/** @type {import('eslint').Rule.RuleModule} */
export const noAudiencePrimitiveImport = {
  meta: {
    type: 'problem',
    docs: { description: '通知模块内受众判定唯一入口 —— 禁直接 import content.visibility' },
    schema: [
      {
        type: 'object',
        properties: {
          /** 常驻白名单(仓库相对路径后缀),唯一定义处 = eslint.harness.mjs(红区)。 */
          allow: { type: 'array', items: { type: 'string' } },
        },
        additionalProperties: false,
      },
    ],
    messages: { audiencePrimitiveImport: AUDIENCE_PRIMITIVE_IMPORT_MESSAGE },
  },
  create(context) {
    const options = context.options[0] ?? {};
    const allow = options.allow ?? [];
    if (isAllowedFile(context.cwd, context.filename, allow)) return {};
    /**
     * @param {import('estree').Node} node
     * @param {unknown} sourceValue
     */
    const check = (node, sourceValue) => {
      if (typeof sourceValue === 'string' && VISIBILITY_SOURCE_RE.test(sourceValue)) {
        context.report({ node, messageId: 'audiencePrimitiveImport' });
      }
    };
    return {
      ImportDeclaration(node) {
        check(node, node.source.value);
      },
      // `export { canSeeContent } from '…'` —— 不产生本地 import 绑定,漏掉即开一条转发绕过
      ExportNamedDeclaration(node) {
        if (node.source) check(node, node.source.value);
      },
      // `export * from '…'` —— 同上,且连名字都不用点
      ExportAllDeclaration(node) {
        check(node, node.source.value);
      },
      // 动态 `import('…')`:少见但零成本封死;非字面量说明符不猜(报不出确定语义)
      ImportExpression(node) {
        if (node.source.type === 'Literal') check(node, node.source.value);
      },
    };
  },
};
