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

### 2.5 通知管理(站内信撰写 / 发布 + 微信订阅渠道 + 系统定向)— ✅ S1+S2+S3 后端就绪(本 PR,Unreleased)

统一通知模块 S1 站内信渠道 + S2 微信订阅 quota 渠道 + S3 producer 接入(GAP-005 前三切片;冻结评审稿 [`unified-notification-dispatcher-review.md`](../archive/reviews/unified-notification-dispatcher-review.md))。admin 撰写/发布,会员 app 拉取站内信 feed(未读红点);S2 起 admin 可勾微信渠道,发布时向已订阅会员机会式推送。**S3 = 系统自动定向通知**:招新**发号 / 入队**完成后,后端自动向当事队员发一条**定向**站内信(发号另带微信),admin 面**无新操作**(producer 内部直调派发器,无新端点/无新 RBAC 码);会员侧 feed 见 [`miniapp.md`](miniapp.md)。

| 任务 / 页面 | 端点 | 鉴权 |
|---|---|---|
| 通知列表(草稿/已发/归档 + 类型/可见档/置顶过滤;readCount 触达)| `GET /api/admin/v1/notifications?statusCode=&notificationTypeCode=&visibilityCode=&pinned=` | `[rbac: notification.read.record]` |
| 新建草稿 | `POST /api/admin/v1/notifications`(title/body/notificationTypeCode/visibilityCode/visibleOrganizationIds/pinned)| `[rbac: notification.create.record]` |
| 详情(含 body + readCount,**不自增**)| `GET /api/admin/v1/notifications/{id}` | `[rbac: notification.read.record]` |
| 编辑(draft/published 可改,archived 冻结 → 31030)| `PATCH /api/admin/v1/notifications/{id}` | `[rbac: notification.update.record]` |
| 软删(任意态)| `DELETE /api/admin/v1/notifications/{id}` | `[rbac: notification.delete.record]` |
| 发布 / 撤回 / 归档(状态机 draft→published→archived,立即生效无 cron;非法跃迁 31030)| `POST …/notifications/{id}/{publish,unpublish,archive}` | `[rbac: notification.publish.record]` |

**字段/可见性**:可见档 4 选 1 `member` / `formal_member` / `department` / `management`(**通知去 public**,会员面专属);`department` 档须填活跃部门 orgId 数组(否则 31012);`notificationTypeCode` ∈ `notification_type` 字典(activity-reminder/recruitment/emergency/general)。统一形状列 `audienceType`/`sourceType`/`channels` 出参回显。**会员侧站内信 feed**(list/未读红点/标记已读)见 [`miniapp.md`](miniapp.md)。

**S2 微信渠道勾选**:create/update 入参 `channels`(数组,值 ∈ `["in-app","wechat"]`;**站内恒发**,后端强制含 `in-app`;不传 = 仅站内)。勾 `wechat` 后 **publish 时**后端在事务外向「该类型已配微信模板 + 可见 + 有订阅 quota」的会员逐人推送(非订阅者不打扰);投递成败落 `NotificationDelivery`(本期无 admin 查询端点,运维看库;`recipientRef` 为掩码 openid,非明文)。**前端只需在通知编辑页加渠道勾选**,推送由后端 publish 自动触发,无独立"发送"按钮。

| S2 任务 / 页面 | 端点 | 鉴权 |
|---|---|---|
| 列微信订阅模板配置(各类型 → templateId / 启用态)| `GET /api/admin/v1/notification-wechat-templates` | `[rbac: notification.read.record]` |
| 配置某类型的微信模板 ID + 启用(运营改不重部署;类型须 ∈ 字典否则 31010)| `PUT /api/admin/v1/notification-wechat-templates/{typeCode}`(body: `templateId?` / `enabled?` / `remarks?`)| `[rbac: notification.update.template]` |

**模板配置(D-N3 运营可配)**:`templateId` = 小程序后台审批后拿到的订阅消息模板 ID,**默认 null = 该类型微信渠道不可发**(运维上线后台审批后经此端点填)。字段映射(通知 → 微信 `data` key,如 `thing1`=标题)**内置代码**,运维上线须按真实模板字段名核对(见评审稿 §3.5)。

---

## 3. 踩坑表(gotchas)

