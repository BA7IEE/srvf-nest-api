# 短信闭环测试 —— 证明「这套系统能用腾讯云短信」

> **状态**:**验证码链路 + 通知链路均 PASS**(2026-08-20 真机实测,两轮)。
>
> 🔴 **但请先读 §6.5** —— 实测拿到一个反例:`status=SENT` 且 `providerMsgId` 非空,
> **手机仍未收到**(运营商免打扰名单)。`SENT` 是**已提交 Provider**,**不是已送达终端**。
>
> 配套:[`sms-production-rollout-checklist.md`](./sms-production-rollout-checklist.md)(录入侧 SOP)。
> 本文只管**录入之后怎么验**。

## 0. 为什么单列一份

和 COS 那支的关系:同样是「证明系统能用这个外部服务」,但**短信无法全自动** ——
验证码必须真手机收。所以是**半自动**:脚本发起 → 你读手机输码 → 脚本回验并核对留痕。

🔴 **手机号不写进脚本、不进仓库**。仓库红线 **A-9(R13)**:
真实成员 PII(姓名 / 身份证号 / **手机号**)不进 git history
(2026-06-21 维护者拍板,`docs/V2红线与复活路径.md:86`;公开仓库已知情)。
脚本改为运行时输入,输出**一律掩码**。

## 1. 测什么

| 步骤 | 真实发生的事 | 判据 |
|---|---|---|
| ① 读配置 | 不发短信 | providerType=TENCENT_SMS · enabled · credentialStatus=**CONFIGURED** · 两个模板 ID 已录入 |
| ② step-up | 密码二次验证 | 拿到 5 分钟有效的 `stepUpToken`(绑手机强制要求) |
| ③ **真发短信** | 腾讯云受理并下发 | 接口返回 `code=0` |
| ④ 真机接收 | **你的手机响** | 你能读到 6 位码 |
| ⑤ **回验** | 码真的可用 | `PUT /app/v1/me/phone` 通过 ⇒ 发码→收码→回验闭合 |
| ⑥ 留痕 | 可审计 | `status=SENT` · `providerMsgId` **非空** · 手机号**掩码** |

⚠️ **⑥ 的 `providerMsgId` 非空是关键判据,但它只管到腾讯云那一段** —— 它是腾讯云返回的 SerialNo。
接口返回 200 只说明**我们受理了**,`providerMsgId` 非空才说明**腾讯云受理了**。

🔴 **它证明不了手机收到**(2026-08-20 实测反例,见 §6.5):
`status=SENT` + `providerMsgId` 非空 + `errCode=null`,而终端因**运营商免打扰名单**未收到。
⇒ **必须同时确认真机响了**,不能只看留痕。

⚠️ **收不到短信时不要直接判失败** —— 脚本会继续查留痕,帮你分清两种情况:
「没发出去」(providerMsgId 为空 / status≠SENT)vs「发了但没到」(留痕正常但手机没响,
多半是运营商拦截,凭 providerMsgId 找腾讯云查回执)。

## 2. 怎么跑

```bash
./scripts/ops/sms-closed-loop-test.sh https://srvf-dp.23cc.cn <super-admin-username>
```

手机号和密码都在运行时问,**不走命令行参数**(不进 shell history,`ps` 也看不到)。
需要 `bash 4+`、`jq`、`curl`。

⏱ **②–⑤ 要在 5 分钟内做完** —— `stepUpToken` 只有 5 分钟有效期。手机放手边再开跑。

## 3. 前置:通道得先录入

脚本第 ① 步就是查这个,没配好会直接停下并告诉你缺什么。
录入见 [`sms-production-rollout-checklist.md`](./sms-production-rollout-checklist.md) §5。

## 4. 关键实现约束(改脚本前先看)

- **绑手机需要 step-up**(`BindMyPhoneDto` 要 `phone` + `code` + `stepUpToken`),
  所以流程里必须先 `POST /auth/v1/step-up/password`,`action` 固定为 **`PHONE_BIND`**。
- ⭐ **绑手机这个口专门支持没有 Member 的管理员账号** ——
  `app-me.controller.ts` 注释:「Admin 无 Member 也需绑定,故**不**调
  `appIdentity.resolve` + `assertCanUseApp`」。所以 SUPER_ADMIN 直接能用,不必先建队员。
