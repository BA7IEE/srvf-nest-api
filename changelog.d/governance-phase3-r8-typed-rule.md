### Changed

- 架构治理 Phase 3 前置：R8 声明↔实现闭环规则（`srvf/authz-declaration-closure`）的注入依赖解析改为 **typed**——按类型在其**声明处**的名字与已登记 `receiverTypes` 比对，取代原先读注解文本的做法，`import { AuthzService as A }` / re-export / 局部 `type` 别名改名后不再误判整端点为 T3；解析不出类型时回落到注解读法，不会静默漏报。新增「接收者类型被改名后仍解析到真类」正样例。全仓重扫分布与 Phase 1 **逐项相同**（T1=4 / T2=2 / T3=113 / N-A=9，总计 128），119 条 warning 的理由字符串逐条相同——本仓无别名、无 `@Inject`、无缺注解构造参数，typed 化的收益是免疫力而非当期发现。
