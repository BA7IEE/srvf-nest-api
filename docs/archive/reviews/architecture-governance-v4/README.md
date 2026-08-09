# SRVF 终局架构 + 渐进治理 · v4 最终执行版（冻结）

> **状态**：v4 = 架构总方案冻结版。本版消除 v3 遗留的实施歧义后**停止迭代**（无 v5）；下一步唯一动作 = 依本文起草 Phase 0 goal。**Phase 0 不执行 Phase 1、不修改任何 `src` 业务代码。**
> **演进**：v1 全量第一手取证 → v2 六点外部评审修订 → v3 三点执行细节核修 → **v4 十点收口**（两类检查分离 / 大域拆分表述修正 / Exit Criteria 化 / 权限测试分类 / R8 能力边界 / 健康基线定形 / 1J 硬门 / 债务身份证 / 登记表版本管理 / Gate 分层与 AI 错误反馈）。
> **取证口径**：关键结论均为第一手验证（亲读 guard/service/resolver/controller 源码；解析 openapi.json 全部 498 operation；扫描 1,658 个 Prisma 访问点、2,040 条跨模块 import → 166 条依赖边；逐个核验 11 个 admin `[auth]` 端点）。
> **v4 勘误（2026-08-09 并入，不构成 v5）**：① 登记表溯源改确定性 `inputDigest`（派生生成物不得含时间戳/git SHA，否则字节比对新鲜度恒假红且自引用；观测型记录豁免）；② 债务棘轮语义精确化：**禁新增代码债**，扫描能力提升后新发现的存量历史债经审核可登记入册；③ R8 检测对象升级为**已登记授权断言模式清单**（与 ALS 打标点共用单源），未命中模式=进 T3；④ 宪法 C7 明确两段式：Outbox Intent 同业务事务、真实外部 Effect 恒在事务外。
> **v4 勘误批次二（2026-08-09 并入）**：⑤ 新增 **R14 授权语义 diff**（保护等级降级须显式授权，不得作为普通 manifest 更新通过）；⑥ R7 过渡期真相源管线定死（classification registry → 生成 → 装饰器接管 → registry 退役），防两份真相；⑦ authz 注册制接线点死（composition root / 稳定 token 自注册，platform-access 不 import 业务）；⑧ 业务→platform 限公开 surface，禁 deep import；⑨ 跨域写出口补事务语义（同事务走 `*InTx(tx)`，禁嵌套自开事务）；⑩ kernel 读集机器化为 `kernelReadFields` 字段清单（无 select 全行读=主泄露通道）；⑪ 债务身份证补 `violationFingerprint` 稳定指纹（file:line 降为定位提示）；⑫ 状态实体加 `governanceStatus: inventory|governed`，宪法 C6 只约束 governed；⑬ C7 适用范围（durable effect vs 同步集成）留待 Phase 0 外部 I/O 盘点后拍板。
> **v4 勘误批次三（2026-08-09 并入）**：⑭ 规则计数订正为 **14 条**；⑮ Gate L4 层补接 R14；⑯ `@AuthzChainVerified` 防逃生门三重约束（仅限真 T3／新增须 fragment+拍板／结构化字段强制）；⑰ R14 权限**升级**由"静默放行"改为"**放行但恒可见**"（升级同样改变前端可见行为）；⑱ **换码不自动定强弱**——权限码无全序，A→B 恒按语义变更需显式确认；⑲ 债务指纹碰撞登记为 Phase 0 实现事项（occurrenceIndex／同指纹计数增减判据）。
> **v4 勘误批次四（2026-08-09 并入）**：⑳ 权限声明由扁平五态升级为「五态主模式 + 结构化条目」（admission 正交轴／codes require all|any／scopeKind／engine），R14 降级闭集随之扩展；㉑ 敏感授权事件（降级/换码/T3 标注）的人工批准**机器化**——复用红区 base-trusted + GitHub Environment 审批模式，**自写 fragment 不构成批准**；㉒ Phase 0 A 类翻闸定死 bootstrap 顺序（非阻断落地→true-up→在既有 required job 内翻步骤，不新增 required context）；㉓ 债务加 `shapeDigest` 第二判据防偷梁换柱（身份恒稳，实质漂移=受控事件）；㉔ **auth 域归属修正**：platform-core → identity-org.accounts（依赖邻域实测恰为 {auth, users, members}；原归属未验证即写入，属前三批事实错误，留痕）。
> **v4 勘误批次五（2026-08-09 并入）**：㉕ **修正 R14 码集增减逻辑错误**——降级判定必须按 `require` 语义分派（`any` 集**增码=降级**，与 `all` 集方向相反）；㉖ 动作族线性排序改为**权限蕴含图**（DAG 可达性判强弱，无路径=不可比=保守，另与 seed 绑定矩阵做一致性核对）；㉗ `scopeKind` 单值改 `scopes[]` 可组合、且 scope 可绑定到具体 code（meta 四码四 scope 实证）；㉘ `@AuthzChainVerified` 出口表述内部矛盾修正——标注是**唯一端点级出口**（结构化对象签名），known-gap 是检测器自述不是端点豁免通道；㉙ kernelReadFields 补 relation 规则（裸 include=全行读等价违规；嵌套 select 同白名单；`omit` 不构成合规出口）。
> **v4 勘误批次六 + 终审实施约束（2026-08-09 并入）**：㉚ 图 2 同步 auth 归属修正；㉛ A 类 blocking 表述统一为「目标级 blocking，首轮 bootstrap 按㉒先 report 再翻闸」；㉜ R7 更名 **Route Authorization Policy**（五态仅存为 mode 主分类，classification overlay 必须承载 admission/codes/require/scopes/engine 全结构）；㉝ §14 第 10 项过期替换（改问 authz-review 审批人范围/最少人数/紧急 bypass）；㉞ **R11 与 R14 同安全原则**——breaking 须 Environment 人工审批，fragment 仅申报不构成批准，"内置回滚"表述删除（真回滚=revert/feature gate/兼容层）；㉟ T3 标注加 **verification freshness**（reviewId+evidenceDigest，授权链输入一变即 stale 重审）。终审约束：【七】`src/common` 纳入治理（新增 R15，规则数 **15**）；【八】Schema Change Ownership（R4 扩展，硬闸沿既有 prisma 红区）；【九】债务终局身份=call-site 结构身份（count 永不作身份）；【十】kernelPredicateFields（不返回≠可作谓词）；【十一】R14 比较器四态输出（证明不了恒 INCOMPARABLE→审查；DAG 是规范源，seed 仅 sanity check）；【十二】测试特权边界（journeys 禁 prisma 直用）。
> **v4 勘误批次七（终审扫尾八条，2026-08-09 并入）**：Phase 5 验收改 Environment 审批（不再"有 fragment 就行"）；全文清残留"五态定性/五态 ROUTE_AUTHZ/即时 blocking"表述；Gate L2 补接 R15；**Route Authorization Policy 定义唯一 canonical semantics**（各轴恒 AND，manifest JSON 为 canonical form，Guard/R8/R14/ALS 共用单一 normalizer）；**R8 升级为逐轴验证完整结构化 Policy**（不是命中任意判权模式即过，任一轴不可判整端点进 T3）；**R14 `engine` 变化恒 INCOMPARABLE**；债务 schema 正式加入 `callSiteId`/`occurrenceIndex` 字段。**同日补两条**：R8 `require:any` 必须验证**全部**合法 OR 分支（防死声明与隐藏路径，证明不了整端点进 T3）；§8 身份三层分工统一定义（`callSiteId`=最终身份 / `violationFingerprint`=归类关联 / `shapeDigest`=漂移检测）。

| 输出要求(1-18) | 章节 |
|---|---|
| 1 审计结论 | §1 |
| 2 终局领域架构 | §2 |
| 3 领域/数据/谓词所有权 | §3 |
| 4 依赖规则 | §4 |
| 5 权限 fail-closed 架构 | §5 |
| 6 治理规则最终版 | §6 |
| 7 Exit Criteria | §7 |
| 8 债务数据结构 | §8 |
| 9-10 迁移路线 / Phase 0 交付物 | §11 / §12 |
| 11 1J 与 enforce 硬门 | §11（Phase 1D） |
| 12-13 Gate 结构 / 错误反馈设计 | §10 |
| 14-16 三张图 | §13 |
| 17 拍板事项 | §14 |
| 18 不做什么 | §15 |
| Constitution | §16 |
| 登记表版本管理 | §9 |

---

## §1 当前真实架构审计结论

**规模**：37 模块 / 94 controller / 498 端点（契约精确锁，`openapi.contract-spec.ts:1615`）/ 109 model / 81 migration / 234 权限码 / 424 BizCode / 265 e2e + 195 unit + 1 contract spec / src 非测试 ~14.8 万行；近 30 天 409 commits——一年内 700~1000 端点是基准情形。

