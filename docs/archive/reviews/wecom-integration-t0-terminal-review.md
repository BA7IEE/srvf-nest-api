# SRVF 企业微信接入 T0 终态评审稿 v1.2（WeCom Integration Terminal Review）

> **建议仓库路径**：`docs/archive/reviews/wecom-integration-t0-terminal-review.md`  
> **状态**：**已冻结**(2026-07-29 维护者「按推荐」整体冻结 `D-WC-1..31`)；不回改，偏离须另出 superseding 评审稿。  
> **本次修订（2026-07-29）**：依据企业微信官方《构造网页授权链接》《获取访问用户身份》（2026-04-22）《获取 access_token》《发送应用消息》（2025-09-24）《全局错误码》（2026-07-14）《访问频率限制》《获取指定应用详情》完成协议校准：修正 OAuth 身份接口路径与小写字段；固化 `agentid`、state、code、回调桥接、Token 刷新、`agent/get` 诊断、文本卡片限制、发送回执与重试分类；新增 `D-WC-31`，把可信 IP、可信域名与接口许可明确为上线配置门禁，不再阻塞 T0 设计冻结。  
> **冻结基线**：`BA7IEE/srvf-nest-api` `main@73ebb4667a126e2a34911068a7a11e04891ff4d6`，`package.json=0.63.0`，核验日期 2026-07-29。  
> **现实发布边界**：当前代码 Release GO，但 production 未部署；现有 Notification Outbox、Storage、保险、活动责任及外部通道仍有生产切换硬门。  
> **性质**：企业微信接入涉及 schema、migration、认证、凭证、Audit、Permission、外部 Effect 与 Outbox，属于 D 档设计评审。本文只冻结目标、边界、契约、锁序、失败语义、测试和落地顺序；本文本身不修改运行时代码或数据。  
> **权威分层**：实施后当前事实以 `docs/current-state.md`、运行时代码、Prisma schema、OpenAPI contract 为准；本文作为冻结设计证据保留。实施若需要偏离本文，必须暂停并另出 superseding 评审稿，不得顺手回改本稿。  
> **命名约定**：本文统一使用 `WeCom` / `wecom` 表示企业微信；现有 `Wechat` / `wechat` 专指微信小程序。二者不得混写、混表、混错误码、混通知渠道。

---

## 0. TL;DR

### 0.1 一句话终态

企业微信采用**单企业、单自建应用 Agent**接入，作为 SRVF 的“身份入口 + 工作台入口 + 外部通知通道”；SRVF 继续作为 User、Member、组织、职务、权限、活动、报名、考勤和审核的唯一业务真相源。

```text
企业微信自建应用 Agent
       ├── 工作台 H5 OAuth
       │        ↓
       │  WecomIdentity → User → Member → SRVF Authz
       │
       └── 主动应用消息
                ↑
       Notification Outbox Worker
                ↑
      SRVF 业务事务同写 Notification + Intent
```

### 0.2 第一版做什么

1. 企业微信工作台 H5 入口。
2. 企业微信 OAuth 免密登录。
3. 未绑定身份通过现有手机号短信锚定到已有 SRVF User。
4. 已登录用户通过现有 identity step-up 绑定或换绑企业微信。
5. 管理员清除企业微信绑定。
6. 企业微信应用消息通道，复用现有 Notification + PostgreSQL durable outbox。
7. 企业微信配置、凭证加密、连接诊断、独立登录与消息开关。
8. User 软删除、队员账号重开时的企业微信身份生命周期闭环。
9. 上线先采用 10–30 人分层试点，完成身份、生命周期、通知和回滚演练后再扩大应用可见范围。
10. 可信 IP、可信域名和接口许可按实际企业微信后台与试点回执在上线阶段核验；它们是生产开关门禁，不是 T0 数据模型或 API 契约的阻塞项。

### 0.3 第一版明确不做

- 不把企业微信 `UserId` 写进现有 `User.openid`。
- 不把企业微信部门、职位或标签当成 SRVF 组织、职务或权限。
- 不自动创建 User、Member、Membership、PositionAssignment 或 RoleBinding。
- 不做通讯录定时同步，不新增第三个 Cron。
- 不做企业微信删除成员即自动离队。
- 不做交互卡片直接审批。
- 不做聊天机器人或 AI Agent。
- 不做多企业、多 CorpID、多 Agent、多租户。
- 不引入 Redis、BullMQ、外部消息队列或新的事件总线。
- 不在第一版增加回调 Token、EncodingAESKey 或入站事件表。
- 不承诺 exactly-once；外部消息继续遵循 at-least-once。
- 不做普通 PC 浏览器的企业微信扫码登录；第一版只支持企业微信客户端工作台 H5，PC 管理后台继续使用原有登录方式。
- 不按企业微信部门、标签或通讯录人数直接群发业务消息；未完成绑定的用户不进入企业微信消息覆盖，但站内信及其他既有通道继续按原规则工作。
- 不支持互联企业、企业互联或上下游的跨企业身份；OAuth 返回 `CorpId/userid` 形式时第一版统一拒绝。
- 不在系统内购买、分配或自动激活企业微信接口许可；`unlicenseduser` 只作为投递诊断与运营决策依据。

### 0.4 推荐落地顺序

```text
T0 评审稿冻结
  ↓
T1 schema expand-only
  ↓
T2 WeCom 配置、凭证、Provider、连接诊断
  ↓
T3 OAuth 登录、首次绑定、本人换绑、管理员清除
  ↓
T4 User 软删 / account reopen 生命周期闭环
  ↓
T5A 通知收件人判定行为保持重构
  ↓
T5B WeCom Outbox 消息通道
  ↓
T6 runbook、10–30 人分层试点、生产演练与逐步启用
```

身份链可以先上线；消息链必须等现有 Notification Outbox 在生产完成部署、Worker 同版本切换和硬门验证后再启用。

### 0.5 维护者必须知道的五条业务口径

1. **企业微信通讯录里有多少人，不等于企业微信消息能覆盖多少人。** 第一版能在发送前确定的是“SRVF 当前可见、User 有效、Member 符合业务准入、已完成企业微信绑定”；应用可见范围与基础接口许可由企业微信发送回执做最终裁决。`invaliduser/81013` 记为收件人不可用，`unlicenseduser` 记为无接口许可，均不得误记为 SENT。未绑定或未送达人员仍保留站内信；微信小程序和短信继续按各自既有规则运行。
2. **没有绑定系统手机号的人，系统不能按姓名或部门猜测绑定。** 这类用户应先用原用户名密码或其他现有可用方式登录，再通过现有 step-up 流程绑定企业微信。前端必须给出该兜底入口，但后端不得泄露某个账号是否绑定手机号。
3. **第一版不做普通 PC 浏览器扫码登录。** 支持的是企业微信客户端工作台内打开 H5 并免密进入；PC 管理后台继续保留密码、短信等原有登录方式。未来真要 PC 扫码登录，另立认证评审。
4. **不能一上来全员开放。** 首轮只选择 10–30 人，覆盖普通队员、活动发起人、考勤审核人、部门负责人和超级管理员。完成首次绑定、重复登录、停用恢复、离队恢复、账号重开、管理员清除、消息发送、无绑定降级和回滚演练后，才能扩大范围。
5. **可信 IP、域名和接口许可先作为上线门禁处理。** 服务器使用静态出口 IP并在企业微信后台配置；可信域名按届时管理后台要求完成；接口许可不在第一版里做采购或激活逻辑，试点若返回 `unlicenseduser`，系统安全降级到站内信并交由运营决定是否补许可。

---

## 1. 当前代码基线与结构性结论

### 1.1 当前事实锚点

| 核查项 | 当前事实 | 证据 |
|---|---|---|
| 版本与 HEAD | `v0.63.0`，最新 `main` 为 `73ebb466` | `package.json`；GitHub commit #817 |
| 代码体量 | 36 模块、81 Controller、416 Endpoint、65 Migration、278 BizCode、213 Permission、123 AuditLogEvent、2 Cron | `docs/current-state.md §1` |
| 企业微信模块 | 不存在 `src/modules/wecom/` | `CODEMAP.md` 仅列 36 模块 |
| 现有 `wechat` | 微信小程序通道，负责 AppID/AppSecret、`code2session`、`User.openid` 和小程序订阅消息 | `src/modules/wechat/**`；`CODEMAP.md` |
| 现有登录 | 密码、短信 OTP、微信小程序三种登录最终共用 `AuthService.createSession()` | `src/modules/auth/auth.service.ts` |
| 会话因子 | `password-hash`、`phone`、`openid` 三种 `SessionIssuanceExpectation` | `src/modules/auth/auth.service.ts:30-33` |
| JWT | payload 固定 `{sub, username}`，每请求查 User 最新状态 | `src/modules/auth/strategies/jwt.strategy.ts` |
| App 准入 | `memberId != null` 且 User ACTIVE 且 Member ACTIVE；权限不写进 token | `src/modules/users/app-identity.resolver.ts` |
| 身份换绑 | 手机和微信换绑均使用 5 分钟 step-up proof、User 行锁、锁后复验、refresh 撤销和 Audit | `src/modules/auth/identity-step-up.service.ts`；`src/modules/users/users.service.ts` |
| 通知 | 站内、微信小程序、短信统一在 `notifications` 模块；已有 durable outbox、lease/fence、generation、recipient、RBAC/quota 最终闸 | `src/modules/notifications/**` |
| Outbox 生产态 | 代码已交付但生产未部署，切换要求排空旧 API/Worker/Intent，禁止混跑 | `docs/current-state.md §2` |
| 基础设施约束 | Cron 恰好 2；Redis、queue、LLM、vector、多租户冻结 | `AGENTS.md §3`；`docs/current-state.md §3` |
| Harness 3.0 | auth、Prisma、Audit、Permission、全局 bootstrap、workflow 等均为红区；AI 不得自行授权 | `AGENTS.md §1`；`harness/redzone.json` |

### 1.2 由当前代码推出的五个结论

1. **企业微信不能并入现有 `wechat` 模块。**  
   现有 `wechat` 的身份键是微信小程序 `openid`，企业微信内部成员身份键是 `corpId + wecomUserId`。把二者塞进同一字段或同一 Provider，会让登录、换绑、通知和审计产生语义污染。

2. **企业微信登录必须进入现有唯一会话签发路径。**  
   不允许另写 JWT 签发器，不允许把 role、permission 或 member 状态塞进 token，不允许绕过 refresh family、Audit 和锁后复验。

3. **企业微信消息必须进入现有 Notification Outbox。**  
   不能在活动、报名、考勤或审核事务里直接调用企业微信 HTTP API，也不能恢复业务 producer 的 commit 后 best-effort 直发。

4. **企业微信身份应绑定 User，而不是直接绑定 Member。**  
   登录会话属于 User；Admin 账号可能没有 Member；Member 的业务准入继续由 AppIdentityResolver 决定。消息发送时再从 `memberId → active User → active WecomIdentity` 解析目标。

5. **消息通道不能复制现有微信小程序的受众判定。**  
   当前 `NotificationWechatDispatchService` 已包含 Member、User、Membership、management RBAC 与 Provider 前加锁复验。新增 WeCom 时必须先抽出渠道无关的收件人授权边界，否则两个通道会形成两套权限真相。

---

## 2. 维护者拍板清单 — ✅ 已于 2026-07-29 整体冻结

