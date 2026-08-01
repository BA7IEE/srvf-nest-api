// @ts-check
// ============================================================================
// srvf/no-near-future-date —— 第四条自定义规则:测试文件禁「近未来」日期字面量。
//
// 事故出处(INC-18,2026-08-01):e2e 共用 fixture 活动 endAt=2026-08-01T12:00Z,
// 墙钟越过该时刻的瞬间「活动已完结」闸翻面,main 上**所有 PR** 的 CI 同时红,
// 且引爆时刻与任何 diff 无关(当天 06:40Z 同一 spec 全绿,12:54Z 起必红)。
// 这是同一缺陷类第三次发作(v0.40.0 拆过一次,#875 又拆一次)。
//
// 判据:字符串/模板字面量里出现日历上真实存在的日期 D,且 today < D < 2090-01-01
// (today 按北京日历日、lint 运行当刻取值)——
//   · D ≤ today:历史数据,合法(已爆的炸弹会直接让测试红,轮不到本规则);
//   · D ≥ 2090-01-01:远未来惯例(2099 / +72 年平移),本仓拆弹既定写法;
//   · 中间地带 = 引信随墙钟倒计时的炸弹,一律拒。
//
// 判据边界是**单调**的:一个日期一旦越过 today 就永远不再被本规则标红,不存在
// 「昨天绿今天红」的方向;反方向(昨天红今天绿)只发生在引信烧完之后 —— 而那时
// 该测试要么已经爆了(CI 直接红),要么本来就与墙钟无关(应入基线)。
//
// #875 拆弹实测出的**不是炸弹**的形态(全部进 harness/near-future-date-baseline.json
// 具名冻结,身份 = 「文件 × 日期字面量」;同文件新增其他日期、其他文件同日期照样红):
//   ① 时钟注入型:job.runOnce(NOW) 把时钟当参数传,literal 相对注入钟恒定
//      (顺手「修」它反而打红 —— 看着像炸弹不等于是炸弹);
//   ② 年窗耦合型:贡献值按 cycle 年窗过滤,日期是窗内坐标不是未来性断言
//      (盲平移把「既往 4 分」移出窗,computeContribution 4→0);
//   ③ 派生断言型:FIXED_MONTHS 等纯函数从过去输入算出的未来输出
//      (平移期望值而输入不动,断言当场红 —— 它根本不依赖墙钟)。
//
// inline disable **不是**本规则的逃生门:scripts/harness-eslint.selftest.ts 的
// 全仓扫描拒一切指向 srvf/ 的 disable 指令(R2)与规则配置注释(Q2)。
// 唯一豁免通道 = 基线文件,而它在红区 —— 改它要维护者 harness:grant。
// ============================================================================

/** 远未来下界:≥ 此日期视为刻意的远未来惯例(2099 / +72 年平移),不拦。 */
export const FAR_FUTURE_FLOOR = '2090-01-01';

export const NEAR_FUTURE_DATE_MESSAGE =
  '测试禁「近未来」日期字面量({{date}}:today < D < 2090-01-01):墙钟越过它的瞬间,' +
  '耦合当前时间的业务闸翻面,main 全线 CI 红且与任何 diff 无关。' +
  '[INC-18 · 2026-08-01 实爆,同类第三次] 正确做法:纯未来 fixture 平移到 2090 之后' +
  '(既有惯例 2099;多个有序日期用 +72 年保序映射,别拍平);确经核验与墙钟无关' +
  '(时钟注入 / 年窗坐标 / 派生断言)→ 入 harness/near-future-date-baseline.json ' +
  '具名冻结(身份 = 文件 × 日期,红区,维护者 grant)。';

/**
 * 北京「今天」的 YYYY-MM-DD。时钟以参数注入 —— 自测要能喂固定时刻做阳性对照,
 * 本规则自己不能反过来成为一颗依赖墙钟的炸弹。
 * @param {Date} [now]
 */
export function beijingTodayISO(now = new Date()) {
  return new Date(now.getTime() + 8 * 3_600_000).toISOString().slice(0, 10);
}

const DATE_RE = /(?<!\d)(20[2-9][0-9])-([01][0-9])-([0-3][0-9])(?!\d)/g;

