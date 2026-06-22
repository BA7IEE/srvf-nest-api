# 交接:后端 ↔ admin 前端(srvf-admin-web)

> **canonical**(本文件在后端仓,改契约同 PR 改本文件;见 [`README.md`](README.md))。
> 字段级真相 = live `/api/docs-json`;权限码 = [`RBAC_MAP.md`](../ai-harness/RBAC_MAP.md)(155)。
> 本文件只讲这两样讲不了的:**轴模型 + 任务→端点图 + 踩坑 + 缺口**。

---

## 1. 轴模型(最重要,先读这条)

后端把一切建成**沿"所有权轴"嵌套的子资源**——URL 树本身就是一张任务驱动的信息架构图:

```
活动轴   admin/v1/activities/:id
           ├─ /registrations            报名(activityId 是路径必填段)
           └─ /attendance-sheets        考勤(同上)
队员轴   admin/v1/members/:id
           ├─ /certificates  /department  /profile
           └─ /emergency-contacts  /insurances
```

**前端要按"任务"设计页面,不是按"资源"。** 两种合法任务视图:
- **沿轴下钻**:进一个活动 → 看它的报名/考勤(作战室);进一个队员 → 看它的证书/部门/履历(队员档案)。
- **跨轴横扫**:跨所有活动看"待我审批的"(审批工作台,按 status)。

> ❌ **反模式(已发生过)**:把嵌套子资源拍平成顶级菜单 + 一个"手选父级"下拉
> (报名页选活动、考勤页选活动、证书页选队员)。这等于把后端已经建好的父子关系在 UI 层扔掉,
> 制造"上下文丢失"。看到自己在写"请先选择一个 X 才能看 Y",就停下来想想——Y 是不是该长在 X 的详情页里。

---

## 2. 能力图(任务 / 页面 → 端点)

### 2.1 活动作战室(沿活动轴下钻)— ✅ 后端全就绪,纯前端重组 IA
| 区块 | 端点 |
|---|---|
| 活动头部 + 发布/取消 | `GET /api/admin/v1/activities/:id` · `PATCH .../:id/publish` · `PATCH .../:id/cancel` |
| 报名 tab | `GET /api/admin/v1/activities/:id/registrations?statusCode=` · `POST` 代报名 · `PATCH .../:rid/{approve,reject,cancel}` · `GET .../export`(CSV) |
| 考勤 tab | `GET /api/admin/v1/activities/:id/attendance-sheets?statusCode=` · `POST` 提交单据 |
| 考勤审核详情 | `GET /api/admin/v1/attendance-sheets/:id/review-detail`(**活动摘要+单据+records含队员嵌套**,为审核页量身做的)· `PATCH .../:id/{approve,reject,final-approve,final-reject}` · `DELETE` |

> 关键:报名/考勤接口**本来就按 activityId 嵌套**——作战室是它们的自然消费者。
> `activityId` 从**路由参数**来,不要在页面顶部摆"选择活动"下拉。

