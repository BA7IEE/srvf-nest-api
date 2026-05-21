# 《附件功能业务确认稿(批次 7)》

> **用途**:作为 [《附件功能业务访谈提纲(批次 7,暂定)》](批次7_attachments_业务访谈提纲.md) 的 **D6 业务确认产物**,记录业务方对 11 个问题的逐项拍板 + 5 条超出原 11 题的新增决议。本稿为 C-7 attachments D7 评审稿的输入,并触发 **C-6 RBAC 模型决议作为前置硬依赖**。
> **性质**:**D6 业务确认稿**(业务方已拍板;等 D7 评审 + V2.x 立项)。
> **批次号**:批次 7 暂定;正式编号以 D7 评审通过 + V2.x 立项 commit 为准。
> **撰写日期**:2026-05-13
> **业务方**:项目维护者(兼救援队代表方)
> **接续**:[访谈提纲](批次7_attachments_业务访谈提纲.md) / [v0.8.0 handoff §5.3 Slow-2](handoff/v0.8.0.md) / [V2 红线 C-6 / C-7](V2红线与复活路径.md)
> **拍板准绳**(业务方原话):**"不考虑时间周期 只考虑项目稳定和长久"**
> **核心决议**(5 条,详见 §三):
> 1. **启动顺序**:C-6 RBAC 完整模型批次**先行** → C-7 attachments 批次**跟进**(不走"硬编码权限先上 + 后续迁移"短路径)
> 2. **RBAC 模型**:**完整 RBAC 表**(`permissions` + `role_permissions` + `user_roles` 三表)— 不扩 `Role` enum / 不加 `deptHead` 字段
> 3. **配置中心三表**(`attachment_type_config` / `attachment_mime_config` / `attachment_size_limit_config`)+ CRUD API,**与 attachments 主模块同批次落地**
> 4. **合规口径**:**最低合规版**(Provider 侧 SSE-S3 默认加密 / 退队 ADMIN 手动清理 / 入队同意书 + 救援派遣作为合法性基础)
> 5. **Provider 选型评估**:**独立评审稿**(本稿不决议;与 attachments 实施期同期完成)

---

## 一、背景与拍板准绳

### 1.1 拍板时间线

| 时间 | 事件 |
|---|---|
| 2026-05-13 上午 | 访谈提纲落地为 PR #44(squash commit `08aa4d7`) |
| 2026-05-13 中午 | 业务方第一轮拍板(11 题主答案 + 边界澄清诉求) |
| 2026-05-13 下午 | AI 标记 4 处冲突(2 处合规红线 + 2 处越界基建)并暂停说明 |
| 2026-05-13 下午 | 业务方第二轮拍板(6 / 8b API 给后台对接 / 7 走 RBAC / 9 前期不搞加密清理 / 10 / 11) |
| 2026-05-13 下午 | AI 提出"以稳定长久为准绳的真正长路径"+ RBAC 三选一 |
| 2026-05-13 下午 | 业务方明确准绳"**不考虑时间周期 只考虑项目稳定和长久**" + RBAC 模型拍板**选项 3(完整 RBAC 表)** |
| 2026-05-13 下午 | 本稿撰写 |

### 1.2 拍板准绳(对项目骨架级影响)

业务方明确:**"不考虑时间周期 只考虑项目稳定和长久"**。

这一准绳决定:

- **不走** "硬编码权限先上 + 后续迁移到 RBAC" 短路径(虽然短 3 周对比 6 周以上)
- **不走** "扩 `Role` enum" / "加 `deptHead` 字段" 半 RBAC 路径
- **不走** "config 文件级配置 → V3 再迁 DB 表" 二次工程路径
- **走** "C-6 RBAC 完整模型先行 → C-7 attachments 跟进"
- **走** "完整 RBAC 三表"(`permissions` + `role_permissions` + `user_roles`)
- **走** "配置中心三表与 attachments 同批次"(避免短期 config 文件 → 长期 DB 表的二次迁移)
- **走** "最低合规版"(在 research §4.3 + 个保法约束下做到最低成本合规化,不走"先存着以后补"反模式)

### 1.3 本稿边界

| 范围 | 说明 |
|---|---|
| ❌ schema / API 路径 / DTO / BizCode 详码 | 留 D7 评审稿(段位 `130xx` / `131xx` 已由 baseline §1.1 锁) |
| ❌ Provider 具体选型 / KMS 密钥管理 | 独立 Provider 选型安全策略评估稿 |
| ❌ RBAC 完整 schema / permissions 表结构 / 权限点穷举 | C-6 RBAC 独立批次(C-6 业务访谈 → D6 → D7 → 实施) |
| ❌ "自动清理脚本" / 病毒扫描具体方案实现 | 本稿仅决议"不做",实施细节后续若启动单独走 |
| ❌ 字典 seed 真实值(部门 / 等级 / 活动类型) | research §5.1 / §7-R13:由用户私下提供,不进公共仓库历史 |
| ❌ 现有 V2 模块 v1 14 接口任何字段 | A-2 红线;本稿与 v1 接口零相关 |
| ❌ APD 部门部长 / 副部长权限规则细节 | C-6 RBAC 落地后由 RBAC 配置决定,本稿不预设 |

---

## 二、业务方逐项拍板(原 11 题)

> **说明**:每题先记业务方拍板(原话引用 + 选项),再附 AI 风险注释 / 转译版本 / D7 评审稿覆盖范围。**AI 转译版本**仅作 D7 评审输入候选,**D7 评审时业务方有权回退或调整**。

### 问题 1:第一批附件先做哪个场景

**业务方拍板**:**选 A**(队员证件照) **+ 增项"活动发布的封面"**。

**业务方原话**:"A 以及活动发布的封面"

