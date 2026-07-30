- **主数据契约与审计收尾(2026-07-30;证书标准库跨模型评审 findings F5,冻结稿 [`certificate-standard-library-t0-review.md`](docs/archive/reviews/certificate-standard-library-t0-review.md) §5.3 / §7.1 / §7.2 / §9.2 / §13.1 / §13.2 / §13.5 / §17)**:零新增端点、零新增权限码、零新增 BizCode、零 schema 变更(Endpoint 恒 438 · Migration 恒 67)。⚠️ 含**两处契约收紧**,`openapi.json` 同 PR 已刷新。

  ### R2 · DRAFT 标准可改身份字段(除 `code`)

  原设计是「身份字段一律不可改,DRAFT 期要改就删掉重建」。那条路在这个模型里**走不通** —— `code` 是全量 `@unique` 且**含软删行**(D-CERT-004「不可复用」正是靠这一点)。软删一个填错的 DRAFT 标准之后,它的 code 被永久占用,「重建」只能换 code。首批初始化打错一个字,那个 code 就永远用不了了。

  现在开放 `kind` / `categoryCode` / `levelCode` / `parentId` / `isInternal`,判据是 **`status = DRAFT` 且 `activatedAt IS NULL`**。用 `activatedAt` 而不是只看 status:状态机允许 `ACTIVE → INACTIVE → ACTIVE`,而 `activatedAt` 记的是**首次**启用且永不覆盖 —— 只看 status 会把一个 INACTIVE 标准误判成可改身份,而它可能已被一批历史证书引用。`code` 仍然一个字都不能改。

  ### R3 · 只有 DRAFT 可软删,且先锁再数引用

  两条:**① 只有 DRAFT 可删** —— 此前 ACTIVE / INACTIVE 零引用时也能删,后果是「这个 code 被永久占用且再也建不出来」。**② 先锁再数** —— 此前引用计数在锁外跑,与「给这个标准建 Policy」并发时可留下一条指向已软删 Standard 的 Policy。现在两条路径抢同一把 Standard 行锁(与 policies service 的 `lockStandardOrThrow` 同款 `FOR NO KEY UPDATE`,各用各的锁等于没锁)。

  ### R4 · 状态迁移加行锁 + 锁后复读

  并发两次 `DRAFT→ACTIVE` 此前**都成功**:各自读到 DRAFT、各自过状态机、各自写 `activatedAt`(后者覆盖前者,而 §7.1 说它记的是首次),留下两条 `activate` 审计。现在后到的那个在锁后复读时看到 status 已是 ACTIVE,状态机直接拒。

  ### R5 · `options` 两档都只返 ACTIVE

  此前 `recognizedOnly` 缺省时返 ACTIVE + INACTIVE,而 INACTIVE 标准在 Resolver 那里是硬拒 —— 下拉里明明列着、甚至因为还挂着一条 ACTIVE Policy 而显示 `currentlyRecognized: true`,选中提交却被拒。「能选但选了就报错」是最难排查的一类前端问题:报错指向标准状态,而界面上根本没有状态这一列。两档的区别因此收窄为「要不要**同时**有 ACTIVE Policy」。

  ### R7 · RECRUITMENT 来源证书永久禁改 `standardId`

  原有的闸只看 `certStatusCode === pending`,而招新来源的证书**可以**回到 pending(改了别的核心事实就会 §9.2 打回)。一旦回到 pending,`standardId` 就能被改成另一个标准 —— 而 `sourceClaimId` 仍指着原来那条 Claim:证书说自己是 A 标准,它的证据链、审核结论、锁定的 Policy 说的是 B 标准。§8.5 在发号那一刻建立的对应关系被一次管理端 PATCH 悄悄拆掉,且无法从数据上还原。

  ### R8 · 审计能区分建版与改版,并记录被退役的那一版

  改 DRAFT 规则此前复用 `create-policy` —— 审计里建版与改版长得一模一样。新增闭集值 `update-draft-policy`。激活时新增 `supersededPolicyId` / `supersededPolicyVersion`:此前完全看不出激活 v3 的同时退役了 v2,而「上一版是什么时候、被哪次激活顶掉的」正是事后复原「这张证书当时按哪版规则认定」的关键线索。

  ### R9 · 撤回审核只清不写

  此前把撤回人写进 `reviewedByUserId` / `reviewedAt`、把撤回理由写进 `reviewNote` —— 而这三列的语义是「谁、什么时候、以什么理由**通过**了这条申报」。于是一条 SUBMITTED 申报上挂着「审核人:张三」,申请人侧的 `reviewNote` 会把撤回理由读成驳回说明。方法的 JSDoc 本来就写着「必须清空……审核字段」,执行位没跟上。撤回人不丢:审计的 `actorUserId` 就是他,并新增 `revokedReviewerUserId`(被撤销的那次审核是谁做的)与 `noteProvided`(§17 禁备注全文入审计)。

  ### R10 · `evidenceAvailable` 覆盖两种来源

  此前只判 `sourceClaim.imageKeys`,注释还写着「不假装覆盖两种」。结果是**管理端上传的证据一律显示为没有证据**,前端据此隐藏「查看证据」入口。而工作台侧早就两种都算了 —— 同一张证书在工作台显示「有证据」、在详情页显示「无证据」。现在按 `sourceCode` 分流:RECRUITMENT 看 Claim 图,ADMIN 数 `ownerType='certificate'` 的 Attachment(只数不取 key)。

  ### §3-2 · 撤掉 Policy 状态接口对 `RETIRED` 的放开(维护者拍板)

  §13.2 逐字是「激活 DTO **只允许 ACTIVE**」,而 DTO 多收了一个 `RETIRED`,上一行注释自己就写着「只允许 ACTIVE」—— 描述与执行位当场矛盾。更要紧的是它悄悄扩了业务语义:手动退役会让标准进入「有标准、无生效规则」状态,此后既不能建证也不能过审。那是一个真实的运营动作(「暂停认定」),需要自己的判权、审计与前端提示,不该由一次「顺手多接一个枚举值」带进来。真需要就单独立项。

  ### 两条随之翻面的旧断言

  §7 纪律要求「反向断言的寿命只到它锁住的事实成立那一刻;某刀让它过期,同刀必须翻面」。本刀翻了两条:「身份字段一律不在 PATCH 白名单」收窄为「`code` 与 `status` 永远不在」;「撤回理由写进 `reviewNote`」翻成「`reviewNote` 必须为 null」。另有两条因 R3 改变了可达性而重写(「被子节点引用 → 18032」经 API 已构造不出来,改直插构造以证明**守卫**没随可达性一起消失;审计三连拆成两条,因为「建→激活→删」在同一个标准上已走不通)。