- **send-logs 里的 `phone` 字段本身就是掩码**(`sms-send-logs.service.ts` 的
  `phone: maskPhone(row.phone)`;DTO 描述写明「一律掩码」)⇒ 脚本断言它含 `*`,
  **断言失败要当安全问题停下取证**,不是显示问题。
- **production 禁用 DEV_STUB**(`sms-provider.router.ts`:「production-like 环境禁用 DEV_STUB 通道」)
  ⇒ 生产上只可能是 `TENCENT_SMS`,配成 stub 会直接拒发。
- **三个模板相互独立**:`missingRuntimeParams(settings, template)` 按 template 分别校验
  ⇒ 缺生日模板不影响验证码与通知。

## 5. 通知模板链路:脚本不覆盖,已于 2026-08-20 手工验过

`templateIdNotification` 的链路要**真发一条通知**才算验过,涉及业务侧操作(建草稿 → 发布 →
受众计算 → 计费确认),不适合塞进这支脚本。**已手工完成,结论见 §6.4。**

手工步骤(可重复):
1. `POST /admin/v1/notifications` 建草稿 —— `channels: ["in-app","sms"]` **必须显式含 `sms`**
2. `POST /admin/v1/notifications/{id}/publish` —— ⭐ **发布本身不发短信**(实测确认)
3. `POST /admin/v1/notifications/{id}/send-sms` `{"confirmed":false}` —— **安全预览,零发送**
4. 核对 `recipientCount` **与人工预期完全一致**后,再 `{"confirmed":true}`

🔴 **第 3 步是硬要求不是建议** —— 见 §6.6。

## 6. 实测结论

### 6.1 结论

**2026-08-20 · 腾讯云 SMS 验证码真实闭环:PASS**(维护者在真机实测)。

走通的是完整业务链,不是 Mock、不是 DEV_STUB、也不是只看接口返回 200:

```
SRVF API → 腾讯云 SMS → 真实手机收码 → 验证码校验 → 手机号绑定 → 发送日志
```

环境:`https://srvf-dp.23cc.cn` · `APP_ENV=production` ·
`sdkAppId=1401142432` / `signName=深圳市公益救援` / `region=ap-guangzhou` ·
`templateIdVerifyCode=2675279` / `templateIdNotification=2675285`。

### 6.2 关键读数

| 步骤 | 实测 |
|---|---|
| step-up(`action=PHONE_BIND`) | 成功(token 不回显) |
| `POST /app/v1/me/phone/send-code` | `code=0`,`expiresInSeconds=300` |
| 真机接收 | ✅ 收到「深圳市公益救援」签名的 6 位码 |
| `PUT /app/v1/me/phone` | `code=0`,`phone=139****6288`,`phoneVerifiedAt` 已落库 |
| 发送留痕 | `status=SENT` · `providerType=TENCENT_SMS` · **`providerMsgId=99:140053352417872116629479628`** · `errCode=null` · 手机号掩码 |

⭐ **`providerMsgId` 非空是这一轮最硬的一条** —— 它是腾讯云的发送回执,
证明请求**真的到达了腾讯云并被受理**,而不是只有本地接口返回成功。

由此一并证实:凭据可解密可用 · SDK AppID 可用 · 签名匹配 · 模板匹配 ·
**模板参数数量与顺序正确** · 服务器→腾讯云网络通 · 腾讯云→运营商→手机链路通。

### 6.3(原「本轮未证明的事」—— 已于同日补验闭合,见 6.4)

### 6.4 通知模板链路:PASS(2026-08-20 第二轮)

模板 `2675285`,走完整业务链:建草稿 → 发布 → 受众计算 → 计费预览 → 显式确认 → 腾讯云 → 运营商 → 真机。

| 验收项 | 实测 |
|---|---|
| `channels` 含 `sms` 才可发 | ✅ |
| **发布本身不发短信** | ✅ `publish` 后零发送 |
| `confirmed=false` 预览 | ✅ `recipientCount=1` / `sent=0` |
| `confirmed=true` 真发 | ✅ `sent=1` / `failed=0` |
| `templateKey` | **`notification`**(与验证码轮的 `verify-code` 分属两条路) |
| `providerMsgId` | `99:3375363021…` 非空 |
| 手机号留痕 | 掩码 |
| **真机收到** | ✅(第二号码) |

⇒ 验证码与通知两条 SMS 链路**均已完成真机验证**。

### 6.5 🔴 实测反例:`SENT` ≠ 已送达

第一个测试号码给出了明确反例:

