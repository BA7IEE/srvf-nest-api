# 交接:后端 ↔ admin 前端(srvf-admin-web)

> **canonical**(本文件在后端仓,改契约同 PR 改本文件;见 [`README.md`](README.md))。
> 字段级真相 = live `/api/docs-json`;权限码 = [`RBAC_MAP.md`](../ai-harness/RBAC_MAP.md)(总数见 [`current-state.md §1`](../current-state.md),脚本守护,本文不抄数)。
> 本文件只讲这两样讲不了的:**轴模型 + 任务→端点图 + 踩坑 + 缺口**。
> 活动责任闭环当前是 Unreleased 开发能力，只用于本地前后端联调；没有正式生产环境，也不执行未来 Runbook 的迁移、认领、人员配置、部署或切换步骤。

---

## 1. 轴模型(最重要,先读这条)

后端把一切建成**沿"所有权轴"嵌套的子资源**——URL 树本身就是一张任务驱动的信息架构图:

```
活动轴   admin/v1/activities/:id
           ├─ /registrations            报名(activityId 是路径必填段)
           ├─ /attendance-sheets        考勤(同上)
           ├─ /check-ins                GPS 打卡证据复核
           ├─ /attendance-sheet-draft   只读生成考勤提交草稿
           ├─ /feedbacks · /feedback-summary  实名评价列表/聚合
           └─ /reconciliation · /participation-summary  跨报名×考勤核对/汇总
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
| 活动头部 + 发布/取消/完结 | `GET /api/admin/v1/activities/:id`(含派生 `phase`) · `PATCH .../:id/publish`(body 必填 `{requiresInsuranceConfirmed:true}`) · `PATCH .../:id/cancel`(仅 draft|published) · `POST .../:id/complete`(**唯一**完结通路 published→completed) |
| 负责人 / 协办 tab（Unreleased） | `GET /api/admin/v1/activities/:activityId/responsibilities` · `POST/DELETE .../collaborators[/:assignmentId]` · `POST .../transfer`；legacy 仅管理员用 `POST .../claim` / `POST .../assign-initiator` |
| 岗位 tab | `POST/GET /api/admin/v1/activities/:activityId/positions` · `GET/PATCH/DELETE .../positions/:activityPositionId`；读仅登录，写复用 `activity.update.record` + activity scope |
| 报名 tab | `GET /api/admin/v1/activities/:id/registrations?statusCode=` · `POST` 代报名 · `PATCH .../:rid/{approve,reject,cancel}` · `POST .../:rid/reopen`(v0.40.0 审批后悔药 reject→pending)· `PATCH .../{bulk-approve,bulk-reject}`(1–100 条逐项结果) · `GET .../export`(CSV) |
| 考勤 tab | `GET /api/admin/v1/activities/:id/attendance-sheets?statusCode=` · `POST` 提交单据 |
| GPS 打卡证据 / 考勤草稿 | `GET /api/admin/v1/activities/:id/check-ins?page=&pageSize=` · `GET .../:id/attendance-sheet-draft`(只读、不落 Sheet/Record) |
| 评价 tab / 汇总卡 | `GET /api/admin/v1/activities/:id/feedbacks?page=&pageSize=` · `GET .../:id/feedback-summary`；两者复用 `attendance.read.sheet` + activity ref |
| 考勤审核详情 | `GET /api/admin/v1/attendance-sheets/:id/review-detail`(**活动摘要+单据+records含队员嵌套**,为审核页量身做的)· `PATCH .../:id/{approve,reject,final-approve,final-reject}` · `POST .../:id/{return,final-return,resubmit,reopen}` · `DELETE` |
| 参与核对 / 汇总 | `GET /api/admin/v1/activities/:id/reconciliation`(**仅 completed**) · `GET .../:id/participation-summary`；两者均需 `attendance.read.sheet` + `activity-registration.read.record` |

> **Unreleased · 活动责任闭环本地联调（历史来源 PR-4–PR-11）**：活动出参 additive 增加 `initiatorMemberId` / `workflowRevision`，Admin create 可选 `initiatorMemberId`；不传时当前账号必须绑定正式队员，代建仅限 SUPER_ADMIN 或 `activity-responsibility.override.record`。发布审核工作台为 `GET /api/admin/v1/activity-publish-reviews`、`GET /:id`、`POST /:id/approve`、`POST /:id/return`，列表按显式 reviewer RoleBinding 组织范围过滤。发布成功会原子创建发起人为唯一 owner 并投影 `activity-owner` scoped binding；reviewer 永不因审批成为 owner。责任读模型返回 `{activityId,initiator,owner,collaborators,legacyUnassigned}`；协办 body 为 `{memberId,canManageRegistrations,canManageAttendance,reason?}`（至少一个 capability=true），移交 body 为 `{newOwnerMemberId,retainPreviousOwnerAsCollaborator,reason}`。legacy `claim` 只允许已发布且零 active responsibility，`assign-initiator` 只允许 draft 且 initiator 为空，两者 reason 必填。gate=true 后 pending review 期间 Activity 与岗位不可直改，published 直改返回 `20037`；App submit/withdraw/change proposal 与 Admin approve change 均已交付。普通 `biz-admin`/`org-admin` 不再天然拥有活动写、报名写、考勤写/一审，`group-manager` 也不天然拥有一审；通用角色只保留规格中的 create/delete/read。代码、契约、全量测试和临时 Docker Smoke 已验证，但当前只供本地联调，不配置真实 reviewer/owner。
>
> **Unreleased · PR-12 发起权限边界**：create 与 draft 真实改 `organizationId` 共用同一发起资格策略；目标组织必须存在、ACTIVE、未软删且非根，持久化 initiator 必须是 ACTIVE 正式队员并关联至少一个 ACTIVE、未软删 User。后台代建沿既有 contract：membership 属于目标 initiator，`activity.create.cross-org` scoped grant 属于实际操作者；draft 改组织不得用操作者 memberId 回退。已发布活动的普通 change proposal 不允许改组织，submit 与 approve（含旧/篡改 snapshot）均以 `20022` 拒绝；显式传当前相同 `organizationId` 正常通过。
>
> **未来正式上线参考**：legacy gap、显式认领、三个 reviewer RoleBinding 与整 fleet 切换顺序保留在 [`activity-responsibility-workflow-rollout.md`](../ops/activity-responsibility-workflow-rollout.md)。当前不执行；真正上线时必须使用届时批准的正式 release tag 和不可变 image digest 重新复核。前端不得用 `publishedBy` 猜 owner，也不得把本地 smoke=true 当作环境状态。

> 关键:报名/考勤接口**本来就按 activityId 嵌套**——作战室是它们的自然消费者。
> `activityId` 从**路由参数**来,不要在页面顶部摆"选择活动"下拉。

> **审计刀 5 参与口径**:`reconciliation` 的 no-show = completed 活动中 pass 报名且**零未软删考勤记录**；考勤 Sheet 即使仍 pending，只要已有 record 就算到场。cancelled 报名不计 no-show。`participation-summary.registrationCounts` 固定返回 `pending/pass/reject/cancelled/waitlisted` 五个分项，且五项和恒等于 `total`；候补规模直接读 `waitlisted`，不要用差值反推。`totalServiceHours` / `totalContributionPoints` / 四档时长 histogram 则只统计 approved Sheet records；不要把“是否到场”和“是否已审批生效”混成同一过滤条件。

> **活动 GPS 打卡 → 考勤草稿(F3/F4)**:`check-ins` 与 `attendance-sheet-draft` 都只提供安全复核视图，**不返回原始 longitude/latitude 或 accuracy**。前端读取草稿后在本地结合 `flags` 编辑 `records`，再向既有 `POST /api/admin/v1/activities/:id/attendance-sheets` 提交 `{ "records": editedRecords }`；两条 GET 需 `attendance.read.sheet`，真正提交另需 `attendance.create.sheet`，读权不等于创建权。F4 起岗位报名的草稿 `roleCode` 自动带岗位 `attendanceRoleCode`，忘签退回退岗位 `endAt`；无岗位仍为 `member` + Activity.endAt。提交时后端按 record 对应报名的岗位窗校验并以该 roleCode 命中既有贡献规则，前端不要重写成 `member` 或自行算贡献。`absentRegistrations` 仅提示当前 pass 且零打卡的报名，不能伪造成 record；`records=[]` 时不要提交；超过 200 条按既有 `ArrayMaxSize(200)` 分批创建多个 Sheet，不能静默截断。

> **活动评价(F3–F4)**:`feedbacks` 默认按 `updatedAt DESC,id DESC` 分页，item 精确展示 `memberNo/displayName/rating/comment/createdAt/updatedAt`；`feedback-summary` 返回评价人数、两位均分（无评价为 null）、固定 1～5 星五桶和四位评价率。评价率分母是 approved Sheet 内未软删考勤记录的 distinct member 数，分母为 0 时为 0。`participation-summary` 尾部 additive `feedback:{count,avgRating}` 与完整汇总同源；不要在前端自行重算，也不要把 App 评价暴露给其他队员。F4 已用真实 DB E2E 对账两种汇总并锁定实名字段。

> **活动岗位(F2–F4)**:创建/更新 body 白名单为 `name/attendanceRoleCode/capacity/startAt/endAt/genderRequirementCode/description/sortOrder`；响应主键字段为 `activityPositionId`。`capacity=null` 表示不限，岗位时段必须同空同有且落在活动窗内。列表固定 `sortOrder ASC,createdAt ASC,id ASC`。同活动 live 重名返 `20003`，软删/跨活动岗位详情统一 `20002`，存在 pending/pass/waitlisted 报名时删除返 `20031`。有 live 岗位时活动 list/detail 的 `capacity` 是岗位名额派生值（任一不限→null，否则求和），编辑 Activity.capacity 不再触发递补。岗位报名的 App 签到/签退与 Admin 考勤 record 都按岗位窗 ± 既有容差，草稿角色自动取岗位 `attendanceRoleCode`；岗位没配独立时段才回落活动窗。前端路由参数必须使用全称 `activityPositionId`，不要复用组织职务的 `positionId` 命名。
>
> **报名岗位列(F3)**:Admin 报名列表 item additive 返回 `activityPosition:null|{activityPositionId,name}`；代报名 body 可传 `activityPositionId`。活动有 live 岗位未传返 `21035`，不存在/跨活动/已删返 `20002`，同人报第二岗位仍返 `21002`。候补排位、取消递补与岗位扩容递补均按 `(activityId,activityPositionId)` 隔离。

> ⚠️ **报名审批生命周期新规(v0.40.0 参与域生命周期收口)**:
> ① **未发布/取消/完结/已结束活动禁批报名** —— `approve` 仅在 activity=published 且 `endAt >= now` 时允许；draft 返 `20126`，cancelled/completed/已结束返 `20124`。`reject` / `cancel` 仍可用于清理残留队列。
> ② **审批后悔药 reopen** —— 驳回后想改判:`POST .../:rid/reopen`(**只 `reject → pending`**;无 body;成功后 `reviewedBy/reviewedAt/reviewNote` 清空,回到待审)。**没有 `reject → 直接通过`**——改判必须 reopen 回待审后重走 approve。reopen 需 `activity-registration.reopen.record` 码(biz-admin 默认有)。reopen 也解决了「被驳回的队员无法对同一活动重新报名」——驳回记录占着报名唯一槽,reopen 回待审后即可正常重审。
> ③ **已考勤报名禁取消** —— 报名一旦有未撤销的考勤记录,`PATCH .../:rid/cancel`(及 App 端 `cancelMy`)返 **`21033`**(`ACTIVITY_REGISTRATION_HAS_ATTENDANCE`,「报名已有考勤记录,不可取消」)。要撤销这类参与,先去考勤面处理该考勤记录(软删),报名即自然解锁可取消。前端给出对应文案,别笼统按"操作失败"。
> ④ **活动已结束/截止/公开性报名闸** —— admin 代报名与 App 自助都要求 published、未截止、未结束；admin 对 `isPublicRegistration=false` **允许定向邀请**，App 自助仍拒且 App 可参加池过滤非公开活动。活动 detail 口径刻意不动（published 即可见）。
> ⑤ **手动完结唯一通路** —— `POST .../:id/complete`(无 body)把 published 推进 completed；考勤提交不再改变 Activity 状态。完结后仍可补录考勤，但不可新报名/审批通过。
> ⑥ **发布/编辑前端适配** —— `PATCH .../:id/publish` 从本批起 body **必填** `{ "requiresInsuranceConfirmed": true }`，缺失/false → 400；发布弹窗必须让操作者显式核对 `requiresInsurance` 后再提交。发布会复检 `endAt > now` 与 deadline 未过；create/update 要求 deadline≤endAt，capacity 不得缩到当前 pass 数以下。completed/cancelled 仅开放 description/coverImageUrl/galleryImageUrls/content/registrationNotes 五个展示字段。

> ⚠️ **考勤终审判权与责任约束**：终审权只来自任职上的 scoped `attendance-final-reviewer` 绑定或 `SUPER_ADMIN`；`biz-admin` 不持终审码，无码者先返回 `30100`。持权者调用 `final-approve` / `final-reject` 时，提交人或最近重提人自审返回 `22074`，一级审核人与终审人同人返回 `22075`，`SUPER_ADMIN` 也不豁免。`ATTENDANCE_ALLOW_SAME_REVIEWER` 已废弃且不会放开。前端必须分别展示 30100/22074/22075，排查授权用 §2.6 `authz/explain`。

> **考勤退回修改（Unreleased PR-8）**：一审 `POST .../:id/return`、终审 `POST .../:id/final-return`，body 均为 `{ "returnNote": "必填原因" }`；成功后状态为 `returned`，records 原样保留。普通修正先 `PATCH .../:id`（returned 可编辑），再 `POST .../:id/resubmit` 发送空对象；重提清空一审/终审/退回责任字段、`version+1`、回 `pending`，必须重新走一审。无原因返 `22082`，非 returned 重提返 `22083`。原 `reject/final-reject` 仍表示作废并软删 records，不能拿来做普通整改。终审退回同样执行 22074/22075；一级退回执行最近提交人自审限制 22081。

> ⚠️ **考勤终审撤回(v0.47.0 F2)**:`POST /api/admin/v1/attendance-sheets/:id/reopen`,body 必填 `{ "reason": "撤回原因" }`,成功 HTTP 201。只允许 `approved → pending`;后端保留全部 records / previousSnapshot / version,清空一审与终审责任字段。前端撤回后应重新开放 records 编辑与一级/终审流程;approved-only 的队员贡献值/考勤记录会暂时消失,再次 finalApprove 后恢复。撤回本身不发通知、也不回滚历史报名准入或招新/入队晋级;再次 finalApprove 仍发既有考勤通知。权限码 `attendance.reopen.sheet` 与终审同属 `attendance-final-reviewer` scoped 角色或 SUPER_ADMIN,biz-admin 不持有;reopen 不触发 22074/22075。

### 2.2 队员 360(沿队员轴下钻)— ✅ 6 子资源(部门→memberships 升级 PR2;+任职 PR4)+ 4 跨轴查询全就绪
| tab | 端点 | 状态 |
|---|---|---|
| 基本信息 | `GET /api/admin/v1/members/:id` | ✅ |
| 证书 / 档案 / 紧急联系人 / 保险 | `GET /api/admin/v1/members/:id/{certificates,profile,emergency-contacts}`；保险主数据源改用 `GET /api/admin/v1/members/:id/insurances/overview`，审核与 PR3 gate 见下方 | ✅ |
| **组织归属(memberships)** — 主/兼/临时/支援多归属 + 任期 | `GET/POST .../members/:id/memberships` · `PATCH/DELETE .../members/:id/memberships/:id`(**终态 scoped-authz PR2**,已发 main)| ✅(旧 `/department` 单部门面 deprecated,见下备注)|
| **任职(position-assignments)** — 该队员在组织体系内担任的职务,含撤销历史 | `GET .../members/:id/position-assignments`(**终态 scoped-authz PR4**,已发 main;含 ACTIVE/REVOKED 全量,任命/撤销动作在组织架构侧发起,见 §2.6)| ✅ |
| 活动履历 / 考勤记录 / 参与汇总 / 贡献值 | `GET .../members/:id/registrations?statusCode=` · `GET .../members/:id/attendance-records` · `GET .../members/:id/participation-summary` · `GET .../members/:id/contribution-summary` | ✅ |

> 队员 360 跨轴查询备注:`registrations`/`attendance-records` 分页(`page`/`pageSize`)+ item 自带 activity 上下文(`activityId`/`activityTitle`);`attendance-records` **仅返 approved sheet 内 records**(已生效记录,镜像 app `/me` 口径);`contribution-summary` 返**生涯累计 capped 总分**(`{ memberId, contributionPoints }`,后端已按北京日封顶 3,**前端直接展示别再加**)。v0.48.0 起历史记录也按新上限读时实时重算,生涯累计数字可能变大;不存在/软删队员 → `MEMBER_NOT_FOUND`(15001)。

> **新增 `participation-summary`** 把 approved-only 的 `totalServiceHours` / distinct `activityCount` / `recordCount` 与生涯 capped `contributionPoints` 合成一个卡片 DTO；贡献字段和旧 `contribution-summary` 都调用同一 `computeCappedContribution(memberId, null)`，可做等值迁移但旧端点保留。该个人端点刻意不返回 no-show。

> **队员 360 统一保险概览**：保险 tab 的显示主数据源为 `GET /api/admin/v1/members/:memberId/insurances/overview`。`selfPurchased` 展示个人自购保险及审核动作；`teamProvided` 只读展示团队保险安全投影，不展示“核验通过 / 驳回”，也不返回保单号、备注、其他成员或 reviewer。UI 必须直接使用后端的 `dateStatus` 与 `summary.hasConfirmedCoverage`，不再仅以 `coverageEnd >= 当前时间` 自行推导日期状态。`summary` 只是按北京当前日的概览，不得替代某次活动审批或入队资格判定。旧 `GET /api/admin/v1/members/:memberId/insurances` 保留兼容，但队员 360 应迁移到 overview。
>
> 个人审核动作仍为 `POST /api/admin/v1/members/:memberId/insurances/:insuranceId/review`。
>
> **自购保险审核(D-INSURANCE v3 PR3 cutover)**：保险列表/审核成功响应包含 `reviewStatusCode`(`pending|verified|rejected`)、`version`、`reviewedAt`，不返回 reviewer 身份。仅对 `pending` 行展示“核验通过 / 驳回”动作；调用唯一 review 端点 `POST /api/admin/v1/members/:memberId/insurances/:insuranceId/review`，body **只能**是 `{decision:'verified'|'rejected',expectedVersion:number}`，`expectedVersion` 永远必填，不得设计 note/reason 输入。权限码仍为 `member-insurance.review.record`。`26011` 表示版本/并发冲突：刷新该行、重新展示当前状态并由用户确认后再提交；`26012` 表示已非 pending，刷新后关闭审核动作。审核响应的新 `version` 必须写回前端状态。
>
> **单 gate 与 Team Join final join**：`Create/UpdateTeamJoinCycleDto` 可配置 `requiresInsurance`（create 缺省 false），response 始终回显。只有 `INSURANCE_ENFORCEMENT_ENABLED=true && cycle.requiresInsurance=true` 时，admin final join 才按 verified self → live team policy coverage 固定优先级校验入队北京日，并在根事务生成绑定 application 的恰一条最小 evidence；无来源返 `26031`（“本轮入队要求保险,当前队员无覆盖入队日期的有效保险,无法入队”），不得复用活动的 `26030`。gate=false 时字段仍可配置/展示，但不查资格、不写 evidence；活动保险失败继续 `26030`。
>
> **PR4 migration 终态**：约束代码已交付但本 PR 未 deploy、生产尚未生效；deploy 后 Evidence 的单 source/owner、kind/区间/review snapshot、同 member、owner 全局唯一与 immutable 才由 PostgreSQL 兜底，source/owner 后续编辑或软删不改历史 snapshot。该收口没有新增 route、DTO、权限、审核动作或前端字段，Admin 契约 0 diff。
>
> **rollout 边界**：维护者于 2026-07-19 逐字确认“旧客户端都没上线，放心操作执行”，这只解除客户端兼容等待，**不代表旧 server=0 已验证**。本 PR 不 release/deploy/启用；production 配置必须显式 true/false，切 true 前先 drain 旧 server/旧事务，且整个 fleet 必须同档位，禁止 true/false 混跑。App expectedVersion 与活动 consumer 细节见 [`miniapp.md §1.2`](miniapp.md)。

> **v0.49.0 队员轴 scoped-authz 已接通**:members 列表/options 只返回调用者可见组织树内、具有 active **PRIMARY** membership 的队员；SECONDARY/TEMPORARY/SUPPORT 不扩大鉴权范围。显式 `organizationId` + `includeDescendants` 是用户筛选条件，服务端会再与鉴权范围求交，绝不越界。队员 detail/全部写动作、证书、档案、紧急联系人、个人保险以及本节三条跨轴查询都对 member/resource ref 重做 authz 判定：范围外 detail/写返 `30100`；有读码但有效范围为空时列表返回 200 空集。队长/部长沿 `org-admin` 可读可管本树，组长沿 `group-manager` 管本组；副职 `org-readonly`/`group-readonly` 与分管 `org-supervisor` 只读，写动作恒 `30100`。敏感明文码仍不随派生角色下放。

> **档案(profile)敏感字段分级(第三轮 review §F&A-3,2026-07-10;镜像 recruitment `read.sensitive`)**:`GET/POST/PATCH .../members/:memberId/profile` 三端点的 `documentNumber`(证件号)与 `mobile`(本人手机)**默认掩码返回**(`110101********1234` / `138****1234`);入口闸仍是 `member-profile.read.record`,**明文需更严的 `member-profile.read.sensitive`**(绑 biz-admin,故一切 ADMIN 默认见明文;org-admin/group-manager 等 scoped 角色**不含**该码 → 见掩码)。**字段名/类型不变**(掩码是值变换,不是新增 `*Masked` 字段;`documentNumber`/`mobile` 仍是 `string`),前端无需改字段绑定;若需展示明文,给对应岗位角色补挂 `member-profile.read.sensitive` 即可。其余字段(含医疗类)不随该码分级。

> **组织归属(memberships)= 部门面升级(终态 scoped-authz PR2,已发 main)**:一个队员可有多条归属——**主 PRIMARY**(至多一条 active)/ **兼 SECONDARY** / **临时 TEMPORARY** / **支援 SUPPORT**,各带任期(`startedAt` / `endedAt`)+ 原因(`reason`),支持历史留痕。端点 `admin/v1/members/:memberId/memberships`:`GET` 列全部含历史(`membership.list.record`)· `POST` 新增指定 `membershipType`(`membership.set.record`)· `PATCH :id` 改类型 / 任期 / 原因〔不改 status〕(`membership.set.record`)· `DELETE :id` 结束归属〔status=ENDED + endedAt,留痕非物删〕(`membership.end.record`);**换组织 = 结束旧 + 新建**(不就地改 organizationId)。4 码全绑 **ops-admin**;`membership.read.record` 已 seed 但**本刀无端点承接**(为未来 `GET :id` 预留的孤码)。**旧单部门端点 `GET/PUT/DELETE .../members/:memberId/department`(3 端点,`member-department.{read,set,clear}.current`)deprecated-但保留一版**——内部映射到 active PRIMARY membership;**新面一律用 memberships,别再对 `/department` 开新 UI**。

> **任职(position-assignments)= 组织轴 + 队员轴双轴子资源(终态 scoped-authz PR4,已发 main)**:本 tab 只读展示该队员的任职(`GET .../members/:memberId/position-assignments`,`position-assignment.read.record`);**任命 / 撤销动作在组织架构侧发起**(§2.6 组织轴),不在本 tab 内操作,避免"队员 360 里手选组织再任命"的反模式。字段含 `isConcurrent`(兼任标记,如"副队长（兼）",纯展示不影响授权)、`appointmentSource`(任命来源自由串)、`appointedByUserId`/`revokedByUserId`。**若该队员同时是分管人**(supervision-assignment,PR5,与职务正交,§2.6),其分管范围可用 `GET .../members/:memberId/supervision-scope` 只读查询(`supervision-assignment.read.record`),同样只展示不管理,建/改/撤销分管走 §2.6 的分管管理面。**🔴 任职记录的存在不代表该队员已获得对应权限**——判权语义见 §2.6 落地进度声明。

### 2.3 审批工作台(跨活动横扫"待我处理")— ✅ 后端扁平查询就绪(跨轴只读 2026-06-23;F2「B 组」搜索/组织过滤/expand 已发 main)
跨所有活动按 `statusCode` 横扫报名/考勤,**脱离 `:activityId` 路径段**:`GET /api/admin/v1/registrations?statusCode=` · `GET /api/admin/v1/attendance-sheets?statusCode=`(均分页 + item 自带 activity 上下文 `activityId`/`activityTitle`)。见 [GAP-001](#4-缺口台账-gap-ledger)。

活动责任闭环联调必须把以下五种视图分开，不能因为用户“能看到某页”就把写按钮全部点亮：

| 视图 | 数据源 | 操作判断 |
|---|---|---|
| 我参与的活动 | App `GET /api/app/v1/my/activities` | 本人报名/参与历史，不代表管理责任 |
| 我发起或负责的活动 | App `GET /api/app/v1/my/managed-activities` | 详情的 `myResponsibility`、publish review 与 closure 状态 |
| 待我审核发布 | Admin `GET /api/admin/v1/activity-publish-reviews?status=pending` | `activity.publish.record` 对该 review/activity 的 scoped 判定 |
| 待我一审 | Admin `GET /api/admin/v1/attendance-sheets?statusCode=pending` | `attendance.approve.sheet` + resource 状态 + 人员隔离 |
| 待我终审 | Admin `GET /api/admin/v1/attendance-sheets?statusCode=pending_final_review` | `attendance.final-approve.sheet` + resource 状态 + 人员隔离 |

列表可见只说明有读取范围。按钮仍需按对应 action、resource-specific responsibility 和当前状态判断，服务端判定是最终结果；不要按管理员、队长、`publishedBy` 或页面可见性猜权限。

> 报名批量动作仍落在具体活动轴：`PATCH admin/v1/activities/:activityId/registrations/bulk-approve` / `bulk-reject`。body `ids` 去重且 1–100；后端按输入顺序逐条复用单条 approve/reject 的事务、容量、状态、审计与通知语义，返回逐项 success/failed，一条失败不会回滚此前成功项。前端必须展示失败行及其 BizCode，不能把 HTTP 200 等价成“全批成功”；批量驳回未填备注时后端使用「批量驳回」。

> **候补（已发 v0.53.0）**：不新增列表或手动递补端点。活动内列表与跨活动扁平列表继续使用既有 `statusCode=waitlisted` 过滤；列表项 additive `waitlistPosition:number|null`，候补从 1 开始，其余状态为 null。满员代报成功返回 waitlisted，不再返 21031。取消 pass 会自动把 FIFO 队首转 pending，capacity 调大递补 delta、改 null 递补全部；后台只需刷新列表/工作台，**不要提供 waitlisted→pass 的直通按钮**。候补可沿既有 reject/cancel 清理，approve 仍仅允许 pending。

> ⚠️ 过滤参数名是 **`statusCode`**(不是草拟期写的 `status`;沿既有嵌套列表口径)。值用 registration_status / attendance_sheet_status 字典码(如 `pending`/`pass`/`approved`)。

> **v0.49.0 scoped-authz 提示**:本页两个扁平跨轴列表已按调用者的可见组织集下推到 `activity.organizationId`。仅职务/分管派生、零 GLOBAL 绑定的用户可进入页面：队长/部长见对应组织树，组长见本组，副职与分管人只读可见；显式 `organizationId`/`includeDescendants` 与鉴权范围求交。GLOBAL 角色与 SUPER_ADMIN 仍看全量；有码但范围空返 200 空列表，无码返 `30100`。点动作仍在具体 resource ref 上独立判权，列表可见不等于拥有审批/写权限。

**F2「B 组」搜索 & 组织过滤 & expand**(admin-api-fe-integration-roadmap.md §4 B1/B2;2026-07-04 已发 main):两端点在原有 `statusCode` 基础上新增以下**可选**参数,全部省略时响应逐字不变:

| 端点 | 新增可选 query | expand 白名单 |
|---|---|---|
| `GET admin/v1/registrations` | `q`(模糊命中 memberNo+memberDisplayName+activityTitle)/ `memberQ`(仅队员字段)/ `activityQ`(仅活动标题)/ `memberId` / `activityId`(精确过滤)/ `organizationId`(经活动 organizationId)/ `includeDescendants` | `member`(附 `{id,memberNo,displayName,gradeCode}`)/ `activity`(附 `{id,title,startAt,organizationId}`) |
| `GET admin/v1/attendance-sheets` | `q`(模糊命中 activityTitle + 提交人 User.username/nickname)/ `activityQ`(仅活动标题)/ `organizationId` / `includeDescendants` | `activity`(附 `{id,title,startAt,organizationId}`) |

两端点均支持 `dateFrom`/`dateTo`(ISO8601,含边界;registrations 按 `registeredAt`,attendance-sheets 按 `submittedAt`)。

**`expand` 仓库级约定(D6,F2 首落地,F3–F5 沿用)**:`?expand=a,b` 逗号分隔白名单枚举(见上表);**默认不传 = 响应形状与旧版逐字一致**(不会多出 `member`/`activity` 键);传白名单外的值 → `BAD_REQUEST`。展开出的子对象是**独立最小摘要**,与 item 上已有的扁平字段(如 `memberNo`/`memberDisplayName`/`activityTitle`)并存、不互相替代——即便字段名有重叠(如 `memberNo`),取 `expand` 出的嵌套对象仅为拿到更完整的一组字段(如 `gradeCode`/`startAt`/`organizationId`),不代表旧的扁平字段被废弃。

> ⚠️ **参数溢出提示**:`registrations`/`attendance-sheets` 的这批新 query 参数与嵌套路径端点(`activities/:activityId/registrations`、`members/:memberId/registrations`、`activities/:activityId/attendance-sheets`)共享同一份请求 DTO——Swagger 上这些嵌套端点也会"看到"这些参数,但**传了不生效**(仅本节两个扁平横扫端点真正消费)。别在嵌套端点上依赖它们。

### 2.4 其它资源管理页(CRUD,沿现状)
活动列表 `GET /api/admin/v1/activities`(多字段过滤)· 队员列表 `GET /api/admin/v1/members`(memberNo/gradeCode/status)· 字典 `system/v1/dict-*` · 组织 · 贡献值**规则** `system/v1/contribution-rules`(注:是规则,不是队员的分)· 用户/RBAC/审计 `system/v1/*`。

> ⚠️ **贡献规则 `dailyCap` 入参下线**:新建/PATCH 表单停止发送 `dailyCap`,继续传入会被 DTO 白名单拒绝为 HTTP 400 / `40000`。响应仍保留该历史字段供旧数据展示，更新其他字段不会改写存量 `dailyCap`；前端不得将它解读为生效中的每日上限。

**队员账号闭环 v1(MVP,2026-07-07)— ✅ 已发 main**:给已存在队员(手动建档 / 未走招新 promote 的历史队员)开通登录账号。开号 = 建一个绑手机号的 `User`(`username=memberNo`、随机不可用密码、`role=USER`),队员**用手机验证码登录**(现有 `POST auth/v1/login-sms{,/send-code}`),**不设密码**。以后队员想自己设密码,走现有"手机验证码找回/设置密码"(`POST auth/v1/password-reset{,/send-code}`,用队员自己手机号)即可,**前端无需为此单独造页面**。

**队员账号闭环 v2(完整生命周期,2026-07-07)— ✅ 已发 main**(冻结评审稿 [`member-account-loop-v2-review.md`](../archive/reviews/member-account-loop-v2-review.md)):`User.memberId` 根改造为 partial unique(软删旧号即释放槽位),补齐绑定既有悬空账号 / 解绑 / 退号重开 / 队员面启停账号四条能力,v1 单条"从零开号"闭环成完整生命周期。

| 任务 / 页面 | 端点 | 鉴权 |
|---|---|---|
| 队员列表按"有没有账号"过滤(找出还没开号的队员)| `GET /api/admin/v1/members?hasAccount=false` | `[rbac: member.read.record]` |
| 队员列表/详情显示"是否已开号 + 账号状态"| `hasAccount`/`accountStatus`(`ACTIVE`\|`DISABLED`\|`null`)/`userId` 三字段 additive 出现在 `GET /api/admin/v1/members`(list)与 `GET /api/admin/v1/members/{id}`(detail)响应里,**无需新调用**;v2 起语义收窄为"仅计当前 live 绑定"(历史软删账号不再计入) | 同上 |
| 队员详情页"开通账号"按钮(仅 `hasAccount=false` 时可点)| `POST /api/admin/v1/members/{id}/account`(body: `{phone}`,大陆 11 位手机号)→ 返 `{userId,username,phone,phoneVerifiedAt,role,memberId}`;v2 起该队员历史软删过账号也可再次开号(槽位已释放) | `[rbac: member.grant.account]`(**绑 ops-admin**,与队员列表其余 5 码归 biz-admin **不同**——若持 biz-admin 的运营也要能开号,维护者可后续单独把该码也授予 biz-admin,一行绑定、不改前端) |
| 队员详情页"绑定既有账号"(把 `POST admin/v1/users` 建的、还没绑队员的悬空账号认领给本队员;账号保留原密码/openid/phone 等登录方式,不强制手机号)| `POST /api/admin/v1/members/{id}/account/bind`(body: `{userId}`)→ 200 返更新后的队员详情 | `[rbac: member.bind.account]`(绑 ops-admin,不绑 biz-admin) |
| 队员详情页"解绑账号"(只断链,账号回悬空 `ACTIVE`,**不**顺手停用/删除——要停用/删除走既有用户管理端点)| `POST /api/admin/v1/members/{id}/account/unbind`(无 body)→ 200 | `[rbac: member.bind.account]` |
| 队员详情页"退号重开"("账号打错了"一步修复:软删旧号 + 用新手机号开新号,单事务原子)| `POST /api/admin/v1/members/{id}/account/reopen`(body: `{phone}`,须与旧号不同——同号会命中 `PHONE_ALREADY_BOUND`,这是有意行为)→ 返新账号 `{userId,username,phone,phoneVerifiedAt,role,memberId}`;**`username` 从第 2 次起追加代际后缀**(如 `M-0001-2`),不影响登录(登录只认手机号) | `[rbac: member.grant.account]`(复用) |
| 队员详情页"启用/停用关联账号"| `PATCH /api/admin/v1/members/{id}/account/status`(body: `{status: 'ACTIVE'\|'DISABLED'}`)→ 200 返更新后的队员详情;禁止管理员对**自己绑定的账号**操作(`CANNOT_OPERATE_SELF`);置 `DISABLED` 时联动撤销该账号全部未过期 refresh token(与用户管理页"禁用用户"同一效果) | `[rbac: user.update.status]`(复用既有用户管理码,0 新码) |
| 队员批量导入后"一键批量开号"(整队历史队员一次性开号;逐行 skip-on-error,单行失败不影响其余行)| `POST /api/admin/v1/members/accounts/bulk-grant`(body: `{items:[{memberId,phone}]}`,1-200 条)→ 返 `{items:[{memberId,status:'ok'\|'blocked',userId,reason}],summary:{total,ok,blocked}}`(`userId`/`reason` 恒回显两键,不适用为 `null`) | `[rbac: member.grant.account]`(复用) |
| 用户列表/详情反查"这个账号属于哪个队员"| `memberId`/`member:{memberNo,displayName}\|null` 两字段 additive 出现在 `GET /api/admin/v1/users`(list)与 `GET /api/admin/v1/users/{id}`(detail)响应里 | `[rbac: user.read.account]` |
| **队员详情页"一键离队"**——一步关闭队员身份及全部当前授权来源:置 `INACTIVE`、结束全部在编归属、停用关联账号并撤 refresh、撤销 active 任职/分管、结束 USER/MEMBER/POSITION_ASSIGNMENT 的 active RoleBinding；历史行保留 | `POST /api/admin/v1/members/{id}/offboard`(无 body)→ 返兼容字段 `{member, memberDeactivated, membershipsEnded, accountDisabled, refreshTokensRevoked, linkedUserId, residualActivePositionAssignments, residualActiveSupervisions}`；`PATCH /api/admin/v1/members/{id}/status` 置 `INACTIVE` 时复用同一事务核心 | offboard 为 `[rbac: member.offboard.record]`；status 为 `[rbac: member.update.status]` |

**v2 完整生命周期(单条 bind/unbind/reopen/status + 批量开号)已全部落地,`NEXT_TASKS` P1-18 已关**。

> ⚠️ **一键离队前端注意**:①**幂等**——重复执行返 200，已完成的腿计数为 0，可安全重试；②`residualActivePositionAssignments`/`residualActiveSupervisions` 保留为兼容字段与锁后不变式探针，正常终态恒为 0；③队员不存在 `15001`，若关联账号已被提权为非 `USER` 则返 `15036`，须先走用户管理端点；④无关联账号时账号腿自动跳过，其他授权来源仍会正常关闭；⑤重新置 `ACTIVE` 只恢复队员状态，不自动恢复任何历史归属、账号状态、任职、分管或角色绑定。

### 2.5 通知管理(站内信撰写 / 发布 + 微信订阅渠道 + 系统定向 + 短信兜底)— ✅ S1+S2+S3+S4+S5 后端就绪(v0.32.0 已发)

统一通知模块 S1 站内信渠道 + S2 微信订阅 quota 渠道 + S3 producer 接入 + S4 活动·考勤 producer 定向触发 + S5 短信兜底渠道(GAP-005 S1–S5 全切片;冻结评审稿 [`unified-notification-dispatcher-review.md`](../archive/reviews/unified-notification-dispatcher-review.md))。admin 撰写/发布,会员 app 拉取站内信 feed(未读红点);S2 起 admin 可勾微信渠道,发布时向已订阅会员机会式推送。**S3 = 系统自动定向通知**:招新**发号 / 入队**完成后,后端自动向当事队员发一条**定向**站内信(发号另带微信),admin 面**无新操作**(业务 transaction 同写 durable intent、worker 后续执行,无新端点/无新 RBAC 码);会员侧 feed 见 [`miniapp.md`](miniapp.md)。**活动域现行通知口径(已发 v0.50.0)**:公开活动发布 → `activity-published` 会员广播;时间/地点变更、活动取消、队员取消已通过报名 → `activity-changed`;报名审批 → `registration-result`;考勤终审 → `attendance-result`;开场前 24 小时仅向仍为 `pass` 的报名者发一次 `activity-reminder`。全部复用站内信 feed、事务外 best-effort 派发,admin 面无新操作/新端点/RBAC 码。**S5 = 短信兜底(紧急召集;admin 显式发起 + 计费确认)**:管理端对**已发布且勾了"短信"渠道**的通知,点"发送短信" → **必须二次确认计费**:前端先以 `confirmed:false` 调 `POST admin/v1/notifications/{id}/send-sms` **预览** `recipientCount`(受众快照 / 预估,不保证最终计费),用户确认后再以 `confirmed:true` 确认并创建 / 尝试上述任务(向**可见且有手机**的队员逐人发"请打开 App 查看"短信,不代表全部最终完成;新 RBAC 码 `notification.send.sms` 162→163;见 §2.5)。**短信永不随发布自动发**(成本动作显式 gating);未声明短信渠道 / 未发布 → `31013`,短信通道未配置 → `24030`,缺 `confirmed` → 400;手机号一律掩码。**真·全员短信批处理异步未做**(若受众过大致延迟另立项)。

> **D-Outbox 当前实现(2026-07-18)**:招新发号/入队由业务 transaction 同写 durable intent，独立 worker 后续执行定向 Effect。前端端点、响应和操作完全不变；活动/报名/考勤 producer 暂仍沿 commit 后 best-effort 口径。

| 任务 / 页面 | 端点 | 鉴权 |
|---|---|---|
| 通知列表(草稿/已发/归档 + 类型/可见档/置顶过滤;readCount 触达)| `GET /api/admin/v1/notifications?statusCode=&notificationTypeCode=&visibilityCode=&pinned=` | `[rbac: notification.read.record]` |
| 新建草稿 | `POST /api/admin/v1/notifications`(title/body/notificationTypeCode/visibilityCode/visibleOrganizationIds/pinned)| `[rbac: notification.create.record]` |
| 详情(含 body + readCount,**不自增**)| `GET /api/admin/v1/notifications/{id}` | `[rbac: notification.read.record]` |
| 编辑(draft/published 可改,archived 冻结 → 31030)| `PATCH /api/admin/v1/notifications/{id}` | `[rbac: notification.update.record]` |
| 软删(任意态)| `DELETE /api/admin/v1/notifications/{id}` | `[rbac: notification.delete.record]` |
| 发布 / 撤回 / 归档(状态机 draft→published→archived,立即生效无 cron;非法跃迁 31030)| `POST …/notifications/{id}/{publish,unpublish,archive}` | `[rbac: notification.publish.record]` |
| **S5 发送短信兜底**(紧急召集;须已发布 + channels 含 sms,否则 31013;通道未配 24030)。**计费确认必需**:`confirmed:false` → 仅预览,`recipientCount` 为受众快照 / 预估(零发送,不保证最终计费);`confirmed:true` → 已确认并创建 / 尝试任务,不代表全部最终完成。`sent/failed/skipped` 仅为本请求同步首轮观测;not-claimed 计入 `failed`,其 durable final 可能随后成功;缺 `confirmed` → 400 | `POST /api/admin/v1/notifications/{id}/send-sms`(body: `confirmed: boolean`;返 `{confirmed, recipientCount, sent, failed, skipped}`)| `[rbac: notification.send.sms]` |

**字段/可见性**:可见档 4 选 1 `member` / `formal_member` / `department` / `management`(**通知去 public**,会员面专属);`department` 档须填活跃部门 orgId 数组(否则 31012);`notificationTypeCode` ∈ `notification_type` 字典(含 `activity-reminder` / `activity-published` / `activity-changed` / `registration-result` / `attendance-result` / `recruitment` / `emergency` / `general`)。统一形状列 `audienceType`/`sourceType`/`channels` 出参回显。**会员侧站内信 feed**(list/未读红点/标记已读)见 [`miniapp.md`](miniapp.md)。

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
| **任职总表 / 详情 / 任命预检**(F5「E 组」;跨组织跨队员横扫)| `GET /api/admin/v1/position-assignments`(分页 + 过滤 + `expand=member,position,organization`;缺省含 REVOKED 历史)· `GET .../position-assignments/:id` · `POST .../position-assignments/preview`(dry-run 任命校验逐项收集 violations,零写入)| `[rbac: position-assignment.read.record]`(0 新码)|
| **分管总表 / 详情 / 覆盖预演**(F5「E 组」;D9 兄弟路由)| `GET /api/admin/v1/supervision-assignments/page`(分页 + 过滤 + `expand=supervisor,organization`;旧数组端点不动)· `GET .../supervision-assignments/:id` · `POST .../supervision-assignments/coverage-preview`(EXACT/TREE 覆盖组织集预演)| `[rbac: supervision-assignment.read.record]`(0 新码)|
| **角色绑定 列表 / 建 / 改 / 软删**(带 scope 的角色绑定;PR6;2026-07-13 委派闸 + 任期/末位保护收口)| `GET/POST /api/admin/v1/role-bindings` · `PATCH/DELETE .../:id` | `[rbac: role-binding.{read,create,update,delete}.record]`;非 SUPER_ADMIN 对特权角色的 create / reactivation / 任期扩张 → 30102;特权角色 = ops-admin 或含 `role-binding.*` / `rbac.*` / 6 条 SA-only 保留码;PATCH/DELETE 或用户管理的禁用/软删若使最后一个 active GLOBAL ops-admin 持有人离场 → 30101;PATCH 成功写 `role-binding.update` before/after audit |
| **角色绑定 分页总表 / 详情 / 预检 / 批量建**(F3「C 组」;管理页主列表建议直接用 `/page`)| `GET /api/admin/v1/role-bindings/page`(分页 + 过滤 + `expand=role,principal`)· `GET .../role-bindings/:id` · `GET .../role-bindings/preview`(dry-run 零写入)· `POST .../role-bindings/batch`(≤200 逐条 ok/blocked/already-exists)| 读三路 `[rbac: role-binding.read.record]` / batch `[rbac: role-binding.create.record]`(0 新码)|
| **权限解释 / 判权诊断**(诊断读,deny 是 200 数据;PR10 + F3 批量壳)| `POST /api/admin/v1/authz/explain` · `POST .../authz/explain-batch`(≤200,同 11 值枚举)| `[rbac: authz.explain.decision]` / `[rbac: authz.explain-batch.decision]` |
| **当前用户有效权限码**(v0.49.0;前端路由/按钮可见性)| `GET /api/system/v1/authz/me/effective-permissions` → `{permissions:string[]}`(直接 RoleBinding + 正/副职 policy + 分管三源,去重排序)| `[auth]` 仅登录；SUPER_ADMIN 返 Permission 全集 |
| **批量业务态闸**(「这组按钮对我该不该亮」;F3「C 组」)| `POST /api/admin/v1/authz/action-state/batch`(≤200;判定对象 = 调用者本人;`allowed = 判权 ∧ 资源状态机只读`)| `[rbac: authz.action-state.decision]` |
| **归属总表 / 详情 / 冲突诊断**(F4「D 组」;跨队员跨组织横扫)| `GET /api/admin/v1/memberships`(分页 + 过滤 + `expand=member,organization`)· `GET .../memberships/:id` · `GET .../memberships/conflicts`(只读体检:悬空/停用/多主)| `[rbac: membership.{list,read}.record]` |
| **归属迁移(transfer)**(F4 唯一写端点;把队员某类型归属从 orgA 迁到 orgB)| `POST /api/admin/v1/memberships/transfer`(单事务:结束旧 + 新建;audit `membership.transfer`)| `[rbac: membership.transfer.record]`(绑 biz-admin)|
| **组织轴归属 / 队员下拉**(F4;组织管理页配套)| `GET /api/admin/v1/organizations/:orgId/memberships`(分页,`includeDescendants`/`membershipType`/`status`/`q`/`expand`;缺省仍含历史,成员页传 `status=ACTIVE`)· `GET .../organizations/:orgId/members/options`(该组织±后代可选队员,F1 投影)| `[rbac: membership.list.record]` / `[rbac: member.read.record]` |
| **组织树 + 归属计数**(F4;组织架构页概览)| `GET /api/admin/v1/organizations/tree-with-summary`(每节点 `directMembershipCount`/`subtreeMembershipCount`)| `[rbac: org.read.node]` |
| **公告导入 预览 / 执行**(2026 任命 staging 双锚落库工具;PR11,**一次性上线初始化用,平时不用**)| `POST /api/admin/v1/announcement-import/preview`(零写入诊断)· `POST .../announcement-import/execute`(幂等落库)| `[rbac: announcement-import.{preview,execute}.record]` |

**reparent**:重挂组织节点父级,事务内重算闭包表;守护——禁改根节点父级(`ORGANIZATION_PARENT_CHANGE_FORBIDDEN`)/ 目标父 = 自身或后代(成环)(`ORGANIZATION_PARENT_CYCLE`)/ 父不存在(`ORGANIZATION_PARENT_NOT_FOUND`)→ 拒。

**职务定义(positions)= 全局复用定义**:6 内置(队长 / 副队长 / 部长 / 副部长 / 组长 / 副组长);类别 `categoryCode` = `LEADER` 正职 / `DEPUTY` 副职 / `STAFF` 干事(STAFF 留口未内置);`code` kebab 创建后不可改;被职务规则引用时禁删(`POSITION_IN_USE` 32003)。**职务规则(position-rules)= 绑定关系**:某**组织类别**(`nodeTypeCode`,取 node_type 字典值)可设哪些职务(30 内置默认规则;`(nodeTypeCode, positionId)` 唯一)。positions + rules **8 码全绑 ops-admin**。

**任职(position-assignments)= 组织轴 + 队员轴双轴子资源(队员轴一侧见 §2.2)**:`POST organizations/:orgId/position-assignments` 任命时校验 5 项,均清晰归码——职务适配(该组织类别须有对应 active 职务规则,否则 `POSITION_ASSIGNMENT_RULE_NOT_MATCHED` 32022)/ 单人独占(职务 `allowMultiple=false` 且已有在任者 → `POSITION_ASSIGNMENT_SINGLE_HOLDER` 32023)/ 兼任(职务 `allowConcurrent=false` 且该队员已有其它在任 → `POSITION_ASSIGNMENT_CONCURRENT_FORBIDDEN` 32024)/ 归属要求(职务 `requireMembership=true` 时,队员须在本组织或其祖先有 active membership,经组织闭包表求祖先集判定 → `POSITION_ASSIGNMENT_MEMBERSHIP_REQUIRED` 32025)/ 任期(`endedAt` 须晚于 `startedAt` → `POSITION_ASSIGNMENT_TENURE_INVALID` 32026)。`isConcurrent` 是入参可选的**兼任标记**(如"副队长（兼）"),纯展示用途,**不影响任何校验或授权**。撤销 = `status: ACTIVE→REVOKED` + 记撤销人 `revokedByUserId` + `endedAt=now`(**非物理删**,记录保留供历史链 `.../:id/history` 查询);`AssignmentStatus` 三态 `ACTIVE`/`ENDED`/`REVOKED`,但**`ENDED` 当前无任何代码路径写入**(留作保留态,眼下只会看到 `ACTIVE`/`REVOKED`,别按 `ENDED` 做过滤分支)。**4 码全绑 ops-admin**。

**分管(supervision-assignments)= 与职务正交的独立监督关系**:`POST supervision-assignments` **不要求** supervisor 持有任何职务(R5 拍板:副职头衔零推导);`scopeMode` 二选一——`EXACT` 仅该组织节点 / `TREE` 含全部下级(创建默认 TREE)。两条只读查询**均为展示用,经组织闭包表现算,不是判权依据**:`supervision-scope`(某队员的分管范围)按其 active 分管逐条展开 `expandedOrganizationIds`(EXACT=`[organizationId]`;TREE=该组织 + 全部后代,含自身);`supervisors`(某组织被谁分管)聚合**直接**(`coverage=DIRECT`,分管记录直落该组织)+ **继承**(`coverage=INHERITED`,某祖先有 active `TREE` 分管而覆盖到本组织)两类,出参嵌套完整 `supervisionAssignment` 对象。撤销同任职语义(`status→REVOKED` + 撤销人 + `endedAt`,非物理删);`SupervisionStatus` 三态同任职,`ENDED` 同样当前无写入路径。同人对同组织仅一条 active(`SUPERVISION_ALREADY_EXISTS` 33002)。**4 码全绑 ops-admin**(三读端点——列表/`supervision-scope`/`supervisors`——共用 `read.record`)。

**角色绑定(role-bindings)= UserRole 终态形态,scoped 各型入库即止**:`principalType`(`USER`/`MEMBER`/`POSITION_ASSIGNMENT`/`SYSTEM`,非 SYSTEM 必填 `principalId`,**多态无 FK**,校验存在性归口对应实体)× `scopeType`(`GLOBAL`/`ORGANIZATION`/`ORGANIZATION_TREE`/`ACTIVITY`/`RESOURCE`/`SELF`)决定哪个 `scope*` 字段必填(`ORGANIZATION`/`ORGANIZATION_TREE`→`scopeOrgId`;`ACTIVITY`→`scopeActivityId`;`RESOURCE`→`scopeResourceType`+`scopeResourceId`;`GLOBAL`/`SELF` 均不填),字段与类型不一致 → `ROLE_BINDING_SCOPE_INVALID`(34003)/ principal 不一致 → `ROLE_BINDING_PRINCIPAL_INVALID`(34004)。`BindingStatus` 三态 `ACTIVE`/`ENDED`/`SUSPENDED`:`DELETE` 端点 = 软删,写 `status=ENDED`+`endedAt`+`deletedAt`(**与任职/分管的"REVOKED 不物删"不同,本资源软删会真的从列表消失**);`SUSPENDED` 可经 `PATCH` 手动置入(临时挂起而不撤销),后端不自动触发,判权同样不认。**4 码全绑 ops-admin**。**与既有"角色与权限"页是两个入口、同一张底表**——`system/v1/users/:userId/roles`(既有,仅 USER+GLOBAL,契约不变,`rbac.user-role.*` 码,继续可用)vs 本节 `role-bindings`(新,PR6,通用 CRUD,含 scoped,`role-binding.*` 码);两边建的 GLOBAL 绑定互相可见。**🔴 全篇最关键的一条(2026-07-03 PR12 + 摘码微刀 #482 已发后更新,以此为准)**:`RbacService`(全仓绝大多数业务面仍在用的老判权服务)**永远只读** `principalType=USER` 且 `scopeType=GLOBAL` 的绑定(等价旧 `user_roles`),这条不因 PR8 上线而改变。**真正会读 scoped 绑定(`ORGANIZATION`/`ORGANIZATION_TREE`/`ACTIVITY`/`RESOURCE`/`SELF`)的是新判权大脑 `AuthzService`(PR8,已发)**,目前**消费者 = 考勤终审(`final-approve`/`final-reject`,PR9,见 §2.1)+ participation 三模块点动作**(`activities`/`activity-registrations`/`attendances`,PR12,24 处判权位点,见 §2.1/§2.3)。也就是说:一条 scoped 绑定要真正生效,不但要建对绑定,还要该绑定授予的权限码恰好被这两批消费者之一读取;**其余动作**(证书核验、队员管理、招新/入队、内容发布、统一通知……)**不管建多少条 scoped 绑定,目前一律不影响任何人的实际权限**,因为对应业务代码根本没调 `AuthzService`(其余业务面逐面接入,诉求触发再出 goal,不再挂 GAP-007)。**前端在角色绑定管理页务必按此精确提示**(scopeType 非 GLOBAL 时,把旧文案换成**「当前对考勤终审 + 活动/报名/考勤的单点动作生效(扁平跨轴列表与新建活动仍 GLOBAL-only);其余业务面待后续批逐面接入」**),既避免运营误以为"建了 scoped 绑定 = 全面立刻生效",也避免反过来误以为"发了就什么都没用"。**排查某条绑定到底有没有生效** → 用下文「权限解释」端点(PR10)一键查。

> **v0.49.0 scoped 消费面扩展（取代上段旧“仅 participation 点动作生效”范围口径）**:`AuthzService` 当前消费者已扩为：①考勤终审与 participation 三模块全部点动作；②members 列表/options/detail/全部写；③certificates、member-profiles、emergency-contacts、member-insurances 嵌套资源；④registrations/attendance-sheets 两条扁平跨轴列表；⑤队员报名履历、考勤记录、贡献汇总三条 member-axis 入口。列表按可见组织集下推，member/certificate 归属只认 active PRIMARY membership，participation 按 `activity.organizationId`。**仍未接线**:users/content/notifications/audit-logs、Recruitment、team-join 与 App API；这些面继续既有 GLOBAL/显式授权语义。角色绑定页的 scoped 提示改为「已对队员轴与参与域生效；具体读写仍取决于 action 码与资源范围」，不再显示“扁平列表 GLOBAL-only”。

> **v0.49.0 内置只读角色**:`org-readonly`(10 码，副队长/副部长)与 `group-readonly`(11 码，副组长)加入受保护角色清单，内置角色总数 **7→9**；两者删除按钮与原 7 个内置角色一样对所有身份禁用，后端返 `30104`。角色码集由对应正职角色动态投影，不手工复制；只读码恒零写、零 `*.read.sensitive`。

> ⚠️ **2026-07-13 后台权限配置适配(第一档安全收口;v0.49.0 角色数 true-up)**:后台应把特权角色统一理解为 `ops-admin` 或含任一控制面权限码的角色;控制面码 = `rbac.*` / `role-binding.*` / `user.update.role` / `storage-setting.reset.credentials` / `sms-setting.reset.credentials` / `wechat-setting.reset.credentials` / `realname-setting.reset.credentials` / `member.delete.record`。① 非 SUPER_ADMIN 在角色绑定 create、预检、批量建、重新 ACTIVE、任期向前/向后扩张,以及旧 `system/v1/users/:userId/roles` 的 assign/revoke 都可能被 `30102` 拒;预检保持 HTTP 200,以 `valid=false` + `conflicts[].bizCode=30102` 呈现。② 角色权限编辑器对非 SUPER_ADMIN 不应提供/提交任何控制面码;后端整批拒 `30103`,业务权限码仍可正常配置。③ `ops-admin` / `member` / `biz-admin` / `org-admin` / `org-readonly` / `group-manager` / `group-readonly` / `org-supervisor` / `attendance-final-reviewer` 九个内置角色的删除按钮应对所有身份禁用(含 SUPER_ADMIN),后端返 `30104`;自定义角色删除不变。④ `UpdateRoleBindingDto.endedAt` 当前只接受字符串,**不新增 null 清空契约**;本轮前端无需改变请求 schema。

> ⚠️ **2026-07-13 任期/末位保护补充(第二档安全收口)**:legacy `RbacService` 仍只读 USER+GLOBAL,但现在仅当前在期绑定(`startedAt<=now` 且 `endedAt` 为空或 `>=now`)产权限与角色摘要,与 `AuthzService` 任期判定一致;前端不需要改 schema,但未来/过期绑定应展示为不生效。用户管理页禁用或软删最后一个 active GLOBAL ops-admin 持有人会返 `30101`,应提示先保留/建立另一名 ops-admin 持有人再操作。

**权限解释(authz/explain)= 判权大脑对外的可解释性出口**：入参 `{userId, action, resourceRef?}`；`userId` 是被解释的目标用户，不存在/已软删 → `10001`。`action` 只校验权限码格式，不要求码真实存在；不存在的码会以 `200 + reason=no_permission` 返回。`resourceRef.type` 当前 13 类：`organization` / `activity` / `activity_publish_review` / `attendance_sheet` / `attendance_record` / `activity_registration` / `member` / `member_profile` / `certificate` / `team_join_application` / `recruitment_application` / `notification` / `attachment`，非法类型走通用 `400`。合法入参的 deny 是 200 数据，资源不存在/已软删返回 `reason=resource_not_found`。`decision.reason` 保持 11 值稳定枚举；`matchedGrant.source` 为 `super_admin` / `role_binding` / `position` / `supervision`。调用者缺 `authz.explain.decision` → `30100`；DISABLED 目标仍可诊断；无 audit。

**F3「C 组」增强面(2026-07-04;路线图 [`admin-api-fe-integration-roadmap.md §4 C1–C3`](../archive/reviews/admin-api-fe-integration-roadmap.md),D8/D9 拍板)**:① **role-bindings 分页总表** `GET /role-bindings/page` —— 旧 `GET /role-bindings`(bare 数组)**逐字不动**,分页版是兄弟路由(D9,防 breaking);过滤 = 既有 5 项 + `scopeOrgId` / `roleCode`(精确)/ `principalQ`(主体模糊:USER 命中 username+nickname,MEMBER 命中 memberNo+displayName,POSITION_ASSIGNMENT 命中其背后队员)/ `q`(note+角色 code/显示名)/ `includeExpired`(**默认 false = 仅「当前生效」**:status=ACTIVE 且未过任期;要查 ENDED/SUSPENDED 直接传 `status`,显式 status 优先于默认收窄)+ `expand=role,principal`(D6 约定:缺省不展开、形状与旧端点一致;`role` 附 `{id,code,displayName}`,`principal` 按类型附 username/memberNo/displayName 等,SYSTEM 主体恒省略)。② **detail** `GET /role-bindings/:id`(不存在 → `34001`)。③ **预检** `GET /role-bindings/preview` —— 入参与 create 同参(query 形态),**与 create 走同一批校验器,零写入**;出 `{valid, conflicts[], resolvedScope}`,conflicts 逐项 `{bizCode, message}`(34002 重复 / 34003 形状 / 34004 主体 / 34005 任期 / 10001 用户不存在 …可多项累积);**deny 是数据**,前端在「新建绑定」表单提交前调它做实时校验提示。④ **批量建** `POST /role-bindings/batch` —— `{items:[{...create}]}` ≤200,逐条独立(单条失败不影响其它条),出逐条 `{index, outcome: ok|blocked|already-exists, bindingId?, bizCode?, message?}` + `summary`;`already-exists` = 同维度 ACTIVE 绑定已在(幂等 skip,**重跑同一批不报错**,镜像公告导入);每条成功走单条 create 全套校验+审计。⑤ **explain-batch** `POST /authz/explain-batch` —— 单条 explain 的批量壳 `{items:[{userId,action,resourceRef?}]}` ≤200,出逐条 `{...入参回显, decision}`;**reason 同一套 11 值枚举**(见上段,不因批量扩值);⚠️ 与单条不同的输入错误语义:**任一 `userId` 不存在/已软删 → 整请求 `10001`**(先批量校验用户再逐条判),前端批量诊断页要先保证 userId 集合有效。⑥ **action-state/batch** `POST /authz/action-state/batch` —— **判定对象 = 调用者本人**(入参无 userId;「这一组按钮对当前登录管理员该不该亮」),`{items:[{action,resourceType,resourceId,key?}]}` ≤200,出逐条 `{action, resourceType, resourceId, key?, allowed, reason}`〔F 批小修 2026-07-05:回显新增 `resourceType`(入参原样回显,additive);**items 顺序 = 请求 items 顺序**,可按下标一一对应回填按钮状态,不必再靠 `action`+`resourceId` 反查〕〔三处收尾 2026-07-05:回显新增可选 `key`(≤64 字符,调用方自定义关联键)—— **仅当该 item 的请求携带 `key` 时才出现在响应里**,不参与判定/去重/入库,供前端跨区域合并请求或缓存合并场景做第二自然键〕;`allowed = authz 判权 ∧ 资源状态机只读校验`,`reason` ∈ 11 值 ∪ **`state_forbidden`**(判权过了但资源当前状态不允许 —— 如「考勤单不在待终审态不能终审」「活动已取消不能再取消」「报名已过审不能再批」;注册面 = 考勤单 6 动作 + 活动 update/publish/cancel + 报名 approve/reject/cancel,未注册 action 只判权不判状态);前端据此**一次请求点亮/置灰一批操作按钮**,不必逐个试错;`state_forbidden` 文案建议「当前状态不允许此操作」而非「无权限」。两新码 `authz.{explain-batch,action-state}.decision` 绑 ops-admin,role-bindings 四新端点 0 新码(读三路复用 `read.record`、batch 复用 `create.record`)。

**F4「D 组」memberships 增强面(2026-07-04;路线图 [`admin-api-fe-integration-roadmap.md §4 D 组`](../archive/reviews/admin-api-fe-integration-roadmap.md))**:① **分页总表** `GET /memberships` —— 跨队员跨组织横扫(队员轴 `members/:id/memberships` 仍在,是单人视角;本总表是管理页主列表),过滤 `memberId`/`organizationId`(+`includeDescendants` 子树)/`membershipType`/`status`(**缺省含 ENDED 历史**,要仅在任传 `status=ACTIVE`)/`q`(命中队员 memberNo+displayName + 组织 name+code)+ `expand=member,organization`(D6:缺省不展开、形状与队员轴一致;`member` 附 `{id,memberNo,displayName,gradeCode}`,`organization` 附 `{id,name,code,nodeTypeCode}`)。② **detail** `GET /memberships/:id`(不存在 → `17003`)。③ **冲突诊断** `GET /memberships/conflicts` —— 只读数据体检(4 类闭集:`multiple_active_primary` 多主〔正常被唯一约束拦,legacy 兜底〕/ `dangling_member` 悬空队员 / `dangling_organization` 悬空组织 / `inactive_organization` 停用组织上的在任归属;可按 `organizationId`+`includeDescendants` 收窄),建议做成组织管理页的「数据体检」辅助入口。④ **归属迁移** `POST /memberships/transfer` —— **F4 唯一写端点**:`{memberId, fromOrganizationId, toOrganizationId, membershipType, reason?}` 单事务「结束源组织对应类型 ACTIVE 归属 + 在目标组织建同类型新归属」,返回新归属行;边界:源=目标 → `400`、队员不存在/停用 → `15001`/`17030`、目标组织不存在/停用 → `11001`/`17031`、源侧无对应类型在任归属 → `17003`、目标已有同维度在任归属 → `17004`(**整事务回滚,源行不受影响**);**源组织刻意不校验存在/停用** —— 迁出已软删/停用组织正是 conflicts 诊断后的治理动作;audit 一条 `membership.transfer`(不再拆 set/end 两条)。新码 `membership.transfer.record` 绑 **biz-admin**(业务写;其余读码沿 ops-admin 管理面)。⑤ **组织轴** `GET /organizations/:orgId/memberships`(分页;`includeDescendants`/`membershipType`/`status`/`q`/`expand=member,organization`〔F 批小修 2026-07-05:参数集对齐扁平总表 `GET /memberships`,同一份查询构造〕;**缺省仍含 ENDED/SUSPENDED 历史**(additive 红线,行为不变),组织成员页请显式传 `status=ACTIVE` 只看在任;组织不存在 → `11001`)+ `GET /organizations/:orgId/members/options`(该组织±后代的可选队员下拉,与 F1 `members/options?organizationId=` 同一份投影,建任职/分管表单选人用)。⑥ **树 + 计数** `GET /organizations/tree-with-summary` —— 组织树每节点附 `directMembershipCount`(直属 ACTIVE 归属条数)/`subtreeMembershipCount`(含全部后代);⚠️ 是**归属条数不是去重人数**(一人多归属计多条),做「组织人数」看板时请注明口径或按 PRIMARY 过滤后再数。

**F5「E 组」任职/分管增强面(2026-07-04;路线图 [`admin-api-fe-integration-roadmap.md §4 E1/E2`](../archive/reviews/admin-api-fe-integration-roadmap.md);F1–F5 至此全量落地)**:① **任职总表** `GET /position-assignments` —— 跨组织跨队员横扫(组织轴 `organizations/:orgId/position-assignments` 仍在,是单组织在任视角;本总表**缺省含 REVOKED 历史**,`status=ACTIVE` 收窄),过滤 `organizationId`(+`includeDescendants` 子树)/`memberId`/`positionId`/`status`/`q`(命中队员 memberNo+displayName + 职务 code+name + 组织 name+code)+ `expand=member,position,organization`(D6 缺省不展开;`position` 附 `{id,code,name,categoryCode}`)。② **detail** `GET /position-assignments/:id`(不存在 → `32020`)。③ **任命预检** `POST /position-assignments/preview` —— 入参 = 组织轴 create 同参 + `organizationId`;**violations 逐项收集**(任期 `32026` / 存在性 `11001`/`32001`/`15001` / 职务适配 `32022` / 归属要求 `32025` / 兼任 `32024` / 防重 `32021` / 单人独占 `32023`),一次请求把表单全部问题返齐(区别于真实任命的 first-failure 抛错);**零写入**;前端在「任命」表单提交前调它做实时校验提示;返回 200,`valid=false` 是数据不是错误。④ **分管总表** `GET /supervision-assignments/page` —— 旧 `GET /supervision-assignments`(bare 数组,**仅 ACTIVE**)逐字不动(D9 防 breaking 同型);总表**缺省含 REVOKED 历史**,过滤 `supervisorMemberId`/`organizationId`(+`includeDescendants`)/`scopeMode`/`status`/`q` + `expand=supervisor,organization`。⑤ **detail** `GET /supervision-assignments/:id`(不存在 → `33001`)。⑥ **覆盖预演** `POST /supervision-assignments/coverage-preview` —— `{organizationId, scopeMode?}`(缺省 TREE,与 create 默认一致)→ `{expandedOrganizationIds}`:建分管前给运营看清「这条分管会覆盖哪些组织」(EXACT=仅该节点;TREE=该组织+全部后代);展示读 closure 非判权,零写入。**六端点全部复用既有 read 码,0 新码**(goal 拍板:两 preview 均不设新码;dry-run 只读,可见面 = 持 read 码本可列到的数据,无越面泄露)。

**公告导入(announcement-import)= preview/execute 两段式一次性落库工具(PR11)**:批量把《任命公告》类结构化数据(组节点 + 任职 + 分管)导入系统,**面向"上线初始化 / 批量换届"场景,不是日常管理页**——正常运营下建组织/任职/分管请用本节上方各自的常规端点逐条操作;**前端可以不为它单独做页面**,运营/维护者直接用 API 客户端(curl/Postman)调用即可,若要做也应做成一次性工具页而非常规菜单(不建议加进 §5.2 导航树)。两路由复用同一请求形状 `{organizations?, positions?, supervisions?}`(结构化行数组,后端**不做**自然语言解析,公告文本→行由运营/AI 线下产出);`preview` **零写入**逐行诊断,`execute` 幂等落库(单行失败不影响其它行,可重跑)。响应逐行 `status` ∈ 四态:`ok`(可创建)/ `blocked`(缺字段或校验不过,`reasons[]` 说明,`bizCode` 可能为 `null`〔合成诊断〕)/ `already-exists`(命中已有记录,execute 语境下视为幂等 skip)/ `needs-manual`(仅 `displayName` 唯一命中 active 队员时的建议,回显 `suggestedMemberNo`,**仍需人工确认,从不自动升级为 `ok`**)。**双锚铁律(R7,execute 强制)**:人按 `memberNo`、组织按 `code`,**绝不按姓名自动落库**——`positions[]`/`supervisions[]` 行在 `execute` 下缺 `memberNo`(即便 `displayName` 唯一命中)直接 `blocked`。组织行 `nodeType` 恒为 `group`(只建组级节点,建队/部/总队级不支持);组织 `code` 全局唯一,且同请求内可被 `positions[]`/`supervisions[]` 的 `orgCode` 引用(父组织行必须先于引用它的子行声明)。**本工具只做锚定解析 + 编排**——任命 5 项校验(职务适配/单人独占/兼任/归属要求/任期)、分管防重/任期校验、组织闭包维护、audit 写入,全部只存在于被复用的 `OrganizationsService`/`PositionAssignmentsService`/`SupervisionAssignmentsService` 内部,与本节上方各自端点走**同一份**校验代码(不存在"预览说 ok、执行却因校验分支不同而失败"的两套逻辑漂移)。**BD-2 终审绑定不含在导入范围内**——导入只落 `PositionAssignment`(+ 必要 `Membership`),运营需在导入完成后另行调 `POST admin/v1/role-bindings` 手工挂 `attendance-final-reviewer`(参数样例见 [`RBAC_MAP.md` §5](../ai-harness/RBAC_MAP.md));完整上线执行顺序见 [`ops/scoped-authz-go-live-checklist.md`](../ops/scoped-authz-go-live-checklist.md)。**R13**:本节及任何前端对接文档示例一律用假数据(如 `T0001`/`张三`),真实姓名/编号绝不进文档。

> ⚠️ **scoped-authz 落地进度(2026-07-03 摘码微刀 #482 收官,序列 PR1–PR12 + 摘码微刀已全发 main,**GAP-007 完结,整条终态序列就此闭幕**;前端照当前状态造 UI 即可,不会再有下一刀改变本节口径)**:
> - **判权现状一句话**:统一判权大脑 `AuthzService` **已上线**(PR8);**scoped-live 业务面 = 考勤终审**(`final-approve`/`final-reject`,PR9)+ **participation 三模块点动作**(`activities`/`activity-registrations`/`attendances`,PR12,24 处判权位点)。点动作(改/删/发布/取消单个活动;审批/驳回/管理员取消单条报名;单据 read/update/delete/approve/reject)带具体资源 ref,嵌套列表(路径带 `:activityId`)带父活动 ref;**扁平跨轴列表(如 `admin/v1/attendance-sheets`/`admin/v1/registrations`,见 §2.3)与新建活动(`activity.create`)仍 GLOBAL-only**(不带 ref,纯 scoped 持有者访问仍 `30100`;把 tree scope 变成列表查询条件的 QueryService 读下推是序列外后续 goal)。**除以上两批外的其余所有业务面**(证书核验、队员管理、招新/入队、内容发布、统一通知……)**仍只认 GLOBAL 角色绑定**,scoped 绑定对它们**零影响**(逐面迁移诉求触发再出 goal,不再挂 GAP-007)。
> - **🔴 关键语义(必读,替换旧版"仅考勤终审"的表述)**:**任职(position-assignments,PR4)+ 一条显式指向该任职的角色绑定(role-bindings 绑 `attendance-final-reviewer`,PR6)两步都做,才会对考勤终审真实生效**(见 §2.1);只做任职不建绑定 = 不生效。**PR12 起新增一条不同形态的生效路径,且不需要额外显式绑定**:队长/部长(经"职务→角色 policy",PR7,自动推导为 `org-admin`@本组织树)、组长(推导为 `group-manager`@本组)、分管人(推导为 `org-supervisor`@分管范围)现在对 participation 三模块的点动作**在其组织树/分管范围内真实生效**——例如 team-leader/dept-leader 经 `org-admin`@TREE 可在本树内管理活动(update/publish/cancel)+ 审批本树报名 + 为本树活动建考勤单/一级审核,树外仍 `30100`;group-leader 经 `group-manager`@TREE 可在本组一级审核考勤;`org-supervisor` 经分管推导可读分管树内单据,树外 `out_of_supervised_scope`。**`org-admin`/`group-manager`/`org-supervisor` 三角色均不含终审两码**——即使已有任职或分管记录,**不会**因此自动获得终审权,终审仍必须走上一条路径单独显式绑定。**🔴 摘码微刀(#482,2026-07-03)后的关键变化**:持 `biz-admin` 的 ADMIN **不再天然拥有**终审权(不建任何绑定直调终审端点 → `30100`,见 §2.1);`biz-admin` 的其余业务码(含 participation 全部点动作对应的 GLOBAL 码)不受影响。前端在这些管理面的文案/交互上按此精确化——role-bindings 页具体文案见上一段。
> - **角色与权限页现在会看到 7 个内置角色**:原有 3 个(`biz-admin`/`ops-admin`/`member`)+ 4 个新增(`org-admin` 56 码 / `group-manager` 22 码 / `org-supervisor` 4 码 / `attendance-final-reviewer` 3 码)。**这 4 个新角色 seed 阶段零持有、是 scoped 判权的载体**,设计上经"职务→角色 policy"(PR7,自动推导)或显式 RoleBinding(如给某个 POSITION_ASSIGNMENT 绑 `attendance-final-reviewer`)生效——**不建议在"角色与权限"页把它们当普通全局角色直接手工绑给某个 user**(技术上绑了也不会报错,但绑了只有 GLOBAL 语义,绕开了整套职务/分管推导设计,业务含义会跟运营预期不符)。
> - **排查工具**:不确定某人某权限到底生不生效 → 用「权限解释」端点(`authz/explain`,PR10,见上段)一键查,不用猜。
> - **GAP-007 序列已全部落地(PR1–PR12 + 摘码微刀 #482),详见 §4 [GAP-007](#4-缺口台账-gap-ledger)**——序列内不再有"未落地"项;members/certificates/content/notifications 等其余业务面迁移、QueryService 扁平列表 scoped 过滤、16 个 `attachment.*.self` 收敛为 SELF scope、监督角色可配化、存量队员批量导入工具均已归入**序列外**候选清单,诉求触发再单独出 goal(不再挂本 GAP)。

### 2.7 搜索 & 选择器(F1「A 组」;admin-api-fe-integration-roadmap.md §4 A1–A7)— ✅ 已发 main

前端每个列表页的模糊搜索框、每个表单里的下拉选择器、跨资源展示回填,统一走本节这批端点。全部 additive(旧字段/响应形状零变),**除 `meta.resolve.label` 外零新增权限码**(options 复用对应资源既有读码)。

| 资源 | list 增强(query,均可省略) | 新增 `/options`(或同类)端点 | 鉴权 |
|---|---|---|---|
| **members** | `q`(模糊 displayName+memberNo)/ `organizationId` / `includeDescendants` | `GET admin/v1/members/options` → `{items:[{id,label,memberNo,gradeCode}]}` | `[rbac: member.read.record]` |
| **users** | `q`(模糊 username+nickname+email+phone)/ `role` / `status` / `memberId` | `GET admin/v1/users/options` → `{items:[{id,label,username}]}`(label=nickname‖username) | `[rbac: user.read.account]` |
| **organizations** | `q`(模糊 name+code)/ `nameContains` / `codeContains` | `GET admin/v1/organizations/options` → `{items:[{id,label,code,nodeTypeCode,parentId}]}` · `GET admin/v1/organizations/tree-options` → 树形 `[{id,label,code,children[]}]`(表单级联选择器用,`label`/`code` 精简版 `/tree`) | `[rbac: org.read.node]` |
| **roles**(⚠️ 落 `system/v1`,唯一跨 surface 例外,D4 拍板) | — | `GET system/v1/roles/options` → `{items:[{id,label,code}]}`(label=displayName;`q` 模糊 code+displayName) | `[rbac: rbac.role.read]` |
| **positions** | — | `GET admin/v1/positions/options` → `{items:[{id,label,categoryCode}]}`(`categoryCode?`/`status?`/`q?`) | `[rbac: position.read.definition]` |
| **activities** | `q`(模糊 title)/ `dateFrom`+`dateTo`(按 startAt 区间)/ `includeDescendants` / `includeStats`(附 `registrationCount`+`attendanceSheetCount`,批量聚合无 N+1) | `GET admin/v1/activities/options` → `{items:[{id,label,startAt,statusCode}]}` | **`[auth]` 仅登录**(镜像 list/detail 现状;§4 已决 won't-do 新增 `activity.read.*` 码;USER 角色同样强制只见 published/completed) |

`GET admin/v1/meta/resolve-labels` 见下方独立说明。

**options 全部不分页**:响应固定 `{items:[...]}`(无 `total`/`page`/`pageSize`),`limit?` 截断(默认 20,上限 100;`tree-options` 无 `limit`,整树返回)。**GET query 布尔值传字符串** `'true'`/`'false'`(HTTP query string 本就无原生 boolean 类型,后端已做 `'true'`/`'false'` 字面量转换,传其它值会因 `@IsBoolean()` 校验落空为 `undefined` 而非报错——但仍建议前端只传这两个字面量字符串)。

**`includeDescendants`**:配合 `organizationId` 使用,展开该组织 + 全部后代组织再过滤(经组织闭包表)。它本身仍只是用户筛选参数，不授予任何权限；v0.49.0 起 members/options 与 registrations/attendance-sheets 等已接线列表会把该展开结果与 Authz 可见组织集求交，最终结果只会更窄、不会越权。未接线模块继续按各自既有权限语义，不能从这个 query 参数推断授权。

**批量 id→label 解析(meta/resolve-labels,net-new)**:`POST admin/v1/meta/resolve-labels`,入 `{refs:[{type,id}]}`(`type` ∈ `member`/`user`/`organization`/`role`/`position`/`activity` 闭集,`refs` ≤200 条,超限 `400`;单请求可混合多 type)。出 `{[type]:{[id]:{label,...极少字段}}}`——**顶层 key 按实际命中的 type 动态出现**,未命中/无权的 type 整体不出现(不是空对象)。典型用途:审计日志的 `actorUserId`、角色绑定的 `principalId`、各种跨资源外键 id,批量换成人类可读文案,不用逐条单查。**两层权限**(务必分清,前端遇到"有的类型解析出来有的没有"不是 bug):① 入口码 `meta.resolve.label`(绑 ops-admin,门控"能否用这个工具");② per-type 各资源既有读码(门控"能读到哪些 type"——例如纯 ops-admin 身份没有 `member.read.record`,同一请求里 `member` 类型会被静默拿掉,`organization`/`role`/`position`/`user`/`activity` 仍正常返)。**id 不存在 / 已软删 / 无权** 三种情况处理一致:该 id 不出现在结果里,**不报错、不占位**(防枚举;前端拿到的"缺失" id 一律当"这条不可用",不要区分成因)。`activity` 类型额外套用 Q-A7 规则:USER 角色只能解析到 published/completed 的活动。

**工作台/首页待办汇总(meta/dashboard-summary,GAP-003 + 活动责任闭环 PR-9)**:`GET admin/v1/meta/dashboard-summary`,零 query 参数。出四个**可省略**块:`registrations:{pending,waitlisted}` / `attendanceSheets:{pending,pendingFirstReview?,pendingFinalReview}` / `activityPublishReviews:{pending}` / `activities:{published,pendingCompletion}`；`waitlisted` 是未软删候补数，`pendingCompletion` = published 且 `endAt < now`。`attendanceSheets` 兼容字段仍凭 `attendance.read.sheet`；`pendingFirstReview` 只在持 `attendance.approve.sheet` 时出现并按该 action 的组织范围统计；发布审核块只在持 `activity-review.read.request` 时出现。块/可选字段无权时缺失，不是 0；有权限但合法 scope 为空时返回 0。

**参与月度 overview（审计刀 5）**:`GET admin/v1/meta/participation-overview`，按 `Activity.startAt` 的 UTC 月输出组织范围内活动数、报名/到场/no-show、approved 时长与固定四桶。入口同时要求 `attendance.read.sheet` + `activity-registration.read.record`；两项权限各自的可见组织集先求交，再与显式 `organizationId`/`includeDescendants` 筛选求交。有码但合法 scope 为空返回 `months:[]`，不是越权扩成全量；每月数值与同范围逐活动 `participation-summary` 求和一致。

**v0.49.0 前端有效权限出口**:`GET system/v1/authz/me/effective-permissions` 是后台登录后的 permission code 真值出口，聚合 direct RoleBinding、职务策略(含副职只读投影)与分管三源的当前有效码。响应只含稳定排序的 `permissions:string[]`，不暴露 role/binding/scope 明细；SUPER_ADMIN 返回 Permission 全集。既有 `GET system/v1/rbac/me/permissions` **保留且语义零变化**，仍只聚合当前用户主体的 GLOBAL RoleBinding，因此 derived-only 的正/副职或分管用户在旧端点可为空、在新端点非空。后台菜单和按钮从 v0.49.0 起应读新出口；App 的 `/me/capabilities` 不受影响。

**FE 适配最小规则**:登录后固定三调 `login → admin/v1/me → authz/me/effective-permissions`；菜单树仍由前端静态维护，仅以新出口 `permissions[]` 过滤，不新增后端菜单接口。`vice-captain`/`dept-deputy` 映射 `org-readonly`，`deputy-group-leader` 映射 `group-readonly`；两只读角色只含 `*.read.*`/`attachment.view.*` 且排除 `*.read.sensitive`。前端不能仅凭有读码点亮写按钮，写按钮仍按对应 create/update/delete/approve 等真实 action 码过滤；最终是否允许由后端 resource ref + scope 判定。

---

## 3. 踩坑表(gotchas)

1. **登录是 3-call(v0.49.0)**:`POST /api/auth/v1/login` → `GET /api/admin/v1/me`(身份) + `GET /api/system/v1/authz/me/effective-permissions`(含职务/分管派生的有效权限码)。三个端点拆开,别假设 login 返回身份/权限；旧 `rbac/me/permissions` 只认 USER+GLOBAL 绑定，保留兼容但不能用来点亮 derived-only 用户的后台菜单。
2. **字段以 live `/api/docs-json` 为准**。任何手写指南(含本文件)的字段名都可能漂;类型从 docs-json 取。
3. **权限码不要臆造**:用真实码(如 `member.read.record` / `attendance.final-approve.sheet`),来源 = 各端点 `[rbac: x]` summary 或 [`RBAC_MAP.md`](../ai-harness/RBAC_MAP.md);禁 `*:*:*` / `permission:btn:*`。
4. **贡献值别在前端裸 SUM**:存在**全局每日封顶 3**(一人单北京日封顶;v0.48.0 起历史记录同样按 3 读时实时重算)。前端把 `attendance_records.contributionPoints` 直接相加会**算多**。要总分用后端给的 capped 值(见 GAP-002 的 contribution-summary),贡献值总分一律走后端,不在前端算。
5. **菜单是前端静态 + `permissions[]` 过滤**,后端没有菜单树端点(`asyncRoutes` / `getMenuList` 是 P0 禁区,别开)。
6. **App ≠ Admin**:`/api/app/v1/*` 是小程序面(本人视角,见 [`miniapp.md`](miniapp.md)),admin 后台不要调它。**唯一例外 = 账号级自助端点**:`PUT app/v1/me/password`(改密)/ `app/v1/me/phone*`(换绑手机)是有意的"账号级豁免"(`D-P2-3-1` 锁定,无 canUseApp 闸、`admin without member 允许使用`)——admin 个人中心改密 / 换手机直接调它们,**不必造 `admin/v1` 镜像**。
7. **signed URL / 敏感字段**有可见级与时效;附件走 `upload-url` / `confirm-upload` 通用链路,别假设直链。SVG/HTML/XHTML 恒拒;confirm 与保留兼容的 legacy `POST /api/admin/v1/attachments` create 都会读取对象并核对实际大小、jpg/png/webp/gif/pdf 前缀魔数,声明 MIME 与内容不符返 13016,前端须保留失败提示与重选文件入口。`expireAt <= now` 的附件不再返回 `accessUrl`(公开内容附件会直接移除过期行、过期封面 URL 为 null);未来时间/null 仍按原行为签发。
8. **考勤审核严格责任矩阵(2026-07-23 活动责任闭环 PR3)**:`approve`/`reject` 对最初提交人或最近重提人返回 `22081`;`final-approve`/`final-reject` 对提交/重提人返回 `22074`,对一级审核人同人返回 `22075`,`SUPER_ADMIN` 也不豁免。`ATTENDANCE_ALLOW_SAME_REVIEWER` 已废弃且不会放开。**判定顺序**:约束否决只发生在确实持有对应审核权之后；无码者仍先返回 `30100`。按钮需分别处理 22081/22074/22075/30100，排查终审权用 `authz/explain`。详见 §2.1 / §2.6。
9. **组织成员页调 `organizations/:orgId/memberships` 必须显式传 `status=ACTIVE`**:该端点(F4)缺省 **三态混返**(`ACTIVE`/`ENDED`/`SUSPENDED` 全部历史归属都在,不是只返在任成员)——不传 `status` 会把已离队(`ENDED`)/暂停(`SUSPENDED`)的历史归属当成在编人员显示在"组织成员"页上。扁平总表 `GET /memberships` 同一红线(缺省同样含历史)。这是 additive 红线刻意保留的默认行为(F 批 #511 拍板不翻默认值,非缺陷),**"组织成员"这个具体页面必须显式传 `status=ACTIVE` 过滤**;只有"归属变更记录/数据体检"这类明确要看历史或全量的场景才用缺省。详见 §2.6。
10. **刀D 掩码收紧(2026-07-11,⚠️ 回写陷阱二连)**:`member-profile` 无 `member-profile.read.sensitive` 时,`birthDate/landline/email/qq/wechat/heightCm/weightKg/bloodTypeCode/eyesight/medicalNotes` 一律返 **null**(不再明文;`documentNumber/mobile` 维持掩码串;`birthDate`/`email` 类型已放宽 nullable);`members/:memberId/emergency-contacts` 四出口对无 `emergency-contact.read.sensitive`(新码,绑 biz-admin;org-admin / group-manager 默认无)者掩码 姓名/两电话/住址。**编辑表单必须沿 v0.39.0 member-profile 首例范式**:hasPerms 镜像 sensitive 码,无权字段(值为 null 或含 `*`)提交前 delete,靠「不发=保留」——否则保存即用 null/掩码覆盖真值。连带小变更:开第二个 open 轮 40000→`28032`(招新)/`28231`(入队);入队标 gate 完成日填未来→`28243`(允许"今天");`MemberProfile` 新增 `detailedAddress`/`profileExtra`(MP-34/35,promote 搬入)**本刀无读出口**,docs-json 里找不到不是丢了。
11. **四类通道设置提交后无需刷新后端缓存**:`sms-settings` / `wechat-settings` / `storage-settings` / `realname-settings` 的 PATCH/reset 写事务提交后，任一实例下一次 settings 读取直接获得 PostgreSQL 新值，无需 restart/reload/invalidate 或等待 60s；单次发送/OCR/存储 Effect 只使用其已解析的 provider 参数快照。Storage 的 `enabled=false` 会从下一次调用起拒绝普通业务 put/delete/sign/head/read（含历史 pinned locator 与自动 worker），已开始的 Effect 不被中断；只有经过人工复核的 manual maintenance 证据采集可继续读取历史对象。production 下 provider/bucket/region 不应在 UI 暴露为任意值：后端会强制 COS + 非空 bucket/region + 可解密凭证。

### 3.1 登录与令牌接线(全端通用;2026-07-17 自 srvf-admin-web 对接 guide 归一)

> 权威细则 = [`reference/auth-jwt-refresh.md`](../reference/auth-jwt-refresh.md)(P0-E 冻结,动它先过决策锁);本节只保留前端必须知道的行为语义。小程序/H5 令牌语义与此完全一致(见 [`miniapp.md §1.1`](miniapp.md));纯前端侧改哪些文件(`src/api/user.ts` 等)留在姊妹仓文档,不在本层。

1. **信封与失败语义**:成功 `{code:0,message:'ok',data}`;业务失败 = **HTTP 4xx** + `{code,message}`(无 data)——axios 会 reject,业务体在 `err.response.data.{code,message}`,不是 resolved 的 `{code:!0}`。拦截器的「401 自动刷新」**必须排除** `auth/v1/login` 与 `auth/v1/refresh` 自身(这两处的 401 是凭证失败,去刷新会死循环)。
2. **错误码 → 前端行为**:`10004`(401,登录失败;不存在/密码错/禁用/软删四场景防枚举同响应)→ 提示 message、**不**触发刷新;`40100`(401,未登录/access 失效)→ 触发 refresh → 重放,refresh 也失败才登出;`10007`(401,refresh 无效;4 子原因刻意不细分)→ 清 token 跳登录;`30100`(403,判权失败)→ 403 页;`42900`(429 限流,**无** `Retry-After` / `X-RateLimit-*` 头)→ 提示稍后再试。
3. **令牌双计时器**:`expiresIn` 是 JWT 配置时长字符串(如 `"15m"`)**不是时间戳** → 前端自算 `expires = now + parse(expiresIn)`,建议提前 30–60s 主动刷;`refreshExpiresAt` 是 refresh **family 的 ISO 绝对死期**(rotation 不延期)→ 到点 refresh 必返 `10007`,强制重登(不是再刷)。rotation always:每次 refresh 返回全新 access+refresh 对,旧 refresh 立即失效,重放命中触发 family 整族撤销。
4. **token 形态**:`accessToken` 是裸 JWT(响应不带前缀,前端自拼 `Bearer <token>`);`refreshToken` 是不透明随机串(**非 JWT,勿解析**);`LoginResponseDto` 恰 5 字段冻结(P0-E,禁再增)。
5. **logout 两层语义**:`POST /api/auth/v1/logout` 的 refresh token **只用于定位 family**；后端撤销该 family 全部 active 未过期 token，其他登录 family 不动，成功恒 `{code:0,message:'ok',data:null}`，旧 access 仍自然过期。`logout-all` 才撤销当前用户全部 family，并返回 `{revokedCount}`；两者勿共用响应 DTO。
6. **权限出口**:登录后 3-call(踩坑 #1);`permissions[]` 是真实点格式码,SUPER_ADMIN 返**实体化全集**(不是 `["*"]` 也不是空数组);前端 `hasPerms` 纯字符串 includes 直接喂真实码。
7. **联调测试账号**:seed 建默认 SUPER_ADMIN(env `SUPER_ADMIN_USERNAME/PASSWORD`;非 production 缺省 `admin` / `ChangeMe123456`,production 禁用默认必须显式设 env;见 [`development.md`](../development.md))。

---

## 4. 缺口台账(gap-ledger)

> 前端→后端的需求簿。状态:`提出` → `已出 goal` → `已发`。

| # | 诉求(前端想做的任务) | 期望端点 | 状态 |
|---|---|---|---|
| **GAP-001** | 审批工作台:跨所有活动按 status 横扫报名/考勤 | `GET /api/admin/v1/registrations?statusCode=` · `GET /api/admin/v1/attendance-sheets?statusCode=` | ✅ **已发 v0.30.0**(2026-06-23;[PR #432](https://github.com/BA7IEE/srvf-nest-api/pull/432) → bump #433 → tag `v0.30.0` / Release Latest)。注:过滤参数实装为 `statusCode`(非草拟期 `status`) |
| **GAP-002** | 队员 360:某队员的报名履历 / 考勤记录 / 贡献值生涯累计 | `GET .../members/:id/registrations` · `GET .../members/:id/attendance-records` · `GET .../members/:id/contribution-summary`(贡献值=实时算复用 team-join `computeCappedContribution` 封顶核,生涯 cutoff=null + 北京日封顶 3;历史记录读时重算) | ✅ **已发 v0.30.0**(2026-06-23;[PR #432](https://github.com/BA7IEE/srvf-nest-api/pull/432) → bump #433 → tag `v0.30.0` / Release;v0.48.0 调整上限)。注:`attendance-records` 仅返 approved sheet 内 records |
| **GAP-003** | 工作台/首页待办汇总数字(待审报名数 / 进行中活动数 / 招新进度)— 设计期识别,待前端确认是否做仪表盘 | 一个聚合 stats 端点(或前端用各列表 `total`/分页字段拼,无新端点);**招新进度**部分 = `GET /api/admin/v1/recruitment/cycles/{id}/stats` | ✅ **已全量交付关账**(2026-07-05):**招新进度**部分已由招新工作台 stats 端点答复(GAP-006 S2,**已发 v0.31.0**;五组聚合 今日/待处理/门槛进度/综合评定/公示发号)。**待审报名数 / 进行中活动数**由本次新增 `GET /api/admin/v1/meta/dashboard-summary` 答复(扩既有 `MetaController`;零 query 参数;三个可省略块 `registrations.pending`/`attendanceSheets.{pending,pendingFinalReview}`/`activities.published`,块级权限裁剪〔无权限静默省略,不 403〕,详见 §2.7)。**team-join / 证书待核 / 通知等块刻意排除**(前端可用各列表分页 `total` 拼;真诉求再 additive 加块)——**台账至此关闭** |
| **GAP-004** | 管理员自助改密(PC 个人中心「旧→新」)— **调研结论:非缺口**。`app/v1/me/password` 是账号级自助(`D-P2-3-1` 锁定,"admin without member 允许使用"),admin 用自身 JWT 即可改密(复用 `changeMyPassword`:同事务撤销 refresh + `password.change.self` 审计 + 限流) | 无需新端点;admin 个人中心直接调账号级 `app/v1/me/password`(例外见踩坑 #6) | ✅ 已澄清(2026-06-23 用户拍板=文档化,不造 `admin/v1` 镜像) |
| **GAP-005** | 向队员主动推送通知/公告(活动提醒 / 招新公告 / 紧急召集);现 notifications 模块仅"生日短信"后台任务,无 admin 推送面 | **统一多渠道**(站内 / 微信订阅 quota / 短信)+ 派发器(Effect)+ producer 只创建任务;T0 修订冻结评审稿 [`archive/reviews/unified-notification-dispatcher-review.md`](../archive/reviews/unified-notification-dispatcher-review.md)(supersede 原 [`member-notification-review.md`](../archive/reviews/member-notification-review.md) 站内信架构;招新 §9 / GAP-006 S7 触发挂此)| ✅ **已发 v0.32.0**(S1–S5 全切片 #449–#453 → bump #454 → tag `v0.32.0` / Release Latest;2026-06-27;以下逐切片 `本 PR` / Unreleased 为各自交付时态历史标注)。**S1 站内信渠道已交付**(本 PR,Unreleased;T0 修订评审 2026-06-25 已冻结):**admin 8 端点** `admin/v1/notifications`(CRUD + 状态机 publish/unpublish/archive;R 模式 `notification.*` 5 RBAC 码 156→161;见 §2.5)+ **app 4 端点** `app/v1/notifications`(站内信 feed:list/unread-count/detail/mark-read;canUseApp 准入 + 4 档可见性**复用 content.visibility 去 public** + 未读红点;mark-read 幂等;见 [`miniapp.md`](miniapp.md))。状态机/可见性镜像 content 零第二套;统一形状列就位不返工;BizCode 310xx 5 码。**S2 微信订阅 quota 渠道已交付**(本 PR,Unreleased):admin create/update 加 `channels` 勾选(可含 wechat),publish 含 wechat → **事务外**向「该类型已配模板 + 可见 + 有订阅 quota」会员逐人推送(非订阅者不打扰,投递落 `NotificationDelivery`);**+app 2 端点** `app/v1/notifications/subscriptions`(ack 上报授权 quota +1 封顶 / status 查剩余配额,见 [`miniapp.md`](miniapp.md))+ **admin 2 端点** `admin/v1/notification-wechat-templates`(模板配置运营可配,新码 `notification.update.template` 161→162;见 §2.5);微信 subscribe-send 能力 additive 扩 `wechat/`(stable_token 缓存 + 8s + token 失效刷一次重试,L3 token/openid 零明文)。**S3 producer 接入 + 派发器 Effect 正式化已交付**(本 PR,Unreleased):`NotificationDispatcher`(architecture-boundary §3.6 **首个真实 Effect**;`dispatchTargeted` 建已发布定向行 directed/system/authorUserId=null/跳过 draft 直 published → 站内 + 微信复用 S2)由招新 **发号**(`recruitment-promotion`,promote commit 后,站内+微信,payload memberNo + 入队入口)与 **入队**(`team-join-enrollment`,join commit 后,仅站内,payload 部门+正式队员)在业务事务**外** try-catch 直调(**派发失败不破坏 promote/入队行为锁**;防环单向 producer→notifications);`Notification.recipientMemberId` 定向收件人(会员 feed **仅本人可见**,他人 404 防枚举);**0 新端点 / 0 新 RBAC 码(162 不变)/ 0 BizCode**(producer 内调,admin 面无新操作)。**报名前 5 触发不做**(报名受理/转人工/门槛/评定/公示:申请人那时非队员,S1/S2 够不着,维持**查询进度 pull**)。**S4 活动·考勤 producer 定向触发已交付**(本 PR,Unreleased):**报名审批结果**(approve/reject → 报名本人)/ **活动取消**(cancel → 遍历已报名者 pending+pass fan-out)/ **考勤终审结果·贡献值**(finalApprove → sheet 内逐 record 本人)三处 producer 在各自业务事务 **commit 后、事务外、try-catch 永不抛**直调 `dispatchTargeted`(`activity-reminder` 类型,**仅站内** channels=['in-app'],微信 opt-in 延后);**派发失败绝不破坏取消状态机 / 报名审批状态机 / 考勤 finalApprove + 贡献值**行为锁(注入失败 e2e 断言三处业务仍成功);防环单向 producer→notifications;**0 schema / 0 migration / 0 新端点 / 0 新 RBAC 码(162 不变)/ 0 BizCode**(纯 producer 内调,复用 S3 派发器 + 既有 `notification_type` 字典)。**S5 短信兜底渠道已交付**(本 PR,Unreleased;末位切片,含真实计费外发):**admin 1 端点** `POST admin/v1/notifications/{id}/send-sms`(新码 `notification.send.sms` 162→163;见 §2.5)= **紧急召集兜底,admin 显式发起 + 计费确认必需**——`confirmed:false` 预览 `recipientCount`(可见且有手机的可计费受众,零发送),`confirmed:true` 真发(逐人经 `SmsProviderRouter.sendNotification` 单发零变量"请打开 App 查看"短信 + `NotificationDelivery`/`sms_send_logs` 记账,手机号 maskPhone);**短信永不随 publish 自动发**(站内+微信优先,成本动作显式 gating);前置闸须 **published + channels 含 `sms`**(否则 `31013`)、通道未配置 → `24030`、缺 `confirmed` → 400;防滥发继承同号封顶 10/间隔 60s/同日同模板幂等 + FAILED 逐人不阻断;审计复用 `notification.publish` 伞事件 `operation='send-sms'` + 收件人计数(无新 audit 串)。**0 新表**(复用 `NotificationDelivery`/`sms_send_logs`)+ 第 30 migration(`sms_settings.templateIdNotification` 1 列)。**运维须**填真实 `templateIdNotification`(零变量模板须先过审)。**报名前 openid 非会员推送路 / 真·全员短信批处理异步**待后续切片另出 goal。**至此 GAP-005 S1–S5 全切片落地**(招新 S7 通知阻塞解除)|
| **GAP-006** | 招新→入队完整闭环优化(招新工作台 stats / 新人进度模型 / OCR 复核分流 / H5 手机身份链 / promote 志愿者化 / 批量操作 / RBAC 字段分级 等 12 域)— T0 评审已冻结、零代码,按切片另出 goal | 冻结评审稿 [`archive/reviews/recruitment-phase4-loop-optimization-review.md`](../archive/reviews/recruitment-phase4-loop-optimization-review.md)(其 §7 工作台 stats **含 GAP-003「招新进度」部分**;其 §9 通知闭环**挂 GAP-005 落地后**)| ✅ **已发 v0.31.0**(S1–S6 全 7 切片 #439–#445 → bump #446 → tag `v0.31.0` / Release Latest;2026-06-24;以下逐切片 `#NNN` / Unreleased 为各自交付时态历史标注):**S1 状态业务文案 + 新人进度模型**已发(#439,Unreleased)· **S2 招新工作台 stats**已发(#440,Unreleased;`GET …/cycles/{id}/stats` 五组只读聚合,答 GAP-003「招新进度」)· **S3 RBAC 敏感字段分级**已发(#441;新码 `recruitment-application.read.sensitive`——报名详情明文证件号/手机 + 证件照 signed-URL 改判敏感码,`read.record` 收窄为脱敏;biz-admin 同持双码)· **S4a H5 + 手机身份链**已发(#442)· **S4b OCR 六分流 + 重拍计数**已交付(本 PR,Unreleased):submit 六分流〔matched→verified / 模糊·防伪首次→retake 不落记录 / 不一致→三选一 / 上游首次→retry;**forgery·ocr_error H5 会话连续 2 次**才落 `manual_review`〔high/system〕,计数落会话表预建列〕;application **+4 列 additive 无 enum**;进度模型 +`retake/confirm/manual_high` 三态;**S2 待人工三栏升真 `riskLevel`**;admin 报名列表 +`riskLevel` 过滤、admin DTO +`riskLevel`/`manualReviewReason`(人工队列三栏分流/分组);**申请人侧绝不暴露风险分级**(高风险中性文案);**S5 promote 志愿者化 + 入队门禁双兼容**已交付(Unreleased):promote 改写 `gradeCode='volunteer'` + 建 **VOL 归口部门**(`Organization.code='VOL'`,≠ VOD);入队**两处门禁**(自助发起 + 一键入队)改用共享纯函数 `isUnenrolledVolunteer` **双兼容**(新 `volunteer`+VOL / legacy `null`+零部门);一键入队写改「**软删 VOL + 建目标部门**」守 `member_departments` 单部门唯一;历史成员**零迁移**;`join_source` 字典补 `recruitment` 项;新错误码 `28044`(VOL 部门缺失/非 ACTIVE 时 promote 清晰失败)。**S6 批量操作**已交付(Unreleased):**3 批量端点纯加,零 schema / 零新 RBAC 码**——批量标门槛 `POST …/applications/batch-mark-threshold`(匹配键 临时编号/手机/姓名+手机,签到导入由前端解析为数组;复用单行 `markThreshold` = 逐行幂等 + 逐行容错〔不整批回滚〕+ 自动推进;返 per-row + 批次汇总)· 批量导出 `POST …/applications/export`(按筛选导 CSV;**持 `read.sensitive` → 明文列 / 仅 `read.record` → 脱敏列**,复用 S3 `toAdminDto`)· 一键发号前预检 `GET …/cycles/{id}/promote-precheck`(纯读;复用 `decidePromotionIssuance` **结构性保证「预检=实发」**;per-row 可发/跳过 + 六类原因 + 重复 openid 高亮 + 缺字段 flag + 特殊证件 + 汇总)。**S7 通知闭环 = 部分交付**(本 PR,Unreleased,经 GAP-005 S3):招新 6 触发中**发号 / 入队结果** 2 个(申请人此时已是队员)已接入统一通知派发器 → 当事队员收到系统**定向**站内信(发号另带微信);**报名前 5 触发**(报名受理/转人工/门槛/评定/公示)申请人非队员、定向通知够不着 → **维持现状靠查询进度 pull**(`POST open/v1/recruitment/applications/query` 进度模型,见 S1),openid 非会员推送路另立项 |
| **GAP-007** | 终态「组织职务 + 分管 + scoped RBAC + 统一鉴权」落地序列(§11 PR1–PR12 逐刀)— 组织基座 / 多归属 / 职务配置 / 任职 / 分管 / scoped 判权 / 可解释性 | 冻结稿(已归档,全序列实施完成)[`org-position-scoped-authz-terminal-design-review.md`](../archive/reviews/org-position-scoped-authz-terminal-design-review.md) | ✅ **已全量落地(2026-07-03,PR1–PR12 + 摘码微刀全发 main,序列闭幕,序列内不单独发版)**:**PR1 组织基座**(reparent `org.move.node` + 闭包表,[#465](https://github.com/BA7IEE/srvf-nest-api/pull/465))· **PR2 Membership**(多归属 memberships,[#466](https://github.com/BA7IEE/srvf-nest-api/pull/466))· **PR3 职务定义**(positions + position-rules,[#467](https://github.com/BA7IEE/srvf-nest-api/pull/467))· **PR4 任职**(position-assignments 双轴 + 撤销 + 历史,[#469](https://github.com/BA7IEE/srvf-nest-api/pull/469))· **PR5 分管**(supervision-assignments,与职务正交,[#470](https://github.com/BA7IEE/srvf-nest-api/pull/470))· **PR6 RoleBinding**(带 scope 角色绑定 + UserRole 无损升级 = 判权唯一读源,[#471](https://github.com/BA7IEE/srvf-nest-api/pull/471))· **PR7 职务→角色 policy**(seed-only,3 新角色 org-admin/group-manager/org-supervisor,零持有零端点,[#473](https://github.com/BA7IEE/srvf-nest-api/pull/473))· **PR8 AuthzService/ResourceResolver**(统一判权大脑,三源推导 + covers + ActionConstraint,零消费者、无 ref 逐字等价 `rbac.can`,[#474](https://github.com/BA7IEE/srvf-nest-api/pull/474))· **PR9 考勤终审接线**(`finalApprove`/`finalReject` 切 authz = **首个业务消费者 + 首次现网真收紧**,新增 22074/22075 + 第 7 角色 `attendance-final-reviewer`,[#475](https://github.com/BA7IEE/srvf-nest-api/pull/475))· **PR10 authz/explain 诊断端点**(`POST admin/v1/authz/explain`,[#476](https://github.com/BA7IEE/srvf-nest-api/pull/476))· **PR11 公告导入**(2026 任命 staging 双锚落库工具 preview/execute,一次性上线初始化用,[#478](https://github.com/BA7IEE/srvf-nest-api/pull/478),见 §2.6)· **PR12 逐面迁移第一批(participation)**(`activities`/`activity-registrations`/`attendances` 三模块 24 处判权位点切 authz,scoped 持有者获点动作能力、GLOBAL 持有者行为逐字不变,[#479](https://github.com/BA7IEE/srvf-nest-api/pull/479))**均已发**(能力见 §2.1 / §2.2 / §2.3 / §2.6)· **摘码微刀**(`biz-admin` 摘除考勤终审两码 74→72,终审权改道 scoped 绑定或 SUPER_ADMIN 兜底,[#482](https://github.com/BA7IEE/srvf-nest-api/pull/482))。前端**现可做** memberships / positions / position-rules / 任职 / 分管 / role-bindings **全部录入面 + authz/explain 诊断查询 + 公告导入一次性工具**(端点明细见 §2.6 / §2.2,字段以 live `/api/docs-json` 为准);**⚠️ scoped 判权当前生效范围 = 考勤终审(final-approve/final-reject)+ participation 三模块点动作**(扁平跨轴列表与新建活动仍 GLOBAL-only)——其余业务面仍只认 `RoleBinding(GLOBAL)`,详见 §2.6 落地进度声明。**序列外候选(诉求触发再出 goal,不再挂本 GAP)**:members/certificates/content/notifications 等其余业务面逐面迁移 `rbac.can`→`authz.can`;QueryService 把 tree scope 下推成列表查询条件(扁平跨轴列表 scoped 过滤);16 个 `attachment.*.self` 收敛为 SELF scope;监督角色(`org-supervisor`)可配化(如分管可代签等写权);存量队员批量导入工具(preview/execute 镜像 announcement-import,同 R13 约束,登记于 [`NEXT_TASKS.md`](../ai-harness/NEXT_TASKS.md)) |
| **GAP-008** | 后台前端对接接口批次(搜索模糊化 / 选择器投影 / 跨轴列表增强 / 授权诊断批量化 / memberships·任职·分管总表)— F1–F5 五批,逐批 per-batch goal | 冻结路线图 [`admin-api-fe-integration-roadmap.md`](../archive/reviews/admin-api-fe-integration-roadmap.md)(§11 已拍板 2026-07-04,全按推荐) | **F1(A 组:搜索 & 选择器 + resolve-labels)✅ 已发 main**(members/users/organizations/positions/activities 5 资源 list 增强 + 6 个 `/options`〔含 `tree-options`〕+ net-new `meta/resolve-labels` 批量解析;详见 §2.7)。**F2(B 组:registrations/attendance-sheets 增强 + expand 约定)✅ 已发 main**(2026-07-04;两端点 +q/memberQ〔仅 registrations〕/activityQ/memberId+activityId〔仅 registrations〕/organizationId/includeDescendants/dateFrom+dateTo/expand;**D6 `expand` 仓库级约定首落地**〔逗号白名单 + 默认关形状不变 + 批量 join 禁 N+1,新增共享 `parseExpandQuery()` 供 F3–F5 复用〕;0 权限码/0 路由/0 schema 变更;详见 §2.3)。**F3(C 组:授权诊断 & role-bindings)✅ 已发 main**(2026-07-04;role-bindings `/page` 分页兄弟路由〔旧数组端点逐字不动,D9〕+ `GET :id` detail + `GET /preview` dry-run 预检〔与 create 同校验零写入〕+ `POST /batch` 批量建〔≤200 逐条 ok/blocked/already-exists 幂等〕+ `POST authz/explain-batch`〔单条批量壳,同 11 值枚举〕+ `POST authz/action-state/batch`〔批量业务态闸,reason ∪ `state_forbidden`〕;+2 码 `authz.{explain-batch,action-state}.decision` 绑 ops-admin〔goal 拍板 preview 复用 read 码不设新码〕;详见 §2.6)。**F4(D 组:memberships 总表 + transfer + tree-with-summary)✅ 已发 main**(2026-07-04;分页总表〔expand=member,organization〕+ detail〔membership.read.record 预埋孤码实装〕+ conflicts 只读体检 + **transfer 唯一写端点**〔单事务 end+create + audit `membership.transfer`;+1 码 `membership.transfer.record` 绑 biz-admin〕+ 组织轴归属分页/队员下拉 + tree-with-summary 树计数;详见 §2.6)。**F5(E 组:任职/分管总表 + preview)✅ 已发 main**(2026-07-04;任职全局分页总表〔expand=member,position,organization,缺省含 REVOKED 历史〕+ detail + 任命预检〔violations 逐项收集零写入〕+ 分管 `/page` 兄弟路由〔旧数组端点不动,D9〕+ detail + 覆盖预演〔EXACT/TREE closure 展开〕;六端点 0 新码全复用 read 码;详见 §2.6)。**→ 至此路线图 F1–F5 五批全量落地**(A 搜索&选择器 → B 工作台增强 → C 授权诊断 → D memberships → E 任职/分管;横切约定 D1/D2/D3/D7〔F1〕+ D6〔F2〕+ D8/D9〔F3〕全部确立并逐批复用;终值:权限码 195 / EXPECTED_ROUTES 319 / controller 66;路线图按其头部说明归档,本 GAP 关账) |
| **GAP-009** | 跨队员证书待核验队列:证书现仅挂队员轴(`members/:id/certificates`,核验/拒绝也在该轴),核验人无法跨队员横扫「全队待核验证书」,只能逐个进队员 360(镜像审批工作台的跨轴横扫诉求) | 一个扁平只读列表,如 `GET /api/admin/v1/certificates?certStatusCode=pending`(形态待拍板) | **提出**(源自 srvf-admin-web `docs/srvf-admin-vnext-blueprint.md` §10.4〔2026-07-06 识别为"后端缺口候选"但未回登本台账〕,2026-07-17 归一时补登;是否出 goal 待维护者) |
| **GAP-010** | 通知按条投递明细:admin 想看某条通知的逐人投递/触达情况;现只有全局 `sms-send-logs` 与通知 `readCount` 聚合,`NotificationDelivery` 表有数据但**无 admin 查询端点**(S2 交付时刻意「运维看库」,见 §2.5) | `GET /api/admin/v1/notifications/:id/deliveries`(分页;是否升级为正式端点待拍板) | **提出**(来源同 GAP-009,2026-07-17 归一时补登;是否出 goal 待维护者) |

> 蓝图 §10.4 的第三项「通用统计端点」**不另立 GAP**——已被 GAP-003 关账口径覆盖(dashboard-summary 块级供给;其余用各列表分页 `total` 拼,真诉求再 additive 加块)。

> **GAP-007 v0.49.0 扩展关账（#604–#608）**:冻结评审 #604 → 副职只读派生角色 #605 → 可见组织集 + FE 有效权限出口 #606 → members/certificates/profile/contacts/insurance 队员轴 #607 → participation 五个扁平/member-axis 入口 #608，已全部合入 main。上方 GAP-007 历史行末尾的“扁平列表仍 GLOBAL-only / members、certificates 待迁移”是 v0.34.0 序列闭幕时口径，**自 v0.49.0 起由本段取代**。当前后续候选只保留 users/content/notifications/audit-logs、attachment self-scope 等未接线面；Recruitment/team-join 是明确维持中央流程，不列为自动派生迁移 TODO。

> **通知发布代次 G2（Unreleased）**：admin 列表/详情仍可读取 system-directed 通知，但 PATCH/DELETE/publish/unpublish/archive 只允许 admin+broadcast；system-directed mutation 统一 `31030`。published 通知的 `title/body/notificationTypeCode/visibilityCode/visibleOrganizationIds/channels` 真实变化会自动回 draft，`pinned` 或 channels/org 集合语义等价更新保持 published。send-sms 对 system-directed 复用 `31013`。微信 worker 内部现按 publish generation 做 final permission，并把首次 quota reservation 与稳定模板绑定；这些都是后端运行时/部署约束，**没有新增或变更 admin API 字段**。端点、DTO 字段、权限码均不变，前端只需按新错误面和自动回 draft 状态刷新。

> **GAP-005 活动域扩展关账（2026-07-15;已随 v0.50.0 发版）**:上方历史行中的“三处 producer 共用 `activity-reminder`”仅代表 v0.32.0 发布时口径，现由独立类型 `activity-published` / `activity-changed` / `registration-result` / `attendance-result` 承接对应事件，`activity-reminder` 收窄为开场前 24 小时提醒；同时补齐公开发布广播、时间/地点变更、队员取消已通过报名与一次性提醒。无新端点/RBAC 码，前端继续消费既有 feed。

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

- **第①道门 = 招新**:对外公开报名 → OCR 实名 → 考核 → **一键发号**(`recruitment-application.promote.member`),产物 = 志愿者。**S5(v0.31.0)起**显式化:`gradeCode='volunteer'` + 挂 **VOL 归口部门**(`Organization.code='VOL'`,≠ VOD 志愿者组织部);历史(S5 前)发号的志愿者仍为 `null`+零部门,入队门禁**双兼容**(两种都认作"未入队志愿者")。
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

> **分组可演进**:① "系统管理" 一拥挤就拆「基础数据」(字典 / 组织 / 职务定义 / 职务规则 / 贡献值规则 / 附件配置)+「系统与权限」(用户 / 角色 / 审计 / 短信日志 / 各设置),按使用频率 + 权限层级分;② 审批工作台**只做日常高频**(活动发布 / 报名 / 考勤);招新报名、入队申请的待处理队列是季节性的,**留在各自模块**别塞进工作台(要"全局待办数"等 [GAP-003](#4-缺口台账-gap-ledger) 的 stats 端点统一出)。

### 5.3 页面骨架 + 可见性码(组件按 Element Plus / pure-admin `PureTable`)

| 页面 | 主端点(详见 §2) | 进入/列表可见性码 | 骨架要点 |
|---|---|---|---|
| 活动列表 → 作战室 | `activities` + `/:id/{registrations,attendance-sheets,reconciliation,participation-summary}` | 列表 `[auth]` 仅登录;写操作 `activity.*.record`;参与核对需两项读码 | `el-tabs` 增「参与核对」；`activityId` 取**路由参数**不放下拉；completed 才拉 reconciliation；考勤进 `review-detail` 审核页(初审/终审) |
| 审批工作台 | `activity-publish-reviews?status=pending` · `registrations?statusCode=` · `attendance-sheets?statusCode=` · 活动轴 `registrations/{bulk-approve,bulk-reject}` | `activity-review.read.request` · `activity-registration.read.record` · `attendance.read.sheet` | 发布审核、报名、考勤分栏；考勤再按 `pending`/`pending_final_review` 分一审和终审；选中报名按 activityId 分组后调用批量端点；展示逐项失败 BizCode；22081/22074/22075 单独处理 |
| 队员列表 → 360 | `members` + 子资源(§2.2;含**组织归属 memberships** CRUD + **任职 position-assignments** 只读 + `participation-summary`)| `member.read.record`(各子 tab 另持各自 read 码;参与汇总另需 `attendance.read.sheet`)| `el-tabs` 十 tab；参与汇总卡展示 approved 时长/活动数/记录数 + capped 贡献值，**别裸 SUM**(§3 #4) |
| 队保单 | `team-insurance-policies` | `team-insurance-policy.read.record` | 左保单表 + 右覆盖名单(`el-transfer` 或加/移弹窗) |
| 招新轮次 / 报名审核 | `recruitment/{cycles,applications}`(列表 `?cycleId=&statusCode=&riskLevel=normal\|high\|system` 过滤〔三参均 query DTO 白名单、可选;早期 loose `@Query` 旁路曾被全局 `forbidNonWhitelisted` 误拒 400,已纳入 `RecruitmentApplicationListQueryDto` 修复〕,**S4b**) | `recruitment-cycle.read.record` · `recruitment-application.read.record`(列表/脱敏详情)· `recruitment-application.read.sensitive`(详情明文证件号·手机 + 证件照 signed-URL;**S3 敏感分级**) | `el-steps` 表流程;**详情默认脱敏,持 `read.sensitive` 才显明文证件号/手机 + 取证件照 signed-URL**(无该码 → signed-URL 30100;字段集不变只 masking 随码);**S4b 人工队列三栏**:列表按 `riskLevel`(普通/高风险/系统异常)切栏,DTO 含 `riskLevel`/`manualReviewReason`(`forgery_suspected`/`system_ocr_error`/`ocr_mismatch_confirmed`/`special_document`)分组筛;`el-drawer` 标门槛/综合评定/一键发号;**S6 批量操作**:`POST applications/batch-mark-threshold`(批量标门槛,匹配键 临时编号/手机/姓名+手机,`mark.threshold` 码,返 per-row + 批次汇总)· `POST applications/export`(导 CSV,`read.record` 脱敏列 / `read.sensitive` 明文列)· `GET cycles/:id/promote-precheck`(发号前预检,`promote.member` 码,预检=实发;**v0.40.0 H5 手机通道**:无微信 openid 但有已验证手机的申请人**现可一键发号**〔建 SMS 登录通道账号〕,`PromotePrecheckRowDto` additive +`phoneAlreadyBound`/`duplicatePhoneInBatch` 两 flag;⚠️ **skipReason 字符串变**:`missing-openid` 停用 → `missing-login-channel`〔openid+phone 皆无〕,另新增 `phone-already-bound`/`duplicate-phone-in-batch`——前端若硬编码 `missing-openid` 文案须改);**OCR 鉴伪版充分利用(已发 v0.33.0)**:`GET applications/{id}/id-card-image-url` 现返**三图 signed-URL**(`url` 原图 + `cropImageUrl` 主体框裁剪 + `portraitImageUrl` 头像裁剪;裁剪图仅大陆身份证鉴伪版且已入库才有、否则 null;**仍 `read.sensitive` 闸**),报名详情 DTO **+4 OCR 顾问式列** `ocrAddress`/`ocrNation`/`ocrAuthority`/`ocrValidDate`(**随 `read.sensitive` 分级:脱敏级 → null**,住址等同证件号敏感)+ `hasIdCardCropImage`/`hasIdCardPortraitImage` 布尔 flag;**OCR 仅顾问式存档,gender/birth 仍由证件号推导权威、不被 OCR 覆盖**;**F2 改资料(v0.41.0-pre)**:`PATCH applications/:id`(新码 `recruitment-application.update.record`)——非身份字段(地址/紧急联系人〔整组替换〕/profileExtra/来源渠道/城区)恒可改,身份字段(realName/idCardNumber/birthDate/genderCode)**仅 `manual_review` 或外籍记录**(verified 大陆 → `28045` 文案「已通过证件核验不可修改身份字段」);大陆记录 birthDate/genderCode 由证件号派生**不可直改**(表单该两项对大陆记录禁用),改证件号会自动重派生;promoted/已脱敏行 → `28041`;**phone/openid 改绑不在此端点**(引导申请人走自助换绑)——发号预检 skip 的 `missing-derived-field`/`incomplete-data` 行在此补录后即可走 F3 单人建档;**F3 单人手动建档(v0.41.0-pre)**:`POST applications/:id/promote-single`(新码 `recruitment-application.promote.single`)——批量发号 skip 项(锚点占用/缺派生)逐条收尾;非大陆证件资料与登录锚齐备时已直接进入 batch,不因证件类型单独 skip。单人通道与批量共用建档内核 + 原子号段(编号连续)+ 发号通知,且**同样放行非大陆证件**(缺姓名/生日/性别 → `28047`「先补录再建档」,前端直接跳 F2 编辑);锚点自动择优(openid 可用→微信登录,否则手机→SMS 登录,响应 `loginChannel` 回显;双缺/双占 → `28046`「引导申请人先自助换绑」);已发号重跑 → `28041`(幂等零重复)。公示页/预检页每个 skip 行的「手动建档」按钮即接此端点;**F7 证书图(v0.41.0-pre)**:`GET applications/:id/certificate-image-urls`(**复用 `read.sensitive`**,短 TTL signed-URL 按类别分组〔first_aid/bsafe〕,无图 → 空 items)——报名详情「证书材料」面板取图;标 redCross/bsafe 门槛前可先看申请人自报证书图;发号后图随档案进 certificates(pending 行,占位 issuingOrg/issuedAt 待核验人经证书面修正) |
| 招新工作台(进度看板) | `recruitment/cycles/:id/stats` | `recruitment-application.read.record` | 五组聚合卡片(今日数据/待处理事项/门槛进度/综合评定/公示发号);**纯读**,计数与报名 stage 同源;`el-statistic` 数字卡 + `el-progress` 门槛分布;待人工 normal/high/system 三栏为**真 `riskLevel` 口径**(S4b 落地,去 verifyOutcome 代理);**S6 发号前预检**(`cycles/:id/promote-precheck`)可在「公示发号」卡上做发号前体检(逐行可发/跳过原因);**F6(v0.41.0-pre)**:stats 出参 additive +`withdrawnCount`(自助撤销终态独立计数,不入待处理桶);报名列表/导出筛选支持 `withdrawn` 态 |
| 入队管理 / 入队申请 | `team-join/{cycles,applications}` | `team-join-cycle.read.record` · `team-join-application.read.record` | 开轮/编辑轮表单 `openOrganizationIds?:string[]\|null`(最多 64 项;null/空=全部 ACTIVE)+`maxTargetOrgs?:number\|null`(**null=默认 2,域 1..2**),配置清单中的 org 必须存在且 ACTIVE;轮次 list/detail 仍回显数据库原始配置。旧轮若存值 >2 不订正,但 App 申请写侧校验与 App 响应有效上限均钳制为 2;历史已提交的 >2 部门申请仍有效。申请人新发起/改候选由后端强制「候选 ⊆ 开放清单且去重后数量 ≤ 2」;3 项及以上先由 DTO 返回 `40000`,其它清单/轮配置不合法复用 `28242`;一键入队弹窗仍只能从申请人的历史候选中选最终部门 + 默认级别 L1 |

> **招新/入队契约收口(已发 v0.42.0–v0.43.0;C/D/E)**:
>
> - admin 报名 DTO/发号预检 DTO 的 `isForeigner` 已改名为 **`isNonMainlandDocument`**,CSV 表头同步为 `is_non_mainland_document`;含义固定为「非大陆证件(身份需人工核验;不代表国籍)」。前端模型、表格列与导出映射须同步改名。DB 历史列名不属于接口契约。
> - 批量发号改为**纯资料齐备口径**:非大陆证件申请人补齐 `realName/birthDate/genderCode` 且有 `openid|phone` 登录锚后,可进入公示预览/预检/批量实发;`foreign-manual-build` skip reason 已退役。仍缺派生字段时自然落 `missing-derived-field`。
> - `approved` 入队资格**不随轮次关闭失效**;一键入队不再依赖 `evaluationExtendedUntil`。该字段继续回显但仅存档;专业队 gate、8 项通用门槛有效期与贡献值仍由后端在入队时重校验。
> - 证书审核正路为 `POST admin/v1/recruitment/applications/:id/certificates/:category/review`,权限码 `recruitment-application.review.certificate`,路径 `category ∈ {first_aid,bsafe}`,body `{approved,note?}`。通过自动标对应门槛(`first_aid→redCross`,`bsafe→bsafe`);驳回写原因、清该类图片并同步退门槛标记。直接/批量标 `redCross`/`bsafe` 前也要求对应类别已有证书图,缺图返 `28053`;详情「证书材料」面板应以此审核端点提供通过/驳回动作,不要再把门槛勾选当作审核本身。
> - **v0.43.0 刀A 契约/行为收紧**:申请人上传现必填 `issuingOrg` + `issuedAt`(date-only,不得晚于今天),admin 报名 list/detail 共用 DTO additive `certificates:[{category,imageCount,issuingOrg,issuedAt,reviewStatus,reviewedAt,reviewedBy,reviewNote}]` 摘要;已 approved 类别重传返 `28054`。直接/批量标证书类门槛除有图外还须审核 approved,否则 `28055`;CSV 列不变。promote 仍建 `pending` Certificate,但 `issuingOrg/issuedAt` 搬申请真值,存量缺值才回退占位,招新阶段 approved 结论写入 `verifyNote` 供后续证书核验人参考。
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
> - **活动作战室·概览** 摆出 `capacity` / `registrationDeadline` / `requiresInsurance` / 派生 `phase`；发布弹窗必须提交 `{requiresInsuranceConfirmed:true}`。报名/审批要求 published，考勤允许 published|completed；活动过时后用 dashboard `pendingCompletion` 提醒人工 complete。
> - **角色 / 权限 / 绑定提交后即时生效**:`RbacService` 下一请求直接读取当前 DB 权限事实,无需刷缓存；`system/v1/rbac` reload 与 `rbac.config.reload` 判权仅作兼容保留,内部 no-op。

### 5.4 工作台 / 首页

最实用的落地页是"**有什么等我处理**"(待审报名 / 考勤),而非报表。**建议直接把「审批工作台」设为登录默认路由**。

**✅ 2026-07-15 true-up**:首页数字卡片在原 `registrations.pending` + `attendanceSheets.{pending,pendingFinalReview}` + `activities.published` 上，新增 `activities.pendingCompletion`（published 且活动已结束但尚未手动完结）。建议单独做「待完结活动」卡片并跳转 activities published 列表；块级权限裁剪、零 query、零缓存语义不变。

---

## 6. 这份文件怎么不馊

改后端 API surface / RBAC / 契约 → **同 PR** 改本文件受影响行 + `pnpm docs:handoff:openapi`(沿 [`AGENTS.md`](../../AGENTS.md) 反漂铁律);"改什么必须动哪篇哪节"的逐行对照见 [`README.md §2`](README.md)。前端对接前先读本文件 + 对 live `/api/docs-json` 核字段。
