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
| **GAP-001** | 审批工作台:跨所有活动按 status 横扫报名/考勤 | `GET /api/admin/v1/registrations?statusCode=` · `GET /api/admin/v1/attendance-sheets?statusCode=` | ✅ **已发 v0.30.0**(2026-06-23;[PR #432](https://github.com/BA7IEE/srvf-nest-api/pull/432) → bump #433 → tag `v0.30.0` / Release Latest)。注:过滤参数实装为 `statusCode`(非草拟期 `status`) |
| **GAP-002** | 队员 360:某队员的报名履历 / 考勤记录 / 贡献值生涯累计 | `GET .../members/:id/registrations` · `GET .../members/:id/attendance-records` · `GET .../members/:id/contribution-summary`(贡献值=实时算复用 team-join `computeCappedContribution` 封顶核,生涯 cutoff=null + 北京日封顶 1.5) | ✅ **已发 v0.30.0**(2026-06-23;[PR #432](https://github.com/BA7IEE/srvf-nest-api/pull/432) → bump #433 → tag `v0.30.0` / Release)。注:`attendance-records` 仅返 approved sheet 内 records |
| **GAP-003** | 工作台/首页待办汇总数字(待审报名数 / 进行中活动数 / 招新进度)— 设计期识别,待前端确认是否做仪表盘 | 一个聚合 stats 端点(或前端用各列表 `total`/分页字段拼,无新端点) | 提出 |
| **GAP-004** | 管理员自助改密(PC 个人中心「旧密码→新密码」);现 `admin/v1/me` 仅 GET 身份,无 `me/password` | `PUT /api/admin/v1/me/password`(镜像 app `me/password` 账号级豁免链路) | 提出(已确认要做,B 档待实施) |
| **GAP-005** | 向队员主动推送通知/公告(活动提醒 / 招新公告 / 紧急召集);现 notifications 模块仅"生日短信"后台任务,无 admin 推送面 | 待定:notification 推送面(涉新 schema + 新 RBAC 码 = **D 档拍板**) | 提出(已确认要做,待出 goal) |

> 备注:**活动作战室(Tier1)不是缺口**——后端全就绪,纯前端重组 IA(见 §2.1)。
> ✅ GAP-001 / GAP-002 已于 2026-06-23 **发版 v0.30.0**(#432 + bump #433 + tag/Release Latest),§2.2/§2.3 已 ⛔→✅。

---

## 5. 导航与页面设计(IA 建议 — 给前端"做哪些菜单/页面")

> 把 §1 轴模型 + §2 能力图落成具体菜单树与页面骨架,解决前端"不知道做哪些页面"。
> 端点详情对 §2,字段对 live `/api/docs-json`,权限码对 [`RBAC_MAP.md`](../ai-harness/RBAC_MAP.md)。
> **菜单树严格守 §1**:嵌套子资源只作详情页的 tab,不单独成顶级菜单。

### 5.1 业务主线(一个队员的一生 — 前端最该先懂)

整个后台围绕"陌生人 → 正式队员 → 日常出勤"。**招新(`recruitment`)与入队(`team-join`)是先后两道门,不是一回事**:

```
路人 ─公开报名→ 申请人 ─实名OCR+考核→ ①一键发号 → 志愿者(有账号/有 Member,但无部门无级别)
                                                      └ 入队申请+综合评估 → ②一键入队(设部门+级别 L1)→ 正式队员
正式队员 ─日常→ 报名活动 → 出勤 → 考勤审核 → 贡献值累计    档案维护:证书 / 保险 / 部门 / 级别
```

- **第①道门 = 招新**:对外公开报名 → OCR 实名 → 考核 → **一键发号**(`recruitment-application.promote.member`),产物 = 志愿者(有账号但无部门无级别)。
- **第②道门 = 入队**:志愿者 → 综合评估 → **一键入队**(`team-join-application.join.member`,设部门 + 级别 L1),产物 = 正式队员。

### 5.2 推荐菜单树(6 顶层组)

```
工作台 / 我的待办              ← 落地首页(见 5.4)
活动
  活动列表 ──▶ 活动作战室(详情·tab:概览│报名│考勤 ──▶ 考勤审核详情)
  审批工作台(跨活动横扫:待审报名 + 待审考勤)
队员
  队员列表 ──▶ 队员360(详情·tab:基本│部门│档案│证书│紧急联系人│保险│活动履历│考勤记录│贡献值)
  队保单(团队保险单 + 覆盖名单)
招募与入队
  招新轮次 ──▶ 报名审核(OCR·考核·一键发号)
  入队管理 ──▶ 入队申请(综合评估·一键入队)
内容发布
  内容列表 ──▶ 内容编辑器(草稿/发布/5档可见性)
系统管理
  用户管理│角色与权限│组织架构│数据字典│贡献值规则│附件配置│审计日志│短信日志│系统设置
  (个人中心走右上角头像下拉,不进侧栏)
```

**故意不做的菜单**(它们是别人的 tab):报名管理、考勤管理、证书管理、保险管理、紧急联系人、部门管理。看到要写"请先选择一个 X 才能看 Y"就回 §1 反模式。

> **分组可演进**:① "系统管理" 一拥挤就拆「基础数据」(字典 / 组织 / 贡献值规则 / 附件配置)+「系统与权限」(用户 / 角色 / 审计 / 短信日志 / 各设置),按使用频率 + 权限层级分;② 审批工作台**只做日常高频**(报名 / 考勤);招新报名、入队申请的待处理队列是季节性的,**留在各自模块**别塞进工作台(要"全局待办数"等 [GAP-003](#4-缺口台账-gap-ledger) 的 stats 端点统一出)。

### 5.3 页面骨架 + 可见性码(组件按 Element Plus / pure-admin `PureTable`)

| 页面 | 主端点(详见 §2) | 进入/列表可见性码 | 骨架要点 |
|---|---|---|---|
| 活动列表 → 作战室 | `activities` + `/:id/{registrations,attendance-sheets}` | 列表 `[auth]` 仅登录;写操作 `activity.*.record` | `el-tabs` 三 tab;`activityId` 取**路由参数**不放下拉;考勤进 `review-detail` 审核页(初审/终审) |
| 审批工作台 | `registrations?statusCode=` · `attendance-sheets?statusCode=` | `activity-registration.read.record` · `attendance.read.sheet` | 跨活动扁平列表 + `statusCode` 切;item 自带活动上下文;`el-drawer` 内审批 |
| 队员列表 → 360 | `members` + 8 子资源(§2.2) | `member.read.record`(各子 tab 另持各自 read 码) | `el-tabs` 九 tab;贡献值用 `contribution-summary` capped 值,**别裸 SUM**(§3 #4) |
| 队保单 | `team-insurance-policies` | `team-insurance-policy.read.record` | 左保单表 + 右覆盖名单(`el-transfer` 或加/移弹窗) |
| 招新轮次 / 报名审核 | `recruitment/{cycles,applications}` | `recruitment-cycle.read.record` · `recruitment-application.read.record` | `el-steps` 表流程;证件照走 signed-URL;`el-drawer` 标门槛/综合评定/一键发号 |
| 入队管理 / 入队申请 | `team-join/{cycles,applications}` | `team-join-cycle.read.record` · `team-join-application.read.record` | 同上;一键入队弹窗选部门(`el-tree-select`)+ 默认级别 L1 |
| 内容发布 | `contents` | `content.read.record` | 富文本 + 封面 `el-upload` + 可见性下拉(5 档)+ 状态机按钮 |
| 用户管理 | `admin/v1/users` | `user.read.account` | CRUD;自我保护 / 最后超管后端拦,按错误码提示 |
| 角色与权限 | `system/v1/{roles,permissions,user-roles}` | `rbac.role.read` / `rbac.permission.read` | 角色授权 `el-tree`/`el-transfer` |
| 组织架构 | `admin/v1/organizations` | `org.read.node` | `el-tree` 增删改(已内置根 + 15 部门) |
| 数据字典 | `system/v1/dict-{types,items}` | `dict.read.type` / `dict.read.item` | 左类型右项联动;内置项有防误删守卫 |
| 贡献值规则 | `system/v1/contribution-rules` | `contribution.read.rule` | 是**规则**不是队员的分,别和 360 贡献值混 |
| 附件配置 | `system/v1/attachment-{type,mime,size-limit}-configs` | `attachment-config.read.*` | 三表 override-with-default,三 tab |
| 审计日志 | `system/v1/audit-logs` | `audit-log.read.entry` | 只读 + 时间范围筛选;详情 `el-drawer` |
| 短信日志 | `system/v1/sms-send-logs` | `sms-send-log.read.list` | 只读 `PureTable`(手机号**掩码**);独立页,别折进系统设置 |
| 系统设置 | `{storage,sms,wechat,realname}-settings` | `*-setting.read.singleton` | 单例 `el-form`;密钥掩码回显;reset 凭证多为仅超管可见 |
| 个人中心(头像下拉,非侧栏) | `admin/v1/me`(身份;改密见 [GAP-004](#4-缺口台账-gap-ledger)) | `[auth]` 仅登录 | `el-descriptions` 展示身份/角色;**自助改密端点是缺口**(GAP-004) |

> 可见性码只列"能否看见该菜单/列表"的 read 码;**按钮级码(approve / promote / final-approve …)另查** §2 + 端点 `[rbac:]` summary(沿 §3 #3,**禁臆造**)。菜单 = 前端静态路由 + `permissions[]` 过滤(§3 #5,后端无菜单树端点)。

> **页面细化(后端已就绪,这些动作别漏)**:
> - **证书 tab 含核验工作流**:`PATCH .../members/:id/certificates/:cid/{verify,reject}`(待核验→已核验 / 已拒绝,`reject` 须填 `verifyNote`)+ `GET .../qualification-flag`(资质标记)。不是"上传 + 表格"那么简单,要有 状态 + 核验通过 / 拒绝 动作。
> - **队员列表是全 CRUD**:`members` 有 `POST`(手动建队员)/ `PATCH :id` / `PATCH :id/status` / `DELETE`(软删)。**招新发号是主路径**,但 admin 可手动建 / 改 / 改状态 / 软删(历史数据、纠错)——§5.1 funnel 别误读成"队员只能从招新来"。
> - **活动作战室·概览** 摆出 `capacity`(名额,空=不限)/ `registrationDeadline`(报名截止)/ `requiresInsurance`(需保险),且**发布 / 取消是状态机**(`draft → published → completed`,可 `cancel`);报名 / 考勤动作按 `published` 解锁。
> - **角色 / 权限改完要刷缓存**:角色与权限页放一个"重载权限缓存"按钮(`system/v1/rbac` reload,`rbac.config.reload`),否则改完绑定不即时生效。

### 5.4 工作台 / 首页

最实用的落地页是"**有什么等我处理**"(待审报名 / 考勤),而非报表。**建议直接把「审批工作台」设为登录默认路由**:后端**无聚合 stats 端点**(数字卡片 `el-statistic` 现只能靠各列表 `total` 拼),与其先做个喂不饱的仪表盘,不如用工作台兜底,待 [GAP-003](#4-缺口台账-gap-ledger) 落地再加汇总卡片。

---

## 6. 这份文件怎么不馊

改后端 API surface / RBAC / 契约 → **同 PR** 改本文件受影响行 + `pnpm docs:handoff:openapi`(沿 [`AGENTS.md`](../../AGENTS.md) 反漂铁律)。前端对接前先读本文件 + 对 live `/api/docs-json` 核字段。