| 系统侧 | 腾讯云控制台 |
|---|---|
| `status=SENT` · `providerMsgId=99:2507238470…` 非空 · `errCode=null` | 提交状态**成功** / 送达状态**失败** / 原因:**运营商免打扰名单** |

**手机始终没收到。**

⇒ 当前 `sms_send_logs.status` 的 `SENT` 表达的是「**Provider 已接受 / SendSms 请求成功**」,
**不是**「用户已收到短信」。`SmsSendStatus` 只有 `SENT` / `FAILED` 两态,
且全仓**无任何送达回执 / 状态回调链路**。

⚠️ **这条推翻了本文档早先的说法** —— 原文把 `providerMsgId` 非空写成「最硬的一条」,
当时的措辞暗示它能证明送达。它只证明到腾讯云那一段。
⇒ **验收必须同时确认真机响了**,只看留痕会得出错误结论。

改进项(状态语义细化 + 回执回调)已登记 `NEXT_TASKS` **P2-10**。

### 6.6 🔴 `confirmed=false` 预览是硬要求,不是建议

实测确认安全阀有效:`confirmed=false` 时 `sent=0`,只返回 `recipientCount`。

**规则**:任何人工广播 SMS 真实发送前**必须先跑一次 `confirmed=false`**,
**只有 `recipientCount` 与人工预期完全一致才允许 `confirmed=true`**。

本轮若无此检查,就存在**误发真实队员 + 产生短信费用**的双重风险。

### 6.7 本轮暴露的前置条件错误(本文档原文写错了)

原文假设「SUPER_ADMIN 绑了手机就能当通知短信收件人」。**不成立。**

通知广播 SMS 的收件人链是:

```
ACTIVE Member → 满足通知 visibility → 关联 ACTIVE User → User.phone 非空
```

`david` 的 `memberId` 为 `null` ⇒ **无论绑不绑手机都不会成为收件人**。
且 `account/bind` 护栏只允许绑 `role=USER` 的悬空账号,不能为测试把 SUPER_ADMIN 挂到 Member。

**正确前置**:准备一个 **ACTIVE Member + 关联 ACTIVE USER**,`User.phone` 为唯一测试号;
发送前必须 `confirmed=false` 并核对 `recipientCount`。

另:`visibilityCode` 用 **`member`** 而非 `management` —— 普通 USER 测试账号不在 management 可见范围内。

### 6.8 部署版本漂移(非本轮故障,但值得记)

实测时服务器上的 `Member` 仍是 `displayName`,而 main 已演进为 `realName` / `nickname`
(#1048 T1)⇒ 按新代码写的 SQL 报 `column m.realName does not exist`。

⇒ **运维 / 验收脚本必须以实际部署的 commit 与 schema 为准**,不能拿当前 main 的 DTO/schema 假设已部署。

### 6.4 本轮暴露的两处文档缺陷(均已修)

1. **`sms-production-rollout-checklist.md` §6 契约漂移** —— 第 2 步的绑定示例只写
   `phone` + `code`,**漏了 `stepUpToken`**;而 `BindMyPhoneDto` 是三个必填字段,
   且该 token 必须是 `action=PHONE_BIND` 的 5 分钟 proof。**照旧文操作会直接失败。**
   已补一整步(取 step-up)并订正示例。
2. **脚本当时尚未合入仓库** —— 实测在 07:41,脚本随 #1103 于 07:46 合入,差 5 分钟。
   本轮按本文档定义的步骤逐项手工执行,覆盖范围与脚本一致。

## 7. 排错

| 现象 | 含义 |
|---|---|
| ① 就停下 | 通道没录入或录错,按提示补 §5 |
| ③ 返回 24030 | 通道未配置 / enabled=false / 凭据状态不对 |
| ③ 返回 24031 | **腾讯云拒发** —— 签名或模板未过审 / 变量数不符 / 子账号无 `sms:SendSms` 权限 |
| ③ 返回 24120 / 24121 | 系统侧防刷(同号间隔 / 日上限),**属预期行为**,等一会再试 |
| 留痕 `status=SENT` 但手机没收到 | 运营商侧拦截,凭 `providerMsgId` 向腾讯云查回执 |
| 留痕 `providerMsgId` 为空 | 请求**没到**腾讯云,查凭据与网络 |
| ⑤ 回验失败 | 码输错 / 超时 / `stepUpToken` 过期(5 分钟) |
| 留痕手机号是明文 | 🔴 **停下取证** —— 掩码是安全要求,不是显示偏好 |
