# SRVF 通用证书标准库、队内认定规则与招新证书闭环落地开发文档 v1.2

## 文档信息

| 项目 | 内容 |
|---|---|
| 仓库 | `BA7IEE/srvf-nest-api` |
| 审查基线 | `main@217bba669e66ad2ab79066be89140b90b74fbac0` |
| 基线版本 | `v0.63.0` 之后的 Harness 加固提交，证书业务实现未改变 |
| 文档日期 | 2026-07-29 |
| 文档状态 | **已冻结**(2026-07-29 维护者拍板);合入后不回改,偏离须另出 superseding 评审稿 |
| 数据前提 | 系统尚未正式上线，生产无须保留的证书和招新证书历史数据 |
| 替代关系 | 本文完整替代 v1.0 和 v1.1，旧版不得继续作为实施依据 |
| 前端产品名称 | 证书标准库、证书认定规则、证书管理、招新证书审核 |
| 后端核心领域对象 | `CertificateStandard`、`CertificateRecognitionPolicy`、`RecruitmentCertificateClaim`、`Certificate` |
| 目标仓库范围 | 后端 API；同时给出前端契约、数据迁移、权限、审计和验收要求 |

> 一句话结论：通用证书标准库定义“它是什么证”，队内认定规则定义“本队怎么认可这类证”，招新证书申报记录“申请人拿来了什么”，正式 `Certificate` 记录“审核后确认了什么”。四类事实必须分开，不能再由一张模板表同时承担。

---

## 0.0 维护者拍板记录(2026-07-29,冻结时追加)

本节是**冻结时刻追加的唯一修改**,正文其余部分与投放稿逐字一致。

| # | 拍板 | 内容 |
|---|---|---|
| ① | 冻结 v1.2 | 本文为唯一评审稿,v1.0 / v1.1 **废止**,不得混用 |
| ② | PR-4 拆分 | 原「PR-4 原子终态切换」拆为 **PR-4a(切写路径)+ PR-4b(删旧事实)**,见 §21 |
| ③ | 与企业微信的排期 | **本 Goal 先做**;企业微信接入(`wecom-integration-t0-terminal-review.md`)在本 Goal 全部落地并部署后启动 |

**③ 的理由(一句话)**:本方案「直接删列、不做兼容、不双写」的可行性,建立在
`Certificate = 0 行` 与 `招新证书 JSON = 0 行` 之上;这个前提**只在 production 未部署期间成立**,
是一扇单向门。企业微信是 expand-only、开关默认全 false,任何时候做成本相同,
且其价值(工作台入口 + 通知)与依赖(Notification Outbox 生产部署)都在部署之后。

**基线漂移核验(2026-07-29)**:`217bba66..main` 触碰 `src/` `prisma/` 的改动**仅 1 个文件**
(`src/bootstrap/apply-swagger.ts`,离线 OpenAPI 生成)。`prisma/` 零改动;
`certificate` / `recruitment` / `permissions` / `audit` / `authz` / `attachments` / `storage` / contract **全部零改动**。
本文审查基线仍然有效,开工无须重出漂移报告 —— 但仍须按 §26 现场跑 `pnpm agent:preflight` 复核。

---

## 0. 给维护者看的大白话版本

现在的系统能录证书、审核证书、拒绝证书、提醒到期，但它还没有真正回答四个问题：

```text
这张证到底是什么？
本队按什么规则认可它？
申请人上传的原始材料是什么？
审核后最终确认的证书事实是什么？
```

上一版把前两个问题揉成了一个 `CertificateDefinition`：

```text
证书身份
+ 认可机构
+ 有效期规则
+ 编号要求
```

结果是，一旦认可机构或有效期规则变化，同一种证书就需要复制出 v2、v3，最后出现：

```text
bsafe_l2
bsafe_l2_v2
bsafe_l2_final
bsafe_l2_final_final
```

这不是版本管理，而是证书身份被炸碎。

本版改为：

```text
CertificateStandard
  = 证书本身的稳定身份
  例如 BSAFE 二级、红十字救护员证、AHA BLS Provider

CertificateRecognitionPolicy
  = 本队某一时期采用的认定规则版本
  例如认可机构 A/B、编号必填、有效期 24 个月

RecruitmentCertificateClaim
  = 招新申请人上传的一张原始证书申报
  可以暂时不知道准确标准，等待审核员分类

Certificate
  = 审核后进入正式队员档案的一张真实证书
```

因此：

```text
BSAFE 二级永远只有一个 Standard
队内认定规则可以有 Policy v1、v2、v3
旧证书记住自己按哪个 Policy 审核
查询“有没有 BSAFE 二级”永远按 Standard code 查询
```

对于申请人自己也说不清楚的证书，系统不再建立“其他外部证书”垃圾桶，而是允许申报保持“待分类”：

```text
上传图片
填写能看懂的名称和机构
找不到标准就选择“不确定”
审核员查看原件后映射已有标准
没有标准就先建立具体标准和认定规则
然后再审核
```

不知道是一种工作流状态，不是一种正式证书。

---

## 1. 本轮复审结论

### 1.1 保留的正确方向

以下原则继续锁定：

1. 系统未上线且无历史业务数据，所以终态字段可以直接 `NOT NULL`。
2. 不保留旧请求体、旧 JSON 证书结构、无标准证书和 category fallback。
3. 不把复杂模板字段塞进 `DictItem`。
4. 所有正式证书必须对应明确的通用证书标准。
5. 招新证书必须在审核阶段完成标准化，发号阶段只搬运结果。
6. 不新增第 3 个 cron。
7. 不预埋 `APP_SELF / IMPORT` 等尚未实施来源。
8. 不提前实现通用岗位资格引擎。
9. 不支持新旧前端、后端和数据库混跑。
10. 任何 schema、migration、Permission seed、AuditLogEvent 变更均按 D 档执行。

### 1.2 v1.1 被替换的关键原因

v1.1 存在以下结构性问题：

1. 招新上传没有证书编号和到期日期，却允许模板要求编号和期限。
2. 招新按 category 保存 JSON，无法表达同一类别多张不同证书。
3. 一个 Definition 同时承担证书身份和队内认定规则，规则变化会制造多个相同证书身份。
4. `Certificate` 计划同时保存 Standard 关系和 `certTypeCode / certSubTypeCode / isInternal`，形成多套真相。
5. ALLOWLIST 让客户端提交机构文字，中文机构名称匹配不可靠。
6. `MANUAL` 将“必须手填到期日”和“可不填即终身”混为一谈。
7. `other_external` 会成为无法治理的万能兜底。
8. 证书编号、审核备注和证书图片的敏感读取边界没有完整拆分。
9. 招新审核通过后到发号前，Policy 变化时的行为没有冻结。
10. 工作台统计没有给出可执行公式，可能与列表或 Cron 状态漂移。

---

## 2. 第一性原理：系统必须保存哪四类事实

## 2.1 通用证书标准

回答：

> 这是什么证？

示例：

```text
BSAFE 一级
BSAFE 二级
红十字救护员证
深圳市急救中心急救员证
AHA BLS Provider
业余无线电操作技术能力验证证书 A 类
```

它不回答：

```text
本队是否认可
认可哪些机构
证书编号是否必填
本队按几年有效处理
```

这些属于队内认定规则。

## 2.2 队内认定规则

回答：

> 本队在某个时期按什么规则认可这个标准？

示例：

```text
BSAFE 二级 Policy v1
认可机构：A、B
编号：必填
有效期：24 个月

BSAFE 二级 Policy v2
认可机构：A、B、C
编号：必填
有效期：24 个月
```

两个 Policy 都指向同一个：

```text
CertificateStandard.code = bsafe_l2
```

## 2.3 招新证书申报

回答：

> 申请人原始提交了什么材料，审核员如何处理？

申报允许暂时不知道精确标准，但必须保留：

```text
申请人填写的证书名称
类别提示
建议标准
发证机构
证书编号
发证日期
到期日期
证书图片
审核状态
最终解析出的 Standard 和 Policy
```

## 2.4 正式队员证书

回答：

> 审核后确认的真实证书事实是什么？

正式证书只保存：

```text
持有人
通用标准
审核所依据的 Policy 版本
实际发证机构
编号
发证日期
最后有效日
来源
审核结论
证据来源
```

---

## 3. 顶层不变量

以下为本 Goal 的强制不变量：

