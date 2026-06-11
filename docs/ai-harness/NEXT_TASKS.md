# NEXT_TASKS — 后续任务拆解(P0 / P1 / P2)

> **性质**:任务提案清单(2026-06-10 Review 产出)。**每项任务仍须按 [`process.md`](../process.md) 单独立项,AI 不自动启动**(process §7)。状态列可由 AI 在 docs PR 中更新。
> P0 = 不解决阻碍 AI Harness 落地;P1 = 影响长期维护;P2 = 可优化。

---

## P0(harness 落地链路)

(P0-1 / P0-2 / P0-3 均已完成,见文末归档区。)

## P1(长期维护)

(P1-3 业务面 RBAC 接入〔Slow-4〕已于 2026-06-11 goal 全队列完成,见文末归档区;P1-4 已于 2026-06-10 调研收口,见文末归档区。)

### P1-7 SMS 后续消费者(剩 ②③)— **🚧 进行中(2026-06-11 B 队列 goal 拍板立项;冻结评审稿 [`queue-b-otp-birthday-infra-review.md`](../archive/reviews/queue-b-otp-birthday-infra-review.md))**
- ② **OTP / 验证码登录**(goal F4;`AGENTS.md:242` 红区行已评审解锁,改写随实施 PR)+ ③ **通知用途短信首批 = 生日祝福**(goal F5;拍板仅 `User.phone` 单发,无群发/退订)。①找回密码已完成,见归档区。
- 原"前置 = 运维侧真实通道验收"由 goal 拍板豁免(DevStub 先行全验沿找回密码先例;真实通道仍由运维接力,届时**两模板一批**送审)。

## P2(可优化)

### P2-3 分页 skip/take 换算的轻度重复 — **❌ 不做**
- 依据:现状可接受(逻辑两行,已验证);主动抽 util 违反 AGENTS §2 grab-bag 禁令。重开条件 = 后续出现第 3 处分页 bug 时单独评估,**不**预先立项。

### P2-5 contract snapshot 单文件 ~1MB — **❌ 不做(已接受)**
- 依据:current-state §4 已接受("PR review 用 diff 看");无动作项,仅提醒勿整读(2026-06-10 实测 35,777 行 / ~1,013 KB)。

---

## 已完成项归档区

