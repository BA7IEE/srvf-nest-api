# 《RBAC 权限模型业务访谈提纲(批次 8,暂定)》

> **用途**:拿去和深圳救援队管理层 / 业务负责人面对面访谈或异步收集答案。
> **性质**:**访谈前置提纲**,**不是**业务确认稿;答案收齐后才升级为 D6 业务确认稿,再进 D7-RBAC 评审稿。
> **批次号**:批次 8 暂定;正式编号以 D7-RBAC 评审通过 + V2.x 立项 commit 为准。
> **撰写日期**:2026-05-13
> **接续**:[PR #45 attachments 业务确认稿](批次7_attachments_业务确认稿.md) §三 决议 1 + 决议 2 / [V2 红线 C-6 / Slow-1](V2红线与复活路径.md) / [research §3.11](srvf-foundation-research.md)
> **写作铁律**:本期**不预设答案、不写"推荐"段**;A/B/C/D 候选纯作引导,业务方可全部否决并提"E: 其他"。

> **关键前置(本期已锁,不再问)**:
> 1. **RBAC 模型选型 = 完整 RBAC 三表**(`permissions` + `role_permissions` + `user_roles`)— 沿 [PR #45 业务确认稿 §三 决议 2](批次7_attachments_业务确认稿.md);**本期不再问"用 RBAC 还是扩 Role enum 还是加 deptHead 字段"**
> 2. **沿用现有 `SUPER_ADMIN` / `ADMIN` / `USER` 三层 Role**(系统级身份分层)与 RBAC 业务级权限两层并存 — 沿 PR #45 决议 2
> 3. **C-6 实施前必须走 [ARCHITECTURE.md §9 升级路径](../ARCHITECTURE.md)**(扩 Prisma schema + 新增 `modules/permissions/` + BizCode 段位 `140xx` / `141xx`)
> 4. **不引入运行时缓存基建**(Redis / 队列);RBAC 缓存仅允许**进程内 short TTL**(沿 V1.1 §17.3)

---

## 一、背景与硬边界

### 1.1 这次访谈解决什么

队里管理系统现在只有 `SUPER_ADMIN` / `ADMIN` / `USER` **三层粗粒度角色**,但实际业务中有大量细分场景:

- **谁能终审某类活动?**(APD 部长 / 副部长? 不是所有 ADMIN 都该有此权限)
- **谁能上传 / 查看某类附件?**(本人 / 管理员 / 同队队员?)
- **部门负责人能否只看本部门的业务?**
- **装备管理员能否只管装备相关数据?**
- **培训管理员能否只管培训资料?**
- **运营管理员能否给其他用户分配业务角色?**

这些都需要**业务级权限点**(细粒度) + **角色** + **用户 → 角色映射**,技术上叫 **RBAC(基于角色的访问控制)**,用三张表表达。

但 RBAC 的设计**有几个关键决策必须业务方拍板**,否则模型做出来:

- 过细(权限点 instance 级)→ 冗余 + 维护成本爆炸
- 过粗(权限点仅 action 级)→ 后期遇到细分场景又要返工
- 不带继承 → 配置工作量翻倍
- 切片维度错 → 部门 / 组织业务跑不通

本期访谈帮你把这 13 个决策一次性问清楚,作为后续 D7-RBAC 评审稿的输入。

### 1.2 不在本次访谈范围内的事

| 项 | 留给谁 |
|---|---|
| RBAC 三表 schema 字段集 / 索引 / FK | D7-RBAC 评审稿 |
| 完整权限点穷举(几百条 permissions seed 内容) | D7-RBAC 评审稿 + 上线后运营持续维护 |
| RBAC CRUD API 路径 / DTO / BizCode 详码 | D7-RBAC 评审稿(BizCode 段位 `140xx` / `141xx` 待 baseline 评审) |
| 现有 `users.policy.ts` 何时迁出 / 是否完全废弃 | D7-RBAC 评审稿 |
| 缓存基建(Redis / 失效广播 / 分布式锁) | 不在 RBAC 范围;沿 V1.1 §17.3 锁 |
| 多租户 / 跨组织权限隔离 | RBAC 之外;真出现需求时单独评审 |
| 字典 seed 真实值 / 真实部门名 / 真实业务角色名 | 用户私下提供,不进公共仓库历史(research §5.1 / §7-R13) |
| 现有 v1 14 接口 + V2 79 接口任何字段变更 | A-2 红线;本期 RBAC 设计**完全向后兼容** |

### 1.3 一条事先告知的边界

> **RBAC 模型的关键决策一旦落地,后续所有业务模块的权限设计都受其约束**。
> - 设计粒度**过细**(如 instance 级权限点)→ 后期实施成本爆炸 + 维护工作量惊人
> - 设计粒度**过粗**(如仅 action 级)→ 后期遇到细分场景又要返工
> - **本期 13 题中,问题 3(权限点粒度)/ 问题 5(角色继承)/ 问题 11(与三层 Role 的关系)是项目骨架级决策**,一旦上线后修改成本高

这意味着:**本期所有"AI 默认值"仅供参考,业务方可以并应该按实际业务场景拍板**。

---

## 二、必须确认的 13 个问题

### 问题 1:业务角色清单 — 哪些"业务角色"要进 RBAC 表?

| 候选 | 含义 |
|---|---|
| A | **仅"APD 部长 / 副部长"**(对应 V2 红线 C-6 的唯一明示需求;最小启动集) |
| B | A + 其他**业务管理员类**(装备管理员 / 培训管理员 / 财务管理员 / 资料管理员) |
| C | B + **队员的子分类**(普通队员 / 实习队员 / 后备队员 / 退役队员) |
| D | **全套**(A + B + C + 跨组织角色,如"联合救援队代表"/"友队联络员") |
| E | **其他**(请描述实际需要的角色清单) |

**[当前 AI 参考观察(不替业务方决定)]**:V2 红线 C-6 字面只锁定 APD 部长 / 副部长这一个明示场景。其他角色清单**不在已锁定范围内**。业务方层面只需告知"实际运营中有哪些'我应该能干 X 而不该干 Y'的细分诉求"。**真实角色名不进本提纲**(沿 research §5.1 R13)。

**不确认的影响**:

- 选 A(最小):D7-RBAC 评审稿仅设计 APD 部长 / 副部长两个业务角色 + 对应权限点;后续每加一个角色需独立评审 + seed migration
- 选 B / C / D:D7-RBAC 评审稿需穷举更多权限点;seed 工作量翻倍;但后期免返工
- 不确认 → 评审稿无法收敛初始 seed 范围

---

### 问题 2:角色组合 — 一个用户能否兼任多个业务角色?

| 候选 | 含义 |
|---|---|
| A | **单 RBAC 角色**:一个用户**仅能持有 1 个业务角色**(加现有三层 Role 共 2 个 role 维度) |
| B | **多 RBAC 角色**:一个用户**能持有多个业务角色**(如某 ADMIN 同时是"APD 部长 + 装备管理员") |

**[当前 AI 参考观察]**:救援队场景下,常见**一个人多帽子**(队长兼装备管理员 + APD 副部长)。选 A(单角色)技术上更简单(`user_roles` 表可以退化为 `User.businessRoleId` 字段),但表达力受限。选 B(多角色)是 RBAC 标准做法,与三表设计天然契合。

**不确认的影响**:

- 选 A:某 ADMIN 兼"APD 部长 + 装备管理员"时无法表达,只能选其一或新建"APD 装备管理员"复合角色(角色爆炸)
- 选 B:`user_roles` 真正以多对多表实现;判权时取并集
- 不确认 → 默认选 B(沿 RBAC 标准),但可能与实际诉求不符

---

### 问题 3:**权限点粒度**(项目骨架级)

权限点定义为"允许执行的某个动作"。粒度决定了 `permissions` 表的规模 + 后续判权逻辑复杂度。

| 候选 | 含义 | 权限点示例 | 规模预估 |
|---|---|---|---|
| A | **action 级**(最粗) | `attachment.upload` / `attachment.view` | 20-50 条 |
| B | **resource type 级**(中) | `attachment.upload.cert` / `attachment.view.cert` / `attachment.upload.activity` | 100-200 条 |
| C | **resource instance 级**(最细) | `attachment.view.cert.<certId>` — 针对具体某条 Certificate | 不可枚举(动态) |
| D | **混合**(按业务模块决定:某些 action 级,某些 resource 级) | — | 50-150 条 |

**[当前 AI 参考观察]**:

- **A action 级 太粗** — 无法表达"能上传证件附件但不能上传活动附件"
- **C instance 级 太细** — `permissions` 表无法用静态 seed 表达;判权要每次查具体 instance,性能 + 维护成本爆炸;一般 RBAC 不走 instance 级,instance 级通常用 **ACL(Access Control List)** 或资源所有权字段(沿问题 4)
- **B resource type 级** 是 RBAC 标准做法,与问题 1 / 4 / 8 协同最自然
- **D 混合** 是工程上常见的折中,但要求 D7-RBAC 评审稿对**每个权限点都标明粒度**,评审工作量翻倍

**不确认的影响**:

- 选 A:权限点表小,但很快会出现"细分不出来"的运营吐槽,半年内必返工
- 选 B:权限点表中等,与 attachments 业务确认稿(决议 6 +7)天然契合
- 选 C:几乎不可实施,**强烈不建议**(除非业务方有非常特殊的"某条记录单独配权限"诉求)
- 选 D:灵活但难维护;D7-RBAC 评审稿需为每个权限点定级粒度

---

### 问题 4:资源所有权 — "本人" 的判定方式

很多权限点判定涉及 **"本人 vs 他人"**(如"本人能查看自己证件 + 他人证件需要 ADMIN")。"本人" 的判定方式需要明确:

| 候选 | 含义 |
|---|---|
| A | **`user.id` 匹配** — 看 `User.id == 资源.userId`(或资源.uploadedBy 等) |
| B | **`Member.id` 匹配** — 看登录用户挂载的 `Member.id == 资源.memberId` |
| C | **两者都支持**(混合判定;不同业务表用不同字段) |

**[当前 AI 参考观察]**:

- v1 设计中**用户**(`User`)和**队员**(`Member`)是分离的两张表(沿 §12.8.2 / memberNo 决议),`User` 可以有 `memberId` 可空外键关联到 `Member`
- attachments 业务确认稿(问题 2 字段集)中 `uploadedBy` 字段 D7 决议是 `User.id` 还是 `Member.id`,与本题强相关
- 选 A:`uploadedBy` → `User.id`;但救援队场景下"队员上传"语义上更接近 `Member.id`
- 选 B:`uploadedBy` → `Member.id`;但管理员不一定有 `Member` 记录(`Member` 表当前仅救援队员),管理员上传时需特殊处理
- 选 C:每个业务表自定;但 RBAC 判权逻辑需 case-by-case 写

**不确认的影响**:

- D7-RBAC 评审稿的判权函数(`rbac.can(user, action, resource)`)签名取决于此答案
- attachments / activities / certificates 的 `userId` vs `memberId` 字段全部受其影响

---

### 问题 5:**角色继承**(项目骨架级)

| 候选 | 含义 |
|---|---|
| A | **无继承**:每个角色独立分配权限点;`SUPER_ADMIN` 也要显式分配所有权限 |
| B | **三层 Role 自动继承**:`SUPER_ADMIN` 自动拥有 `ADMIN` 所有权限;`ADMIN` 自动拥有 `USER` 所有权限(沿三层层级) |
| C | **RBAC 业务角色显式继承**:业务角色之间可配置继承关系(如"APD 部长" 继承 "APD 副部长" 所有权限) |
| D | **B + C**(三层 Role 自动继承 + RBAC 业务角色显式继承) |

**[当前 AI 参考观察]**:

- 选 A 看似"最显式 / 最安全",但实际运营中给 SUPER_ADMIN 重复分配 200+ 权限点是工作量灾难
- 选 B 是大多数 RBAC 系统的默认做法(SUPER_ADMIN > ADMIN > USER 的语义自然继承)
- 选 C 在角色繁多时(如 APD 部门内部 3 层 / 装备组 2 层)有用,但增加配置复杂度
- 选 D 兼顾,**但 D7-RBAC 评审稿要明确"继承环路检测"+"继承断链行为"**

**不确认的影响**:

- 选 A:RBAC seed 工作量 = 角色数 × 权限点数(每个角色独立分权限);上线 6-12 个月后角色多了,运营吐槽
- 选 B:SUPER_ADMIN / ADMIN seed 自动化;新增 ADMIN 时不需要重新分配 USER 通用权限
- 选 C / D:复杂度高,但灵活;真实救援队场景未必用得到

---

### 问题 6:权限点分配权 — 谁能修改 `role_permissions` 表(改"某角色拥有哪些权限点")?

| 候选 | 含义 |
|---|---|
| A | **仅 `SUPER_ADMIN`** — 最严,但 SUPER_ADMIN 不在时无法运营 |
| B | **`SUPER_ADMIN` + `ADMIN`** — 折中 |
| C | **专门的"运营管理员"业务角色** — 通过 RBAC 自身解决(`rbac.config.role_permission.update` 权限点配给运营管理员) |

**[当前 AI 参考观察]**:

- 选 A 最严,但 SUPER_ADMIN 是稀缺角色(项目维护者本人 + 1-2 个备份),运营变更频繁时是瓶颈
- 选 B 折中,但所有 ADMIN 都能改 RBAC 配置 → 权限暴政风险(某 ADMIN 自己给自己加权限)
- 选 C 是 RBAC 标准"自描述"模式:RBAC 自身的配置权限也走 RBAC 控制;**但需要小心 bootstrap**(第一次 seed 时谁有权限?默认配给 SUPER_ADMIN)
- 救援队场景**SUPER_ADMIN 通常就是项目维护者** + 队长,平时不在线;**建议 C** 让"运营管理员"角色处理日常配置

**不确认的影响**:

- 选 A:配置变更瓶颈;每次都要找 SUPER_ADMIN
- 选 B:权限暴政风险(需 audit_logs + 双人确认机制弥补)
- 选 C:bootstrap 时需明确"首次 seed 给运营管理员角色配 RBAC 配置权限"

---

### 问题 7:角色分配权 — 谁能修改 `user_roles` 表(给用户分配业务角色)?

| 候选 | 含义 |
|---|---|
| A | **仅 `SUPER_ADMIN`** |
| B | **`SUPER_ADMIN` + `ADMIN`** |
| C | **专门的"运营管理员"业务角色** |
| D | **按角色分级**:SUPER_ADMIN 能分配任何角色;ADMIN 能分配 USER 级角色;某些业务角色(如 APD 部长)能分配下属(APD 副部长) |

**[当前 AI 参考观察]**:

- 与问题 6 平行,但**比问题 6 更高频**(角色分配比权限点分配频繁;新人入队需要分角色)
- 选 D 是大型组织常见做法,但需要"角色层级"配套(选 C 角色继承的延伸)
- 救援队场景,**建议 D**:SUPER_ADMIN 配高敏感角色(部长);ADMIN / 部长配下属角色

**不确认的影响**:与问题 6 类似。

---

### 问题 8:按部门切片(数据范围权限)

| 候选 | 含义 |
|---|---|
| A | **不切片** — 权限是全局的;APD 部长能审**所有** APD 活动,无论哪个组织节点下 |
| B | **按 `Organization` 切片** — APD 部长仅能审**本组织** APD 活动(救援队当前只有 1 个组织,但未来可能多组织) |
| C | **按 `Member` 部门切片** — APD 部长仅能审**本部门成员**的活动 |
| D | **不在 RBAC 内做** — 切片走 Service 层显式判断(沿 v1 / V2 现有 `assertCanXxx` 风格) |

**[当前 AI 参考观察]**:

- 选 A:最简单,救援队当前单组织场景实际等价
- 选 B / C:复杂度高;RBAC 表设计需要扩展(`role_permissions` 表加 `scope_organization_id` / `scope_department_id` 字段),或独立的 `rbac_scopes` 表
- 选 D:RBAC 只做"角色 → 权限点",数据范围另走 Service 层;**与 research §3.11 + 现有 `users.policy.ts` 风格一致**;**AI 倾向 D**(避免 RBAC 表设计复杂化)
- 真出现多组织场景再升级 B 也来得及(B 是 D 的超集)

**不确认的影响**:

- 选 A:多组织时返工
- 选 B / C:实施成本翻倍;RBAC 表 schema 复杂
- 选 D:RBAC 表简单,但需明确"数据范围由 Service 层判 vs RBAC 判"的边界

---

### 问题 9:配置即时生效策略

RBAC 配置改动(如运营给某用户加角色)后,**多久生效**?

| 候选 | 含义 |
|---|---|
| A | **进程内 short TTL 缓存**(如 60 秒 / 5 分钟)+ 自动失效 — 简单稳定,但延迟生效 |
| B | **显式刷新**:运营改完调一个"reload" 接口主动触发进程内缓存失效 — 即时生效,但需运营主动操作 |
| C | **用户重新登录**:改完后,目标用户**下次重新登录**才生效 — 安全但用户体验差 |
| D | **实时无缓存**:每次请求都查库 — 最即时,但 DB 压力翻倍 |

**[当前 AI 参考观察]**:

- 沿 V1.1 §17.3 不引入 Redis;RBAC 缓存只能走进程内
- 选 D 实时无缓存:理论上每次请求查 3 表 join,DB 压力大;但当前 QPS 远未到瓶颈,**短期可接受**
- 选 A short TTL:60 秒延迟对救援队场景可接受;运营改完喝杯水就生效
- 选 B 显式刷新:运营 UI 需配"刷新缓存"按钮;实施成本中等;**用户体验稳定**
- 选 C 重登:用户体验最差(刚加角色不能立即用),不建议

**不确认的影响**:

- 选 A:延迟生效,但实施简单
- 选 B:即时生效 + 进程内分布式失效复杂度(如果未来多实例部署,需广播失效)
- 选 D:DB 压力,但当前规模可接受

---

### 问题 10:上线时初始 seed 范围

C-6 RBAC 模块上线时,**预置哪些权限点 + 角色 + 角色权限映射**?

| 候选 | 含义 |
|---|---|
| A | **最小启动**:仅预置 `SUPER_ADMIN` / `ADMIN` / `USER` 三层 Role 映射到对应 RBAC "系统级角色"(本质是过渡期);业务角色 + 权限点延后到业务模块需要时再加 |
| B | A + 预置 **attachments 业务必需**的所有权限点 + 默认角色权限映射(沿 PR #45 attachments 业务确认稿) |
| C | B + **APD 部长 / 副部长 + 装备管理员等业务角色**(沿问题 1 选 B / C / D 的范围) |
| D | **全套**:B + C + 所有可预见的业务角色(运营管理员 + 部门负责人 + 培训管理员等) |

**[当前 AI 参考观察]**:

- 选 A 最稳:RBAC 表先上线,业务角色 + 权限点上线后由运营在后台增量添加
- 选 B:RBAC 上线即支撑 attachments 实施;C-7 不需要等"再补 RBAC 配置"
- 选 C / D:工作量倍增,但避免"上线后立刻又要加角色"的尴尬
- **真实角色名 / 权限点名不进本提纲**(沿 research §5.1 / §7-R13)

**不确认的影响**:

- 选 A:RBAC 上线后需要业务方逐步在后台添加角色 / 权限点;C-7 attachments 启动时可能需要补 seed
- 选 B / C / D:seed migration 工作量大;但 attachments 启动顺畅

---

### 问题 11:**与现有三层 Role 的关系**(项目骨架级)

`SUPER_ADMIN` / `ADMIN` / `USER` 三层 Role 在 RBAC 落地后**扮演什么角色**?

| 候选 | 含义 |
|---|---|
| A | **三层 Role 仍权威**:三层 Role 决定基础权限;RBAC 表是补充(细化业务权限);Service 层先看 Role 再查 RBAC |
| B | **RBAC 表权威**:三层 Role 退化为"系统级身份标签"(仅 enum,实际权限完全走 RBAC);所有判权都查 RBAC 表 |
| C | **短期 A,长期 B**:过渡方案 — 三层 Role 沿用一段时间,逐步迁移到完全走 RBAC |

**[当前 AI 参考观察]**:

- PR #45 attachments 业务确认稿 §三 决议 2 写"沿用现有三层 Role 不变,作为'**系统级身份分层**';RBAC 三表作为'**业务级权限点**';**两层并存**" — 这是 A 的语义
- 选 B 需要把现有 `users.policy.ts` / `RolesGuard` / `@Roles(...)` 装饰器全部废弃,改走 RBAC — 工作量巨大,且破坏 v1 兼容性(A-2 红线)
- 选 C 是 V2 阶段最务实的方向:**当前 A,未来若 RBAC 成熟则 B** — 但需要明确"过渡何时结束"
- **AI 倾向 A**(沿 PR #45 决议 2)— 三层 Role 是 v1 已交付的契约,不要破坏

**不确认的影响**:

- 选 A:`Role` enum 永远存在,RBAC 是细化补充;现有 `users.policy.ts` 保留,逐步迁出非必需路径
- 选 B:破坏 A-2 红线;v1 14 接口的 `@Roles(...)` 装饰器全部需要重写
- 选 C:需要明确过渡终止条件;过渡期内双重判权可能引发语义冲突

---

### 问题 12:RBAC 配置变更 `audit_logs`

`permissions` / `role_permissions` / `user_roles` 三表的增删改,**是否进 audit_logs**?

| 候选 | 含义 |
|---|---|
| A | **全部记录**:三表增删改全部走 `AuditLogsService.log()` 同事务落库(沿 V2 audit_logs 范式 + A-17 红线) |
| B | **仅记录 user_roles**:给用户分配角色 / 撤销角色这一动作最关键(谁动了某用户的权限);`permissions` / `role_permissions` 不记 |
| C | **不记录**:沿 V2 阶段 Q1=A 决议(read 类不记;但 RBAC 配置变更是 write 类,Q1=A 不适用) |

**[当前 AI 参考观察]**:

- 选 A 最完整,与 audit_logs 第二波写迁移范式一致(沿 PR #34 - #41)
- 选 B 折中,但 `permissions` / `role_permissions` 变更也可能导致权限暴政(运营给某角色偷偷加权限),不记则审计盲区
- 选 C 与 audit_logs 现有方向冲突(write 类一律记录)
- **AI 倾向 A**(完整记录;沿 audit_logs 第二波范式;`AuditLogEvent` union 新增 9 项:`rbac.{permission, role-permission, user-role}.{create, update, delete}`)

**不确认的影响**:

- 选 A:实施时 RBAC CRUD API 全部 wrap `AuditLogsService.log({ tx })`;增加 e2e 覆盖
- 选 B:审计盲区(运营改 `role_permissions` 不留痕)
- 选 C:与 audit_logs 现有"write 类必记"方向冲突,需要专项说明

---

### 问题 13:用户失效场景下 RBAC 角色处理

用户被 disable / soft-delete / 关联 Member 离队时,其 `user_roles` 记录如何处理?

| 候选 | 含义 |
|---|---|
| A | **用户 disable 时 user_roles 不动** — disable 后用户登录失败,RBAC 自然失效(沿 v1 软禁用模式) |
| B | **用户 soft-delete 时 user_roles 联级 soft-delete**(`user_roles.deletedAt` 同步设置) |
| C | **A + B + Member 离队时关联 user_roles 触发清理**(Member 软删 → 关联 User → user_roles 软删) |

**[当前 AI 参考观察]**:

- 沿 v1 软删除模式(`User.deletedAt`)+ Member 软删模式(`Member.deletedAt`)
- 选 A:简单稳定;disable 用户 RBAC 配置原样保留,reactivate 时立即恢复
- 选 B:与 v1 软删除一致;但需要 RBAC 查询时跳过 `user_roles.deletedAt != null`
- 选 C:严格"清理"语义;但救援队场景"队员暂时离队后回归"是常见场景,触发 user_roles 清理后再加回不优雅

**不确认的影响**:

- 选 A:disable + reactivate 体验最好
- 选 C:严格但不优雅;救援队"回归队员"场景体验差

---

## 三、访谈完成后的下一步

业务方回答上述 13 个问题后:

1. 答案落回 **`docs/批次8_RBAC_业务确认稿.md`**(新建,沿 [`docs/批次6_audit_logs_业务确认稿.md`](批次6_audit_logs_业务确认稿.md) + [`docs/批次7_attachments_业务确认稿.md`](批次7_attachments_业务确认稿.md) 风格)
2. **业务确认稿 + research 已锁定项** → 输入到 **D7-RBAC 评审稿**
3. **D7-RBAC 评审稿**覆盖:
   - `permissions` / `role_permissions` / `user_roles` 三表 Prisma schema + 索引 + FK
   - 权限点穷举(首批 seed 范围内的全部权限点)
   - RBAC CRUD API 路径 + DTO + BizCode 段位 `140xx` / `141xx`(待 baseline §1.1 评审)
   - `rbac.can(user, action, resource)` 判权函数签名 + 实现策略
   - 与 `users.policy.ts` 共存方案(过渡期 vs 完全替代)
   - 缓存策略具体实现(进程内 short TTL / 显式刷新)
   - audit_logs 集成(沿问题 12 决议)
   - 初始 seed migration(沿问题 10 决议)
4. **D7-RBAC 评审通过 → C-6 RBAC 批次正式立项**
5. 实施按 v0.7.0 / v0.8.0 audit_logs 范式渐进推进(单模块独立 PR + 单 docs 收口 PR)
6. **C-6 上线后** → **C-7 attachments D7 评审稿启动**(沿 PR #45 决议 1 启动顺序)

---

## 四、本期访谈不涉及的内容(避免越界,重申)

| 项 | 留给谁 |
|---|---|
| 三表 schema 详码(字段集 / 索引 / FK) | D7-RBAC 评审稿 |
| 权限点穷举具体名称 | D7-RBAC 评审稿 + 运营持续维护 |
| RBAC CRUD API 路径 / DTO / BizCode 详码 | D7-RBAC 评审稿 |
| 真实角色名 / 部门名 / 字典 seed | 用户私下提供(research §5.1 / §7-R13) |
| 多租户 / 跨组织 / 多语言 | RBAC 之外;真出现需求时单独评审 |
| 缓存基建(Redis / 失效广播) | V1.1 §17.3 锁;C-6 内**不解锁** |
| v1 14 接口 + V2 79 接口任何字段变更 | A-2 红线 |
| C-7 attachments 实施(D7 + 代码) | C-6 落地后启动(沿 PR #45 决议 1) |
| Provider 选型评估 | 独立评审稿(与 C-7 实施同期) |

---

## 五、参考引用

### 主要引用

- [docs/批次7_attachments_业务确认稿.md](批次7_attachments_业务确认稿.md):RBAC 模型选型决议来源(§三 决议 1 + 决议 2)
- [docs/批次7_attachments_业务访谈提纲.md](批次7_attachments_业务访谈提纲.md):访谈提纲风格参照
- [docs/批次6_audit_logs_业务确认稿.md](批次6_audit_logs_业务确认稿.md):D6 业务确认稿风格参照(用于本提纲落地后的下一步)
- [docs/srvf-foundation-research.md §3.11](srvf-foundation-research.md):权限模型升级 [暂不做] 段头(C-6 解锁的源头)

### 红线 / 复活路径

- [docs/V2红线与复活路径.md](V2红线与复活路径.md) **A-4**:不扩 Role enum / 不引入 RBAC(本期通过 §9 升级路径解锁)
- [docs/V2红线与复活路径.md](V2红线与复活路径.md) **C-6 / Slow-1**:APD 部长 / 副部长权限细分(本提纲启动)

### 阶段交接 / 当前状态

- [docs/handoff/v0.8.0.md §5.3 Slow-1](handoff/v0.8.0.md):RBAC 模型评审硬前置 → 本提纲启动

### 基线 / 段位锁定

- [docs/srvf-foundation-baseline.md §1.1](srvf-foundation-baseline.md):BizCode 段位预估 `140xx` / `141xx`(待 baseline 评审)

### 升级路径 / 架构

- [ARCHITECTURE.md §9](../ARCHITECTURE.md):升级路径(RBAC 解锁前置)
- [ARCHITECTURE.md §7.11](../ARCHITECTURE.md):三层 Role 不是 RBAC 的声明(本期解锁 RBAC 不破坏此声明,而是在三层 Role 之上叠加)
- [ARCHITECTURE.md §12.11.2](../ARCHITECTURE.md):V2.x 复活路径

### 写作铁律

- [CLAUDE.md §18](../CLAUDE.md):V2 调研期约束(§18.2 表达级禁止 + §18.3 四档标签 + §18.4 协作纪律)
- [docs/srvf-foundation-baseline.md §14.4](srvf-foundation-baseline.md):规范冲突优先级

---

## 六、撰写元信息

- **状态标签**:草稿 v0.1;**[待调研]** 阶段(访谈前置提纲)
- **批次号**:批次 8 暂定;正式编号以 D7-RBAC 评审通过 + V2.x 立项 commit 为准
- **下一步**:用户拿提纲与业务方对齐 → 答案落回新建《批次8_RBAC_业务确认稿.md》→ D7-RBAC 评审稿启动
- **覆盖的红线 / baseline**:
  - V2 §18.2 不写最终 schema / V2 §18.3 四档标签
  - V2 §18.5 工具链约束(本提纲在 ARCHITECTURE.md §9 升级路径 / 权限模型升级 / 项目骨架级动作前,用 Plan 模式 / 维护者拍板触发)
  - PR #45 业务确认稿 §三 决议 1 / 决议 2 锁定的 RBAC 模型前置
  - baseline §1.1 段位预留(`140xx` / `141xx` 待 baseline 评审追加)
- **不在本期范围**:见 §四
- **撰写者签名**:Claude Code(基于 PR #45 决议 1 / 决议 2 + V2 红线 C-6 + research §3.11;**未动任何代码 / schema / migration**)
- **commit 风格(若维护者决定提 PR)**:`docs(v2-design): 批次8 RBAC 业务访谈提纲 v0.1`(沿 V2 §18.5 风格)