**依赖**：166 条模块依赖边。合理枢纽：permissions（33 个依赖方，`rbac.can` API）、audit-logs（29，`AuditLogsService`，跨模块直写 `auditLog` 表实测 = 0）。15 对双向依赖中 9 对属两个真实业务簇（身份五模块、参与链三模块）——模块线错、域线对。危险项：authz 反向内嵌 14 类业务归属查询（`resource-resolver.service.ts:25-26`，域知识第二副本）；隐性内核四件住在业务模块私有目录（`app-identity.resolver.ts` 被 42 文件引用、`member-lifecycle-lock.ts`、`membership-term-state-machine.ts`、`wecom-identity-revoke.ts`）。现行 lint 明文允许跨模块引 service（`eslint.harness.mjs:455`）；无依赖图执法、无环检测。

**数据**：表所有权无定义。`member` 被 21 模块读/仅 3 模块写；68 处跨属主写分四类——W1 域内错切（≈12，结算三 service 在 activities 写考勤表等）；W2 身份生命周期编排（≈45，目标域内合法；**真跨域写实锤：`recruitment-promotion.service.ts:729` 直写 `Certificate`**）；W3 业务→平台授权投影（4，`grant-projector.ts:37/97` 直写 `roleBinding`）；W4 提醒记账列错位（5，`expiry-reminder.service.ts:109/167/243/308/356`）。仓内已有正确范式：属主 tx 原语（`revokeActiveWecomIdentityInTx`）、共享谓词单源（`role-binding-validity.ts`）。

**权限**：链 = `Throttler → JwtAuthGuard(@Public 跳) → RolesGuard`（`app.module.ts:215-217`）；`RolesGuard` 无 `@Roles` 即放行（`roles.guard.ts:29`）且活跃 `@Roles`=0；判权 100% service 层（188+43 处）。**无 deny-by-default。** 声明分布：public 33 / rbac 337 / `[auth]` 128（admin 11、app 109、auth 6、system 2）/ 无声明 0。证据分层：admin 11 逐个核验 = 0 裸奔、≥2 处**声明失真**（标 `[auth]` 实调 `authz.explain`+双码，`activity-participation-query.service.ts:39-41`）、3 处刻意无码化（Q-A7）；auth/system 8 个语义核验；**app 109 仅模块级证据+抽样，未逐个定性——全局结论待 Phase 0 全量定性**。CI 的 G 检查只验 summary 后缀存在、自述不解析调用链（`check-rbac-map.ts:29-31`）。新增权限码手抄 6~7 处。

**状态机**：8 个手写机 / ~5 种形状 / 零共享抽象；结算账本子域无状态机（44 处裸 `statusCode !==` 在 activities+attendances）；状态闭集 DB CHECK 仅 9 个 migration 文件（全为 2026-08 新表）；`action-state-checks.ts` 已注册 3/8（注册表原型）。

**契约/测试/CI**：强项——字节零漂移+精确 498+ask 门快照+21 条 lint+3 棘轮基线+replay 18/6+红区 58 globs+hooks fail-closed（本会话实测三连拦）。缺口——无破坏性分级；前端零 codegen；`docs:openapi:check` 不在本地管线；**跨域旅程 e2e=0**（招新↔活动零交叉实测）；测试纪律无机器守护。

**Top 5 危险债**：① 权限声明↔实现零闭环+无 fail-closed；② 表所有权未定义（真跨域写与无害错切机器不可分）；③ authz 归属第二副本；④ 旅程零测试；⑤ activities 3.5 万行平铺+11 个千行 service（AI 理解面超限）。

---

## §2 终局领域架构

划分方法：事务边界 + 数据簇 + 已实证强连通团，不按美学。耦合证据只证明"今天拆不开"，不证明"概念上是一个"——大簇定为**治理大域（暂定）+ 观察子域**。

| 域 | 模块 | 拥有数据（代表） | 对外能力 |
|---|---|---|---|
| **platform-core** | storage, attachments, attachment-configs, dictionaries, meta, health, audit-logs | StorageObject*, Attachment*, Dict*, AuditLog | 存储/附件/字典/审计写入 API（勘误㉔：auth 已移出至 identity-org.accounts；JWT guard/throttler 本就在 `common/`，不受影响） |
| **platform-access**（权限系统属地） | authz, permissions, role-bindings | Role/Permission/RolePermission, RbacRole, RoleBinding, ActionConstraint | `rbac.can`/`authz.can/explain`、scope 展开；资源归属由各域注册（§4） |
| **comms** | notifications, sms, wechat(通道), wecom(通道), announcement-import | Notification*, OutboxIntent, SmsSendLog, 模板/quota | 四渠道+outbox；只读业务表、禁写（W4 迁移或持债务身份证） |
| **identity-org**（治理大域·暂定；观察子域 accounts / people / structure） | accounts：**auth（勘误㉔）**、users、身份绑定表；people：members, member-profiles, emergency-contacts, realname；structure：organizations, member-departments, positions, position-assignments, supervision-assignments | User, Member, MemberProfile, **RefreshToken, PasswordResetToken**, Organization(+Closure), Membership, Position*, EmergencyContact | 登录/会话/step-up；身份/组织/任职查询；MemberOnboarding 建号原语；生命周期锁；kernel 读集；共享谓词导出 |
| **engagement** | recruitment, team-join | Recruitment*, TeamJoin* | 招募/入队；promote 调 identity-org 与 credentials 原语 |
| **participation**（治理大域·暂定；观察子域 lifecycle / registration / attendance / settlement-ledger） | activities；activity-registrations；attendances, activity-feedbacks；结算账本全套+contribution-rules | 活动/报名/考勤/结算/贡献值账本 | 活动全生命周期；账本读接口 |
| **insurance** | insurances | MemberInsurance, TeamInsurance*, EligibilityEvidence | 资格证据生产 |
| **credentials** | certificates | Certificate, CertificateStandard, RecognitionPolicy/Issuer | 证书录入/认定/发号原语 |
| **content** | content | Content* | CMS |
| （预留） | missions / logistics / training / finance | — | 新域平铺加行 |

**治理大域子域升格原则（v4 修正表述）**：子域未来升格为独立 Domain 时——**不要求物理搬目录**；但若仍存在跨子域直接写表、私有 service 调用、内部实现互引，**必须先收口**，收口方式优先为 public API / Query API / tx 原语 / owner 谓词；满足领域边界判据后**再**调整 domain-map；是否移动物理目录**单独判断**。即：**逻辑边界变化 ≠ 必须搬代码，但也不保证只改配置。** 观察子域间的写路径/私有调用自 Phase 2 起进 report，为升格决策积累数据。

**auth 归属修正的证据（勘误㉔，第一手复核）**：`auth-session-lock` 被 auth×4 文件 / users×3 / members×1 共享；`RefreshToken` 全部读写方 = auth(14 处) + users(10) + members(3)，**无第四个模块触碰**；auth 模块的 import 方只有 users 与 members；auth 直写 `User`×3、`WecomIdentity`×2。即 auth 的整个依赖邻域恰好 = {auth, users, members}——它属于 identity-org.accounts，不是底层平台件。移入后 auth→User 写、users/members→RefreshToken 撤销、session-lock 共享全部变为域内合法，platform 层不再有任何写业务表的成员。此归属仍列 §14 拍板确认；原 platform-core 归属系未验证即写入，属前三批事实错误，特此留痕。

---

## §3 所有权三层

1. **域所有权**：每个模块唯一归属一个域（`harness/domain-map.json`）。
2. **数据所有权**：每个 Prisma model 唯一属主域；核心对象归属——Org/Member→identity-org；Recruitment→engagement；Activity/Attendance/贡献值账本→participation；Certificate→credentials；Insurance→insurance；权限引擎+码表+RoleBinding→platform-access（业务投影写入走 role-bindings 导出原语）。
3. **谓词所有权**：所有权的单位不只是表，是**不变量与谓词**。任何域的业务谓词（有效任期/正式队员/当前 PRIMARY/资格判定…）只允许一份实现、由属主导出；抄第二份即越界。仓内先例：`role-binding-validity.ts`、`membership-term-state-machine.effectiveWhere()`、`isFormalMemberGradeCode()`。

