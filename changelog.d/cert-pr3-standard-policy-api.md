- **通用证书标准库与队内认定规则管理 API(2026-07-30;证书标准库 PR-3,冻结稿 [`certificate-standard-library-t0-review.md`](docs/archive/reviews/certificate-standard-library-t0-review.md) §13.1 / §13.2)**:13 个新端点(Endpoint 416 → **429**,Controller 81 → **83**)。**不改任何现有 Certificate / Recruitment 写路径** —— 那是 PR-4a。

  | 面 | 端点 |
  |---|---|
  | 证书标准 7 | `GET/POST /admin/v1/certificate-standards` · `GET .../options` · `GET/PATCH/DELETE .../:id` · `PATCH .../:id/status` |
  | 认定规则 6 | `GET/POST /admin/v1/certificate-standards/:standardId/recognition-policies` · `GET/PATCH/DELETE /admin/v1/certificate-recognition-policies/:id` · `PATCH .../:id/status` |

  **`/options` 接受四条入口码任一** —— 这是 PR-2 设计订正留下的硬要求。PR-2 为保住「业务面码集与 ops-admin 互不相交」这条架构不变量,把 8 条配置面码只绑了 ops-admin;而真正要用标准下拉的是持 `certificate.create/verify.record` 或 `recruitment-application.review.certificate` 的人。少了替代清单,biz-admin / org-admin 的建证下拉会**恒空且没有任何测试会红**。e2e 用一个只持 `certificate.create.record` 的窄角色正向证明它能读 options、且读 list 仍 30100(替代码不是万能钥匙)。

  **身份字段不可改做在契约层**:`UpdateCertificateStandardDto` 不含 `code` / `kind` / `categoryCode` / `levelCode` / `parentId` / `isInternal`,`forbidNonWhitelisted` 直接 400 —— 不依赖运行时判状态。DRAFT 期要改身份字段就删掉重建(DRAFT 可软删且必然零引用)。父子循环同理由**字段不可变性**保证:`parentId` 只在 create 可设,而新建行此刻没有任何后代,循环在结构上不可能形成,不需要环检测。

  **并发正确性不只靠 partial unique**(§5.3 固定锁序):所有改动「某 Standard 的 Policy 集合」的写路径先锁 Standard 行(`FOR NO KEY UPDATE`)。激活是「RETIRE 旧 + ACTIVATE 新」两步写,无行锁时两个事务可各自读到「当前 ACTIVE 是 v1」、各自 RETIRE v1 再各自 ACTIVATE 自己 —— 其中一个撞 unique 回滚,但**回滚前它已经 retire 了 v1**,在 READ COMMITTED 下另一个看不到这次回滚,最终可能「谁都没生效」。行锁把这个窗口整个消掉;partial unique 退居兜底(万一将来有人加了绕过行锁的新写路径)。e2e 用真 PostgreSQL 验:同一 Policy 并发激活恰好一个 200、另一个 18037,且无论谁赢 DB 恒只有一个 ACTIVE。

  **P2002 按索引名显式分流成两个码**(§5.3 第 7 步):`(standardId, version)` 撞 → `18039`(版本号被抢占,重取 MAX 再来);`one_active_per_standard` 撞 → `18040`(已有别的版本刚生效,刷新再决定)。两者语义与前端提示不同,不合并成一个「并发冲突」。

  **BizCode +15(280 → 295)**。号位已 grep 真源确认 22 个 180xx/181xx 零碰撞;其中三条是按真源补的、§18 建议表未列:`18019`(父子 category 不一致 / 成环)与上述两条并发兜底码。`18014/18016/18035/18038` 属实例写路径,留给 PR-4a —— 此刻加就是孤码。

  **audit 落 §17 两个高价值事件**,与 positions / dictionaries 等配置面「不落 audit」的既有范式**有意偏离**:一次 Policy 激活会改变此后所有新证书的认定依据(编号是否必填、有效期怎么算、认可哪些机构),而已锁定的历史证书又必须保持不变(D-CERT-008)——「谁在什么时候把哪版规则切上去了」是事后唯一能复原判断依据的线索。

  两处订正,都是 e2e / lint 先红抓到的:
  - status DTO 从 `@IsEnum` 改 `@IsIn`。`@IsEnum` **会放过 DRAFT**(它确实是枚举成员),而 `@ApiProperty.enum` 只是文档元数据不参与校验 —— 于是「不接受 DRAFT」这句话在契约层根本不成立,只能靠状态机兜 409。
  - 审计断言原用 `/certNumber/i` 宽正则,误伤了 §17 明确允许的 `certNumberMode`(那是规则名 REQUIRED/OPTIONAL/NONE,不是编号)。改为逐 key 精确比对禁字段,并正向断言 `certNumberMode` 在。

- **修 e2e 测试库重置漏表(PR-2 的遗漏)**:`test/setup/reset-db.ts` 的 TRUNCATE 列表补上 PR-2 的 4 张新表(55 → 59 张)。**实测证据**:逐字跑修复前那条 TRUNCATE,插入的 `CertificateStandard` / `CertificateRecognitionPolicy` / `CertificateRecognitionIssuer` 三行**全部存活**;只有 `RecruitmentCertificateClaim` 被 `recruitment_applications` 的 CASCADE 隐式带走。机理是 `TRUNCATE ... CASCADE` 只连带清「**引用**被清表」的表,而 `Certificate.standardId → CertificateStandard` 是 Certificate 引用 Standard,清 Certificate 清不到 Standard。后果是同一 worker DB 内跨 spec 累积 Standard 行,`options` 这类全量取回断言会随执行顺序时红时绿 —— 典型的「只在特定 spec 组合下才复现」的 flake 源。四张表现已显式列出(含 Claim,不再依赖隐式 CASCADE:那条依赖一旦被挪走就会静默失效)。修复后同样跑阳性对照:三张表 1/1/1 → 0/0/0。
