# SRVF 招新实名环节 OCR 改造评审稿(Recruitment Realname → Tencent OCR Recognition Review)

> **状态:冻结**(2026-06-22;goal「招新实名环节 —— 二要素核验 → 腾讯云 OCR 多证件识别」拍板,goal 文本即立项 + 评审授权;**§0.5 全部 6 分叉已于 2026-06-22 经维护者元核验「按推荐」冻结 + 4 条附加把关**)。
> **按 [`process.md §4`](../../process.md) D 档降速产出**;冻结后不回改,实施(T1+)不早于冻结。
>
> **元核验结论(2026-06-22,维护者)**:§0.5 六分叉**全部按推荐**冻结 —— ①无 HMAC token + 提交端重识别(大陆 2 次/外籍 1 次 OCR);②仅 mainland_id 重识别(护照/回乡证提交端不再 OCR、恒进人工);③提交端对 OCR 永不硬报错、一律转 manual_review(27030/27031 只在识别端浮现);④消灭 pending_verification 卡死类(OCR 前置 + 单事务建终态,退役 FM-A);⑤姓名完全一致(NFC 归一)不做生僻字容错;⑥verifyOutcome 加细分 String 值。**收口 = 并入下个 minor**(无 schema/BizCode/权限码增量)。**附加把关(实施期遵守)**:(a) ④ churn 最大——submit 主流程 + 退役 pending_verification + 删 FM-A resolve 逻辑/测试要干净不留死代码,且验证 phase-2/3 入口态 `verified` 零 diff;(b) 红线复述见 §7 / DoD(不联网验真 + IdCardVerification 删干净 / PII 掩码 / secret 不落日志 / 证件照短 TTL signed-URL / 零新依赖 / 真通道休眠不接真凭证);(c) 每阶段 PR + 终版报告回传主会话最终元核验(三计数实跑亲核 / rbacmap·codemap 0 FAIL / CHANGELOG + current-state §1/§2/§3 回填 / 全仓无联网验真路径 / +1 识别端点 contract / e2e 翻转 mismatch→manual_review);(d) 某节点把分支 push 出来便于主会话核全文。
>
> **PR 结构(冻结时定;契约耦合所迫)**:Provider 契约 `verify→recognize` 与其唯一消费者(recruitment 报名 service)强耦合 —— T1(`realname/` 通道层)单独落地会让 recruitment caller 编译失败、或被迫留 faceid shim 死代码(违反附加把关 a)。故 **T1+T2 合并为一个功能 PR**(realname OCR 层 + recruitment 流程重构 + 识别端点 + DevStub + 全部 spec/e2e,IdCardVerification 一次删净),**T3(docs 收尾)单独 A 档 PR**。这是对 §9 任务队列的唯一冻结期微调,服务附加把关 (a) 的「不留死代码」。
> **业务依据**:goal 原文(自含,维护者 2026-06-22 已拍板 5 条事实)。需求文档不入仓,引用以 goal 原文为准。
> **范式母本**:① 本稿**逐层镜像** [`recruitment-phase1-review.md`](recruitment-phase1-review.md)(下称「一期评审稿」)的结构与铁律;② `realname/` 通道层沿 wechat/sms 通道层范式(provider 接口 + DevStub 确定性桩 + 真实腾讯云 provider〔TC3 签名、休眠、spec mock fetch 锁结构〕+ settings 单例);③ 报名主流程沿一期 §4 校验顺序冻结(免费校验前置、付费最后)。
> **冲突优先级**:本稿让步给 `AGENTS.md` / `ARCHITECTURE.md` / baseline / V2 红线 / `api-surface-policy.md`(沿 process §6);但在「本次 OCR 改造范围内的具体设计取舍」上,经元核验冻结后即为决议。

---

## 0. TL;DR

1. **语义换血,不换骨架**:实名环节从「腾讯云 faceid `IdCardVerification` 二要素**真实性核验**(查公安库)」改为「腾讯云 **OCR 证件识别 + 自洽匹配**」。**明确放弃联网核验真实性**——全仓删除 `IdCardVerification` 调用路径,不再调公安库或任何真实性比对接口(DoD 红线)。
2. **`realname/` 第 25 模块就地改造,不新建模块、不改模块名**:Provider 契约 `verify(name,idCard)→{matched}` 改为 `recognize(documentTypeCode,image)→{结构化字段 + 防伪 + 清晰度}`;三接口走 `ocr.tencentcloudapi.com`(service `ocr`,version `2018-11-19`),**复用现有 `buildSignedHeaders`**(改 host/service/action/version);真通道**保持休眠**,DevStub 改为确定性 OCR 桩,`.spec` mock fetch 锁三 action 结构。
3. **统一前段流程(大陆+外籍同)= 两端点**:新增公开**识别端点**(扫证件 → OCR → 回填) + 改造**提交端点**(权威校验 + 落库)。「申请人确认/修正后提交」靠前端拿识别结果回填、提交端点做权威判定落地。
4. **判定按证件类型分流(goal 拍板 2/4/5)**:
   - `mainland_id` → `RecognizeValidIDCardOCR`:**匹配一致 + 防伪无告警 + 清晰** → **自动 verified + 发临时编号**;不匹配 / 防伪告警 / 不清晰 / OCR 失败 → **manual_review**(**不再 rejected**,「对不上转人工不误杀」)。
   - `passport` → `MLIDPassportOCR`(仅可机读)/ `hk_macau_permit` → `MainlandPermitOCR`(校验证件类别仅接受「来往内地」、拒「往来港澳」):OCR 识别 + 回填 → **manual_review**(人工最终确认)。
   - `taiwan_permit` / `foreigner_permit` / 其余 → **本期不 OCR**,沿现状直接 **manual_review**。
