# 《RBAC 权限模型业务确认稿(批次 8)》

> **用途**:作为 [《RBAC 权限模型业务访谈提纲(批次 8,暂定)》](批次8_RBAC_业务访谈提纲.md) 的 **D6 业务确认产物**,记录业务方对 13 个问题的逐项拍板。本稿为 C-6 RBAC D7-RBAC 评审稿的输入。
> **性质**:**D6 业务确认稿**(业务方已拍板;等 D7-RBAC 评审 + V2.x 立项)。
> **批次号**:批次 8 暂定;正式编号以 D7-RBAC 评审通过 + V2.x 立项 commit 为准。
> **撰写日期**:2026-05-14
> **业务方**:项目维护者(兼救援队代表方)
> **接续**:[访谈提纲(批次 8)](批次8_RBAC_业务访谈提纲.md) / [PR #45 attachments 业务确认稿 §三 决议 1 / 决议 2](批次7_attachments_业务确认稿.md) / [V2 红线 C-6 / Slow-1](V2红线与复活路径.md) / [research §3.11](srvf-foundation-research.md)
> **拍板准绳**(沿 PR #45 业务方原话):**"不考虑时间周期 只考虑项目稳定和长久"**
> **核心决议**(13 题逐项 + 4 处留 D7-RBAC 细化,详见 §二 / §四):
> 1. **业务角色清单**:D 全套 seed 预置(常用角色)+ 后台 CRUD API 支持运营持续新增角色
> 2. **角色组合**:B 多 RBAC 角色(`user_roles` 多对多)
> 3. **★ 权限点粒度**:B resource type 级(项目骨架级)
> 4. **资源所有权**:C 混合(`user.id` + `Member.id` 两种 owner 字段)
> 5. **★ 角色继承**:B 三层 Role 自动继承(项目骨架级)
> 6. **权限点分配权**:C 专门的"运营管理员"业务角色
> 7. **角色分配权**:D 按角色分级
> 8. **按部门切片**:A 不切片
> 9. **配置即时生效策略**:B 显式 reload 接口
> 10. **上线时初始 seed**:D 全套预置(配合决议 1 自定义扩展)
> 11. **★ 与现有三层 Role 关系**:C 短期 A 长期 B(过渡终止条件留 D7-RBAC 决议;项目骨架级)
> 12. **RBAC 配置变更 audit_logs**:A 全部记录
> 13. **用户失效场景下 RBAC 角色处理**:A disable 时 `user_roles` 不动

---

## 一、背景与拍板准绳

### 1.1 拍板时间线

| 时间 | 事件 |
|---|---|
| 2026-05-13 | [批次 7 attachments 业务确认稿(PR #45)](批次7_attachments_业务确认稿.md) §三 决议 1 / 决议 2 锁定:**C-6 RBAC 完整模型批次先行 → C-7 attachments 批次跟进** + **完整 RBAC 三表**(`permissions` + `role_permissions` + `user_roles`) |
| 2026-05-13 | 批次 8 RBAC 业务访谈提纲落地为 [PR #46](批次8_RBAC_业务访谈提纲.md)(squash commit `1b33c4e`) |
| 2026-05-14 | 业务方逐项答 13 题(本稿源数据) |
| 2026-05-14 | AI 标记 2 处 AI 转译(Q1 + Q11)+ 4 处留 D7-RBAC 细化(Q4 / Q6 / Q7 / Q10) |
| 2026-05-14 | 业务方拍板 "A 接受 AI 转译,立即执行" |
| 2026-05-14 | 本稿撰写 |

### 1.2 拍板准绳

沿 PR #45 业务方原话:**"不考虑时间周期 只考虑项目稳定和长久"**。

本次 13 题大部分**直接落**(8 题);其中:

- **2 题项目骨架级(Q3 / Q5)**:业务方直接选 B(标准 RBAC 做法 + 自动继承),与稳定长久准绳一致
- **1 题项目骨架级(Q11)**:业务方选 C(短期 A 长期 B),保留未来灵活性;**过渡终止条件留 D7-RBAC 决议**
- **2 处 AI 转译(Q1 + Q11)**:业务方原话非候选选项,AI 转译后业务方拍板"A 接受 AI 转译"
- **4 处留 D7-RBAC 细化(Q4 / Q6 / Q7 / Q10)**:决议方向已定,但实施细节(具体字段集 / bootstrap 流程 / 角色层级 / seed 内容)留 D7-RBAC 评审稿决议

### 1.3 本稿边界

| 范围 | 说明 |
|---|---|
| ❌ RBAC 三表 schema 详码(字段集 / 索引 / FK / `@db.*` 注解) | 留 D7-RBAC 评审稿 |
| ❌ 权限点穷举具体名称(几百条 permissions seed 内容) | D7-RBAC + 上线后运营持续维护 |
| ❌ RBAC CRUD API 路径 / DTO / BizCode 详码 | 留 D7-RBAC(段位 `140xx` / `141xx` 待 baseline §1.1 评审) |
| ❌ `users.policy.ts` 何时迁出 / 是否完全废弃 | 留 D7-RBAC + Q11 过渡终止条件决议 |
| ❌ 缓存基建(Redis / 失效广播 / 多实例分布式锁) | V1.1 §17.3 锁;本期不解锁 |
| ❌ 多租户 / 跨组织权限隔离 | RBAC 之外;Q8 选 A 不切片,未来需要时走 §9 升级路径 |
| ❌ 真实角色名 / 部门名 / 字典 seed 真实值 | user 私下提供,不进公共仓库历史(research §5.1 / §7-R13) |
| ❌ 现有 v1 14 接口 + V2 既有 79 接口任何字段变更 | A-2 红线;本期 RBAC 完全向后兼容 |
| ❌ Q11 过渡终止条件 | 留 D7-RBAC 决议(本稿仅标方向"V2 阶段沿 A") |

---

## 二、业务方逐项拍板(13 题)

> **说明**:每题先记业务方拍板(原话引用 + 选项),再附 AI 风险注释 / 转译版本 / D7-RBAC 评审稿覆盖范围。**AI 转译版本**仅作 D7-RBAC 评审输入候选,**D7-RBAC 评审时业务方有权回退或调整**。

### 问题 1:业务角色清单 — 哪些"业务角色"要进 RBAC 表?

**业务方原话**:"尽量做到可以自定义角色"

**业务方拍板**(非候选 A/B/C/D/E,经 AI 转译):**D 全套 seed 预置常用角色 + 后台 CRUD API 支持运营持续新增角色**

**AI 转译**:

业务方原话不在候选 A/B/C/D/E 中,字面意为"RBAC 系统支持运营运行时增删角色"。这是 RBAC 标准能力(`role_permissions` + `user_roles` 表 + 后台 CRUD API 就是自定义角色基建)。AI 转译为:

- **D 全套 seed 预置常用角色**(沿 Q10 D 决议):首批包含 APD 部长 / 副部长 / 装备管理员 / 培训管理员 / 运营管理员 等(**真实名字由 user 私下提供 seed**,沿 research §5.1 / §7-R13)
- **+ 后台 CRUD API 支持运营持续新增角色**:对接独立的后台 UI 项目;后台 UI 不在本期范围

业务方第二轮拍板"A 接受 AI 转译,立即执行" → **本稿落地**

**AI 风险注释**:

- 与 Q6 C(运营管理员业务角色)天然契合 — 运营管理员就是日常增删角色的角色
- "自定义角色"能力上线 = bootstrap 阶段必须有"首个运营管理员"(Q6 bootstrap 策略)

**D7-RBAC 评审稿覆盖**:

- 首批预置角色清单(具体名字 user 私下提供;脱敏 placeholder 在评审稿中)
- 后台 CRUD API 路径 + DTO + 字段集(role 的 `code` / `displayName` / `description` 等)
- 运行时新增角色后的权限点分配流程

---

### 问题 2:角色组合 — 一个用户能否兼任多个业务角色?

**业务方原话**:"多 RBAC 角色"

**业务方拍板**:**B 多 RBAC 角色**(一个用户可持有多个业务角色,如某 ADMIN 同时是"APD 部长 + 装备管理员")

**AI 风险注释**:无。多角色是 RBAC 标准做法,与三表设计天然契合。

**D7-RBAC 评审稿覆盖**:

- `user_roles` 表实现多对多关系
- 判权时取并集(任一角色拥有权限点即通过)
- 角色冲突场景的处理(暂无明显冲突场景;但 D7-RBAC 评审时考虑)
- 性能:多角色 + 权限点查询的 join 性能(沿 Q9 缓存策略缓解)

---

### 问题 3:★ 权限点粒度(项目骨架级)

**业务方原话**:"B"

**业务方拍板**:**B resource type 级**(`<module>.<action>.<resource_type>`)

**AI 风险注释**:

- B resource type 级是 RBAC 标准做法,与 attachments 业务确认稿(决议 6 + 7)天然契合
- 权限点示例(D7-RBAC 决议具体命名):
  - `attachment.upload.cert` / `attachment.view.cert` / `attachment.upload.activity` / ...
  - `member.read.self` / `member.read.other` / `member.update.self` / ...
- 规模预估:**100-200 条** permissions(D7-RBAC 评审时穷举)

**D7-RBAC 评审稿覆盖**:

- 权限点命名规范(`<module>.<action>.<resource_type>` 或类似 — D7 拍板)
- 与 attachments 业务确认稿权限点示例对齐
- `permissions` 表字段集 + 索引

---

### 问题 4:资源所有权 — "本人"的判定方式

**业务方原话**:"C"

**业务方拍板**:**C 混合**(`user.id` + `Member.id` 两种 owner 字段,不同业务表用不同字段)

**🔄 留 D7-RBAC 细化**:

- 每个业务表的"本人"判定字段:
  - `Members`:本人 = `Member.id`(user 通过 `User.memberId` 关联)
  - `Activities`:创建者可能 = `User.id`(管理员创建活动,无 Member 关联)
  - `Attachments`:上传者 = `User.id` 或 `Member.id`(D7 决议;沿 attachments 业务确认稿 Q2 字段集决议)
  - `Certificates`:本人 = `Member.id`(直接挂 Member)
  - 其他业务表:D7-RBAC 评审稿逐表明确

**AI 风险注释**:

- 判权函数 `rbac.can(user, action, resource)` 需要支持两种 owner 字段判定
- 实施层面:Service 层判权时根据 resource type 决定查 `user.id` 还是 `user.memberId`

**D7-RBAC 评审稿覆盖**:

- 每个业务表的"本人"判定字段穷举
- `rbac.can(user, action, resource)` 函数签名 + 实现
- 与现有 `User.memberId` 可空外键(v1 兼容性,沿 §12.8.2)的协同

---

### 问题 5:★ 角色继承(项目骨架级)

**业务方原话**:"选 B"

**业务方拍板**:**B 三层 Role 自动继承**

- `SUPER_ADMIN` 自动拥有 `ADMIN` 所有权限
- `ADMIN` 自动拥有 `USER` 所有权限
- RBAC 业务角色之间**无显式继承**

**AI 风险注释**:

- 三层 Role 自动继承是大多数 RBAC 系统的默认做法
- RBAC 业务角色无显式继承 = 简单清晰;真出现"APD 部长 自动拥有 APD 副部长 所有权限"诉求时,通过 Q6 C 运营管理员手动配置即可

**D7-RBAC 评审稿覆盖**:

- 三层 Role 自动继承的实现方式:judge 函数中先判 Role 等级 + 再查 RBAC(沿 Q11 短期 A 决议)
- 继承环路检测(虽然 RBAC 业务角色无显式继承,但 D7 评审时确认无环路风险)

---

### 问题 6:权限点分配权 — 谁能修改 `role_permissions` 表?

**业务方原话**:"选 C"

**业务方拍板**:**C 专门的"运营管理员"业务角色**

**🔄 留 D7-RBAC 细化**:

- **bootstrap 策略**:首次 seed 时谁是"运营管理员"?
  - **AI 建议**:`SUPER_ADMIN` 通过 Q5 B 自动继承机制,自动拥有运营管理员的所有权限;**seed 同时预置"运营管理员"业务角色**,user 私下提供"首个运营管理员"的具体 User ID(在 seed 阶段配置)
- **运营管理员能改的表粒度**:
  - **AI 建议**:`permissions` / `role_permissions` / `user_roles` **三张表全部能改**(因为 Q1 自定义角色 + Q10 D 全套预置都需要)
  - 但需要**最低保留 SUPER_ADMIN 角色不可删除 / 不可被剥夺所有权限**(类似 v1 §13 "最后一个 SUPER_ADMIN 保护")

**AI 风险注释**:

- 运营管理员是 RBAC 自我管理的"meta 角色",bootstrap 必须保证至少 1 个用户拥有此角色,否则系统无法运营
- 运营管理员被 disable / soft-delete 时需检查"剩余活跃运营管理员数"(沿 v1 §13 最后一个 SUPER_ADMIN 保护范式)

**D7-RBAC 评审稿覆盖**:

- 运营管理员的具体权限点(`rbac.permission.*` / `rbac.role-permission.*` / `rbac.user-role.*`)
- bootstrap 流程(seed migration 时如何配置首个运营管理员)
- "最后一个运营管理员保护"(类比 v1 §13)
- 与 Q7 D 角色分级的协同

---

### 问题 7:角色分配权 — 谁能修改 `user_roles` 表?

**业务方原话**:"D"

**业务方拍板**:**D 按角色分级**(SUPER_ADMIN 能分配任何角色;ADMIN / 部长配下属;某些业务角色能分配下属角色)

**🔄 留 D7-RBAC 细化**:

- **角色层级具体定义**:救援队组织扁平,层级未必明显;**D7-RBAC 评审时由业务方明确**:
  - 候选 1:SUPER_ADMIN > 部长 > 副部长 > 队员
  - 候选 2:SUPER_ADMIN > 运营管理员(可分配高敏感角色) > 部长(可分配队员级) > 副部长(可分配队员级) > 队员
  - 候选 3:简化为"SUPER_ADMIN 配所有 + 运营管理员配所有 + 其他角色不配"(最小化层级)

**AI 风险注释**:

- 角色分配比权限点分配频繁(新人入队需要分角色)
- "按角色分级"配套的"角色层级"是 D7-RBAC 必决项

**D7-RBAC 评审稿覆盖**:

- 角色层级具体规则
- "分配权"判定函数(`canAssignRole(actor, targetUser, targetRole)`)
- 与 v1 §13 `assertCanManageUser` 共存方案

---

### 问题 8:按部门切片(数据范围权限)

**业务方原话**:"A"

**业务方拍板**:**A 不切片**(权限是全局的;APD 部长能审**所有** APD 活动,无论组织节点)

**AI 风险注释**:

- 救援队当前**单组织**场景实际等价
- 未来多组织 / 多部门切片诉求出现时,通过 `ARCHITECTURE.md §9` 升级路径解锁(扩 schema + 加 `scope_*` 字段)

**D7-RBAC 评审稿覆盖**:

- `role_permissions` 表**不**增加 `scope_organization_id` / `scope_department_id` 字段
- 数据范围判断仍走 Service 层显式判断(沿现有 `users.policy.ts` 风格)
- "本人 vs 他人"判定走 Q4 决议

---

### 问题 9:配置即时生效策略

**业务方原话**:"B"

**业务方拍板**:**B 显式 reload 接口**(运营改完 RBAC 配置后调"reload" 接口主动触发缓存失效)

**AI 风险注释**:

- 进程内 short TTL 缓存(沿 V1.1 §17.3 不引入 Redis)
- **默认 TTL 设较长**(如 30 分钟),依赖运营主动调 reload 接口即时生效
- 多实例部署时需要广播失效(暂不涉及,V1.1 §17.3 锁;未来多实例场景需 §9 升级路径)

**D7-RBAC 评审稿覆盖**:

- 缓存实现(进程内 Map / NodeCache / 其他;TTL 默认值)
- reload 接口的权限:只有运营管理员能调
- reload 接口的范围:全量刷新 / 按 user 刷新 / 按 role 刷新(D7 决议)
- 多实例场景的过渡方案(单实例 OK,多实例需 §9 升级)

---

### 问题 10:上线时初始 seed

**业务方原话**:"D"

**业务方拍板**:**D 全套预置**(配合 Q1 自定义扩展)

**🔄 留 D7-RBAC 细化**:

- 具体首批角色清单 + 权限点清单 + 角色权限映射(user 私下提供 seed 真实内容)
- migration 文件结构(沿 v0.2.0 ~ v0.8.0 7 个 migration 范式)

**AI 风险注释**:

- D 全套预置工作量较大,但与"稳定长久"准绳契合
- 与 attachments 业务确认稿 §三 决议 3 配合:attachments 模块上线时所有权限点已经在 RBAC 中(避免 attachments 启动时"再补 RBAC 配置")

**D7-RBAC 评审稿覆盖**:

- 首批预置范围(角色 + 权限点 + 角色权限映射)
- 真实名字 / 真实权限点名(脱敏 placeholder 在评审稿;真实值 user 私下提供)
- 与 attachments 业务确认稿权限点的对齐

---

### 问题 11:★ 与现有三层 Role 的关系(项目骨架级)

**业务方原话**:"C"

**业务方拍板**:**C 短期 A 长期 B**(过渡方案)

**AI 转译**:

- **短期(V2 阶段)沿 A**:三层 Role 仍权威;`users.policy.ts` + `RolesGuard` + `@Roles(...)` 装饰器保留;RBAC 仅作业务级权限补充(attachments / 未来业务模块通过 RBAC 判细分权限)
- **长期 B**:三层 Role 退化为"系统级身份标签"(仅 enum);所有判权完全走 RBAC
- **过渡终止条件**:**留 D7-RBAC 评审稿决议**(避免现在拍板限制未来灵活性);候选:
  - (a) 某 N 个业务模块 100% 走 RBAC 判权后,启动 v1 14 接口 `@Roles(...)` 迁出
  - (b) 时间硬截止(如 V3.0 启动时强制完全切换)
  - (c) **永不切换** — 三层 Role 永远存在作为"系统级身份分层";RBAC 作为业务级补充长期共存

业务方第二轮拍板"A 接受 AI 转译,立即执行" → **本稿落地**

**AI 风险注释**:

- 过渡期内 RBAC 与三层 Role 双重判权可能引发语义冲突(D7-RBAC 必须明确判权优先级)
- v1 14 接口的 `@Roles(...)` 装饰器保留(A-2 红线)
- 过渡终止条件**不在本期决议**,避免锁死未来选项

**D7-RBAC 评审稿覆盖**:

- 过渡期判权优先级:三层 Role(粗粒度快速路径)→ RBAC(细粒度业务判权)
- 短路逻辑:SUPER_ADMIN 是否自动通过所有 RBAC 判权?(AI 倾向是,沿 Q5 B 三层 Role 自动继承)
- 过渡终止条件决议(三选一 + 备选)
- v1 接口 + V2 既有接口的 `@Roles(...)` 是否启动迁出(沿 Q11 长期 B 方向,但 A-2 红线锁定 v1 14 接口)

---

### 问题 12:RBAC 配置变更 `audit_logs`

**业务方原话**:"A"

**业务方拍板**:**A 全部记录**(`permissions` / `role_permissions` / `user_roles` 三表增删改全部走 `AuditLogsService.log()` 同事务落库)

**AI 风险注释**:

- 沿 audit_logs 第二波写迁移范式(PR #34 - #41)
- 同事务 fail-fast(A-17 红线)
- 不审计 audit_logs 自身(A-18 红线)

**D7-RBAC 评审稿覆盖**:

- 新增 `AuditLogEvent` union 项(预估 ~9 项):
  - `rbac.permission.{create, update, delete}` × 3
  - `rbac.role-permission.{create, delete}` × 2
  - `rbac.user-role.{create, delete}` × 2
  - `rbac.config.reload` × 1(沿 Q9 显式 reload 接口)
  - `rbac.role.{create, update, delete}` × 3(沿 Q1 自定义角色 + 后台 CRUD API)
  - **具体 union 项 D7 拍板**(可能 union 项更多或更少)
- 同事务 wrap 策略
- e2e 覆盖

---

### 问题 13:用户失效场景下 RBAC 角色处理

**业务方原话**:"A"

**业务方拍板**:**A disable 时 `user_roles` 不动**(disable 后用户登录失败,RBAC 自然失效)

**AI 风险注释**:

- 沿 v1 软禁用模式(`User.status = DISABLED`)
- disable + reactivate 体验最好(角色配置原样保留)
- soft-delete 时 `user_roles` 也不动(但 RBAC 判权时检查 `User.deletedAt === null`)
- Member 离队场景:Member 软删 → 关联 User 软删 → user_roles 自然失效(沿 v1 软删除模式)

**D7-RBAC 评审稿覆盖**:

- 判权时检查:`User.status === ACTIVE && User.deletedAt === null`(沿 v1 `JwtStrategy.validate()` 范式)
- `user_roles` 表**不**增加 `deletedAt` 字段(沿 Q13 A 决议简化)
- disable + reactivate 流程的 user_roles 一致性测试

---

## 三、超出原 13 题的新增决议(沿 PR #45 风格)

### 决议 1:启动顺序(沿 PR #45 §三 决议 1,本稿仅复述)

**C-6 RBAC 完整模型批次先行 → C-7 attachments 批次跟进**。

**本稿落地后下一步**:

1. 本 PR(D6 业务确认稿)merge → main
2. **D7-RBAC 评审稿**起草(基于本稿 + Q1 / Q4 / Q6 / Q7 / Q10 / Q11 留待 D7 细化项)
3. D7-RBAC 评审通过 → C-6 RBAC 批次正式立项
4. C-6 实施 + 上线
5. C-6 上线后 → **C-7 attachments D7 评审稿启动**(沿 PR #45 决议 1 顺序)

### 决议 2:RBAC 模型(沿 PR #45 §三 决议 2,本稿仅复述)

**完整 RBAC 三表**(`permissions` + `role_permissions` + `user_roles`)+ 沿用现有三层 Role 并存(沿 Q11 C 短期 A 长期 B,过渡终止条件留 D7-RBAC)。

### 决议 3:实施前置(沿 PR #45 + V2 红线 + ARCHITECTURE.md §9)

C-6 RBAC 实施前必须:

- 走 `ARCHITECTURE.md §9` 升级路径(扩 Prisma schema + 新增 `modules/permissions/` + BizCode 段位 `140xx` / `141xx`)
- baseline §1.1 评审追加 `140xx` / `141xx` 段位
- 新增 `prisma/schema.prisma` 三个 model(`Permission` / `RolePermission` / `UserRole`)+ 1 个 model(`Role` 自定义角色表;沿 Q1)
- 实施按 v0.7.0 / v0.8.0 audit_logs 范式渐进推进(单模块独立 PR + 单 docs 收口 PR)

### 决议 4:v1 / V2 既有接口 zero drift(沿 A-2 红线)

- v1 14 接口 + V2 既有 79 接口的**路径 / HTTP 方法 / 入参 DTO / 出参 DTO / 错误码 / 权限标注 / 响应包装**全部保留不变
- `users.policy.ts` 保留(沿 Q11 短期 A);RBAC 是补充,不替换
- contract snapshot 验收 zero drift(沿 v0.7.0 / v0.8.0 范式)

---

## 四、D7-RBAC 评审稿覆盖范围(对后续评审稿撰写者的输入提示)

D7-RBAC 评审稿应覆盖以下议题(基于本稿决议):

### 4.1 RBAC 三表 + Role 表 schema 设计

1. `Permission` 表(权限点定义;`code` / `description` / `module` / `resource_type` / `action`)
2. `Role` 表(业务角色定义;沿 Q1 自定义角色;`code` / `displayName` / `description`)
3. `RolePermission` 中间表(角色 ↔ 权限点 多对多;含 `createdAt` / `createdBy` 审计字段)
4. `UserRole` 中间表(用户 ↔ 角色 多对多;沿 Q2 / Q13 — **不**含 `deletedAt`)
5. 索引 / FK / `@db.*` 注解

### 4.2 权限点穷举(首批 seed)

1. 各业务模块的权限点定义(`<module>.<action>.<resource_type>` 命名规范;沿 Q3 B)
2. **真实权限点名 user 私下提供**(脱敏 placeholder 在评审稿)
3. 与 attachments 业务确认稿(决议 6 + 7)的权限点对齐

### 4.3 RBAC CRUD API

1. `permissions` CRUD(沿 Q6 C 运营管理员权限)
2. `roles` CRUD(沿 Q1 自定义角色)
3. `role_permissions` CRUD(沿 Q6 C)
4. `user_roles` CRUD(沿 Q7 D 按角色分级 — 含分配权限判定)
5. `rbac/reload` 接口(沿 Q9 B)
6. API 路径 + DTO + BizCode 段位 `140xx` / `141xx`(待 baseline §1.1 评审)

### 4.4 judge 函数 `rbac.can(user, action, resource)` 设计

1. 函数签名(`resource` 类型;`action` 类型)
2. 实现:三层 Role 短路 → 业务 Role 查询 → 权限点匹配
3. "本人"判定(沿 Q4 C 混合;各业务表的 owner 字段映射)
4. 缓存策略(沿 Q9 B 进程内 short TTL + 显式 reload)

### 4.5 与三层 Role / `users.policy.ts` 共存

1. 判权优先级(沿 Q11 C 短期 A)
2. 短路逻辑(SUPER_ADMIN 是否自动通过所有 RBAC 判权)
3. v1 14 接口的 `@Roles(...)` 装饰器保留(A-2 红线)
4. 过渡终止条件三选一决议(沿 Q11)

### 4.6 audit_logs 集成(沿 Q12 A)

1. 新增 `AuditLogEvent` union 项(预估 ~9 项 ± )
2. 同事务 fail-fast wrap 策略
3. e2e 覆盖

### 4.7 初始 seed migration(沿 Q1 + Q10)

1. 预置角色清单(脱敏 placeholder)
2. 预置权限点清单
3. 预置角色权限映射
4. **首个运营管理员 bootstrap 流程**(沿 Q6 决议)

### 4.8 失效场景测试(沿 Q13 A)

1. disable + reactivate 流程的 user_roles 一致性
2. soft-delete 时 RBAC 判权失败
3. Member 离队联动测试

### 4.9 "最后一个运营管理员保护"(沿 Q6 AI 风险注释)

1. 类比 v1 §13 最后一个 SUPER_ADMIN 保护
2. 运营管理员 disable / soft-delete / 改角色时的事务内检查

### 4.10 测试覆盖

1. e2e 用例(每场景判权 / 失效场景 / bootstrap / 多角色组合)
2. contract snapshot(新增端点 + 现有 v1 14 + V2 79 接口 zero drift)
3. RBAC judge 函数单元测试

---

## 五、本稿不覆盖(重申硬边界)

| 项 | 留给谁 |
|---|---|
| RBAC 三表 + Role 表 schema 详码 / 字段集 / 索引 / FK | D7-RBAC 评审稿 |
| 权限点穷举具体名称 | D7-RBAC + 上线后运营持续维护 |
| RBAC CRUD API 路径 / DTO / BizCode 详码 | D7-RBAC |
| `rbac.can()` 函数签名 + 实现细节 | D7-RBAC |
| 缓存基建(Redis / 失效广播) | V1.1 §17.3 锁;本期不解锁 |
| 多租户 / 跨组织 / 多语言 | RBAC 之外;Q8 A 不切片 |
| 真实角色名 / 部门名 / 字典 seed 真实值 | user 私下提供(research §5.1 / §7-R13) |
| Q11 过渡终止条件 | D7-RBAC 评审稿决议 |
| Q4 / Q6 / Q7 / Q10 实施细节 | D7-RBAC 评审稿决议 |
| v1 14 接口 + V2 79 接口任何字段变更 | A-2 红线;本期 RBAC 完全向后兼容 |
| C-7 attachments 实施 | C-6 落地后启动(沿 PR #45 决议 1) |
| Provider 选型评估 | 独立评审稿(与 C-7 实施同期) |

---

## 六、风险声明(业务方知情承担)

业务方在 13 题答案中已明确接受以下风险:

| # | 风险 | 业务方决议 | 备注 |
|---|---|---|---|
| 1 | Q11 过渡期内 RBAC 与三层 Role 双重判权可能引发语义冲突 | 接受;过渡终止条件留 D7-RBAC 决议 | 沿 Q11 C |
| 2 | Q8 单组织场景等价;未来多组织 / 多部门切片需走 §9 升级路径 | 接受 | 沿 Q8 A |
| 3 | Q9 显式 reload 接口在单实例 OK;多实例场景需 §9 升级路径 | 接受 | 沿 Q9 B |
| 4 | Q13 disable + reactivate 体验好,但用户回归时角色仍保留可能不符部分场景 | 接受 | 沿 Q13 A |
| 5 | RBAC 引入 = §9 升级路径;扩 schema + 新增 BizCode 段位 + 新增模块 | 接受 | 沿 PR #45 §三 决议 2 + 本稿 §三 决议 3 |

业务方在 D7-RBAC 评审 / V2.x 立项时**可调整**任一风险的接受程度。

---

## 七、参考引用

### 主要引用

- [docs/批次8_RBAC_业务访谈提纲.md](批次8_RBAC_业务访谈提纲.md):本稿前置访谈提纲(PR #46,squash commit `1b33c4e`)
- [docs/批次7_attachments_业务确认稿.md](批次7_attachments_业务确认稿.md):**RBAC 启动顺序 + 模型选型来源**(§三 决议 1 + 决议 2)
- [docs/批次7_attachments_业务访谈提纲.md](批次7_attachments_业务访谈提纲.md):访谈提纲风格参照
- [docs/批次6_audit_logs_业务确认稿.md](批次6_audit_logs_业务确认稿.md):D6 业务确认稿风格参照
- [docs/srvf-foundation-research.md §3.11](srvf-foundation-research.md):权限模型升级 [暂不做] 段头(C-6 解锁的源头)

### 红线 / 复活路径

- [docs/V2红线与复活路径.md](V2红线与复活路径.md) **A-2**:v1 14 接口 + V2 既有 79 接口 zero drift(沿本稿 §三 决议 4)
- [docs/V2红线与复活路径.md](V2红线与复活路径.md) **A-4**:不扩 Role enum / 不引入 RBAC(本期通过 §9 升级路径解锁)
- [docs/V2红线与复活路径.md](V2红线与复活路径.md) **A-17**:audit_logs 同事务 fail-fast(沿 Q12 A)
- [docs/V2红线与复活路径.md](V2红线与复活路径.md) **A-18**:不审计 audit_logs 自身(沿 Q12 A)
- [docs/V2红线与复活路径.md](V2红线与复活路径.md) **C-6 / Slow-1**:APD 部长 / 副部长权限细分(本稿启动)
- [docs/V2红线与复活路径.md](V2红线与复活路径.md) **C-7 / Slow-2**:attachments 复活硬前置(C-6 落地后启动)

### 阶段交接 / 当前状态

- [docs/handoff/v0.8.0.md §5.3 Slow-1](handoff/v0.8.0.md):RBAC 模型评审硬前置 → 本稿启动

### 基线 / 段位锁定

- [docs/srvf-foundation-baseline.md §1.1](srvf-foundation-baseline.md):BizCode 段位预估 `140xx` / `141xx`(待 baseline 评审追加)

### 升级路径 / 架构

- [ARCHITECTURE.md §7.11](../ARCHITECTURE.md):三层 Role 不是 RBAC 的声明(本期解锁 RBAC 不破坏此声明,而是叠加)
- [ARCHITECTURE.md §9](../ARCHITECTURE.md):升级路径(RBAC 解锁前置)
- [ARCHITECTURE.md §12.11.2](../ARCHITECTURE.md):V2.x 复活路径

### 写作铁律

- [CLAUDE.md §13 角色层级与管理员保护](../CLAUDE.md):v1 §13 最后一个 SUPER_ADMIN 保护(本稿 Q6 风险注释类比)
- [CLAUDE.md §18](../CLAUDE.md):V2 调研期约束(§18.2 表达级禁止 + §18.3 四档标签 + §18.4 协作纪律)
- [docs/srvf-foundation-baseline.md §14.4](srvf-foundation-baseline.md):规范冲突优先级

---

## 八、撰写元信息

- **状态标签**:草稿 v0.1;**D6 业务确认**(已业务方拍板;等 D7-RBAC 评审)
- **下一步**(沿决议 1 启动顺序):
  1. **D7-RBAC 评审稿**(新建 `docs/批次8_RBAC_API前评审.md` 或类似命名;沿 `docs/批次6_audit_logs_API前评审.md` 风格)— 基于本稿决议
  2. C-6 RBAC 批次正式立项 → 实施(多 PR)→ 上线
  3. **C-6 上线后** → C-7 attachments D7 评审稿启动(基于 PR #45 决议)
- **覆盖的红线 / baseline**:
  - V2 §18.2 不写最终 schema / V2 §18.3 四档标签
  - V2 §18.4 不擅自调和:Q1 + Q11 经业务方第二轮拍板"A 接受 AI 转译"
  - PR #45 §三 决议 1 / 决议 2 锁定的启动顺序 + RBAC 模型
  - baseline §1.1 段位预留(`140xx` / `141xx` 待 baseline 评审追加)
  - A-2 v1 14 接口 + V2 既有 79 接口 zero drift(本稿 §三 决议 4)
  - A-17 + A-18 audit_logs 范式(沿 Q12 A)
- **不在本期范围**:见 §五
- **撰写者签名**:Claude Code(基于业务方逐题拍板 + 业务方"A 接受 AI 转译"二次确认;**未动任何代码 / schema / migration**)
- **commit 风格(若维护者决定提 PR)**:`docs(v2-design): 批次8 RBAC 业务确认稿 v0.1`(沿 V2 §18.5 风格)
