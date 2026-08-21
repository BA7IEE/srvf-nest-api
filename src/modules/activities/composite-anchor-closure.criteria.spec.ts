import {
  ANCHOR_CLOSURE_EXEMPTIONS,
  CHAIN_ANCHORS,
  describeViolation,
  findAnchorHolders,
  findAnchorViolations,
  isExempt,
  parsePrismaModels,
  readSchemaText,
} from './composite-anchor-closure.criteria';

/**
 * 「多锚点表用单列外键」类闸(第六轮评审 A-2 + B-03)。
 *
 * 修的是**缺陷类**不是实例:不点名四张表,而是问「凡持有 ≥2 个业务锚点的模型,
 * 指向同链对象的外键是不是复合的」。第五张同形状的表建出来时会自动进入管辖。
 */
describe('business composite anchor closure', () => {
  const schemaText = readSchemaText();
  const models = parsePrismaModels(schemaText);
  const holders = findAnchorHolders(models);

  // ===========================================================================
  // 自证:先证明仪器没瞎,再报数
  //
  // 「扫描面为空 ⇒ 零违规 ⇒ 全绿」是本仓已登记的假绿形状。下面几条用**地板锚点**
  // (至少有多少 / 至少包含谁)而不是「恰好 N 条」—— 写死数量的自证会在下次加表时
  // 过期,然后被人顺手改大,判据就此失去意义。
  // ===========================================================================

  it('parses the schema into a non-empty model graph', () => {
    expect(models.size).toBeGreaterThan(80);
    // 解析器认得出标量、关系、复合 unique 三样,缺一样都会让主断言静默变绿。
    const identity = models.get('ActivityParticipationIdentity');
    expect(identity).toBeDefined();
    expect(identity?.scalars.has('activityId')).toBe(true);
    expect(identity?.relations.some((r) => r.name === 'session')).toBe(true);
    expect(identity?.uniques.some((u) => u.includes('id') && u.includes('activityId'))).toBe(true);
  });

  it('discovers the anchor-holding models dynamically, including the four named tables', () => {
    const names = holders.map((model) => model.name);
    // 地板:不写死总数,只钉住「至少这些必须在管辖内」。
    for (const table of [
      'ActivityParticipationIdentity',
      'AttendancePunchEvent',
      'ParticipationLedgerEntry',
      'OfflinePackageParticipant',
    ]) {
      expect(names).toContain(table);
    }
    // 管辖面远不止那四张 —— 写死四张名单的判据看不见其余表。
    expect(holders.length).toBeGreaterThanOrEqual(15);
  });

  it('inspects a non-trivial number of to-one relations', () => {
    const inspected = holders
      .flatMap((model) => model.relations)
      .filter((relation) => !relation.list && relation.fields.length > 0);
    expect(inspected.length).toBeGreaterThanOrEqual(50);
  });

  // ===========================================================================
  // 主断言
  // ===========================================================================

  it('closes every same-chain foreign key on anchor-holding models', () => {
    const violations = findAnchorViolations(models).filter(
      (violation) => !isExempt(violation.model, violation.relation),
    );

    if (violations.length > 0) {
      throw new Error(
        `发现 ${violations.length} 处「多锚点表用单列外键」——\n` +
          `这些外键只证明目标 ID 存在,不证明它与本行属于同一条业务主链:\n\n` +
          violations.map(describeViolation).join('\n\n') +
          `\n\n修法二选一:\n` +
          `  1) 把缺失的锚点列加进 @relation 的 fields/references(并在被引用侧补 @@unique);\n` +
          `  2) 确属正确的单列外键 ⇒ 加进 ANCHOR_CLOSURE_EXEMPTIONS,并写明**指向权威源**的理由。`,
      );
    }
    expect(violations).toEqual([]);
  });

  // ===========================================================================
  // 白名单自身的守护
  //
  // 豁免清单最容易腐烂成垃圾堆:条目留在那里,而它豁免的东西早就不存在了 ——
  // 下一个人读到清单会以为「这几处是故意不闭合的」,其实是没人清理。
  // 这里反过来要求:每一条豁免都必须**当下真的对应一处违规**。
  // ===========================================================================

  it('keeps every exemption live — a stale exemption is itself a failure', () => {
    const raw = findAnchorViolations(models);
    const stale = ANCHOR_CLOSURE_EXEMPTIONS.filter(
      (exemption) =>
        !raw.some(
          (violation) =>
            violation.model === exemption.model && violation.relation === exemption.relation,
        ),
    );
    // 空数组即通过;非空时报出的就是「已经没有对应违规」的那几条豁免,
    // 说明关系已闭合或已被删除,豁免应当一并删掉。
    expect(stale.map((item) => `${item.model}.${item.relation}`)).toEqual([]);
  });

  it('requires every exemption to carry a substantive reason', () => {
    for (const exemption of ANCHOR_CLOSURE_EXEMPTIONS) {
      expect(exemption.reason.length).toBeGreaterThan(20);
    }
  });

  // ===========================================================================
  // 正对照:把一处已闭合的复合外键退回单列 ⇒ 判据必须当场红,并点名
  //
  // 没有这一条,一个恒返回 [] 的 findAnchorViolations 也会让主断言全绿。
  // ===========================================================================

  it('goes red when an already-closed composite foreign key is reverted to a single column', () => {
    const closed =
      'participationIdentity ActivityParticipationIdentity @relation(fields: [participationIdentityId, activityId, sessionId, memberId], references: [id, activityId, sessionId, memberId], onDelete: Restrict)';
    const normalised = schemaText.replace(/[ \t]+/g, ' ');
    expect(normalised).toContain(closed); // 前置:被测的那处确实是闭合的

    const reverted = normalised.replace(
      closed,
      'participationIdentity ActivityParticipationIdentity @relation(fields: [participationIdentityId], references: [id], onDelete: Restrict)',
    );
    expect(reverted).not.toBe(normalised);

    const violations = findAnchorViolations(parsePrismaModels(reverted)).filter(
      (violation) => !isExempt(violation.model, violation.relation),
    );

    expect(violations.length).toBeGreaterThan(0);
    // 必须点名到具体模型 + 关系 + 缺了哪个锚点,而不只是「有问题」。
    const named = violations.find((violation) => violation.relation === 'participationIdentity');
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
    const injected = `${schemaText}

model FutureAnchorTable {
  id         String @id @default(cuid())
  activityId String
  sessionId  String
  memberId   String
  positionId String

  activity Activity                @relation(fields: [activityId], references: [id], onDelete: Restrict)
  position ActivitySessionPosition @relation(fields: [positionId], references: [id], onDelete: Restrict)
}
`;

    const violations = findAnchorViolations(parsePrismaModels(injected)).filter(
      (violation) => !isExempt(violation.model, violation.relation),
    );

    const caught = violations.find((violation) => violation.model === 'FutureAnchorTable');
    expect(caught).toBeDefined();
    expect(caught?.relation).toBe('position');
    expect(caught?.missing).toEqual(expect.arrayContaining(['activityId', 'sessionId']));
    expect(caught?.requiredUniqueOnTarget).toEqual(
      expect.arrayContaining(['id', 'activityId', 'sessionId']),
    );

    // 同一张表上的 `activity` 关系**不该**被判红 —— Activity 是链根,没有 activityId 列。
    expect(
      violations.some(
        (violation) => violation.model === 'FutureAnchorTable' && violation.relation === 'activity',
      ),
    ).toBe(false);
  });

  // ===========================================================================
  // 反向豁免对照:操作者类关系不得被误判
  //
  // 若「同链」判据改用「列名相同」而不是「目标带 activityId」,所有指向 User 的
  // operator / reviewer 关系都会因 User 也有 memberId 而被误判成漏闭合 ——
  // 那会逼着后来的人往白名单里塞十几条,白名单就此变成垃圾堆。
  // ===========================================================================

  it('never flags operator-style relations that point at global entities', () => {
    const raw = findAnchorViolations(models);
    const actorRelations = raw.filter((violation) =>
      ['User', 'Member', 'Activity'].includes(violation.target),
    );
    expect(actorRelations).toEqual([]);

    // 正面钉住:这些关系确实存在且确实被扫到过,否则上面是空对空。
    const punch = models.get('AttendancePunchEvent');
    expect(punch?.relations.map((relation) => relation.name)).toEqual(
      expect.arrayContaining(['operatorUser', 'operatorMember', 'member', 'activity']),
    );
  });

  it('uses a domain vocabulary of anchors rather than a hardcoded model list', () => {
    expect([...CHAIN_ANCHORS]).toEqual(['activityId', 'sessionId', 'memberId']);
  });
});
