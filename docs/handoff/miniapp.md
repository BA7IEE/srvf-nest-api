# 交接:后端 ↔ 小程序前端

> **骨架占位**(小程序前端仓尚未建)。先把 App surface 模型 + 铁律就位,将来建仓直接填能力图。
> canonical 在后端仓;字段真相 = live `/api/docs-json`;见 [`README.md`](README.md)。

---

## 1. App surface 模型(和 admin 完全不同,先读铁律)

小程序消费 **`/api/app/v1/*`**(队员**本人视角**),不是 admin 面。后端语义锁(`api-surface-policy.md §9`):

- **准入**:App 要求 `User.memberId != null` + `User.status=ACTIVE` + 绑定 `Member.status=ACTIVE`;不满足 → `canUseApp=false`。候选人 / 临时号**进不来** App。
- **scope=self**:App 端 where 永远用 `currentUser.memberId` 锁本人;后端不靠 role 放大数据范围(ADMIN 登 App 也只看本人)。
- **`/me` vs `/my`**:`/me/*` = 身份/账号/资料/能力;`/my/*` = 本人持有的业务记录。别混。
- **capability ≠ raw RBAC**:`GET /api/app/v1/me/capabilities` 返**产品级**能力(`canUseApp` / `canRegisterActivity`…),**不返** raw 权限码(raw 码是 admin 的 `system/v1/rbac/me/permissions`)。
- **L3 永不回**:App 永不返 `passwordHash` / `refreshToken` / `secretKey*` / 完整 signed URL。

## 2. 能力图(现有 App 端点;按任务填)

