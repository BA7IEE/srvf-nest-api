- **自助换绑与后台改资料接入同一把报名锁(2026-07-31;证书标准库第二轮跨模型评审 findings G2)**:`rebindWechat` / `rebindPhone` / `updateApplication` 三条写路径此前都在事务**之外**解析凭证 / 读报名(要调微信、要消费短信码,不能放进事务),随后进事务按**锁前那份快照**无条件写。**Endpoint 恒 438 · 权限码恒 222 · Migration 恒 67 · BizCode 恒 306 · AuditLogEvent 恒 129**,零 schema、零契约变化。

  **修复前能发生什么。** 等锁期间发号可以提交 —— 发号会把报名标 `promoted` + `sensitivePurgedAt` 并清空全部 PII。旧请求醒来后把手机 / openid / 住址 / 换绑历史**写回**一行已脱敏的记录;而 `sensitivePurgedAt` 非空会让留存清理 SOP(`WHERE sensitivePurgedAt IS NULL`)**永远跳过该行** —— 这一行会永久带着本该删除的 PII(换绑历史里还含**明文旧手机号**)。

  三处统一改用 `recruitment-application-lock.ts` 里已有的锁:

  - **两个换绑**走 `lockOwnActiveApplicationOrThrow`(锁 + 复读 + **复核旧凭证仍匹配** + 拒终态)。`channel` 传 `'phone'` —— 复核的必须是**授权本次操作的那条凭证**(两条路径验的都是 `dto.phone` 的短信码),不是被修改的那个字段;这样也顺带覆盖「首次绑定微信」(报名此前无 openid),按 openid 复核会把这条合法路径误杀。不匹配按 `28002` 泛化返回,沿整份撤销那条路径的口径。
  - **`phoneBindingHistory` 改为从锁后的行重新生成**,不再沿用事务外的 `priorHistory`。历史是追加型事实,用旧快照覆盖写就是丢事实:两次换绑竞速时,后到的那次会把先到那次的记录**整条抹掉**。
  - **`updateApplication`** 走 `lockActiveApplicationOrThrow`,`promoted` / `sensitivePurgedAt` 两道守卫在**锁后重新执行**(`sensitivePurgedAt` 是独立的一根轴 —— 留存清理跑过但状态未到终态的行只有它能拦),最终写入改为带 `statusCode + sensitivePurgedAt IS NULL` 条件的 CAS `updateMany`(`count !== 1` 即 28041)。

  **⚠️ 行为变化**:`updateApplication` 现在对 `rejected` / `withdrawn` 报名也返 `28041`(此前只拦 `promoted` 与已脱敏行)。终态报名的资料不该再被改 —— 与其余写路径的终态口径拉齐。其余错误码与放行条件逐字不变。

  行为锁:新增 `test/e2e/recruitment-identity-write-concurrency.e2e-spec.ts`(11 条,含独立连接元断言 + 全库巡检「`sensitivePurgedAt IS NOT NULL` 的报名不得含任何应清 PII」,19 列逐字对齐发号清敏写入)。竞态编排让**真发号**排在锁队列第 1 位、被测操作第 2 位 —— 清敏字段清单因此不会与实现漂移。其中 6 条在修复前红。
