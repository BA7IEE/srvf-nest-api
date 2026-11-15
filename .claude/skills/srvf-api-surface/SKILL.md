---
name: srvf-api-surface
description: 修改 SRVF controller、DTO、路由、Swagger、OpenAPI 或客户端 surface 时使用。
---

# API 变更

路径均相对仓库根。先查看相关 controller/service、contract 和 `docs/api-surface-policy.md`，
DTO/Swagger 细则在 `docs/reference/`。

- 保持六个 canonical surface：Admin/App/Auth/System/Open/Integration，不新增 Mixed Controller。
- App DTO 不派生自 Admin；surface-neutral 复用只沿已登记例外。raw permission 不等于 capability。
- 物理拆分须核对 path/method/tag/访问声明/DTO/service 调用零漂移；行为变化须在用户授权范围内。
- 同 PR 更新对应 `docs/handoff/`，运行 `pnpm docs:refresh` 并审阅生成 diff，
  不盲目更新 contract snapshot，不输出 L3 字段。
- 运行 `pnpm agent:check:api` 与相关定向 E2E；全量 E2E 留 CI。
  说明破坏性变化、前端适配和未验项。
