### Changed

- 同一提交从 Draft 转 Ready 不再重触发 trusted 审批；模块规则文档退出运行时代码路径审批，代码重命名的两侧仍受保护。
- Markdown 与 `docs/plans/evidence/` 下的静态 JSON、图片及 patch 证据使用文档检查通道，保留派生物、权限、单测和差异检查，省去运行时回归和 Docker 构建。未知文件类型仍走完整流水线。
- 模块目录中的 Markdown 不再触发自动容器 smoke；四个 required check 名和运行时代码的业务回归范围不变。
