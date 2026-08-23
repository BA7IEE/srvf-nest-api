# SRVF API — 腾讯云 SMS 生产上线运维清单(验证码 + 通知 + 生日祝福**三**模板)

> **性质**:运维侧 SOP(沿 [`cos-production-rollout-checklist.md`](cos-production-rollout-checklist.md) 范式);系统侧能力已随 SMS 基础设施 T1-T3 就绪,**本清单是真实通道开通的唯一接力入口**。
> **权威源**:行为契约见冻结评审稿 [`docs/archive/reviews/sms-verification-infra-review.md`](../archive/reviews/sms-verification-infra-review.md);字段事实见 [`prisma/schema.prisma`](../../prisma/schema.prisma) `SmsSettings`。

## 0-pre. 当前实况(2026-08-20 · **验证码链路已真机 PASS**)

| 项 | 状态 |
|---|---|
| 签名「深圳市公益救援」 | ✅ 已生效;验证码/通知 **报备成功** |
| 验证码模板 `2675279` | ✅ 已生效 · **已录入** · **已真机验发验收** |
| 通知模板 `2675285` | ✅ 已生效 · **已录入** · ✅ **已真机验发**(2026-08-20 第二轮) |
| 生日祝福模板 | ⏸ **未建**(只影响生日祝福,不阻塞其余两条链) |
| `sms_settings` 录入 | ✅ **已完成**:`sdkAppId=1401142432` / `region=ap-guangzhou` / `credentialStatus=configured` |

**验证码闭环实测(2026-08-20)**:step-up → 真发 → 真机收码 → 回验绑定 → 留痕,
`providerMsgId=99:1400533524…` 非空、手机号留痕掩码。详见
[`sms-closed-loop-test.md`](./sms-closed-loop-test.md) §6。

**通知链路实测(2026-08-20 第二轮)**:建草稿 → 发布 → 受众计算 → `confirmed=false` 预览
→ `confirmed=true` 真发 → 真机收到 → 留痕 `templateKey=notification`。两条链路均已验。

🔴 **但 `SENT` 不等于已送达** —— 同轮拿到反例:`status=SENT` + `providerMsgId` 非空,
手机因**运营商免打扰名单**未收到。`SENT` 只表示「已提交腾讯云」。
详见 [`sms-closed-loop-test.md`](./sms-closed-loop-test.md) §6.5,改进项登记 `NEXT_TASKS` P2-10。

⚠️ **签名内容要逐字填进 `signName`** —— 是「深圳市公益救援」(七个字),不是队伍全名。
填错腾讯云返 `FailedOperation.SignatureIncorrectOrUnapproved`。

📌 与 COS 不同的两点,可以放心:
- SMS **不做 boot fail-fast**(`sms-settings.service.ts` 注释:「SMS 是可选基础设施,production 未配置合法」)⇒ 配错不会让服务起不来。
- 全部配置走 **PATCH 管理接口**,没有「只接受空表、写错不能重来」的 bootstrap ⇒ **填错可以直接改**。

---

## 0. 用法说明

### 0.1 谁在读

- **运维侧**(腾讯云控制台操作人):§2 / §3 / §4
- **维护者 / SUPER_ADMIN**(admin API 操作人):§5 / §6
- 全部步骤完成前,production 的 SMS 端点返回 `SMS_CHANNEL_NOT_CONFIGURED`(24030),**不影响其他功能**(SMS 是可选基础设施,无启动 fail-fast)。

### 0.2 怎么读

- 按 §1 → §6 顺序执行,每节末尾有"校验"步骤;任一校验不过,**不进入下一节**。
- 占位符:`<SDK_APP_ID>` / `<SIGN_NAME>` / `<TEMPLATE_ID_VERIFY>` / `<TEMPLATE_ID_BIRTHDAY>` / `<SECRET_ID>` / `<SECRET_KEY>` / `<REGION>`(如 `ap-guangzhou`)。

## 1. 前置门槛

### 1.1 系统侧已就位(必读,部署侧确认)

- [ ] 部署环境 env 已注入并冻结 `SMS_ENCRYPTION_KEY`(≥32 字符;推荐 `openssl rand -base64 32`;**与其他三把 key 不同值**;production / smoke 缺失会启动失败;已有密文后禁止直接修改,见 [`encryption-key-freeze.md`](encryption-key-freeze.md))
- [ ] 当前版本包含 SMS 基础设施 T1-T3(`sms_settings` 等三表 migration 已 deploy;`GET /api/system/v1/sms-settings` 可达)
- [ ] 权限码已 seed(`sms-setting.*` 3 条 + `sms-send-log.read.list` + `user.phone.clear`;`pnpm prisma:seed` 幂等)

