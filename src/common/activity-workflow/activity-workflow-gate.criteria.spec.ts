import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  DECLARED_TEST_CONFIGS,
  GATE_FILE,
  LEGACY_ASSERT,
  READ_SOURCE,
  REPO_ROOT,
  V11_ASSERT,
  runCriteria,
} from './activity-workflow-gate.criteria';

/**
 * 活动 v1.1 单一 cutover gate 的结构判据 —— 断言 + **正对照**。
 *
 * 🔴 本仓的硬教训:**不做正对照的结构断言等于没有**。只断言「当前是绿的」证明不了判据
 * 在缺陷出现时会变红 —— 判据可能压根没扫到目标文件、匹配写法写错、或被自己的配置遮蔽,
 * 那时「零命中」会被读成「合规」。所以下面每一条判据都配一个变异:
 * 把闸拆掉 / 绕开 / 各读各的,判据**必须转红**,且红在**指名的那一处**。
 *
 * 变异用 `runCriteria(overrides)` 在内存里替换源码,不落盘 —— 避免「变异脚本超时停在半路
 * 留下脏工作区」和「git checkout 把未提交实现一起抹掉」这两类既有事故。
 */

const PUNCH = 'src/modules/attendances/attendance-punch-command.service.ts';
const REVIEW = 'src/modules/attendances/attendance-review.service.ts';
const SUMMARY = 'src/modules/attendances/participation-summary-query.service.ts';
const JOURNEYS_KEY = 'jest-journeys.config.ts';
const WORKER_MODULE = 'src/modules/activities/activity-batch-worker.module.ts';
const TEAM_JOIN_PROBE = 'src/modules/team-join/team-join-enrollment.service.ts';

function source(relPath: string): string {
  return readFileSync(join(REPO_ROOT, relPath), 'utf8');
}

