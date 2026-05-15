# 《批次7_provider选型_API前评审稿》(C-7.5 Provider 选型 D7-provider v0.1 草稿)

> **状态**:**v0.1 草稿**(2026-05-15)— **触发条件**:C-7 attachments 全模块实施已收口(v0.10.0;沿 [`docs/handoff/v0.10.0.md`](handoff/v0.10.0.md));D7-attachments v1.0 冻结稿(PR #68,squash commit `5da801f`)挂起 Q14 / Q15 Provider 上传 / 删除策略,**留 Provider 选型评审稿**;C-7 attachments **9 个实施 PR(#70-#78)+ landing(#79) + bump(#80) + handoff(#81)** 共 17 PR 已全部入 main;`v0.10.0` tag + Latest GitHub Release 已发(`2f4b89d` → `1db905e`,2026-05-15)。本 PR 启动 **C-7.5 Provider 选型独立评审**,沿 D7-attachments v0.1 草稿 / D7-RBAC v0.1 草稿范式。
>
> **性质**:**C-7.5 Provider 选型评审 v0.1 草稿**(基于 C-7 attachments 落地后的现状 + V2 红线 §4 C-10 行 "文件上传 Provider 实装"复活路径 + 用户拍板 10 项 v0.1 拍板项;**沿 D7-attachments v1.0 冻结稿不回改**)。
> **批次号**:批次 7.5 暂定;正式编号以 **C-7.5 V2.x 立项 commit** 为准。
> **撰写日期**:2026-05-15(v0.1)
> **修订历程**(只在本说明区出现历史措辞):**v0.1 草稿**(本 PR,沿 D7-attachments v0.1 草稿范式;5 项 F 锁 + 3 项 B 锁 + 15 项 Q 待评审;**不回改 D7-attachments v1.0 冻结稿**)。
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
> **核心**(v0.1 草稿;5 项 F 锁 + 3 项 B 锁 + 15 项 Q 待评审;沿用户启动本 PR 时拍板的 10 项 v0.1 锁):
> - **F1 锁** 本 Provider 选型评审 **独立进行**,**不回改 D7-attachments v1.0 冻结稿**(沿 D7-attachments §16 决议表 Q14 / Q15 挂起范式;v1.0 冻结后由本评审承接)
> - **F2 锁** 生产推荐 **signed URL 模式**(沿 D7-attachments §5.5 模式 B);dev / test 推荐 **LocalProvider**(沿 ARCHITECTURE.md §9 升级路径范式)
> - **F3 锁** 存储后端 **国内合规优先**(阿里 OSS / 腾讯 COS 二选一);**若队组织已有云资源,优先复用**(避免选型脱离实际)
> - **F4 锁** 删除策略 = **同步尝试删除 + 失败 logger.warn**(Provider lifecycle / versioning 兜底);**不引入消息队列 / Redis / 异步 worker**(沿 V1.1 §17.3)
> - **F5 锁** `StorageProvider` 接口扩展方向 = **6 方法**(`putObject` / `deleteObject` 沿用 + `generateUploadUrl` / `generateDownloadUrl` / `headObject` 新增);`getStream` / `range` 不收录(走 signed URL 直传 / 直下,沿 F2)
> - **🔒 v0.1 拍板 5 项 B**:B1 暂不新增 schema 字段(沿 D7-attachments v1.0 `key` / `etag` / `checksum` / `accessLevel` / `expireAt` 够用)/ B2 API 候选新增 **upload-url + confirm-upload** 2 个端点 / B3 RBAC 不新增权限点(沿现有 20 条 `attachment.*`)/ B4 audit 不新增 event(仅 `attachment.upload` / `attachment.delete` 的 `extra` 扩展 Provider 信息)/ B5 PR 拆分先按 13 PR 设计节奏(沿用户启动本 PR 时拍板)
> - **本 v0.1 草稿待评审 15 项 Q**:Q1 业务方既有云资源 / Q2 上传模式 A/B/C/D 终选 / Q3 删除策略 A/B/C/D 终选 / Q4 存储后端 7 选项 / Q5 `StorageProvider` 接口签名细化 / Q6 `upload-url` API 字段集 / Q7 `confirm-upload` API 字段集 / Q8 `accessUrl` 短期过期 TTL / Q9 是否需要 `uploadState` schema 字段 / Q10 PII 检测是否在 confirm-upload 重做 / Q11 是否启用 Provider versioning / Q12 加密 SSE-S3 vs SSE-KMS / Q13 大文件 multipart upload 支持 / Q14 跨域 CORS 配置 / Q15 Provider 切换 / 迁移路径

---

## 0. 前置启动门槛(已通过)

- ✅ C-7 attachments 全模块已落地(v0.10.0;沿 [v0.10.0 handoff](handoff/v0.10.0.md))
- ✅ D7-attachments v1.0 冻结稿已合并(PR #68,squash commit `5da801f`,2026-05-14)
- ✅ Q14 / Q15 已锁"挂起待 Provider 选型评审"(沿 D7-attachments §16 决议表)
- ✅ V2 红线 §4 C-10 "文件上传 Provider 实装"已列入可复活项
- ✅ v0.10.0 tag + Latest GitHub Release 已发(`2f4b89d`,2026-05-15)
- ⏳ **业务方提供既有云资源信息**(Q1 待评审;若已有阿里 / 腾讯 / AWS / Cloudflare / 自部署,优先复用)
- ⏳ **用户拍板 v0.1 待评审 15 项 Q** → 进入 v0.2 局部收口阶段

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

### 6.2 v0.1 候选推荐(沿 F3)

**国内合规优先**(SRVF 业务全部在国内深圳;队员个人信息合规口径):

1. **阿里 OSS**(候选 1;若队组织已有阿里云资源)
2. **腾讯 COS**(候选 2;若队组织已有腾讯云资源)
3. **MinIO 自托管**(候选 3;若队组织有自有服务器 / 云资源)
4. **LocalProvider**(必选;dev / test 用)
5. ❌ AWS S3 / Cloudflare R2(国内合规风险;v0.1 不推荐;若有跨境业务诉求另议)
6. ❌ 七牛 Kodo(候选不强;Beta versioning 风险)

### 6.3 Q1 业务方先决条件待评审

**Q1**(本 v0.1 草稿待评审):**队组织已有的云资源**?

- 选项 A:已有阿里云账号 → **OSS 优先**
- 选项 B:已有腾讯云账号 → **COS 优先**
- 选项 C:有自有服务器 / 自建 IDC → **MinIO 优先**
- 选项 D:全新选型 → 用户拍板二选一(OSS / COS)+ LocalProvider(dev)
- 选项 E:其他(请说明)

**v0.2 局部收口前必须先决议 Q1**。

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

### 8.5 Q8 accessUrl TTL 待评审

**Q8**(本 v0.1 草稿):`accessUrl` 签名过期时间(TTL)?

| 场景 | TTL 候选 | 说明 |
|---|---|---|
| **upload-url** | 600 秒(10 分钟) | 给客户端预留上传时间 |
| **download-url**(详情 / 列表) | 300 秒(5 分钟) | 短期访问;过期后客户端可重新拉详情拿新 URL |
| **download-url**(预览 / batch) | 60-1800 秒 | 待评审;依赖前端使用场景 |

**v0.1 倾向**:upload-url = 600,download-url = 300。

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

### 9.2 Q9 是否需要 `uploadState` 字段(沿 B1 暂不新增,Q9 待评审)

**Q9**(本 v0.1 草稿):是否在 `Attachment` 上新增 `uploadState` 字段(枚举 `pending` / `confirmed`)?

| 选项 | 含义 | 影响 | v0.1 倾向 |
|---|---|---|---|
| **A. 不新增** | upload-url 不落库 pending row;confirm-upload 时一次性落库 | upload-url 阶段无 row;客户端必须自行携带 ownerType/Id/size/mime;**Service 层用 signed token 防伪造**(JWT-like) | ✅ v0.1 倾向(B1 锁;最小改动) |
| B. 新增 `uploadState` enum | upload-url 落 pending row;confirm-upload 改 confirmed | Schema +1 字段 + 1 migration | ❌ 留 Q9 评审 |
| C. 新增独立 `attachment_upload_tokens` 表 | 单独存 pending 状态 + signed token | Schema +1 表 + migration | ❌ 复杂度高 |

**v0.1 拍板 A**:**不新增**(沿 B1);具体待评审 Q9 决议。

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

### 11.3 Q10 PII 检测在 confirm-upload 是否重做?

**Q10**(本 v0.1 草稿):upload-url 阶段已做 PII 检测(沿 Q6e);confirm-upload 是否需要重做?

| 选项 | 理由 | v0.1 倾向 |
|---|---|---|
| A. **不重做** | upload-url 已检;客户端不可能在上传过程中修改 originalName / description / tags;省一次正则 | ✅ v0.1 倾向 |
| B. **重做一次** | 防客户端篡改 originalName(实际不会,因为 confirm-upload 不接受 originalName 入参) | ❌ 冗余 |

**v0.1 拍板 A**;留 Q10 评审。

---

## 12. 合规 / 加密 / versioning(沿 D7-attachments §9 + 用户拍板 v0.1)

### 12.1 加密(沿 D7-attachments §9.1)

- ✅ Provider 侧 **SSE-S3 等价默认透明加密**(沿 D7-attachments §9.1)
- ❌ **不做 KMS 主动加密**(沿 D6 决议 4 最低合规版)
- **Q12 待评审**:具体加密配置 SSE-S3 vs SSE-KMS vs SSE-C(各 Provider 等价能力差异;本 v0.1 倾向 SSE-S3 等价默认)

### 12.2 versioning(沿 D6 §六.1 + D7-attachments §9.3)

- ✅ Provider 启用 versioning(误删兜底;沿 D6 风险接受范式)
- ✅ 30 天 expire 旧版本(沿 F4)
- **Q11 待评审**:具体 lifecycle 规则(过期时间 / 转 glacier / 永久保留 等)

### 12.3 入队同意书 / 退队清理(沿 D7-attachments §9.5 / §9.6)

- 沿 D7-attachments **B8 入队同意书最低原则四锚点**(本评审不动)
- 沿 D7-attachments **Q8 退队清理 N 配置项语义**(本评审不动;由业务方 v1.1 提供 N 具体值)
- **Provider 不参与同意书 / 退队清理决策**(系统侧承载)

### 12.4 跨域 CORS(Q14 待评审)

**Q14**(本 v0.1 草稿):Provider bucket CORS 如何配置?

- 候选:允许 `https://*.your-frontend.com`(具体域名待定)
- AllowedMethods:`PUT`(upload)+ `GET`(download)
- AllowedHeaders:`Content-Type` / `Authorization`(沿 Provider 文档)
- MaxAgeSeconds:3600

留 Q14 评审决议。

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

## 16. PR 拆分建议(沿 B5 v0.1 拍板;Q16 留实施期微调)

### 16.1 13 PR 节奏

| PR # | 类型 | 主题 | 范围 | 风险 |
|---|---|---|---|---|
| **设计** PR 1 | `docs(v2-design)` | **本 PR**:add provider selection review draft v0.1 | 新建 `docs/批次7_provider选型_API前评审.md` | 低 |
| 设计 PR 2 | `docs(v2-design)` | refine provider selection v0.2 局部收口 | 用户拍板 Q1-Q15 后 | 中 |
| 设计 PR 3 | `docs(v2-design)` | freeze provider selection v1.0 | 全部决议锁定 | 中 |
| 设计 PR 4 | `docs(v2-design)` | start C-7.5 provider V2.x implementation track | 立项 PR | 低 |
| **实施** PR 5 | `chore` | extend StorageProvider interface(+ 4 method + types) | 仅 interface + types;0 实现 | **零运行时改动** |
| 实施 PR 6 | `feat(storage)` | LocalStorageProvider 实装(dev / test) | `src/common/storage/providers/local.provider.ts` + unit | 低(本地;无云) |
| 实施 PR 7 | `feat(storage)` | <真实 Provider> 实装(按 Q4 选型) | `src/common/storage/providers/<provider>.provider.ts` + 配置 + unit | 中(引入云 SDK) |
| 实施 PR 8 | `feat(attachments)` | wire Provider into attachments.service(accessUrl + delete 同步 Provider 删) | 改 `toResponseDto` / `delete` 2 处 | **中**(contract snapshot 微调) |
| 实施 PR 9 | `feat(attachments)` | add upload-url + confirm-upload API(模式 B) | 新增 2 个端点 + DTOs + RBAC + audit extra + e2e | 中(contract +2 paths) |
| **landing** PR 10 | `docs(v2)` | record provider selection + implementation landing | CHANGELOG + V2 红线 §C-10 → 已落地 + TASKS + 立项记录 | 低 |
| **bump** PR 11 | `chore` | bump version to v0.11.0(或 v0.10.1) | package + Swagger + CHANGELOG | 低 |
| **handoff** PR 12 | `docs(v2)` | add v0.11.0(/v0.10.1) handoff | `docs/handoff/v0.11.0.md` | 低 |
| **tag/release** PR 13 | 维护者手动 | git tag + GitHub Release | 沿 v0.9.0 / v0.10.0 范式 | 低 |

**累计**:**13 PR**(4 设计 + 5 实施 + 1 landing + 1 bump + 1 handoff + 1 维护者收尾)。

### 16.2 与 D7-attachments(C-7)节奏对比

| 维度 | C-7 attachments | C-7.5 Provider 选型 |
|---|---|---|
| 设计 PR | 5(#65-#69) | 4(D7-provider v0.1 → v0.2 → v1.0 → 立项) |
| 实施 PR | 9(#70-#78) | 5(interface + Local + 真实 Provider + 接通 + 新 API) |
| docs | landing + bump + handoff = 3 | landing + bump + handoff + tag/release = 4 |
| **累计** | **17** | **13** |

**实施密度差异**:C-7 是新建主模块 + 配置三表 + RBAC + audit 全栈;C-7.5 是在 C-7 基础上**仅接通 Provider 实现**,接入面极小(2 处 service 改动 + 2 新 API)。

### 16.3 实施 PR 间依赖

```
PR 5(interface 扩展) ← 不依赖
PR 6(LocalProvider) ← 依赖 PR 5
PR 7(真实 Provider) ← 依赖 PR 5(可与 PR 6 并行)
PR 8(接通 attachments.service)← 依赖 PR 5 + 6(LocalProvider 接通即可;PR 7 真实 Provider 切换由配置控)
PR 9(新 API)← 依赖 PR 5 + 6 + 8
PR 10(landing)← 依赖全部
PR 11(bump)← 依赖 10
PR 12(handoff)← 依赖 11
PR 13(tag/release)← 依赖 11 / 12
```

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

## 19. 决议表(C-7.5 Provider 选型 v0.1 草稿)

> **状态历程**(修订日志):
> - **v0.1 草稿**(本 PR,2026-05-15):**5 项 F 锁**(用户启动本 PR 时拍板 10 项 v0.1 的核心 5 项)+ **3 项 B 锁**(沿用户启动本 PR 时拍板的 B1 / B2 / B3 / B4 / B5)+ **15 项 Q 以"本稿建议 / 待评审"承载**

| # | 决议 | v0.1 状态 | 来源 / 章节 |
|---|---|---|---|
| F1 | 本 Provider 选型评审独立进行,**不回改 D7-attachments v1.0 冻结稿** | 🔒 v0.1 锁 | 用户拍板 |
| F2 | 生产推荐 **signed URL 模式(B)**;dev / test 推荐 **LocalProvider(D)** | 🔒 v0.1 锁 | 用户拍板 / §4 |
| F3 | 存储后端 **国内合规优先**(阿里 OSS / 腾讯 COS 二选一);**若队组织已有云资源,优先复用** | 🔒 v0.1 锁 | 用户拍板 / §6 |
| F4 | 删除策略 = **同步尝试 + 失败 logger.warn + Provider lifecycle / versioning 兜底**;**不引入队列**(沿 V1.1 §17.3) | 🔒 v0.1 锁 | 用户拍板 / §5 |
| F5 | `StorageProvider` 接口扩展方向 = **6 方法**(`putObject` / `deleteObject` 沿用 + `generateUploadUrl` / `generateDownloadUrl` / `headObject` 新增) | 🔒 v0.1 锁 | 用户拍板 / §7 |
| B1 | **暂不新增 schema 字段**(沿 D7-attachments v1.0 `key` / `etag` / `checksum` / `accessLevel` / `expireAt` 够用) | 🔒 v0.1 锁 | 用户拍板 / §9 |
| B2 | API 候选新增 **upload-url + confirm-upload** 2 个端点;**不动现有 7 个 attachments 端点 paths / 入参 / 出参 schema** | 🔒 v0.1 锁 | 用户拍板 / §8 |
| B3 | **RBAC 不新增权限点**;沿现有 20 条 `attachment.*`(沿 D7-attachments Q11) | 🔒 v0.1 锁 | 用户拍板 / §10 |
| B4 | **audit 不新增 event**;仅 `attachment.upload` / `attachment.delete` 的 `extra` 扩展 Provider 信息(沿 D11 路线 A 单事件 + extra) | 🔒 v0.1 锁 | 用户拍板 / §11 |
| B5 | PR 拆分先按 **13 PR 设计节奏**(4 设计 + 5 实施 + 1 landing + 1 bump + 1 handoff + 1 维护者 tag/release)| 🔒 v0.1 锁(建议;实施期允许微调,沿 D7-attachments Q16 范式) | 用户拍板 / §16 |
| Q1 | 业务方既有云资源 | ⏳ v0.1 待评审(候选 A 阿里 / B 腾讯 / C 自建 / D 全新 / E 其他)| §6.3 |
| Q2 | 上传模式 A 中转 / B 签名 URL / C STS / D 本地 终选 | 🔒 v0.1 拍板生产 = B + dev = D;**Q2** 是否启用 C STS 大文件 multipart 留 Q13 | §4 |
| Q3 | 删除策略 A 同步事务 / B 异步队列 / C 同步 + 告警 / D 仅 versioning 终选 | 🔒 v0.1 拍板 = C + D;**Q3 子项**(audit 中 providerDeleteStatus 字段写法)待评审 | §5 |
| Q4 | 存储后端具体选择(阿里 OSS / 腾讯 COS / R2 / S3 / MinIO / 七牛 / LocalProvider) | ⏳ v0.1 待评审(依赖 Q1) | §6 |
| Q5 | `StorageProvider` 接口签名细化(`expiresIn` 类型 / `headers` 必填性 / `method` 是否含 POST 候选) | ⏳ v0.1 待评审 | §7.4 |
| Q6 | `POST /upload-url` 字段集 + Q6a-Q6e 子项(key 谁生成 / 是否落 pending row / 校验链 / mime / size / PII 是否做) | ⏳ v0.1 待评审 | §8.3 |
| Q7 | `POST /confirm-upload` 字段集 + Q9 联动(是否需要 attachmentId 入参) | ⏳ v0.1 待评审 | §8.4 |
| Q8 | `accessUrl` 签名过期 TTL(upload = 600s / download = 300s 倾向) | ⏳ v0.1 待评审 | §8.5 |
| Q9 | 是否新增 `uploadState` schema 字段 / 独立 `attachment_upload_tokens` 表 | 🔒 v0.1 拍板 A 不新增(沿 B1);**留 Q9 评审**(若 Q6b 决议落 pending row,Q9 必须新增) | §9.2 |
| Q10 | PII 检测是否在 confirm-upload 重做 | 🔒 v0.1 拍板 A 不重做(upload-url 已检) | §11.3 |
| Q11 | Provider versioning + lifecycle 具体配置(30 天 expire / glacier / 永久 等) | ⏳ v0.1 待评审 | §12.2 |
| Q12 | 加密 SSE-S3 / SSE-KMS / SSE-C(具体 Provider 配置) | ⏳ v0.1 待评审 | §12.1 |
| Q13 | 大文件 multipart upload 支持(沿 STS 模式 C);是否本批次实施 | ⏳ v0.1 待评审(本 v0.1 倾向"暂不";留 v1.1 / 实施期) | §4 + §7.2 |
| Q14 | 跨域 CORS 配置(AllowedOrigins / AllowedMethods / MaxAge) | ⏳ v0.1 待评审 | §12.4 |
| Q15 | Provider 切换 / 跨 Provider 迁移路径(运行时切换 / 迁移脚本 / 数据保留策略) | ⏳ v0.1 待评审 | §15.4 |

**总计**:**F 5 + B 5 + Q 15 = 25 项**

- **🔒 v0.1 已锁**:**F 5 + B 5 = 10 项**(沿用户启动本 PR 时拍板)
- **⏳ v0.1 待评审**:**Q 15 项**(全部 Q 待用户拍板)
- **沿 D7-attachments v0.1 草稿 16 项 Q + 5 项 F + 9 项 B = 30 项**节奏(本评审 25 项;少了 5 项,因为部分决议已被 D7-attachments v1.0 锁定)

---

## 20. 落地节奏

1. ✅ **C-7 attachments 全模块**(PR #65-#81 17 个;v0.10.0 段内全部 squash merge)
2. ✅ **v0.10.0 tag + GitHub Release**(2026-05-15;Latest)
3. **本 PR(C-7.5 Provider 选型 v0.1 草稿)** → 🔄 进行中;新建本文件
4. **C-7.5 v0.2 局部收口 PR** → 用户拍板 Q1-Q15 后启动
5. **C-7.5 v1.0 冻结 PR** → 全部决议锁定后启动
6. **C-7.5 V2.x 立项 PR**(沿 D7-attachments 立项 PR #69 / D7-RBAC 立项 PR #52 范式)→ 用户授权
7. **C-7.5 实施 PR 5-9**(沿 §16 13 PR 节奏)→ 逐 PR 用户授权
8. **C-7.5 landing PR 10** → 收口 docs(CHANGELOG / V2 红线 §C-10 / TASKS / 立项记录)
9. **C-7.5 bump PR 11**(沿 v0.10.0 / v0.9.0 bump 范式)→ `chore: bump version to v0.11.0`(或 v0.10.1)
10. **C-7.5 handoff PR 12** → `docs/handoff/v0.11.0.md`(或 v0.10.1)
11. **C-7.5 tag + Release**(维护者手动;沿 v0.10.0 维护者实际范式 = tag → handoff commit)

---

## 21. 撰写元信息

- **状态**:C-7.5 Provider 选型评审 **v0.1 草稿**(撰写完成;入库待用户授权 squash merge 本 PR)
- **本评审稿自身的版本含义**:沿 D7-attachments v0.1 → v0.2 → v1.0 范式;**本 v0.1 是草稿**,**v1.0 由用户拍板全部 15 项 Q 后冻结**
- **不在本评审范围**:
  - 任何代码 / schema / migration / Provider 实装(由对应实施 PR 承载)
  - D7-attachments v1.0 冻结稿任何回改(沿 F1)
  - C-7 attachments 7 端点 / 配置三表 15 端点 / 4 表 / 20 permission / 3 audit event(已锁;沿 D7-attachments v1.0 + v0.10.0 终态)
  - 业务方既有云资源决策(Q1 待用户提供)
  - 真实 Provider 选择(Q4 待用户拍板)
  - tag + Release(沿 v0.10.0 维护者权限边界)
- **撰写者签名**:Claude Code(基于 C-7 attachments 17 PR 全程实施经验 + Step 1 调研报告 + 用户启动本 PR 时拍板 10 项 v0.1 决策;**未动任何代码 / schema 文件**)
- **commit 风格**:`docs(v2-design): add provider selection review draft v0.1`(沿 D7-attachments v0.1 PR #65 `docs(v2-design): add attachments API review draft v0.1` 命名风格)

---
