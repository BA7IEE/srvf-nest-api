# 交接:后端 ↔ admin 前端(srvf-admin-web)

> **canonical**(本文件在后端仓,改契约同 PR 改本文件;见 [`README.md`](README.md))。
> 字段级真相 = live `/api/docs-json`;权限码 = [`RBAC_MAP.md`](../ai-harness/RBAC_MAP.md)(191)。
> 本文件只讲这两样讲不了的:**轴模型 + 任务→端点图 + 踩坑 + 缺口**。

---

## 1. 轴模型(最重要,先读这条)

后端把一切建成**沿"所有权轴"嵌套的子资源**——URL 树本身就是一张任务驱动的信息架构图:

```
活动轴   admin/v1/activities/:id
           ├─ /registrations            报名(activityId 是路径必填段)
           └─ /attendance-sheets        考勤(同上)
队员轴   admin/v1/members/:id
           ├─ /certificates  /memberships  /profile   (/department 旧单部门面 deprecated → memberships)
           └─ /emergency-contacts  /insurances
```

**前端要按"任务"设计页面,不是按"资源"。** 两种合法任务视图:
- **沿轴下钻**:进一个活动 → 看它的报名/考勤(作战室);进一个队员 → 看它的证书/部门/履历(队员档案)。
- **跨轴横扫**:跨所有活动看"待我审批的"(审批工作台,按 status)。

> ❌ **反模式(已发生过)**:把嵌套子资源拍平成顶级菜单 + 一个"手选父级"下拉
> (报名页选活动、考勤页选活动、证书页选队员)。这等于把后端已经建好的父子关系在 UI 层扔掉,
> 制造"上下文丢失"。看到自己在写"请先选择一个 X 才能看 Y",就停下来想想——Y 是不是该长在 X 的详情页里。

> 📎 **本批新增两类资源的归位(守本轴纪律)**:队员**组织归属**(memberships,终态 scoped-authz PR2)是**队员轴**子资源 → 只作队员 360 的一个 tab(§2.2),**不做**顶级"归属管理"菜单 + 手选队员;**职务定义 / 职务规则**(positions / position-rules,PR3)是**全局配置**(不属任何实例轴)→ 归"系统管理/基础数据",与数据字典 / 组织架构并列(§2.6)。
>
> 📎 **PR4–PR6 三类新资源的归位(同守本轴纪律)**:**任职**(position-assignments,PR4)是**组织轴 + 队员轴双轴**子资源 → 组织架构树选中节点后的"在任职务"详情面板(挂在既有"组织架构"菜单项,不新开菜单;§2.6)+ 队员 360 的"任职"tab(§2.2),**不做**顶级"任职管理"菜单 + 手选组织/队员;**分管**(supervision-assignments,PR5)与**角色绑定**(role-bindings,PR6)是**系统管理配置面**(与"角色与权限""职务定义"并列,§2.6/§5.2)——它们各自面向队员/组织的范围展示查询(`supervision-scope`/`supervisors`)只是队员 360、组织架构树里的**只读**辅助信息,不是独立管理入口。

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

