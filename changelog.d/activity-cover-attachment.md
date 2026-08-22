### Fixed

- 活动封面 / 图集改附件制(P2-14 刀 A;维护者 2026-08-22 拍板「按你建议:改成和内容模块一样」):同一个仓里此前有两套封面做法,活动用的是弱的那套 —— `Activity.coverImageUrl` 是**裸字符串**,把关的只有 `@IsString() @MaxLength(512)`,即「任何字符串都能当封面」。后果按严重度:①能填任意外站地址,外站换图 / 删图后封面变裂图或**变成别的内容**;②图不在本仓存储里,备份 / 迁移 / 清理 / 配额全都管不到;③也可能填站内签名链接,而签名链接**会过期** ⇒ 封面一张一张慢慢坏掉且没有任何告警;④无访问控制,该 URL 谁拿到谁能看、永不失效。`galleryImageUrls Json?` 同病且更松 —— 旧 DTO 连 `ArrayMaxSize` 和每项 `MaxLength` 都没有,是**无界数组 + 无界字符串**。本刀把两者改成与内容模块(`Content.coverImageKey` / `coverAttachmentId`)**逐字同形**的附件制:`Activity` 加 `coverImageKey` / `coverAttachmentId` / `galleryImageKeys` / `galleryAttachmentIds` 四列,写入必须给**本活动的 `activity` 类型附件 id**,读出一律 `resolveSignedUrlTrusted` 现签。响应字段名仍叫 `coverImageUrl` / `galleryImageUrls`,前端不用改字段名 —— 只是值从「死字符串」变成「活签名」。
- 顺带修掉一处既有不对称:`activity-proposal-validator.ts` 构造变更审核快照时,封面认 patch 而图集只认 current,两者语义相同却行为不同;现已一致(都只取 current —— 封面本就在「已发布可直改的展示字段」闭集里,从不进审核链)。

### Added

- `PUT /api/admin/v1/activities/{id}/cover` · `PUT /api/admin/v1/activities/{id}/gallery` · `PUT /api/app/v1/my/managed-activities/{activityId}/cover` · `PUT /api/app/v1/my/managed-activities/{activityId}/gallery`:设 / 清封面与图集。**复用既有 `activity.update.record` 权限码,零新增权限码** —— 改封面在语义上就是一次活动更新,它此前也确实是 PATCH 的一个字段。之所以必须是独立端点而不是继续做 create/update 的字段:附件必须已归属本活动(`ownerType='activity'` 且 `ownerId=<本活动 id>`),而**创建活动那一刻活动还不存在**,附件不可能已归属它 —— create 上的封面字段在结构上不可能被正确校验。对照组 `Content` 正是因此把封面单独做成端点(`CreateContentDto` / `UpdateContentDto` 一个 cover 字段都没有)。使用顺序:建活动(draft)→ 以 `ownerType='activity'` 走通用附件接口上传 → 设封面。四条路由委托**同一个** `ActivityCoverService`,校验只有一份。
- `AppManagedActivityProjectionDto` 补 `coverImageUrl` / `galleryImageUrls` 两个只读字段(纯加法):改造前 App managed 面**能写封面却读不回来**,新端点返回该 DTO 时调用方看不到自己刚设的东西。
- `src/modules/activities/activity-image-reference.criteria.spec.ts`:**结构性**扫描活动模块全部 TS 源,断言可写 DTO 上**不存在任何** `*ImageUrl` / `*ImageUrls` 形状的字段 —— 发现面是「形状」不是「名字清单」,下一个 `bannerImageUrl` / `posterImageUrls` 同样会被抓。「可写」的判据是「带 class-validator 装饰器」而不是「类名里有 Create/Update」:全局 ValidationPipe 开了 `whitelist` + `forbidNonWhitelisted`,没有校验装饰器的属性根本进不来,所以「带校验装饰器」恰好就是「能被请求体写入」的结构性定义;只带 `@ApiProperty` 的响应字段不会被误报(出参的 `coverImageUrl` 是现签 URL,那是本刀想要的结果)。配真阳性 + 假阳性两条自证,外加「扫描面非空」地板锚点(防「目录挪走 ⇒ 零命中 ⇒ 判据自动全绿」)。
- `test/e2e/activity-cover-attachment.e2e-spec.ts`:承担结构判据证明不了的几格 —— 越权取证(拿 A 活动的附件 id 去设 B 活动封面 → 404,且 B 的封面列没被写;图集混入外来 id 则**整笔**拒绝、合法项也不落库)、读出侧确实是签名 URL 且**随附件过期变 null**(与内容模块 `content-public.e2e-spec.ts` 同一条口径)、图集顺序即展示顺序且两列逐位对齐、`activity_gallery_arrays_aligned_check` 在数据库里真的在挡(`$executeRawUnsafe` 写不等长两列 → 23514,钉到约束名)。⚠️ 越权那条**必须**是真跑的 e2e:归属判定现在跨了 controller → `ActivityCoverService` → `AttachmentsService` facade → boundary 纯函数四层,spy 挂在任何一层薄委托上都可能「不报错也不被调用」。
- `AttachmentsService.findOwnedAttachmentsTrusted` / `lockOwnerReferenceStorageBoundaryTrusted`:owner-generic 的归属查询与写入围栏。内容模块原有的 `lockContentReferenceStorageBoundaryTrusted` 改为它的薄包装,**两个模块走同一份实现** —— 另写一份的代价不是重复代码,是两份对「什么算合法封面」的理解会各自漂移,而漂移时没有症状。归属查询之所以必须住在 attachments 模块里:附件归属是附件域的事实,活动模块自己 `tx.attachment.findMany` 是跨域直读,架构债棘轮当场判 `cross-domain-fact-read-candidate`(本刀初版就是这么被拦下的)。

