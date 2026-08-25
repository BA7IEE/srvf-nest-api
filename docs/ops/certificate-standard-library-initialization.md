# 证书标准库首批初始化指引(PR-6)

> 冻结稿:[`certificate-standard-library-t0-review.md`](../archive/reviews/certificate-standard-library-t0-review.md) v1.2 §20.3 步骤 6 / §11。
> 前置:PR-4b 的 contract migration 已 deploy(见 [`certificate-standard-library-go-live.md`](./certificate-standard-library-go-live.md))。

## 为什么必须先做这一步

PR-4b 起 `Certificate.standardId` / `recognitionPolicyId` / `sourceCode` 是 **NOT NULL**,且建证要求该标准**当前有一条 ACTIVE 认定规则**。

所以在库里没有 Standard + ACTIVE Policy 之前:

- 管理端建证 `POST /admin/v1/members/:memberId/certificates` → `18002`(标准不存在)
- 招新证书申报**可以提交**(申报不需要标准),但审核通过 → `28062`(该标准尚无生效认定规则)
- 发号会把整批 fail-closed(§8.5 不为缺失 Standard/Policy 的 Claim 建 pending 证书)

## 哪些标准可以内置,哪些必须人工建(2026-08-25 维护者拍板)

> **国家法规定义的证书可以内置;队里自己认定的一律走人工创建。**
>
> 判据只有一句 —— **「这个证书的内容,队里有得选吗?」** 有 ⇒ 人工建;没有 ⇒ 可内置。

这条规矩防的是「**系统替维护者决定我们队认哪些证书**」。§20.3 把「创建 Standard 和 RecognitionPolicy」列为部署流程的第 6 步、人工动作,正是因为「队里认哪些证书、认哪些发证机构、有效期几年、编号必填不必填」**是判断题** —— 拍错的默认值会被当成事实用下去。

而**由国家法规定死内容的证书不是判断题**:分类、前置条件、频段功率全国一套,队里没得选,内置它不构成替谁拍板。目前唯一一批:

| 已内置(`prisma/seed.ts`) | 依据 |
|---|---|
| `amateur_radio_operator` + `_a` / `_b` / `_c`(业余无线电台操作技术能力验证证书) | 工业和信息化部令第 67 号《业余无线电台管理办法》(2024-03-01 施行) |

**其余一切标准仍按本文档人工创建。**

⚠️ **已内置的不要在这里重复建** —— `code` 是 unique,重复 `POST` 直接 `409`。建之前先 `GET /api/admin/v1/certificate-standards?q=amateur_radio` 看一眼(`q` 同时匹配 `name` 与 `code`)。

> 🔴 **但列表查不到 ≠ 这个 code 能用**:列表带软删过滤,而 `code` 的 unique **含软删行** —— 一个被软删掉的标准不会出现在 `GET` 里,却照样让同名 `POST` 吃 `409`。查不到又建不上,就是撞上这一格了(见上一节:软删是刻意的,不是 bug)。

ℹ️ **内置不是单向门**:`CertificateStandard` 是**软删**,而 `code` 的 unique **含软删行** —— 你删掉之后再跑 seed,upsert 走 update 分支、`update: {}` 什么都不写,**不会复活**。不想要就删,seed 不会跟你抢。

## 一、准备:确认你的账号能建标准

配置面 8 个权限码只绑 `ops-admin`:

```text
certificate-standard.read.record   / create.record / update.record / delete.record
certificate-recognition-policy.read.record / create.record / update.record / delete.record
```

用 `GET /api/system/v1/authz/me/effective-permissions` 确认自己持有它们。缺就先配角色 —— 这一步不该靠改 seed 绕过。

## 二、建标准(§5.2)

标准分两种 `kind`:

| kind | 含义 | 能否持有证书 |
|---|---|---|
| `FAMILY` | 目录节点(如「急救类」) | **否**(D-CERT-003) |
| `CREDENTIAL` | 具体可持有的证书 | 是 |

