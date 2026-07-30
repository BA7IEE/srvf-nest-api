- **上线 SOP 顺序订正 + 留存字段补齐 + 初始化示例拆标准 + 台账回填(2026-07-30;证书标准库跨模型评审 findings F6)**:纯文档刀,零代码、零 schema、零契约变化。

  ### V9 · 上线 SOP 的执行顺序是错的

  原顺序 `① 探针 → ② 停止写入 → ③ migrate deploy`。探针证明的是**跑那一刻**库里没有会被 DROP 的数据 —— 如果此后还能写入,探针到停写之间那个窗口里进来的任何一行都会被不可逆地删掉,而「探针全 0」的记录会让人以为已经证明过没有数据。**探针的结论只有在库冻结之后才成立。**

  且备份原本根本不在有序步骤里(只在正文别处提过一句)。这批 migration 会 DROP 七列,一旦发现探针漏判,唯一退路就是备份 —— 而一个没验证过能恢复的备份等于没有备份。

  新顺序:`停写 → 备份并当场确认可恢复 → 在冻结后的库跑探针 → 任一非 0 立即停 → migrate deploy → 结构复核`。

  ### R11 · 留存 SOP 只清了最显眼的那一项

  清理 SQL 原本只 `imageKeys = NULL` + `sensitivePurgedAt = now()`,把申报里其余再识别字段全留下了。证书编号(L2,可用于外部查询或冒用)、发证机构、发证日 / 到期日三者合起来足以定位到一个具体的人。

  更糟的是 SOP 的筛选条件是 `sensitivePurgedAt IS NULL` —— **打上标记之后这一行永不再被扫到**,漏清的字段会永久残留。这正是 promote 路径 F12 踩过的同一个坑。

  补齐 `certNumber` / `issuingOrg` / `issuedAt` / `expiredAt` / `rawCertificateName` / `reviewNote`;明确**不清** `standardId` / `recognitionPolicyId` / `status`(它们是「当时被判成什么」的档案,不含再识别信息)。

  另补一条**删除失败的重试口径**:存储侧删对象是 best-effort,只对确认删成功的 id 打 `sensitivePurgedAt`,失败的保持 NULL 让下一轮重新扫到 —— 这就是重试机制,不需要额外账本。判断依据只有一条:**`sensitivePurgedAt` 非空 = 这一行的敏感字段确实已经清干净了**。

  ### R12 · 初始化示例把两种证书揉进了一个标准

  示例把「深圳市红十字会」与「深圳市急救中心」放进同一个 `red_cross_first_aid` 的 issuer 名单。它们是**两种不同的证书**,只是同属 `first_aid` 大类 —— 培训内容、有效期、复训要求都不一样。维护者口径逐字:**「急救资质是大类,不等于红十字证书。」**

  改为两个 Standard、同一个 `categoryCode`(`red_cross_first_aid` / `emergency_center_first_aid`)。`criterionType=category&criterionCode=first_aid` 的资质判定两张证都算数,要精确到某一种就用 `criterionType=standard` —— 这正是 F4 两级判据存在的理由。

  同时补上判据:**什么时候才该把多个机构放进同一个名单** —— 同一张证书由多家机构联合或分区签发时。判据是「持证人拿到的是不是同一张证」,不是「都属于同一个大类」。

  初始化文档另同步 A-3(DRAFT 期可改身份字段)并加了一条醒目警告:**`code` 打错一个字就永远用不了了**(含软删行的 unique),那是整份文档里最不可逆的一步。

  ### amendments 文件 + 台账回填

  新建 [`certificate-standard-library-t0-amendments.md`](docs/archive/reviews/certificate-standard-library-t0-amendments.md):冻结稿正文**一个字不改**,post-freeze 的 8 条修正(A-1…A-8)逐条记「原文 / 改为 / 理由 / 触发来源」。冻结的价值在于「当时到底是怎么定的」可复原 —— 回改正文会让所有引用它的 PR 描述、审计记录和评审结论指向一份已经不同的文本。**两份合起来才是当前需求,冲突以 amendments 为准。**

  [`docs/README.md`](docs/README.md) 已登记该文件并把冻结稿从「已冻结未实施」移出;[`current-state.md`](docs/current-state.md) §2 补证书标准库能力指针 + 三份 ops runbook,§4 补三条 P1 债务(不可逆 migration 未部署 / 契约破坏未发版 / 首批标准未建);[`NEXT_TASKS.md`](docs/ai-harness/NEXT_TASKS.md) P1-24 从「下一个开工的 Goal」改为已交付 + F1–F6 修复批次状态 + 四条剩余挂账。
