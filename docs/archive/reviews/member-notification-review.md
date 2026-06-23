# 会员通知 / 公告模块评审稿(Member Notification Review)— T0 冻结

> **状态:冻结,不回改**(2026-06-23;立项源 = admin 前端交接层缺口 [GAP-005](../../handoff/admin-web.md#4-缺口台账-gap-ledger);维护者 2026-06-23 拍板「①要做 ②走 D 档 T0 评审先行 ③渠道倾向站内信为主」;本稿按 [`process.md §4`](../../process.md) D 档降速 + [`§7.1`](../../process.md) 循环产出,**只调研 + 只出评审稿,零代码**)。
> **性质**:本文件是会员通知模块 T0 评审**冻结档**,记录开工前现状核查 + 决策矩阵(产品项给推荐**待维护者拍板**,工程项本稿代决冻结)+ schema / RBAC / BizCode 草案 + 分档实施串 + 风险表,供 T1–T4 执行对照。**本稿只提方案不写实现;落地仍需逐 T 走档。**
> **权威分层**:本文件是**冻结时刻**的决策依据,**非当前事实源**;落地后当前事实以 [`docs/current-state.md`](../../current-state.md) 为准,字段以 [`prisma/schema.prisma`](../../../prisma/schema.prisma) 为准,接口以 OpenAPI contract / live `/api/docs-json` 为准。
> **基线**:main HEAD = `b9097dff`(v0.30.0;worktree HEAD == origin/main 已核,0/0);`git status` clean;0 open PR;`grep '"version"'` = 0.30.0。
> **范式母本**:① 多 T 功能评审范式 → [`content-module-review.md`](content-module-review.md) + [`insurance-module-review.md`](insurance-module-review.md);② 会员侧「拉取」读取面 + 发布状态机 + 5 档可见性 → `content/` 模块;③ 短信触达基础设施 + 触达隐私口径 → `sms/` + `birthday-greeting.service` + [`queue-b-otp-birthday-infra-review.md`](queue-b-otp-birthday-infra-review.md)。

---

## ⚠️ 待维护者拍板清单(产品决策;本稿只给推荐,不替决)

下列 5 项是**产品口径决策**,本稿给方案 + 推荐 + 理由,**最终由维护者拍板**(可一句「按推荐」全收,或逐项调整)。其余决策(数据模型形态 / 端点集 / 防滥发 / 审计 / schema / RBAC / BizCode / 分档)是**工程代决**,本稿冻结,落地照执行。

| # | 待拍板 | 本稿推荐 | 一句话理由 |
|---|---|---|---|
| ① | **渠道** | **站内信(app 内拉取)为主,首期只做站内信;短信群发明确延后** | 站内信零 cron(避开 R-5 定时任务锁)、零短信成本;短信基建已就绪,延后零架构代价 |
| ③ | **定向范围** | **复用 content 的可见性分档(member/formal_member/department/management);活动参与者定向延后** | 复用 `content.visibility.ts` 是最大复用收益;活动参与者定向耦合 activities,与 ⑧ 联动一起延后 |
| ④ | **已读状态** | **做**——`NotificationRead` 已读表 + 未读数 | 「未读红点 + 已读管理」正是站内信区别于 content 的核心;不做已读则本模块退化成「会员可见的 content」 |
| ⑤ | **会员准入 / 可见性繁简** | **复用 content 的 canUseApp 准入 + 可见性分档(去掉 public 档 = 4 档)** | 与 content 读取面同构,零新机制;通知是会员面专属,无匿名公开档 |
| ⑧ | **触发方式** | **纯手动(admin 撰写 + 发布);活动发布联动延后** | 联动耦合 activities,与 ③ 活动参与者定向成对,首期不入 |

> 工程代决项(②⑥⑦⑨⑩)随上列拍板结果**自动确定形态**(下文 §2 标注依赖链)。若维护者改 ①/④ 的取值,§3–§6 的 schema / 端点 / 分档需按新取值微调——本稿已在各处标注「若改 X 则 Y」。

---

## 0. TL;DR

**一句话**:新增 `notifications` 第 29 模块的**推送面 + 会员读取面**(现 `notifications/` 仅生日短信后台任务,无 admin 面)。镜像 `content` 的「admin CRUD + 发布状态机 + 会员拉取 + 可见性分档」,**额外加一张轻量已读表**`NotificationRead`(站内信的核心差异)。**首期 = 站内信(app 内拉取),不发短信、不加 cron、无 open/v1 公开面**。

**两张表**:① `Notification`(广播主表,镜像 `Content`:状态机 draft/published/archived + 可见性分档 + 软删 + `readCount` 反范式);② `NotificationRead`(`notificationId × memberId` 已读回执,append-once,plain unique)。**不做收件人 fan-out**(数百队员体量,广播 + 已读 join 足够,fan-out 是过度工程)。

**端点 +12**:admin 8(CRUD + 状态机)+ app 4(list / detail / mark-read / unread-count)。**权限码 +5**(`notification.{read,create,update,delete,publish}.record`,全绑 biz-admin,镜像 content)。**BizCode 310xx 段 5 码**(镜像 content 290xx;`31xxx` 已亲核空闲)。**字典 +1** `notification_type`(4 项)。**audit +4**(admin 撰写动作入 audit,镜像 content;**会员已读不入 audit**,镜像生日触达 + content viewCount + App self 读不写)。

**首期不做**:短信群发 / 活动发布联动 / 活动参与者定向 / open/v1 公开通知面 / 通知附件图片 / 已读名单明细 / 批量已读 / 服务端推送(APNs / 小程序订阅消息)/ 定时发布 cron / 小程序前端。

---

## 1. 背景与现状核查(亲核,2026-06-23)

### 1.1 立项源 — GAP-005

[`docs/handoff/admin-web.md`](../../handoff/admin-web.md) §4 缺口台账:

> **GAP-005** | 向队员主动推送通知/公告(活动提醒 / 招新公告 / 紧急召集);现 notifications 模块仅"生日短信"后台任务,无 admin 推送面 | 待定:notification 推送面(涉新 schema + 新 RBAC 码 = **D 档拍板**)| 提出(已确认要做,待出 goal)

诉求 = 给运营一个「向队员主动推送通知/公告」的能力,三类典型场景:**活动提醒 / 招新公告 / 紧急召集**。

### 1.2 现状核查(runner 亲核,非 grep 二手)

| 核查项 | 结论 | 证据 |
|---|---|---|
| 是否已有 Notification / Announcement / Message model | **无**(零命中) | `grep -niE "model (Notification\|Announcement\|Message)" prisma/` = NONE |
| `notifications/` 模块现状 | **仅生日短信后台任务,无 controller / 无权限码 / 无 DTO** | [`notifications.module.ts`](../../../src/modules/notifications/notifications.module.ts)(imports `DatabaseModule` + `SmsModule`;providers 仅 `BirthdayGreetingService`;无 controllers) |
| 生日任务形态 | `@Cron('0 0 9 * * *', Asia/Shanghai)`;选取六条件仅 `User.phone`;同日同模板同号幂等防重发;FAILED 不重试;**不进 audit**;写 `sms_send_logs` | [`birthday-greeting.service.ts:51`](../../../src/modules/notifications/birthday-greeting.service.ts)(@Cron)+ 幂等查重 `~106-118` |
| **cron 锁现状(关键约束)** | 本仓唯一 `@Cron`;`@nestjs/schedule` 解锁范围**仅限生日批**;新增第二个定时任务 = 新 D 档评审(R-5) | [`queue-b-otp-birthday-infra-review.md`](queue-b-otp-birthday-infra-review.md)「no-cron 升级路径正式触发,解锁范围仅生日批」 |
| 短信基建可复用面 | `SmsProviderRouter.{sendVerifyCode,sendBirthdayGreeting,resolveProviderType}`;`sms_send_logs` append-only + `maskPhone` 掩码;同号日封顶 10 + 最小间隔 60s | [`sms-provider.router.ts:60/65/73`](../../../src/modules/sms/sms-provider.router.ts);[`schema.prisma:1196`](../../../prisma/schema.prisma) `SmsSendLog`;`sms.constants.ts`(`SMS_PHONE_DAILY_LIMIT=10` / `SMS_SEND_MIN_INTERVAL_SECONDS=60`) |
| 触达隐私口径先例 | 生日批**不入 audit_logs**(「运营触达非管理动作,`sms_send_logs` 流水足够」);响应手机号一律掩码 | [`queue-b-otp-birthday-infra-review.md`](queue-b-otp-birthday-infra-review.md) §6 E-B8 / E-20/E-21 |
| 群发是否曾被显式 park | **是** | 生日批评审稿 §9:「群发/退订/活动通知/农历生日未立项」 |

### 1.3 母本与可复用资产(读它们再动笔)

| 资产 | 复用点 | file:line |
|---|---|---|
| **content admin 发布状态机** | draft → published → archived(publish/unpublish/archive 三跃迁共用一个 `content.publish.record` 码;非法跃迁 29030) | [`content-admin.controller.ts`](../../../src/modules/content/content-admin.controller.ts);`content.service.ts:299-373`(transition) |
| **content app 拉取面** | `app/v1/contents` GET list + GET :id;canUseApp 准入(403)+ 可见性过滤 + 防枚举 404 + viewCount 自增 | [`content-app.controller.ts`](../../../src/modules/content/content-app.controller.ts);`content-read.service.ts:181-186`(准入)/ `145-149`(viewCount) |
| **content 可见性纯函数** | `canSeeContent(ctx,c)` 详情判定 + `buildVisibilityWhere(ctx)` 列表 where(DB 过滤保分页正确) | [`content.visibility.ts:44-68`](../../../src/modules/content/content.visibility.ts)(canSee)/ `72-84`(buildWhere) |
| **content 主表 schema** | `Content`:statusCode/visibilityCode(String 常量无 enum)+ visibleOrganizationIds `String[]` + viewCount + pinned + publishedAt + authorUserId(无 FK)+ 软删 + 索引集 | [`schema.prisma:1559`](../../../prisma/schema.prisma) `model Content` |
| **content 权限码 seed 结构** | `{ code, module, action, resourceType, description }` 进 `*_PERMISSION_SEED` → spread 入 `BIZ_PERMISSION_SEED` → 自动绑 biz-admin | [`seed.ts:2248-2286`](../../../prisma/seed.ts)(`CONTENT_PERMISSION_SEED`) |
| **insurance 多 T 评审范式** | T0(评审,A)→ T1(schema+seed,D)→ T2(端点+audit+BizCode,C/D)→ T3(接线,C/D)→ T4(docs,A);风险表 / 红区改动计划 / 本期不做 / 敏感字段三问 | [`insurance-module-review.md`](insurance-module-review.md) §2/§9/§10/§11 |
| **触达隐私口径** | 运营触达的「发送 / 阅读」侧不入 audit(`sms_send_logs` 流水足够);本稿据此区分**撰写动作(入 audit)vs 阅读(不入)** | [`queue-b-otp-birthday-infra-review.md`](queue-b-otp-birthday-infra-review.md) §6 |

---

## 2. 决策矩阵(① ~ ⑩)

> 标 🟡 = 产品待维护者拍板(§ 顶部清单);标 🟢 = 工程代决,本稿冻结。每条:方案 A/B(/C)+ 推荐 + 理由 + 决策间依赖。

### ① 渠道 🟡

| 方案 | 说明 |
|---|---|
| **A 站内信 pull(✅ 推荐,首期核心)** | 会员经 `app/v1/notifications` 主动拉取;零短信、零 cron;活动提醒 / 招新公告 / 紧急召集均以会员打开 app 见红点消费 |
| B 短信群发 | admin 触发对一批号码群发短信;走既有 `SmsProviderRouter` + `sms_send_logs` |
| C 两者 | 站内信为主 + 紧急召集额外走短信 |

- **推荐 A(首期只做站内信),B 明确延后(§8 本期不做),C 作为后续可选演进**。
- **理由**:(1) **避开 cron 锁**——站内信是「会员拉取」,**无需任何定时任务**,不触碰 R-5「新 @Cron = 新 D 档」红线;短信群发若做成定时/批处理会再次踩 cron 锁。(2) **零边际成本**——站内信不计费;短信群发有真实计费 + 同号日封顶 10 的限制,群发语义与「验证类单发」不同,需要单独的计费/防重口径设计。(3) **维护者已倾向站内信为主**(2026-06-23 拍板③)。(4) **延后零代价**——`SmsProviderRouter` / `sms_send_logs` / `maskPhone` / 同号防重发已就绪,后续要短信时直接复用,本期不做不浪费任何架构。(5) **公开招新公告另有归宿**——面向**匿名公众**的招新宣传可直接用既有 `content` 模块(`open/v1/contents` public 档),无需通知模块开公开面。
- **依赖**:决定 ②(数据模型只需广播表,无需短信流水接线)、⑥⑦(端点集不含群发触发)、⑨(站内信无需新限流)。**若维护者选 C**:T 串末尾追加一个「短信群发」子档(复用短信基建 + 同号防重 + 显式计费确认),不改前序 schema。

### ② 数据模型 🟢(依赖 ①④)

| 方案 | 说明 |
|---|---|
| **A 广播主表 + 轻量已读 join(✅ 推荐)** | `Notification` 单表(广播,镜像 `Content`),定向靠**可见性条件列**(visibilityCode + visibleOrganizationIds);已读靠 `NotificationRead`(notificationId × memberId)轻表,仅 ④ = 做已读时存在 |
| B 收件人 fan-out 表 | 发布时按定向**炸开**成每收件人一行(`NotificationRecipient`),精确投递 + 已读挂在每行 |
| C 纯广播无已读 | 只 `Notification` 单表,无任何收件 / 已读关系(= ④ 选 fire-and-forget) |

- **推荐 A**。
- **理由**:救援队体量数百队员,**广播 + 可见性过滤**(复用 content)天然覆盖「全员 / 按部门 / 按级别」,无需 fan-out;fan-out(B)= 每条通知数百行收件记录 × 数百条通知,写放大且无收益,是过度工程(违背本仓「避免过度工程化」原则)。已读用**一张瘦表**`NotificationRead`(只在被某会员读过时才有一行),比 fan-out 省一个数量级的行。
- **依赖**:**②=A 当且仅当 ④=做已读**(需要 `NotificationRead`);若 ④ = fire-and-forget,则退化为 C(无已读表),但那样通知 ≈「会员可见的 content」,本模块价值存疑(见 ④ 理由)。

### ③ 定向范围 🟡

| 方案 | 说明 |
|---|---|
| **A 复用 content 可见性分档(✅ 推荐)** | 一条通知选一档:member / formal_member / department / management;`department` 档用 `visibleOrganizationIds`(复用 `organization` + `member_department`),即得「全员 / 按部门 / 按级别」 |
| B + 活动参与者定向 | 额外支持「通知某活动的报名者」(join `activity_registrations`) |
| C + 按级别(member_grade)定向 | 额外按 `member_grade` 字典精确定向 |

- **推荐 A**(首期);**B/C 延后**(§8)。
- **理由**:A **零新机制**——直接复用 `content.visibility.ts` 的 `canSeeContent` / `buildVisibilityWhere`(file:line 见 §1.3),是本模块**最大的复用收益**。「按部门」已由 `department` 档 + `visibleOrganizationIds` 覆盖;「按级别(部长/队员/志愿者)」可由 `formal_member` / `management` 粗档覆盖大部分诉求。B(活动参与者)**耦合 activities 模块**,且与 ⑧ 的「活动发布联动」成对出现——两者一起延后更内聚。C(member_grade 精确定向)v1 诉求未明,延后。
- **依赖**:③=A 复用 ⑤ 的可见性闸;**若选 B**,通知模块需 import activity-registrations(单向)+ 新增「activity 参与者」定向列与查询,挂后续。

### ④ 已读状态 🟡

| 方案 | 说明 |
|---|---|
| **A 做已读(✅ 推荐)** | `NotificationRead`(notificationId × memberId × 首读时刻)+ 列表项带 `read:boolean` + `unread-count` 未读数 + `mark-read` 端点;`Notification.readCount` 反范式已读人数(admin 看触达) |
| B fire-and-forget | 不留已读,只一个 `readCount`/`viewCount` 计数(= content viewCount 口径) |

- **推荐 A**。
- **理由**:**已读是站内信区别于 content 的核心**。content 已提供「会员可见的多档内容拉取 + viewCount」;若通知也 fire-and-forget(B),则通知 ≈ content 的子集,**新模块价值不成立**(完全可以用 content 一个 `notification` 类型搞定)。「未读红点 + 标记已读 + 未读数 badge」是运营「主动推送」诉求的关键反馈闭环,必须有 per-member 已读态。保持**最小**:一张 append-once 瘦表 + 一个反范式 `readCount`,不做已读名单明细(§8)。
- **依赖**:④=A 驱动 ②=A 含 `NotificationRead` 表、⑥ admin 详情回显 `readCount`、⑦ app 含 `mark-read` / `unread-count`。**④ 是本模块是否成立的关键拍板**。

### ⑤ 会员准入与可见性 🟡

| 方案 | 说明 |
|---|---|
| **A 复用 canUseApp + 可见性分档(去 public = 4 档)(✅ 推荐)** | 准入 = `AppIdentityResolver` canUseApp(memberId 非空 + User/Member ACTIVE,否则 403);可见档 = member/formal_member/department/management(**去掉 content 的 public 档**,通知是会员面专属、无匿名公开面) |
| B 全员可见(更简单) | 所有 active 会员看所有已发布通知,无分档 |

- **推荐 A**(去 public 的 4 档)。
- **理由**:与 content 读取面**同构**(同一 `canUseApp` 准入 + 同一可见性纯函数,去掉 public 分支),复用成熟闸控、零新准入机制。比 content **少一档**(无 public)——因为通知首期**无 open/v1 公开面**(决定 ①:面向匿名公众的公告用 content),省掉匿名上下文 + content-public throttler。B(全员可见)丢掉「紧急召集只给在册正式队员」「部门通知只给本部门」的能力,运营迟早要,不如一次到位复用现成分档。
- **依赖**:⑤=A 复用 ③ 的可见性档;app 读取面(⑦)的准入与过滤直接镜像 `content-read.service`。

### ⑥ admin 推送面端点集 🟢(镜像 content,去附件/封面/公开面)

- **推荐**:镜像 content 状态机,**8 端点**(`admin/v1/notifications`):

| # | 方法 路径 | 用途 | 权限码 |
|---|---|---|---|
| 1 | POST `/` | 建草稿 | `notification.create.record` |
| 2 | GET `/` | 列表(status/type/visibility 过滤;回显 readCount) | `notification.read.record` |
| 3 | GET `/:id` | 详情(回显 readCount,不增) | `notification.read.record` |
| 4 | PATCH `/:id` | 更新(draft/published 可改,archived 冻结 → 31030) | `notification.update.record` |
| 5 | DELETE `/:id` | 软删(任意态) | `notification.delete.record` |
| 6 | POST `/:id/publish` | **发布(= 推送时刻**,置 publishedAt,会员可见) | `notification.publish.record` |
| 7 | POST `/:id/unpublish` | 撤回(从会员 feed 隐藏;已读会员已读过) | `notification.publish.record` |
| 8 | POST `/:id/archive` | 归档(终态,不可逆,除软删) | `notification.publish.record` |

- **理由**:与 content admin 面一致(开发者认知零迁移),状态机已验证。比 content **少 4 端点**(无 attachment upload-url/confirm/delete + 无 cover)——首期通知**无正文图/附件**(§8)。`publish` 的语义 = 「推送」:草稿撰写期会员不可见,publish 后进会员 feed。`unpublish` = 撤回(已读会员留存已读痕,新拉取不再见),保留以与 content 状态机对齐。
- **依赖**:⑥ 镜像 content,随 ④ 在详情/列表加 `readCount` 回显字段。

### ⑦ 会员读取面端点集 🟢(镜像 content-app + 已读两端点)

- **推荐**:**4 端点**(`app/v1/notifications`,canUseApp 准入,可见性过滤,无权限码):

| # | 方法 路径 | 用途 | 鉴权 |
|---|---|---|---|
| 9 | GET `/` | 列表(可见性过滤 + 分页;**每项带 `read:boolean`**) | canUseApp 闸(403),无码 |
| 10 | GET `/:id` | 详情(可见级闸 + 防枚举 404;**不自动已读**) | canUseApp 闸,无码 |
| 11 | POST `/:id/read` | 标记已读(**幂等 upsert**;首读 readCount 原子 +1) | canUseApp 闸,无码 |
| 12 | GET `/unread-count` | 未读数(badge) | canUseApp 闸,无码 |

- **理由**:9/10 镜像 `content-app`(list+detail,canUseApp + 可见性 + 防枚举 404);11/12 是站内信增量(④)。**详情不自动已读**——按 goal「mark-read」显式建端点,客户端可在列表项或打开后调 `POST /:id/read`(分离读取与已读、UX 更可控)。`mark-read` 幂等(`NotificationRead` upsert,二次 no-op,readCount 仅首插 +1,P2002 兜底不重复增)。**实现注意(T3)**:`GET /unread-count` 字面段路由须声明在 `GET /:id` 之前,避免被 `:id` 参数捕获(镜像既有字面段 vs `:id` 排序惯例)。
- **依赖**:⑦ 随 ④ 存在;`unread-count` = (可见 + published 通知)NOT IN(本人已读)的计数(NOT EXISTS 子查询;v1 体量可接受,性能观察挂 NEXT_TASKS,镜像 content body-ILIKE 顺扫的处理)。

### ⑧ 触发方式 🟡

| 方案 | 说明 |
|---|---|
| **A 纯手动(✅ 推荐)** | admin 撰写草稿 → publish 推送,逐条人工 |
| B + 活动发布联动 | 活动 publish 时自动建一条「活动提醒」通知 |

- **推荐 A**;**B 延后**(§8)。
- **理由**:A 是 MVP,覆盖三类场景(活动提醒 / 招新公告 / 紧急召集均可手动发)。B **耦合 activities**(activity publish → 建 notification),引入跨模块联动 + 自动建记录的幂等/去重问题,且与 ③ 的「活动参与者定向」成对——一起延后更内聚。goal 亦建议「联动留后续不入首期」。
- **依赖**:A = 端点集(⑥⑦)无联动入口;若选 B,activities 模块 publish 钩子 + 通知模板,挂后续(单向 activities → notifications,防环)。

### ⑨ 防滥发 🟢(依赖 ①)

- **推荐**:**站内信无需新增限流**;短信群发(若后续做)继承既有短信防滥发。
- **理由**:站内信是 **RBAC 闸控的 admin 写动作**(只有持 `notification.publish.record` 的 biz-admin 能发),**无 per-收件人成本**,滥发风险低,且每次 publish 入 audit(⑩)可追责——与 content publish **无新增限流**一致(content 的 `content-public` throttler 仅服务匿名 open 面,通知首期无 open 面故不需要)。短信群发(①-C/延后)若做,**自动继承** `sms.constants` 的同号日封顶 10 + 最小间隔 60s + 同日同模板防重发,无需新机制。
- **依赖**:⑨ 取值由 ① 定;站内信路径无 throttler 实例增量。

### ⑩ 隐私与审计 🟢(调和两先例)

- **推荐**:**admin 撰写动作入 audit**(create/update/delete/publish 4 事件,镜像 content);**会员阅读不入 audit**(mark-read 不写)。
- **理由**:两先例需调和——
  - **生日触达口径**(「运营触达非管理动作,`sms_send_logs` 流水足够,不入 audit」)管的是**自动化的发送 + 阅读侧**(系统 cron 发、无 admin 操作者)。
  - **content 口径**(`content.publish` 入 audit)管的是**有明确 admin 操作者的撰写/发布动作**。
  - 通知的 admin CRUD/publish **有明确操作者、是刻意管理动作** → **入 audit**(镜像 content `content.{create,update,delete,publish}`,4 个 DB union 事件;publish 伞盖 publish/unpublish/archive,via `extra.operation` + before/after statusCode)。
  - 会员 `mark-read` 是**会员 self 行为**(无管理性)→ **不入 audit**(镜像生日触达「阅读侧不留 audit」+ content viewCount 不审计 + App self 读不写 audit 的 `D-P2-7-16` 先例)。
- **敏感面**:通知正文是运营广播文案,**无 L3 字段**(无 token/secret/证件号/手机号),不进日志 redact 清单(详见 §9 敏感字段三问)。`NotificationRead` 仅 `memberId + 时刻`,非敏感。
- **依赖**:无外部依赖;audit 事件随 ⑥ admin 端点接入(T2)。

---

## 3. schema 草案(T1;**不**落 migration)

> 镜像 `Content`(§1.3);两张表 + Member 一条反向关系。字段长度由 DTO 承担(沿仓内长文本惯例,不落 `@db.VarChar`)。

```prisma
model Notification {
  id        String    @id @default(cuid())
  createdAt DateTime  @default(now())
  updatedAt DateTime  @updatedAt
  deletedAt DateTime?

  title                String   // DTO ≤ 200
  body                 String   // PG text;站内信正文(纯文本 / 轻 Markdown);DTO ≤ 5000(v1 无正文图/附件)
  notificationTypeCode String   // ∈ notification_type 字典 item(activity-reminder/recruitment/emergency/general)
  statusCode           String   // draft / published / archived(String 常量,无 enum;镜像 content)
  visibilityCode       String   // member / formal_member / department / management(4 档;去 public,会员面专属)

  visibleOrganizationIds String[]  @default([]) // department 档可见部门 orgId 数组(hasSome;镜像 content)

  readCount    Int       @default(0)   // 反范式已读人数(首次 mark-read 原子 increment;镜像 content.viewCount)
  pinned       Boolean   @default(false)
  publishedAt  DateTime?               // publish 时置 now;unpublish 保留;draft 从未发布则 null
  authorUserId String?                 // 发布 admin;不建 FK(沿 content.authorUserId / 招新 reviewedByUserId)

  reads NotificationRead[]

  @@index([statusCode])
  @@index([visibilityCode])
  @@index([notificationTypeCode])
  @@index([publishedAt])
  @@index([deletedAt])
  @@index([createdAt])
  @@index([statusCode, publishedAt]) // 会员 feed:published 按发布时间序
  @@map("notifications")
}

model NotificationRead {
  id        String   @id @default(cuid())
  createdAt DateTime @default(now()) // = 首次已读时刻(readAt;append-once,无 updatedAt / 无 deletedAt)

  notificationId String
  memberId       String

  notification Notification @relation(fields: [notificationId], references: [id], onDelete: Restrict)
  member       Member       @relation(fields: [memberId],       references: [id], onDelete: Restrict)

  @@unique([notificationId, memberId]) // 一会员对一通知至多一条(plain unique;reads 不软删,无需 partial WHERE)
  @@index([memberId])                  // 会员未读查询主路径(NOT EXISTS 子查询)
  @@index([notificationId])
  @@map("notification_reads")
}
```

+ `Member.notificationReads NotificationRead[]`(反向关系,一处)。

**要点 / 与 content 的差异**:
- `body` 用 plain `String`(PG `text`);长度交 DTO(≤ 5000,远小于 content 的 50000——站内信是短文案)。
- `visibilityCode` **4 档无 public**(决定 ⑤);无 `tags` / 无 `keyword` 搜索(站内信是时序 feed,首期不做检索;比 content 简化)。
- 软删沿 `deletedAt`;所有读 where 显式 `deletedAt: null`。
- **`NotificationRead` 无 `deletedAt`**——已读是 append-once 回执(immutable),与可软删业务行不同;故 `@@unique([notificationId, memberId])` 是 plain unique(**非** insurance 那种 partial-unique-WHERE-deletedAt-null)。这是与 `TeamInsuranceCoverage` 的刻意差异。
- FK 全 `onDelete: Restrict`(沿 certificates/insurance 惯例);通知软删后其已读行成无害孤儿(通知已从会员查询消失,镜像 content 软删不级联附件;真要物理清走 retention SOP)。
- `readCount` 反范式(镜像 content.viewCount):mark-read 首插时 `{ increment: 1 }`(非事务,失败不阻断),admin 看触达人数免 count join。**精确触达分母(可见会员总数)不存**(§8 延后)。

**migration**:仅新增 `notifications` + `notification_reads` 两表(**第 24 个** migration;现累计 23,见 [`prisma/CLAUDE.md`](../../../prisma/CLAUDE.md));纯新增,无破坏性,无历史数据回填,无 enum 迁移(statusCode/visibilityCode 是 String 列)。

---

## 4. RBAC 码集草案(T1 seed;**不**改 seed)

> 镜像 [`seed.ts:2248-2286`](../../../prisma/seed.ts) `CONTENT_PERMISSION_SEED` 结构;`<module>.<action>.<resourceType>` 三段(沿 [`AGENTS.md §8`](../../../AGENTS.md) 判权单轨 `rbac.can()` + [`§13`](../../../AGENTS.md) 三层 Role 不扩展)。**5 码全绑 biz-admin**;会员读取面(⑦)零码(canUseApp 闸 + 可见级,镜像 content app 面)。

```ts
// 会员通知模块(第 29 模块):notification.* 5 码,全绑 biz-admin(镜像 content)。
const NOTIFICATION_PERMISSION_SEED: ReadonlyArray<RbacPermissionSeed> = [
  { code: 'notification.read.record',   module: 'notification', action: 'read',   resourceType: 'record',
    description: 'admin 查看通知(列表 + 详情;全状态全可见档;回显已读人数)' },
  { code: 'notification.create.record', module: 'notification', action: 'create', resourceType: 'record',
    description: '新建通知草稿' },
  { code: 'notification.update.record', module: 'notification', action: 'update', resourceType: 'record',
    description: '更新通知(draft / published 可改,archived 冻结)' },
  { code: 'notification.delete.record', module: 'notification', action: 'delete', resourceType: 'record',
    description: '软删通知(任意态)' },
  { code: 'notification.publish.record', module: 'notification', action: 'publish', resourceType: 'record',
    description: '通知状态机:publish(推送)/ unpublish(撤回)/ archive(立即生效无 cron)' },
];
```

**绑定**:`NOTIFICATION_PERMISSION_SEED` spread 进 `BIZ_PERMISSION_SEED` → 经 `BIZ_ADMIN_PERMISSION_SEED` filter 自动绑 biz-admin(沿 `seedBizAdminRbac`;ops-admin / member 零变化)。权限码全集 **155 → 160**;biz-admin 绑定数 **+5**。守护脚本(`seed-biz-admin.e2e` 期望清单 + `biz-admin.fixture` + `docs:rbacmap:check` 计数)随 T1 PR true-up(镜像 content/insurance 计数同步惯例;T1 新码 src 无引用 → `docs:rbacmap:check` F 项孤码 WARN **属预期**,T2 实装清零)。

**为何不开更细的码(如 read.other / publish.emergency)**:首期无「他人 vs 本人」分野(通知是广播,无 owner-scope),无紧急级专属权限(紧急召集仍是 publish 一种);沿 insurance「不为前端提示价值无差的语义新开码」纪律。

---

## 5. BizCode 段位预留(红区只读核查 + 红区改动计划)

### 5.1 选段(亲核空闲)

| 核查 | 结论 | 证据 |
|---|---|---|
| `31xxx` 是否空闲 | **空闲(零命中)** | `grep -nE "code: 31[0-9]{3}" biz-code.constant.ts` = ZERO HITS |
| `300xx/301xx` 归属 | permissions(C-6 RBAC,最高 30103) | [`biz-code.constant.ts`](../../../src/common/exceptions/biz-code.constant.ts) 索引 + `grep code: 30` 最高 30103 |
| baseline §1.1 是否已预留 | **是**:「`310xx` 起 \| 未规划模块预留 \| RBAC 之后未规划模块」 | [`docs/srvf-foundation-baseline.md §1.1`](../../srvf-foundation-baseline.md) 段位表末行 |

→ **通知模块占 `310xx + 311xx` 段**(沿每模块 200 号:`310xx` 实体级 / `311xx` 权限边界)。

### 5.2 BizCode 草案(5 码,镜像 content 290xx)

| code | 常量 | http | 落点 |
|---|---|---|---|
| `31001` | `NOTIFICATION_NOT_FOUND` | 404 | admin 查不存在;**app 详情 / mark-read 防枚举统一**(存在但不可见 → 同 404) |
| `31010` | `NOTIFICATION_TYPE_INVALID` | 400 | notificationTypeCode 不在 `notification_type` 字典 ACTIVE item |
| `31011` | `NOTIFICATION_VISIBILITY_INVALID` | 400 | visibilityCode 非 4 档之一 |
| `31012` | `NOTIFICATION_VISIBLE_ORG_INVALID` | 400 | department 档 visibleOrganizationIds 空 / 非活跃 org |
| `31030` | `NOTIFICATION_INVALID_STATUS_TRANSITION` | 409 | 非法跃迁(archive 一个 draft / unpublish 一个 draft / 改 archived) |

**不开** `311xx FORBIDDEN_*`(权限拒绝走通用 30100/40300,沿 baseline);mark-read 对未发布/不可见通知 → 复用 `31001`(防侧信道);DTO 白名单非法走通用 400 无码。

### 5.3 红区改动计划(**不在本评审执行;留 T1/T3 PR,逐行可解释,沿 #294 范式**)

> 红区(`baseline §1.1`)**本评审只读核查,不触碰**。落地时(BizCode 常量 T2、baseline 行 T3)做下列改动:

1. **段位映射表**:`310xx 起 | 未规划模块预留` 行收窄为 `320xx 起`;其上插入
   `| 310xx + 311xx | notifications | 200 | 会员通知模块已实装(2026-06-XX;310xx 段 5 BizCode〔31001/31010/31011/31012/31030〕;不开 311xx;冻结评审稿本文件)|`。
2. **状态说明 bullet 区**追加一条「会员通知模块已实装」(码清单 + 不开项 + 本评审稿链接);把「仅 `310xx` 起仍属未规划」措辞同步为 `320xx`。
3. [`biz-code.constant.ts`](../../../src/common/exceptions/biz-code.constant.ts) 文件头索引追加 `31xxx + 311xx: notifications`(T2 随常量落地)。

AGENTS.md / V2 红线 / api-surface-policy **零碰**(本模块无 open/v1 公开面,不解锁任何既有铁律行;若 ①-C 后续加短信群发再评估)。

---

## 6. 分档与实施串(T0 → T4;镜像 insurance 多 T 范式)

| 阶段 | 档 | 内容 | 验证口径(DoD 锚) |
|---|---|---|---|
| **T0** | A | **本评审稿**(本文件)+ NEXT_TASKS 登记 | 本稿存在 + NEXT_TASKS 有通知模块条目 |
| **T1** | **D** | §3 schema(`notifications` + `notification_reads` + Member 反向关系)+ 第 24 migration + §4 seed(`notification_type` 字典 4 项 + 5 权限码全绑 biz-admin)+ 计数同步 | 干净库 `prisma migrate deploy` 重放 24/24;seed 幂等二跑;`seed-biz-admin.e2e` 期望 160/绑定 +5 绿;`docs:rbacmap:check` T1 孤码 WARN 预期 |
| **T2** | **C/D** | §6 admin 8 端点(CRUD + 状态机 publish/unpublish/archive)+ §5.2 BizCode 310xx 5 码常量 + §2⑩ audit 4 事件 + admin e2e + contract | admin CRUD + 状态机各分支(31030 非法跃迁);readCount 回显;`docs:codemap:check`(29);contract 仅新增 |
| **T3** | **C/D** | §7 app 4 端点(list/detail/mark-read/unread-count)+ canUseApp 准入 + 4 档可见性纯函数(复用/镜像 `content.visibility`)+ `NotificationRead` upsert + readCount 自增 + §5.3 baseline §1.1 红区行 + app e2e | app 4 档可见 hit/miss;mark-read 幂等(二次 no-op、readCount 不重复增);unread-count 准确;防枚举 404;`unread-count` 路由不被 `:id` 遮蔽 |
| **T4** | A | docs 收尾:current-state §2/§3 + CHANGELOG(T1/T2/T3)+ RBAC_MAP(160)+ CODEMAP(29)+ handoff GAP-005 → ✅ 已发 + api-surface §0(app/v1 + admin/v1 notifications)+ NEXT_TASKS 归档 + 本评审稿引用 | current-state §2 有通知行;handoff GAP-005 状态翻 ✅ |

**预算表(冻结预算,落地实跑亲核为准;镜像 content/insurance「本表为冻结预算」声明)**:

| 维度 | 增量 | 落点 |
|---|---|---|
| 权限码 | **+5**(155→160) | `notification.{read,create,update,delete,publish}.record`,全绑 biz-admin |
| BizCode | **+5**,310xx 段 | 31001/31010/31011/31012/31030;不开 311xx |
| audit DB union | **+4** | `notification.{create,update,delete,publish}`(publish 伞盖三跃迁 via extra.operation) |
| 字典 | +1 type | `notification_type` + 4 items(activity-reminder/recruitment/emergency/general;label 待运营) |
| controller | +2 | NotificationAdminController + NotificationAppController(**无 public controller**) |
| endpoint | **+12** | admin 8 + app 4 |
| migration | +1(第 24 个) | `notifications` + `notification_reads` 两表 |
| 模块 | +1(第 29 个) | `notifications/`(从生日批单服务扩为完整模块) |
| throttler | **+0** | 站内信无 open 面,不需新 throttler |

---

## 7. 风险表(D 档降速)

| 项 | 结论 |
|---|---|
| 是否修改 `prisma/schema.prisma` | ✅ T1:2 表(`Notification` + `NotificationRead`)+ `Member.notificationReads` 反向关系 1 处 |
| 是否新增 migration | ✅ T1 一个(第 24 个);**纯新增两表,无破坏性,无历史数据回填,无 enum 迁移** |
| 是否修改 `prisma/seed.ts` | ✅ T1:+5 权限码进 `BIZ_PERMISSION_SEED` 全绑 biz-admin + `notification_type` 字典;**既有码 / 绑定 / 角色零变化** |
| 是否影响现有数据 | ❌(全部新增) |
| 是否不可逆 | ❌(回退 = drop 两表 + 删 Member 反向关系 + 删 seed 增量;无数据迁移) |
| 是否新增 cron / 定时任务 | ❌(**站内信 = 会员拉取,零 cron**;刻意避开 R-5「新 @Cron = 新 D 档」;短信群发延后正是为不踩此锁) |
| 是否影响 OpenAPI / contract | ✅ T2/T3 +12 端点;**仅新增,零删改,零 L3** |
| 是否影响鉴权 / Permission seed / 审计 | ✅ 权限码 155→160 / biz-admin +5;AuditLogEvent union +4;**JwtPayload / auth / Guard 链 / throttler 零碰** |
| 是否新增 BizCode | ✅ 310xx 段 5 码;baseline §1.1 红区加行(T3,逐行进 PR) |
| 是否需要用户拍板 | ✅ **产品 5 项待拍板**(§ 顶部清单:渠道 ① / 定向 ③ / 已读 ④ / 可见性 ⑤ / 触发 ⑧);工程项本稿冻结 |
| 用户可见行为变化 | admin 多「通知管理」页(CRUD + 发布);会员 app 多「站内信」feed(未读红点 + 标记已读)。既有 content / 生日批 / 其余模块**零行为漂移** |
| 回退 | 删两表 + seed 增量 + 两 controller + BizCode/audit 增量;无副作用(纯新增模块) |

**既有行为锁(实施期任一破坏 = 停 + 人话简报)**:① 生日批 cron / `sms_send_logs` 零碰;② content / sms / wechat / insurance 模块零 diff;③ contract 仅新增零删改零 L3;④ auth / JwtPayload / throttler / Guard 链零碰;⑤ seed 既有码与绑定零变化(biz-admin 仅 +5);⑥ `docs:rbacmap:check` / `docs:codemap:check` 各阶段 0 FAIL(T1 孤码 WARN 预期,T2 清零)。

---

## 8. 本期不做(明确划出;终版必列)

- **短信群发**(决定 ①:延后;`SmsProviderRouter` + `sms_send_logs` + `maskPhone` + 同号防重发已就绪,后续要时复用;群发须显式确认计费口径 + 防重发语义,且若做成批处理须过 R-5 cron 评审)。
- **活动发布联动自动建通知**(决定 ⑧-B;耦合 activities,与活动参与者定向成对延后)。
- **活动参与者定向 / member_grade 精确定向**(决定 ③-B/C;join activity_registrations / member_grade,后续诉求触发再立项)。
- **open/v1 公开通知面**(面向匿名公众的招新宣传用既有 `content` 模块 public 档;通知首期会员面专属,无 throttler 增量)。
- **通知正文图 / 附件**(镜像 insurance E-20:attachments 接线 = owner 类型扩展 + 权限码 + 配置行,超首期;后续要时复用 content 的 attachment 集成范式)。
- **已读名单明细 / 精确触达分母**(首期只 `readCount` 反范式已读人数;per-recipient 已读名单 + 可见会员总数分母延后)。
- **批量已读 / mark-all-read**(首期逐条 `POST /:id/read`)。
- **服务端主动推送**(APNs / 小程序订阅消息 / WebSocket;站内信 = 纯 pull,不引入推送通道)。
- **定时 / 定点发布通知**(无 cron,R-5)。
- **退订 / 通知偏好设置**(会员级订阅开关);**农历 / 节日批**;**通知模板内容细化**。
- **小程序前端**。

---

## 9. 敏感字段三问(AGENTS §18.4)

1. **业务用途**:通知正文 = 运营向队员广播的文案(活动提醒 / 招新公告 / 紧急召集);`NotificationRead` = 已读回执(运营看触达 + 会员看未读)。
2. **查看角色**:admin 撰写面 = 持 `notification.*` 的 biz-admin;会员读取面 = canUseApp 会员按可见档。**无 L3 字段**(无 token / secret / 证件号 / 手机号;正文是公开广播文案,非 owner-scoped PII)→ 不进日志 redact 清单、不掩码。`NotificationRead` 仅 `memberId + 首读时刻`,非敏感。
3. **保存期限**:软删保留(`Notification.deletedAt`;沿 content/certificates);`NotificationRead` append-once 留存;v1 不做退队自动清理(真实诉求出现单独立项;通知软删后已读行无害孤儿,走 retention SOP 手动清,不解锁 cron)。audit snapshot 沿 content 全量(audit_logs 自身 RBAC 保护)。

---

## 10. 授权与红线(本评审 T0)

- **授权(本评审稿,A 档)**:read-only 调研全仓;**仅新增** `docs/archive/reviews/member-notification-review.md` 一个文件;走 [`process §7.1`](../../process.md) 循环。
- **本评审禁区(已遵守)**:**未**改 `prisma/**` / `src/**` / `prisma/seed.ts` / RBAC 绑定 / auth / throttler / 任何 `.ts/.json/.yml`;**未**新增除本稿外任何文件;红区(`baseline §1.1`)仅只读核查未触碰;产品决策(渠道 / 范围 / 已读 / 可见性 / 触发)**只给推荐未替维护者拍板**。
- **后续 T1–T4 授权边界(待维护者拍板本稿后,逐 T 走档)**:T1 解 schema/migration/seed(D 档);T2/T3 加 `notifications/` 模块端点 + 310xx BizCode + audit + baseline §1.1 红区行(逐行 PR);各 T 偏离 DoD / 遇未决 → [`process §4.1`](../../process.md) 人话简报停,不夹带。
- **完成**:本稿走 PR(分支保护强制);终版回传主会话元核验。

---

> **冻结声明**:本评审稿自 2026-06-23 冻结,不回改。产品 5 项待维护者拍板(§ 顶部清单);拍板结果与后续 T1–T4 实施进展记录于 [`docs/current-state.md`](../../current-state.md) / `CHANGELOG.md` / [`NEXT_TASKS.md`](../../ai-harness/NEXT_TASKS.md),不回改本冻结档。