| 任务 | 端点 |
|---|---|
| 登录 | `POST /api/auth/v1/login`(密码) · `login-sms`(验证码) · `login-wechat`(小程序 openid;未绑返 `bindingRequired`) |
| 我的身份/资料/能力 | `GET /api/app/v1/me` · `me/account` · `PATCH me/profile` · `PUT me/password` · `GET me/capabilities` |
| 活动池 / 我的活动 | `GET /api/app/v1/activities`(**v0.40.0:已结束〔`endAt < now`〕活动不再出现在可报名池;活动详情 `GET /api/app/v1/activities/:id` 口径不变,已报名者仍能回看已结束活动**) · `GET /api/app/v1/my/activities` |
| 我的报名(报名/查/取消) | `GET /api/app/v1/my/registrations` · `POST` 报名(**v0.40.0:活动已结束 `endAt < now` → `20125`「活动已结束,不可报名」;报名截止 `registrationDeadline` 仍为独立闸 `20123`**)· `PATCH` 取消(**v0.40.0:该报名已有考勤记录 → `21033`「报名已有考勤记录,不可取消」**) |
| 我的考勤 / 证书 | `GET /api/app/v1/my/attendance-records` · `GET /api/app/v1/my/certificates` |
| 公开(无账号) | `POST /api/open/v1/recruitment/applications/*`(招新报名) · `GET /api/open/v1/contents`(内容) |
| 招新本人进度(无账号) | `POST /api/open/v1/recruitment/applications/query`(凭 wx.login code 换 openid;**返进度模型**:业务态 `stage` + 字典 `stageText` + `nextAction` + 门槛 `todoList` 真投影 + 临时编号;`memberNo` 恒 null——发号后经登录态 app 侧查,见 §3 GAP-006)。**F4(v0.41.0-pre)**:发号后(报名行 openid 已清)不再「查无 28002」——经账号 openid 锚 fall-through 返 **stage=volunteer 引导态**(「已转志愿者 / 待入队」+ `nextAction=apply-teamjoin`),前端见此态引导用户登录小程序/申请入队;已离队(INACTIVE)或非招新出身仍 28002 |
| **H5 报名前手机身份链(无账号;S4a)** | `POST /api/open/v1/recruitment/identity/send-code`(`{phone}`→发验证码) → `POST .../identity/verify-code`(`{phone,code}`→返一次性 `phoneVerificationToken`〔30min,明文仅返一次〕) → 提交报名(见下行 H5 链)。**F4(v0.41.0-pre)**:闭轮期两端点对「手机命中未清除报名记录」者放行(自助查询/换绑链闭轮不再断);闭轮陌生手机 send-code 返防枚举泛化 200(不真发码),verify-code 统一 24010——前端不必对闭轮做特殊分支 |
| **H5 报名提交(无账号;S4a)** | `POST /api/open/v1/recruitment/applications`(multipart;`payload` JSON 内 **`phoneVerificationToken`**〔H5〕或 `wechatCode`〔小程序〕**至少二选一**;`payload.phone` 须与验证手机一致;小程序链向后兼容不变)。**⚠️ 契约收紧(Unreleased)**:`payload` **必含 `privacyConsentAccepted: true`**,multipart **必含 `signatureImage`**(jpeg/png ≤5MB,申请人手写签名图;任一缺省/false → 40000,旧版本前端会全量 400——发版前必须同步升级);可选 `privacyConsentVersion`(同意文本版本号,建议随文案版本迭代);签名图发号后随队员档案长期留存。**前端必须先完成签名采集再允许提交**,不可再省略该文件位 |
| **OCR 六分流提交结果(S4b)** | 同上 submit 端点出参由 `RecruitmentSubmitResultDto.outcome` 区分:`submitted`(已落记录,`statusCode`=verified/manual_review + `tempNo`)/ `retake`(证件照模糊或需重拍,**不落记录**,`stage`/`stageText`/`hint` 中性引导,重拍后用**同 token** 重提)/ `confirm`(识别与填写不一致**三选一**,回带 `recognized`{realName,idCardNumber}:① 用 OCR 回填〔改 `payload.realName/idCardNumber` 重提〕② 改填写重提 ③ `payload.applicantConfirmedOcrWrong=true` 确认 OCR 错→落普通人工)/ `retry`(核验繁忙,稍后用同 token 重提)。**①②不落人工、仅③落**;`retake/confirm/retry` 均不消费 token。⚠️ 出参**绝不含风险分级**(高风险疑似造假不对申请人提示;申请人侧文案恒中性「待人工核验」) |
| **证件 OCR 识别预填 + 鉴伪版扩展回显(无状态)** | `POST /api/open/v1/recruitment/applications/recognize`(multipart;`documentTypeCode` + `idCardImage`)→ `ocrSupported`/`clarityOk`/`recognized`{realName,idCardNumber}/`antiForgeryWarnings[]`/`documentCategory`/`hint`,**+ `ocrDetail`(仅大陆身份证鉴伪版;顾问式不改判定)**:字段级 `sex`/`nation`/`birth`/`address`/`authority`/`validDate`(每栏 `{content, reflect, incomplete}` —— 用于精准提示「哪一栏反光/不完整,重点重拍」)+ `documentType`(识别证件类型)+ `cardWarnings`{copy,reshoot,ps,border,occlusion,blur}(卡片级质量/防伪)。**`ocrDetail` 为 null** = 该证件无鉴伪版扩展(护照/回乡证/未返)。⚠️ **裁剪图永不在 recognize 响应**(仅 submit 入库存档);`ocrDetail` 是建议性回显,**放行与否仍由 submit 端权威判定**(`clarityOk`/六分流不受影响) |
| **报名防重与 OCR 成本线(F1,v0.41.0-pre)** | ⚠️ 行为变更:submit 在付费 OCR 前增加**同轮活跃报名去重**(除既有同证件号 `28003` 外):同微信 openid → **`28004`** / 同手机号 → **`28005`**(均 409;文案引导「查询进度 / 联系管理员」——前端命中时直接引导进 `query`/`query-by-phone`)。付费 OCR(`recognize` + `submit` 大陆分支共享)按 **IP × 北京自然日封顶**(默认 30,运维 env `RECRUITMENT_OCR_DAILY_IP_LIMIT` 可调):超限 → **`28060`(HTTP 429)**,前端提示「今日识别次数已达上限,明日再试」;识别端点契约不变(无新参数) |
| **招新本人进度②(手机;S4a)** | `POST /api/open/v1/recruitment/applications/query-by-phone`(`{phone,code}`→同进度模型;一次查询消费一码)。**F4(v0.41.0-pre)**:发号后经账号 phone / 档案手机锚 fall-through 返 stage=volunteer 引导态(同微信 query 口径) |
| **自助撤销报名(F6,v0.41.0-pre)** | `POST /api/open/v1/recruitment/applications/withdraw`(双通道**二选一**:`{wechatCode}` 或 `{phone,code}`〔消费一码〕)→ 非终态皆可撤,返进度模型 **stage=`withdrawn`**「已撤销报名」;已发号/未通过/已撤销 → `28052`;**撤销后同轮可重报**(同证件号/同微信/同手机都不再被占)——前端在进度页对非终态展示「撤销报名」入口,撤销成功引导「如需重新报名可直接再次提交」 |
| **证书图上传(F7,v0.41.0-pre)** | `POST /api/open/v1/recruitment/applications/certificates`(multipart;双通道**二选一**:`wechatCode` 或 `phone+code`〔消费一码〕;`category ∈ {first_aid, bsafe}` + `images` 文件 1~3 张〔jpeg/png 每张 ≤5MB〕)→ `{category, imageCount}`。**重传整类覆盖**(旧图即删);终态行(已发号/未通过/已撤销)→ `28041`。发号时按类别自动建 pending 证书档案(admin 核验);红十字/BSAFE 门槛勾选仍由 admin 决定——上传只是自证材料,前端在门槛 todoList 旁提供「上传证书」入口即可 |
| **自助换绑(无账号;S4a)** | `POST .../applications/rebind-wechat`(`{phone,code,newWechatCode}`,当前手机验码校验本人→换 openid) · `POST .../applications/rebind-phone`(`{phone,code,newPhone,newPhoneCode}`,双验→换手机+换绑历史) |
| **会员站内信 feed(统一通知 S1)** | `GET /api/app/v1/notifications`(分页 feed,每项带 `read` 已读标志)· `GET .../notifications/unread-count`(未读红点 badge:`{unreadCount}`)· `GET .../notifications/{id}`(详情含 body;**不自动已读**)· `POST .../notifications/{id}/read`(标记已读;**幂等**,二次 no-op 不重复计数)。准入 canUseApp(否则 403);**4 档可见性**(member/formal_member/department/management,**去 public**,复用 content.visibility);不可见/未发布通知 → 404 防枚举。出参零敏感(无 authorUserId/visibleOrganizationIds/statusCode/readCount) |
| **微信订阅授权上报 / 查配额(统一通知 S2)** | `POST /api/app/v1/notifications/subscriptions/ack`(`{templateIds:[...]}` → 各模板 `availableCount`;**前端在 `wx.requestSubscribeMessage` 用户接受后调本端点上报授权**)· `GET .../subscriptions/status?templateIds=a,b`(逗号分隔 → 各模板剩余配额)。准入 canUseApp(否则 403)。**补授权交互**:小程序高频按钮点击后调 `wx.requestSubscribeMessage` 拿一次授权 → 接受则 ack 上报(后端 quota **+1 封顶 5**);**ack 本质 additive 非去重幂等**(微信无授权回执 ID,可累积,靠封顶 + 前端只在真授权后上报缓解);后端真正发送时扣 1,配额耗尽即停发 → 前端据 `status` 的 `availableCount` 判断**何时再次引导用户补授权**。**前端只拿授权 + 上报,绝不直接发消息**(发送权全在后端 publish 派发);**templateId = 小程序后台订阅消息模板 ID,须与后端模板配置一致**(后端 admin 配置 `notification-wechat-templates`) |
| **系统定向通知(统一通知 S3;发号/入队)** | **无新端点** —— 复用上面 S1 feed 4 端点。招新**发号**(转志愿者发永久编号)和**入队**(志愿者→队员)完成后,后端自动向当事队员发一条 `notificationTypeCode='recruitment'` 的**定向**站内信(发号那条 `channels` 含 wechat,若该会员订阅了 recruitment 模板则也推一条订阅消息;入队那条仅站内)。**定向通知仅本人 feed 可见**(他人列表不含、详情/标已读 → 404 防枚举);展示与广播通知同形(title/body/read/pinned/publishedAt)。**前端无需特殊处理**:发号/入队后引导用户回站内信即可看到;发号成功**正是引导用户 `wx.requestSubscribeMessage` 订阅 recruitment 模板的好时机**(后续节点订阅消息触达)。报名**前**阶段(报名受理/转人工/门槛/评定/公示)**无定向通知**——申请人那时还没账号/队员身份,仍走 `query`/`query-by-phone` **查询进度**(见上「招新本人进度」)|
| **系统定向通知(统一通知 S4;考勤结果/报名审批/活动取消)** | **无新端点** —— 同样复用 S1 feed 4 端点(`notificationTypeCode='activity-reminder'`,**仅站内** `channels=['in-app']`,微信 opt-in 延后)。三处队员事件后端自动发**定向**站内信:① **报名审批结果**——管理端通过/驳回某报名后,报名本人收「报名已通过」/「报名未通过」(含活动名 + 驳回理由若有);② **活动取消**——某活动取消后,**所有已报名者**(pending 待审 + pass 已通过)各收一条「活动已取消」(含活动名 + 取消原因;reject/cancelled 报名者不收);③ **考勤结果/贡献值**——考勤表终审通过后,该表内**每位队员**收一条「考勤结果已确认」(含活动名 + 本次贡献值)。**定向通知仅本人 feed 可见**(他人 404 防枚举);展示同形。**前端无需特殊处理**:队员回站内信即见;红点 / 已读复用 S1。|

