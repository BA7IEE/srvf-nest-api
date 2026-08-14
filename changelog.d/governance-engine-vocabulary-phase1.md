### Added

- 架构治理:`RouteAuthzEngine` 新增取值 **`none`** —— 表示**已声明的缺席**:该端点的判权由 scopes / admission 轴承载(self-by-construction、责任策略、App 准入),不欠任何 engine 断言。它与规范化声明上的 `null` 不同:`null` 表示该模式本就无引擎(PUBLIC / LOGIN_ONLY),`none` 是作者对一个**确有判定面**的路由做出的正面陈述。

  背景:`@LoginScoped` 对未指定 engine 的路由填入 `authz-scoped`,而该类型此前只有两个取值 ⇒ **用 `@LoginScoped` 就必然声称走 scoped-authz 引擎,语法上无法表达「我不走」**。全仓 118 条声明 `authz-scoped` 的端点中,该轴**满足者为 0**(0/119)。本刀只把表达能力补上。

### Changed

- **R8 的 engine 轴改为 fail-closed**。此前 `patternForEngine()` 对任何未知取值一律 `return null` = 「不欠任何断言」,于是把 `authz-scopedd` 这类**拼写错误**与「没什么要证的」变成不可区分 —— 该轴静默通过。现在:`null` 与 `none` 不欠断言(前者模式本就无引擎、后者是已声明的缺席),**其余未注册取值一律落 T3**。

- engine 词汇不再有第二份:`generate-authz-manifest.ts` 的声明解析器改为调用单源导出的 `isRouteAuthzEngine()`,并把自有 `Policy.engine` 的字面联合换成 `RouteAuthzEngine`。此前它硬编码了一份 `'rbac-global' | 'authz-scoped'`,与 `authz-context.ts` 各自演化。

### 边界与验收(本刀真的零影响)

- **未改 `@LoginScoped` 的默认值**(`engine: options.engine ?? 'authz-scoped'` 一字未动)—— 改默认会让 115 条 manifest 同时变化、触发 115 条 R14 审批,那是第二段的事。`route-authz.decorator.ts` **零改动**:它的 `engine?: RouteAuthzEngine` 直接引用单源,扩取值自动生效。
- **零端点使用新取值**,实测:`ROUTE_AUTHZ.md` 的 `entries` 数组**逐字节不变**,整文件差异**恰好只有 `inputDigest` 两行**(该摘要摄入整个 `src/**`,任何源码改动都会让它变,与端点策略无关);`harness/authz-assertion-patterns.json` **整文件逐字节不变**;`docs:authz:check` 绿;全仓 R8 分布 `T1=4 / T2=5 / T3=110 / N-A=9` 与本刀前逐项相同。
- 判据由变异对拍绑定:拆掉 fail-closed → 「未注册取值」负样例翻红;把 `none` 移出注册表 → 「已声明缺席」正样例翻红;**两红集不重叠**。