1. **登录是 3-call**:`POST /api/auth/v1/login` → `GET /api/admin/v1/me`(身份) + `GET /api/system/v1/rbac/me/permissions`(权限码)。三个端点拆开,别假设 login 返回身份/权限。
2. **字段以 live `/api/docs-json` 为准**。任何手写指南(含本文件)的字段名都可能漂;类型从 docs-json 取。
3. **权限码不要臆造**:用真实码(如 `member.read.record` / `attendance.final-approve.sheet`),来源 = 各端点 `[rbac: x]` summary 或 [`RBAC_MAP.md`](../ai-harness/RBAC_MAP.md);禁 `*:*:*` / `permission:btn:*`。
4. **贡献值别在前端裸 SUM**:存在**全局每日封顶 1.5**(一人单北京日封顶)。前端把 `attendance_records.contributionPoints` 直接相加会**算多**。要总分用后端给的 capped 值(见 GAP-002 的 contribution-summary;在它落地前,贡献值总分一律走后端,不在前端算)。
5. **菜单是前端静态 + `permissions[]` 过滤**,后端没有菜单树端点(`asyncRoutes` / `getMenuList` 是 P0 禁区,别开)。
6. **App ≠ Admin**:`/api/app/v1/*` 是小程序面(本人视角,见 [`miniapp.md`](miniapp.md)),admin 后台不要调它。**唯一例外 = 账号级自助端点**:`PUT app/v1/me/password`(改密)/ `app/v1/me/phone*`(换绑手机)是有意的"账号级豁免"(`D-P2-3-1` 锁定,无 canUseApp 闸、`admin without member 允许使用`)——admin 个人中心改密 / 换手机直接调它们,**不必造 `admin/v1` 镜像**。
7. **signed URL / 敏感字段**有可见级与时效;附件走 `upload-url` / `confirm-upload` 通用链路,别假设直链。

---

## 4. 缺口台账(gap-ledger)

> 前端→后端的需求簿。状态:`提出` → `已出 goal` → `已发`。

