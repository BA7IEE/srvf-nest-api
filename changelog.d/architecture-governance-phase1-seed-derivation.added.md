### Added

- 架构治理 Phase 1：新增受红区保护的 RBAC seed facts，由 `prisma/seed.ts` 单向消费并暴露只读结构化目录；保留的 SUPER_ADMIN 权限码、四组 seed e2e 的码表、角色绑定、职务 policy 与计数均从同源事实派生，三个治理解析器按精确 seed 事实闭包读取，避免手工同步。
