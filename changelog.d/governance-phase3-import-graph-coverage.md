### Changed

- 架构治理 Phase 3 前置：R2/R3 依赖图补齐 `export … from` / 动态 `import()` / `import = require()` 三种形态的解析，并给每条跨域边标注 `form` 与 `typeOnly`。实测本仓这三种形态**各 0 条**，判定逻辑未改、findings 512 → 512 零变化；三条正样例证明解析器认得它们，三条「当前为 0」断言在第一条真出现时即红。type-only 跨域边（623 条边中 179 条，41 条违规中 4 条）按维护者拍板**照算并打标记**，不静默豁免 —— 其中 3 条正是 v4 §4 要求恒 0 的 `platform-access→participation` 反向边。
