# 《批次7_provider选型_API前评审稿》(C-7.5 Provider 选型 D7-provider v0.2 局部收口稿)

> **状态**:**v0.2 局部收口稿**(2026-05-15;**含 v0.2 架构修订**)— **收口原因**:v0.1 草稿([PR #82](https://github.com/BA7IEE/srvf-nest-api/pull/82),squash commit `6dbdbed`,2026-05-15)10 项 v0.1 拍板(F 5 + B 5)+ 15 项 Q 留评审后,用户拍板**v0.2 局部收口**:**正式 Provider 锁定为腾讯云 COS**(不再 OSS / COS 二选一);**COS 运行参数支持后台配置 + 凭证安全存储**(Q20 / Q21 / Q22 / Q23 新增锁定;**不长期依赖 env**;env 仅作 bootstrap fallback / dev / test 兜底);**底层 `storage_settings` schema 一次设计完整,实施可分批**(Q24 / Q25 新增锁定;原则:**字段允许闲置,不允许未来推翻 schema**);沿用 v0.1 锁定的 F1-F5 / B1-B5;**Q1 / Q4 锁定**(业务方既有云资源 + 存储后端具体选择)+ **Q8 / Q9 / Q10 / Q11 / Q12 / Q13 / Q14 / Q15 锁定**(TTL / uploadState / PII 重做 / versioning / 加密 / multipart / CORS / 迁移)+ **新增 Q16-Q25 锁定**(私有桶 / key 命名 / 环境隔离 / STS / 后台配置 / 凭证加密 / 不回显 / 不依赖 env / schema 一次设计 / 实施分批);**留 v1.0 / 实施期决议 3 项**(Q5 接口签名细化 / Q6 upload-url 字段集 / Q7 confirm-upload 字段集 — 实施 PR 期落地)。
>
> **触发条件**:C-7 attachments 全模块实施已收口(v0.10.0;沿 [`docs/handoff/v0.10.0.md`](handoff/v0.10.0.md));D7-attachments v1.0 冻结稿(PR #68,squash commit `5da801f`)挂起 Q14 / Q15 Provider 上传 / 删除策略,**留 Provider 选型评审稿**;C-7 attachments **9 个实施 PR(#70-#78)+ landing(#79) + bump(#80) + handoff(#81)** 共 17 PR 已全部入 main;`v0.10.0` tag + Latest GitHub Release 已发(`2f4b89d` → `1db905e`,2026-05-15)。本 PR 推进 **C-7.5 Provider 选型 v0.2 局部收口**,沿 D7-attachments v0.2 局部收口稿 / D7-RBAC v0.2 局部收口稿范式。
>
> **性质**:**C-7.5 Provider 选型评审 v0.2 局部收口稿**(基于 v0.1 草稿 + 用户拍板腾讯云 COS 锁定 + 9 项 v0.2 锁定决策;**沿 D7-attachments v1.0 冻结稿不回改**)。
> **批次号**:批次 7.5 暂定;正式编号以 **C-7.5 V2.x 立项 commit** 为准。
> **撰写日期**:2026-05-15(v0.1 / **v0.2**)
> **修订历程**(只在本说明区出现历史措辞):**v0.1 草稿**(PR #82,squash commit `6dbdbed`,2026-05-15,5 项 F 锁 + 5 项 B 锁 + 15 项 Q 待评审)→ **v0.2 局部收口稿(初版)**(本 PR commit 1,用户拍板**正式 Provider = 腾讯云 COS**;锁定 Q1 / Q4 / Q8-Q15 共 10 项 Q + 新增 Q16-Q19 共 4 项 Q = 共锁 14 项 Q;留 3 项 Q 待 v1.0 / 实施期决议)→ **v0.2 架构修订**(本 PR commit 2,用户拍板**COS 配置后台化 + 凭证加密存储**;不长期依赖 env;新增 Q20-Q25 共 6 项 Q + 新增 §6.5 Storage Settings 架构设计 + §6.6 凭证安全边界 + §16 PR 拆分 13 → 14 PR 节奏;**原则:底层模型一次设计对,实施可分批,字段允许闲置不允许推翻 schema**;**不回改 D7-attachments v1.0 冻结稿**)。
> **拍板准绳**:沿 D6 / D7-attachments / D7-RBAC 业务确认稿"**不考虑时间周期,只考虑项目稳定和长久**"(沿 D6 §1.2)。
> **接续**:
> - [D7-attachments v1.0 冻结稿](批次7_attachments_API前评审.md)(PR #68,squash commit `5da801f`;**Q14 / Q15 沿用挂起待本评审决议**)
> - [批次7 attachments V2.x 立项记录](批次7_attachments_V2x立项记录.md)(C-7 实施落地清单)
> - [docs/handoff/v0.10.0.md §7.2](handoff/v0.10.0.md)(Provider 选型 Slow-2 启动条件)
> - [V2 红线与复活路径 §4 C-10](V2红线与复活路径.md)(文件上传 Provider 实装复活路径)
> - [ARCHITECTURE.md §9](../ARCHITECTURE.md)(升级路径与外部依赖引入边界)
> - [`src/common/storage/storage.interface.ts`](../src/common/storage/storage.interface.ts)(v1 极简 interface;`putObject` + `deleteObject` 两动作;留待 Provider 接入时扩展)
> - [`src/modules/attachments/attachments.service.ts`](../src/modules/attachments/attachments.service.ts) `toResponseDto`(`accessUrl: null` 占位;Provider 接入唯一改动点)
> **风格参照**:[批次7_attachments_API前评审.md](批次7_attachments_API前评审.md)(D7 评审稿正典)/ [批次8_RBAC_API前评审.md](批次8_RBAC_API前评审.md)
> **核心**(v0.2 局部收口含架构修订;5 项 F 锁 + 5 项 B 锁 + 20 项 Q 锁 + 3 项 Q 留 v1.0 / 实施期):
> - **F1-F5 沿 v0.1 锁**(独立评审 / signed URL 模式 / 国内合规优先 / 同步删除 + lifecycle / 6 方法接口)
> - **B1-B5 沿 v0.1 锁**(不新增**业务** schema(沿 D7-attachments 4 表)/ +2 API / 不新增 RBAC / 不新增 event / **PR 节奏 13 → 14**;⚠️ B1 仅约束 attachments 业务表;**`storage_settings` 是配置表,Q24 单独锁**)
> - **🔒 v0.2 锁 20 项 Q**:
>   - **Q1 锁**:业务方已锁腾讯云资源(用户拍板)
>   - **Q4 锁**:正式 Provider = **腾讯云 COS**(国内合规 + 已有云资源;不再 OSS 候选)
>   - **Q8 锁**:`accessUrl` TTL = upload 600s / download 300s(沿 v0.1 倾向;**实际值可后台调整**;沿 Q20)
>   - **Q9 锁**:不新增 `uploadState` schema 字段(沿 v0.1 倾向 A;客户端由 upload-url 拿 signed token,confirm-upload 一次性落库)
>   - **Q10 锁**:PII 不在 confirm-upload 重做(upload-url 已检;沿 v0.1 倾向 A)
>   - **Q11 锁**:COS versioning 启用 + lifecycle 30 天 expire 旧版本(**`lifecycleDays` 后台可改**;沿 Q20)
>   - **Q12 锁**:加密 = **COS 服务端加密 SSE-COS**(腾讯云原生;等价 AWS SSE-S3;不启用 SSE-KMS)
>   - **Q13 锁**:本批次不实施大文件 multipart upload(留 v1.1 / 实施期;客户端单文件 ≤ 5GB 走 PUT signed URL)
>   - **Q14 锁**:COS CORS 配置(AllowedOrigins / AllowedMethods / AllowedHeaders / MaxAge;**`corsAllowedOrigins` JSON 后台可改**;沿 Q20)
>   - **Q15 锁**:COS 暂不迁移(若未来跨 Provider,沿 S3 兼容协议;`StorageProvider` 接口抽象保证可平移)
>   - **Q16 锁**(新增):**私有桶** + signed URL 唯一访问路径;**永不开放公有读**
>   - **Q17 锁**(新增):key 命名规范 = `attachments/<env>/<yyyy>/<mm>/<dd>/<cuid>.<ext>`
>   - **Q18 锁**(新增):bucket 环境隔离 = **单 bucket + key 前缀**(沿 Q17;**`envPrefix` 后台可改**;沿 Q20)
>   - **Q19 锁**(新增):**不采用 STS 临时凭证**(沿 F2 模式 B + Q13 暂不 multipart;multipart upload 需要时 v1.1 / 实施期再启用)
>   - **🆕 Q20 锁**(v0.2 架构修订):**COS Provider 运行参数支持后台配置**(bucket / region / TTL / lifecycle / CORS / envPrefix 等;**不长期依赖 env**;env 仅作 bootstrap fallback + dev / test 兜底;**主路径 = 后台配置读取**)
>   - **🆕 Q21 锁**(v0.2 架构修订):**SecretId / SecretKey 允许后台录入,但必须加密存储**(`secretIdEncrypted` / `secretKeyEncrypted` 列;encrypted at rest)
>   - **🆕 Q22 锁**(v0.2 架构修订):**凭证 API 不返回明文 / UI 永不回显**;只支持 reset / replace;`credentialStatus ∈ {configured, missing, invalid}` 状态化展示
>   - **🆕 Q23 锁**(v0.2 架构修订):**不长期依赖 env**;env 仅允许 bootstrap fallback / 首次系统未初始化兜底 / 本地开发环境;生产主路径 = 后台配置读取
>   - **🆕 Q24 锁**(v0.2 架构修订):**`storage_settings` schema 一次设计完整**(15+ 字段;允许首期闲置部分字段;**不允许未来推翻 schema 重做 migration**)
>   - **🆕 Q25 锁**(v0.2 架构修订):**实施分批**(不一次做完;沿 §16 PR 6-14 共 9 个实施 / 收口 PR 节奏)
> - **本 v0.2 留 v1.0 / 实施期决议 3 项 Q**:Q5 `StorageProvider` 接口签名细化 / Q6 upload-url DTO 字段集 / Q7 confirm-upload DTO 字段集

---

## 0. 前置启动门槛(已通过)

- ✅ C-7 attachments 全模块已落地(v0.10.0;沿 [v0.10.0 handoff](handoff/v0.10.0.md))
- ✅ D7-attachments v1.0 冻结稿已合并(PR #68,squash commit `5da801f`,2026-05-14)
- ✅ Q14 / Q15 已锁"挂起待 Provider 选型评审"(沿 D7-attachments §16 决议表)
- ✅ V2 红线 §4 C-10 "文件上传 Provider 实装"已列入可复活项
- ✅ v0.10.0 tag + Latest GitHub Release 已发(`2f4b89d`,2026-05-15)
- ✅ **v0.1 草稿已合**(PR #82,squash commit `6dbdbed`,2026-05-15;5 项 F 锁 + 5 项 B 锁 + 15 项 Q 待评审)
- ✅ **业务方既有云资源 = 腾讯云**(用户拍板;Q1 v0.2 锁定)
- ✅ **正式 Provider = 腾讯云 COS**(Q4 v0.2 锁定;不再 OSS / COS 二选一)
- ⏳ **用户拍板剩余 3 项 Q**(Q5 / Q6 / Q7;接口与 DTO 字段集)→ 进入 v1.0 冻结阶段

---

## 1. 触发上下文(C-7 attachments 已落地)

### 1.1 当前 attachments 已就绪能力(沿 v0.10.0 handoff §4)

| 维度 | 数量 |
|---|---|
| Prisma 表 | 4(`Attachment` + 配置三表)|
| API 端点 | 22(主模块 7 + 配置三表 15)|
| BizCode `130xx` | 13 项实装 |
| AuditLogEvent | 3 项(`attachment.upload` / `attachment.delete` / `attachment.config.change`)|
| Permission seed | 20 条 `attachment.*` |
| RbacRole 内置角色 | 1(`member` placeholder)|

**首次业务模块接入 `rbac.can()`** + **audit 同事务 fail-fast** 已确立范式;**Provider 实装是 C-7 收尾后唯一未做的扩展项**。

### 1.2 当前 attachments 对 Provider 的真实依赖点

| # | 位置 | 当前形态 | Provider 接入时的改动 |
|---|---|---|---|
| 1 | `prisma/schema.prisma` `Attachment.key` / `etag` / `checksum` | schema 已落地 | 沿用;不动 schema |
| 2 | [`src/modules/attachments/attachments.service.ts:55`](../src/modules/attachments/attachments.service.ts) `toResponseDto` | `accessUrl: null` 占位 | 改为 `await this.storage.generateDownloadUrl(row.key)` |
| 3 | `attachments.service.ts:438` `delete()` | 仅 `tx.attachment.delete` | 追加 `this.storage.deleteObject(key)` + 失败 `logger.warn`(沿 F4)|
| 4 | `attachments.service.ts:275` `create()` | 仅落库元数据 | **保持现状**(由 `confirm-upload` 内部调;沿 F2 signed URL 模式 + B2)|
| 5 | [`src/common/storage/storage.interface.ts`](../src/common/storage/storage.interface.ts) | v1 极简 interface(2 方法)| 扩展到 6 方法(沿 F5)|
| 6 | `src/common/storage/storage.types.ts` | `PutObjectInput` / `StoredObject` | 扩展 `GenerateUploadUrlInput` / `GenerateDownloadUrlInput` / `HeadObjectResult` |

**接入面极小**:`toResponseDto`(1 处)+ `delete`(1 处)+ storage interface 扩展;**0 schema 改动 / 0 RBAC 改动 / 0 audit event 改动**(沿 B1 / B3 / B4)。

### 1.3 D7-attachments v1.0 冻结时的 Q14 / Q15 挂起原因

沿 [D7-attachments §16 决议表](批次7_attachments_API前评审.md#16-决议表):

- **Q14**:Provider 接通后上传策略(签名 URL / STS / 中转代理)— 各 Provider SDK 差异显著,**提前锁定易返工**
- **Q15**:Provider 删除失败处理(同步 / 异步 / 告警)+ versioning 生命周期 — 依赖具体 Provider 能力

**本评审承接 Q14 / Q15**,完成后由实施 PR 落地接入。

---

## 2. 本批次目标

### 2.1 决议范围

- ✅ **决议**:Provider 选型(本地 / S3 / R2 / 阿里 OSS / 腾讯 COS / MinIO / 其他)— Q4 待评审
- ✅ **决议**:上传模式(A 中转 / B 签名 URL / C STS / D 本地)— Q2 待评审;v0.1 拍板生产 = B(签名),dev = D
- ✅ **决议**:删除策略 A/B/C/D — Q3 待评审;v0.1 拍板 = F4 同步 + 告警 + lifecycle 兜底
- ✅ **决议**:`StorageProvider` 接口扩展(6 方法签名细化)— Q5 待评审
- ✅ **决议**:新增 API `upload-url` + `confirm-upload` 字段集 — Q6 / Q7 待评审
- ✅ **决议**:`accessUrl` TTL 选择 — Q8 待评审
- ✅ **决议**:`uploadState` schema 字段是否新增 — Q9 待评审(B1 暂不新增,留 v0.2 复议)
- ✅ **决议**:加密 / versioning / CORS / multipart / 迁移路径 — Q11 / Q12 / Q13 / Q14 / Q15 待评审

### 2.2 本批次输出

**沿 D7-attachments 评审稿范式**:

1. 本 v0.1 草稿 PR(本 PR)
2. v0.2 局部收口 PR(用户拍板 Q1-Q15 后)
3. v1.0 冻结 PR(全部决议锁定后)
4. **C-7.5 V2.x 立项 PR**(沿 D7-RBAC PR #52 / D7-attachments PR #69 范式)
5. 实施 PR(沿 §16 PR 拆分建议;先按 13 PR 节奏走)

### 2.3 不在本批次范围

| 项 | 原因 |
|---|---|
| ❌ 改 D7-attachments v1.0 冻结稿(沿 F1) | v1.0 已锁;本评审独立承接 Q14 / Q15 |
| ❌ 改 attachments 业务逻辑 / schema / RBAC / audit | 沿 B1 / B3 / B4;接入面仅 `toResponseDto` + `delete` |
| ❌ 引入消息队列 / Redis / 异步 worker(沿 V1.1 §17.3) | F4 已锁同步 + 告警 + lifecycle 兜底 |
| ❌ 实装具体 Provider | 本评审仅决议;实装由 V2.x 实施 PR 完成 |
| ❌ 修改 `src/common/storage/` 实际代码 | v0.1 草稿仅文档;实际代码改动留实施 PR |

---

## 3. 本批次不做(沿 V1.1 §17.3 + D7-attachments F2)

- ❌ **不实装 Provider**(沿 D7-attachments F2;本评审仅决议,不动代码)
- ❌ **不引入 Redis / 队列 / 定时任务 / cron**(沿 V1.1 §17.3;F4 同步范式)
- ❌ **不引入 BullMQ / pg-boss / 任何异步 worker**
- ❌ **不接通 `accessUrl`**(沿 D7-attachments Q14 挂起 → 本评审决议后由实施 PR 接通)
- ❌ **不改 attachments 任何业务字段 / 语义**(沿 B1 / B3 / B4 锁)
- ❌ **不引入 OCR / 病毒扫描 / 加密 KMS**(沿 D7-attachments §11 风险接受)
- ❌ **不实装 multipart upload**(Q13 待评审;若用户拍板"暂不",留 v1.1 / 实施期)
- ❌ **不改 audit_logs union 字符串值**(沿 D6 R5 + B4;`AuditLogEvent` 17 项 union 不动)
- ❌ **不动 `prisma/schema.prisma` / `prisma/migrations/**` / `prisma/seed.ts`**
- ❌ **不动 `package.json` / `pnpm-lock.yaml`**(新依赖留实施 PR;v0.1 草稿是纯 docs)

---

## 4. 上传模式分析

### 4.1 4 模式对比

| 模式 | 适用场景 | 客户端复杂度 | 服务端复杂度 | 安全 | 性能 | 成本 | v0.1 拍板 |
|---|---|---|---|---|---|---|---|
| **A. 后端中转上传** | 小文件 / 严格服务端校验 | 低(标准 multipart) | 高(服务端要存流量 / CPU) | 高 | 低(2 跳;后端瓶颈) | 高(出口流量 ×2) | ❌ 不选 |
| **B. 前端直传 signed URL** | **D7-attachments §5.5 推荐范式** | 中(需处理 signed URL + retry) | 中(签 URL + 校 confirm) | 中(签名时间窗口 + content-type pinning) | 高(1 跳直传 Provider) | 低(后端不过流量) | ✅ **v0.1 拍板:生产** |
| **C. STS 临时凭证** | 大文件 / multipart 大对象 | 高(需 Provider SDK) | 中(签 STS Policy) | 中-高(凭证短期 + Policy 路径限定) | 高 | 低 | ⏳ 留 Q13 评审(若需要 multipart 再启用) |
| **D. 本地存储** | 开发 / 测试 / 离线部署 | 低(中转 + 静态文件) | 中-低(`fs.writeFile`) | 取决于部署网络 | 中(本地磁盘) | 极低 | ✅ **v0.1 拍板:dev / test** |

### 4.2 v0.1 拍板模式 B(生产)+ D(dev)

**模式 B 流程**(沿 D7-attachments §5.5):

```
[Client]  POST /api/v2/attachments/upload-url
          { ownerType, ownerId, originalName, mime, size }
          ↓
[Server]  生成 key + Provider.generateUploadUrl(key, mime, expiresIn=600)
          落库 attachment(状态 pending)← 是否落库待 Q9 评审
          ↓
[Server]  → { attachmentId?, key, uploadUrl, uploadHeaders, expiresAt }
[Client]  ↓
[Client]  PUT <uploadUrl> + body (直传 Provider)
          ↓
[Provider 收到文件;Client 拿到 ETag]
          ↓
[Client]  POST /api/v2/attachments/confirm-upload
          { key } 或 { attachmentId }
          ↓
[Server]  Provider.headObject(key) → { exists: true, size, etag, ... }
          落库 / 更新 attachment(状态 confirmed)
          ↓
[Server]  → AttachmentResponseDto(含真实 accessUrl)
```

**模式 D 流程**(dev / test):

```
[Client]  POST /api/v2/attachments(沿现有 D7-attachments §5.4.1)
          { key, originalName, mime, size, ownerType, ownerId, ... }
          + 可选 multipart body(LocalProvider 写入 fs)
          ↓
[Server]  LocalProvider.putObject(key, body) → fs.writeFile
          落库 attachment
          ↓
[Server]  → AttachmentResponseDto(accessUrl = `/uploads/<key>` 静态 URL)
```

**两模式共存策略**:`StorageProvider` interface 统一;**实际 Provider 通过环境变量切换**(`STORAGE_PROVIDER=local | oss | cos | r2 | s3`);**API 形态保持一致**(模式 B 主路径;LocalProvider 兼容)。

---

## 5. 删除策略分析

### 5.1 4 策略对比

| 策略 | DB 删 → Provider 删 顺序 | 失败处理 | 一致性 | 复杂度 | v0.1 拍板 |
|---|---|---|---|---|---|
| **A. 同步删除 Provider 文件**(事务内) | `$transaction`:DB 删 + Provider 删 顺序执行 | Provider 删失败 → 回滚 DB | 强一致 | 高(Provider 删可能慢;事务时间窗口长) | ❌ 不选 |
| **B. DB 删除成功后异步删除** | DB 先删 + 事件入队 → 异步 worker 删 Provider | 异步重试 N 次后告警 | 最终一致(可能孤儿) | 高(需引入队列;违反 V1.1 §17.3) | ❌ 不选(违反 V1.1) |
| **C. Provider 删失败仅记录告警** | DB 删后**同步**尝试删 Provider,失败 → `logger.warn` 不抛 | 失败孤儿文件 + audit `attachment.delete` 仍写;运维定期扫描清理 | 最终一致(孤儿可控) | 低(无队列;沿现有同步范式) | ✅ **v0.1 拍板:主路径** |
| **D. Provider 不删 + Provider versioning 兜底** | DB 删 + Provider 文件保留(走 Provider 自带版本生命周期) | 不删失败 — Provider 自动 expire | 取决于 Provider 配置 | 低(Provider 端配置) | ✅ **v0.1 拍板:兜底** |

### 5.2 v0.1 拍板策略 C + D 组合(沿 F4)

**事务结构**(沿 attachments.service.ts PR #6c `delete()` 范式):

```typescript
async delete(id: string, user: CurrentUserPayload, auditMeta: AuditMeta) {
  const row = await this.findByIdOrThrow(id);

  // RBAC + ownership 校验(沿现有 PR #6b)
  const { resource, scope } = await this.buildRbacResourceAndScope(...);
  await this.assertRbacAllowed(user, action, resource);

  // 事务内:DB 删 + audit(沿 PR #6c F4 同事务 fail-fast)
  await this.prisma.$transaction(async (tx) => {
    await tx.attachment.delete({ where: { id } });
    await this.auditLogs.log({ event: 'attachment.delete', ..., tx });
  });

  // 事务外:同步尝试 Provider 删(F4;失败 logger.warn,不回滚 audit)
  try {
    await this.storage.deleteObject(row.key);
    // audit extra.providerDeleteStatus = 'success'(B4 扩展)
  } catch (err) {
    this.logger.warn({ msg: 'provider delete failed', key: row.key, err });
    // audit extra.providerDeleteStatus = 'failed';依赖 Provider lifecycle 兜底
  }

  return toResponseDto(row);
}
```

**为什么 Provider 删放事务外?**

- 事务内 Provider 调用是**外部网络 IO**,会拉长事务窗口(Postgres 锁持有时间)
- Provider 删失败应**不回滚 DB 删**(沿 D6 §六.1:硬删不可恢复,接受;Provider versioning 兜底)
- audit `attachment.delete` 已**先写**(沿 F6 同事务 fail-fast);Provider 删后状态通过 `extra.providerDeleteStatus` 更新(B4 扩展)
- ⚠️ **Q3 待评审**:audit 写在 Provider 删之前 → audit 中 `providerDeleteStatus` 是否要后置更新?候选 A:audit 写一次,状态 = 'pending' / B:audit 写一次,不记 providerDeleteStatus(让运维查 Provider) / C:audit 写两次(delete + provider-delete-status)

### 5.3 versioning + lifecycle 兜底(沿 F4)

**Provider 端配置**(各 Provider 等价能力):

| Provider | versioning 能力 | lifecycle 能力 | v0.1 推荐 |
|---|---|---|---|
| AWS S3 | ✅ versioning | ✅ Lifecycle(expire / glacier) | versioning 启用 + 30 天 expire 旧版本 |
| Cloudflare R2 | Beta(2024+) | ✅ Lifecycle Rules | 留 Q11 评审 |
| 阿里 OSS | ✅ 多版本控制 | ✅ 生命周期规则 | versioning 启用 + 30 天 expire |
| 腾讯 COS | ✅ 版本控制 | ✅ 生命周期 | versioning 启用 + 30 天 expire |
| MinIO | ✅ versioning | ✅ ILM(Information Lifecycle Management) | 自配 |
| LocalProvider | ❌ 无 | ❌ 无 | dev / test;不做兜底 |

**v0.1 拍板**:启用 versioning;**30 天 expire 旧版本**;具体 lifecycle 配置由 Q11 评审锁定。

---

## 6. 候选 Provider 矩阵

### 6.1 7 维风险对比(沿 Step 1 调研报告 §6)

| Provider | 适合规模 | 成本(中国大陆向) | 合规 / 数据主权 | 私有访问 | 误删恢复 | 迁移难度 |
|---|---|---|---|---|---|---|
| **本地磁盘**(LocalProvider) | 开发 / 单机 / < 10GB | ¥0 | 完全自主 | 通过后端代理 | 需自实现备份(rsync) | 不可平移到云 |
| **AWS S3** | 任意规模 | 中(美区便宜) | ⚠️ 海外数据;**国内合规风险**(PIPL 跨境评估) | signed URL | versioning + lifecycle | 易(标准协议) |
| **Cloudflare R2** | 任意规模 | 低(**无 egress 费**) | ⚠️ 海外节点;同 PIPL 风险 | signed URL(S3 兼容) | versioning(Beta) | 易(S3 兼容) |
| **阿里 OSS** | 任意规模(**国内首选**) | 低 - 中 | ✅ **国内合规友好**(ICP / 实名认证) | signed URL / STS | versioning + lifecycle | 中(SDK 差异;支持 S3 兼容协议) |
| **腾讯 COS** | 任意规模(**国内首选**) | 低 - 中 | ✅ 同 OSS | signed URL / STS | versioning + lifecycle | 中(SDK 差异;支持 S3 兼容协议) |
| **MinIO**(自托管 S3) | 中小规模 / 自部署 | 服务器成本 | ✅ 完全自主 | signed URL | 自配 lifecycle | 易(S3 兼容) |
| **七牛 Kodo** | 中小规模 / 国内 | 低 | ✅ 国内合规 | signed URL | versioning(Beta) | 中 |

### 6.2 v0.2 锁定后端(沿 F3 + 用户拍板)

**🔒 v0.2 锁定**:**正式 Provider = 腾讯云 COS**(国内合规 + 业务方已有腾讯云资源)+ **LocalProvider(dev / test 用)**。

| Provider | v0.2 状态 |
|---|---|
| **腾讯云 COS** | ✅ **生产正式 Provider**(Q1 / Q4 v0.2 锁) |
| **LocalProvider** | ✅ **dev / test 必选**(沿 F2;ARCHITECTURE.md §9 升级路径范式) |
| 阿里 OSS | ❌ 不采用(同等国内合规,但业务方已锁腾讯生态) |
| MinIO | ❌ 不采用(队组织无自建 IDC 诉求) |
| AWS S3 / Cloudflare R2 / 七牛 Kodo | ❌ 不采用(国内合规风险 / 已锁腾讯生态) |

### 6.3 Q1 业务方先决条件(✅ v0.2 锁)

**🔒 v0.2 锁**:业务方既有云资源 = **腾讯云**(用户拍板);沿 F3 国内合规优先原则,优先复用既有云生态。

**Q1 历史候选**(已锁定 B 腾讯;留作历史参考):
- ~~选项 A:已有阿里云账号 → OSS 优先~~ ❌ 未采用
- ✅ **选项 B:已有腾讯云账号 → COS 优先**(v0.2 锁)
- ~~选项 C / D / E~~ 不适用

### 6.4 COS 落地技术细节(🔒 v0.2 锁 Q11 / Q12 / Q14 / Q16 / Q17 / Q18 / Q19)

#### 6.4.1 私有桶 + signed URL(Q16 v0.2 锁)

**🔒 v0.2 锁**:**所有 attachments bucket 强制私有桶**(`Bucket ACL = private`);**永不开放公有读**;**所有访问 100% 走 signed URL**(沿 F2 模式 B)。

- 上传:`PUT signed URL`(600s 过期;沿 Q8)
- 下载:`GET signed URL`(300s 过期;沿 Q8)
- 列表:**不暴露 Provider 端列表能力**;业务层走 DB 查 `attachments` 表(沿 §7.2 接口扩展;`StorageProvider` 不收录 `listObjects`)
- **客户端不可直接拼 URL 访问 Provider**(沿 D7-attachments §6.5 accessLevel + RBAC 单一权威源)

**绕过 RBAC 风险**:由于 signed URL 是短期有效的(300/600s),即使被 XSS 截获,过期后自动失效(沿 §14 风险 8 + Q13 信息泄漏防御)。

#### 6.4.2 key 命名规范(Q17 v0.2 锁)

**🔒 v0.2 锁定 key 命名 schema**:

```
attachments/<env>/<yyyy>/<mm>/<dd>/<cuid>.<ext>
```

**字段释义**:

| 字段 | 取值规则 | 例 |
|---|---|---|
| `attachments/` | 固定前缀(沿 D7-attachments `key` 字段语义;§5.4.1) | `attachments/` |
| `<env>` | 环境前缀:`dev` / `test` / `prod`(沿 Q18 bucket 环境隔离)| `prod/` |
| `<yyyy>/<mm>/<dd>` | 上传日期(UTC;按 `uploadedAt` 计算)| `2026/05/15/` |
| `<cuid>` | 复用 `attachment.id` cuid(沿现有 Prisma `@id @default(cuid())`)| `cl9z3a8b...` |
| `<ext>` | MIME 推断的扩展名(`image/jpeg → .jpg` / `application/pdf → .pdf` 等)| `.jpg` |

**完整例**:`attachments/prod/2026/05/15/cl9z3a8b00000abcd1234efgh.jpg`

**为什么不用 `originalName`?**:
- 沿 D7-attachments Q9 + §9.4 PII 铁律:**`originalName` 可能含身份证号正则模式**(已 Service 层拒;但额外防御);**key 不复用 originalName** 避免 Provider 侧路径含 PII
- 沿 storage.interface.ts `key` 字段语义(Provider 侧唯一引用,非用户可见字符串)
- 用 `attachment.id` cuid 保证全局唯一 + 短期不可猜测

**冲突避免**:cuid 已全局唯一(沿 v1 §3 命名铁律 `cuid()` 字符串)+ 日期前缀防同日撞库;实际 collision 概率 < 10⁻¹⁵。

#### 6.4.3 bucket 环境隔离(Q18 v0.2 锁)

**🔒 v0.2 锁**:**单 bucket + key 前缀环境隔离**(沿 Q17 `<env>` 前缀)。

| 环境 | Bucket 名(候选) | key 前缀 | 用途 |
|---|---|---|---|
| dev | `srvf-attachments` | `attachments/dev/...` | 本地 LocalProvider 主用;偶尔接 COS 联调 |
| test | `srvf-attachments` | `attachments/test/...` | CI / e2e |
| prod | `srvf-attachments` | `attachments/prod/...` | 生产 |

**为什么不多 bucket?**:
- 单 bucket 简化运维(IAM / 计费 / lifecycle 配置统一)
- 沿 Q17 key 前缀已天然隔离;权限通过 IAM Policy 限制访问范围
- 沿 D7-attachments F4 配置三表入口固定 `@Roles(SUPER_ADMIN, ADMIN)`,运维操作可控

**多 bucket 备选(留 v1.0 / 实施期决议)**:若 dev / test / prod 完全隔离 + 跨环境数据不可读取诉求,可改为 3 bucket(`srvf-attachments-dev` / `srvf-attachments-test` / `srvf-attachments-prod`);沿 ARCHITECTURE.md §9 升级路径。

#### 6.4.4 加密(Q12 v0.2 锁)

**🔒 v0.2 锁**:**COS 服务端加密 SSE-COS**(腾讯云原生;等价 AWS SSE-S3)。

- **启用方式**:bucket 默认加密策略 = `AES256`;**配置在 COS 控制台侧设置**(队组织运维操作;**`storage_settings` 不承载加密策略细节**,仅承载 `providerType` / `bucket` / `region` 等运行参数;沿 Q20 / Q24)
- **客户端透明**:上传时无需指定加密参数;COS 自动加密落盘
- **❌ 不启用 SSE-KMS**(沿 D6 决议 4 最低合规版;KMS 复杂度 + 成本不必要;沿 D7-attachments §11 风险 3 接受)
- **❌ 不启用 SSE-C**(客户端管理密钥;复杂度过高)

**合规依据**:沿 D7-attachments §9.1 "Provider 侧 SSE-S3 等价默认透明加密"(已锁)。

#### 6.4.5 versioning + lifecycle(Q11 v0.2 锁)

**🔒 v0.2 锁**:

| 项 | 配置 | 用途 |
|---|---|---|
| **多版本控制(versioning)** | ✅ 启用 | 误删兜底(沿 D6 §六.1 风险接受) |
| **生命周期规则 1**:旧版本 30 天 expire | `NoncurrentVersionExpiration.NoncurrentDays = 30` | 误删 30 天内可恢复;30 天后 COS 自动清理 |
| **生命周期规则 2**:删除标记 expire 即清除 | `Expiration.ExpiredObjectDeleteMarker = true` | 防"已删但有 DeleteMarker"占用 list 结果 |
| **生命周期规则 3**:incomplete multipart upload 7 天 abort | `AbortIncompleteMultipartUpload.DaysAfterInitiation = 7` | 防 confirm-upload 失败留下的孤儿分片(沿 Q13 暂不实施 multipart,但此规则提前兜底) |
| **❌ 不启用** glacier / 冷归档 | — | 沿决议 4 最低合规版;访问频率低但延迟敏感 |
| **❌ 不启用** lifecycle 删活动版本 | — | 沿 D7-attachments §9.2 不做自动清理 |

**实际配置由运维在 COS 控制台 / Terraform 设置**(系统侧不承载 lifecycle 规则本身);**但 `lifecycleDays` 数值作为业务侧引用值,存入 `storage_settings.lifecycleDays`**(沿 Q11 + Q20 + §6.5);两侧由运维保持一致(运维 SOP 文档锁定流程)。

#### 6.4.6 CORS(Q14 v0.2 锁)

**🔒 v0.2 锁定 CORS 规则**(COS bucket 侧 + `storage_settings.corsAllowedOrigins` 双侧维护):

```json
{
  "AllowedOrigins": ["https://<your-frontend-domain>"],
  "AllowedMethods": ["PUT", "GET", "HEAD"],
  "AllowedHeaders": ["Content-Type", "Content-MD5", "x-cos-*"],
  "ExposeHeaders": ["ETag", "x-cos-request-id"],
  "MaxAgeSeconds": 3600
}
```

**配置位置**:
- COS bucket 侧实际 CORS Rule(运维在 COS 控制台 / Terraform 配置)
- 业务侧 `storage_settings.corsAllowedOrigins`(JSON;沿 Q20 + §6.5)— 用于业务层日志展示 / 排障 + 后续 v1.1+ 若需要 Service 层校验前置 origin
- 两侧由运维 SOP 保持一致(沿 §6.4.5 lifecycle 同范式)

**字段释义**:
- `AllowedOrigins`:**生产域名白名单**(具体域名由前端项目方提供;**❌ 不允许 `*` 通配**)
- `AllowedMethods`:`PUT`(上传)+ `GET`(下载)+ `HEAD`(headObject 校验);**不开放 `POST` / `DELETE`**(沿 §6.4.1 私有桶 + signed URL)
- `AllowedHeaders`:必填 `Content-Type` + 可选 `Content-MD5`(checksum 校验)+ COS 私有 `x-cos-*` 头
- `ExposeHeaders`:暴露 `ETag` 给客户端(confirm-upload 时校验)+ `x-cos-request-id`(排障)
- `MaxAgeSeconds`:`3600`(1 小时 preflight 缓存)

**dev / test 环境**:CORS 允许 `http://localhost:*`(沿 v1 / V1.1 既有 CORS 配置范式)。

#### 6.4.7 不采用 STS 临时凭证(Q19 v0.2 锁)

**🔒 v0.2 锁**:**不采用 STS**(沿 F2 模式 B + Q13 暂不实施 multipart)。

**理由**:
- STS 主要解决**大文件 multipart upload**(SDK 端 multipart 分片上传需要持续凭证);沿 Q13 v0.2 锁"本批次不实施 multipart",STS 暂无必要
- signed URL(模式 B)单文件 ≤ 5GB(腾讯 COS PUT API 上限);足够 attachments 业务场景(身份证 / 证件 / 活动照片普遍 < 10MB)
- STS 引入额外 SDK 依赖 + 客户端复杂度;暂不引入(沿 V1.1 §17.3 / D6 决议 5 最小集)

**未来启用条件**(留 v1.1 / 实施期评估):
- 出现单文件 > 5GB 的业务诉求(C-7 4 个 ownerType 场景预期无此需求)
- 客户端需要 multipart 分片上传(大文件 / 弱网络)

#### 6.4.8 路径规范汇总(沿 Q16-Q19)

| 维度 | 规则 |
|---|---|
| Bucket 访问 | 私有(沿 Q16);永不公有读 |
| Bucket 数量 | 单 bucket(沿 Q18) |
| Key 格式 | `attachments/<env>/<yyyy>/<mm>/<dd>/<cuid>.<ext>`(沿 Q17) |
| 上传方式 | PUT signed URL(沿 F2 + Q19);TTL 600s(沿 Q8) |
| 下载方式 | GET signed URL(沿 F2);TTL 300s(沿 Q8) |
| 加密 | SSE-COS(沿 Q12) |
| versioning | 启用 + 30 天 expire 旧版本(沿 Q11) |
| CORS | 生产白名单 + PUT/GET/HEAD + 3600s preflight(沿 Q14) |
| STS | 不采用(沿 Q19) |
| Multipart | 暂不实施(沿 Q13) |

### 6.5 Storage Settings 架构设计(🔒 v0.2 架构修订;Q20 / Q24 锁)

#### 6.5.1 设计原则

**🔒 v0.2 锁定原则**(沿用户拍板):

1. **底层模型一次设计对**:`storage_settings` schema 一次性设计完整(15+ 字段);后续扩展只**新增**字段,**绝不推翻 / 重命名 / 删除既有字段**
2. **实施可分批**:首期允许大部分字段闲置(`null` 默认值);后续 PR 逐步启用
3. **字段允许闲置,不允许未来推翻 schema**(沿 Q24)
4. **主路径 = 后台配置读取**;生产环境**不长期依赖 env**(沿 Q20 + Q23)
5. **凭证安全存储**:`secretIdEncrypted` / `secretKeyEncrypted` 加密落库(沿 Q21);API / UI 不回显明文(沿 Q22)

#### 6.5.2 候选 schema(完整 15 字段;实施期由 prisma 落地)

> ⚠️ **本节是 schema 设计草案**;**实施 PR 6 才创建实际 Prisma model + migration**;本评审仅锁定字段集 / 约束 / 默认值方向。

```prisma
// V2.x C-7.5 Provider 选型实施期落地(PR 6;本评审仅设计,不落代码)
//
// 设计原则:一次设计完整(沿 D7-provider Q24);允许首期闲置部分字段
// 但严禁未来推翻 schema 重新设计(沿用户拍板"底层模型一次设计对")。
//
// 单条记录(singleton row;运营通过 GET / PATCH 维护;不支持多 Provider 并存,
// 沿 Q4 锁腾讯 COS + Q18 单 bucket)。
model StorageSettings {
  id String @id @default(cuid())

  // ===== Provider 选型(沿 Q4)=====
  providerType    StorageProviderType  // 'local' | 'cos'(实施期补 enum)
  enabled         Boolean              @default(true)

  // ===== 运行参数(沿 Q11 / Q17 / Q18 / Q20)=====
  bucket          String?              // COS bucket 名;Local 留空
  region          String?              // COS region;Local 留空
  envPrefix       String?              // 沿 Q17 / Q18:'dev' | 'test' | 'prod';key 前缀
  uploadUrlTtlSeconds   Int            @default(600)   // 沿 Q8
  downloadUrlTtlSeconds Int            @default(300)   // 沿 Q8
  lifecycleDays         Int            @default(30)    // 沿 Q11

  // ===== 能力开关(允许闲置;首期可不启用)=====
  enableSignedUrl       Boolean        @default(true)  // 沿 F2;LocalProvider 仍走静态 URL
  enableVersioning      Boolean        @default(true)  // 沿 Q11

  // ===== CORS / 大小 / MIME 策略 =====
  corsAllowedOrigins    Json?          // 沿 Q14:string[];业务侧引用 + 运维 SOP 维护
  maxObjectSizeBytes    BigInt?        // 沿 D7-attachments §6 兜底;默认 null = 不限(由 attachment_size_limit_configs 管业务侧)
  allowedMimePolicyMode StorageMimePolicyMode? // 'inherit-attachment-configs' | 'override';沿 D7-attachments §6.6 + Q13 黑名单;首期 = 'inherit'

  // ===== 凭证(加密存储;沿 Q21 / Q22)=====
  // 实际加密算法 + key 派生策略由实施 PR 期决议(候选:AES-256-GCM + KMS / 应用层 key 派生)
  secretIdEncrypted     String?        // 加密后的密文;明文永不入库
  secretKeyEncrypted    String?        // 同上
  credentialConfigured  Boolean        @default(false) // 是否已配置凭证(沿 Q22 credentialStatus)

  // ===== 元信息 =====
  remarks               String?        // 运维备注
  updatedBy             String?        // User.id(沿 V2 updatedBy 范式)
  updatedAt             DateTime       @updatedAt
  createdAt             DateTime       @default(now())

  // ===== 关系(若需要)=====
  // updater User? @relation(fields: [updatedBy], references: [id], onDelete: SetNull)

  @@map("storage_settings")
}

enum StorageProviderType {
  LOCAL
  COS
}

enum StorageMimePolicyMode {
  INHERIT          // 沿 attachment_mime_configs(默认;首期锁定)
  OVERRIDE         // 由 storage_settings 直接限定(留 v1.1+ 启用;v0.2 不实施)
}
```

#### 6.5.3 字段释义 + 首期启用清单

| 字段 | 含义 | 首期启用?(实施 PR 6-10) | 来源决议 |
|---|---|---|---|
| `id` | 主键 cuid | ✅ 启用 | 沿 V2 范式 |
| `providerType` | Provider 类型 enum | ✅ 启用(枚举 `LOCAL` / `COS`) | Q4 + Q24 |
| `enabled` | 全局启用开关 | ✅ 启用 | Q20 |
| `bucket` | COS bucket 名 | ✅ 启用 | Q20 |
| `region` | COS region | ✅ 启用 | Q20 |
| `envPrefix` | key 环境前缀 | ✅ 启用 | Q17 / Q18 |
| `uploadUrlTtlSeconds` | 上传 signed URL TTL | ✅ 启用 | Q8 |
| `downloadUrlTtlSeconds` | 下载 signed URL TTL | ✅ 启用 | Q8 |
| `lifecycleDays` | 旧版本 expire 天数 | ✅ 启用(业务侧引用值;不写 COS API)| Q11 |
| `enableSignedUrl` | 是否启用 signed URL | ✅ 启用(`true`;LocalProvider 自行覆盖) | F2 |
| `enableVersioning` | versioning 业务侧引用 | ✅ 启用 | Q11 |
| `corsAllowedOrigins` | 业务侧引用 CORS origins | ⏳ 首期允许 `null`(运维 SOP 维护;v1.1+ 启用业务校验) | Q14 |
| `maxObjectSizeBytes` | 全局 size 兜底 | ⏳ 首期允许 `null`(由 `attachment_size_limit_configs` 管) | D7-attachments §6 |
| `allowedMimePolicyMode` | mime 策略模式 | 🔒 首期固定 `INHERIT` | D7-attachments §6.6 |
| `secretIdEncrypted` | 加密 SecretId | ✅ 启用(沿 Q21) | Q21 |
| `secretKeyEncrypted` | 加密 SecretKey | ✅ 启用(沿 Q21) | Q21 |
| `credentialConfigured` | 凭证状态 | ✅ 启用(沿 Q22) | Q22 |
| `remarks` | 运维备注 | ✅ 启用 | 通用 |
| `updatedBy` / `updatedAt` / `createdAt` | 审计字段 | ✅ 启用 | V2 范式 |

**首期闲置字段**(沿 Q24 一次设计;允许 `null` 默认值):
- `corsAllowedOrigins`(业务侧暂不引用 CORS 校验;运维 SOP 维护 COS bucket 侧 + 业务侧仅做日志展示)
- `maxObjectSizeBytes`(由 `attachment_size_limit_configs` 表承载;`storage_settings` 仅作全局兜底,首期不启用)

**闲置字段语义**:**字段在 schema 中已就位;首期 PR 不读不写**(默认 `null`);未来需要时**仅启用代码**(零 schema 改动)。

#### 6.5.4 单条记录约束(singleton row)

- 表名 `storage_settings`;**全局单条记录**(系统级配置);**不支持多 Provider 并存**(沿 Q4 + Q18)
- 首次启动若表为空:运维通过 `POST /api/v2/storage-settings` 创建首条记录(沿 PR 11 后台 CRUD)
- bootstrap fallback:**首次启动且 DB 无记录时,从 env 兜底读取 + 创建首条记录**(沿 Q23);**仅一次**;后续修改通过后台
- 后续访问:`GET /api/v2/storage-settings`(返单条;`credentialStatus` 状态化;不返加密密文)

#### 6.5.5 配置读取层(实施 PR 6)

**Service 范式**(沿 D7-RBAC `RbacService` / `RbacCacheService` 缓存范式):

```typescript
@Injectable()
export class StorageSettingsService {
  // 读取当前生效配置(缓存;TTL 60s 或 invalidate 主动失效)
  async getActiveSettings(): Promise<StorageSettingsResolved> {
    // 1. 查 DB(主路径)
    // 2. DB 空且非生产环境 → env fallback(沿 Q23)
    // 3. 缓存命中直接返
    // 4. 解密 secretIdEncrypted / secretKeyEncrypted(沿 Q21)→ 返 resolved
  }
}
```

`StorageSettingsResolved` 形态(运行时类型;**不进 API DTO**):

```typescript
export interface StorageSettingsResolved {
  providerType: 'LOCAL' | 'COS';
  enabled: boolean;
  bucket: string | null;
  region: string | null;
  envPrefix: string | null;
  uploadUrlTtlSeconds: number;
  downloadUrlTtlSeconds: number;
  lifecycleDays: number;
  enableSignedUrl: boolean;
  enableVersioning: boolean;
  corsAllowedOrigins: string[] | null;
  maxObjectSizeBytes: bigint | null;
  allowedMimePolicyMode: 'INHERIT' | 'OVERRIDE';
  credentials: { secretId: string; secretKey: string } | null;  // 明文;仅在 Service 内部使用
  credentialStatus: 'configured' | 'missing' | 'invalid';
}
```

⚠️ **`credentials` 在 API DTO 中永不出现**(沿 Q22)。

---

### 6.6 凭证安全边界(🔒 v0.2 架构修订;Q21 / Q22 锁)

#### 6.6.1 凭证存储

**🔒 v0.2 锁**:**SecretId / SecretKey 加密存储**(沿 Q21);**明文永不入 DB / 永不入日志 / 永不入 audit_logs**。

| 项 | 锁定值 |
|---|---|
| 存储列 | `storage_settings.secretIdEncrypted` / `secretKeyEncrypted`(String 类型,密文) |
| 加密算法 | **AES-256-GCM**(候选;实施 PR 期最终决议;不在 v0.2 锁具体算法,但锁"对称加密 + Authenticated Encryption + nonce") |
| 加密 key 来源 | **环境变量** `STORAGE_ENCRYPTION_KEY`(或等价 KMS 派生)+ 应用层 key derivation;**Key 自身 ≠ 凭证,可长期存 env**(沿 Q23 例外:env 可承载加密 key,但不承载凭证本身) |
| Key 轮换 | v1.1+ 启用;实施期不强制(留 SOP) |
| 解密时机 | **仅 `StorageSettingsService.getActiveSettings()` 内部解密**;返 `StorageSettingsResolved.credentials`(明文运行时对象);**不传出 Service 层** |

#### 6.6.2 API 边界(沿 Q22)

**🔒 v0.2 锁 4 项**:

1. **API 不返加密密文**:`GET /api/v2/storage-settings` 出参 **不含** `secretIdEncrypted` / `secretKeyEncrypted` 字段;仅返 `credentialStatus`(枚举)
2. **API 不返明文**:**永不**通过任何端点回显 SecretId / SecretKey 的明文
3. **UI 永不回显**:前端展示形如 `SecretId: 已配置 ✅` + `SecretKey: ********`(不显示前几位 / 后几位)
4. **只允许 reset / replace**:运维想更新凭证 → `POST /api/v2/storage-settings/reset-credentials`(入参 `{ secretId, secretKey }`;Service 层加密后落库;不返回任何凭证字段)

#### 6.6.3 凭证状态枚举 `credentialStatus`(沿 Q22)

```typescript
export enum CredentialStatus {
  CONFIGURED = 'configured', // secretIdEncrypted / secretKeyEncrypted 都已配置且解密成功
  MISSING = 'missing',       // 任一列为 null;系统未初始化
  INVALID = 'invalid',       // 配置存在但解密失败 / Provider 校验失败(沿 Q22 三档状态)
}
```

**UI 表现**:

```
SecretId:  已配置 ✅
SecretKey: ********
状态:      configured
[重新设置凭证]   [测试连接]
```

#### 6.6.4 DB 泄漏防御

沿 Q21 加密 at rest:

- DB dump / 备份泄漏 → 攻击者拿到密文 + 不知 `STORAGE_ENCRYPTION_KEY` → 无法解密
- `STORAGE_ENCRYPTION_KEY` 单独存 env(沿 v1 / V1.1 `JWT_SECRET` 范式;不进仓库;沿 ARCHITECTURE.md §13 / `.env.example` 注释)
- **双因素**:DB dump + env 文件 同时泄漏 → 凭证暴露;此风险**接受**(同 `JWT_SECRET` 同等防护级别;沿 D7-attachments §11 风险声明)

#### 6.6.5 audit 行为(沿 D7-attachments B4 + 本评审 B4)

- ❌ **凭证写操作不记 audit**(沿 D7-attachments §7.3 R4 read 不审计 + 沿 v0.2 B4 不新增 event;`POST /reset-credentials` 是配置维护,**不**触发 `attachment.*` 事件)
- ❌ **audit_logs `extra` 不记凭证字段**(沿 Q21 / Q22 明文永不出现)
- ✅ 仅在系统日志(pino;沿 V1.1 §17.4)记 reset 动作 + actorUserId + 不含密文 / 明文
- ⏳ 未来若需配置变更 audit(C-7.5 范围外),留独立"配置变更审计"专项评审 PR

---

## 7. StorageProvider 抽象接口扩展草案

### 7.1 当前 v1 极简版(沿 [`storage.interface.ts`](../src/common/storage/storage.interface.ts))

```typescript
export interface StorageProvider {
  putObject(input: PutObjectInput): Promise<StoredObject>;
  deleteObject(key: string): Promise<void>;
}
```

**v1 注释**(沿 storage.interface.ts:11-14):
> 刻意不收录的方法(留待 Provider 设计时定调):
> - get / getStream:下载流,牵涉权限 / range / content-disposition
> - exists:可由业务查 DB 或 Provider 自行决定
> - getUrl / getSignedUrl:公开访问 URL / 签名 URL / 过期时间 / 权限策略

### 7.2 v0.1 拍板扩展 6 方法(沿 F5)

```typescript
export interface StorageProvider {
  // === v1 已有(保留)===
  putObject(input: PutObjectInput): Promise<StoredObject>;
  deleteObject(key: string): Promise<void>;

  // === 新增(沿 F5)===
  generateUploadUrl(input: GenerateUploadUrlInput): Promise<UploadUrlResult>;
  // ↑ 模式 B(签名 URL)必备
  //   input: { key, contentType, sizeBytes, expiresIn }
  //   return: { url, method, headers, expiresAt }

  generateDownloadUrl(input: GenerateDownloadUrlInput): Promise<DownloadUrlResult>;
  // ↑ 给 accessUrl 字段填值
  //   input: { key, expiresIn, contentDisposition? }
  //   return: { url, expiresAt }

  headObject(key: string): Promise<HeadObjectResult>;
  // ↑ confirm-upload 后端校验(文件已上传)
  //   return: { exists, size?, etag?, contentType?, lastModified? }
}
```

**不收录**:

- `getStream` / `range`:走 signed URL 直下(沿 F2 / Q13 待评审)
- `listObjects`:业务层走 DB 查询 attachments 表;Provider 不需要列举能力
- `copyObject` / `moveObject`:本批次不实装(留 v1.1 / 实施期)
- `getMultipartUploadId` / `completeMultipartUpload`:Q13 待评审(若启用大文件 multipart;沿 STS 模式 C)

### 7.3 类型扩展草案

```typescript
// === 输入类型 ===
export interface GenerateUploadUrlInput {
  key: string;
  contentType: string;
  sizeBytes?: number;        // 用于 Content-Length pinning(可选)
  expiresIn: number;         // 秒;典型 600(10 分钟)
}

export interface GenerateDownloadUrlInput {
  key: string;
  expiresIn: number;         // 秒;典型 300(5 分钟)
  contentDisposition?: string; // 可选;`attachment; filename="..."`
}

// === 输出类型 ===
export interface UploadUrlResult {
  url: string;
  method: 'PUT' | 'POST';    // 大多 PUT;multipart 走 POST
  headers?: Record<string, string>;  // 必填 Content-Type 等
  expiresAt: Date;
}

export interface DownloadUrlResult {
  url: string;
  expiresAt: Date;
}

export interface HeadObjectResult {
  exists: boolean;
  size?: number;
  etag?: string;
  contentType?: string;
  lastModified?: Date;
}
```

### 7.4 Q5 接口签名细化(本 v0.1 待评审)

- **Q5a**:`expiresIn` 用秒还是 Date?(本 v0.1 倾向秒,简单)
- **Q5b**:`headers` 是否必返还是可选?(本 v0.1 倾向可选,留 Provider 决定)
- **Q5c**:`UploadUrlResult.method` 是否需要 `POST`(multipart)候选?(本 v0.1 留预留,但本 PR 不实施)

---

## 8. API 契约草案

### 8.1 v0.1 拍板新增 2 个端点(沿 B2)

| # | 方法 | 路径 | 用途 | 入口 Guard | Service 判权 |
|---|---|---|---|---|---|
| 1 | POST | `/api/v2/attachments/upload-url` | 申请签名上传 URL(模式 B) | `JwtAuthGuard`(沿 F3) | `rbac.can('attachment.upload.<type>.{self,other}', resource)` |
| 2 | POST | `/api/v2/attachments/confirm-upload` | 上传完成后落库 / 状态确认(模式 B) | `JwtAuthGuard` | 同上 |

**不动现有 7 个端点**(沿 B1 / B3):POST / GET × 4 / PATCH / DELETE 全部不动 path / 不动入参 / 不动出参 schema(除 `accessUrl` 由 null 改真实 URL)。

### 8.2 路径顺序铁律

```
/api/v2/attachments
  POST             (沿现有 PR #6b create;模式 B 下不再裸用)
  GET              (沿现有 list)

/api/v2/attachments/upload-url      ← 新增(在 :id 之前)
/api/v2/attachments/confirm-upload  ← 新增(在 :id 之前)
/api/v2/attachments/by-owner        (沿现有)
/api/v2/attachments/me/uploaded     (沿现有)
/api/v2/attachments/:id             (字面段优先)
/api/v2/attachments/:id/...
```

### 8.3 Q6 upload-url 字段集待评审

**Q6**(本 v0.1 草稿):`POST /api/v2/attachments/upload-url` 入参 / 出参字段集?

**入参候选(本 v0.1 倾向)**:

```typescript
class GenerateUploadUrlDto {
  @IsString() @MinLength(1) @MaxLength(64) ownerType!: string;
  @IsString() @Length(8, 64) ownerId!: string;
  @IsString() @MinLength(1) @MaxLength(255) originalName!: string;
  @IsString() @MinLength(1) @MaxLength(128) mime!: string;
  @IsInt() @Min(0) sizeBytes!: number;
  // 沿 D7-attachments DTO 字段集;不接受 key(由后端生成,沿 Q5 v0.1 倾向)
}
```

**出参候选(本 v0.1 倾向)**:

```typescript
class UploadUrlResponseDto {
  key!: string;                              // 后端生成(防客户端控制 key)
  uploadUrl!: string;                        // signed PUT URL
  uploadHeaders!: Record<string, string>;    // 必填 Content-Type 等
  expiresAt!: Date;                          // ISO8601
  // 可选:attachmentId(若 Q9 拍板"写入 pending row")
  attachmentId?: string;
}
```

**Q6a-Q6e 子项待评审**:

- Q6a:`key` 由谁生成?(本 v0.1 倾向后端;沿 Provider 命名规范)
- Q6b:是否同时落库 `attachment` row(状态 pending)?(本 v0.1 倾向"否";由 confirm-upload 落库;**否则 Q9 必须加 schema 字段 `uploadState`**)
- Q6c:upload-url 命中 ownerType / ownerId 校验是否在本端点执行?(本 v0.1 倾向"是";沿 D7-attachments §6.2 校验链)
- Q6d:upload-url 是否做 mime / size 白名单校验?(本 v0.1 倾向"是";沿 D7-attachments §6.2 mime / size 校验)
- Q6e:upload-url 是否做 PII 检测?(本 v0.1 倾向"是";沿 §9.4 身份证号正则)

### 8.4 Q7 confirm-upload 字段集待评审

**Q7**(本 v0.1 草稿):`POST /api/v2/attachments/confirm-upload` 入参 / 出参字段集?

**入参候选(本 v0.1 倾向)**:

```typescript
class ConfirmUploadDto {
  @IsString() @MinLength(1) @MaxLength(256) key!: string;  // upload-url 阶段返回的 key
  // 沿 Q6b 拍板:若 upload-url 已落库 pending row,这里加 @IsString() attachmentId
  // 若 upload-url 未落库,这里需要重复传 ownerType / ownerId 等
}
```

**Service 层逻辑**:

```typescript
async confirmUpload(dto: ConfirmUploadDto, user: CurrentUserPayload, auditMeta: AuditMeta) {
  // 1. 沿 Q6b:从 upload-url 阶段恢复 ownerType / ownerId / size / mime / ...
  //    候选 A:DB 查 pending row(若 Q6b = 落库)
  //    候选 B:JWT-like signed token 解码(若 Q6b = 不落库;upload-url 返 signed token)
  // 2. Provider.headObject(key) → 校验文件已上传 + 拿真实 size + etag
  // 3. PII 检测(沿 Q9):若 originalName / metadata 含身份证号 → 13015 + 删 Provider 文件
  // 4. 落库 attachment(状态 confirmed)+ audit attachment.upload(沿现有 PR #6c)
  // 5. 返 AttachmentResponseDto(含真实 accessUrl)
}
```

**出参候选**:`AttachmentResponseDto`(沿现有;`accessUrl` 由 `generateDownloadUrl` 填)

### 8.5 Q8 accessUrl TTL(🔒 v0.2 锁)

**🔒 v0.2 锁定 TTL**:

| 场景 | TTL | 说明 |
|---|---|---|
| **upload-url** | **600 秒**(10 分钟) | 给客户端预留上传时间;网络抖动 / 重试场景足够 |
| **download-url**(详情 / 列表) | **300 秒**(5 分钟) | 短期访问;过期后客户端可重新拉详情拿新 URL |
| **download-url**(预览 / batch) | **300 秒** | 沿 detail TTL;前端通过 detail 端点刷新 |

**为什么不更长?**:
- 越长越易被 XSS 截获后滥用(沿 §14 风险 8)
- 沿 D7-attachments §6.5 accessLevel + RBAC 单一权威:每次访问都经过后端判权 + 短期签名;权限变更后,旧签名 5 分钟内失效
- 前端按需通过 GET `:id` 端点刷新 URL(不影响体验;沿 Q15)

**为什么不更短?**:
- 上传 600s:覆盖弱网络上传 10MB 文件(测试 4G 网络下普遍 < 5 分钟)
- 下载 300s:覆盖单次 PDF / 图片预览;长会话场景刷新成本可接受

**Q5 子项**(`expiresIn` API 参数类型):**留 v1.0 / 实施期决议**(候选:秒数 vs Date 对象;本 v0.2 倾向"秒数",简单)。

---

## 9. schema 影响(沿 B1 暂不新增)

### 9.1 字段够用度核验

| 字段 | 当前 schema | Provider 接入后是否够用? | 是否新增 |
|---|---|---|---|
| `key` | `String` `@MaxLength(256)` | ✅ 够用;由后端生成 | ❌ 不动 |
| `etag` | `String?` `@MaxLength(128)` | ✅ 够用;confirm-upload 后写入 | ❌ 不动 |
| `checksum` | `String?` SHA-256 64 hex | ✅ 够用;可选(客户端可计算) | ❌ 不动 |
| `size` | `Int` | ✅ 够用;confirm-upload 后从 `headObject` 写回 | ❌ 不动 |
| `mime` | `String` | ✅ 够用 | ❌ 不动 |
| `accessLevel` | `AttachmentAccessLevel?` | ✅ 够用(沿 D7-attachments Q2 锁) | ❌ 不动 |
| `expireAt` | `DateTime?` | ✅ 够用 | ❌ 不动 |

### 9.2 Q9 是否需要 `uploadState` 字段(🔒 v0.2 锁:不新增)

**🔒 v0.2 锁**:**选项 A — 不新增 `uploadState` 字段**(沿 B1 + v0.1 倾向)。

| 选项 | 含义 | v0.2 状态 |
|---|---|---|
| **✅ A. 不新增** | upload-url 不落库 pending row;confirm-upload 时一次性落库 | **v0.2 锁** |
| ~~B. 新增 `uploadState` enum~~ | upload-url 落 pending row;confirm-upload 改 confirmed | ❌ 不采用 |
| ~~C. 新增独立 `attachment_upload_tokens` 表~~ | 单独存 pending 状态 + signed token | ❌ 不采用(复杂度过高) |

**v0.2 拍板理由**:
- 沿 B1 锁定"暂不新增 schema 字段"
- upload-url 端点用 **signed token**(JWT-like;或直接用 COS signed URL 自带的签名信息)防伪造;客户端必须**重传** ownerType/Id/size/mime 在 confirm-upload(同 signed token 验证)
- **最小改动**:零 schema diff;零 migration;沿 v0.10.0 终态 zero drift

**Q6 / Q7 子项**:upload-url 是否落 pending row(Q6b)/ confirm-upload 是否需要 attachmentId 入参(Q7)— **留 v1.0 / 实施期决议**(沿 Q9 锁定 A 后,默认 confirm-upload 一次性落库,不需要 attachmentId 入参,但具体字段集留 PR 细化)。

### 9.3 不动 schema 的运行时含义

- 沿 D7-attachments v1.0 `key` / `etag` / `checksum` / `accessLevel` / `expireAt` 字段集
- v0.10.0 段内 4 张表 schema 全部 zero drift
- contract snapshot 仅新增 2 个 paths(upload-url / confirm-upload)+ 对应 DTO(沿 B2 / B3)

---

## 10. RBAC 影响(沿 B3 不新增权限点)

### 10.1 复用现有 20 条 `attachment.*`

| 新增 API | 触发权限点 | 沿用现有? |
|---|---|---|
| `POST /upload-url` | `attachment.upload.<type>.<scope>` | ✅ 沿用 |
| `POST /confirm-upload` | 同上(upload 子步骤) | ✅ 沿用 |
| `GET /:id` 详情 `accessUrl` 字段 | `attachment.view.<type>.<scope>` | ✅ 沿用(沿 D7-attachments §6 + PR #6b) |
| `DELETE /:id` 追加 Provider 删 | `attachment.delete.<type>.<scope>` | ✅ 沿用 |

**结论**:**RBAC 现有 20 条权限点不动**(沿 D7-attachments Q11 锁定);Provider 接入不引入新权限点。

### 10.2 attachment.config.* 权限(配置三表)

**配置三表**(沿 D7-attachments F4 锁):入口仍 `@Roles(SUPER_ADMIN, ADMIN)`;**不接 Provider**(配置三表是 attachment_type_configs / mime_configs / size_limit_configs 的 CRUD,与 Provider 无关);本评审**不影响**配置三表。

---

## 11. audit_logs 影响(沿 B4 不新增 event)

### 11.1 复用现有 3 个 event

| 现有 event | Provider 接入后改动 |
|---|---|
| `attachment.upload` | **新增 `extra.uploadVia: 'direct' \| 'local'`**(B / D 模式区分);`extra.uploadConfirmedAt`(confirm-upload 时间戳) |
| `attachment.delete` | **新增 `extra.providerDeleteStatus: 'success' \| 'failed' \| 'skipped'`**(沿 F4)|
| `attachment.config.change` | ❌ 不动(配置三表与 Provider 无关) |

### 11.2 不新增 event(沿 B4)

- ❌ **不新增** `attachment.upload-url-issued`(签名 URL 申请失败不审计;沿 D7-attachments F6 / R4) 
- ❌ **不新增** `attachment.provider-delete-failed`(走 `attachment.delete` 的 `extra.providerDeleteStatus`;沿 D11 单事件 + extra)
- ❌ **不新增** `attachment.download-url-issued`(read 不审计;沿 R4)

**总结**:`AuditLogEvent` union **保持 17 项不动**;仅 extra 微调。

### 11.3 Q10 PII 检测在 confirm-upload 是否重做?(🔒 v0.2 锁:不重做)

**🔒 v0.2 锁**:**选项 A — 不在 confirm-upload 重做 PII 检测**(沿 v0.1 倾向)。

| 选项 | 理由 | v0.2 状态 |
|---|---|---|
| **✅ A. 不重做** | upload-url 已检;客户端不可能在上传过程中修改 originalName / description / tags;省一次正则 | **v0.2 锁** |
| ~~B. 重做一次~~ | 防客户端篡改 originalName(实际不会,因为 confirm-upload 不接受 originalName 入参) | ❌ 冗余 |

**v0.2 拍板理由**:
- upload-url 阶段已完整做 PII 检测(沿 Q6e + D7-attachments §9.4 身份证号正则)
- confirm-upload 入参仅 `{ key }` 或 signed token(不接受 originalName / description / tags 重传;沿 Q9 锁定 A)
- 沿 Q9 锁定 A 后,客户端无篡改 PII 字段的注入面;重做仅是无意义性能损耗

---

## 12. 合规 / 加密 / versioning(🔒 v0.2 锁 COS 落地配置)

### 12.1 加密(🔒 v0.2 锁 Q12;详见 §6.4.4)

- ✅ **COS SSE-COS**(腾讯云原生服务端加密;等价 AWS SSE-S3;沿 D7-attachments §9.1)
- ❌ **不启用 SSE-KMS**(沿 D6 决议 4 最低合规版)
- ❌ **不启用 SSE-C**(复杂度过高)
- 启用方式:COS 控制台 / Terraform 配置 bucket 默认加密策略 = `AES256`(**不在系统侧硬编码**)

### 12.2 versioning + lifecycle(🔒 v0.2 锁 Q11;详见 §6.4.5)

- ✅ **COS 多版本控制启用**(误删兜底;沿 D6 §六.1 风险接受)
- ✅ **lifecycle 旧版本 30 天 expire**(`NoncurrentVersionExpiration.NoncurrentDays = 30`)
- ✅ **DeleteMarker 即清除**(`Expiration.ExpiredObjectDeleteMarker = true`)
- ✅ **incomplete multipart 7 天 abort**(沿 Q13 兜底)
- ❌ 不启用 glacier / 冷归档(沿决议 4)
- 实际配置由运维在 COS 控制台 / Terraform 设置(**不写入系统**)

### 12.3 入队同意书 / 退队清理(沿 D7-attachments §9.5 / §9.6)

- 沿 D7-attachments **B8 入队同意书最低原则四锚点**(本评审不动)
- 沿 D7-attachments **Q8 退队清理 N 配置项语义**(本评审不动;由业务方 v1.1 提供 N 具体值)
- **Provider 不参与同意书 / 退队清理决策**(系统侧承载)

### 12.4 跨域 CORS(🔒 v0.2 锁 Q14;详见 §6.4.6)

```json
{
  "AllowedOrigins": ["https://<your-frontend-domain>"],
  "AllowedMethods": ["PUT", "GET", "HEAD"],
  "AllowedHeaders": ["Content-Type", "Content-MD5", "x-cos-*"],
  "ExposeHeaders": ["ETag", "x-cos-request-id"],
  "MaxAgeSeconds": 3600
}
```

- ❌ **不允许 `*` 通配 origin**(生产域名白名单)
- ❌ **不开放 `POST` / `DELETE` 方法**(沿 §6.4.1 私有桶 + signed URL;只允许 PUT 上传 / GET 下载 / HEAD 校验)
- dev / test 环境追加 `http://localhost:*`(沿 v1 / V1.1 既有 CORS 配置范式)

---

## 13. v1 14 + V2 131 全量接口 zero drift 守护(沿 A-2 红线)

### 13.1 contract snapshot 影响预估

| 改动 | snapshot 影响 |
|---|---|
| 新增 `POST /api/v2/attachments/upload-url`(B2) | +1 path + 1-2 DTO |
| 新增 `POST /api/v2/attachments/confirm-upload`(B2) | +1 path + 1 DTO |
| `accessUrl` 字段由 null 改真实 URL | **0 schema drift**(字段类型保持 `string \| null`;只是运行时值变化) |
| `delete()` 追加 Provider 删 | **0 schema drift**(API 入参 / 出参不变;事务结构改动属内部) |
| `audit_logs` extra 微调 | **0 schema drift**(extra 字段类型本就是 `Record<string, unknown>`) |

**总结**:contract snapshot **仅增量 2 paths + 2-3 DTOs**;**v1 14 + V2 131 既有接口字段 / 路径 / 错误码全部 zero drift**(沿 A-2)。

### 13.2 实施 PR 必须验证

- ✅ `pnpm test:contract` 通过 + snapshot 仅增量,**不变更既有字段**
- ✅ v1 14 + V2 131 既有接口 paths 不动
- ✅ 既有 22 个 attachments 端点 paths 不动

---

## 14. 风险声明(沿 D6 §六 + D7-attachments §11 + 业务方知情承担)

| # | 风险 | 业务方决议 / v0.1 倾向 | 沿用 |
|---|---|---|---|
| 1 | signed URL 在过期前被中间人截获 | 接受;HTTPS 强制 + content-type pinning + 过期短(600s) | D7-attachments §11 + 本评审 F2 |
| 2 | Provider 删失败留孤儿文件 | 接受;运维定期扫描 + versioning lifecycle 兜底 | F4 + 本评审 §5 |
| 3 | Provider 全局故障 → 上传失败 | 接受;系统可用性依赖 Provider SLA;无 fallback | 业务方接受 |
| 4 | LocalProvider 不可平移到云 | 接受;仅 dev / test 用;生产强制 OSS / COS / R2 | 本评审 F2 |
| 5 | upload-url 与 confirm-upload 之间客户端不调 confirm → 孤儿 Provider 文件 | 接受;Provider lifecycle 30 天自动清理(沿 F4) | 本评审 §5 |
| 6 | 跨 Provider 迁移成本 | 接受;`StorageProvider` 接口抽象 + 标准 S3 兼容协议优先 | 本评审 §6.2 |
| 7 | Provider 账单超支 | 接受;运维监控 + 上限告警(具体配置由队组织决定) | 业务方接受 |
| 8 | 客户端被 XSS 拿到 signed URL 直接下载 | 接受;沿 D7-attachments accessLevel 仅 hint + RBAC 单一权威;签名短期过期 | 本评审 §10 + §8.5 |
| 9 | 国内 Provider 数据合规未达预期 | 接受;沿 F3 阿里 OSS / 腾讯 COS ICP + 实名 | 本评审 F3 |

---

## 15. 测试覆盖建议

### 15.1 接口扩展层(`storage.interface.ts`)

- ✅ 类型定义 unit 测试(`expectType` / typescript-eslint 无新增 warning)
- ✅ LocalProvider 实装 unit 测试(`putObject` / `deleteObject` / `generateUploadUrl` 返本地 URL / `generateDownloadUrl` / `headObject`)

### 15.2 attachments service 集成层

- ✅ `toResponseDto` 在 LocalProvider 下 `accessUrl` 返本地 URL
- ✅ `delete()` 成功 / Provider 删失败 → `logger.warn` + audit `extra.providerDeleteStatus`
- ✅ `upload-url` 端点 e2e:成功 / RBAC 拒绝 / ownerType 拒绝 / mime 拒绝 / size 拒绝 / PII 拒绝
- ✅ `confirm-upload` 端点 e2e:成功(headObject 返 exists=true)/ 失败(exists=false → 13xxx)/ RBAC 拒绝

### 15.3 contract snapshot

- ✅ +2 paths(upload-url / confirm-upload)
- ✅ +2-3 DTOs(GenerateUploadUrlDto / UploadUrlResponseDto / ConfirmUploadDto)
- ✅ 既有 22 个 attachments path schemas zero drift

### 15.4 Provider 切换 e2e(Q15 待评审)

- ⏳ 若 Q15 决议"支持运行时 Provider 切换",需 e2e 跨 Provider 测试矩阵(LocalProvider × 真实 Provider)
- ✅ 本 v0.1 仅锁 LocalProvider e2e;真实 Provider e2e 留实施 PR

---

## 16. PR 拆分建议(🔒 v0.2 架构修订;Q25 锁分批;原 13 PR → 14 PR)

### 16.1 14 PR 节奏(v0.2 架构修订)

> **v0.2 架构修订**:新增 PR 6 设计 `storage_settings` schema + DTO + 配置读取层(沿 Q24);新增 PR 11 后台 Storage Settings CRUD + credential reset(沿 Q20-Q22);PR 8 改为 **COS Provider 读 `storage_settings`**(不直接读 env)。

| PR # | 类型 | 主题 | 范围 | 风险 |
|---|---|---|---|---|
| **设计** PR 1 | `docs(v2-design)` | add provider selection review draft v0.1 | 新建 `docs/批次7_provider选型_API前评审.md`(已合 PR #82,squash commit `6dbdbed`) | 低 |
| 设计 PR 2 | `docs(v2-design)` | refine provider selection v0.2 局部收口 + 架构修订 | **本 PR**(含初版 + 架构修订;Q20-Q25 新增锁) | 中 |
| 设计 PR 3 | `docs(v2-design)` | freeze provider selection v1.0 | 用户拍板剩余 Q5 / Q6 / Q7 后 | 中 |
| 设计 PR 4 | `docs(v2-design)` | start C-7.5 provider V2.x implementation track | 立项 PR | 低 |
| **实施** PR 5 | `chore` | extend StorageProvider interface(+ 4 method + types) | 仅 interface + types;0 实现 | **零运行时改动** |
| **实施** PR 6 | `chore(prisma)` | **add `storage_settings` schema + DTO + 配置读取层**(不接 COS SDK)| `prisma/schema.prisma` +1 model(15 字段;沿 §6.5)+ migration + `src/common/storage/storage-settings.service.ts` + DTO + e2e + bootstrap fallback(沿 Q23)| **中**(schema migration + 加密 key 装载) |
| 实施 PR 7 | `feat(storage)` | LocalStorageProvider 实装(dev / test;读 `storage_settings`)| `src/common/storage/providers/local.provider.ts` + unit | 低(本地;无云) |
| 实施 PR 8 | `feat(storage)` | **COS Provider 实装**(读 `storage_settings` 不依赖 env;沿 Q23)| `src/common/storage/providers/cos.provider.ts` + 引入 `cos-nodejs-sdk-v5` + unit | 中(引入云 SDK + 加密凭证读取) |
| 实施 PR 9 | `feat(attachments)` | wire attachments.service(`accessUrl` 真实化 + delete 同步 Provider 删) | 改 `toResponseDto` / `delete` 2 处 | **中**(contract snapshot 微调) |
| 实施 PR 10 | `feat(attachments)` | add upload-url + confirm-upload API(模式 B) | 新增 2 个端点 + DTOs + RBAC + audit extra + e2e | 中(contract +2 paths) |
| **实施** PR 11 | `feat(storage)` | **后台 Storage Settings CRUD + credential reset**(沿 Q20-Q22)| 新增 `/api/v2/storage-settings` × 2(GET + PATCH)+ `/api/v2/storage-settings/reset-credentials` × 1 + DTO + Service(凭证加密 / `credentialStatus`)+ e2e | 中(后台 UI 接口;凭证加密落库) |
| **landing** PR 12 | `docs(v2)` | record provider selection + implementation landing | CHANGELOG + V2 红线 §C-10 → 已落地 + TASKS + 立项记录 | 低 |
| **bump** PR 13 | `chore` | bump version to v0.11.0(SemVer minor;新增 1 model + 3 API + 加密凭证存储) | package + Swagger + CHANGELOG | 低 |
| **handoff** PR 14 | `docs(v2)` | add v0.11.0 handoff | `docs/handoff/v0.11.0.md` | 低 |
| **tag/release** | 维护者手动 | git tag + GitHub Release | 沿 v0.9.0 / v0.10.0 范式;由维护者执行 | 低 |

**累计**:**14 PR**(4 设计 + 7 实施 + 1 landing + 1 bump + 1 handoff + 维护者收尾)。

### 16.2 v0.2 架构修订关键改动(相比 v0.2 初版 13 PR)

| 改动 | v0.2 初版(13 PR) | v0.2 架构修订(14 PR) |
|---|---|---|
| PR 6 范围 | LocalProvider 实装 | **改为** `storage_settings` schema + 配置读取层(LocalProvider 后移 PR 7) |
| PR 8 范围 | <真实 Provider> 实装(读 env) | **改为** COS Provider 读 `storage_settings`(沿 Q23) |
| PR 11 | (无;原 11 是 bump) | **新增** 后台 Storage Settings CRUD + credential reset |
| PR 12 / 13 / 14 | landing / bump / handoff | 整体后移(原 PR 10 → 12 / 11 → 13 / 12 → 14) |

### 16.3 实施 PR 间依赖

```
PR 5(interface 扩展) ← 不依赖
PR 6(storage_settings schema + 配置读取层) ← 依赖 PR 5(用 interface 类型)
PR 7(LocalProvider) ← 依赖 PR 5 + 6
PR 8(COS Provider 读 storage_settings) ← 依赖 PR 5 + 6(可与 PR 7 并行)
PR 9(接通 attachments.service) ← 依赖 PR 5 + 6 + 7(LocalProvider 接通即可走 e2e)
PR 10(新 API upload-url + confirm-upload) ← 依赖 PR 5 + 6 + 7 + 9
PR 11(后台 CRUD + credential reset) ← 依赖 PR 6(用 StorageSettingsService;可与 PR 8-10 并行)
PR 12(landing) ← 依赖全部
PR 13(bump) ← 依赖 12
PR 14(handoff) ← 依赖 13
```

### 16.4 与 D7-attachments(C-7)节奏对比

| 维度 | C-7 attachments | C-7.5 Provider 选型(v0.2 架构修订)|
|---|---|---|
| 设计 PR | 5(#65-#69) | 4(D7-provider v0.1 → v0.2 含架构修订 → v1.0 → 立项) |
| 实施 PR | 9(#70-#78) | 7(interface + storage_settings + Local + COS + 接通 + 新 API + 后台 CRUD) |
| docs | landing + bump + handoff = 3 | landing + bump + handoff + 维护者 tag/release = 3 + 1 |
| **累计** | **17** | **14** |

**实施密度差异**:C-7 是新建主模块 + 配置三表 + RBAC + audit 全栈;C-7.5 是在 C-7 基础上**接通 Provider + 引入 `storage_settings` 配置表 + 加密凭证存储 + 后台 CRUD**;比 v0.2 初版多 1 PR(后台 CRUD),但**底层架构一次设计对**(Q24)。

---

## 17. 验收门槛(沿 baseline §14)

### 17.1 v0.1 草稿 PR(本 PR)验收

- ✅ 新建 `docs/批次7_provider选型_API前评审.md` v0.1 草稿
- ✅ 不动 `src/**` / `prisma/**` / `test/**` / `package.json` / `pnpm-lock.yaml` / `CHANGELOG.md`
- ✅ 不动 [`docs/批次7_attachments_API前评审.md`](批次7_attachments_API前评审.md)(D7-attachments v1.0 冻结稿;沿 F1)
- ✅ `pnpm lint` / `pnpm typecheck` / `pnpm build` 通过(纯 docs,无副作用)
- ✅ Contract snapshot 0 drift

### 17.2 后续 v0.2 / v1.0 PR 验收

- ⏳ 用户拍板 Q1-Q15 后,出 v0.2 局部收口 PR
- ⏳ 全部 Q 决议锁定后,出 v1.0 冻结 PR
- ⏳ v1.0 冻结后,出立项 PR(沿 D7-attachments PR #69 范式)
- ⏳ 立项 PR 合入后,启动 PR 5-13 实施

---

## 18. 关联说明 / 边界澄清

### 18.1 与 D7-attachments v1.0 关系(沿 F1)

- **D7-attachments v1.0 冻结稿不回改**(沿 F1)
- 本评审承接 D7-attachments Q14 / Q15 挂起项
- D7-attachments v1.0 中 attachments 主模块 / 配置三表 / RBAC / audit 已全部就位;**本评审仅决议 Provider 接通方式**

### 18.2 与 v1 极简 storage.interface.ts 关系

- v1 极简版(沿 `storage.interface.ts:7-9`)是占位骨架
- 本评审锁定 6 方法扩展(沿 F5)
- 实施 PR 5 修改 `storage.interface.ts` + `storage.types.ts`,**不破坏 v1 已有 2 方法**(`putObject` / `deleteObject` 沿用)

### 18.3 与 V2 红线 §4 C-10 关系

- V2 红线 **C-10**:文件上传 Provider 实装(本地 / OSS / R2)
- 本评审是 **C-10 的具体决议路径**
- 本评审 v1.0 冻结后,C-10 行从"复活路径"更新为"已实施"(沿 C-7 landing PR #79 更新 §4 C-7 行范式)

### 18.4 与 ARCHITECTURE.md §9 升级路径关系

- §9 升级路径:**"第一个产品需要文件上传时,接入 Provider"**
- 本评审正是 §9 触发后的决议路径
- 沿 §9:"按 §9 升级路径在 `src/common/storage/providers/` 下落地具体 Provider,届时再补 storage.module.ts 与注入 token"

### 18.5 与 PII 检测 Q9 / §9.4 关系

- D7-attachments §9.4 PII 铁律:**身份证图像永远以图像形态存储于 Provider 侧;DB / API / 日志 / audit_logs 永不出现身份证号字符串**
- 本评审 Q6e + Q10 沿用 PII 检测;Provider 接入不影响铁律

---

## 19. 决议表(C-7.5 Provider 选型 v0.2 局部收口)

> **状态历程**(修订日志,只在本说明区出现历史措辞):
> - **v0.1 草稿**(PR #82,squash commit `6dbdbed`,2026-05-15):5 项 F 锁 + 5 项 B 锁(沿用户启动 v0.1 时拍板)+ **15 项 Q 以"⏳ 待评审"承载**
> - **v0.2 局部收口(初版)**(本 PR commit 1,2026-05-15):用户拍板 **正式 Provider = 腾讯云 COS**(Q1 / Q4 锁定);沿用 v0.1 的 F1-F5 + B1-B5;**新锁 14 项 Q**(Q1 / Q4 / Q8 / Q9 / Q10 / Q11 / Q12 / Q13 / Q14 / Q15 + 新增 Q16 / Q17 / Q18 / Q19)
> - **v0.2 架构修订**(本 PR commit 2,2026-05-15):用户拍板 **COS 配置后台化 + 凭证加密存储**;**不长期依赖 env**;**新增 Q20-Q25 共 6 项 Q**(后台配置 / 凭证加密 / 不回显 / 不依赖 env / schema 一次设计 / 实施分批);**新增 §6.5 Storage Settings 架构设计 + §6.6 凭证安全边界**;**§16 PR 拆分 13 → 14 PR**(沿用户拍板原则:底层模型一次设计对,实施可分批);**留 3 项 Q 待 v1.0 / 实施期决议**(Q5 / Q6 / Q7;接口与 DTO 字段集);v1.0 暂不冻结
> - 🔒 = v0.1 / v0.2 锁;⏳ = v1.0 / 实施期待决议;🆕 = v0.2 架构修订新增

| # | 决议 | v0.2 状态 | 来源 / 章节 |
|---|---|---|---|
| F1 | 本 Provider 选型评审独立进行,**不回改 D7-attachments v1.0 冻结稿** | 🔒 v0.1 → v0.2 锁 | 用户拍板 |
| F2 | 生产推荐 **signed URL 模式(B)**;dev / test 推荐 **LocalProvider(D)** | 🔒 v0.1 → v0.2 锁 | 用户拍板 / §4 |
| F3 | 存储后端 **国内合规优先**(腾讯 COS / 阿里 OSS 二选一);**若队组织已有云资源,优先复用** | 🔒 v0.1 → v0.2 锁;Q4 已具体化为腾讯 COS | 用户拍板 / §6 |
| F4 | 删除策略 = **同步尝试 + 失败 logger.warn + Provider lifecycle / versioning 兜底**;**不引入队列**(沿 V1.1 §17.3) | 🔒 v0.1 → v0.2 锁 | 用户拍板 / §5 |
| F5 | `StorageProvider` 接口扩展方向 = **6 方法**(`putObject` / `deleteObject` 沿用 + `generateUploadUrl` / `generateDownloadUrl` / `headObject` 新增) | 🔒 v0.1 → v0.2 锁 | 用户拍板 / §7 |
| B1 | **暂不新增 schema 字段**(沿 D7-attachments v1.0 `key` / `etag` / `checksum` / `accessLevel` / `expireAt` 够用) | 🔒 v0.1 → v0.2 锁 | 用户拍板 / §9 |
| B2 | API 候选新增 **upload-url + confirm-upload** 2 个端点;**不动现有 7 个 attachments 端点 paths / 入参 / 出参 schema** | 🔒 v0.1 → v0.2 锁 | 用户拍板 / §8 |
| B3 | **RBAC 不新增权限点**;沿现有 20 条 `attachment.*`(沿 D7-attachments Q11) | 🔒 v0.1 → v0.2 锁 | 用户拍板 / §10 |
| B4 | **audit 不新增 event**;仅 `attachment.upload` / `attachment.delete` 的 `extra` 扩展 Provider 信息(`providerDeleteStatus` / `uploadConfirmedAt`;沿 D11 路线 A 单事件 + extra) | 🔒 v0.1 → v0.2 锁 | 用户拍板 / §11 |
| B5 | PR 拆分先按 **13 PR 设计节奏**(4 设计 + 5 实施 + 1 landing + 1 bump + 1 handoff + 1 维护者 tag/release)| 🔒 v0.1 → v0.2 锁(建议;实施期允许微调,沿 D7-attachments Q16 范式) | 用户拍板 / §16 |
| **Q1** | 业务方既有云资源 | 🔒 **v0.2 锁**:**腾讯云**(用户拍板) | §6.3 |
| Q2 | 上传模式 A 中转 / B 签名 URL / C STS / D 本地 终选 | 🔒 v0.1 → v0.2 锁:生产 = B + dev = D;C STS 不采用(沿 Q19) | §4 |
| Q3 | 删除策略 A 同步事务 / B 异步队列 / C 同步 + 告警 / D 仅 versioning 终选 | 🔒 v0.1 → v0.2 锁:**C + D**(同步 + 告警 + COS lifecycle 兜底) | §5 |
| **Q4** | 存储后端具体选择 | 🔒 **v0.2 锁**:**腾讯云 COS**(沿 Q1;不再 OSS 候选) | §6.2 |
| Q5 | `StorageProvider` 接口签名细化(`expiresIn` 类型 / `headers` 必填性 / `method` 是否含 POST 候选) | ⏳ **v1.0 / 实施期决议**(本 v0.2 不锁;留 PR 5 interface 扩展实施期落地) | §7.4 / §8.5 |
| Q6 | `POST /upload-url` DTO 字段集 + Q6a-Q6e 子项 | ⏳ **v1.0 / 实施期决议**(本 v0.2 不锁;留 PR 9 实施期落地;沿 Q9 锁定后 attachmentId 字段去留) | §8.3 |
| Q7 | `POST /confirm-upload` DTO 字段集 | ⏳ **v1.0 / 实施期决议**(本 v0.2 不锁;留 PR 9 实施期落地) | §8.4 |
| **Q8** | `accessUrl` 签名过期 TTL | 🔒 **v0.2 锁**:upload = 600s / download = 300s | §8.5 |
| **Q9** | 是否新增 `uploadState` schema 字段 / 独立 `attachment_upload_tokens` 表 | 🔒 **v0.2 锁**:**A 不新增**(沿 B1;客户端用 signed token + confirm-upload 一次性落库) | §9.2 |
| **Q10** | PII 检测是否在 confirm-upload 重做 | 🔒 **v0.2 锁**:**A 不重做**(upload-url 已检;confirm-upload 不接受 originalName 等 PII 字段重传) | §11.3 |
| **Q11** | Provider versioning + lifecycle 具体配置 | 🔒 **v0.2 锁**:COS versioning 启用 + 旧版本 30 天 expire + DeleteMarker 即清除 + 7 天 abort incomplete multipart | §6.4.5 / §12.2 |
| **Q12** | 加密配置 | 🔒 **v0.2 锁**:**COS SSE-COS**(腾讯云原生;`AES256`);❌ 不启用 SSE-KMS / SSE-C | §6.4.4 / §12.1 |
| **Q13** | 大文件 multipart upload 支持 | 🔒 **v0.2 锁**:**本批次不实施**(单文件 ≤ 5GB 走 PUT signed URL);留 v1.1 / 实施期评估 | §4 / §6.4.7 |
| **Q14** | 跨域 CORS 配置 | 🔒 **v0.2 锁**:生产白名单 origin + `PUT/GET/HEAD` + `MaxAge=3600`;❌ 不允许 `*` 通配 | §6.4.6 / §12.4 |
| **Q15** | Provider 切换 / 跨 Provider 迁移路径 | 🔒 **v0.2 锁**:**COS 暂不迁移**;`StorageProvider` 接口抽象保证未来可平移(沿 S3 兼容协议) | §15.4 / §18 |
| **Q16**(新增) | 私有桶 vs 公有桶 | 🔒 **v0.2 锁**:**私有桶**;所有访问 100% 走 signed URL;**永不开放公有读** | §6.4.1 |
| **Q17**(新增) | key 命名规范 | 🔒 **v0.2 锁**:`attachments/<env>/<yyyy>/<mm>/<dd>/<cuid>.<ext>` | §6.4.2 |
| **Q18**(新增) | bucket 环境隔离 | 🔒 **v0.2 锁**:**单 bucket + key 前缀**(`dev` / `test` / `prod`);多 bucket 备选留 v1.0 / 实施期 | §6.4.3 |
| **Q19**(新增) | 是否采用 STS 临时凭证 | 🔒 **v0.2 锁**:**不采用 STS**(沿 F2 模式 B + Q13);未来 multipart 需要时 v1.1 / 实施期再评估 | §6.4.7 |
| **🆕 Q20** | COS 是否支持后台配置? | 🔒 **v0.2 架构修订锁**:**✅ 是**;**主路径 = `storage_settings` 后台配置读取**;env 仅作 bootstrap fallback / dev / test 兜底;**不长期依赖 env**(沿 Q23) | §6.5 |
| **🆕 Q21** | 凭证 SecretId / SecretKey 是否允许后台录入? | 🔒 **v0.2 架构修订锁**:**✅ 是**;**必须加密存储**(`secretIdEncrypted` / `secretKeyEncrypted` 列;AES-256-GCM 候选;加密 key 单独存 env);**明文永不入 DB / 日志 / audit_logs** | §6.6.1 |
| **🆕 Q22** | 凭证是否允许 API 明文返回 / UI 回显? | 🔒 **v0.2 架构修订锁**:**❌ 否**;API 不返加密密文;API 不返明文;UI 形如 `已配置 ✅` / `********`;只允许 reset / replace;`credentialStatus ∈ {configured, missing, invalid}` 状态化 | §6.6.2 / §6.6.3 |
| **🆕 Q23** | 是否长期依赖 env? | 🔒 **v0.2 架构修订锁**:**❌ 否**;env **仅允许** bootstrap fallback / 首次系统未初始化时兜底 / 本地开发环境;**例外**:加密 key(`STORAGE_ENCRYPTION_KEY`)允许长期存 env(沿 v1 `JWT_SECRET` 范式;加密 key ≠ 凭证) | §6.5.4 / §6.6.4 |
| **🆕 Q24** | `storage_settings` schema 是否一次设计完整? | 🔒 **v0.2 架构修订锁**:**✅ 是**;15 字段一次性设计完整(沿 §6.5.2);**允许首期闲置部分字段**(`corsAllowedOrigins` / `maxObjectSizeBytes`);**严禁未来推翻 schema 重做 migration**(允许新增,不允许重命名 / 删除既有字段;沿用户拍板"底层模型一次设计对") | §6.5.1 / §6.5.2 / §6.5.3 |
| **🆕 Q25** | 是否首期一次做完? | 🔒 **v0.2 架构修订锁**:**❌ 否**;**实施分批**(沿 §16 PR 6-14 共 9 个实施 / 收口 PR);PR 6 先做 schema + 配置读取层(不接 SDK)→ PR 7-10 逐步接入 → PR 11 后台 CRUD | §16.1 / §16.2 |

**总计**:**F 5 + B 5 + Q 25 = 35 项**

- **🔒 v0.2 已锁**:**F 5 + B 5 + Q 22 = 32 项**(初版 26 项 + 架构修订 6 项 Q20-Q25)
- **⏳ v1.0 / 实施期待决议**:**Q 3 项**(Q5 接口签名细化 / Q6 upload-url 字段集 / Q7 confirm-upload 字段集 — 实施 PR 期细化)
- **v0.2 局部收口完成**:Provider 选型核心决议 + 架构设计全部就位(腾讯云 COS + 私有桶 + signed URL + SSE-COS + versioning 30d + 不 STS / 不 multipart + **`storage_settings` 配置表一次设计** + **凭证加密存储** + **后台 CRUD** + **不长期依赖 env**);**剩余 3 项 Q 是 API 与 interface 字段集,可在 v1.0 冻结前补 + 实施 PR 期细化**
- **沿 D7-attachments v0.2 局部收口范式**:本评审 v0.2 锁 22 项 Q,超过 D7-attachments v0.2 的 13 项 Q,但仍属"局部收口"性质(留 3 项 Q 待决议)
- **架构修订原则确立**:**底层模型一次设计对,实施可分批,字段允许闲置不允许推翻 schema**(沿 Q24 + Q25)

---

## 20. 落地节奏

1. ✅ **C-7 attachments 全模块**(PR #65-#81 17 个;v0.10.0 段内全部 squash merge)
2. ✅ **v0.10.0 tag + GitHub Release**(2026-05-15;Latest)
3. ✅ **C-7.5 v0.1 草稿 PR**(PR #82,squash commit `6dbdbed`,2026-05-15)
4. **本 PR(C-7.5 v0.2 局部收口)** → 🔄 进行中;沿用户拍板 **腾讯云 COS** 锁 + 14 项 Q 锁
5. **C-7.5 v1.0 冻结 PR** → 用户拍板剩余 Q5 / Q6 / Q7 后启动(或决定推迟到实施 PR 期细化)
6. **C-7.5 V2.x 立项 PR**(沿 D7-attachments 立项 PR #69 / D7-RBAC 立项 PR #52 范式)→ 用户授权
7. **C-7.5 实施 PR 5-9**(沿 §16 13 PR 节奏)→ 逐 PR 用户授权
8. **C-7.5 landing PR 10** → 收口 docs(CHANGELOG / V2 红线 §C-10 / TASKS / 立项记录)
9. **C-7.5 bump PR 11**(沿 v0.10.0 / v0.9.0 bump 范式)→ `chore: bump version to v0.11.0`(或 v0.10.1)
10. **C-7.5 handoff PR 12** → `docs/handoff/v0.11.0.md`(或 v0.10.1)
11. **C-7.5 tag + Release**(维护者手动;沿 v0.10.0 维护者实际范式 = tag → handoff commit)

---

## 21. 撰写元信息

- **状态**:C-7.5 Provider 选型评审 **v0.2 局部收口稿**(撰写完成;入库待用户授权 squash merge 本 PR)
- **本评审稿自身的版本含义**:沿 D7-attachments v0.1 → v0.2 → v1.0 范式;**本 v0.2 是局部收口稿**;**v1.0 冻结由用户拍板剩余 Q5 / Q6 / Q7 后启动**(或决定推迟到实施 PR 期细化)
- **不在本评审范围**:
  - 任何代码 / schema / migration / Provider 实装(由对应实施 PR 承载)
  - D7-attachments v1.0 冻结稿任何回改(沿 F1)
  - C-7 attachments 7 端点 / 配置三表 15 端点 / 4 表 / 20 permission / 3 audit event(已锁;沿 D7-attachments v1.0 + v0.10.0 终态)
  - 腾讯云账号 / IAM / API key 等运维细节(由队组织运维侧承载;**不写入本仓库**)
  - COS 控制台 / Terraform 实际配置(沿 §6.4.4 / §6.4.5 / §6.4.6:运维手段配置,系统侧不硬编码)
  - tag + Release(沿 v0.10.0 维护者权限边界)
- **撰写者签名**:Claude Code(基于 C-7 attachments 17 PR 全程实施经验 + Step 1 调研报告 + v0.1 草稿 + 用户启动 v0.2 时拍板 9 项核心决议 + 腾讯云 COS 锁定;**未动任何代码 / schema 文件 / SDK 依赖**)
- **commit 风格**:`docs(v2-design): refine provider selection review decisions v0.2`(沿 D7-attachments v0.2 PR #67 `docs(v2-design): refine attachments API review decisions v0.2` 命名风格)

---
