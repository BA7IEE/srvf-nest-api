---
name: srvf-prisma-change
description: 修改 SRVF Prisma schema、migration、seed、索引、外键或数据兼容性时使用。
---

# 数据变更

路径均相对仓库根。读取 `prisma/CLAUDE.md`、相关模型/迁移、调用方及
`docs/reference/soft-delete-transactions.md`。

- 写代码前确认已有授权涵盖具体数据变化，说明旧数据兼容性、不可逆性及 seed/API/权限影响。
- 不自动执行 `migrate dev/reset` 或 `db push`；不操作生产。
  migration 保留历史不可变约定，SQL 的约束、锁、回填和回滚路径须明确。
- 多写同事务；软删唯一性含已删行，P2002 沿统一错误规范。
  enum 从 Prisma 导入，复合锚点证明来源同链；不可变收据与事实不增加删除通道。
- `pnpm prisma:generate` 后跑类型检查与相关测试；迁移须验证空库重放、非空升级、
  非法状态拒绝和失败回滚。使用已授权的隔离测试库，不临时扩张测试权限或放宽约束。
- 报告 SQL/数据影响、验证结果与生产执行前置。代码交付不表示生产已部署。
