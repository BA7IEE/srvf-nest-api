# 交接:后端 ↔ 小程序前端 / 招新 H5

> **本文件服务两类前端**:小程序(前端仓尚未建,能力图按占位骨架先就位,建仓直接填)与**招新 H5(已建仓 `srvf-h5`:报名 / 身份证上传 / OCR 确认 / 进度查询)**——H5 无账号,只消费 §2 中 `open/v1` 招新链各行。
> canonical 在后端仓;字段真相 = live `/api/docs-json`;见 [`README.md`](README.md)。
> 活动责任闭环已随 **v0.62.0 release**，但 production 尚未部署；当前仍只做本地前后端联调，不执行迁移、真实人员配置、部署或切换。

---

## 1. App surface 模型(和 admin 完全不同,先读铁律)

小程序消费 **`/api/app/v1/*`**(队员**本人视角**),不是 admin 面。后端语义锁(`api-surface-policy.md §9`):

- **准入**:App 要求 `User.memberId != null` + `User.status=ACTIVE` + 绑定 `Member.status=ACTIVE`;不满足 → `canUseApp=false`。候选人 / 临时号**进不来** App。
- **scope=self**:App 端 where 永远用 `currentUser.memberId` 锁本人;后端不靠 role 放大数据范围(ADMIN 登 App 也只看本人)。
- **`/me` vs `/my`**:`/me/*` = 身份/账号/资料/能力;`/my/*` = 本人持有的业务记录。别混。
- **capability ≠ raw RBAC**:`GET /api/app/v1/me/capabilities` 返**产品级**能力，不返 raw 权限码。活动新增入口提示为 `activities.canInitiateActivity` / `canDirectPublishOwnActivity`，管理提示为 `managed.canViewManagedActivities` / `canManageManagedRegistrations` / `canSubmitManagedAttendance` / `canReviewActivityPublication` / `canFirstReviewAttendance` / `canFinalReviewAttendance`；它们都不能证明某一活动或组织最终可操作。
- **L3 永不回**:App 永不返 `passwordHash` / `refreshToken` / `secretKey*` / 完整 signed URL。

### 1.1 登录与令牌(与 admin 全端一致,不在两处各维护)

三种登录(`login` 密码 / `login-sms` 验证码 / `login-wechat` openid,未绑定时返 `bindingRequired` 见 §2)成功时返回同一 `LoginResponseDto`(P0-E 冻结 5 字段)。信封语义、业务失败 = HTTP 4xx、`expiresIn` 时长串 + `refreshExpiresAt` family 绝对死期的**双计时器**、rotation always、错误码(10004/40100/10007/42900)→ 行为映射,统一见 [`admin-web.md §3.1`](admin-web.md)(全端通用)。其中 `logout` 用传入 token 定位并撤销整个 refresh family，成功 `data=null`；只有 `logout-all` 返回 `revokedCount`。App 侧差异只有一条:登录后能力判定调 `GET app/v1/me/capabilities`(产品级),**不**消费 admin 的 raw 权限码出口(§1 铁律)。

| 任务 | 端点 |
|---|---|
| 登录 | `POST /api/auth/v1/login`(密码) · `login-sms`(验证码) · `login-wechat`(小程序 openid;未绑返 `bindingRequired`) · **`login-wecom`(企业微信 OAuth;见下方 §1.3)** |
| 身份换绑 step-up | 换手机号/微信/企业微信前先按当前可用因子调用 `POST /api/auth/v1/step-up/password`、`step-up/sms{,/send-code}` 或 `step-up/wechat`,body 的 `action` 固定为目标动作 `PHONE_BIND` / `WECHAT_BIND` / **`WECOM_BIND`**;成功仅返 `{stepUpToken,expiresAt}`。随后分别把 proof 作为必填 `stepUpToken` 传给 `PUT /api/app/v1/me/phone` / `me/wechat` / **`me/wecom`**。⚠️ **不新增 WECOM 因子** —— 要绑的东西不能同时当"我已经是这个人"的证据,仍用现有 PASSWORD/SMS/WECHAT 三种因子证明 |
| **企业微信绑定状态 / 换绑** | `GET /api/app/v1/me/wecom`(未绑定返 `{bound:false,...}` 而不是错误) · `PUT /api/app/v1/me/wecom`(见 §1.3)。**没有 DELETE** —— 本人裸解绑不开(D-WC-9),释放身份只能由管理员清除 |
| 我的身份/资料/能力 | `GET /api/app/v1/me` · `me/account` · `PATCH me/profile` · `PUT me/password` · `GET me/capabilities` |
| 活动池 / 我的活动 | `GET /api/app/v1/activities/available`(**仅 `public` 且未结束活动;详情 `GET /api/app/v1/activities/:id` 含 `phase` / `genderRequirementCode` / `requiresInsurance` / `passCount` / `allocationMode`；列表刻意不增加该字段**) · `GET /api/app/v1/activities/:activityId/positions`（live 岗位，`remainingCapacity` / `canRegister`；余量 0 仍可进候补）· `GET /api/app/v1/my/activities`。活动 `capacity` 有岗位时为岗位总和，任一岗位不限则 null |
| **我发起或负责的活动（v0.62.0 本地联调；production 未部署）** | 新 base `GET/POST /api/app/v1/my/managed-activities`，**不得复用**上行 `/my/activities`（后者仍只表示本人报名历史）。创建 body 必填 `allocationModeCode∈{first_come,qualification_rank,lottery}`，managed detail/projection 同字段原样回显；draft 可 PATCH 该字段，published 的改变必须在 change review `activityPatch` 里提交。`GET organization-options` 返回 active membership / cross-org grant 可发起组织及 `pathLabel`；detail 返回 activity、initiator/owner/`myResponsibility`、publishReview、counts、closure。draft 可 PATCH/DELETE，并在独立 `/positions` 子资源 CRUD；初发用 `submit-publish-review` 或详情 `publishReview.canDirectPublish=true` 时的 `direct-publish`，pending 可 `withdraw-publish-review`。published 直改返 `20037`，owner 改走 `submit-change-review` 完整 proposal。职责面为 `responsibilities`、`collaborator-options`、`collaborators` add/end、`transfer-owner`；报名管理位于 `/:activityId/registrations`；考勤管理位于 `/:activityId/check-ins`、`attendance-sheet-draft`、`attendance-sheets`（list/create/detail/edit/delete/resubmit）。owner 与 active 对应能力协办可用，无关用户即使持全局业务角色也统一 30100，协办结束后下一请求立即失权。考勤 GPS 视图不返回原始经纬度/精度；退回单先 PATCH 编辑，再 POST `:sheetId/resubmit`，回 `pending` 后必须重新一审。活动结束后仅当前 owner 可 `POST /:activityId/declare-attendance-complete`；详情 `closure.status` 实时区分待声明/一审/退回整改/终审/closed。Activity=`cancelled` 时详情固定 `activity.statusCode='cancelled'`、`closure.status='cancelled'`、`closure.nextAction=null`，取消优先于全部考勤闭环状态；前端显示“已取消”，不显示考勤声明、一审、终审或完结按钮，不得映射为 published。只有 Activity=`completed`、已声明且无未解决有效 Sheet 时才 closed。列表保持扁平契约，直接读取顶层 `statusCode + nextAction`，取消项为 `cancelled + null`，**不要期待列表存在 `closure` 对象**；`unresolvedAttendanceSheets` 可辅助展示但不得覆盖取消终态。closure 是责任闭环展示状态，Activity 主状态仍是业务事实，cancelled 场景两者语义必须一致。 |

