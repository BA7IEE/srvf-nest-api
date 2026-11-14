# 维护者手册

日常开发由 AI 在你的授权范围内推进。你主要决定业务行为、不可逆操作、生产切换和发布。
不再需要开工令牌、`harness:grant` 或逐项维护流程台账。

CI 保留 lint、类型检查、构建、单测、契约、E2E、journeys、Human V3 和 Docker 构建。
这些能发现具体错误，但全绿不等于生产已经验收。让 AI 说明实际跑了什么、哪里仍未验证。

涉及数据库结构、鉴权核心或 CI 控制面的 PR 会进入 `harness-review`。
查看 PR 的改动理由、行为影响和验证后，在 GitHub 的 Review deployments 中批准。
AI 可以准备改动和创建 Draft PR，不代你审批。

`prisma migrate dev/reset`、`db push`、生产部署、数据删除/回填和生产开关仍由你在具体场景确认并执行。
发版分 `pnpm release:prepare <版本>` 与 `pnpm release:finish <版本>`，具体见 [开发流程](process.md)。

日常状态见 [current-state](current-state.md)，生产操作见 `docs/ops/`。
历史资料已保存在远端 `harness-v3-final` 标签，按原路径可恢复；旧记录不代表当前状态。