**kernel 读集（机器化，勘误⑩）**：不写"安全列"散文——domain-map 以 `kernelReadFields` 明确到字段（如 `Member: [id, memberNo, displayName, status, gradeCode…]` / `User: [id, username, nickname, status…]` / `Organization: [id, name, status…]`，字段清单逐字段归维护者拍板）。跨域 kernel 读**必须显式 `select` 且 ⊆ kernelReadFields**——主泄露通道是**无 select 的全行读**（`findUnique({where})` 默认返回含 phone/PII 的整行），不只是多选字段；动态/spread select 进 known gaps。**relation 通道同规（勘误㉙）**：`include: { member: true }` 这类**裸 include 经关系拉全行**，与无 select 直读等价、同样违规；跨域关系上的嵌套 `select` 同受 kernelReadFields 白名单约束（多级嵌套逐级适用）；`omit` **不构成合规出口**——黑名单在模型新增列时静默泄露，结构不免疫，白名单语义恒 select-based。**谓词侧同治（终审【十】）**：区分 `kernelSelectFields`（可返回）与 `kernelPredicateFields`（可入 where/orderBy/distinct/cursor，通常更窄）——`where:{phone:…}, select:{id:true}` 不返回手机号但用它做了存在性探针，**"不返回"≠"可作谓词"**；业务语义条件恒归 owner predicate。kernel 四件原语（app-identity.resolver / member-lifecycle-lock / membership-term-state-machine / wecom-identity-revoke）在 domain-map 显式声明。

---

## §4 依赖规则（四通道，不一刀切）

| 通道 | 规则 |
|---|---|
| Service / tx 原语调用 | 业务域→platform **仅限公开 surface**（勘误⑧：导出 service/module/types/constants/具名原语——既有 lint 公开面惯例的延伸；禁 deep import platform 内部 provider/私有 helper；domain-map 可按模块以 `publicSurface` 增补声明，如 tx 原语文件）；业务域↔业务域仅沿声明边（engagement→identity-org、engagement→credentials、participation→insurance、participation→identity-org、team-join→participation 账本读、content→attachments）；platform→业务域禁止——authz 例外走**注册制**，接线点死（勘误⑦）：**platform-access 不得 import 任何业务 module/文件**；唯二合法接线 = ① composition root（`app.module.ts`/专用 wiring module，红区）以动态模块装配各域 resolver；② 各域模块经 platform-access 导出的稳定 token/注册 API **自注册**（业务→platform 方向，合法）。R2 扫描器守：platform-access 的业务入边恒 0，composition root 是唯一豁免点 |
| 跨域 DB 读（三档） | ① kernel 事实读：放行；② 跨域事实读（按 id 取行/读 schema 可见事实）：allowlist 登记；③ **业务语义查询：必须消费属主导出谓词**（长期 report 级监督，见 §6 R6） |
| 跨域 DB 写 | **默认禁止**；唯二出口带**事务语义**（勘误⑨）：需与调用方业务写**同一 PG 事务原子提交**（锁/CAS/账本一致性场景）→ 必走属主导出 `*InTx(tx: Prisma.TransactionClient)` 原语（原语内**禁自开事务**、锁需求须头注声明；仓内标准型=`revokeActiveWecomIdentityInTx`）；不要求同事务 → 走属主 service 公开 API（自管事务）。**反模式点名**：在已有 transaction 内调用会自开事务的跨域写方法 = 破坏原子性与锁序，R5 扫描器加启发式检测+阳性对照。存量入债务身份证（§8）按代码债棘轮裁决 |
| `$queryRaw`/`$executeRaw` | 独立通道治理：SQL 字面量含他域物理表名（表名集从 schema `@@map` 派生）即违规候选——delegate 级 AST 对裸 SQL 是盲的，本仓大量裸 SQL 做锁与探针，此通道必须纳入才有资格谈 blocking |

---

## §5 权限 fail-closed 架构

### 5.1 两条阻断线 + 一条检测线

**阻断线 1 · 声明存在性 Guard（deny-by-default，pre-handler）**：装饰器族 `@Public()`（已有）/ `@LoginOnly()` / `@LoginScoped('<规则名>')` / `@ResponsibilityScoped()` / `@RequiresPermission('<code>'…)` —— 只做元数据声明不判定（判定单轨 service 层）。`AuthzDeclarationGuard` 全局注册：路由无任何声明 → `AUTHZ_UNDECLARED` 拒绝，在 handler 前、任何副作用前拦截。⚠️ 触碰 D7 v0.2 决策锁（"不做 Guard 装饰器"），须拍板（§14）。

**声明结构化（勘误⑳）**：五态是 R14 词汇层的**主模式**，但 manifest 条目不是扁平枚举而是**结构体**——现网已实证扁平五态装不下：reconciliation/participation-summary 同时要求两个读码（AND）、meta 面板聚合四个 scope、App 面 109 端点全部先过 D-5 准入再叠其他模式。条目结构：`{ admission?: 'app-member'（正交轴，App 面恒有）; mode: 五态之一; codes?: [{code, scope?}…], require: all|any; scopes?: [self | visibility:<规则名> | responsibility | org-scope]（勘误㉗：可组合数组，组合语义默认 all；scope 可绑定到具体 code——meta 面板四码四 scope 是现网实证）; engine?: rbac-global | authz-scoped }`；装饰器可组合表达。**R14 降级闭集随之扩展**：去除 admission 轴、`require: all→any`、scope 集缩减，均按降级处理；码集增减的方向判定按 `require` 语义分派（勘误㉕，见 R14 行）。

**canonical semantics（勘误批次七·唯一语义源）**：结构化 Policy 的判定语义只有一份定义——**各轴恒 AND 组合**：`admission(若声明) ∧ mode 基线 ∧ codes 判定（按 require 语义；code-bound scope 并入该码判定）∧ scopes 判定（端点级，组合默认 all）`，`engine` 指定 codes/scopes 的判定引擎。**manifest JSON 是 canonical form**：装饰器只是表面语法，必须 1:1 归一化到 canonical form；Guard、R8 静态验证、R14 比较器、ALS 全部消费**同一个 normalizer 的输出**（单一解析实现，与"断言模式清单与 ALS 共用单源"同一哲学）——禁止任何消费者自带第二套组合语义解释。

**阻断线 2 · 构建期闭环（typed AST + selftest）**：见 5.2 R8 能力边界。

**检测线 · ALS（observe/alert only，不是安全边界）**：request 上下文记录实际判权断言（`rbac.can` 记码 / `authz.can|explain` 记码+ref / `AppIdentityResolver.resolve` 记准入），响应前与声明比对，不一致**只告警不拒绝**——事务由 service 持有（architecture-boundary §4），后置拒绝阻止不了已提交副作用且会对已提交写谎报失败；HTTP 动词非副作用可靠代理（反例：content 详情 GET 自增 viewCount）。ALS 价值：抓「声明了但没执行」的生产实况、覆盖 R8 不可静态判定层；告警入日志可见渠道 + 周度 true-up，出现即当天修。

### 5.2 R8「声明↔实现闭环」的能力边界（v4 明确，不做假形式化证明）

**检测对象（v4 勘误③升级）**：不是"存在 `.can(` 调用"，而是**已登记授权断言模式**——清单落 `harness/authz-assertion-patterns`，每个模式 = 调用形态 + **后果分支**（返回值必须进入 throw / 早退 / 过滤下推，裸调用不构成断言）。起步模式族（全部有仓内实证）：`rbac.can`+throw/guard、`authz.can/explain`+deny→BizCode 映射、`getVisibleOrganizationScope` 下推过滤（list 面）、`AppIdentityResolver.resolve`+准入分支、responsibility 检查族。**验证对象 = 完整结构化 Policy 的逐轴闭环（勘误批次七），不是命中任意一类判权模式即过**：admission 轴→resolver 准入模式；每个声明 code→对应判权模式且字面码匹配（`require:all` 逐码核验——声明 [a,b] 只断言了 a 必须红；`require:any` **必须验证全部合法 OR 分支**——每个声明码都要有静态可证的对应判定分支，只命中一个 = 其余码沦为死声明或实现藏有未声明路径，两者都使 manifest 失真、并让 R14 的 any-集比较建立在虚假码集上；**OR 结构完整性证明不了 → 整端点进 T3**）；每个 scope→对应 scope 模式（code-bound scope 随该码核）；engine 匹配（声明 authz-scoped 须见 `authz.can/explain`，纯 GLOBAL `rbac.can` 不算数）。**任一轴不可判 = 整端点进 T3**。该模式清单与 **ALS 打标点共用同一单源**——"什么算判过权"只许有一份定义，防静态检测与运行时观测长出两套语义。selftest 每模式一正一负样例（负样例 = 调用无后果分支）。

