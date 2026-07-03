# SRVF 全仓多维度系统性 review 报告(v0.34.0 base,第二轮)

> **状态:冻结**(2026-07-03;goal「全仓多维度系统性 review 第二轮(v0.34.0 + #482/#483 base)— 只审不修,产出冻结报告」拍板)。
> **性质**:**A 档只读审查**——本 goal **不改任何代码 / schema / seed / docs**(本报告除外);**修复另起 review-then-fix goal**(按本报告 §7 分批,沿上一轮 #399→#400-#413 范式)。
> **base**:`main` HEAD `082b5477`。比 `v0.34.0` tag(指向 bump `059a68ed`)新两个已合入 `## Unreleased` 的收口 PR:#482(摘码微刀,rbac-only)+ #483(终批收口,docs-only);尚未 version-bump 发版。0 open PR / 工作树 clean(runner 亲核,非转述)。
> **方法**:29 个「维度」对抗式 finder,拆成 2 个并行 workflow ——**L1 判权终态深审**(8 维度,首次对终态 scoped-authz 判权路径整体横切,effort=high)+ **L2/L3/L4 模块与横切扫描**(12 个新/改模块系统过 + 5 项全仓横切不变量 + 4 项存量面抽查)。每条候选 finding 独立对抗 verify(real ∧ isNew 才 confirmed;**P0/P1 候选自动升级为 3 票独立多数决**,本轮触发 1 次)。另有 102 条「红线肯定性证据」逐条亲核(非「找 bug」,而是反向证明不变式当前仍然成立)。合计 **61 agents / ~6,682,523 tokens / ~2,169 tool-uses**。对账基准:`docs/current-state.md` + `docs/ai-harness/NEXT_TASKS.md` + `docs/ai-harness/RBAC_MAP.md` + `AGENTS.md` + 上一轮 [`full-repo-systematic-review-v0.26.0.md`](../archive/reviews/full-repo-systematic-review-v0.26.0.md)——**已登记的已知 / 已接受项不重复报**。
> **冲突优先级**:本报告让步给 `AGENTS.md` / baseline / 各权威源;仅作审查证据,不覆盖任何铁律,不构成 fix 授权。

---

## 🔴 P0 / P1 置顶

**0 P0(可利用安全漏洞 / 数据破坏风险)/ 1 confirmed P1。** 已在发现当下第一时间人话简报给用户,未等报告写完;以下是该发现的完整记录。

### G1 — 真实队员 PII(姓名 + memberNo)已进入公开仓库 git history

| 项 | 内容 |
|---|---|
| **文件** | `docs/archive/reviews/org-position-scoped-authz-terminal-design-review.md`(主体)+ `prisma/seed.ts:776`(次要,单一姓名字面量,同一条规则的最小回声) |
| **现象** | 冻结的 T0 架构评审稿(终态 scoped-authz 序列的立项设计文档)自称数据来源为「真实任命公告《深圳市公益救援志愿者联合会 2026 年任命公告》」,文中系统性出现 10+ 位队员真名(明细见 git history,不再复述),并与真实 `memberNo`、真实部门 / 组织代号成对出现,用来验证设计对真实组织结构的适配性。`prisma/seed.ts:776` 注释里单独出现一例真实姓名,是同一违规的最小回声(单一姓名,无编号)。 |
| **为何是红线** | 直接命中项目自定 R13 / A-9 红线(`docs/V2红线与复活路径.md`):「真实成员 PII(姓名 / 身份证号 / 手机号)+ 真实编号规则与样例(memberNo)不进 git history」。runner 亲核仓库可见性:`gh repo view --json visibility` → `BA7IEE/srvf-nest-api`,**`PUBLIC`**。该内容自 2026-07-01(`139dffe0`,PR #464 T0 冻结)起进入 git history,并原样保留在当前 HEAD(`082b5477`,2026-07-03 终批收口 PR #483)——**不是历史遗留的一次性问题,是此刻仍然存在的公开暴露**。 |
| **严重度判定依据** | 判定为 **P1** 而非 P0:不是可被利用的代码安全漏洞,不是数据破坏风险(P0 定义范畴);是对项目自身数据合规红线的现行违反,牵涉真实第三方(救援队志愿者,非本仓库协作者)隐私,3 个独立复核者一致 `CONFIRMED` + `isNew:true` + `mustFixBeforeLaunch:true`(3 票全真实全新,无需再升级)。 |
| **本 goal 已采取的行动** | **无代码 / 文档改动**——严格遵守本 goal「只审不修,连 typo 都不顺手改」的授权边界,即便 `seed.ts:776` 只是单个字面量、修复成本极低,也未动;发现的第一时间已在会话中向用户人话简报(见对话记录),未等报告写完。git history 改写属于本仓库 git 安全铁律里明确要求「先说明风险并等用户拍板」的动作,更不可自行处理。 |
| **待用户拍板的选项** | (a) **前向修订**:替换为占位符,写一个新 commit,但不移除历史(clone 到旧 commit 仍能看到原文)。(b) **history rewrite**:用 filter-repo/BFG 彻底移除,但需要强制推送 + 协调任何已存在的 fork/clone,是破坏性操作,按本仓库 git 安全铁律需要显式用户授权才能执行。(c) **显式记录为已接受例外**:若维护者判断这批任命信息本就是队内可公开的正式任命、暴露可接受,应在 R13 权威源或本文档内显式补一条例外声明,避免下次系统性审查重复上报同一条。 |
| **处置(2026-07-03)** | 选项(a)前向修订已执行(本 PR);历史保留已知悉;如需彻底清除=转 private/联系 GitHub Support,另行立项。 |

---

## 0. 结论(TL;DR)

- **0 P0 / 1 confirmed P1(见上)。** 终态 scoped-authz 序列(PR1–PR12 + 摘码微刀 #482 + 终批 #483)经首次整体横切深审,**判权路径本身(schema / seed / AuthzService / ResourceResolver / 消费者接线 / 第三条通路)未发现任何可利用的越权或数据破坏缺陷**;唯一的 P1 是数据合规问题(R13 PII 泄漏),与判权正确性无关,不影响"谁能做什么"这条主线的可信度。
- confirmed-new 共 **29 条**(P0 0 / **P1 1** / **P2 9** / **P3 19**),另有 **1 条 known-duplicate**(final-reject 无自审 / 同人约束的不对称设计,复核确认是既有 e2e 锁定行为,非新发现)。
- **L1 判权终态深审(8 维度)零 P0/P1**:第三条终审通路排查(role-bindings CRUD 能否绕出提权)、`/authz/explain` 端点信息泄露排查、participation 24 位点 ref 矩阵逐点核对、防枚举回退顺序核对均通过。L1 唯一 3 条 confirmed 均为 P3(SA 短路诊断可解释性小缺口 / 22074-22075 优先级测试覆盖盲区 / RoleBinding 创建时校验不完整但判权时动态复核完全兜底)。
- **最值得先看的 P2**(9 条,详见 §2):① `notification_type` 字典缺防误删守卫(G2)② recruitment 三个写端点绕过 `read.sensitive` 脱敏闸,PII 明文可能被非预期角色回显(G4,与 G1 同族但独立成因,值得放在一起复核)③ OCR 裁剪图落图失败会产生存储孤儿(G3)④ memberships 写路径审计留痕缺口(G5)⑤ role-bindings PATCH 任期 / 状态自相矛盾组合未拒绝(G7)⑥ announcement-import 组织行 already-exists 分支校验不足、可能挂错父组织(G8)+ DTO 层格式错误会整批 400(G9)⑦ 两条新增未登记依赖 CVE(G10:qs + js-yaml)⑧ position-assignments 模块头注释与 PR8 后事实矛盾、可能误导未来维护判断(G6)。
- **0 confirmed-known**:29 条 confirmed-new 中没有一条是把 §6 已登记的已知 / 已接受项误报为新 finding;唯一 1 条 known-duplicate 被正确识别为既有 e2e 锁定的既有设计,未混入主清单。
- **覆盖**:L1 8 维度全部命中判权核心的 12 个焦点文件簇;L2 12 模块系统过覆盖 scoped-authz 序列全部 6 个新模块(positions / position-assignments / supervision-assignments / role-bindings / authz / announcement-import)+ content / 字典守卫 / OCR 两版 / notifications S1-S5 / recruitment phase-4 / memberships;L3 5 项横切不变量(死码 / 文档漂移 / 测试健康 / 依赖审计 / NEXT_TASKS 残余)全跑且部分项目**亲自实跑**(e2e / pnpm audit / jest --listTests)而非仅静态阅读;L4 4 项存量抽查(auth / attachments / insurance / audit-logs)零回归。见 §5 矩阵自证无漏扫。
- **共性根因**:29 条 confirmed-new 集中在两类——① **文档 / 注释与代码事实的漂移速度跟不上 scoped-authz 序列 12 刀的推进速度**(G6、G15、G20-G24、G26、G27,共 9 条,全部 P2/P3,无一处造成实际运行时危害)② **新表 / 新端点的边界条件细节(PATCH 一致性、已存在分支校验、审计留痕)在快速迭代中留了小口子,但均被判权 / 事务主路径之外的兜底吸收、未产生真实越权**(G3、G5、G7、G8、G9、G13、G16 等)。真正独立于这两类根因之外、需要认真对待的是 G1(数据合规)和 G4(脱敏闸绕过,PII 相关)。

---

## 1. 计数

| 项 | 值 |
|---|---|
| finder(维度) | **29**(L1 判权终态深审 8 + L2 模块系统过 12 + L3 横切不变量 5 + L4 存量抽查 4) |
| workflow / agents / tokens / tool-uses | 2 个并行 workflow;61 agents;~6,682,523 tokens;~2,169 tool-uses |
| 候选 finding(去重前 / 后) | 30 / 30(L1 4 + L2/L3/L4 26;跨维度未见重复候选,去重前后一致) |
| 进入对抗 verify | 30(100%;P0/P1 候选额外升级为 3 票独立多数决,本轮触发 1 次即 G1) |
| **confirmed-new** | **29**(P0 0 / **P1 1** / **P2 9** / **P3 19**) |
| confirmed-known(复核为真但已登记) | 0 |
| known-duplicate(复核为真,但与既有 e2e 锁定行为属同一事实) | 1(final-reject 无自审约束的设计不对称;P3 口径,归 §6,不进主清单计数) |
| dismissed(复核 real=false) | 0 |
| 红线肯定性证据条目 | **102**(L1 31 + L2/L3/L4 71);**100 holds:true / 2 holds:false** |
| 上述 2 条 holds:false | 均已计入上方 confirmed-new,非额外计数:R13 零真实数据(→ G1)、字典防误删守卫覆盖完整性(→ G2) |
| NEXT_TASKS P2-6 / P2-7 残余状态复核 | 7 项逐项复核(见 §6),另新增 2 项依赖审计发现未登记在此 7 项范围内 |

亲核自证(本轮 runner 直接执行,非转述):

| 检查项 | 结果 |
|---|---|
| `git status` / `git branch --show-current` / `git rev-parse HEAD` vs `origin/main` | HEAD = origin/main = `082b5477`,工作树 clean |
| `gh pr list --state open` | 0 |
| `pnpm docs:rbacmap:check` | 0 FAIL / 1 WARN(`membership.read.record` 预埋孤码,预期)/ 1 INFO / 6 PASS |
| `pnpm docs:codemap:check` | 0 FAIL / 1 WARN(6 个 god-service 体量观察,预期)/ 1 INFO(4 个 500-700L 大文件观察)/ 5 PASS |
| `pnpm lint` | 0 错误 |
| `pnpm typecheck` | 0 错误 |
| 干净库(`app_test`)重放全部 38 个 migration | **零报错**(`pnpm db:test:reset`,经用户显式同意执行 —— Prisma 检测到 `migrate reset` 由 Claude Code 调用会硬阻断并要求实时同意,不接受 goal 文本的预先授权) |
| seed 二跑 diff | **除预期的「admin 用户已存在」提示行外逐字节相同**;两次运行的角色绑定数(ops-admin 91 / biz-admin 72 / org-admin 56 / group-manager 22 / org-supervisor 4 / attendance-final-reviewer 3)均与声称基线精确吻合 |

---

## 2. P2 findings(9)

| # | 维度 | file:line | 问题 | 建议修法 | 档 | 上线前必修 |
|---|---|---|---|---|---|---|
| **G2** | l2-dict-guardrails | `src/modules/dictionaries/dictionaries.service.ts:70` | `notification_type` 字典类型是 seed 内置闭集(2026-06-25 PR #449 引入,用 `assertNotificationTypeValid` 硬校验),但未登记进 `SYSTEM_PROTECTED_DICT_TYPES` / `ITEM_PROTECTED_DICT_TYPES`,R13 防误删守卫对它完全失效 | 把 `notification_type` 加入两个保护集合(约 101/129 行附近),并在 seed.ts 对应条目注释里补登记说明,与 `org_establishment_status`/`recruitment_stage` 等其他闭集写法保持一致 | B | 否 |
| **G3** | l2-ocr-two-versions | `src/modules/recruitment/recruitment-applications.service.ts:341` | 裁剪图 / 头像图 `storeCropImage()` 调用位于 tx try/catch 块之外,storage 写失败时不会触发既有 orphan 清理,违反本模块自己文档化的 FM-B 保证(评审稿明确写「落图失败走既有 orphan 清理范式」) | 把第 330-352 行(主证件照 + 两次 `storeCropImage`)整体挪进 try 块内,或单独包 try/catch 对已成功的 key 做 best-effort 补偿删除后再抛出 | B | 否 |
| **G4** | l2-recruitment-phase4 | `src/modules/recruitment/recruitment-application-review.service.ts:99`(另 253;`recruitment-applications.service.ts:627`) | `markThreshold` / `evaluate` / `resolveManual` 三个写动作端点响应一律硬编码 `toAdminApplicationDto(updated, false)`(`masked=false`,恒明文),完全不检查调用者是否持有 `recruitment-application.read.sensitive`,与模块自身在 `detailForAdmin`/`exportApplicationsCsv` 严格执行的分级铁律矛盾 | 三处补一次 `rbac.can(user, 'recruitment-application.read.sensitive')` 判定后传 `toAdminApplicationDto(updated, !canSensitive)`,与既有两处同口径。**处置(2026-07-03):已修(本 PR)** | B | 否 |
| **G5** | l2-memberships | `src/modules/member-departments/memberships.service.ts:107` | memberships 面(create/update/end)与旧 member-departments 面(set/remove)写路径均未接入 `AuditLogsService`,而同批次三个架构姊妹表(PR4/PR5/PR6)全部对任命 / 撤销类写操作接入了 audit | 沿 position-assignments/supervision-assignments 的 inline-in-transaction 范式补齐 audit,或在 RBAC_MAP/NEXT_TASKS 显式记为已知裁剪 | B | 否 |
| **G6** | l2-position-assignments | `src/modules/position-assignments/position-assignments.service.ts:21`(同款措辞另见 supervision-assignments.service.ts:33) | 模块头注释断言「本表绝不被任何 rbac.can / AuthzService 判权路径读」,但 PR8 起 `AuthzService.collectGrants()` 实际把该表现读作三源归集之一(3a 主体绑定 + 3b 职务推导的输入),与自身 `authz/CLAUDE.md` 公开设计矛盾,可能误导未来维护者以为改动此表与判权无关 | 把措辞改精确为「本表自身 CRUD/校验逻辑不读角色/权限表(单向);但 PR8 起 AuthzService 会读本表做 grant 推导输入,任职生命周期变化直接联动授权结果」,supervision-assignments 同款措辞一并校准 | A | 否 |
| **G7** | l2-role-bindings | `src/modules/role-bindings/role-bindings.service.ts:292` | `update()` 任期校验只做 `endedAt>startedAt` 相对关系检查,不与「当前时间」/「status」做一致性校验,允许写入 `status=ACTIVE` 但 `endedAt` 仍是过去时间的自相矛盾记录,且不会自动清空过期 `endedAt`;运营 PATCH 想重新激活会 200 成功但权限依旧不生效(判权时 `isWithinTerm` 仍判 false),且没有护栏提示这个矛盾 | 补一致性校验:`status===ACTIVE` 且 `endedAt` 已过期则拒绝(或要求同次 PATCH 显式带新 `endedAt`),或自动清空过期 `endedAt`(涉及判权语义变化需按 D 档评估) | B | 否 |
| **G8** | l2-announcement-import | `src/modules/announcement-import/announcement-import.service.ts:306` | 组织行 already-exists 幂等分支只比对 `code` 唯一性冲突,从不校验命中的既有组织 `nodeTypeCode`/`parentId` 是否与本行意图一致,就把其 id 写入 `orgCodeMap` 供本请求后续 positions[]/supervisions[] 引用;误写 / 复用一个已存在但语义不同的组织 code(如撞到 seed 内置 16 个真实缩写之一)会把任职 / 分管行静默创建到无关组织上而非报错 | already-exists 分支追加 `nodeTypeCode`(及可选 `parentId`)一致性校验,不匹配则改判 `blocked` | B | 否 |
| **G9** | l2-announcement-import | `src/modules/announcement-import/announcement-import.dto.ts:23` | DTO 头部注释声称行内字段「缺字段 / 写错」都不应让 class-validator 把整批请求 400 掉,但实测只有「缺字段」成立(全部 `@IsOptional()`);字段存在但格式错误(如非法日期字符串)会让 `ValidationPipe` 把整批一次性 400 掉,不会走到 service 层逐行 `blocked` 分类,与自身注释矛盾 | 修正注释措辞承认这一权衡,或把行内格式校验下沉到 service 层自行 try/catch,与既定「完整性判断下沉 service」设计对齐 | B | 否 |
| **G10** | l3-dependency-audit | `package.json`(生产依赖树) | 亲跑 `pnpm audit -P` 发现两条此前未登记的 moderate CVE:`qs@6.15.1`(经 `@nestjs/platform-express>express`,DoS)+ `js-yaml@4.1.1`(经 `@nestjs/swagger`,DoS),均经核心框架依赖链、生产可达;NEXT_TASKS.md P2-6 此前只登记过 fast-xml-parser(COS 树)+ fast-uri/form-data(dev 树)三项,未提及这两条 | 沿用 PR #401 已确立的 `pnpm.overrides` 模式新增两条覆盖(`qs`/`js-yaml`),跑通 build+lint+typecheck+相关 e2e 后独立收口登记 | B | 否 |

---

## 3. P3 findings(19)

| # | 维度 | file:line | 问题 | 建议修法 | 档 |
|---|---|---|---|---|---|
| **G11** | authz-service-core | `src/modules/authz/authz.service.ts:145` | SUPER_ADMIN 短路路径在 ref 解析失败(资源不存在 / 已软删)时不 fail-close 到 `resource_not_found`,而是直接 `super_admin_pass` 放行,与非 SA 路径行为不对称;仅影响诊断可解释性(explain 端点),真实业务消费者(finalApprove/finalReject)因 ref id 与实际操作 id 同源不受影响,无越权路径 | 若诊断精确性重要,可让 SA 短路分支在 ref 解析失败时也归因 `resource_not_found`;当前设计是刻意的(注释「解析失败不掀翻短路」),建议向维护者确认是否已拍板过 | — |
| **G12** | attendance-final-review-wiring | `src/modules/authz/action-constraints.spec.ts:42` | 「自审 + 同人同时命中时 22074 优先于 22075」的判定顺序无任何测试锁定(unit/e2e 均只各自独立设置字段);若未来重构约束注册顺序,不会有任何绿灯测试捕获这个静默行为变化(两种顺序结果都是 deny,不是 allow/deny 翻转) | 补一条测试用例显式断言两约束同时命中时的优先级 | B |
| **G13** | third-path-privilege-escalation | `src/modules/role-bindings/role-bindings.service.ts:104` | 建 `POSITION_ASSIGNMENT` 主体绑定时,存在性校验只过滤 `deletedAt`,不校验 `status=ACTIVE`,可对已 REVOKED/ENDED 但未软删的任职建立绑定;经证实该绑定在判权时被 `AuthzService.collectGrants()` 的动态复核完全兜底(`assignmentValid` map AND 运算),永不参与 allow,不构成可利用提权 | 收紧创建时校验完整性(非安全必需),避免运营侧误建无效绑定产生困惑 | — |
| **G14** | l2-content | `src/common/exceptions/biz-code.constant.ts:1043` | `CONTENT_VISIBILITY_INVALID`(29011)是死码:在 controller 的 `@ApiBizErrorResponse` 里被引用暗示会返回,但 DTO 的 `@IsIn` 校验会让非法值在 ValidationPipe 阶段就被拦下,实际走通用 400;模块自己的 e2e 已证实并断言 400 而非 29011 | 从 `@ApiBizErrorResponse` 移除该码(契约如实反映),或加注释说明当前不可达属预留 | A |
| **G15** | l2-memberships | `src/modules/member-departments/memberships.controller.ts:1` | 「PR2 全量重指向几个消费者」的口径在不同文档间有「8」vs「9」的措辞差异,经核实是计数口径不同(按模块槽位 vs 按文件数)对应同一组文件,无遗漏也无幻影消费者,纯文字歧义 | 非必须;若顺手可统一措辞为「9 个消费者文件(team-join 贡献 2 个)」 | — |
| **G16** | l2-role-bindings | `src/modules/role-bindings/role-bindings.service.ts:92` | `validatePrincipalOrThrow` 对 `USER` 主体只校验 `deletedAt:null`,不像 `UserRolesService` 那样同时要求 `status:ACTIVE`,允许给 DISABLED(未软删)用户建绑定;经证实 `JwtStrategy.validate()` 是全仓唯一鉴权查库点、对任何请求先校验 `status===ACTIVE`,DISABLED 用户的后续请求在鉴权阶段即被 401 拦截,不构成可利用路径,只是与姊妹写入路径校验粒度不对称 | 若为「预置绑定,账号恢复后自动生效」的有意设计,建议补注释说明,避免被误判为遗漏后「顺手」加上 status 校验导致预置场景回归 | A |
| **G17** | l2-authz-agents-lens | `src/modules/authz/authz.service.ts:413` | `covers()` 与 `coversGeometrically()`(453 行)两个 `switch(scopeType)` 语句体几乎逐分支重复,未来新增 scope 类型可能只改一处漏改另一处,导致 `expired_grant` 归因逻辑与真实 covers 判定悄悄失步(仅影响错误归因准确度,不影响 allow/deny 结果) | 非本刀要求;未来触碰此文件时可抽取共享几何匹配辅助函数消除重复 | A |
| **G18** | l2-announcement-import | `src/modules/organizations/organizations.service.ts:246` | `OrganizationsService.create()` 全程无 audit 写入,是 PR1 遗留的既有决策(模块 CLAUDE.md 已记录、非 PR11 新引入),但 PR11 是第一个把这条路径推到批量规模(单请求最多 200 行)并用于真实公告场景的调用方,放大了「谁在何时批量建了哪些组」缺失审计轨迹的实际暴露面 | 非本 PR 必须解决;如需补应在 `organizations.service.ts` 独立立项(同时惠及既有端点),不应在 announcement-import 内单独造一份 audit 逻辑 | C |
| **G19** | l3-dead-code-orphan-inventory | `src/modules/organizations/organization-closure.util.ts:11` | `export interface ClosureEdge` 从未被本文件之外任何文件按名导入,是可安全去掉 `export` 的孤立类型标注,纯 cosmetic | 改为不带 export 的本地 interface,或保持现状不改 | A |
| **G20** | l3-doc-drift | `src/modules/authz/CLAUDE.md:44` | Validation 小节写「路由 290 恒定」,当前实际 `EXPECTED_ROUTES` 为 292(PR11 +2 后未回填,PR12 维持 292 也未回填) | 改为 292,或改引用数组长度而非写死数字 | B |
| **G21** | l3-doc-drift | `docs/ai-harness/README.md:59` | 描述 RBAC_MAP.md 时写「76 权限码全集」,实际当前 191,相差 115 条(超 2.5 倍),该行自 2026-06-10 起从未更新 | 改为 191,或改用不写死数字的自愈式表达 | C |
| **G22** | l3-doc-drift | `docs/ai-harness/README.md:55` | 「定位路径」一句列举模块级 CLAUDE.md 写「9 个」,实际已有 10 个(遗漏 authz、announcement-import 两个 scoped-authz 序列新增模块) | 更新为「10 个」并补上两个文件名 | C |
| **G23** | l3-doc-drift | `docs/current-state.md:93` | §4 债务表「god-service 体量观察」行的 LOC 数字与当前实际全部不符(如 attendances 1285L→实际 1428L),且遗漏因 PR12 新晋 god-service 候选的 `activities.service.ts`(722L) | 用 `pnpm docs:codemap:check` 实时输出重新 true-up,并补 activities.service.ts 进观察清单 | C |
| **G24** | l3-doc-drift | `docs/handoff/admin-web.md:76` | §2.5 通知管理小节标题写「✅ S1+S2+S3+S4+S5 后端就绪(本 PR,Unreleased)」,但该模块早已 v0.32.0 正式发版,标题单独进入时缺乏历史时态上下文,易误导前端联调计划 | 改为「(v0.32.0 已发)」或删除时态标注 | C |
| **G25** | l3-dependency-audit | `package.json`(COS SDK 传递依赖) | `cos-nodejs-sdk-v5` 依赖的 `request@2.88.2`(upstream 已弃用,永久无补丁)及其自身传递依赖(`tough-cookie`/`ajv`/`qs`/`uuid`)携带 4 条未被 NEXT_TASKS 逐一点名的 moderate CVE(SSRF/原型污染/ReDoS/缓冲区越界) | 短期对仍有补丁版本的子项追加 scoped override;`request` 本身无解,需等 COS SDK 上游换传输层;登记入 NEXT_TASKS 明确标注「upstream 永久无解」而非「待发版」 | — |
| **G26** | l3-next-tasks-residual-status | `docs/ai-harness/NEXT_TASKS.md:44` | P2-6 F1(`attachment.*.other`)条目两处事实描述已过时:计数「11 条」自写入之日起就是错的(实测 8 条);「当前 seed 不绑任何 meta 角色」在 PR7 后不再成立(`group-manager` 现绑定其中 4 条,是设计内决定) | 更正计数为 8,并补充 group-manager 已绑定 4 条这一既有事实,避免未来处理该遗留项时从错误前提出发 | C |
| **G27** | l3-next-tasks-residual-status | `docs/ai-harness/NEXT_TASKS.md:52` | F13(`BIZ_ADMIN_DESCRIPTION` 计数过时)已被 2026-07-03 摘码微刀 PR #482 顺手解决,seed.ts 内文本现已与实际绑定数完全一致,该 P2-7 残余项应标记完成而非继续挂账 | 补一行「✅ 已于 #482 顺手校准」,移入已完成项归档区 | A |
| **G28** | l4-auth-refresh-token | `AGENTS.md:350` | §9 联动撤销五场景条目声称 `audit extra.refreshTokensRevoked` 对全部 5 场景「必写」,实际代码只在 3/5 场景写该字段;`admin-disable`/`admin-delete` 两场景刻意不写 audit(有历史拍板依据),与紧邻的 audit 写入清单本身是一致的,只是 line 350 措辞对自身下一段过度概括 | 把「必写」改为精确列出 3 个场景,并注明另 2 个场景刻意不写 audit 的依据 | A |
| **G29** | l4-attachments-signed-url | `test/e2e/attachments.e2e-spec.ts:518` | F2(attachment key 命名空间正则)的 6 种坏 key 拒绝矩阵只曾用 `ownerType='member'` 跑过,`content-image`/`content-file` 从未在 mode-A `create()` 端点下被同一矩阵覆盖;未来若给 content-* 特殊处理跳过 F2,不会有测试捕获 | 补一条 it.each 用例对 `content-image`/`content-file` 复跑该矩阵 | C |

---

## 4. 复核为真、无当前运行时危害(102 项红线证据核验)

> 与「找 bug」相反的证明工作:对每条声称的不变式,亲自去代码 / migration / 实跑测试里找「此刻仍然成立」的确凿证据,而非信任历史文档的过去声称。**100/102 holds:true,2/102 holds:false**(已计入 §2/§3 的 G1、G2,不重复列)。

### 4.1 goal 明确要求的 6 项红线亲核

| # | 不变式 | 结论 | 证据位置 |
|---|---|---|---|
| 1 | **RbacService GLOBAL-only** —— 全局判权唯一出口(含 rbac-cache 失效查询、user-roles CRUD)只读 `scopeType=GLOBAL` 的 RoleBinding,从不消费任何 scoped 类型 | ✅ holds | `rbac.service.ts:85-93`(`getUserPermissionCodes`)+ `:264-271`(`getEffectiveRoles`)均显式 `scopeType: BindingScopeType.GLOBAL` 过滤;`rbac-cache.service.ts:76-90`、`user-roles.service.ts:64-72`(`activeGlobalUserWhere` 私有 helper,被全部 CRUD/复检查询复用,无绕过分支)同款过滤。全仓 `roleBinding.` 调用点 grep 逐一核对,`permissions/` 模块之外全部命中 `authz/` 与 `role-bindings/`(职责内)。 |
| 2 | **R5 副职零 policy 行"三兜底"** —— 副职(vice-captain/dept-deputy/deputy-group-leader)永不产生管理角色推导 | ⚠️ holds,但需精确措辞:实际是**两层独立防线 + 一层设计原则**,不是三层独立**运行时代码**防线。(a) seed-time 运行时断言(`seed.ts:3455-3465`,插入违规行会让 seed 进程非 0 退出,已用真实端到端注入实测触发)+ (b) CI e2e 断言(`seed-position-role-policies.e2e-spec.ts:307-314`,外部黑盒校验,不依赖 seed 内部实现)是两层真正独立的运行时防线。第三层是**设计原则而非代码防线**:`AuthzService.authz.service.ts:322-361` 的 3b 职务推导逻辑对 `PositionCategory` **零字面量特判**——若 seed 数据不干净、真的插入了一条副职 policy 行,判权代码本身不会识别并拒绝它,会被当作正常 grant。这是刻意的「安全默认由数据保证、代码不加头衔特判」设计(`authz/CLAUDE.md` 已如实记录),不是遗漏,但「三兜底」若按字面理解为三层独立代码防御是不准确的。**不构成 finding**(设计已知且已记录),但值得在下次提及此不变式时更精确表述。 |
| 3 | **BD-2 无部门 hardcode** —— 生产代码不出现具体部门字面量(如「APD」) | ✅ holds | `bd2-department-literal-gate.spec.ts:21-83` 全文核实:对 `authz/`+`attendances/` 全部非测试 `.ts` 文件剥注释后断言零 `'APD'` 字面量,豁免仅限 3 个 OpenAPI 文案文件且范围未被扩大。**实跑该 spec**(`npx jest ... bd2-department-literal-gate.spec.ts`,2/2 通过)。独立 grep 复核额外命中的 6 个文件全部在豁免清单内或仅出现在行注释中(用 spec 同款 stripComments 正则在 node 里重放验证)。 |
| 4 | **announcement-import dryRun 真零写入** —— preview 路径不落库,且不遗留 orphan audit | ✅ holds | 三处被复用 service 的 `create()` 均是「**真实执行到底后、提交前主动抛错回滚**」模式(非「提前 return 不写库」):校验 → 真实 `tx.xxx.create()` insert → (任命/分管两者)audit 写入(传同一 `tx`)→ 末行 `if (dryRun) throw new DryRunAbort(result)`;外层 catch 捕获后原样返回响应体,但因 throw 发生在 `$transaction` 回调**内部尚未 commit**,Prisma 整体回滚,写入与同 tx 内的 audit 一并回滚,不留 orphan。 |
| 5 | **防枚举回退一致性** —— `resource_not_found` 判断严格先于且独立于权限判断,无消费点意外颠倒顺序 | ✅ holds | 抽查 `attendances.service.ts`(`assertCanOrThrow` 8 处共用 + `assertFinalReviewAuthzOrThrow` 终审专用)、`activity-registrations.service.ts`(8 处共用)三处实现逐字一致:先 `authz.explain()`,`resource_not_found` 判定发生在 explain() 内部 step 3(第 179-183 行),**严格早于**三源 grant 归集(step 4);消费点侧「回退 rbac.can」是为保留旧契约行为锁,不是绕过防枚举。 |
| 6 | **R13 零真实数据** —— 仓库(含本次新增的 e2e 数据与本报告)不含任何真实 PII | ❌ **holds:false** —— 见 §「🔴 P0/P1 置顶」G1。分类字典内置部分(V2_DICT_SEED / activity_type / SRVF 组织树 16 个真实缩写)本身合规,未发现真实姓名/证件号/手机号;但 `docs/archive/reviews/org-position-scoped-authz-terminal-design-review.md` + `prisma/seed.ts:776` 的真实姓名 + 真实 memberNo 构成对此不变式的现行违反。本报告自身的示例数据(下方 §5/§6 引用)以及本次新跑的 e2e 抽查均确认合成占位(见下 4.2 「双锚不猜名」条目旁的 R13 抽查明细),**不构成新的违反面**。 |

### 4.2 L1 判权终态深审:其余 25 条红线证据(压缩表)

| 维度 | 不变式(压缩) | 证据要点 |
|---|---|---|
| schema-8-tables | `role_bindings_active_unique` 真带 `NULLS NOT DISTINCT` 且真能让 GLOBAL scope 绑定去重 | 静态:migration.sql SQL 原文含该子句。**动态**:在 `app_test` 显式事务内实测插入/冲突/软删释放槽位三组行为,全部符合预期,`ROLLBACK` 收尾未污染测试库 |
| schema-8-tables | 8 表 FK onDelete 逐一核对:仅 `OrganizationClosure` 两条 Cascade,其余全 Restrict;Cascade 分支当前不可达(无任何硬删 Organization 的代码路径) | 7 个 migration.sql 逐条 grep `ON DELETE`;`organizations.service.ts:491` 删除实现确认纯软删 |
| schema-8-tables | 枚举闭集消费方(`covers()`/`coversGeometrically()`/`validateScopeShapeOrThrow` 等)分支穷尽,无遗漏导致静默走默认值 | `authz.service.ts:419-448/453-485` 两个 switch 逐一列出 `BindingScopeType` 全部 6 值;其余枚举二元/三元判等天然穷尽 |
| schema-8-tables | 8 表软删列一致性:仅 `OrganizationClosure` 无 `deletedAt`,且从未被判权路径读作权威源 | schema.prisma 逐模型 grep 计数;closure 读取点均为展示/任命校验/covers() 组织路径判定,真正门禁落在 `Organization.status`+`deletedAt` |
| schema-8-tables | 冻结表验证:`MemberDepartment`/`UserRole` 除迁移期回填 SQL 外,`src/` 全仓 0 处生产读写 | grep 0 命中;判权/memberships 消费者全部核实指向新表;`reset-db.ts` 仍保留旧表名仅为测试基础设施 |
| seed 全集 | R5 layer(a)/(b)/(c) 三层证据(详见 4.1 第 2 项的精确措辞) | 见上 |
| authz-service-core | RbacService GLOBAL-only(与 4.1 第 1 项同一不变式,来源维度不同) | 见 4.1 第 1 项 |
| resource-resolver | 10 个软删模型 + attachment 硬删,resolve() 均对不存在/已软删返回 `null`(fail-close) | 每个 `resolveXxx` 统一 `findFirst({deletedAt:null})` 模式;e2e 逐类标记删除后断言全部返回 null |
| resource-resolver | 未知/未映射类型 + attachment 委派链断裂双重 fail-close | switch default → null;attachment 委派 `if (!delegate) return null` 统一兜底;e2e 覆盖未知类型/未映射 ownerType/委派目标已软删三种场景 |
| attendance-final-review-wiring | 先判码后查单(与 4.1 第 5 项同一不变式) | `assertFinalReviewAuthzOrThrow` switch 仅 3 具名 case + default→30100;e2e 11/11 实测通过 |
| attendance-final-review-wiring | 摘码后 biz-admin 持有者 finalApprove/finalReject 均 30100,单据零变化 | e2e 用例④双重断言 + DB 层显式绑定数断言 `rolePermission.count===0` |
| attendance-final-review-wiring | 真正终审路径只有 SUPER_ADMIN 与 scoped RoleBinding 两条,无第三条 | grep 全仓两码命中仅 4 个非测试文件,判权全部委托同一 `AuthzService.explain`;e2e 验证 scoped 通路命中 + 撤任职即时失权 |
| participation-24-touchpoints | 24 处调用位点总数精确核实(非约数)与冻结稿承诺一致 | `grep -c` 三文件精确 5+8+11=24 |
| participation-24-touchpoints | 「点动作」全部传具体资源 ref,type 字符串与 id 取值均无误用 | 逐一核对 activities/activity-registrations/attendances 全部调用点 |
| participation-24-touchpoints | 「嵌套列表」传父资源 ref;「扁平/create」刻意不传 ref | 同上,无一处分类错位 |
| participation-24-touchpoints | 三文件 `assertCanOrThrow` 私有辅助方法实现逐字一致 | 结构比对:`explain→resource_not_found回退→rbac.can→RBAC_FORBIDDEN` |
| participation-24-touchpoints | `participation-scoped-authz.e2e-spec.ts` 12 用例覆盖范围与自身文档声明一致,未覆盖位点是文档承诺范围外的已知留白 | spec 头部注释显式声明覆盖边界 |
| third-path-privilege-escalation | RoleBinding 建 POSITION_ASSIGNMENT 主体有存在性校验(不能凭空发明 id) | `validatePrincipalOrThrow` 104-111 行,不存在则抛 32020 |
| third-path-privilege-escalation | 创建端不核实 status=ACTIVE(→ 即 G13,已计入 P3) | 见 §3 G13 |
| third-path-privilege-escalation | 换届撤任职即失权:判权时动态核实,非入库时一次性校验 | `collectGrants()` 每次现查任职状态并 AND 运算;e2e「场景4」先建绑定后撤任职,断言立即 `expired_grant` |
| third-path-privilege-escalation | `/authz/explain` 出参不含 L3 敏感字段 | 目标用户 select 仅 4 字段;11 类 resolver select 逐一核对无 passwordHash/idCardNumber 等 |
| third-path-privilege-escalation | `authz.explain.decision` 码仅绑 ops-admin,横向枚举面与其既有读权限范围相称 | seed 绑定核实 + RBAC_MAP 戳文确认;探测面未超出 ops-admin 既有可及范围 |
| redline-affirmative-reverify | 双锚不猜名(announcement-import execute 严格要求精确 memberNo,displayName 仅 preview 侧建议展示) | `resolveMemberAnchor()` 三分支逐一核对,execute 路径无姓名模糊匹配自动落库通道 |
| redline-affirmative-reverify | R13 抽查(5 个新增 e2e spec 的 displayName/memberNo 均为合成占位) | 全部前缀化占位(`rb-e2e-`/`psa-m-`/`AIE2E-`)或通用占位文案,零手机号/身份证号字段;**此项本身是 4.1 第 6 项的一部分证据来源**,seed 内置字典部分合规,但被同一维度发现的 archive 文档违规拉低了整体判定 |

### 4.3 L2/L3/L4:71 条红线证据(按维度归组,压缩表)

> 完整逐条证据文本保留在两个 workflow 的运行记录中(`w0954wgah` / `wii800tr3` 任务输出),此处按维度归组呈现结论性摘要,supporting 全部 holds:true(2 条 holds:false 已在 4.1/§2 单列)。

| 维度 | 已验证不变式数 | 结论摘要 |
|---|---|---|
| l2-content | 4 | 5 档可见性 switch 穷尽 + default fail-close;404 防枚举(非 403);签名 URL 范围例外 a 严格在可见性判定之后才签发;content.* 5 码 + 4 附件码绑定与 seed 一致无死码 |
| l2-dict-guardrails | 3(1 项 holds:false→G1,1 项 holds:false→G2) | `Organization.code` 唯一约束与 16 个内置缩写一致;分类字典 seed 数据本身零真实 PII(仅 archive 文档违规) |
| l2-notifications-s1-s5 | 7 | BizCode 310xx 三字段齐全;P2002 用 `err.code===` 而非 target 误用;Guard 无残留;Effect 严格事务外 try-catch;短信防滥发三层无绕过路径(幂等键按 phone+templateKey 非 notificationId);微信 quota 条件原子无竞态;4 档可见性与 content 5 档共享同一纯函数无第二套逻辑 |
| l2-memberships | 5 | 4 码绑定 seed↔src 双向一致;旧 3 端点行为逐字节不变;9 个消费者全量重指向逐文件核实;partial unique 语义与文档一致;controller 无 @Roles 残留 |
| l2-positions | 10 | 8 码绑定无游离;controller R 模式收口;`POSITION_IN_USE` **实跑 e2e 22/22** 验证真实阻止删除;规则按 nodeTypeCode 过滤正确;两表绝不进判权路径(仅被 assignment/policy 消费定义);软删列 + 查询过滤正确;DTO 白名单阻止维度键改写;P2002 处理安全;BizCode 六码规范;配置面不落 audit 符合先例 |
| l2-position-assignments | 4(1 项→G6 P2) | 5 项任命校验事务内全部真实执行(非仅声明);requireMembership 正确实现 BD-4 祖先集判定;撤销正确写历史行非物理删除;create/revoke 两事件正确写入 |
| l2-supervision-assignments | 5 | create() 绝不校验职务(R5 正交验证,连 mock 都未 stub 任职表);supervision-scope/supervisors 两查询正确使用 closure;partial unique 双重防护(预检+P2002 兜底)真实阻止重复;audit 两事件正确写入 |
| l2-role-bindings | 12(1 项→G7 P2,1 项→G16 P3) | 4 码无死码引用;controller R 模式;BizCode 规范;P2002 用 `target.includes` 而非 `===`(规避整类误用问题);软删过滤正确;create/软删有 audit 且 viaPath 正确区分;update 不写 audit 是文档化既有设计非遗漏;DTO 白名单严格;多写操作全部事务包裹;scope↔字段 6 种类型双向校验完整;principal↔类型 4 分支覆盖;`endedAt<=startedAt` 创建时正确拒绝 |
| l2-authz-agents-lens | 1(→G17 P3) | （其余核对项并入其他维度,唯一独立发现即代码重复观察） |
| l2-announcement-import | 3(2 项→G8/G9 P2,1 项→G18 P3) | （见 §2/§3 对应条目） |
| l3-doc-drift | 3(其余 5 项→§3 G20-G24) | `docs/handoff/openapi.json` 与实际 292 端点契约一致;模块 CLAUDE.md 端点数/权限码数与代码一致;current-state §1 摘要与 CHANGELOG 对应段落一致 |
| l3-test-health | 5 | 全仓 0 处 `.skip`/`.only`/`xdescribe` 等跳过标记;BD-2 CI 闸**实注入违规代码验证会变红**(测后已清理不留痕);等价矩阵断言有独立锚点防「两侧同时错成 all-false」蒙混;PR12「22 个既有 spec 零修改」**用 git show --stat 独立验证为真**;`jest --listTests` 实跑确认 unit 71 / e2e 123 文件,无空文件或损坏文件 |
| l3-dependency-audit | 3(另 2 项→§2/§3 G10/G25) | 已登记的 3 项 dev-only CVE(fast-uri/form-data)现状维持原判;已登记的 cos>fast-xml-parser moderate CVE 现状维持原判;CI 无 pnpm audit 门禁现状维持原判 |
| l4-auth-refresh-token | 4 | rotation always 事务内验证;reuse detection 触发 family revoke 判定顺序正确;5 场景联动撤销逐点 grep 核实;JwtPayload 严格 `{sub,username}` 未被新模块加料;**131 个相关 e2e 实跑全绿** |
| l4-insurance | 3 | self-scope 严格锁 memberId 无 IDOR;requiresInsurance 双路径校验一致;队保单软删不级联覆盖行 |
| l4-audit-logs | 3 | A-1 不可改删(全仓仅 2 处 `.create` 调用,无 update/delete/upsert);scoped-authz 新增 6 事件全部正确接入;8 个新写入位点抽查无未脱敏敏感字段 |

---

## 5. 维度 × 模块覆盖矩阵(自证无漏扫)

### 5.1 L1 判权终态深审(8 维度,深审级,effort=high)

| 维度 | 覆盖对象 | confirmed finding | 结论 |
|---|---|---|---|
| schema-8-tables | 8 张新表 + 7 个 migration.sql + 冻结表验证 | 0 | 5 条红线证据 holds:true |
| seed-positions-rules-policies-roles | 6 职务 / 30 规则 / 3 policy / 7 角色码集 / `BIZ_ADMIN_EXCLUDED_CODES` | 0 | R5 三层证据(见 4.1) |
| authz-service-core | 三源推导 / covers / ActionConstraint / RbacService 不变量 / deny 归因 | 1(G11,P3) | RbacService GLOBAL-only 独立证实 |
| resource-resolver | ResourceResolver 全部资源类型 fail-close | 0 | 10 软删模型 + attachment 硬删 + 委派链断裂三线全 fail-close |
| attendance-final-review-wiring | finalApprove/finalReject 接线、防枚举顺序、22074/22075 判定顺序、第三条通路 | 1(G12,P3)+ 1 known-dup | ④用例 e2e 实测锁定摘码后行为 |
| participation-24-touchpoints | activities/activity-registrations/attendances 24 位点 ref 矩阵 | 0 | 位点数精确核实(非约数)、e2e 覆盖盲区已知登记非本刀 bug |
| third-path-privilege-escalation | role-bindings CRUD 提权面、explain 端点信息泄露 | 1(G13,P3) | 创建时校验缺口经证实被判权时动态复核完全兜底 |
| redline-affirmative-reverify | BD-2/R5/dryRun/防枚举/双锚/R13 六项 | 0(直接产出计入 4.1) | R13 一项与字典守卫维度交叉证实违规(即 G1) |

### 5.2 L2 模块系统过(12 维度,AGENTS 铁律横切级)

| 维度 | confirmed finding | 结论 |
|---|---|---|
| content | 1(P3) | 5 档可见性 / 防枚举 / 签名 URL 范围例外核实通过 |
| 字典守卫(dict-guardrails) | 2(**1×P1**=G1、1×P2=G2) | R13 全仓最严重发现即出自本维度 |
| OCR 两版(realname + recruitment) | 1(P2) | Enable* 开关 / 6 分流 / birth-gender 权威核实通过 |
| notifications S1-S5 | 0 | Effect 事务外 try-catch / 防滥发三层 / quota 原子性核实通过 |
| recruitment phase-4 | 1(P2) | S6 批量脱敏 / S5 志愿者化双兼容核实通过 |
| memberships(PR2) | 2(1×P2 审计缺口 + 1×P3 文档措辞) | 旧 3 端点行为不变 / 9 消费者全量重指向核实通过 |
| positions(PR3) | 0 | 8 码绑定 / 删除守卫(**实跑 e2e**)/ 纯配置不进判权核实通过 |
| position-assignments(PR4) | 1(P2,头注释 doc-drift) | 5 项任命校验 / 撤销历史留存 / audit 核实通过 |
| supervision-assignments(PR5) | 0 | 职务正交 / closure 仅展示 / partial-unique 核实通过 |
| role-bindings(PR6) | 2(1×P2 任期一致性 + 1×P3 USER 校验不对称) | scope↔字段 / principal↔类型校验核实通过 |
| authz(AGENTS 铁律视角,与 L1 的判权正确性视角互补) | 1(P3,代码质量观察) | DTO 校验 / Swagger / 零写入 / 无 audit 刻意性核实通过 |
| announcement-import(PR11) | 3(2×P2 + 1×P3) | preview/execute 复用同校验 / 双锚铁律核实通过 |

### 5.3 L3 横切不变量(5 维度,全仓级,部分亲自实跑)

| 维度 | confirmed finding | 结论 |
|---|---|---|
| dead-code-orphan-inventory | 1(P3) | 24 个新 BizCode(32xxx/33xxx/34xxx+31013)全部有真实 throw 点、0 死码;仅 1 处冗余 export |
| doc-drift | 5(全 P3) | current-state / RBAC_MAP / handoff / 模块 CLAUDE.md 逐项核对;openapi.json 快照本体一致(问题都在 prose 描述层) |
| test-health | 0 | `.skip`/`.only` 全仓 0 残留;BD-2 闸**实注入验证**;PR12 零修改声明**独立验证**;测试文件清单**实跑核数** |
| dependency-audit | 2(1×P2 新增 CVE + 1×P3 COS 传递链) | 亲跑 `pnpm audit -P`,F5/F6/F18 现状复核见 §6 |
| next-tasks-residual-status | 2(全 P3,均为 doc 状态而非新缺陷) | P2-6/P2-7 共 7 项逐项复核见 §6,F13 已修正未回填 |

### 5.4 L4 存量面抽查(4 维度,轻量级,不逐行)

| 维度 | confirmed finding | 结论 |
|---|---|---|
| auth-refresh-token | 1(P3,文档过度概括) | rotation/reuse/5 场景撤销/JwtPayload 零漂移核实通过,**131 个相关 e2e 实跑全绿** |
| attachments-signed-url | 1(P3,测试覆盖盲区) | F2 命名空间正则仍生效,content-* 复用同一套校验 |
| insurance | 0 | self-scope IDOR / 双路径门槛 / 保单软删不级联核实通过 |
| audit-logs | 0 | 不可改删 / 新 6 事件正确接入 / 脱敏核实通过 |

### 5.5 覆盖边界说明(非漏扫的依据)

runner 亲自执行 `git diff --stat v0.26.0..HEAD -- <module>` 核实以下模块在两轮 review 之间**确无实质改动**、故本轮未单独立维度审查不构成漏扫:`ai`(占位,CODEMAP 标"本期不实现")、`health`(live/ready 平凡端点)、`certificates`、`contribution-rules`、`member-profiles`、`storage`、`attachment-configs`、`users`(0 diff)。`emergency-contacts` 有一处 38 行小改动,经 `git log` 核实是上一轮 review 的已知修复(`#404`,F3 promote 绕字典校验),非本轮新工作。`sms`/`wechat` 两模块**确有实质改动**(通知 S2/S5 的 producer 接线——`sendNotification` additive 函数、微信订阅 quota),但已被 `l2-notifications-s1-s5` 维度的 finder 明确要求核对"微信/短信派发是否严格事务外 try-catch",故计入该维度覆盖而非独立列维度。**34 个模块中,无一模块被本轮 L1-L4 完全跳过审查**(直接命中 20 个,间接经 L1 grep 交叉引用或 L4 抽查覆盖剩余全部,8 个零改动模块经亲核确认不构成漏扫)。

---

## 6. 新发现 vs 已知 对账

- **1 条 known-duplicate**:final-reject 方向无自审 / 同人终审约束的设计不对称(`action-constraints.ts:58`)。finder 独立发现并怀疑是安全问题,复核者亲自读代码 + 找到对应 e2e(`attendances-final-review-authz.e2e-spec.ts` 一条具名断言「SA submitter 自 reject → 200」)确认这是 PR8/PR9 期间已拍板、e2e 锁定的既有行为,非新发现。**未混入主清单**,但仍值得维护者知悉:该不对称设计目前依赖「reject 自己的申请没有实质利益冲突」这一未被正式写成安全论证的假设,建议后续找机会把这句话正式补进 `authz/CLAUDE.md`,避免下次 review 重复深挖同一处。
- **0 confirmed-known**:未把任何已登记的已知 / 已接受项误判为新 finding。已正确路由为「已知,不重复报」的项包括(均在 finder/verifier 环节被正确识别,未出现在候选清单里):扁平跨轴列表 GLOBAL-only 限制、legacy `.self` 未迁移 authz、`MemberDepartment`/`UserRole` 冻结待 DROP、`membership.read.record` 预埋孤码、NEXT_TASKS P1-10/P1-14/P1-15、flaky auth-jwt-guard、历史 `claude/*` 远端分支。
- **NEXT_TASKS.md P2-6(4 项)+ P2-7(3 项)残余逐项复核结果**(本轮唯一被要求主动核实现状、而非当作已知项跳过的 7 条):

  | 项 | 现状复核结论 |
  |---|---|
  | P2-6 F1(attachment.\*.other 复核保留集) | ⚠️ **描述已过时**,见 G26(P3):计数「11」应为「8」,且 PR7 后 group-manager 已绑其中 4 条(设计内决定非疏漏) |
  | P2-6 F2(attachment key owner-绑定) | ✅ 现状不变——COS 仍休眠(懒加载默认非 COS,需管理员显式激活),前提「接通前非紧急」仍成立 |
  | P2-6 F5+F6(dev-only CVE:fast-uri/form-data) | ✅ 现状不变,亲跑 `pnpm audit` 确认版本号与登记描述精确吻合;**另发现 2 条此前未登记的生产可达 moderate CVE**(qs/js-yaml,见 G10)不在 F5/F6 范围内,是真正的新增缺口 |
  | P2-6 F18(CI pnpm audit 门禁缺失) | ✅ 现状不变,grep 全仓 CI 工作流确认仍无任何 audit 调用 |
  | P2-7 F7(付费核验 cost-DoS) | ✅ 前提不变,DevStub 仍是默认值,真实腾讯云通道仍未激活 |
  | P2-7 F8(promote 写字典契约) | ✅ 前提不变,`genderCode`/`documentTypeCode` 仍只能是身份证派生的固定 canonical 值,零运行时危害结论仍站得住 |
  | P2-7 F13(BIZ_ADMIN_DESCRIPTION 计数过时) | ✅ **已在 #482 修复,应标记完成**,见 G27(P3) |

- **建议**:F13 应在下次 docs 改动时随手移入 NEXT_TASKS 已完成项归档区;F1 的计数与「零绑定」前提应一并校正,避免下次 attachment.\*.other enforcement 触发评估时从错误起点出发。G10(qs/js-yaml)不属于本次七项复核范围,是本轮依赖审计独立发现的新缺口,已单独计入 §2 主清单。

---

## 7. 修复分批建议(供 review-then-fix goal 立项;本 goal 不修)

| 批次 | finding | 档 | 备注 |
|---|---|---|---|
| **数据合规批**(需维护者先拍板,不是常规代码修复) | **G1**(R13 PII 泄漏) | 待拍板(前向修订 / history rewrite / 显式例外三选一) | 见「🔴 P0/P1 置顶」;优先级最高,但不是"写代码"能解决,需要人的决策 |
| **PII/脱敏硬化批** | G4(recruitment read.sensitive 绕过)+ 顺带复核 G26 提及的 group-manager attachment.\*.other 绑定是否需要同批评估 | B | G4 涉及真实证件号/手机号回显边界,建议与 G1 分开但同一批次窗口处理,便于统一评审隐私相关改动 |
| **判权硬化批**(role-bindings 边界条件) | G7(PATCH 任期/状态一致性)· G13(创建时 status 校验)· G16(USER 主体 status 校验) | B | 三条同文件(role-bindings.service.ts),可一刀;均非当前可利用但值得补齐 |
| **存储/数据完整性批** | G3(OCR 裁剪图 orphan)· G8(announcement-import 已存在分支校验) | B | 不同模块但同属"写路径边界条件遗漏",可并批评审 |
| **审计留痕批** | G5(memberships 缺 audit)· G18(organizations.create 缺 audit,范围更大需独立评估) | B/C | G18 影响面超出本次序列,建议拆成独立 goal |
| **依赖 CVE 批** | G10(qs+js-yaml,生产可达)· G25(COS request 传递链,upstream 无解)· 呼应登记 F5/F6/F18 | B | G10 应优先(生产可达 + 有补丁);G25 需要跟踪上游动态;F18 CI 门禁可与本批一起立项 |
| **字典守卫批** | G2(notification_type 防误删) | B | 沿既有登记范式加一行 |
| **测试补强批** | G12(22074/22075 优先级测试)· G29(F2 矩阵补 content-* 覆盖) | B/C | 低成本硬化,补测试即可 |
| **文档 true-up 批**(一次性大扫除,可一次随手清) | G6 · G9 · G14 · G15 · G17 · G19 · G20 · G21 · G22 · G23 · G24 · G26 · G27 · G28 | A | 14 条纯 docs/注释/cosmetic,无运行时影响,适合单个 A 档 PR 一次清完(沿上一轮 F13/F14/F17/F19 处理先例) |

> 每批应循 `docs/process.md` 单独立项;B 档需维护者拍板,A 档 docs 沿惯例。**本报告不构成任何 fix 授权**——尤其是数据合规批(G1),在拿到用户明确指示前,不应有任何 goal 擅自开始处理 git history。