> **整单取消（第 4 批第三刀）**：负责人继续使用既有 managed activity cancel command，wire 不变。成功后刷新 managed detail 与报名列表：canonical pending/waitlisted 会关闭为 cancelled，已 pass 的历史审批和 active capacity 保留；混合头仍按 pass 展示。若服务端返回既有 `20147`，表示本次没有部分结果，应刷新后交给运营核对，不能用 legacy 候补入口或新 operationKey 静默补偿。
| 我的报名(报名/查/取消) | v1.1 活动固定走 `POST /api/app/v1/activities/:activityId/registrations`，body 只可为 `{operationKey,formVersion,answers,preferences}`；`preferences[].positionIds` 的数组顺序由后端派生为从 1 开始的志愿顺序。活动存在任一 live 岗位时 `preferences` 不可为空；已选场次存在 live 岗位时该场次 `positionIds` 也不可为空，二者均返 `21035`。活动性别不符或缺 profile 返 `21034`；启用保险且活动要求保险但无有效来源返 `26030`。成功/同 key 同 canonical 请求仅返 `{registrationId,registrationRevisionId,revision,submittedAt}`；不同 canonical 请求复用 key 返 `21003`。无 active Form 时仅可 `formVersion:null + answers:[]`；file 答案仅可给 `uploadSessionId`，提交后会被消费且不可重用。`POST /api/app/v1/my/registrations` 仅保留给没有 live session、也没有 active Form 的 legacy 活动；v1.1 活动统一返 `21038`，不可绕过答案、身份和附件链。`GET /api/app/v1/my/registrations` 与 `PATCH` 取消语义不变。 |
| 我的考勤 / 参与汇总 / 证书 | `GET /api/app/v1/my/attendance-records` · `GET /api/app/v1/my/participation-summary` · `GET /api/app/v1/my/certificates`。参与汇总严格锁当前 `AppIdentityResolver.memberId`，只统计 approved Sheet：`totalServiceHours` / distinct `activityCount` / `recordCount`；`contributionPoints` 复用生涯累计封顶核，与 Admin 旧 `contribution-summary` 同源。**不返回 memberId / no-show / 他人数据**，前端直接展示，勿自行 SUM |
| **活动 GPS 自助签到 / 签退(F2)** | `POST /api/app/v1/my/activities/:activityId/check-in` · `POST .../check-out` · `GET .../check-in`。只认本人当前 `pass` 报名；⚠️ **首次写已收紧为 fail-closed**：活动/请求坐标完整合法且原始 Haversine 距离不超过配置半径才 200。已有合法 winner 的网络重试仍返回同一证据且不覆盖。App 仅收到时间、距离与历史兼容字段 `geoVerified/outOfRange`，**不返回原始经纬度、accuracy 或 memberId**。**审计口径**:签到/签退**成功本身不落 AuditLog** —— 事实记录就是那行 `ActivityCheckIn`(坐标、精度、距离、时间戳齐全且不可变),再写一条审计只是同一事实的副本;前端不要期待打卡会出现在任何审计/操作日志视图里。反过来,**管理端对签到记录的任何修改或删除必须留痕**(当前后端不存在这类写路径,新增时才会有对应审计事件) |
| **活动评价(F2–F4)** | `GET /api/app/v1/my/activities/:activityId/feedback` 初始化本人评价与 `canSubmit/windowClosesAt`；`PUT` 同路径提交 `{rating,comment?}`。只认 completed + 窗口内 + approved 到场，本人 scope；不返回他人评价/人数/均分 |
| 公开(无账号) | `POST /api/open/v1/recruitment/applications/*`(招新报名) · `GET /api/open/v1/contents`(内容;`expireAt <= now` 的附件行不返回、过期封面 URL 为 null,未来时间/null 不变) |
| 招新本人进度(无账号) | `POST /api/open/v1/recruitment/applications/query`(凭 wx.login code 换 openid;**返进度模型**:业务态 `stage` + 字典 `stageText` + `nextAction` + 门槛 `todoList` 真投影 + 临时编号;`memberNo` 恒 null——发号后经登录态 app 侧查,见 §3 GAP-006)。**F4(v0.41.0)**:发号后(报名行 openid 已清)不再「查无 28002」——经账号 openid 锚 fall-through 返 **stage=volunteer 引导态**(「已转志愿者 / 待入队」+ `nextAction=apply-teamjoin`),前端见此态引导用户登录小程序/申请入队;已离队(INACTIVE)或非招新出身仍 28002 |

### 1.1.1 活动报名表与一次性附件会话（第 4 批）

- 管理 Form：`GET/PUT /api/app/v1/my/managed-activities/:activityId/registration-form`。PUT body 固定为 `{form:null|{fields:[...]}}`；`null` 是明确移除/不用自定义表，object 的 `fields` 必须非空。草稿仅沿既有发起人直改权限；published PUT 返回 `20037`，改动应走 change review。相同 canonical 定义是 no-op，不会产生新版本或 audit。
- **资格规则配置/发布激活**：负责人通过 `GET/PUT /api/app/v1/my/managed-activities/:activityId/qualification-rules` 管理 draft 活动。PUT 为全量替换，`{ruleSets:[]}` 明确清空全部 draft scope；每项为 `{scope:{sessionId:null|string,positionId:null|string},rules:[...]}`，仅接受 #22 typed wire，不能传 `valueJson`。canonical 相同即 no-op，不产生新版本或 audit；published direct PUT 返回 `20037`。初发审核与携带显式 `qualificationRuleSets:{create,update,cancel}` 的变更审核才冻结 V5 目标并在审批时激活/退役版本；proposal 内新岗位用既有 `clientRef` 引用。取消有 active 规则的场次/岗位必须同时显式 `cancel` 对应 scope，否则 `409/20022`，不要尝试由前端隐式删除配置。
- 队员活动详情：`GET /api/app/v1/activities/:activityId` 保留 `formVersion:number|null`，并新增 `registrationForm:null|{version,fields}`、`allocationMode:first_come|qualification_rank|lottery` 与资格安全投影：顶层 `qualification`、每个 session 的 `qualification`、每个 position 的 `qualification`。资格对象只含 `resultCode` 和未满足项 `{ruleId,enforcementCode,resultCode,message,warnScore}`；前端可展示 warn 提示，不能据此推测或缓存等级、性别、生日、组织、证书或保险事实。只有 active Form 才返回安全题目定义；绝不依赖或展示 DB id、hash、workflowRevision、时间戳或存储信息。
- 创建会话：`POST /api/app/v1/activities/:activityId/registration-upload-sessions`。仅当前公开可报名、未结束且 active Form 含 file 题的活动可创建；成功**仅此一次**返回 `{id,token,expiresAt,formVersion}`，token 30 分钟有效，客户端须立刻临时保存，不能期望后续读取或恢复明文 token。
- 上传：`POST /api/app/v1/activities/:activityId/registration-upload-sessions/:sessionId/files` 是后端中转 `multipart/form-data`，文本字段名 `token`、**单个**文件字段名 `file`。仅 JPEG/PNG/WebP/PDF，最大 10 MiB，声明 MIME、大小和文件魔数都须通过。成功仅返回 `{attachmentId,originalName,mime,size,createdAt}`；同 token 重试返回同一安全元数据。
- **提交/重报（第 4 批）**：`POST /api/app/v1/activities/:activityId/registrations` 必填 `operationKey`、`formVersion`、`answers`、`preferences`。同 key+同 canonical 请求即使 upload session 已 consumed 也返回首次回执；同 key 异载荷返 `21003`。提交会按活动/已选场次/已选岗位以当前事实重评资格：block 返 `409/21040`，配置无法安全判定返 `409/21041`，warn 仍成功但应按活动详情投影提示。pending/waitlisted 以及 live cancelled/reject 头的新 key 都只在原 head/identity 上追加 revision；soft-deleted 头不复活。旧 revision/答案/志愿/保险 evidence 不改写；仅 single gate=true 且活动 `requiresInsurance=true` 时，每次成功报名/重报产生当次 revision evidence，gate=false 或活动不要求保险时为 0。客户端应保存新回执的 revision/id，不要把“取消后重报”建模成第二份报名。
- **file 题最终绑定**：答案只传 `uploadSessionId`，不传 attachmentId/token/key/URL。事务内会核验本人、活动、Form 版本、会话状态及唯一 AVAILABLE 文件；成功后将附件转为内部 `registration-form-answer` owner 并消费会话。安全回执、异常和通用附件读写面都不会返回最终附件 id、文件名、token、key、URL 或 locator。
- **没有 Provider signed upload URL**：任何响应都不返回 key、accessUrl/signed URL、owner、tokenHash 或存储 locator。

- **资格错误与 legacy**：canonical 报名的资格 block 返 `21040`，配置漂移返 `21041`，warn 不拦截；legacy 只在没有 live session、active Form 和 active 场次/岗位资格规则时可用，否则继续 `21038`。managed approve 面对旧 legacy pending 无 identity/preference、但后续已出现 active 场次/岗位 RuleSet 时同样返回 `21038`；不要把活动详情的安全投影当作可自行重算的事实来源。
- **分配方式与发布审核**：draft PATCH、初发/变更提交或审核遇到任一历史 allocation batch mode 不一致时均返 `409/20152`，前端不要静默重试或尝试改历史 batch；v4 review 待审期间若 mode 被旁路修改，approve 返 `409/20144`，应刷新活动后重新提交。分配 command 与安全读面见下一条；本 handoff 不交付新的排队、资格排序、抽签、candidate 或候补 UI。
- **邀请接受与分配 command（第 4 批）**：本人接受邀请用 `POST /api/app/v1/my/activity-invitations/:invitationId/accept`，body 与 canonical 报名相同，仍必须传 `operationKey`、Form 版本、答案和志愿；同 key+同请求重放原回执，异请求按稳定冲突码处理。`first_come` 不创建 allocation batch，每个场次独立即时得到 `pass` 或 `waitlisted`；一个场次满员不能拖累其他已提交志愿。负责人仅对 `qualification_rank`/`lottery` 使用 `POST /api/app/v1/my/managed-activities/:activityId/allocation-batches` prepare、`POST .../:batchId/commit`、`POST .../:batchId/void` 与 `GET .../:batchId`。prepare 必须在报名截止后；lottery 的 seed 只在 committed 批次回显。客户端只展示服务端返回的结果和四位资格分数，不要自行复算资格或排序；候补递补只会发生在原场次、原岗位，跨岗位须本人重新确认。