describe('活动 v1.1 cutover gate — 结构判据(合同 §16.2 执行位)', () => {
  describe('基线:当前实现四条判据全绿', () => {
    it('零 finding,且三项受控面各自确实在闸上', () => {
      const { findings, counts } = runCriteria();

      // 先打印再断言:判据红时要能一眼看到红在哪,而不是只看到 length 不等于 0。
      expect(findings.map((f) => `[${f.criterion}] ${f.detail}`)).toEqual([]);

      // 计数不是装饰:它们证明判据**真的扫到了东西**。若某个数字是 0,
      // 说明那一面根本没被覆盖 —— 「零 finding」就会是空绿而不是合规。
      expect(counts.v11GatedEntries).toBeGreaterThan(0);
      expect(counts.legacyGatedEntries).toBeGreaterThan(0);
      expect(counts.v11Files).toBeGreaterThan(0);
      expect(counts.legacyFiles).toBeGreaterThan(0);
      expect(counts.readFiles).toBeGreaterThan(0);
      expect(counts.gateDependentModules).toBeGreaterThan(0);
      expect(counts.declaredTestRoots).toBeGreaterThan(0);
    });
  });

  describe('C1 正对照:任一处另读一遍配置 ⇒ 必红', () => {
    it('把读面改成自己读 config 而不是问闸 ⇒ C1 红在该文件', () => {
      const original = source(SUMMARY);
      const mutated = original.replace(
        'this.activityWorkflowGate.participationReadSource()',
        "this.config.activityV11Workflow.enabled ? 'committed-ledger' : 'approved-attendance'",
      );
      // 变异必须真的落在目标行上 —— 否则「判据没红」证明不了任何事。
      expect(mutated).not.toBe(original);

      const { findings } = runCriteria({ [SUMMARY]: mutated });
      const c1 = findings.filter((f) => f.criterion === 'C1');
      expect(c1.length).toBeGreaterThan(0);
      expect(c1.some((f) => f.detail.includes(SUMMARY))).toBe(true);
    });
  });

  describe('C2 正对照:写路径绕开闸 ⇒ 必红', () => {
    it('拆掉打卡链的判闸位 ⇒ C2 红在 selfPunch 等公开入口', () => {
      const original = source(PUNCH);
      const mutated = original.split(`this.activityWorkflowGate.${V11_ASSERT}();`).join('');
      expect(mutated).not.toBe(original);

      const { findings } = runCriteria({ [PUNCH]: mutated });
      const c2 = findings.filter((f) => f.criterion === 'C2');
      expect(c2.some((f) => f.detail.includes('selfPunch()'))).toBe(true);
    });

    it('拆掉旧考勤审批链的判闸位 ⇒ C2 红在 approve 等公开入口', () => {
      const original = source(REVIEW);
      const mutated = original.split(`this.activityWorkflowGate.${LEGACY_ASSERT}();`).join('');
      expect(mutated).not.toBe(original);

      const { findings } = runCriteria({ [REVIEW]: mutated });
      const c2 = findings.filter((f) => f.criterion === 'C2');
      expect(c2.some((f) => f.detail.includes('approve()'))).toBe(true);
    });

    it('把判闸位换成写死 true ⇒ 仍然红(闸必须真的被问到,不是摆个 if)', () => {
      const original = source(PUNCH);
      const mutated = original
        .split(`this.activityWorkflowGate.${V11_ASSERT}();`)
        .join('if (!true) throw new Error("v11 disabled");');
      expect(mutated).not.toBe(original);

      const { findings } = runCriteria({ [PUNCH]: mutated });
      expect(findings.some((f) => f.criterion === 'C2')).toBe(true);
    });
  });

  describe('C3 正对照:某一项受控面整体脱闸 ⇒ 必红', () => {
    it('读面不再问闸 ⇒ C3 报「统计读面没有接上闸」', () => {
      const original = source(SUMMARY);
      const mutated = original
        .split(`this.activityWorkflowGate.${READ_SOURCE}()`)
        .join("('approved-attendance' as const)");
      expect(mutated).not.toBe(original);

      const { findings } = runCriteria({ [SUMMARY]: mutated });
      const c3 = findings.filter((f) => f.criterion === 'C3');
      expect(c3.some((f) => f.detail.includes(READ_SOURCE))).toBe(true);
    });
  });

  describe('C4 反向闸:入队门槛恒按 approved 算,接了闸反而要红', () => {
    it('让 team-join 引用闸 ⇒ C4 红', () => {
      // 这一条守的是**刻意的不一致**:维护者拍板 computeCappedContribution 与入队门槛
      // 不随 v1.1 闸切换。后人「顺手统一」会悄悄改掉入队门槛的业务口径,故上反向闸。
      // 变异用**真代码**而不是注释:注释也能触发 C4(它按文本判,刻意从宽 ——
      // 入队门槛文件里连提到闸都该引起复核),但正对照必须演示真实缺陷的形状。
      const original = source(TEAM_JOIN_PROBE);
      const mutated = original.replace(
        'export class',
        `const probe = (gate: ActivityWorkflowGate): boolean => gate.isV11Enabled();\nvoid probe;\nexport class`,
      );
      expect(mutated).not.toBe(original);

      const { findings } = runCriteria({ [TEAM_JOIN_PROBE]: mutated });
      const c4 = findings.filter((f) => f.criterion === 'C4');
      expect(c4.length).toBeGreaterThan(0);
      expect(c4.some((f) => f.detail.includes(TEAM_JOIN_PROBE))).toBe(true);
    });
  });

  describe('C5 正对照:受闸 service 的模块漏 import 闸 ⇒ 必红', () => {
    it('把 worker 模块的 ActivityWorkflowModule 去掉 ⇒ C5 红在该模块', () => {
      // 这条正对照复现的是**本刀实测踩到的真实事故**:两个 worker 进程各建独立
      // application context,该模块 providers 里有账本 prepare / commit 却没 import 闸 ⇒
      // 整个 worker 起不来。当时全部 unit spec 是绿的,只有 e2e 在
      // createApplicationContext 处炸 —— C5 把这一类缺陷从「运行时才炸」提前成「静态可判」。
      const original = source(WORKER_MODULE);
      const mutated = original
        .split('ActivityWorkflowModule')
        .join('__GateModuleRemovedByMutation__');
      expect(mutated).not.toBe(original);

      const { findings } = runCriteria({ [WORKER_MODULE]: mutated });
      const c5 = findings.filter((f) => f.criterion === 'C5');
      expect(c5.length).toBeGreaterThan(0);
      expect(c5.some((f) => f.detail.includes(WORKER_MODULE))).toBe(true);
    });
  });

  describe('C6 正对照:测试根漏登记 ⇒ 必红', () => {
    it('把 jest-journeys 从清单里拿掉 ⇒ C6 红并点名它', () => {
      // 这条复现的是**本刀真实踩到、且 C1–C5 一条都没抓到**的缺口:
      // test/journeys/ 被 jest-e2e.config.ts 的 testPathIgnorePatterns **显式排除**,
      // 是独立 jest project;我按「跑 e2e 看谁红」定闸位姿态,整个 journeys 根从没被跑过,
      // 直到 CI 把「金五条③考勤修正全链」撞红。
      // C1–C5 全在 src/** 上判,**结构上看不见测试目录** —— 那是它们的盲区。
      //
      // 真实目录不可变(readdirSync 读真源),故从**清单侧**证伪:漏登一个真实存在的根 ⇒ 必红。
      const withoutJourneys = Object.fromEntries(
        Object.entries(DECLARED_TEST_CONFIGS).filter(([key]) => key !== JOURNEYS_KEY),
      );
      expect(Object.keys(withoutJourneys)).not.toContain(JOURNEYS_KEY);

      const { findings } = runCriteria({}, withoutJourneys);
      const c6 = findings.filter((f) => f.criterion === 'C6');
      expect(c6.length).toBeGreaterThan(0);
      expect(c6.some((f) => f.detail.includes(JOURNEYS_KEY))).toBe(true);
    });

    it('清单登记了不存在的配置 ⇒ C6 红(另一侧:清单与真源脱节)', () => {
      const { findings } = runCriteria(
        {},
        {
          ...DECLARED_TEST_CONFIGS,
          'jest-does-not-exist.config.ts': '不存在的根',
        },
      );
      const c6 = findings.filter((f) => f.criterion === 'C6');
      expect(c6.some((f) => f.detail.includes('jest-does-not-exist.config.ts'))).toBe(true);
    });
  });

  describe('闸文件自身', () => {
    it('gate 是 src 生产代码里唯一读取 ACTIVITY_V11_WORKFLOW_ENABLED 的地方', () => {
      const gate = source(GATE_FILE);
      // 三项受控面全部经由 isV11Enabled();闸只在这一处碰配置。
      expect(gate).toContain('this.config.activityV11Workflow.enabled');
      expect(gate.split('this.config.activityV11Workflow.enabled').length - 1).toBe(1);
    });
  });
});