**覆盖场景清单**(6 类):

| # | 场景 | 挂载对象(候选,D7 决议) | 性质 |
|---|---|---|---|
| 1 | 队员证件照(身份证) | `Member` 或 `Certificate` | 高敏感(含身份证号 OCR 风险) |
| 2 | 队员证件照(急救 / 潜水 / 培训证) | `Certificate` | 中敏感 |
| 3 | 活动现场照 | `Activity` | 低敏感(可能含队员人像) |
| 4 | **活动发布封面**(本次新增) | `Activity` | 低敏感(本质公开展示) |
| 5 | 培训资料 | 待定(Activity ? 独立 `TrainingMaterial` ?) | 低敏感 |
| 6 | 装备图 | 待定(独立 `Equipment` 模型未起) | 低敏感 |

**AI 风险注释**:

- **场景 4 "活动发布封面"** 性质与原候选 1-3 不同 — 它是 `Activity` 的展示字段而非独立附件元数据。D7 评审稿需要决议:
  - 复用 attachments 模型(`ownerType='activity'` + 在 `Activity` 表加 `coverAttachmentId` 字段) 
  - **vs** 单独走 `Activity.coverImageUrl` 字符串字段
  - **AI 建议**:复用 attachments 模型,统一附件链路,避免双轨制
- **场景 5 / 6** 挂载对象不明 — `TrainingMaterial` / `Equipment` 在 V2 当前无对应业务模型;D7 评审稿要么:
  - (a) 明确把这两类场景**延后**到独立业务模型复活后再启用 attachments 支持
  - (b) 启用 `ownerType` 留空的通用容器(`'misc'`)— 但增加业务语义模糊
  - **AI 建议**:(a) 延后,先打通场景 1-4

**D7 评审稿覆盖**:

- 每个场景的 `ownerType` 枚举值(来源于决议 3 的 `attachment_type_config` 表)
- 场景 4 "活动发布封面" 与 `Activity` 模型的字段关联方案
- 场景 5 / 6 是否延后

---

### 问题 2:附件元数据额外字段

**业务方拍板**:**全部候选额外字段都加上**。

**业务方原话**:"候选额外字段都加上 不一定马上用但是以后兼容性更大"

**最终字段集(13 字段;实际字段名 / 可空性 / 默认值 D7 决议)**:

| 来源 | 字段 | 性质 |
|---|---|---|
| 基础(research §2.4 锁) | `key` | 文件标识(Provider 侧唯一引用) |
| 基础 | `originalName` | 原始文件名 |
| 基础 | `mime` | MIME 类型 |
| 基础 | `size` | 文件大小(字节) |
| 基础 | `uploadedBy` | 上传者 ID(User.id 或 Member.id,D7 决议) |
| 基础 | `uploadedAt` | 上传时间 |
| 基础 | `ownerType` + `ownerId` | 归属业务对象(多态外键;决议 见问题 4) |
| 额外 | `checksum` | SHA-256 哈希(防重传 + 完整性校验 + 秒传基础) |
| 额外 | `etag` | S3 兼容 Provider 的服务端版本号 |
| 额外 | `description` | 用户备注(上传时填写) |
| 额外 | `accessLevel` | 访问级别(public / internal / sensitive)— 与 RBAC 协调 |
| 额外 | `tags` | 标签数组(按标签筛选) |
| 额外 | `originalUploaderName` | 冗余存上传者人名(上传者软删后仍能显示) |
| 额外 | `expireAt` | 附件本身的有效期(如年度体检报告) |

**AI 风险注释**:

- `accessLevel` 字段含义需在 D7 评审稿中**明确与 RBAC 的关系**:
  - 选项 a:`accessLevel` 是 RBAC 之外的"快速分级",Service 层先看 `accessLevel` 再查 RBAC(双轨制)
  - 选项 b:`accessLevel` 仅作 hint / 索引用途,实际权限完全走 RBAC(单一权威源)
  - **AI 建议**:(b) 单一权威源,避免"accessLevel 写 'public' 但 RBAC 没配"的语义冲突
- `tags` 是数组字段,D7 评审稿需要决议**字符串数组 vs 独立 tags 关联表**(前者简单,后者支持 tag CRUD + 全局唯一)
- 13 字段中,**8 个为冗余**(checksum / etag / description / accessLevel / tags / originalUploaderName / expireAt)— 业务方明示"不一定马上用,以后兼容性更大";D7 评审保留接受,但**入参 DTO 一开始可以只接受必填字段**,其余字段在 V3 / V4 业务诉求出现时再开放

**D7 评审稿覆盖**:

- 每字段的可空性 / 默认值 / 是否进入入参 DTO / 是否进入出参 DTO
- `accessLevel` 与 RBAC 的最终关系
- `tags` 实现方式(字符串数组 vs 关联表)
- `uploadedBy` 指向 User.id 还是 Member.id

---

### 问题 3:附件归属对象数

**业务方拍板**:**选 A**(单归属 1:N — 一个附件只属于一个对象)。

**业务方原话**:"A"

**沿 research §4.9 [当前倾向] 单归属 1:N**;本稿确认此倾向。

**AI 风险注释**:无。单归属是稳定长久的选择(避免多对多场景下的删除策略复杂性)。

**D7 评审稿覆盖**:无单独议题(归属关系实现见问题 4)。

---

### 问题 4:附件归属实现方式

**业务方拍板**:**选 A**(多态外键 `ownerType` + `ownerId`)。

**业务方原话**:"A"

**AI 风险注释**:

- 多态外键**牺牲数据库层 FK 完整性**(`ownerType` 是字符串字段,数据库无法强制约束),需在 Service 层手写校验:
  - `ownerType` 必须在合法枚举内(来源于决议 3 的 `attachment_type_config` 表)
  - `ownerId` 必须真实指向 `ownerType` 对应业务表的现存记录
  - 业务对象软删 / 硬删时,附件元数据如何处理(关联问题 5 硬删除决议)