### 1.1.2 自助二维码与现场服务段（第 5 批）

- **负责人二维码**：考勤责任人先读 `GET /api/app/v1/my/managed-activities/:activityId/sessions/:sessionId/qr-credentials`，再以 `{operationKey}` 调 `POST .../qr-credentials/:action/issue` 签发或重签（`action` 仅 `check-in` / `check-out`）。服务端只从对应场次的签到或签退窗口取有效期；同 key+同 canonical 请求重放首次安全回执，异请求保持稳定冲突。`POST .../qr-credentials/:credentialId/revoke` 需要 `{operationKey,reason}`；负责人、活动和场次均由服务端在 Activity 根事务内重验，不能把页面可见性当作授权。
- **二维码展示**：`POST /api/app/v1/my/managed-activities/:activityId/qr-credentials/:credentialId/render` 只向考勤责任人返回 `Cache-Control: no-store` 的受保护 SVG 二进制内容；不使用 JSON envelope，列表、签发、作废和任何服务段读面都不回显扫码 token、token digest 或 request hash。小程序仅把扫码得到的完整 token 原样作为下一步请求输入，不能持久化、拼接或自行签名。
- **本人签到/签退**：`POST /api/app/v1/activities/:activityId/sessions/:sessionId/punches/check-in` 与 `.../check-out` 均传 `{qrToken,eventKey,longitude?,latitude?,accuracy?}`；`eventKey` 是全局防重键，坐标三元组只按活动配置的定位策略校验，显式 `null` 不可替代缺省。`GET .../my-punch-state` 只返回本人安全状态、服务端时间和可执行的下一动作，不返回身份、原始坐标或扫码机密。
- **现场纠正**：考勤责任人可用 `POST /api/app/v1/my/managed-activities/:activityId/onsite/sessions/:sessionId/early-departure-close` 为指定 `participationIdentityId` 以 `{eventKey,reason}` 特殊闭合；`POST .../onsite/punch-events/:eventId/void`、`.../replace` 以 `{operationKey,reason}` 追加纠正事实。三者不会覆盖历史 PunchEvent；早退固定产生零时长零分段。所有 PunchEvent 写命令在同一 Activity 根事务内投影服务段，首笔签到后的报名状态变化不阻断该身份已打开服务段的正常签退。
- **范围边界**：本批只交付本人 QR 自助和责任人现场纠正；不含工作人员代扫、代理、批量、导入或离线流程（均属于第 6 批）。

### 1.1.3 工作人员现场、CSV 导入与离线写入（第 6 批）

- **成员凭证与 staff scan**：本人用 `POST /api/app/v1/my/attendance-member-credential/render` 取得仅 SVG 二进制的短时成员凭证；它不返回 JSON token，客户端不得持久化或尝试解析。考勤责任人调用 `POST /api/app/v1/my/managed-activities/:activityId/onsite/sessions/:sessionId/staff-scan` 时，必须二选一提交 `memberCredential` 或 `{manualConfirmation:{participationIdentityId,reason}}`，并带 `actionCode`、`eventKey` 与可选完整坐标三元组。服务端时间是唯一 `occurredAt`。
- **单人代理与批量任务**：`POST .../proxy-punch` 要求 `participationIdentityId`、`actionCode`、`eventKey`、`reason`；`POST .../bulk-punch-jobs` 要求 `operationKey`、`actionCode`、`reason`、去重的 `participationIdentityIds` 和可选完整坐标三元组。bulk 的同 key 同请求重放原任务，异请求稳定冲突；用 `GET .../onsite/bulk-punch-jobs/:jobId` 读取安全进度，不能把已创建任务视为所有 item 都已成功。
- **CSV 预览与执行**：`POST .../import-previews` 用 multipart 上传 `operationKey`、`reason` 与单个 UTF-8 CSV（唯一列顺序为 `participationIdentityId,actionCode,occurredAt,longitude,latitude,accuracy`）；再以 `GET .../import-previews/:previewId` 读取安全摘要/分页行状态，最后用 `POST .../import-previews/:previewId/execute` 提交 `{operationKey,fileDigest,parserVersion,previewHash}`。客户端不得保存或要求返回原 CSV、对象 key、签名 URL、原始单元格或导入附件 locator；execute 会重读同一冻结对象并重新校验摘要，文件替换或解析漂移不会产生 PunchEvent。
- **离线包签发/撤销**：考勤责任人以 `{operationKey,deviceId}` 调 `POST .../onsite/sessions/:sessionId/offline-packages`；成功只在首次签发或同 key 同请求精确重放时返回 `{package,packageToken}`。token 格式固定为 `base64url(canonical payload).base64url(HMAC-SHA256)`，payload 字段顺序为 `{v,purpose,packageId,activityId,sessionId,operatorUserId,operatorMemberId,deviceId,packageVersion,packageKeyVersion,validFrom,validUntil,uploadUntil,sequenceStart,chainAnchorHash,ruleSnapshotHash,workflowRevision,participantSnapshotHash}`。受控设备可解码冻结字段和首个 `chainAnchorHash`，但不得把本地解码结果当成授权结论；服务端仍会逐请求验签和重读责任。完整 token 只可在该设备的平台安全存储中保存至包撤销/过期，不得进日志、埋点、普通明文存储或经其他读取接口恢复。撤销走 `POST .../onsite/offline-packages/:packageId/revoke`，body 固定 `{operationKey,reason}`。
- **单事件离线上传**：`POST .../onsite/offline-packages/:packageId/upload` 每次只收一个事件，body 精确为 `{packageToken,sequence,priorHash,eventKey,actionCode,deviceTime,memberCredential,location?,signature}`；`location` 可选，提供定位时经纬度必须成对，`accuracy` 可选，并继续服从场次定位策略。设备必须按包内连续 sequence/hash 链签名，成员凭证按 `deviceTime` 的 60 秒窗口验证。成功回执仍是统一 `AppActivityPunchReceiptDto`；同 `eventKey+requestHash` 精确重放原事实，异内容稳定返 `22088`。
- **签名与链的 canonical 规则**：事件 key 为 `HKDF-SHA256(IKM=packageToken UTF-8, salt=empty, info="srvf:attendance-offline-event:v1", L=32)`。待签 UTF-8 JSON 的字段顺序固定为 `{v:"attendance-offline-event/v1",packageId,sequence,priorHash,eventKey,actionCode,deviceTime,memberCredentialDigest,location:{longitude,latitude,accuracy}}`；`deviceTime` 规范为 UTC ISO 字符串，credential digest 为 raw credential 的 SHA-256 lower-hex，经纬度分别 `toFixed(7)`，accuracy `toFixed(2)`，缺省为 JSON `null`。`signature` 是该 JSON 的 HMAC-SHA256 无 padding base64url；`eventPayloadHash=SHA-256(canonical event JSON)`，`signatureDigest=SHA-256(signature string)`，下一链值为 `SHA-256(canonical {v:"attendance-offline-chain/v1",packageId,sequence,priorHash,eventPayloadHash,signatureDigest})`。只有 201 成功或 review approve 才推进本地 sequence/priorHash；22097/22098/22099 均不得推进。
- **异常与人工复核**：`22097` 表示 token/锚/签名无法验证，服务端零写且不建复核项；`22098` 表示已验证但超过 `uploadUntil`，仅写过期复核项且零 PunchEvent；`22099` 表示已验证但需人工复核，同一 pending 事件不重复制造复核行。用 `GET .../onsite/offline-review-items` 读取安全分页列表，再以 `{operationKey,reason}` 调 `POST .../:reviewItemId/approve` 或 `.../reject`；列表和回执不会返回 token、签名、hash、成员凭证或原始坐标。`reject_only` 不可 approve；revoked/expired 包也不会因 approve 恢复上传能力。
- **交付边界**：以上只代表 B6-2 子刀的 wire；不能据此判断完整第 6 批、PR/CI/核验/合并状态或生产部署，联调前须核对对应 exact SHA 的交付证据。

### 活动责任闭环的五类视图与按钮

1. **我参与的活动**：App `/api/app/v1/my/activities`，只表示本人报名/参与历史。
2. **我发起或负责的活动**：App `/api/app/v1/my/managed-activities`，表示 initiator、owner 或 active collaborator 关系。
3. **待发布审核**：Admin `/api/admin/v1/activity-publish-reviews?status=pending`。
4. **待一审考勤**：Admin `/api/admin/v1/attendance-sheets?statusCode=pending`。
5. **待终审考勤**：Admin `/api/admin/v1/attendance-sheets?statusCode=pending_final_review`。

