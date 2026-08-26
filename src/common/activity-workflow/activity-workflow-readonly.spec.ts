import { relative } from 'node:path';

import * as ts from 'typescript';

import {
  REPO_ROOT,
  collectProdFiles,
  readSource,
} from '../../../scripts/check-activity-workflow-gate';
import { parseActivityWorkflowReadonly } from '../../config/app.config';
import type { AppConfig } from '../../config/app.config';
import { BizCode } from '../exceptions/biz-code.constant';
import { BizException } from '../exceptions/biz.exception';
import { ActivityWorkflowGate } from './activity-workflow.gate';

/**
 * 活动 v1.1 **只读维护态**(合同 §16.4)—— 行为矩阵 + 一条结构断言。
 *
 * ──────────────────────────────────────────────────────────────────────────
 * 🔴 文件名为什么**不是** `*.criteria.spec.ts`(先说这个,免得被读成绕闸)
 *
 * 本仓有一道「判据纯度」闸(`scripts/check-criteria-spec-purity.ts`):凡叫
 * `*.criteria.spec.ts` 的文件必须是**薄运行器** —— 不许有分支 / 循环 / 函数 / 正则 /
 * 能力型 import,实质逻辑一律住在 selfGuard 保护下的 `scripts/check-*.ts` 里。
 * 理由是判据的价值就在于「改松它很麻烦」。
 *
 * 本文件 21 条断言里 **20 条是行为单测**(拿真 `ActivityWorkflowGate` 跑 `enabled × 只读`
 * 四态,与 `attendances.service.spec.ts` 同类),它们靠「跑的是真类」取信,不靠「难改」;
 * 只有**最后那条结构断言**(只读位的单一读取处)是货真价实的判据形态。
 * 把 20 条行为断言硬塞进薄运行器的模子里做不到,给整个文件挂 `.criteria.` 也只会
 * 让纯度闸对一个行为单测报一堆假阳。⇒ **按它真实的性质命名。**
 *
 * ⚠️ 代价说清楚,不粉饰:那条结构断言因此住在**无红区保护**的文件里,
 *    任何 PR 都能把它删掉且零授权。正确落点是把这两个标识符并进
 *    `scripts/check-activity-workflow-gate.ts` 的 C1 令牌表(那里已经钉着
 *    `activityV11Workflow`)—— 那是红区,本刀是零红区刀,故未做。
 *    已在 `docs/ai-harness/NEXT_TASKS.md` P2-22 的「顺带」里登记。
 *
 * ⭐ 缓解(不是替代):只读位刻意住在 `activityV11Workflow` 这个**已被 C1 钉住**的
 *    配置命名空间里 ⇒ 别的生产文件想读它就得引用 `activityV11Workflow`,**当场 C1 红**。
 *    下面这条结构断言补的是 C1 覆盖不到的另一条路:有人绕过配置层直接读
 *    `process.env.ACTIVITY_WORKFLOW_READONLY`。
 *
 * ──────────────────────────────────────────────────────────────────────────
 *
 * ──────────────────────────────────────────────────────────────────────────
 * 这条判据在守什么
 *
 * §16.4「发现严重问题」时给了两条路:(i) gate 切为拒绝新写;(ii) 部署只读维护镜像。
 * 维护者 2026-08-26 选 (i)、且明确「用现成的切换闸,不新建镜像」。
 *
 * 🔴 二值闸做不到这件事,这是本判据存在的全部理由:上线后(闸开)把
 * `ACTIVITY_V11_WORKFLOW_ENABLED` 关掉**不是**「拒绝新写」,它同时把旧考勤写路径放开了,
 * 而 §16.4 第 5 条逐字写着「不能切回旧表写入」。⇒ 「两边都拒」这一态此前物理上不存在。
 *
 * ──────────────────────────────────────────────────────────────────────────
 * 🔴 为什么每一维各自成一个 `it`
 *
 * jest 在一个 `it` 内**首个失败即停**。若把四态矩阵塞进一个 `it`,做变异对拍时
 * 第一格先红,后面几格**一次都没跑到** —— 「判据有判别力」于是结构上观测不到,
 * 而这在基线全绿时完全看不出来(`docs/ai-harness/TOOL_TRAPS.md` §6.1)。
 * 下面每一格、每一个方向、每一条解析分支都是**独立的 `it`**。
 *
 * ──────────────────────────────────────────────────────────────────────────
 * ⚠️ 边界(别把本判据读大)
 *
 * 只读态继承的是**闸本身的范围** = 结算真相链(Punch / Settlement / Ledger / Closure /
 * Correction)+ 旧考勤写。报名、活动编辑、通知、用户管理**照常可写**。
 * 合同 §16.4 那条若指「全站只读」,那是路 (ii) 的事,本判据不声称覆盖它。
 */

const GATE_FILE = 'src/common/activity-workflow/activity-workflow.gate.ts';
const CONFIG_FILE = 'src/config/app.config.ts';

/** 只读位在生产代码里**允许**出现的地方 —— 与 C1 对 `activityV11Workflow` 的口径同形。 */
const READONLY_TOKEN_ALLOWLIST: readonly string[] = [CONFIG_FILE, GATE_FILE];

