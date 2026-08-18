### Fixed

- 统一时间权威:修掉「写入用数据库时钟、判定用应用时钟」这一**缺陷类**的全部 16 个写点
  (14 处生产代码 + 2 处本地夹具;登记在册的判定写点共 29 个,其余 13 个此前就写对了)。
  受影响的判定列有 5 个 —— `ActivityBatchJob.availableAt`、`StorageObjectOperation.availableAt`、
  `NotificationOutboxIntent.availableAt`、`RoleBinding.startedAt`、`MemberOrganizationMembership.startedAt`。
  它们此前落到 Prisma `@default(now())`(库时钟),而领取/判权侧拿应用时钟去比:库钟一旦快于应用钟,
  `availableAt <= now` / `startedAt <= now` **恒假** —— 任务永不可领、刚发的角色判权侧「尚未生效」,
  且不报错、不抛异常,只是什么都不发生。现在写侧一律显式写判定侧那个时钟。
- `LedgerPreparationService.ensurePrepareJob` 接收 worker 本轮的 `now`,并把「本轮建的 job 下一轮才领」
  这条两轮协议写成 `availableAt = now + 1ms`。此前该协议靠「库钟恰好落在应用钟之后」这个偶然维持,
  库钟一旦慢于应用钟协议自己就翻面;现在与两个时钟的相对快慢无关。
- App 面 `POST /app/v1/my/managed-activities`:责任制工作流开关关闭时不再抛
  `ACTIVITY_ATTENDANCE_DECLARATION_INVALID`(20039「当前活动不能声明考勤已全部提交」)——
  那个码说的是另一件事,会把排障的人引去查考勤。改抛新增的
  `ACTIVITY_RESPONSIBILITY_WORKFLOW_NOT_ENABLED`(20036 / 503),形状沿既有 `*_NOT_CONFIGURED` 一族。

### Added

- 新增 `src/common/datetime/clock-authority.spec.ts`:上述缺陷类的**执行位**。
  以 TypeScript AST(非文本匹配,天然剥注释)扫描全部 `create / createMany / upsert` 写点,五道断言 ——
  ① 完整性硬闸:`prisma/schema.prisma` 里每个非审计的 `@default(now())` 列都必须在登记表里做过一次决定
  (清单从 schema 反推,不写「恰 N 条」);② 判定点仍在且仍读应用时钟;③ 判定列的每个写点都显式写出该列,
  且值表达式与登记表逐字一致;④ 单一权威列(`ActivityRegistration.registeredAt`,只与同列兄弟行比较)
  反过来**不许**任何写点显式写;⑤ 反向闸:封场/关账/生命周期三处**刻意**取库时钟的 `now()` 不得被
  「统一时间权威」顺手改掉 —— 那是更强的事务级单一「现在」,改成应用时钟是降级。
  7 条真变异对拍(逐条落在目标实现行)+ 6 条内置阳性对照,红集互不重叠。
- 新增 `src/modules/activities/app-managed-activities-workflow-switch.spec.ts`:钉住开关关闭时的**具体码**
  (整包比对码/文案/httpStatus),换成任何别的码都红。
