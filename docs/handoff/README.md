# docs/handoff — 前后端交接层(派生 · 指针优先 · 双向)

> **这是给 AI / 人看的"对接说明",不是契约副本。**
> 后端是 SRVF 各前端(admin 后台 / 小程序)的 API 真相源;本目录把"契约表达不了的东西"补上,
> 并把前端的需求/缺口反向登记回来。

---

## 0. 一条铁原则(否则这层会变成会烂的第三事实源)

**机器能自校验的东西,永远以后端生成物为准,本目录只引用、不手抄:**

| 你要什么 | 权威源(live / 机器校验) | 本目录做什么 |
|---|---|---|
| 端点清单 / 入参出参 / 字段 | **`/api/docs-json`**(live)· `test/contract/openapi.contract-spec.ts` 的 `EXPECTED_ROUTES` | 不复制;只在能力图里引用端点名 |
| RBAC 权限码(206) | [`docs/ai-harness/RBAC_MAP.md`](../ai-harness/RBAC_MAP.md) · 各端点 `[rbac: x]` summary | 不复制;能力图里写"用哪个码门" |
| 当前版本 / surface 状态 / 债务 | [`docs/current-state.md`](../current-state.md) | 不复制 |

**本目录只放契约表达不了的三样**(需要人/AI curate、且不会被 contract 测出来的):
1. **任务→端点图**(capability-map):某个页面/任务该调哪几个接口、按哪条轴下钻;
2. **踩坑表**(gotchas):登录几步走、贡献值别裸 SUM、字段以 docs-json 为准等对接陷阱;
3. **缺口台账**(gap-ledger):前端缺什么、是否已出 goal、是否已发——双向请求簿。

> 字段级真相永远是 live `/api/docs-json`。本目录若与之冲突,**以 live 为准**,并回来修本目录。

---

## 1. 文件

| 文件 | 给谁 | 内容 |
|---|---|---|
| [`admin-web.md`](admin-web.md) | `srvf-admin-web`(PC 管理后台) | 轴模型 + 任务→端点图 + 踩坑 + 缺口台账(**canonical**) |
| [`miniapp.md`](miniapp.md) | 小程序前端(仓未建,占位) | App surface(`/api/app/v1/*`)模型 + 能力图骨架 |
| `openapi.json` | 离线/版本审查用 | 从 live 导出的**便利快照**(非真相;真相是 live `/api/docs-json`) |

刷新 openapi 快照:`pnpm docs:handoff:openapi`(需后端 dev server 在 `:3000`;本质 = `curl /api/docs-json`)。
快照入 git 的好处:改契约的 PR 里 openapi.json 出 diff → reviewer 一眼看见契约变了。

---

## 2. 反漂铁律(已写进 [`AGENTS.md`](../../AGENTS.md) 权威源表)

> **改 API surface / RBAC / 契约 → 同一个 PR 内更新本目录受影响的 capability-map / gap-ledger,并刷新 `openapi.json`。**

把"交接更新"焊在"契约变更"的同一 PR 上,是这层不馊的唯一办法。release 收口
([`srvf-release-closeout`](../../.claude/skills/) 九阶段)末尾再统一核一次:openapi 重导 + 缺口台账标"已发"。

## 3. 双向怎么用

- **后端 → 前端**:改了能力 → 更新 admin-web/miniapp 的能力图 + 刷 openapi;前端据此对接。
- **前端 → 后端**:前端发现"想做的任务后端没接口" → 在对应文件的 **gap-ledger 登记一行**
  (诉求 / 涉及任务 / 期望端点);维护者据此决定出不出 goal。goal 出了/发了 → 回来更新这行状态。

## 4. Unreleased 对接增量（2026-07-15，审计刀 5）

本批新增 7 个 additive endpoint（`EXPECTED_ROUTES` 338→345）：活动核对/参与汇总、Admin/App 个人参与汇总、组织月度参与 overview、报名批量通过/驳回。Admin 任务映射见 [`admin-web.md`](admin-web.md) §2.1–§2.3/§2.7，App 本人汇总见 [`miniapp.md`](miniapp.md) §2；字段、状态码与响应 schema 仍只以 live `/api/docs-json` 为准。