| # | 诉求(前端想做的任务) | 期望端点 | 状态 |
|---|---|---|---|
| **GAP-001** | 审批工作台:跨所有活动按 status 横扫报名/考勤 | `GET /api/admin/v1/registrations?statusCode=` · `GET /api/admin/v1/attendance-sheets?statusCode=` | ✅ **已发 v0.30.0**(2026-06-23;[PR #432](https://github.com/BA7IEE/srvf-nest-api/pull/432) → bump #433 → tag `v0.30.0` / Release Latest)。注:过滤参数实装为 `statusCode`(非草拟期 `status`) |
| **GAP-002** | 队员 360:某队员的报名履历 / 考勤记录 / 贡献值生涯累计 | `GET .../members/:id/registrations` · `GET .../members/:id/attendance-records` · `GET .../members/:id/contribution-summary`(贡献值=实时算复用 team-join `computeCappedContribution` 封顶核,生涯 cutoff=null + 北京日封顶 1.5) | ✅ **已发 v0.30.0**(2026-06-23;[PR #432](https://github.com/BA7IEE/srvf-nest-api/pull/432) → bump #433 → tag `v0.30.0` / Release)。注:`attendance-records` 仅返 approved sheet 内 records |
| **GAP-003** | 工作台/首页待办汇总数字(待审报名数 / 进行中活动数 / 招新进度)— 设计期识别,待前端确认是否做仪表盘 | 一个聚合 stats 端点(或前端用各列表 `total`/分页字段拼,无新端点);**招新进度**部分 = `GET /api/admin/v1/recruitment/cycles/{id}/stats` | 🟡 **部分交付**(2026-06-24):**招新进度**部分已由招新工作台 stats 端点答复(GAP-006 S2,见下,**已发 v0.31.0**;五组聚合 今日/待处理/门槛进度/综合评定/公示发号)。**待审报名数 / 进行中活动数**仍未做(可待活动域 stats 合并,或前端用各列表 `total` 拼,无强需新端点) |
| **GAP-004** | 管理员自助改密(PC 个人中心「旧→新」)— **调研结论:非缺口**。`app/v1/me/password` 是账号级自助(`D-P2-3-1` 锁定,"admin without member 允许使用"),admin 用自身 JWT 即可改密(复用 `changeMyPassword`:同事务撤销 refresh + `password.change.self` 审计 + 限流) | 无需新端点;admin 个人中心直接调账号级 `app/v1/me/password`(例外见踩坑 #6) | ✅ 已澄清(2026-06-23 用户拍板=文档化,不造 `admin/v1` 镜像) |
| **GAP-005** | 向队员主动推送通知/公告(活动提醒 / 招新公告 / 紧急召集);现 notifications 模块仅"生日短信"后台任务,无 admin 推送面 | **统一多渠道**(站内 / 微信订阅 quota / 短信)+ 派发器(Effect)+ producer 只创建任务;T0 修订冻结评审稿 [`archive/reviews/unified-notification-dispatcher-review.md`](../archive/reviews/unified-notification-dispatcher-review.md)(supersede 原 [`member-notification-review.md`](../archive/reviews/member-notification-review.md) 站内信架构;招新 §9 / GAP-006 S7 触发挂此)| **S1 站内信渠道已交付**(本 PR,Unreleased;T0 修订评审 2026-06-25 已冻结):**admin 8 端点** `admin/v1/notifications`(CRUD + 状态机 publish/unpublish/archive;R 模式 `notification.*` 5 RBAC 码 156→161;见 §2.5)+ **app 4 端点** `app/v1/notifications`(站内信 feed:list/unread-count/detail/mark-read;canUseApp 准入 + 4 档可见性**复用 content.visibility 去 public** + 未读红点;mark-read 幂等;见 [`miniapp.md`](miniapp.md))。状态机/可见性镜像 content 零第二套;统一形状列就位不返工;BizCode 310xx 5 码。**S2 微信订阅 quota 渠道已交付**(本 PR,Unreleased):admin create/update 加 `channels` 勾选(可含 wechat),publish 含 wechat → **事务外**向「该类型已配模板 + 可见 + 有订阅 quota」会员逐人推送(非订阅者不打扰,投递落 `NotificationDelivery`);**+app 2 端点** `app/v1/notifications/subscriptions`(ack 上报授权 quota +1 封顶 / status 查剩余配额,见 [`miniapp.md`](miniapp.md))+ **admin 2 端点** `admin/v1/notification-wechat-templates`(模板配置运营可配,新码 `notification.update.template` 161→162;见 §2.5);微信 subscribe-send 能力 additive 扩 `wechat/`(stable_token 缓存 + 8s + token 失效刷一次重试,L3 token/openid 零明文)。**S3 producer 接入 + 派发器 Effect 正式化已交付**(本 PR,Unreleased):`NotificationDispatcher`(architecture-boundary §3.6 **首个真实 Effect**;`dispatchTargeted` 建已发布定向行 directed/system/authorUserId=null/跳过 draft 直 published → 站内 + 微信复用 S2)由招新 **发号**(`recruitment-promotion`,promote commit 后,站内+微信,payload memberNo + 入队入口)与 **入队**(`team-join-enrollment`,join commit 后,仅站内,payload 部门+正式队员)在业务事务**外** try-catch 直调(**派发失败不破坏 promote/入队行为锁**;防环单向 producer→notifications);`Notification.recipientMemberId` 定向收件人(会员 feed **仅本人可见**,他人 404 防枚举);**0 新端点 / 0 新 RBAC 码(162 不变)/ 0 BizCode**(producer 内调,admin 面无新操作)。**报名前 5 触发不做**(报名受理/转人工/门槛/评定/公示:申请人那时非队员,S1/S2 够不着,维持**查询进度 pull**)。**S4 活动·考勤触发 / S5 短信兜底 / 报名前 openid 推送路**待后续切片另出 goal |
| **GAP-006** | 招新→入队完整闭环优化(招新工作台 stats / 新人进度模型 / OCR 复核分流 / H5 手机身份链 / promote 志愿者化 / 批量操作 / RBAC 字段分级 等 12 域)— T0 评审已冻结、零代码,按切片另出 goal | 冻结评审稿 [`archive/reviews/recruitment-phase4-loop-optimization-review.md`](../archive/reviews/recruitment-phase4-loop-optimization-review.md)(其 §7 工作台 stats **含 GAP-003「招新进度」部分**;其 §9 通知闭环**挂 GAP-005 落地后**)| ✅ **已发 v0.31.0**(S1–S6 全 7 切片 #439–#445 → bump #446 → tag `v0.31.0` / Release Latest;2026-06-24;以下逐切片 `#NNN` / Unreleased 为各自交付时态历史标注):**S1 状态业务文案 + 新人进度模型**已发(#439,Unreleased)· **S2 招新工作台 stats**已发(#440,Unreleased;`GET …/cycles/{id}/stats` 五组只读聚合,答 GAP-003「招新进度」)· **S3 RBAC 敏感字段分级**已发(#441;新码 `recruitment-application.read.sensitive`——报名详情明文证件号/手机 + 证件照 signed-URL 改判敏感码,`read.record` 收窄为脱敏;biz-admin 同持双码)· **S4a H5 + 手机身份链**已发(#442)· **S4b OCR 六分流 + 重拍计数**已交付(本 PR,Unreleased):submit 六分流〔matched→verified / 模糊·防伪首次→retake 不落记录 / 不一致→三选一 / 上游首次→retry;**forgery·ocr_error H5 会话连续 2 次**才落 `manual_review`〔high/system〕,计数落会话表预建列〕;application **+4 列 additive 无 enum**;进度模型 +`retake/confirm/manual_high` 三态;**S2 待人工三栏升真 `riskLevel`**;admin 报名列表 +`riskLevel` 过滤、admin DTO +`riskLevel`/`manualReviewReason`(人工队列三栏分流/分组);**申请人侧绝不暴露风险分级**(高风险中性文案);**S5 promote 志愿者化 + 入队门禁双兼容**已交付(Unreleased):promote 改写 `gradeCode='volunteer'` + 建 **VOL 归口部门**(`Organization.code='VOL'`,≠ VOD);入队**两处门禁**(自助发起 + 一键入队)改用共享纯函数 `isUnenrolledVolunteer` **双兼容**(新 `volunteer`+VOL / legacy `null`+零部门);一键入队写改「**软删 VOL + 建目标部门**」守 `member_departments` 单部门唯一;历史成员**零迁移**;`join_source` 字典补 `recruitment` 项;新错误码 `28044`(VOL 部门缺失/非 ACTIVE 时 promote 清晰失败)。**S6 批量操作**已交付(Unreleased):**3 批量端点纯加,零 schema / 零新 RBAC 码**——批量标门槛 `POST …/applications/batch-mark-threshold`(匹配键 临时编号/手机/姓名+手机,签到导入由前端解析为数组;复用单行 `markThreshold` = 逐行幂等 + 逐行容错〔不整批回滚〕+ 自动推进;返 per-row + 批次汇总)· 批量导出 `POST …/applications/export`(按筛选导 CSV;**持 `read.sensitive` → 明文列 / 仅 `read.record` → 脱敏列**,复用 S3 `toAdminDto`)· 一键发号前预检 `GET …/cycles/{id}/promote-precheck`(纯读;复用 `decidePromotionIssuance` **结构性保证「预检=实发」**;per-row 可发/跳过 + 六类原因 + 重复 openid 高亮 + 缺字段 flag + 特殊证件 + 汇总)。**S7 通知闭环 = 部分交付**(本 PR,Unreleased,经 GAP-005 S3):招新 6 触发中**发号 / 入队结果** 2 个(申请人此时已是队员)已接入统一通知派发器 → 当事队员收到系统**定向**站内信(发号另带微信);**报名前 5 触发**(报名受理/转人工/门槛/评定/公示)申请人非队员、定向通知够不着 → **维持现状靠查询进度 pull**(`POST open/v1/recruitment/applications/query` 进度模型,见 S1),openid 非会员推送路另立项 |

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
| 招新轮次 / 报名审核 | `recruitment/{cycles,applications}`(列表 `?riskLevel=normal\|high\|system` 过滤,**S4b**) | `recruitment-cycle.read.record` · `recruitment-application.read.record`(列表/脱敏详情)· `recruitment-application.read.sensitive`(详情明文证件号·手机 + 证件照 signed-URL;**S3 敏感分级**) | `el-steps` 表流程;**详情默认脱敏,持 `read.sensitive` 才显明文证件号/手机 + 取证件照 signed-URL**(无该码 → signed-URL 30100;字段集不变只 masking 随码);**S4b 人工队列三栏**:列表按 `riskLevel`(普通/高风险/系统异常)切栏,DTO 含 `riskLevel`/`manualReviewReason`(`forgery_suspected`/`system_ocr_error`/`ocr_mismatch_confirmed`/`special_document`)分组筛;`el-drawer` 标门槛/综合评定/一键发号;**S6 批量操作**:`POST applications/batch-mark-threshold`(批量标门槛,匹配键 临时编号/手机/姓名+手机,`mark.threshold` 码,返 per-row + 批次汇总)· `POST applications/export`(导 CSV,`read.record` 脱敏列 / `read.sensitive` 明文列)· `GET cycles/:id/promote-precheck`(发号前预检,`promote.member` 码,预检=实发) |
| 招新工作台(进度看板) | `recruitment/cycles/:id/stats` | `recruitment-application.read.record` | 五组聚合卡片(今日数据/待处理事项/门槛进度/综合评定/公示发号);**纯读**,计数与报名 stage 同源;`el-statistic` 数字卡 + `el-progress` 门槛分布;待人工 normal/high/system 三栏为**真 `riskLevel` 口径**(S4b 落地,去 verifyOutcome 代理);**S6 发号前预检**(`cycles/:id/promote-precheck`)可在「公示发号」卡上做发号前体检(逐行可发/跳过原因) |
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