| 层 | 形态 | 静态可判性 | 处置 |
|---|---|---|---|
| T1 | handler 方法体内命中已登记断言模式（字面码 + 后果分支） | 可靠 | **blocking** |
| T2 | 一层 helper：handler→同模块 service 公开方法内命中已登记模式（解析深度 ≤2、同模块内） | 可靠（受控范围成文） | **blocking** |
| T3 | 多层 service 链 / 跨模块委托 / wrapper / interface·DI / 条件分支 / 动态码（`can(codeVar)`）/ **未命中任何已登记断言模式** | 不可靠 | **不宣称证明**。**唯一端点级出口 = 显式标注** `@AuthzChainVerified({reason, verifiedBy, date, reviewId, evidence:{files, symbols}, evidenceDigest})`（勘误㉘㉟：结构化对象签名+新鲜度绑定，与⑯三重约束一致；进 ROUTE_AUTHZ manifest 成为具名审计对象，新增/修改走 ㉑ Environment 审批）。ALS 生产观测 = 兜底监测，**不是出口**；known-gap 清单 = **检测器能力边界的自述**（属扫描器文档），**不是端点豁免通道**。**T3 无标注 → lint 红**（强制显式化，把"假证明"换成"诚实声明"） |

**目标是降低漏判权风险，不是构建形式化证明系统。**

**`@AuthzChainVerified` 防逃生门三重约束（勘误⑯）**：① **仅限真 T3**——若 handler 静态可判（能命中已登记断言模式），lint **禁止**使用该标注（可判定却贴标注=红，堵"用标注逃避静态检查"这条路）；② **新增/修改标注是受控事件**——须 `authz-chain-manual:` fragment（记录载体）并过勘误㉑的 Environment 审批（自写 fragment 不构成批准），与 R14 降级同级对待，不得随普通改动静默混入；③ **标注必须携带结构化字段**（reason / verifiedBy / date / 证据指向〔spec 名或核验说明〕），空洞标注 lint 红；④ **verification freshness（勘误㉟）**——标注绑定 `reviewId + evidence:{files, symbols} + evidenceDigest`（对声明证据集内容的归一化摘要），检查器复算 digest：**授权链输入一变，旧核验即 stale → lint 红 → 重走 Environment 审批**（宁可过敏勿失敏：证据文件任何改动都触发复审），杜绝"下游 Service B 改了、Controller 标注还永久有效"的通行证化。叠加 ALS 对全部 T3 端点恒观测；标注全集进 ROUTE_AUTHZ manifest 成为常驻审计面。

### 5.3 权限测试分类（v4 修正，两类不得混称）

| 类别 | 内容 | 载体 |
|---|---|---|
| **运行时安全行为测试** | 无任何声明的新端点 → 请求进入 → `AuthzDeclarationGuard` 在 handler 前拒绝 | **E2E red-first**（行为锁，进 e2e 套件） |
| **静态架构规则测试** | `@RequiresPermission('activity.delete')` 而调用链无对应授权逻辑 → typed AST/lint 捕获；含 alias/解构/中转绕过样例 | **architecture selftest / eslint rule selftest**（`harness-eslint.selftest.ts` 阳性对照族），**不称 E2E** |

---

## §6 治理规则最终版（15 条）

**元规则**：凡登记表必有 `:check` + selftest 阳性对照 + 自身入 selfGuard 红区；存量豁免走 `ratchet-registry.json` 棘轮（按 §8 语义：**禁新增代码债**、新发现历史债经审核登记；base-trusted 裁决）。

**两类检查严格分离（v4 核心修正）**：
- **A 类 · 登记完整性（治理元数据是否完整）**：37 模块全部归域、109 model 全部有唯一 owner、新增 module/model 同步登记、manifest/登记表新鲜度、registry 版本一致。**目标级 = blocking**（只约束"登记动作"，无历史债无误伤面）；首次 bootstrap 按㉒顺序执行：先 report 落地 → 初始登记与拍板完成 → 在既有 required job 内翻闸 → 此后恒 blocking（勘误㉛统一口径）。
- **B 类 · 现存架构违规（历史债）**：现存非法跨域 import、现存跨域写、现存环、历史语义查询复制。**Phase 0 起 report + 建 baseline（债务身份证）**；历史债不阻塞项目；baseline 只减不增；**新增违规才阻断**，且阻断以满足 §7 Exit Criteria 为前提。

| # | 规则 | 类 | Gate 层(§10) | 管什么 | 初始级 → 终级 |
|---|---|---|---|---|---|
| R1 | domain-map | **A** | L1 | 模块→域/子域归属 + 域间允许边声明完备 | 目标级 blocking（bootstrap 按㉒：首轮 report→翻闸） |
| R2 | module dependency rules | **B** | L2 | 跨域 import 仅沿声明边；新增越界边 | report → blocking（EC-R2） |
| R3 | circular dependency | **B** | L2 | 新增模块环/域环；15 对存量入基线 | report → blocking（EC-R3） |
| R4 | table ownership + **Schema Change Ownership（终审【八】）** | **A** | L1 | 每 model 唯一属主、新 model 未登记即红；**schema diff 按 owner 归属出报告**——他域 PR 触碰 owner model 的 schema（尤其新增状态列/跨域 FK/W4 型通知列）标红入拍板面；硬闸沿既有 prisma-schema 红区双闸，**不另造第二道闸**，本层补的是归属可见性与敏感形态检查单 | 目标级 blocking（bootstrap 按㉒） |
| R5 | cross-domain write | **B** | L3 | 跨属主写默认禁；68 处存量入债务身份证 | report → blocking（EC-R5，含 $queryRaw 通道） |
| R6 | cross-domain read 三档 | **B** | L3 | ②档 allowlist；③档语义查询走属主谓词 | **长期 report**（谓词识别为启发式，误报率不足以支撑阻断；升级须单独拍板并满足 EC-R5 全项+谓词规则成文） |
| R7 | **Route Authorization Policy**（ROUTE_AUTHZ manifest，勘误㉜） | **A** | L1/L4 | 端点×**结构化授权策略**（admission + mode + codes/require + scopes + engine）单一事实源——五态仅为 mode 主分类；生成物新鲜度 | 新鲜度目标级 blocking（bootstrap 按㉒）；128 存量定性=Phase 0 交付物 |
| R8 | 声明↔实现闭环 | A+B | L4 | §5.2 分层：T1/T2 blocking；T3 强制显式标注 | T1/T2 report → blocking（EC-R8）；T3 标注完备性=A 类 blocking |
| R9 | fail-closed Guard + ALS | — | L4+运行时 | §5.1；enforce 切换见 Phase 1D 硬门 | Guard report → enforce（§11 六条件）；ALS 恒 observe |
| R10 | state-machine registry | **A**(登记) + **B**(一致性) | L5 | 53 个状态列登记完备（A，blocking）；每实体带 `governanceStatus: inventory \| governed`（勘误⑫）——inventory=仅盘点在册；governed=闭集+边+错误码+实现映射齐备且过一致性检查。宪法 C6 只约束 governed；Phase 4 起新建 stateful 实体必须直接 governed；存量按棘轮晋升；老表 CHECK 回填逐表 D 档 | 登记 blocking（Phase 4 起）；governed 晋升=棘轮 |
| R11 | OpenAPI semantic diff | — | L6 | breaking（删端点/必填新增/类型收窄等）与 R14 同安全原则（勘误㉞）：**须 ㉑ 的 Environment 人工审批**；fragment 仅为**申报载体**（记录为什么破坏/迁移方式/影响面/回滚方式），自写不构成批准；真正回滚 = revert / feature gate / 兼容层，不是 changelog 文件 | 上线即 blocking（审批通过即绿） |
| R12 | Journey Tests | — | L7 | 五条金路径；Phase 1J 先于权限 enforce | blocking（EC-R12：变异可红 + 连续稳定非 flaky） |
| R13 | Architecture Gate | — | 聚合 | §10 七层聚合为一个 required check | 各子层达标后才聚合 required（EC-R13） |
| R14 | **Authorization Semantic Diff（降级检测，勘误⑤⑰⑱）** | — | L4 | ROUTE_AUTHZ base↔head 语义比对，输出**全部**语义迁移清单——升/平/降三类**恒可见**（升级同样改变前端可见行为〔原本可用的端点新增 403〕，放行但不允许不可见）。**降级闭集（自动判定，保守）**：任何模式→PUBLIC；RBAC/LOGIN_SCOPED/RESPONSIBILITY_SCOPED→LOGIN_ONLY；去除 scope 要求；**码集变更按 `require` 语义分派（勘误㉕）**——`require:all` 集：缩码=降级、增码=升级；`require:any` 集：**增码=降级**（多开一条进门路）、缩码=升级；`all→any`=降级、`any→all`=升级；复合变更无法唯一分解 → 恒保守按语义变更处理——降级**不得作为普通 manifest 更新通过**，须 `changelog.d/` 显式 `authz-downgrade:` fragment + ㉑ 审批。**换码（A→B）不自动定强弱**：权限码间无全序，一律按"语义变更"处理、同样需 fragment；唯一可选例外=登记表显式声明的**权限蕴含图**（勘误㉖：DAG，边 `A⇒B`=「持 A 者必持 B」的规范性声明；强弱=可达性，无路径=不可比=保守；蕴含图与 seed 绑定矩阵做一致性核对，声明边与现实矛盾即告警；初始边集可为空） | manifest 权威化（Phase 1A 完成）后即 blocking——比对对象是生成物，无 AST 依赖；裁判沿 base-trusted 模式（EC-R14） |
| R15 | **common/shared 治理（终审【七】）** | A+B | L2/L3 | `src/common` 只放技术无关横切件：**禁业务 Prisma 访问、业务谓词、业务状态机**——堵"把业务 helper 搬进 common 让双方 import"的洗白通道；common→modules import 恒 0；共享业务内核必须显式登记 owner（kernel 白名单），不能靠搬 common 免除归属。存量三件定性：soft-delete / claim-at-status = 技术件白名单；`member-advisory-lock` = 业务内核，登记 owner = identity-org | 新增违规目标级 blocking（存量入基线+棘轮） |

