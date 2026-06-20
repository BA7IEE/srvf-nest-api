# SRVF 全仓多维度系统性 review 报告(v0.26.0 base)

> **状态:冻结**(2026-06-20;goal「全仓多维度系统性 review(v0.26.0 base)— A 档只读审查」拍板)。
> **性质**:**A 档只读审查**——本 goal **不改任何代码/schema/seed/docs**(本报告除外);**修复另起 review-then-fix goal**(按本报告分批)。
> **base**:`main` HEAD `e0194d3b`(v0.26.0;package.json = Swagger = tag = GitHub Release Latest 四方一致;0 open PR / 工作树 clean)。
> **方法**:22 个「维度 × 模块簇」对抗式 finder(并行子代理)→ 跨 finder 去重 → **每条 finding 独立对抗 verify(real ∧ isNew 才 confirmed)**;48 agents / 4.18M tokens / 849 tool-uses。对账基准:`current-state §3/§4` + `AGENTS` + `architecture-boundary` + `api-surface-policy` + `V2红线`——**已登记的已知/已接受项不重复报**。
> **冲突优先级**:本报告让步给 `AGENTS` / baseline / 各权威源;仅作审查证据,不覆盖任何铁律,不构成 fix 授权。

---

## 0. 结论(TL;DR)

- **底座结构性健康:0 P0 / 0 P1。** 招新三期入队刚收口的 v0.26.0,经全仓 10 维对抗扫描**未发现高危/严重缺陷**。confirmed-new 全部为 **P2(6)+ P3(13)= 19 条**,均为**硬化级 / 一致性级**,非阻断。
- **最值得先看的 P2**:① **RBAC 提权职责分离破口**(ops-admin 可自授 SA-only 保留码,F1)② **attachment 直传 key 客户端可控 → COS 接通后 signed-URL IDOR**(F2)③ 两条**依赖 CVE**(multer HIGH / COS-SDK 传递 critical,F5/F6,均「COS/真通道接通即激活」)④ 两条 **promote 写 canonical 表绕字典校验**(relation/gender,F3/F8)⑤ **attendance rejected 单时间窗死锁**(F4)。
- **0 confirmed-known**:finder 正确区分「已知/已接受」(god-service 体量、service 单测占比、招新去重枚举面、外籍手动建档、身份证明文 C-8、retention 手动 SOP、flaky auth-jwt-guard、单实例假设…)均未被误报为新发现。
- **覆盖**:26/27 模块被直接命名审查(`health` 为 live/ready 平凡端点、`ai` 为占位无代码,均无 finding,非漏扫);见 §5 矩阵。
- **共性根因**:多数 P3 集中在 **recruitment promote 路径**(搬档绕 canonical 字典校验 / 即时清漏字段 / 公示预览与发号口径分叉 / 同批 openid 整批阻断)+ **运维文档随单实例耦合点增长的 true-up 滞后**。

---

## 1. 计数

| 项 | 值 |
|---|---|
| finder(维度×模块簇) | 22 |
| 候选 finding(去重前 / 后) | 27 / 27 |
| finder 自标已知(不进 verify) | 1 |
| 进入对抗 verify | 26 |
| **confirmed-new** | **19**(P0 0 / P1 0 / **P2 6** / **P3 13**) |
| confirmed-known(复核为真但已登记) | 0 |
| dismissed(复核 real=false / 无运行时危害) | 7(其中含真但无害的 doc-drift,见 §4) |

---

## 2. P2 findings(6;先修候选)