**拍板结果:维护者回复「按推荐」,`D-WC-1..31` 全部按下表推荐终态冻结,无逐项调整。**

同时拍板的排期(与证书 Goal 的关系):

> **本 Goal 排在证书标准库 Goal 之后。** 两者都改 `prisma/schema.prisma`,受
> [`process.md §8`](../../process.md) 「同一时刻至多一条 schema-touching lane」约束,不并行;
> 且写集在 Permission seed / AuditLogEvent / openapi 快照 / CODEMAP / RBAC_MAP / counts 上重叠。
> 先后由**单向门**决定:证书方案依赖 `Certificate = 0 行`,该前提只在 production 未部署期间成立;
> 本 Goal 是 expand-only、开关默认全 false,何时做成本相同,且价值与依赖均在部署之后。
> 详见 [`certificate-standard-library-t0-review.md` §0.0](./certificate-standard-library-t0-review.md)。

**基线漂移核验(2026-07-29)**:`73ebb466..main` 触碰 `src/` `prisma/` 的改动**仅 1 个文件**
(`src/bootstrap/apply-swagger.ts`,离线 OpenAPI 生成)。`prisma/` 零改动;
`auth` / `users` / `notifications` / `wechat` / `permissions` / `audit` **全部零改动**。
本文冻结基线仍然有效;T1 开工仍须现场跑 `pnpm agent:preflight` 复核。

下表为已冻结的终态,保留理由列作为决策证据。

| 编号 | 决策 | 推荐终态 | 理由 |
|---|---|---|---|
| D-WC-1 | 接入产品形态 | 企业微信**自建应用 Agent** | 支持工作台 H5、内部成员身份、主动应用消息；Bot 不适合作为业务系统身份主干 |
| D-WC-2 | 租户形态 | 单 CorpID、单 Agent、单 settings singleton | 当前 SRVF 非多租户；不为未来可能性提前引入 accountId/tenantId |
| D-WC-3 | 权威边界 | 企业微信只证明身份、提供入口和送达；SRVF 决定业务权限 | 避免通讯录反向控制救援队业务 |
| D-WC-4 | 模块边界 | 新建 `src/modules/wecom/`，不复用 `wechat` | 企业微信和微信小程序是不同身份域、Token 域和消息协议 |
| D-WC-5 | 身份归属 | `WecomIdentity → User` | 会话属于 User；Member 准入继续走现有闭包 |
| D-WC-6 | 首次绑定锚点 | 现有 User.phone + `SmsCodeService` | 已验证的账号控制权锚点；不按姓名、手机号目录匹配或部门猜人 |
| D-WC-7 | 未绑定行为 | 返回 `bindingRequired`，不自动开号、不自动建 Member | 企业微信可见成员不等于 SRVF 有权用户 |
| D-WC-8 | 本人换绑 | JWT + action-bound step-up + 企业微信 OAuth code | 沿现有手机/微信身份变更安全模型 |
| D-WC-9 | 解绑 | 无本人裸解绑；管理员清除为显式释放路径 | 防误解绑和身份槽位漂移 |
| D-WC-10 | User 生命周期 | DISABLED/offboard 保留绑定；User soft-delete/account reopen 撤销绑定 | 临时停用可恢复；User 代际终止时必须释放外部身份槽位 |
| D-WC-11 | 设置开关 | `enabled` 主开关 + `loginEnabled` + `messageEnabled` | 支持身份链和消息链独立试点、独立熔断 |
| D-WC-12 | 凭证 | 独立 `WECOM_ENCRYPTION_KEY` 加密 CorpSecret | 不与小程序 `WECHAT_ENCRYPTION_KEY` 共域 |
| D-WC-13 | OAuth | `snsapi_base`，授权 URL 必带当前 `agentid`；协议只接受小写 `userid`，`openid/external_userid`、`CorpId/userid` 跨企业身份一律拒绝 | 第一版不采集姓名、头像、手机、部门、`user_ticket` 或 `user_doc_ticket` |
| D-WC-14 | OAuth 状态 | state 固定为 32 字节随机数的 64 字符 hex（仅字母数字、≤128 字节）+ PostgreSQL 一次性 binding ticket；原文只在客户端存在，DB 仅存 hash | 对齐官方 state 字符集并抗 CSRF、重放和 code 注入 |
| D-WC-15 | 会话签发 | `createSession()` 新增第四种 `wecom-identity` expectation | 保持 JWT、refresh、Audit 和 User 锁单轨 |
| D-WC-16 | 限流 | 新增第 11 个 PostgreSQL shared throttler `login-wecom`，默认 5/60/endpoint/IP | 与微信小程序配额物理隔离，DB 异常 fail-closed |
| D-WC-17 | 消息 | 只走 Notification Outbox，逐 member child intent | 可追踪、可重试、可见性一致、无业务事务外发 |
| D-WC-18 | Outbox payload | 只存 `notificationId/memberId/publishGeneration` 等内部引用 | 禁止 wecomUserId、token、secret、Provider request/response 入库 |
| D-WC-19 | 受众判定 | 抽 `NotificationRecipientAuthorizationService`，微信小程序与 WeCom 共用 | 防止两套可见性和 RBAC 漂移 |
| D-WC-20 | 消息类型 | 第一版用 `textcard` 非交互文本卡片，128 字符标题、512 字符描述、2048 字节 URL、4 字按钮；开启 1800 秒重复检查，按钮只打开 SRVF 安全深链 | 对齐官方协议，不把审批动作搬到企业微信回调 |
| D-WC-21 | 通讯录 | 第一版不接；后续仅人工 `preview → execute` 对账 | 不定时同步，不自动修改 SRVF 组织或权限 |
| D-WC-22 | 入站回调 | 第一版不接 Token/EncodingAESKey；卡片事件另立 D 档 | 不占无业务用途的敏感字段 |
| D-WC-23 | 错误码段 | 新开 `360xx + 361xx` 作为 WeCom 独立段 | 25xxx 已属于微信小程序，必须语义隔离 |
| D-WC-24 | 回滚 | 所有新能力默认 disabled；schema additive 保留，关闭开关即可停用 | 避免回滚时删表、删历史或移动身份 |
| D-WC-25 | 外部依赖 | 登录和主动消息使用 Node 22 原生 fetch，8 秒超时；第一版零新 runtime 依赖 | 镜像现有微信/实名 Provider，减少供应链与维护面 |
| D-WC-26 | 多企业扩展 | 不预埋 multi-account controller、tenant table 或动态 Agent 路由 | 真出现第二 CorpID 时另立架构评审 |
| D-WC-27 | 企业微信消息覆盖 | 发送前候选仅为“SRVF 当前可见 ∩ live ACTIVE User ∩ 合法 Member 准入 ∩ active WecomIdentity”；企业微信应用可见范围与基础接口许可由逐人 `message/send` 回执最终裁决 | 第一版不复制通讯录，也不假装能预计算许可；`invaliduser/81013/unlicenseduser` 均安全降级 |
| D-WC-28 | 无手机号用户兜底 | 禁止姓名/部门/通讯录猜测；用户先通过原账号或其他现有方式登录，再以现有 step-up 自助绑定 WeCom | 兼顾可用性与身份安全，同时保持 pre-auth 防枚举 |
| D-WC-29 | PC 登录范围 | 第一版仅企业微信客户端工作台 H5；不做普通 PC 浏览器企业微信扫码登录，PC 管理后台保留原登录 | 避免把网站扫码认证、回调和设备会话问题混入第一版 |
| D-WC-30 | 上线试点 | 10–30 人分层试点；全部规定场景验收并由维护者签署后才扩大应用可见范围 | 用真实生命周期和消息故障演练替代“接口能通即上线” |
| D-WC-31 | 外部配置与接口许可 | 静态出口 IP、可信域名、接口许可均作为 T6/production GO 门禁；T0 不设计自动采购、激活或同步机制 | 外部后台规则会调整，运行时以官方回执为准；未知许可状态不应阻塞身份与通知架构冻结 |

---

## 3. 业务边界与数据权威矩阵

| 事实 | 唯一权威源 | 企业微信是否可覆盖 |
|---|---|---|
| 企业内部成员标识 | 企业微信 `corpId + wecomUserId` | 仅作为外部身份事实 |
| SRVF User 状态 | SRVF `User` | 否 |
| SRVF Member 状态与等级 | SRVF `Member` | 否 |
| 组织归属 | SRVF `MemberOrganizationMembership` | 否 |
| 职务 | SRVF `OrganizationPositionAssignment` | 否 |
| 分管关系 | SRVF `OrganizationSupervisionAssignment` | 否 |
| 角色与权限 | SRVF `RoleBinding/AuthzService` | 否 |
| 活动、报名、考勤、保险、证书 | SRVF 业务表 | 否 |
| 企业微信应用可见范围与基础接口许可 | 企业微信后台及 `message/send` 回执 | 第一版不复制或预计算；只决定企业微信消息是否能送达，不授予 SRVF 权限 |
| 外部消息最终投递结果 | SRVF `NotificationDelivery` + 企业微信回执 | 企业微信提供回执，SRVF 保留安全摘要 |
| 企业微信部门/标签 | 企业微信通讯录 | 第一版仅未来对账参考，绝不直接写 SRVF |

核心规则：

```text
企业微信回答“你是谁”
SRVF 回答“你能做什么”
Notification Recipient Authorization 回答“这条消息现在能不能发给你”
```

企业微信消息实际覆盖口径冻结为：

```text
企业微信消息覆盖
  = SRVF 当前可见受众
  ∩ live ACTIVE User
  ∩ 当前合法的 Member/App 业务准入
  ∩ 当前 CorpID 下 active WecomIdentity
  ∩ 企业微信应用可见范围
```

因此，企业微信通讯录有 300 人而最终只向 80 人发送，并不自动表示系统故障；可能只是只有 80 人完成绑定且仍符合当前 SRVF 可见性。未进入 WeCom 覆盖的人员仍可在 SRVF 站内看到其有权看到的通知，其他渠道继续沿各自既有规则。

---

## 4. 目标架构与依赖方向

### 4.1 模块图

```text
src/modules/wecom/
  wecom.module.ts
  wecom.constants.ts
  wecom.types.ts
  wecom.dto.ts
  wecom-crypto.service.ts
  wecom-settings.service.ts
  wecom-settings.controller.ts
  wecom.service.ts
  wecom.provider.ts
  dev-stub-wecom.provider.ts
  wecom-auth-attempt.service.ts

src/modules/auth/
  login-wecom.service.ts
  auth.controller.ts                 # additive routes
  auth.dto.ts                        # additive Auth DTO
  auth.service.ts                    # fourth expectation only
  identity-step-up.service.ts        # WECOM_BIND action-bound snapshot

src/modules/users/
  user-wecom-binding.service.ts
  controllers/app-me.controller.ts   # GET/PUT me/wecom
  users.controller.ts                # admin clear

src/modules/notifications/
  notification-recipient-authorization.service.ts
  notification-wecom-dispatch.service.ts
  notification.wecom-message.ts
  notification-outbox.handlers.ts
  notification-outbox.types.ts
  notification-outbox.service.ts
```

### 4.2 依赖方向

```text
auth → wecom
users → auth + wecom
notifications → wecom
business producers → notifications
wecom ✕ users
wecom ✕ members
wecom ✕ activities / attendances / recruitment
```

`wecom` 通道层对 User、Member 和业务权限无感知。身份占用、绑定、refresh 撤销和 Audit 分别归 auth/users；受众资格归 notifications。

