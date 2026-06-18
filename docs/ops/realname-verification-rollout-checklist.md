# SRVF API — 实名核验真实通道(腾讯云)上线运维清单

> **状态**:系统侧已全部就位("正确但休眠",2026-06-18 goal P1-11 招新一期 T2-T3 落地;冻结评审稿
> [`recruitment-phase1-review.md`](../archive/reviews/recruitment-phase1-review.md));
> 真实可用只差本清单的运维侧动作(腾讯云开通 + 凭证录入 + 验收)。
> 镜像 [`wechat-mini-production-rollout-checklist.md`](./wechat-mini-production-rollout-checklist.md) /
> [`sms-production-rollout-checklist.md`](./sms-production-rollout-checklist.md) 范式。

---

## 0. 用法说明

### 0.1 谁在读

- **运维 / 维护者**:§2-§5 逐步执行(开通腾讯云实名核验 → 拿 SecretId/SecretKey → admin API 录入 → 验收)
- **部署侧**:§1.1 确认系统侧前置已就位(env / migration / seed)

### 0.2 怎么读

按顺序执行,每节末尾有「✅ 完成判据」;全部判据满足 = 招新报名的付费实名核验真实可用。
**安全红线**:SecretId / SecretKey 是 L3 凭证——只经 §4 的 admin API 录入(各自 AES-256-GCM 加密落库,永不回显);
**禁止**写进 .env / 配置文件 / 聊天记录 / 工单。
**成本红线**:实名核验是**按次计费**的付费接口;系统侧已把它放在报名校验链的**最后一道闸**(免费校验〔证件校验位 + 年龄 + code2session + 同轮去重〕全过才调用),录入真凭证后即开始产生真实费用——上线前确认计费账户额度与告警已配置。

---

## 1. 前置门槛

### 1.1 系统侧已就位(必读,部署侧确认)

- [ ] 版本 ≥ 含招新 goal 的 release(migration `20260618083340_add_recruitment_phase1` 已 deploy;`prisma migrate status` 无 pending)
- [ ] seed 已跑(权限码 136,含 `realname-setting.*` 3 条 + recruitment 5 条)
- [ ] 生产 env 已注入 `REALNAME_ENCRYPTION_KEY`(≥32 字符,推荐 `openssl rand -base64 32`;**与 STORAGE / SMS / WECHAT 三把 key 均不同值**;缺失时 production 启动 fail-fast,这是预期保护)
- [ ] 可选 env:`RECRUITMENT_THROTTLE_LIMIT` / `_TTL_SECONDS`(留空默认公开报名 IP 10 次/3600 秒)

### 1.2 运维侧准备

- [ ] 一个已实名认证的腾讯云账号,开通**身份证核验(二要素:姓名 + 身份证号)**接口(腾讯云「身份证实名核验」/ 慧眼系产品;按主体完成开通与计费签约)
- [ ] CAM 子账号 **SecretId / SecretKey**(最小权限:仅授予所用实名核验接口;**不要**用主账号密钥)
- [ ] 确认接口的 `region` / `endpoint` 与系统侧 Provider 实现一致(见冻结评审稿 §5 真实 Provider 段;不一致需先对齐再录入)
- [ ] SUPER_ADMIN 账号(§4 录凭证仅 SUPER_ADMIN 可调)

---

## 2. 开通腾讯云实名核验

1. 腾讯云控制台 → 开通身份证二要素核验接口,完成计费签约;记录接口计费单价与免费额度(若有)
2. 访问 CAM → 新建子用户 → 仅授权该实名核验接口的调用权限 → 生成 **SecretId / SecretKey**
   - SecretId 非高度敏感但仍按凭证处理;**SecretKey 为 L3:只在生成当下复制一次,直接进入 §4 录入,不落任何中间介质**
3. (推荐)配置腾讯云侧用量告警 / 日预算上限,防止异常调用产生超额费用

**✅ 完成判据**:接口已开通可计费;拿到 SecretId;SecretKey 已生成且仅存在于剪贴板/即将录入的窗口期。

---

## 3. (推荐)先用 DevStub 验全链

> 生产禁 DEV_STUB(写入与运行时双重校验),本节在 **staging / 本地** 做,验证系统侧报名链路无关真实凭证。