| 编号 | 不变量 |
|---|---|
| D-CERT-001 | `CertificateStandard` 定义证书身份，`CertificateRecognitionPolicy` 定义队内认定规则，二者不得合表。 |
| D-CERT-002 | 同一种证书只有一个稳定 Standard code；机构或有效期规则变化只新增 Policy 版本，不新增 Standard。 |
| D-CERT-003 | 只有 `kind=CREDENTIAL` 的 Standard 可被 Policy、Claim 和 Certificate 使用；`FAMILY` 仅用于目录分组。 |
| D-CERT-004 | Standard code 创建后不可修改、不可复用。 |
| D-CERT-005 | Standard 的类别、等级、父级、内部属性在首次启用后冻结；名称、说明、排序可以在审计下修正文案。 |
| D-CERT-006 | 每个 Standard 同时至多一个 ACTIVE RecognitionPolicy。 |
| D-CERT-007 | 已激活或已退役 Policy 的业务规则永久不可修改；规则变化创建下一版本。 |
| D-CERT-008 | 已存在的 pending Certificate 和 APPROVED Claim 使用已经锁定的 Policy，不因新 Policy 上线而移动目标。 |
| D-CERT-009 | 每张正式 `Certificate` 必须有 `standardId` 和 `recognitionPolicyId`。 |
| D-CERT-010 | `Certificate` 不再保存 `certTypeCode / certSubTypeCode / isInternal` 等重复事实。 |
| D-CERT-011 | 类别、等级、是否内部证书从 Standard 关系读取，数据库只有一个权威。 |
| D-CERT-012 | 招新每张实际证书对应一条 `RecruitmentCertificateClaim`，不再按 category 聚合到 JSON。 |
| D-CERT-013 | 同一报名允许多张同类别证书，门槛由“是否至少有一条 APPROVED Claim”派生。 |
| D-CERT-014 | Claim 可以在审核前没有 Standard；审核通过时必须解析为具体 CREDENTIAL Standard 和 Policy。 |
| D-CERT-015 | 没找到标准时保持待处理，不建立 `other_external` 万能证书。 |
| D-CERT-016 | 申请人建议的 Standard 不是权威，审核员可以更正。 |
| D-CERT-017 | 招新审核阶段完成全部机构、编号、日期和 Policy 校验；发号阶段不得重新猜测。 |
| D-CERT-018 | 招新发号只搬运 APPROVED Claim，利用 `sourceClaimId` 唯一约束防止重复建证。 |
| D-CERT-019 | `expiredAt` 表示最后有效日，按北京时间日历日比较。 |
| D-CERT-020 | 资质判断不依赖 Cron 是否及时翻态，必须同时检查状态和日期。 |
| D-CERT-021 | ALLOWLIST/FIXED 机构使用 issuer id，不依赖客户端提交机构文字匹配。 |
| D-CERT-022 | FREE_TEXT 才允许自由填写机构名称。 |
| D-CERT-023 | 列表、工作台和统计不返回完整证书编号、审核备注或证据 URL。 |
| D-CERT-024 | 证书图片、storage key、signed URL、完整编号和自由备注不得进入日志或不可变审计快照。 |
| D-CERT-025 | 证书标准与 Policy 是全局主数据；证书实例继续使用 scoped Authz。 |
| D-CERT-026 | 新 schema、新接口、新前端和迁移在同一切换边界发布，不支持旧契约。 |
| D-CERT-027 | 数据探针发现任何旧证书或旧招新证书 JSON 时立即停止，不猜、不回填。 |
| D-CERT-028 | 通用标准库不是全国权威数据库，只是本系统的统一证书身份目录。 |
| D-CERT-029 | 业务负责人明确批准的宽口径标准可以存在，但必须有清晰名称和范围，不得使用“其他任何证书”。 |
| D-CERT-030 | 本 Goal 不实现通用岗位资格引擎，先提供分类级和 Standard 级资质判断。 |

---

## 4. 目标领域关系

```text
cert_type 字典
  └── CertificateStandard
        ├── FAMILY
        │     └── CREDENTIAL
        └── CertificateRecognitionPolicy v1/v2/v3
               └── CertificateRecognitionIssuer

RecruitmentApplication
  └── RecruitmentCertificateClaim
        ├── 可暂时未解析 Standard
        ├── 审核时锁定 Standard + Policy
        └── 发号后生成 Certificate

Member
  └── Certificate
        ├── standardId
        ├── recognitionPolicyId
        ├── recognitionIssuerId 或自由机构快照
        └── sourceClaimId 可空
```

---

## 5. 目标数据模型

> 以下是评审目标结构。正式修改 Prisma 前必须再次核对当前 main，并按 D 档冻结 migration 草案。

## 5.1 枚举

```prisma
enum CertificateStandardKind {
  FAMILY
  CREDENTIAL
}

enum CertificateStandardStatus {
  DRAFT
  ACTIVE
  INACTIVE
}

enum CertificateRecognitionPolicyStatus {
  DRAFT
  ACTIVE
  RETIRED
}

enum CertificateIssuerPolicy {
  FIXED
  ALLOWLIST
  FREE_TEXT
}

enum CertificateValidityMode {
  PERMANENT
  FIXED_MONTHS
  EXPLICIT_REQUIRED
  EXPLICIT_OPTIONAL
}

enum CertificateNumberMode {
  REQUIRED
  OPTIONAL
  NONE
}

enum CertificateSource {
  ADMIN
  RECRUITMENT
}

enum RecruitmentCertificateClaimStatus {
  SUBMITTED
  NEEDS_INFO
  APPROVED
  REJECTED
  PROMOTED
  WITHDRAWN
}
```

说明：

- `EXPLICIT_REQUIRED`：证书上存在具体到期日，必须人工填写。
- `EXPLICIT_OPTIONAL`：具体到期日可空，空值明确代表终身有效。
- 不再用一个模糊的 `MANUAL` 同时表达两种含义。
- `CertificateSource` 第一版只有真实存在的 `ADMIN / RECRUITMENT`。

## 5.2 `CertificateStandard`

```prisma
model CertificateStandard {
  id           String                    @id @default(cuid())
  code         String                    @unique
  name         String
  description  String?
  kind         CertificateStandardKind
  categoryCode String
  levelCode    String?
  parentId     String?
  isInternal   Boolean                   @default(false)
  status       CertificateStandardStatus @default(DRAFT)
  sortOrder    Int                       @default(0)
  activatedAt  DateTime?
  createdAt    DateTime                  @default(now())
  updatedAt    DateTime                  @updatedAt
  deletedAt    DateTime?

  parent       CertificateStandard?  @relation("CertificateStandardTree", fields: [parentId], references: [id], onDelete: Restrict)
  children     CertificateStandard[] @relation("CertificateStandardTree")
  policies        CertificateRecognitionPolicy[]
  certificates    Certificate[]
  suggestedClaims RecruitmentCertificateClaim[] @relation("ClaimSuggestedStandard")
  resolvedClaims  RecruitmentCertificateClaim[] @relation("ClaimResolvedStandard")

  @@index([kind])
  @@index([categoryCode])
  @@index([levelCode])
  @@index([parentId])
  @@index([status])
  @@index([sortOrder])
  @@index([deletedAt])
  @@index([createdAt])
}
```

约束：

- `code`：小写字母、数字、下划线、中横线，1 至 64 字符。
- `name`：1 至 128 字符。
- `description`：最多 500 字符。
- `categoryCode`：必须是 ACTIVE `cert_type`。
- `levelCode`：可空；非空时必须是 ACTIVE `cert_sub_type`。
- `FAMILY` 不允许配置 Policy，也不能绑定 Certificate。
- `CREDENTIAL` 才能被认定和持有。
- 父节点必须是 FAMILY。
- 子节点与父节点的 `categoryCode` 必须一致。
- 禁止形成父子循环。
- DRAFT 可编辑完整身份字段。
- ACTIVE/INACTIVE 只允许修正 `name / description / sortOrder / status`。
- 语义发生变化时新建 Standard；仅错别字和展示文案可原地修正。

## 5.3 `CertificateRecognitionPolicy`

```prisma
model CertificateRecognitionPolicy {
  id                 String                             @id @default(cuid())
  standardId         String
  version            Int
  status             CertificateRecognitionPolicyStatus @default(DRAFT)
  issuerPolicy       CertificateIssuerPolicy
  validityMode       CertificateValidityMode
  validityMonths     Int?
  certNumberMode     CertificateNumberMode
  activatedAt        DateTime?
  retiredAt          DateTime?
  createdAt          DateTime                           @default(now())
  updatedAt          DateTime                           @updatedAt
  deletedAt          DateTime?

  standard     CertificateStandard @relation(fields: [standardId], references: [id], onDelete: Restrict)
  issuers      CertificateRecognitionIssuer[]
  certificates Certificate[]
  claims       RecruitmentCertificateClaim[]

  @@unique([standardId, version])
  @@unique([id, standardId])
  @@index([standardId])
  @@index([status])
  @@index([deletedAt])
  @@index([createdAt])
}
```

数据库 migration 手写 partial unique：

```sql
CREATE UNIQUE INDEX certificate_recognition_policy_one_active_per_standard
ON "CertificateRecognitionPolicy" ("standardId")
WHERE "status" = 'ACTIVE' AND "deletedAt" IS NULL;
```

字段组合：

| validityMode | validityMonths | 实例到期日 |
|---|---:|---|
| `PERMANENT` | NULL | 必须 NULL |
| `FIXED_MONTHS` | 1 至 600 | 后端计算，客户端不得传 |
| `EXPLICIT_REQUIRED` | NULL | 必填 |
| `EXPLICIT_OPTIONAL` | NULL | 可空，空即终身 |

证书编号规则：

```text
REQUIRED：trim 后必须非空
OPTIONAL：空字符串归一为 NULL
NONE：必须为 NULL；客户端传值直接拒绝
```

Policy 生命周期：

```text
DRAFT → ACTIVE → RETIRED
```

不允许：

```text
ACTIVE/RETIRED → DRAFT
RETIRED → ACTIVE
```

新建 DRAFT Policy 时，必须在 Standard 行锁内读取 `MAX(version)` 并写入下一版本；并发撞 `(standardId, version)` 时显式转换 P2002。

新 Policy 激活时：

1. 锁 Standard。
2. 校验 Standard 为 ACTIVE CREDENTIAL。
3. 校验 Policy 和 issuer 最终态。
4. 锁并 RETIRE 当前 ACTIVE Policy。
5. 激活新 Policy。
6. 全部在同一事务提交。
7. 并发激活由 partial unique 和显式 P2002 映射兜底。

## 5.4 `CertificateRecognitionIssuer`

```prisma
model CertificateRecognitionIssuer {
  id             String   @id @default(cuid())
  policyId       String
  name           String
  normalizedName String
  sortOrder      Int      @default(0)
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt
  deletedAt      DateTime?

  policy       CertificateRecognitionPolicy @relation(fields: [policyId], references: [id], onDelete: Restrict)
  claims       RecruitmentCertificateClaim[]
  certificates Certificate[]

  @@unique([id, policyId])
  @@index([policyId])
  @@index([sortOrder])
  @@index([deletedAt])
}
```

migration 手写 partial unique：

```sql
CREATE UNIQUE INDEX certificate_recognition_issuer_active_name_unique
ON "CertificateRecognitionIssuer" ("policyId", "normalizedName")
WHERE "deletedAt" IS NULL;
```

机构策略：

| issuerPolicy | issuer 数量 | 实例提交 |
|---|---:|---|
| `FIXED` | 必须恰好 1 | 可不传，后端选唯一 issuer |
| `ALLOWLIST` | 至少 1 | 必须传 `recognitionIssuerId` |
| `FREE_TEXT` | 必须 0 | 必须传 `issuingOrg` 自由文本 |

第一版不让 FREE_TEXT 同时维护建议机构，避免 `issuerId` 与自由文本双义。后续如确有需要，再增加独立“机构建议词”能力。

机构归一化只用于 DRAFT 内去重：

