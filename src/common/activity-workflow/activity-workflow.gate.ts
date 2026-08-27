import { Inject, Injectable } from '@nestjs/common';

import appConfig from '../../config/app.config';
import type { AppConfig } from '../../config/app.config';
import { BizCode } from '../exceptions/biz-code.constant';
import { BizException } from '../exceptions/biz.exception';

/**
 * 活动 v1.1 上线切换闸 —— 合同 §16.2 的**单一 cutover gate**。
 *
 * 合同红线原文:「不能拆成多个可独立开启的开关让同一实例进入『新打卡＋旧结算』混合状态。
 * 子能力可以有 UI 灰度,但业务真相切换必须单轨。」
 *
 * 执行位在于**本类是 `ACTIVITY_V11_WORKFLOW_ENABLED` 在 src 生产代码里的唯一读取处**:
 * 三项受控面(新结算真相写 / 旧考勤写 / 统计读面取数)全部经由本类取值,谁都无法各读各的开关。
 * 这条「唯一读取处」由 `pnpm gate:v11:check` 机器执法:把任一项改成读别的开关或写死
 * true / false,判据立刻转红(该脚本自带正对照,见 activity-workflow-gate.spec.ts)。
 *
 * ⚠️ 闸控范围**不是**合同字面的全部五项。维护者 2026-08-19 拍板:只闸**结算真相链**
 * (Punch / Settlement / Ledger / Closure / Correction)。原因是实测发现 `ActivitySession`
 * 写是**两条路径的共用前置** —— 发布活动硬性要求 live session
 * (`ACTIVITY_PUBLISH_REVIEW_LIVE_SESSION_REQUIRED`),而旧 AttendanceSheet 链只能在
 * 已发布活动上跑;若闸关时连 Session 写一起拒绝,活动根本发布不了,旧写路径会跟着一起死,
 * 那就违反了「闸关 ⇒ 旧写路径放行(今天的行为)」这条安全底线。
 * 合同点名要防的混合态是「新打卡＋旧结算」—— 两端都在本类闸控的结算真相链里。
 *
 * ──────────────────────────────────────────────────────────────────────────
 * 第三态:只读维护(合同 §16.4,2026-08-26 维护者拍板「现在做,用现成的闸,不建镜像」)
 *
 * §16.4 给了两条路:(i) gate 切为拒绝新写;(ii) 部署只读维护镜像。选了 (i)。
 *
 * 🔴 **为什么二值闸做不到这件事** —— 这是本次改动的全部理由:
 * 上线后(闸开)发现严重问题时,把 `ACTIVITY_V11_WORKFLOW_ENABLED` 关掉**不等于**
 * 「拒绝新写」,它同时**放开了旧考勤写路径**(见 `assertLegacyWriteAllowed`),
 * 而合同 §16.4 第 5 条逐字写着「修复版本沿相同新模型继续,**不能切回旧表写入**」。
 * ⇒ 二值闸的两端**都不是**「两边都拒」,§16.4 要的那一态在此前物理上不存在。
 *
 * 所以加的是 `ACTIVITY_WORKFLOW_READONLY`,而它:
 *   · **只做减法**:两个 assert 里各排在最前、只抛不放行 ⇒ 它不可能放行任何原本被拒的写。
 *   · **不碰真相轨**:`participationReadSource()` 一个字都不看它(§16.5「已生成的新数据模型
 *     即使应用只读,也保持可查询和可导出」);读路径因此照旧全通。
 *   · **不制造混合态**:`v11放行 ∧ legacy放行 ≡ false` 在 `enabled × 只读` 全部四态成立
 *     —— 判据逐态跑过,见 `activity-workflow-readonly.spec.ts`。
 *
 * ⚠️ **边界要说准,别读成「全站只读」**:本类的闸控范围就是结算真相链
 * (见上一段维护者 2026-08-19 的收窄),只读态**继承同一个范围** ——
 * 报名、活动编辑、通知、用户管理等等**照常可写**。合同 §16.4 那条要的「只读维护版本」
 * 若指全站,那是路 (ii) 的事,本类给不了。
 *
 * ──────────────────────────────────────────────────────────────────────────
 * 为什么只冻一半 —— 维护者 2026-08-26 拍板,原话记在这里
 *
 * > **只冻结算链,不做全站只读。**
 * > 出问题最可能出在结算(并发、关账、更正、账本这几样最复杂);
 * > 而报名、查数据这些**不产生新账**,冻它们没有止血作用,只是让人用不了。
 * > ⚠️ **随时可以再加「全站只读」,反过来很难。**
 *
 * **怎么用**:上线后发现结算在持续产生错账时,按下它立刻止血,而系统其余部分照常。
 *
 * 🔴 这一段是给**三年后问「为什么只冻一半」的那个人**看的 —— 别删,也别改写成
 * 「因为只读态继承闸的范围」那种同义反复:那说的是**怎么实现的**,不是**为什么这么定**。
 */
@Injectable()
export class ActivityWorkflowGate {
  constructor(@Inject(appConfig.KEY) private readonly config: AppConfig) {}

  /**
   * 闸位当前取值。**这是 src 生产代码里唯一一处读 `activityV11Workflow`**;
   * 三项受控面都必须经过本类,不得自己再读一遍配置(判据 C1 机器执法)。
   */
  isV11Enabled(): boolean {
    return this.config.activityV11Workflow.enabled;
  }