/**
 * 纯函数:文本里所有「日历真实存在 且 today < D < FAR_FUTURE_FLOOR」的日期串,升序去重。
 * 抽成纯函数并导出,是让自测能对判据本身做期望值对照(边界:today / today+1 / 2090-01-01 /
 * 2089-12-31 / 假日期 2027-02-30),而不是只断言「规则报了点什么」。
 * @param {string} text
 * @param {string} todayISO `YYYY-MM-DD`
 * @returns {string[]}
 */
export function nearFutureDatesIn(text, todayISO) {
  /** @type {Set<string>} */
  const found = new Set();
  for (const m of text.matchAll(DATE_RE)) {
    const [iso, y, mo, d] = [m[0], Number(m[1]), Number(m[2]), Number(m[3])];
    const t = Date.UTC(y, mo - 1, d);
    const rt = new Date(t);
    // 日历真实性:Date.UTC 会把 2027-02-30 悄悄进位成 03-02 —— round-trip 不一致即假日期
    if (rt.getUTCFullYear() !== y || rt.getUTCMonth() !== mo - 1 || rt.getUTCDate() !== d) continue;
    if (iso > todayISO && iso < FAR_FUTURE_FLOOR) found.add(iso);
  }
  return [...found].sort();
}

/**
 * 本规则只管**测试代码**:`test/**` 与任何 `*.spec.ts`(单测就住在 src/ 里)。
 * src 业务文件里的日期是业务语义(DTO example / 拍板日期 / 字典),不拦 ——
 * 且 DTO example 进 openapi 契约快照,动它会撞 test/contract 红区。
 * 守卫写在规则内部而不只靠 config 块的 files 作用域,是因为棘轮对账扫描器
 * (scripts/harness-eslint.selftest.ts)会把本规则铺到全仓三目录跑 —— 两条路径
 * 必须看到同一个集合,否则对账会把 src 业务日期记成「新增违规未登记」。
 * @param {string} cwd
 * @param {string} filename
 */
export function isGuardedTestFile(cwd, filename) {
  const rel = (filename.startsWith(cwd) ? filename.slice(cwd.length) : filename).replaceAll(
    '\\',
    '/',
  );
  return /(^|\/)test\//.test(rel) || rel.endsWith('.spec.ts');
}

/** @type {import('eslint').Rule.RuleModule} */
export const noNearFutureDate = {
  meta: {
    type: 'problem',
    docs: { description: '测试文件禁「近未来」(today, 2090) 日期字面量 —— 墙钟炸弹' },
    schema: [
      {
        type: 'object',
        properties: {
          /** 具名豁免:该文件内已核验墙钟无关的日期串,来自 harness/near-future-date-baseline.json */
          exempt: { type: 'array', items: { type: 'string' } },
          /** 棘轮对账协议(同 no-param-id-string):上报文案换成身份串本身,按文件去重。 */
          identityOnly: { type: 'boolean' },
        },
        additionalProperties: false,
      },
    ],
    messages: { nearFutureDate: NEAR_FUTURE_DATE_MESSAGE, identity: '{{identity}}' },
  },
  create(context) {
    const options = context.options[0] ?? {};
    const exempt = new Set(options.exempt ?? []);
    const identityOnly = options.identityOnly === true;
    if (!isGuardedTestFile(context.cwd, context.filename)) return {};
    const todayISO = beijingTodayISO();
    // identityOnly 按文件去重:对账合同是「每个身份恰好 1 命中」(0=陈旧 / ≥2=不唯一),
    // 而同一日期在同文件成对出现(checkIn/checkOut)是常态 —— 一条基线行盖住该文件内
    // 这个日期的全部出现,本来就是 date-literal 形状的既定语义(见 BASELINE_SYMBOL_SHAPES 注释)。
    /** @type {Set<string>} */
    const reportedIdentities = new Set();
    /**
     * @param {import('estree').Node} node
     * @param {string} text
     */
    const scan = (node, text) => {
      for (const date of nearFutureDatesIn(text, todayISO)) {
        if (identityOnly) {
          if (!reportedIdentities.has(date)) {
            reportedIdentities.add(date);
            context.report({ node, messageId: 'identity', data: { identity: date } });
          }
        } else if (!exempt.has(date)) {
          context.report({ node, messageId: 'nearFutureDate', data: { date } });
        }
      }
    };
    return {
      Literal(node) {
        if (typeof node.value === 'string') scan(node, node.value);
      },
      TemplateElement(node) {
        scan(node, node.value.raw);
      },
    };
  },
};
