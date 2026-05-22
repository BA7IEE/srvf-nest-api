# CLAUDE.md — Claude Code 入口转发

> **本文件不是完整规则源。**
> SRVF 派生项目自 v0.15.0 起把长期 AI 协作铁律统一收口在 [`AGENTS.md`](./AGENTS.md);
> 本文件保留是为了让以 `CLAUDE.md` 为入口的 Claude Code 会话不至于读不到任何指引。

---

## 1. 权威源分层(冲突时按此顺序)

| 你想知道的事 | 第一时间读 |
|---|---|
| **当前事实**(版本、open PR、最新 release、surface 状态、当前债务) | [`docs/current-state.md`](./docs/current-state.md) |
| **长期 AI 协作铁律**(命名、目录、错误码、Guard、软删除、RBAC、refresh token、App API 边界、§19 决策) | [`AGENTS.md`](./AGENTS.md) |
| **架构蓝图与早期阶段背景** | [`ARCHITECTURE.md`](./ARCHITECTURE.md)(请先读其顶部"当前阶段说明") |
| **开发 / PR 分级 / release 收口流程** | [`docs/process.md`](./docs/process.md) |
| **API surface 长期边界**(/api/app/v1 / /api/v2 / root legacy) | [`docs/api-surface-policy.md`](./docs/api-surface-policy.md) |
| **客户端边界设计期顶层规范** | [`docs/api-client-boundary.md`](./docs/api-client-boundary.md) |
| **Participation 业务上下文边界图**(activities / activity-registrations / attendances / contribution-rules 4 模块;不含 certificates) | [`docs/participation-bounded-context.md`](./docs/participation-bounded-context.md) |
| **附件配置三表边界**(`AttachmentTypeConfig` / `AttachmentMimeConfig` / `AttachmentSizeLimitConfig` override-with-default;不合表 / 不抽 facade) | [`docs/attachment-config-boundary.md`](./docs/attachment-config-boundary.md) |
| **架构边界铁律**(Presenter / QueryService / PolicyService / StateMachine / AuditRecorder / Effect 抽离决策;承接 `AGENTS.md §19.7 D-7`) | [`docs/architecture-boundary.md`](./docs/architecture-boundary.md) |
| **V2 基线规范 / 红线** | [`docs/srvf-foundation-baseline.md`](./docs/srvf-foundation-baseline.md) / [`docs/V2红线与复活路径.md`](./docs/V2红线与复活路径.md) |
| **安全 / 部署 / 测试 / 排错** | [`docs/security.md`](./docs/security.md) / [`docs/deployment.md`](./docs/deployment.md) / [`docs/testing.md`](./docs/testing.md) / [`docs/development.md`](./docs/development.md) |
| **历史 handoff / 评审稿 / 批次 / first-release 过程档案** | [`docs/archive/`](./docs/archive/) — **历史证据,不再作为当前执行约束** |

冲突处理:

- 当前事实(版本、能力清单、PR 状态)以 `docs/current-state.md` 为准
- 长期铁律以 `AGENTS.md` 为准
- 架构蓝图与现状冲突时,以 `docs/current-state.md` 描述的当前事实为准;`ARCHITECTURE.md` 仅作为设计背景
- 归档目录 (`docs/archive/**`) 内文档**只代表历史时刻的决议**,不能直接作为当前规则依据

---

## 2. 开工前必做

```bash
git status --short          # 工作树 clean
git branch --show-current   # 在期望分支
gh pr list --state open     # 0 open PR
grep '"version"' package.json
git tag --sort=-creatordate | head -1
```

任一不满足,**不开新功能,先与维护者对齐**。门禁细节见 [`docs/current-state.md §5`](./docs/current-state.md) 与 [`docs/process.md §2`](./docs/process.md)。

---

## 3. 本文件不维护的事

- ❌ 不复制 `AGENTS.md` 全文规则
- ❌ 不维护当前版本号、open PR、release 状态(那是 `docs/current-state.md` 的职能)
- ❌ 不维护 handoff / PR 编号 / 历史批次决议(那是 `docs/archive/` 的职能)
- ❌ 不替代 `ARCHITECTURE.md` 的阶段说明

如发现 `AGENTS.md` 与本文件冲突,**以 `AGENTS.md` 为准**;本文件只负责把会话引到正确的权威源。

---

## 4. 自动 memory(沿用)

本仓库与 Claude Code 自身的 `memory/` 持久化机制无关;`memory/` 行为以 Claude Code 全局配置为准,不在仓库铁律范围。仓库内任何协作约束、规则、流程、决议**只**写在 `AGENTS.md` / `docs/current-state.md` / `docs/process.md` / `ARCHITECTURE.md` / `docs/srvf-foundation-baseline.md` 等明确标记的权威源里。

---

> 历史版本的 `CLAUDE.md`(≈1150 行,与 `AGENTS.md` 80% 重复)已不再维护;如需查阅,可通过 `git log --follow CLAUDE.md` 取历史快照。
