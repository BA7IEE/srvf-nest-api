### Added

- R14 授权语义门:对 ROUTE_AUTHZ manifest 的 base↔head 做四态语义比对(EQUIVALENT / NARROWER / BROADER / INCOMPARABLE),逐端点按 admission、mode、codes(按 `require` 语义分派)、scopes、engine 五轴判定。降级与不可比须在 changelog.d 里以 `authz-downgrade` 块申报,并由维护者在 harness-review 环境点批;收紧与等价放行但恒进全量迁移清单。
- 权限蕴含图登记表 `harness/authz-implication-graph.json`(初始边集为空 = 任何换码恒不可比),带结构校验:引用不存在的权限码、自环、成环均硬红。