**D7 评审稿覆盖**:

- `ownerType` 枚举值定义来源:**`attachment_type_config` 表(运行时可配置)** vs **业务层硬编码常量**(`AttachmentOwnerType` enum)
  - **AI 建议**:配置表为权威源,业务层 enum 作为编译期已知值的快照(每次构建从配置表生成);**两者必须同步**
- ownerType / ownerId 的 Service 层校验逻辑(包括业务对象不存在 / 已软删时的行为)

---

### 问题 5:附件删除策略

**业务方拍板**:**选 B**(硬删除 — 元数据立即从库消失 + 物理文件同步删除,不可恢复)。

**业务方原话**:"B"

**AI 风险注释**:

- 与 V2 现有 `Member` / `Activity` / `Certificate` **软删除模式不一致**。需在 D7 评审稿澄清:
  1. **业务对象软删 vs 附件硬删的语义对齐**:
     - 场景:`Member` 软删除(deletedAt != null,记录保留)
     - 问题:该 Member 的附件是否立即硬删?或跟随 Member 软删保留?
     - **AI 建议**:**业务对象软删时附件不动**(避免软删 Member 被恢复时附件丢失);**业务对象硬删时(若有该操作)附件硬删**;**附件主动删除时(用户在前端按"删除按钮")才走硬删**
  2. **audit_logs 追溯要求**:
     - 硬删除意味着附件元数据消失,但 audit_logs 需要保留"谁删了什么"(参 问题 7 决议:身份证类附件的删除日志保留 1 年)
     - audit_logs 已有的 `attachment.*` 事件命名预留(沿 V2 红线 §3.1d 同事务策略):D7 评审时新增 `attachment.delete` 事件名
  3. **误删兜底**:
     - 选 B 硬删意味着误删不可恢复
     - **AI 建议**:Provider 侧启用 **versioning**(S3 versioning / OSS 版本管理)— Provider 物理文件保留 N 天后清理;DB 元数据不留,但物理文件可应急回滚;**N 由 Provider 选型评审稿决定**
     - 业务方知情承担:Provider 侧 versioning 是技术兜底,**业务层无 UI 恢复**

**D7 评审稿覆盖**:

- "业务对象软删 / 硬删 / 附件主动删"三种场景下附件的处理矩阵
- `attachment.delete` audit_logs 事件(同事务 fail-fast)
- Provider versioning 启用方案(与 Provider 选型评审稿同期)

---

### 问题 6:谁能上传

**业务方拍板(第一轮)**:"这块需要看情况,有的是队员能上传,最好是后台可自定义配置"
**业务方拍板(第二轮澄清)**:"后台可自定义配置上传权限 你提供 API 后台 UI 是单独对接的项目"
**业务方拍板(第三轮,稳定长久准绳)**:**走 RBAC**(完整 RBAC 表配置;后台 UI 通过 RBAC CRUD API 对接,**不另开 `attachment_permission_config` 表**)

**业务方原话(三轮汇总)**:
1. "这块需要看情况,有的是队员能上传,最好是后台可自定义配置"
2. "后台可自定义配置上传权限 你提供 API 后台 UI 是单独对接的项目,不行吗?"
3. (隐含)走完整 RBAC 表(决议 2)

**AI 转译**:

- attachments 的"谁能上传"决策**完全交给 RBAC**;没有 attachments 自己的权限配置表
- 后台 UI 修改"谁能上传 X 类型附件"的方式:**调用 RBAC CRUD API**(不是 attachments 自己的 API)
- attachments 主模块 Service 层在上传接口入口调 `rbac.can(user, 'attachment.upload', { ownerType, attachmentType })` 决定放行
- 上传权限点示例(D7 评审稿穷举):`attachment.upload.cert.self` / `attachment.upload.cert.other` / `attachment.upload.activity.cover` / ...

**D7 评审稿覆盖**:

- attachments 上传接口的 RBAC 调用点
- 各场景的权限点命名规范(`attachment.upload.<type>.<scope>`)
- C-6 RBAC 落地前 attachments **不上线**(沿决议 1 启动顺序)

---

### 问题 7:谁能查看(敏感字段三问)

**业务方拍板(第一轮)**:"all,用途是储存你别管什么用途,具体情况具体分配,永久保存"
**业务方拍板(第二轮澄清)**:"存储了不代表所有人可见啊,需要配置权限啊 所以需要 RBAC 啊"
**业务方拍板(第三轮,稳定长久准绳)**:**走 RBAC**(查看权限完全由 RBAC 配置决定;业务用途 / 保存期限按"最低合规版"措辞落地)

**业务方原话**:
1. "all,用途是储存你别管什么用途,具体情况具体分配,永久保存"
2. "存储了不代表所有人可见啊,需要配置权限啊 所以需要 rbac 啊"

**AI 转译**:

业务方第一轮的"all / 别管用途 / 永久保存"经 AI 标记触发 research §4.3 + V2 §18.4 + 个保法第 13/19/24 条红线后,业务方第二轮澄清意为"存储是 all 类型可存,**查看权限由 RBAC 配置决定**,不是真的所有人都能看"。

业务用途 / 保存期限按**最低合规版**(决议 4)落地:

| 场景 | 业务用途(Q1) | 查看角色(Q2,落 RBAC 后配置) | 保存期限(Q3) |
|---|---|---|---|
| 队员证件照(身份证) | 队员资质核验 + 复审周期 1 年;**OCR 号码不存,仅图像** | 本人 + ADMIN/SUPER_ADMIN + (未来)APD 部长 RBAC 角色 | 退队后 6 个月 ADMIN 手动清理 + 删除日志保留 1 年 |
| 队员证件照(急救 / 潜水 / 培训证) | 活动派遣前资质核验 + 复审周期 1 年 | 本人 + ADMIN/SUPER_ADMIN + 同队队员(派遣选人用) | 退队后 2 年 ADMIN 手动清理 |
| 活动现场照 | 活动事后存档 + 内部宣传 | 本队队员 + ADMIN/SUPER_ADMIN | 永久(队组织数据资产) |
| 活动封面 | 活动展示用图(本质公开) | 全员 | 永久(跟随 Activity 生命周期) |
| 培训资料 | 队内学习材料 | 全员 | 永久 |
| 装备图 | 装备清单 / 采购凭证 | ADMIN/SUPER_ADMIN + 未来装备管理员 RBAC 角色 | 永久 |

**AI 风险注释**:

- "身份证 OCR 号码不存,仅图像" 是关键合规措辞,需在 D7 评审稿明确技术实现:
  - 方案 a:不调用 OCR 服务(身份证号永远以图像形式存在,DB / API 永不出现身份证号字符串)
  - 方案 b:调用 OCR 但只用于"图像质量检测"(模糊 / 反光检测),OCR 结果不入库
  - **AI 建议**:(a) 不调用 OCR,合规风险最低
- 上述三问表是**最低合规版**,在 D7 评审稿可由业务方调整;但**任一格调整都触发 research §4.3 三问硬约束**,不允许"留空"

**D7 评审稿覆盖**:

- 每场景的 Q1/Q2/Q3 最终值(允许 D7 评审时业务方再调整,但不允许留空)
- 身份证 OCR 不调用的技术保证
- 退队"6 个月 / 2 年"自动触发条件(`Member.status` 改 DISABLED? `deletedAt` 设置后?)
- "ADMIN 手动清理"的 UI 路径(后台对接由独立前端项目实现)

---

### 问题 8a:单文件最大尺寸

**业务方拍板**:**选 F**(按附件类型分级)。

**业务方原话**:"F"

**初始候选阈值**(D7 评审稿决议具体数值;**由决议 3 的 `attachment_size_limit_config` 表运行时可配置**):

| 附件类型 | 初始候选阈值 |
|---|---|
| 队员证件照 | 5 MB(适合手机拍照) |
| 活动现场照 | 10 MB(适合相机原图) |
| 活动封面 | 5 MB |
| 培训资料 | 50 MB(PDF / docx) |
| 装备图 | 10 MB |

**配置载体**:`attachment_size_limit_config` 表 + CRUD API(决议 3)。

**D7 评审稿覆盖**:

- 各类型初始默认值
- 上限上限(Provider 单文件硬上限 / API 网关层硬上限 / 客户端预校验阈值)

---

### 问题 8b:允许的 MIME

**业务方拍板(第一轮)**:"最好也是后台配置"
**业务方拍板(第二轮)**:"也是一样的嘛 后台 UI 要等所有 API 开发完成后 给前端做专门的后台"
**业务方拍板(第三轮,稳定长久准绳)**:**DB 表 + CRUD API**(`attachment_mime_config` 表;决议 3)

**业务方原话**:
1. "最好也是后台配置"
2. "也是一样的嘛 后台 UI 要等所有 API 开发完成后 给前端做专门的后台"

**AI 转译**:

后台 UI 由独立前端项目对接,本期交付**后端 CRUD API**;`attachment_mime_config` 表作为 MIME 白名单的运行时配置中心。

**初始 MIME 白名单候选**(D7 评审稿决议;运行时可改):

| 类别 | MIME |
|---|---|
| 图片(允许) | `image/jpeg` / `image/png` / `image/heic` / `image/webp` |
| 文档(允许) | `application/pdf` / `application/vnd.openxmlformats-officedocument.wordprocessingml.document`(docx) / `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`(xlsx) / `text/plain` |
| 视频(本期禁) | `video/*` 全禁(若启用走独立多媒体管理评审) |
| 压缩包(本期禁) | `application/zip` / `application/x-rar-compressed` 全禁(高安全风险) |
| 可执行文件(永久禁) | `application/x-msdownload` / `application/x-executable` 等(无业务必要 + 高安全风险) |

**D7 评审稿覆盖**:

- `attachment_mime_config` 表 schema + CRUD API 路径 / DTO / BizCode
- "永久禁"清单(即使后台配置也不允许加入白名单)

---

### 问题 8c:病毒扫描

**业务方拍板**:**选 A**(不做病毒扫描)。

**业务方原话**:"A"

**AI 风险声明(业务方知情承担)**:

恶意文件上传风险由队组织知情承担。具体风险类型:

- 上传的 PDF / docx 可能含宏 / 嵌入式恶意脚本(下载者打开时触发)
- 上传的图片可能含 EXIF 隐藏数据 / 恶意 polyglot 文件(同时是图片 + 可执行内容)
- 上传的 ZIP(虽本期禁)可能含 zip bomb

**升级路径(V3+,不在本期)**:

- 接入 ClamAV(开源 + 本地部署)
- 阿里云内容安全 / 七牛盾(云服务,按调用计费)
- 异步队列扫描(需 V1.1 §17.3 升级路径,本期不涉及)

**D7 评审稿覆盖**:无(本期决议"不做")。

---

### 问题 9:保存期限 / 合规 / 加密(敏感字段三问延伸)

**业务方拍板(第一轮)**:"不自动清理,不管法务,不加密"
**业务方拍板(第二轮)**:"前期不要搞加密 清理。以后再考虑"
**业务方拍板(第三轮,稳定长久准绳)**:**最低合规版**(沿决议 4,见 §三)

