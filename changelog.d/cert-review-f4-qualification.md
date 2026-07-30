- **§12 资质判断落地(2026-07-30;证书标准库跨模型评审 findings F4,冻结稿 [`certificate-standard-library-t0-review.md`](docs/archive/reviews/certificate-standard-library-t0-review.md) §12)**:零新增端点、零新增权限码、零新增 BizCode、零 schema 变更(Endpoint 恒 438 · Migration 恒 67)。⚠️ **对外契约破坏**,`openapi.json` 与 [`handoff/admin-web.md`](docs/handoff/admin-web.md) §3.2.1 同 PR 已登记。

  冻结稿 §12 此前**整节未实现**:query 只收 `certTypeCode`(等价于两级判据里的 category 一级),出参只有 `memberId / certTypeCode / qualified` 三字段,全仓搜 `criterion` 零命中。

  `GET /admin/v1/members/:memberId/certificates/qualification-flag`

  | | 旧 | 新 |
  |---|---|---|
  | query | `certTypeCode=first_aid` | `criterionType=category\|standard` + `criterionCode` |
  | 出参 | 3 字段 | 5 字段(+ `matchedCertificateId` / `expiredAt`,`certTypeCode` → `criterionType` + `criterionCode`) |

  **旧参数直接删除、不做兼容**:两套入参就是两个事实源,而 `certTypeCode=first_aid` 与 `criterionType=category&criterionCode=first_aid` 语义完全重合 —— 留着只会让下一个人以为它们有区别。`forbidNonWhitelisted` 会把继续发旧参数的调用方拒成 `40000`,而不是静默当成「没传判据」返回一个错误答案。

  判据一律用**稳定 code**(§12:「不使用跨环境不稳定的 cuid 作为业务规则参数」)—— 岗位要求、活动门槛这类配置将来会引用它,cuid 换个环境就失效。

  **四级稳定排序**(`永久有效优先 → expiredAt 较晚 → issuedAt 较晚 → id 字典序`):前两级由 `ORDER BY expiredAt DESC NULLS FIRST` 一个 clause 表达。第四级不是凑数 —— 少了它,两张同日发放、同日到期的证书谁被选中取决于 PostgreSQL 的物理行序,同一次查询在 `VACUUM` 前后可能返回不同的 `matchedCertificateId`,而那正是「稳定顺序」四个字要排除的东西。

  **为什么要返 `matchedCertificateId` 与 `expiredAt`**:只回一个布尔,调用方拿到 `false` 无法区分「没有这张证」与「有但过期了」,拿到 `true` 也无法回答「什么时候要提醒续期」。

  **`criterionCode` 不存在 → 400 而不是 `qualified: false`**(category 走 `18010`,standard 走 `18002`)。拼错的 code 与「确实没有这张证」是两件事,而后者会被调用方(岗位资格、活动门槛)当成「这个人不合格」写进业务结论。

  **§12「历史 Certificate 不要求 Standard / Policy 当前 ACTIVE」**:standard 级判据只校验标准**存在且未软删**,不校验 `status`。校验 ACTIVE 会让「标准停用后,存量持证人一夜之间全部不合格」,而停用标准的本意是「不再新发」,不是「追溯作废」。e2e 正向锁住了这一格。

  审计 extra 的 `filterFields` 随之从 `['certTypeCode']` 改为 `['criterionType', 'criterionCode']` —— 仍然只记「按哪些字段筛的」,不记筛选值本身,也不记判定结果。
