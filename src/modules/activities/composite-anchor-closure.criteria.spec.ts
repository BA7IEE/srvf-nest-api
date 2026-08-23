import {
  CHAIN_ANCHORS,
  MIN_ANCHOR_HOLDERS,
  MIN_INSPECTED_RELATIONS,
  MIN_PARSED_MODELS,
  NAMED_ANCHOR_TABLES,
  analyzeAnchorClosure,
  closedRelationIsPresent,
  describeViolation,
  futureTableControl,
  misflaggedActorRelations,
  revertedCompositeKeyControl,
  selfCheck,
  staleExemptions,
  thinExemptionReasons,
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
});
