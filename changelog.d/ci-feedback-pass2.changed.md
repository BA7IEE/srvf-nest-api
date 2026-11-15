### Changed

- 同一提交从 Draft 转 Ready 不再重触发 trusted 审批；模块规则文档退出运行时代码路径审批，代码重命名的两侧仍受保护。
- Markdown-only PR 保留派生物、权限、单测和差异检查，省去 Docker 构建及自动容器 smoke；四个 required check 名和业务回归的适用范围不变。