5. **零新增 OCR 原始结果存储字段**(PII 不蔓延):OCR 值经申请人确认后落**现有** `realName` / `idCardNumber`;OCR 仅用于「比对 + 防伪 + 清晰度」判定,判完即弃。
6. **footprint 极小(地基已就位)**:**零 schema migration**(`idCardNumber`/`documentTypeCode`/`verifyOutcome`/`idCardImageKey`/`isForeigner` 已就位;`verifyOutcome` 是 String、新增取值零 migration);**零新 BizCode**(复用 27030/27031;「OCR 失败 / 不清晰 / 类别不符 / 不匹配」是 verify 结果驱动 manual_review,非错误码;不支持类型走 `ocrSupported:false` 非错误);**零新权限码**(识别端点 `@Public`);**AuditLogEvent union 零变**(复用 `recruitment-application.realname-verify`,语义重定为 OCR 调用)。
7. **唯一接口增量 = +1 公开端点**(`POST open/v1/recruitment/applications/recognize`);EXPECTED_ROUTES +1、contract 仅新增。
8. **状态机净化(推荐)**:把付费调用挪到「建记录之前」,改两段事务为**单事务建终态记录**,**退役 `pending_verification` 在途态 + FM-A 卡死恢复逻辑**(从「缓解卡死」升级为「消灭卡死类」);`mismatch→rejected` 改 `mismatch→manual_review` 后,`ELIM_STAGE_REALNAME`('realname')不再被写。
9. **真通道休眠不变**:本 goal 不接真实凭证;运维 SOP 改为 OCR 口径(Tn)。**零新依赖**(沿原生 fetch + node crypto + #346 的 8s 上限)。

---

## 0.5 六个分叉(✅ 2026-06-22 元核验「按推荐」全部冻结)

> **冻结结论**:维护者 2026-06-22 回「按推荐」,①-⑥ 全部按下表推荐项冻结(详见顶部元核验结论)。以下保留各分叉对比为冻结存档。推荐项 ①③④ 联动——合在一起得到「无 token、无卡死态、提交端永不误杀」的最简形态。

**分叉① · 付费 OCR 调用次数 / API 形态 —— 推荐 A(无 token,提交端重识别)**

| | 方案 A(推荐) | 方案 B |
|---|---|---|
| 形态 | 识别端点**无状态**(OCR 后即弃图,不落库不发 token);提交端点**重新 OCR** 作权威判定 | 识别端点 OCR 后落图 + 返 **HMAC 签名凭据**(绑 OCR 结果哈希 + imageKey + 防伪/清晰标志 + cycleId + 时间戳,短 TTL);提交端点验签复用,不再 OCR |
| 付费次数 | 大陆 2 次(识别预填 + 提交权威)/ 港澳护照 1 次(见分叉②) | 全类型 1 次 |
| 复杂度 | 低:无加密凭据、无 TTL/重放、无 PII 入凭据、无客户端传 imageKey 的信任面 | 高:HMAC 凭据方案 + 短 TTL/重放推理 + imageKey 绑定(否则有「识别后换图」攻击窗口)+ **新增孤儿图类**(识别落图但未提交) |
| 成本纪律 | 提交端 OCR 是**全部免费校验之后的最后一步**(教科书「付费最后」);识别端 OCR 受 `@RecruitmentThrottle` + open 轮 + mime/大小闸前置 | 同样在识别端先花一次;提交端零付费 |
| 安全 | **防换图**(提交端 OCR 的是实际落库那张图);识别无状态 → **无新孤儿类** | imageKey 必须进签名凭据才防换图;识别落图引入新孤儿类 |
| 取舍 | 招新低量(每轮数十~低百)+ 真通道休眠 → 第 2 次 OCR 的边际成本可忽略(约 ¥20/轮);简单与安全压过省一次调用 | 省一次调用,但凭据机制是非职业维护者长期要扛的复杂度;goal 点了「HMAC 签名先例」故列为备选 |

**推荐 A**:沿项目「避免过度工程化、简单显式」(`.claude/CLAUDE.md`)+ 低量 + 休眠 → 无 token 的简单形态更可长期维护,且提交端重识别天然防换图、识别端无状态无新孤儿。回退条件:若未来量级或单价显著上升、第 2 次 OCR 成本变敏感,再切 B(切换是纯通道层 + 提交端改动,不动 schema)。

**分叉② · 提交端重识别范围(仅在 A 下)—— 推荐「仅 mainland_id 重识别」**
- 推荐:**只有 `mainland_id`(唯一自动放行通道)在提交端重新 OCR** 作权威判定;`passport`/`hk_macau_permit` 提交端**不重识别**——落图后直接 manual_review(识别端已回填;匹配/清晰/类别由人工看图最终判),把第 2 次付费只花在「会改变自动决策」的通道上。
- 含义:港澳/护照的「匹配 + 清晰 + 类别」在**识别端为前端做一次(建议性)+ 人工复核为最终**;提交端不再权威重判(它们本就 100% 进人工)。这是对 goal「passport·hk_macau OCR 识别+匹配+清晰→manual_review」的一种**读法**,请元核验确认。
- 备选(goal 字面)**全 OCR 类型提交端都重识别**,把匹配/清晰/类别权威写进 manual_review 记账(港澳/护照 +1 次付费)。

**分叉③ · 提交端 OCR 失败的去向 —— 推荐「提交端对 OCR 永不硬报错,一律转 manual_review」**
- 推荐:**提交端任何 OCR 问题(通道未配 27030 / 上游失败 27031 / 不清晰 / 防伪告警 / 不匹配)统统 → manual_review**(graceful;最大化「不误杀」+ 配合分叉④消灭一切卡死态)。27030/27031 **只在识别端点**对前端浮现(让申请人在填表前就知道 OCR 暂不可用)。
- 取舍:若生产忘配通道,大陆申请人会**静默全进人工**(自动化静默关闭)——可检测:`verifyOutcome` 出现 `ocr_error`/`channel_unavailable` 值 + 人工队列突增 + 识别端返 27030 + 上线前 rollout §3 DevStub 验收会拦住。可接受。
- 备选(更响)**提交端对「通道未配 27030」抛错不建记录**(逼运维立即修),仅「上游瞬时失败 27031」转人工。

**分叉④ · 状态机重构 —— 推荐「OCR 前置 + 单事务建终态 + 退役 pending_verification/FM-A」**
- 推荐:把付费 OCR 挪到**建记录之前**(免费校验 → code2session → OCR → **单事务建终态记录 + 原子发号 + audit**)。这样记录一建即是终态(verified 或 manual_review),**不存在 `pending_verification` 在途态**,FM-A 卡死恢复逻辑(在途行不可碰 / mismatch 只能 reject / matched 卡死可救)**整类消失**——不是「缓解」是「消灭」(外部调用全在唯一事务之前,事务内只剩本地写,失败即整体回滚无残留;孤儿图沿 FM-B 补偿删)。
- 含义:`pending_verification` 常量保留(防御 + 兼容历史行,`resolveManual` 仍接受它),但**新报名不再产生该态**;一期 e2e 的 FM-A 卡死系列(Ⓐ1-Ⓐ4)随之**改写/退役**。
- 备选(最小改动)**保留 tx1(pending)/tx2 两段结构**,只把 `mismatch→rejected` 改 `mismatch→manual_review` + OCR 类型新增 passport/hk_macau 识别;FM-A 逻辑与测试基本留存。churn 小但稳态更复杂(卡死类仍在,仅被缓解)。

**分叉⑤ · 姓名匹配口径 —— 推荐「完全一致(Unicode NFC 归一 + trim),不做生僻字容错」**
- 推荐:身份证号**完全一致**(trim + 'X' 大写归一后字符串相等);姓名**完全一致**(NFC 归一 + trim 后相等)。因「对不上 → manual_review 不误杀」,**从严零代价**(长尾交人工),且避免模糊匹配的误放行(把假证误判为一致)。
- 备选**生僻字容错**(编辑距离/混淆字表):复杂、难正确、有误放行风险;鉴于人工兜底,属过度工程,不推荐。

**分叉⑥ · `verifyOutcome` 取值粒度 —— 推荐「加细分 String 值(零 migration)」**
- 推荐:沿用 `matched`/`mismatch`/`manual`/`skipped`,**新增** `forgery_warning`/`ocr_unclear`/`ocr_error`/`category_mismatch`(均 String、零 migration),便于人工复核与审计区分进人工的原因。
- 备选**粗粒度**(只用 `mismatch`+`manual`),人工丢失原因信号。不推荐。

---

## 1. 决策汇总表

### 1.1 goal 已拍板项(D-RO;冻结,不重开)

| # | 决策 | 出处 |
|---|---|---|
| D-RO-1 | **放弃联网真实性核验**:删除 `IdCardVerification` 调用路径,全仓**无任何公安库 / 真实性比对调用**;实名 = OCR 识别 + 提交值与证件照 OCR 结果**自洽匹配** + 证件照清晰(OCR 成功) | goal 拍板 1 + DoD 红线 |
| D-RO-2 | **腾讯云 OCR 产品**:`ocr.tencentcloudapi.com`,version `2018-11-19`,service `ocr`;按 `documentTypeCode` 分流三 action | goal 拍板 2 |
| D-RO-3 | **接口映射**:`mainland_id`→`RecognizeValidIDCardOCR`(自带防伪)/ `passport`→`MLIDPassportOCR`(仅机读)/ `hk_macau_permit`→`MainlandPermitOCR`(校验类别仅来往内地、拒往来港澳) | goal 拍板 2 |
| D-RO-4 | **统一前段流程**:上传证件照 → OCR 识别 → 申请人确认/修正后提交 → 系统保证「提交 realName+idCardNumber 与证件照 OCR 一致」+「证件照清晰」 | goal 拍板 3 |
| D-RO-5 | **判定/状态机**:mainland 匹配+防伪→自动 verified 发号;不匹配/告警/失败→manual_review(**不再 rejected**);passport/hk_macau OCR 识别后→manual_review;taiwan/foreigner/其余→manual_review 不 OCR | goal 拍板 4 |
| D-RO-6 | **OCR 证件范围 = 身份证 + 护照 + 回乡证三类**;台胞证/外国人永居本期人工不 OCR(接口顺带支持,诉求出现再加) | goal 拍板 5 |
| D-RO-7 | **零新增 OCR 原始结果存储字段**:OCR 值经申请人确认落现有 `realName`/`idCardNumber`,判完即弃 | goal 拍板 3 + DoD |
| D-RO-8 | **真通道休眠**:本 goal 不接真实凭证(运维后填);**零新依赖**(原生 fetch + node crypto + 8s 上限);secretId/secretKey/Authorization/PII 不入日志(沿既有 realname 安全铁律) | goal 禁区 |

### 1.2 工程细节代决项(本稿固化;§0.5 元核验拍板后实施不得再漂移)

| # | 代决 | 依据 / 推荐分叉 |
|---|---|---|
| E-RO-1 | Provider 契约改为 `recognize(input:{documentTypeCode,image:Buffer,mimeType})→RealnameOcrResult{recognized,name,idCardNumber,warnings[],documentCategory?,reason?}`;`RealnameProvider.verify` 改名 `recognize`;`RealnameVerificationService.verify`→`recognize`;域错误→BizCode 映射边界不变(27030/27031) | §3.6;镜像现 provider 接口 |
| E-RO-2 | 真实 provider 走三 action:复用 `buildSignedHeaders`,改 `REALNAME_TC_HOST=ocr.tencentcloudapi.com` / `REALNAME_TC_SERVICE=ocr` / `REALNAME_TC_VERSION=2018-11-19` / action 按类型(`RecognizeValidIDCardOCR`/`MLIDPassportOCR`/`MainlandPermitOCR`);图片走 `ImageBase64`(base64(buffer))入 body;**真通道休眠**,`.spec` mock fetch 锁三 action 请求构造 + 结果/错误映射 | D-RO-2/3;沿现 TC3 签名 |
| E-RO-3 | 模块名 **不改**(仍 `realname/`,语义重定为「OCR 识别 + 自洽匹配」,非「联网真实性核验」),注释/文档显式说明语义换血;避免 CODEMAP/import 大范围 churn | 最小 churn |
| E-RO-4 | 证件类型路由 helper:新增 `isOcrDocument(code)`(∈{mainland_id,passport,hk_macau_permit})+ `ocrActionFor(code)`(返 action 或 null)+ `isMainlandId(code)`(唯一自动放行);**`isForeigner` 不变**(仍 `code!==mainland_id`,承载 birthDate/gender 派生跳过 + phase-2 手动建档边界——故 passport/hk_macau 既 OCR 又 isForeigner=true) | recruitment.constants |
| E-RO-5 | 新增公开**识别端点** `POST open/v1/recruitment/applications/recognize`(`@Public`+`@RecruitmentThrottle`;multipart:`documentTypeCode`+`idCardImage`)→ `RecruitmentOcrRecognizeResponseDto{ocrSupported,recognized:{realName,idCardNumber}\|null,clarityOk,antiForgeryWarnings[],documentCategory\|null,hint\|null}`;**无状态**(不落图、不发 token,推荐分叉①A) | §3.2 端点 4b |
| E-RO-6 | 提交端流程重构(推荐分叉④):免费校验 → code2session → 去重预检 → (OCR 类型)**付费 OCR** → 决策 → 落图 → **单事务建终态记录(verified 原子发号 / manual_review)+ audit**(P2002→28003 + 孤儿图补偿删);**OCR 前置于唯一事务之前**,消灭 pending_verification 在途态/FM-A | §4;一期 §4 + FM-A 升级 |
| E-RO-7 | mainland_id 判定矩阵(§3.6 表):success+clear+no-warning+name 完全一致+id 完全一致 → verified;否则 manual_review(细分 verifyOutcome,分叉⑥) | D-RO-5 + 分叉⑤⑥ |
| E-RO-8 | 提交端对 OCR **永不硬报错**(推荐分叉③):27030/27031/不清晰/告警/不匹配 → manual_review;27030/27031 仅识别端浮现 | 分叉③ |
| E-RO-9 | DevStub 改确定性 OCR 桩(§3.7):把上传图 buffer 当 UTF-8 JSON `{name,idCardNumber,warnings?,clarity?,category?}` 解析回显;非 JSON 兜底固定「清晰无告警」结果;production-like 写入口 + 运行时双重禁用不变 | E-R-6 升级;e2e 各链路可造 |
| E-RO-10 | audit:**复用** `recruitment-application.realname-verify` 事件(语义重定为「提交端 OCR 调用」,extra `{idCard:掩码,name:掩码,documentType,outcome}`,建记录后写、resourceId=申请 id);识别端点 OCR 调用 → pino 运维 trace(无 DB resource;cost-DoS 已登记接受);**union 零变** | 配套③ + audit 最小 footprint |
| E-RO-11 | 零 schema migration / 零新 BizCode / 零新权限码 / 零新依赖(§2 风险表逐条);`verifyOutcome` 新值零 migration;不支持类型 → `ocrSupported:false`(非错误) | §0 TL;DR 6 |
| E-RO-12 | 既有行为锁:auth/微信/sms/attachments/members/insurance/phase-2/phase-3 零 diff;`realname-settings` 三端点 + 凭证加密/三态 credentialStatus **零行为漂移**(仅通道指向的腾讯云产品变了);`code2session` 只读复用零改 | §7 |

---

## 2. 风险表(D 档降速 ②)

| 项 | 结论 |
|---|---|
| 是否修改 `prisma/schema.prisma` | ❌ **零变更**(`idCardNumber`/`documentTypeCode`/`verifyOutcome`/`idCardImageKey`/`isForeigner` 均已就位;`verifyOutcome` 是 String,新值零 migration;`RealnameProviderType` enum 不变) |
| 是否新增 migration | ❌ **无**(故 **不触发 `srvf-prisma-change` 降速**;迁移计数仍 23) |
| 是否修改 `prisma/seed.ts` | ❌(权限码/字典/角色零变化;`document_type` 5 项字典已就位) |
| 是否影响现有数据 | ❌(无 schema/数据迁移;历史 `pending_verification`/`rejected` 行不回填,`resolveManual` 仍兼容 pending 行) |
| 是否不可逆 | ❌(纯行为 + 通道层 + 测试改动;可整体回退到二要素核验) |
| 是否影响 OpenAPI / contract snapshot | ✅ **+1 路由**(识别端点)+ 提交端 `@ApiBizErrorResponse` 错误码集微调;**仅新增,零删改,零 L3** |
| 是否新增 BizCode | ❌ **零**(复用 27030/27031;OCR 失败/不清晰/类别不符/不匹配 → manual_review 非错误码;不支持类型 → `ocrSupported:false`) |
| 是否新增权限码 | ❌ **零**(识别端点 `@Public`;settings 码不变) |
| 是否影响鉴权 / audit | ⚠ 仅 audit:**union 零变**(复用 `realname-verify` 事件,语义重定);`JwtPayload`/Guard 链/AppIdentityResolver 零碰 |
| 是否新增 env / docker-smoke | ❌(`REALNAME_ENCRYPTION_KEY` 已就位;docker-smoke 锚行不变) |
| 是否触碰 api-surface-policy 红区 | ❌(`open/v1` 已于一期首用;识别端点是既有公开 surface 内新增,非政策红区) |
| 是否新增依赖 / cron | ❌ **零**(原生 fetch + node crypto;不新增 cron) |
| 是否需要用户拍板 | ✅ goal 已立项 + 授权;**§0.5 六分叉须元核验拍板后冻结**(D-RO-* 已拍板,E-RO-* 待确认) |
| 为何仍是 D 档 | 实名通道核心语义改造(放弃真实性核验 = 安全/合规语义变)+ 报名主流程与状态机分支 + audit 语义重定 + 需对抗审查;**虽零 schema/BizCode/权限码,仍按 D 档降速 + 评审稿冻结 + 元核验**(process §4) |

---

## 3. 五张清单

### 3.1 schema —— **零变更**(本节为「确认不动」清单)

- `recruitment_applications`:`realName?` / `idCardNumber?`(通用证件号容器:大陆 18 位 / 外籍证件号)/ `documentTypeCode` / `isForeigner` / `idCardImageKey?` / `verifyOutcome?`(String)/ `birthDate?` / `genderCode?` 均已就位,**全部复用**。
- `realname_verification_settings`:`providerType`(DEV_STUB/TENCENT_CLOUD)/ `region?` / `secretIdEncrypted?` / `secretKeyEncrypted?` / `credentialConfigured` 复用——**OCR 与原二要素同走 secretId+secretKey+region,settings 形态零变**。
- enum `RealnameProviderType { DEV_STUB, TENCENT_CLOUD }` 不变(语义 = OCR provider)。
- **`verifyOutcome` 新增取值**(String,零 migration):`forgery_warning` / `ocr_unclear` / `ocr_error` / `category_mismatch`(分叉⑥);沿用 `matched`/`mismatch`/`manual`/`skipped`。
- 退役(保留常量、新报名不再产生):`pending_verification` 在途态(分叉④)、`ELIM_STAGE_REALNAME`('realname';mismatch 不再 rejected)。

### 3.2 端点清单(净 **+1**;现 228 → **229**)

| # | Method Path | 鉴权后缀 | 变化 | 说明 |
|---|---|---|---|---|
| 4 | `POST open/v1/recruitment/applications` | `[public]`+`@RecruitmentThrottle` | **改造** | 提交:免费校验 → (OCR 类型)付费 OCR 权威判定 → 单事务建终态(mainland 匹配→verified 发号 / 其余→manual_review);`@ApiBizErrorResponse` 错误码集微调(去掉「核验硬错导致的发号失败」语义,OCR 失败转人工不再外抛) |
| **4b** | `POST open/v1/recruitment/applications/recognize` | `[public]`+`@RecruitmentThrottle` | **新增** | 识别:multipart(`documentTypeCode`+`idCardImage`)→ OCR 回填结果(无状态);非 OCR 类型返 `ocrSupported:false`;不清晰返 `clarityOk:false`(非错误);通道未配/上游失败浮现 27030/27031 |
| 5 | `POST open/v1/recruitment/applications/query` | `[public]`+`@RecruitmentThrottle` | 零变 | 本人查询 |
| 6-13 | admin 轮次 ×4 + 报名 ×4(列表/详情/取图/resolve) | 各 rbac 后缀 | 零变 | `resolveManual` 仍兼容历史 pending 行(分叉④);取证件照 signed-URL 不变 |

Tag:`Public - Recruitment`(识别端点同 controller)。contract `EXPECTED_ROUTES` 228 → **229**(仅新增)。

### 3.3 BizCode —— **零新增**(本节为「复用/不开」清单)

| code | 复用语义(OCR 口径) |
|---|---|
| 27030 `REALNAME_CHANNEL_NOT_CONFIGURED` | OCR 通道未配置/未启用/凭证非 CONFIGURED/production-like DEV_STUB(**仅识别端点浮现**;提交端转 manual_review) |
| 27031 `REALNAME_API_FAILED` | OCR 上游失败(腾讯云 Error 回执/HTTP 非 200/超时/网络/缺字段)(**仅识别端点浮现**;提交端转 manual_review) |
| 28030/28031/28010/28003/28011/40000 | 报名免费校验链复用(无 open 轮/容量满/年龄越界/去重/缺图/格式) |

**不开**:OCR 失败/不清晰/类别不符/不匹配 **非 BizCode**(是 OCR 结果驱动 manual_review,沿一期「不匹配非错误码」铁律);不支持的证件类型 → `ocrSupported:false`(识别端点正常 200,非错误)。

### 3.4 权限码 —— **零新增**(识别端点 `@Public`;settings 码不变)。权限码全集仍 **155**。

### 3.5 audit —— **union 零变**

- **复用** DB 事件 `recruitment-application.realname-verify`:语义重定为「提交端付费 OCR 调用」;`actorUserId` 置空;`extra={idCard:掩码,name:掩码,documentType,outcome}`;**建终态记录后写**(resourceId=申请 id;每次提交端付费调用必留痕)。
- **识别端点** OCR 调用:pino 运维 trace(无 DB resource,记 `{documentType,outcome,ip}` 掩码);cost-DoS 已登记接受(§6 + 沿 P3 F7)。
- 其余(submit/resolve-manual/...)事件与掩码不变。**不写**任何 OCR 原始结果/明文 PII/凭证(L3)。

### 3.6 Provider 契约 + mainland_id 判定矩阵 + 证件类型映射表

**Provider 契约(E-RO-1)**:
```ts
interface RealnameOcrInput  { documentTypeCode: string; image: Buffer; mimeType: string }
interface RealnameOcrResult {
  recognized: boolean;          // OCR 成功且可读(清晰度;false=不清晰/读不出)
  name: string | null;          // OCR 识别姓名
  idCardNumber: string | null;  // OCR 识别证件号
  warnings: string[];           // 防伪/质量告警归一码(空=无告警;仅 mainland 有意义)
  documentCategory?: string | null; // 仅 hk_macau:证件类别(须 ∈ 来往内地)
  reason?: string;              // 归一化原因(不含 PII;审计辅助)
}
interface RealnameProvider { recognize(input: RealnameOcrInput): Promise<RealnameOcrResult> }
```

**证件类型 → 接口映射表 + 各接口限制(D-RO-3/6)**:

| documentTypeCode | 字典 label | OCR action | 接口限制 / 频率 | 提交端去向 |
|---|---|---|---|---|
| `mainland_id` | 居民身份证 | `RecognizeValidIDCardOCR` | 自带图像防伪(翻拍/PS篡改/复印件/遮挡/边框不全/反光告警);id 18 位 | 匹配+无告警+清晰→**verified 发号**;否则→manual_review |
| `passport` | 护照 | `MLIDPassportOCR` | **仅可机读护照**(MRZ);非机读→识别失败(clarity=false) | →manual_review(人工最终;提交端不重识别,分叉②) |
| `hk_macau_permit` | 港澳居民来往内地通行证(回乡证) | `MainlandPermitOCR` | 校验**证件类别 ∈ 来往内地**;往来港澳→category_mismatch | →manual_review(人工最终) |
| `taiwan_permit` | 台湾居民来往大陆通行证 | (本期不 OCR) | 接口顺带支持(MainlandPermitOCR),诉求出现再加 | →manual_review(不 OCR) |
| `foreigner_permit` | 外国人永久居留身份证 | (本期不 OCR) | — | →manual_review(不 OCR) |

> 频率上限:腾讯云 OCR 默认 QPS(各产品约 ≥10-20 QPS)在招新低量 + 8s 上限 + `@RecruitmentThrottle`(IP 10/3600)下非瓶颈;真实字段名以腾讯云文档为准、在实施期对照(休眠期由 spec mock 锁结构,rollout 期联调校正)。

**mainland_id 判定矩阵(E-RO-7;提交端,分叉⑤⑥)**:

| OCR 结果 | name 完全一致 | id 完全一致 | 防伪 | → 状态 | verifyOutcome |
|---|---|---|---|---|---|
| 成功+清晰 | ✓ | ✓ | 无告警 | **verified + 发号** | `matched` |
| 成功+清晰 | ✗(任一不一致) | — | 无告警 | manual_review | `mismatch` |
| 成功+清晰 | ✓ | ✓ | **有告警** | manual_review | `forgery_warning` |
| 不清晰(clarity=false) | — | — | — | manual_review | `ocr_unclear` |
| 上游失败(27031)/通道未配(27030) | — | — | — | manual_review(分叉③) | `ocr_error` |

> passport/hk_macau:恒 manual_review;提交端不重识别(分叉②),`verifyOutcome=manual`(识别端的类别/清晰为前端建议性 + 人工最终)。taiwan/foreigner/其余:不 OCR,manual_review,`verifyOutcome=manual`。

### 3.7 DevStub OCR 桩(E-RO-9)

- `DevStubRealnameProvider.recognize(input)`:把 `input.image`(Buffer)按 UTF-8 解析为 JSON `{ name, idCardNumber, warnings?: string[], clarity?: boolean, category?: string }`,作为确定性 OCR 结果回显;**解析失败兜底**返 `{recognized:true,name:'测试姓名',idCardNumber:<input 不可知则空>,warnings:[],...}`(本地联调用)。
- e2e 各链路造法(上传图 = 一小段 JSON,Content-Type 仍标 image/jpeg;service 只校 mimetype 串 + 大小,不校 magic bytes):
  - 大陆自动通过:`mainland_id` + JSON `{name:"张三",idCardNumber:"<偶校验位有效号>",clarity:true,warnings:[]}` + 提交 confirmed 同值 → verified。
  - 匹配不一致转人工:提交 confirmed 与 JSON 不一致 → manual_review(`mismatch`)。
  - 证件不清晰:JSON `{clarity:false}` → recognized=false → manual_review(`ocr_unclear`)。
  - 防伪告警:JSON `{warnings:["PS"]}` → manual_review(`forgery_warning`)。
  - 回乡证类别:`hk_macau_permit` + JSON `{category:"往来港澳通行证"}` → category_mismatch / `{category:"港澳居民来往内地通行证"}` → 正常 manual_review。
  - 外籍人工:`taiwan_permit`/`foreigner_permit` → provider 不调 → manual_review。
- debug 日志不输出 name/idCardNumber(沿现 DevStub);不模拟通道错误/超时(由真 provider spec mock 覆盖);production-like 双重禁用不变。

---

## 4. 报名流程冻结(推荐分叉①A+②+③+④;实施不得调换)

**识别 `POST open/v1/recruitment/applications/recognize`(无状态)**:
1. DTO/multipart 校验(`documentTypeCode` 必填、`idCardImage` mime/大小)→ 不合 40000。
2. 当前 open 轮存在(cheap DB;无 → 28030,省 OCR)。
3. `isOcrDocument(documentTypeCode)` 为假 → 200 `{ocrSupported:false}`(前端转手填,不 OCR)。
4. 付费 OCR(`ocrActionFor`)→ 结果。通道未配 27030 / 上游失败 27031 **在此浮现**(前端 UX);不清晰 → 200 `{ocrSupported:true,clarityOk:false,recognized:null,hint:"请重拍清晰证件照"}`。
5. 200 返 `{ocrSupported:true,clarityOk:true,recognized:{realName,idCardNumber},antiForgeryWarnings,documentCategory}` 供前端回填、申请人确认/修正。pino trace 留痕(掩码)。

**提交 `POST open/v1/recruitment/applications`(顺序即「免费在前、付费最后、建记录最后」)**:
1. DTO 校验(controller)。
2. 当前 open 轮解析(无 28030 / 满 28031)。
3. `mainland_id`:校验位(40000)+ 年龄 18-60(28010)(纯,免费;非大陆跳过)。
4. 紧急联系人 relation 字典校验(免费,fail-fast)。
5. `code2session(wechatCode)`(免费 wechat;失败沿 25030/25031)→ openid。
6. 同轮去重预检 `(cycleId,idCardNumber)` 活跃非 rejected(28003)(免费,省 OCR)。
7. mime/大小(multer + 40000)(免费)。
8. **付费 OCR**(仅 OCR 类型;`mainland_id` 必调权威判定;`passport`/`hk_macau` 按分叉②**不在提交端重识别**;taiwan/foreigner/其余跳过)→ 结果 / 异常按分叉③ 转 manual_review 不外抛。
9. 决策状态(§3.6 矩阵):mainland 匹配+清晰+无告警 → verified;否则 / 其余 OCR 类型 / 非 OCR 类型 → manual_review(细分 verifyOutcome)。
10. 落图 → `idCardImageKey`(失败不建记录)。
11. **单事务**:create 终态记录(verified → 原子发号 `tempNoSeq+1`〔容量校验同事务,FM-C〕+ tempNo+verifiedAt;manual_review → 无 tempNo)+ derive 脱敏字段 + `verifyOutcome` + audit `submit`(actor 置空)+(mainland)audit `realname-verify`(resourceId=新 id;掩码 + outcome);去重 unique 强制(P2002→28003 + 孤儿图补偿删,FM-B)。
12. 事务后:通知触发数据已落库;返 public DTO。

> **无 `pending_verification` 在途态、无 FM-A 卡死类**(分叉④):外部调用(code2session/OCR)全在唯一事务之前;事务内只剩本地写,失败整体回滚无残留(孤儿图 FM-B 补偿)。`resolveManual` 仍兼容历史 pending 行(防御)。
> **manual_review 出口** = admin `POST .../:id/resolve`(通过→发号 / 不通过→rejected,eliminationStage='manual')不变。

---

## 5. 模块结构(零新模块/零新子目录;就地改造)

```
src/modules/realname/                          # 第 25 模块(语义换血:OCR 识别 + 自洽匹配)
├── realname.service.ts                        # verify→recognize;域错误→BizCode(27030/27031)不变
├── realname.types.ts                          # RealnameVerifyInput/Result → RealnameOcrInput/Result(+RealnameProvider.recognize)
├── realname.constants.ts                      # TC host/service/version/action 改 OCR;DevStub 桩改 JSON 回显;maskIdCard/maskName 复用
├── providers/
│   ├── dev-stub.provider.ts                   # recognize:JSON 回显确定性桩(E-RO-9)
│   └── tencent-realname.provider.ts           # recognize:三 action 分发,复用 buildSignedHeaders;休眠;.spec mock fetch 锁结构
├── realname-settings.{service,controller,dto}.ts  # 零行为漂移(凭证/三态/单例不变)
└── realname-crypto.service.ts                 # 零变

src/modules/recruitment/
├── recruitment-public.controller.ts          # +recognize 端点(端点 4b);submit @ApiBizErrorResponse 微调
├── recruitment.dto.ts                         # +RecruitmentOcrRecognizeResponseDto;submit DTO 基本不变(仍 multipart)
├── recruitment.constants.ts                   # +isOcrDocument/ocrActionFor/isMainlandId;verifyOutcome 新值;pending/realname 退役注记
└── recruitment-applications.service.ts        # submit 重构(§4);recognize 编排;mismatch→manual_review;FM-A 退役/简化
```

跨模块依赖不变:`recruitment` → `realname`/`wechat`/`storage`(单向);`realname` 叶子。

---

## 6. 敏感字段 + 留存(沿一期 §6;本次零增量)

1. **业务用途**:`realName`/`idCardNumber` = OCR 自洽匹配 + 同轮去重(语义从「二要素核验输入」变为「与证件照 OCR 比对的申请人确认值」);证件照 = OCR 输入 + 人工复核依据;`phone` 仍仅通知用途、非身份证据。
2. **OCR 结果不落库**(D-RO-7):识别/提交端的 OCR `name`/`idCardNumber`/`warnings` 仅在内存用于回填(返申请人本人)与比对,**判完即弃**;落库的是申请人**确认值**(mainland 自动放行路 == OCR 值);零新增存储字段。识别端点返申请人本人 OCR 值属 self-scope 回填(非 L3),但**不入日志**。
3. **留存 SOP 零增量**:证件照仍 1 张(提交端落 `idCardImageKey`),沿现 `recruitment-data-retention-sop.md`(按 key 删 blob + NULL 敏感字段)。**识别端无状态 → 无新孤儿图类**(分叉①A 的关键收益;若改 B 落图,须为「识别落图未提交」新增孤儿清理 SOP)。
4. **凭证 L3 不变**:secretId/secretKey 永不回显/入日志;Authorization 头不落日志(沿 realname 安全铁律)。

---

## 7. 既有行为锁(实施期间任一破坏 = 停下报告)

1. auth/JWT/refresh/微信 `code2session` 只读复用 / sms / attachments / members / member-profiles / activity-registrations / insurance / phase-2 promote / phase-3 team-join **零 diff**。
2. `realname-settings` 三端点(GET/PATCH/reset-credentials)+ 凭证两段加密 + 三态 credentialStatus + 单例 + production-like 禁 DEV_STUB **零行为漂移**(出参/RBAC/掩码不变;仅运行时指向的腾讯云产品从 faceid 变 ocr)。
3. `@RecruitmentThrottle`/Guard 链/ResponseInterceptor/AppIdentityResolver 零碰;识别端点复用既有 throttler。
4. contract snapshot **仅新增**(识别端点 + submit 错误码集微调),零删改、零 L3。
5. 临时编号永不进 members(schema 无 Member FK 已保证);phase-2/3 入口态 `verified` 语义不变(mainland 自动放行仍发 `verified`+临时编号,下游门槛/评定/发号链零感知)。
6. **全仓无 `IdCardVerification` / 任何联网真实性核验调用路径**(DoD 红线;grep 自证零命中)。

---

## 8. 测试计划(DoD 展开)

- **unit**:
  - `tencent-realname.provider.spec`:**重写**为三 action(mock fetch)——`RecognizeValidIDCardOCR` 成功/防伪告警/不清晰 / `MLIDPassportOCR` 成功/非机读失败 / `MainlandPermitOCR` 类别来往内地/往来港澳;上游 Error 回执→27031 / HTTP 非 200→27031 / 超时→27031 / 通道未配→27030(不调 fetch);锁请求构造(host/service/version/action/ImageBase64)。
  - `dev-stub.provider.spec`:**重写**为 JSON 回显桩各分支(matched/mismatch/unclear/warning/category)。
  - `realname.service.spec`:`recognize` 路由 + 错误→BizCode(27030/27031)映射(改方法名)。
  - `recruitment-applications.service.spec`:FM-B 孤儿图补偿在新单事务结构下仍成立(OCR 前置 → 事务失败补偿删);新增 mainland 判定矩阵关键分支单测(可选)。
- **e2e `recruitment.e2e-spec.ts`**(改写 + 新增):
  - **识别端点**:mainland 回填 OCR 值 / passport 回填 / 非 OCR 类型 `ocrSupported:false` / 不清晰 `clarityOk:false` / 通道未配 27030(识别端浮现)。
  - **提交端改写**:① mainland OCR 匹配+清晰+无告警 → verified+`T...0001`(members 零增长)；② mainland **不匹配 → manual_review**(原「→rejected」翻转;`eliminationStage` 不再 'realname')；③ mainland 防伪告警 → manual_review(`forgery_warning`)；④ mainland 不清晰 → manual_review(`ocr_unclear`)；⑤ **passport OCR → manual_review**(提交端不重识别,分叉②)；⑥ hk_macau 类别往来港澳 → manual_review(`category_mismatch`)；⑦ taiwan/foreigner → manual_review 不 OCR(provider 零调用断言)；⑧ manual_review → admin resolve 通过发号 / 不通过 rejected。
  - **FM-A 系列(Ⓐ1-Ⓐ4)退役/改写**(分叉④):不再产生 pending_verification 在途态;保留 `resolveManual` 对历史 pending 行兼容的 1 例(防御)。
  - **成本纪律**:免费校验未过(年龄越界/缺图/去重命中)时**付费 OCR 零调用**断言;OCR 在全部免费校验之后调用断言。
  - **DoD 红线**:全仓 grep 无 `IdCardVerification` 断言(或 contract/源码守护)。
  - 既有:编号按序唯一 / 防重 28003 / 轮次开关 28030 / 容量满 28031 / 取证件照 signed-URL / 掩码 / RBAC 边界 / members 零增长 **保持绿**。
- **realname-settings.e2e-spec**:零行为漂移,**保持绿**(仅通道产品变,settings 契约不变)。
- **横切回归**:auth-*/sms/wechat/insurance/phase-2/phase-3/CMS 全组零修改全绿;contract 仅新增 1 路由 + 错误码集受控。
- 计数三件套(e2e suites/tests、unit spec/tests、contract routes)**实跑亲核**写入 current-state(本地 OrbStack 起则跑 full;未起则 quick + 显式声明 contract/e2e 留 CI,不谎报)。

---

## 9. 任务队列与探针(顺序硬约束;goal 队列固化)

| 阶段 | 档 | 内容 | 探针(未满足才做) |
|---|---|---|---|
| **T0** | A | 本稿冻结(✅ §0.5 六分叉 2026-06-22 元核验「按推荐」+ 4 附加把关) | ✅ 已完成 |
| **T1+T2** | D | **合并一个功能 PR**(契约耦合,见顶部 PR 结构):`realname/` 通道层(provider `recognize` 三 action + 复用 TC3 签名 + 休眠 + DevStub JSON 桩 + types/constants/settings 语义)+ `recruitment/` 流程重构(§4)+ 识别端点 4b + 状态机(mismatch→manual_review)+ verifyOutcome 新值 + audit 语义重定 + DTO + 全部 spec/e2e + IdCardVerification 删净 | provider 仍 `verify`/faceid |
| T3 | A | CHANGELOG + current-state §1/§2/§3 回填 + realname/recruitment 模块注释 + `ops/realname-verification-rollout-checklist.md` 改 OCR 凭证/验收口径 | current-state 无 OCR 改造行 |

> **收口 = 并入下个 minor**(2026-06-22 元核验拍板;无 schema/BizCode/权限码增量)。沿 `srvf-release-closeout`。LOOP 纪律沿 process §7.1:同失败 ≤2 轮;连续 2 轮零推进熔断;每 PR 合并沿 §5.4。

---

## 10. 本期不做(终版报告必列)

- 真实腾讯云 OCR 通道接入(运维接力,出 SOP;DevStub 全验;真凭证后填)。
- 台胞证 / 外国人永居 OCR(接口顺带支持,本期人工;诉求出现再加)。
- OCR 原始结果落库 / 历史比对 / 二次校验工作流。
- 联网真实性核验的任何形态(明确放弃,不偷留)。
- 新 cron / 新依赖 / 新模块 / schema 变更。
- 招新下游(phase-2/3)逻辑改动(入口态 `verified` 语义不变,下游零感知)。
- 分叉①B 的 HMAC 凭据方案(除非元核验改选 B)。

---

## 11. 红区改动计划

- **无 baseline §1.1 红区改动**(零新 BizCode 段)。
- **无 api-surface-policy 红区改动**(`open/v1` 已首用;识别端点是既有公开 surface 内新增)。
- **受保护文档**(AGENTS §0:current-state / CHANGELOG / 本评审稿 / 模块注释)中**本 feature 必需**的改动在 goal 授权范围(surgical + PR body 标注)。
- `AGENTS.md` 本体 / V2 红线 **零碰**。

---

> 实施(T1-T3)以本稿为准;与 goal 原文冲突时 goal 优先;**§0.5 六分叉以维护者元核验冻结结论为准,未拍板前不实施**;新发现问题按 process §4.1 人话简报上报,不顺手修。
