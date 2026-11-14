# 开发与交付

1. 确认任务边界、实际代码和相关测试；独立任务使用独立工作树。新工作树安装锁定依赖并生成 Prisma client。
2. 在已授权范围内完成实现。只有新增业务决策、不可逆操作或扩大范围需要再次询问维护者。
3. 运行相关检查，审阅 diff。日常用 `pnpm agent:check:quick`，提交前冷 lint；
   API 变化运行 contract、OpenAPI/client freshness 与定向 E2E。全量 E2E 由 CI 运行。
4. PR 说明问题、改后行为、验证及剩余限制。业务变更写 `changelog.d/` fragment；
   不再要求同步 CODEMAP、计数、Goal、NEXT_TASKS 或冻结稿台账。
5. CI 的四个 required check 名保留：
   `Lint / Typecheck / E2E`、`Docker image build`、`Diff guards`、`Red-zone (trusted)`。
   最小红区由 base 上的裁判检查，维护者人工批准。不要代点审批或把待审批写成已通过。

## 发布

仅在维护者授权后执行。先 `pnpm release:prepare <版本号>` 生成文件，审阅、验证并走 PR；
合并状态确认后再 `pnpm release:finish <版本号>` 打 tag、创建 GitHub Release。
发版不等于生产部署，现场切换另按 `docs/ops/` 对应 SOP。
清理工作树前确认 GitHub 已合并及本地没有未保存工作；不强删、不批量清理无关工作树。

## 历史

旧五档流程、六步降速、固定简报、Goal/lane 协议及本地授权令牌已退役。
原文可从 `harness-v3-final` 标签读取。旧评审中的业务决定仍有效，旧流程要求不再约束新任务。
