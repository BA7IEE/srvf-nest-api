### Added

- 第 4 批资格配置/发布激活：负责人可在 App managed `GET/PUT qualification-rules` 全量维护 activity/session/position 的 #22 typed RuleSet；草稿 canonical no-op 不写版本或审计，初发与显式规则集合变更审核冻结 V5 target/hash，已发布活动的 direct PUT 必须走审核。
- RuleSet active/retired 版本保持冻结；变更中取消带资格 scope 的场次或岗位必须显式取消对应 RuleSet，失败以既有 `20022` 零写。clone 仅重映射定义到目标 draft v1，不复制 active 指针。

<!-- contract-breaking
operation: POST /api/app/v1/my/managed-activities/{activityId}/change-reviews
reason: 可选的 qualificationRuleSets 一旦出现，create/update/cancel 三个完整集合必须同时冻结，避免省略集合被误判为保留、清空或删除。
impact: 既有 V4 调用方继续省略顶层 qualificationRuleSets，wire 与快照不变；选择 V5 资格配置的调用方须传入三个数组，未使用的数组传空数组。
migration: 前端 codegen 后只在提交资格配置变更时构造 {create,update,cancel}；其它既有 change review 请求不添加该顶层字段。
rollback: 真回滚为 revert 本 PR 的 V5 qualificationRuleSets DTO、冻结/applier 与生成契约，恢复只接受既有 V4 change review wire。
-->
