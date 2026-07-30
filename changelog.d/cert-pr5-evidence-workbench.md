- **证书证据读取 + 全局工作台(2026-07-30;证书标准库 PR-5,冻结稿 [`certificate-standard-library-t0-review.md`](docs/archive/reviews/certificate-standard-library-t0-review.md) §13.5 / §13.6 / §14 / §15.2 / §15.7)**:3 个新端点(Endpoint 435 → **438**,Controller 84 → **85**)。**零新增权限码**(恒 222):工作台复用 `certificate.read.record`,证据读取用 `certificate.read.sensitive`。

  | 面 | 端点 |
  |---|---|
  | 证据读取 1 | `GET /admin/v1/members/:memberId/certificates/:id/evidence-urls` |
  | 全局工作台 2 | `GET /admin/v1/certificates` · `GET /admin/v1/certificates/stats` |

  **§15.7 scope 先下推再计数**,这是工作台最容易写错的一格。可见组织范围与用户请求的 `organizationId` 取交集后进 SQL,再分页、再 `count`。先查后裁会让 `total` 泄露范围外的存在数量 —— 列表看不到那些行,计数却把它们算进去了。两处细节:交集为空时返「必然不成立的条件」而不是「不加条件」(后者把无权的人放成全库可见,是越权而不是少几行);scope 与 filter 用 `AND` 组合而非浅合并(两边都可能带 `member` 键,浅合并会让 filter 覆盖 scope,正好把范围条件整段丢掉)。

  **§14 `effectiveStatusCode` 不是第五个持久状态**:它不入库、每次读时按北京 today 算,所以**不依赖到期 cron 是否跑过**。`expired` 计数含第二个分支(`verified` 且 `expiredAt < today`)—— cron 每天 09:00 才翻态,只信持久状态会在它跑之前少算。e2e 造了一张「持久态仍 verified 但已过期」的证书正向锁住这一格:少了第二分支,`expired` 会是 0。

  **§15.2 出参白名单**:完整 `certNumber` / `verifyNote` / `verifiedBy` / `imageKeys` / signed URL / `sourceClaimId` **不在 select 里** —— 不是「取出来再剥掉」,而是根本没查。`q` 刻意**不搜完整证书编号**(L2 数据,可搜即可枚举);出参字段集用**精确 key 集合**断言(12 项),`objectContaining` 会放行任何新增字段,而工作台扩面正是泄露 L2/L3 的最短路径。

  **§13.5 证据读取的授权是两道**(维护者 2026-07-30 拍板走方案 A):入口要 scoped `certificate.read.sensitive`(证据图是 L3);`source=ADMIN` 那一支再经 `AttachmentsService.listByOwner`,它自带 `attachment.view` RBAC + 可读性过滤 + pinned ledger 解析。

  **为什么不给 attachments 加一个 certificate 专用 trusted 方法**:`listOwnerAttachmentsTrusted` 的注释里明写「仅限 content-\* owner;其余 owner 的读**必须**走 `attachment.view` RBAC」并且点名了 certificate。在那道护栏上开口换来的只是省一个权限码,代价是把一条明确的安全边界改成有例外的边界。**结果**:ADMIN 来源证据的读者需同时持 `certificate.read.sensitive` 与 `attachment.view`。

  其余 §13.5 约束逐条:TTL 300s(`Cache-Control: no-store` 由 controller 设 —— 少了它签名 URL 会进浏览器/代理缓存,TTL 到期后缓存副本仍可取出);签 URL 前重查权限与归属;**已软删证书 404 不签**;`accessUrl` 为 null 的项**直接丢掉而不是回退裸 key**(provider 或 ledger 状态不确定即 fail-closed);URL 不入审计(只记 `operation` 与 `sourceCode`)。

  **一条真实运行期耦合**,由 e2e 先红发现:ADMIN 分支要求 `attachment_type_configs` 里有一条 ACTIVE 的 `certificate` 记录。运维把它停用,证据读取会 **400 而不是返空数组**。那是正确的 fail-closed(配置不确定就不签),但值得知道 —— e2e 里写明了这一点。

  工作台的证据存在性判定用**整页一次 `groupBy`**:attachment 是多态归属(`ownerType`/`ownerId`,无 Prisma 关联),逐行 count 就是 pageSize 次往返。
