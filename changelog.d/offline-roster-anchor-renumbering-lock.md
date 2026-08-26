### 变更

- **离线打卡名册的四条复合锚点外键改 `ON UPDATE RESTRICT`,并接成机器闸(P2-11 的 4 条真残余)**

  大白话:离线打卡会生成一份**当时的人员名册**,应该定格。此前数据库没拦着 ——
  万一有人改了上游的编号,名册会**跟着被改掉且不留痕迹**。

  维护者 2026-08-25 拍板:**先只锁编号**;更彻底的 append-only trigger(D 档)是**独立一刀**,本次不做。

  **真因**:`OfflinePackageParticipant` 的四条复合外键只写了 `onDelete: Restrict`,**没写 `onUpdate`**,
  而 **Prisma 未写 `onUpdate` 时默认落到 `Cascade`**(⚠️ 与被引用列可空与否无关 ——
  `onDelete` 的默认值才看可空性,照着推会推错)。于是实际 DDL 全是 `ON UPDATE CASCADE`。
  这张表**只有 `createdAt`、没有 `updatedAt`、没有 trigger** ⇒ 名册被改写之后,
  没有任何一处能看出它变过。

  **改了什么**(第 99 条 migration `20260826090000_offline_package_participant_lock_anchor_renumbering`):

  - `offlinePackage` / `session` / `participationIdentity` / `position` 四条**复合**外键补 `onUpdate: Restrict`;
  - **只 DROP + ADD 约束**(PostgreSQL 改引用动作的唯一办法),**不加列、不删列、不改可空性、不改列类型**;
  - **四条约束名逐字不变** —— 两支既有 e2e 分别按名断言 `OfflinePackageParticipant_package_anchor_fkey`
    和逐字钉着其中两条的已知 RenameForeignKey 漂移基线,改名会当场打挂它们;
  - **可逆**,回滚 SQL 逐条写在 migration 头注;生产未 deploy;
  - ⚠️ **单列外键刻意不动**(`activity` / `member` / `participationRevision`):它们指向 `id` 型代理键,
    `ON UPDATE CASCADE` 结构上无物可抹。

  **接闸**(台账明写「别建在『数 CASCADE 有几条』上」—— 那个分母全仓 283 条,没有意义):
  `scripts/check-composite-anchor-closure.ts` 增规则 ②,问的是一句**机制**话 ——

  > 「**冻结记录**(持 ≥2 业务锚点 · 有 `createdAt` 无 `updatedAt`)+ **复合外键**」的集合里,
  > 不允许出现**既无 `onUpdate: Restrict` 又无 BEFORE UPDATE 触发器**的成员。

  两道锁任一成立即可:写了 `onUpdate: Restrict`,或该表挂着 BEFORE UPDATE 触发器
  (实测触发器会把级联下来的那条 UPDATE 一并挡掉)。扫描面**动态**取自 `schema.prisma`
  与 `prisma/migrations/**`(触发器索引现算,并处理 `DROP TRIGGER` —— 否则「触发器早被拆了、
  判据还以为它在」是静默 fail-open),**不写死表名单**,**没有白名单**:要放宽只能改那个文件本身,
  而它在红区 selfGuard 内。

  起刀当日读数:**4 张**冻结多锚点表 / **24 条**复合外键 / **10 条** BEFORE UPDATE 触发器 /
  扫过 **99 个** migration。四张表里 `ActivityAllocationApplicationProjection` 两道锁都有、
  `AttendancePunchEvent` 与 `ParticipationLedgerEntry` 靠触发器过关,
  `OfflinePackageParticipant` 是唯一两样都没有的那张 —— 本刀之后归零。

  **变异对拍**(五组,每一维各自成 `it`;jest 一个 `it` 内首个失败即停,塞一起后面的断言从未被执行):

  | 变异 | CLI 退出码 | spec 红集 |
  |---|---|---|
  | 基线(无变异) | 0 | 16/16 全绿 |
  | 摘掉 `session` 的 `onUpdate: Restrict` | 1,点名 `OfflinePackageParticipant.session -> ActivitySession (schema.prisma:5671)`、外键列、当前值 | **1 条** |
  | 摘掉 `position`(= 正对照自己的靶子) | 1,**空变异守卫开火**(「被测的那处当下没上锁 ⇒ 空变异」) | 4 条 |
  | 触发器索引清空 | 1,诊断指向「**扫描器坏了**,不是仓库真的把触发器删光了」 | 3 条 |
  | `staleExemptions` 改恒返回 `[]` | 1,「豁免防腐自证失效」 | **2 条** |
  | `isFrozenRecord` 改恒 `false` | 1,管辖面地板**逐表**点名 | 5 条(主断言**照样绿** —— 正是地板要接住的那种假绿) |

  **顺带补一个真洞**:同文件既有的豁免名单 `ANCHOR_CLOSURE_EXEMPTIONS` 原先只有
  「当前名单是干净的」这一条断言 —— 把 `staleExemptions` 改成恒返回 `[]`,它**照样全绿**
  (上表第五行实测)。本刀补的防腐自证是往名单里塞一条**指着不存在的表**的豁免,
  必须被当场报出来。这补的是 #1184 那个形状:名单指着已删掉的东西,不生效、不报错、没人发现。
