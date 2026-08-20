# 短信闭环测试 —— 证明「这套系统能用腾讯云短信」

> **状态**:⚠️ **未实测**(脚本已按仓库实况写好,**所有请求体与响应字段均逐个对着真实 DTO 类核过**;尚未在真机跑过)。
> 跑完把结论回填到 §6。
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

⚠️ **⑥ 的 `providerMsgId` 非空是关键判据** —— 它是腾讯云返回的 SerialNo。
接口返回 200 只说明**我们受理了**,`providerMsgId` 非空才说明**腾讯云受理了**。
两者之间差着整条网络与鉴权链路。

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

## 5. 本脚本**不**覆盖:通知模板(紧急召集兜底)

`templateIdNotification` 的链路要**真发一条紧急召集**才算验过,涉及业务侧操作,
不适合塞进这支脚本。见 checklist 验收第 4 条 —— 那条明写
**「不能靠等它自己触发」**(紧急召集是低频动作,不主动发一次就等于没验)。

⇒ **验证码链路 PASS ≠ 短信通道全部可用。** 两条要分别声称。

## 6. 实测结论(跑完回填)

```
日期:
环境:
验证码链路:
通知链路:
备注:
```

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