```text
trim
连续空白折叠
ASCII 大小写归一
不删除中文法律名称
不做模糊匹配
```

实例认可不靠文字匹配，而靠 issuer id。

## 5.5 `RecruitmentCertificateClaim`

```prisma
model RecruitmentCertificateClaim {
  id                    String                            @id @default(cuid())
  applicationId         String
  version               Int                               @default(0)
  status                RecruitmentCertificateClaimStatus @default(SUBMITTED)

  categoryHintCode      String
  rawCertificateName    String?
  suggestedStandardId   String?

  standardId            String?
  recognitionPolicyId   String?
  recognitionIssuerId   String?

  issuingOrg            String?
  certNumber            String?
  issuedAt              DateTime?
  expiredAt             DateTime?
  imageKeys             Json?

  reviewedByUserId      String?
  reviewedAt            DateTime?
  reviewNote            String?
  promotedAt            DateTime?
  sensitivePurgedAt     DateTime?

  createdAt             DateTime                          @default(now())
  updatedAt             DateTime                          @updatedAt
  deletedAt             DateTime?

  application       RecruitmentApplication @relation(fields: [applicationId], references: [id], onDelete: Restrict)
  suggestedStandard CertificateStandard?    @relation("ClaimSuggestedStandard", fields: [suggestedStandardId], references: [id], onDelete: Restrict)
  standard          CertificateStandard?    @relation("ClaimResolvedStandard", fields: [standardId], references: [id], onDelete: Restrict)
  policy            CertificateRecognitionPolicy? @relation(fields: [recognitionPolicyId], references: [id], onDelete: Restrict)
  issuer            CertificateRecognitionIssuer? @relation(fields: [recognitionIssuerId], references: [id], onDelete: Restrict)
  certificate       Certificate?

  @@index([applicationId])
  @@index([status])
  @@index([standardId])
  @@index([recognitionPolicyId])
  @@index([deletedAt])
  @@index([createdAt])
}
```

说明：

- 一张真实证书一条 Claim。
- 同一申请可有多条相同 `categoryHintCode`。
- `suggestedStandardId` 是申请人建议，不是审核结论。
- `standardId / policyId / issuerId` 在 APPROVED 时锁定。
- `version` 用于申请人重传与管理员审核的 CAS，避免双方同时覆盖。
- `imageKeys` 只在数据库内部使用，永不进入普通响应、日志、审计或 OpenAPI 示例。
- APPROVED 必须满足完整标准化字段 CHECK。
- PROMOTED 必须保留 Standard/Policy/审核链和 promotedAt，但允许在成功搬运后清空重复标量。
- `Certificate.sourceClaimId` 唯一，确保一条 Claim 最多生成一张证书。
- `RecruitmentApplication` 必须增加反向关系 `certificateClaims RecruitmentCertificateClaim[]`。
- Standard、Policy、Issuer 也必须补齐上文命名关系的反向数组，Prisma schema 每个 PR 都必须可 generate，不能只写单边 relation。

migration CHECK 示例：

```text
status = APPROVED 时：
  standardId IS NOT NULL
  recognitionPolicyId IS NOT NULL
  issuingOrg IS NOT NULL
  issuedAt IS NOT NULL

status = PROMOTED 时：
  standardId IS NOT NULL
  recognitionPolicyId IS NOT NULL
  promotedAt IS NOT NULL

expiredAt IS NULL OR issuedAt IS NULL OR expiredAt >= issuedAt
version >= 0
```

跨表一致性由事务内 Resolver 校验：

```text
Policy.standardId = Claim.standardId
Issuer.policyId = Claim.recognitionPolicyId
```

## 5.6 终态 `Certificate`

当前系统无历史数据，本 Goal 直接删除重复事实字段：

```text
certTypeCode
certSubTypeCode
isInternal
imageKeys
```

目标模型核心部分：

```prisma
model Certificate {
  id                     String            @id @default(cuid())
  memberId               String
  standardId             String
  recognitionPolicyId    String
  recognitionIssuerId    String?
  sourceClaimId          String?           @unique
  sourceCode             CertificateSource

  issuingOrg             String
  certNumber             String?
  issuedAt               DateTime
  expiredAt              DateTime?
  certStatusCode         String
  verifiedBy             String?
  verifiedAt             DateTime?
  verifyNote             String?
  supersededByCertId     String?
  expireNotifyDueAt      DateTime?

  createdAt              DateTime          @default(now())
  updatedAt              DateTime          @updatedAt
  deletedAt              DateTime?

  member       Member @relation("CertificateMember", fields: [memberId], references: [id], onDelete: Restrict)
  standard     CertificateStandard @relation(fields: [standardId], references: [id], onDelete: Restrict)
  policy       CertificateRecognitionPolicy @relation(fields: [recognitionPolicyId, standardId], references: [id, standardId], onDelete: Restrict)
  issuer       CertificateRecognitionIssuer? @relation(fields: [recognitionIssuerId], references: [id], onDelete: Restrict)
  sourceClaim  RecruitmentCertificateClaim? @relation(fields: [sourceClaimId], references: [id], onDelete: Restrict)

  verifier     Member?       @relation("CertificateVerifier", fields: [verifiedBy], references: [id], onDelete: Restrict)
  supersededBy Certificate?  @relation("CertificateSupersession", fields: [supersededByCertId], references: [id], onDelete: Restrict)
  supersedes   Certificate[] @relation("CertificateSupersession")

  @@index([memberId])
  @@index([standardId])
  @@index([recognitionPolicyId])
  @@index([certStatusCode])
  @@index([expiredAt])
  @@index([sourceCode])
  @@index([deletedAt])
  @@index([createdAt])
  @@index([supersededByCertId])
}
```

必须保证：

- Policy 与 Standard 的组合由复合 FK 锁定。
- migration 应对 `(recognitionIssuerId, recognitionPolicyId)` 增加指向 Issuer `(id, policyId)` 的复合 FK；`recognitionIssuerId=NULL` 时按 PostgreSQL MATCH SIMPLE 放行。Claim 使用同样约束。
- Service 仍需在写前校验 issuer 未软删并属于锁定 Policy，数据库约束负责最终兜底。
- migration 应增加来源 CHECK：`sourceCode=RECRUITMENT` 时 `sourceClaimId IS NOT NULL`；`sourceCode=ADMIN` 时 `sourceClaimId IS NULL`。
- `issuingOrg` 是审核时的机构名称快照。
- Standard 名称不落实例快照。名称只能做非语义修正，历史变更由审计保存。
- 查询分类、等级、内部属性时 join Standard。
- 任何测试 fixture 或直接 Prisma 写都必须提供 Standard 和 Policy。

---

## 6. 数据权威表

| 数据 | 唯一权威 | 禁止副本 |
|---|---|---|
| 证书标准 code、类别、等级、内部属性 | `CertificateStandard` | `Certificate.certTypeCode/certSubTypeCode/isInternal` |
| 当前新提交认定规则 | ACTIVE `CertificateRecognitionPolicy` | Service 常量、招新独立规则 |
| 某张证审核时采用的规则 | `Certificate.recognitionPolicyId` | 根据当前 ACTIVE Policy 反推 |
| 认可机构集合 | Policy 下 issuer 行 | 字符串数组、DictItem JSON |
| 某张证真实发证机构 | `Certificate.issuingOrg` 快照 | 仅 issuer 当前名称 |
| 招新原始申报 | `RecruitmentCertificateClaim` | `RecruitmentApplication` 三个证书 JSON |
| 正式持证事实 | `Certificate` | Claim 继续作为正式查询主表 |
| 证据图片 | Claim `imageKeys` 或 Certificate 标准附件 | 普通 DTO、审计快照、日志 |

---

## 7. Standard 与 Policy 生命周期

## 7.1 Standard

允许：

```text
DRAFT → ACTIVE
ACTIVE → INACTIVE
INACTIVE → ACTIVE
```

DRAFT：

- 可编辑 identity 字段。
- 可软删。
- 不可用于 Policy 激活、Claim 审核或 Certificate 创建。

ACTIVE：

- CREDENTIAL 可建立和激活 Policy。
- FAMILY 仅展示和分组。
- 只允许修正名称、说明、排序。
- 不允许修改 code、kind、category、level、parent、isInternal。

INACTIVE：

- 不出现在新建证书选项中。
- 不阻止查看历史 Certificate。
- 已锁定 Policy 的 pending Certificate 和 APPROVED Claim 仍可完成流程。
- 恢复 ACTIVE 前重新校验字典和父级。

## 7.2 Policy

DRAFT：

- 可编辑完整规则和 issuer 集合。
- 可软删。
- 不可用于审核或建证。

ACTIVE：

- 新建 Certificate 和 Claim 审核可锁定。
- 所有规则只读。

RETIRED：

- 不接受新提交。
- 已锁定该 Policy 的 pending Certificate、APPROVED Claim 和历史 Certificate 继续有效。
- 不可恢复为 ACTIVE。

## 7.3 规则变化

例如 BSAFE 二级增加认可机构 C：

```text
Standard:
  bsafe_l2 保持不变

Policy v1:
  A、B
  ACTIVE → RETIRED

Policy v2:
  A、B、C
  DRAFT → ACTIVE
```

查询 BSAFE 二级仍然只使用：

```text
standardCode = bsafe_l2
```

---

## 8. 招新证书申报终态流程

## 8.1 申请人提交

申请人提交一张 Claim：

```text
categoryHintCode：必填
rawCertificateName：可选
suggestedStandardId：可选
issuingOrg：可选或必填，按前端表单要求
certNumber：可选
issuedAt：可选
expiredAt：可选
images：1 至 3 张
身份凭证：现有微信或手机验证链
```

关键规则：

- 每个报名最多保留 10 条未软删 Claim，防止公开上传被当作无限存储入口。
- 每条 Claim 允许 1 至 3 张 JPEG/PNG，单文件大小、MIME、魔数和内容检查复用现有 `AttachmentContentValidator`。
- storage key 只能使用随机 id 和固定 namespace，不得包含姓名、手机、证件号或原文件名。
- 公开端点复用现有 recruitment throttler 和双通道身份链，付费外部调用之前先完成免费校验。
- 申请人可以选择“不确定”，即 `suggestedStandardId=null`。
- 申请人不能提交 Policy、审核状态或标准化 issuer id。
- 同一报名可提交多张急救证书或多张 BSAFE 证书。
- 每张 Claim 单独重传、审核和显示状态。
- 不能再按 category 重传整组并覆盖其他证书。

