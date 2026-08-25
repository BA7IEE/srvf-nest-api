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

#### 同批新增 3 个 `cert_sub_type` 字典项 —— 分级是**出队前要知道的事**

`amateur_radio_a` / `_b` / `_c`(label「业余无线电 A/B/C 类」),三个 CREDENTIAL 的 `levelCode` 取它们。
理由不是「方便筛选」,是**短波(<30MHz)功率上限差一个量级**:

| 等级 | 短波功率上限 |
|---|---|
| A | **不可用**(仅 30MHz 以上) |
| B | <15W |
| **C** | **≤1000W** |

短波 1000 瓦 = 手机没信号时还能通联 ⇒「队里有几个 C 类」是救援调派的输入。
而 `levelCode` 是身份字段、标准 `activatedAt` 之后 API 改它一律 18033(D-CERT-005)
⇒ **现在不加就永远加不了**。code 沿本字典既有 `<族>_<级>` 惯例(`bsafe_l1` / `first_aid_basic`):
族取 `amateur_radio` 而非 cert_type 的 `comm`(通讯将来还会装对讲机 / 卫星电话等别的族),
也刻意不取标准自己的 code(两个命名空间用同一串字面量迟早被当成同一个东西)。

新增一格判据闭合「`levelCode` ↔ 字典项」这条**没有 FK 的引用**(字典漏一项 seed 照样成功,
只有后续 PATCH 才 400,零症状)。**变异对拍**:把 C 的 levelCode 改成字典里没有的
`amateur_radio_d` ⇒ **恰 1 条红**、其余 11 条全绿;还原后 12/12 复绿,零残留。

#### ⭐ 规矩的措辞跟着改(**六处**),不是「本次例外」

runbook 原文「本仓刻意**不内置**任何证书标准」防的是「系统替维护者决定我们队认哪些证书」——
那确实是判断题。而 A/B/C 由 67 号令定死、**全国一套队里没得选**,不构成替谁拍板。
⇒ 把规矩改写成一条**可判的判据**(维护者 2026-08-25 拍板):

> **国家法规定义的证书可以内置;队里自己认定的一律走人工创建。**
> 判据:「这个证书的内容,队里有得选吗?」—— 有 ⇒ 人工建;没有 ⇒ 可内置。

改了 `docs/ops/certificate-standard-library-initialization.md`(新增判据节 + 已内置清单 +
「别重复建,撞 unique 会 409」)· `docs/current-state.md` §4 P1 ③ ·
`docs/ai-harness/NEXT_TASKS.md`(两处)· `docs/ai-harness/FROZEN_DRAFTS.md` ·
`docs/README.md` 的 runbook 索引行(第六处,改完前五处后全仓自查才发现 ——
同一个仓里留着两段互相矛盾的说明比只留一段正确的更糟)。

⚠️ `docs/archive/handoff/v0.65.0.md` 有同样一句,**刻意不动**:`docs/archive/**` 是红区
(仅允许新增),且按 AGENTS §0 归档是**历史证据不是当前事实** —— 它记的是 v0.65.0 当时为真的口径。

ℹ️ **内置不是单向门**:`CertificateStandard` 是软删,`code` 的 unique 含软删行 ⇒ 维护者删掉之后
再跑 seed,upsert 走 update 分支、`update: {}` 什么都不写,**不会复活**。删了就是删了。