### 1.2 运维侧准备

- [ ] 腾讯云主账号可登录,已实名认证(短信服务要求)
- [ ] 预估月发送量并购买国内短信套餐包(验证码场景;按 [评审稿 §2 R-2](../archive/reviews/sms-verification-infra-review.md) 设置**套餐余量告警**,这是大规模盗刷的最后兜底)

## 2. 开通短信服务 + 签名审核

1. 腾讯云控制台 → 短信 SMS → 开通(国内短信)。
2. 创建**签名**:类型选"App"或"公众号/小程序"按资质;签名内容 = 队伍/机构名称(`<SIGN_NAME>`);上传资质材料。
3. 等待审核(工作日通常数小时~2 天)。

**校验**:控制台签名状态 = **已通过**;记录 `<SIGN_NAME>`(与控制台显示完全一致,含中文)。

## 3. 模板审核(**三模板**;2026-08-20 更新)

> ⚠️ **本节 2026-08-20 修补**:原文只写了验证码 + 生日祝福两模板,**漏掉 `templateIdNotification`**
> —— 它是统一通知 S5 的**紧急召集兜底短信**,对救援队恰恰是最要紧的一条。
> 缺口由真机接通时发现(维护者已建好验证码与通知两模板、反而没建生日模板)。
>
> **三者相互独立**:`missingRuntimeParams()` 按 template 分别校验
> (`tencent-sms.provider.ts`)⇒ **缺哪个只影响哪条链**,不会互相拖累。

| 模板 | 字段 | 变量 | 缺了会怎样 |
|---|---|---|---|
| 验证码 | `templateIdVerifyCode` | **恰 2 个**:`{1}`=码,`{2}`=分钟 | 短信登录 / 找回密码 / 绑手机不可用 |
| **通知** | `templateIdNotification` | **零变量** | **紧急召集兜底短信发不出** |
| 生日祝福 | `templateIdBirthday` | **零变量** | 只影响生日祝福,其余照常 |

### 3a. 验证码模板

1. 控制台 → 短信 → 正文模板 → 创建模板。
2. **模板内容必须恰好 2 个变量,顺序固定**(系统侧 `TemplateParamSet=[验证码, 有效分钟数]`,沿评审稿 E-22):

   ```text
   您的验证码为 {1},{2} 分钟内有效。如非本人操作请忽略本短信。
   ```

3. 模板类型选"验证码";等待审核。

**校验**:模板状态 = **已通过**;记录数字模板 ID `<TEMPLATE_ID_VERIFY>`(录入 `templateIdVerifyCode`)。
**⚠ 变量数不是 2 个 / 顺序颠倒** → 真实发送时腾讯云返回 `FailedOperation.TemplateParamSetNotMatch` 类错误(`GET /api/system/v1/sms-send-logs` 的 errCode 可见)。

### 3b. 通知模板(**统一通知 S5 紧急召集兜底**;2026-08-20 补登记)

1. 同入口创建模板;**内容必须零变量**(系统侧 `TemplateParamSet=[]`)。已过审的真实样例:

   ```text
   深圳公益救援队有一条重要通知,请及时打开系统/小程序或相关群组查看详情。
   ```

2. 模板类型选"普通短信"(通知类);等待审核。

**校验**:模板状态 = **已通过**;记录数字模板 ID(录入 `templateIdNotification`)。
**⚠ 模板含任何 {n} 变量** → 同样报 `TemplateParamSetNotMatch`(系统侧固定传空参数组)。

> 📌 为什么零变量:紧急召集的**内容本身不进短信**(短信只做"去看系统"的触达),
> 避免救援任务细节经运营商链路外泄。这是设计决定,不要为了"信息更全"给它加变量。

### 3c. 生日祝福模板(2026-06-11 +;queue-b 评审稿 §6.5)

1. 同入口创建第二个模板;**内容必须零变量**(系统侧 `TemplateParamSet=[]`,纯祝福文案),示例:

   ```text
   祝您生日快乐!深圳公益救援队感谢有您,愿新的一岁平安顺遂。
   ```

2. 模板类型选"普通短信"(通知类);等待审核。

**校验**:模板状态 = **已通过**;记录数字模板 ID `<TEMPLATE_ID_BIRTHDAY>`(录入 `templateIdBirthday`)。
**⚠ 模板含任何 {n} 变量** → 发送时变量数不符同样报 `TemplateParamSetNotMatch`(系统侧固定传空参数组;需变量须先回评审改系统)。

