---
name: srvf-fe-be-handoff
description: SRVF 后端 ↔ 前端 API 对接交接层的读写。当在 srvf-nest-api 里改 API surface / 端点 / 契约 / RBAC 码,需要同步前后端交接文档(docs/handoff/*)时使用;也当有人问"某前端任务/页面该调哪些接口""活动作战室/审批工作台/队员360 怎么对接""前端缺什么接口"时使用。中文触发:对接、交接、契约、API surface、能力图、任务到端点、缺口台账、活动作战室、审批工作台、队员360、前端要什么。
---

# srvf-fe-be-handoff — 前后端交接层读写

后端是各前端(admin / 小程序)的 API 真相源。交接层在 [`docs/handoff/`](../../../docs/handoff/):
admin → `admin-web.md`,小程序 → `miniapp.md`,索引/原则 → `README.md`。

## 什么时候做什么

- **被问"某任务/页面该调哪些接口"** → 读对应 `docs/handoff/*.md` 的"能力图(任务→端点)";
  字段真相对 live `/api/docs-json` 核,权限码对 `docs/ai-harness/RBAC_MAP.md` 核。别手抄契约。
- **改了 API surface / 端点 / DTO / RBAC / 契约** → **同一个 PR 内**:
  1. 更新对应 `docs/handoff/*.md` 受影响的能力图 / 缺口台账行;
  2. `pnpm docs:handoff:openapi` 刷新 `docs/handoff/openapi.json`(需 dev server）。
  这是 [`AGENTS.md`](../../../AGENTS.md) 权威源表里的反漂铁律——交接更新焊在契约变更上。
- **前端反馈"想做的任务后端没接口"** → 在对应文件的"缺口台账(gap-ledger)"登记一行
  (诉求 / 任务 / 期望端点 / 状态);维护者据此决定出不出 goal。goal 发了 → 回来标"已发"。

## 一条心智模型(讲给前端 / 设计页面时)

后端按"所有权轴"嵌套(活动轴 / 队员轴),URL 树即任务驱动 IA。前端**按任务设计页面**:
沿轴下钻(活动作战室 / 队员档案)或跨轴横扫(审批工作台)。
**反模式**:把嵌套子资源拍平成顶级菜单 + 手选父级下拉(制造上下文丢失)——发现就劝回详情页内嵌。

> 想让本 skill 也在前端仓(srvf-admin-web)/ 小程序仓里主动触发,把本目录复制过去或提升到
> `~/.claude/skills/`;前端仓当前靠其 `CLAUDE.md` 的"必读"指针路由到本交接层。
