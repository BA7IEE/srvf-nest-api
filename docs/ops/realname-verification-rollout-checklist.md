# SRVF API — 实名 OCR 证件识别真实通道(腾讯云)上线运维清单

> **状态**:系统侧已全部就位("正确但休眠",2026-06-22 招新实名环节 OCR 改造落地;冻结评审稿
> [`recruitment-realname-ocr-review.md`](../archive/reviews/recruitment-realname-ocr-review.md));
> 真实可用只差本清单的运维侧动作(腾讯云开通 OCR 三接口 + 凭证录入 + 验收)。
> 镜像 [`wechat-mini-production-rollout-checklist.md`](./wechat-mini-production-rollout-checklist.md) /
> [`sms-production-rollout-checklist.md`](./sms-production-rollout-checklist.md) 范式。
>
> **2026-06-22 语义换血**:实名环节从「腾讯云 faceid 二要素**真实性核验**(查公安库)」改为「腾讯云 **OCR
> 证件识别 + 自洽匹配**」——**明确放弃联网真实性核验**(全仓无 `IdCardVerification` 调用)。本清单从
> 「开通二要素核验接口」改为「开通 OCR 三接口」;凭证形态(SecretId/SecretKey/region)与录入流程不变。

---

## 0. 用法说明

### 0.1 谁在读

- **运维 / 维护者**:§2-§5 逐步执行(开通腾讯云 OCR → 拿 SecretId/SecretKey → admin API 录入 → 验收)
- **部署侧**:§1.1 确认系统侧前置已就位(env / migration / seed)

### 0.2 怎么读

按顺序执行,每节末尾有「✅ 完成判据」;全部判据满足 = 招新报名的付费 OCR 证件识别真实可用。
**安全红线**:SecretId / SecretKey 是 L3 凭证——只经 §4 的 admin API 录入(各自 AES-256-GCM 加密落库,永不回显);
**禁止**写进 .env / 配置文件 / 聊天记录 / 工单。证件照走短 TTL signed-URL,姓名 / 证件号一律掩码,均不入日志。
**成本红线**:OCR 证件识别是**按次计费**的付费接口。系统侧把付费 OCR 放在报名校验链的**最后一道闸**
(免费校验〔证件校验位 + 年龄 + code2session + 同轮去重〕全过才调用)。**调用次数**:大陆身份证申请人
约 **2 次**(识别端点预填 1 次 + 提交端权威判定 1 次);护照 / 回乡证申请人约 **1 次**(仅识别端点;提交端
恒转人工不再 OCR)。录入真凭证后即开始产生真实费用——上线前确认计费账户额度与告警已配置。
**识别端点防刷**:公开识别端点 `@RecruitmentThrottle`(IP 默认 10/3600)+ open 轮前置,缓解 cost-DoS。

---

## 1. 前置门槛

### 1.1 系统侧已就位(必读,部署侧确认)

- [ ] 版本 ≥ 含招新实名 OCR 改造的 release(招新表 migration 早已 deploy;**OCR 改造本身零新 migration**;`prisma migrate status` 无 pending)
- [ ] seed 已跑(权限码含 `realname-setting.*` 3 条;OCR 改造**零新权限码**)
- [ ] 生产 env 已注入 `REALNAME_ENCRYPTION_KEY`(≥32 字符,推荐 `openssl rand -base64 32`;**与 STORAGE / SMS / WECHAT 三把 key 均不同值**;缺失时 production 启动 fail-fast,这是预期保护)
- [ ] 可选 env:`RECRUITMENT_THROTTLE_LIMIT` / `_TTL_SECONDS`(留空默认公开报名/识别 IP 10 次/3600 秒)

### 1.2 运维侧准备

- [ ] 一个已实名认证的腾讯云账号,开通**文字识别 OCR** 下列三接口(按需主体完成开通与计费签约):
  - `RecognizeValidIDCardOCR`(身份证**鉴伪版**;响应嵌套 `Response.IDCardInfo.{Name,IdNum}.Content` + `WarnInfos` 标志位 —— 系统侧已按此结构映射〔2026-06-29 修复〕;**须确认账号开通的是此鉴伪版,而非标准 `IDCardOCR`**:二者计费/响应结构不同)
  - `MLIDPassportOCR`(护照识别,**仅可机读护照**)
  - `MainlandPermitOCR`(港澳台居民来往内地 / 大陆通行证识别;系统侧仅接受「来往内地」类别)
