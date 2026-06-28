# SRVF 招新实名 OCR 鉴伪版充分利用评审稿(Recruitment Realname OCR Anti-Forgery Enrichment Review)

> 冻结时刻:2026-06-29 · 基线 v0.32.0(HEAD==origin/main `b8e2054`,0 open PR)
> 立项 = goal「招新实名 OCR 充分利用腾讯云身份证鉴伪版能力」(维护者拍板 + 授权;自驱执行)
> 本稿镜像既有 `recruitment-realname-ocr-review.md` / `sms-verification-infra-review.md` /
> `wechat-mini-login-review.md` 先例:把**精确列名/类型、字段映射表、Enable\* 开关清单、裁剪图 key 规则、
> 敏感分级、DTO 增量、DevStub/spec 计划、护栏零变**全部钉死,实施期不得再漂移。
> 字段名以腾讯云线上文档 <https://cloud.tencent.com/document/product/866/112345> 为准,**运维上线再校正**
> (沿既往 OCR 迁移惯例;真通道休眠不变)。

---

## 0. TL;DR

现状只榨了鉴伪版 `RecognizeValidIDCardOCR`(Version 2018-11-19)的一点点:请求体仅 `{ ImageBase64 }`、
映射只取 `Name/IdNum/3 防伪标志`。本 goal 把它**充分利用**:

1. **请求体显式带 Enable\* 开关**(仅 mainland_id),取回字段级反光/不完整 + 卡片级质量/防伪 + 主体裁剪图 + 头像裁剪图 + 顶层证件类型。
2. **四列入库**(住址/民族/签发机关/有效期,additive nullable 业务列);**主体裁剪 + 头像裁剪**两张图 submit 时解码入库(两个新 key 列)。
3. **recognize 端点顾问式回显**:字段级告警(每栏 reflect/incomplete)+ 卡片级质量/防伪 + 证件类型 + OCR 性别/民族/出生/住址/签发机关/有效期。
4. **admin 取图扩为三图签名 URL**(原图 + 主体裁剪 + 头像裁剪),敏感新列纳入既有 `read.sensitive` 门控。

**行为锁铁律**:`recognized` 清晰度判定、S4b 六分流、`riskLevel`、`antiForgeryWarnings→lastOcrOutcome`、
`birthDate/genderCode` 由身份证号推导的**权威性**——一律不破。OCR 的 Sex/Birth **仅回显、不持久、不覆盖**。
字段级/卡片级告警 + 证件类型 **顾问式回显,不进任何判定**。

**护栏零变**:EXPECTED_ROUTES **260→260**(0 新端点)· 权限码 **0 新**(复用 `read.record`/`read.sensitive`)·
BizCode **0 新**。明文 PII(姓名/证件号/住址/民族/裁剪图 base64)永不入日志(L3)。

---

## 1. 决策汇总表

### 1.1 goal 已拍板项(冻结,不重开)

| # | 决策 | 取值 |
|---|---|---|
| P1 | 增强面 | **仅** mainland_id(`RecognizeValidIDCardOCR`);passport/hk_macau 维持现状,不迁统一接口 |
| P2 | 四列入库 | 住址/民族/签发机关/有效期 = additive nullable 业务列;OCR Sex/Birth 仅回显不持久、不覆盖 genderCode/birthDate |
| P3 | 头像裁剪图 | 仅入库存档(后台人工复核查看);「设为队员头像」留后续 goal,本轮不碰 promotion/team-join/member |
| P4 | 字段级告警 + 证件类型 | 顾问式回显,**不改判定**;recognized/六分流/riskLevel/antiForgeryWarnings→lastOcrOutcome 行为锁不破 |

### 1.2 工程细节代决项(本稿固化)