### 4.3 为什么不建万能 `external_identities`

第一版只存在一个新增外部身份域：企业微信。立即创建 `external_identity(provider, tenant, subject, metadata...)` 会提前引入：

- provider 抽象与动态路由；
- 多租户语义；
- 不同平台互不相同的唯一约束；
- 不同登录和撤销生命周期；
- JSON metadata 逃逸；
- AI 难以机器验证的隐式分支。

因此第一版使用明确的 `WecomIdentity`。未来若飞书、钉钉真实进入，再拿两个已运行实现提取共同边界，而不是现在猜未来。

---

## 5. 数据模型终态

### 5.1 `WecomSettings`

```prisma
model WecomSettings {
  id                   String   @id @default(cuid())
  providerType         String   @default("DEV_STUB") // DEV_STUB | WECOM
  enabled              Boolean  @default(false)
  loginEnabled         Boolean  @default(false)
  messageEnabled       Boolean  @default(false)

  corpId               String?
  agentId              Int?
  webBaseUrl           String?  // production 必须为 HTTPS origin，不允许 path/query/fragment

  corpSecretEncrypted  String?
  credentialConfigured Boolean  @default(false)

  remarks              String?
  updatedBy            String?
  createdAt            DateTime @default(now())
  updatedAt            DateTime @updatedAt

  @@map("wecom_settings")
}
```

Migration 追加 constant unique index，保证全库至多一行：

```sql
CREATE UNIQUE INDEX "wecom_settings_singleton_unique"
ON "wecom_settings" ((true));
```

规则：

1. `enabled=false` 时登录和消息全部 fail-closed。
2. `loginEnabled=false` 时 OAuth authorize/login/bind-self OAuth 不可用。
3. `messageEnabled=false` 时新消息不创建 WeCom intent；已存在 intent 在 Effect 前终态 skipped，不等待未来迟到发送。
4. production/smoke 禁 `DEV_STUB`，写入口和运行时双重校验。
5. `corpId` 仅允许在 active `WecomIdentity=0` 时修改。
6. `corpSecretEncrypted`、access token、原始 Secret 永不响应、永不 Audit、永不日志。
7. `webBaseUrl` 仅保存 origin，如 `https://app.example.com`；OAuth callback path和通知 detail path由代码固定拼接。
8. `configurationGeneration` 不落库，由 effect 字段做 SHA-256 opaque hash：
   `row.id/providerType/enabled/loginEnabled/messageEnabled/corpId/agentId/webBaseUrl/credentialConfigured/corpSecretEncrypted`。
9. `remarks` 不参与 generation。
10. Encryption key rotation第一版不支持；Key 变化导致 credentialStatus=invalid 并 fail-closed。

### 5.2 `WecomIdentity`

```prisma
model WecomIdentity {
  id              String   @id @default(cuid())
  userId          String
  corpId          String
  wecomUserId     String
  status          String   @default("active") // active | revoked
  bindingSource   String                    // pre-auth | me
  boundAt         DateTime @default(now())
  revokedAt       DateTime?
  revokedByUserId String?
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  user User @relation(fields: [userId], references: [id], onDelete: Restrict)

  @@index([userId, status])
  @@index([corpId, status])
  @@index([wecomUserId])
  @@map("wecom_identities")
}
```

Migration 手写：

```sql
CREATE UNIQUE INDEX "wecom_identity_subject_active_unique"
ON "wecom_identities" ("corpId", "wecomUserId")
WHERE "status" = 'active';

CREATE UNIQUE INDEX "wecom_identity_user_active_unique"
ON "wecom_identities" ("corpId", "userId")
WHERE "status" = 'active';

ALTER TABLE "wecom_identities"
ADD CONSTRAINT "wecom_identity_status_check"
CHECK ("status" IN ('active', 'revoked'));

ALTER TABLE "wecom_identities"
ADD CONSTRAINT "wecom_identity_revocation_shape_check"
CHECK (
  ("status" = 'active' AND "revokedAt" IS NULL)
  OR
  ("status" = 'revoked' AND "revokedAt" IS NOT NULL)
);
```

语义：

- 绑定、换绑、清除均保留历史行。
- 换绑是结束旧 active 行并创建新 active 行，不覆盖历史 `wecomUserId`。
- `wecomUserId` 是企业内部稳定标识，按 L2 处理：业务必须明文存储用于发送，但所有响应、Audit 和日志只允许掩码。
- 同一 User 在当前 CorpID 下最多一个 active 企业微信身份。
- 同一企业微信身份最多绑定一个 active User。
- 不建 `memberId` 字段，不把 Member 当登录主体。
- 不建 `departmentIds/name/avatar/mobile/email` 快照。
- 不建 soft delete；`revoked` 已是终态历史语义。

### 5.3 `WecomAuthAttempt`

```prisma
model WecomAuthAttempt {
  id                String   @id @default(cuid())
  purpose           String   // login | bind_self
  status            String   @default("pending")
  subjectUserId     String?  // bind_self 时固定；login 为 null

  stateHash         String   @unique
  returnPath        String
  stateExpiresAt    DateTime
  stateConsumedAt   DateTime?

  bindingTicketHash String?  @unique
  corpId            String?
  wecomUserId       String?
  bindingExpiresAt  DateTime?
  bindingConsumedAt DateTime?

  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt

  subjectUser User? @relation(fields: [subjectUserId], references: [id], onDelete: Restrict)

  @@index([status, stateExpiresAt])
  @@index([bindingExpiresAt])
  @@map("wecom_auth_attempts")
}
```

状态闭集：

```text
pending
state_consumed
binding_required
completed
failed
```

规则：

1. 原始 `state`、原始 `bindingTicket` 不入库，只存 SHA-256 hash。
2. OAuth code 不入库、不入日志、不入 Audit。
3. `purpose=login` 时 `subjectUserId=null`。
4. `purpose=bind_self` 时 `subjectUserId` 必须是发起 authorize 的登录用户。
5. state 固定为 `randomBytes(32).toString('hex')`：64 个 ASCII 字母数字字符、256-bit 熵、≤128 字节；默认 5 分钟，单次消费。
6. binding ticket 默认 10 分钟，send-code 只校验不消费，bind 原子消费。
7. `corpId/wecomUserId` 仅在未绑定登录转入 `binding_required` 时临时保存。
8. 成功、失败和过期记录由手动 retention SOP 清理，不新增 Cron。
9. 外部 Provider 调用不持 DB 事务；state 先 CAS 消费，Provider 失败后用户重新发起，不恢复 state。
10. 不在响应中返回 attempt id、wecomUserId 或 corpId。

### 5.4 User 反向关系

`User` 只新增 Prisma 反向关系：

```prisma
wecomIdentities    WecomIdentity[]
wecomAuthAttempts  WecomAuthAttempt[]
```

不在 `User` 上新增 `wecomUserId`、`wecomIdentityId`、`corpId` 或 JSON 字段。

### 5.5 数据分级

| 数据 | 等级 | 持久化 | 响应 | 日志/Audit |
|---|---|---:|---:|---:|
| CorpSecret | L3 | AES-256-GCM 密文 | 禁止 | 禁止 |
| 企业微信 access_token | L3 | 不落库，进程内短缓存 | 禁止 | 禁止 |
| OAuth code | L3 一次性凭证 | 禁止 | 客户端只向登录接口提交 | 禁止 |
| 原始 state | L3 一次性凭证 | 禁止，仅 hash | authorize URL 中存在 | 禁止 |
| 原始 binding ticket | L3 一次性凭证 | 禁止，仅 hash | 仅 bindingRequired 响应 | 禁止 |
| wecomUserId | L2 稳定身份标识 | `WecomIdentity` 明文 | 仅掩码 | 仅掩码 |
| corpId | 内部配置 | 明文 | settings 可掩码或不回显全值 | 不写 Audit value |
| agentId | 内部配置 | 明文 | settings 可回显 | 允许 changedFields，不写 before/after |
| webBaseUrl | 内部配置 | 明文 | settings 可回显 | 只记 changedFields |
| Provider 原始请求/响应 | 可能含敏感信息 | 禁止 | 禁止 | 禁止 |

---

## 6. API 契约终态

所有响应继续使用全局 `{code,message,data}` 包装。以下只列 `data`。

### 6.1 System surface

#### GET `/api/system/v1/wecom-settings`

权限：`wecom-setting.read.singleton`

返回：

```json
{
  "id": "c...",
  "providerType": "WECOM",
  "enabled": true,
  "loginEnabled": true,
  "messageEnabled": false,
  "corpIdMasked": "ww12****cdef",
  "agentId": 1000002,
  "webBaseUrl": "https://app.example.com",
  "credentialConfigured": true,
  "credentialStatus": "configured",
  "remarks": null,
  "updatedBy": "c...",
  "updatedAt": "2026-07-29T00:00:00.000Z",
  "createdAt": "2026-07-29T00:00:00.000Z"
}
```

不存在时返回 `data:null`。响应不含 Secret 明文、密文、configurationGeneration 或 access token。

#### PATCH `/api/system/v1/wecom-settings`

权限：`wecom-setting.update.singleton`

允许字段：

```json
{
  "providerType": "WECOM",
  "enabled": true,
  "loginEnabled": true,
  "messageEnabled": false,
  "corpId": "ww...",
  "agentId": 1000002,
  "webBaseUrl": "https://app.example.com",
  "remarks": "SRVF 企业微信自建应用"
}
```

规则：

- DTO whitelist 严格拒绝任何 secret/token/callback key 字段。
- production-like 禁 DEV_STUB。
- `webBaseUrl` production-like 仅 HTTPS origin。
- `loginEnabled/messageEnabled=true` 时必须 `enabled=true`。
- `corpId` 改变时必须持 settings 行锁并确认 active identity=0，否则 36020。
- update Audit 只记录 `changedFields`。

#### POST `/api/system/v1/wecom-settings/reset-credentials`

仅 SUPER_ADMIN 短路可用，`wecom-setting.reset.credentials` 不绑定 ops-admin。

入参：

```json
{
  "corpSecret": "..."
}
```

返回安全 settings DTO。Audit 不传 before/after/extra，不含凭证字段名或值。

#### POST `/api/system/v1/wecom-settings/test-connection`

权限：`wecom-setting.test.connection`

行为：

1. 读取单份 settings snapshot。
2. 强制跳过 token cache，调用 `/cgi-bin/gettoken` 获取新 access token。
3. 立即调用 `/cgi-bin/agent/get`，验证返回 `agentid` 与配置一致、`close=0`。
4. 不发送消息、不读取完整通讯录、不修改身份；只对 `allow_userinfos/allow_partys/allow_tags` 计数，不返回任何成员、部门或标签 ID。
5. 返回安全诊断：

```json
{
  "ok": true,
  "providerType": "WECOM",
  "credentialStatus": "configured",
  "tokenAcquired": true,
  "agentMatched": true,
  "agentEnabled": true,
  "agentName": "初心救援队系统",
  "visibilitySummary": {
    "directUsers": 12,
    "parties": 2,
    "tags": 0
  },
  "redirectDomainConfigured": true,
  "checkedAt": "2026-07-29T00:00:00.000Z"
}
```

`test-connection` 不能证明所有用户都有基础接口许可；许可只能通过真实逐人发送回执中的 `unlicenseduser` 观察。失败返回业务错误码 36030/36031，不回显上游 URL、token、Secret、完整 errmsg 或可见范围 ID。该只读诊断不写 audit，pino 只记录固定错误类。

