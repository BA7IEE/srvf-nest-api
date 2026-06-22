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

> 任务→端点的细化(注册流、入队流等)等建仓时按真实页面补,别提前臆造。

## 3. 缺口台账(gap-ledger)

| # | 诉求 | 期望端点 | 状态 |
|---|---|---|---|
| _(空)_ | | | |

## 4. 不馊

改 App surface / 契约 → 同 PR 改本文件 + `pnpm docs:handoff:openapi`(沿 [`AGENTS.md`](../../AGENTS.md) 反漂铁律)。