> 任务→端点的细化(注册流、入队流等)等建仓时按真实页面补,别提前臆造。
> **H5 链失败码**:验码错/过期统一 `24010`;token 无效/过期/已用 `28050`;无 open 轮 `28030`;换微信撞他人 `28051`;无报名 `28002`。
> **⚠️ S5 语义变(Unreleased)**:`GET /api/app/v1/me`(及任何回带 `Member.gradeCode` 的 app 出参)对**未入队志愿者**现返 `gradeCode='volunteer'`(S5 前恒 `null`)。前端**勿再用 `gradeCode==null` 等价"志愿者/未入队"**;"是否正式队员"应判 `gradeCode ∈ level-1..7`。历史(S5 前)发号的志愿者仍为 `null`,故"未入队志愿者"= `gradeCode ∈ {null, 'volunteer'}`。

### 2.x 十项收口一刀增量(2026-07-11)

- **公示落点补齐**:进度 `nextAction='view-publicity'` 终于有得跳——`GET /api/open/v1/recruitment/publicity`(无账号、throttler recruitment):`{ cycleYear, items:[{ realName, proposedMemberNo }] }`,与后台公示预览/实发同源;`proposedMemberNo` 为 null = 待人工建档;无公示中名单返 `cycleYear=null + items=[]`(渲染空态,不是错误)。
- **⚠️ stage 值域收窄**:进度接口 `stage` 不再出现 `manual_high`(公开出口折叠为 `manual`,文案本就同「待人工核验」);若曾按 `manual_high` 分支渲染,删掉该分支。
- **⚠️ submit `documentTypeCode` 白名单**:仅 `mainland_id / passport / hk_macau_permit / taiwan_permit / foreigner_permit / other` 六值,名单外 400——证件类型用选择器,别放自由输入。
- **新站内通知(additive)**:入队贡献值达标提醒(type=`recruitment`,title「入队贡献值已达标」)随考勤终审自动触达本人,复用既有 notifications 拉取端点,无新契约。

