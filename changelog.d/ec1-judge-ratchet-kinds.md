### Added

- base-trusted 裁判支持**两种棘轮形态**(EC-1 前置,PR-A):新增 `kind` 判别(`eslint-exempt` 默认 / `numeric-monotonic`)与 `judgeNumericMonotonicity` 数值单调性判决 —— 后者按 file 比数值,「只减不增 + 不得新增 file」,补上此前「裁判只比 (file, symbol) 集合、不认数值」这条使尺寸棘轮无法登记的结构缺口。既有三条棘轮**一个字节未改**(kind 省略即默认)。本 PR 只改裁判,注册表未动;登记与 eslint 侧分流在 PR-B(裁判跑 base 定义,必须先合入本 PR)。