**业务方原话**:
1. "不自动清理 ,不管法务,不加密"
2. "前期不要搞加密 清理。以后再考虑"

**AI 转译(最低合规版,详见决议 4)**:

| 项 | 决议 | 工作量 |
|---|---|---|
| 加密 | Provider 侧 **SSE-S3 默认服务端透明加密**(开箱即用 + 无 KMS) + DB 元数据不加密 | 0(Provider 默认配置) |
| 自动清理 | **不做自动脚本**;业务确认稿口径:"队员退队后由 ADMIN 手动清理"满足个保法第 19 条最小化原则 | 0(只是文档措辞) |
| 保存期限 | 沿问题 7 三问表(在队期间永久 + 退队触发清理 6 个月 / 2 年) | 0(只是文档措辞) |
| 合法性基础 | "队员入队同意书条款 + 救援活动派遣合理范围";具体同意书条款 D7 评审时由维护者提供草案 | 0(维护者提供同意书内容) |

**AI 风险注释**:

业务方原话 "不管法务" 在合规层面**无法直接落地**(个保法第 13/19/24/51 条 + 数据安全法第 21/27 条是国家法律,项目维护者无权单方豁免)。AI 转译为"最低合规版"是:

- **不要求维护者投入法务咨询时间** ← 满足"前期不搞"的意图
- **但在文档里写四句话措辞** ← 满足个保法对"合法性基础 + 数据最小化 + 安全保护"的最低要求
- **不增加任何代码工作量** ← 满足"稳定长久"准绳(不为合规增加技术债)

**业务方在 D7 评审时可:**

- 完全接受本"最低合规版"(D7 通过)
- 调整任一句措辞(如修改保存期限 / 合法性基础措辞)
- **不接受** ← 此时 attachments 模块需另寻合规路径或维护者承担合规风险(本稿 AI 不替业务方决定法律风险)

**D7 评审稿覆盖**:

- 维护者提供入队同意书草案
- "ADMIN 手动清理"的后台 UI 入口规范
- Provider SSE-S3 默认开启的配置项 / 监控

---

### 问题 10:现有 `Certificate.attachmentKey` 占位字段

**业务方拍板**:**选 B**(废弃此字段)。

**业务方原话(轮 1)**:"这个不懂 你按最佳方案处理"
**业务方原话(轮 2,基于 AI 建议确认)**:"B"

**理由**(AI 提供 → 业务方确认):

- 问题 4 选 A(多态外键)— 通用 `attachments` 表挂所有业务对象
- 若 `Certificate` 单独保留 `attachmentKey`,等于通用方案外开特例,后期出现"证件附件走 `Certificate.attachmentKey` 还是通用 attachments?"二义性
- 统一走通用方案,`Certificate.attachmentKey` 字段安排 migration 删掉(数据迁移成本为 0,字段始终 NULL)

**D7 评审稿覆盖**:

- migration 脚本(D7 评审稿落地):删除 `Certificate.attachmentKey` 字段 + 同步删除其在 `userSafeSelect` / 出参 DTO 的引用 — 具体 SQL / Prisma migration 文件留 D7,本稿不写
- 时机:与 attachments 主模块落地**同批次**(同 PR;避免单独 schema 改动 PR 浪费 contract snapshot)
- 影响范围:`Certificate` 模型出参 DTO(`userSafeSelect` / `CertificateResponseDto` 同步删除该字段)
- 验收:contract snapshot 显示 `Certificate.attachmentKey` 从 OpenAPI 中消失(预期变更)

---

### 问题 11:与 `member_profiles` / `events` 复活的耦合度

**业务方拍板**:**选 A**(三者独立 — attachments 自己先做)。

**业务方原话(轮 1)**:"也看不懂 反正别考虑什么合规问题"
**业务方原话(轮 2,基于 AI 解释确认)**:"A"

**AI 注**:业务方"反正别考虑什么合规问题" 措辞与问题 9 合规决议合并处理(见决议 4);问题 11 本身**不是合规问题**,业务方第二轮在理解"耦合度"语义后确认选 A。

**理由**(AI 提供 → 业务方确认):

- attachments 挂载对象(`Member` / `Certificate` / `Activity`)已存在
- 问题 2 选"全部额外字段都加上"已为 `member_profiles` / `events` 复活预留兼容性
- 后续 `member_profiles` / `events` 复活时 attachments **不需要**扩字段(沿决议 4 全字段冗余 = 未来不返工)

**D7 评审稿覆盖**:

- attachments 模块 schema 不为 `member_profiles` / `events` 预留特殊字段
- `member_profiles` / `events` 复活时 attachments 仅扩 `attachment_type_config` 表注册新 `ownerType`,不动 attachments 主模块

---

## 三、超出原 11 题的新增决议(5 条)

### 决议 1:启动顺序

**C-6 RBAC 完整模型批次先行 → C-7 attachments 批次跟进**。

**理由**:

- 业务方"不考虑时间周期,只考虑稳定和长久"准绳
- attachments 的查看 / 上传权限走 RBAC(问题 6 / 7 决议),attachments 启动前 RBAC 模型必须就绪,否则要承担"硬编码权限 → 后续迁移"的二次工程债
- RBAC 是整个项目权限基建,attachments 只是 RBAC 的第一个使用者;所有其他业务模块(activities / members / certificates / ...) 后续都会用到 RBAC,**不应该为 attachments 而设计 RBAC**

**操作影响**:

- 本稿(C-7 attachments 业务确认稿)**完成后**:
  - 不立即起草 attachments D7 评审稿
  - **先启动 C-6 RBAC 完整批次**:C-6 业务访谈提纲 → C-6 D6 业务确认稿 → C-6 D7 评审稿 → C-6 实施
