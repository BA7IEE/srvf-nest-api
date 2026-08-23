import {
  DECLARED_TEST_CONFIGS,
  ENV_EXAMPLE_REQUIRED_SAMPLE,
  GATE_FILE,
  SMOKE_WORKFLOW_FILE,
  LEGACY_ASSERT,
  READ_SOURCE,
  REVERSE_GATE_MARKERS,
  V11_ASSERT,
  controlAllReadFacesDetached,
  controlEnvExampleMissingRequired,
  readSource,
  runCriteria,
} from '../../../scripts/check-activity-workflow-gate';

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
const INSURANCE_ASSEMBLER = 'test/e2e/insurance-config-fail-fast.e2e-spec.ts';
const WORKER_MODULE = 'src/modules/activities/activity-batch-worker.module.ts';
const TEAM_JOIN_PROBE = 'src/modules/team-join/team-join-enrollment.service.ts';
const ACTIVITY_PARTICIPATION = 'src/modules/activities/activity-participation-query.service.ts';
const META_OVERVIEW = 'src/modules/meta/participation-overview-query.service.ts';
const TEAM_JOIN_PROGRESS = 'src/modules/team-join/team-join-progress.ts';
/** 与考勤毫无关系的纯函数文件 —— C8 反对照的宿主(证明发现靠规则不靠文件名)。 */
const NEUTRAL_UTIL = 'src/common/identity/member-label.util.ts';

/** 同一段读取,但放在一个**写旧链的 class method** 里 —— 链内部的形状。 */
const SYNTHETIC_READ_FACE_IN_WRITING_CLASS = `
export class ProbeWritingService {
  constructor(private readonly prisma: any) {}
  async probeServiceHours(): Promise<unknown[]> {
    await this.prisma.attendanceSheet.update({ where: { id: 'x' }, data: {} });
    return this.prisma.attendanceRecord.findMany({
      where: { deletedAt: null },
      select: { memberId: true, serviceHours: true },
    });
  }
}
`;