### 6.2 Auth surface

#### POST `/api/auth/v1/login-wecom/authorize`

`@Public()`，挂 `@LoginWecomThrottle()`。

入参：

```json
{
  "returnPath": "/activities"
}
```

返回：

```json
{
  "authorizeUrl": "https://open.weixin.qq.com/connect/oauth2/authorize?...",
  "expiresAt": "2026-07-29T00:05:00.000Z"
}
```

规则：

- `returnPath` 只接受站内相对路径。
- 拒绝 `http:`, `https:`, `//`, `\\`, control chars、用户名密码片段、query 中的 token-like key。
- state 固定为 32 字节随机数的 64 字符 hex，满足官方 `[a-zA-Z0-9]` 且不超过 128 字节；DB 仅存 SHA-256 hash。
- authorize URL 固定为：`appid=CORPID`、`redirect_uri=encodeURIComponent(FIXED_CALLBACK_URL)`、`response_type=code`、`scope=snsapi_base`、`state=STATE`、`agentid=AGENTID`、`#wechat_redirect`。
- `redirect_uri` 指向固定前端 GET callback 页面。企业微信跳转到 `?code=...&state=...` 后，页面立即 POST 到 `/api/auth/v1/login-wecom`，随后用 `history.replaceState` 清理地址栏；code/state 禁止进入埋点、错误上报或浏览器持久存储。
- `redirect_uri` 只编码一次，禁止未编码或重复编码。
- response 和日志不单独输出 raw state；state 只存在于 authorize URL。

#### POST `/api/auth/v1/login-wecom`

`@Public()`，挂 `@LoginWecomThrottle()`。

入参：

```json
{
  "code": "企业微信一次性code",
  "state": "OAuth state"
}
```

已绑定：

```json
{
  "bindingRequired": false,
  "bindingTicket": null,
  "session": {
    "accessToken": "...",
    "tokenType": "Bearer",
    "expiresIn": "15m",
    "refreshToken": "...",
    "refreshExpiresAt": "..."
  },
  "returnPath": "/activities"
}
```

未绑定：

```json
{
  "bindingRequired": true,
  "bindingTicket": "opaque-random-ticket",
  "session": null,
  "returnPath": "/activities"
}
```

规则：

1. 原子消费 `purpose=login` state。
2. 校验 code 为非空且 UTF-8 字节数不超过 512；事务外调用 `/cgi-bin/auth/getuserinfo`。code 只能消费一次，5 分钟后过期。
3. 只读取小写协议字段 `userid`；返回 `openid`、`external_userid`、缺少 `userid`，或 `userid` 为 `CorpId/userid` 跨企业形式时统一 36010。`user_ticket`、`user_doc_ticket` 即使返回也立即丢弃，不进入对象、日志、Audit 或数据库。
4. 查询 active `WecomIdentity`：
   - 无绑定：生成 binding ticket，attempt 转 `binding_required`。
   - 有绑定：调用 `AuthService.createSession()`。
5. 绑定指向 DISABLED/软删 User时统一 36010，不返回“账号已禁用”等可区分信息。
6. `LoginResponseDto` 字段集不变。
7. 只在成功签发时写 `auth.login.wecom`。
8. 未绑定页面必须同时提供两条明确入口：`手机号验证码绑定` 与 `使用原账号登录后绑定企业微信`。
9. 后端不得返回 `hasPhone`、手机号尾号或“该账号未绑定手机号”等可枚举信息；无手机号兜底由已登录 self-bind 路径完成。

#### POST `/api/auth/v1/wecom-bind/send-code`

`@Public()`，同时挂登录 WeCom 限流和既有 SMS send 限流。

入参：

```json
{
  "bindingTicket": "opaque-random-ticket",
  "phone": "13800001234"
}
```

返回固定：

```json
{
  "expiresInSeconds": 300
}
```

规则：

- binding ticket 必须有效但不消费。
- phone 未命中、`User.phone=null`、User DISABLED、User 软删、或输入 phone 与账号绑定值不一致时，返回与有效号逐字段相同的泛化 200，不发送短信。
- 有效 User 走新增 `SmsPurpose.WECOM_BIND`。
- 短信资费、日限、间隔和验证码散列完全复用 `SmsCodeService`。
- 不返回企业微信身份状态。

#### POST `/api/auth/v1/wecom-bind`

`@Public()`，挂 `@LoginWecomThrottle()` 与 SMS verify 限流。

入参：

```json
{
  "bindingTicket": "opaque-random-ticket",
  "phone": "13800001234",
  "smsCode": "123456"
}
```

成功直接返回既有 `LoginResponseDto`。

冻结校验顺序：

```text
① binding ticket 有效且 binding_required
② resolve active User by phone；无效统一 24010
③ SMS assertValid，不消费
④ 企业微信身份占用预检；他人 active 占用 → 36002
⑤ SMS verifyAndConsume，单赢家
⑥ 绑定事务：
   settings FOR SHARE → User FOR UPDATE → 当前 active WecomIdentity
   → settings corpId 与 attempt corpId 二次一致
   → target occupancy 二次检查
   → 结束旧身份（若有）+ 建新身份
   → 消费 binding ticket
   → 撤销全部 active refresh
   → audit wecom.bind/rebind.self
⑦ createSession('auth.login.wecom')，锁后再次校验新 identity
```

绑定成功后有两条 Audit：身份绑定事件 + 登录事件。绑定事务成功但会话签发失败的窄窗口接受，客户端重新执行 `login-wecom` 即可。

#### POST `/api/auth/v1/wecom-bind/authorize`

需登录，不标 `@Public()`；挂 `@LoginWecomThrottle()`。

用途：本人绑定或换绑前创建 `purpose=bind_self` OAuth state。

返回与 login authorize 同形。attempt 固定 `subjectUserId=currentUser.id`，默认 returnPath `/me/security`。

#### 未绑定用户分流（冻结产品行为）

企业微信首次登录发现未绑定身份时，前端必须展示：

```text
路径 A：输入系统绑定手机号 → 短信验证码 → 完成首次绑定
路径 B：使用原用户名密码或其他现有可用方式登录 → 通过 step-up → 在“账号安全”绑定企业微信
```

规则：

- 路径 B 是未绑定手机号、收不到短信或不便使用短信用户的正式兜底，不是人工数据库操作。
- 禁止按姓名、昵称、企业微信部门、企业微信手机号或通讯录模糊匹配 User。
- pre-auth 页面不得告诉访问者“这个手机号是否存在、是否已绑定、账号是否停用”。
- 用户收不到短信时，前端只能提示“可使用原账号登录后绑定”，不能泄露具体账号状态。
- 完成路径 B 后仍走同一 `WecomIdentity → User` 绑定模型，不创建第二套特殊身份。

### 6.3 App surface

#### GET `/api/app/v1/me/wecom`

账号级身份接口，不强制 `canUseApp`，沿 me/phone、me/wechat 豁免边界。

返回：

```json
{
  "bound": true,
  "wecomUserIdMasked": "zh****san",
  "boundAt": "2026-07-29T00:00:00.000Z"
}
```

无绑定返回：

```json
{
  "bound": false,
  "wecomUserIdMasked": null,
  "boundAt": null
}
```

#### PUT `/api/app/v1/me/wecom`

入参：

```json
{
  "code": "企业微信一次性code",
  "state": "bind_self state",
  "stepUpToken": "5分钟action-bound proof"
}
```

冻结流程：

```text
① 原子消费 bind_self state，subjectUserId 必须等于 currentUser.id
② 校验 code≤512字节，事务外调用 `/cgi-bin/auth/getuserinfo` 换取小写 `userid`
③ 读取锁外 User + 当前身份快照，预验 WECOM_BIND proof
④ 绑定事务：
   settings FOR SHARE
   → User FOR UPDATE
   → 当前 active WecomIdentity
   → 锁后重算 action-bound identity snapshot
   → proof 二次验证
   → 同目标 no-op
   → target occupancy 检查
   → revoke old + create new
   → revoke all refresh
   → audit
⑤ 返回 AppMeWecomDto
```

绑定或换绑后当前 access token按 P0-E 继续自然到期；全部 refresh token被撤销。客户端应完成后重新登录，不新增 tokenVersion。

### 6.4 Admin surface

#### DELETE `/api/admin/v1/users/:id/wecom`

权限：`user.wecom.clear` + 既有 `assertCanManageUser`。

冻结语义：

- 目标 User 必须是未软删 User。
- User 无 active WecomIdentity时幂等 200，不写 Audit。
- 实际清除时：
  `User FOR UPDATE → active WecomIdentity → status=revoked → refresh revoke → wecom.clear.by-admin Audit`。
- 不返回完整企业微信 UserId。
- 不允许通过此接口把身份直接转移给另一 User。

---

## 7. OAuth、绑定和会话安全模型

### 7.1 OAuth Provider

第一版 Provider 仅暴露四种能力：

```ts
interface WecomProvider {
  exchangeOAuthCode(input: { code: string }): Promise<{ wecomUserId: string }>;
  getAccessToken(forceRefresh?: boolean, beforeEffect?: () => Promise<void>): Promise<string>;
  getAgent(
    accessToken: string,
    agentId: number,
    beforeEffect?: () => Promise<void>,
  ): Promise<WecomAgentSnapshot>;
  sendTextCard(
    accessToken: string,
    input: WecomTextCardInput,
    beforeEffect?: () => Promise<void>,
  ): Promise<WecomSendResult>;
}
```

外部协议锚点：

- OAuth authorize：`https://open.weixin.qq.com/connect/oauth2/authorize`
- code 换身份：`https://qyapi.weixin.qq.com/cgi-bin/auth/getuserinfo`
- access token：`https://qyapi.weixin.qq.com/cgi-bin/gettoken`
- 获取应用：`https://qyapi.weixin.qq.com/cgi-bin/agent/get`
- 应用消息：`https://qyapi.weixin.qq.com/cgi-bin/message/send`

实现规则：

1. Node 22 原生 fetch + `AbortSignal.timeout(8000)`。
2. Secret/access_token 位于 query/body 的请求，禁止完整 URL、body、fetch error原文入日志。
3. 程序只按 `errcode` 分类，不依赖可能变化的 `errmsg`；HTTP 非 2xx、非 JSON、缺协议字段均 fail-closed。
4. OAuth `40029/42003/42022`、无小写 `userid`、外部成员或跨企业 userid统一映射 36010，终态不重试。
5. `40001/40013/40056/50001/50003/60020/60031/301002/48001/48002` 等确定性配置或权限错误映射 36030，终态不自动重试。
6. `40014/42001` 仅允许强制刷新 access token并重试原请求一次；再次失败即 `token-failed`，禁止刷新循环。
7. `-1` 系统繁忙最多自动尝试 3 次；网络、超时、HTTP 5xx沿 Outbox暂态策略，但总尝试不超过既有上限。
8. `45009` 为限流，不做秒级/指数盲重试；intent终态 `dead/rate-limited`，由运维在官方拦截窗口结束后显式 replay。
9. access token有效期以返回 `expires_in` 为准，进程内按 `corpId + agentId + configurationGeneration` 缓存，并以安全缓冲提前刷新；`refreshPromise` 合并并发刷新。
10. 多实例各自缓存合法；缓存丢失只增加取 token 请求，不影响正确性。
11. 配置变化后新 generation 不命中旧 token。
12. `getAgent` 仅用于连接诊断；返回可见范围 ID不得穿过 service边界。
13. `beforeEffect` 在每次真正外部请求前执行，fence 丢失时不启动 Provider。

