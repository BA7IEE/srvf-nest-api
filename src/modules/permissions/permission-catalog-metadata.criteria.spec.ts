import {
  analyzeCatalogMetadata,
  selfCheck,
} from '../../../scripts/check-permission-catalog-metadata';

// P1-32 PR 0(2026-08-22):权限元数据决策锁的执行位。
//
// ⚠️ **本文件只是薄运行器,实质逻辑在 `scripts/check-permission-catalog-metadata.ts`。**
//    那个文件在 selfGuard(`scripts/check-*.ts`)内,改松它要过红区人闸;
//    而 `src/**/*.spec.ts` 不在 selfGuard —— 把逻辑放这里等于没锁。
//    地板锚点(UNIVERSE_FLOOR)、权限码形状正则、CRITICAL 五族判定,全在那边。
//
// ─── 这条闸修的是哪一类缺陷 ────────────────────────────────────────────────
// 冻结稿把 PR 0 定性为「设计/文档,不改运行行为」。照字面做出来的产物是一份 237 条的
// markdown 目录 —— 而**纯文档的决策记录会漂**:新增一条权限码不会让任何文档变红。
//
// 所以本闸的职责**不是**当期快照(「今天这 237 条都填了」),而是:
//   🔴 **将来任何一条新码,不填元数据就进不了主干。**
//
// ⚠️ 每条判据前先跑**自证**:全集扫不到东西 / 元数据表被清空时,判据必须当场红,
// 而不是「没有可检查的项 ⇒ 全过」。「判据失去输入 ≠ 通过」。
describe('权限元数据判据 —— 自证(先证明仪器没瞎,再报数)', () => {
  const report = analyzeCatalogMetadata();

  it('全集非空不低于地板、形状对、锚点在、注册表与标签族都非空', () => {
    // 扫描面锚点包含**动态拼接码**与 **flag-gated 码** —— 它们是「具名子集冒充闭包」
    // 时第一批消失的东西,少了任一个 selfCheck 就红并点名。
    expect(selfCheck(report)).toEqual([]);
  });
});

describe('权限元数据判据 —— 覆盖完整性(双向集合相等)', () => {
  const report = analyzeCatalogMetadata();

  it('🔴 全集里的每一条码都有元数据条目(新增码不填元数据即红并点名)', () => {
    expect(report.missingMetadata).toEqual([]);
  });

  it('元数据表里没有全集之外的条目(码删掉后不得留下孤儿元数据)', () => {
    expect(report.orphanMetadata).toEqual([]);
  });
});

describe('权限元数据判据 —— 每条 ACTIVE 的字段完整且取值合法', () => {
  const report = analyzeCatalogMetadata();

  it('🔴 中文名与人话说明都不为空', () => {
    expect(report.blankDisplayName).toEqual([]);
    expect(report.blankBusinessDescription).toEqual([]);
  });

  it('🔴 分类完整:sectionCode / groupCode 已登记,且两者归属一致', () => {
    expect(report.unknownSection).toEqual([]);
    expect(report.unknownGroup).toEqual([]);
    expect(report.sectionGroupMismatch).toEqual([]);
  });

  it('🔴 sortOrder 是正整数(0 会被消费方的 `if (!sortOrder)` 当成缺值)', () => {
    expect(report.badSortOrder).toEqual([]);
  });

  it('🔴 风险等级 / 授予策略 / 状态 / 可见性都落在冻结稿枚举内', () => {
    expect(report.unknownRiskLevel).toEqual([]);
    expect(report.unknownGrantPolicy).toEqual([]);
    expect(report.unknownUiVisibility).toEqual([]);
  });

  it('🔴 风险标签非空、无重复、且每个都在枚举内', () => {
    expect(report.emptyRiskTags).toEqual([]);
    expect(report.duplicateRiskTags).toEqual([]);
    expect(report.unknownRiskTags).toEqual([]);
  });

  it('每条恰好带 READ 或 WRITE 之一(读写性质不许留空,也不许自相矛盾)', () => {
    expect(report.badReadWriteExclusivity).toEqual([]);
  });

  it('所有状态取值合法(含退役码 —— 它们不做完整性检查,但状态本身必须能被认出来)', () => {
    expect(report.unknownStatus).toEqual([]);
  });
});

describe('权限元数据判据 —— 维护者 2026-08-22 拍板结论的执行位', () => {
  const report = analyzeCatalogMetadata();

  it('① CRITICAL 恰好等于「五族」:带 CRITICAL 标签族之一,或在身份签发清单里', () => {
    // 该是 CRITICAL 却没标(判据变松时这一侧红)
    expect(report.criticalUnderstated).toEqual([]);
    // 标了 CRITICAL 却不属于五族(有人手工把某条升到最高危而不说明依据时这一侧红)
    expect(report.criticalOverstated).toEqual([]);
  });

  it('① CONTROL_PLANE 只贴给写侧(贴到只读码上会把「查看谁有什么角色」升成最高危)', () => {
    expect(report.controlPlaneOnReadCode).toEqual([]);
  });

  it('② 授予策略 SUPER_ADMIN_ONLY 的集合,恰等于正在执法的 SA-only 保留码集合', () => {
    // 🔴 复用权威集合,不抄第二份清单 —— 抄一份就是造第二个事实源,两份可以各自漂移,
    //    而「元数据说能授、控制面拦着」或反过来,都不会有任何症状。
    //    seed 侧「这 7 条零角色持有」的执行位在 permission-code-holders.spec.ts,本条不重复。
    expect(report.declaredSuperAdminOnly).toEqual(report.reservedSuperAdminOnly);
  });

  it('② 保留码在角色编辑器里不露面(HIDDEN)—— 露面就等于邀请人去授它', () => {
    expect(report.visibleReservedCodes).toEqual([]);
  });

  it('③ 本期不出 scopeProfile 字段(Scope 首版只提示;字段在就会被当成强校验依据)', () => {
    expect(report.leakedScopeProfile).toEqual([]);
  });

  it('⑤ 旧 Permission 写 CRUD 仍是 ACTIVE(退役由 PR 8 前提触发,不定死日期)', () => {
    expect(report.legacyCrudNotActive).toEqual([]);
  });
});