- **P2-6 `sms_verification_codes` / `sms_send_logs` retention 清理** ✅(2026-06-11 B 队列 goal F3;冻结评审稿 [`queue-b-otp-birthday-infra-review.md §4`](../archive/reviews/queue-b-otp-birthday-infra-review.md)):**拍板方案 = 手动 SQL SOP** [`docs/ops/sms-data-retention-sop.md`](../ops/sms-data-retention-sop.md)(验证码 90 天 / 流水 1 年,数值可改;季度例行 + 报警线〔codes>5 万 / logs>50 万 / 合计>100MB〕;备份→事务预数→DELETE→复核 强制顺序);SQL 2026-06-11 在 app_test 实测冻结(老化行 5/7 全删 + 窗口内行存活边界用例);**不解锁 cron 清理**(`@nestjs/schedule` 解锁范围仅生日批,沿评审稿 R-5);docs/README §1 已登记。
- **P2-4 `common/storage/` 迁往 `src/modules/storage/`** ✅(2026-06-11 B 队列 goal F2;冻结评审稿 [`queue-b-otp-birthday-infra-review.md §3`](../archive/reviews/queue-b-otp-birthday-infra-review.md)):D 档纯搬迁零行为——20 文件 `git mv`(含模块 CLAUDE.md)+ import 链 15 文件更新(外部 3 + spec 2 + e2e 2 + 内部相对深度 4 + 注释 4);**snapshot 逐字节零 diff** + 全仓 `grep common/storage` 残留 0(archive 豁免)+ `agent:check:full` 全绿;CODEMAP 模块数 19→20、current-state §4 P3 行闭环。
- **P1-3 业务面 RBAC 接入(Slow-4 / 权限双轨收口)** ✅(2026-06-11 goal T0-T4 全队列完成;冻结评审稿 [`docs/archive/reviews/slow4-rbac-business-face-review.md`](../archive/reviews/slow4-rbac-business-face-review.md)):**Slow-3 决议**(维护者 2026-06-11 拍板)= ADMIN 内置角色边界 = 全量业务权限,`biz-admin` 承载;部门级细分仍不做(沿 P1-5 方案 A);迁移目标 = 零行为漂移。T0 评审稿 #314(44 端点逐行映射,原 RBAC_MAP「48 处」亲核 true-up 为 44)→ T1 seed #315(36 码 + biz-admin 绑 35〔`member.delete.record` 仅 SA,D1=A 镜像;attachment 20 码不绑〕+ ADMIN 全员幂等补挂强校验;81→117 码)→ T2 member 族 #316(21 端点)→ T3 participation #317(23 端点,activities 列表/详情无码化 `[auth]`)→ T4 docs 收尾。**全仓活跃 `@Roles` = 0**(RolesGuard 机制保留);拒权 40300→30100 沿 P0-F 先例;零漂移五类由 7 个 `*-rbac-boundary` spec(52 例)锁定,既有业务断言零修改全绿;`docs:rbacmap:check` 0 FAIL / 0 WARN。
- **P1-7 ① 找回密码(SMS 验证码重置,pre-auth)** ✅(2026-06-11 goal T0-T3 全队列完成;冻结评审稿 [`docs/archive/reviews/password-reset-by-sms-review.md`](../archive/reviews/password-reset-by-sms-review.md)):T0 评审稿 #307 → T1 enum migration #308(`SmsPurpose` +`PASSWORD_RESET` 单行;干净库 14/14 重放 + seed 幂等二跑)→ T2 实施 #309(`auth/v1` 两公开端点 + 防枚举四场景泛化 200 + reset 统一 24010 零新增码 + 10006 不烧码 + 联动撤销第 5 场景 `'self-password-reset'` + audit `password.reset.by-sms` + `@PasswordResetThrottle()` 第 6 实例 3/60 + AGENTS §9 四→五场景红区行 + e2e 12 例;contract 155→157;**auth 既有断言零修改全绿,auth.service.ts/users.service.ts 零 diff**)→ T3 docs 收尾。**运维侧零新增作业**:DevStub 已全验,真实短信仍只卡腾讯云审核一件事(沿 P1-6 checklist)。图形验证码不做,重启条件成文评审稿 §9。
- **P1-6 手机号验证码基础设施** ✅(2026-06-10 goal T0-T4 全队列完成;冻结评审稿 [`docs/archive/reviews/sms-verification-infra-review.md`](../archive/reviews/sms-verification-infra-review.md)):T0 评审稿 #299 → T1 schema #300(User +phone/phoneVerifiedAt + 三表三 enum,干净库重放 + seed 幂等二跑)→ T2 通道层 #301(sms 模块 + 双 Provider + settings/send-logs 4 端点 + 权限码 76→81 + SMS_ENCRYPTION_KEY fail-fast + SDK 锁 4.1.240)→ T3 验证码与绑定 #302(SmsCodeService + me/phone 两端点 + admin 清号 + BizCode 24xxx 6 码 + 3 audit 事件 + 双 throttler + e2e 三组 42 用例)→ T4 docs 收尾。**行为锁全程守住**:auth-* 原断言零改动全绿 / JWT payload zero drift / AGENTS:242 不动。**真实通道未开通**(运维接力:[`docs/ops/sms-production-rollout-checklist.md`](../ops/sms-production-rollout-checklist.md));消费者三项见 P1-7,retention 见 P2-6。

- **P2-2 Swagger 权限要求文本化惯例补全** ✅ PR #287(2026-06-10,C 档,goal 预拍板范围内实施;配套一致性检查项 G 见 P1-1 条目 PR #288):全部 **148 个 endpoint** 的 `@ApiOperation` summary 追加统一鉴权后缀,四种形态与实际鉴权 1:1 对照(`pnpm docs:rbacmap:check` 口径):`[rbac: <权限码>]`(81,R 模式,码自 service `rbac.can()` 调用点逐个反查;attachments 8 端点为运行时 self/other 动态判定,标 `attachment.<action>.*` 通配族)/ `[roles: <角色列表>]`(44,G 模式,自方法级 `@Roles(...)` 实参)/ `[public]`(6,`@Public()`)/ `[auth]`(17,仅登录:App surface 15 + `rbac/me/permissions` + `auth/logout-all`;goal 三格式未覆盖"仅登录"形态,按最小扩展补第 4 记号并已在 PR 描述显式声明)。**零行为变更**;contract snapshot diff 296 行全部为 summary 行(逐行核验非 summary 变更 = 0)。