**R7 过渡期真相源（勘误⑥，防两份真相）**：Phase 0 不改 `src`，而代码今天只有三态词汇——结构化策略定性必须人工拍板。管线定死：`harness/route-authz-classification.json`（Phase 0 人工定性+拍板，**临时输入登记表**，计入生成器 inputDigest 闭包）→ 生成 ROUTE_AUTHZ（逐端点标 `truthSource: code | classification-overlay`）→ Phase 1A codemod 按定性回填装饰器 → **装饰器成为长期唯一 source of truth** → overlay 条目清零 = classification registry **退役**（文件删除，下一个 generatorVersion 移除 overlay 支持）。

**敏感授权事件的人工批准机器化（勘误㉑）**：R14 降级/换码、`@AuthzChainVerified` 新增或修改——批准不落在散文与自写文件上。沿红区既有「base-trusted 裁判 + GitHub Environment 审批」模式（`harness-review` 同款，可复用或新建 `authz-review` environment）：base-trusted detector（跑 base 版脚本，PR 改不了裁判）判定 PR 含敏感授权事件 → 要求 Environment 人工点批，审批人与时点由 GitHub 记录。`changelog.d/` fragment 降级为**申报与记录载体**——**自写 fragment 不构成批准**。

**R14 最终比较器：四态语义结果（终审【十一】）**：实现统一输出 `EQUIVALENT / NARROWER / BROADER / INCOMPARABLE`——只有机器能**证明授权集合包含关系**时才自动定向（require 语义分派、蕴含图可达性、admission/scope 规则 = "可证明情形"的判定库）；codes + code-bound scopes + global scopes + admission 的复杂组合证明不了 → 恒 `INCOMPARABLE` → security review（按降级流程走 ㉑ 审批）；**`engine` 变化恒 `INCOMPARABLE`**（rbac-global↔authz-scoped 改变"谁能通过"的判定方式——三源 scoped grant 与 GLOBAL 单轨的持有者集合互不包含，不可静态定向）。`NARROWER`（收紧）= 放行但恒可见；`BROADER` = 降级流程。**蕴含图是人工规范性事实源；seed 绑定矩阵只做 sanity check，不得反向"证明" A⇒B**（seed 是当前状态不是不变量）。

**测试代码特权边界（终审【十二】）**：R5/R6 等数据访问规则的作用域 = `src/**`。`test/setup`、`test/support`、fixtures 为**受控特权面**（造数可直写 DB）；**`test/journeys/**` 内禁直接使用 prisma**——数据准备必须经 `test/support` helper，正式业务动作恒走真实 API/service 路径（可 lint 执法）；生产 `src` 绝不享受任何测试例外。

---

## §7 report → blocking 的 Exit Criteria（验收门槛，非时间门槛）

v3 的"report 2 周/4 周"降级为**观察时间参考**，不构成自动升级条件。每条 B 类规则转 blocking 必须**同时满足**：

**通用 Exit Criteria（EC-COMMON）**
1. 历史 baseline 已冻结并接入 ratchet-registry（语义=**禁新增代码债**；扫描升级新发现的历史债走 §8 审核登记通道，不算破棘轮；base-trusted 裁决）；
2. 扫描器覆盖范围与已知缺口成文（known gaps 具名清单）；
3. blocking 版本已 **typed-AST 化**（正则版仅限 report 期）；
4. alias / destructuring / variable-forwarding / re-export 绕过样例在 selftest 中全绿（阳性对照）；
5. `$queryRaw`/`$executeRaw` 通道已纳入（涉数据访问的规则）；
6. report 期误报逐条处理完毕（修规则或列入 known gaps），残余误报率维护者书面接受；
7. 相关 CI 检查连续稳定（参考值 ≥10 个 PR 或 ≥2 周自然流量无 infra 抖动）；
8. 涉及业务行为的规则：Journey 全绿 + 相对健康基线 zero-new-red；
9. 回滚路径成文且为一行开关（blocking→report 降级）；
10. 错误信息达到 §10 AI 反馈五要素标准。

**各规则专属附加项**

| 规则 | 附加 Exit Criteria |
|---|---|
| R2/R3 依赖与环 | EC-COMMON 1-4,6,7,9,10（import 图 AST 天然可靠；5 不适用）；domain-map 声明边经维护者拍板 |
| R5 跨域写 | EC-COMMON 全项；债务身份证字段完备率 100%（§8）；属主原语出口至少各域有一条已验证样例；嵌套自开事务反模式检测已带阳性对照（勘误⑨） |
| R6 语义读 | 默认不升级。若升级：EC-COMMON 全项 + 谓词识别规则成文并单独评审误报率 |
| R8 T1/T2 | EC-COMMON 1-4,6,7,9,10 + 断言模式清单已登记且每模式有正/负样例（负样例=调用无后果分支）+ T1/T2 可判定范围定义成文 + T3 显式标注机制已上线且存量标注完备 |
| R9 Guard enforce | 不适用 EC-COMMON，用 Phase 1D 六条件硬门（§11）+ 9,10 |
| R11 语义契约门 | 分类器规则成文（breaking 判定表）+ Environment 审批接线（㉞，与 R14 共用机制）+ fragment 申报字段成文（原因/迁移/影响面/回滚方式）+ selftest 阳性对照（每类 breaking 一例） |
| R12 Journey | 五条变异可红（挡真回归的证明）+ 连续 N 次绿无 flake 定性 + 运行时长入健康基线 |
| R13 required 聚合 | 七个子层各自达到其终级 + required context 名一经设定逐字冻结（沿 ci.yml 教训：改名=全仓 PR 卡死） |
| R15 common 治理 | 存量三件定性完成（技术件白名单 + member-advisory-lock 登记 owner）+ common→modules 入边=0 核验 + 新增业务访问检测带阳性对照；A 面基线后即 blocking，扫描升级沿 EC-COMMON |
| R14 授权降级门 | manifest 生成稳定 + **四态比较器输出接线**（终审【十一】：INCOMPARABLE→审批路径）+ 降级判定成文（mode 主分类强弱格 + 按 require 语义分派的码集方向判定 + 蕴含图可达性、无路径恒保守）+ 蕴含图↔seed 一致性核对接线 + 全量迁移清单输出（升级恒可见）+ base-trusted 裁判接线 + **Environment 审批接线（㉑，fragment 仅申报非回滚）** + selftest 覆盖 `all`/`any` 码集方向各一例 + 每类降级一例阳性对照 |

---

## §8 Architecture Debt 数据结构（债务身份证）

不再只存"68 个跨域写"这样的计数。每笔历史豁免一条结构化条目，落 `harness/architecture-debt.json`（selfGuard 红区——**"禁止新增 baseline"是物理约束**：AI 无 grant 令牌改不了基线文件，不靠口头警告）。扫描器自动填充定位字段，classification/reason/desiredExit 在 Phase 2 一次性人工/AI 补全。