### 7.2 DevStub

- 仅 development/test 可用。
- code → `dev-wecom-${sha256(code).slice(0,24)}`，确定性生成。
- code 本身不进入返回、日志或 Audit。
- 提供显式测试故障码以覆盖 invalid-code、API failure、timeout。
- production/smoke 写入口和运行时双重拒绝。

### 7.3 createSession 第四 expectation

```ts
type SessionIssuanceExpectation =
  | { kind: 'password-hash'; value: string }
  | { kind: 'phone'; value: string }
  | { kind: 'openid'; value: string }
  | {
      kind: 'wecom-identity';
      identityId: string;
      corpId: string;
      wecomUserId: string;
    };
```

`createSession()` 在既有 User 锁后：

1. 重读 User ACTIVE/deletedAt。
2. `SELECT WecomIdentity ... FOR SHARE`。
3. 验证 identity：
   - `id` 一致；
   - `userId=current.id`；
   - `corpId/wecomUserId` 一致；
   - `status=active`；
   - `revokedAt IS NULL`。
4. 再签 access token、创建 refresh family、写 `auth.login.wecom`。
5. 失败统一 36010。
6. `JwtPayload`、`LoginResponseDto`、refresh rotation、90 天绝对到期和 access 15 分钟行为零变化。

### 7.4 Step-Up 扩展

新增：

```ts
StepUpAction.WECOM_BIND
```

不新增 `IdentityStepUpFactor.WECOM`。用户仍可用现有 PASSWORD/SMS/WECHAT 因子证明当前账号控制权。

为了防止管理员刚清除绑定，旧 proof 在 5 分钟内又把身份绑回来：

- `WECOM_BIND` action的 snapshot除现有 User credential snapshot外，额外包含当前 active WecomIdentity fingerprint。
- fingerprint由 `identityId/corpId/wecomUserId/status/updatedAt` 输入现有 snapshot HMAC，不把原值写进 token。
- 其他 `PHONE_BIND/WECHAT_BIND` snapshot算法保持逐字不变。
- final bind事务在 User与 identity锁后重算 fingerprint并二次验证。

---

## 8. 生命周期矩阵

| 事件 | User | Member | WecomIdentity | refresh | 说明 |
|---|---|---|---|---|---|
| 正常登录 | ACTIVE | 任意 | 必须 active | 新建 family | Admin 无 Member也可通过 WeCom登录 Admin面；App面仍由 AppIdentityResolver 拒绝 |
| User DISABLED | DISABLED | 不变 | **保留 active** | 全撤销 | 下一请求由 JwtStrategy即时失效；未来重新启用可继续原绑定 |
| User 重新启用 | ACTIVE | 若有关联 Member则 Member 必须 ACTIVE | 原绑定继续 | 不自动签发 | 下次 WeCom登录重新建 family |
| User soft-delete | DISABLED + deletedAt | 不变 | **同事务 revoke** | 全撤销 | User 代际结束，释放外部身份槽位 |
| Member offboard | linked User DISABLED | INACTIVE | **保留 active** | 全撤销 | offboard是可恢复业务停用，不是 User 代际删除 |
| Member 恢复 + User启用 | ACTIVE | ACTIVE | 原绑定继续 | 无 | 下次登录恢复 |
| member-account unbind | User仍 live | User.memberId=null | 保留 | 不因解绑自动撤销 | 企业微信身份属于 User |
| member-account reopen | 旧 User soft-delete，新 User创建 | 同一 Member | **旧 User身份同事务 revoke，不自动转移** | 旧 User全撤销 | 新账号必须重新通过 SMS/step-up绑定，防旧外部凭证自动继承 |
| 本人换绑 | ACTIVE | 不变 | revoke old + create new | 全撤销 | access自然到期，客户端重新登录 |
| Admin清除 | ACTIVE | 不变 | revoke active | 全撤销 | 幂等 |
| CorpID切换 | 不变 | 不变 | active 必须为 0 | 不变 | 有 active identity时 36020 |

### 8.1 为什么 offboard 不撤身份，但 soft-delete 撤身份

- offboard把同一个 User临时停用，现有系统允许业务恢复。保留绑定使恢复后无需重新占用身份。
- soft-delete和 account reopen结束旧 User代际。若不撤销 `WecomIdentity`，身份会永久卡在旧 User，新的 live User无法绑定。
- account reopen不自动转移身份，是为了维持“新账号需要重新证明身份”的安全边界，避免被重开操作静默继承旧外部凭证。

---

## 9. 锁序与并发不变式

### 9.1 全局锁序

```text
WecomSettings
  → Member（仅 member lifecycle 既有路径）
  → User
  → WecomIdentity
  → WecomAuthAttempt
  → RefreshToken / Audit
```

通知沿现有锁序：

```text
Notification
  → NotificationOutboxIntent
  → Member
  → Organization topology shared lock
  → User
  → RBAC grant chain
  → WecomIdentity
  → 事务提交
  → Provider HTTP
```

### 9.2 Settings 与首次绑定竞态

CorpID更新与首个 identity创建可能在 active count=0 时并发。解决方式：

- PATCH settings：`WecomSettings FOR UPDATE`，再检查 active identity count。
- bind/rebind：`WecomSettings FOR SHARE`，验证 attempt corpId等于锁后 settings corpId，再锁 User/Identity。
- 这样 CorpID切换不能穿透首个绑定。

### 9.3 身份占用竞态

- target `wecomUserId` 的占用预检查只做早提示，不跨用户锁目标 User，避免双向换绑死锁。
- 最终正确性由 active partial unique兜底。
- P2002 `meta.target` 对手写 partial index可能不稳定。Service必须同时识别列名和索引名；另加真实 PostgreSQL并发 e2e证明一个赢家、一个 36002，禁止裸 500。
- 不采用“任何 P2002都映射 36002”，因为同一事务还可能撞其他唯一键。

### 9.4 登录与清除竞态

两条路径统一 `User → WecomIdentity`：

- login先持锁：会话签发提交后 clear再撤 refresh；已签 access按 P0-E自然到期。
- clear先持锁：login锁后看到 identity revoked，拒绝签发 36010。
- 禁止 clear先锁 identity再锁 User。

### 9.5 OAuth attempt

- state消费使用 CAS：
  `WHERE stateHash=? AND status='pending' AND stateExpiresAt>now AND stateConsumedAt IS NULL`。
- bind ticket消费使用 CAS：
  `WHERE bindingTicketHash=? AND status='binding_required' AND bindingExpiresAt>now AND bindingConsumedAt IS NULL`。
- count=1才继续；count=0统一无效。
- Provider调用不在事务内。
- 外部调用成功但进程在状态推进前崩溃，用户重新发起；不尝试复活 code/state。

---

## 10. Notification Outbox 接入终态

### 10.1 新渠道与事件

```ts
NOTIFICATION_CHANNEL_WECOM = 'wecom';

OUTBOX_EVENT_WECOM_BROADCAST = 'notification.wecom-broadcast';
OUTBOX_EVENT_WECOM_DELIVERY = 'notification.wecom-delivery';
```

`NOTIFICATION_CHANNELS_ALLOWED` 扩展为：

```text
in-app
wechat
wecom
sms
```

规则：

- `in-app` 恒发。
- `wechat` 为微信小程序订阅消息。
- `wecom` 为企业微信应用消息。
- `sms` 仍只允许管理员显式计费确认，不随 publish自动发送。
- 系统 targeted payload的 channel parser允许 `in-app/wechat/wecom`，继续拒绝 targeted sms。

### 10.2 Payload

广播 root：

```json
{
  "notificationId": "c...",
  "publishGeneration": 3
}
```

逐人 child：

```json
{
  "notificationId": "c...",
  "memberId": "c...",
  "publishGeneration": 3
}
```

禁止：

```text
wecomUserId
corpId
agentId
access_token
CorpSecret
完整深链
Provider request/response
手机号
openid
JWT
binding ticket
```

### 10.3 EventKey

系统定向：

```text
wecom-delivery:{notificationId}:{memberId}
```

Admin广播 root：

```text
wecom-broadcast:{notificationId}:{publishGeneration}
```

Admin广播 child：

```text
wecom-delivery:{notificationId}:{rootIntentId}:{memberId}
```

Migration 新增 WeCom独立 active-slot partial unique。不得与微信小程序共用同一个不含 eventType的索引，否则同一通知同一人无法同时收两个渠道。

推荐形态：

```sql
CREATE UNIQUE INDEX "notification_outbox_wecom_delivery_active_unique"
ON "notification_outbox_intents" ("aggregateId", "destinationRef")
WHERE "eventType" = 'notification.wecom-delivery'
  AND "status" IN ('pending', 'processing');
```

### 10.4 受众解析

企业微信消息覆盖不是企业微信通讯录全员，也不是某个企业微信部门全员。第一版不拉通讯录、不展开应用可见范围，也没有接口可以提前精确判断每个成员的基础接口许可。因此冻结为“两阶段裁决”：

```text
发送前候选
  = Notification 在 SRVF 中的当前合法受众
  ∩ live ACTIVE User
  ∩ 当前合法 Member/App 准入
  ∩ 当前 CorpID 的 active WecomIdentity

最终送达资格
  = 发送前候选
  ∩ 企业微信 message/send 对当前 userid 的可见范围与接口许可裁决
```

业务结果：

- 未完成企业微信绑定的用户不创建企业微信广播 child intent，不按姓名、部门或标签补发。
- 未绑定不影响该 Notification 的站内信可见性；微信小程序、短信继续按各自已有 channel、quota、显式确认规则运行。
- 企业微信 Provider 只能逐 `wecomUserId` 发送，不允许为了提高覆盖率改用 `toparty`、`totag` 或企业微信群发绕过 SRVF 受众判断。
- `errcode=0` 仍必须检查 `invaliduser` 与 `unlicenseduser`；全部无效的 `81013` 也不得误记为 SENT。
- 运营验收必须分别记录“SRVF 可见受众数”“active identity候选数”“SENT数”“recipient-unavailable数”“recipient-unlicensed数”，不得混为同一指标。

#### 广播 root候选

1. 当前 settings `enabled && messageEnabled`。
2. 查询当前 CorpID下 active WecomIdentity。
3. 关联 live ACTIVE User，要求 `memberId != null`。
4. 候选 memberId交给 `NotificationRecipientAuthorizationService`按当前通知可见性过滤。
5. 去除本通知该 channel已 SENT者。
6. 每个 member创建 child intent。

#### Provider前最终闸

在同一事务里：

1. 锁 Notification与 intent fence。
2. 锁 Member，重读 ACTIVE、正式等级。
3. 取组织 topology shared lock。
4. 锁 live User，重读 ACTIVE/memberId。
5. management档锁后重读 GLOBAL RBAC grant chain。
6. 调用共享可见性规则。
7. 锁当前 CorpID下 active WecomIdentity。
8. 仅返回事务内快照的 `wecomUserId` 给事务外 Provider。
9. 任一步失败：
   - 资格已失效：effectPerformed=false，不发；
   - 无身份：记录 skipped/no-wecom-identity；
   - channel关闭：记录 skipped/channel-disabled。