## 4. SDK AppId 与最小权限子账号

1. 控制台 → 短信 → 应用管理:记录 `<SDK_APP_ID>`(140 开头数字)。
2. CAM → 用户 → 新建**子账号**(编程访问,仅 API 密钥):
   - 绑定**最小权限策略**:仅 `QcloudSMSFullAccess`(或自定义仅 `sms:SendSms`);**不**给任何其他产品权限。
3. 生成并一次性保存 `<SECRET_ID>` / `<SECRET_KEY>`(**只在录入时使用,不落任何文档/聊天记录**)。

**校验**:子账号策略列表仅 SMS;主账号密钥**不**使用。

## 5. admin API 录入(维护者 / SUPER_ADMIN)

> 凭证录入端点仅 SUPER_ADMIN 可调(`sms-setting.reset.credentials` 不绑 ops-admin,镜像 storage D2=A)。

1. 运行参数(SUPER_ADMIN 或持 `sms-setting.update.singleton` 的 ops-admin):

   ```bash
   curl -X PATCH https://<API_HOST>/api/system/v1/sms-settings \
     -H "Authorization: Bearer <ACCESS_TOKEN>" -H "Content-Type: application/json" \
     -d '{"providerType":"TENCENT_SMS","enabled":true,"sdkAppId":"<SDK_APP_ID>","signName":"<SIGN_NAME>","region":"<REGION>","templateIdVerifyCode":"<TEMPLATE_ID_VERIFY>","templateIdNotification":"<TEMPLATE_ID_NOTIFICATION>","templateIdBirthday":"<TEMPLATE_ID_BIRTHDAY>"}'
   ```

2. 凭证(仅 SUPER_ADMIN;AES-256-GCM 加密落库,响应与日志永不回显):

   ```bash
   curl -X POST https://<API_HOST>/api/system/v1/sms-settings/reset-credentials \
     -H "Authorization: Bearer <SA_ACCESS_TOKEN>" -H "Content-Type: application/json" \
     -d '{"secretId":"<SECRET_ID>","secretKey":"<SECRET_KEY>"}'
   ```

**校验**:`GET /api/system/v1/sms-settings` 返回 `providerType=TENCENT_SMS` / `enabled=true` / **`credentialStatus=configured`** 且运行参数(sdkAppId / signName / region / 两模板 ID)均非 null。
**⚠ `credentialStatus=invalid`** → key 与密文不匹配或密文损坏。停止通道并恢复已冻结的原 key；不得把 reset-credentials 当作 key 轮换工具。
**⚠ production 禁 `providerType=DEV_STUB`**:PATCH 传 DEV_STUB 会被 400 拒绝(评审稿 E-15);DevStub 仅限本地/测试联调。

## 6. 真实发送验收

1. 用一台真机 + 测试账号登录 App(或用 access token 调 API):

   ```bash
   curl -X POST https://<API_HOST>/api/app/v1/me/phone/send-code \
     -H "Authorization: Bearer <ACCESS_TOKEN>" -H "Content-Type: application/json" \
     -d '{"phone":"<真实手机号>"}'
   # 期望:{"code":0,...,"data":{"expiresInSeconds":300}};手机收到带 <SIGN_NAME> 签名的 6 位码
   ```

2. **先取 step-up proof**(2026-08-20 补 —— 本步原文缺失,照旧文直接绑定必失败):

   ```bash
   curl -X POST https://<API_HOST>/api/auth/v1/step-up/password \
     -H "Authorization: Bearer <ACCESS_TOKEN>" -H "Content-Type: application/json" \
     -d '{"action":"PHONE_BIND","password":"<当前账号密码>"}'
   # 期望:data.stepUpToken 非空;**有效期仅 5 分钟**
   ```

   ⏱ 只有 5 分钟,所以**这一步要放在收到短信之后、绑定之前**,别一开始就取。

3. 用收到的码完成绑定(**必须带 `stepUpToken`**):

   ```bash
   curl -X PUT https://<API_HOST>/api/app/v1/me/phone \
     -H "Authorization: Bearer <ACCESS_TOKEN>" -H "Content-Type: application/json" \
     -d '{"phone":"<真实手机号>","code":"<收到的码>","stepUpToken":"<上一步的 token>"}'
   # 期望:data.phone 为掩码号(139****XXXX 形状),phoneVerifiedAt 为时间串
   ```

   🔴 **2026-08-20 契约漂移订正**:本步原文只写 `phone` + `code`,**漏了 `stepUpToken`**。
   当前 `BindMyPhoneDto` 是**三个必填字段** —— `phone` / `code` / `stepUpToken`,
   且该 token 必须是 `action=PHONE_BIND` 的 5 分钟 step-up proof。
   缺口由 2026-08-20 真机实测暴露(维护者照本清单操作时发现)。

