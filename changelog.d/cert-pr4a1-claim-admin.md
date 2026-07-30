- **招新证书申报管理端 + 认定规则解析器(2026-07-30;证书标准库 PR-4a-1,冻结稿 [`certificate-standard-library-t0-review.md`](docs/archive/reviews/certificate-standard-library-t0-review.md) §8.2 / §8.3 / §11.2 / §13.3 / §13.4 / §15.4 / §17)**:6 个新端点(Endpoint 429 → **435**,Controller 83 → **84**)。**纯新增刀** —— 旧 `POST /admin/v1/recruitment/applications/:id/certificates/:category/review` 与人工门槛标记**仍然在线且行为逐字不变**。

  | 面 | 端点 |
  |---|---|
  | 招新证书申报 5 | `GET /admin/v1/recruitment/applications/:applicationId/certificate-claims` · `GET /admin/v1/recruitment/certificate-claims/:id` · `GET .../:id/image-urls` · `POST .../:id/review` · `POST .../:id/revoke-review` |
  | 公开标准选项 1 | `GET /open/v1/recruitment/certificate-standards` |

  **零新增 RBAC 码**(权限码恒 222):读走 `recruitment-application.read.record`,完整编号 / 审核人 / 备注 / 证据图 URL 要 `recruitment-application.read.sensitive`,审核与撤回走 `recruitment-application.review.certificate`。

  **一证一行取代「按类别一格」**。旧路径把 `:category` 当资源 id,于是同类别第二张证书无处存放、单证重传与单证审核都做不到。新路径的单体端点挂 `certificate-claims/:id` 扁平前缀 —— claimId 已足够定位,不需要把报名 id 再拼一层。

  **§11.2「已收录、待认定」不是「已认可」**。公开选项对暂无生效认定规则的标准返 `currentlyRecognized: false`:申请人仍可选它作**建议**(比让他填自由文本可归类得多),但审核通过必须另有生效规则,否则 `28062`。e2e 正向验这一格 —— 拿一个申请人已建议的待认定标准去 APPROVE,拒 28062 且该行状态 / 锁定字段 / version **一律不落痕**。

  **审核锁定的是规则,不是当时的文字**(§5.6 / D-CERT-021):APPROVE 落 `standardId` + `recognitionPolicyId` + `recognitionIssuerId` + `issuingOrg`(机构**名称快照**)+ 规范化后的编号与日期。机构认可靠 issuer id 不靠中文机构名匹配;`FIXED_MONTHS` 的到期日由后端算,客户端自带 `expiredAt` **直接拒**而非静默忽略(静默忽略会让前端以为自己填的生效了)。

  **`CertificateRecognitionResolver` 是 certificates 模块唯一对外导出**(§19),招新侧复用它解析机构 / 编号 / 日期,不复制第二套认定算法。它刻意**不提供** `resolve()`,而是四个显式入口:建证与审核用**当前 ACTIVE** 规则,改证沿该证**已锁定**的规则(哪怕已 RETIRED),发号**只搬运不重判**。把四者合成一个带开关的 `resolve()`,开关就是漂移的开始。依赖方向单向 —— certificates **绝不**反向 import recruitment。

  **敏感分级只有一个出口**:所有返 DTO 的方法都经 `present(row, sensitive)`。`imageKeys` **永不出现在任何响应**(两档都不返),只给 `imageCount`;取图走独立端点,TTL 300s + `Cache-Control: no-store`(少了 no-store,签名 URL 会进浏览器/代理缓存,TTL 到期后缓存副本仍可取出,短 TTL 就白设了)。审计只记条数,key 与 URL 一律不入。

  **§15.4「授权不能只靠 claimId」**:详情 / 证据图 / 审核都连带校验该 Claim 挂在一个真实且未软删的报名上。只按 claimId 查到行就返回,等于让一条泄露的 claimId 变成万能钥匙;报名已软删时统一按「申报不存在」回,不泄露「claim 在但报名没了」。

  **CAS + 固定锁序**:审核回传 `version` 必须等于当前值(不等 `28058`),审核自身也自增 version,让并发的申请人重传撞 CAS。事务内先锁 `RecruitmentApplication` 行再复读 Claim —— 等锁期间申请人可能已重传。锁序与发号、Policy 切换同前缀(§8.3),不制造新的死锁路径。

  **状态机穷举单测 55 条**([`recruitment-certificate-claim-state-machine.spec.ts`](src/modules/recruitment/recruitment-certificate-claim-state-machine.spec.ts)):6×6 全枚举 + 门槛派生 + 报名状态重算。`PROMOTED` 与 `WITHDRAWN` 是两个空集终态。撤回审核回 `SUBMITTED` 而非 `NEEDS_INFO` —— 撤回是「审核结论错了」,不该给申请人推一条补材料通知。

  **门槛派生刻意还没接线**(§21 约束 2):门槛是**聚合投影**而不是可写标记(两张急救证拒掉一张,不该清掉另一张已通过证书带来的门槛),纯函数已就位并有单测,但接线必须与「`markThreshold` 拒写证书两类」「旧 `certificateImages` JSON 停写」在 4a-2 一次原子切换 —— 提前接线会与仍在线的人工标记形成两个真相源。e2e 有一条**反向断言**锁住这件事:审核前后报名的 `statusCode` / `thresholdMarks` / `certificateImages` / `certificateReviewStatus` 逐字不变。

  **BizCode +11(295 → 306)**:招新域 7 条(`28056` 申报不存在 / `28057` 状态非法 / `28058` 版本冲突 / `28059` 数量超限 / `28061` 必须指定标准 / `28062` 无生效认定规则 / `28063` 类别与标准不符),证书域 4 条(`18014` 机构不在名单 / `18016` 编号规则不允许 / `18020` 编号必填 / `18035` 无生效认定规则)—— 后 4 条是 PR-3 明确留给实例写路径的号位,此刻才不是孤码。

  **首次消费 PR-2 已登记的两个审计事件**(AuditLogEvent 恒 **127**,不新增):`recruitment-certificate-claim.review` / `.review-revoke`。extra 是**闭集**,e2e 逐 key 精确比对:只有 operation / applicationId / decision / standardId / policyId / issuerProvided / imageCount / certNumberProvided / expiredAtProvided。完整编号、图片 key、备注全文、申请人 PII 全部不入;同时**正向**断言 `certNumberProvided` 与 `imageCount` 在 —— 否则「不写明文」可以靠什么都不写来假装满足。撤回事件另记 `revokedStandardId` / `revokedPolicyId`,那是事后复原判断依据的唯一线索。

  一处订正,是 DB 的 CHECK 先红抓到的:e2e 原本直插一条 `status = PROMOTED` 但不带完整标准化事实的 Claim 行,被 `recruitment_certificate_claim_promoted_complete_check` 以 23514 拒掉。修的是夹具不是约束 —— 造不出「已发号却没锁定规则」的行正是那条 CHECK 存在的意义。