### 10.5 共享收件人授权边界

新增：

```text
NotificationRecipientAuthorizationService
```

职责：

- 候选 member批量可见性过滤；
- Provider前 Member/User/Membership/RBAC最终复验；
- 固定锁序；
- 返回安全的内部 User snapshot。

不负责：

- 微信小程序 quota/template/openid；
- 企业微信 identity/token/消息格式；
- 短信手机号、资费、日限；
- Provider HTTP；
- Notification状态机；
- Outbox lease/ack/nack。

落地前必须先给现有微信小程序广播与定向路径补 characterization tests，再做零行为重构。WeCom不得以“顺手复用”为名直接复制当前 500+ 行受众逻辑。

### 10.6 消息呈现

第一版采用单收件人 `textcard`：

```json
{
  "touser": "USERID",
  "msgtype": "textcard",
  "agentid": 1000002,
  "textcard": {
    "title": "Notification.title 的安全裁剪",
    "description": "Notification.body 的纯文本安全摘录",
    "url": "https://example.com/notifications/NOTIFICATION_ID",
    "btntxt": "查看详情"
  },
  "enable_id_trans": 0,
  "enable_duplicate_check": 1,
  "duplicate_check_interval": 1800
}
```

规则：

- `title` 最多 128 个 Unicode 字符；`description` 最多 512 个 Unicode 字符；URL UTF-8 字节数最多 2048 且 production必须 HTTPS；按钮固定“查看详情”，不超过 4 个文字。
- description先纯文本化并转义，再只允许 Presenter自身生成 `<br>` 与 `<div class="gray|highlight|normal">`；绝不透传 Notification.body 中的任意 HTML。
- 开启企业微信 1800 秒重复消息检查作为第二层保险；SRVF Outbox幂等、SENT guard和 active-slot仍是主防线，不因此承诺 exactly-once。
- 不使用交互模板卡片。
- 不在消息中放身份证、手机、医疗信息、完整人员名单、详细审核备注、敏感行动位置。
- 不在 URL放 JWT、refresh token、state、ticket、signed URL。
- 用户点击后必须在 SRVF重新登录并走 App/Admin可见性检查。
- `WecomMessagePresenter`负责纯文本化、HTML转义、确定性裁剪和 URL拼装；它是 Presenter，不访问 Prisma。
- Provider按一名 `wecomUserId` 一次请求发送，`toparty/totag` 字段不得出现。逐人发送能得到可审计的 delivery，也避免企业微信部门与 SRVF组织不一致。

### 10.7 投递结果

`NotificationDelivery.channel='wecom'`。

新增 reasonCode：

```text
no-wecom-identity
channel-disabled
recipient-unavailable
recipient-unlicensed
token-failed
rate-limited
provider-contract-error
api-failed
```

规则：

- `recipientRef` 只保存掩码 wecomUserId。
- `SENT` 必须同时满足：`errcode=0`、当前单一 userid未出现在 `invaliduser`、未出现在 `unlicenseduser`；它只表示企业微信接口接受且未报告该收件人无效，不表示用户已看见或已读。
- `invaliduser` 或 `81013` 统一 terminal skipped/`recipient-unavailable`；官方无法可靠区分“userid不存在”与“不在应用可见范围”，第一版不得伪造更细原因。
- `unlicenseduser` 统一 terminal skipped/`recipient-unlicensed`，站内信继续可用；是否购买或激活许可由运营另行决定。
- 单 `touser` 请求若返回 `invalidparty/invalidtag`，视为请求契约错误 `provider-contract-error`，不得忽略。
- Provider `msgid` 可保存；原始 errmsg和完整响应不保存。
- 明确无身份、channel关闭、通知已失效为 terminal skipped。
- `40014/42001` 强刷 Token后仅重试一次；`-1` 最多3次；网络/超时/HTTP 5xx按既有暂态上限；`45009` 不自动盲重试，终态 dead/`rate-limited`供人工 replay。
- Provider已接受但本地未 ack的崩溃窗口仍可能重复发送；不宣称 exactly-once。卡片始终指向同一 notification，重复点击幂等。
- `enabled=false/messageEnabled=false` 时不允许“等恢复后迟到补发”；现有 intent终态 skipped。

### 10.8 发布与回滚的混版本风险

旧 Worker不认识 `notification.wecom-*`，可能将其判为 unsupported terminal dead。因此启用消息前必须：

1. 所有旧 Worker退出。
2. 新 API与新 Worker使用同一审核 digest。
3. Worker handler、strict parser和数据库 active-slot migration均已部署。
4. `messageEnabled`仍为 false完成 smoke。
5. 确认 fleet仅新版本后再启用。
6. 回滚前先关闭 messageEnabled，并用新 Worker排空或终结所有 WeCom intent；不得让旧 Worker接触新事件。

---

## 11. Permission、BizCode、Audit 规划

### 11.1 Permission

| Permission | 默认绑定 | 用途 |
|---|---|---|
| `wecom-setting.read.singleton` | ops-admin | 读取安全配置 |
| `wecom-setting.update.singleton` | ops-admin | 修改非凭证配置和开关 |
| `wecom-setting.test.connection` | ops-admin | 连接诊断 |
| `wecom-setting.reset.credentials` | 不绑定 ops-admin，SUPER_ADMIN短路 | 重置 CorpSecret |
| `user.wecom.clear` | ops-admin | 管理员清除企业微信身份 |

规则：

- Auth公开登录、pre-auth bind不走 RBAC。
- 本人 `me/wecom`不新增 permission，走登录身份与 step-up。
- 不新增 `361xx FORBIDDEN` BizCode，权限拒绝继续 30100。
- seed只 exact-upsert新增映射，不删除自定义映射。
- RBAC_MAP由生成器更新，禁止手改。

### 11.2 BizCode：360xx

| 常量 | code | HTTP | 语义 |
|---|---:|---:|---|
| `WECOM_IDENTITY_ALREADY_BOUND` | 36002 | 409 | 企业微信身份已被其他 active User占用 |
| `WECOM_LOGIN_CREDENTIAL_INVALID` | 36010 | 400 | state/code/内部身份无效，或绑定账号不可用；公开面统一 |
| `WECOM_BINDING_TICKET_INVALID` | 36011 | 401 | binding ticket无效、过期、已消费或状态不匹配 |
| `WECOM_CORP_ID_IN_USE` | 36020 | 409 | active identity存在时禁止修改 CorpID |
| `WECOM_CHANNEL_NOT_CONFIGURED` | 36030 | 503 | settings缺失、关闭、凭证缺失/无效、production Stub |
| `WECOM_API_FAILED` | 36031 | 502 | 企业微信上游、网络、超时或非法响应 |

复用：

- phone/短信无效继续 `SMS_CODE_INVALID=24010`。
- P2002 identity冲突映射 36002。
- 限流继续 `TOO_MANY_REQUESTS=42900`。
- User管理权限继续 30100/101xx既有语义。
- settings DTO无效继续 40000。

不开：

- `WECOM_NOT_BOUND`：GET返回状态对象，clear幂等。
- `WECOM_USER_DISABLED`：公开登录统一 36010，防侧写。
- `WECOM_EXTERNAL_USER`：无内部 UserId统一 36010。
- 企业微信发送失败 BizCode：异步落 Delivery/Outbox状态，不污染HTTP业务端点。

### 11.3 AuditLogEvent

新增 6 个：

```text
wecom-setting.update
wecom-setting.reset-credentials
auth.login.wecom
wecom.bind.self
wecom.rebind.self
wecom.clear.by-admin
```

规则：

- settings update只记 changedFields。
- reset-credentials不传 before/after/extra。
- login extra允许 `familyId/identityId/wecomUserIdMasked`。
- bind/rebind before/after只允许掩码身份；extra `viaPath=pre-auth|me`。
- clear before只允许掩码身份。
- OAuth code、state、binding ticket、CorpSecret、access token、完整 wecomUserId永不入 Audit。
- User soft-delete和 member account reopen复用既有 umbrella Audit，在 extra增加 `wecomIdentitiesRevoked`，不额外制造逐腿事件。
- Provider逐人投递不进 immutable Audit，投递事实归 NotificationDelivery/Outbox。

---

## 12. 通讯录、回调与机器人后续扩展边界

### 12.1 通讯录对账

后续另立目标：

```http
POST /api/admin/v1/wecom-directory-sync/preview
POST /api/admin/v1/wecom-directory-sync/execute
```

Preview只报告：

- 企业微信成员无 SRVF identity；
- active identity指向 disabled/deleted User；
- User有 identity但企业微信不再可见；
- 同一手机号候选冲突；
- 企业微信部门与 SRVF PRIMARY/SECONDARY/TEMPORARY/SUPPORT不一致；
- CorpID配置漂移。

Execute必须逐项显式选择，不按姓名猜人，不自动赋权限，不自动 offboard。

不新增 Cron。管理员触发时调用企业微信通讯录 API，结果作为短期诊断，不把完整通讯录复制进 SRVF。

### 12.2 入站回调和卡片

只有出现真实业务需求时才新增：

- callback Token；
- EncodingAESKey；
- `GET/POST /api/open/v1/wecom/callback`；
- 入站 event inbox；
- 模板卡片按钮事件；
- 回调幂等键；
- 官方 Crypto SDK或经审查的原生实现。

任何审批按钮都必须：

```text
验签/解密
  → wecomUserId → active WecomIdentity → User
  → 每请求身份有效性
  → AuthzService重新判权
  → 业务状态机重新判定
  → 正式业务Audit
```

企业微信签名只证明“请求来自企业微信”，不证明“这个人当前仍有审批权限”。

### 12.3 Bot / AI Assistant

Bot独立于 Agent身份主干。未来可做：

```text
企业微信 Bot消息
  → WecomIdentity
  → SRVF只读查询服务/Authz
  → 回复活动、值班、待办
```

Bot不得直接读数据库、不得保存另一套权限、不得把自然语言意图当成授权。

---

## 13. PR 拆分与写集

### T0：本评审稿

档位：A，docs-only。

文件：

```text
docs/archive/reviews/wecom-integration-t0-terminal-review.md
docs/ai-harness/NEXT_TASKS.md 或 goal记录
```

DoD：

- 维护者拍板 D-WC-1..31。
- 文件合入后冻结。
- 零 `src/prisma/test/workflow` 变动。

### T1：Schema expand-only

档位：D。

写集：

```text
prisma/schema.prisma
prisma/migrations/<timestamp>_wecom_identity_foundation/migration.sql
test/e2e/wecom-schema.e2e-spec.ts
changelog.d/<fragment>.md
```

内容：

- 三个 model；
- FK、CHECK、索引、active partial unique、singleton unique；
- User反向 relation；
- `SmsPurpose.WECOM_BIND` 若决定同 PR加入 enum；
- 零 runtime读写、零 endpoint、零 permission、零 audit；
- 干净库 deploy与现有库 migration preflight；
- 零回填、零删数、零默认身份绑定。

### T2：WeCom 通道层与设置

档位：D。

内容：

- `src/modules/wecom/**`；
- `WECOM_ENCRYPTION_KEY` config；
- settings四端点；
- Permission +4 setting codes；
- 36030/36031；
- Audit settings 2事件；
- 第11 throttler配置骨架；
- Unit/e2e、RBAC_MAP、CODEMAP、OpenAPI。

默认所有开关 false。

### T3：OAuth登录和绑定