| # | 细节 | 冻结取值 |
|---|---|---|
| E1 | 4 业务列命名 | `ocrAddress` / `ocrNation` / `ocrAuthority` / `ocrValidDate`(全 `String?`;`ocr` 前缀显式标识「OCR 读取、非权威」,**区别于既有 applicant 自填 `detailedAddress`**) |
| E2 | 有效期类型 | `String?`(腾讯返串如 `2010.07.21-2020.07.21` / `2010.07.21-长期`;不解析为 DateTime) |
| E3 | 2 裁剪图 key 列 | `idCardCropImageKey`(主体框 CardImage)/ `idCardPortraitImageKey`(头像 PortraitImage);镜像 `idCardImageKey String?` 形态 |
| E4 | 裁剪图 storage key 规则 | `recruitment/id-card-crop/{cycleId}/{uuid}.jpg` / `recruitment/id-card-portrait/{cycleId}/{uuid}.jpg`(镜像 `ID_CARD_IMAGE_KEY_PREFIX` 形态:prefix 常量 + cycleId + uuid + ext;裁剪图恒 jpg) |
| E5 | Enable\* 开关注入面 | 仅 mainland action 的请求体带;passport/hk_macau 维持 `{ ImageBase64 }`(那两 action 无鉴伪/裁剪能力) |
| E6 | base64 裁剪图流向 | **仅 submit 路径消费**(解码入库);**不进 recognize 响应、不入日志** |
| E7 | 4 列写入面 | 仅 mainland 且 disposition='submitted' 落库时写(matched→verified / mismatch+确认③ / forgery 高风险 / 等);ocr_error(OCR 失败)→ ocr 为 null → 列全 null |
| E8 | 敏感分级 | 4 OCR 列 + 3 图 URL 纳入既有 `read.sensitive` 门控(镜像 S3 #441);masked → 4 列 null + 裁剪 URL 仅 sensitive 闸内可取 |
| E9 | 卡片级告警回显口径 | recognize 响应新增结构化 `cardWarnings{copy,reshoot,ps,border,occlusion,blur}`(全集,顾问式);既有 `antiForgeryWarnings: string[]`(forgery 子集,驱动路由)**保留不动** |

---

## 2. 风险表(D 档降速)

| 风险 | 缓解 |
|---|---|
| 真腾讯响应字段名与本稿假定不符 | 真通道休眠;provider.spec 以线上文档嵌套结构 mock 锁定;运维上线校正(沿 OCR 迁移惯例) |
| 误把 OCR Sex/Birth 覆盖号码推导 | submit 不读 OCR Sex/Birth;e2e 断言 gender/birth 恒来自号码推导 |
| 字段级告警渗进判定 | 告警只入 recognize 响应 + 4 列存档;classifyOcrResult/routeOcrOutcome 入参集**零变**(只读 recognized/name/idCardNumber/warnings);ocr-routing.spec 零回归 |
| 裁剪图 base64 入日志/响应泄漏 | provider logger.debug 仅记布尔/长度;recognize 响应不含 base64;submit 落库后 buffer 即弃 |
| 裁剪图落 storage 失败阻断提交 | 裁剪缺省/接口未返 → 列 null 不阻断;落图失败走既有 orphan 清理范式(收集全部已落 key 逐个 best-effort 删) |
| 迁移破坏既有行 | 6 列全 additive nullable 无默认无回填无 enum;干净库重放 + seed 幂等二跑自证 |

---

## 3. 五张清单

### 3.1 schema —— **+6 列(全 additive nullable;1 migration)**

`model RecruitmentApplication`(`prisma/schema.prisma`)新增:

```prisma
// ===== OCR 鉴伪版充分利用(2026-06-29)=====
// 仅 mainland_id RecognizeValidIDCardOCR 充分利用:扩展字段入库 + 主体/头像裁剪图入库。
// 全 additive nullable 无 enum;OCR 读取值(顾问式存档,非权威);gender/birth 仍由号码推导,本组不参与。
ocrAddress             String? // OCR 住址(≠ applicant 自填 detailedAddress;敏感,read.sensitive 门控)
ocrNation              String? // OCR 民族
ocrAuthority           String? // OCR 签发机关
ocrValidDate           String? // OCR 有效期(串;如 2010.07.21-2020.07.21 / -长期)
idCardCropImageKey     String? // 主体框裁剪图 storage key(CardImage;后台复核查看)
idCardPortraitImageKey String? // 头像裁剪图 storage key(PortraitImage;存档;晋升设头像留后续 goal)
```

migration 目录:`prisma/migrations/20260629HHMMSS_add_recruitment_ocr_anti_forgery_fields/`(6 × `ADD COLUMN ... NULL`;
无 default、无 backfill、无 enum、无索引、无 partial unique 改动)。D 档:干净库 `migrate reset` 重放 + `seed` 幂等二跑。

### 3.2 端点清单 —— **零变更**(EXPECTED_ROUTES 260→260)

不新增/不删除/不改 path 任何端点。仅扩展既有 3 端点的**响应体字段集**:
- `POST /api/open/v1/recruitment/applications/recognize`(响应 +`ocrDetail`)
- `POST /api/open/v1/recruitment/applications`(提交;入参不变,内部多落 4 列 + 2 裁剪图)
- `GET /api/admin/v1/recruitment/applications/{id}/id-card-image-url`(响应 +`cropImageUrl`/`portraitImageUrl`)
- `GET /api/admin/v1/recruitment/applications/{id}`(详情 +4 OCR 列,敏感分级)

> 如实施期发现确需新端点 → **人话简报停**(goal 授权边界:不新增端点)。

### 3.3 BizCode —— **零新增**

复用既有:27030/27031(OCR 通道/上游)、28011(缺图)、40000、30100、28002 等。本特性不开新 BizCode。

### 3.4 权限码 —— **零新增**

复用 `recruitment-application.read.record`(详情/列表)+ `recruitment-application.read.sensitive`(明文 OCR 列 + 三图签名 URL)。
识别/提交端点 `@Public`。权限码全集**零变**。

### 3.5 audit —— **union 零变**

复用既有 `recruitment-application.submit` / `recruitment-application.realname-verify` 伞事件;
extra 不新增明文(裁剪图/住址/民族不入 audit)。读图签名 URL 复用既有 `id-card-image.read` placeholder。

### 3.6 Provider 契约 + 字段映射表 + Enable\* 开关清单

#### 3.6.1 Enable\* 开关清单(仅 mainland 请求体;线上文档为准)

```jsonc
{
  "ImageBase64": "<base64>",
  "EnablePortrait":      true,   // 返回头像裁剪图 PortraitImage
  "EnableCropImage":     true,   // 返回主体框裁剪图 CardImage
  "EnableBorderCheck":   true,   // 边框完整性检查
  "EnableOcclusionCheck":true,   // 遮挡检查
  "EnableCopyCheck":     true,   // 复印件检查
  "EnableReshootCheck":  true,   // 翻拍检查
  "EnableQualityCheck":  true    // 图像质量(反光/模糊等)
}
```

passport(`MLIDPassportOCR`)/ hk_macau(`MainlandPermitOCR`)请求体维持 `{ ImageBase64 }` 不变。

#### 3.6.2 响应字段映射表(mainland `Response`;`{ Content }` 为嵌套对象)

| 腾讯响应路径 | → RealnameOcrResult | 用途 | 行为锁 |
|---|---|---|---|
| `IDCardInfo.Name.Content` | `name` | 既有匹配 | **不动** |
| `IDCardInfo.IdNum.Content` | `idCardNumber` | 既有匹配 | **不动** |
| `IDCardInfo.WarnInfos`(Copy/Reshoot/PS) | `warnings: string[]` | 驱动 forgery_warning 路由 | **不动**(collectForgeryWarnings 收窄不变) |
| `IDCardInfo.Sex.Content` + 字段标志 | `extendedFields.sex{content,reflect,incomplete}` | recognize 回显(不持久) | 新增,顾问式 |
| `IDCardInfo.Nation.Content` | `extendedFields.nation` + 落 `ocrNation` | 回显 + 存档 | 新增 |
| `IDCardInfo.Birth.Content` | `extendedFields.birth` | recognize 回显(**不持久、不覆盖 birthDate**) | 新增,顾问式 |
| `IDCardInfo.Address.Content` | `extendedFields.address` + 落 `ocrAddress` | 回显 + 存档 | 新增 |
| `IDCardInfo.Authority.Content` | `extendedFields.authority` + 落 `ocrAuthority` | 回显 + 存档 | 新增 |
| `IDCardInfo.ValidDate.Content` | `extendedFields.validDate` + 落 `ocrValidDate` | 回显 + 存档 | 新增 |
| `IDCardInfo.WarnInfos`(全 6 标志) | `cardWarnings{copy,reshoot,ps,border,occlusion,blur}` | recognize 卡片级回显 | 新增,顾问式 |
| 顶层 `Type` | `documentType` | recognize 回显证件类型 | 新增,顾问式 |
| 顶层 `CardImage`(base64) | `cardImageBase64` | **仅 submit 解码入库**;不入响应/日志 | 新增 |
| 顶层 `PortraitImage`(base64) | `portraitImageBase64` | **仅 submit 解码入库**;不入响应/日志 | 新增 |

字段级标志合并口径:`reflect = !!(IsReflect || IsKeyReflect)`、`incomplete = !!(IsInComplete || IsKeyInComplete)`。

### 3.7 DevStub OCR 桩扩展

`DevStubOcrEnvelope` 新增可选键:`extendedFields` / `documentType` / `cardWarnings` / `cardImageBase64` / `portraitImageBase64`,
clear+recognized 路径如实透传(缺省 → undefined → 下游降级 null)。debug 日志仍不输出姓名/证件号/裁剪图。

---

## 4. RealnameOcrResult / DTO 增量(钉死)

### 4.1 `realname.types.ts`(provider 出参承载)

```ts
export interface RealnameOcrField { content: string | null; reflect: boolean; incomplete: boolean; }
export interface RealnameOcrExtendedFields {
  sex: RealnameOcrField | null; nation: RealnameOcrField | null; birth: RealnameOcrField | null;
  address: RealnameOcrField | null; authority: RealnameOcrField | null; validDate: RealnameOcrField | null;
}
export interface RealnameOcrCardWarnings {
  copy: boolean; reshoot: boolean; ps: boolean; border: boolean; occlusion: boolean; blur: boolean;
}
// RealnameOcrResult 追加(全 optional;仅 mainland 鉴伪版填充):
//   documentType?: string | null;
//   extendedFields?: RealnameOcrExtendedFields | null;
//   cardWarnings?: RealnameOcrCardWarnings | null;
//   cardImageBase64?: string | null;       // submit 路径消费;不入响应/日志
//   portraitImageBase64?: string | null;   // submit 路径消费;不入响应/日志
```

### 4.2 `recruitment.dto.ts`(API 出参)

```ts
class RecruitmentOcrFieldDto { content: string|null; reflect: boolean; incomplete: boolean; }
class RecruitmentOcrCardWarningsDto { copy; reshoot; ps; border; occlusion; blur: boolean; }
class RecruitmentOcrDetailDto {
  sex|nation|birth|address|authority|validDate: RecruitmentOcrFieldDto|null;
  documentType: string|null; cardWarnings: RecruitmentOcrCardWarningsDto|null;
}
// RecruitmentOcrRecognizeResponseDto += ocrDetail: RecruitmentOcrDetailDto | null  (base64 裁剪图绝不在此)
// IdCardImageUrlResponseDto       += cropImageUrl: string|null; portraitImageUrl: string|null
// RecruitmentApplicationAdminDto  += ocrAddress|ocrNation|ocrAuthority|ocrValidDate: string|null (masked→null)
```

3 个新 named schema(`RecruitmentOcrFieldDto`/`RecruitmentOcrCardWarningsDto`/`RecruitmentOcrDetailDto`)
追加进 contract `EXPECTED_SCHEMAS` 白名单 + `@ApiExtraModels`;契约快照 `-u` 刷新(paths + components.schemas 段)。

---

## 5. 报名流程改造点(实施不得调换既有顺序)

`recruitment-applications.service.ts`:
- `classifyMainlandOcr()` 返回 `{ outcome, recognized, ocr }`(ocr = RealnameOcrResult | null;OCR 失败时 null)。
- `recognize()` 端点:`ocrDetail = buildOcrRecognizeDetail(ocr)`(presenter 纯函数;ocr 无扩展数据 → null)注入响应;base64 裁剪图不取。
- `submit()`:
  - 第 10 步落主图后,若 `mainlandOcr.cardImageBase64/portraitImageBase64` 存在 → 解码 `Buffer.from(b64,'base64')` + `putObject` 落两 key;**收集全部已落 key** 进 `storedKeys[]`。
  - 第 11 步建终态 create data 追加:`ocrAddress/ocrNation/ocrAuthority/ocrValidDate`(来自 `extendedFields.*.content`,有值才写)+ `idCardCropImageKey/idCardPortraitImageKey`(落图成功才写)。
  - catch:`for (k of storedKeys) safeDeleteOrphanImage(k)`(既有 orphan 范式扩为多 key)。
  - **零改**:birthDate/genderCode 推导(第 2 步)、六分流(第 7-9 步)、issueTempNo/容量、audit。

`recruitment-applications.presenter.ts`:
- `toAdminApplicationDto(app, masked)` += 4 OCR 列(`masked ? null : app.ocrX`);CSV 投影**不加**新列(保持列集)。
- 新增 `buildOcrRecognizeDetail(ocr): RecruitmentOcrDetailDto | null`(纯函数)。

`recruitment-applications-query.service.ts`:
- `getIdCardImageUrl()`:对存在的 `idCardImageKey/idCardCropImageKey/idCardPortraitImageKey` 各生成签名 URL,
  返 `{ url, expiresAt, cropImageUrl, portraitImageUrl }`(裁剪 key null → URL null;不阻断);闸仍 `read.sensitive`。

---

## 6. 敏感字段 + 留存

- `ocrAddress`(住址)= 高敏感 PII,等同 idCardNumber 级:masked→null、不入日志/audit 明文。
- 裁剪图 base64 = 高敏感:不入响应/日志;入库 blob 与原图同 L3,取图走短 TTL 签名 URL + read.sensitive。
- 留存 SOP(rejected / 轮 closed 满 30 天 NULL 化 + 删 blob):新增 4 列随既有敏感列一并 NULL 化;
  两裁剪 key 列随既有 idCardImageKey 一并按 key 删 blob(留存 SOP 文档侧台账,本 goal 不改 SOP 代码)。

---

## 7. 既有行为锁(实施期间任一破坏 = 停下报告)

1. `RealnameOcrResult.{recognized,name,idCardNumber,warnings}` 语义 + `collectForgeryWarnings` 收窄(仅 Copy/Reshoot/PS)。
2. `classifyOcrResult` / `routeOcrOutcome` 入参集与判定 100% 不变(recruitment-ocr-routing.spec 零回归)。
3. `riskLevel` 三栏 / `lastOcrOutcome` 快照 / `antiForgeryWarnings` 响应字段。
4. `birthDate`/`genderCode` 由身份证号推导的权威性(OCR Sex/Birth 不持久不覆盖)。
5. recognize `recognized/clarityOk/hint/documentCategory` 既有语义;FM-B 孤儿清理 deleteObject 行为(无裁剪图 fixture → 仍恰 1 次 main key)。
6. EXPECTED_ROUTES / 权限码 / BizCode 三者零变。

---

## 8. 测试计划(DoD 展开)

| DoD | 证伪测试 |
|---|---|
| D1 | recruitment e2e:DevStub 注入 extendedFields/documentType/cardWarnings → recognize 响应 `ocrDetail` 如实回显;断言响应**不含** base64 裁剪图 |
| D2 | e2e:提交含 extendedFields 的 mainland fixture → 断言 4 列落库;gender/birth 仍来自号码推导(与 OCR Sex/Birth 不同值时取号码) |
| D3 | e2e:提交含 cardImageBase64/portraitImageBase64 → 两 key 列非空 + 生成签名 URL 可取;不返裁剪图 fixture → 两列 null 且提交仍成功 |
| D4 | e2e:read.sensitive vs 仅 read.record → 详情 4 OCR 列(明文/ null)+ 三图 URL(可取/ null/30100)差异符合预期 |
| D5 | tencent-realname.provider.spec:线上嵌套结构 mock → 断言请求体含 7 Enable\* 开关 + 扩展字段映射 + Type + CardImage/PortraitImage 透传 |
| D6 | recruitment-ocr-routing.spec + recruitment e2e 既有断言零回归(仅允许新增字段附加断言) |
| D7 | EXPECTED_ROUTES 260→260 / 权限码 0 新 / BizCode 182→182(亲核前后对比);grep 证明无明文 PII 入日志 |
| D8 | openapi.json diff 含新字段;handoff 招新实名条目更新 |
| D9 | unit + contract + e2e + lint + typecheck 全绿(OrbStack 未起→CI 兜底) |

---

## 9. 任务队列(顺序硬约束)

1. **本稿冻结**(docs/archive/reviews/)✅
2. schema +6 列 + migration(干净库重放 + seed 二跑;srvf-prisma-change D 档降速)
3. realname types/provider/dev-stub + provider.spec/dev-stub.spec
4. recruitment dto/service/presenter/query-service + EXPECTED_SCHEMAS + @ApiExtraModels
5. e2e 新增断言 + 契约快照 -u
6. 全量 quality 门(unit/contract/e2e/lint/typecheck)
7. docs/handoff + openapi.json 追平 + CHANGELOG Unreleased + 分支保护 PR + 绿灯自合

---

## 10. 本期不做(终版报告必列)

- ❌ passport(MLIDPassportOCR)/ hk_macau(MainlandPermitOCR)迁统一接口或加鉴伪/裁剪(裁剪/字段级告警是鉴伪版独有)。
- ❌ 用 OCR Sex/Birth 覆盖 genderCode/birthDate(推导权威不动)。
- ❌ promotion/team-join/member 任何改动;「头像裁剪图设为队员头像」(下游留后续单独 goal)。
- ❌ 新增端点 / 权限码 / BizCode;留存 SOP 代码改动;真腾讯联调。
- ❌ release closeout(bump/tag/GH Release)= 另起 E 档 goal(本 goal 止于 feature 合并 + CI 绿 + docs 追平 + Unreleased 记账)。

---

## 11. 红区改动计划(AGENTS §0 受保护 / 高风险)

| 文件 | 改动 | 风险闸 |
|---|---|---|
| `prisma/schema.prisma` + migration | +6 additive nullable 列 | srvf-prisma-change D 档:干净库重放 + seed 二跑 |
| `docs/handoff/**`(受保护) | 招新实名能力图 + openapi.json 追平 | goal 授权内必需 docs 更新;surgical + PR body 标注(protected-docs-goal-authorization) |
| `CHANGELOG.md` | `## Unreleased` 记账行 | 标准记账 |