```text
POST /api/admin/v1/certificate-standards
{
  "code": "red_cross_first_aid",
  "name": "红十字急救员证",
  "kind": "CREDENTIAL",
  "categoryCode": "first_aid",     // cert_type 字典 code
  "isInternal": false              // 是否本会颁发
}
```

> ⚠️ **建标准时,可选字段要么带一个真值,要么整条省掉 —— 不要传显式 `null`。**
> `levelCode`(cert_sub_type 字典 code)、`parentId`(挂到某个 FAMILY 下)、`isInternal`、`sortOrder`
> 在**建标准**这一步都只有「给真值」和「不写」两种选择:传 `null` 会被契约层拒成 `400`
> (评审 findings H3 之前是 `500`,更难看懂)。要用就给真值,不用就别写这一行。
>
> 改标准(`PATCH /:id`)不同:`levelCode` / `parentId` / `description` 传 `null` 是**合法的清空动作**
> (清等级 / 摘到根 / 清说明)。其余字段传 `null` 同样 `400`。

新建为 `DRAFT`,**不能用于建证**。

**身份字段在 DRAFT 期可以直接改**(2026-07-30 修正,见 [amendments A-3](../archive/reviews/certificate-standard-library-t0-amendments.md#a-3-draft-标准可改身份字段code-除外)):`PATCH /:id` 接受 `kind` / `categoryCode` / `levelCode` / `parentId` / `isInternal`,条件是该标准仍是 `DRAFT` **且从未启用过**;首次切 `ACTIVE` 之后永久拒绝(`18033`),哪怕后来又切回 `INACTIVE`。

**`code` 是唯一改不了的那个。** 它是长期稳定标识(岗位要求、活动门槛、外部系统都可能引用),而且它的 unique **含软删行** —— 软删一个标准**不会**释放它的 code。所以:

> ⚠️ **初始化时 `code` 打错一个字,那个 code 就永远用不了了。** 建标准前把 code 逐个念一遍再提交,这是本文档里最不可逆的一步。

`PATCH /:id/status` 切 `ACTIVE` 后才可用。

### 招新要用的两个类别

招新只收两类(`RECRUITMENT_CERT_CATEGORIES`):`first_aid` 与 `bsafe`。想让申请人在公开选择器里看到某个标准,它必须是 `ACTIVE` + `CREDENTIAL` + 这两个 `categoryCode` 之一。验证:

```text
GET /api/open/v1/recruitment/certificate-standards   （无需登录）
```

`currentlyRecognized: false` 表示「已收录、待认定」—— 申请人可以选它作建议,但审核通过必须另有 ACTIVE Policy(§11.2)。

## 三、建认定规则(§5.3 / §5.4)

每个 CREDENTIAL 标准至多一条 ACTIVE Policy,版本化:

```text
POST /api/admin/v1/certificate-standards/:standardId/recognition-policies
{
  "issuerPolicy": "ALLOWLIST",        // FIXED | ALLOWLIST | FREE_TEXT
  "validityMode": "FIXED_MONTHS",     // PERMANENT | FIXED_MONTHS | EXPLICIT_REQUIRED | EXPLICIT_OPTIONAL
  "validityMonths": 24,               // FIXED_MONTHS 必填
  "certNumberMode": "REQUIRED",       // REQUIRED | OPTIONAL | NONE
  "issuers": [{ "name": "深圳市红十字会" }]
}
```

> ⚠️ **issuer 名单不是「这个类别下所有可能的发证机构」,而是「**这一个标准**认可哪些机构签发」。**
>
> 本示例此前把「深圳市红十字会」与「深圳市急救中心」放进同一个 `red_cross_first_aid` 的 issuer 名单(2026-07-30 跨模型评审 R12 订正)。那是错的:它们是**两种不同的证书**,只是同属 `first_aid` 大类。
>
> 维护者口径逐字:**「急救资质是大类,不等于红十字证书。」** 把两家揉进一个标准,后果是资质判定分不出「这个人有红十字救护员证」和「这个人有急救中心的急救员证」—— 而它们的培训内容、有效期、复训要求都不一样。
>
> 正确做法是**两个 Standard、同一个 `categoryCode`**:
>
> | code | name | categoryCode | issuers |
> |---|---|---|---|
> | `red_cross_first_aid` | 红十字救护员证 | `first_aid` | 深圳市红十字会 |
> | `emergency_center_first_aid` | 深圳市急救中心急救员证 | `first_aid` | 深圳市急救中心 |
>
> 两者都属 `first_aid`,所以 `criterionType=category&criterionCode=first_aid` 的资质判定**两张证都算数**(§12);要精确到某一种就用 `criterionType=standard`。这正是两级判据存在的理由。
>
> **什么时候才该把多个机构放进同一个名单**:同一张证书由多家机构联合签发或分区签发(例如同一个 BSAFE 等级在不同城市由不同分会发证),它们发的是**同一种**证书。判据是「持证人拿到的是不是同一张证」,不是「都属于同一个大类」。

三组规则各自决定录入/审核时要传什么:

| `issuerPolicy` | 录入 / 审核时 |
|---|---|
| `FIXED` | 恰好 1 个 issuer,可不传(后端选唯一) |
| `ALLOWLIST` | **必须**传 `recognitionIssuerId`,且属于本 Policy |
| `FREE_TEXT` | **必须**传 `issuingOrg` 自由文本,不得传 issuerId |

| `validityMode` | `expiredAt` |
|---|---|
| `PERMANENT` | 不得传 |
| `FIXED_MONTHS` | **不得传**(后端按自然月算,月底夹取) |
| `EXPLICIT_REQUIRED` | 必填 |
| `EXPLICIT_OPTIONAL` | 可空(空 = 终身) |

新建为 `DRAFT`,`PATCH /:id/status` 切 `ACTIVE` 时旧版本自动 `RETIRED`。**已锁定旧版本的历史证书不受影响** —— 那是 D-CERT-008:审核当时锁定的规则就是最终依据。

## 四、最小 smoke(§20.3 步骤 8)

按顺序各跑一次,任一失败先停:

```text
1. GET  /api/admin/v1/certificate-standards/options        → 能看到刚建的标准
2. GET  /api/open/v1/recruitment/certificate-standards     → currentlyRecognized=true
3. POST /api/admin/v1/members/:memberId/certificates       → 201(用 standardId,不是 certTypeCode)
4. GET  /api/admin/v1/certificates                         → 工作台能看到它
5. GET  /api/admin/v1/certificates/stats                   → pending 计数 +1
6. POST /api/open/v1/recruitment/certificate-claims        → 申请人能提交申报
7. POST /api/admin/v1/recruitment/certificate-claims/:id/review  → APPROVE 成功
8. 发号一次                                                 → Claim → PROMOTED + 建出证书
```

第 3 步若返 `18035`(该证书标准尚无生效认定规则),说明第三节没做完。

## 五、两个容易踩的顺序问题

**先建 FAMILY 还是先建 CREDENTIAL**:两个顺序都行。先建 FAMILY 可以在建 CREDENTIAL 时直接传 `parentId`;先建 CREDENTIAL 也不要紧 —— 它仍是 `DRAFT` 且**从未启用过**时,`PATCH /:id` 可以补设 `parentId`(见上文 [amendments A-3](../archive/reviews/certificate-standard-library-t0-amendments.md#a-3-draft-标准可改身份字段code-除外))。父节点必须是 `FAMILY` 且 `categoryCode` 与子节点一致。

**ALLOWLIST 的 issuer 名单只能在 DRAFT 期整体替换**。Policy 一旦 ACTIVE,加机构要新建版本 —— 这是刻意的:改认可范围是规则变更,应该有版本痕迹,而不是悄悄往名单里塞一行。

## 六、这一步做完之后

回到 [`certificate-standard-library-go-live.md`](./certificate-standard-library-go-live.md) 第五节确认两处对外契约破坏已被前端适配,再开放业务(§20.3 步骤 7-10)。