/** 被看守的两个标识符。`ACTIVITY_WORKFLOW_READONLY_MAINTENANCE`(错误码名)是**另一个**标识符,精确相等故不误收。 */
const READONLY_TOKENS: readonly string[] = ['ACTIVITY_WORKFLOW_READONLY', 'readonlyMaintenance'];

function gate(enabled: boolean, readonlyMaintenance: boolean): ActivityWorkflowGate {
  return new ActivityWorkflowGate({
    activityV11Workflow: { enabled, readonlyMaintenance },
  } as AppConfig);
}

/** 跑一次 assert,返回 `null`(放行)或它抛出的业务码。非 BizException 一律原样抛出去 —— 500 不是「被拒」。 */
function attempt(run: () => void): number | null {
  try {
    run();
    return null;
  } catch (e) {
    if (!(e instanceof BizException)) throw e;
    return e.biz.code;
  }
}

interface Probe {
  readonly v11: number | null;
  readonly legacy: number | null;
  readonly readSource: 'committed-ledger' | 'approved-attendance';
}

function probe(enabled: boolean, readonlyMaintenance: boolean): Probe {
  const g = gate(enabled, readonlyMaintenance);
  return {
    v11: attempt(() => g.assertV11WriteAllowed()),
    legacy: attempt(() => g.assertLegacyWriteAllowed()),
    readSource: g.participationReadSource(),
  };
}

const READONLY_CODE = BizCode.ACTIVITY_WORKFLOW_READONLY_MAINTENANCE.code;
const V11_OFF_CODE = BizCode.ACTIVITY_V11_WORKFLOW_NOT_ENABLED.code;
const LEGACY_CLOSED_CODE = BizCode.ACTIVITY_LEGACY_ATTENDANCE_WRITE_CLOSED.code;