```json
{
  "schemaVersion": "1.0.0",
  "generatorVersion": "1.0.0",
  "inputDigest": "<扫描输入闭包的确定性摘要>",
  "entries": [{
    "id": "XW-0001",
    "classification": "W2-cross",
    "discoveredBy": "boundary-scanner@1.0.0",
    "violationFingerprint": "vfp:<hash(归一化 Class.method + prismaModel + operation)>",
    "shapeDigest": "sdg:<hash(data/where 列键集 + 调用形态)>",
    "callSiteId": "cs:<归一化 AST 路径/上下文哈希——blocking 版棘轮身份（终审【九】）>",
    "occurrenceIndex": 1,
    "baselineRevision": "<登记时点记录（观测型字段，§9 豁免确定性）>",
    "sourceDomain": "engagement",
    "sourceFile": "src/modules/recruitment/recruitment-promotion.service.ts",
    "sourceSymbol": "RecruitmentPromotionService.promote",
    "targetDomain": "credentials",
    "prismaModel": "Certificate",
    "operation": "create",
    "reason": "promote 事务内一并建证书（招新申报一证一行）；历史实现直写",
    "risk": "绕过 credentials 域全部不变量与审计闸",
    "currentStatus": "active-baselined",
    "desiredExit": "改调 credentials 导出 tx 原语（拟 certificate-issue.primitive.ts）",
    "ownerApiTarget": "src/modules/certificates/certificate-issue.primitive.ts（待建）",
    "introducedAt": "≤2026-06（招新 phase2；可考则记，不可考记范围）",
    "allowUntil": "Phase 7 滚动偿还期",
    "reviewTrigger": "credentials 域任何 schema 变更时优先复核本条",
    "debtOwner": "maintainer",
    "notes": "致 Codex：这是登记在案的历史债，不是可复制的范式；仿写=新增违规=阻断"
  }]
}
```

字段全集：`id / classification(W1|W2|W3|W4|import|cycle|predicate) / discoveredBy / violationFingerprint / shapeDigest / dynamicShape / callSiteId / occurrenceIndex / baselineRevision / sourceDomain / sourceFile / sourceSymbol / targetDomain / prismaModel / operation(read|write|create|update|delete|raw) / reason / risk / currentStatus / desiredExit / ownerApiTarget / introducedAt / allowUntil / reviewTrigger / debtOwner / notes`。

**棘轮语义（v4 勘误②精确化）**：按 id 裁决（防此消彼长互相掩护），含义是**禁止新增代码债**——新写入的代码引入违规 = 阻断，无例外。**扫描能力提升后新发现的存量历史债，允许经维护者审核后登记入册**：条目必须标 `discoveredBy`（发现它的扫描器版本）并给出 `introducedAt` 证据（git blame / 版本范围）；**登记 PR 不得同时改动该违规代码行**（改了即按新增代码债裁决——此条可机判）；登记文件在 selfGuard 红区，登记动作本身就要过人工授权闸。登记新发现的历史债**不使已 blocking 的规则跌回 report**。

**身份三层分工（勘误⑪/㉓/终审【九】统一定义，以本段为准）**：① **`callSiteId` = 最终债务身份**——归一化 AST 路径/上下文哈希，棘轮按它裁决（blocking 版唯一身份）；② **`violationFingerprint` = 归类/关联键**——归一化 `Class.method` + prismaModel + operation（不含 file/line），用于分组、跨重构候选关联与 `supersedes` 匹配；移动方法/格式化/行号漂移不改变它 ⇒ 不产生"旧债消失+新债出现"的假 churn（那种 churn 会被代码债棘轮误拦成新债）；③ **`shapeDigest` = 实质漂移检测**——同身份下实质变化 = 受控事件。`sourceFile` 行号仅是定位提示；关联失败时扫描器输出新旧候选对，人工确认后以 `supersedes: <旧id>` 迁移、旧条目闭结。**Phase 0 扫描器首版即实现三层，不后补。**

**已知实施细节——指纹碰撞（勘误⑲，Phase 0 实现时定稿）**：同一方法内对同 model 同 operation 的多处违规会得到相同指纹。候选消解：同指纹 + `occurrenceIndex`（文件内出现序）或结构上下文哈希；report 期辅助判据可用**同指纹计数的增减**（减=清偿候选、增=新代码债），方法内重排不改计数即不产生假 churn；终局身份恒为 `callSiteId`（见下方三层分工）。

**偷梁换柱防护（勘误㉓）**：指纹只管身份、不管实质——同方法同 model 同 operation 下，把"写 claim 标记列"换成"写 status 列"，指纹不变，旧条目会**掩护一个恶化了的新违规**。加第二判据 `shapeDigest`（静态可提取时：`data`/`where` 的列键集 + 调用形态的归一化摘要）：**身份 = fingerprint 恒稳；实质漂移 = 受控事件**——baselined 条目的 shapeDigest 变化即红，须以过审 PR 更新条目并说明漂移原因方可通过；无法静态提取（动态构造/spread）的条目标 `dynamicShape: true`，入 known gap 并挂 reviewTrigger 定期复核。改名袭夺他条指纹的手法同样会被 shapeDigest 失配暴露。

**终局身份 = call-site 级（终审【九】）**：count/occurrence 只在 report 期作辅助——"删旧调用 A + 同方法新增同形态调用 C"可令 fingerprint、shapeDigest、count 三者全不变。blocking 版每个 call-site 必须有**稳定结构身份**（归一化 AST 路径/上下文哈希）；自动关联失败恒走 `supersedes` 人工迁移；**count 永不作为最终棘轮身份**。

---

## §9 治理登记表元规范（版本管理）

适用对象：domain-map、table ownership（domain-map 内段）、ROUTE_AUTHZ manifest、state-machine registry、architecture-debt、boundary allowlist。

1. 每份**派生**登记表顶层必含：`schemaVersion`（semver；breaking 升 major）、`generatorVersion`、`inputDigest`——对生成**输入闭包**（排序后的输入文件清单 + 内容哈希）的确定性摘要。**派生生成物不得内嵌时间戳或 git SHA**：时间戳让"重新生成逐字比对"（本仓 openapi/counts/codemap 的既有新鲜度范式）恒假红；SHA 提交前不可知、提交后即过期（自引用悖论）；
2. 生成段与手写段物理分离（沿 RBAC_MAP `begin/end` 标记先例）；生成段禁手改，`:check` 守护；
3. **generator 与登记表版本不匹配 → 检查器直接 fail**（旧 generator 遇新 schemaVersion 恒 fail-closed，不猜）；
4. 登记表改动走 PR 拍板面（diff 即人审对象），语义性改动（域边/owner 变更）须维护者拍板记录；
5. 向后兼容规则成文：minor 变更须旧字段可读；major 变更须迁移脚本同 PR；
6. 全部登记表与检查器入 selfGuard 红区（AI 不可自改约束边界——既有机制直接覆盖）；
7. **新鲜度判定** = 重新生成逐字比对（既有范式）∥ `inputDigest` 复算比对。输入闭包的枚举**单源在生成器内**，selftest 阳性对照：触碰任一输入文件必须翻转 digest（防枚举漏项造成静默陈旧）；
8. **观测型记录豁免**：BASELINE_HEALTH、债务条目的语义字段、incidents 等是**记录不是派生物**——允许含 CI run 链接、日期等环境事实，不做确定性与再生成比对要求，版本由 git 历史承载。

---

## §10 CI Architecture Gate：七层结构 + AI 错误反馈设计

**不做一个黑盒 `Architecture guards`。** 逻辑分层（PR 聚合为一个 required check，失败按层报告）：

| 层 | 名 | 覆盖规则 |
|---|---|---|
| L1 | Metadata Integrity | R1、R4、R7 新鲜度、R10 登记完备、§9 版本校验 |
| L2 | Dependency Boundary | R2、R3、R15 依赖面（common→modules 入边恒 0） |
| L3 | Data Ownership | R5、R6、$queryRaw 通道、R15 common 治理（终审【七】） |
| L4 | Authorization Contract | R8（T1/T2 + T3 标注完备）、R9 声明存在 lint 面、R14 授权语义 diff（勘误⑮） |
| L5 | State Governance | R10 一致性面 |
| L6 | API Contract | R11 + 既有 contract snapshot（归位为本层既有能力） |
| L7 | Journey Regression | R12 |

**错误反馈五要素（面向 AI Coding / Codex 设计，人类可读 + JSON 机器可读双输出）**：每条违规必含 ①规则 ID+层名；②精确位置（file:line / symbol）；③事实句（谁对谁做了什么）；④违规依据（引用 domain-map/manifest 的具体声明行）；⑤修复路径（合法出口 + 明确"禁止自行扩 baseline"——该禁止是物理的：baseline 在 selfGuard 红区）。

示例（禁止输出 `architecture check failed` 这类黑盒信息）：

```
[L3/R5] 跨域写违规  src/modules/recruitment/foo.service.ts:412  RecruitmentFooService.bar
事实: engagement 域正在直接写 Certificate（create），owner = credentials（domain-map#models.Certificate）。
合法出口: certificates 导出原语 certificate-issue.primitive.ts；或 CertificatesService 公开 API。
历史债对照: 与 XW-0001 同型，但 XW-0001 是登记在案的历史豁免，禁止仿写。
处置: 改走合法出口。不得修改 harness/architecture-debt.json（selfGuard 红区，AI 无授权不可写）。
```

