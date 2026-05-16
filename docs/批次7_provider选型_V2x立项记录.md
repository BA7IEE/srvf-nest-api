# 《C-7.5 Provider 选型 V2.x 立项记录(批次 7.5)》

> **状态(2026-05-16 实施收口)**:✅ **C-7.5 Provider 实施已完成,待 v0.11.0 版本收口**。8 个实施 PR 全部 squash merge(#86-#93,含 P1 技术债 PR #92);腾讯云 COS Provider + LocalProvider + 动态路由 + AES-256-GCM 凭证加密 + signed URL 直传 + 后台凭证管理全部就位;`accessUrl` 已真实化;upload-url + confirm-upload + storage-settings 5 端点全部落地;**版本号 bump / git tag / GitHub Release / handoff 留独立 PR + 维护者手动**。
>
> **历史状态(2026-05-16 立项)**:🎯 C-7.5 Provider 选型 v1.0 已冻结(PR #84 `f8b357d`),V2.x implementation track 启动。立项 PR #85 合并即解除 V2 §18 调研期硬禁止(针对 Provider 实装范围)。
>
> **批次号**:C-7.5 Provider 选型(批次 7.5;接续 C-7 attachments 的 Q14 / Q15 挂起项)
> **撰写日期**:2026-05-16(立项 PR #85;实施收口 landing PR 本 PR)
> **接续(设计阶段)**:
> - PR #82 C-7.5 v0.1 草稿(squash commit `6dbdbed`,2026-05-15;5 项 F + 5 项 B 锁 + 15 项 Q 待评审)
> - PR #83 C-7.5 v0.2 局部收口 + 架构修订(squash commit `8d19a07`,2026-05-15;锁腾讯 COS + 14 项 Q;新增 Q20-Q25 架构修订;13 PR → 14 PR)
> - PR #84 C-7.5 v1.0 冻结(squash commit `f8b357d`,2026-05-16;**35 项决议全部就位**:F 5 + B 5 + Q 25;Q5 / Q6 / Q7 接口与 DTO 锁 + Q8 TTL 升级锁)
> - PR #85 V2.x 立项 PR(squash commit `5e12511`,2026-05-16;本文件初始版本)
>
> **接续(实施阶段;8 PR 累计;2026-05-15 ~ 2026-05-16 集中落地)**:
> - PR #86 实施 #5:`chore(storage): extend StorageProvider interface for C-7.5 v1.0`(squash commit `fc8241d`;F5 落地 +3 方法 +5 类型;0 实装)
> - PR #87 实施 #6:`chore(prisma): add storage_settings schema and config reader for C-7.5 v1.0`(squash commit `45ae871`;15 字段 + 2 enum + 1 migration + StorageSettingsService + StorageCryptoService AES-256-GCM)
> - PR #88 实施 #7:`feat(storage): add LocalStorageProvider for C-7.5 v1.0`(squash commit `bceba0f`;5 方法 + 16 unit + Symbol DI token)
> - PR #89 实施 #8:`feat(storage): add CosStorageProvider with dynamic router for C-7.5 v1.0`(squash commit `f44310c`;5 方法 + Router 动态路由 + 32 unit + 引入 `cos-nodejs-sdk-v5@^2.15.4`)
> - PR #90 实施 #9:`feat(attachments): wire storage provider into attachment accessUrl and delete flow`(squash commit `119778c`;7 调用点 await + delete 事务外 tryDeleteFromProvider + accessUrl description 微调)
> - PR #91 实施 #10:`feat(attachments): add upload-url and confirm-upload APIs`(squash commit `527aa47`;2 端点 + 3 DTO + uploadToken HMAC-SHA256 + 28 e2e + 18 upload-token unit)
> - PR #92 P1 技术债:`chore(prisma): add unique constraint for attachment key`(squash commit `fc08d17`;承接 PR #91 已知偏差;1 migration;并发 replay 防御)
> - PR #93 实施 #11:`feat(storage): add Storage Settings admin APIs and credential reset`(squash commit `85cae45`;3 端点 + 3 DTO + 30 e2e;0 BizCode / 0 audit;Q-11-1 到 Q-11-19 全落地)
>
> **本 landing PR 边界**:仅文档 4 处(本立项记录 §状态头 + §四 PR 拆分实际完成清单 + §六合并后下一步状态更新 + TASKS.md §9 + V2 红线 §4.3 C-10 行 + CHANGELOG `Unreleased` `### Added` + `### Docs`)。**不动代码 / schema / migration / 依赖 / 版本号 / git tag / Release**。

---

## 一、立项背景

### 1.1 已完成的设计阶段

C-7.5 Provider 选型的设计阶段已**全部完成**(沿 PR #82 → #83 → #84 三段):

| 阶段 | PR | squash commit | 状态 |
|---|---|---|---|
| C-7.5 v0.1 草稿 | #82 | `6dbdbed` | ✅ 已合并(5 项 F 锁 + 5 项 B 锁 + 15 项 Q 待评审) |
| C-7.5 v0.2 局部收口 + 架构修订 | #83 | `8d19a07` | ✅ 已合并(锁腾讯 COS Q1/Q4 + 14 项 Q;新增 Q20-Q25 架构修订;13 PR → 14 PR) |
| **C-7.5 v1.0 冻结** | **#84** | **`f8b357d`** | ✅ **已合并(2026-05-16);35 项决议全部就位**(F 5 + B 5 + Q 25)|

### 1.2 已锁定的 35 项决议(沿 C-7.5 v1.0)

完整决议表见 [`docs/批次7_provider选型_API前评审.md §19`](批次7_provider选型_API前评审.md)。

**F 类(框架级骨架,5 项;v0.1 用户拍板;v0.2 沿用锁定)**:

- **F1** 本 Provider 选型评审独立进行,**不回改 D7-attachments v1.0 冻结稿**
- **F2** 生产推荐 **signed URL 模式(B)**;dev / test 推荐 **LocalProvider(D)**(沿 §4)
- **F3** 存储后端**国内合规优先**(腾讯 COS / 阿里 OSS 二选一);若队组织已有云资源,优先复用;v0.2 已具体化为腾讯 COS
- **F4** 删除策略 = **同步尝试 + 失败 logger.warn + Provider lifecycle / versioning 兜底**;**不引入队列**(沿 V1.1 §17.3 / §5)
- **F5** `StorageProvider` 接口扩展方向 = **6 方法**(`putObject` / `deleteObject` 沿用 + `generateUploadUrl` / `generateDownloadUrl` / `headObject` 新增;沿 §7)

**B 类(沿 v0.1,5 项;v0.2 沿用锁定)**:

- **B1** **暂不新增 schema 字段**(沿 D7-attachments v1.0 `key` / `etag` / `checksum` / `accessLevel` / `expireAt` 够用)
- **B2** API 候选新增 **upload-url + confirm-upload** 2 个端点;**不动现有 7 个 attachments 端点 paths / 入参 / 出参 schema**
- **B3** **RBAC 不新增权限点**;沿现有 20 条 `attachment.*`(沿 D7-attachments Q11)
- **B4** **audit 不新增 event**;仅 `attachment.upload` / `attachment.delete` 的 `extra` 扩展 Provider 信息(`providerDeleteStatus` / `uploadConfirmedAt`;沿 D11 路线 A 单事件 + extra)
- **B5** PR 拆分先按 **13 PR 设计节奏**(沿 v0.2 架构修订实际为 14 PR;建议;实施期允许微调)

**Q 类(v0.2/v1.0 锁定 25 项)**:

- **Q1**(v0.2 锁):业务方既有云资源 = **腾讯云**
- **Q2**(v0.1 锁):上传模式 = 生产 B + dev D;C STS 不采用(沿 Q19)
- **Q3**(v0.1 锁):删除策略 = **C + D**(同步 + 告警 + COS lifecycle 兜底)
- **Q4**(v0.2 锁):存储后端 = **腾讯云 COS**(沿 Q1;不再 OSS 候选)
- **🆕 Q5**(v1.0 锁):`StorageProvider` 接口签名细化 = `expiresIn = number(秒)`(Q5a)/ `headers: Record<string, string>` 必填可空对象(Q5b)/ `UploadUrlResult.method = 'PUT' | 'POST'` 联合保留默认 `'PUT'`(Q5c)
- **🆕 Q6**(v1.0 锁):`POST /upload-url` DTO = 入参 5 字段(`ownerType` / `ownerId` / `originalName` / `mime` / `sizeBytes`)+ 出参 6 字段(`key` / `uploadUrl` / `uploadHeaders` / `uploadMethod` / `expiresAt` / **`uploadToken`** HMAC-SHA256);Q6a key 后端生成 / Q6b 不落 pending row / Q6c-Q6e ownerType+mime+size+PII 校验全做
- **🆕 Q7**(v1.0 锁):`POST /confirm-upload` DTO = 入参 1 必填(`uploadToken`)+ 1 可选(`checksum` sha256 64-hex);出参 `AttachmentResponseDto`(沿现有 PR #6b);Service 流程 6 步(验签 / headObject / size 一致性 / PII 不重做 / 落库 + audit / generateDownloadUrl 填 accessUrl)
- **🆕 Q8 升级**(v0.2 锁 → v1.0 升级锁):`accessUrl` 签名过期 TTL 默认值 upload = 600s / download = 300s;**实际值由 `storage_settings.uploadUrlTtlSeconds` / `downloadUrlTtlSeconds` 后台配置**(沿 Q20);取值范围:60 ≤ uploadTtl ≤ 3600;60 ≤ downloadTtl ≤ 1800
- **Q9**(v0.2 锁):是否新增 `uploadState` schema 字段 / 独立 `attachment_upload_tokens` 表 = **A 不新增**(沿 B1;客户端用 signed token + confirm-upload 一次性落库)
- **Q10**(v0.2 锁):PII 检测是否在 confirm-upload 重做 = **A 不重做**(upload-url 已检;confirm-upload 不接受 originalName 等 PII 字段重传)
- **Q11**(v0.2 锁):Provider versioning + lifecycle 具体配置 = COS versioning 启用 + 旧版本 30 天 expire + DeleteMarker 即清除 + 7 天 abort incomplete multipart
- **Q12**(v0.2 锁):加密配置 = **COS SSE-COS**(腾讯云原生;`AES256`);❌ 不启用 SSE-KMS / SSE-C
- **Q13**(v0.2 锁):大文件 multipart upload 支持 = **本批次不实施**(单文件 ≤ 5GB 走 PUT signed URL);留 v1.1 / 实施期评估
- **Q14**(v0.2 锁):跨域 CORS 配置 = 生产白名单 origin + `PUT/GET/HEAD` + `MaxAge=3600`;❌ 不允许 `*` 通配
- **Q15**(v0.2 锁):Provider 切换 / 跨 Provider 迁移路径 = **COS 暂不迁移**;`StorageProvider` 接口抽象保证未来可平移(沿 S3 兼容协议)
- **Q16**(v0.2 锁):私有桶 vs 公有桶 = **私有桶**;所有访问 100% 走 signed URL;**永不开放公有读**
- **Q17**(v0.2 锁):key 命名规范 = `attachments/<env>/<yyyy>/<mm>/<dd>/<cuid>.<ext>`
- **Q18**(v0.2 锁):bucket 环境隔离 = **单 bucket + key 前缀**(`dev` / `test` / `prod`);多 bucket 备选留 v1.0 / 实施期
- **Q19**(v0.2 锁):是否采用 STS 临时凭证 = **不采用 STS**(沿 F2 模式 B + Q13);未来 multipart 需要时 v1.1 / 实施期再评估
- **🆕 Q20**(v0.2 架构修订锁):COS 是否支持后台配置 = **✅ 是**;主路径 = `storage_settings` 后台配置读取;env 仅作 bootstrap fallback / dev / test 兜底;**不长期依赖 env**(沿 Q23)
- **🆕 Q21**(v0.2 架构修订锁):凭证 SecretId / SecretKey 是否允许后台录入 = **✅ 是**;**必须加密存储**(`secretIdEncrypted` / `secretKeyEncrypted` 列;AES-256-GCM 候选;加密 key 单独存 env);**明文永不入 DB / 日志 / audit_logs**
- **🆕 Q22**(v0.2 架构修订锁):凭证是否允许 API 明文返回 / UI 回显 = **❌ 否**;API 不返加密密文;API 不返明文;UI 形如 `已配置 ✅` / `********`;只允许 reset / replace;`credentialStatus ∈ {configured, missing, invalid}` 状态化
- **🆕 Q23**(v0.2 架构修订锁):是否长期依赖 env = **❌ 否**;env 仅允许 bootstrap fallback / 首次系统未初始化时兜底 / 本地开发环境;**例外**:加密 key(`STORAGE_ENCRYPTION_KEY`)允许长期存 env(沿 v1 `JWT_SECRET` 范式;加密 key ≠ 凭证)
- **🆕 Q24**(v0.2 架构修订锁):`storage_settings` schema 是否一次设计完整 = **✅ 是**;15 字段一次性设计完整;**允许首期闲置部分字段**(`corsAllowedOrigins` / `maxObjectSizeBytes`);**严禁未来推翻 schema 重做 migration**(允许新增,不允许重命名 / 删除既有字段)
- **🆕 Q25**(v0.2 架构修订锁):是否首期一次做完 = **❌ 否**;**实施分批**(沿 §16 PR 6-14 共 9 个实施 / 收口 PR);PR 6 先做 schema + 配置读取层(不接 SDK)→ PR 7-10 逐步接入 → PR 11 后台 CRUD

### 1.3 决议表汇总

| 类别 | 数量 | 备注 |
|---|---|---|
| 🔒 v1.0 已锁 | **35 项** | F 5 + B 5 + Q 25 |
| ⏳ 待决议 | **0 项** | v1.0 冻结完成 |
| ⏸ 留 v1.1+ 评估 | 2 项 | uploadToken 重放防御 / 失败回滚 Provider 文件 |

**v1.0 冻结完成度**:**100%**(Provider 选型 + 架构设计 + 接口 + DTO + TTL 全部就位)。

### 1.4 已建立的基础设施

- [`docs/批次7_provider选型_API前评审.md`](批次7_provider选型_API前评审.md):C-7.5 v1.0 冻结稿(35 项决议 + 接口 + DTO + storage_settings 架构 + 凭证安全边界 + 14 PR 节奏)
- [`docs/批次7_attachments_V2x立项记录.md`](批次7_attachments_V2x立项记录.md):C-7 attachments 立项记录(本立项 PR 风格参照)
- [`src/common/storage/storage.interface.ts`](../src/common/storage/storage.interface.ts):v1 极简版骨架(`putObject` / `deleteObject`;沿 §18.2)
- [`src/common/storage/storage.types.ts`](../src/common/storage/storage.types.ts):v1 极简版类型(`PutObjectInput` / `StoredObject`)

---

## 二、立项内容(C-7.5 Provider 选型实施范围)

### 2.1 `storage_settings` 配置表(Q20-Q24)

| 字段 | 类型 | 用途 |
|---|---|---|
| `id` | cuid | 主键(预期单行) |
| `provider` | enum | `LOCAL` / `COS`(未来扩展 OSS / R2) |
| `bucket` | string | COS bucket 名 |
| `region` | string | COS region(如 `ap-shanghai`) |
| `endpoint` | string? | 自定义 endpoint(可空;默认走 SDK) |
| `keyPrefix` | string | 路径前缀(默认 `attachments`;沿 Q17) |
| `secretIdEncrypted` | bytes | AES-256-GCM 加密;明文永不入库 |
| `secretKeyEncrypted` | bytes | AES-256-GCM 加密;明文永不入库 |
| `credentialStatus` | enum | `configured` / `missing` / `invalid`(沿 Q22) |
| `uploadUrlTtlSeconds` | int | upload signed URL TTL;默认 600;范围 60-3600(沿 Q8) |
| `downloadUrlTtlSeconds` | int | download signed URL TTL;默认 300;范围 60-1800(沿 Q8) |
| `corsAllowedOrigins` | string[]? | 首期闲置(运维侧 COS 控制台配置;沿 Q14 / Q24) |
| `maxObjectSizeBytes` | bigint? | 首期闲置(沿 Q24;实际走 `attachment_size_limit_configs`) |
| `createdAt` | DateTime | 时间戳 |
| `updatedAt` | DateTime | 时间戳 |

**Q24 锁**:15 字段一次性设计完整,首期允许闲置 2 字段(`corsAllowedOrigins` / `maxObjectSizeBytes`),**严禁未来推翻 schema 重做 migration**。

### 2.2 `StorageProvider` 接口扩展(F5 / Q5)

| 方法 | v1 状态 | v1.0 锁后 |
|---|---|---|
| `putObject(input: PutObjectInput): Promise<StoredObject>` | ✅ 已存在 | 沿用 |
| `deleteObject(key: string): Promise<void>` | ✅ 已存在 | 沿用 |
| `generateUploadUrl(input: GenerateUploadUrlInput): Promise<UploadUrlResult>` | ❌ | **新增**(Q5a / Q5b / Q5c) |
| `generateDownloadUrl(input: GenerateDownloadUrlInput): Promise<DownloadUrlResult>` | ❌ | **新增** |
| `headObject(key: string): Promise<HeadObjectResult>` | ❌ | **新增**(confirm-upload 检 Provider 真实文件) |

**Q5a 锁**:`expiresIn = number(秒)`,**不**用 Date / Duration 字符串。
**Q5b 锁**:`headers: Record<string, string>` 必填字段(可为空对象 `{}`),**不**用可选字段。
**Q5c 锁**:`UploadUrlResult.method = 'PUT' | 'POST'` 联合保留,**默认 `'PUT'`**(COS PUT signed URL)。

### 2.3 API 候选新增 2 个端点(B2 / Q6 / Q7)

| 端点 | 用途 | 入参 | 出参 |
|---|---|---|---|
| `POST /api/v2/attachments/upload-url` | 客户端获 PUT signed URL + uploadToken | 5 字段(`ownerType` / `ownerId` / `originalName` / `mime` / `sizeBytes`)| 6 字段(`key` / `uploadUrl` / `uploadHeaders` / `uploadMethod` / `expiresAt` / `uploadToken`)|
| `POST /api/v2/attachments/confirm-upload` | 客户端上传完成后落库 | 1 必填(`uploadToken`)+ 1 可选(`checksum` sha256 64-hex) | `AttachmentResponseDto`(沿现有 PR #6b)|

**Q6e 锁**:upload-url 接 PII 检测(沿 Q10:confirm-upload 不重做)。
**Q7 锁**:Service 流程 6 步 = 验 uploadToken 签 → headObject Provider 真实文件 → size 一致性 → PII 不重做(Q10) → 落库 + audit `attachment.upload` → generateDownloadUrl 填 accessUrl。

### 2.4 后台 Storage Settings CRUD(Q20-Q22 + §6.5 后台架构)

| 端点 | 用途 | 权限 |
|---|---|---|
| `GET /api/v2/storage-settings` | 读当前配置(凭证字段返 `credentialStatus`;明文永不返)| ADMIN+(沿 F4)|
| `PATCH /api/v2/storage-settings` | 改非凭证字段(provider / bucket / region / endpoint / keyPrefix / TTL 等)| ADMIN+(沿 F4)|
| `POST /api/v2/storage-settings/reset-credentials` | 重置凭证(`secretId` + `secretKey` 入参 → AES-256-GCM 加密落库;响应不回显)| ADMIN+(沿 F4)|

**Q22 锁**:**永不**通过 API / UI 回显凭证明文 / 密文;UI 形如 `已配置 ✅` / `********`。

### 2.5 既有 attachments 模块改动(Q14 / B4)

- `toResponseDto` 改:`accessUrl` 由恒返 null 改为调 `generateDownloadUrl`(沿 Q8 默认 300s TTL)
- `delete` 改:接通 `provider.deleteObject(key)`;同步尝试 + 失败 `logger.warn`(沿 F4 / Q3);**不阻断业务删除**
- `audit_logs.extra` 扩:`attachment.upload` 加 `extra.providerDeleteStatus` / `extra.uploadConfirmedAt`(沿 B4 + D11 路线 A 单事件 + extra)
- **既有 7 端点 paths / 入参 / 出参 schema zero drift**(沿 B2 + A-2 红线)

### 2.6 不动项(沿 B 类)

- ❌ 不新增 `attachments` schema 字段(沿 B1;现有 13 字段够用)
- ❌ 不新增 `attachment.*` 权限点(沿 B3;现有 20 条够用;upload-url / confirm-upload 复用 `attachment.create.<resourceType>`;reset-credentials / storage-settings CRUD 走 `@Roles(SUPER_ADMIN, ADMIN)`,**不进** RBAC 业务权限段)
- ❌ 不新增 `AuditLogEvent` union 项(沿 B4;`attachment.upload` / `attachment.delete` 复用)
- ❌ 不动 v1 14 + V2 117 既有接口(沿 A-2 红线;v0.10.0 终态 117 接口 + C-7.5 新 3 端点 = 120)

---

## 三、实施前置硬约束

### 3.1 不引入(沿 V1.1 §17.3 + C-7 §3 + C-7.5 §3)

- ❌ **不引入 STS 临时凭证**(沿 Q19;模式 C 不采用)
- ❌ **不实施 multipart upload**(沿 Q13;单文件 ≤ 5GB 走 PUT signed URL)
- ❌ **不开放公有桶 / 公有读**(沿 Q16;私有桶 + 100% signed URL)
- ❌ **不引入异步删除队列**(沿 F4 + Q3;同步 + 告警 + COS lifecycle)
- ❌ **不引入 Redis / 任何 cache 中间件**(沿 V1.1 §17.3)
- ❌ **不长期依赖 env**(沿 Q23;env 仅 bootstrap fallback / dev / test;凭证主路径 = `storage_settings` 加密存储)
- ❌ **不在凭证字段返回明文 / 密文 / 任何形式回显**(沿 Q22;UI 形如 `已配置 ✅`)
- ❌ **不做 uploadToken 重放防御 / 黑名单 / 双因素**(留 v1.1+ 评审;v1.0 依赖 `attachment.key` UNIQUE + P2002 兜底)
- ❌ **不做失败回滚 Provider 文件**(留 v1.1+ 评审;Provider lifecycle 30 天兜底)

### 3.2 不改 v1 / V2 / RBAC / attachments 既有接口(沿 A-2 红线)

- ❌ **不改 v1 14 接口**(零字段 / 路径 / 错误码 / 权限标注 / 响应包装漂移)
- ❌ **不改既有 V2 117 接口**(v0.10.0 终态;含 v2 batch 1-7 全部模块)
- ❌ **不改 RBAC 16 接口**(沿 v0.9.0 收口现状)
- ❌ **不改 attachments 主模块 7 端点 + 配置三表 15 端点 paths / 入参 / 出参 schema**(沿 D7 v1.0 B2);**仅**:`toResponseDto.accessUrl` 由 null → 真实 URL(出参字段值变化,字段类型保持 `string | null`)
- ❌ **不动 `users.policy.ts`**(沿 D7-RBAC D12 永久共存)
- ❌ **不修改 `JwtStrategy.validate()` 查库逻辑**(沿 v1 §8)
- ❌ **不动 `prisma/schema.prisma`**(本立项 PR 边界);schema 变更由实施 PR #6 落地

### 3.3 v1.0 冻结后才允许进入实施

- ✅ C-7.5 v1.0 已冻结(PR #84 `f8b357d`)
- ✅ D7-attachments v1.0 已合(PR #68 `5da801f`;接口 + RBAC + audit 基础就位)
- ✅ C-7 attachments 实施已落地(PR #70-#78;v0.10.0 终态)
- ✅ 本 V2.x 立项 PR 合并 → **解除 V2 §18 调研期硬禁止(针对 Provider 实装范围)**
- ⏳ 实施 PR #5 启动前必须:**先展示 interface 扩展 diff**(`storage.interface.ts` / `storage.types.ts`),等用户明确确认后才推进
- ⏳ 实施 PR #6 启动前必须:**先展示 schema diff + migration SQL**(`storage_settings` 表 15 字段 + 加密 key 装载逻辑),等用户明确"破坏性变更已经过评审"后才执行 `prisma migrate dev`(沿 CLAUDE.md §0 铁律)

---

## 四、实施 PR 拆分(实际完成清单)

> **📋 Q25 v1.0 锁:实施分批;Q16 v1.0 沿用建议不冻结**(实施期允许微调)→ **实际累计 13 PR**(4 设计 + 7 实施 + 1 P1 技术债 + 1 landing 本 PR;bump / handoff / tag-release 留维护者)。

| PR # | GitHub PR | squash commit | 类型 | 主题 | 状态 |
|---|---|---|---|---|---|
| 设计 1 | #82 | `6dbdbed` | `docs(v2-design)` | add provider selection review draft v0.1 | ✅ |
| 设计 2 | #83 | `8d19a07` | `docs(v2-design)` | refine provider selection review decisions v0.2(含架构修订) | ✅ |
| 设计 3 | #84 | `f8b357d` | `docs(v2-design)` | freeze provider selection review v1.0(35 项决议全部就位) | ✅ |
| 设计 4 | #85 | `5e12511` | `docs(v2-design)` | start C-7.5 provider V2.x implementation track | ✅(2026-05-16)|
| **实施 5** | #86 | `fc8241d` | `chore(storage)` | extend StorageProvider interface for C-7.5 v1.0(+3 方法 +5 类型;0 实装) | ✅(2026-05-15)|
| **实施 6** | #87 | `45ae871` | `chore(prisma)` | add storage_settings schema and config reader for C-7.5 v1.0(15 字段 + 2 enum + 1 migration + StorageSettingsService + StorageCryptoService AES-256-GCM)| ✅(2026-05-15)|
| 实施 7 | #88 | `bceba0f` | `feat(storage)` | add LocalStorageProvider for C-7.5 v1.0(5 方法 + 16 unit + Symbol DI token)| ✅(2026-05-15)|
| 实施 8 | #89 | `f44310c` | `feat(storage)` | add CosStorageProvider with dynamic router for C-7.5 v1.0(5 方法 + Router + 32 unit + 引入 `cos-nodejs-sdk-v5@^2.15.4`)| ✅(2026-05-15)|
| 实施 9 | #90 | `119778c` | `feat(attachments)` | wire storage provider into attachment accessUrl and delete flow(7 调用点 + delete 事务外 + accessUrl description 微调)| ✅(2026-05-15)|
| 实施 10 | #91 | `527aa47` | `feat(attachments)` | add upload-url and confirm-upload APIs(2 端点 + 3 DTO + uploadToken HMAC-SHA256 + 28 e2e + 18 upload-token unit)| ✅(2026-05-15)|
| **P1 技术债**(实施段额外)| #92 | `fc08d17` | `chore(prisma)` | add unique constraint for attachment key(承接 PR #91 已知偏差;1 migration;并发 replay 防御)| ✅(2026-05-15)|
| 实施 11 | #93 | `85cae45` | `feat(storage)` | add Storage Settings admin APIs and credential reset(3 端点 + 3 DTO + 30 e2e;0 BizCode / 0 audit;Q-11-1 到 Q-11-19 全落地)| ✅(2026-05-16)|
| **landing 12(本 PR)**| TBD | TBD | `docs(v2)` | record C-7.5 provider implementation landing | 🔄 进行中 |
| bump 13 | TBD | TBD | `chore` | bump version to v0.11.0(SemVer minor)| ⏳ 留独立后续 PR |
| handoff 14 | TBD | TBD | `docs(v2)` | add v0.11.0 handoff | ⏳ 留独立后续 PR |
| tag/release | 维护者手动 | — | — | git tag + GitHub Release(沿 v0.9.0 / v0.10.0 范式)| ⏳ 维护者拍板 |

**实际实施周期**:**约 1 天**(2026-05-15 ~ 2026-05-16;7 实施 PR 集中落地,沿 D7-attachments v0.10.0 段同天落地 9 PR 节奏)。

**实际偏离原 14 PR 计划**:

- **新增 P1 技术债 PR #92**(`attachment.key @unique`;承接 PR #91 已知并发 replay 偏差;评审 §8.4.4 "依赖 attachment.key UNIQUE + P2002 兜底" 实施时发现 schema 缺 @unique 约束;补 1 migration + 修复双层防御)
- 实施 5-11 全部落地;**0 项 PR 缺失 / 顺延**
- 沿 §16.3 依赖序无偏离

**实际新增依赖**:**1 个**(预期 2 个;实际 1 个)

- `cos-nodejs-sdk-v5@^2.15.4`(腾讯云 COS SDK;实施 PR #89 引入)
- 加密辅助:**0 新依赖**(全部沿 Node 原生 `crypto`:AES-256-GCM / HMAC-SHA256 / scrypt / randomBytes / timingSafeEqual / `cos-nodejs-sdk-v5` 是唯一新增;沿评审 §四 立项记录"优先 Node 原生 crypto")

**实际新增 env 变量**:**2 个**

- `STORAGE_ENCRYPTION_KEY`(production 必填;dev/test 留空允许 → StorageCryptoService isAvailable=false;沿 v1 §14 JWT_SECRET 范式;PR #87 引入)
- `STORAGE_LOCAL_ROOT`(LocalProvider 根目录;default `./tmp/storage`;PR #88 引入)

---

## 五、本立项 PR 边界

### 5.1 本 PR 做(仅文档 4 处)

- ✅ 新增本文件 [`docs/批次7_provider选型_V2x立项记录.md`](批次7_provider选型_V2x立项记录.md)
- ✅ 更新 [`TASKS.md`](../TASKS.md) §9 V2.x C-7.5 Provider 选型立项准备(短摘要 + 链回本文件)
- ✅ 更新 [`docs/V2红线与复活路径.md`](V2红线与复活路径.md):C-10 行从"`src/common/storage/` 仅 interface,无实装"更新为"C-7.5 Provider 选型 v1.0 已冻结(PR #84 `f8b357d`),V2.x implementation track 启动(本立项 PR)"
- ✅ 更新 [`CHANGELOG.md`](../CHANGELOG.md) Unreleased 追加一行

### 5.2 本 PR 不做(全部沿 V2.x 立项 ≠ 实施 红线)

- ❌ **不动代码**:`src/**` / `prisma/**` / `test/**` 零触碰
- ❌ **不动 schema**:`prisma/schema.prisma` 不动,**不新增 migration**
- ❌ **不改 seed**:`prisma/seed.ts` 不动
- ❌ **不动依赖**:`package.json` / `pnpm-lock.yaml` 不动
- ❌ **不引入 COS SDK / 加密库**(实施 PR 6 / PR 8 引入)
- ❌ **不 bump version**:`package.json#version` 仍 `0.10.0` / Swagger `setVersion(...)` 仍 `0.10.0`
- ❌ **不打 tag** / **不发 GitHub Release**
- ❌ **不启动 C-7.5 实施 PR 5-11**(均需单独启动 + 用户授权)
- ❌ **不改 baseline / ARCHITECTURE.md**(段位早已预留;C-10 升级路径已就位)
- ❌ **不改 [`docs/批次7_provider选型_API前评审.md`](批次7_provider选型_API前评审.md)**(C-7.5 v1.0 已冻结,本立项 PR 不回改)
- ❌ **不改 [`docs/批次7_attachments_API前评审.md`](批次7_attachments_API前评审.md)**(D7 v1.0 已冻结,本立项 PR 不回改;沿 F1)
- ❌ **不改 [`docs/批次7_attachments_V2x立项记录.md`](批次7_attachments_V2x立项记录.md)**(C-7 已实施收口)
- ❌ **不改 `docs/handoff/v0.10.0.md`** / 其他历史 handoff(沿 V2 红线 §5.1)
- ❌ **不把腾讯云 SecretId / SecretKey 写入仓库**(沿 Q21 / Q22;凭证由运维侧后台录入,**永不入** git 历史)

---

## 六、合并后的下一步(landing 后状态)

### 6.1 C-7.5 implementation landing 已完成 ✅

| 阶段 | 状态 | 备注 |
|---|---|---|
| C-7.5 v1.0 冻结(PR #84 `f8b357d`)| ✅ 已合 | 2026-05-16 |
| V2.x 立项(PR #85 `5e12511`)| ✅ 已合 | 2026-05-16 |
| 实施 PR #86-#93(8 PR;含 P1 技术债 #92)| ✅ 全部已合 | 2026-05-15 ~ 2026-05-16 集中落地 |
| Landing PR(本 PR `docs(v2): record C-7.5 provider implementation landing`)| 🔄 进行中 | 4 处 docs 修订(本立项记录 + V2 红线 + TASKS + CHANGELOG)|

### 6.2 后续 PR(留独立 PR;不在本 landing PR 范围)

| PR | 性质 | 用途 | 时机 |
|---|---|---|---|
| **bump PR #13** | `chore` | bump `package.json#version` + Swagger `setVersion(...)`;**SemVer 推荐 minor**:`0.10.0 → 0.11.0`(+1 表 / +5 API / +2 enum / +1 unique / +2 migrations / +1 runtime 依赖 `cos-nodejs-sdk-v5`;无 breaking change) | landing 合并后由维护者评估 |
| **handoff PR #14** | `docs(v2)` | 类比 v0.10.0 / v0.9.0 / v0.8.0 范式;13 章节;**下次会话启动必读** | bump 之后 |
| **GitHub Release / git tag** | 维护者手动 | 沿 v0.10.0 终态范式(handoff 后维护者打 tag + 发 Release) | 跟随 bump |

**Claude Code 在 landing 合并后不应自动启动**版本 bump / handoff;由维护者明确授权后再开。

### 6.3 生产侧 COS 运维配置(系统侧不承载;由队组织运维侧执行)

| # | 项 | 评估 |
|---|---|---|
| 1 | 真实腾讯云 COS bucket 创建(`srvf-attachments-<APPID>`)| 由运维 |
| 2 | 真实 IAM 子账号 + Secret 生成 | 由运维 |
| 3 | bucket CORS 规则配置(沿 §6.4.6;生产域名白名单 + PUT/GET/HEAD + MaxAge=3600)| 由运维(腾讯云控制台 / Terraform) |
| 4 | bucket lifecycle 规则(沿 §6.4.5;旧版本 30 天 expire + DeleteMarker 即清除 + 7 天 abort multipart)| 由运维 |
| 5 | bucket versioning 启用(沿 §6.4.5)| 由运维 |
| 6 | bucket SSE-COS 加密配置(沿 §6.4.4)| 由运维 |
| 7 | 真实生产凭证录入(通过 `POST /storage-settings/reset-credentials`)| 由运维 |
| 8 | 生产环境 `STORAGE_ENCRYPTION_KEY` 注入(`openssl rand -base64 32`)| 由运维 / 部署平台 |

### 6.4 并行可启动的独立 PR(不阻塞 C-7.5 收口;由用户授权)

| PR | 性质 | 用途 | 状态 |
|---|---|---|---|
| "RBAC 内置角色 / ADMIN 默认附件权限"专项评审 PR | docs-only | 决议 D7-attachments Q12;实施期默认按方案 B(沿 v0.9.0 现状)| ⏳ 用户未授权 |
| D7-attachments v1.1 修订 PR | docs-only | 等业务方提供 B8 同意书正式文本 + Q8 退队清理 N 具体值后启动 | ⏳ 用户未授权 |
| 跨表引用约束评审 PR(13030 `ATTACHMENT_TYPE_IN_USE` 等)| docs-only | C-7 v1.0 未覆盖;留专项 PR | ⏳ 用户未授权 |
| 业务模块全面 RBAC 接入评审 PR | docs-only | 14 RBAC CRUD 自身接入 + 既有 V2 117 接口接入 `rbac.can()` | ⏳ 用户未授权 |
| bootstrap fallback 专项 PR | feat | sec env 兜底自动创建 row(沿 Q-11-3 留 v1.1+)| ⏳ 用户未授权 |
| test-connection API 专项 PR | feat | COS 真实联调时启动(沿 Q-11-6) | ⏳ 用户未授权 |
| multipart upload 专项 PR | feat | 大文件需求触发时启动(沿 Q13)| ⏳ 用户未授权 |

均需用户明确授权后启动。

### 6.5 v1.1+ 留待评估(沿 §21 不在 v1.0 评审范围)

- uploadToken 重放防御 / 黑名单 / 双因素(v1.0 依赖 `attachment.key` UNIQUE + P2002 兜底,已由 PR #92 强化)
- 失败回滚 Provider 文件(v1.0 依赖 Provider lifecycle 30 天兜底)
- multipart upload 支持(沿 Q13;大文件需求未触发)
- STS 临时凭证(沿 Q19;模式 C 不采用;multipart 触发时再评估)
- 跨 Provider 迁移路径(沿 Q15;COS 暂不迁移)
- bootstrap fallback(env 兜底自动创建 row;沿 Q-11-3)
- test-connection API(沿 Q-11-6)
- Storage Settings 配置变更 audit_logs(沿 §6.6.5)

---

## 七、风险与边界声明

### 7.1 立项 ≠ 实施

**本 PR 仅完成 V2.x C-7.5 立项准备**;实施需单独 PR 推进。AI / 维护者**不得**在本 PR 合并后"顺手"启动实施 PR #5,必须等用户明确授权 + 展示对应 diff 双确认。

### 7.2 C-7.5 v1.0 决议不可绕过

实施 PR 必须**严格遵循** v1.0 冻结的 35 项决议(沿 [`docs/批次7_provider选型_API前评审.md §19`](批次7_provider选型_API前评审.md))。任何"实施时发现需要调整决议"的情况,必须**暂停 + 向用户说明**,不得擅自调整。如确需调整决议,需另起 C-7.5 v1.x 修订 PR + 用户拍板,再启动实施。

### 7.3 不引入未登记新依赖

实施 PR 中如需引入新依赖,必须在对应 PR 任务卡中显式登记,沿 baseline `不得引入未在任务卡声明的新依赖` 纪律。**预期新增依赖 2 个**(沿 §四 注释:`cos-nodejs-sdk-v5` + 可能的加密辅助库;**优先 Node 原生 `crypto`**)。

### 7.4 contract snapshot 守护

实施 PR 必须保证 **v1 14 + V2 117(v0.10.0 终态)+ RBAC 16 接口 schema + paths zero drift**(沿 A-2 红线);新增 3 端点(upload-url + confirm-upload + reset-credentials)+ 2 端点(storage-settings GET + PATCH)= 5 端点加入 snapshot;**既有 attachments 主模块 7 端点 + 配置三表 15 端点 paths / 入参 / 出参 schema zero drift**;仅 `toResponseDto.accessUrl` 字段值变化(由 null → 真实 URL),字段类型保持 `string | null`,**不算 schema drift**。任何 v1 / 既有 V2 / 既有 RBAC 接口字段变化视作 A-2 红线破口,**不可合并**。

### 7.5 实施 PR #6 涉及 schema 变更

`storage_settings` 表 15 字段是 V2 第八张新表(沿 v0.10.0 终态 22 表 + 1 = 23 表):

- 加密字段:`secretIdEncrypted` / `secretKeyEncrypted` 列 → AES-256-GCM 加密;`STORAGE_ENCRYPTION_KEY` 通过 env 装载(沿 Q23 例外)
- 默认数据:实施 PR 6 不预置;首次访问 `GET /api/v2/storage-settings` 返 `credentialStatus: missing`(沿 Q22)
- 启动校验:沿 v1 §14 / CLAUDE.md §0 启动强校验铁律;`STORAGE_ENCRYPTION_KEY` 至少 32 字节,production 禁止用 `.env.example` 默认值
- e2e 需新增:`storage-settings.e2e-spec.ts`(覆盖 GET / PATCH / reset-credentials + 启动校验)

**实施 PR #6 启动前**:必须先展示 migration SQL + 启动校验代码 diff + e2e 用例预览,等用户明确"破坏性变更已经过评审"后才执行。

### 7.6 凭证安全边界(Q21 / Q22)

- 凭证明文**永不**入 DB / 日志 / audit_logs / git 历史 / API 响应 / UI 回显
- 加密 key(`STORAGE_ENCRYPTION_KEY`)与凭证**分离**存储:加密 key 在 env;凭证密文在 DB(沿 Q23 例外)
- `credentialStatus` 三态(`configured` / `missing` / `invalid`)是凭证存在性的**唯一外露形式**
- 凭证轮换走 `POST /api/v2/storage-settings/reset-credentials`(沿 §6.6.3);**不**通过 PATCH 字段方式实现
- AI 在实施期**不得**为了"调试方便"在日志 / 报错信息中输出凭证明文 / 密文 / 加密 key

### 7.7 段位预留 ≠ 段位实装

baseline 段位预留沿用 D7 v1.0 `130xx + 131xx`;C-7.5 不新增段位(沿 B3 / B4)。**仅**复用现有 BizCode(如 upload-url 401 / 403 / 404 走通用 4xxxx;`attachment.key` 唯一约束撞 P2002 走现有 13002 等)。如实施期发现需新增段位,需另起评审 PR。

### 7.8 v1 极简 storage.interface.ts 兼容性

v1 极简版(`src/common/storage/storage.interface.ts`)有 2 方法(`putObject` / `deleteObject`)是占位骨架。**沿 F5**:实施 PR #5 扩展为 5 方法(+`generateUploadUrl` / `generateDownloadUrl` / `headObject`);**不破坏** v1 已有 2 方法签名;v1 极简版没有任何调用方,扩展无运行时影响(沿 §18.2)。

---

## 八、参考引用

### 主要引用

- [`docs/批次7_provider选型_API前评审.md`](批次7_provider选型_API前评审.md):C-7.5 v1.0 冻结稿(35 项决议、`StorageProvider` 接口、upload-url + confirm-upload DTO、`storage_settings` 架构、凭证安全边界、14 PR 节奏)
- [`docs/批次7_attachments_API前评审.md`](批次7_attachments_API前评审.md):D7 v1.0 冻结稿(C-7.5 承接 Q14 / Q15 挂起项)
- [`docs/批次7_attachments_V2x立项记录.md`](批次7_attachments_V2x立项记录.md):C-7 attachments 立项记录(本立项 PR 风格参照)

### 红线 / 复活路径

- [`docs/V2红线与复活路径.md`](V2红线与复活路径.md) **A-2**:v1 14 + V2 117 + RBAC 16 接口 zero drift
- [`docs/V2红线与复活路径.md`](V2红线与复活路径.md) **A-17**:audit_logs 同事务 fail-fast(C-7.5 沿用,不新增 event)
- [`docs/V2红线与复活路径.md`](V2红线与复活路径.md) **C-10**:文件上传 Provider 实装(本立项启动)
- [`docs/V2红线与复活路径.md`](V2红线与复活路径.md) **Slow-7**:任何"顺手"接入 Redis / 队列 / 定时任务 / Provider(Provider 段解锁;Redis / 队列 / 定时任务仍锁)

### 基线 / 段位

- [`docs/srvf-foundation-baseline.md §1.1`](srvf-foundation-baseline.md):BizCode 段位 `130xx + 131xx` `attachments` 模块预留(C-7.5 沿用;不新增段位)

### 升级路径 / 架构

- [`ARCHITECTURE.md §9`](../ARCHITECTURE.md):升级路径(C-10 文件上传 Provider 实装条件)
- [`ARCHITECTURE.md §12.11.2`](../ARCHITECTURE.md):V2.x 复活路径

### v1 接口骨架

- [`src/common/storage/storage.interface.ts`](../src/common/storage/storage.interface.ts):v1 极简版骨架(2 方法)
- [`src/common/storage/storage.types.ts`](../src/common/storage/storage.types.ts):v1 极简版类型

### 阶段交接

- [`docs/handoff/v0.10.0.md`](handoff/v0.10.0.md):C-7 attachments 全模块实施收口 + C-7.5 前置门槛(v0.10.0 tag + Release 已就位)

---

## 九、撰写元信息

- **状态标签**:V2.x C-7.5 立项准备(等用户授权启动实施 PR #5)
- **commit message**:`docs(v2-design): start C-7.5 provider V2.x implementation track`
- **PR 标题**:同 commit message
- **未做项**(本 PR 边界):
  - 不动 `src/**` / `prisma/**` / `test/**` / `package.json` / `pnpm-lock.yaml`
  - 不新增 migration
  - 不改 seed
  - 不引入 COS SDK / 加密库
  - 不 bump version / 不打 tag / 不发 Release
  - **不启动 C-7.5 实施 PR 5-11**
  - 不启动"RBAC 内置角色 / ADMIN 默认附件权限"专项评审 PR
  - 不启动 D7-attachments v1.1 修订 PR
  - 不启动跨表引用约束 / 业务全面 RBAC 接入评审 PR
  - 不改 C-7 / C-7.5 已冻结文档
- **本 PR 修订范围**(4 处文档):
  - 新增本文件 `docs/批次7_provider选型_V2x立项记录.md`
  - `TASKS.md` 追加 §9 V2.x C-7.5 Provider 选型立项准备(短摘要 + 链回本文件)
  - `docs/V2红线与复活路径.md` 更新 C-10 行(状态从"`src/common/storage/` 仅 interface,无实装"改为"C-7.5 v1.0 已冻结,V2.x implementation track 启动")
  - `CHANGELOG.md` Unreleased 追加一行
- **撰写者签名**:Claude Code(基于 C-7.5 v1.0 冻结 PR #84 `f8b357d` + 用户立项指令 + D7-attachments 立项记录 PR #69 风格参照;**未动任何代码 / schema / migration / SDK 依赖**)