## 8.2 Claim 状态机

```text
SUBMITTED → NEEDS_INFO
SUBMITTED → APPROVED
SUBMITTED → REJECTED

NEEDS_INFO → SUBMITTED
REJECTED → SUBMITTED

APPROVED → PROMOTED
SUBMITTED/NEEDS_INFO/APPROVED/REJECTED → WITHDRAWN
```

禁止：

```text
PROMOTED → 任何状态
APPROVED 由申请人直接修改
```

管理员在发号前发现 APPROVED 结论错误时，可走独立“撤回审核”动作：

```text
APPROVED → SUBMITTED
```

撤回必须：

- 仅具证书审核权限者可操作。
- 报名尚未 promoted。
- 清空 resolved Standard、Policy、issuer 和审核字段。
- 重新计算对应招新门槛。
- 写高价值审计。

## 8.3 审核

审核请求建议：

```json
{
  "decision": "APPROVE",
  "version": 3,
  "standardId": "standard-cuid",
  "recognitionIssuerId": "issuer-cuid",
  "issuingOrg": null,
  "certNumber": "SZ-2026-0001",
  "issuedAt": "2026-07-01",
  "expiredAt": null,
  "note": "原件清晰"
}
```

`APPROVE`：

固定锁序：

```text
RecruitmentApplication → Claim → Standard → Active Policy → Issuer
```

所有 Claim review、revoke 和 application withdrawal 必须沿同一前缀锁序，避免与发号和 Policy 切换形成死锁。

1. Claim 加行锁。
2. CAS 校验 version。
3. Standard 必须为 ACTIVE CREDENTIAL。
4. 读取该 Standard 当前 ACTIVE Policy。
5. FIXED 自动选择唯一 issuer。
6. ALLOWLIST 要求有效 issuer id。
7. FREE_TEXT 要求 `issuingOrg`。
8. 按 certNumberMode 校验编号。
9. 按 validityMode 校验或计算到期日。
10. 校验 issuedAt 不晚于今天。
11. 校验 expiredAt 最后有效日语义。
12. 写 APPROVED、Standard、Policy、issuer、规范化事实和审核字段。
13. 根据全部 APPROVED Claim 重新计算证书类门槛。
14. 写审计。
15. 返回脱敏结果。

`NEEDS_INFO`：

- note 必填。
- 保留图片和原始事实。
- 不锁定 Standard/Policy。
- 申请人可修正并重新提交。

`REJECT`：

- note 必填。
- 清除任何门槛贡献。
- 图片进入清理流程。
- 不允许保留伪造的 APPROVED 标记。

## 8.4 门槛派生

现有映射继续作为招新业务规则：

```text
first_aid → redCross
bsafe     → bsafe
```

但门槛状态不再由某一次 review 直接写 true/false。

`redCross / bsafe` 两个证书型门槛从本 Goal 起是 Claim 的派生投影：

- 单条和批量 `markThreshold` 不再允许直接写这两个 code。
- 传 `completed=true` 或 `completed=false` 均返回明确业务错误。
- 只有 Claim approve、revoke、reject、withdraw、promote 事务可以重算它们。
- `patrol1 / patrol2 / training` 等非证书门槛继续沿现有人工标记。

正确算法：

```text
某证书门槛完成
= 当前报名下至少存在一条
  status=APPROVED 或 PROMOTED
  且 Standard.categoryCode 对应该门槛
  且未软删的 Claim
```

因此：

- 两张急救证中拒绝一张，不会错误清除另一张已通过证书带来的门槛。
- 撤回审核时重新聚合。
- 批量标门槛接口不得绕过 Claim 审核结论。

Claim 变化与报名状态必须在同一事务重算：

```text
证书门槛由完成变为未完成：
  pending_evaluation → verified
  publicity          → verified
  verified           → verified

证书门槛由未完成变为全部完成：
  verified           → pending_evaluation
  publicity 且仍全部完成 → publicity
```

从 `publicity` 回退时必须同步清空 `evaluatedByUserId / evaluatedAt / evaluationNote`，从公示名单移除，并写审计。不能保留“已评定通过”字段却把状态退回。

整份 RecruitmentApplication 被申请人撤销时：

- 所有未 PROMOTED Claim 在同一事务转为 WITHDRAWN。
- 清除 Claim 对门槛的贡献。
- 进入证据清理流程。
- 已 PROMOTED 应用本就不可撤销。

## 8.5 发号

发号事务中：

固定锁序：

```text
RecruitmentApplication
→ Claim（按 id ASC）
→ Member/账号建档所需资源（沿现有发号锁序）
```

发号不再锁 Standard/Policy 做新判断，只校验 Claim 已经 APPROVED 且关系完整。

1. 锁 RecruitmentApplication。
2. 按稳定 id 顺序锁全部 APPROVED Claim。
3. 所有 APPROVED Claim 必须已有完整 Standard/Policy/规范化事实。
4. 为每条未 PROMOTED Claim 创建 Certificate。
5. `sourceCode=RECRUITMENT`。
6. `sourceClaimId=claim.id`。
7. 继承审核人、审核时间和审核备注。
8. 根据到期日决定初始状态：
   - 最后有效日早于今天：`expired`
   - 否则：`verified`
9. Claim 改为 PROMOTED，并写 promotedAt。
10. `sourceClaimId @unique` 防止重跑重复创建。
11. 成功创建 Certificate 后，Claim 必须清空重复的 `rawCertificateName / certNumber / issuingOrg / issuedAt / expiredAt`，写 `sensitivePurgedAt`；Standard、Policy、审核链和图片证据继续保留。
12. 整个 Member 建档与 Claim 转 Certificate 保持现有单事务原子性。

发号不得：

- 根据 category 猜 Standard。
- 根据当前 ACTIVE Policy 重审。
- 为缺失 Standard/Policy 的 Claim 创建 pending Certificate。
- 重复执行审核。
- 悄悄跳过坏 Claim 后继续发号。

---

## 9. 管理端直接录入证书

## 9.1 创建

请求：

```json
{
  "standardId": "standard-cuid",
  "recognitionIssuerId": "issuer-cuid",
  "issuingOrg": null,
  "certNumber": "CERT-001",
  "issuedAt": "2026-07-01",
  "expiredAt": null
}
```

步骤：

1. scoped Authz 校验 `certificate.create.record`。
2. 加载 ACTIVE CREDENTIAL Standard。
3. 加载该 Standard 当前 ACTIVE Policy。
4. 解析机构。
5. 校验编号。
6. 处理日期。
7. 写 `standardId / policyId / issuerId / issuingOrg / source=ADMIN`。
8. 写 `pending`。
9. 写掩码审计。

## 9.2 修改

允许修改：

```text
pending：
  standardId
  recognitionIssuerId / issuingOrg
  certNumber
  issuedAt
  expiredAt

verified / expired / rejected：
  recognitionIssuerId / issuingOrg
  certNumber
  issuedAt
  expiredAt
```

规则：

- pending 允许纠正选错 Standard。
- 修改 Standard 时重新选择当前 ACTIVE Policy，并完整重校验。
- 非 pending 不允许修改 Standard。
- verified/expired/rejected 修改核心事实后重回 pending。
- 事实修正继续沿原 policyId 校验，避免规则在录入后移动。
- 如原 Policy 已 RETIRED，仍允许按该版本修正和复核。
- `expiredAt` 最终值变化时清空 `expireNotifyDueAt`。
- 不通过“软删后重建”处理普通录入纠错。

## 9.3 审核

审核使用 Certificate 已锁定的 Policy，而不是当前 ACTIVE Policy。

通过结果：

```text
expiredAt < today  → expired
其他               → verified
```

拒绝：

```text
pending → rejected
verifyNote 必填
```

并发 verify/reject/update 继续使用现有行锁和 CAS，只有一个动作成功。

---

## 10. 日期语义

## 10.1 唯一语义

```text
issuedAt  = 发证日
expiredAt = 最后有效日
today     = 北京时间日历日
```

示例：

```text
expiredAt = 2026-08-01
表示 2026-08-01 当天仍有效
2026-08-02 起失效
```

## 10.2 API 格式

所有证书日期只接受：

```text
YYYY-MM-DD
```

不再接受带时区和时分秒的任意 ISO datetime。

入库继续使用现有北京时间 date-only 归一工具。

## 10.3 基础校验

```text
issuedAt <= today
expiredAt IS NULL OR expiredAt >= issuedAt
```

## 10.4 FIXED_MONTHS

- 从 issuedAt 按自然月计算。
- 月底夹取。
- 不用 `30 天 × 月数`。
- 结果即最后有效日。

示例：

```text
2024-02-29 + 12 月 = 2025-02-28
2026-01-31 + 1 月 = 2026-02-28
```

## 10.5 资质和 Cron

有效资质：

```text
status = verified
AND deletedAt IS NULL
AND (expiredAt IS NULL OR expiredAt >= today)
```

自动过期：

```text
status = verified
AND expiredAt < today
```

提前 60 天：

```text
status = verified
AND expiredAt BETWEEN today AND today+60
AND expireNotifyDueAt IS NULL
```

任何查询都不能只信持久状态，不检查日期。

---

## 11. 不确定证书和通用标准库

## 11.1 不确定不等于其他证书

申请人找不到标准时：

```text
suggestedStandardId = null
status = SUBMITTED
```

后台显示：

```text
待分类
```

审核员可以：

1. 映射已有 Standard。
2. 请求补充材料。
3. 转交标准管理员建立具体 Standard 和 Policy。
4. 拒绝。

## 11.2 Standard 可以先收录、暂不认可

一种证书可以：

```text
Standard = ACTIVE
但没有 ACTIVE Policy
```

它可以：

- 被检索。
- 被申请人建议选择。
- 进入待认定队列。

它不能：

- 审核为 APPROVED。
- 创建正式 Certificate。
- 参与资质判断。

## 11.3 宽口径标准