| # | 维度 | file:line | 问题 | 修法 | 档 |
|---|---|---|---|---|---|
| **F1** | 安全·RBAC 提权 | `permissions/role-permissions.service.ts:87-121` + `user-roles.service.ts:99-118` | ops-admin 运行时给自建角色挂 `member.delete.record` 等「仅 SA」保留码再挂给自己——`role-permission.assign` 缺 user-role 那样的分级闸(canAssignRole),seed「不绑定=仅 SA」铁律可被绕过 | assign 增权限码分级闸:非 SA 不得把 SA-only 保留码写入任何角色 | B |
| **F2** | 安全·IDOR | `attachments/attachments.service.ts:345-410` + `:88-111` + `dto.ts:118-127` | 直传 create 的 `dto.key` 全客户端可控(仅长度约束),RBAC 只判 ownerType/ownerId、与 key 解耦;`toResponseDto→resolveAccessUrl(key)` 直接对任意 key 签发 signed GET → **COS 接通后 signed-URL 越权 oracle** | key 服务端派生 / 强制 `attachments/<envPrefix>/` 命名空间 + 绑 owner 派生前缀 | B |
| **F3** | 正确性 | `recruitment/recruitment-promotion.service.ts:162-173` | promote 写紧急联系人把报名者自填 `relation` 原样落 `EmergencyContact.relationCode`,绕过 canonical `assertRelationCodeValid`,污染字典契约(违 promote「零漂移」头注释) | 提交 DTO 收紧 relation 为 `emergency_relation` 字典(优先),或 promote 内复刻 assert + skip+report | B |
| **F4** | 正确性 | `attendances/time-overlap-policy.ts:41-49` + state-machine + `attendances.service.ts:875-916` | `rejected`(一级驳回)单的 records 不软删、单据又不可 edit/softDelete → live records 经 assertNoTimeOverlap **永久占用 member 时间窗**,纠正后重提交被 22060 死锁,无恢复路径 | reject 令 records 跟随软删(对称 finalReject),或 overlap 校验过滤 `statusCode NOT IN (rejected,final_rejected)` | B |
| **F5** | 依赖·CVE | `package.json:43`(multer@2.1.1)+ `recruitment-public.controller.ts:83-89` | 未鉴权 multipart 上传(`open/v1/recruitment` @Public)依赖 multer@2.1.1(GHSA-3p4h-7m6x-2hcm,HIGH)→ 畸形 multipart 未捕获异常 **单实例进程崩溃 DoS** | bump @nestjs/platform-express 至 multer≥2.2.0 / pnpm overrides 钉版本后重锁 | B |
| **F6** | 依赖·CVE | `package.json:52`(cos-nodejs-sdk-v5@2.15.4)+ `storage/providers/cos.provider.ts:2` | 生产强制 provider(COS)的 SDK 链含 critical 传递 CVE:`form-data@2.3.3`(unsafe boundary)+ `fast-xml-parser@4.2.5`(entity-bypass/DoS);COS 接通后解析腾讯云 XML 即落受影响版本 | 升 cos-sdk / overrides 钉 `fast-xml-parser≥4.5.5` `form-data≥4.0.6` 重锁 | B |

**F1 触发链(已对抗证实)**:持 ops-admin(seed 绑 14 条 `rbac.*` 含 role.create/role-permission.create/user-role.create)→ ① 建角色 `evil` → ② `POST /system/v1/roles/{evil}/permissions` 传 `['member.delete.record']`(assign 仅校 `rbac.role-permission.create`,member.delete.record 是真实 Permission 行 seed:1545,createMany 直落库)→ ③ 自授 `evil`(canAssignRole 因 `evil!==ops-admin` 放行)→ `rbac.can(self,'member.delete.record')` 命中,members 软删「仅 SA」(纯靠 seed 不绑维持)被攻破。同法可自授全部 `*.reset.credentials`。**克制 P2 不抬 P1**:需已持高信任内部 ops-admin 账户;`user.update.role` 经 `canChangeRole`「永禁升 SA」兜底,夺不到 Role 枚举级 SA 短路,被击穿的是 permission-gate 的 SA-only 能力子集。

**F2 触发**:持 `attachment.upload.member.self` 成员调 `POST admin/v1/attachments`,owner=自身(RBAC 过),`key='attachments/prod/2026/05/01/<他人对象>.jpg'` → 返回 `accessUrl` 即该任意桶对象有效 signed GET。今 COS 休眠(Local 仅返相对 stub)未现网激活,**运维接通 COS 当天即可利用**。

---

## 3. P3 findings(13)