后三类是 Admin 审批面，不要混入 `/my/activities`。正式队员才显示“发起活动”，可选组织只读 `organization-options`；普通发起人显示“提交发布审核”，只有详情 `publishReview.canDirectPublish=true` 才显示“直接发布”。owner 与报名协办、考勤协办的按钮按 `myResponsibility` 分开；考勤提交与考勤审核按钮也必须分开。`returned` 时展示退回原因、修改和重新提交。最终闭环判断是 `closure.status === 'closed'`，不是 `closure.closed`。

页面级 capability 只负责入口提示。每个按钮还要结合 `myResponsibility`、Activity/review/Sheet/closure 状态；服务端 resource + scope 判定才是最终结果。不得按 ADMIN、队长、`publishedBy` 或“能看到页面”猜权限。

本地正常验收中的发布审核员、考勤一审员和终审员必须使用显式 scoped RoleBinding，不能使用 SUPER_ADMIN 掩盖角色配置问题。实际系统中 SUPER_ADMIN 保留紧急兜底权限，但仍受考勤提交人不能审核自己、最近重提人不能审核自己、一审人不能终审同一张单等人员隔离规则约束，不应作为日常审核人员配置使用。

> **v0.62.0 · PR-12 边界收口（production 未部署）**：draft 只有在目标组织 ACTIVE、未软删、非根，且持久化 initiator 仍为有 ACTIVE 账号的正式队员并具备目标组织 membership / scoped cross-org grant 时才可真实改组织；`initiatorMemberId=null` 不会回退为当前操作者。已发布活动的 `submit-change-review.activity.organizationId` 只能省略或等于当前组织，不同值统一返 `20022`，客户端不要提供普通 proposal 的“迁移组织”入口。
| **H5 报名前手机身份链(无账号;S4a)** | `POST /api/open/v1/recruitment/identity/send-code`(`{phone}`→发验证码) → `POST .../identity/verify-code`(`{phone,code}`→返一次性 `phoneVerificationToken`〔30min,明文仅返一次〕) → 提交报名(见下行 H5 链)。**F4(v0.41.0)**:闭轮期两端点对「手机命中未清除报名记录」者放行(自助查询/换绑链闭轮不再断);闭轮陌生手机 send-code 返防枚举泛化 200(不真发码),verify-code 统一 24010——前端不必对闭轮做特殊分支 |
| **公开报名提交(无账号;H5 + 小程序)** | `POST /api/open/v1/recruitment/applications`(multipart)。**⚠️ 契约收紧(已发 v0.42.0;consent 必填自 v0.41.0)**:`payload.phoneVerificationToken` 对 H5/小程序现均为**必填**——两端都先调上一行 send-code/verify-code 完成短信验码,`payload.phone` 须与验证手机一致;小程序可另附 `wechatCode` 绑定 openid,但**仅 wechatCode、无 token 一律 40000**。`payload` 另须含 `privacyConsentAccepted: true`,multipart 须含 `signatureImage`(jpeg/png ≤5MB,申请人手写签名图;任一缺省/false → 40000,旧版本前端会全量 400——发版前必须同步升级);可选 `privacyConsentVersion`;签名图发号后随队员档案长期留存。**前端必须先完成短信验码 + 签名采集再允许提交**。证件照/签名图的实际字节必须匹配声明 MIME,仅改扩展名或伪装内容统一返 `13016`,且不会进入 OCR/落库 |
| **OCR 六分流提交结果(S4b)** | 同上 submit 端点出参由 `RecruitmentSubmitResultDto.outcome` 区分:`submitted`(已落记录,`statusCode`=verified/manual_review + `tempNo`)/ `retake`(证件照模糊或需重拍,**不落记录**,`stage`/`stageText`/`hint` 中性引导,重拍后用**同 token** 重提)/ `confirm`(识别与填写不一致**三选一**,回带 `recognized`{realName,idCardNumber}:① 用 OCR 回填〔改 `payload.realName/idCardNumber` 重提〕② 改填写重提 ③ `payload.applicantConfirmedOcrWrong=true` 确认 OCR 错→落普通人工)/ `retry`(核验繁忙,稍后用同 token 重提)。**①②不落人工、仅③落**;`retake/confirm/retry` 均不消费 token。⚠️ 出参**绝不含风险分级**(高风险疑似造假不对申请人提示;申请人侧文案恒中性「待人工核验」) |
| **证件 OCR 识别预填 + 鉴伪版扩展回显(无状态)** | `POST /api/open/v1/recruitment/applications/recognize`(multipart;`documentTypeCode` + `idCardImage`)→ `ocrSupported`/`clarityOk`/`recognized`{realName,idCardNumber}/`antiForgeryWarnings[]`/`documentCategory`/`hint`,**+ `ocrDetail`(仅大陆身份证鉴伪版;顾问式不改判定)**:字段级 `sex`/`nation`/`birth`/`address`/`authority`/`validDate`(每栏 `{content, reflect, incomplete}` —— 用于精准提示「哪一栏反光/不完整,重点重拍」)+ `documentType`(识别证件类型)+ `cardWarnings`{copy,reshoot,ps,border,occlusion,blur}(卡片级质量/防伪)。**`ocrDetail` 为 null** = 该证件无鉴伪版扩展(护照/回乡证/未返)。⚠️ **裁剪图永不在 recognize 响应**(仅 submit 入库存档);`ocrDetail` 是建议性回显,**放行与否仍由 submit 端权威判定**(`clarityOk`/六分流不受影响)。证件图会在调用 OCR 前核对实际字节与声明 MIME,不匹配返 `13016`、不产生 OCR 调用 |
| **报名防重与 OCR 成本线(F1,v0.41.0)** | ⚠️ 行为变更:submit 在付费 OCR 前增加**同轮活跃报名去重**(除既有同证件号 `28003` 外):同微信 openid → **`28004`** / 同手机号 → **`28005`**(均 409;文案引导「查询进度 / 联系管理员」——前端命中时直接引导进 `query`/`query-by-phone`)。付费 OCR(`recognize` + `submit` 大陆分支共享)按 **IP × 北京自然日封顶**(默认 30,运维 env `RECRUITMENT_OCR_DAILY_IP_LIMIT` 可调):超限 → **`28060`(HTTP 429)**,前端提示「今日识别次数已达上限,明日再试」;识别端点契约不变(无新参数) |
| **招新本人进度②(手机;S4a)** | `POST /api/open/v1/recruitment/applications/query-by-phone`(`{phone,code}`→同进度模型;一次查询消费一码)。**F4(v0.41.0)**:发号后经账号 phone / 档案手机锚 fall-through 返 stage=volunteer 引导态(同微信 query 口径) |
| **自助撤销报名(F6,v0.41.0)** | `POST /api/open/v1/recruitment/applications/withdraw`(双通道**二选一**:`{wechatCode}` 或 `{phone,code}`〔消费一码〕)→ 非终态皆可撤,返进度模型 **stage=`withdrawn`**「已撤销报名」;已发号/未通过/已撤销 → `28052`;**撤销后同轮可重报**(同证件号/同微信/同手机都不再被占)——前端在进度页对非终态展示「撤销报名」入口,撤销成功引导「如需重新报名可直接再次提交」 |
| **证书图上传 + 审核进度(F7 + v0.43.0 刀A)** | `POST /api/open/v1/recruitment/applications/certificates`(multipart;双通道二选一:`wechatCode` 或 `phone+code`;**必填** `category ∈ {first_aid,bsafe}` + `issuingOrg`〔≤128 自由文本〕+ `issuedAt`〔YYYY-MM-DD,不得晚于今天〕+ `images` 1~3 张)→ `{category,imageCount}`。证书大类 `first_aid` 前端展示名建议「急救资质」(不限红十字会——深圳市急救中心等被认可机构的救护员证同样有效);发证机构 `issuingOrg` 自由文本,快捷项建议「红十字会 / 深圳市急救中心 / 其他手填」,后端不建机构字典。重传整类覆盖并把旧审核态复位为 `uploaded`;**已 approved 类别禁止重传**→`28054`,须联系管理员先驳回后再传。报名进度 DTO 仍为 `certificates:[{category,status,imageCount,note?}]`(本刀不改申请人进度 DTO);审核通过自动完成对应门槛,驳回清图并取消门槛。直接/批量标 redCross/bsafe 现须对应审核状态 approved,否则 `28055`(缺图仍 `28053`)。上传图片实际字节须匹配 jpeg/png 声明,不匹配返 `13016` 且不写入图片 key。**查询行为变化**:微信 `query` 与手机 `query-by-phone` 均按「最近活跃报名优先,无活跃才取最近终态,再无才走 promoted 锚」,较新的 rejected/withdrawn 不再遮蔽旧轮仍活跃报名。**发号继承审核(2026-07-14)**:招新阶段已审核通过(approved)的证书,一键发号建正式档案时**直接继承为已核验** `verified`(含审核人/时间/备注),不再进入队员端「待核验」列表二次审核;仅上传未审的类别仍为 `pending` |
| **入队申请候选部门(刀H;v0.48.0 上限收紧)** | `POST /api/app/v1/me/team-join/applications` 发起 / `GET .../applications/current` 查进度 / `PATCH .../applications/:id/targets` 改候选。候选必须属于 `openOrganizationIds`(空=全部 ACTIVE)且去重后数量 ≤ `maxTargetOrgs`;**有效上限默认/硬上限均为 2**。发起或修改传 3 项及以上由 DTO 直接返 `40000`;旧轮即使库内 `maxTargetOrgs>2`,submit/current/update 成功响应也钳制回显 `maxTargetOrgs=2`,历史已提交的 >2 部门数组仍原样展示、不作废。进度贡献值另由后端按北京日封顶 3 实时计算,v0.48.0 起历史记录也按新上限重算,数字可能变大;前端直接展示、不要自行 SUM。候选选择器须限制最多 2 项并按开放清单禁用部门;本刀不新增 pre-submit 轮次查询端点,首提交流程的部门数据来源沿现有产品配置/前端交付同步。**⚠️ Harness 3.0 P2(Unreleased)schema 更名**:查进度响应里 `gates[]` 的 OpenAPI schema 名由 `GateStatusDto` 改为 `AppGateStatusDto`(App 与管理面 DTO 物理解耦,由 eslint 机器强制)。**字段与语义逐字段不变**(code / professional / marked / passed / satisfied / completionDate / extendedUntil,required 集合亦不变),仅影响按 OpenAPI 生成客户端类型的项目 —— 重新 codegen 后把引用的类型名改掉即可,无运行时行为变化 |
| **自助换绑(无账号;S4a)** | `POST .../applications/rebind-wechat`(`{phone,code,newWechatCode}`,当前手机验码校验本人→换 openid) · `POST .../applications/rebind-phone`(`{phone,code,newPhone,newPhoneCode}`,双验→换手机+换绑历史) |
| **会员站内信 feed(统一通知 S1)** | `GET /api/app/v1/notifications`(分页 feed,每项带 `read` 已读标志)· `GET .../notifications/unread-count`(未读红点 badge:`{unreadCount}`)· `GET .../notifications/{id}`(详情含 body;**不自动已读**)· `POST .../notifications/{id}/read`(标记已读;**幂等**,二次 no-op 不重复计数)。准入 canUseApp(否则 403);**4 档可见性**(member/formal_member/department/management,**去 public**,复用 content.visibility)。`formal_member` 只认 ACTIVE 且 `gradeCode∈level-1..level-7`；`department` 独立按当前 activeOrgIds，二者不互相推导。不可见/未发布通知 → 404 防枚举。出参零敏感(无 authorUserId/visibleOrganizationIds/statusCode/readCount) |
| **微信订阅授权上报 / 查配额(统一通知 S2)** | `POST /api/app/v1/notifications/subscriptions/ack`(`{templateIds:[...]}` → 各模板 `availableCount`;**前端在 `wx.requestSubscribeMessage` 用户接受后调本端点上报授权**)· `GET .../subscriptions/status?templateIds=a,b`(逗号分隔 → 各模板剩余配额)。准入 canUseApp(否则 403)。**补授权交互**:小程序高频按钮点击后调 `wx.requestSubscribeMessage` 拿一次授权 → 接受则 ack 上报(后端 quota **+1 封顶 5**);**ack 本质 additive 非去重幂等**(微信无授权回执 ID,可累积,靠封顶 + 前端只在真授权后上报缓解);后端真正发送时扣 1,配额耗尽即停发 → 前端据 `status` 的 `availableCount` 判断**何时再次引导用户补授权**。**前端只拿授权 + 上报,绝不直接发消息**(发送权全在后端 publish 派发);**templateId = 小程序后台订阅消息模板 ID,须与后端模板配置一致**(后端 admin 配置 `notification-wechat-templates`) |
| **系统定向通知(统一通知 S3;发号/入队)** | **无新端点** —— 复用上面 S1 feed 4 端点。招新**发号**(转志愿者发永久编号)和**入队**(志愿者→队员)完成后,后端自动向当事队员发一条 `notificationTypeCode='recruitment'` 的**定向**站内信(发号那条 `channels` 含 wechat,若该会员订阅了 recruitment 模板则也推一条订阅消息;入队那条仅站内)。**定向通知仅本人 feed 可见**(他人列表不含、详情/标已读 → 404 防枚举);展示与广播通知同形(title/body/read/pinned/publishedAt)。**前端无需特殊处理**:发号/入队后引导用户回站内信即可看到;发号成功**正是引导用户 `wx.requestSubscribeMessage` 订阅 recruitment 模板的好时机**(后续节点订阅消息触达)。报名**前**阶段(报名受理/转人工/门槛/评定/公示)**无定向通知**——申请人那时还没账号/队员身份,仍走 `query`/`query-by-phone` **查询进度**(见上「招新本人进度」)|
| **活动域系统通知(已发 v0.50.0)** | **无新端点** —— 继续复用 S1 feed 4 端点、仅站内 `channels=['in-app']`:公开活动发布 → `activity-published` 会员广播;时间/地点变更、活动取消、队员取消已通过报名 → `activity-changed`;报名审批通过/驳回及候补自动递补进入待审 → `registration-result`;考勤终审 → `attendance-result`;开场前 24 小时仅向仍为 `pass` 的报名者发一次 `activity-reminder`。定向通知仅本人 feed 可见;广播按既有会员可见性展示。前端按 `notificationTypeCode` 选图标/文案即可,红点与已读复用 S1。|

