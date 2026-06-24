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
| 活动池 / 我的活动 | `GET /api/app/v1/activities` · `GET /api/app/v1/my/activities` |
| 我的报名(报名/查/取消) | `GET /api/app/v1/my/registrations` · `POST` 报名 · `PATCH` 取消 |
| 我的考勤 / 证书 | `GET /api/app/v1/my/attendance-records` · `GET /api/app/v1/my/certificates` |
| 公开(无账号) | `POST /api/open/v1/recruitment/applications/*`(招新报名) · `GET /api/open/v1/contents`(内容) |
| 招新本人进度(无账号) | `POST /api/open/v1/recruitment/applications/query`(凭 wx.login code 换 openid;**返进度模型**:业务态 `stage` + 字典 `stageText` + `nextAction` + 门槛 `todoList` 真投影 + 临时编号;`memberNo` 恒 null——发号后经登录态 app 侧查,见 §3 GAP-006) |
| **H5 报名前手机身份链(无账号;S4a)** | `POST /api/open/v1/recruitment/identity/send-code`(`{phone}`→发验证码) → `POST .../identity/verify-code`(`{phone,code}`→返一次性 `phoneVerificationToken`〔30min,明文仅返一次〕) → 提交报名(见下行 H5 链) |
| **H5 报名提交(无账号;S4a)** | `POST /api/open/v1/recruitment/applications`(multipart;`payload` JSON 内 **`phoneVerificationToken`**〔H5〕或 `wechatCode`〔小程序〕**至少二选一**;`payload.phone` 须与验证手机一致;小程序链向后兼容不变) |
| **OCR 六分流提交结果(S4b)** | 同上 submit 端点出参由 `RecruitmentSubmitResultDto.outcome` 区分:`submitted`(已落记录,`statusCode`=verified/manual_review + `tempNo`)/ `retake`(证件照模糊或需重拍,**不落记录**,`stage`/`stageText`/`hint` 中性引导,重拍后用**同 token** 重提)/ `confirm`(识别与填写不一致**三选一**,回带 `recognized`{realName,idCardNumber}:① 用 OCR 回填〔改 `payload.realName/idCardNumber` 重提〕② 改填写重提 ③ `payload.applicantConfirmedOcrWrong=true` 确认 OCR 错→落普通人工)/ `retry`(核验繁忙,稍后用同 token 重提)。**①②不落人工、仅③落**;`retake/confirm/retry` 均不消费 token。⚠️ 出参**绝不含风险分级**(高风险疑似造假不对申请人提示;申请人侧文案恒中性「待人工核验」) |
| **招新本人进度②(手机;S4a)** | `POST /api/open/v1/recruitment/applications/query-by-phone`(`{phone,code}`→同进度模型;一次查询消费一码) |
| **自助换绑(无账号;S4a)** | `POST .../applications/rebind-wechat`(`{phone,code,newWechatCode}`,当前手机验码校验本人→换 openid) · `POST .../applications/rebind-phone`(`{phone,code,newPhone,newPhoneCode}`,双验→换手机+换绑历史) |

> 任务→端点的细化(注册流、入队流等)等建仓时按真实页面补,别提前臆造。
> **H5 链失败码**:验码错/过期统一 `24010`;token 无效/过期/已用 `28050`;无 open 轮 `28030`;换微信撞他人 `28051`;无报名 `28002`。

## 3. 缺口台账(gap-ledger)

| # | 诉求 | 期望端点 | 状态 |
|---|---|---|---|
| GAP-006 | 招新→入队闭环「可见」(12 域:进度模型/工作台/批量/通知/H5+手机/promote 志愿者化…;T0 冻结评审稿 `docs/archive/reviews/recruitment-phase4-loop-optimization-review.md`) | 见评审稿 §12 切片表(S1–S7) | **S1/S2/S3/S4a/S4b 已交付**:S1 进度模型 + S2 工作台 stats + S3 RBAC 敏感分级;**S4a = H5 + 手机身份链**;**S4b = OCR 六分流 + 重拍计数**(submit 改六分流:matched→verified / 模糊·防伪首次→retake 不落 / 不一致→三选一 / 上游首次→retry;forgery·ocr_error **H5 会话连续 2 次**才落 manual_review〔high/system〕,计数落 `recruitment_identity_sessions` 预建列;application +4 列 additive 无 enum;进度模型 +retake/confirm/manual_high 三态;S2 待人工三栏升真 `riskLevel`)。**S5**(promote 志愿者化)/ S6(批量)/ S7(通知,阻塞 GAP-005)待后续切片另出 goal。 |

## 4. 不馊

改 App surface / 契约 → 同 PR 改本文件 + `pnpm docs:handoff:openapi`(沿 [`AGENTS.md`](../../AGENTS.md) 反漂铁律)。
