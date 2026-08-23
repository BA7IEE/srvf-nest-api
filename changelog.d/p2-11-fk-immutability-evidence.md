### Changed

- **P2-11 立项前取证(A 档,纯取证不是修复)** —— 台账 P2-11「用 `onUpdate: CASCADE` 的外键去守
  『副本与源一致』」的三问已答,读数写回 [`docs/ai-harness/NEXT_TASKS.md`](docs/ai-harness/NEXT_TASKS.md)。
  **本刀零 schema 改动 / 零 migration / 零 `src/` 改动 / 未建闸** —— 守法候选给的是对照表,
  **改不改、怎么改由维护者拍板**。
- **Q1 = 28 条**(承担「副本必须等于当初那份源」职责的 FK),分布在 7 个模型。
  ⚠️ 这个数**不是**「全仓 283 条 FK 里有几条 CASCADE」—— 那个分母没有意义,
  绝大多数 CASCADE 是完全正确的级联。
- **Q2 = 15 条** `onUpdate` 为 CASCADE;⭐ **但真残余只有 4 条**,全部在 `OfflinePackageParticipant`。
  差额的 11 条被持有侧的 DB trigger 遮挡 —— **实测**:FK 的级联更新**会触发**持有侧的行级
  `BEFORE UPDATE` trigger(报错上下文可见 PostgreSQL 内部发出的 `UPDATE ONLY … SET …`),
  整个事务回滚 ⇒ **行级 BEFORE UPDATE trigger 能就地废掉 `ON UPDATE CASCADE`**。
  ⚠️ 这 11 条**不是同一种 trigger**,逐个读过函数体后分开算:**9 条**无条件
  (`AttendancePunchEvent` 6 + `ParticipationLedgerEntry` 3,函数体无 `IF` 直接 `RAISE`)、
  **2 条**按状态(`ActivityQualificationRuleSet` 的 `freeze_guard()`:`retired` 全拒、
  `active` 显式点名拒改 `activityId`/`sessionId`/`positionId`、`draft` 放行)——
  ⭐ 后者**不是缺口**,`draft` 期本就没有不变量可违反,**保护范围与不变量生效范围恰好对齐**。
- **这 4 条对下一步意味着什么**:它们**当前打不响** —— 实测 993 个 `src/**.ts` 里
  **没有任何一条代码路径写被引用的锚列**(typed Prisma 侧唯一命中是持有侧清空自己的 FK 列;
  裸 SQL `UPDATE … SET` 侧 0 处)。所以这仍是**判据缺口不是风险敞口**,两本账别混。
  缺口在于:让它保持安全的是「碰巧没人写」这条**无人守的代码纪律**,
  而不是 schema 约束或任何执法位 —— 有人第一次写锚列时,**没有任何机器闸会红**。

### Fixed

- ⚠️ **订正 P2-11 出处引文的理由**:原记「`ActivityRuleSnapshot.snapshotHash` 判为不补,
  理由是本批复合 FK 恒为 CASCADE」—— **结论(不补)对,理由错**,而被推广成缺陷类的恰恰是那个错理由。
  实测:`snapshotHash` **不是任何 FK 的列**,CASCADE 结构上碰不到它;该模型 3 条 FK
  **全是单列指向 `id`**;且它挂着 `trg_activity_rule_snapshot_10_append_only`
  (`BEFORE UPDATE OR DELETE` 无条件 RAISE)⇒ 永不能被 UPDATE,指向它的复合 FK 的级联也永不发生。
  **缺陷类本身依然成立**(已用 probe 库复现:无 trigger 时副本被静默改写、记录当初值的旁列纹丝不动),
  只是它的**首个举例举错了**。

### Notes

- ⭐ **判别法用了五路信号并交叉核对**,每路命中数分别是
  模型名 45 · 字段名 30 · 内容型 `*Hash` 66 · 注释词表 151 · 复合 FK 59,**并集 196/283(69%)**。
  69% 显然是错的 —— **信号是发现网不是判据**,这是 P2-8「同一缺陷类三种形状 131→15→1」的同构复现:
  单用注释词表会报 151 条,据此得出的「全仓普遍存在」是判据太粗造成的假象。
- **假阳性做的是普查不是抽查**:32 个候选模型逐个反证(生产代码是否真的 `update()` 它),
  **剔除 11 个,假阳性率 34%**。⭐ 模型名信号最差(7 个假阳性)——
  `EvidenceSeal` / `ActivityEvidenceState` 这种名字里写着「封存 / 存证」的模型**照样天天被 update**。
  ⚠️ 反向也查了:9 张有 trigger 的表里 2 张带 `updatedAt`,只用「无 `updatedAt`」会**漏掉 2/9** ——
  只用一种信号**两个方向都会错**。
- ⭐ **Prisma 未写 `onUpdate` 时默认落到 `CASCADE`,已实测非假设**:由
  `prisma migrate diff --from-empty --to-schema-datamodel` 生成的规范 DDL 里
  264 条 `ON UPDATE CASCADE` = schema 中未写 `onUpdate` 的 264 条,
  19 条 `ON UPDATE RESTRICT` = 显式写了 `onUpdate: Restrict` 的 19 条,**逐条一一对应**。
  ⚠️ **该默认值与可空性无关**(111 可选 + 153 必填全是 CASCADE)——
  必须单独实测,因为 `onDelete` 的默认值**是**看可空性的,照着推会推错。
  ⚠️ 全仓**无一处显式写 `onUpdate: Cascade`**,故读数按实际 DDL 口径算;只数显式的会得到 0(假读数)。
  本机库 `app` 只跑到 67/95 个 migration,已陈旧,**不作读数来源**,仅作方向性佐证。
- **Q3 对照表列了四种守法而非三种** —— 台账原列三种,取证发现仓内**已经在用第四种**
  (append-only trigger,9 张表 10 个 trigger 在跑)且它比前三种都强。
  另:`onUpdate: Restrict` **已是本仓既有范式**(19 条显式 Restrict 全部落在冻结类模型上),
  说明后续批次已自发在这么做,只是 `OfflinePackageParticipant` 那批漏了。