- [ ] CAM 子账号 **SecretId / SecretKey**(最小权限:仅授予上述 OCR 接口;**不要**用主账号密钥)
- [ ] 确认接口的 `region` / `endpoint` 与系统侧 Provider 实现一致:`ocr.tencentcloudapi.com`,service `ocr`,
      version `2018-11-19`(见冻结评审稿 §3.6 / `realname.constants.ts`;不一致需先对齐再录入)
- [ ] **首次真实联调核对字段映射**(2026-06-29:mainland 鉴伪版已按腾讯云文档嵌套结构〔`IDCardInfo.{Name,IdNum}.Content`〕校正;passport / hk_macau 仍按顶层字符串映射,待各自首次联调确认):真实身份证打一次 `recognize` 后,看后端 `logger.debug` 行 `[realname ocr] … nameHit=true idHit=true` —— **出现 = 字段路径正确**;若图清晰但 `nameHit=false / idHit=false`,字段名仍需对照真实回包微调 provider `mapResponse`。**字段映射失败现会落 `27031`〔识别端〕/ `ocr_error`〔提交端〕而非静默「不清晰」**,便于一眼定位(2026-06-29 去混淆修复)
- [ ] SUPER_ADMIN 账号(§4 录凭证仅 SUPER_ADMIN 可调)

---

## 2. 开通腾讯云 OCR

1. 腾讯云控制台 → 开通文字识别 OCR,启用 §1.2 三接口,完成计费签约;记录各接口计费单价与免费额度(若有)
2. 访问 CAM → 新建子用户 → 仅授权上述 OCR 接口的调用权限 → 生成 **SecretId / SecretKey**
   - SecretId 非高度敏感但仍按凭证处理;**SecretKey 为 L3:只在生成当下复制一次,直接进入 §4 录入,不落任何中间介质**
3. (推荐)配置腾讯云侧用量告警 / 日预算上限,防止异常调用产生超额费用

**✅ 完成判据**:三接口已开通可计费;拿到 SecretId;SecretKey 已生成且仅存在于剪贴板/即将录入的窗口期。

---

## 3. (推荐)先用 DevStub 验全链

> 生产禁 DEV_STUB(写入与运行时双重校验),本节在 **staging / 本地** 做,验证系统侧报名链路无关真实凭证。
> **DevStub OCR 桩**把上传的证件照当作 JSON「OCR 信封」回显(评审稿 §3.7):上传内容为
> `{"name":"张三","idCardNumber":"<有效号>","clarity":true,"warnings":[]}` 的"图"(Content-Type 标 image/jpeg)
> 即可造确定性结果;上传真实图片会因桩读不出字段而落 manual_review(预期,非 bug)。

1. staging:`PATCH /api/system/v1/realname-settings` `{"providerType":"DEV_STUB","enabled":true}`(ops-admin 可调)
2. 建一个 open 招新轮次:`POST /api/admin/v1/recruitment/cycles` → `PATCH .../{id}` `{"statusCode":"open"}`
3. **识别端点**:`POST /api/open/v1/recruitment/applications/recognize`(multipart:`documentTypeCode=mainland_id` +
   `idCardImage`=信封)→ 期待 `ocrSupported:true` + `clarityOk:true` + `recognized` 回填;`documentTypeCode=taiwan_permit`
   → `ocrSupported:false`;信封 `{"clarity":false}` → `clarityOk:false`
4. **提交端**:`POST /api/open/v1/recruitment/applications`,`payload` 用**有效身份证号**、`idCardImage` 信封与 payload
   姓名/证件号一致 → 期待 `statusCode:"verified"` + 临时编号 `T{year}0001`;信封姓名与 payload 不一致 / `warnings` 非空 /
   `clarity:false` → 期待 `statusCode:"manual_review"`(**不再 rejected**,「对不上转人工不误杀」)
5. 外籍证件(`documentTypeCode` 非 `mainland_id`)→ 期待 `statusCode:"manual_review"`(护照/回乡证识别端可 OCR,提交端不再 OCR)

**✅ 完成判据**:识别端点四路 + 提交端 verified / manual_review 两路 + 外籍人工全通(等价于 CI e2e `recruitment` 组覆盖面)。

---

## 4. admin API 录入凭证(维护者 / SUPER_ADMIN)

> 顺序:先 PATCH 切 providerType(ops-admin 可),再 reset-credentials 录两段密钥(**仅 SUPER_ADMIN**)。

