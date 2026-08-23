### Added

- **冻结稿落地台账** [`docs/ai-harness/FROZEN_DRAFTS.md`](docs/ai-harness/FROZEN_DRAFTS.md):已拍板冻结的施工依据**还欠多少**,此前不在任何一处被维护 —— 要回答这个问题得跑五条机器命令再读三屏散文。台账分三段:§1 逐项欠账(8 项 / 涉 16 份文件,分「欠代码」四项与「欠运维」四项)· §2 机器读数(生成块)· §3 归档评审稿与计划**全量四值分类**(`open` / `landed` / `report` / `superseded`,96 份逐份定性,不许有未分类项)。
- **台账判据** `scripts/check-frozen-drafts-ledger.ts`(判定 + 计算,`--write` 刷新读数)+ 薄运行器 `src/frozen-drafts-ledger.criteria.spec.ts`(跑在 CI Fast 的 unit job)。守五条:①分类完整性**双向集合相等**(新增归档文件未登记 → 红;登记了已删除的文件 → 红)②分类闭集且 `open` 必带台账编号 ③§1 欠账表与 §3 的 `open` 行互证 ④读数块与真源**逐字节**比对 ⑤自证非空(扫描面 < 80 份 / 解析不出验收编号 / 读数条数不足 → 红,「判据失去输入 ≠ 通过」)。8 条变异逐条对拍全部命中,基线 0 红;其中最关键的一条是**真源变化**(模拟 P1-32 PR1 落地,新增 `permission-catalog*` 运行时文件)→ 读数当场对不上 ⇒ 读数是活的,不是抄下来的快照。
- 读数**恒不含时间戳与 git SHA**(架构治理 v4 勘误①:派生生成物带这两样会让字节比对新鲜度恒假红且自引用),并由判据单独锁死。

### Fixed

- `docs/README.md` 那句「已冻结但尚未实施的 T0 评审稿……**当前两份**」已经漂了:实测漏登 `rbac-permission-catalog-t0-review.md`(2026-08-20 入仓)与整个 `activity-business-overhaul-v1.1/` 合同目录。根因与 `docs/ai-harness/README.md` 当年漂成「恰 4 文件」同类 —— **漏登记不产生任何坏链接**,所以 `referenced-paths-exist` 之类守护看不见它,而那边已有 `ai-harness-index-complete` 闸、这边没有对应件。本刀不再在该行写死份数,改为指向新台账的 `open` 行,由完整性闸接管。
- ⚠️ **扫描面不用关键词法**:「头部含冻结 / FROZEN」那版实现过并当场否决 —— 实测漏掉 `activity-responsibility-workflow-v2-review.md`(头部写的是「业务已定版」),而那份恰恰是「代码已落、`ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED` 生产未开」的欠账项。关键词判据会把**最需要看见的那份**漏掉,故改为「归档目录下每一份 `.md` 都必须有分类」。
