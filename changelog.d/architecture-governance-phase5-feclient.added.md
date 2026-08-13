### Added

- 前端 TS client 生成:从 `docs/handoff/openapi.json` 按 surface 生成 admin 与 app 两份类型 + 轻客户端,落 `docs/handoff/clients/{admin,app}/`。产物只出类型与调用签名(不含 baseURL / 令牌 / 任何鉴权逻辑,传输层由消费方注入 Fetcher),`code/message/data` envelope 与分页形状按仓内既有契约表达,头部带确定性 `inputDigest`(不含时间戳 / git SHA)。新鲜度由 `pnpm docs:feclient:check` 在 CI Docs guards 同链守护;生成器并对自己的产物跑 TypeScript 诊断(`docs/**` 在 lint 与 typecheck 射程之外,不自校验就没人管)。
- Phase 5 语义门收口报告 `docs/ai-harness/SEMANTIC_GATES.md`:三门真实 gate 输出样例、selftest 阳性对照与变异 A/B 清单、已知性质与缺口、本次未做段。