| # | 维度 | file:line | 问题 | 修法方向 | 档 |
|---|---|---|---|---|---|
| **F7** | 安全·cost-DoS | `recruitment-applications.service.ts:129-228` | 同 openid 可用不同「校验位合法」伪造身份证号无限提交、每条直达**付费**实名核验;去重键是 `(cycleId,idCardNumber)` 非 openid,无 per-openid 上限 | per-openid/IP 二级配额,或「同 openid 已有报名」前置拦于付费前;否则 §4 登记此角度 | D |
| **F8** | 正确性 | `recruitment-promotion.service.ts:145-160` | promote 写 `MemberProfile.genderCode/documentTypeCode` 绕 canonical `assertAllDictCodes`;若 gender 字典 item code 非恰为 `male/female`(seed 现为占位 demo-*)则 profile 携带不可字典解析值,canonical 改 profile 会被卡 | promote 内复刻 assertDictItemValid + skip+report,或 ops SOP 登记「gender 必含 male/female、document_type 必含 mainland_id」前置门禁 | B |
| **F9** | 正确性 | `recruitment-applications.service.ts:582` vs `recruitment-promotion.service.ts:84-85` | 公示名单 `publicityList` 判可发号只用 `isPromotable`(不查 openid 已占用),promote 额外要 `!openidAlreadyBound` → 预览与实发分叉(显示拟发号实际 skip + 其后整体 +1 偏移,公示失真) | 抽 `openidAlreadyBound` 为两处共享纯查询 helper,publicityList 同判 → needsManualBuild | B |
| **F10** | 正确性 | `attachments/attachments.service.ts:707-813` | `confirmUpload` 不重校 owner 仍存在(只从 token claims 重建 scope);member 分支不查存活 → owner 软删窗口内落库悬空行 | confirm 落库前补 `assertOwnerExists`(与 create 对齐);可并入未来 attachments 健壮性批 | B |
| **F11** | 正确性·并发 | `activity-registrations.service.ts:271-283,459-461` | 容量闸 READ COMMITTED 下普通 COUNT 复核无行锁,两并发 approve 互不可见对方未提交写 → **pass 超 capacity**;line 459 注释与隔离语义不符 | approve 事务对 activity 行 `FOR UPDATE` 锁/Serializable+重试/DB 名额约束;修注释 | B |
| **F12** | 数据合规 | `recruitment-promotion.service.ts:176-190` | promote 即时清漏 `openid` + `reviewNote`(retention SOP §1 明列需 NULL);因该行同置 `sensitivePurgedAt`,SOP `WHERE sensitivePurgedAt IS NULL` 永跳过 → 两再识别 PII 字段在「已脱敏」行永久残留 | 即时清 update data 补 `openid:null,reviewNote:null` + 补断言 | A |
| **F13** | 一致性 | `prisma/seed.ts:2014` | `BIZ_ADMIN_DESCRIPTION`(持久化、运营可见)枚举停在「recruitment-application 2=48 绑 47」,漏招新二期+3 与整个入队+7;实际 58 码/绑 57;rbacmap 不校 description 故逃门禁 | 改由 `*_PERMISSION_SEED.length` 动态拼接,或更新 58/57 + 刷 `update:{}` 让既有行更新 | A |
| **F14** | 一致性 | `scripts/check-rbac-map.ts:298` | controller-prefix PASS 摘要 + 头注释硬写「4 canonical 前缀」,实际 `CANONICAL_PREFIXES` 已 5(open/v1 第 5);数组对、仅打印数字误导 | 模板/注释「4」→ `${CANONICAL_PREFIXES.length}` 或 5 | A |
| **F15** | 测试 | `recruitment-promotion.service.ts:83-94` | promote skip 分区不去重「同批两条共享 openid」→ 第二条建 User 撞 `User.openid @unique`→P2002→28042 **整批回滚零发号**;此失败路径无任何 e2e/单测(现有测试全用互异 openid) | 补 e2e 锁行为;实现建议批内 openid 去重移入 skipped(降级「一对阻断全批」为「仅冲突项跳过」) | B |
| **F16** | 性能·N+1 | `recruitment-promotion.service.ts:83-94` | 事务前分区循环对每报名串行 `openidAlreadyBound`→逐行 `user.findFirst`(N 次顺序往返) | 循环前单次 `findMany({openid:{in}})` 构 Set,N→1(行为/原子性零变,沿 #387 思路) | B |
| **F17** | 性能·扩容文档 | `docs/deployment.md:4-11` + `current-state.md:27` | 横向扩容 checklist stale:漏第 9 限流器 `recruitment` + 第 4 个 60s 缓存 `realname-settings`;item#2 仍写「8 限流器」、settings 缓存只列 storage/sms/wechat;§1 指针「5 处」与实列 6/代码 7 类耦合不符 | true-up:9 限流器 + realname 缓存 + §1 计数对齐(纯文档,单实例零行为变化) | B |
| **F18** | 依赖·门禁 | `package.json`(无 CI audit)+ `system-foundation-governance.md:59`(G-12) | 全仓无 `pnpm audit` 门禁,26 漏洞(2 crit/8 high/13 mod/3 low)无 CI 拦截/巡检;§3/§4/AGENTS/security 均无对这些 CVE 的接受登记(未登记债务) | CI 加 `pnpm audit --audit-level high`(先告警再门禁)或 G-12 正式立项,把 26 项分类「修/接受+理由」写 §4 | B |
| **F19** | 运维·扩容文档 | `docs/deployment.md:10` | 「60s 进程内 settings 缓存」只列 storage/sms/wechat,漏 `realname-settings`(同款 `CACHE_TTL_MS=60_000`,第 7 个进程内耦合点)| true-up「6 处」→7,补 realname-settings 缓存项(**与 F17 同区,合并修**) | D |

> 说明:**F15/F16 同位**(`recruitment-promotion.service.ts:83-94` 的同批 openid)——一为测试缺口、一为 N+1,可一并处理(批内 openid 去重 + 单次 findMany 同时解两者)。**F17/F19 同区**(deployment.md 扩容 checklist + realname 缓存),合并一次 true-up。

---

## 4. 附:复核为真但无运行时危害(dismissed 中的 doc-drift;纯随手 true-up,不计入 19 主清单)

这些经独立 verify 确认事实属实但 `real=false`(无可构造失败场景),归「随手 true-up」而非 finding:

- **`biz-code.constant.ts:6` 头注释计数陈旧**:「141 个 BizCode 覆盖 21 段」实际已 ~157-162 码(保险后 + sms/wechat/realname/recruitment/team-join 多段);无重号、无功能影响,仅文件头注释 stale。
- **`prisma/seed.ts:2006` biz-admin 绑定注释**:「50 条=51 过滤」与「48/47」「upsert 48 条」多处旧计数(实际 58 码/绑 57);与 **F13** 同源(F13 是持久化 description 升 A 档,这些是源码注释)。
- **`prisma/seed.ts:1920-1923` team-join 注释**:T2 期写的「team-join-application 3 码」头注释,T4 落 join.member 后未更新为 4。
- **`maskIdCard` 两实现形状不同**(`common/audit/mask-pii.util.ts:56` 保留前 6 位 vs `realname.constants` 前 3 位):写入同一 `audit_logs` 表但**掩码更严的一方不构成泄漏**,无害;可统一口径(低优一致性)。
- **`app-team-join.dto.ts:4` 跨 surface 复用 `GateStatusDto`**:App 出参 import admin 文件定义的 `GateStatusDto`——是**中性值对象**(无 L3、无 admin-only 字段),非「派生 admin 实体 DTO」,不违 DTO 隔离铁律;演化风险低,可留注记。
- **`deployment.md:7`「8 限流器」**:与 **F17** 同(已并入 F17 修法)。

---

## 5. 维度 × 模块覆盖矩阵(自证无漏扫)

> 每模块被 ≥1 相关维度覆盖;一致性/架构/测试/性能/依赖/运维/文档为**全仓**横扫(下表列 finder 实际命名审查到的模块,横扫维度另覆盖未列出的低风险 CRUD 模块)。

| 维度 | 覆盖模块(finder 命名) |
|---|---|
| 安全 | auth · permissions · users · members · member-departments · member-profiles · emergency-contacts · certificates · insurances · attachments · attachment-configs · storage · sms · wechat · realname · recruitment · team-join · notifications · audit-logs(19) |
| 正确性·健壮性 | recruitment · team-join · attendances · contribution-rules · insurances · activities · activity-registrations · attachments · storage · dictionaries · organizations(11) |
| 数据·合规 | recruitment · member-profiles · team-join · audit-logs(+ 跨模块 mask 工具)(4) |
| 架构·边界 | attendances · users · attachments · activity-registrations · team-join · recruitment · insurances · realname(+ 全仓 surface/boundary)(8) |
| 一致性 | 全仓 BizCode · RBAC seed · RBAC_MAP · CODEMAP · current-state · check 脚本 · auth/users/certificates/insurances/realname/sms/wechat/recruitment/team-join/ai(10+) |
| 测试 | recruitment · team-join(+ god-service characterization 抽样)(2,重点新模块+多写路径) |
| 性能·可扩展 | attendances · activities · activity-registrations · insurances · members · permissions(rbac-cache)· notifications(cron)· recruitment · team-join · sms/wechat/storage/realname(settings 缓存)· bootstrap(13) |
| 依赖·供应链 | package.json · pnpm-lock · auth(bcryptjs)· storage(cos)· wechat/realname(native fetch)· notifications(@nestjs/schedule pin)(全仓) |
| 运维就绪 | bootstrap(main/crash/global-setup/throttle/logger/swagger)· config · ops/ 五 SOP · deployment · notifications · realname-settings · seed fail-fast · Dockerfile · docker-smoke(全仓) |
| 文档·债务 | current-state · NEXT_TASKS · RBAC_MAP · architecture-boundary · seed · biz-code · audit-logs · team-join(全仓) |

**覆盖核验**:27 模块中 26 被直接命名;唯一未命名 `health`(live/ready,无 service,模块结构例外,无 finding 预期)。`ai` = 占位(仅 README、零代码、未注册,CODEMAP 标「本期不实现」)→ N/A。**无漏扫模块。**

---

## 6. 新发现 vs 已知 对账

- **confirmed-known = 0**:finder + verifier 正确把以下「已登记已知/已接受」识别为**不报**:god-service 体量(§4 / architecture-boundary)、service 单测 ~11.8%(§4 刻意策略)、contract snapshot ~1MB(§4)、Mixed controller 存量 2(api-surface-policy §5.1)、招新同轮去重枚举面 28003(§4 P3 已接受)、外籍手动建档边界(§3/§4)、身份证明文 C-8(§3)、retention 手动 SOP 不解锁 cron(§3/§4)、flaky auth-jwt-guard(§4)、单实例假设(§2 / deployment)。
- **19 条均为新发现**(未在 §3/§4/AGENTS/boundary/surface 基准登记);其中 F17/F19 是「单实例 checklist」已知主题下的**具体遗漏点**(已知主题 ≠ 已登记该遗漏),仍计新。
- **建议**:F7(付费核验 cost-DoS 角度)若运营确认不修,应入 §4 债务表登记(与 28003 枚举面同处理),避免下次 review 重报。

---

## 7. 修复分批建议(供 review-then-fix goal 立项;本 goal 不修)

| 批次 | finding | 档 | 备注 |
|---|---|---|---|
| **安全硬化批**(优先) | F1(RBAC 分级闸)· F2(attachment key 约束) | B(权限/签名边界事实变更,补 e2e) | F2 必在 COS 接通前修 |
| **依赖 CVE 批** | F5(multer)· F6(COS SDK)· F18(audit 门禁) | B | overrides 重锁 + CI audit gate;COS/真通道接通前必清 critical |
| **promote 健壮批** | F3 · F8(字典校验)· F9(口径分叉)· F12(即时清漏)· F15+F16(同批 openid 去重 + N+1) | A/B | 多数同文件 `recruitment-promotion.service.ts`,可一刀 |
| **participation 并发批** | F4(attendance 时间窗死锁)· F11(容量竞态) | B | 需评审定调修法(行锁/软删对称) |
| **attachments 健壮批** | F10(confirm owner 复查) | B | 可并入未来 attachments 批 |
| **文档 true-up 批** | F13 · F14 · F17 · F19 + §4 doc-drift | A | 纯 docs,无运行时;可一次随手清 |

> 每批应循 `process.md` 单独立项;B/D 档需维护者拍板,A 档 docs 沿惯例。**本报告不构成任何 fix 授权。**
