import { analyzeRoleClassification, selfCheck } from '../../../scripts/check-role-classification';

// P1-32 PR 2(2026-08-24):角色分类三字段 + 权限目录只读投影的执行位。
//
// ⚠️ **本文件只是薄运行器,实质逻辑在 `scripts/check-role-classification.ts`。**
//    那个文件在 selfGuard(`scripts/check-*.ts`)内,改松它要过红区人闸;
//    而 `src/**/*.spec.ts` 不在 selfGuard —— 把逻辑放这里等于没锁。
//    地板锚点、反向探针、AST 扫描面,全在那边。这条现在由
//    `scripts/check-criteria-spec-purity.ts` 机器执法。
//
// ─── 这条闸修的是哪一类缺陷 ────────────────────────────────────────────────
// 三个字段是**派生**的(冻结稿 §6.3:不给 Role 表加 kind 列)。派生的好处是
// 「DB 字段被改成 CUSTOM 逃逸保护」结构上不可能;代价是**漂了没有症状** ——
// 展示口径与执法口径分家不会有编译错误,也不会有既有测试变红。
//
// ⚠️ 每条判据前先跑**自证**:清单被删空 / 目录扫描面塌了 / 反向探针被收编 /
// 分类文件被搬走,判据必须当场红,而不是「没有可检查的项 ⇒ 全过」。

describe('角色分类判据 —— 自证(先证明仪器没瞎,再报数)', () => {
  const report = analyzeRoleClassification();

  it('内建角色清单 / 系统托管清单 / 目录条目都不低于地板,反向探针确实是自定义角色', () => {
    expect(selfCheck(report)).toEqual([]);
  });
});

describe('角色分类判据 —— 派生结果 == 正在执法的谓词(两向)', () => {
  const report = analyzeRoleClassification();

  it('🔴 每个内建角色都标成 SYSTEM(把某个内建角色标成 CUSTOM 即红并点名)', () => {
    expect(report.builtinNotSystemKind).toEqual([]);
  });

  it('🔴 每个内建角色的权限集都标成 RELEASE_MANAGED —— 与 PR 3a 的 30108 闸同一口径', () => {
    expect(report.builtinNotReleaseManaged).toEqual([]);
  });

  it('自定义角色不许被标成 SYSTEM / 只读(反向:防「恒返回 SYSTEM」把正向断言变成空转)', () => {
    expect(report.customMarkedSystemKind).toEqual([]);
    expect(report.customMarkedReleaseManaged).toEqual([]);
  });

  it('🔴 三个活动责任角色的绑定标成 SYSTEM_ONLY —— 与 assertRoleIsNotSystemManaged 同一集合', () => {
    expect(report.systemManagedNotSystemOnly).toEqual([]);
  });

  it('其余角色不许被标成 SYSTEM_ONLY(标了等于告诉前端「人工入口关着」,与实际相反)', () => {
    expect(report.nonSystemManagedMarkedSystemOnly).toEqual([]);
  });

  it('🔴 分类派生处不许抄角色 code 字面量(抄一份就是造第二个事实源)', () => {
    expect(report.hardcodedRoleCodeLiterals).toEqual([]);
  });
});

describe('权限目录只读投影判据 —— 断言真响应体,不是断言数据表', () => {
  const report = analyzeRoleClassification();

  it('🔴 每条目录条目的中文名与人话说明都出得来(删掉说明字段即红并点名)', () => {
    expect(report.itemFieldsMissingOrBlank).toEqual([]);
  });

  it('目录响应与元数据表双向集合相等(该进的没进 / 不该进的进了,两侧都红)', () => {
    expect(report.itemsMissingFromMetadata).toEqual([]);
    expect(report.metadataMissingFromItems).toEqual([]);
  });

  it('权限码定义索引与元数据表双向集合相等(反射漏掉某个数组即红)', () => {
    expect(report.seedIndexMissingFromMetadata).toEqual([]);
    expect(report.metadataMissingFromSeedIndex).toEqual([]);
  });

  it('权限码定义与码本身一致,且目录内无重复码', () => {
    expect(report.inconsistentSeedDefinitions).toEqual([]);
    expect(report.duplicateItemCodes).toEqual([]);
  });

  it('分组结构自洽:无空分组、条目挂在自己声明的分组下、totalItems 与实际条目数相等', () => {
    expect(report.emptyGroups).toEqual([]);
    expect(report.itemInWrongGroup).toEqual([]);
    expect(report.totalItemsMismatch).toEqual([]);
  });
});
