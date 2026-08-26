import {
  CHAIN_ANCHORS,
  MIN_ANCHOR_HOLDERS,
  MIN_IMMUTABILITY_TRIGGERS,
  MIN_INSPECTED_RELATIONS,
  MIN_PARSED_MODELS,
  MIN_SCANNED_MIGRATIONS,
  NAMED_ANCHOR_TABLES,
  NAMED_FROZEN_ANCHOR_TABLES,
  NAMED_TRIGGER_PROTECTED_TABLES,
  REQUIRED_ON_UPDATE,
  analyzeAnchorClosure,
  bogusExemptionControl,
  closedRelationIsPresent,
  describeRenumberingLeak,
  describeViolation,
  droppedUpdateLockControl,
  futureFrozenTableControl,
  futureTableControl,
  immutabilityTriggerCount,
  lockedRelationIsPresent,
  misflaggedActorRelations,
  revertedCompositeKeyControl,
  selfCheck,
  staleExemptions,
  thinExemptionReasons,
  triggerlessFrozenControl,
  unrecognisedTriggerTables,
} from '../../../scripts/check-composite-anchor-closure';

/**
 * 「多锚点表用单列外键」类闸(第六轮评审 A-2 + B-03)。
 *
 * ⚠️ **本文件只是薄运行器,实质逻辑在 `scripts/check-composite-anchor-closure.ts`。**
 *    那个文件在 selfGuard(`scripts/check-*.ts`)内,改松它要过红区人闸;
 *    而 `src/**\/*.spec.ts` 不在 selfGuard —— 把逻辑放这里等于没锁。
 *
 * 修的是**缺陷类**不是实例:不点名四张表,而是问「凡持有 ≥2 个业务锚点的模型,
 * 指向同链对象的外键是不是复合的」。第五张同形状的表建出来时会自动进入管辖。
 */