4. 后台核验发送留痕(持 `sms-send-log.read.list`):

   ```bash
   curl "https://<API_HOST>/api/system/v1/sms-send-logs?page=1&pageSize=20" \
     -H "Authorization: Bearer <ACCESS_TOKEN>"
   # 期望:status=SENT / providerType=TENCENT_SMS / providerMsgId 非空 / 手机号显示为掩码 138****XXXX
   # ⚠️ SENT = 已提交腾讯云,不代表终端已送达 —— 必须同时确认真机收到了码(见 §0-pre 反例)
   ```

5. **通知链路验收**(2026-08-20 已完成;步骤如下,可重复):

   🔴 **前置(原文写错过,勿再犯)**:通知广播 SMS 的收件人链是
   `ACTIVE Member → 满足 visibility → 关联 ACTIVE User → User.phone 非空`。
   **SUPER_ADMIN 绑了手机也没用** —— 它 `memberId` 为 null,不在受众链内。
   须准备 **ACTIVE Member + 关联 ACTIVE USER**,`User.phone` 为唯一测试号。

   ① `POST /admin/v1/notifications` 建草稿 —— `channels` **必须显式含 `sms`**;
      `visibilityCode` 用 **`member`**(普通 USER 不在 `management` 可见范围内)
   ② `POST /admin/v1/notifications/{id}/publish` —— ⭐ **发布本身不发短信**(实测确认)
   ③ `POST /admin/v1/notifications/{id}/send-sms` `{"confirmed":false}` —— 安全预览,`sent=0`
   ④ 🔴 **核对 `recipientCount` 与人工预期完全一致后**,才 `{"confirmed":true}`
   ⑤ 查 send-logs:期望 `templateKey=notification` / `status=SENT` / `providerMsgId` 非空

   🔴 **第 ③ 步是硬要求不是建议** —— 少了它就存在**误发真实队员 + 产生短信费用**的双重风险。
   ⚠️ **第 ⑤ 步的 `SENT` 不等于送达**,必须同时确认真机响了(见 §0-pre 的反例)。

6. 生日祝福链路验收(轻量;2026-06-11 +):`templateIdBirthday` 录入后,任一队员生日当天 09:00(Asia/Shanghai)后查 send-logs——期望出现 `templateKey=birthday-greeting / status=SENT` 行且真机收到祝福短信;当天无人生日则顺延至最近生日核验(系统侧幂等保证不重发)。

**全部通过 = 通道上线完成。**

## 7. 排错速查

| 现象 | 查 | 常见原因 |
|---|---|---|
| 24030 SMS_CHANNEL_NOT_CONFIGURED | `GET sms-settings` | settings 缺失 / enabled=false / credentialStatus≠configured / 运行参数缺失 / production 误配 DEV_STUB |
| 24031 SMS_SEND_FAILED | `GET sms-send-logs` 的 errCode/errMsg | 签名或模板未过审 / 模板变量数不符 / 子账号无 SendSms 权限 / 套餐余量耗尽 / 频控被腾讯云侧拦截 |
| 24120 / 24121 | — | 系统侧防刷(同号 60s 间隔 / 自然日上限);属预期行为,**阈值不外暴** |
| 收不到短信但 SENT | 腾讯云控制台发送记录 | 运营商侧拦截 / 用户屏蔽;凭 providerMsgId(SerialNo)向腾讯云回执查询 |

## 8. 本清单不覆盖(系统侧已定/挂起事项)

- 上游 SMS SecretId/SecretKey 替换：仅在 `SMS_ENCRYPTION_KEY` 不变时重复 §4-§5；encryption key 轮换当前不支持，见 [`encryption-key-freeze.md`](encryption-key-freeze.md)
- `sms_verification_codes` / `sms_send_logs` retention 清理:**手动 SQL SOP 已收口**(2026-06-11 P2-6),见 [`sms-data-retention-sop.md`](sms-data-retention-sop.md)
- 找回密码 / OTP 登录 / 生日祝福 / **紧急召集兜底**:系统侧消费者已全部落地(P1-7 闭环,2026-06-11);本清单完成后三者即随通道真实生效,**零额外运维作业**
