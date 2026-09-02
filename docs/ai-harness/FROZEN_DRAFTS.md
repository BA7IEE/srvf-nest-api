# FROZEN_DRAFTS — 冻结稿落地台账

> **这份文件回答一个问题**:已经拍板冻结的施工依据,**还有多少没落地**。
>
> **它不是权威源**。每一份冻结稿的正文才是需求;`NEXT_TASKS.md` 才是任务台账;
> `current-state.md` 才是现实运维态。本文件是**索引 + 读数**,冲突时一律让步。
>
> **为什么要有它**(2026-08-22 实测立项):`docs/README.md` 里那句
> 「已冻结但尚未实施的 T0 评审稿……**当前两份**」当时已经漂了 ——
> `rbac-permission-catalog-t0-review.md` 与整个 `activity-business-overhaul-v1.1/`
> 都没登记。**漏登记不产生任何坏链接**,所以既有守护一次都没响过;
> 这与 `docs/ai-harness/README.md` 当年漂成"恰 4 文件"是同一类缺陷,那边已有闸、这边没有。
>
> **怎么刷新读数**:`pnpm exec tsx scripts/check-frozen-drafts-ledger.ts --write`
> **闸在哪**:判定与计算都在 `scripts/check-frozen-drafts-ledger.ts`(selfGuard 内);
> CI 由 `Diff guards` job 直接跑它(**不随 docs-only 短路**),
> `src/frozen-drafts-ledger.criteria.spec.ts` 是 unit 轮的**薄运行器**。见 §4。

---

## 1. 还有欠账的冻结稿(9 项 / 涉 17 份文件)