> 任务→端点的细化(注册流、入队流等)等建仓时按真实页面补,别提前臆造。
> **登录态身份换绑**:step-up proof 固定 5 分钟且绑定 user + action + 当前 credential snapshot；换绑前 credentials 已变化、proof 过期/签名错/user 或 action 不匹配都统一 `10008`，前端应丢弃 proof 并重新 step-up。当前账号没有所选 phone/openid 因子返 `10009`，可切换 password 等可用因子。真实换绑会撤销该账号所有 refresh，当前旧 access 不主动吊销；成功后应重新登录建立新 refresh family。同目标 no-op 不撤 session。
> **H5 链失败码**:验码错/过期统一 `24010`;token 无效/过期/已用 `28050`;无 open 轮 `28030`;换微信撞他人 `28051`;无报名 `28002`。
> **⚠️ S5 语义变(v0.31.0)**:`GET /api/app/v1/me`(及任何回带 `Member.gradeCode` 的 app 出参)对**未入队志愿者**现返 `gradeCode='volunteer'`(S5 前恒 `null`)。前端**勿再用 `gradeCode==null` 等价"志愿者/未入队"**;"是否正式队员"应判 `gradeCode ∈ level-1..7`。历史(S5 前)发号的志愿者仍为 `null`,故"未入队志愿者"= `gradeCode ∈ {null, 'volunteer'}`。

### 1.3 企业微信登录与绑定(T3,2026-08-02;冻结稿 `docs/archive/reviews/wecom-integration-t0-terminal-review.md`)

> ⚠️ **第一版只面向企业微信客户端工作台 H5**(D-WC-29)。PC 管理后台登录**一字不动**,小程序也不消费本节。
> ⚠️ **默认关闭**(D-WC-24):`wecom_settings.loginEnabled` 默认 false,五个端点在关闭时一律 `36030`。上线前由运维在
> `system/v1/wecom-settings` 打开,并确认企业微信后台已登记可信域名(那一条只有真实 OAuth 回跳能验证)。
> ⚠️ **命名**:WeCom = 企业微信,与微信小程序(`wechat` / `openid` / 250xx)**是两个外部主体**,错误码、端点、身份键都不共用。

> 🔴 **破坏性变更(2026-08-03,P1-27 第一刀 B1)—— 前端必须适配,否则整条企业微信登录链 100% 失败。**
> 详见下方 §1.3.1。一句话:企业微信登录/绑定的**每一个**请求都必须带上 Cookie
> (`fetch` 加 `credentials: 'include'`,`axios` 加 `withCredentials: true`)。

**登录四步(前端逐步照做)**