## 3. 缺口台账(gap-ledger)

| # | 诉求 | 期望端点 | 状态 |
|---|---|---|---|
| GAP-005 | 会员站内信(向队员推送通知/公告;站内 feed + 未读红点 + 标记已读)+ 微信订阅推送 | `app/v1/notifications`(list/unread-count/detail/mark-read + subscriptions/ack·status)| ✅ **已发 v0.32.0**(S1–S5;#449–#453 → bump #454 → tag `v0.32.0` / Release Latest;2026-06-27;以下逐切片 `本 PR` / Unreleased 为交付时态历史标注)。**S1 站内信 + S2 微信订阅 quota 渠道已交付**(本 PR,Unreleased;统一通知模块前两切片,冻结评审稿 `docs/archive/reviews/unified-notification-dispatcher-review.md`)。会员侧 = 站内信 feed(**4 档可见性复用 content.visibility 去 public**)+ 未读数 badge + mark-read 幂等(见 §2);**S2 微信订阅消息 quota** = `wx.requestSubscribeMessage` 接受后 **ack 上报 → 后端 quota +1 封顶 5**,后端 publish 勾微信时按配额扣减发送(只推已订阅会员),前端据 `status` 剩余配额判补授权(见 §2「微信订阅授权上报」行)。**S3 producer 接入已交付**(本 PR,Unreleased):招新**发号 / 入队**完成后,后端自动向当事队员发**定向**站内信(`recruitment` 类型;发号另带微信),复用 S1 feed 4 端点**无新端点**,定向通知**仅本人可见**(他人 404 防枚举);**报名前 5 触发不做**(申请人非队员,仍走 `query`/`query-by-phone` 查询进度),见 §2「系统定向通知」行。**S4 活动·考勤 producer 定向触发已交付**(本 PR,Unreleased):报名审批结果 / 活动取消(遍历已报名者)/ 考勤终审结果·贡献值三处队员事件后端自动发**定向**站内信(`activity-reminder` 类型,**仅站内**,微信 opt-in 延后),复用 S1 feed **无新端点 / 0 schema / 0 新 RBAC 码 / 0 BizCode**,仅本人可见(见 §2「系统定向通知(S4)」行)。**S5 短信兜底已交付**(本 PR,Unreleased;admin 显式发起紧急召集兜底,**无 miniapp 新面**——会员仅收到「请打开 App 查看」短信)。**报名前 openid 非会员推送路 / 真·全员短信批处理异步**待后续切片另出 goal |
| GAP-006 | 招新→入队闭环「可见」(12 域:进度模型/工作台/批量/通知/H5+手机/promote 志愿者化…;T0 冻结评审稿 `docs/archive/reviews/recruitment-phase4-loop-optimization-review.md`) | 见评审稿 §12 切片表(S1–S7) | ✅ **已发 v0.31.0**(S1–S6;#439–#445 → bump #446 → tag `v0.31.0` / Release Latest;以下逐切片 Unreleased 为交付时态历史标注)。**S1–S4b**:S1 进度模型 + S2 工作台 stats + S3 RBAC 敏感分级;**S4a = H5 + 手机身份链**;**S4b = OCR 六分流 + 重拍计数**(submit 改六分流:matched→verified / 模糊·防伪首次→retake 不落 / 不一致→三选一 / 上游首次→retry;forgery·ocr_error **H5 会话连续 2 次**才落 manual_review〔high/system〕,计数落 `recruitment_identity_sessions` 预建列;application +4 列 additive 无 enum;进度模型 +retake/confirm/manual_high 三态;S2 待人工三栏升真 `riskLevel`)。**S5 = promote 志愿者化**已交付(Unreleased):发号后志愿者 `Member.gradeCode` 由 `null` 改 `'volunteer'` + 挂 VOL 归口部门 → **`GET /api/app/v1/me` 的 `gradeCode` 对志愿者现返 `'volunteer'`(此前 null;详见 §2 ⚠️ 语义变)**。**S6 = 批量操作**已发(批量标门槛 / 导出 CSV / 发号预检,纯加端点零 schema / 零新 RBAC 码);**S7 通知闭环 = 部分交付**(本 PR,Unreleased,经 GAP-005 S3):**发号 / 入队**2 触发(申请人已是队员)接入统一通知 → 当事队员收系统定向站内信(发号另带微信);**报名前 5 触发**(报名受理/转人工/门槛/评定/公示)非队员够不着 → 维持 `query`/`query-by-phone` **查询进度 pull**(openid 非会员推送路另立项)。 |

## 4. 不馊

改 App surface / 契约 → 同 PR 改本文件 + `pnpm docs:handoff:openapi`(沿 [`AGENTS.md`](../../AGENTS.md) 反漂铁律)。
