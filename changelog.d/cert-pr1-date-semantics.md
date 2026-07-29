- **证书日期语义收口为「最后有效日」(2026-07-30;证书标准库 PR-1,冻结稿 [`certificate-standard-library-t0-review.md`](docs/archive/reviews/certificate-standard-library-t0-review.md) §10)**:`expiredAt` 从此明确表示**最后有效日** —— `2026-08-01` 意为当天仍有效、`08-02` 起失效。这是**行为变更**,三处此前各自把「最后有效日」算成已过期,方向一致但边界各错一处:

  ① **资质判定**([`certificates.service.ts`](src/modules/certificates/certificates.service.ts) `isQualified`)原用 `expiredAt > now` —— 拿**时间戳**比一个 date-only 字段。`expiredAt` 存的是「北京日历日的 UTC 零点」,所以最后有效日一进北京 **08:00**,`now` 就越过了该零点,当天余下 **16 小时**全部误判为「无资质」。改为 `expiredAt >= today`(today = 北京日历日)。

  ② **到期 cron 自动过期**([`expiry-reminder.service.ts`](src/modules/notifications/expiry-reminder.service.ts))原用 `expiredAt <= today`,在最后有效日当天 09:00 就把证书翻成 `expired`,**整整早一天**。改为严格 `expiredAt < today`。外层扫描、事务内 findFirst 复核、原子 updateMany claim **三处谓词同时收紧** —— 漏一处会变成「扫到了却 claim 不到」的静默空转。

  ③ **到期 cron 提前 60 天提醒**原用 `expiredAt > today`,把「到期日 = 今天」这批**最该提醒的证书直接漏掉**。改为 `expiredAt >= today`(即冻结稿的 `BETWEEN today AND today+60`)。

  **谁会感知到**:后台与 App 的资质查询,在证书最后有效日当天由「已失效」变为「仍有效」;该日的自动过期推迟到次日;到期日 = 当天的证书现在会收到提醒。

- **证书日期入参收紧为纯 `YYYY-MM-DD`(行为变更,§10.2)**:`POST/PATCH .../certificates` 的 `issuedAt` / `expiredAt` 不再接受带时分秒或时区的 ISO datetime,只收 10 位纯日期。原因是放开 datetime 会让 `2026-08-01T00:00:00+08:00` 与 `...Z` 落到**不同的北京日**,同一个「意图日期」产生两种入库结果,客户端还能借时区偷偷改天。契约同步声明 `format: date` + `pattern`(不只写在 description —— `@Matches` 不会被 Swagger 推导成 `pattern`,否则前端 codegen 拿不到可执行约束)。**前端需适配**:表单提交值改为纯日期。

- **新增日期基础校验(§10.3)**:`issuedAt` 不得晚于今天(`18018 CERTIFICATE_ISSUED_AT_IN_FUTURE`);`expiredAt` 不得早于 `issuedAt`(`18017 CERTIFICATE_DATE_RANGE_INVALID`,`expiredAt == issuedAt` 合法 = 当天有效一天)。PATCH 按**写入后的最终值**校验并取行锁后的基准 —— 只改 `expiredAt` 时同样与库内 `issuedAt` 比较,不存在「分两次改绕过校验」的缝。`expiredAt` 最终值变化时清空 `expireNotifyDueAt`,让到期提醒按新日期重新计算(该字段是 at-most-once 水印,不清会永久错过新窗口);传入同值不算变化,不抹掉已发提醒的事实。

- **证书敏感字段分级(行为变更 + 契约破坏,§15.2/§15.3)**:新增权限码 `certificate.read.sensitive`(权限码 213 → 214),**默认只绑 biz-admin**。入口码仍是 `certificate.read.record` —— 缺敏感码**不是 403**,而是同一次 200 响应里降级:

  | 出参字段 | 仅 `read.record` | 另持 `read.sensitive` |
  |---|---|---|
  | `certNumberMasked` | 恒返(形如 `SZ****01`;≤4 字符整体掩为 `****`) | 同 |
  | `certNumberFull` | 恒 `null` | 明文 |
  | `verifyNote` | 恒 `null` | 明文 |
  | `verifiedBy` | 恒 `null` | 审核人 Member.id |
  | `evidenceAvailable` | 布尔(恒返) | 同 |

  **契约破坏**:详情与全部写回显的 `certNumber` 字段**已删除**,拆成 `certNumberMasked` + `certNumberFull`。**前端必须适配**。不沿 member-profiles 的「同名字段原地打码」是刻意的:同名打码有已知的编辑表单 round-trip 陷阱(掩码值被当真值写回覆盖真实编号),而 `certNumber` 恰是 PATCH 可写字段;改名后表单拿不到可直接回写的 `certNumber`,陷阱在结构上不成立。**写侧入参仍是 `certNumber`,未变。**

  分级出口收在唯一一个 presenter,6 个返详情 DTO 的方法(findOne / create / update / softDelete / verify / reject)全部经它;`CertificateResponseDto` 不再有 `certNumber`,漏接某条路径会**编译失败**而不是静默泄露。`imageKeys` 进 select 只为算 `evidenceAvailable` 布尔,原值不进任何出参 / 日志 / 审计(D-CERT-024)。读审计增记 `maskLevel`(plain / masked),便于事后追「谁看过完整编号」,编号本身仍不入审计(§15.6)。

  **`certificate.read.sensitive` 已加入 `ORG_ADMIN_EXCLUDED_CODES`** —— org-admin 码集是 biz-admin 的派生过滤,不排除就会让队长/部长随之自动继承证书明文(与既有三个 `*.read.sensitive` 同款围栏)。只读投影角色由 `isReadonlyProjectionCode` 恒排除 `.read.sensitive`,无需额外处理。

  ⚠️ **与冻结稿 §16.4 的一处偏离(维护者 2026-07-30 拍板)**:表格建议 ops-admin 也绑本码,实际只绑 biz-admin。理由:本仓 ops-admin 持**零条业务码**(连 `certificate.read.record` 都没有),而敏感读是叠在 read.record 之上的降级闸 —— 只绑敏感码对它不生效;且既有三个 `*.read.sensitive` 全部只绑 biz-admin。SUPER_ADMIN 短路照旧可见,ADMIN 用户由 seed 自动补挂 biz-admin,实际运维人员可见性不受影响。

- **`FIXED_MONTHS` 自然月工具就位(§10.4)**:`addMonthsClamped` 按自然月推进并做月底夹取(`2024-02-29 + 12 月 = 2025-02-28`;`2026-01-31 + 1 月 = 2026-02-28`),**明确不用 `30 天 × 月数`**(按天算会让 2 月发的证书比 1 月发的短命,且跨闰年漂移)。本刀只落工具与测试,调用方在后续 Policy 刀接入。同时把 `beijingDateOnly` 收进 [`date-only.util.ts`](src/common/datetime/date-only.util.ts) 单一实现,`normalizeDateOnly` 与 cron 的 `toBeijingDateOnly` 均改为委托(冻结稿 §19「不复制第二套日期算法」),行为逐位不变。