- **P1-4 god-service 拆分系列** ✅ 收口(2026-06-10,用户逐项拍板;沿 `srvf-god-service-refactor` skill 全流程):
  - **第一刀 attendances Presenter** ✅ PR #280(C 档方案 A 拍板):4 个序列化方法 + `decimalToString` 抽至 `attendance-presenter.ts`(137L),service 1157→1100L;零漂移三证 = 716L characterization 断言零改动 + presenter unit spec 6 用例 + contract snapshot 零 diff;事务归属未下放,select 查询策略留 service。
  - **attendances 第二刀(QueryService)**:只读调研判定触发不足——4 个读方法净查询构造仅 ~40L、filter 分支 1-2 个、抽离需事务壳传参或读事务下放,命中 [`architecture-boundary.md §6`](../architecture-boundary.md) Do-not-extract("hide the transaction boundary")→ 拍板收刀。
  - **attachments(827L)**:调研结论**无合规可抽边界**——纯规则历史已抽完(audit-recorder #203 / `attachment-validation.ts` PR #6b / `mime-to-ext.ts`);余量为 signed-URL L3 红线(`resolveAccessUrl`)+ RBAC self/other scope 判定(Hard stop 区)+ 配置三表读点(boundary 文档锁"不抽 facade")+ 本职编排 → 拍板收刀。
  - **activity-registrations(750L)**:仅剩 `formatRowsAsCsv`(~54L,单点调用)低价值 Presenter 候选 → 拍板不立项。
  - **终态认知**:3 个 ⚠G 模块均已达 architecture-boundary 政策下合理形态,`docs:codemap:check` 的 god-service WARN 仅作体量观察,不再视为"待拆"队列;重开任何一刀需出现 §6 新触发条件并单独立项。`current-state.md §3/§4` 已同步本结论。
  - **伴随产出**:participation 5 个纯组件 unit 全矩阵(#278 time-overlap-policy + contribution-calculator / #279 三个 state-machine)+ attendance-presenter spec(#280);src 内 unit spec 20→26 个。

- **P1-5 部门级权限(finalReviewer 终审)业务确认** ✅(2026-06-10 用户拍板**方案 A**):维持 ADMIN 级终审,`finalReviewerUserId` 仅审计记录不参与授权;部门级细分挂 Slow-3 子议题,未立项前不实现、不新增权限码、不补部门级 e2e。现状已正式标注于 [`participation-bounded-context.md §4`](../participation-bounded-context.md) 关键 invariant;`current-state.md §3` Slow-3 行同步登记。
- **P2-1 member-profiles dto 拆分(harness 验证任务)** ✅(2026-06-10,用户指定"选一个真实小任务验证 Harness"):**原任务前提修正**——769L 文件内并无 enum(Review 扫描代理误报,亲核仅 4 个 DTO class + 1 共享正则),改按 AGENTS §2 既有解锁例外(单 dto 文件 >300L 允许拆 `dto/` 目录)执行物理拆分:`dto/member-profile.shared.dto.ts`(PHONE_PATTERN + MedicalNoteItemDto)+ response / create / update 三个 per-class 文件,sed 逐字节搬移零改写;importer 仅 controller / service 两处。验收:quick 绿 + contract snapshot **零 diff**(snapshot 未触碰,由 CI 契约锁证明)+ codemap / rbacmap 双检查 0 FAIL。
- **P0-1 合入 ai-harness 文档层** ✅ PR #272(2026-06-10):9 文档 + 3 模板 + `docs/README.md §1` 登记;CI 全绿。
- **P0-3 测试环境双侧验证** ✅ 随 PR #272 CI 完成:contract + e2e 在 CI 通过,无 Docker 降级路径成立(该路径现成文于 `process.md §3` 组合命令口径行;原 §1 出处已随 2026-06-10 瘦身裁撤)。
- **P0-2 入口接线** ✅ PR #273(2026-06-10,用户拍板授权):`CLAUDE.md §1` 表追加 ai-harness 行;CLAUDE.md 66 行,仍 ≤80。
- **P1-2 `docs/testing.md` 漂移 true-up** ✅(2026-06-10 用户立项,同日落地):覆盖表 `users-me` 行(死链,Route B Phase 4 删除)替换为 `app-me` / `app-me-password` 承接行;全文 20 个相对链接复核,其余 19 个均有效。
- **P1-1 RBAC_MAP 自动漂移检查脚本** ✅ PR #274(2026-06-10 用户立项,同日落地):`scripts/check-rbac-map.ts` + `pnpm docs:rbacmap:check`(沿 check-codemap 范式,零新依赖;6 检查项:seed 码提取 / 码数对账 / controller 数对账 / canonical 前缀 / 直调码必在 seed / 孤码 WARN + 动态前缀 INFO)。验收达成:当前仓库 0 FAIL;负向测试(删 seed 码 → FAIL 75≠76;篡改声明数 → FAIL)通过。已知边界写在脚本头部(helper 间接调用走全源字面量扫描;仅剥 // 行注释)。**2026-06-10 追加检查项 G**(PR #288,P2-2 配套):summary 鉴权后缀 ↔ @Roles/@Public/seed 一致性校验,现共 7 检查项;负向 3 连(删后缀 / roles 不符 / 码不在 seed)均精确 FAIL。