```
[L4/R9] 路由缺少访问声明  src/modules/foo/foo.controller.ts:88  GET /api/admin/v1/foos
事实: handler 无 @Public/@LoginOnly/@LoginScoped/@ResponsibilityScoped/@RequiresPermission 任一声明。
依据: Route Authorization Policy 声明规范——结构化策略（docs/ai-harness/ROUTE_AUTHZ.md）。
处置: 按端点语义补声明；若属 RBAC 须同步 service 层判权（R8 T1/T2 会核）。enforce 后该路由运行时将被 AuthzDeclarationGuard 拒绝。
```

---

## §11 迁移路线（最终版）

**全局验收规则 zero-new-red**：自 Phase 0 健康基线落档起，任何 Phase 验收允许 baseline 中已登记的旧失败继续存在，**不允许新增失败**。

| Phase | 目的 | 业务代码 | 文件量（估） | 接口影响 | 运行时影响 | 回滚 | 风险 | 工作量 | 验收 | 获得能力 |
|---|---|---|---|---|---|---|---|---|---|---|
| **0 纯取证+登记+健康基线** | A 类检查落地（目标级 blocking，首轮按㉒先 report 再翻闸；R1/R4/R7 新鲜度）；B 类首扫 report+债务身份证初版；manifest 生成器+128 定性报告；53 状态列清单；**BASELINE_HEALTH 落档（§12）** | 否 | 新增 8-10（harness/*.json×3、scripts×2-3、生成物、基线报告、selftest 追加）；src=0 | 0 | 0 | revert 净删 | 零 | 2-3 刀 | A 类全绿；定性报告+债务身份证初版交拍板；健康基线落档 | 机读架构事实 + 零新红对照基准 |
| **1A 权限声明体系** | 装饰器族+Guard（**report**）+ALS 观测；回填 codemod 分 surface 三刀；128 定性落 manifest；seed 派生；summary 失真修复（契约刀） | 少量（声明+接线，不改判权逻辑） | 新增 4-5；回填触及 ~94 controller；`app.module.ts`（红区）；seed 派生 6 文件 | OpenAPI 0（装饰器不进契约）；失真修复刀快照受控刷新 | report 期 0；ALS 仅告警 | Guard/ALS 从 providers 摘除即回滚 | 低（report） | 4-6 刀（含红区刀、契约刀） | 声明覆盖 100%；classification overlay 清零并退役（勘误⑥）；R8 T1/T2 report 出数；失真清零 | 声明面从三态失真变结构化策略可审计 |
| **1J Journey 金 5 条（与 1A 并行）** | ①招募→晋升→建号→入队 ②活动→报名→审批→签到→结算→账本 ③考勤修正 ④证书标准→认定→申报→发号 ⑤事件→outbox→投递重试 | 否（纯新增测试） | test/journeys/ 5 + jest config（红区）+ ci.yml（红区） | 0 | CI +2~4 min | 删测试 | 低 | 2-3 刀 | 5 条全绿且变异可红 | 跨域回归网先于最高风险开关就位 |
| **1D enforce 切换（硬门）** | `AuthzDeclarationGuard` report→enforce。**六条件缺一不可**：① 128 `[auth]` 全量定性完成；② 声明回填 100%；③ Guard report 期无未知问题（未识别路由/误伤清单=空或已处置）；④ 1J 五条全绿；⑤ red-first（运行时 E2E：无声明端点被 Guard 前置拒）通过；⑥ 相对 Phase 0 基线 zero-new-red | 一行开关 | 1 | 0 | 未声明路由 handler 前被拒（即目的） | 开关回 report | 中→由六条件压到低 | 1 刀 | 六条件逐条留痕 | deny-by-default 生效 |
| **2 数据所有权+写保护上线** | R5/R6 扫描 report；债务身份证字段补全（classification/reason/desiredExit 100%）；观察子域间写路径进 report | 否 | 扫描器+登记 2-3 | 0 | 0 | 删文件 | 零 | 1-2 刀 | 68 处全部持证 | 新增跨域写可见 |
| **3 按 Exit Criteria 转 blocking** | R2/R3/R5/R8(T1/T2) 各自满足 §7 后转 blocking（无固定日期，验收制） | 极少 | eslint/CI 配置（红区）+基线 | 0 | 0（CI 层） | 一行降级 report | 低 | 1-2 刀/规则 | 各规则 EC 清单逐项打勾留痕 | 新债物理不可入 |
| **4 状态机治理** | 注册表+共享执行器；新实体强制；action-state 3/8→全量派生；老表 CHECK 回填逐表 D 档 | 新实体起 | registry+执行器+检查 | 0 | 0 | 删登记（无消费者时）；CHECK 逐表 drop | 低 | 2 刀+N 小刀 | 未登记状态列即红；governed 晋升按棘轮出数（勘误⑫） | 状态图成拍板面 |
| **5 契约语义门+FE codegen** | R11 上线；admin/app TS client 生成进 handoff | 否 | 脚本 2+package.json（红区）+产物 | 0 | 0 | 摘 CI 步骤 | 低 | 2-3 刀 | breaking 未过 Environment 审批即红（fragment 仅申报，勘误㉞） | 前端半程机器保障 |
| **6 尺寸棘轮+按触碰拆** | 11 个千行 service 具名基线只增即红；触碰时按 D-7 六类拆 | 是（渐进） | check-codemap 升级+基线 | 0（行为等价） | 0 | per-PR revert | 中 | 持续 | 基线单调降 | AI 理解面回预算 |
| **7 滚动偿还** | 按债务身份证逐条清偿：XW-0001（recruitment→credentials 原语）、W3 投影走 role-bindings 原语、W4 列迁移（D 档）或持证长存、authz 倒置注册制（接线按 §4 勘误⑦判据验收：platform-access 业务入边=0，composition root 唯一豁免）、content↔attachments 环 | 是 | 每条 1 刀+属主侧原语文件 | 0（行为等价） | 0 | per-PR revert | 中 | 每条 1 刀 | 债务条目按 id 清偿闭结；代码债零新增 | 债务只出不进闭环（新发现历史债走 §8 审核登记通道） |
| **8 物理目录（条件触发）** | 某域模块数>10 或新域立项时按域分组；先满足 §2 收口判据 | 是 | 大 | 0 | 0 | 高成本 | 高 | 大 | — | 可不做 |

**并行 lane 解锁硬门**：R2/R5/R8(T1,T2)/R9 达终级 + 1J 恒绿 ⇒ 开第二条 lane。
**治理 true-up**：每 +100 端点或每新增一个域，盘点登记表覆盖率与债务条目集。

---

## §12 Phase 0 真实交付物清单

| 交付物 | 落点 | 说明 |
|---|---|---|
| domain-map（含 table ownership、kernel 声明、观察子域） | `harness/domain-map.json` | A 类目标级 blocking（首轮按㉒ report→翻闸） |
| 边界扫描器（首版可正则，仅 report） | `scripts/check-boundaries.ts` | A/B 两类检查物理分离为两个入口（`--metadata` blocking / `--violations` report）；violations 输出首版即带 `violationFingerprint`（勘误⑪） |
| Route Authorization Policy 生成器 + 128 端点定性报告（勘误㉜） | `scripts/generate-authz-manifest.ts` → `docs/ai-harness/ROUTE_AUTHZ.md` | **结构化策略**逐端点交拍板（admission / mode / codes+require / scopes / engine 全轴，非仅五态） |
| 结构化授权策略登记表（临时真相源，勘误⑥/㉜） | `harness/route-authz-classification.json` | 人工定性+拍板；**必须承载全结构（admission/codes/require/scopes/engine），不得只填一个五态 mode**；计入生成器 inputDigest 闭包；Phase 1A overlay 清零后退役 |
| 外部 I/O 盘点表（勘误⑬） | 报告（观测型） | 全仓外部调用分型：durable async effect（应走 Outbox）vs 同步集成（登录握手/OCR/实时查询/存储签发）；供 C7 适用范围拍板 |
| 债务身份证初版 | `harness/architecture-debt.json` | 定位字段自动填充；语义字段 Phase 2 补全 |
| 状态列清单 | `harness/state-machines.json` 骨架 | 仅登记，全部 `governanceStatus: inventory`（勘误⑫）——登记≠已治理 |
| **BASELINE_HEALTH** | `docs/ai-harness/BASELINE_HEALTH.md` + `harness/baseline-health.json` | 至少含：unit 总/过/败；e2e 总/过/败；contract；lint（冷/缓存双口径）；OpenAPI check；当前 CI required checks 快照；各 job 耗时；已知 flaky（auth-jwt-guard / users-last-super-admin / attendances-state-transition 起步）；已知长期红项；失败原因归类（infra/flake/regression/env）；sourceRevision + CI run 链接 |
| selftest/红区收编 | `harness-guards.selftest.ts` 追加；`redzone.json` selfGuard 段收编上述文件 | 登记表自身受保护 |

**A 类翻闸 bootstrap 顺序（勘误㉒）**：① 登记表 + 检查器先以**非阻断**形态落地（报告输出）；② main 全绿并与在飞 lane true-up 一次（期间合入的新 module/model 补登记）；③ 翻闸方式 = 在**既有 required job 内把该步骤从报告翻为失败**，**不新增 required context**——「required context 必须先合后加」是本仓第五轮 harness 评审的既有教训，新 context 会卡死所有 base 上没有它的在飞分支；④ 翻闸时点选批次边界，自翻闸起新增 module/model 未登记即红。回滚 = 步骤翻回报告，一行。

---

## §13 三张图

### 图 1 · 当前

```
                    ┌─ 平铺 37 modules ──────────────────────────────┐
  [permissions]←33──┤ activities(35k行,107文件) attendances users    │
  [audit-logs] ←29──┤ members organizations recruitment team-join …  │
                    │   ↕15对双向依赖   隐性内核散在业务模块内        │
                    │   authz ⇄ 业务(归属知识第二副本)                │
                    └───────────────┬────────────────────────────────┘
                                    ▼  162 文件直握同一个裸 PrismaClient
                          [PostgreSQL 109 表]  ← 表所有权未定义,68 处跨属主写
  权限: Jwt→RolesGuard(空转)→service 手写 can()  ← 无 deny-by-default
  声明: 三态词汇,双向失真已实证   测试: 265 e2e 点状,旅程 0
```

### 图 2 · 终局

```
  业务域(域内自由,域间走声明边;†=治理大域·暂定,子域观察中)
  ┌────────────┬──────────┬───────────────┬──────────┬────────────┬─────────┐
  │identity-   │engagement│participation† │insurance │credentials │ content │
  │org†        │          │ lifecycle/    │          │            │         │
  │ accounts/  │          │ registration/ │          │            │         │
  │ people/    │          │ attendance/   │          │            │         │
  │ structure  │          │ settlement    │          │            │         │
  └────┬───────┴───┬──────┴──────┬────────┴────┬─────┴─────┬──────┴────┬────┘
       │ 建号原语← ─┘  账本读↑     │ 证据消费←───┘  发号原语←─┘           │
       ▼            ▼            ▼             ▼           ▼           ▼
  ┌─ platform-access(authz/permissions/role-bindings; 归属解析=各域注册) ─┐
  ├─ comms(四渠道+outbox; 只读业务,禁写)                                 ─┤
  ├─ platform-core(storage/attachments/dict/audit/meta;auth∈accounts㉚) ─┤
  └─ kernel 读集: User/Member/Organization 安全列 + owner 导出谓词        ─┘
  治理面: domain-map ▪ 债务身份证 ▪ 结构化 Route Authorization Policy ▪ fail-closed(两阻断+ALS观测)
         ▪ 状态机注册表 ▪ 契约语义门+TS client ▪ journeys ▪ 七层 Architecture Gate
  拍板面: 每 PR 附登记表 diff —— 人审表,机器审码
```

### 图 3 · 迁移路线

```
P0 纯取证+登记+健康基线(A类目标级blocking·首轮report→翻闸 / B类report+持证)
  │
  ├──→ P1A 权限声明体系(Guard report+回填+ALS观测+定性落manifest)
  ├──→ P1J 旅程金5条(并行,纯新增)
  │
  └──→ P1D enforce 切换【六条件硬门:定性全量+回填100%+report无未知+1J绿+red-first过+zero-new-red】
              ─→ P2 写保护report+债务身份证补全 ─→ P3 各规则按 Exit Criteria 转 blocking(验收制,无固定日期)
                                                            ▼
                          【并行 lane 解锁: R2/R5/R8(T1,T2)/R9 达终级 + 1J 恒绿】
                                                            ▼
P4 状态机登记 ─→ P5 契约语义门+codegen ─→ P6 尺寸棘轮/按触碰拆 ─→ P7 滚动偿还(按债务id清偿)
                                                           ─→ P8 物理目录(条件触发,可不做)
原则: A类完整性恒blocking;B类历史债report+持证+棘轮;blocking=Exit Criteria验收不=时间;
      阻断靠pre-handler与构建期,ALS只观测;zero-new-red贯穿;业务批次全程不停
```

---

## §14 需维护者拍板事项

1. 域划分与治理大域/观察子域方案（§2，含歧义模块归属）；
2. **D7 v0.2 决策锁**：声明存在性 Guard 是否构成「Guard 装饰器」条款修订（判定仍单轨 service 层）；
3. 128 个 `[auth]` 结构化策略定性表（Phase 0 产出后逐个拍板；重点 admin 3 个刻意无码化是否维持）；
4. 红区授权：`app.module.ts`、`package.json`、`redzone.json` selfGuard 收编、jest/ci 配置（journeys）；
5. W4 提醒标记列：D 档迁移 vs 持债务身份证长存；
6. R6 语义读是否永久停留 report 级；
7. 各规则转 blocking 时的 Exit Criteria 打勾单（每次升级一签）；
8. 并行 lane 解锁硬门条款；
9. `kernelReadFields` 字段清单（§3，逐字段拍板）；
10. `authz-review` Environment 的审批人范围、最少审批人数、紧急 bypass 流程（勘误㉝：出口形态已定为 Environment 审批，fragment 仅申报）；
11. C7 适用范围界定（Phase 0 外部 I/O 盘点表产出后：durable effect vs 同步集成）；
12. auth 模块域归属确认（勘误㉔建议：identity-org.accounts，证据见 §2；确认后 domain-map 照此登记）；
13. 权限蕴含图初始边集（勘误㉖：可先空集=全不可比恒保守，有需要再逐边拍板）。

## §15 本方案不做什么

不拆微服务；不引入事件溯源/CQRS/GraphQL；不预装 Redis/queue/事件总线（§9 升级路径触发制不变）；不引入 Repository 层；不统一重写 8 个既有状态机（先登记后收敛）；不做调用链形式化证明系统（R8 边界诚实）；Phase 1 前不改任何 `src` 业务代码；不大规模搬目录（P8 条件触发且可不做）；不触碰 wecom/证书两条上线线与生产开关；不回改 `prisma/migrations/**` 存量与 `docs/archive/**`；不再迭代总方案（v4 冻结）。

---

## §16 Architecture Governance Constitution（宪法 14 条）

> 任何人或 AI 修改 SRVF 必须遵守的最高原则。具体 domain-map 可变，本节不轻易变。

1. **每张表、每个业务谓词有唯一属主域**；属主之外禁止第二份实现。
2. **跨域写默认禁止**；唯二合法出口 = 属主 public API / 属主导出 tx 原语。
3. **跨域读分三档**；业务语义查询必须消费属主导出谓词，不得内联复制。
4. **禁止新增代码债**；每笔历史豁免必须持结构化身份证——它是被允许暂存的历史债，不是可复制的范式。扫描能力提升后新发现的存量历史债，经审核登记入册，不视为破例。
5. **无显式访问声明的路由默认拒绝**（fail-closed）；判权执行单轨在 service 层。
6. **状态治理分二档（勘误⑫）**：`governanceStatus=governed` 的状态字段，变更必须走登记的合法生命周期、非法迁移以具名错误码拒绝；`inventory` 档仅表示"已盘点在册"，不构成治理承诺——**登记≠已治理**。
7. **外部副作用恒经 Outbox**：Intent 与业务写**同事务**提交（enqueue 失败 = 业务整体回滚）；真实外部 Effect（HTTP/短信/微信/企微）**恒在业务事务之外**由独立 worker 执行。（勘误⑬：本条适用范围——durable 业务副作用 vs 同步集成〔登录态外部握手/实名 OCR/实时查询/存储签发〕——留待 Phase 0 外部 I/O 盘点表出来后拍板界定；界定前本条不适用于同步集成通道。）
8. **基础设施按真实触发信号解锁**；不为架构美学拆微服务、不预装未触发的中间件。
9. **不为抽象而增加 Repository 层**；数据边界由登记表+执法位实现，不由包装层实现。
10. **行为等价重构不得改变 API 契约、事务边界、锁序、错误码**；等价性由 characterization + Journey 判定。
11. **机器规则优先于文档与记忆**：能做成执法位的不写散文；每条执法位必须有阳性对照自测。
12. **物理目录不是领域边界**；边界 = domain-map 声明 + 执法。搬目录永远是独立决策。
13. **治理登记表是架构事实源**：带版本、带校验、生成段禁手改、改动走拍板面 diff。
14. **任何规则转 blocking 必须先满足 Exit Criteria**，且 blocking 必须可一键降级回 report。

---

*v4 冻结。下一步：依 §12 起草 Phase 0 goal（纯取证+登记+健康基线；不执行 Phase 1；不修改 `src` 业务代码）。*
