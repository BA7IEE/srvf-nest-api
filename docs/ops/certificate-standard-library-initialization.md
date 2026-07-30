# 证书标准库首批初始化指引(PR-6)

> 冻结稿:[`certificate-standard-library-t0-review.md`](../archive/reviews/certificate-standard-library-t0-review.md) v1.2 §20.3 步骤 6 / §11。
> 前置:PR-4b 的 contract migration 已 deploy(见 [`certificate-standard-library-go-live.md`](./certificate-standard-library-go-live.md))。

## 为什么必须先做这一步

PR-4b 起 `Certificate.standardId` / `recognitionPolicyId` / `sourceCode` 是 **NOT NULL**,且建证要求该标准**当前有一条 ACTIVE 认定规则**。

所以在库里没有 Standard + ACTIVE Policy 之前:

- 管理端建证 `POST /admin/v1/members/:memberId/certificates` → `18002`(标准不存在)
- 招新证书申报**可以提交**(申报不需要标准),但审核通过 → `28062`(该标准尚无生效认定规则)
- 发号会把整批 fail-closed(§8.5 不为缺失 Standard/Policy 的 Claim 建 pending 证书)

**这一步不是 seed。** §20.3 把「创建 Standard 和 RecognitionPolicy」列为部署流程的第 6 步、人工动作 —— 因为「队里认哪些证书、认哪些发证机构、有效期几年、编号必填不必填」是业务拍板,不是代码默认值。本仓刻意**不内置**任何证书标准:内置了就等于替维护者拍板,而拍错的默认值会被当成事实用下去。

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
  "levelCode": null,               // cert_sub_type 字典 code,可空
  "parentId": null,                // 可挂在 FAMILY 下
  "isInternal": false              // 是否本会颁发
}
```

新建为 `DRAFT`,**不能用于建证**。改身份字段(code / kind / category / level / parent / isInternal)只能在 DRAFT 期,而且是删掉重建 —— `PATCH` 契约层就不接收这些字段(`forbidNonWhitelisted` 直接 400)。

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
  "issuers": [{ "name": "深圳市红十字会" }, { "name": "深圳市急救中心" }]
}
```

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

**先建 FAMILY 还是先建 CREDENTIAL**:`parentId` 只能在 create 时设,所以要挂树就得先建 FAMILY。事后想挂只能删掉重建(DRAFT 期可软删且必然零引用)。

**ALLOWLIST 的 issuer 名单只能在 DRAFT 期整体替换**。Policy 一旦 ACTIVE,加机构要新建版本 —— 这是刻意的:改认可范围是规则变更,应该有版本痕迹,而不是悄悄往名单里塞一行。

## 六、这一步做完之后

回到 [`certificate-standard-library-go-live.md`](./certificate-standard-library-go-live.md) 第五节确认两处对外契约破坏已被前端适配,再开放业务(§20.3 步骤 7-10)。