| 步 | 端点 | 前端要做的事 |
|---|---|---|
| ① 取授权 URL | `POST /api/auth/v1/login-wecom/authorize`,body 可选 `{returnPath}` | 拿到 `{authorizeUrl, expiresAt}` 后**整串直接跳转**。⚠️ 不要解析或重写其中任何参数(`state` 只在这里出现一次)。⚠️ **必须带 `credentials:'include'`** —— 这一步的响应带一个 `Set-Cookie`,丢了它第 ③ 步必失败(§1.3.1)。`returnPath` 只接受**站内相对路径**,绝对 URL / `//` / 反斜杠 / 控制字符 / userinfo / query 里的凭证类 key(`token` `code` `state` `key` `sig` … 含 camelCase 如 `refreshToken`)一律 `40000` |
| ② 企业微信回跳 | 固定落地页 `<webBaseUrl>/auth/wecom/callback?code=…&state=…` | 页面**立即** POST 到步骤 ③,随后 `history.replaceState` 清理地址栏。⚠️ `code` / `state` **禁止**进入埋点、错误上报、localStorage / sessionStorage 或任何日志 |
| ③ 换会话 | `POST /api/auth/v1/login-wecom` body `{code, state}` | ⚠️ **必须带 `credentials:'include'`**(§1.3.1)。出参恒 4 字段 `{bindingRequired, bindingTicket, session, returnPath}`。已绑定 → `bindingRequired:false` + `session`(与密码登录**同一个** `LoginResponseDto`,双计时器语义一致);未绑定 → `bindingRequired:true` + 一次性 `bindingTicket`(默认 10 分钟),`session:null` |
| ④ 未绑定分流 | 见下 | 必须**同时**给出两条入口,不要只给路径 A |

#### 1.3.1 🔴 浏览器关联 Cookie(2026-08-03 新增,破坏性)

**为什么加**:原来的 `state` 只证明"这条回跳对应后端签发过的一次授权",**不证明"提交回跳的浏览器就是发起授权的那个"**。
攻击者在自己那侧走完企业微信授权拿到 `code + state`,再把它塞进受害者的浏览器(一条链接就够),
受害者提交后拿到的是**攻击者身份**的会话;若攻击者的企业微信号尚未绑定任何账号,受害者会在自己页面上
看到"请输入手机号 + 短信码",照做之后**攻击者的企业微信号就被绑到受害者账号**上 —— 完整账号接管。
(这条不是推演:修复前已端到端复现。)

**后端做了什么**:`authorize` 现在额外下发一个 `HttpOnly` Cookie,`state` 由它派生;
`login-wecom` / `PUT me/wecom` 必须同时收到匹配的 Cookie 才受理。

| Cookie 名 | 由谁下发 | 谁必须带上 |
|---|---|---|
| `__Host-srvf_wecom_login` | `POST auth/v1/login-wecom/authorize` | `POST auth/v1/login-wecom` |
| `__Host-srvf_wecom_bind` | `POST auth/v1/wecom-bind/authorize` | `PUT app/v1/me/wecom` |

属性固定 `HttpOnly; Secure; SameSite=Lax; Path=/`,有效期与 `state` 同为 5 分钟,消费后由后端清除。

**前端要改的**(共三处,漏一处该流程恒 `36010`):

1. 上表四个端点的请求全部加 `credentials: 'include'`(`axios` 是 `withCredentials: true`)。
   `authorize` 和它对应的提交请求**必须成对**都带 —— 只在提交那一步带,Cookie 根本没存下来。
2. **不要**尝试读取、转发或存储这个 Cookie:它是 `HttpOnly`,JS 读不到,这是设计。
   照旧**禁止**把 `code` / `state` 放进 localStorage / sessionStorage / 埋点 / 错误上报。
3. 用户中途换浏览器、清了 Cookie、或流程超过 5 分钟 → `36010`。文案沿用既有"登录已失效,请重新发起",
   **不要**新增可区分的提示(它与 `code` 无效、账号停用共用同一个码,这是防枚举的一部分)。

> ⚠️ **部署前提(运维 / 架构,不是前端能解决的)**:回跳页所在 origin 必须与 API **同源**,
> 或至少与 API **同 site**(同一 eTLD+1,例如 `app.example.com` ↔ `api.example.com`)。
> 若两者跨 site,浏览器不会带这个 Cookie,且当前后端 CORS **没有开** `Access-Control-Allow-Credentials`
> —— 跨源部署需要先补这一项(不在本次改动范围内)。上线前请以真实域名实测走通一次。

**未绑定时必须同时展示两条入口(冻结产品行为,不可只做一条)**

- **路径 A(手机号锚定)**:`POST auth/v1/wecom-bind/send-code` `{bindingTicket, phone}` → `POST auth/v1/wecom-bind` `{bindingTicket, phone, smsCode}`,成功直接返 `LoginResponseDto`。
- **路径 B(原账号登录后绑)**:引导用户用**原有任意可用方式**登录(密码 / 验证码 / 微信),再走下面的登录态换绑。
  这是**未绑定手机号、收不到短信、或不便用短信**用户的正式兜底,不是人工改库。

**前端不得据响应推断账号是否存在**:`send-code` 对「号码不存在 / 该账号没绑手机号 / 账号停用 / 已软删 / 号码与账号不一致」返回与有效号
**逐字段完全相同**的 200 且不发短信;`wecom-bind` 一切号码/验证码问题统一 `24010`。收不到短信时只能提示"可使用原账号登录后绑定",
**不能**提示"该手机号未注册/账号已停用"之类。后端也不返回 `hasPhone`、手机号尾号或账号状态。

**登录态绑定 / 换绑(路径 B 的后半段,也是日常换绑入口)**

1. `POST /api/auth/v1/wecom-bind/authorize`(**需登录**)拿 `authorizeUrl` → 跳转 → 回跳拿 `code` + `state`;
2. 按当前可用因子做一次 step-up,`action` 传 `WECOM_BIND`,拿 `stepUpToken`;
3. `PUT /api/app/v1/me/wecom` body `{code, state, stepUpToken}` → 返 `AppMeWecomDto`。

⚠️ **换绑成功后必须重新登录**:真实变更会撤销该账号**全部** refresh token(旧 access token 按 15 分钟自然到期,不主动吊销)。
⚠️ **step-up proof 绑定"当前身份状态"**:管理员刚清除绑定后,5 分钟内签发的旧 proof 立即失效(`10008`)—— 重新 step-up 即可,不是 bug。
⚠️ 绑同一个企业微信号是**幂等**的:不重写、不撤 refresh、不写审计,直接返当前状态。

**失败码速查**

| 码 | HTTP | 含义与前端动作 |
|---|---:|---|
| `36010` | 400 | state / code 无效或过期、非本企业成员(外部联系人 / 跨企业)、绑定账号不可用 —— **一律同码同形,不可据此判断原因**。动作:回到步骤 ① 重新发起 |
| `36011` | 401 | binding ticket 无效 / 过期 / 已用。动作:回到步骤 ① 重新走一遍 OAuth |
| `36002` | 409 | 该企业微信身份已绑在**其他账号**上。动作:提示联系管理员先清除 |
| `36030` | 503 | 通道未配置或开关关闭。动作:提示"企业微信登录暂未开放" |
| `36031` | 502 | 企业微信上游 / 网络 / 超时。动作:提示稍后重试 |
| `24010` | 400 | 手机号或短信验证码问题(路径 A;**不区分子原因**) |
| `10008` | 401 | step-up proof 无效 / 过期 / 身份状态已变。动作:重新 step-up |
| `42900` | 429 | 限流(第 11 个独立计数器 `login-wecom`,默认 IP 5 次/60 秒,与其他限流互不影响;`send-code` / `bind` 另叠既有短信限流) |

**⚠️ 试点期运维状态(T6,2026-08-02;只登记,细节在 ops 文档)**

首轮上线是 **10–30 人分层试点**,企业微信应用可见范围**只含名单内成员**。对前端的三条影响:

1. **不在名单内的人根本打不开这个应用** —— 他们不会走到本节任何一步。企业微信登录入口
   不要设计成"所有人都该看到并能用"的主入口;试点期它是一条**并存**的可选入口,
   原有登录方式(密码 / 短信 / 小程序)一字不动。
2. **通道随时可能被运维关掉**(试点验收、回滚演练都会关)。关闭期间五个端点一律 `36030` ——
   见上表,按"暂未开放"提示,**不要**当故障重试或上报。
3. **PC 浏览器扫码登录本版不做**(D-WC-29)。有用户反馈"PC 上扫不了码"是**预期行为**,不是缺陷。

运维侧怎么开、怎么关、试点怎么验收:[`ops/wecom-backend-configuration-sop.md`](../ops/wecom-backend-configuration-sop.md)
· [`ops/wecom-pilot-playbook.md`](../ops/wecom-pilot-playbook.md)。前端无需适配任何新契约。

### 1.2 自购保险 PR3 cutover 契约(D-INSURANCE v3)

