### Added

- **活动 v1.1 上线切换闸 `ACTIVITY_V11_WORKFLOW_ENABLED`**(第 7 批第 ③ 刀;合同 §16.2 的执行位,
  C 档;默认关闭)。合同红线原文:「不能拆成多个可独立开启的开关让同一实例进入『新打卡＋旧结算』
  混合状态。子能力可以有 UI 灰度,但**业务真相切换必须单轨**。」本刀把这句话做成机器判据。
  - **配置项**逐字沿 `ACTIVITY_AUDIENCE_TAGS_HTTP_ENABLED` 的形状:空值时 production / smoke
    **抛错拒启**,其余环境默认 `false`;非严格 `true` / `false` 一律抛错。
  - **单一真源** `ActivityWorkflowGate`(`src/common/activity-workflow/`)—— 它是 src 生产代码里
    **唯一**读取该配置的地方,三项受控面全部经由它取值:
    ① 新结算真相链(打卡 / 服务段 / 封场 / 结算 / 账本 / 关账 / 更正)写路径:闸关时拒绝(`20153` / 503);
    ② 旧 `ActivityCheckIn` / `AttendanceSheet` 写路径:闸开时拒绝(`20154` / 410 —— 是永久关闭而非稍后重试);
    ③ 统计读面取数:闸开读**已 committed 账本**,闸关读 approved 考勤(今天的行为)。
  - **闸控范围按维护者 2026-08-19 拍板收窄为「结算真相链」**,不含 Session / Participation /
    Registration。理由是实测:发布活动硬性要求 live session
    (`ACTIVITY_PUBLISH_REVIEW_LIVE_SESSION_REQUIRED`),而旧 AttendanceSheet 链只能在已发布活动上跑
    ⇒ 若闸关时连 Session 写一起拒绝,活动根本发布不了,**旧写路径会跟着一起死**,那就违反了
    「闸关 ⇒ 旧写路径放行(今天的行为)」这条安全底线。合同点名要防的「新打卡＋旧结算」两端
    都在收窄后的范围内。全链路 e2e 实测印证:闸关时第 1–8 站(建草稿→场次→岗位→发布审核→
    批准→报名→分配→签发二维码)全部走通,恰好在第 9 站「签到」拿到 `20153`。
  - **执行位不是那个布尔变量,而是四条结构判据**(`activity-workflow-gate.criteria.ts`,
    随 unit 套件自动执法,**不新增需要单独接线的 CI 命令**):
    C1 单一真源(按 AST 判,注释里的说明不误报)· C2 无漏网写路径(按 Prisma delegate 定位,
    沿文件内调用图传播到公开入口 ⇒ **新增端点只要落到受控 delegate 上就会被抓住**,
    是按缺陷类而不是按实例设闸)· C3 三面确实在闸上 · C4 反向闸。
    四条判据各配**正对照**:拆掉判闸位 / 改成各读各的配置 / 换成写死 `true` ⇒ 判据必须转红,
    且红在指名的那一处 —— 不做正对照的结构断言等于没有。
  - **C4 是一条反向闸**:入队门槛(team-join)与 `computeCappedContribution` **恒按 approved 算**,
    不随本闸切换(维护者已拍板)。这条不一致是刻意的,故上闸禁止它们接闸,防止后人「顺手统一」
    悄悄改掉入队门槛的业务口径。
  - footprint:BizCode 新增 **2** 条(`20153` / `20154`);Endpoint / 权限码 / Migration / Cron /
    throttler **恒等**;零 schema、零数据迁移(合同 §16.3:非生产库由维护者重建,不写长期 backfill)。