- C-6 RBAC 实施完成 + 上线**之后**,才启动 C-7 attachments D7 评审稿 + 实施

**关联文档**(待新建):

- `docs/批次N_RBAC_业务访谈提纲.md`(N 由 C-6 立项时拍)
- `docs/批次N_RBAC_业务确认稿.md`
- `docs/批次N_RBAC_API前评审.md`(D7-RBAC)

---

### 决议 2:RBAC 模型选型

**选项 3:完整 RBAC 表**(`permissions` + `role_permissions` + `user_roles` 三表)。

**业务方原话**:"3"

**模型核心**(具体 schema D7-RBAC 评审决议):

| 表 | 含义 |
|---|---|
| `permissions` | 权限点定义(预估 50-200 条目;如 `attachment.upload.cert.self` / `attachment.view.cert.other` / `activity.publish` / `member.update.other` ...) |
| `role_permissions` | 角色 → 权限点映射(后台可配置;由 RBAC CRUD API 维护) |
| `user_roles` | 用户 → 角色多对多(一个用户可兼任多角色;如某 ADMIN 同时是"APD 部长") |

**沿用现有三层 `Role` 枚举(SUPER_ADMIN / ADMIN / USER)** 不变,作为"**系统级身份分层**";RBAC 三表作为"**业务级权限点**";**两层并存**,符合 v1 §3 命名铁律(`Role` 唯一来源是 Prisma schema)+ V2 §18 不破坏现有三层 Role。

**不选其他两项的理由**:

| 选项 | 不选理由 |
|---|---|
| 1. 扩 `Role` enum | 真出现新角色就要 schema migration;角色组合(一个用户兼任多角色)无法表达;按部门切片做不到;3-5 年内必返工 |
| 2. 加 `deptHead` / `departmentId` 字段 | 只能解决"按部门切片"一种场景;权限点扩展时仍要回头加表;混合架构后期难拆 |
| 3. 完整 RBAC 三表 ✅ | 标准 RBAC 设计;权限点细化 + 角色组合 + 资源级控制 + 部门切片都能表达;做完后未来 5-10 年不返工 |

**实施前置**:

- 走 `ARCHITECTURE.md §9` 升级路径(扩 Prisma schema + 新增 BizCode 段位 + 新增 `modules/permissions/`)
- 新增 BizCode 段位预估:**`140xx` / `141xx`** — 待 baseline §1.1 评审拍板
- 与现有 [`users.policy.ts`](src/modules/users/users.policy.ts) 共存方案:
  - v1 三层 Role 判断(`assertCanManageUser` 等)作为"**粗粒度**"快速路径
  - RBAC 表查询作为"**细粒度**"权限判断
  - 具体衔接(优先级 / 短路逻辑 / 缓存策略)由 D7-RBAC 评审决议

**实施影响范围**(D7-RBAC 评审稿覆盖):

- 新增 `prisma/schema.prisma` 三个 model
- 新增 `src/modules/permissions/` 模块(`permissions.module.ts` / `controller.ts` / `service.ts` / `dto.ts`)
- 新增 `src/common/guards/rbac.guard.ts`(可选;沿 V2 §18 评估必要性)
- 新增 BizCode 段位 `140xx` / `141xx`
- v1 现有 14 接口 / V2 现有 79 接口**入参 DTO / 出参 DTO / 路径 / HTTP 方法 / 错误码**严格 **zero drift**(A-2 红线)
- 现有 Guard / `users.policy.ts` 短期沿用,RBAC 上线后**渐进迁出**(沿 audit_logs 第二波渐进迁出范式)

---

### 决议 3:配置中心三表(与 attachments 主模块同批次)

| 表 | 内容 | CRUD API |
|---|---|---|
| `attachment_type_config` | 注册附件类型(决定 `ownerType` 枚举值;每条目含 type code / display name / 关联业务表名 / 默认 size limit / 默认 mime whitelist) | list / create / update / delete |
| `attachment_mime_config` | 各附件类型的允许 MIME 白名单(覆盖 type_config 的默认值) | list / create / update / delete |
| `attachment_size_limit_config` | 各附件类型的最大文件尺寸(覆盖 type_config 的默认值) | list / create / update / delete |

**对接方**:后台 UI 由独立前端项目对接 CRUD API。

**性质**:**与 attachments 主模块同批次落地**(C-7 attachments 实施同 PR / 同 release);**不预先**(在 C-7 启动前)落地配置中心。

**避免方案**:

- ❌ V2.x 阶段 config 文件 → V3 阶段迁 DB 表(二次迁移技术债;违背稳定长久准绳)
- ❌ 配置中心独立批次先行(增加 C-7 启动前置批次数;配置中心无 attachments 使用场景时业务价值不明)

**权限规则配置载体**:**统一走 RBAC**,**不另起** `attachment_permission_config` 表(沿问题 6 / 7 决议)。

**D7 评审稿覆盖**:

- 三表 schema(字段集 / 索引 / FK / 默认值)
- 三表 CRUD API 路径 / DTO / BizCode(段位待定;沿 V2 BizCode 段位规则在 attachments `130xx` / `131xx` 内分配)
- 缓存策略(配置改动后多长时间生效;沿 V1.1 §17.3 不引入 Redis,本期建议**进程内 short TTL 缓存** + 应用重启自动失效)
- 后台 UI 对接的接口契约(snake_case / camelCase / 分页规范沿用 v1 / V2 已确认)

---

### 决议 4:合规口径(最低合规版)