- `app/v1/me/insurances` 的保险响应 additive 增加 `reviewStatusCode`(`pending|verified|rejected`)、`version`、`reviewedAt`;不返回 reviewer 身份。客户端应保存每次成功响应中的新 `version`。
- `PATCH /api/app/v1/me/insurances/:id` 在 body 回传 `expectedVersion`;`DELETE` 同路径在 query 回传 `expectedVersion`。OpenAPI/客户端契约自 PR3 起均为**必填**；single gate=true 时缺失、`null`、空串或纯空白统一 `40000`，并保证 0 mutation/0 audit。显式旧版本仍返 `26011`：先刷新该保险、保留用户输入并让用户确认后再重试，禁止拿旧版本盲重放。
- 实质 PATCH 会 `version + 1` 并把审核态重置为 `pending`、清空审核责任时间；空 body、仅 `expectedVersion`、trim 后相同字符串或北京 date-only 相同都是真 no-op，`version/status/updatedAt` 不变。DELETE 会 `version + 1`，但保留删除前审核态与审核责任时间。
- single gate=true 后，`requiresInsurance=true` 的活动只接受覆盖完整北京日区间的 **verified 自购保险**，否则再尝试 live 团队保单覆盖；pending/rejected/软删/日期不覆盖都返既有 `26030`。报名成功会在同一事务生成恰一条最小 evidence，前端无新字段可消费；evidence 不保存保险公司、保单号、note/reason、图片/key/URL。
- PR4 + 第 82 migration/约束与 revision-bound runtime 已交付但未 production deploy；新报名/重报 evidence 绑定当次 RegistrationRevision，旧 header-only evidence 不回填。上线须 drain 后由维护者独立 deploy D81/D82+探针，并保持 drain 整批切 runtime exact SHA，禁新旧混跑/旧版回滚。**没有新增 route、DTO 或前端字段，客户端契约 0 diff**。
- gate=false 保留 PR2 运行时兼容（缺版本仍可接受、活动 consumer 旧语义、0 evidence）；这只是 rollout 档位，不改变客户端“expectedVersion 必填”的终态契约。维护者于 2026-07-19 仅确认“旧客户端都没上线，放心操作执行”，**没有验证旧 server=0**；本 PR 不部署/启用。production 切 true 前必须 drain 全部旧 server/旧事务，并确保 fleet 不出现 true/false 混跑。Admin final join 与配置细节见 [`admin-web.md §2.2`](admin-web.md)。

### 2.1 活动 GPS 自助打卡(F2)

- **定位权限**：点击签到/签退后先请求定位权限；用户拒绝或客户端没有完整经纬度时，不发后端请求，展示重新授权指引。`accuracy` 可选且只作证据，不参与半径放大/缩小；精度很差也不能让超范围请求通过。
- **按钮初始化**：进入活动页先调 `GET .../check-in`。`22002` = 尚无当前报名打卡，显示“签到”；200 且 `checkOutAt=null` = 已签到，显示“签退”；200 且 `checkOutAt!=null` = 已完成。GET 不受活动四态额外阻断，但只读取当前 `pass` 报名。
- **⚠️ 成功态收紧**：新合法签到证据固定 `geoVerified=true/outOfRange=false`；`geoVerified=false` / `outOfRange=true` 只可能来自历史行，GET/Admin 展示仍保留。首次位置未通过不再返回 200，也不写异常证据。
- **安全重试**：网络超时可重发同一动作；状态与当前 `pass` 闸仍合法时，重复/并发请求返回同一个合法 winner，首次位置不会被后续重试覆盖。winner 已存在后，即使重试位置本身超范围也会返回旧 winner 200；这代表幂等命中，不是接受了新位置。
- **错误提示**：`22080` 活动定位缺失/非法或当前位置超出范围，统一提示“定位未通过，请确认已到活动范围内；持续失败请联系管理员核对活动定位”；`22076` 当前报名未通过/已取消；`22077` 超出有效打卡窗（有独立岗位时段则是岗位窗，否则是活动窗）；`22078` 尚未签到不可签退；`22070` 签到后不足 36 秒不可首次签退；`20030` completed 不可新签到；`20122` 活动已取消；`20126` 活动尚未发布。请求定位字段缺失、越界、小数位或夹带未知字段仍统一按 40000 表单错误处理。

### 2.2 活动报名候补与排位（审计刀 6 · 第二件）

- **满员仍是成功态**：报名响应若为 `statusCode='waitlisted'`，表示已进入候补队列，不要按异常提示“报名失败”；建议成功页显示“已进入候补，第 N 位”。
- **排位字段**：`GET /api/app/v1/my/registrations` 的列表项与详情、报名成功响应均有 `waitlistPosition:number|null`。仅 waitlisted 时从 1 开始；pending/pass/reject/cancelled 均为 null。
- **自动递补**：已有通过者取消或管理员扩容时，后端按报名时间、同时间按 id 自动扫描候补；Member inactive 或已软删的报名保持 waitlisted 且不发 audit/通知，继续递补下一名 live+ACTIVE 队员为 pending，并发送标题「候补已递补」的 `registration-result` 站内信。前端收到后刷新报名详情，展示“待审核”，**不是直接通过**。
- **退出候补**：候补沿既有取消端点退出；取消 pending 或 waitlisted 不影响其他候补排位，取消 pass 才会腾出名额并触发一人递补。
- **签到边界**：waitlisted/pending 都不能签到；只有当前 pass 报名可走 GPS 签到。`21031` 不再用于满员报名提示，但可保留旧版本兼容文案。

### 2.3 活动评价（审计刀 6 · 第三件 F2–F4）

- **入口初始化**：活动详情/我的活动进入评价区先调 GET；无评价仍是 200，`feedback=null`。按钮只看后端 `canSubmit`，倒计时以 `windowClosesAt` 为准，不在客户端自行推算。
- **提交**：PUT `{rating:1..5,comment?}`；窗口内可反复修改同一条，缺省/null comment 会清空文字。App 永远只拿本人评价，不展示人数、均分、直方图或他人内容。
- **资格**：只有 approved 考勤表内有未软删到场记录才可评；pass 报名、waitlisted 或仅 GPS 打卡都不等于评价资格。
- **提示码**：`35030` 活动未完结；`35031` 窗口已关闭；`35032` 无 approved 到场记录；`35002` 首次并发冲突时刷新 GET 后重试 PUT。rating 0/6、comment 超 500 或未知字段统一 40000。

### 2.4 活动岗位与时段（审计刀 6 · 第四件 / 收官）

- **先选岗位再报名**：对公开报名活动调用 `GET /api/app/v1/activities/:activityId/positions`，按 `sortOrder` 展示 `name/description/attendanceRoleCode/startAt/endAt/genderRequirementCode/capacity/remainingCapacity/canRegister`。`remainingCapacity=0` 不代表按钮禁用——满员仍可提交并进入候补；`capacity/remainingCapacity=null` 表示不限。不可见活动统一 20001，避免存在性枚举。
- **报名 body**：`POST /api/app/v1/my/registrations` additive 接收 `activityPositionId`，legacy 路由**没有** `operationKey`。活动有 live 岗位时必填，缺失返 `21035`；不存在/跨活动/已删返 `20002`；同人已有 pending/pass/waitlisted 报名时，换另一个岗位仍返 `21002`。无 permanent identity 的 live cancelled/reject legacy 头可由一次新提交在原头追加 revision；一旦已有 canonical/onsite identity，legacy 新请求返 `21038`，应回到 canonical/managed 流程。soft-deleted 头不复活。
- **岗位级候补**：`waitlistPosition` 只在所选岗位队列内编号；A 岗释放或扩容只递补 A 岗，不影响 B 岗。收到「候补已递补」后仍是 pending 待审核，不是 pass。
- **岗位级性别与名额**：`canRegister=false` 可由活动状态/截止、已报名、活动性别闸或岗位性别闸导致；最终提交仍会复做全部闸与活动级保险校验，客户端不可把 `canRegister` 当授权证明。活动详情 `capacity` 在有岗位时是岗位名额派生值（任一岗位不限则 null），不要再取原活动 capacity 自行判断。
- **岗位打卡窗**：报名岗位配置 `startAt/endAt` 时，签到/签退按岗位窗 ± 既有容差；岗位无独立时段或无岗位报名才沿活动窗。客户端仍只处理既有 `22077`，但提示文案应写“超出当前岗位/活动的有效打卡时间”。

### 2.x 十项收口一刀增量(2026-07-11)

- **公示落点补齐**:进度 `nextAction='view-publicity'` 终于有得跳——`GET /api/open/v1/recruitment/publicity`(无账号、throttler recruitment):`{ cycleYear, items:[{ realName, proposedMemberNo }] }`,与后台公示预览/实发同源;`proposedMemberNo` 为 null = 待人工建档;无公示中名单返 `cycleYear=null + items=[]`(渲染空态,不是错误)。
- **⚠️ stage 值域收窄**:进度接口 `stage` 不再出现 `manual_high`(公开出口折叠为 `manual`,文案本就同「待人工核验」);若曾按 `manual_high` 分支渲染,删掉该分支。
- **⚠️ submit `documentTypeCode` 白名单**:仅 `mainland_id / passport / hk_macau_permit / taiwan_permit / foreigner_permit / other` 六值,名单外 400——证件类型用选择器,别放自由输入。
- **新站内通知(additive)**:入队贡献值达标提醒(type=`recruitment`,title「入队贡献值已达标」)随考勤终审自动触达本人,复用既有 notifications 拉取端点,无新契约。