  /**
   * 只读维护态当前取值(合同 §16.4)。与 `isV11Enabled()` 一样,**只有本类读得到**。
   *
   * ⚠️ 它**不是第二条真相轨**:真相走哪条仍由 `isV11Enabled()` 单轨决定
   * (`participationReadSource()` 一个字都不看本方法)。本位只回答一个问题 ——
   * 「今天还收不收写入」。
   */
  isReadonlyMaintenance(): boolean {
    return this.config.activityV11Workflow.readonlyMaintenance;
  }

  /**
   * 只读维护态的**唯一**拒绝点。刻意做成 private 且被下面两个 assert 各调一次 ——
   * 于是**每一条已经接了闸的写路径自动进入只读态**,一个调用点都不用改。
   * 合同 §16.4 给的是「gate 切为拒绝新写」这条路(而不是另建只读镜像),
   * 这个「零新增调用点」正是那条路的字面意思。
   */
  private assertNotReadonlyMaintenance(): void {
    if (this.isReadonlyMaintenance()) {
      throw new BizException(BizCode.ACTIVITY_WORKFLOW_READONLY_MAINTENANCE);
    }
  }

  /**
   * 新结算真相链写路径的判闸位:只读维护态拒绝;闸关时拒绝。
   *
   * 形状沿既有 `ACTIVITY_RESPONSIBILITY_WORKFLOW_NOT_ENABLED`(20036 / 503)——
   * 「开关没开」不是「状态不对」,而是本部署还没切到 v1.1,客户端据此隐藏入口。
   */
  assertV11WriteAllowed(): void {
    this.assertNotReadonlyMaintenance();
    if (!this.isV11Enabled()) {
      throw new BizException(BizCode.ACTIVITY_V11_WORKFLOW_NOT_ENABLED);
    }
  }

  /**
   * 旧 ActivityCheckIn / AttendanceSheet 写路径的判闸位:只读维护态拒绝;闸**开**时拒绝。
   *
   * 与上一个方法读同一个 `isV11Enabled()` —— 这正是「单轨」的执行位:
   * 两端不可能同时放行,故实例永远进不了合同禁止的「新打卡＋旧结算」混合态。
   *
   * 🔴 只读位**只会让拒绝面变大,不会让它变小**(两个 assert 里它都排在最前、且只抛不放行)
   * ⇒ 加了它之后混合态仍然结构上不可能:
   * `v11 放行 ∧ legacy 放行 = (enabled ∧ ¬只读) ∧ (¬enabled ∧ ¬只读) ≡ false`。
   * 判据把 `enabled × 只读` 四态逐个跑过一遍,见
   * `activity-workflow-readonly.spec.ts`。
   */
  assertLegacyWriteAllowed(): void {
    this.assertNotReadonlyMaintenance();
    if (this.isV11Enabled()) {
      throw new BizException(BizCode.ACTIVITY_LEGACY_ATTENDANCE_WRITE_CLOSED);
    }
  }

  /**
   * 「存量考勤账本化」转换刀(P1-28 第 7 批② A 案)的判闸位:唯一放行态 = 只读维护窗。
   *
   * §16.3 顺序「停旧写 → 部署 → 开闸」的中间窗,是转换唯一合法的执行时机:
   * - **常规闸关**(¬enabled ∧ ¬只读):旧终审还在产生新 approved 数据,
   *   现在转换会与后续审批竞态(转完又来一批,账本口径漏人)⇒ 拒;
   * - **闸开**(enabled):读面已切 committed,再跑转换等于对着已切换的真相补写历史
   *   ⇒ 拒(窗口已过,补写须另走更正链);
   * - **只读 ∧ 未开**(¬enabled ∧ 只读):旧写已被只读位拒绝 ⇒ 人群冻结,可转。
   *
   * ⚠️ 本方法与上面两个 assert 的关系是**第三个写方**,不是它们的放松:
   * `v11 放行 ∧ legacy 放行 ≡ false` 不因本方法改变 —— 本方法只在「两个运行时写方
   * 都被拒」的窗口里放行一个维护写方,运行时混合态仍然结构上不可能。
   */
  assertLegacyLedgerConversionAllowed(): void {
    if (!this.isReadonlyMaintenance() || this.isV11Enabled()) {
      throw new BizException(BizCode.LEGACY_LEDGER_CONVERSION_WINDOW_INVALID);
    }
  }

  /**
   * 统计读面取数源:闸开读 committed 账本,闸关读 approved 考勤(今天的行为)。
   *
   * ⚠️ 与本方法**并存但刻意不一致**的是入队门槛(team-join)与
   * `computeCappedContribution` —— 维护者已拍板它们恒按 approved 算,不随本闸切换。
   * 后人见此不一致先读这条注释,别「顺手统一」:那会改掉入队门槛的业务口径。
   * 该刻意差异由判据 C4 反向锁住(入队门槛侧不得调用本闸)。
   *
   * 🔴 **本方法刻意不看 `isReadonlyMaintenance()`**,这不是漏写:
   * 合同 §16.5 逐字要求「已经生成的新数据模型即使应用只读,也保持可查询和可导出」,
   * §16.4 第 3 条要求维护态「保留查询、任务状态、导出和审计」。
   * 只读态若顺手把读面切回旧考勤,那就是 §16.4 第 5 条禁止的「切回旧表」的读面版本。
   * ⇒ 判据把「同一个 enabled 下,只读开与关的读源必须逐字相同」单独立成一条断言。
   */
  participationReadSource(): 'committed-ledger' | 'approved-attendance' {
    return this.isV11Enabled() ? 'committed-ledger' : 'approved-attendance';
  }
}
