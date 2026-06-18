# 招新一期 系统性审查报告(review-then-fix · R0 冻结)

> **性质**:对「已落地的招新一期(招新前段)」做开报名前终检——只补正确性 / 健壮性 / 合规 / 安全,**不改业务语义**。本文件是 R0 冻结审查产物;R1 修复以维护者对「待决项」的拍板为准。
> **冻结时刻**:2026-06-18 · main HEAD `1b1785c9`(#378)· v0.24.0 · 0 open PR · 工作树 clean。
> **审查者视角**:对抗 / 默认「假设有 bug」逐维度找。行号已亲核(grep 锚点见 §DoD)。
> **权威源**:冻结评审稿 [`recruitment-phase1-review.md`](./recruitment-phase1-review.md)(下称「评审稿」)/ [`AGENTS.md`](../../../AGENTS.md) / [`current-state.md`](../../current-state.md)。

涉及面:`src/modules/recruitment/`(第 26 模块)· `src/modules/realname/`(第 25 模块)· `prisma/`(第 19 migration `20260618083340_add_recruitment_phase1` 3 表 + 2 手写 partial unique)。

---

## §0 结论 + 发现索引

**总判**:无高危;无业务语义缺陷;happy-path / 安全面 e2e(17+12 例)与契约一致。
存在 **1 个中危健壮性缺口(FM-A)** 值得在第一轮真开报名前修;其余为低危健壮性 / 合规硬化,可批量随修。
评审稿对 FM-A / FM-B / FM-C **三者均未讨论**——是**真实遗漏**,非「已接受风险」(逐字核对,见 §1/§9)。

| ID | 维度 | 严重度 | file:line | 修法档位 | 处置 |
|---|---|---|---|---|---|
| **FM-A** | ①事务原子性 | **中** | `recruitment-applications.service.ts:207→213→228` / `:355` | **设计级 → 待决** | **拍板修法后修** |
| **FM-B** | ③PII/合规 | 低 | `recruitment-applications.service.ts:139` vs `:150` / `:194` | B | 修(补偿删) |
| **FM-C** | ②并发 | 低 | `recruitment-applications.service.ts:415-420` / `:360` | B | 修(发号内原子校验) |
| **P3-enum** | ④公开面 | 低 | `recruitment-applications.service.ts:114` | —(语义) | **维持接受**(已登记 §4) |
| F-1 | ④公开面/DoS | 低-中 | `recruitment-public.controller.ts:85` | B | 修(补 multer `limits`) |
| F-2 | ②并发/⑥schema | 低 | `recruitment-cycles.service.ts:124-127` | 接受 / 可选 D | **待决**(接受 or DB 兜底) |
| F-3 | ⑥schema | 低(潜伏) | `recruitment.constants.ts:42` / 索引② | —(设计) | 接受 + 留痕 |
| F-4 | ④输入校验 | 低 | `recruitment-applications.service.ts:131-136` | 接受 / 可选 B | 接受(留痕) |
| F-5 | ⑦DTO | 低 | `recruitment.dto.ts:118-121` | —(设计) | 接受(留痕) |
| N-1 | ⑤realname | nit | `realname-crypto.service.ts:89-93` | B | 可选(死代码) |
| N-2 | ⑤realname/测试 | info | `providers/tencent-realname.provider.ts:156` | 可选 B | 可选(签名 golden-vector 测试) |

**已亲核为正确 / 健壮(无需动)**:TC3-HMAC-SHA256 手写签名(§5)· tempNo 行级原子发号 + partial unique 兜底(§2)· 去重 precheck + P2002 兜底(§2)· AES-256-GCM key/salt 隔离(§5)· settings 三态 + reset 仅 SA(§5)· 缺 key production-like fail-fast(§5)· 掩码完整性 + signed-URL L3(§3)· admin 每端点 `rbac.can`(§4)· audit union/placeholder/BizCode 段/两层身份/surface 5 前缀(§8)。

---

## §1 维度①:事务 / 失败原子性

报名 happy-path 的四个边界:**storage.putObject → tx1(建申请+审计)→ 付费 verify(事务外)→ tx2(发号/拒)**。

### FM-A(中危)——付费核验成功但 tx2 失败 → 钱已花 + 申请人硬卡死,无恢复路径

- **链路**:`recruitment-applications.service.ts:207` 付费 `realname.verify`(事务外,必须——外部调用不可入 DB 事务)→ `:213` 核验审计(独立写,**tx2 之前**)→ `:228` tx2(matched 发号 / mismatch 拒)。
- **失败窗口**:tx1(`:150`)已提交 → 行落 `pending_verification` 无 `tempNo`。此后任一步抛错:
  - `verify` 返回 matched(**已计费**)后,`:213` 审计写失败 → 整个 submit 抛错,tx2 永不执行;
  - 或 `:228` tx2 因 DB 抖动 / 瞬时错误失败。
  - 结果:**钱已花、状态停 `pending_verification`、无 tempNo**。
- **无恢复**:
  - 申请人重交 → `:114` precheck(`statusCode != rejected` 命中)或并发走 partial unique `:194` → `28003`,**挡死**;
  - 人工 resolve `:355` 仅认 `manual_review`,对 `pending_verification` 抛 `28040`(`:356`),**救不了**;
  - matched 结果仅存在于 `:213` 审计日志(可见但不可驱动状态机)。
  - **唯一出口 = 改库**。
- **频率/影响**:低频(需付费调用成功后亚秒窗口内的基础设施抖动);单次影响高(真金白银 + 一个真实报名者静默卡死,仅 DBA 能解)。
- **评审稿**:逐字核对**全文无任何**幂等 / 重试 / `pending_verification` 恢复 / 补偿 / 「失败即终态」的讨论——**真实遗漏**。
- **修法方向(设计级 → 见 §决策-1,R0 不自定)**:首选「人工 resolve 闸放开 `pending_verification`」——把 `:355` 的可解状态由 `{manual_review}` 扩为 `{manual_review, pending_verification}`,使卡死行变为 admin 可清(approve→发号 / reject;`:213` 审计已留 matched 证据供裁断)。**因触及状态机 surface,必须拍板。**

### 附属(同属 FM-A 面,随 FM-A 一并处置)
- `:213` 核验审计在 tx2 之外且之前:其写失败 = 计费后抛错 = 同卡死桶。
- 无幂等键:客户端在 tx1 后丢响应重试 → 被去重挡(`28003`)→ 无法续完。

### 已亲核为健壮
- tx1(`:150-191`)= create + submit 审计,**原子**;失败时 `:192` catch 把 P2002 → `28003`。✔
- 外籍链(`:201-204`)tx1 后即 return,不触付费,无 tx2 窗口。✔

---

## §2 维度②:并发

### FM-C(低危)——容量 TOCTOU + 人工发号零容量校验 → 可超发 `capacity`

- **TOCTOU**:容量闸在 submit 开头 `resolveOpenCycleOrThrow`(`:415-420`,`count(statusCode=verified)`),与真正发号(tx2 `:230`)**不同事务**。N 个并发 submit 全过闸 → 全发号 → 超 `capacity`。
- **人工旁路**:`resolveManual` 发号(`:360`)**完全无容量校验** → 人工 approve 可无条件超发。
- **影响**:低(容量由 admin 配置、招新单轮公开并发有限、超发数枚可人工纠);但确为既有不变量的原子性缺口。
- **评审稿**:未讨论 check-vs-issue 竞态(逐字核对)。
- **修法方向(B 档,非设计级)**:把容量校验下沉进发号事务——`issueTempNo`(`:427`)内 `cycle.update` 已对 cycle 行加锁,读自增后的 `tempNoSeq` 与 `capacity` 比较,超则抛 `28031`;tx2 与 `resolveManual` 共用。**语义微调留痕**:此举把「容量 = 已发号数(tempNoSeq,只增不减)」作为原子口径,与现「count(verified)」口径在软删后略有差异(tempNoSeq 不回退),需在 PR/§4 注明(不改对外语义,容量仍是容量)。

### 已亲核为健壮
- **tempNo 发号**:`issueTempNo`(`:427-433`)`cycle.update tempNoSeq+1` 由 Postgres 行锁串行 → 唯一序;partial unique `(cycleId, tempNo) WHERE tempNo IS NOT NULL` 兜底。✔(评审稿 E-R-9)
- **去重竞态**:precheck(`:114`)+ partial unique `(cycleId, idCardNumber) WHERE deletedAt IS NULL AND statusCode <> 'rejected'` → P2002(`:194`)→ `28003`。precheck 谓词与索引谓词**一致**。✔(评审稿 E-R-10)

### F-2(低危,待决)——E-R-11「至多一个 open 轮」仅 service 校验,无 DB 兜底

- `recruitment-cycles.service.ts:124-127`:开轮前 `count(其它 open)` > 0 则拒。此 count-then-update 在 Prisma 默认 read-committed 下**看不到并发未提交的兄弟**——两个不同 closed 轮并发开 → 都看到 0 → 都提交 → 两个 open 轮。
- **影响**:低(admin-only、低并发;`resolveOpenCycleOrThrow` 取 `createdAt desc` 最新一个,可人工关其一恢复)。
- **评审稿**:E-R-11 **明确按「service 层强校验」设计**(非 DB unique)——故缺 DB 兜底是**设计选择**,非缺陷;是否加固为**可选**。
- **修法方向(可选 D 档)**:`recruitment_cycles` 上常量表达式 partial unique `WHERE statusCode='open' AND deletedAt IS NULL`(全局至多一行 open)。**见 §决策-2。**

---

## §3 维度③:PII / 合规

### FM-B(低危)——证件照孤儿 blob:put 成功但 tx1 失败 → 永久无人管的身份证图

- `recruitment-applications.service.ts:138-139` `putObject` 在 tx1(`:150`)**之前**。tx1 失败(含并发撞去重 P2002 路径 `:194`、任何 DB 错误)→ 身份证照片留在 storage、**无 DB 行引用**。
- **留存 SOP 清不到**:[`recruitment-data-retention-sop.md`](../../ops/recruitment-data-retention-sop.md) 按 DB 行 `idCardImageKey` 删 blob(SOP 步骤 4),孤儿无行 = 不可达;SOP 自己承认「次序反了会丢 key 致 blob 成孤儿」,但**无任何 sweep / 前缀枚举 / 对账**步骤。
- **storage 层无 `listObjects`**(`storage.interface.ts` 仅 put/delete/upload-url/download-url/head;枚举留 v1.1)→ 当前**物理无法**按 `recruitment/id-card/{cycleId}/` 前缀找孤儿。
- **影响**:低但**合规味重**(私有桶内一张不可清理的身份证图;需 tx1 失败触发,不常见)。
- **评审稿**:未讨论孤儿(逐字核对;§6 留存设计假定 key-blob 对应永真)。
- **修法方向(B 档)**:复用现有 `:192` catch——重抛前 best-effort `await this.storage.deleteObject({key: idCardImageKey})`(吞删除错 + 记日志),覆盖 P2002 与 DB-error 路径。残留「put 与 tx1 间进程崩溃」窗口极小,接受。**无需 schema / 接口改动**(`deleteObject` 已存在)。

### 已亲核为健壮
- **掩码**:`maskIdCard`(前3后4)/ `maskName`(姓+*)/ `maskPhone`(前3后4)/ `maskOpenid`;审计 extra(`:183-187`、`:220-224`、`:392`)均走掩码。✔
- **signed-URL**:TTL 300s(`ID_CARD_IMAGE_SIGNED_URL_TTL_SECONDS`),L3 仅出参回显、不入日志/snapshot(`:337-338`)。✔
- **L3 不外泄**:realname settings 响应永不含 secret 明文/密文(DTO + 12 e2e 锁);settings 变更不写 audit_logs(沿 L-3 挂起,仅 pino)。✔
- **留存 SOP 字段覆盖**:NULL realName/idCardNumber/birthDate/phone/detailedAddress/emergencyContacts/profileExtra/idCardImageKey/openid/reviewNote(10,**超集**于评审稿 §6 的 7 个,更彻底)。✔(唯一缺口 = 孤儿 blob = FM-B)
- **身份证号 v1 明文入库**:维护者 2026-06-18 拍板留作审计痕迹,归 C-8 合规议题单独处理——**明确出本 goal 范围,非发现**(current-state §3)。

---

## §4 维度④:公开面安全

### F-1(低-中危)——证件照上传无 multer `limits`,5MB 校验前已全量入内存

- `recruitment-public.controller.ts:85` `FileInterceptor('idCardImage')` **无 `limits` 选项**;全仓亦无全局 multer / body-size 兜底(bootstrap 核对)。`image.size > 5MB` 校验在 service(`:131-136`)**之后**——即文件已被 multer memoryStorage **全量 buffer 进内存**才拒。
- **影响**:低-中。攻击者每请求携超大 body(GB 级)→ 内存压力;受 `@RecruitmentThrottle` IP 10/3600 限速缓解,但单 IP 一阵 10 发即可。busboy 默认 `fieldSize` 1MB 已护住 `payload` JSON 字段,**唯文件无界**。
- **修法方向(B 档)**:`FileInterceptor('idCardImage', { limits: { fileSize: ID_CARD_IMAGE_MAX_BYTES, files: 1 } })`。**注**:multer `LIMIT_FILE_SIZE` 抛 `MulterError`,需确保全局异常过滤器映射为 400(或就近 catch),否则裸 500——R1 需带此映射 + 一条超限 e2e。语义不变(超限仍拒,只是更早、且不再全量入内存)。

### P3-enum(低危,**维持接受**)——同轮去重前置于付费核验 → 可枚举「某身份证本轮是否已报名」

- `:114` 免费去重在付费 verify 之前 → 限流内可据 `28003` vs 正常流推断目标身份证是否已在本开轮报名。
- **已登记**:current-state §4 P3(维护者 2026-06-18 拍板「v1 接受不改实现」)——免费去重**必须**前置以省付费核验成本(评审稿 §4 / 配套① E-R-25 = 整个校验顺序的设计目的);泄露面窄(需已知**完整**身份证号 + 同一开轮)+ IP 10/3600 限速。
- **本轮复评结论**:**维持接受**。两种「修法」均越出「不改业务语义」红线——dedup-after-paid 直接摧毁配套①成本纪律;200 泛化改变公开端点契约 + 退化报名者 UX(查不到「你已报名」)。留痕备案,真实风险出现再单独评估。

### 已亲核为健壮
- **throttler**:`recruitment` 已注册 10/3600(`throttle-options.ts`);`ThrottlerBizGuard` 全局且**在 JwtAuthGuard 之前**;`@Public` **不**旁路 throttler;`setHeaders:false`(不泄阈值)。两个公开端点均挂 `@RecruitmentThrottle()`。✔
- **输入校验**:multipart `payload` 手动 `JSON.parse`(try/catch→40000)+ `plainToInstance` + `validate({whitelist, forbidNonWhitelisted})`(`:68-72`);全局 ValidationPipe 同样 `whitelist+forbidNonWhitelisted+transform`。✔
- **admin 每端点 `rbac.can`**:cycles 4(create/read/read/update)+ applications 4(read/read/read/resolve)+ realname 3(read/update/reset)= 11 端点全覆盖(service 层 `assertCanOrThrow`)。✔
- **IDOR**:admin 按 id 取任意行 = admin 语义正当;公开 `query` 锁本人 openid。✔

### F-4(低危,接受)——mime 仅信客户端 `Content-Type`,无 magic-byte 嗅探
- `:133` 校验 `image.mimetype`(multer 取自 part 的 Content-Type,客户端可控);无内容嗅探。影响低(私有桶 + 仅 admin signed-URL 取图)。修法 = 引 `file-type` 嗅探(新依赖)。**接受 + 留痕**(超出「不过度工程」边界)。

---

## §5 维度⑤:realname 通道

**全部亲核为正确 / 健壮**:

- **TC3-HMAC-SHA256 手写签名**(`tencent-realname.provider.ts:156-206`)——逐段核对腾讯云 v3 规范:
  - canonical request 形(`POST\n/\n\n<canonicalHeaders>\n<signedHeaders>\n<hashedPayload>`,header 全小写、字典序 content-type;host;x-tc-action)✔
  - `credentialScope = <UTC date>/faceid/tc3_request`,`date` 取 `timestamp` 的 UTC `YYYY-MM-DD`(与时间戳同源)✔
  - HMAC 链 `TC3+secretKey → date → service → tc3_request → stringToSign`✔
  - `X-TC-Action` 头送原样大小写、canonical 内小写(符合规范)✔ · secretKey 仅入 HMAC 不外泄、Authorization 不落日志 ✔
- **DevStub 确定性**(`dev-stub.provider.ts` / `realnameDevStubMatched`):校验位奇偶(X=10 偶)两路,确定性;只对已过 `isValidChineseId` 的大陆证件调用。✔
- **AES-256-GCM**(`realname-crypto.service.ts`):iv 12B 随机、authTag 16B、`scrypt(key, 独立 salt, 32)`;salt 与 sms/wechat/storage 不同(误配同 env 也派生不同密钥);decrypt 处理短包/篡改/key 错。✔
- **settings 三态 + reset 仅 SA**:`credentialConfigured`→`MISSING`,解密失败→`INVALID`,两段成功→`CONFIGURED`;`reset.credentials` 码不绑 ops-admin,仅 SA 短路(seed `:1079` filter + 12 e2e 锁)。✔
- **超时**:`AbortSignal.timeout(8000)`(沿 #346)。✔
- **缺 key fail-fast**:`app.config.ts:277-293` production-like(production|smoke)空 key 抛错退出 + ≥32 字符校验;dev/test 留空 → `isAvailable=false`,reset 时抛 `RealnameCryptoUnavailableError`→ 全局过滤器 500(仅 dev/test)。✔
- **错误映射**:`RealnameChannelUnavailableError`→27030 / `RealnameApiError`→27031(`realname.service.ts:52-60`);「不匹配」是返回值非异常(驱动状态机 rejected)。✔
- **通道选择 credential 兜底**:`resolve()` 对 TENCENT_CLOUD 不查 credentialStatus,但 provider `requireTencentContext`(`:141-146`)二次守护 `credentialStatus !== CONFIGURED`→27030(纵深防御)。✔(非 bug)

### N-1(nit)——`realname-crypto.service.ts:89-93` `Buffer.from(payload,'base64')` 的 try/catch 是死代码(base64 解码不抛);无害。可选清理。
### N-2(info)——tencent provider spec 以 mock fetch 锁结构,但**无**测试锁定 TC3 签名确切字节(确定性依赖 Date)。可选:加一条固定 timestamp/key 的 golden-vector 单测。低价值。

---

## §6 维度⑥:migration / schema

migration `20260618083340_add_recruitment_phase1`:

- **手写 partial unique ①**`(cycleId, idCardNumber) WHERE deletedAt IS NULL AND statusCode <> 'rejected'`——WHERE 与 service 去重谓词**逐字一致**(`:114-120`),允许 rejected 后同轮重试。✔
- **手写 partial unique ②**`(cycleId, tempNo) WHERE tempNo IS NOT NULL`——兜底并发发号。✔
- **索引**:applications(cycleId/statusCode/openid/deletedAt/createdAt)· cycles(year/statusCode/deletedAt/createdAt)合理。✔
- **FK**:`applications.cycleId → cycles.id ON DELETE RESTRICT`(防带报名删轮)。✔
- **tempNoSeq**`Int @default(0)`,事务内 `+1` 原子。✔
- **字段可空性**:敏感字段全 nullable(适配留存 NULL 化),与脱敏设计一致。✔
- **enum** `RealnameProviderType{DEV_STUB, TENCENT_CLOUD}`。✔

### F-3(低危,潜伏,接受)——tempNo 仅「轮内唯一」,非「年内唯一」
- partial unique ② 按 `(cycleId, tempNo)`;`formatTempNo`(`recruitment.constants.ts:42`)用 `cycle.year`。**同一年若开两轮**(E-R-11 允许串行多轮),两轮各自 `tempNoSeq` 从 1 起 → `T2026 0001` 在两轮**各存一份**,`T{year}` 命名空间跨轮碰撞。
- **影响**:低/潜伏。单年单轮是常态;tempNo 在 phase-1 仅本轮展示用;跨轮映射 = phase-2 promote(出范围)。
- **处置**:**接受 + 留痕**(修法 = 设计级:年内全局序 / 加轮次判别位,与 phase-2 编号方案耦合,出本 goal 范围)。phase-2 立项时一并定。

---

## §7 维度⑦:DTO / 契约

- **whitelist / forbidNonWhitelisted**:公开 submit 手动校验 + 全局 pipe 双重。✔
- **公开 DTO 不派生**:`RecruitmentApplicationPublicDto` 手定 self-scope 最小集(statusCode/tempNo/cycleName/meetingInfo/qqGroup/notifyTemplate),不含任何 PII。✔
- **Swagger 与实现一致**:各 controller `@ApiBizErrorResponse` 列与实际 throw 码吻合;contract 锁 10 招新 + 3 realname 路由。✔
- **错误码不漏敏感**:消息通用化;`27030/27031/28xxx` 不含 PII。✔
- **admin DTO PII 可见性**:`RecruitmentApplicationAdminDto` 列表掩码 / 详情全显——符合设计。✔

### F-5(低危,接受)——`profileExtra`(`recruitment.dto.ts:118-121`)`@IsObject()` 任意 JSON,无嵌套校验、whitelist 不剥内层键
- 设计如此(「本期最小」);存的是报名者自填数据、随留存清。影响低。**接受 + 留痕**。

---

## §8 维度⑧:与评审稿 / 铁律一致

- **BizCode 段**:27xxx realname 2 码(27030/27031)+ 28xxx recruitment 8 码(28001/28002/28003/28010/28011/28030/28031/28040);271xx/281xx 不开;「不匹配」非 BizCode。✔
- **audit union**:5 事件(cycle.create/update · application.submit/realname-verify/resolve-manual)注册于 `audit-logs.types.ts:90-94`(union 共 48);placeholder 2(read.other · id-card-image.read)注册于 `audit-placeholder.ts:94-95`(共 31)。✔
- **RBAC_MAP / CODEMAP**:8 招新 + 3 realname 码,128→136;reset.credentials 仅 SA、5 招新码绑 biz-admin、2 realname read/update 绑 ops-admin;`check-rbac-map.ts` + `biz-admin.fixture.ts`(硬编码 47 码)锁。✔
- **两层身份**:`tempNo` 绑 application,**永不进 members**;e2e ① 断言 members 零增长。✔
- **surface 5 前缀**:`open/v1` 首用;contract `CANONICAL_PREFIXES` 锁。✔

---

## §9 种子发现归类(全部已确认 + 分级)

| 种子 | 确认 | 严重度 | 评审稿是否预见 | 处置 |
|---|---|---|---|---|
| **FM-A** 付费核验事务外 / tx2 失败卡死 | ✔ `:207/:213/:228/:355` | **中** | **否**(逐字核对全文无恢复/幂等讨论)| 设计级修法 → **待决-1** |
| **FM-B** 证件照孤儿 blob | ✔ `:139` vs `:150`/`:194` | 低 | 否 | B 档补偿删 → 批准修 |
| **FM-C** 容量 TOCTOU + 人工发号无校验 | ✔ `:415-420`/`:360` | 低 | 否 | B 档发号内原子校验 → 批准修 |
| **P3** 去重前置可枚举(28003) | ✔ `:114` | 低 | 是(已登记 §4 接受)| **维持接受** |

---

## §决策(R0 不自定,拍板后入 R1)

### 决策-1(必答)· FM-A 恢复策略
- **选项 A(推荐)**:人工 resolve 闸放开 `pending_verification`——`:355` 可解状态扩为 `{manual_review, pending_verification}`。卡死行变 admin 可清(approve→发号 / reject);`:213` 审计已留 matched 证据供裁断。最小、复用既有审计 + 容量逻辑(并入 FM-C 修法即原子)。**代价**:触及状态机可解 surface(additive,不改 happy-path 转移)。
- **选项 B**:幂等化——核验前/后持久化「matched 待发号」可恢复标记,加恢复端点/job 不重复计费续发号。更复杂,改动面大。
- **选项 C(do-nothing)**:不改实现,补 DB-surgery runbook + 接受(无真实报名者 + 通道休眠,真开轮前再回看)。留风险但零代码。
- **倾向**:A(把硬卡死变 admin 可清,最小且复用审计闸)。

### 决策-2(可选)· F-2 E-R-11 是否加 DB 兜底
- **接受**(评审稿明确 service 层设计,admin-only 低并发)/ **可选 D 档**(常量表达式 partial unique 强制全局至多一 open 轮)。**倾向**:接受(不扩范围),除非维护者要硬不变量。

### 批准即修(无需逐项拍板,默认随 R1)
- **FM-B**(B):`:192` catch 内补偿 `deleteObject`。
- **FM-C**(B):容量校验下沉 `issueTempNo` 事务(tx2 + resolveManual 共用;tempNoSeq 口径留痕)。
- **F-1**(B):`FileInterceptor` 补 `limits.fileSize` + MulterError→400 映射 + 超限 e2e。
- **接受留痕**:P3-enum(维持)· F-3(tempNo 年内)· F-4(mime)· F-5(profileExtra)· N-1/N-2(可选清理/测试)。

> design-level(决策-1 尤甚)/ schema(决策-2 若选 D)/ 红区 / 不可逆 → 均待维护者拍板后才动,R1 不自作主张定设计。

---

## §DoD 自证(R0)

- **八维度全覆盖**:§1-§8 逐维有发现或「已亲核为健壮」结论;每条带 severity / file:line / 修法方向 / 档位。✔
- **种子全归类**:FM-A(中)/ FM-B(低)/ FM-C(低)/ P3(低·接受)见 §9。✔
- **行号亲核**(grep 锚点,2026-06-18):
  - FM-A:`grep -n` → verify `:207` · realname-verify 审计 `:214` · tx2 issueTempNo `:230` · resolve 闸 `:355-356` · resolve 发号 `:360` · issueTempNo `:427`。
  - FM-B:putObject `:139`(key `:138`)· tx1 `:150` · P2002 catch `:194`。
  - FM-C:capacity 闸 `:415-420`(count `:416` / 比较 `:419`)· resolveManual 发号 `:360`(无闸)。
  - F-1:controller FileInterceptor `:85`(无 limits)· service size 校验 `:131-136`。
  - F-2:cycles E-R-11 `:124-127`。
- **测试基线(R1「零改」锚)**:recruitment e2e 17 例 + realname-settings e2e 12 例 + realname unit 4 spec;happy-path / 安全面全覆盖;**失败/原子/孤儿/并发路径当前零覆盖**(R1 须补:FM-A 失败链 · FM-B 孤儿 · FM-C 并发 · F-1 超限)。
- **范围合规**:本 R0 仅只读审查 + 出本报告;零代码/schema 改动;业务语义零触碰。✔

---

*R0 冻结结束 → 人话简报回传 → 停等拍板(尤决策-1)。R1 修复以拍板为准,按档位拆最少 PR(B 档纯代码一批;若决策-2 选 D 则 schema 走 srvf-prisma-change 单独一刀)。*

---

## §R1 实施结果(2026-06-18 拍板后)

**拍板**(维护者,均按推荐):决策-1 = **FM-A Option A**(人工 resolve 放开 `pending_verification`);决策-2 = **F-2 接受现状**(不加 DB 兜底)。→ R1 = **单一 B 档纯代码批次,零 schema 变更**(migration 仍 19)。

### 已修(各带回归/边界测试)

| 项 | 改动 | file:line(改后) |
|---|---|---|
| **FM-A** | 人工 resolve 可解态 = `manual_review` ∪ `pending_verification`;审计 `before.statusCode` 改读实际前态;Swagger summary + 注释 true-up | `recruitment-applications.service.ts:361`(闸)/ `:396`(审计 before)/ admin controller summary |
| **FM-B** | tx1 catch 内 best-effort `safeDeleteOrphanImage`(`storage.deleteObject`,失败仅 warn 不掩盖原错) | `recruitment-applications.service.ts:196`(catch 补偿)/ `:450`(helper) |
| **FM-C** | 容量校验下沉 `issueTempNo` cycle 行锁内(自增后超 `capacity` → 28031,回滚撤销自增);tx2 + 人工 resolve 共用 | `recruitment-applications.service.ts:436-444`(`:442` 容量校验) |
| **F-1** | `FileInterceptor` 补 `limits:{fileSize, files:1}`;`all-exceptions.filter` 413→40000 | `recruitment-public.controller.ts:89`/ `all-exceptions.filter.ts:20` |

**FM-A ↔ FM-C 交互(已留痕)**:公开链路容量边界竞态的失败者(已过前置预检、已计费 verify、tx1 已落)在 tx2 撞容量 → 停 `pending_verification`。因 FM-A Option A,此态 admin 可恢复(reject 不受容量限,approve 受限)。比修前(静默超发 / 或 FM-A 硬卡死)严格更优;前置预检仍在常见串行场景免计费。**未改业务语义**:容量仍是容量,只是原子执行。

### F-2 / P3 / 其余接受项(留痕,未动代码)
F-2(E-R-11 DB 兜底)、P3(28003 枚举)、F-3(tempNo 年内唯一)、F-4(mime 信任)、F-5(profileExtra)、N-1/N-2 — 维持 R0 结论接受;§4 P3 行 + CHANGELOG 已留痕。

### DoD 自证(命令 + 计数,2026-06-18 亲核)
- `pnpm typecheck` ✔ · `pnpm lint`(--max-warnings 0)✔
- `pnpm test`(unit):**45 spec / 1477 passed**(44/1473 → +1 spec/+4:FM-B 孤儿补偿 spec)
- `pnpm test:e2e`(full):**95 suites / 1893 passed**(1889 → +4:recruitment 17→21)
- `pnpm test:contract`:**337 passed**(snapshot 仅 resolve summary 1 行 diff = Swagger↔实现 true-up)
- `pnpm docs:rbacmap:check`:0 FAIL(136 码、196 swagger 后缀一致)· `pnpm docs:codemap:check`:0 FAIL(recruitment service 516L < 700 god-service 线)
- **业务语义零变化**:happy-path①-⑩ + 安全面 e2e 断言零改;两层身份(members 零增长 ①)不变;无 schema/migration 变更(F-2 接受)→ 无重放/seed 二跑需求。
- **红区**:OpenAPI snapshot 1 行(resolve summary);无 baseline/AGENTS/RBAC_MAP/CODEMAP 计数变更(零新码/路由/模块)。

*R1 结束。系统性审查 + 统一修复闭环;报告冻结。*