## 2.9 证书标准库(2026-07-30;PR-1 → PR-5,⚠️ 三处契约破坏)

> 冻结稿 = [`certificate-standard-library-t0-review.md`](../archive/reviews/certificate-standard-library-t0-review.md) v1.2;后台侧见 [`admin-web.md §3.2`](admin-web.md)。

小程序面被动到三处,都是**破坏性**的,不改就报错或显示错:

### ① 招新证书上传:换端点,且语义从「按类别覆盖」变成「一证一行」

| 旧 | 新 |
|---|---|
| `POST /api/open/v1/recruitment/applications/certificates`(已删,调它 404) | `POST /api/open/v1/recruitment/certificate-claims` |
| — | `POST /api/open/v1/recruitment/certificate-claims/:id/resubmit` |
| — | `POST /api/open/v1/recruitment/certificate-claims/:id/withdraw` |

- multipart 文件位仍是 `images`,**1~3 张**;凭证仍是双通道二选一(`wechatCode` 或 `phone`+`code`)。
- 入参从 `category` 改为 `categoryHintCode`(只是提示,最终分类由审核定),并可带 `rawCertificateName` / `suggestedStandardId` / `issuingOrg` / `certNumber` / `issuedAt` / `expiredAt`。
- **同类别可以交多张,互不覆盖**。重传只换那一条(要带 `version` 做 CAS,不符返 `28058`)。
- 每份报名最多 **10 条**未撤回申报,超了返 `28059`。
- 已通过的申报**本人不能改**(`28057`)—— 要改得让管理员先撤回审核。撤回后是终态,要重来就新交一条。
- 标准选择器:`GET /api/open/v1/recruitment/certificate-standards`(无需登录)。`currentlyRecognized: false` = **已收录、待认定** —— 可以选它作建议,别当成不可选。**不要自动选第一项**,要有「不确定/没找到」(§23)。

### ② 进度模型 `certificates` 变形

从「每个类别恰一条,`status ∈ none/uploaded/approved/rejected`」改为**每条申报一行**:

```text
{ claimId, version, category, rawCertificateName, status, imageCount, note }
```

`status` 直接是 Claim 六态(`SUBMITTED/NEEDS_INFO/APPROVED/REJECTED/PROMOTED/WITHDRAWN`)。数组**可能为空**,也**可能同类别多行** —— 旧形状表达不了「两张急救证一张过了一张被驳回」,这正是改它的原因。`note` 只在 `REJECTED` / `NEEDS_INFO` 有值。

### ③ `GET /api/app/v1/my/certificates` 出参与过滤都改了

| 旧 | 新 |
|---|---|
| `certTypeCode` / `certSubTypeCode` | `standardId` + `standardName` + `certCategoryCode` + `certLevelCode` |
| `isInternal`(取自证书行) | `isInternal`(字段名不变,值取自 Standard) |
| 查询参数 `?certTypeCode=` | 查询参数 **`?certCategoryCode=`**(值域不变,仍是 cert_type 字典 code) |

出参字段数 **12 → 14**。其余字段(`certNumber` 本人可见明文、`verifyNote` 本人可见、`certStatusCode`、`verifiedAt`)语义不变;仍**不**暴露审核人身份。

---

## 3. 缺口台账(gap-ledger)

> **当前运行时真值（2026-07-27）**：招新/入队、报名 L1、活动 L2、责任 L3、考勤 L4 producer 均在业务事务内写 durable intent；worker 在 commit 后执行 Notification / 微信 / SMS Effect，provider 失败进入 retry/dead 且不回滚已提交业务。App API/DTO 未变化，前端继续消费既有 feed。
>
> **历史实现，已被 2026-07-26 L1–L4 durable outbox 收口取代。** 下方 GAP-005 S1–S5 长段仅保留发布时历史，commit 后 best-effort 描述不是当前实现。

| # | 诉求 | 期望端点 | 状态 |
|---|---|---|---|
| GAP-005 | 会员站内信(向队员推送通知/公告;站内 feed + 未读红点 + 标记已读)+ 微信订阅推送 | `app/v1/notifications`(list/unread-count/detail/mark-read + subscriptions/ack·status)| ✅ **已发 v0.32.0**(S1–S5;#449–#453 → bump #454 → tag `v0.32.0` / Release Latest;2026-06-27;以下逐切片 `本 PR` / Unreleased 为交付时态历史标注)。**S1 站内信 + S2 微信订阅 quota 渠道已交付**(本 PR,Unreleased;统一通知模块前两切片,冻结评审稿 `docs/archive/reviews/unified-notification-dispatcher-review.md`)。会员侧 = 站内信 feed(**4 档可见性复用 content.visibility 去 public**)+ 未读数 badge + mark-read 幂等(见 §2);**S2 微信订阅消息 quota** = `wx.requestSubscribeMessage` 接受后 **ack 上报 → 后端 quota +1 封顶 5**,后端 publish 勾微信时按配额扣减发送(只推已订阅会员),前端据 `status` 剩余配额判补授权(见 §2「微信订阅授权上报」行)。**S3 producer 接入已交付**(本 PR,Unreleased):招新**发号 / 入队**完成后,后端自动向当事队员发**定向**站内信(`recruitment` 类型;发号另带微信),复用 S1 feed 4 端点**无新端点**,定向通知**仅本人可见**(他人 404 防枚举);**报名前 5 触发不做**(申请人非队员,仍走 `query`/`query-by-phone` 查询进度),见 §2「系统定向通知」行。**S4 活动·考勤 producer 定向触发已交付**(本 PR,Unreleased):报名审批结果 / 活动取消(遍历已报名者)/ 考勤终审结果·贡献值三处队员事件后端自动发**定向**站内信(`activity-reminder` 类型,**仅站内**,微信 opt-in 延后),复用 S1 feed **无新端点 / 0 schema / 0 新 RBAC 码 / 0 BizCode**,仅本人可见(见 §2「系统定向通知(S4)」行)。**S5 短信兜底已交付**(本 PR,Unreleased;admin 显式发起紧急召集兜底,**无 miniapp 新面**——会员仅收到「请打开 App 查看」短信)。**报名前 openid 非会员推送路 / 真·全员短信批处理异步**待后续切片另出 goal |
| GAP-006 | 招新→入队闭环「可见」(12 域:进度模型/工作台/批量/通知/H5+手机/promote 志愿者化…;T0 冻结评审稿 `docs/archive/reviews/recruitment-phase4-loop-optimization-review.md`) | 见评审稿 §12 切片表(S1–S7) | ✅ **已发 v0.31.0**(S1–S6;#439–#445 → bump #446 → tag `v0.31.0` / Release Latest;以下逐切片 Unreleased 为交付时态历史标注)。**S1–S4b**:S1 进度模型 + S2 工作台 stats + S3 RBAC 敏感分级;**S4a = H5 + 手机身份链**;**S4b = OCR 六分流 + 重拍计数**(submit 改六分流:matched→verified / 模糊·防伪首次→retake 不落 / 不一致→三选一 / 上游首次→retry;forgery·ocr_error **H5 会话连续 2 次**才落 manual_review〔high/system〕,计数落 `recruitment_identity_sessions` 预建列;application +4 列 additive 无 enum;进度模型 +retake/confirm/manual_high 三态;S2 待人工三栏升真 `riskLevel`)。**S5 = promote 志愿者化**已交付(Unreleased):发号后志愿者 `Member.gradeCode` 由 `null` 改 `'volunteer'` + 挂 VOL 归口部门 → **`GET /api/app/v1/me` 的 `gradeCode` 对志愿者现返 `'volunteer'`(此前 null;详见 §2 ⚠️ 语义变)**。**S6 = 批量操作**已发(批量标门槛 / 导出 CSV / 发号预检,纯加端点零 schema / 零新 RBAC 码);**S7 通知闭环 = 部分交付**(本 PR,Unreleased,经 GAP-005 S3):**发号 / 入队**2 触发(申请人已是队员)接入统一通知 → 当事队员收系统定向站内信(发号另带微信);**报名前 5 触发**(报名受理/转人工/门槛/评定/公示)非队员够不着 → 维持 `query`/`query-by-phone` **查询进度 pull**(openid 非会员推送路另立项)。 |

> **GAP-005 活动域扩展关账（2026-07-15;已随 v0.50.0 发版）**:上方历史行中的“三处事件共用 `activity-reminder`”仅代表 v0.32.0 发布时口径；现由 `activity-published` / `activity-changed` / `registration-result` / `attendance-result` 分型，`activity-reminder` 仅保留开场前 24 小时一次性提醒，并补齐发布广播、时间/地点变更与队员退出事件。无新 App 端点。

## 4. 不馊

改 App surface / 契约 → 同 PR 改本文件 + `pnpm docs:openapi`(沿 [`AGENTS.md`](../../AGENTS.md) 反漂铁律);"改什么必须动哪篇哪节"的逐行对照见 [`README.md §2`](README.md)。
