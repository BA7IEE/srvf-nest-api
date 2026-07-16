# changelog.d/ — CHANGELOG fragment 暂存目录

> Harness 2.0 lane 并行协议的一部分(T0 §1.4 / d4)。CHANGELOG `## Unreleased` 是单一追加点,并行 PR 必然冲突;fragment 把每条 lane 的登记拆成独立文件,bump 前由总控一次归并。

## 用法

- **写**:lane 的 PR 需要登记 CHANGELOG 时,新建 `changelog.d/<branch-or-topic>.md`,内容 = 可直接并入 `## Unreleased` 的 markdown 条目(与直接写 CHANGELOG 的格式完全一致)。
- **并**:release 收口 bump 前,总控执行 `pnpm changelog:merge` —— 按文件名序归并进 CHANGELOG `## Unreleased`(无该段则自动新建)并删除 fragment。
- 本 README 不参与归并。

## 边界

- 单 lane 场景直接编辑 CHANGELOG 的旧路径**不废除**(process §5);fragment 仅在并行 lane 期间为必须。
- A 档 docs-only PR 照旧不登记 CHANGELOG(既有约定)。
