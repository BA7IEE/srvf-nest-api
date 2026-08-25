### 首批证书标准入库 —— 业余无线电台操作技术能力验证证书 A / B / C(证书标准库零标准 → 4 条)

证书标准库 T0「② 首批标准与认定规则未建(零标准)」的第一批。本刀之前 `prisma/seed.ts` 里
`certificateStandard` 命中 **0** —— 证书模块的标准 / 认定规则 / 建证接口早已齐全,新库上却
**一个可选标准都没有**。现在 seed 出 **1 个 FAMILY + 3 个 CREDENTIAL + 3 条 ACTIVE 认定规则**。

| 标准 code | kind | 频段与功率(工信部令第 67 号第三十条) |
|---|---|---|
| `amateur_radio_operator` | FAMILY | 目录分组,不可认定 / 不可持有 |
| `amateur_radio_operator_a` | CREDENTIAL | 30—3000MHz,≤25W |
| `amateur_radio_operator_b` | CREDENTIAL | <30MHz 且 <15W,或 >30MHz 且 ≤25W |
| `amateur_radio_operator_c` | CREDENTIAL | <30MHz 且 ≤1000W,或 >30MHz 且 ≤25W |

三条认定规则同形:`PERMANENT`(不载到期日)+ `FREE_TEXT`(核发机关按证录入)+ 编号 `OPTIONAL`。
`categoryCode` 全取既有字典 `cert_type` 的 `comm`,**未新增任何字典项**;**零 schema 改动、零 migration**。

#### 🔴 不建前置条件链(维护者 2026-08-25 拍板)

B 类要求「依法取得业余无线电台执照 6 个月以上」、C 类要求「取得载明 30MHz 以下频段的执照
18 个月以上」—— 卡的是**电台执照**持有时长,不是证书,而本仓没有「电台执照」这个概念。
系统的角色是**记录队员有什么证**,不是审核他该不该有(发证方是无线电管理机构)。
⇒ 三类各自独立登记,前置条件只落在 `description` 文本里,**零字段、零校验、零 schema、零父子依赖**;
四条之间的 `parentId` 只是 D-CERT-003 的目录分组,不表达任何先后关系。

#### ⭐ 两处法规事实与立项口径不同(实测更正)

- **名称**:工信部令第 67 号全文**不出现「业余无线电台操作证书」**,法定名是「业余无线电台
  **操作技术能力验证**证书」(第二十九条)。「操作证书」是原中国无线电运动协会 / 业余无线电分会
  时代的**旧证**名,正在集中换发(各省通告口径:2026-12-31 前旧证仍作数,**2027-01-01 起失效**)。
  本刀收录的是新版法定名;旧证若要单独建档是另一批标准的事。
- **有效期**:67 号令**未规定**操作证书有效期,也无换证条款 ——「终身有效」是各地换发通告的
  宣传口径,**不是条文里的字面词**。落到本仓的事实是「证书不载到期日」⇒ `validityMode = PERMANENT`
  (该档语义正是「到期日必须 NULL」)。

#### ⭐「终身有效」的实测证据(不是填了个枚举就算)

新增 `src/modules/certificates/amateur-radio-standard-seed.spec.ts`(8 例,不连库),把三段接上:

| 段 | 判据 | 读数 |
|---|---|---|
| ① seed 事实 | 三条规则 `PERMANENT` 且 `validityMonths` 为 NULL | 绿 |
| ② 签出的实例 | 真 `CertificateRecognitionResolver` + 本 seed 的规则形状 ⇒ `expiredAt === null`;客户端硬塞到期日**直接拒**;**阳性对照**换 `FIXED_MONTHS(24)` ⇒ 非空 | 绿 |
| ③ 提醒的目标集 | 抓 `ExpiryReminderService.runOnce()` 实际下发给 `certificate.findMany` 的两条 `where` | 见下 |

③ 的实际读数(本机 tsx 探针,`runOnce(2026-08-25)`,恰 2 条):

```
{ deletedAt: null, certStatusCode: 'verified',
  expiredAt: { gte: '2026-08-25', lte: '2026-10-24' }, expireNotifyDueAt: null }   // 提前 60 天提醒
{ deletedAt: null, certStatusCode: 'verified',
  expiredAt: { lt:  '2026-08-25' } }                                              // 自动过期
```

两条目标集**都由 `expiredAt` 的区间比较定义**,没有 `OR`、没有 `IS NULL` 分支 ⇒ SQL 三值逻辑下
`NULL <op> x` 求值为 NULL 而非 TRUE,`expiredAt = NULL` 的行**结构上进不去**。
DB 侧读数仓内早已存在:`test/e2e/notifications-expiry-reminder.e2e-spec.ts` 的 `perpetualCertificate`
(`expiredAt: null` + `verified`)在四张证书的夹具里,`runOnce` 只报
`certificateReminderCandidates: 1` / `certificateExpiryCandidates: 1`,且该行跑完仍是
`expireNotifyDueAt === null` / `certStatusCode === 'verified'`。
⇒ **没有发现缺陷:PERMANENT 这一档不会被到期提醒扫进去。**

spec ③ 的执行位是**禁止型**的:谓词一旦出现 `OR` / `IS NULL` / 未覆盖算子 / 不再筛 `expiredAt`,
判据**当场抛错**而不是继续给出上一版结论(带 4 格阳性对照证明它会红)。

#### 幂等

三处 `upsert` 全部 `update: {}` —— 与字典同侧、与 Permission 相反(P2-15 对照表):Standard 的
name / description / sortOrder 按 D-CERT-005 本就**允许运营在审计下改文案**,覆写型 upsert 会
回退运营编辑并恒跑 UPDATE 白动 `@updatedAt`。`code` 的 unique 含软删行 ⇒ 有人软删后再跑 seed
既不复活也不建第二份。`FREE_TEXT` 要求 issuer 数**恰好 0**,故刻意不建 `CertificateRecognitionIssuer`
行(顺带避开该表**没有自然唯一键**、幂等只能靠 findFirst 兜的风险)。

⚠️ **`levelCode` 三条全留 NULL**:字典 `cert_sub_type` 当前只有 bsafe / 救护员四项,没有业余无线电
A/B/C 的取值,而往字典加值需要维护者拍板。🔴 这是**单向门** —— `levelCode` 属身份字段,
`activatedAt !== null` 之后 API 侧改它一律 18033(D-CERT-005),要补等级码必须在合入前决定。