> ⚠️ **考勤终审判权收紧(终态 scoped-authz PR9,2026-07-02 起生效;考勤终审是全仓首个真正切到 scoped 判权的业务面;**2026-07-03 摘码微刀 #482 后终审权彻底改道**,取代下方旧版"biz-admin 全局终审不变"口径)**:`final-approve` 新增两个专用错误码——**`22074` 自审拒绝**(提交人 == 终审人;**SUPER_ADMIN 也拒**,没有任何配置能放开)/ **`22075` 同人拒绝**(一级审核人 == 终审人;**默认禁止**,运维可设 env `ATTENDANCE_ALLOW_SAME_REVIEWER=true` 放开,严格字符串匹配)。**`final-reject` 不受这两条约束**——同一张单据,驳回操作没有自审/同人限制(不对称设计,e2e 已锁死这个差异,不是漏做)。前端终审按钮**必须单独处理 22074/22075**,给出对应文案(如「不能终审自己提交的考勤单据」/「一级审核人不得再终审同一张考勤单据」),不能笼统按旧的"权限不足"(`30100`)文案兜底——这两个码本质是"数据完整性约束"而不是"没权限",文案不该说"你没有权限"。**🔴 权限来源(2026-07-03 摘码微刀 #482 后终态)**:持 `biz-admin` 的 ADMIN **不再天然拥有**终审权——不建任何绑定直接调 `final-approve`/`final-reject` 会拿**权限不足 `30100`**(不是 22074/22075,见下方判定顺序)。终审权只来自两条路径之一:① 给某人的组织任职挂一条 `attendance-final-reviewer` 角色的 role-binding(经 `POSITION_ASSIGNMENT` 主体绑定,**换届撤任职即自动失权**,零代码改动;详见 §2.6)② `SUPER_ADMIN` 兜底(不受摘码影响,但自审 `22074` 对 SA 一样拒)。`biz-admin` 的其余 6 个考勤动作(create/read/update/delete + 一级 approve/reject)**不受影响**,仍全局可用。**判定顺序(易错点)**:约束否决只发生在"确实持有终审权"之后——没有 scoped 绑定、也不是 SUPER_ADMIN 的人直接调终审端点,会先撞**权限不足 `30100`**,根本走不到 22074/22075 这一层判断;只有真正持有终审权的人才可能撞上这两个数据完整性码。**单管理员部署注意**:若唯一的管理员只持 `biz-admin`(无 scoped 终审绑定),他**终审不了任何单据**——终审要么用 `SUPER_ADMIN` 账号,要么先给某人建任职 + 绑 `attendance-final-reviewer`(参数样例见 [`RBAC_MAP.md` §5](../ai-harness/RBAC_MAP.md)/上线步骤见 [`ops/scoped-authz-go-live-checklist.md`](../ops/scoped-authz-go-live-checklist.md));`ATTENDANCE_ALLOW_SAME_REVIEWER` env 只影响 22075(同人),不能替代持权问题。想确认"某人到底能不能终审某张单" → 用 §2.6 的「权限解释」端点(PR10)直接查,不用猜或翻权限表。

### 2.2 队员 360(沿队员轴下钻)— ✅ 6 子资源(部门→memberships 升级 PR2;+任职 PR4)+ 3 跨轴查询全就绪(跨轴只读 2026-06-23)
| tab | 端点 | 状态 |
|---|---|---|
| 基本信息 | `GET /api/admin/v1/members/:id` | ✅ |
| 证书 / 档案 / 紧急联系人 / 保险 | `GET /api/admin/v1/members/:id/{certificates,profile,emergency-contacts,insurances}` | ✅ |
| **组织归属(memberships)** — 主/兼/临时/支援多归属 + 任期 | `GET/POST .../members/:id/memberships` · `PATCH/DELETE .../members/:id/memberships/:id`(**终态 scoped-authz PR2**,已发 main)| ✅(旧 `/department` 单部门面 deprecated,见下备注)|
| **任职(position-assignments)** — 该队员在组织体系内担任的职务,含撤销历史 | `GET .../members/:id/position-assignments`(**终态 scoped-authz PR4**,已发 main;含 ACTIVE/REVOKED 全量,任命/撤销动作在组织架构侧发起,见 §2.6)| ✅ |
| 活动履历 / 考勤记录 / 贡献值 | `GET .../members/:id/registrations?statusCode=` · `GET .../members/:id/attendance-records` · `GET .../members/:id/contribution-summary` | ✅(跨轴只读 2026-06-23,见 [GAP-002](#4-缺口台账-gap-ledger))|

> 队员 360 跨轴查询备注:`registrations`/`attendance-records` 分页(`page`/`pageSize`)+ item 自带 activity 上下文(`activityId`/`activityTitle`);`attendance-records` **仅返 approved sheet 内 records**(已生效记录,镜像 app `/me` 口径);`contribution-summary` 返**生涯累计 capped 总分**(`{ memberId, contributionPoints }`,后端已按北京日封顶 1.5,**前端直接展示别再加**)。不存在/软删队员 → `MEMBER_NOT_FOUND`(15001)。

> **组织归属(memberships)= 部门面升级(终态 scoped-authz PR2,已发 main)**:一个队员可有多条归属——**主 PRIMARY**(至多一条 active)/ **兼 SECONDARY** / **临时 TEMPORARY** / **支援 SUPPORT**,各带任期(`startedAt` / `endedAt`)+ 原因(`reason`),支持历史留痕。端点 `admin/v1/members/:memberId/memberships`:`GET` 列全部含历史(`membership.list.record`)· `POST` 新增指定 `membershipType`(`membership.set.record`)· `PATCH :id` 改类型 / 任期 / 原因〔不改 status〕(`membership.set.record`)· `DELETE :id` 结束归属〔status=ENDED + endedAt,留痕非物删〕(`membership.end.record`);**换组织 = 结束旧 + 新建**(不就地改 organizationId)。4 码全绑 **ops-admin**;`membership.read.record` 已 seed 但**本刀无端点承接**(为未来 `GET :id` 预留的孤码)。**旧单部门端点 `GET/PUT/DELETE .../members/:memberId/department`(3 端点,`member-department.{read,set,clear}.current`)deprecated-但保留一版**——内部映射到 active PRIMARY membership;**新面一律用 memberships,别再对 `/department` 开新 UI**。

> **任职(position-assignments)= 组织轴 + 队员轴双轴子资源(终态 scoped-authz PR4,已发 main)**:本 tab 只读展示该队员的任职(`GET .../members/:memberId/position-assignments`,`position-assignment.read.record`);**任命 / 撤销动作在组织架构侧发起**(§2.6 组织轴),不在本 tab 内操作,避免"队员 360 里手选组织再任命"的反模式。字段含 `isConcurrent`(兼任标记,如"副队长（兼）",纯展示不影响授权)、`appointmentSource`(任命来源自由串)、`appointedByUserId`/`revokedByUserId`。**若该队员同时是分管人**(supervision-assignment,PR5,与职务正交,§2.6),其分管范围可用 `GET .../members/:memberId/supervision-scope` 只读查询(`supervision-assignment.read.record`),同样只展示不管理,建/改/撤销分管走 §2.6 的分管管理面。**🔴 任职记录的存在不代表该队员已获得对应权限**——判权语义见 §2.6 落地进度声明。

### 2.3 审批工作台(跨活动横扫"待我处理")— ✅ 后端扁平查询就绪(跨轴只读 2026-06-23)
跨所有活动按 `statusCode` 横扫报名/考勤,**脱离 `:activityId` 路径段**:`GET /api/admin/v1/registrations?statusCode=` · `GET /api/admin/v1/attendance-sheets?statusCode=`(均分页 + item 自带 activity 上下文 `activityId`/`activityTitle`)。见 [GAP-001](#4-缺口台账-gap-ledger)。

> ⚠️ 过滤参数名是 **`statusCode`**(不是草拟期写的 `status`;沿既有嵌套列表口径)。值用 registration_status / attendance_sheet_status 字典码(如 `pending`/`pass`/`approved`)。

> ⚠️ **scoped-authz 提示(PR12,2026-07-02)**:本页两个端点是**扁平跨轴列表**,设计上**仍 GLOBAL-only**——纯 scoped 持有者(无 GLOBAL 角色,如仅凭职务推导出的 `org-admin`/`group-manager`)访问会拿 `30100`,即便他在树内对单条报名/考勤已有点动作权限也一样(点动作走 §2.1 的嵌套端点,如 `PATCH .../registrations/:rid/approve`)。列表按 scope 过滤(QueryService 读下推)是序列外后续 goal,诉求触发再排。

### 2.4 其它资源管理页(CRUD,沿现状)
活动列表 `GET /api/admin/v1/activities`(多字段过滤)· 队员列表 `GET /api/admin/v1/members`(memberNo/gradeCode/status)· 字典 `system/v1/dict-*` · 组织 · 贡献值**规则** `system/v1/contribution-rules`(注:是规则,不是队员的分)· 用户/RBAC/审计 `system/v1/*`。

### 2.5 通知管理(站内信撰写 / 发布 + 微信订阅渠道 + 系统定向 + 短信兜底)— ✅ S1+S2+S3+S4+S5 后端就绪(v0.32.0 已发)

统一通知模块 S1 站内信渠道 + S2 微信订阅 quota 渠道 + S3 producer 接入 + S4 活动·考勤 producer 定向触发 + S5 短信兜底渠道(GAP-005 S1–S5 全切片;冻结评审稿 [`unified-notification-dispatcher-review.md`](../archive/reviews/unified-notification-dispatcher-review.md))。admin 撰写/发布,会员 app 拉取站内信 feed(未读红点);S2 起 admin 可勾微信渠道,发布时向已订阅会员机会式推送。**S3 = 系统自动定向通知**:招新**发号 / 入队**完成后,后端自动向当事队员发一条**定向**站内信(发号另带微信),admin 面**无新操作**(producer 内部直调派发器,无新端点/无新 RBAC 码);会员侧 feed 见 [`miniapp.md`](miniapp.md)。**S4 = 活动·考勤系统定向**:管理端**报名审批(通过/驳回)/ 活动取消 / 考勤终审通过**三处操作后,后端自动向相关队员发**定向**站内信(报名本人 / 已报名者 fan-out / 考勤表内每位队员;`activity-reminder` 类型,**仅站内**,微信 opt-in 延后);admin 面**同样无新操作**(三 producer 各自 commit 后直调派发器,无新端点/无新 RBAC 码/无新 BizCode),会员侧 feed 见 [`miniapp.md`](miniapp.md)。**S5 = 短信兜底(紧急召集;admin 显式发起 + 计费确认)**:管理端对**已发布且勾了"短信"渠道**的通知,点"发送短信" → **必须二次确认计费**:前端先以 `confirmed:false` 调 `POST admin/v1/notifications/{id}/send-sms` **预览** `recipientCount`(「将向 N 人发短信 = N 条计费」),用户确认后再以 `confirmed:true` 真发(向**可见且有手机**的队员逐人发"请打开 App 查看"短信;新 RBAC 码 `notification.send.sms` 162→163;见 §2.5)。**短信永不随发布自动发**(成本动作显式 gating);未声明短信渠道 / 未发布 → `31013`,短信通道未配置 → `24030`,缺 `confirmed` → 400;手机号一律掩码。**真·全员短信批处理异步未做**(若受众过大致延迟另立项)。

| 任务 / 页面 | 端点 | 鉴权 |
|---|---|---|
| 通知列表(草稿/已发/归档 + 类型/可见档/置顶过滤;readCount 触达)| `GET /api/admin/v1/notifications?statusCode=&notificationTypeCode=&visibilityCode=&pinned=` | `[rbac: notification.read.record]` |
| 新建草稿 | `POST /api/admin/v1/notifications`(title/body/notificationTypeCode/visibilityCode/visibleOrganizationIds/pinned)| `[rbac: notification.create.record]` |
| 详情(含 body + readCount,**不自增**)| `GET /api/admin/v1/notifications/{id}` | `[rbac: notification.read.record]` |
| 编辑(draft/published 可改,archived 冻结 → 31030)| `PATCH /api/admin/v1/notifications/{id}` | `[rbac: notification.update.record]` |
| 软删(任意态)| `DELETE /api/admin/v1/notifications/{id}` | `[rbac: notification.delete.record]` |
| 发布 / 撤回 / 归档(状态机 draft→published→archived,立即生效无 cron;非法跃迁 31030)| `POST …/notifications/{id}/{publish,unpublish,archive}` | `[rbac: notification.publish.record]` |
| **S5 发送短信兜底**(紧急召集;须已发布 + channels 含 sms,否则 31013;通道未配 24030)。**计费确认必需**:`confirmed:false` → 预览 `recipientCount`(零发送);`confirmed:true` → 真发(每收件人 1 条计费);缺 `confirmed` → 400 | `POST /api/admin/v1/notifications/{id}/send-sms`(body: `confirmed: boolean`;返 `{confirmed, recipientCount, sent, failed, skipped}`)| `[rbac: notification.send.sms]` |

**字段/可见性**:可见档 4 选 1 `member` / `formal_member` / `department` / `management`(**通知去 public**,会员面专属);`department` 档须填活跃部门 orgId 数组(否则 31012);`notificationTypeCode` ∈ `notification_type` 字典(activity-reminder/recruitment/emergency/general)。统一形状列 `audienceType`/`sourceType`/`channels` 出参回显。**会员侧站内信 feed**(list/未读红点/标记已读)见 [`miniapp.md`](miniapp.md)。

**S2 微信渠道勾选**:create/update 入参 `channels`(数组,值 ∈ `["in-app","wechat","sms"]`〔S5 放开 `sms`〕;**站内恒发**,后端强制含 `in-app`;不传 = 仅站内)。勾 `wechat` 后 **publish 时**后端在事务外向「该类型已配微信模板 + 可见 + 有订阅 quota」的会员逐人推送(非订阅者不打扰);投递成败落 `NotificationDelivery`(本期无 admin 查询端点,运维看库;`recipientRef` 为掩码 openid,非明文)。**前端只需在通知编辑页加渠道勾选**,微信推送由后端 publish 自动触发,无独立"发送"按钮。**`sms` 渠道例外**:勾 `sms` 仅"声明可短信兜底",**短信永不随 publish 自动发**;真发须 admin 在该通知详情页显式点"发送短信" → 走上表 S5 `send-sms` 端点(计费二次确认)。

| S2 任务 / 页面 | 端点 | 鉴权 |
|---|---|---|
| 列微信订阅模板配置(各类型 → templateId / 启用态)| `GET /api/admin/v1/notification-wechat-templates` | `[rbac: notification.read.record]` |
| 配置某类型的微信模板 ID + 启用(运营改不重部署;类型须 ∈ 字典否则 31010)| `PUT /api/admin/v1/notification-wechat-templates/{typeCode}`(body: `templateId?` / `enabled?` / `remarks?`)| `[rbac: notification.update.template]` |

**模板配置(D-N3 运营可配)**:`templateId` = 小程序后台审批后拿到的订阅消息模板 ID,**默认 null = 该类型微信渠道不可发**(运维上线后台审批后经此端点填)。字段映射(通知 → 微信 `data` key,如 `thing1`=标题)**内置代码**,运维上线须按真实模板字段名核对(见评审稿 §3.5)。

### 2.6 组织 · 职务 · 任职 · 分管 · 角色绑定 · 权限诊断 · 公告导入(终态 scoped-authz PR1–PR12 + 摘码微刀已全序列发 main,序列闭幕)— ⚠️ 看清落地进度再造 UI

「组织职务 + 分管 + scoped RBAC + 统一鉴权」终态按 §11 序列逐刀落地(冻结稿已归档,全序列实施完成:[`org-position-scoped-authz-terminal-design-review.md`](../archive/reviews/org-position-scoped-authz-terminal-design-review.md))。**PR1–PR12 全 12 刀 + 摘码微刀(#482)均已发 main,序列就此闭幕**,新增以下配置面(队员**组织归属** memberships 属队员轴见 §2.2;**任职** position-assignments 亦双轴,队员轴一侧同见 §2.2;**公告导入是一次性上线初始化工具、非常规管理页**,见表后说明):

| 任务 / 页面 | 端点 | 鉴权 |
|---|---|---|
| **组织架构 reparent**(重挂父级;PR1)| `POST /api/admin/v1/organizations/:id/move`(body 必填非空 `parentId`;不支持移成根)| `[rbac: org.move.node]` |
| **职务定义 列表 / 增改删**(全局复用;PR3)| `GET/POST /api/admin/v1/positions` · `GET/PATCH/DELETE .../positions/:id` | `[rbac: position.{read,create,update,delete}.definition]` |
| **职务规则 列表 / 增改删**(某组织类别可设哪些职务;PR3)| `GET/POST /api/admin/v1/position-rules` · `PATCH/DELETE .../position-rules/:id`(列表按 `nodeTypeCode` 过滤;无 `GET :id`)| `[rbac: position-rule.{read,create,update,delete}.record]` |
| **组织在任职务**(该组织当前职务任命;PR4,组织轴)| `GET/POST /api/admin/v1/organizations/:orgId/position-assignments`(GET 仅 status=ACTIVE;POST=任命,5 项校验见下)| `[rbac: position-assignment.{read,create}.record]` |
| **任职撤销 / 变更历史**(扁平;PR4)| `POST /api/admin/v1/position-assignments/:id/revoke` · `GET .../:id/history`(以 :id 锚定人-组织-职务三元组,返全量含 REVOKED)| `[rbac: position-assignment.revoke.record]` / `[rbac: position-assignment.read.history]` |
| **该组织被谁分管**(直接 + 祖先继承;PR5,组织轴只读)| `GET /api/admin/v1/organizations/:orgId/supervisors`(标 `coverage` DIRECT/INHERITED)| `[rbac: supervision-assignment.read.record]` |
| **分管 列表 / 建 / 改 / 撤销**(扁平管理面;PR5)| `GET/POST /api/admin/v1/supervision-assignments` · `PATCH .../:id` · `POST .../:id/revoke` | `[rbac: supervision-assignment.{read,create,update,revoke}.record]` |
| **角色绑定 列表 / 建 / 改 / 软删**(带 scope 的角色绑定;PR6)| `GET/POST /api/admin/v1/role-bindings` · `PATCH/DELETE .../:id` | `[rbac: role-binding.{read,create,update,delete}.record]` |
| **权限解释 / 判权诊断**(诊断读,deny 是 200 数据;PR10)| `POST /api/admin/v1/authz/explain` | `[rbac: authz.explain.decision]` |
| **公告导入 预览 / 执行**(2026 任命 staging 双锚落库工具;PR11,**一次性上线初始化用,平时不用**)| `POST /api/admin/v1/announcement-import/preview`(零写入诊断)· `POST .../announcement-import/execute`(幂等落库)| `[rbac: announcement-import.{preview,execute}.record]` |

**reparent**:重挂组织节点父级,事务内重算闭包表;守护——禁改根节点父级(`ORGANIZATION_PARENT_CHANGE_FORBIDDEN`)/ 目标父 = 自身或后代(成环)(`ORGANIZATION_PARENT_CYCLE`)/ 父不存在(`ORGANIZATION_PARENT_NOT_FOUND`)→ 拒。

**职务定义(positions)= 全局复用定义**:6 内置(队长 / 副队长 / 部长 / 副部长 / 组长 / 副组长);类别 `categoryCode` = `LEADER` 正职 / `DEPUTY` 副职 / `STAFF` 干事(STAFF 留口未内置);`code` kebab 创建后不可改;被职务规则引用时禁删(`POSITION_IN_USE` 32003)。**职务规则(position-rules)= 绑定关系**:某**组织类别**(`nodeTypeCode`,取 node_type 字典值)可设哪些职务(30 内置默认规则;`(nodeTypeCode, positionId)` 唯一)。positions + rules **8 码全绑 ops-admin**。

**任职(position-assignments)= 组织轴 + 队员轴双轴子资源(队员轴一侧见 §2.2)**:`POST organizations/:orgId/position-assignments` 任命时校验 5 项,均清晰归码——职务适配(该组织类别须有对应 active 职务规则,否则 `POSITION_ASSIGNMENT_RULE_NOT_MATCHED` 32022)/ 单人独占(职务 `allowMultiple=false` 且已有在任者 → `POSITION_ASSIGNMENT_SINGLE_HOLDER` 32023)/ 兼任(职务 `allowConcurrent=false` 且该队员已有其它在任 → `POSITION_ASSIGNMENT_CONCURRENT_FORBIDDEN` 32024)/ 归属要求(职务 `requireMembership=true` 时,队员须在本组织或其祖先有 active membership,经组织闭包表求祖先集判定 → `POSITION_ASSIGNMENT_MEMBERSHIP_REQUIRED` 32025)/ 任期(`endedAt` 须晚于 `startedAt` → `POSITION_ASSIGNMENT_TENURE_INVALID` 32026)。`isConcurrent` 是入参可选的**兼任标记**(如"副队长（兼）"),纯展示用途,**不影响任何校验或授权**。撤销 = `status: ACTIVE→REVOKED` + 记撤销人 `revokedByUserId` + `endedAt=now`(**非物理删**,记录保留供历史链 `.../:id/history` 查询);`AssignmentStatus` 三态 `ACTIVE`/`ENDED`/`REVOKED`,但**`ENDED` 当前无任何代码路径写入**(留作保留态,眼下只会看到 `ACTIVE`/`REVOKED`,别按 `ENDED` 做过滤分支)。**4 码全绑 ops-admin**。

**分管(supervision-assignments)= 与职务正交的独立监督关系**:`POST supervision-assignments` **不要求** supervisor 持有任何职务(R5 拍板:副职头衔零推导);`scopeMode` 二选一——`EXACT` 仅该组织节点 / `TREE` 含全部下级(创建默认 TREE)。两条只读查询**均为展示用,经组织闭包表现算,不是判权依据**:`supervision-scope`(某队员的分管范围)按其 active 分管逐条展开 `expandedOrganizationIds`(EXACT=`[organizationId]`;TREE=该组织 + 全部后代,含自身);`supervisors`(某组织被谁分管)聚合**直接**(`coverage=DIRECT`,分管记录直落该组织)+ **继承**(`coverage=INHERITED`,某祖先有 active `TREE` 分管而覆盖到本组织)两类,出参嵌套完整 `supervisionAssignment` 对象。撤销同任职语义(`status→REVOKED` + 撤销人 + `endedAt`,非物理删);`SupervisionStatus` 三态同任职,`ENDED` 同样当前无写入路径。同人对同组织仅一条 active(`SUPERVISION_ALREADY_EXISTS` 33002)。**4 码全绑 ops-admin**(三读端点——列表/`supervision-scope`/`supervisors`——共用 `read.record`)。

**角色绑定(role-bindings)= UserRole 终态形态,scoped 各型入库即止**:`principalType`(`USER`/`MEMBER`/`POSITION_ASSIGNMENT`/`SYSTEM`,非 SYSTEM 必填 `principalId`,**多态无 FK**,校验存在性归口对应实体)× `scopeType`(`GLOBAL`/`ORGANIZATION`/`ORGANIZATION_TREE`/`ACTIVITY`/`RESOURCE`/`SELF`)决定哪个 `scope*` 字段必填(`ORGANIZATION`/`ORGANIZATION_TREE`→`scopeOrgId`;`ACTIVITY`→`scopeActivityId`;`RESOURCE`→`scopeResourceType`+`scopeResourceId`;`GLOBAL`/`SELF` 均不填),字段与类型不一致 → `ROLE_BINDING_SCOPE_INVALID`(34003)/ principal 不一致 → `ROLE_BINDING_PRINCIPAL_INVALID`(34004)。`BindingStatus` 三态 `ACTIVE`/`ENDED`/`SUSPENDED`:`DELETE` 端点 = 软删,写 `status=ENDED`+`endedAt`+`deletedAt`(**与任职/分管的"REVOKED 不物删"不同,本资源软删会真的从列表消失**);`SUSPENDED` 可经 `PATCH` 手动置入(临时挂起而不撤销),后端不自动触发,判权同样不认。**4 码全绑 ops-admin**。**与既有"角色与权限"页是两个入口、同一张底表**——`system/v1/users/:userId/roles`(既有,仅 USER+GLOBAL,契约不变,`rbac.user-role.*` 码,继续可用)vs 本节 `role-bindings`(新,PR6,通用 CRUD,含 scoped,`role-binding.*` 码);两边建的 GLOBAL 绑定互相可见。**🔴 全篇最关键的一条(2026-07-03 PR12 + 摘码微刀 #482 已发后更新,以此为准)**:`RbacService`(全仓绝大多数业务面仍在用的老判权服务)**永远只读** `principalType=USER` 且 `scopeType=GLOBAL` 的绑定(等价旧 `user_roles`),这条不因 PR8 上线而改变。**真正会读 scoped 绑定(`ORGANIZATION`/`ORGANIZATION_TREE`/`ACTIVITY`/`RESOURCE`/`SELF`)的是新判权大脑 `AuthzService`(PR8,已发)**,目前**消费者 = 考勤终审(`final-approve`/`final-reject`,PR9,见 §2.1)+ participation 三模块点动作**(`activities`/`activity-registrations`/`attendances`,PR12,24 处判权位点,见 §2.1/§2.3)。也就是说:一条 scoped 绑定要真正生效,不但要建对绑定,还要该绑定授予的权限码恰好被这两批消费者之一读取;**其余动作**(证书核验、队员管理、招新/入队、内容发布、统一通知……)**不管建多少条 scoped 绑定,目前一律不影响任何人的实际权限**,因为对应业务代码根本没调 `AuthzService`(其余业务面逐面接入,诉求触发再出 goal,不再挂 GAP-007)。**前端在角色绑定管理页务必按此精确提示**(scopeType 非 GLOBAL 时,把旧文案换成**「当前对考勤终审 + 活动/报名/考勤的单点动作生效(扁平跨轴列表与新建活动仍 GLOBAL-only);其余业务面待后续批逐面接入」**),既避免运营误以为"建了 scoped 绑定 = 全面立刻生效",也避免反过来误以为"发了就什么都没用"。**排查某条绑定到底有没有生效** → 用下文「权限解释」端点(PR10)一键查。

**权限解释(authz/explain)= 判权大脑对外的可解释性出口(PR10)**:入参 `{userId, action, resourceRef?}`——`userId` 是**被解释判权的目标用户**(不是调用者),不存在/已软删 → `10001`;`action` 是权限码格式字符串(如 `attendance.final-approve.sheet`),**不要求码真实存在**——查一个不存在的码会直接返 `reason=no_permission`,这本身就是诊断结论;`resourceRef` 可选,缺省 = 无 ref 退化路径(等价全局判定),`resourceRef.type` 须 ∈ 11 类白名单(`activity`/`attendance_sheet`/`attendance_record`/`activity_registration`/`member`/`member_profile`/`certificate`/`team_join_application`/`recruitment_application`/`notification`/`attachment`),不在白名单 → 通用 `400`。出参 `{targetUser{id,username,role,status,memberId}, decision:{allow,reason,matchedGrant?,resource?}}`。**🔴 deny 是 200 数据不是错误**:合法入参一律 `200` 返 `decision`,`resourceRef` 指向不存在/已软删资源 → `200` + `reason='resource_not_found'`,**不是** `404`;HTTP 非 200 只有三种——调用者自己没有 `authz.explain.decision` 码 → `30100`、目标 `userId` 不存在或已软删 → `10001`、DTO 校验不过(如 `resourceRef.type` 不在白名单)→ `400`。`decision.reason` 是 **11 值稳定枚举**并已入 OpenAPI 契约锁:allow 侧 `super_admin_pass` / `matched`;deny 侧 `no_permission` / `out_of_scope` / `out_of_supervised_scope` / `expired_grant` / `inactive_org` / `self_approval_forbidden`(即 22074 语义,见 §2.1)/ `same_reviewer_forbidden`(即 22075 语义)/ `sensitive_denied`(保留位)/ `resource_not_found`。`matchedGrant.source` ∈ `super_admin`/`role_binding`/`position`/`supervision`,附对应绑定 / 任职 / 分管的**内部 id 原样返**(ops-admin 面可见,不脱敏)。**`DISABLED` 用户也可以被 explain**(`status` 原样返——线上真实请求会被 `JwtStrategy` 挡在更前面,这层是给运营的诊断视图,不是登录判定)。**无 audit**(诊断读,PR10 拍板不记)。**用途**:运营/前端排查"为什么这个人能/不能做某事"——一次调用拿到「谁 · 因哪条授权 · 在什么范围(`scopeType`+`scopeId`)· 对什么资源(`resource.organizationId`/`organizationPath`/属主)· 允许还是拒绝」,建议做成「角色与权限」或「角色绑定」页里的一个辅助查询入口,**不必**做成独立高频菜单(见 §5.3)。

**公告导入(announcement-import)= preview/execute 两段式一次性落库工具(PR11)**:批量把《任命公告》类结构化数据(组节点 + 任职 + 分管)导入系统,**面向"上线初始化 / 批量换届"场景,不是日常管理页**——正常运营下建组织/任职/分管请用本节上方各自的常规端点逐条操作;**前端可以不为它单独做页面**,运营/维护者直接用 API 客户端(curl/Postman)调用即可,若要做也应做成一次性工具页而非常规菜单(不建议加进 §5.2 导航树)。两路由复用同一请求形状 `{organizations?, positions?, supervisions?}`(结构化行数组,后端**不做**自然语言解析,公告文本→行由运营/AI 线下产出);`preview` **零写入**逐行诊断,`execute` 幂等落库(单行失败不影响其它行,可重跑)。响应逐行 `status` ∈ 四态:`ok`(可创建)/ `blocked`(缺字段或校验不过,`reasons[]` 说明,`bizCode` 可能为 `null`〔合成诊断〕)/ `already-exists`(命中已有记录,execute 语境下视为幂等 skip)/ `needs-manual`(仅 `displayName` 唯一命中 active 队员时的建议,回显 `suggestedMemberNo`,**仍需人工确认,从不自动升级为 `ok`**)。**双锚铁律(R7,execute 强制)**:人按 `memberNo`、组织按 `code`,**绝不按姓名自动落库**——`positions[]`/`supervisions[]` 行在 `execute` 下缺 `memberNo`(即便 `displayName` 唯一命中)直接 `blocked`。组织行 `nodeType` 恒为 `group`(只建组级节点,建队/部/总队级不支持);组织 `code` 全局唯一,且同请求内可被 `positions[]`/`supervisions[]` 的 `orgCode` 引用(父组织行必须先于引用它的子行声明)。**本工具只做锚定解析 + 编排**——任命 5 项校验(职务适配/单人独占/兼任/归属要求/任期)、分管防重/任期校验、组织闭包维护、audit 写入,全部只存在于被复用的 `OrganizationsService`/`PositionAssignmentsService`/`SupervisionAssignmentsService` 内部,与本节上方各自端点走**同一份**校验代码(不存在"预览说 ok、执行却因校验分支不同而失败"的两套逻辑漂移)。**BD-2 终审绑定不含在导入范围内**——导入只落 `PositionAssignment`(+ 必要 `Membership`),运营需在导入完成后另行调 `POST admin/v1/role-bindings` 手工挂 `attendance-final-reviewer`(参数样例见 [`RBAC_MAP.md` §5](../ai-harness/RBAC_MAP.md));完整上线执行顺序见 [`ops/scoped-authz-go-live-checklist.md`](../ops/scoped-authz-go-live-checklist.md)。**R13**:本节及任何前端对接文档示例一律用假数据(如 `T0001`/`张三`),真实姓名/编号绝不进文档。

> ⚠️ **scoped-authz 落地进度(2026-07-03 摘码微刀 #482 收官,序列 PR1–PR12 + 摘码微刀已全发 main,**GAP-007 完结,整条终态序列就此闭幕**;前端照当前状态造 UI 即可,不会再有下一刀改变本节口径)**:
> - **判权现状一句话**:统一判权大脑 `AuthzService` **已上线**(PR8);**scoped-live 业务面 = 考勤终审**(`final-approve`/`final-reject`,PR9)+ **participation 三模块点动作**(`activities`/`activity-registrations`/`attendances`,PR12,24 处判权位点)。点动作(改/删/发布/取消单个活动;审批/驳回/管理员取消单条报名;单据 read/update/delete/approve/reject)带具体资源 ref,嵌套列表(路径带 `:activityId`)带父活动 ref;**扁平跨轴列表(如 `admin/v1/attendance-sheets`/`admin/v1/registrations`,见 §2.3)与新建活动(`activity.create`)仍 GLOBAL-only**(不带 ref,纯 scoped 持有者访问仍 `30100`;把 tree scope 变成列表查询条件的 QueryService 读下推是序列外后续 goal)。**除以上两批外的其余所有业务面**(证书核验、队员管理、招新/入队、内容发布、统一通知……)**仍只认 GLOBAL 角色绑定**,scoped 绑定对它们**零影响**(逐面迁移诉求触发再出 goal,不再挂 GAP-007)。
> - **🔴 关键语义(必读,替换旧版"仅考勤终审"的表述)**:**任职(position-assignments,PR4)+ 一条显式指向该任职的角色绑定(role-bindings 绑 `attendance-final-reviewer`,PR6)两步都做,才会对考勤终审真实生效**(见 §2.1);只做任职不建绑定 = 不生效。**PR12 起新增一条不同形态的生效路径,且不需要额外显式绑定**:队长/部长(经"职务→角色 policy",PR7,自动推导为 `org-admin`@本组织树)、组长(推导为 `group-manager`@本组)、分管人(推导为 `org-supervisor`@分管范围)现在对 participation 三模块的点动作**在其组织树/分管范围内真实生效**——例如 team-leader/dept-leader 经 `org-admin`@TREE 可在本树内管理活动(update/publish/cancel)+ 审批本树报名 + 为本树活动建考勤单/一级审核,树外仍 `30100`;group-leader 经 `group-manager`@TREE 可在本组一级审核考勤;`org-supervisor` 经分管推导可读分管树内单据,树外 `out_of_supervised_scope`。**`org-admin`/`group-manager`/`org-supervisor` 三角色均不含终审两码**——即使已有任职或分管记录,**不会**因此自动获得终审权,终审仍必须走上一条路径单独显式绑定。**🔴 摘码微刀(#482,2026-07-03)后的关键变化**:持 `biz-admin` 的 ADMIN **不再天然拥有**终审权(不建任何绑定直调终审端点 → `30100`,见 §2.1);`biz-admin` 的其余业务码(含 participation 全部点动作对应的 GLOBAL 码)不受影响。前端在这些管理面的文案/交互上按此精确化——role-bindings 页具体文案见上一段。
> - **角色与权限页现在会看到 7 个内置角色**:原有 3 个(`biz-admin`/`ops-admin`/`member`)+ 4 个新增(`org-admin` 56 码 / `group-manager` 22 码 / `org-supervisor` 4 码 / `attendance-final-reviewer` 3 码)。**这 4 个新角色 seed 阶段零持有、是 scoped 判权的载体**,设计上经"职务→角色 policy"(PR7,自动推导)或显式 RoleBinding(如给某个 POSITION_ASSIGNMENT 绑 `attendance-final-reviewer`)生效——**不建议在"角色与权限"页把它们当普通全局角色直接手工绑给某个 user**(技术上绑了也不会报错,但绑了只有 GLOBAL 语义,绕开了整套职务/分管推导设计,业务含义会跟运营预期不符)。
> - **排查工具**:不确定某人某权限到底生不生效 → 用「权限解释」端点(`authz/explain`,PR10,见上段)一键查,不用猜。
> - **GAP-007 序列已全部落地(PR1–PR12 + 摘码微刀 #482),详见 §4 [GAP-007](#4-缺口台账-gap-ledger)**——序列内不再有"未落地"项;members/certificates/content/notifications 等其余业务面迁移、QueryService 扁平列表 scoped 过滤、16 个 `attachment.*.self` 收敛为 SELF scope、监督角色可配化、存量队员批量导入工具均已归入**序列外**候选清单,诉求触发再单独出 goal(不再挂本 GAP)。

---

## 3. 踩坑表(gotchas)

1. **登录是 3-call**:`POST /api/auth/v1/login` → `GET /api/admin/v1/me`(身份) + `GET /api/system/v1/rbac/me/permissions`(权限码)。三个端点拆开,别假设 login 返回身份/权限。
2. **字段以 live `/api/docs-json` 为准**。任何手写指南(含本文件)的字段名都可能漂;类型从 docs-json 取。
3. **权限码不要臆造**:用真实码(如 `member.read.record` / `attendance.final-approve.sheet`),来源 = 各端点 `[rbac: x]` summary 或 [`RBAC_MAP.md`](../ai-harness/RBAC_MAP.md);禁 `*:*:*` / `permission:btn:*`。
4. **贡献值别在前端裸 SUM**:存在**全局每日封顶 1.5**(一人单北京日封顶)。前端把 `attendance_records.contributionPoints` 直接相加会**算多**。要总分用后端给的 capped 值(见 GAP-002 的 contribution-summary;在它落地前,贡献值总分一律走后端,不在前端算)。
5. **菜单是前端静态 + `permissions[]` 过滤**,后端没有菜单树端点(`asyncRoutes` / `getMenuList` 是 P0 禁区,别开)。
6. **App ≠ Admin**:`/api/app/v1/*` 是小程序面(本人视角,见 [`miniapp.md`](miniapp.md)),admin 后台不要调它。**唯一例外 = 账号级自助端点**:`PUT app/v1/me/password`(改密)/ `app/v1/me/phone*`(换绑手机)是有意的"账号级豁免"(`D-P2-3-1` 锁定,无 canUseApp 闸、`admin without member 允许使用`)——admin 个人中心改密 / 换手机直接调它们,**不必造 `admin/v1` 镜像**。
7. **signed URL / 敏感字段**有可见级与时效;附件走 `upload-url` / `confirm-upload` 通用链路,别假设直链。
8. **考勤终审(`final-approve`)自 2026-07-02 起真收紧,2026-07-03 摘码微刀(#482)后终审权彻底改道**:新增 `22074`(自审拒,提交人==终审人,SUPER_ADMIN 也拒)/ `22075`(同人拒,一级审核人==终审人,默认禁止,env `ATTENDANCE_ALLOW_SAME_REVIEWER=true` 可放开)两个专用错误码;`final-reject` **不受影响**(不对称,别当成漏做)。**判定顺序:约束否决只发生在"确实持有终审权"之后**——`biz-admin` 已不天然持终审权(摘码后),没有 scoped 绑定(任职 + `attendance-final-reviewer`)也不是 `SUPER_ADMIN` 的人直接调终审端点会先拿**权限不足 `30100`**,根本走不到 22074/22075 这一层;只有真正持有终审权的人(SA,或绑了 `attendance-final-reviewer` 的任职)才可能撞上这两个数据完整性码。终审按钮要单独处理 22074/22075/30100 三种情形给对应文案,别混着按通用权限不足处理。排查"某人为什么终审不了" → 用 `authz/explain` 端点直接查。详见 §2.1 / §2.6。

---

## 4. 缺口台账(gap-ledger)

> 前端→后端的需求簿。状态:`提出` → `已出 goal` → `已发`。

| # | 诉求(前端想做的任务) | 期望端点 | 状态 |
|---|---|---|---|
| **GAP-001** | 审批工作台:跨所有活动按 status 横扫报名/考勤 | `GET /api/admin/v1/registrations?statusCode=` · `GET /api/admin/v1/attendance-sheets?statusCode=` | ✅ **已发 v0.30.0**(2026-06-23;[PR #432](https://github.com/BA7IEE/srvf-nest-api/pull/432) → bump #433 → tag `v0.30.0` / Release Latest)。注:过滤参数实装为 `statusCode`(非草拟期 `status`) |
| **GAP-002** | 队员 360:某队员的报名履历 / 考勤记录 / 贡献值生涯累计 | `GET .../members/:id/registrations` · `GET .../members/:id/attendance-records` · `GET .../members/:id/contribution-summary`(贡献值=实时算复用 team-join `computeCappedContribution` 封顶核,生涯 cutoff=null + 北京日封顶 1.5) | ✅ **已发 v0.30.0**(2026-06-23;[PR #432](https://github.com/BA7IEE/srvf-nest-api/pull/432) → bump #433 → tag `v0.30.0` / Release)。注:`attendance-records` 仅返 approved sheet 内 records |
| **GAP-003** | 工作台/首页待办汇总数字(待审报名数 / 进行中活动数 / 招新进度)— 设计期识别,待前端确认是否做仪表盘 | 一个聚合 stats 端点(或前端用各列表 `total`/分页字段拼,无新端点);**招新进度**部分 = `GET /api/admin/v1/recruitment/cycles/{id}/stats` | 🟡 **部分交付**(2026-06-24):**招新进度**部分已由招新工作台 stats 端点答复(GAP-006 S2,见下,**已发 v0.31.0**;五组聚合 今日/待处理/门槛进度/综合评定/公示发号)。**待审报名数 / 进行中活动数**仍未做(可待活动域 stats 合并,或前端用各列表 `total` 拼,无强需新端点) |
| **GAP-004** | 管理员自助改密(PC 个人中心「旧→新」)— **调研结论:非缺口**。`app/v1/me/password` 是账号级自助(`D-P2-3-1` 锁定,"admin without member 允许使用"),admin 用自身 JWT 即可改密(复用 `changeMyPassword`:同事务撤销 refresh + `password.change.self` 审计 + 限流) | 无需新端点;admin 个人中心直接调账号级 `app/v1/me/password`(例外见踩坑 #6) | ✅ 已澄清(2026-06-23 用户拍板=文档化,不造 `admin/v1` 镜像) |
| **GAP-005** | 向队员主动推送通知/公告(活动提醒 / 招新公告 / 紧急召集);现 notifications 模块仅"生日短信"后台任务,无 admin 推送面 | **统一多渠道**(站内 / 微信订阅 quota / 短信)+ 派发器(Effect)+ producer 只创建任务;T0 修订冻结评审稿 [`archive/reviews/unified-notification-dispatcher-review.md`](../archive/reviews/unified-notification-dispatcher-review.md)(supersede 原 [`member-notification-review.md`](../archive/reviews/member-notification-review.md) 站内信架构;招新 §9 / GAP-006 S7 触发挂此)| ✅ **已发 v0.32.0**(S1–S5 全切片 #449–#453 → bump #454 → tag `v0.32.0` / Release Latest;2026-06-27;以下逐切片 `本 PR` / Unreleased 为各自交付时态历史标注)。**S1 站内信渠道已交付**(本 PR,Unreleased;T0 修订评审 2026-06-25 已冻结):**admin 8 端点** `admin/v1/notifications`(CRUD + 状态机 publish/unpublish/archive;R 模式 `notification.*` 5 RBAC 码 156→161;见 §2.5)+ **app 4 端点** `app/v1/notifications`(站内信 feed:list/unread-count/detail/mark-read;canUseApp 准入 + 4 档可见性**复用 content.visibility 去 public** + 未读红点;mark-read 幂等;见 [`miniapp.md`](miniapp.md))。状态机/可见性镜像 content 零第二套;统一形状列就位不返工;BizCode 310xx 5 码。**S2 微信订阅 quota 渠道已交付**(本 PR,Unreleased):admin create/update 加 `channels` 勾选(可含 wechat),publish 含 wechat → **事务外**向「该类型已配模板 + 可见 + 有订阅 quota」会员逐人推送(非订阅者不打扰,投递落 `NotificationDelivery`);**+app 2 端点** `app/v1/notifications/subscriptions`(ack 上报授权 quota +1 封顶 / status 查剩余配额,见 [`miniapp.md`](miniapp.md))+ **admin 2 端点** `admin/v1/notification-wechat-templates`(模板配置运营可配,新码 `notification.update.template` 161→162;见 §2.5);微信 subscribe-send 能力 additive 扩 `wechat/`(stable_token 缓存 + 8s + token 失效刷一次重试,L3 token/openid 零明文)。**S3 producer 接入 + 派发器 Effect 正式化已交付**(本 PR,Unreleased):`NotificationDispatcher`(architecture-boundary §3.6 **首个真实 Effect**;`dispatchTargeted` 建已发布定向行 directed/system/authorUserId=null/跳过 draft 直 published → 站内 + 微信复用 S2)由招新 **发号**(`recruitment-promotion`,promote commit 后,站内+微信,payload memberNo + 入队入口)与 **入队**(`team-join-enrollment`,join commit 后,仅站内,payload 部门+正式队员)在业务事务**外** try-catch 直调(**派发失败不破坏 promote/入队行为锁**;防环单向 producer→notifications);`Notification.recipientMemberId` 定向收件人(会员 feed **仅本人可见**,他人 404 防枚举);**0 新端点 / 0 新 RBAC 码(162 不变)/ 0 BizCode**(producer 内调,admin 面无新操作)。**报名前 5 触发不做**(报名受理/转人工/门槛/评定/公示:申请人那时非队员,S1/S2 够不着,维持**查询进度 pull**)。**S4 活动·考勤 producer 定向触发已交付**(本 PR,Unreleased):**报名审批结果**(approve/reject → 报名本人)/ **活动取消**(cancel → 遍历已报名者 pending+pass fan-out)/ **考勤终审结果·贡献值**(finalApprove → sheet 内逐 record 本人)三处 producer 在各自业务事务 **commit 后、事务外、try-catch 永不抛**直调 `dispatchTargeted`(`activity-reminder` 类型,**仅站内** channels=['in-app'],微信 opt-in 延后);**派发失败绝不破坏取消状态机 / 报名审批状态机 / 考勤 finalApprove + 贡献值**行为锁(注入失败 e2e 断言三处业务仍成功);防环单向 producer→notifications;**0 schema / 0 migration / 0 新端点 / 0 新 RBAC 码(162 不变)/ 0 BizCode**(纯 producer 内调,复用 S3 派发器 + 既有 `notification_type` 字典)。**S5 短信兜底渠道已交付**(本 PR,Unreleased;末位切片,含真实计费外发):**admin 1 端点** `POST admin/v1/notifications/{id}/send-sms`(新码 `notification.send.sms` 162→163;见 §2.5)= **紧急召集兜底,admin 显式发起 + 计费确认必需**——`confirmed:false` 预览 `recipientCount`(可见且有手机的可计费受众,零发送),`confirmed:true` 真发(逐人经 `SmsProviderRouter.sendNotification` 单发零变量"请打开 App 查看"短信 + `NotificationDelivery`/`sms_send_logs` 记账,手机号 maskPhone);**短信永不随 publish 自动发**(站内+微信优先,成本动作显式 gating);前置闸须 **published + channels 含 `sms`**(否则 `31013`)、通道未配置 → `24030`、缺 `confirmed` → 400;防滥发继承同号封顶 10/间隔 60s/同日同模板幂等 + FAILED 逐人不阻断;审计复用 `notification.publish` 伞事件 `operation='send-sms'` + 收件人计数(无新 audit 串)。**0 新表**(复用 `NotificationDelivery`/`sms_send_logs`)+ 第 30 migration(`sms_settings.templateIdNotification` 1 列)。**运维须**填真实 `templateIdNotification`(零变量模板须先过审)。**报名前 openid 非会员推送路 / 真·全员短信批处理异步**待后续切片另出 goal。**至此 GAP-005 S1–S5 全切片落地**(招新 S7 通知阻塞解除)|
| **GAP-006** | 招新→入队完整闭环优化(招新工作台 stats / 新人进度模型 / OCR 复核分流 / H5 手机身份链 / promote 志愿者化 / 批量操作 / RBAC 字段分级 等 12 域)— T0 评审已冻结、零代码,按切片另出 goal | 冻结评审稿 [`archive/reviews/recruitment-phase4-loop-optimization-review.md`](../archive/reviews/recruitment-phase4-loop-optimization-review.md)(其 §7 工作台 stats **含 GAP-003「招新进度」部分**;其 §9 通知闭环**挂 GAP-005 落地后**)| ✅ **已发 v0.31.0**(S1–S6 全 7 切片 #439–#445 → bump #446 → tag `v0.31.0` / Release Latest;2026-06-24;以下逐切片 `#NNN` / Unreleased 为各自交付时态历史标注):**S1 状态业务文案 + 新人进度模型**已发(#439,Unreleased)· **S2 招新工作台 stats**已发(#440,Unreleased;`GET …/cycles/{id}/stats` 五组只读聚合,答 GAP-003「招新进度」)· **S3 RBAC 敏感字段分级**已发(#441;新码 `recruitment-application.read.sensitive`——报名详情明文证件号/手机 + 证件照 signed-URL 改判敏感码,`read.record` 收窄为脱敏;biz-admin 同持双码)· **S4a H5 + 手机身份链**已发(#442)· **S4b OCR 六分流 + 重拍计数**已交付(本 PR,Unreleased):submit 六分流〔matched→verified / 模糊·防伪首次→retake 不落记录 / 不一致→三选一 / 上游首次→retry;**forgery·ocr_error H5 会话连续 2 次**才落 `manual_review`〔high/system〕,计数落会话表预建列〕;application **+4 列 additive 无 enum**;进度模型 +`retake/confirm/manual_high` 三态;**S2 待人工三栏升真 `riskLevel`**;admin 报名列表 +`riskLevel` 过滤、admin DTO +`riskLevel`/`manualReviewReason`(人工队列三栏分流/分组);**申请人侧绝不暴露风险分级**(高风险中性文案);**S5 promote 志愿者化 + 入队门禁双兼容**已交付(Unreleased):promote 改写 `gradeCode='volunteer'` + 建 **VOL 归口部门**(`Organization.code='VOL'`,≠ VOD);入队**两处门禁**(自助发起 + 一键入队)改用共享纯函数 `isUnenrolledVolunteer` **双兼容**(新 `volunteer`+VOL / legacy `null`+零部门);一键入队写改「**软删 VOL + 建目标部门**」守 `member_departments` 单部门唯一;历史成员**零迁移**;`join_source` 字典补 `recruitment` 项;新错误码 `28044`(VOL 部门缺失/非 ACTIVE 时 promote 清晰失败)。**S6 批量操作**已交付(Unreleased):**3 批量端点纯加,零 schema / 零新 RBAC 码**——批量标门槛 `POST …/applications/batch-mark-threshold`(匹配键 临时编号/手机/姓名+手机,签到导入由前端解析为数组;复用单行 `markThreshold` = 逐行幂等 + 逐行容错〔不整批回滚〕+ 自动推进;返 per-row + 批次汇总)· 批量导出 `POST …/applications/export`(按筛选导 CSV;**持 `read.sensitive` → 明文列 / 仅 `read.record` → 脱敏列**,复用 S3 `toAdminDto`)· 一键发号前预检 `GET …/cycles/{id}/promote-precheck`(纯读;复用 `decidePromotionIssuance` **结构性保证「预检=实发」**;per-row 可发/跳过 + 六类原因 + 重复 openid 高亮 + 缺字段 flag + 特殊证件 + 汇总)。**S7 通知闭环 = 部分交付**(本 PR,Unreleased,经 GAP-005 S3):招新 6 触发中**发号 / 入队结果** 2 个(申请人此时已是队员)已接入统一通知派发器 → 当事队员收到系统**定向**站内信(发号另带微信);**报名前 5 触发**(报名受理/转人工/门槛/评定/公示)申请人非队员、定向通知够不着 → **维持现状靠查询进度 pull**(`POST open/v1/recruitment/applications/query` 进度模型,见 S1),openid 非会员推送路另立项 |
| **GAP-007** | 终态「组织职务 + 分管 + scoped RBAC + 统一鉴权」落地序列(§11 PR1–PR12 逐刀)— 组织基座 / 多归属 / 职务配置 / 任职 / 分管 / scoped 判权 / 可解释性 | 冻结稿(已归档,全序列实施完成)[`org-position-scoped-authz-terminal-design-review.md`](../archive/reviews/org-position-scoped-authz-terminal-design-review.md) | ✅ **已全量落地(2026-07-03,PR1–PR12 + 摘码微刀全发 main,序列闭幕,序列内不单独发版)**:**PR1 组织基座**(reparent `org.move.node` + 闭包表,[#465](https://github.com/BA7IEE/srvf-nest-api/pull/465))· **PR2 Membership**(多归属 memberships,[#466](https://github.com/BA7IEE/srvf-nest-api/pull/466))· **PR3 职务定义**(positions + position-rules,[#467](https://github.com/BA7IEE/srvf-nest-api/pull/467))· **PR4 任职**(position-assignments 双轴 + 撤销 + 历史,[#469](https://github.com/BA7IEE/srvf-nest-api/pull/469))· **PR5 分管**(supervision-assignments,与职务正交,[#470](https://github.com/BA7IEE/srvf-nest-api/pull/470))· **PR6 RoleBinding**(带 scope 角色绑定 + UserRole 无损升级 = 判权唯一读源,[#471](https://github.com/BA7IEE/srvf-nest-api/pull/471))· **PR7 职务→角色 policy**(seed-only,3 新角色 org-admin/group-manager/org-supervisor,零持有零端点,[#473](https://github.com/BA7IEE/srvf-nest-api/pull/473))· **PR8 AuthzService/ResourceResolver**(统一判权大脑,三源推导 + covers + ActionConstraint,零消费者、无 ref 逐字等价 `rbac.can`,[#474](https://github.com/BA7IEE/srvf-nest-api/pull/474))· **PR9 考勤终审接线**(`finalApprove`/`finalReject` 切 authz = **首个业务消费者 + 首次现网真收紧**,新增 22074/22075 + 第 7 角色 `attendance-final-reviewer`,[#475](https://github.com/BA7IEE/srvf-nest-api/pull/475))· **PR10 authz/explain 诊断端点**(`POST admin/v1/authz/explain`,[#476](https://github.com/BA7IEE/srvf-nest-api/pull/476))· **PR11 公告导入**(2026 任命 staging 双锚落库工具 preview/execute,一次性上线初始化用,[#478](https://github.com/BA7IEE/srvf-nest-api/pull/478),见 §2.6)· **PR12 逐面迁移第一批(participation)**(`activities`/`activity-registrations`/`attendances` 三模块 24 处判权位点切 authz,scoped 持有者获点动作能力、GLOBAL 持有者行为逐字不变,[#479](https://github.com/BA7IEE/srvf-nest-api/pull/479))**均已发**(能力见 §2.1 / §2.2 / §2.3 / §2.6)· **摘码微刀**(`biz-admin` 摘除考勤终审两码 74→72,终审权改道 scoped 绑定或 SUPER_ADMIN 兜底,[#482](https://github.com/BA7IEE/srvf-nest-api/pull/482))。前端**现可做** memberships / positions / position-rules / 任职 / 分管 / role-bindings **全部录入面 + authz/explain 诊断查询 + 公告导入一次性工具**(端点明细见 §2.6 / §2.2,字段以 live `/api/docs-json` 为准);**⚠️ scoped 判权当前生效范围 = 考勤终审(final-approve/final-reject)+ participation 三模块点动作**(扁平跨轴列表与新建活动仍 GLOBAL-only)——其余业务面仍只认 `RoleBinding(GLOBAL)`,详见 §2.6 落地进度声明。**序列外候选(诉求触发再出 goal,不再挂本 GAP)**:members/certificates/content/notifications 等其余业务面逐面迁移 `rbac.can`→`authz.can`;QueryService 把 tree scope 下推成列表查询条件(扁平跨轴列表 scoped 过滤);16 个 `attachment.*.self` 收敛为 SELF scope;监督角色(`org-supervisor`)可配化(如分管可代签等写权);存量队员批量导入工具(preview/execute 镜像 announcement-import,同 R13 约束,登记于 [`NEXT_TASKS.md`](../ai-harness/NEXT_TASKS.md)) |

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
路人 ─公开报名→ 申请人 ─实名OCR+考核→ ①一键发号 → 志愿者(有账号/有 Member;gradeCode='volunteer' + VOL 归口部门〔S5〕)
                                                      └ 入队申请+综合评估 → ②一键入队(软删 VOL 部门 + 设目标部门 + 级别 L1)→ 正式队员
正式队员 ─日常→ 报名活动 → 出勤 → 考勤审核 → 贡献值累计    档案维护:证书 / 保险 / 部门 / 级别
```

- **第①道门 = 招新**:对外公开报名 → OCR 实名 → 考核 → **一键发号**(`recruitment-application.promote.member`),产物 = 志愿者。**S5(Unreleased)起**显式化:`gradeCode='volunteer'` + 挂 **VOL 归口部门**(`Organization.code='VOL'`,≠ VOD 志愿者组织部);历史(S5 前)发号的志愿者仍为 `null`+零部门,入队门禁**双兼容**(两种都认作"未入队志愿者")。
- **第②道门 = 入队**:志愿者 → 综合评估 → **一键入队**(`team-join-application.join.member`):新志愿者**软删 VOL 归口部门** + 建**目标部门** + 升级别 L1;legacy(零部门)直接建目标部门。守 `member_departments` 单部门唯一(任一时刻仅 1 条 active 归属)。产物 = 正式队员。

> 注:队员的**部门归属现由 memberships 建模**(终态 scoped-authz PR2,§2.2);发号 / 入队的**写路径已内部重指向** active **PRIMARY** membership,**admin 面行为逐字不变**(前端仍调 promote / join,无需改),"单部门唯一"现由 memberships 的 PRIMARY-active 唯一约束承接。**独立的多归属管理**(主 / 兼 / 临时 / 支援)见队员 360 的**组织归属 tab**(§2.2),与入队 funnel 分开。

### 5.2 推荐菜单树(6 顶层组)

```
工作台 / 我的待办              ← 落地首页(见 5.4)
活动
  活动列表 ──▶ 活动作战室(详情·tab:概览│报名│考勤 ──▶ 考勤审核详情)
  审批工作台(跨活动横扫:待审报名 + 待审考勤)
队员
  队员列表 ──▶ 队员360(详情·tab:基本│组织归属│任职│档案│证书│紧急联系人│保险│活动履历│考勤记录│贡献值)
  队保单(团队保险单 + 覆盖名单)
招募与入队
  招新轮次 ──▶ 报名审核(OCR·考核·一键发号)
  入队管理 ──▶ 入队申请(综合评估·一键入队)
内容发布
  内容列表 ──▶ 内容编辑器(草稿/发布/5档可见性)
系统管理
  用户管理│角色与权限│角色绑定(scoped)│权限诊断│组织架构(节点详情含在任职务·被分管)│职务定义│职务规则│分管│数据字典│贡献值规则│附件配置│审计日志│短信日志│系统设置
  (个人中心走右上角头像下拉,不进侧栏)
```

**故意不做的菜单**(它们是别人的 tab):报名管理、考勤管理、证书管理、保险管理、紧急联系人、部门管理、**任职管理**(任职是组织轴+队员轴双 tab,§2.6/§2.2,不设顶级"任职管理"+手选组织/队员)。看到要写"请先选择一个 X 才能看 Y"就回 §1 反模式。

> **分组可演进**:① "系统管理" 一拥挤就拆「基础数据」(字典 / 组织 / 职务定义 / 职务规则 / 贡献值规则 / 附件配置)+「系统与权限」(用户 / 角色 / 审计 / 短信日志 / 各设置),按使用频率 + 权限层级分;② 审批工作台**只做日常高频**(报名 / 考勤);招新报名、入队申请的待处理队列是季节性的,**留在各自模块**别塞进工作台(要"全局待办数"等 [GAP-003](#4-缺口台账-gap-ledger) 的 stats 端点统一出)。

### 5.3 页面骨架 + 可见性码(组件按 Element Plus / pure-admin `PureTable`)

| 页面 | 主端点(详见 §2) | 进入/列表可见性码 | 骨架要点 |
|---|---|---|---|
| 活动列表 → 作战室 | `activities` + `/:id/{registrations,attendance-sheets}` | 列表 `[auth]` 仅登录;写操作 `activity.*.record` | `el-tabs` 三 tab;`activityId` 取**路由参数**不放下拉;考勤进 `review-detail` 审核页(初审/终审);**终审按钮须处理 22074/22075 专用错误码**(§2.1) |
| 审批工作台 | `registrations?statusCode=` · `attendance-sheets?statusCode=` | `activity-registration.read.record` · `attendance.read.sheet` | 跨活动扁平列表 + `statusCode` 切;item 自带活动上下文;`el-drawer` 内审批;**终审(final-approve/final-reject)专用错误码 22074(自审拒)/22075(同人拒,env 可放开)须单独处理文案,别混进通用权限不足提示**(§2.1/§3 #8) |
| 队员列表 → 360 | `members` + 子资源(§2.2;含**组织归属 memberships** CRUD + **任职 position-assignments** 只读)| `member.read.record`(各子 tab 另持各自 read 码;组织归属 tab:`membership.list.record` 看 + `membership.set.record` 增/改 + `membership.end.record` 结束;任职 tab:`position-assignment.read.record` 看,任命/撤销动作在组织架构页发起)| `el-tabs` 十 tab(**部门 tab 升级为组织归属**:主 / 兼 / 临时 / 支援多归属 + 任期;新增**任职 tab**:该队员在组织体系担任的职务 + 历史,`isConcurrent` 显示"（兼）",纯只读);贡献值用 `contribution-summary` capped 值,**别裸 SUM**(§3 #4) |
| 队保单 | `team-insurance-policies` | `team-insurance-policy.read.record` | 左保单表 + 右覆盖名单(`el-transfer` 或加/移弹窗) |
| 招新轮次 / 报名审核 | `recruitment/{cycles,applications}`(列表 `?cycleId=&statusCode=&riskLevel=normal\|high\|system` 过滤〔三参均 query DTO 白名单、可选;早期 loose `@Query` 旁路曾被全局 `forbidNonWhitelisted` 误拒 400,已纳入 `RecruitmentApplicationListQueryDto` 修复〕,**S4b**) | `recruitment-cycle.read.record` · `recruitment-application.read.record`(列表/脱敏详情)· `recruitment-application.read.sensitive`(详情明文证件号·手机 + 证件照 signed-URL;**S3 敏感分级**) | `el-steps` 表流程;**详情默认脱敏,持 `read.sensitive` 才显明文证件号/手机 + 取证件照 signed-URL**(无该码 → signed-URL 30100;字段集不变只 masking 随码);**S4b 人工队列三栏**:列表按 `riskLevel`(普通/高风险/系统异常)切栏,DTO 含 `riskLevel`/`manualReviewReason`(`forgery_suspected`/`system_ocr_error`/`ocr_mismatch_confirmed`/`special_document`)分组筛;`el-drawer` 标门槛/综合评定/一键发号;**S6 批量操作**:`POST applications/batch-mark-threshold`(批量标门槛,匹配键 临时编号/手机/姓名+手机,`mark.threshold` 码,返 per-row + 批次汇总)· `POST applications/export`(导 CSV,`read.record` 脱敏列 / `read.sensitive` 明文列)· `GET cycles/:id/promote-precheck`(发号前预检,`promote.member` 码,预检=实发);**OCR 鉴伪版充分利用(已发 v0.33.0)**:`GET applications/{id}/id-card-image-url` 现返**三图 signed-URL**(`url` 原图 + `cropImageUrl` 主体框裁剪 + `portraitImageUrl` 头像裁剪;裁剪图仅大陆身份证鉴伪版且已入库才有、否则 null;**仍 `read.sensitive` 闸**),报名详情 DTO **+4 OCR 顾问式列** `ocrAddress`/`ocrNation`/`ocrAuthority`/`ocrValidDate`(**随 `read.sensitive` 分级:脱敏级 → null**,住址等同证件号敏感)+ `hasIdCardCropImage`/`hasIdCardPortraitImage` 布尔 flag;**OCR 仅顾问式存档,gender/birth 仍由证件号推导权威、不被 OCR 覆盖** |
| 招新工作台(进度看板) | `recruitment/cycles/:id/stats` | `recruitment-application.read.record` | 五组聚合卡片(今日数据/待处理事项/门槛进度/综合评定/公示发号);**纯读**,计数与报名 stage 同源;`el-statistic` 数字卡 + `el-progress` 门槛分布;待人工 normal/high/system 三栏为**真 `riskLevel` 口径**(S4b 落地,去 verifyOutcome 代理);**S6 发号前预检**(`cycles/:id/promote-precheck`)可在「公示发号」卡上做发号前体检(逐行可发/跳过原因) |
| 入队管理 / 入队申请 | `team-join/{cycles,applications}` | `team-join-cycle.read.record` · `team-join-application.read.record` | 同上;一键入队弹窗选部门(`el-tree-select`)+ 默认级别 L1 |
| 内容发布 | `contents` | `content.read.record` | 富文本 + 封面 `el-upload` + 可见性下拉(5 档)+ 状态机按钮 |
| 用户管理 | `admin/v1/users` | `user.read.account` | CRUD;自我保护 / 最后超管后端拦,按错误码提示 |
| 角色与权限 | `system/v1/{roles,permissions,user-roles}` | `rbac.role.read` / `rbac.permission.read` | 角色授权 `el-tree`/`el-transfer`;仅 USER+GLOBAL 简单授权,契约不变;scoped 场景改用下方「角色绑定(scoped)」页 |
| 组织架构 | `admin/v1/organizations`(含 reparent `POST .../:id/move`)+ 节点详情只读:`.../:id/position-assignments`(在任职务)· `.../:id/supervisors`(被谁分管) | `org.read.node`(reparent 用 `org.move.node`;节点详情另持 `position-assignment.read.record` / `supervision-assignment.read.record`)| `el-tree` 增删改 + **重挂父级 reparent**("移动"操作,body 必填 `parentId`;禁改根 / 守环,§2.6);选中节点右侧详情面板加两个只读区块——**在任职务**(该组织当前任命,任命/撤销动作在此发起:`POST .../:id/position-assignments` + `POST position-assignments/:aid/revoke`)+ **被谁分管**(标 `coverage` DIRECT/INHERITED,纯展示,管理走下方「分管」页);已内置根 + 15 部门 |
| 职务定义 | `admin/v1/positions` | `position.read.definition`(增/改/删另持 `create`/`update`/`delete`.definition)| `PureTable` CRUD;类别 LEADER / DEPUTY / STAFF;`code` 创建后不可改;6 内置(队/部/组正副职);被规则引用禁删(32003);全局配置(§2.6)|
| 职务规则 | `admin/v1/position-rules` | `position-rule.read.record`(增/改/删另持 `create`/`update`/`delete`.record)| 设"某组织类别可设哪些职务";按 `nodeTypeCode` 过滤;`(类别, 职务)` 唯一;30 内置默认(§2.6)|
| 分管 | `admin/v1/supervision-assignments` | `supervision-assignment.read.record`(增/改/撤销另持 `create`/`update`/`revoke`.record)| `PureTable` CRUD;建分管选**分管人(队员)+ 被分管组织 + scopeMode**(EXACT/TREE,默认 TREE);**不要求分管人持职务**(与职务正交);改仅限 scopeMode/任期/note,撤销走 `:id/revoke`;"某队员分管范围"/"某组织被谁分管"只读视图分别挂在队员 360 任职 tab 备注 / 组织架构节点详情(复用 §2.6 端点,不在本页重复建) |
| 角色绑定(scoped) | `admin/v1/role-bindings` | `role-binding.read.record`(增/改/删另持 `create`/`update`/`delete`.record)| `PureTable` CRUD;建绑定选 **principalType**(USER/MEMBER/POSITION_ASSIGNMENT/SYSTEM)+ principal + 角色 + **scopeType**(GLOBAL/ORGANIZATION/ORGANIZATION_TREE/ACTIVITY/RESOURCE/SELF,决定对应 `scope*` 字段是否必填);**scopeType≠GLOBAL 时须在表单/列表显著提示「当前对考勤终审 + 活动/报名/考勤的单点动作生效(扁平跨轴列表与新建活动仍 GLOBAL-only);其余业务面待后续批」**(PR8/PR9/PR12 已发;§2.6 落地进度声明);删除=软删(`status=ENDED`+`deletedAt`,与任职/分管的"REVOKED 不物删"不同);GLOBAL 绑定与「角色与权限」页共享同一张底表,互相可见 |
| 权限诊断 | `admin/v1/authz/explain` | `authz.explain.decision` | 单表单页(非高频菜单,建议做成「角色与权限」/「角色绑定」页内的辅助入口):选目标用户 + 填 action 权限码 + 可选 resourceRef(type 11 选 1 + id)→ 提交展示 `allow`/`deny` + `reason`(11 值枚举)+ `matchedGrant`(命中角色/职务/分管来源及内部 id);**`POST` 但语义是查询,`deny` 是正常 `200` 返回不是报错**,别把 `reason=xxx` 当异常捕获处理;运营/前端排查"这人为什么不能做 X"的诊断工具(§2.6) |
| 数据字典 | `system/v1/dict-{types,items}` | `dict.read.type` / `dict.read.item` | 左类型右项联动;内置项有防误删守卫 |
| 贡献值规则 | `system/v1/contribution-rules` | `contribution.read.rule` | 是**规则**不是队员的分,别和 360 贡献值混 |
| 附件配置 | `system/v1/attachment-{type,mime,size-limit}-configs` | `attachment-config.read.*` | 三表 override-with-default,三 tab |
| 审计日志 | `system/v1/audit-logs` | `audit-log.read.entry` | 只读 + 时间范围筛选;详情 `el-drawer` |
| 短信日志 | `system/v1/sms-send-logs` | `sms-send-log.read.list` | 只读 `PureTable`(手机号**掩码**);独立页,别折进系统设置 |
| 系统设置 | `{storage,sms,wechat,realname}-settings` | `*-setting.read.singleton` | 单例 `el-form`;密钥掩码回显;reset 凭证多为仅超管可见 |
| 个人中心(头像下拉,非侧栏) | `admin/v1/me`(身份)· 改密走账号级 `app/v1/me/password`(admin 可用) | `[auth]` 仅登录 | `el-descriptions` 展示身份/角色;改密表单(旧→新)直接打账号级端点(踩坑 #6 例外,非缺口) |

> 可见性码只列"能否看见该菜单/列表"的 read 码;**按钮级码(approve / promote / final-approve …)另查** §2 + 端点 `[rbac:]` summary(沿 §3 #3,**禁臆造**)。菜单 = 前端静态路由 + `permissions[]` 过滤(§3 #5,后端无菜单树端点)。

> **页面细化(后端已就绪,这些动作别漏)**:
> - **证书 tab 含核验工作流**:`PATCH .../members/:id/certificates/:cid/{verify,reject}`(待核验→已核验 / 已拒绝,`reject` 须填 `verifyNote`)+ `GET .../qualification-flag`(资质标记)。不是"上传 + 表格"那么简单,要有 状态 + 核验通过 / 拒绝 动作。
> - **队员列表是全 CRUD**:`members` 有 `POST`(手动建队员)/ `PATCH :id` / `PATCH :id/status` / `DELETE`(软删)。**招新发号是主路径**,但 admin 可手动建 / 改 / 改状态 / 软删(历史数据、纠错)——§5.1 funnel 别误读成"队员只能从招新来"。
> - **活动作战室·概览** 摆出 `capacity`(名额,空=不限)/ `registrationDeadline`(报名截止)/ `requiresInsurance`(需保险),且**发布 / 取消是状态机**(`draft → published → completed`,可 `cancel`);报名 / 考勤动作按 `published` 解锁。
> - **角色 / 权限改完要刷缓存**:角色与权限页放一个"重载权限缓存"按钮(`system/v1/rbac` reload,`rbac.config.reload`),否则改完绑定不即时生效。

### 5.4 工作台 / 首页

最实用的落地页是"**有什么等我处理**"(待审报名 / 考勤),而非报表。**建议直接把「审批工作台」设为登录默认路由**:活动/报名/考勤域**仍无全局聚合 stats 端点**(首页数字卡片 `el-statistic` 现只能靠各列表 `total` 拼),与其先做个喂不饱的仪表盘,不如用工作台兜底,待 [GAP-003](#4-缺口台账-gap-ledger) 的活动域部分落地再加汇总卡片。**招新域例外**:招新工作台已有专属 stats 端点(`recruitment/cycles/:id/stats`,五组聚合,GAP-006 S2),招新进度看板可直接做。

---

## 6. 这份文件怎么不馊

改后端 API surface / RBAC / 契约 → **同 PR** 改本文件受影响行 + `pnpm docs:handoff:openapi`(沿 [`AGENTS.md`](../../AGENTS.md) 反漂铁律)。前端对接前先读本文件 + 对 live `/api/docs-json` 核字段。
