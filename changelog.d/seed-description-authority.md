### Fixed

- **`Permission.description` 改由 seed 单向权威(P2-15)** —— 补记 [#1153](https://github.com/BA7IEE/srvf-nest-api/pull/1153) 的 changelog fragment(该 PR 合入时遗漏,本条只补文案,**零代码改动**)。

  `Permission.description` 的权威源是代码常量 `RbacPermissionSeed.description`。DB 与代码分叉有**两条**路,`#1151`(P1-32 PR 3b)关掉了第一条,`#1153` 关掉第二条:

  | | 怎么发生 | 关闭于 |
  |---|---|---|
  | V1 | 运行时 `PATCH /permissions/:id` 改 DB | `9cbb0c52`(30110) |
  | V2 | 改**代码里**那个字符串,而 seed 的 `update: {}` 保证**既有库永远收不到** | `ff604d39` ← 本条 |

  ⭐ **V2 不是假想缺陷,实测已发生 4 条**(本机开发库 `app`,只读探测):全是同一形状 ——「代码后来改对了、库停在旧文案」,例如 `recruitment-application.mark.threshold` 库里仍写「红十字」而代码已改成「急救资质」;`certificate.read.record` / `member-profile.read.record` 的「默认掩码」语义、`member.offboard.record` 的「含任职/分管/角色绑定」都停在旧版。⚠️ 这类漂移**零症状** —— 修前没有任何检查会因它变红,而漂移方向恰是「库陈旧、代码正确」⇒ 覆写是**修复**不是丢数据。测试库 `app_test` 为 0 条;⚠️ 读数只代表本机库。

  **改法**:四处 `permission.upsert` 全部改为覆写 `description`(`ALL_` / `ATTACHMENT_` / `BIZ_` / `ACTIVITY_RESPONSIBILITY_WORKFLOW_`)。**只覆写 `description`**;`module` / `action` / `resourceType` 刻意不动(结构字段、被查询与索引使用,打击面不同族,另立项)。

  ⭐ **为什么是现在做**:改动会覆写既有库里的历史文案,而**今天不存在任何长期存活的生产库**(生产仍 NO-GO)⇒ 代价接近零。首次上线之后生产库开始积累历史,同样的改动就变成「可能改写真实运营数据」,届时要么不敢做、要么先得做一轮比对与迁移。**这个窗口会随首次上线关闭。**

  ⚠️ **原先否掉这个做法的理由已不成立**:当时的理由是「会静默改写运营手工调过的文案」,而 `PATCH` 在 `#1151` 之后已关 ⇒ **根本不存在「运营手工调过的文案」**。A(关写入口)与 B(seed 变权威写者)不是二选一,是**先后**。

### Added

- `src/modules/permissions/seed-description-authority.criteria.spec.ts` —— 纯静态 typed-AST 判据(不起 Nest、不连库,~0.4s)。

  **正向**:结构性扫**全部** `prisma.permission.upsert(` 调用,不写死处数、不按行号 ⇒ 第 5 处加进来必被看见;只认取自常量的 `<x>.description`,写死字面量不算。自证用地板锚点(`≥N`)而非「恰 N 处」。

  ⭐ **反向锚点(比正向那条更重要)**:`dictType` / `dictItem` 的 **7 处** upsert 必须**仍是** `update: {}`。

  字典与权限**长得一样但语义已经分岔**:权限运行时已不可改 ⇒ `update: {}` 意味着「代码改了库收不到」= **缺陷**;字典运营本就该能改(改文案不必发版)⇒ `update: {}` 意味着「不回退运营的调整」= **正确**。改完后两处形状不同是**刻意的**,下一个人很可能把字典当成「漏改」顺手统一 —— 而**正向的破坏会被人发现(文案不更新),反向的破坏零症状**(字典的运营编辑功能被悄悄打掉,没有任何东西会红)。

  ⚠️ 还含「扫描面没塌」地板断言:两族 upsert 数各自不低于地板 —— 防「目录挪走 ⇒ 零命中 ⇒ 判据自动全绿」。