业务负责人明确批准时，可以建立：

```text
name = 认可急救资质
code = recognized_first_aid_general
kind = CREDENTIAL
description = 明确列出适用范围
```

但禁止建立：

```text
其他外部证书
其他任何证书
未知证书
万能证书
```

宽口径 Standard 必须有明确业务边界，不是省事入口。

---

## 12. 资质判断

现有嵌套路径保留：

```http
GET /api/admin/v1/members/:memberId/certificates/qualification-flag
```

查询契约改为稳定 code：

```text
criterionType = category | standard
criterionCode = cert_type code | CertificateStandard.code
```

示例：

```http
?criterionType=category&criterionCode=first_aid
?criterionType=standard&criterionCode=bsafe_l2
```

不使用跨环境不稳定的 cuid 作为业务规则参数。

当存在多张符合条件的 Certificate 时，匹配结果按以下稳定顺序选择：

```text
永久有效优先
expiredAt 较晚优先
issuedAt 较晚优先
id 字典序
```

响应：

```json
{
  "memberId": "member-cuid",
  "criterionType": "standard",
  "criterionCode": "bsafe_l2",
  "qualified": true,
  "matchedCertificateId": "certificate-cuid",
  "expiredAt": "2028-07-01"
}
```

规则：

- 分类级按 Standard.categoryCode 匹配。
- Standard 级按 Standard.code 匹配。
- 历史 Certificate 不要求 Standard 当前 ACTIVE。
- 历史 Certificate 不要求 Policy 当前 ACTIVE。
- Policy 更新不自动推翻已有 verified Certificate。
- 本期不回答岗位资格。

---

## 13. API 设计

## 13.1 Standard 管理

```text
GET    /api/admin/v1/certificate-standards
POST   /api/admin/v1/certificate-standards
GET    /api/admin/v1/certificate-standards/options
GET    /api/admin/v1/certificate-standards/:id
PATCH  /api/admin/v1/certificate-standards/:id
PATCH  /api/admin/v1/certificate-standards/:id/status
DELETE /api/admin/v1/certificate-standards/:id
```

`options`：

- 供管理端建证和审核。
- 可传 `recognizedOnly=true`。
- 只返回 CREDENTIAL。
- `recognizedOnly=true` 时要求 Standard ACTIVE 且有 ACTIVE Policy。
- 返回当前 Policy 摘要和 issuer 选项。
- 必须声明在 `:id` 之前。

## 13.2 Policy 管理

```text
GET    /api/admin/v1/certificate-standards/:standardId/recognition-policies
POST   /api/admin/v1/certificate-standards/:standardId/recognition-policies
GET    /api/admin/v1/certificate-recognition-policies/:id
PATCH  /api/admin/v1/certificate-recognition-policies/:id
PATCH  /api/admin/v1/certificate-recognition-policies/:id/status
DELETE /api/admin/v1/certificate-recognition-policies/:id
```

- issuer 集合随 DRAFT Policy 整体提交和替换。
- 不单独开放 ACTIVE Policy issuer 修改端点。
- 激活 DTO 只允许 `ACTIVE`。
- 当前 ACTIVE Policy 由激活动作自动 RETIRE，不让客户端分两步操作。

## 13.3 招新公开申报

建议替换旧 category 聚合上传路径：

```text
POST   /api/open/v1/recruitment/certificate-claims
POST   /api/open/v1/recruitment/certificate-claims/:id/resubmit
POST   /api/open/v1/recruitment/certificate-claims/:id/withdraw
GET    /api/open/v1/recruitment/certificate-standards
```

公开 Standard 选项只返回 ACTIVE CREDENTIAL，并按 `RECRUITMENT_CERT_CATEGORIES` 过滤。响应可带：

```text
id
code
name
categoryCode
levelCode
currentlyRecognized
```

`currentlyRecognized=false` 代表标准已收录但暂无 ACTIVE Policy，申请人可以把它作为建议，后台不得据此直接通过。

- multipart 文件位 `images`。
- 每次操作必须携带现有微信或手机身份凭证。
- 身份凭证必须解析到同一 RecruitmentApplication。
- claimId 不能单独构成授权。

## 13.4 招新管理端

```text
GET  /api/admin/v1/recruitment/applications/:applicationId/certificate-claims
GET  /api/admin/v1/recruitment/certificate-claims/:id
POST /api/admin/v1/recruitment/certificate-claims/:id/review
POST /api/admin/v1/recruitment/certificate-claims/:id/revoke-review
GET  /api/admin/v1/recruitment/certificate-claims/:id/image-urls
```

删除旧的：

```text
POST /api/admin/v1/recruitment/applications/:id/certificates/:category/review
GET  /api/admin/v1/recruitment/applications/:id/certificate-image-urls
```

原因：

- category 不是证书实例 id。
- 无法支持同类别多张证书。
- 无法做单证书重传和审核。

## 13.5 Certificate 实例接口

现有 8 个路径继续保留，但契约收紧：

```text
GET    /api/admin/v1/members/:memberId/certificates
POST   /api/admin/v1/members/:memberId/certificates
GET    /api/admin/v1/members/:memberId/certificates/qualification-flag
GET    /api/admin/v1/members/:memberId/certificates/:id
PATCH  /api/admin/v1/members/:memberId/certificates/:id
DELETE /api/admin/v1/members/:memberId/certificates/:id
PATCH  /api/admin/v1/members/:memberId/certificates/:id/verify
PATCH  /api/admin/v1/members/:memberId/certificates/:id/reject
```

新增证据读取：

```text
GET /api/admin/v1/members/:memberId/certificates/:id/evidence-urls
```

Evidence 来源：

```text
source=RECRUITMENT：
  读取 sourceClaim.imageKeys

source=ADMIN：
  读取 ownerType=certificate 的标准 Attachment
```

响应只返回短时 URL，不返回 key。

实现约束：

- ADMIN 来源必须通过 `AttachmentsService` 的可读性和 pinned storage ledger 路径获取，不允许业务模块直接拼 URL。
- RECRUITMENT 来源沿 Claim 内部 key 签发时，必须先锁定 Certificate → sourceClaim 关系并完成 certificate sensitive Authz。
- Provider 或 ledger 状态不确定时 fail-closed 返回不可读，不得回退到裸 key 或当前 bucket 猜测。
- Claim 图片读取也必须复用同一封装，不能在 recruitment 和 certificates 各写一套签名逻辑。

## 13.6 全局工作台

```text
GET /api/admin/v1/certificates
GET /api/admin/v1/certificates/stats
```

列表过滤：

```text
page
pageSize
q
memberId
organizationId
includeDescendants
standardCode
categoryCode
levelCode
certStatusCode
sourceCode
issuedFrom
issuedTo
expiresFrom
expiresTo
```

`q` 只搜索：

```text
队员编号
队员展示名
Standard 名称/code
机构名称
```

第一版不搜索完整证书编号，避免敏感查询与索引泄漏。

---

## 14. 工作台统计的精确定义

所有统计：

- `deletedAt IS NULL`
- 使用与列表完全相同的可见组织范围。
- 接受同一组非分页过滤。
- 日期按北京时间 today。
- 不依赖 Cron 已经完成翻态。

```text
pending:
  certStatusCode = pending

verified:
  certStatusCode = verified
  AND (expiredAt IS NULL OR expiredAt >= today)

expired:
  certStatusCode = expired
  OR (
    certStatusCode = verified
    AND expiredAt < today
  )

rejected:
  certStatusCode = rejected

expiringWithin60Days:
  certStatusCode = verified
  AND expiredAt BETWEEN today AND today+60

permanent:
  certStatusCode = verified
  AND expiredAt IS NULL
```

工作台和 App/Admin 列表同时返回：

```text
certStatusCode       持久状态
effectiveStatusCode  当前有效展示状态
```

当 `certStatusCode=verified` 且 `expiredAt<today` 时：

```text
effectiveStatusCode=expired
```

不得发明第五个持久状态，也不得继续显示为有效。

---

## 15. 敏感数据和泄露防护

这一节是本版新增的强制安全边界。

## 15.1 数据分级

| 数据 | 分级 | 说明 |
|---|---|---|
| Standard 名称、code、分类、等级 | L0/L1 | 非敏感主数据 |
| Policy 规则和认可机构名称 | L1 | 队内主数据，默认不公开完整管理细节 |
| 发证机构、发证日、到期日 | L1 | 普通档案信息 |
| 完整证书编号 | L2 | 可用于外部查询或冒用 |
| 审核人身份、自由审核备注 | L2 | 跨成员信息和自由文本 |
| 证书图片 | L3 | 可能含姓名、编号、照片、二维码和防伪信息 |
| image key、signed URL | L3 | 存储凭据相邻数据 |

## 15.2 Admin 列表和工作台

永不返回：

```text
完整 certNumber
verifyNote
verifiedBy
imageKeys
signed URL
sourceClaimId
```

允许返回：

```text
certNumberMasked
Standard 摘要
机构
日期
状态
来源
memberId/certificateId
```

## 15.3 Admin 详情敏感分级

新增权限：

```text
certificate.read.sensitive
```

普通 `certificate.read.record`：

```text
certNumberFull = null
certNumberMasked = 有值
verifyNote = null
verifiedBy = null
evidenceAvailable = true/false
```

同时持有 scoped `certificate.read.sensitive`：

```text
可看完整编号
可看审核备注和审核人 id
可申请证据 signed URL
```

App 本人仍可查看自己的完整编号和本人可见审核备注，不暴露审核人身份。

## 15.4 Recruitment Claim

申请人本人：

- 通过现有身份链读取自己的 Claim。
- 可以看自己提交的完整编号和图片缩略信息。
- 不返回审核人 id。
- 驳回/补充说明可以返回。

Admin 招新列表：

- 只显示 masked number、imageCount、状态和建议 Standard。
- 完整编号和图片 URL要求 `recruitment-application.read.sensitive`。
- Claim detail 的授权不能只靠 claimId。

## 15.5 Signed URL

所有证据 URL：