1. staging:`PATCH /api/system/v1/realname-settings` `{"providerType":"DEV_STUB","enabled":true}`(ops-admin 可调)
2. 建一个 open 招新轮次:`POST /api/admin/v1/recruitment/cycles` → `PATCH .../{id}` `{"statusCode":"open"}`
3. 公开报名(multipart):`POST /api/open/v1/recruitment/applications`,`payload` 用**校验位为偶**的有效身份证号 → 期待 `statusCode:"verified"` + 临时编号 `T{year}0001`;换**校验位为奇**的号 → 期待 `statusCode:"rejected"`(DevStub 按校验位奇偶确定性判定,评审稿 E-R-6)
4. 外籍证件(`documentTypeCode` 非 `mainland_id`)→ 期待 `statusCode:"manual_review"`(根本不调核验)

**✅ 完成判据**:上述报名两路 + 外籍人工全通(等价于 CI e2e `recruitment` 组覆盖面)。

---

## 4. admin API 录入凭证(维护者 / SUPER_ADMIN)

> 顺序:先 PATCH 切 providerType(ops-admin 可),再 reset-credentials 录两段密钥(**仅 SUPER_ADMIN**)。

1. `PATCH /api/system/v1/realname-settings`

   ```json
   { "providerType": "TENCENT_CLOUD", "enabled": true, "remarks": "生产腾讯云实名核验" }
   ```

2. `POST /api/system/v1/realname-settings/reset-credentials`

   ```json
   { "secretId": "<§2 的 SecretId>", "secretKey": "<§2 复制的 SecretKey>" }
   ```

   - 期待响应:`credentialStatus: "configured"`,且响应**不含** secretId / secretKey 任何形态(L3 红线;含明文即重大故障,立即上报)
3. `GET /api/system/v1/realname-settings` 复核:`providerType=TENCENT_CLOUD / enabled=true / credentialStatus=configured`(凭证字段不回显)

**✅ 完成判据**:GET 复核字段正确;`credentialStatus=configured`。

---

## 5. 真实核验验收(小成本,用真实身份证)

> 真实核验**按次计费**;验收用 1-2 次真实调用即可,不要批量刷。

1. 在一个 open 轮次,用**运维本人或获授权同事的真实姓名 + 身份证号** + 任意证件照,走 `POST /api/open/v1/recruitment/applications`(真实 `wx.login` code 见 wechat checklist §5 取 code 方式;招新自助小程序前端未上线时可用开发者工具 code)
2. 二要素一致 → 期待 `statusCode:"verified"` + 临时编号
3. 验收负向(可选,会再计一次费):用姓名与身份证号**不匹配**的组合 → 期待 `statusCode:"rejected"`(腾讯云 Result≠0 → verify 返 matched=false → 状态机 rejected;**这不是 27031**,27031 仅上游调用失败)
4. 复核审计:每次付费核验都应在 `audit_logs` 留 `recruitment-application.realname-verify` 一行(姓名/身份证掩码,outcome 记 matched/mismatch)——确认计费调用与审计一一对应

**✅ 完成判据**:2-4 通过 → 招新报名付费实名核验真实通道上线完成。

---

## 6. 排错速查

| 现象 | 码 | 排查 |
|---|---|---|
| 实名核验通道未配置或未启用 | 27030 | settings 行缺失 / enabled=false / credentialStatus≠configured;production 配 DEV_STUB 也落此 |
| 实名核验服务调用失败 | 27031 | 看服务端 warn 日志:腾讯云返 Error 回执(SecretId/SecretKey 错、签名错、接口未开通、欠费)/ HTTP 非 200 / 8s 超时 / 出网不通(检查服务器出站 443 到腾讯云 endpoint);**注意**:核验「不匹配」**不是** 27031,而是正常 verify 结果 → 报名 rejected |
| 报名返「轮次未开放」 | 28030 | 无 `statusCode=open` 的轮次;先 §3 步 2 开轮 |
| 报名返「年龄不在范围」 | 28010 | 大陆证件免费校验:出生年龄不在 18-60;此为免费校验,**未**触达付费核验 |
| 报名返参数错误 | 40000 | 大陆证件校验位非法(免费校验即拦,零付费)/ multipart `payload` JSON 非法 / 紧急联系人 <2 / 证件照 mime·大小越界 |
| 报名返「重复报名」 | 28003 | 同轮同身份证号已有非 rejected 申请(partial unique);此为付费核验**前**的免费去重 |

安全提醒:服务端日志**永不**含 SecretKey / 完整姓名 / 完整身份证号 / 证件照 signed-URL;实名核验的姓名与身份证号在 audit 与日志中一律掩码。若在任何日志看到 SecretKey 或未掩码的姓名/身份证号,按安全事件处理并上报。