### Changed

- **⚠️ 破坏性(写入侧)**:`POST/PATCH /api/admin/v1/activities` 与 `POST/PATCH /api/app/v1/my/managed-activities` 的请求体**不再接受** `coverImageUrl` / `galleryImageUrls`。全局 `forbidNonWhitelisted` 会把它们判成 **400**,而不是静默忽略。旧调用方必须改走上面四条新端点。读出侧字段名与类型均不变(`coverImageUrl: string | null`、`galleryImageUrls: string[]`),故只有**写**的调用方受影响。`srvf-admin-web` 尚未真正投用,这是成本最低的改造窗口。
  - ⚠️ **契约闸对这一类破坏是失明的**:`pnpm gate:contract:semantic` 读数为 `breaking=0 additive=16` —— 它把「删掉一个可选请求字段」看成非破坏(schema 层面确实只是少了一个 optional property),看不见 `forbidNonWhitelisted` 让旧请求从 200 变 400 这件事。因此本刀**没有**填 `contract-breaking` 申报块(填了反而会让闸红:`judgeDeclarations` 对「申报了但 diff 里没有 breaking」判 problem),破坏性只能靠本条散文交代。这是判据缺口,不是本刀的敞口。
- `Activity` 的旧列 `coverImageUrl` / `galleryImageUrls` **保留但已零写入路径**,读出侧一律不再读它们(刀 B 才 DROP,给「发现漏迁」留一个可回退窗口)。
- 克隆活动**不再复制**封面与图集:附件按 `(ownerType, ownerId)` 归属源活动,把源活动的 attachment id / key 抄进克隆件就是造出一条「B 活动引用 A 活动的附件」—— 那正是本刀越权闸要拦的形状,从写入口拦住却从克隆口放进来等于闸形同虚设。克隆件是 draft,重新上传并设封面即可(与内容模块 clone 不复制附件同型)。

### Database

- `20260822120000_activity_cover_gallery_attachment_expand`:expand-only,`Activity` 加 4 列 + 1 条手写 CHECK,**零回填、零 DROP、零 RENAME、零既有行重解释**。
  - 图集两列的逐位对齐由 `activity_gallery_arrays_aligned_check` 在**数据库层**兑现,不是应用层约定 —— 应用层约定漂移时没有症状。⚠️ 其中 `IS NOT NULL` 守卫**必须前置**:Prisma 的 `String[]` 在 PG 侧落成**可空**列(与 `contents.tags` 同形,`information_schema` 实测 `is_nullable=YES`),而 SQL 的 CHECK 在表达式求值为 NULL 时**判通过**。scratch 库双向变异实测:朴素式 `cardinality(a) = cardinality(b)` 下 `(NULL, ARRAY['x'])` 这一行**静默入库**;换成守卫前置式后同一行被 23514 拒、长度不等的行被拒、合法行照常放行。与 §3.23.6 `recognized = credited + cappedOut` 是同一类缺陷,处置手法照抄。
  - **旧数据交代**:`coverImageUrl` / `galleryImageUrls` 的非空计数,本机四个库(`app_test` / `app` / `app_membersv2_dev` / `app_migration_dev`)实测**均为 0**(`app` 有 21 行活动,两列全空)。项目尚未上线、无生产库,故本刀零迁移策略、零数据丢弃。⚠️ 读数来自**本机 Docker 测试 / 开发库**,不代表任何其它环境。⚠️ goal 给的探针 SQL 写的是 `FROM "activities"`,而实际表名是 `"Activity"`(该模型无 `@@map`)—— 照抄会 `ERROR: relation does not exist` 而不是返回 0,「读数 0」将是假读数。