- TTL 默认不超过 300 秒。
- 响应头 `Cache-Control: no-store`。
- URL 不写 audit。
- URL 不写 application log。
- URL 不写 contract snapshot 示例。
- URL 不写通知。
- 前端不得存入 localStorage、sessionStorage 或埋点。
- URL 生成前重新检查当前权限和资源归属。
- 已软删 Certificate、已撤销 Claim 或跨组织请求不得签 URL。

## 15.6 日志和审计

严禁写入：

```text
完整 certNumber
imageKeys
signed URL
上传 token
手机验证码
请求 body 原文
自由审核备注全文
图片文件名中的潜在 PII
```

Audit snapshot：

- certNumber 只写掩码。
- reviewNote 只写 `provided/changed` 布尔。
- issuer 可写 canonical 名称。
- Standard/Policy id 和版本可写。
- 过滤器只记录字段名，不记录姓名和号码值。

## 15.7 防枚举

- 无权或不存在的 Certificate detail 沿当前安全口径统一。
- 公共 Claim 操作中，“不存在”和“不属于当前身份”使用同一安全响应。
- Standard/Policy 管理端不存在与无权不能暴露额外差异。
- 工作台 total 和 stats 必须先下推 scope，再计数。

## 15.8 通知

到期通知只包含：

```text
Standard 名称
到期日期
通用续期提示
```

不包含：

```text
证书编号
审核备注
图片
发证机构敏感扩展信息
```

## 15.9 留存与清理

SUBMITTED / NEEDS_INFO：

- 在招新流程活跃期间保留材料。

REJECTED / WITHDRAWN：

- 沿现有招新留存 SOP 删除图片 blob。
- 清空 certNumber 和其他不再需要的申报事实。
- 删除失败写封闭字段日志，保留可重试标记。
- 不新增第 3 个 cron。

APPROVED：

- 保留到发号。

PROMOTED：

- 规范化标量已经搬入 Certificate。
- Claim 可清空重复的 certNumber、机构和日期，降低重复敏感数据。
- 图片作为 Certificate 的来源证据保留，并只能通过 Certificate sensitive endpoint 访问。
- Claim 不能被普通招新列表再次暴露完整事实。

Certificate 软删：

- 不立即物理删除审计证据。
- 证据随队员档案/离队留存政策处理。
- 自动物理清理不在本 Goal 内，必须在上线前登记为明确运营 SOP，而不是永久无人负责。

---

## 16. 权限模型

## 16.1 Standard

```text
certificate-standard.read.record
certificate-standard.create.record
certificate-standard.update.record
certificate-standard.delete.record
```

## 16.2 Policy

```text
certificate-recognition-policy.read.record
certificate-recognition-policy.create.record
certificate-recognition-policy.update.record
certificate-recognition-policy.delete.record
```

## 16.3 Certificate 新增敏感读

```text
certificate.read.sensitive
```

## 16.4 默认绑定建议

| 角色 | Standard read | Standard write | Policy read | Policy write | Certificate sensitive |
|---|---:|---:|---:|---:|---:|
| SUPER_ADMIN | 短路 | 短路 | 短路 | 短路 | 短路 |
| ops-admin | 是 | 是 | 是 | 是 | 是 |
| biz-admin | 是 | 否 | 是 | 否 | 是 |
| 自定义标准管理员 | 可配置 | 可配置 | 可配置 | 可配置 | 默认否 |
| scoped 证书审核员 | options 所需只读 | 否 | active 摘要只读 | 否 | 按 scope 配置 |
| 招新审核员 | recognized options | 否 | active 摘要只读 | 否 | 招新阶段走 recruitment sensitive |
| group-manager | 默认否 | 否 | 默认否 | 否 | 默认否 |

说明：

- Standard/Policy 管理是 GLOBAL 配置面，走 `RbacService.can()`。
- Certificate 实例继续走 `AuthzService` resource scope。
- `certificate.read.sensitive` 也必须走 Certificate ref，不是全局裸开。
- options endpoint 可以接受 Standard read，或由持 certificate create/verify、recruitment certificate review 的角色获得专门只读绑定。
- 不新增 Prisma `Role` enum。

---

## 17. 审计设计

建议新增高价值事件：

```text
certificate-standard.change
certificate-recognition-policy.change
recruitment-certificate-claim.review
recruitment-certificate-claim.review-revoke
```

通过 `extra.operation` 区分：

```text
create
update
activate
deactivate
delete
create-policy
activate-policy
retire-policy
replace-draft-issuers
approve
reject
needs-info
revoke-approval
```

Standard/Policy snapshot 可以包含：

```text
code
name
kind
categoryCode
levelCode
parentId
isInternal
status
policyVersion
issuerPolicy
issuerNames
validityMode
validityMonths
certNumberMode
```

Claim 审计只包含：

```text
claimId
applicationId
decision
standardId
policyId
issuerId 是否提供
imageCount
certNumberProvided
expiredAtProvided
```

不包含：

```text
完整证书编号
图片 key
signed URL
审核备注全文
申请人姓名、手机、证件号
```

现有 Certificate 审计增加：

```text
standardId
standardCode
recognitionPolicyId
policyVersion
sourceCode
recognitionIssuerId
```

---

## 18. BizCode 规划

证书域继续使用 `180xx / 181xx`。具体数字在 PR-0 冻结前必须 grep 全文件确认无碰撞。

建议：

| 常量 | 建议 code | HTTP | message |
|---|---:|---:|---|
| `CERTIFICATE_STANDARD_NOT_FOUND` | 18002 | 404 | 证书标准不存在 |
| `CERTIFICATE_STANDARD_CODE_EXISTS` | 18003 | 409 | 证书标准编码已存在 |
| `CERTIFICATE_POLICY_NOT_FOUND` | 18004 | 404 | 证书认定规则不存在 |
| `CERTIFICATE_STANDARD_KIND_INVALID` | 18012 | 400 | 该目录节点不是可持有证书标准 |
| `CERTIFICATE_ISSUER_CONFIG_INVALID` | 18013 | 400 | 发证机构配置不符合认定规则 |
| `CERTIFICATE_ISSUER_NOT_ALLOWED` | 18014 | 400 | 发证机构不在认可范围内 |
| `CERTIFICATE_VALIDITY_INVALID` | 18015 | 400 | 证书有效期不符合认定规则 |
| `CERTIFICATE_NUMBER_REQUIRED` | 18016 | 400 | 该证书必须填写证书编号 |
| `CERTIFICATE_DATE_RANGE_INVALID` | 18017 | 400 | 到期日期不能早于发证日期 |
| `CERTIFICATE_ISSUED_AT_IN_FUTURE` | 18018 | 400 | 发证日期不能晚于今天 |
| `CERTIFICATE_STANDARD_INACTIVE` | 18031 | 409 | 证书标准未启用 |
| `CERTIFICATE_STANDARD_IN_USE` | 18032 | 409 | 证书标准已被引用，不能删除 |
| `CERTIFICATE_STANDARD_IMMUTABLE` | 18033 | 409 | 证书标准启用后身份字段不可修改 |
| `CERTIFICATE_STANDARD_STATE_INVALID` | 18034 | 409 | 证书标准状态不允许此操作 |
| `CERTIFICATE_ACTIVE_POLICY_MISSING` | 18035 | 409 | 该证书标准尚无生效认定规则 |
| `CERTIFICATE_POLICY_IMMUTABLE` | 18036 | 409 | 生效或退役认定规则不可修改 |
| `CERTIFICATE_POLICY_STATE_INVALID` | 18037 | 409 | 认定规则状态不允许此操作 |
| `CERTIFICATE_VERSION_CONFLICT` | 18038 | 409 | 证书记录已更新，请刷新后重试 |

缺少 DTO 必填字段继续返回：

```text
40000 BAD_REQUEST
```

不为缺 `standardId` 故意把字段设成 optional。

招新 Claim 建议使用空闲 `28056+` 号位：

```text
RECRUITMENT_CERTIFICATE_CLAIM_NOT_FOUND
RECRUITMENT_CERTIFICATE_CLAIM_STATE_INVALID
RECRUITMENT_CERTIFICATE_CLAIM_VERSION_CONFLICT
RECRUITMENT_CERTIFICATE_STANDARD_REQUIRED
RECRUITMENT_CERTIFICATE_POLICY_UNAVAILABLE
RECRUITMENT_CERTIFICATE_CLAIM_LIMIT
```

最终号码必须在实施前以当前 BizCode 真源为准，不得照抄文档盲写。

---

## 19. 代码结构和边界

仍归属现有 `certificates` 模块：

```text
src/modules/certificates/
├── certificate-standards.controller.ts
├── certificate-standards.service.ts
├── certificate-recognition-policies.controller.ts
├── certificate-recognition-policies.service.ts
├── certificate-standard-policy.ts
├── certificate-recognition-resolver.ts
├── certificate-standard-audit-recorder.ts
├── certificate-evidence-query.service.ts
├── admin-certificates-query.service.ts
├── certificates.controller.ts
├── certificates.service.ts
├── certificates.dto.ts
└── dto/
    ├── admin/
    └── app/
```

Recruitment 新增：

```text
src/modules/recruitment/
├── recruitment-certificate-claims.public.controller.ts
├── recruitment-certificate-claims.admin.controller.ts
├── recruitment-certificate-claims.service.ts
├── recruitment-certificate-claim-state-machine.ts
├── recruitment-certificate-claim-presenter.ts
└── dto/
```

边界：

- Standard Service 持有 Standard 写事务。
- Policy Service 持有 Policy 激活事务。
- Resolver 不拥有外层事务，必须接受 `Prisma.TransactionClient`。
- Resolver 不写 audit。
- Claim Service 持有申报、重传和审核事务。
- Promotion Service 仍持有发号总事务。
- QueryService 只读，不写状态。
- Presenter 不访问 Prisma。
- Evidence Query 只负责授权后的证据读取和签 URL。
- Recruitment 允许导入 CertificatesModule 导出的窄 Resolver。
- CertificatesModule 不反向导入 Recruitment。
- 不建 repository 包装层。
- 不复制第二套日期、机构或 Policy 算法。

Resolver 建议拆成显式方法：

```text
resolveActivePolicyForNewCertificate(...)
resolveActivePolicyForClaimApproval(...)
validateLockedPolicyForCertificateUpdate(...)
materializeApprovedClaimForPromotion(...)
```

