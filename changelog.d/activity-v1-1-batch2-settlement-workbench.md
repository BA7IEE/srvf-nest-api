### Added

- 活动业务改造 v1.1 第 2 批第 ⑨a 刀新增负责人结算工作台读面：结算摘要、逐人分页与 `session`／`result`／`q` 过滤、不可变版本详情与封场修订，以及 returned 版本基于当前 working draft 的重新提交。
- 负责人可用独立 `activity.settlement-update-draft.record` 权限编辑 working draft 单项；编辑采用 `expectedDraftVersion` CAS，运行进入 submitted／posted／closed 等非 drafting 状态即明确拒绝。

### Security

- working draft PATCH 的事务路径不写 `AttendanceSettlementVersion`；已提交版本不会因草稿编辑被修改，returned 重提始终生成新的 immutable version。
