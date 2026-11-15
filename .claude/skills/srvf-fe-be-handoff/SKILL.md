---
name: srvf-fe-be-handoff
description: SRVF 前后端 API 对接、接口能力查询与 docs/handoff 更新时使用。
---

# 前后端交接

路径均相对仓库根。Admin 读 `docs/handoff/admin-web.md`，小程序读 `docs/handoff/miniapp.md`。
字段以 OpenAPI 为准，权限以 controller 声明、service 判权与 `permission-catalog.ts` 为准。

- 回答页面用哪些接口时，沿任务到端点映射核对现行代码，区分已交付接口与候选方案。
- API/DTO/RBAC 变化同 PR 更新受影响的交接内容；运行 `pnpm docs:refresh`、
  contract 与生成物 check，审阅 diff。
- 缺接口时记录具体业务缺口供维护者决定，不把候选端点写成可调用能力。
- 页面沿活动/队员等所有权轴组织，避免将嵌套子资源拍平成顶级菜单再手选父级。
- 明确前端适配、真实联调和部署是否完成；生成文档不能代替外部端回执。