describe('活动 v1.1 只读维护态(合同 §16.4)', () => {
  // ════════════════════════════════════════════════════════════════════════
  // 一、只读**开**:两个写方向都被具名码拒绝(不是 500,不是通用错)
  // ════════════════════════════════════════════════════════════════════════

  it('只读开 + 闸开:新结算真相链写被拒,且是只读态的具名码', () => {
    expect(probe(true, true).v11).toBe(READONLY_CODE);
  });

  it('只读开 + 闸开:旧考勤写也被**只读**码拒(不是「入口已关闭」)—— 只读位排在闸位之前', () => {
    expect(probe(true, true).legacy).toBe(READONLY_CODE);
  });

  it('只读开 + 闸关:新结算真相链写被**只读**码拒(不是「未启用」)', () => {
    expect(probe(false, true).v11).toBe(READONLY_CODE);
  });

  it('只读开 + 闸关:旧考勤写被拒 —— 这一格正是二值闸此前做不到的那一态', () => {
    expect(probe(false, true).legacy).toBe(READONLY_CODE);
  });

  it('只读态的码是 503(临时,可重试),不是 410 —— 维护态按定义是临时的(§16.4 ⑤)', () => {
    expect(BizCode.ACTIVITY_WORKFLOW_READONLY_MAINTENANCE.httpStatus).toBe(503);
  });

  // ════════════════════════════════════════════════════════════════════════
  // 二、只读**开**:读路径仍通 —— 否则那是停服,不是只读
  //     §16.5「已经生成的新数据模型即使应用只读,也保持可查询和可导出」
  // ════════════════════════════════════════════════════════════════════════

  // ⚠️ 这两条**刻意不走 `probe()`** —— `probe()` 同时跑两个 assert,写侧的粗变异会
  //    让读侧跟着连坐红,读数就只能证明「写侧坏了读侧也报」。只否定被测的那一维:
  //    读面的断言只碰 `participationReadSource()`(TOOL_TRAPS §7.2)。
  it('只读开 + 闸开:读源仍是 committed-ledger(与只读关时逐字相同)', () => {
    expect(gate(true, true).participationReadSource()).toBe('committed-ledger');
    expect(gate(true, true).participationReadSource()).toBe(
      gate(true, false).participationReadSource(),
    );
  });

  it('只读开 + 闸关:读源仍是 approved-attendance(与只读关时逐字相同)', () => {
    expect(gate(false, true).participationReadSource()).toBe('approved-attendance');
    expect(gate(false, true).participationReadSource()).toBe(
      gate(false, false).participationReadSource(),
    );
  });

  // ════════════════════════════════════════════════════════════════════════
  // 三、只读**关**:行为与本刀之前逐字不变(反向 —— 证明没顺手改语义)
  // ════════════════════════════════════════════════════════════════════════

  it('只读关 + 闸开:新链写放行', () => {
    expect(probe(true, false).v11).toBeNull();
  });

  it('只读关 + 闸开:旧考勤写抛「入口已关闭」(20154),不是只读码', () => {
    expect(probe(true, false).legacy).toBe(LEGACY_CLOSED_CODE);
  });

  it('只读关 + 闸关:新链写抛「未启用」(20153),不是只读码', () => {
    expect(probe(false, false).v11).toBe(V11_OFF_CODE);
  });

  it('只读关 + 闸关:旧考勤写放行(今天的行为)', () => {
    expect(probe(false, false).legacy).toBeNull();
  });

  // ════════════════════════════════════════════════════════════════════════
  // 四、🔴 合同 §16.2 红线:全状态空间里混合态**结构上不可能**
  // ════════════════════════════════════════════════════════════════════════

  it('🔴 `enabled × 只读` 四态穷举:没有任何一态同时放行「新写」与「旧写」', () => {
    const states = [
      { enabled: true, ro: true },
      { enabled: true, ro: false },
      { enabled: false, ro: true },
      { enabled: false, ro: false },
    ];
    // 非空自证:四态一个不少,否则「零个混合态」是空集恒等于空集的空绿。
    expect(states).toHaveLength(4);
    const mixed = states.filter((s) => {
      const p = probe(s.enabled, s.ro);
      return p.v11 === null && p.legacy === null;
    });
    expect(mixed).toEqual([]);
  });

  it('🔴 只读位是**纯减法**:同一 enabled 下,只读开的放行集 ⊆ 只读关的放行集', () => {
    for (const enabled of [true, false]) {
      const on = probe(enabled, true);
      const off = probe(enabled, false);
      // 「放行」= null。只读开时若某个方向放行,只读关时必须也放行。
      if (on.v11 === null) expect(off.v11).toBeNull();
      if (on.legacy === null) expect(off.legacy).toBeNull();
    }
  });

  it('🔴 只读位不是空开关:两个 enabled 下,只读都真的把放行集变**严格**小了', () => {
    for (const enabled of [true, false]) {
      const openCount = [probe(enabled, false).v11, probe(enabled, false).legacy].filter(
        (c) => c === null,
      ).length;
      const roCount = [probe(enabled, true).v11, probe(enabled, true).legacy].filter(
        (c) => c === null,
      ).length;
      expect(roCount).toBeLessThan(openCount);
    }
  });

  // ════════════════════════════════════════════════════════════════════════
  // 五、结构:只读位的**单一读取处**
  //     C1 已经把 `activityV11Workflow` 钉死在闸文件上,只读位住在那个命名空间里
  //     故自动继承;本条另外把它自己的两个标识符也钉住,防「有人绕开闸直接读 env」。
  // ════════════════════════════════════════════════════════════════════════

  it('只读位的两个标识符在生产代码里只出现在 app.config.ts 与闸文件(集合相等,不是子集)', () => {
    const files = collectProdFiles();
    // 非空自证:扫描面塌了会让「零违规」变成空绿。
    expect(files.length).toBeGreaterThan(100);

    const hits = new Set<string>();
    for (const file of files) {
      const rel = relative(REPO_ROOT, file).split('\\').join('/');
      const src = ts.createSourceFile(rel, readSource(rel), ts.ScriptTarget.Latest, true);
      const scan = (node: ts.Node): void => {
        if (
          (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) &&
          READONLY_TOKENS.includes(node.text)
        ) {
          hits.add(rel);
        }
        ts.forEachChild(node, scan);
      };
      ts.forEachChild(src, scan);
    }
    expect([...hits].sort()).toEqual([...READONLY_TOKEN_ALLOWLIST].sort());
  });

  // ════════════════════════════════════════════════════════════════════════
  // 六、配置解析:严格取值 + **刻意不 fail-fast** 的那条设计决定
  // ════════════════════════════════════════════════════════════════════════

  it('未设置 ⇒ false(不在维护态)', () => {
    expect(parseActivityWorkflowReadonly(undefined)).toBe(false);
  });

  it('空串 / 纯空白 ⇒ false', () => {
    expect(parseActivityWorkflowReadonly('')).toBe(false);
    expect(parseActivityWorkflowReadonly('   ')).toBe(false);
  });

  it("'true' ⇒ true", () => {
    expect(parseActivityWorkflowReadonly('true')).toBe(true);
  });

  it("'false' ⇒ false", () => {
    expect(parseActivityWorkflowReadonly('false')).toBe(false);
  });

  it('🔴 打错字一律抛错拒启 —— 「被当成 false 静默放行写入」是只读态最不能有的失败方向', () => {
    for (const raw of ['ture', 'TRUE', 'True', '1', 'yes', 'on']) {
      expect(() => parseActivityWorkflowReadonly(raw)).toThrow(/ACTIVITY_WORKFLOW_READONLY/);
    }
  });

  it('🔴 production 下未设置**不**拒启 —— 这是刻意的设计决定,不是漏写(理由见 app.config.ts 头注)', () => {
    // 本项没有 env 参数,故「production 下的行为」= 与其它环境完全一致。
    // 这条断言的意义是:哪天有人把它改成 production 必填,这里必须当场红,
    // 逼他连同 .github/workflows/docker-smoke.yml(红区,C7 会要求)一起改。
    expect(parseActivityWorkflowReadonly.length).toBe(1);
    expect(parseActivityWorkflowReadonly(undefined)).toBe(false);
  });
});