1. `PATCH /api/system/v1/realname-settings`

   ```json
   { "providerType": "TENCENT_CLOUD", "enabled": true, "remarks": "生产腾讯云 OCR 证件识别" }
   ```

2. `POST /api/system/v1/realname-settings/reset-credentials`

   ```json
   { "secretId": "<§2 的 SecretId>", "secretKey": "<§2 复制的 SecretKey>" }
   ```

   - 期待响应:`credentialStatus: "configured"`,且响应**不含** secretId / secretKey 任何形态(L3 红线;含明文即重大故障,立即上报)
3. `GET /api/system/v1/realname-settings` 复核:`providerType=TENCENT_CLOUD / enabled=true / credentialStatus=configured`(凭证字段不回显)

**✅ 完成判据**:GET 复核字段正确;`credentialStatus=configured`。

---

## 5. 真实识别验收(小成本,用真实证件)

> 真实 OCR **按次计费**;验收用 1-2 次真实调用即可,不要批量刷。

1. 在一个 open 轮次,用**运维本人或获授权同事的真实身份证照片** + 真实姓名 + 身份证号,走识别端点 `recognize`
   核对回填字段正确,再走提交端 `POST /api/open/v1/recruitment/applications`(真实 `wx.login` code 见 wechat checklist §5
   取 code 方式;招新自助小程序前端未上线时可用开发者工具 code)
2. OCR 识别 + 姓名/证件号一致 + 防伪无告警 + 清晰 → 期待 `statusCode:"verified"` + 临时编号
3. 验收负向(可选,会再计一次费):提交姓名与证件照**不一致**,或用一张明显翻拍/复印的证件照 → 期待
   `statusCode:"manual_review"`(OCR 不匹配 / 防伪告警 → 转人工;**这不是 27031**,27031 仅识别端点上游调用失败)
4. 护照 / 回乡证(如有):识别端点核对回填 + 类别(回乡证须「来往内地」);提交后期待 `manual_review`(人工最终确认)
5. 复核审计:每次提交端付费 OCR 都应在 `audit_logs` 留 `recruitment-application.realname-verify` 一行(姓名/证件号掩码,
   `documentType` + `outcome` ∈ matched/mismatch/forgery_warning/ocr_unclear/ocr_error)——确认计费调用与审计一一对应

**✅ 完成判据**:2-5 通过 → 招新报名付费 OCR 证件识别真实通道上线完成。

---

## 6. 排错速查

| 现象 | 码 | 排查 |
|---|---|---|
| 识别端点返「实名核验通道未配置或未启用」 | 27030 | settings 行缺失 / enabled=false / credentialStatus≠configured;production 配 DEV_STUB 也落此。**注意**:提交端对 OCR 通道未配**不外抛**,转 manual_review(verifyOutcome=ocr_error),仅识别端点浮现 27030 |
| 识别端点返「实名核验服务调用失败」 | 27031 | 看服务端 warn 日志:腾讯云返 Error 回执(SecretId/SecretKey 错、签名错、接口未开通、欠费)/ HTTP 非 200 / 8s 超时 / 出网不通(检查服务器出站 443 到 `ocr.tencentcloudapi.com`)。**提交端**同类失败不报 27031,而是转 manual_review(ocr_error) |
| 报名返「轮次未开放」 | 28030 | 无 `statusCode=open` 的轮次;先 §3 步 2 开轮 |
| 报名返「年龄不在范围」 | 28010 | 大陆证件免费校验:出生年龄不在 18-60;此为免费校验,**未**触达付费 OCR |
| 报名返参数错误 | 40000 | 大陆证件校验位非法(免费校验即拦,零付费)/ multipart `payload` JSON 非法 / 紧急联系人 <2 / 证件照 mime·大小越界 / 识别端点缺 `documentTypeCode` |
| 报名返「重复报名」 | 28003 | 同轮同证件号已有非 rejected 申请(partial unique);此为付费 OCR**前**的免费去重 |
| 报名「对不上」却没拒 | —(非错误码) | OCR 不匹配 / 不清晰 / 防伪告警 / 类别不符**不是错误码**,是 OCR 结果 → 报名落 `manual_review`(不误杀),由 admin 人工 resolve 裁断(approve 发号 / reject) |

安全提醒:服务端日志**永不**含 SecretKey / 完整姓名 / 完整证件号 / 证件照字节 / 证件照 signed-URL;OCR 的姓名与
证件号在 audit 与日志中一律掩码。若在任何日志看到 SecretKey 或未掩码的姓名/证件号,按安全事件处理并上报。
