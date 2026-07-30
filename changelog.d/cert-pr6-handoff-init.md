- **前端交接与初始化收口(2026-07-30;证书标准库 PR-6,冻结稿 [`certificate-standard-library-t0-review.md`](docs/archive/reviews/certificate-standard-library-t0-review.md) §20.3 / §23 / §15)**:**纯文档刀** —— 零端点、零 schema、零权限码、零行为变更(Endpoint 恒 438)。

  两份新 SOP:

  - [`ops/certificate-standard-library-initialization.md`](docs/ops/certificate-standard-library-initialization.md) —— 首批 Standard/Policy 初始化。**本仓刻意不内置任何证书标准**:§20.3 把「创建 Standard 和 RecognitionPolicy」列为部署流程第 6 步、人工动作,因为「队里认哪些证书、认哪些发证机构、有效期几年、编号必填不必填」是业务拍板,不是代码默认值。内置了就等于替维护者拍板,而拍错的默认值会被当成事实用下去。含三组规则(`issuerPolicy` / `validityMode` / `certNumberMode`)对照表、8 步最小 smoke、以及两个顺序坑(`parentId` 只能在 create 设;ALLOWLIST 名单只在 DRAFT 期可整体替换)。
  - [`ops/certificate-evidence-retention-sop.md`](docs/ops/certificate-evidence-retention-sop.md) —— 证据(L3)留存与手动清理。第一条就是**证据的两个属主**:RECRUITMENT 来源在 Claim 上、ADMIN 来源在 Attachment 上,而 PR-4b 之后证书自己**没有** `imageKeys` 列。由此直接得出「`PROMOTED` 的 Claim 图**绝不可删**」—— 删了那张已发号证书的证据链就断了,Claim 不是临时暂存区。另有三条硬规矩:不引入 cron(两个槽位已满且自动化的收益远小于「cron 谓词写错静默删档案」的代价)、先删对象后清列(反了会留孤儿且 key 再也定位不到)、清理动作本身不写 key 到任何地方。

  两份交接文档补齐这一批**共七处对外契约破坏**:

  - [`handoff/admin-web.md §3.2`](docs/handoff/admin-web.md) —— 建证入参换 `standardId` + 按规则二选一的机构入参;出参去掉三个实例侧副本、加四个标准化引用;报名 DTO 的 `certificates` 摘要移除(改调专用 claims 端点);标门槛枚举 5 → 3。外加六条行为说明,其中三条最容易踩:「已收录、待认定」是正常状态不是坏数据;`effectiveStatusCode` 是展示状态、别当第五个持久状态存;ADMIN 来源证据的读者需**同时**持 `certificate.read.sensitive` 与 `attachment.view`(方案 A 的已知代价),且该分支依赖 `attachment_type_configs` 的 `certificate` 那条为 ACTIVE。
  - [`handoff/miniapp.md §2.9`](docs/handoff/miniapp.md) —— 公开上传换端点且语义从「按类别覆盖」变成一证一行;进度模型 `certificates` 从「每类别一条」变成「每条申报一行」(可空、可同类别多行);`my/certificates` 出参 12 → 14 字段、查询参数 `certTypeCode` → `certCategoryCode`。

  §23 里几条**后端无法强制**的前端约束一并写进交接(证据 URL 按需申请、不预加载、页面关闭即丢弃、不写 localStorage/sessionStorage、埋点禁止采集 URL 与表单值)—— 它们只能是约定,所以必须写在交接文档里而不是只留在评审稿。