| 项 | 决议 | 文档措辞 |
|---|---|---|
| 加密 | Provider 侧 SSE-S3(开箱即用) + DB 元数据不加密 | "附件物理存储经 Provider 服务端透明加密(SSE-S3 等价);附件元数据属业务非敏感字段,DB 不加密" |
| 自动清理 | 不做自动脚本;ADMIN 手动清理 | "队员退队后由 ADMIN 在后台通过 attachments 删除接口手动清理;触发条件由 ADMIN 判断,系统不强制" |
| 保存期限 | 沿问题 7 三问表 | "在队期间永久保存;退队后按附件类型 6 个月 / 2 年由 ADMIN 触发清理评估" |
| 合法性基础 | 队员入队同意书 + 救援派遣 | "依据队员入队时签署的同意书条款(具体条款见 D7 评审稿附件)+ 救援活动派遣合理范围;符合《个人信息保护法》第 13 条合法性基础" |

**性质**:

- **不增加任何代码工作量**(0 行代码改动)
- **0 个新表 / 0 个新 service**
- **D7 评审能过**(满足 research §4.3 三问硬约束 + 个保法基本要求)
- **合规风险最小化**(留下文档证据 + 不主动违反"先存着以后补"反模式)

**业务方在 D7 评审时可调整任一格措辞,但不允许留空**。

---

### 决议 5:Provider 选型评估独立走

attachments 主模块 D7 评审稿**不决议 Provider 选型**。

**理由**:

- Provider 选型涉及安全策略(KMS / IAM / 网络 / 加密 / 合规等级)+ 成本(存储 / 流量 / 请求计费)+ 区域(国内 / 跨境)+ 可用性 SLA;比 attachments 模块本身复杂度更高
- 强行在 attachments D7 评审稿内决议会拖慢主模块评审周期
- handoff §5.3 Slow-2 明确"D7 评审 + **Provider 选型评估**"是两条独立硬前置

**独立 Provider 选型评审稿**(待新建):

- 候选:本地 / 阿里云 OSS / 腾讯云 COS / 七牛 / 又拍 / Cloudflare R2 / AWS S3 / 自建 MinIO / Garage
- 评估维度:安全 / 成本 / 区域 / 合规 / 可用性 / 上手成本 / 中长期稳定性
- 输出:单一选型决议 + 备选 + 升级路径

**时机**:与 C-7 attachments 实施期**同期**(C-6 RBAC 上线之后);**不在 C-6 / C-7 评审稿内决议**。

---

## 四、D7 评审稿覆盖范围(对后续评审稿撰写者的输入提示)

D7 attachments 评审稿(待 C-6 RBAC 落地后启动)应覆盖以下议题(基于本稿决议):

### 4.1 attachments 主模块

1. attachments 表 Prisma schema(13 字段 + 索引 + ownerType/ownerId 多态外键约束策略)
2. attachments 主模块 CRUD API(上传 / 下载 / 元数据查询 / 删除 / 列表)
3. 上传接口的 multipart / 直传 vs 中转决议
4. Service 层 ownerType / ownerId 合法性校验逻辑
5. 与 RBAC 集成层(`rbac.can(user, action, resource)` 调用点)
6. audit_logs 事件命名(`attachment.upload` / `attachment.delete` / etc;同事务 fail-fast 沿 A-17 红线)
7. 误删兜底方案(Provider versioning 启用条件 + 保留期限)

### 4.2 配置中心三表

1. `attachment_type_config` / `attachment_mime_config` / `attachment_size_limit_config` 三表 schema
2. 三表 CRUD API(对接后台 UI)
3. 进程内 short TTL 缓存策略 + 失效机制
4. 初始 seed 数据(场景 1-6 的默认配置)

### 4.3 与 Certificate 模型互动

1. Certificate.attachmentKey 字段废弃 migration
2. Certificate 出参 DTO 同步删除该字段
3. Contract snapshot 预期变更标注

### 4.4 BizCode 段位展开

1. `130xx`(attachments 业务)
2. `131xx`(配置中心)
3. 与 baseline §1.1 同步登记

### 4.5 测试覆盖

1. e2e 用例(每个场景上传 / 下载 / 删除 / 权限拒绝;含 6 大场景的多态外键校验)
2. contract snapshot(新增端点 + 现有端点 zero drift)
3. RBAC 集成单元测试

### 4.6 合规措辞(沿决议 4)

1. 入队同意书条款由维护者在 D7 评审时提供草案
2. ADMIN 手动清理 UI 路径规范
3. Provider SSE-S3 配置项验收

### 4.7 风险声明落地

1. 无病毒扫描:业务方知情承担条款进 README / OpenAPI 描述
2. 硬删除不可恢复:Provider versioning 兜底方案文档化

---

## 五、本稿不覆盖(重申硬边界)

| 项 | 留给谁 |
|---|---|
| RBAC 完整 schema / 权限点穷举 / `permissions` 表设计 | **C-6 RBAC 独立批次**(C-6 业务访谈 → D6 → D7-RBAC) |
| Provider 具体选型决议 / KMS 配置 | **独立 Provider 选型评审稿**(与 attachments 实施同期) |
| attachments schema / API 路径 / DTO / BizCode 详码 | **D7 attachments 评审稿**(C-6 落地后启动) |
| 病毒扫描具体实施方案 | 本期决议"不做",升级路径(V3+)启动时独立评审 |
| 自动清理脚本 | 本期决议"不做",维护者后续若需要独立评审 |
| 加密 KMS 密钥管理 | Provider 选型评审稿 |
| 字典 seed 真实值 | 用户私下提供(research §5.1 / §7-R13) |
| APD 部门部长 / 副部长权限规则 | C-6 RBAC 落地后由 RBAC 配置决定 |
| 现有 V2 模块改动(v1 14 接口 + V2 79 接口) | A-2 红线;本稿与 v1 / V2 既有接口 zero drift |

---

## 六、风险声明(业务方知情承担)

业务方在第二轮 / 第三轮拍板时已明确以下风险:

| # | 风险 | 业务方决议 | 备注 |
|---|---|---|---|
| 1 | 硬删除不可恢复 | 接受;走 Provider versioning 技术兜底,业务层无 UI 恢复 | 沿问题 5 + D7 评审 |
| 2 | 无病毒扫描的恶意文件上传 | 接受;升级路径留 V3+ | 沿问题 8c |
| 3 | 无 KMS 主动加密 | 接受;走 Provider SSE-S3 默认透明加密 | 沿问题 9 + 决议 4 |
| 4 | 无自动清理脚本 | 接受;ADMIN 手动清理 | 沿决议 4 |
| 5 | C-6 RBAC 不落地 attachments 不上线 | 接受;沿"稳定长久"准绳 | 沿决议 1 |
| 6 | 多态外键牺牲数据库 FK 完整性 | 接受;Service 层手写校验 | 沿问题 4 + AI 注释 |

业务方在 D7 评审 / V2.x 立项时**可调整**任一风险的接受程度(如改为"做病毒扫描"则触发独立评审稿)。

---

## 七、参考引用

### 主要引用

- [docs/批次7_attachments_业务访谈提纲.md](批次7_attachments_业务访谈提纲.md):本稿前置访谈提纲(已落地于 PR #44, squash commit `08aa4d7`)
- [docs/srvf-foundation-research.md §2.4 / §3.10 / §3.11 / §4.3 / §4.9 / §5.2 / §6.5](srvf-foundation-research.md):attachments / RBAC / 软删除 / 合规相关 [当前倾向] / [待调研] / [已确认] 段头标签

### 红线 / 复活路径

- [docs/V2红线与复活路径.md](V2红线与复活路径.md) **A-4**:不扩 Role enum / 不引入 RBAC(本稿在 §三 决议 2 通过 §9 升级路径解锁 RBAC)
- [docs/V2红线与复活路径.md](V2红线与复活路径.md) **C-6 / Slow-1**:APD 部门部长 / 副部长权限细分(本稿决议 1 / 2 触发 C-6 完整批次启动)
- [docs/V2红线与复活路径.md](V2红线与复活路径.md) **C-7 / Slow-2**:attachments 复活硬前置(本稿决议 1 增加 C-6 落地为前置)

### 阶段交接 / 当前状态

- [docs/handoff/v0.8.0.md §5.2 E-13](handoff/v0.8.0.md):attachments 第一个真实需求 → 本稿决议(场景 1-4 启用 / 场景 5-6 延后)
- [docs/handoff/v0.8.0.md §5.3 Slow-1 / Slow-2](handoff/v0.8.0.md):RBAC + attachments 双硬前置 → 本稿决议 1
- [docs/handoff/v0.8.0.md §6.1](handoff/v0.8.0.md):v0.8.0 阶段绝对禁止"顺手做" RBAC / attachments

### 基线 / 段位锁定

- [docs/srvf-foundation-baseline.md §1.1](srvf-foundation-baseline.md):BizCode 段位 `130xx` / `131xx`(attachments) — V2 基线预留;**新增** `140xx` / `141xx`(permissions / RBAC) 待 baseline 评审

### 升级路径 / 架构

- [ARCHITECTURE.md §9](../ARCHITECTURE.md):升级路径(RBAC + 文件上传 Provider)
- [ARCHITECTURE.md §12.11.2](../ARCHITECTURE.md):V2.x 复活路径

### 写作铁律

- [CLAUDE.md §18](../CLAUDE.md):V2 调研期约束(§18.2 表达级禁止 + §18.3 四档标签 + §18.4 协作纪律 + §18.4.1 baseline 强制读取 + §18.5 工具链约束)
- [docs/srvf-foundation-baseline.md §14.4](srvf-foundation-baseline.md):规范冲突优先级(v1 §1-§17 > V1.1 §17 > baseline > 草案 > 任务卡)

### 既有风格参照

- [docs/批次6_audit_logs_业务确认稿.md](批次6_audit_logs_业务确认稿.md):D6 业务确认稿风格参照

---

## 八、撰写元信息

- **状态标签**:草稿 v0.1;**D6 业务确认**(已业务方拍板,等 D7 评审)
- **下一步**(沿决议 1 启动顺序):
  1. **C-6 RBAC 业务访谈提纲**:新建 `docs/批次N_RBAC_业务访谈提纲.md`(N 由维护者拍板) — **C-7 attachments 实施的硬前置**
  2. C-6 D6 业务确认稿 → C-6 D7 评审稿 → C-6 实施 → C-6 上线
  3. **C-7 attachments D7 评审稿**(C-6 完成后启动) — 基于本稿决议
  4. Provider 选型独立评审稿(与 C-7 实施同期)
  5. C-7 实施 → V2.x attachments 批次正式立项
- **覆盖的红线 / baseline**:
  - V2 §18.2 不写最终 schema / V2 §18.3 四档标签(已确认 / 当前倾向 / 待调研 / 暂不做)
  - V2 §18.4 涉及敏感信息必须三问(问题 7 / 9 三问表落地)
  - V2 §18.4 不擅自调和合规冲突(AI 标记两次合规红线 + 业务方两次澄清)
  - handoff §5.3 Slow-1 + Slow-2 硬前置(决议 1 顺序)
  - baseline §1.1 BizCode 段位预留(决议 2 新增 140xx / 141xx 标注)
- **不在本期范围**:见 §五
- **撰写者签名**:Claude Code(基于业务方三轮拍板 + "不考虑时间周期,只考虑稳定和长久" 准绳;**未动任何代码 / schema / migration**)
- **commit 风格(若维护者决定提 PR)**:`docs(v2-design): 批次7 attachments 业务确认稿 v0.1`(沿 V2 §18.5 风格)