禁止只提供语义模糊的 `resolve()`。

---

## 20. 空库迁移和终态切换

## 20.1 前置探针

至少确认：

```sql
SELECT COUNT(*) FROM "Certificate";

SELECT COUNT(*)
FROM "recruitment_applications"
WHERE "certificateImages" IS NOT NULL
   OR "certificateReviewStatus" IS NOT NULL
   OR "certificateIssuanceInfo" IS NOT NULL;

SELECT COUNT(*)
FROM "attachments"
WHERE "ownerType" = 'certificate';
```

同时检查：

```text
是否存在 certificate 前缀孤立 storage object
是否有旧前端仍调用 category 证书接口
是否有正在进行的招新联调数据
```

任一非 0：

```text
停止
输出计数和样本 id
回到维护者拍板
不执行 drop column
不猜 Standard
不批量回填
```

## 20.2 终态 migration

可以直接：

- 新增 Standard、Policy、Issuer、Claim 表和枚举。
- 给 Certificate 增加 required Standard/Policy/source 字段。
- 删除 Certificate 重复字段。
- 删除 RecruitmentApplication 三个证书 JSON 字段。
- 删除 Certificate.imageKeys。
- 新增复合 FK、unique、partial unique、CHECK 和索引。
- 新增 Permission 和 RolePermission。
- 新增 AuditLogEvent。

不允许：

- nullable 过渡字段进入 release。
- 旧 JSON 与 Claim 双写。
- category fallback。
- sourceCode 默认猜测。
- 旧 API 继续写入。

## 20.3 发布顺序

```text
1. 停止证书和招新证书写入联调
2. 备份数据库
3. 跑空库探针
4. 应用终态 migration 和 permission seed
5. 部署新后端
6. 创建 Standard 和 RecognitionPolicy
7. 部署匹配的新前端
8. 跑 Standard、Policy、Claim、Certificate、发号 smoke
9. 验证敏感读、跨组织、signed URL 和审计
10. 才开放业务
```

---

## 21. PR 拆分

## PR-0：冻结本文和 Goal

档位：A

- 将 v1.2 设为唯一评审稿。
- 写 DoD、探针、授权清单、写集和禁止域。
- 确认前端旧调用面。
- 冻结敏感数据查看和留存口径。
- 维护者拍板后进入 D 档。

## PR-1：现有证书日期与敏感读正确性

档位：C/D，涉及 Permission 时为 D

- 严格 `YYYY-MM-DD`。
- issuedAt 不晚于今天。
- expiredAt 最后有效日语义。
- qualification 和 Cron 边界统一。
- expiredAt 变化重置提醒标记。
- 增加 `certificate.read.sensitive`。
- 现有列表和详情脱敏。
- 不引入 Standard。

## PR-2：Standard / Policy / Claim schema、权限与审计骨架

档位：D

- 新表、枚举、FK、CHECK、partial unique。
- Permission、RolePermission、AuditLogEvent。
- 新模型暂无业务写入口。
- redzone 授权。
- schema、migration、seed、counts、RBAC_MAP 更新。

## PR-3：Standard 与 Policy 管理 API

档位：C/D

- Standard CRUD/status/options。
- Policy CRUD/activate/retire。
- issuer DRAFT 集合。
- 并发激活。
- 审计。
- contract 和 E2E。
- 尚不改现有 Certificate 和 Recruitment 写路径。

## PR-4：Claim 与 Certificate 终态切换(2026-07-29 拍板拆为 4a + 4b)

> **拆分理由**:原设计是单个原子 PR,同时完成新写路径、招新改写、发号改写、
> 删 4 个 Certificate 列、删 3 个 RecruitmentApplication JSON 列、删旧 category API
> 与全部 fixture/e2e 重写 —— 这会是全仓最大的单 PR,而**跨模型独立评审对超大 diff 的效果最差**,
> 而跨模型评审是本仓唯一的兜底(维护者不审代码)。拆成两刀后每刀都在可评审量级内。
>
> **拆分不放松任何不变量**,四条约束逐条钉死:
>
> 1. **同一 release 内**:4a 与 4b 之间**不发版**。原文「不产生中间 release」原意完整保持。
> 2. **不双写**:4a 起旧字段**只读不写**,不存在新旧两条写路径。
> 3. **不留兼容 API**:旧 category 端点在 4a 就删除,不存在兼容窗口。
> 4. **nullable 过渡列不进 release**:它只存在于 4a 与 4b 之间的**未发布**窗口,
>    符合 §20.2「nullable 过渡字段不得进入 release」的禁令。
>
> 若 4a 合入后因任何原因无法在同一 release 内完成 4b,**必须回滚 4a,不得发版**。

### PR-4a：写路径切到 Standard/Policy/Claim

档位：D

- **空库 preflight**(§20.1 三条探针;任一非 0 立即停,不猜、不回填、不继续)。
- 新 Claim public/admin API。
- 招新详情改为读 Claim。
- 管理端证书切 Standard/Policy。
- pending 可纠正 Standard。
- 发号只搬 APPROVED Claim。
- `Certificate.standardId / recognitionPolicyId / sourceCode` 开始写入(此刻列仍 nullable)。
- 旧 `Certificate.certTypeCode / certSubTypeCode / isInternal / imageKeys` 与
  `RecruitmentApplication` 三个证书 JSON 字段 **停止写入**,列暂时保留。
- 旧 category 证书接口(review / certificate-image-urls)**本刀删除**。
- 门槛 `redCross / bsafe` 转为派生投影,`markThreshold` 拒绝这两个 code。
- 更新受影响 fixture、contract、e2e。

### PR-4b：旧事实物理删除与约束收紧

档位：D，与 4a 同 release

- 重跑 §20.1 空库探针,**并追加「旧列全空」探针**(4a 之后应恒为 0;非 0 即说明 4a 有残留写入路径 → 停)。
- `Certificate.standardId / recognitionPolicyId / sourceCode` 收紧为 `NOT NULL`。
- 落地复合 FK(`policy(id, standardId)`、`issuer(id, policyId)`)、来源 CHECK、partial unique。
- `DROP` `Certificate.certTypeCode / certSubTypeCode / isInternal / imageKeys`。
- `DROP` `RecruitmentApplication` 三个证书 JSON 列。
- contract snapshot、fixture、e2e 收尾;确认无任何代码路径引用已删列。

## PR-5：证据读取和全局工作台

档位：C

- Certificate evidence URL。
- Claim evidence URL。
- 工作台 list/stats。
- scope 下推。
- 脱敏。
- no-store。
- K+1 门禁。

## PR-6：前端联调和初始化

前后端仓库分别判档

- Standard/Policy 管理。
- Claim 多证书申报。
- “不确定”流程。
- 审核分类和 Policy 选择。
- Certificate 表单。
- 敏感字段显示权限。
- 不将敏感数据存浏览器持久层。
- 首批 Standard/Policy 初始化包。

## PR-7：release 收口

档位：E

- 全量验证。
- 空库和初始化门禁。
- release prepare/finish。
- handoff 明确无旧契约兼容。
- 跨模型独立 review。

---

## 22. 测试矩阵

## 22.1 Standard

- code 冲突预检和 P2002。
- FAMILY 不可被认定或持有。
- parent 必须 FAMILY。
- 父子 category 一致。
- 防循环。
- DRAFT 可完整编辑。
- ACTIVE identity 字段冻结。
- 名称/说明/排序可审计修正。
- code 软删后不复用。
- `cert_type / cert_sub_type` 被 ACTIVE Standard 引用时不可停用。
- 任意未软删 Standard 或历史 Certificate 引用时不可删除对应字典项。
- 字典恢复启用后，Standard 不自动恢复，仍需显式状态操作。

## 22.2 Policy

- Standard 无 ACTIVE Policy 时不能建证或审核。
- FIXED 恰好 1 issuer。
- ALLOWLIST 至少 1 issuer。
- FREE_TEXT 0 issuer。
- 四种 validityMode 字段组合。
- 三种 certNumberMode。
- 每 Standard 至多 1 ACTIVE。
- 并发激活只有一个成功。
- 激活新版本原子 RETIRE 旧版本。
- ACTIVE/RETIRED 不可修改。
- pending Certificate 使用旧 Policy 仍可审核。

## 22.3 Claim

- 同一 application 多条同 category。
- 每 application 最多 10 条 Claim。
- 每 Claim 1 至 3 张合法图片，超量、伪 MIME、魔数不符均拒绝且零 storage 写。
- storage key 不含 PII 或原文件名。
- suggestedStandard 可空。
- 不确定 Claim 可提交。
- Claim id 不能越权读取。
- version 冲突。
- NEEDS_INFO 重传。
- APPROVE 完整 Resolver。
- 未知 Standard 不能 approve。
- 无 Active Policy 不能 approve。
- issuer id 不属于 Policy 拒绝。
- 编号和日期规则。
- 多条同 category 的门槛聚合。
- 拒绝一条不清除另一条已通过门槛。
- redCross/bsafe 不能再经 markThreshold 直接写 true 或 false。
- revoke approval 重算门槛。
- publicity 因门槛失效回退 verified，并清空评定字段。
- 整份报名撤销时批量 WITHDRAW Claim。
- REJECT/WITHDRAW evidence 清理。
- PROMOTED 不可再改。

## 22.4 Promotion

- 每条 APPROVED Claim 生成一张 Certificate。
- sourceClaimId 唯一。
- 重跑不重复。
- 继承 Standard/Policy/issuer/事实/审核。
- 已过期 Claim 建成 expired。
- 缺任何标准化字段整批 fail-closed。
- 不存在 category fallback。
- Claim PROMOTED 与 Certificate 创建同事务。
- 批量和单人发号共用内核。

## 22.5 Certificate

- 创建只接受 Standard 和实例事实。
- raw category/level/isInternal/source 被 DTO 拒绝。
- Standard 无 Policy 拒绝。
- pending 可纠正 Standard。
- 非 pending 不可改 Standard。
- Policy retired 后 pending 仍可审核。
- issuer id 路径和 FREE_TEXT 路径。
- certNumberMode。
- 四种有效期模式。
- issuedAt future。
- 最后有效日边界。
- certNumberMode REQUIRED/OPTIONAL/NONE。
- verify expired 直接写 expired。
- certStatusCode 与 effectiveStatusCode 在 Cron 延迟窗口内保持可解释。
- 并发 verify/reject/update。
- qualification 按 category code 和 standard code。
- Standard/Policy 后续停用不推翻历史有效证书。

