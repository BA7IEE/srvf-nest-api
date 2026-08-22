### 修复

- 🔴 **队员编号被订正走之后会被重新发给别人**(`correctIdentity` 打穿「编号永不复用」铁律)。仓内多处铁律写着「memberNo 一旦发放就永久占用,即使队员被删也不复用」,而它此前**只靠 `Member` 表兑现** —— `assertMemberNoUnique` 用**含软删**的 `findUnique` 查 `Member`。软删场景够用(行还在),但 #1127 新增的 `correctIdentity` 是**原地 `update`**:`A001` 订正成 `A999` 之后,库里**再没有任何行持有 `A001`** ⇒ 下一个人建档时唯一性预检通过 ⇒ **`A001` 被重新发出去**。

  ⭐ **为什么这不是洁癖**:`memberNo` 同时是**登录识别锚** —— `auth.service` 先按 username 查,未命中再按 memberNo 兜底查,且刻意保留原大小写(注释逐字:「编号即身份」)。号被复用意味着**曾经用 `A001` 登录的是甲,现在是乙**;而这个号还印在证书上、写在通讯录里、队员自己记着 —— **系统外的世界不知道这个号被订正过**。

  修法(维护者 2026-08-22 拍板方案 A):新增**只增不删**的 `MemberNoReservation` 台账,建档 / 招新发号 / 订正三条写路径**同事务**烧号,唯一性预检改成「`Member`(含软删)**或**台账命中即拒」。migration 同时把**现有全部** `Member`(**含软删**)的编号回填进台账。

  ⚠️ **直接推论:订正回不去。**`A001` → `A999` 之后再想改回 `A001` 会被拒(`A001` 已烧),**对本人也成立**。这是「永不复用」四个字的字面后果,不是 bug —— 要留后悔药就得引入释放入口,而那被明确划为不做。

  ⚠️ **拦住复用的是台账上的 DB 唯一约束,不是应用层预检。**这个分工是刻意的,因为**并不是每条写路径都过预检**:招新发号(`recruitment-promotion`)**从不调** `assertMemberNoUnique`,它从 `RecruitmentCycle.memberNoSeq` 取号、靠 P2002 兜底转 28042(整批回滚不跳号)。插台账这一行让它自动被同一条约束管住,**零改判逻辑、零新错误码**。而它真的会撞:实测 `RecruitmentCycle.year` **没有唯一约束**、`memberNoSeq` **每个 cycle 各自从 0 起算** ⇒ 同一年开两个轮次都会发 `26001`。

  刻意**不做**(维护者拍板):台账无 `status` 列、无软删、无释放 / 恢复入口 —— 号烧了就是烧了;将来真要释放另行立项。加一个 `status` 列就等于把「永不复用」偷偷降级成「默认不复用」。

### 数据模型

- 新增 `MemberNoReservation`(migration `20260822040000_member_no_burn_ledger`)。expand + backfill 两段,**零删列、零 DROP、零既有行重解释**。

  `reservedAt` **刻意无 `@default(now())`**:有默认值时应用侧漏传就悄悄吃库时钟,而「写用库时钟、判用应用时钟」在本仓是一整类缺陷;无默认值 ⇒ Prisma `create` 必填 ⇒ 漏传变成编译错误。`memberId` 可空 + `onDelete: Restrict` —— 归属只是附带溯源事实,占号才是本表职责,台账行不得因队员行消失而消失。

  回填 `id` 复用 `Member.id`(确定性,沿 `20260701130202` 同一手法),`reservedAt` 取 `Member.createdAt`(记的是**当初发号**时刻,不是迁移当天)。

### Harness / 执法层

- 「凡写 `Member.memberNo` 的生产路径,必须同事务写 `MemberNoReservation`」类闸(`scripts/harness-guards.selftest.ts`,已在 selfGuard、已被 CI 跑,零新接线)。守的缺陷类是:**发出去一个队员编号却没在台账里占住它 ⇒ 这个号将来会被再发一次**。

  ⭐ **必须是类闸而不是「把三处修好就算」**:三条生产写路径分散在**两个模块**,而且**只有两条过唯一性预检**。扫描面走 typed-AST **动态发现**写点,不写死文件名 —— 实测新建一个从没人见过的文件写 `member.create({ data: { memberNo` 而不烧号,闸当场点名 `src/modules/members/mutprobe-new-write-path.ts:8`。

  ⚠️ 可达性按**传递闭包**算(跟 `this.x()` 与同文件裸函数调用),否则「把烧号搬进私有 helper」这一个动作会同时造成漏抓与误红;满足侧同时认共享谓词 `burnMemberNo` **与**裸 `tx.memberNoReservation.create`,只认前者会把绕开 helper 的写法误判成违规。

  ⚠️ **回填的验收判据是比集合不是比计数**。实测同一个缺陷(台账删一行 `A002`、另插一行幽灵码)下:计数判据读到 `members=5 / reservations=5` 判「无问题」,双向 `EXCEPT` 判据当场点名 `A002`。