/** 一个「读 attendanceRecord 且产出 serviceHours」的读面,不接闸。 */
const SYNTHETIC_READ_FACE = `
export async function probeServiceHours(prisma: any): Promise<unknown[]> {
  return prisma.attendanceRecord.findMany({
    where: { deletedAt: null },
    select: { memberId: true, serviceHours: true },
  });
}
`;

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
      expect(counts.productionRequiredEnv).toBeGreaterThan(0);
      expect(counts.settlementReadFaces).toBeGreaterThan(0);
    });
  });

  describe('C1 正对照:任一处另读一遍配置 ⇒ 必红', () => {
    it('把读面改成自己读 config 而不是问闸 ⇒ C1 红在该文件', () => {
      const original = readSource(SUMMARY);
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
      const original = readSource(PUNCH);
      const mutated = original.split(`this.activityWorkflowGate.${V11_ASSERT}();`).join('');
      expect(mutated).not.toBe(original);

      const { findings } = runCriteria({ [PUNCH]: mutated });
      const c2 = findings.filter((f) => f.criterion === 'C2');
      expect(c2.some((f) => f.detail.includes('selfPunch()'))).toBe(true);
    });

    it('拆掉旧考勤审批链的判闸位 ⇒ C2 红在 approve 等公开入口', () => {
      const original = readSource(REVIEW);
      const mutated = original.split(`this.activityWorkflowGate.${LEGACY_ASSERT}();`).join('');
      expect(mutated).not.toBe(original);

      const { findings } = runCriteria({ [REVIEW]: mutated });
      const c2 = findings.filter((f) => f.criterion === 'C2');
      expect(c2.some((f) => f.detail.includes('approve()'))).toBe(true);
    });

    it('把判闸位换成写死 true ⇒ 仍然红(闸必须真的被问到,不是摆个 if)', () => {
      const original = readSource(PUNCH);
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
      // ⚠️ 2026-08-21(第六轮评审 B-01)起,这条变异必须**摘掉全部三处读面的闸**才会红。
      //    原因正是 C3 的粒度:它只断言「全仓至少有一个文件调过闸的读面方法」,
      //    **一处接了就绿**。当年只有一处读面接闸时,摘掉那一处就红;如今有三处,
      //    摘掉一处剩下两处仍然 >0。⇒ **C3 对「第二、第三处漏进来」结构性失明**,
      //    这正是 C8 存在的理由。两条判据粒度不同、都要留着。
      const control = controlAllReadFacesDetached();
      expect(control.changed).toBe(true);

      const c3 = control.findings.filter((f) => f.criterion === 'C3');
      expect(c3.some((f) => f.detail.includes(READ_SOURCE))).toBe(true);
    });
  });

  describe('C4 反向闸:入队门槛恒按 approved 算,接了闸反而要红', () => {
    it('让 team-join 引用闸 ⇒ C4 红', () => {
      // 这一条守的是**刻意的不一致**:维护者拍板 computeCappedContribution 与入队门槛
      // 不随 v1.1 闸切换。后人「顺手统一」会悄悄改掉入队门槛的业务口径,故上反向闸。
      // 变异用**真代码**而不是注释:注释也能触发 C4(它按文本判,刻意从宽 ——
      // 入队门槛文件里连提到闸都该引起复核),但正对照必须演示真实缺陷的形状。
      const original = readSource(TEAM_JOIN_PROBE);
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
      const original = readSource(WORKER_MODULE);
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

  describe('C7 正对照:production-like 启动点漏设 fail-fast 配置项 ⇒ 必红', () => {
    it('从 smoke 启动块里删掉本刀的闸位 env ⇒ C7 红并点名它', () => {
      // 这条复现的是**本刀真实撞上的 CI 红**:闸位配置在 production / smoke 下空值拒启,
      // 而 smoke workflow 一处也没设它 ⇒ 容器起不来,CI 只报「App not ready after 60s」,
      // **完全不点名是哪个 env 缺了**(本仓教训:失败消息说错方向比不说更费人)。
      // C7 的价值不只是「能发现」,更是**发现时直接说出是谁** ——
      // 下面断言里要求 detail 必须含变量名,就是在钉这一点。
      const original = readSource(SMOKE_WORKFLOW_FILE);
      const mutated = original.split('-e ACTIVITY_V11_WORKFLOW_ENABLED=false \\\n').join('');
      expect(mutated).not.toBe(original);

      const { findings } = runCriteria({ [SMOKE_WORKFLOW_FILE]: mutated });
      const c7 = findings.filter((f) => f.criterion === 'C7');
      expect(c7.length).toBeGreaterThan(0);
      expect(c7.some((f) => f.detail.includes('ACTIVITY_V11_WORKFLOW_ENABLED'))).toBe(true);
    });

    it('从 .env.example 里删掉一个必填项 ⇒ C7 红(字段权威源侧)', () => {
      // deployment.md 明确以 .env.example 为字段权威源:维护者照它做生产 env-file。
      // 漏一项 ⇒ 生产容器起不来。这一侧与 smoke 侧共用同一份「必填清单」,
      // 任一侧红都证明清单是从 app.config.ts 真反推出来的,不是手写死的。
      const control = controlEnvExampleMissingRequired();
      expect(control.changed).toBe(true);

      const c7 = control.findings.filter((f) => f.criterion === 'C7');
      expect(c7.some((f) => f.detail.includes(ENV_EXAMPLE_REQUIRED_SAMPLE))).toBe(true);
    });
  });

  describe('C7-b 正对照:自建 production-like 配置的地方漏设必填项 ⇒ 必红', () => {
    const SYNTHETIC_ASSEMBLER = 'test/helpers/http-server.ts';

    it('把一个普通 helper 变成 production 组装点(什么都不设)⇒ C7 发现它并报缺项', () => {
      // 这条同时证明两件事:
      //   ① **发现是靠规则不是靠硬编码** —— 一个此前完全不是组装点的文件,
      //      只要把 APP_ENV 赋成 production 就会被纳入看守;
      //   ② 纳入后确实逐项比对必填清单。
      // 现实意义:将来再冒出第 2 个 `insurance-config-fail-fast` 那样的 spec,
      // 不需要有人记得来改清单,判据自己会把它圈进来。
      const original = readSource(SYNTHETIC_ASSEMBLER);
      const mutated = `${original}\n// synthetic assembler\nprocess.env.APP_ENV = 'production';\n`;
      expect(mutated).not.toBe(original);

      const { findings } = runCriteria({ [SYNTHETIC_ASSEMBLER]: mutated });
      const c7 = findings.filter((f) => f.criterion === 'C7');
      expect(c7.some((f) => f.detail.includes(SYNTHETIC_ASSEMBLER))).toBe(true);
    });

    it('真实组装点删掉闸位 env ⇒ C7 红并点名它', () => {
      // insurance-config-fail-fast 自建 production 环境验「空值拒启」。新增必填项后,
      // 装配会**先**因新项抛错 ⇒ 它原本要断言的那个错根本走不到(CI 现场就是这样红的)。
      const original = readSource(INSURANCE_ASSEMBLER);
      const mutated = original
        .split("process.env.ACTIVITY_V11_WORKFLOW_ENABLED = 'false';")
        .join('');
      expect(mutated).not.toBe(original);

      const { findings } = runCriteria({ [INSURANCE_ASSEMBLER]: mutated });
      const c7 = findings.filter((f) => f.criterion === 'C7');
      expect(
        c7.some(
          (f) =>
            f.detail.includes(INSURANCE_ASSEMBLER) &&
            f.detail.includes('ACTIVITY_V11_WORKFLOW_ENABLED'),
        ),
      ).toBe(true);
    });
  });

  describe('C8:凡「对外产出工时/贡献值」的读面都必须问闸', () => {
    // 🔴 这一条守的缺陷,C1–C7 一条都抓不到,而且它**真的发生过** ——
    //    v1.1 闸落地时全仓只有 participation-summary 一处读面接了闸,另外几处
    //    「对外产出工时」的读面一处也没接。C3 只断言「至少有一个文件调过闸的读面方法」,
    //    **一处接了就绿**,对「第二、第三处漏进来」结构性失明(与本仓已登记的
    //    「漏进家族」同形)。C8 把粒度从「全仓至少一处」下沉到「每一个读面各自」。

    it.each([
      ['逐活动对账 / 参与汇总', ACTIVITY_PARTICIPATION],
      ['月度参与概览', META_OVERVIEW],
      ['队员参与汇总', SUMMARY],
    ])('正对照:%s 摘掉判闸位 ⇒ C8 红并点名该文件', (_label, target) => {
      const original = readSource(target);
      const mutated = original
        .split(`this.activityWorkflowGate.${READ_SOURCE}()`)
        .join("('approved-attendance' as const)");
      // 变异必须真的落在目标行上 —— 否则「判据没红」证明不了任何事。
      expect(mutated).not.toBe(original);

      const { findings } = runCriteria({ [target]: mutated });
      const c8 = findings.filter((f) => f.criterion === 'C8');
      expect(c8.length).toBeGreaterThan(0);
      expect(c8.some((f) => f.detail.includes(target))).toBe(true);
      // 报错必须点名「漏了什么」,不能只说「有问题」。
      expect(c8.some((f) => f.detail.includes('serviceHours'))).toBe(true);
    });

    it('反对照:凭空新增一个不接闸的读面 ⇒ C8 红(证明扫描面是动态的,不是写死的四个文件名)', () => {
      // 宿主是 `common/identity/member-label.util.ts` —— 纯函数、不碰 Prisma、
      // 与考勤毫无关系。它此前完全不在任何读面清单里,只要「读 attendanceRecord 且
      // select 了结算列」就会被圈进来 ⇒ **发现靠规则,不靠文件名**。
      // 现实意义:将来冒出第 5 处读面,不需要有人记得回来改清单。
      const original = readSource(NEUTRAL_UTIL);
      const mutated = `${original}\n${SYNTHETIC_READ_FACE}`;
      expect(mutated).not.toBe(original);
      // 先证明它本来不在看守范围内,否则「红了」可能只是它一直就红。
      expect(runCriteria().findings.some((f) => f.detail.includes(NEUTRAL_UTIL))).toBe(false);

      const { findings, counts } = runCriteria({ [NEUTRAL_UTIL]: mutated });
      const c8 = findings.filter((f) => f.criterion === 'C8');
      expect(c8.some((f) => f.detail.includes(NEUTRAL_UTIL))).toBe(true);
      expect(c8.some((f) => f.detail.includes('probeServiceHours'))).toBe(true);
      // 看守面确实多了一个 —— 证明是「纳入后判红」而不是「碰巧红在别处」。
      expect(counts.settlementReadFaces).toBe(runCriteria().counts.settlementReadFaces + 1);
    });

    it('豁免不是万能逃生门:同一段读取放进「写旧链的 class method」⇒ 转由 C2 管,C8 不再点名它', () => {
      // 这条证明判据②(「这个函数写不写受控链」)**真的在区分**,而不是恒真的摆设:
      // 同一段读取,只因为同一个方法里多了一次旧链写入,就从「对外读面」变成「链内部」。
      //
      // 用 class method 而不是自由函数,是因为 C2 的判闸位分析只遍历 class method ——
      // 豁免必须落在**另一条判据真的有牙**的地方,否则就是两条判据互相甩锅。
      // (C8 的豁免因此也钉死 `isMethod`,自由函数写旧链照样红。)
      const mutated = `${readSource(NEUTRAL_UTIL)}\n${SYNTHETIC_READ_FACE_IN_WRITING_CLASS}`;
      const { findings } = runCriteria({ [NEUTRAL_UTIL]: mutated });

      expect(
        findings.filter((f) => f.criterion === 'C8').some((f) => f.detail.includes(NEUTRAL_UTIL)),
      ).toBe(false);
      // 而写侧确实被另一条判据接住了 —— 豁免没有把缺陷放跑。
      expect(
        findings
          .filter((f) => f.criterion === 'C2')
          .some((f) => f.detail.includes('probeServiceHours')),
      ).toBe(true);
    });

    it('自由函数写旧链**不给**豁免:C2 看不见它,C8 就必须接住(不留交叉空档)', () => {
      // C2 的 analyzeFile 只遍历 class method ⇒ 自由函数是它的结构盲区。
      // 若 C8 在这里也豁免,一个「既写旧链又读结算量」的自由函数会同时逃过两条判据。
      const withWrite = SYNTHETIC_READ_FACE.replace(
        '  return prisma.attendanceRecord.findMany({',
        "  await prisma.attendanceSheet.update({ where: { id: 'x' }, data: {} });\n  return prisma.attendanceRecord.findMany({",
      );
      expect(withWrite).not.toBe(SYNTHETIC_READ_FACE);

      const { findings } = runCriteria({
        [NEUTRAL_UTIL]: `${readSource(NEUTRAL_UTIL)}\n${withWrite}`,
      });
      // C2 确实没抓到(记录这条盲区的实测读数,不是猜的)。
      expect(
        findings
          .filter((f) => f.criterion === 'C2')
          .some((f) => f.detail.includes('probeServiceHours')),
      ).toBe(false);
      // 所以 C8 必须红。
      expect(
        findings
          .filter((f) => f.criterion === 'C8')
          .some((f) => f.detail.includes('probeServiceHours')),
      ).toBe(true);
    });

    it('C4 与 C8 按构造不可能互相矛盾:反向闸领地被 C8 整体豁免', () => {
      // team-join-progress 确实「读 attendanceRecord 且 select 了 contributionPoints」,
      // 形状上完全命中 C8 的定义域 —— 但维护者已拍板入队门槛恒按 approved 算,
      // 接了闸反而由 C4 判红。两条判据**复用同一份 REVERSE_GATE_MARKERS**,
      // 故「C8 要求接闸、C4 禁止接闸」这种自相矛盾在结构上不可能出现。
      const text = readSource(TEAM_JOIN_PROGRESS);
      expect(text).toContain('contributionPoints');
      expect(text).toContain('attendanceRecord.findMany');
      expect(REVERSE_GATE_MARKERS.some((marker) => TEAM_JOIN_PROGRESS.includes(marker))).toBe(true);

      const { findings } = runCriteria();
      expect(findings.some((f) => f.detail.includes(TEAM_JOIN_PROGRESS))).toBe(false);
    });
  });

  describe('闸文件自身', () => {
    it('gate 是 src 生产代码里唯一读取 ACTIVITY_V11_WORKFLOW_ENABLED 的地方', () => {
      const gate = readSource(GATE_FILE);
      // 三项受控面全部经由 isV11Enabled();闸只在这一处碰配置。
      expect(gate).toContain('this.config.activityV11Workflow.enabled');
      expect(gate.split('this.config.activityV11Workflow.enabled').length - 1).toBe(1);
    });
  });
});
