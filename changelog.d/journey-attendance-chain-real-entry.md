### Fixed

- **入队门槛的贡献值从没被考勤审核链产出过**(P2-12b;由 journey 直写纪律闸逼出的两条接缝之二,
  与 P2-12a 同族)。`test/support/journey-recruitment-team-join.ts` 直接建
  `statusCode: 'approved'` 的 `AttendanceSheet` + 两条 `AttendanceRecord`(分值手填 `3.00` / `2.00`),
  目的只是凑够 5 分过入队门槛 —— 后果是**建单 → 一审 → 终审整条链被跳过**。
  而入队门槛恒按 approved 考勤算(`team-join-progress.ts` 的 `approvedRecordsWhere`),
  于是「**考勤链产出的 approved**」与「**直插的 approved**」是不是同一件事,**当前无人证明**。

  ⚠️ 这是**判据缺口,不是已知缺陷** —— 两本账别混。登记它的理由是:上线后第一次真人走查
  若在这条链上出问题,现有测试给不出任何预警。

  本刀把这段改走**真 HTTP 入口 + 真角色**:
  `POST /api/admin/v1/activities/:activityId/attendance-sheets` →
  `PATCH /api/admin/v1/attendance-sheets/:id/approve` →
  `PATCH /api/admin/v1/attendance-sheets/:id/final-approve`。

  ⭐ **三个身份缺一不可,这是审核链自己钉的,不是排版偏好**:submitter == 审核人 → 22073 / 22074
  (`SELF_{FIRST,FINAL}_REVIEW_FORBIDDEN`,**SUPER_ADMIN 亦拒**);一审人 == 终审人 → 22075
  (`SAME_REVIEWER_FORBIDDEN`)。故 submitter = journey SUPER_ADMIN,一审 = `attendance-first-reviewer`,
  终审 = `attendance-final-reviewer` —— 后两个是 `prisma/seed.ts` 里的**真生产角色码**。
  用同一身份走完全程一条 22075 都碰不到,而单据终态长得一模一样 ⇒ 等于没测角色隔离。

  ⭐ **顺带接通的是分值来源**:submit 的 `contributionPoints` 由 `ContributionRule` 按**时长档位**
  权威计算(`contribution-calculator.ts`;请求体里传了也不作数),直插版那两个字面量正是绕过了它。
  夹具建一条档位规则(阈值 3h / 档下 2 分 / 档上 3 分),两条记录 4h 与 2h 分别取到 3 分与 2 分,
  跨两个北京自然日避开 3 分/日封顶,合计仍是 5 分 —— **门槛读数零变化,产出路径换成真的**。

  helper 内钉两条**两边非空**(沿 12a 范式):
  - 建单后 records 的预填分合计必须 `=== 5`。`computePrefilledPoints` 在**无匹配规则时静默返 0
    且不报错**,症状会一路漂到几十行后的「贡献值不足」,读起来像门槛口径变了。
  - 终审后 `submitterUserId` / `reviewerUserId` / `finalReviewerUserId` 三者**均非空且两两不等**,
    结构性排除「同一身份走完全程」。

  另有两处随之校正:活动时间窗放宽到跨 1-19 / 1-20 两天(考勤记录必须落在活动窗 ±
  `ATTENDANCE_WINDOW_TOLERANCE_HOURS`,默认 2h,否则 submit 直接
  22042 `ATTENDANCE_OUTSIDE_ACTIVITY_WINDOW` —— 直插时无人校验这一条);
  `attendance_role` / `attendance_status` 两类字典进 `journey-runtime.ts` 公共底座
  (submit 对每条 record 的 `roleCode` / `attendanceStatusCode` 做字典闭集校验)。

- 闸分类读数同步更新:`test/support/journey-*.ts` 直写 **44 → 46 处**,
  `ambient` 31 → **35** · `gate-unreachable` 10 · **`mid-chain-start` 2 → 0** · `time-compression` 1。

  ⚠️ **总数是升的,不是降的** —— 立项时预期「会再降」。实际是:抵掉的 2 处 `mid-chain-start`
  被 4 处新 `ambient` 盖过(1 条 `ContributionRule` 档位规则 + 3 处 RBAC 判权底座:
  `rbacRole` / `rolePermission` / `roleBinding`)。这不是退步 ——
  **`mid-chain-start` 归零才是本刀的量**:该分类的语义是「属于被验链、有 API,却刻意从中间态起步」,
  归零 = journey 里**再没有一处**是从被验链的中间态起步的;新增那 4 处是判权与配置底座,
  本就不在任何一条被验链上。总数当分母看会把这件事读反。

### Added

- **`attendanceSheet` / `attendanceRecord` 进封口模型登记表**
  (`scripts/harness-guards.selftest.ts` 的 `JOURNEY_SEALED_MODELS`,随 `pnpm harness:selftest` 在 CI 跑)。

  ⭐ **没有新建第二套判据** —— 12a 立这道闸时就是按「修类不修实例」选的**登记表**形态
  (而不是「certificate / team-join 两文件特判」),正是为了让 12b 按同一形状加两行即可。
  表内模型在 `test/support/journey-*.ts` 内直写数必须**恒为 0**,分类标注一律无效。

  ⚠️ 为什么必须另立这道闸:原有「逐条交代」闸对**接缝回退完全失明**。
  变异对拍(同一份输入喂两道闸)—— 把 journey 改回直插 `approved` 并配一条**完全合法**的
  `// journey-direct-write: mid-chain-start — …` 标注:

  | | 基线 | 变异(回退直插) |
  |---|---|---|
  | 旧闸(逐条交代) | 绿 | **仍全绿** ← 判据缺口 |
  | 新闸(封口登记表) | 绿 | **红**,点名 `file:line` |

  原因是旧闸只问「交代了没有」,**不问「这处还该不该存在」** —— 分类标注可以把一次回退**买回来**。
  登记表的模型名与 `prisma/schema.prisma` 交叉核对(12a 就位的自证):名字拼错则正则永不命中、
  闸恒绿且毫无症状,这条把假绿路径堵死。