## 22.6 泄露和权限

- 工作台不返完整编号。
- 普通详情不返完整编号、备注和审核人。
- sensitive 权限按 scope 生效。
- 跨组织 sensitive 读取拒绝。
- App self 不返审核人。
- imageKeys 不出现在任何响应和 OpenAPI 示例。
- signed URL 不进入 audit/logger。
- URL 响应 `Cache-Control: no-store`。
- public Claim 无权与不存在响应一致。
- stats 在 scope 后计数。
- 日志不含 certNumber。
- audit snapshot 只含掩码。
- 通知不含编号。

## 22.7 工作台

- GLOBAL 全局。
- scoped PRIMARY 组织范围。
- organization 过滤只收窄。
- list 和 stats 同 where 基础。
- Cron 未翻态时统计仍正确。
- 日期边界。
- 无 K+1。
- q 不搜索完整编号。

## 22.8 Migration

- 空库成功。
- 任一旧 Certificate 行阻断。
- 任一旧 recruitment certificate JSON 阻断。
- 旧 attachment/存储孤儿报告。
- Certificate required FK。
- 旧列已删除。
- 旧接口契约失败而不静默写半标准数据。
- 不编写兼容测试。

## 22.9 必跑命令

```bash
pnpm agent:preflight
pnpm agent:check:full
pnpm docs:codemap:check
pnpm docs:rbacmap:check
pnpm docs:counts:check
pnpm docs:openapi:check
pnpm harness:selftest
```

受影响 E2E 先定向，再全量。

禁止：

```text
盲 -u snapshot
删除测试
放宽现有断言
绕过 redzone
自动 migrate reset/db push
```

---

## 23. 前端落地

建议菜单：

```text
证书管理
├── 证书总览
├── 待审核
├── 即将到期
├── 已过期
├── 通用证书标准库
└── 队内认定规则
```

Standard 页面：

- FAMILY/CREDENTIAL 树。
- code、名称、类别、等级、内部证书、状态。
- CREDENTIAL 下展示当前 Policy 版本和是否可用于审核。
- 没有 ACTIVE Policy 显示“已收录，待认定”。

Policy 页面：

- 版本历史。
- 当前 ACTIVE。
- issuer 策略。
- 有效期规则。
- 编号规则。
- 新建版本从当前复制。
- 激活时明确提示旧版本退役。

招新申报：

- 每张证书独立卡片。
- 可新增多张同类别。
- 可选择建议 Standard。
- 有“不确定/没找到”。
- 不能自动选第一项。
- 每张卡片独立重传和状态。

招新审核：

- 看原图。
- 选择具体 Standard。
- 系统显示当前 ACTIVE Policy。
- FIXED/ALLOWLIST 用 issuer 选择器。
- FREE_TEXT 用机构文本。
- 补齐编号和日期。
- APPROVE 前展示最终规范化结果。
- 没有 Policy 时阻断并引导标准管理员。

Certificate 工作台：

- 编号只显示掩码。
- 敏感权限用户点击详情后才取完整字段。
- 证据 URL 按需申请，不预加载。
- 页面关闭后丢弃 URL。
- 不写 localStorage/sessionStorage。
- 埋点禁止采集表单值和 URL。

---

## 24. 完成标准 DoD

- [ ] v1.0/v1.1 明确废止。
- [ ] Standard 与 Policy 分表。
- [ ] FAMILY/CREDENTIAL 边界落地。
- [ ] 同 Standard 至多 1 ACTIVE Policy。
- [ ] Policy 版本更新不创建新 Standard。
- [ ] 不存在 `other_external` 万能标准。
- [ ] Claim 可在未知 Standard 下提交。
- [ ] Claim 一证一行，支持同类别多证。
- [ ] Claim 数量、文件数量、MIME、魔数和 key PII 边界有机器测试。
- [ ] Claim 变化会正确重算门槛和 RecruitmentApplication 状态。
- [ ] redCross/bsafe 已成为只读派生门槛，人工 mark 接口无法绕过。
- [ ] 审核阶段完成全部标准化。
- [ ] 发号只搬运 APPROVED Claim。
- [ ] 门槛按全部 APPROVED Claim 聚合。
- [ ] Certificate 不再保存 category/level/isInternal 重复事实。
- [ ] Certificate standardId/policyId/sourceCode required。
- [ ] Standard/Policy 与 Issuer/Policy 组合有数据库复合约束。
- [ ] ADMIN/RECRUITMENT 来源与 sourceClaimId 有数据库 CHECK。
- [ ] ALLOWLIST/FIXED 通过 issuer id。
- [ ] 四种有效期模式。
- [ ] expiredAt 最后有效日语义全仓一致。
- [ ] issuedAt 不晚于今天。
- [ ] qualification 使用稳定 code。
- [ ] Policy 更新不追溯推翻历史证书。
- [ ] 全局工作台 list/stats 同 scope。
- [ ] 新增 certificate.read.sensitive。
- [ ] 列表和普通详情脱敏。
- [ ] imageKeys/signed URL/完整编号不进日志和审计。
- [ ] evidence URL no-store、短 TTL、实时复权。
- [ ] Claim 留存和证据清理有 SOP。
- [ ] 旧 JSON、旧 category API 和 fallback 删除。
- [ ] 空库探针全为 0。
- [ ] migration、Permission、AuditLogEvent 有红区授权。
- [ ] OpenAPI、RBAC_MAP、CODEMAP、counts 新鲜。
- [ ] agent:check:full 全绿。
- [ ] 跨模型独立 review 完成。
- [ ] 前端仓库旧调用全部清理。
- [ ] 收尾输出“本次未做”。

---

## 25. 本期明确不做

1. 通用岗位资格规则引擎。
2. 证书自动真伪核验。
3. 全国官方发证机构数据库。
4. OCR 自动做最终审核。
5. CSV 批量导入和 `IMPORT` 来源。
6. App 正式队员自助新增和续证。
7. `supersededByCertId` 续证完整闭环。
8. Policy 变化后批量追溯复核历史证书。
9. 证书证据自动物理清理 cron。
10. 多租户或不同队伍各自 Policy。
11. 第 3 个 cron。
12. 新的证书状态。
13. 浏览器离线缓存证书图片。
14. 万能“其他证书”。
15. 用 AI 自动选择 Standard 并直接通过。

---

## 26. 交给总控 Agent 的执行口令

```text
请以《SRVF 通用证书标准库、队内认定规则与招新证书闭环落地开发文档 v1.2》
为唯一业务范围。v1.0 和 v1.1 已废止，不得混用。

文档审查基线为 main@217bba669e66ad2ab79066be89140b90b74fbac0。
开工先执行 pnpm agent:preflight，并核对当前 main。
若 main 已变化，先输出漂移报告，确认变化是否触碰 certificate/recruitment/
permissions/audit/authz/attachments/storage/schema/contract，再决定是否继续。

关键前提：
- 系统未正式上线；
- Certificate 业务数据为 0；
- RecruitmentApplication 旧证书 JSON 数据为 0；
- certificate attachment 和 storage 不存在待保留业务数据；
- 不存在需要兼容的旧客户端。

任一探针非 0，立即停止。
不得猜 Standard、不得自动回填、不得继续 drop column。

本任务属于 C/D 混合 Goal。
任何 schema、migration、seed、Permission、AuditLogEvent、敏感读取语义变更，
均先完成人话简报、评审稿冻结和维护者红区授权。

实施核心不变量：
1. Standard 定义证书身份。
2. RecognitionPolicy 定义队内规则版本。
3. Claim 一张证书一行，可暂时未分类。
4. Certificate 必须绑定 Standard 和 Policy。
5. 发号只搬运 APPROVED Claim。
6. Certificate 不保存 category/level/isInternal 重复事实。
7. ALLOWLIST/FIXED 使用 issuer id。
8. 不存在 other_external。
9. 完整编号、备注、图片和 URL 不泄露。
10. Claim 变化必须重算门槛与报名状态。
11. Prisma 关系必须双向完整、每个 PR 均可 generate。
12. 不支持旧 API 或 category fallback。

每个 PR：
- 只做文档指定范围；
- 先补 characterization/失败测试；
- 实现；
- 跑定向 e2e；
- 跑该档位全量检查；
- 逐行解释 snapshot；
- 输出证据、风险和“本次未做”；
- 由另一个模型独立 review 后进入下一 PR。

禁止：
- definition/standard 可空进入正式 Certificate；
- 新旧 JSON 双写；
- 以 category 猜 Standard；
- Policy 更新时复制 Standard；
- 使用“其他外部证书”兜底；
- 客户端提交 certTypeCode/certSubTypeCode/isInternal/sourceCode；
- 机构文字模糊匹配代替 issuer id；
- 返回 imageKeys；
- 把 signed URL、完整编号或自由备注写进 audit/logger；
- 跨组织统计先 count 后过滤；
- 盲更新 snapshot；
- 自动运行 migrate dev/reset/db push；
- 新增 cron、Redis、queue、LLM 或 OCR 自动通过。
```

---

## 27. 最终判断

本次改造不是增加一个“证书模板下拉框”。

真正的终态是：

```text
一个证书标准只有一个稳定身份
一套队内规则可以有多个历史版本
一张招新证书有一条独立申报记录
一次审核形成完整规范化事实
一次发号只搬运已经确认的结果
一张正式证书只保存一份真相
```

完成后，系统可以稳定回答：

```text
申请人上传的是什么材料？
审核员最终认定它是哪一种证书？
当时依据的是哪一版队内认定规则？
这个队员现在是否持有有效的某类或某种证书？
全队有哪些证书待审核、即将到期或已经失效？
谁能看到完整编号、审核备注和证据图片？
```

至于“这张证允许他担任什么岗位”，继续由后续独立的资格规则 Goal 承接。

先让证书身份、认定规则、申报材料和正式档案各自站稳，再让资格系统在上面运行。