档位：D。

内容：

- `WecomAuthAttemptService`；
- Auth四/五个 endpoint；
- `createSession`第四 expectation；
- `StepUpAction.WECOM_BIND`和action-bound identity fingerprint；
- App GET/PUT me/wecom；
- Admin clear；
- Permission `user.wecom.clear`；
- 其余 BizCode和Audit；
- refresh撤销；
- 防枚举、并发和锁序 e2e。

禁止夹带通知。

### T4：User生命周期闭环

档位：D。

内容：

- `UsersService.softDelete`同事务 revoke active identity；
- member account reopen旧 User identity revoke；
- 既有 umbrella Audit extra计数；
- offboard、disable、enable明确不改 identity；
- 并发回归与行为矩阵 e2e。

禁止顺手改 phone/openid现有不可复用规则。

### T5A：Notification recipient authorization重构

档位：B或D，按最终触碰锁与安全范围研判；默认按D处理。

步骤：

1. 先补 characterization。
2. 抽渠道无关受众判定和 Provider前最终闸。
3. 微信小程序、短信、站内现有行为逐字不变。
4. 不新增 wecom channel/event。
5. Existing e2e断言不删、不放宽。

### T5B：WeCom消息通道

档位：D。

内容：

- channel/event/reason；
- strict payload parser；
- envelope coherence；
- active-slot migration；
- root/child handler；
- WeCom Presenter/Dispatch；
- NotificationDelivery；
- admin DTO允许 wecom；
- targeted parser允许 wecom；
- Worker/fence/retry测试；
- 生产 runbook草案。

默认 messageEnabled=false。

### T6：运维与发布收口

档位：A/D/E按仓库流程拆分。

内容：

- 企业微信后台配置 SOP；
- 静态出口 IP与企业可信 IP核验（配置后等待官方生效窗口）；
- OAuth可信域名按届时后台要求配置并实测；
- 接口许可不做系统内采购/激活，Pilot以 `unlicenseduser` 实测覆盖并形成运营决策；
- Workbench主页；
- 新旧 Worker排空和同 digest；
- 10–30 人分层 Pilot 名单（普通队员、活动发起人、考勤审核人、部门负责人、超级管理员）；
- 至少一个未绑定手机号的专用测试账号或等价测试夹具；
- 失败注入；
- 回滚；
- current-state、CODEMAP、CHANGELOG、handoff、release。

---

## 14. 测试矩阵

### 14.1 Unit

| 组件 | 必测 |
|---|---|
| WecomCryptoService | roundtrip、篡改、Key缺失、独立 salt、错误不含密文 |
| returnPath policy | 相对路径、`//`、scheme、反斜杠、control char、token-like query |
| state/ticket util | state=32字节随机/64字符hex/官方字符集、hash、过期、一次性、不同目的隔离；binding ticket保持内部opaque随机 |
| DevStub | 确定性身份、故障码、禁日志 code |
| Real Provider OAuth | `/auth/getuserinfo`小写 `userid`成功、`openid/external_userid`、跨企业 `CorpId/userid`、ticket丢弃、40029/42003/42022、50001、HTTP错误、超时、非JSON |
| token cache | `expires_in`、corpId+agentId+generation隔离、提前刷新、refreshPromise并发合并、40014/42001单次强刷、失败清理 promise |
| agent/get | agentid匹配、close=0、可见范围仅计数、redirect_domain安全摘要、ID不出 service |
| message response | errcode=0但invaliduser/unlicenseduser、81013、invalidparty/tag契约错、msgid、-1最多3次、45009不盲重试 |
| message presenter | HTML转义、Unicode裁剪、深链固定、禁止 token/signed URL |
| error mapping | OAuth与消息域错误分层，敏感原文不外泄 |
| identity snapshot | WECOM_BIND包含 identity fingerprint，其他 action算法零变化 |

### 14.2 Auth/Identity E2E

1. settings缺失/关闭/Stub production-like拒绝。
2. authorize创建 hash-only attempt，URL含 `agentid`、编码一次的 fixed redirect_uri、`snsapi_base` 与 64字符hex state。
3. returnPath开放重定向攻击全拒。
4. state单次消费，并发两请求单赢家。
5. 已绑定登录签发与密码登录同形 session，refresh可轮换。
6. 未绑定返回 bindingRequired + ticket，不含 wecomUserId。
7. 未绑定响应不含 `hasPhone`、手机号尾号或账号状态侧信道。
8. 无绑定手机号用户可先用原账号登录，再以 PASSWORD/其他既有 factor step-up完成 self-bind。
9. `User.phone=null`、不存在手机号、停用或软删账号的 send-code逐字段同形，均不发送短信。
10. bound User DISABLED/soft-delete与 invalid code同码同形。
11. `openid/external_userid`、无小写 `userid`、跨企业 `CorpId/userid`统一 36010；`user_ticket/user_doc_ticket`不落任何持久层。
12. bind成功、bind重放、ticket过期、SMS错误。
13. 两 User并发绑定同一 wecomUserId：一成功、一36002，无500。
14. 同 User并发换绑：单赢家，active identity恒1。
15. login vs clear：锁序下无 stale签发穿透。
16. login vs disable：不破坏现有 User即时失效语义。
17. self rebind旧 proof在 admin clear后失效。
18. admin clear幂等，实际清除撤 refresh。
19. User soft-delete revoke identity。
20. account reopen revoke旧 identity，不转移到新 User。
21. offboard保留 identity但登录失败；恢复+enable后可登录。
22. Audit仅掩码，无 code/state/ticket/secret/token。

### 14.3 Notification E2E

1. 新 channel不改变现有 in-app/wechat/sms行为。
2. targeted payload允许 wecom，仍拒 targeted sms和未知 channel。
3. strict guard拒绝 wecomUserId/token/secret/URL敏感参数。
4. envelope与 payload不一致 fail-closed。
5. root generation key稳定。
6. child active-slot并发只一 active。
7. 微信小程序与 WeCom同一通知/同一人可以并行，各自独立索引。
8. candidate受众与 App feed可见性同义。
9. management只认 SUPER_ADMIN或当前 GLOBAL `notification.read.record`。
10. department认四类当前有效 Membership + Organization ACTIVE。
11. Provider前撤权/离队/解绑均阻止发送。
12. 广播只为 active WecomIdentity创建 child，未绑定用户不进入 WeCom fan-out。
13. 未绑定用户仍能在 App feed读取其有权看到的同一 Notification。
14. Provider发送参数只允许单一 `touser`，禁止 `toparty/totag` 绕过 SRVF受众。
15. identity在 child创建后被清除时，Provider前最终闸记录 skipped/no-wecom-identity。
16. channel关闭 terminal skipped，不迟到补发。
17. token 40014/42001强刷后只重试一次；-1最多3次；网络/5xx遵守既有上限；45009直接 rate-limited dead等待人工 replay。
18. Provider接受后本地崩溃的重复窗口不被误称 exactly-once。
19. `errcode=0`仍检查 invaliduser/unlicenseduser；81013/许可缺失正确记 skipped，NotificationDelivery只存 masked recipientRef。
20. textcard精确限制、单touser、无toparty/totag、duplicate check=1/1800均有契约断言。
21. unpublish/archive/delete root授权闸停止后续发送。
22. 旧 Worker不可见新事件的runbook守卫测试或 smoke探针。

### 14.4 回归

```bash
pnpm lint
pnpm typecheck
pnpm harness:selftest
pnpm docs:counts:check
pnpm docs:codemap:check
pnpm docs:rbacmap:check
pnpm docs:openapi:check
pnpm test
pnpm test:contract
pnpm build
pnpm test:e2e
```

必须额外跑：

- auth全部现有 e2e；
- users/member lifecycle；
- app-me；
- wechat settings/login/subscribe；
- notifications/outbox；
- throttler；
- Audit敏感信息；
- Docker smoke；
- production dependency audit。

既有测试禁止删除或放宽。若现有断言必须改变，视为行为契约变化，暂停上报。

---

## 15. 生产切换硬门

### 15.1 身份链 GO 条件

- 企业微信自建应用已创建。
- CorpID、AgentId、CorpSecret由维护者在后台录入。
- 应用可见范围只包含经维护者确认的 10–30 名分层试点成员。
- `webBaseUrl` HTTPS origin已配置。
- OAuth可信域名/回调域名按企业微信后台届时规则配置，并以真实 OAuth成功为验收，不把具体后台规则硬编码进 T0。
- 服务器静态出口 IP已加入企业微信“企业可信 IP”，并等待配置生效后再验收。
- production `WECOM_ENCRYPTION_KEY`已安全注入。
- DEV_STUB双重禁用已 smoke。
- state/ticket表 migration已部署。
- 登录限流使用 PostgreSQL shared storage。
- 试点账号完成 SMS首次绑定，以及“无绑定手机号 → 原账号登录 → step-up self-bind”兜底演练。
- 企业微信客户端工作台 H5登录已验收；普通 PC 浏览器扫码登录明确不在第一版验收范围。
- disable/enable、offboard/恢复、soft-delete、account reopen和admin clear演练完成。
- 日志中无完整 URL/code/state/ticket/wecomUserId/token/secret。
- `loginEnabled`启用前 `enabled=true`，`messageEnabled=false`。

### 15.2 消息链 GO 条件

除身份链条件外，还必须：

- 当前 Notification Outbox生产基线已部署并通过现有 runbook。
- 旧 API/Worker全部退出。
- API和 Worker digest一致。
- WeCom handler、strict parser、active-slot migration均存在。
- messageEnabled=false状态下完成 no-effect smoke。
- 单人定向消息试发成功，Delivery与企业微信终端一致；若返回 `unlicenseduser`，必须正确降级为 recipient-unlicensed而非 SENT。
- 撤权、离队、解绑的 Provider前最终闸演练成功。
- Provider故障、token失效、DB故障、Worker crash注入完成。
- rollback前排空策略已演练。
- 监控可区分 sent/recipient-unavailable/recipient-unlicensed/rate-limited/failed/dead，但不记录敏感目标。
- 已验证同一 SRVF可见通知下：已绑定试点成员收到 WeCom，未绑定成员不收 WeCom但仍可读站内信。
- 已验证不使用企业微信部门、标签或群聊作为业务消息绕过路径。

### 15.3 试点范围与扩大条件

首轮试点规模固定为 **10–30 人**，应用可见范围不得先开全员。试点至少覆盖：

- 普通队员；
- 活动发起人或活动责任人；
- 考勤一级审核人和/或终审人；
- 部门负责人或组织管理员；
- SUPER_ADMIN；
- 至少一个未绑定手机号的专用测试账号或等价测试夹具。

试点按三步启用：

```text
A. messageEnabled=false，仅验证工作台登录、首次绑定、self-bind与生命周期
B. 先向 1–3 名试点人员发送定向消息，核对终端与 Delivery，并记录是否出现 invaliduser/unlicenseduser
C. 扩到全部试点人员，仍不扩大企业微信应用可见范围
```

扩大范围前必须完成并留证：

1. 首次短信绑定与重复免密登录；
2. 无手机号用户通过原账号登录后 self-bind；
3. User disable/enable；
4. Member offboard/恢复；
5. User soft-delete与 member-account reopen不继承旧身份；
6. 管理员清除绑定及旧 proof失效；
7. 已绑定且有资格者收到消息；
8. 未绑定者不收 WeCom但站内信仍可见；
9. Provider前撤权、离队或解绑阻止发送；
10. messageEnabled关闭、Worker排空和回滚无迟到补发。