describe('business composite anchor closure', () => {
  const report = analyzeAnchorClosure();

  // ===========================================================================
  // 自证:先证明仪器没瞎,再报数
  //
  // 「扫描面为空 ⇒ 零违规 ⇒ 全绿」是本仓已登记的假绿形状。地板锚点全部是具名常量
  // (住在受保护的裁判里),不是写死在这里的数字 —— 写在这里的数字任何 PR 都能调小。
  // ===========================================================================

  it('self-proves the parser, the jurisdiction and the mutation precondition', () => {
    expect(selfCheck(report)).toEqual([]);
    expect(report.models.size).toBeGreaterThan(MIN_PARSED_MODELS);
    expect(report.holders.length).toBeGreaterThanOrEqual(MIN_ANCHOR_HOLDERS);
    expect(report.inspectedRelations).toBeGreaterThanOrEqual(MIN_INSPECTED_RELATIONS);
    expect(closedRelationIsPresent()).toBe(true);
  });

  it('parses the schema into a non-empty model graph', () => {
    // 解析器认得出标量、关系、复合 unique 三样,缺一样都会让主断言静默变绿。
    const identity = report.models.get('ActivityParticipationIdentity');
    expect(identity).toBeDefined();
    expect(identity?.scalars.has('activityId')).toBe(true);
    expect(identity?.relations.some((r) => r.name === 'session')).toBe(true);
    expect(identity?.uniques.some((u) => u.includes('id') && u.includes('activityId'))).toBe(true);
  });

  it('discovers the anchor-holding models dynamically, including the four named tables', () => {
    // 地板:不写死总数,只钉住「至少这些必须在管辖内」。
    // 管辖面远不止那四张 —— 写死四张名单的判据看不见其余表。
    expect(report.holders.map((model) => model.name)).toEqual(
      expect.arrayContaining(NAMED_ANCHOR_TABLES),
    );
  });

  // ===========================================================================
  // 主断言
  // ===========================================================================

  it('closes every same-chain foreign key on anchor-holding models', () => {
    // 报的是人话描述而不是裸对象:失败输出里直接看到「哪个模型、哪个关系、
    // 缺哪个锚点、该用哪个 unique」。
    //
    // 修法二选一:① 把缺失的锚点列加进 @relation 的 fields/references(并在被引用侧
    // 补 @@unique);② 确属正确的单列外键 ⇒ 加进 ANCHOR_CLOSURE_EXEMPTIONS 并写明理由。
    expect(report.violations.map(describeViolation)).toEqual([]);
  });

  // ===========================================================================
  // 白名单自身的守护
  //
  // 豁免清单最容易腐烂成垃圾堆:条目留在那里,而它豁免的东西早就不存在了 ——
  // 下一个人读到清单会以为「这几处是故意不闭合的」,其实是没人清理。
  // ===========================================================================

  it('keeps every exemption live — a stale exemption is itself a failure', () => {
    expect(staleExemptions(report)).toEqual([]);
  });

  it('requires every exemption to carry a substantive reason', () => {
    expect(thinExemptionReasons()).toEqual([]);
  });

  // ===========================================================================
  // 正对照:把一处已闭合的复合外键退回单列 ⇒ 判据必须当场红,并点名
  //
  // 没有这一条,一个恒返回 [] 的 findAnchorViolations 也会让主断言全绿。
  // ===========================================================================

  it('goes red when an already-closed composite foreign key is reverted to a single column', () => {
    const control = revertedCompositeKeyControl();
    expect(control.changed).toBe(true);
    expect(control.violations.length).toBeGreaterThan(0);

    // 必须点名到具体模型 + 关系 + 缺了哪个锚点,而不只是「有问题」。
    const named = control.violations.find(
      (violation) => violation.relation === 'participationIdentity',
    );
    expect(named).toBeDefined();
    expect(named?.missing).toEqual(expect.arrayContaining(['activityId', 'sessionId', 'memberId']));
    expect(describeViolation(named!)).toContain('该用外键');
  });

  // ===========================================================================
  // 反对照:新建一张同形状的表 ⇒ 判据必须也管得住
  //
  // 这一条证明扫描面是**动态**的。若把管辖范围写死成四张表的名单,下面这张
  // 全新的 `FutureAnchorTable` 不在名单里,判据会一声不吭地放过它。
  // ===========================================================================

  it('catches a brand-new anchor-holding table that nobody added to any list', () => {
    const caught = futureTableControl();
    const position = caught.find((violation) => violation.relation === 'position');

    expect(position).toBeDefined();
    expect(position?.missing).toEqual(expect.arrayContaining(['activityId', 'sessionId']));
    expect(position?.requiredUniqueOnTarget).toEqual(
      expect.arrayContaining(['id', 'activityId', 'sessionId']),
    );

    // 同一张表上的 `activity` 关系**不该**被判红 —— Activity 是链根,没有 activityId 列。
    expect(caught.map((violation) => violation.relation)).not.toContain('activity');
  });

  // ===========================================================================
  // 反向豁免对照:操作者类关系不得被误判
  //
  // 若「同链」判据改用「列名相同」而不是「目标带 activityId」,所有指向 User 的
  // operator / reviewer 关系都会因 User 也有 memberId 而被误判成漏闭合 ——
  // 那会逼着后来的人往白名单里塞十几条,白名单就此变成垃圾堆。
  // ===========================================================================

  it('never flags operator-style relations that point at global entities', () => {
    expect(misflaggedActorRelations(report)).toEqual([]);

    // 正面钉住:这些关系确实存在且确实被扫到过,否则上面是空对空。
    const punch = report.models.get('AttendancePunchEvent');
    expect(punch?.relations.map((relation) => relation.name)).toEqual(
      expect.arrayContaining(['operatorUser', 'operatorMember', 'member', 'activity']),
    );
  });

  it('uses a domain vocabulary of anchors rather than a hardcoded model list', () => {
    expect([...CHAIN_ANCHORS]).toEqual(['activityId', 'sessionId', 'memberId']);
  });

  // ===========================================================================
  // 规则 ②:冻结记录的改号锁(P2-11)
  //
  // 「冻结记录 + 复合外键」的集合里,不允许出现**既无 onUpdate: Restrict
  // 又无 BEFORE UPDATE 触发器**的成员。
  //
  // ⚠️ 下面每一维**各自成 `it`** —— jest 在一个 `it` 内首个失败即停,塞在一起时
  //    后面的断言从未被执行,而这在基线全绿时完全看不出来(TOOL_TRAPS §6.1)。
  // ===========================================================================

  it('self-proves the frozen-record jurisdiction and the trigger index', () => {
    // 管辖面塌成空集 ⇒ 零 leak ⇒ 全绿,是本规则最容易出现的假绿形状。
    expect(report.frozenHolders.map((model) => model.name)).toEqual(
      expect.arrayContaining(NAMED_FROZEN_ANCHOR_TABLES),
    );
    expect(report.scannedMigrations).toBeGreaterThanOrEqual(MIN_SCANNED_MIGRATIONS);
    expect(immutabilityTriggerCount(report)).toBeGreaterThanOrEqual(MIN_IMMUTABILITY_TRIGGERS);
    // 触发器豁免路径确实认得出那两张表,否则那条路径是死代码。
    expect(unrecognisedTriggerTables(report)).toEqual([]);
    // 变异对拍的前置:被测的那处当下确实上着锁,否则下面是空变异。
    expect(lockedRelationIsPresent()).toBe(true);
  });

  it('locks every composite foreign key on frozen anchor-holding records', () => {
    // 红时直接报人话:哪张表、哪条关系、外键列是哪几列、当前 onUpdate 是什么。
    expect(report.renumberingLeaks.map(describeRenumberingLeak)).toEqual([]);
  });

  it('goes red when a single onUpdate lock is dropped, naming the table and the relation', () => {
    const control = droppedUpdateLockControl();
    expect(control.changed).toBe(true);
    expect(control.leaks).not.toEqual([]);

    // 按「模型 + 关系」定位而不是只按关系名 —— 'position' 这个关系名在多张表上都有,
    // 只按名字找会在别的表也变红时悄悄指到另一张表去。
    const named = control.leaks.find(
      (leak) => leak.model === 'OfflinePackageParticipant' && leak.relation === 'position',
    );
    expect(named).toBeDefined();
    expect(named?.target).toBe('ActivitySessionPosition');
    expect(named?.declaredOnUpdate).toBeUndefined();
    expect(describeRenumberingLeak(named!)).toContain(REQUIRED_ON_UPDATE);
  });

  it('accepts a BEFORE UPDATE trigger as the other half of the lock', () => {
    // 把触发器索引清空 ⇒ 靠触发器过关的那两张表必须立刻变红。
    // 没有这一条,一个「什么都算受保护」的触发器扫描器也会让主断言全绿。
    const withoutTriggers = triggerlessFrozenControl().map((leak) => leak.model);
    expect([...new Set(withoutTriggers)]).toEqual(
      expect.arrayContaining(NAMED_TRIGGER_PROTECTED_TABLES),
    );
  });

  it('catches a brand-new frozen roster table that nobody added to any list', () => {
    // 证明规则 ② 的扫描面也是**动态**的:这张表不在任何名单里。
    const caught = futureFrozenTableControl();
    const position = caught.find((leak) => leak.relation === 'position');
    const session = caught.find((leak) => leak.relation === 'session');

    expect(position).toBeDefined();
    expect(session).toBeDefined();
    // 单列外键(activity)不在本规则管辖内 —— 它指的是链根的代理主键。
    expect(caught.map((leak) => leak.relation)).not.toContain('activity');
  });

  it('reports an exemption that points at a table which does not exist', () => {
    // 防腐自证(#1184 的事故形状):豁免名单指着已删/不存在的东西时,
    // `includes()` 永远不匹配 —— 不生效、不报错、不改判定、没有任何机器发现它烂了。
    // 上面那条 `staleExemptions(report)).toEqual([])` 在 staleExemptions 被改成
    // 恒返回 [] 时也照样全绿;这一条才证明它真的会红。
    expect(bogusExemptionControl(report)).not.toEqual([]);
  });
});