> **落地度列开头的 `` `↔…` `` 是给判据 6 读的对照标记**,不是装饰 —— 它声明本行与
> `NEXT_TASKS.md` 同编号条目的状态行**是不是同一把尺子**。取值与写法见 [§4](#4-这份台账由什么守着)。

| # | 冻结稿 | 台账 | 落地度 | 卡在谁 |
|---|---|---|---|---|
| 1 | Integration Foundation v1 T0 | P1-30 | `↔进行中` **1 / 8 PR**(PR1 schema 已交付 2026-08-28) | 维护者 2026-08-28 拍板开工(条件②③齐、④建议级;`D-IF-2` 的「上线后」理由已于 2026-08-20 换成四条件表,见 NEXT_TASKS P1-30) |
| 2 | RBAC 权限目录终态 | P1-32 | `↔进行中 7/9` **完整落地 7 / 9 PR**(PR 4 两半齐全;PR 5 已合 #1175;PR 8 **只落了前一半**) | 剩 PR 6–7(都等前端 srvf-admin-web 投用)+ PR 8 后一半「Permission 写 CRUD 退役」待维护者拍板 |
| 3 | 活动业务 v1.1 合同(6 份) | P1-28 | `↔进行中` 8 批:6 批主体完 / 2 批部分 | 施工中 |
| 4 | 架构治理 v4(3 份) | P1-29 | `↔另尺(NEXT_TASKS 的 P1-29 条目只覆盖 Phase 0,本行覆盖 v4 全 11 阶段)` 11 阶段:6 个完 + Phase 6 部分 | 施工中 |
| 5 | 企业微信 T0 | P1-25 | `↔⏸ 挂起` 代码 100%,运维 0% | 备案 |
| 6 | 证书标准库 T0(2 份) | P1-24 | `↔⏸ 挂起` 代码 100%,运维部分 | 维护者执行 |
| 7 | D-INSURANCE v3 | P1-10 | `↔⏸ 挂起` 代码 100%,部署 0% | 运维窗口 |
| 8 | 活动责任闭环 v2 | — | `↔无台账` 代码 100%,闸未开 | 维护者执行 |
| 9 | Activity OS T0-A 终态合同 | P1-33 | `↔进行中` T0-A / T0-B / Release 1 A1、A2、A3 已通过并合入 #1237/#1239/#1241 | 下一刀 A4 独立立项 |

### 1.1 欠代码的五项

**① Integration Foundation v1 —— 唯一一份零行未动**
外部系统(ICC / 车辆 / 物资 / 无人机 / 值班 / 大屏 / AI Agent / 兄弟部门自研)的安全接入地基:
ServicePrincipal 机器身份 + 可轮换凭证 + 受控 DelegationGrant + 第六 surface `integration/v1`。
序列 PR1–PR8 全 D 档、严格串行。零实施由 §2 前两条读数证明(建表数 0、surface 命中 0)。
⚠️ **「卡在谁」2026-08-24 订正**:此前写的是「等 P1-32 PR 1 落地」,**两层都错**——
(a) P1-32 的 PR 0 / PR 1 已分别由 `#1145` / `#1143` 合入,那条前置**早已解除**;
(b) 更要紧的是它**从一开始就指错了对象** —— 冻结件的 `D-IF-2`=A 定死「PR1 排在
**首次生产上线之后**开工,合并 T0 不解锁 PR1」,那才是真闸。P1-32 PR 1 只是
`NEXT_TASKS` 那张开工条件表里的第②条(两边都要给 `Permission` 挂元数据,
各干各的就是造第二份真相),不是队首。

**② RBAC 权限目录终态 —— 抽走了五项,安全与读写面均已成型**
冻结件列 PR 0…PR 8 共九项(`## Goal/PR 0` + `## PR 1`…`## PR 8`,**九**是权威源读数)。
按 PR 编号口径**完整落地 5 项**:PR 0(决策拍板,#1145)、PR 1(Catalog 单一事实源,#1143)、
PR 2(Catalog 只读 API 与角色分类,#1170)、
PR 3(控制面安全收口,3a #1147 + 3b #1151 两半都落)、
PR 4(permissionRevision + 原子 PUT,4a #1156 + 4b 读/预览面 #1171,**两半齐全**)。
**PR 5(影响预览与 Step-up)在飞**,PR 6 / 7 / 8 未动,其中 PR 7 依赖前端(srvf-admin-web)投用。
⚠️ **PR 5 合入后也别把「step-up 已生效」当完整为真** —— 旧增量端点(`POST` / `DELETE
/roles/:id/permissions`)不受二次验证管辖,窗口到 **PR 8** 退役它们为止;
射程已由 `check-role-permission-impact.ts` 的 `stepup-scope-*` 登记并在 PR 8 时强制重看。
详见 `NEXT_TASKS` 的 P1-32 状态块。
⚠️ **两把尺子别混用**:本行按**冻结件 PR 编号**计(9 项);`NEXT_TASKS` 状态行同时给出
「已合 7 刀」(PR 0/1/2/3a/3b/4a/4b)—— 那是**刀数**,不是 PR 项数。
⚠️ 冻结件写"236 条",§2 的读数是当前真值 —— **别把它写死成常量**。

**③ 活动业务 v1.1 合同 —— 两根尺子读数不同,别混用**
合同 §14 分第 0–7 批。第 0–5 批主体交付;**第 6 批(工作人员/导入/离线)未整体交付**;
**第 7 批(通知/导出/工作台/上线)只落了在途显示与 cutover 闸两刀**。
`pnpm cutover:check` 的 A 类唯一硬失败就是 9a(验收编号仍有 todo)⇒ **闸不可开**。
**两件**明确未做:终审改提交 `LedgerPostingBatch` 那座桥、②-b 换取数源。
⚠️ **2026-08-24 订正**:此处原写"三件",第三件是 worker 运维 runbook ——
它早在 `#1088`(`a1b25764`,2026-08-19)就合了(`docs/ops/activity-batch-worker-runbook.md`),
正是那一刀消掉了 §16.1 第⑦条硬红。**本节自己上一句"A 类唯一硬失败就是 9a"当时就已经和它打架了**。
⚠️ **验收编号绑完 ≠ 那批做完** —— 第 6 批的编号都已绑真用例,但那批本身没整体交付。
⚠️ **2026-08-26 起,§2 那行「已绑真实证据」里有 4 条是「已判定不做」而不是「已做」**:
万人档 `AC-054` / `AC-055` / `AC-068` / `ADV-008` 由维护者拍板**永久不做**
(一场万人用尽 ledger-commit 全部 10 个槽位,PG 共享锁表保底 12800 全实例共享
⇒ 两场并发即 `out of shared memory`,硬 ERROR 且会撒到别的 spec 上),
登记在 [`CUTOVER_SIGNOFF.md`](CUTOVER_SIGNOFF.md) §5,并在验收套件里渲染成**真用例**
(断言该豁免确实被登记、写明理由与拍板人)——**不是删掉编号**,合同里那四项仍在。
⇒ 读这行时按 `86 = 82 已绑证据 + 4 已判定不做`。规模门那一格改由
`cutover:check` 的 ⑨-b「规模测试通过」承载,那格仍是 ⏸。
⚠️ 台账口径与套件真 todo 数由 `activity-business-overhaul-acceptance.spec.ts` 的
「两把尺子」用例钉死(差一条当场红),**别靠人记得同步**。

**④ 架构治理 v4 —— 阶段过半,两条尾巴长**
合同 §11 迁移路线表**恰 11 阶段**:0 / 1A / 1J / 1D / 2 / 3 / 4 / 5 / 6 / 7 / 8。
**完整完成 6 个**:Phase 0 / 1A / 1J / 1D / 2 / 5(§2 的 guard 模式与 journey 数即其执行位读数);
**Phase 6 只完成一半** —— 仓内自拆的 6-A(尺寸棘轮建基线)已落,6-B 未完。
未完:Phase 3(部分规则仍 report)· Phase 4(状态列绝大多数仅 inventory)·
Phase 6-B(尺寸棘轮仍 report,基线仍在册)· Phase 7(债务台账待清偿)· Phase 8(条件触发,可不做)。
⚠️ **2026-08-24 订正**:§1 表此前写"7 个完",那是把半个 Phase 6(即 6-A)当整阶段算 ——
按合同的 11 阶段口径应为「6 个完 + Phase 6 部分」。**6-A / 6-B 是仓内的施工切分,不是合同阶段。**

**⑤ Activity OS T0-A —— T0-A / T0-B 已通过，Release 1 仍须逐刀串行**
本项只完成终态边界、数据所有权、迁移矩阵、接口合同和测试设计，24 项交付均在
[Activity OS T0-A 冻结合同](../archive/reviews/activity-os-t0-terminal-review.md)。
**T0-B 已通过并合入 #1236**：AI README 的主动文档纠偏、Integration 审查矩阵、核心零依赖
红区裁判与已接线结构判据、No-AI Journey 入口，以及 `ARCHITECTURE.md` 过时预设的修正均已
完成验证。**A1 已于 2026-09-01 以 #1237 独立合并**：只增加分类 / Facet 受控字典和 31/31
legacy registry，不改变现有 Activity 运行时或 API。**A2 已于 2026-09-01 以 #1239 独立合并**：
方案 A 的 Family / Version 纯 expand、独立 schema e2e、非空库 rehearsal、全套 PR CI 与红区
审批均已通过；既有 resolver、Activity 选定 Version、canonical JSON/hash/lifecycle、API/DTO/
权限/Gate、seed、回填和生产部署均未改。
**A3 已于 2026-09-01 以 #1241 独立合并**：future Family Version 的 canonical JSON/hash
工具、`draft → active → retired` 生命周期约束、第 102 条 migration 的 PostgreSQL 回归证明、全套
PR CI 与红区审批均已收口；legacy resolver/API、Activity 指针、业务 writer、API/DTO、权限/Gate、
seed、回填和生产部署均未改，DB 亦不重算 hash。A4 及以后仍须逐刀独立立项，A3 的 D 档授权不得带入。
本项不改变现有 schema、migration、AI 模块、Integration 业务面、权限码或任何 Gate。

### 1.2 欠运维的四项(代码都写完了)

| 冻结稿 | 还差什么 |
|---|---|
| **企业微信 T0** | 后台配置 / 凭证录入 / `migrate deploy` / 开 `loginEnabled`+`messageEnabled` / 工作台实跑 / 签两张 GO 单。⏸ 卡备案;之后还有一轮总评审才谈开关 |
| **证书标准库 T0 + amendments** | ① 第 67 migration(**不可逆**,DROP 七列)生产未部署 ② 首批标准:法规定义的那批已内置 seed(业余无线电 A/B/C,2026-08-25 拍板),**队内认定的仍未建** ③ 前端适配未做 |
| **D-INSURANCE v3** | PR3 `INSURANCE_ENFORCEMENT_ENABLED` 未启用、PR4 migration 未 deploy;开关前须证明旧 server=0、禁混跑 |
| **活动责任闭环 v2** | `ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED` 生产未开;legacy 认领须业务负责人逐条指定(禁止从 `publishedBy` 猜) |

> 这四项的**代码侧**是否真的到位,由 §2 末条读数(三条开关是否在配置里)给地板证明;
> **是否开启**属现实运维态,机器判不了,恒以 `current-state.md` §1 / §4 为准。

---

## 2. 机器读数

<!-- frozen-drafts:readings:begin -->
<!-- 由 `pnpm exec tsx scripts/check-frozen-drafts-ledger.ts --write` 生成;禁止手改。
     判据 `src/frozen-drafts-ledger.criteria.spec.ts` 逐字节比对,手改即红。 -->

| 读数 | 值 | 取自 |
|---|---|---|
| IF v1:ServicePrincipal / DelegationGrant 建表数 | **3** | `prisma/schema.prisma` |
| IF v1:第六 surface `integration/v1` 在 src 的命中文件数 | **3** | `src/**/*.ts(不含 .spec.ts)` |
| P1-32 PR1:`permission-catalog*` 运行时文件数 | **2** | `src/modules/permissions/` |
| P1-32:授码 / 撤码两侧是否复用控制面闸谓词 | **已接** | `src/modules/permissions/role-permissions.service.ts` |
| 权限码总数(冻结件写 236,PR0 要逐条分类的就是这张表) | **246** | `scripts/docs-counts.ts 的 typed-AST 闭包` |
| 活动 v1.1 验收编号:已绑真实证据 / 合同定义 | **90 / 95(5 条仍 it.todo)** | `合同正式版 + activity-business-overhaul-acceptance.spec.ts` |
| 治理 Phase 7:债务身份证待清偿条数 | **229** | `harness/architecture-debt.json` |
| 治理 Phase 4:状态列 governed / 登记总数 | **8 / 60** | `harness/state-machines.json` |
| 治理 Phase 6-B:尺寸基线在册文件数(仍超 700 NCLOC) | **21** | `harness/service-size-baseline.json` |
| 治理 Phase 1D:声明 Guard 模式 | **enforce** | `src/common/guards/authz-declaration.guard.ts` |
| 治理 Phase 1J:跨域金路径 journey 数 | **6** | `test/journeys/` |
| 三条"代码已落、闸未开"的开关在配置里的数量 | **3 / 3** | `src/config/app.config.ts` |

<!-- frozen-drafts:readings:end -->

---

## 3. 归档评审稿 / 计划全量分类

**分类闭集四值**(不许有未分类项 —— 这是本闸的主判据):

- `open` —— 施工依据,**仍有欠账**;必须带台账编号(无编号的写 `-`)
- `landed` —— 施工依据,已落地;不再产生欠账
- `report` —— 报告 / 审计 / 盘点 / 设计期资料,**本来就不是施工依据**
- `superseded` —— 已退场或被后续稿取代

⚠️ **诚实边界**:`landed` / `report` / `superseded` 三类是 2026-08-22 一次性定性,
**未逐份复验**(其中在本次会话里真读过代码或产物核实的,只有活动四份 T0、harness 3.0、
PostgreSQL 一致性加固、admin-api 路线图、org-position 终态这几份)。
发现某行定性错了,**直接改那一行**,不必走评审 —— 本闸保证的是"没有未分类项"与"读数不过期",
**不保证历史定性正确**。`open` 那 16 份是本次逐条核过的。

| 文件 | 分类 | 去向 / 理由 |
|---|---|---|
| `docs/archive/reviews/activity-os-t0-terminal-review.md` | open · P1-33 | Activity OS T0-A 冻结合同；T0-B 和 Release 1 以后仍待独立实施 |
| `docs/archive/reviews/activity-os-r1-a1-category-registry-review.md` | landed · P1-33 | Release 1 / A1 的 D 档 seed 变更边界、拍板与风险记录；已随 #1237 合入，评审稿冻结不回改 |
| `docs/archive/reviews/activity-os-r1-a2-template-family-version-review.md` | landed · P1-33 | Release 1 / A2 D 档 Family / Version expand；已随 #1239 合入，评审稿冻结不回改 |
| `docs/archive/reviews/activity-os-r1-a3-template-definition-lifecycle-review.md` | landed · P1-33 | Release 1 / A3 D 档 canonical/hash 与 future Version lifecycle；已随 #1241 合入，评审稿冻结不回改 |
| `docs/archive/reviews/activity-os-r1-a4-explicit-template-version-review.md` | open · P1-33 | Release 1 / A4 的 D 档评审已于 2026-09-02 按方案 A 拍板，实施中；评审稿冻结不回改 |
| `docs/archive/plans/api-client-boundary-design-period.md` | superseded | 设计期 v0,被 api-surface-policy 取代 |
| `docs/archive/plans/api-client-boundary-migration-plan.md` | landed | 五 surface 边界已成型 |
| `docs/archive/plans/architecture-v2-first-stage-blueprint.md` | superseded | archived historical material |
| `docs/archive/plans/first-release-bizcode-mapping.md` | superseded | 契约真相已改为 handoff/ + openapi.json |
| `docs/archive/plans/first-release-bootstrap-sop.md` | superseded | current-state 明标已漂移勿用;改用 ops/server-deployment-runbook.md |
| `docs/archive/plans/first-release-frontend-scope.md` | landed | 第一版联调范围已交付 |
| `docs/archive/plans/first-release-readiness-plan.md` | report | 第一版上线前规划总账,非技术方案 |
| `docs/archive/plans/harness-3.0-blueprint.md` | landed | P1–P7 全量落地 |
| `docs/archive/plans/harness-3.0-p3-rule-classification.md` | report | 恒读层重写的语义零放宽证明附件 |
| `docs/archive/plans/harness-3.0-rule-enforcement-matrix.md` | landed | P2/P3 施工依据,已随蓝图落地 |
| `docs/archive/plans/system-foundation-governance-period.md` | superseded | 治理期已退场归档 |
| `docs/archive/plans/v1.3-plan.md` | landed | V1.3 契约加固已落 |
| `docs/archive/plans/v1.4-prisma7-evaluation.md` | report | 只评估,明确不升级 |
| `docs/archive/plans/v2-design-phase/srvf-foundation-data-model-draft.md` | report | V2 设计期候选模型草案 |
| `docs/archive/plans/v2-design-phase/srvf-foundation-interview-brief.md` | report | V2 设计期访谈清单 |
| `docs/archive/plans/v2-design-phase/srvf-foundation-research.md` | report | V2 设计期研究文档 |
| `docs/archive/plans/v2-design-phase/tasks.md` | superseded | TASKS.md V2 设计期段落归档 |
| `docs/archive/plans/v2-first-stage-plan.md` | landed | V2 第一阶段已落 |
| `docs/archive/reviews/activity-business-overhaul-v1.1-lock-probe.md` | report | 万人 member lock 实测报告 |
| `docs/archive/reviews/activity-business-overhaul-v1.1/AMENDMENTS-v1.1.1.md` | open · P1-28 | 修订件 v1.1.1;冲突以它为准 |
| `docs/archive/reviews/activity-business-overhaul-v1.1/README.md` | open · P1-28 | 合同目录索引 |
| `docs/archive/reviews/activity-business-overhaul-v1.1/SRVF_活动业务全流程修正方案_正式版_v1.1.md` | open · P1-28 | 业务合同正文;AC/ADV 编号定义源 |
| `docs/archive/reviews/activity-business-overhaul-v1.1/SRVF_活动业务全流程改造_详细开发文档_v1.1.md` | open · P1-28 | 开发合同正文;§14 分 0–7 批 |
| `docs/archive/reviews/activity-business-overhaul-v1.1/SRVF_活动业务文档_v1.1_修订说明.md` | open · P1-28 | 合同修订说明,与正文并列生效 |
| `docs/archive/reviews/activity-business-overhaul-v1.1/SRVF_活动业务文档_系统性对抗性复核报告_v1.0.md` | report | 合同对抗性复核报告 |
| `docs/archive/reviews/activity-business-overhaul-v1.1/SRVF_活动业务规则_355项追踪矩阵_v1.1.md` | open · P1-28 | 355 项规则追踪矩阵 |
| `docs/archive/reviews/activity-feedback-t0-review.md` | landed | activity-feedbacks 模块已上 |
| `docs/archive/reviews/activity-positions-t0-review.md` | landed | positions / 时段已上 |
| `docs/archive/reviews/activity-responsibility-workflow-v2-review.md` | open · - | 代码已落;ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED 生产未开,legacy 认领待业务负责人逐条指定 |
| `docs/archive/reviews/activity-self-checkin-t0-review.md` | landed | activity-check-in-location-policy 等已上 |
| `docs/archive/reviews/activity-waitlist-t0-review.md` | landed | 候补递补链已上 |
| `docs/archive/reviews/admin-api-fe-integration-roadmap.md` | landed | F1–F5 全量落地(#502–#506) |
| `docs/archive/reviews/api-client-boundary-inventory.md` | report | Phase 0 客户端边界盘点 |
| `docs/archive/reviews/api-client-boundary-phase-1-review.md` | landed | Swagger tag + path alias 已落 |
| `docs/archive/reviews/app-api-p2-2-profile-review.md` | landed | P2-2 已落 |
| `docs/archive/reviews/app-api-p2-3-password-review.md` | landed | P2-3 已落 |
| `docs/archive/reviews/app-api-p2-4-activities-review.md` | landed | P2-4 已落 |
| `docs/archive/reviews/app-api-p2-5-registrations-review.md` | landed | P2-5 已落 |
| `docs/archive/reviews/app-api-p2-6-attendance-records-review.md` | landed | P2-6 已落 |
| `docs/archive/reviews/app-api-p2-7-my-certificates-review.md` | landed | P2-7 已落 |
| `docs/archive/reviews/app-api-phase-2-review.md` | landed | App API Phase 2 已落 |
| `docs/archive/reviews/app-permission-boundary-review.md` | report | Phase 0.5 专项盘点 |
| `docs/archive/reviews/architecture-governance-v4/DECISIONS-2026-08-09.md` | open · P1-29 | 维护者拍板纪要(Phase 0) |
| `docs/archive/reviews/architecture-governance-v4/DECISIONS-2026-08-13.md` | open · P1-29 | 维护者拍板纪要(Phase 5) |
| `docs/archive/reviews/architecture-governance-v4/README.md` | open · P1-29 | Phase 0–8;6-B / 7 未完,8 条件触发 |
| `docs/archive/reviews/auth-session-linearization-v0.60-review.md` | landed | v0.60 remediation 已落 |
| `docs/archive/reviews/certificate-standard-library-t0-amendments.md` | open · P1-24 | post-freeze 修正,与冻结稿并列生效 |
| `docs/archive/reviews/certificate-standard-library-t0-review.md` | open · P1-24 | 代码全落;剩 migration 67 部署 / 首批初始化 / 前端适配 |
| `docs/archive/reviews/code-architecture-boundary-review.md` | report | Phase 0.7 设计期盘点 |
| `docs/archive/reviews/concurrency-write-path-audit-codex.md` | report | 并发写路径审计(跨模型) |
| `docs/archive/reviews/concurrency-write-path-audit.md` | report | 并发写路径审计(report-only) |
| `docs/archive/reviews/content-module-review.md` | landed | CMS 第 28 模块已上 |
| `docs/archive/reviews/data-access-lifecycle-boundary-review.md` | report | Phase 0.6 专项盘点 |
| `docs/archive/reviews/department-data-scope-v0.49.0-review.md` | landed | v0.49.0 已发 |
| `docs/archive/reviews/expiry-reminder-attendance-reopen-v0.47.0-review.md` | landed | v0.47.0 已发 |
| `docs/archive/reviews/first-release-p0d-change-my-password-review.md` | landed | #115–#118 已落 |
| `docs/archive/reviews/first-release-p0e-refresh-token-review.md` | landed | refresh 轮换已落并冻结 |
| `docs/archive/reviews/first-release-p0f-pr2-config-rbac-review.md` | landed | P0-F PR-2 已落 |
| `docs/archive/reviews/first-release-p0f-pr3-users-rbac-review.md` | landed | P0-F PR-3 已落 |
| `docs/archive/reviews/first-release-p0f-pr4-audit-logs-rbac-review.md` | landed | P0-F PR-4 已落 |
| `docs/archive/reviews/full-repo-fifth-review-v0.57.0.md` | report | 第五轮全仓 review |
| `docs/archive/reviews/full-repo-first-principles-adversarial-review-v0.38.0.md` | report | 第三轮全仓 review |
| `docs/archive/reviews/full-repo-fourth-review-v0.56.0.md` | report | 第四轮全仓 review |
| `docs/archive/reviews/full-repo-systematic-review-v0.26.0.md` | report | 第一轮全仓 review |
| `docs/archive/reviews/full-repo-systematic-review-v0.34.0.md` | report | 第二轮全仓 review |
| `docs/archive/reviews/harness-2.0-t0-review.md` | landed | Harness 2.0 已落,后被 3.0 接续 |
| `docs/archive/reviews/identity-session-p0-step-up-logout-review.md` | landed | step-up + refresh-family logout 已落 |
| `docs/archive/reviews/insurance-module-review.md` | open · P1-10 | PR1–PR4 代码已交付;PR3 enable + PR4 deploy 待运维窗口 |
| `docs/archive/reviews/integration-foundation-v1-t0-terminal-review.md` | open · P1-30 | PR1 已交付(2026-08-28);余 PR2–PR8 严格串行 |
| `docs/archive/reviews/jwt-ttl-startup-validation-v0.60-review.md` | landed | v0.60 已落 |
| `docs/archive/reviews/log-query-redaction-v0.60-review.md` | landed | v0.60 已落 |
| `docs/archive/reviews/member-account-loop-v2-review.md` | landed | P1-18 队员账号闭环已落 |
| `docs/archive/reviews/member-notification-review.md` | landed | GAP-005 S1–S5 已发;余项诉求触发 |
| `docs/archive/reviews/openapi-http-parity-v0.60-review.md` | landed | v0.60 已落 |
| `docs/archive/reviews/org-position-scoped-authz-terminal-design-review.md` | landed | PR1–PR12 + 摘码微刀全序列已落 |
| `docs/archive/reviews/password-reset-by-sms-review.md` | landed | 短信找回密码已落 |
| `docs/archive/reviews/postgresql-consistency-hardening-review.md` | landed | D-ORG/SMS/RBAC/Throttle/Outbox 五条全落 |
| `docs/archive/reviews/pre-go-live-readiness-review-v0.35.0.md` | report | 上线前就绪审计 |
| `docs/archive/reviews/queue-b-otp-birthday-infra-review.md` | landed | Storage 迁移 / SMS retention / OTP / 生日祝福已落 |
| `docs/archive/reviews/rbac-permission-catalog-t0-review.md` | open · P1-32 | PR0–PR8 九项,已落 PR 0/1/2/3(4 只落 4a) |
| `docs/archive/reviews/recruitment-ocr-anti-forgery-enrichment-review.md` | landed | 鉴伪字段已落 |
| `docs/archive/reviews/recruitment-phase1-review.md` | landed | P1-11 招新一期已落 |
| `docs/archive/reviews/recruitment-phase1-systematic-review.md` | report | 招新一期开报名前终检 |
| `docs/archive/reviews/recruitment-phase2-review.md` | landed | P1-12 招新二期已落 |
| `docs/archive/reviews/recruitment-phase3-review.md` | landed | P1-13 招新三期已落 |
| `docs/archive/reviews/recruitment-phase4-loop-optimization-review.md` | landed | 闭环优化各切片已落(v0.41–v0.43) |
| `docs/archive/reviews/recruitment-realname-ocr-review.md` | landed | 腾讯云 OCR 改造已落 |
| `docs/archive/reviews/recruitment-usability-closeout-review.md` | landed | v0.41.0 可用性收口已落 |
| `docs/archive/reviews/security-concurrency-hardening-review-v0.44.0.md` | landed | v0.44.0 已发 |
| `docs/archive/reviews/slow4-rbac-business-face-review.md` | landed | P1-3 Slow-4 已落 |
| `docs/archive/reviews/sms-verification-infra-review.md` | landed | 验证码基础设施已落 |
| `docs/archive/reviews/storage-bootstrap-recovery-v0.60-review.md` | landed | v0.60 已落 |
| `docs/archive/reviews/systematic-security-hardening-review-v0.45-v0.46.md` | landed | v0.45–v0.46 四统一收口已落 |
| `docs/archive/reviews/unified-notification-dispatcher-review.md` | landed | 统一派发已落 |
| `docs/archive/reviews/wechat-mini-login-review.md` | landed | P1-8 小程序登录已落 |
| `docs/archive/reviews/wecom-integration-t0-terminal-review.md` | open · P1-25 | 代码全落;T6 全部是维护者动作,卡备案 |

---

## 4. 这份台账由什么守着

判据与计算都在 `scripts/check-frozen-drafts-ledger.ts`(在 selfGuard 内,改松要过红区人闸);
`src/frozen-drafts-ledger.criteria.spec.ts` 只是**薄运行器**,负责让 `pnpm test` 收它。

**CI 接线**:`.github/workflows/ci.yml` 的 `Diff guards`(`redzone-scan`)job 直接跑那个脚本,
**不随 docs-only 短路**;unit 轮再由薄运行器跑一遍。

> 🔴 **这句话 2026-08-24 之前是假的,而且是"自称有执法而实际没有"那一类。**
> 此前本节逐字写着"跑在 CI Fast 的 unit job 里,**不随 docs-only 短路**" ——
> 实测三步:(a) 那个 spec 的**唯一**入口是 `pnpm test`(`package.json` / 全部 workflow /
> `harness-guards.selftest.ts` 里零处提到它);(b) fast job 的 `Run unit tests` 带
> `if: needs.changeset.outputs.docs_only != 'true'`;(c) docs-only 判定 = 变更文件**全部 `*.md`**。
> ⇒ **一个只改本文件的 PR 就是 docs-only,本台账的全部判据一条都不跑** ——
> 恰好在最该拦的那批 PR 上失效。与 `#1166` 给 `NEXT_TASKS` 闸写的理由**逐字同一条**,
> 那次修了那一个、没回头看这一个。接线是本次补上的,并**顺带把既有五条判据首次真正接上 docs-only PR**。

> ⭐ 这份计算侧原名 `scripts/frozen-drafts-ledger.ts` —— 放在 `scripts/` 下却不匹配任何
> selfGuard glob(`check-*` / `generate-*` / `replay-*` / `*.selftest.*`),实测 `harness:needs`
> **0 需授权**,即零保护。「搬进 `scripts/`」不够,必须**搬成 `check-*.ts`**;2026-08-23 改名收编。

| # | 判据 | 会在什么时候红 |
|---|---|---|
| 1 | **分类完整性(双向集合相等)** | 新增一份归档评审稿却没在 §3 登记 → 红;§3 登记了已删除的文件 → 红 |
| 2 | **分类闭集** | 出现四值以外的分类 → 红;`open` 行没写台账编号 → 红 |
| 3 | **欠账表 ↔ 分类表互证** | §1 表里出现的台账编号在 §3 没有对应 `open` 行(或反过来)→ 红 |
| 4 | **读数新鲜度(逐字节)** | 手改读数、或真源变了没跑 `--write` → 红,并打印应有的块 |
| 5 | **自证非空** | 扫描面 < 80 份 / 活动编号解析不出 / 读数条数不足 → 红。**判据失去输入 ≠ 通过** |
| 6 | **跨台账落地度对照** | §1 某行对 `NEXT_TASKS` 的状态**沉默**(没有 `` `↔…` `` 标记)→ 红;标了同尺却与那边的状态种类 / 进度分数**不一致**→ 红,并**同时打印两边原文**;§1 表塌空(< 6 行)或同尺对照行数 < 4 → 红 |

### 4.1 判据 6 的对照标记(§1 落地度列开头那个 `` `↔…` ``)

**为什么不是「两边数字必须相等」**:§1.1 ③ 的标题自己就写着「**两根尺子读数不同,别混用**」
⇒ 存在**刻意不同的合法情形**,做成数值相等会当场误伤台账里最用心写的那一条。
本闸沿 `NEXT_TASKS` 状态闸同一路子:**治的是「沉默」,不是「不一致」。**

| 标记 | 什么时候用 | 闸做什么 |
|---|---|---|
| `` `↔待办` `` / `` `↔进行中` `` / `` `↔待拍板` `` / `` `↔⏸ 挂起` `` / `` `↔已收口` `` | 本行与 `NEXT_TASKS` 同编号条目**量同一件事** | 状态种类必须**逐字相等**;不等即红并打印两边原文 |
| `` `↔<状态种类> a/b` `` | 同上,且本行给得出**进度分数** | 额外要求与 `NEXT_TASKS` 状态括号**开头**的 `a/b` 相等 |
| `` `↔另尺(<说明>)` `` | 本行**刻意用另一把尺子** | 放行;说明必须有实质内容(`另尺(3/9)` 这种把数字再写一遍的会被拒) |
| `` `↔无台账` `` | 台账列是 `—`,没有 `NEXT_TASKS` 编号 | 放行,计入「射程外」;**有编号的行不许走这条通道** |

⚠️ 状态种类的白名单**直接取自** `scripts/check-next-tasks-state.ts` 的 `STATUS_KINDS`,
本文件不抄第二份 —— 抄一份的话两处漂移时「一边认一边不认」没有任何症状。
⚠️ `↔另尺(…)` 是逃生门,但**不得把闸整体关掉**:判据要求真正做过同尺对照的行数 ≥ 4
(`CROSS_COMPARED_FLOOR`),否则当场红。

**为什么扫描面不是"头部含冻结/FROZEN 的文件"**:那个方案试过并**当场否决** ——
实测漏掉 `activity-responsibility-workflow-v2-review.md`(头部写的是"业务已定版"),
而那份恰恰是"代码已落、闸未开"的欠账项。关键词判据会把**最需要看见的那份**漏掉,
所以改成"归档目录下每一份 .md 都必须有分类"。

**本闸明确不守什么**(写下来,免得后来者以为它比实际更强):

- ~~不守 §1 那些**散文描述**是否与冻结稿正文一致 —— 那要人读;~~
  **2026-08-24 收窄**:判据 6 已接管其中**可机器对照的那一半** —— §1 每行的**落地度**
  必须对 `NEXT_TASKS` 的状态行显式表态,不许沉默地互相矛盾。
  **仍不守的是**:落地度**散文本身**是否与冻结稿正文一致(那仍要人读),
  以及**数字本身是不是真的对** —— **两边一起写错仍然全绿。闸绿 ≠ 台账准。**
  ⚠️ 前提变了这条才成立:`#1166`(`22d2449e`)给 `NEXT_TASKS` 的 25 条条目各加了一行
  机器可读 `**状态**:`,散文才变成可对照的数据。**在那之前"要人读"是对的。**
- ⚠️ **判据 6 的射程外**:§1 行 8「活动责任闭环 v2」台账列是 `—`(`NEXT_TASKS` 里无对应条目)
  ⇒ 只能标 `↔无台账`,**对照不到**。要纳管得先给它一个台账编号 —— 本次刻意不擅自编,登记在此。
- 不守 `landed` / `report` / `superseded` 三类的**定性是否正确**(见 §3 诚实边界);
- 不守**运维是否真的执行了**(部署 / 备案 / 开关)—— 那是 `current-state.md` §1 的地盘;
- 不替代 `pnpm cutover:check`:活动 v1.1 能不能开闸,以那条命令的 A/B/C 三分型为准。

**读数里恒不含时间戳与 git SHA**(架构治理 v4 勘误①):派生生成物带这两样会让
字节比对新鲜度恒假红且自引用。所以本文件不写"截至某日" —— 想知道读数是哪一刻的,
看这个文件的 git 历史。
