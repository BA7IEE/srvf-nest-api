- **招新证书写路径切到 Standard/Policy/Claim(2026-07-30;证书标准库 PR-4a-2,冻结稿 [`certificate-standard-library-t0-review.md`](docs/archive/reviews/certificate-standard-library-t0-review.md) §8.1 / §8.2 / §8.4 / §8.5 / §13.3 / §13.4 / §21)**:**Endpoint 恒 435**(+3 公开申报 −1 旧公开上传 −2 旧 admin category 端点 = 净 0),Controller 恒 84,权限码恒 222,Migration 恒 66。这是一刀**原子切换**:旧路径本刀删除,不留兼容窗口。

  | 变化 | 端点 |
  |---|---|
  | ➕ 公开申报 3 | `POST /open/v1/recruitment/certificate-claims`<br>`POST .../certificate-claims/:id/resubmit`<br>`POST .../certificate-claims/:id/withdraw` |
  | ➖ 旧公开上传 | `POST /open/v1/recruitment/applications/certificates` |
  | ➖ 旧 admin | `POST /admin/v1/recruitment/applications/:id/certificates/:category/review`<br>`GET /admin/v1/recruitment/applications/:id/certificate-image-urls` |

  **⚠️ 前端必须适配的四处契约变化:**

  1. **一证一行取代按类别整组覆盖。** 同类别可以提交多张,互不覆盖;重传只换**这一条**的图与自报事实。旧端点把 `category` 当资源 id,于是同类别第二张证书无处存放、单证重传与单证审核都做不到。
  2. **进度模型 `certificates` 变形**:从「每个类别恰一条,status ∈ none/uploaded/approved/rejected」改为「每条申报一行」,字段为 `claimId / version / category / rawCertificateName / status / imageCount / note`,`status` 直接透传 Claim 状态机(六值),数组可能为空、也可能同类别多行。旧形状在结构上表达不了「两张急救证,一张过了一张被驳回」—— 而那正是一证一行要解决的问题。
  3. **`PATCH .../thresholds` 与 `POST .../batch-mark-threshold` 的 `thresholdCode` 枚举从 5 项收窄到 3 项**(`patrol1 / patrol2 / training`)。传 `redCross` / `bsafe` → `40000`(契约层 `@IsIn`),**无论 `completed` 真假**。
  4. **取证据图换端点**:`GET /admin/v1/recruitment/certificate-claims/:id/image-urls`(claim 维度,TTL 300s + `Cache-Control: no-store`)。

  **§8.4 门槛派生是本刀的核心。** `redCross` / `bsafe` 不再是可人工标记的门槛,而是 Claim 审核结论的**聚合投影**:

  > 某证书门槛完成 = 当前报名下至少存在一条 `status ∈ {APPROVED, PROMOTED}` 且已解析 Standard 的 `categoryCode` 对应该门槛、且未软删的 Claim。

  关键是**聚合**而不是「这次审核的结论直接写 true/false」。两张急救证里拒掉一张,聚合仍看得见另一张已通过的证书;而逐次覆写的标记记不住「还有另一张」,会把已满足的门槛错误清掉。e2e 有一条专门用例锁这一格(同类别两张,撤回其中一张的审核,`redCross` 仍成立)。

  门槛值仍**物化**在 `thresholdMarks` JSON 里(所有既有读侧因此逐字不变),但对这两个 code 它是**投影而不是事实源**:唯一写者是 `recomputeCertificateThresholds`,由提交 / 重传 / 撤回 / 审核 / 撤回审核 / 整份撤销六条路径在**同一事务、持有报名行锁之后**各调一次。派生标记的 `by` 是显式常量 `system:certificate-claim-derived` 而不是审核员 id —— 塞审核员会让人误以为那是一次人工标记,从而误以为可以人工撤销。

  **拒写做成两道,但只有一道是当前可达的。** DTO 的 `@IsIn` 把两个 HTTP 入口都拦在 400;service 层的 `28063 RECRUITMENT_THRESHOLD_DERIVED_READONLY` 是纵深防御,挡的是**未来任何内部直调 `markThreshold` 的新路径**(它的行为锁在单测里直调 service)。这里如实订正我先前的说法:批量入口**也**过 ValidationPipe,不是「靠 service 那道兜住」。

  **§8.5 发号只搬 APPROVED Claim。** 不再读旧 `certificateImages` JSON、不再按 category 猜 Standard、不再建 pending 证书。「只搬不重判」是 D-CERT-008 的落点:审核当时锁定的 Policy 就是最终依据,哪怕此刻该 Standard 已换新 ACTIVE Policy 也绝不重算 —— 所以发号不锁 Standard/Policy,只用 Resolver 校验关系完整,缺任何标准化字段整批 fail-closed(不悄悄跳过坏 Claim)。落 `sourceCode=RECRUITMENT` + `sourceClaimId`(`@unique` 防重跑重复建证);继承审核人/时间/备注;最后有效日早于今天 → `expired`,否则 `verified`;Claim 转 `PROMOTED` 并清掉与证书重复的标量(`rawCertificateName / certNumber / issuingOrg / issuedAt / expiredAt`),Standard / Policy / 审核链 / 图片证据保留。

  **证据图不再搬到 Certificate**:§13.5 明确 `source=RECRUITMENT` 的 evidence 读的是 `sourceClaim.imageKeys`,blob 单一属主自本刀起是 Claim 而不是 Certificate(与旧模型相反)。好处是审核链与证据留在同一行,发号不产生第二份 key 副本。

  **旧三个证书 JSON 列自此只读不写**(`certificateImages / certificateReviewStatus / certificateIssuanceInfo`)。`uploadCertificateImages` 是它们在申请人侧的唯一写者,删掉它「4a 起旧字段只读不写」就成立;promote 里剩下的三处只是清成 `DbNull`。列在 PR-4b 物理 DROP。

  **§8.1 逐条**:每份报名最多 10 条未软删申报(上限在**行锁内**复查 —— 两个并发提交都会在锁外看到 9 条);1~3 张 JPEG/PNG,内容校验复用 attachments 的 `AttachmentContentValidator`(模块内不得复制 MIME 黑名单);storage key = 固定 namespace + 随机 uuid,**不含**类别 / cycleId / 姓名 / 手机 / 原文件名;免费文件闸先跑,再走可能消费短信码的凭证链。申请人自报字段走**白名单函数**而不是「写入前 delete 不该有的键」—— 前者加字段要显式加,后者加字段默认放行,于是 `standardId / policyId / issuerId / 审核字段` 在结构上不可能被申请人写入。

  **§13.3「claimId 不能单独构成授权」**:三个公开端点都要求凭证解析出的报名与 claim 归属一致,不一致按「不存在」回 —— 区分「不是你的」就是枚举 id 的信号。双通道凭证抽成 `resolveActiveApplicationByCredential`,三端点共用,身份链仍只有一处实现。

  **§8.4 末段整份撤销级联**:未 `PROMOTED` 的 Claim 在同一事务转 `WITHDRAWN` 并清除门槛贡献。`PROMOTED` 用 `notIn` 排除 —— 已发号的报名本就撤不掉,这是纵深防御。

  **审计 +2 事件**(AuditLogEvent 127 → **129**):`recruitment-certificate-claim.submit`(提交/重传/撤回,actor 恒 null)与 `recruitment-application.threshold-recompute`(它是「为什么这份报名状态自己动了」的唯一线索)。两者 extra 都是闭集,不含完整编号 / 图片 key / 申请人 PII。

  **三个 BizCode 成为孤码**:`28053`(证书图必填)、`28054`(该类证书已审核通过)、`28055`(证书尚未审核通过)——它们的语义随「按类别一格」一起消失。**保留不删**:删除已发布的错误码对前端是破坏性变化,而留着它们不会被任何路径触发。

  **退役的测试都带指针,不是删掉不变量**:`uploadCertificateImages` 那组三条不变量各写明新归属;「证书图先按安全计数审计再调 provider」+「审计失败 → provider 0 次」两条 fail-closed 不变量迁到 `recruitment-certificate-claims.service.spec`;跨模块总账 `sensitive-read-audit-unification.e2e` 的证书图入口同步 retarget 到 claim 维度(operation `certificate-images` → `certificate-claim-images`,事件名与 extra 白名单不变);PR-4a-1 那条**反向**断言(「本刀不动门槛」)按新事实**翻面**为「审核通过 → 派生门槛写入 / 撤回 → 聚合后清除」——反向断言的寿命只到它锁住的事实还成立那一刻,过期不翻面就是假绿。
