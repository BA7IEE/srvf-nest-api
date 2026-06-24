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

> 任务→端点的细化(注册流、入队流等)等建仓时按真实页面补,别提前臆造。

## 3. 缺口台账(gap-ledger)

| # | 诉求 | 期望端点 | 状态 |
|---|---|---|---|
| GAP-006 | 招新→入队闭环「可见」(12 域:进度模型/工作台/批量/通知/H5+手机/promote 志愿者化…;T0 冻结评审稿 `docs/archive/reviews/recruitment-phase4-loop-optimization-review.md`) | 见评审稿 §12 切片表(S1–S7) | **S1 已交付**:状态业务文案 + 新人进度模型(公开本人查询出参 enrich 为进度模型 + `recruitment_stage` 字典;评审稿 §4/§6)。S2(工作台 stats)~S7(通知,阻塞 GAP-005)待后续切片另出 goal。 |

## 4. 不馊

改 App surface / 契约 → 同 PR 改本文件 + `pnpm docs:handoff:openapi`(沿 [`AGENTS.md`](../../AGENTS.md) 反漂铁律)。