### 2.2 队员 360(沿队员轴下钻)— ✅ 5 子资源 + 3 跨轴查询全就绪(跨轴只读 2026-06-23)
| tab | 端点 | 状态 |
|---|---|---|
| 基本信息 | `GET /api/admin/v1/members/:id` | ✅ |
| 证书 / 部门 / 档案 / 紧急联系人 / 保险 | `GET /api/admin/v1/members/:id/{certificates,department,profile,emergency-contacts,insurances}` | ✅ |
| 活动履历 / 考勤记录 / 贡献值 | `GET .../members/:id/registrations?statusCode=` · `GET .../members/:id/attendance-records` · `GET .../members/:id/contribution-summary` | ✅(跨轴只读 2026-06-23,见 [GAP-002](#4-缺口台账-gap-ledger))|

> 队员 360 跨轴查询备注:`registrations`/`attendance-records` 分页(`page`/`pageSize`)+ item 自带 activity 上下文(`activityId`/`activityTitle`);`attendance-records` **仅返 approved sheet 内 records**(已生效记录,镜像 app `/me` 口径);`contribution-summary` 返**生涯累计 capped 总分**(`{ memberId, contributionPoints }`,后端已按北京日封顶 1.5,**前端直接展示别再加**)。不存在/软删队员 → `MEMBER_NOT_FOUND`(15001)。

### 2.3 审批工作台(跨活动横扫"待我处理")— ✅ 后端扁平查询就绪(跨轴只读 2026-06-23)
跨所有活动按 `statusCode` 横扫报名/考勤,**脱离 `:activityId` 路径段**:`GET /api/admin/v1/registrations?statusCode=` · `GET /api/admin/v1/attendance-sheets?statusCode=`(均分页 + item 自带 activity 上下文 `activityId`/`activityTitle`)。见 [GAP-001](#4-缺口台账-gap-ledger)。

> ⚠️ 过滤参数名是 **`statusCode`**(不是草拟期写的 `status`;沿既有嵌套列表口径)。值用 registration_status / attendance_sheet_status 字典码(如 `pending`/`pass`/`approved`)。

### 2.4 其它资源管理页(CRUD,沿现状)
活动列表 `GET /api/admin/v1/activities`(多字段过滤)· 队员列表 `GET /api/admin/v1/members`(memberNo/gradeCode/status)· 字典 `system/v1/dict-*` · 组织 · 贡献值**规则** `system/v1/contribution-rules`(注:是规则,不是队员的分)· 用户/RBAC/审计 `system/v1/*`。

---

## 3. 踩坑表(gotchas)

1. **登录是 3-call**:`POST /api/auth/v1/login` → `GET /api/admin/v1/me`(身份) + `GET /api/system/v1/rbac/me/permissions`(权限码)。三个端点拆开,别假设 login 返回身份/权限。
2. **字段以 live `/api/docs-json` 为准**。任何手写指南(含本文件)的字段名都可能漂;类型从 docs-json 取。
3. **权限码不要臆造**:用真实码(如 `member.read.record` / `attendance.final-approve.sheet`),来源 = 各端点 `[rbac: x]` summary 或 [`RBAC_MAP.md`](../ai-harness/RBAC_MAP.md);禁 `*:*:*` / `permission:btn:*`。
4. **贡献值别在前端裸 SUM**:存在**全局每日封顶 1.5**(一人单北京日封顶)。前端把 `attendance_records.contributionPoints` 直接相加会**算多**。要总分用后端给的 capped 值(见 GAP-002 的 contribution-summary;在它落地前,贡献值总分一律走后端,不在前端算)。
5. **菜单是前端静态 + `permissions[]` 过滤**,后端没有菜单树端点(`asyncRoutes` / `getMenuList` 是 P0 禁区,别开)。
6. **App ≠ Admin**:`/api/app/v1/*` 是小程序面(本人视角,见 [`miniapp.md`](miniapp.md)),admin 后台不要调它。
7. **signed URL / 敏感字段**有可见级与时效;附件走 `upload-url` / `confirm-upload` 通用链路,别假设直链。

---

## 4. 缺口台账(gap-ledger)

> 前端→后端的需求簿。状态:`提出` → `已出 goal` → `已发`。

| # | 诉求(前端想做的任务) | 期望端点 | 状态 |
|---|---|---|---|
| **GAP-001** | 审批工作台:跨所有活动按 status 横扫报名/考勤 | `GET /api/admin/v1/registrations?statusCode=` · `GET /api/admin/v1/attendance-sheets?statusCode=` | ✅ **已合入 main**(`## Unreleased`,2026-06-23;[PR #432](https://github.com/BA7IEE/srvf-nest-api/pull/432);**未 bump 版本**,随下个 minor 发版)。注:过滤参数实装为 `statusCode`(非草拟期 `status`) |
| **GAP-002** | 队员 360:某队员的报名履历 / 考勤记录 / 贡献值生涯累计 | `GET .../members/:id/registrations` · `GET .../members/:id/attendance-records` · `GET .../members/:id/contribution-summary`(贡献值=实时算复用 team-join `computeCappedContribution` 封顶核,生涯 cutoff=null + 北京日封顶 1.5) | ✅ **已合入 main**(`## Unreleased`,2026-06-23;[PR #432](https://github.com/BA7IEE/srvf-nest-api/pull/432);**未 bump 版本**)。注:`attendance-records` 仅返 approved sheet 内 records |

> 备注:**活动作战室(Tier1)不是缺口**——后端全就绪,纯前端重组 IA(见 §2.1)。
> ✅ GAP-001 / GAP-002 已于 2026-06-23 合入 main(`## Unreleased`),§2.2/§2.3 已 ⛔→✅;发版(版本 bump + Release)另走收口,届时把上方「已合入 main」改「已发 vX.Y.Z」。

---

## 5. 这份文件怎么不馊

改后端 API surface / RBAC / 契约 → **同 PR** 改本文件受影响行 + `pnpm docs:handoff:openapi`(沿 [`AGENTS.md`](../../AGENTS.md) 反漂铁律)。前端对接前先读本文件 + 对 live `/api/docs-json` 核字段。