扩大条件：全部场景通过、无未关闭 P0 问题、P1 风险有明确处置，且由维护者签署“扩大企业微信应用可见范围”。不能以“接口能通”或“试用了几天没报错”代替上述验收。

### 15.4 回滚

身份链回滚：

```text
loginEnabled=false
  → enabled可保留
  → 现有 JWT继续按原规则运行
  → schema/identity历史保留
  → 密码/短信/微信小程序登录不受影响
```

消息链回滚：

```text
messageEnabled=false
  → 停止创建新 WeCom intent
  → 新 Worker终结/排空现有 WeCom intent
  → 确认 pending/processing=0
  → 再回滚 API/Worker
```

禁止：

- 回滚时删表、删 identity历史、移动 tag。
- 让旧 Worker处理新 eventType。
- 把失败 intent直接改 SENT。
- 为清空队列物理删除未审计数据。

---

## 16. 风险表

| 风险 | 等级 | 对策 |
|---|---|---|
| 把企业微信和小程序 openid混用 | P0 | 独立模块、表、错误码、channel |
| 企业微信通讯录越权成为权限源 | P0 | 权威矩阵冻结；不自动同步组织/权限 |
| stale identity在 clear后仍签会话 | P0 | User→Identity锁序 + createSession锁后 expectation |
| 旧 step-up proof重新绑回被清身份 | P0 | WECOM_BIND action额外 identity fingerprint |
| account reopen后身份卡在旧 User | P0 | 旧 User soft-delete同事务 revoke，不自动转移 |
| CorpID切换与首绑并发 | P0 | settings FOR UPDATE/SHARE + 锁后 corp二次校验 |
| 旧 Worker杀死新 WeCom event | P0 | fleet同 digest、开关后置、排空 runbook |
| Outbox持久化外部身份/Secret | P0 | strict parser、forbidden key/value、payload只存内部引用 |
| 复制微信受众逻辑形成双真相 | P1 | T5A先抽共享授权边界 |
| 外部消息重复 | P1 | 明确 at-least-once、幂等深链、SENT guard + 企业微信1800秒重复检查 |
| 企业微信 UserId被企业管理员复用 | P1 | 运维规则禁止复用；删除/重建必须先清绑定；后续目录对账 |
| 应用可见范围配置错误 | P1 | 10–30 人分层试点、invaliduser/81013→recipient-unavailable、连接和投递诊断 |
| 把企业微信通讯录人数误当成消息覆盖人数 | P1 | 分别报告 SRVF受众、active identity候选、SENT、不可用与无许可人数 |
| 基础接口许可未知或过期 | P1 | unlicenseduser→terminal skipped，站内信降级；Pilot后由运营决定是否补许可，不在代码里自动购买/激活 |
| 无手机号用户被困在短信绑定页 | P1 | 前端显式提供“原账号登录后绑定”路径；后端保持防枚举 |
| 把工作台 H5误解为 PC扫码登录 | P2 | 首页、决策表、本期未做和验收范围四处显式锁定 |
| OAuth open redirect | P1 | webBaseUrl固定 origin + returnPath严格相对路径 |
| Secret/token进入日志 | P1 | 禁完整 URL/body/error原文；单元与日志探针 |
| 消息包含敏感业务正文 | P1 | Presenter只发摘要和安全深链 |
| 第11 throttler误串现有配额 | P2 | 独立 name + PostgreSQL key |
| 进程内 token cache多实例重复取 token | P3 | 接受性能成本；不影响正确性；不引 Redis |
| 手动 retention积累短期记录 | P3 | SOP + 指标，不新增 Cron |

---

## 17. 本期未做

- 企业微信通讯录全量/增量同步。
- 企业微信部门到 SRVF组织映射。
- 企业微信标签到 RoleBinding映射。
- 企业微信职位到 PositionAssignment映射。
- Admin批量预绑定身份。
- 普通 PC 浏览器的企业微信扫码登录、网站扫码登录或二维码会话接力；PC 管理后台继续使用原有登录方式。
- 外部联系人身份。
- unionid/open_userid兼容层。
- 多 CorpID、多 Agent、多账号。
- 回调 Token/EncodingAESKey。
- 接收消息、菜单事件、通讯录变更事件。
- 交互模板卡片和一键审批。
- 群机器人、AI助手、自然语言写操作。
- 企业微信文件/语音/视频收发。
- Redis token cache、分布式锁、BullMQ。
- 第三个 Cron。
- 外部身份万能表。
- 自动修复、自动离队、自动改权限。
- WECOM_ENCRYPTION_KEY在线轮换。
- 企业微信接口许可的购买、激活、续期或自动分配。
- 可信域名、可信 IP等企业微信后台配置的自动化管理。
- exactly-once投递承诺。

---

## 18. 最终 DoD

T0冻结完成：

- [ ] 维护者拍板 D-WC-1..31。
- [ ] 文件以建议路径合入。
- [ ] NEXT_TASKS/goal记录对应实施序列。
- [ ] 本稿合入后不回改。

代码完成：

- [ ] 三个 model与所有约束按 T1落地。
- [ ] WeCom settings/Provider默认 disabled。
- [ ] OAuth authorize含 agentid、单次URL编码redirect_uri与64字符hex state；`/auth/getuserinfo`小写字段、code≤512字节/一次性/5分钟已锁定。
- [ ] OAuth state、binding ticket一次性且 hash-only。
- [ ] `createSession`第四 expectation锁后校验。
- [ ] WECOM_BIND proof包含身份 fingerprint。
- [ ] 无手机号用户可经原账号登录 + 现有 step-up完成 self-bind，且 pre-auth响应不泄露手机号绑定状态。
- [ ] 生命周期矩阵全部有真实 DB e2e。
- [ ] 通知共享受众授权边界零行为重构。
- [ ] WeCom消息只覆盖当前合法且已绑定人员；未绑定人员的站内信行为零回归。
- [ ] Provider不存在 `toparty/totag` 业务群发旁路。
- [ ] WeCom event/payload/envelope/active-slot严格锁定。
- [ ] provider外部调用全部在主业务事务外。
- [ ] 无敏感数据进入日志、Audit、OpenAPI示例或 Outbox。
- [ ] 全量 Harness/contract/e2e/smoke绿色。
- [ ] OpenAPI diff逐行可解释。
- [ ] RBAC_MAP/CODEMAP/current-state/CHANGELOG/handoff同步。

生产完成：

- [ ] 现有 v0.63.0及前置 migrations已部署。
- [ ] Notification Outbox生产硬门已关闭。
- [ ] 企业微信可信域名、静态可信 IP、应用可见范围已按上线时后台规则核验。
- [ ] 接口许可不被假设为全员具备；Pilot已验证 unlicenseduser 的降级和运营处理。
- [ ] 10–30 人分层身份链试点完成，并覆盖普通队员、活动发起人、考勤审核人、部门负责人和 SUPER_ADMIN。
- [ ] 无手机号 self-bind、PC扫码不在范围、disable/恢复、offboard/恢复、soft-delete、reopen、admin clear均有验收证据。
- [ ] 消息链同 digest切换与故障演练完成。
- [ ] 已绑定/未绑定对照验证通过：前者按资格收 WeCom，后者不收 WeCom但仍可读站内信。
- [ ] 回滚排空演练完成。
- [ ] 维护者签署最终 production GO。

---

## 19. 官方协议与仓库参考

### 19.1 企业微信协议锚点

- 企业微信开发者中心：`https://developer.work.weixin.qq.com/`
- OAuth authorize：`https://open.weixin.qq.com/connect/oauth2/authorize`
- code换企业成员身份：`https://qyapi.weixin.qq.com/cgi-bin/auth/getuserinfo`
- 获取 access token：`https://qyapi.weixin.qq.com/cgi-bin/gettoken`
- 获取指定应用详情：`https://qyapi.weixin.qq.com/cgi-bin/agent/get`
- 发送应用消息：`https://qyapi.weixin.qq.com/cgi-bin/message/send`
- 官方错误判定：只按 `errcode`，不按 `errmsg`; OAuth code `40029/42003/42022`; Token `40014/42001`; 配置 `50001/50003/60020`; 发送 `81013/invaliduser/unlicenseduser`; 限流 `45009`
- 企业微信官方团队 Agent/Bot实现参考：`https://github.com/WecomTeam/wecom-openclaw-plugin`

实施 PR必须再次用当日官方文档或官方调试工具核对字段、错误码、消息限制和域名配置；若官方协议已变化，暂停并更新实施方案，不以第三方博客覆盖官方事实。

### 19.2 第一版官方协议冻结摘要（2026-07-29）

| 场景 | 第一版冻结值 |
|---|---|
| OAuth URL | `appid=CorpID`、URL Encode后的固定 `redirect_uri`、`response_type=code`、`scope=snsapi_base`、64字符hex `state`、必带 `agentid`、`#wechat_redirect` |
| OAuth code | 最大512字节、只能使用一次、5分钟过期 |
| 身份接口 | `GET /cgi-bin/auth/getuserinfo`；只接受小写 `userid` |
| 丢弃字段 | `openid`、`external_userid`、`user_ticket`、`user_doc_ticket`、原始响应 |
| Token | `GET /cgi-bin/gettoken`；以 `expires_in` 为准并按应用缓存；40014/42001只强刷一次 |
| 连接诊断 | `GET /cgi-bin/agent/get`；验证 agentid与close，只返回安全摘要 |
| 应用消息 | `POST /cgi-bin/message/send`；单 `touser`、`msgtype=textcard`、禁止 `toparty/totag` |
| 文本卡片 | title≤128字符、description≤512字符、URL≤2048字节且含协议头、btntxt≤4文字 |
| 重复检查 | `enable_duplicate_check=1`、`duplicate_check_interval=1800` |
| 发送成功 | `errcode=0` 且单一userid不在 invaliduser/unlicenseduser；SENT不等于已读 |
| 许可缺失 | `unlicenseduser`→recipient-unlicensed，站内信继续，运营另决 |
| 收件人不可用 | `invaliduser`或81013→recipient-unavailable，不伪造具体子原因 |
| 系统繁忙 | `-1`最多3次 |
| 频率限制 | `45009`不自动盲重试，人工在窗口后 replay |
| 外部后台配置 | 静态可信IP、可信域名、接口许可均为production GO门禁，不进入第一版自动管理 |

### 19.3 仓库内母本

- `docs/archive/reviews/wechat-mini-login-review.md`
- `docs/archive/reviews/unified-notification-dispatcher-review.md`
- `docs/archive/reviews/member-account-loop-v2-review.md`
- `docs/reference/auth-jwt-refresh.md`
- `docs/api-surface-policy.md`
- `docs/architecture-boundary.md`
- `docs/current-state.md`
- `AGENTS.md`
- `src/modules/auth/**`
- `src/modules/users/**`
- `src/modules/wechat/**`
- `src/modules/notifications/**`
- `prisma/schema.prisma`

---

> **冻结口令**：维护者回复“按推荐”，即表示 D-WC-1..31 全部拍板。随后本文件可作为 T0 docs-only PR 合入并冻结。  
> **实施纪律**：任何新发现只能按 `docs/process.md §4.1` 上报，不顺手扩范围；写与查必须跨模型；每个 PR 收尾明确列出“本次未做”。
