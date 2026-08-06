### Changed

- 活动业务改造 v1.1 第 3 批②-pre 将 `ActivityRuleSnapshot.templateVersionId` 放开可空；无模板活动可在审核通过后生成不可变规则快照，同时保留有模板时的 FK 校验；零 endpoint、零运行时行为、零 seed。
