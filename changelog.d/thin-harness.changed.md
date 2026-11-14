### Changed

- 精简 AI 协作入口与五个技能，移除 preflight/grant、写入 hooks、harness 自测/回放和强制流程台账。
- CI 保留代码、契约、业务验收及交付物检查；trusted 审批缩到数据库、鉴权核心和 CI 控制面，四个 required check 名不变。
- 历史规则与台账保存在 `harness-v3-final`；保留业务测试/运维输入，发版计数直接从源码计算。

### Fixed

- Human V3 隔离夹具使用 CI 已拉取的固定 PostgreSQL 镜像摘要启动，避免依赖特定 Docker 存储后端的本地 image ID；超时清理仍核对本次解析的精确镜像身份，不改认证回归、隔离条件或资源预算。
