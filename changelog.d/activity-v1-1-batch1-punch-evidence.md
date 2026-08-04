### Added

- **活动业务改造 v1.1 第 1 批第三刀:打卡 / 证据 schema expand**(第 **73** migration
  `20260804060000_activity_v11_slice3_punch_evidence`;合同
  [`docs/archive/reviews/activity-business-overhaul-v1.1/`](docs/archive/reviews/activity-business-overhaul-v1.1/)
  §3.15 / §3.16 / §3.17 / §3.18,批次划分见 §14「第 1 批」建议拆分第 3 项)。

  净新 **5 张空表**:`AttendanceQrCredential`(§3.15 场次二维码凭证)、
  `AttendancePunchEvent`(§3.16 追加式打卡事件)、
  `ActivityEvidenceState` / `EvidenceSeal`(§3.17 证据版本指针与封场凭证)、
  `ParticipantServiceSegmentRevision`(§3.18 服务段投影与修订)。
  **既有表本刀零加列** —— 前两刀各加过列,本刀一列没加,只有 Prisma 反向 relation。

  **expand-only:零 DROP / 零 RENAME / 零既有列语义变更 / 零回填 / 零删数 / 零 enum。**
  五张新表**零调用方 / 零端点 / 零 DTO / 零权限码 / 零 audit / 零 seed** —— 纯 schema 刀,
  契约 snapshot 一字未动;消费方在第 5 批。生产未 deploy。

  末尾 **25 条手写约束**:21 条 CHECK + 3 条 partial unique + **1 组 append-only trigger**。
  判据钉在 `test/e2e/activity-v11-slice3-schema-constraints.e2e-spec.ts`(27 例),
  并用两次变异 A/B 证明判据绑对(卸 trigger ⇒ 恰好 2 例红;去 QR partial 谓词 ⇒ 恰好 3 例红;
  两个红集**互不重叠**)。

  四处值得记的落点:

  - **`AttendancePunchEvent` 由 DB trigger 强制 append-only**(§3.16「不提供 update/delete
    endpoint」「生产业务角色不得 UPDATE/DELETE」),镜像既有
    `trg_insurance_evidence_20_immutable` 的函数 + trigger 两段范式,`ERRCODE='55000'`。
    四条判据全部**实测**而非推理:INSERT 放行(正对照 —— 一个恒拒的 trigger 也能让
    "被拒"用例全绿)/ UPDATE 拒 / DELETE 拒 / **TRUNCATE 仍放行**。
    第四条是 e2e 地基:`test/setup/reset-db.ts` 靠 `TRUNCATE ... CASCADE` 清库,而本表
    **不在** TRUNCATE 列表里、靠引用 `Activity` 被 CASCADE 带走;行级 trigger 不响应
    TRUNCATE,实测 7 行 → 0 行且 trigger 仍在(后半句同样是判据 —— 少了它,一个"被
    TRUNCATE 顺手卸掉"的 trigger 也能让前面全绿)。
  - **void/replace 形状拆成三条 CHECK 而非一条大 OR —— 但理由不是 NULL 坍塌。**
    本刀实测核对过:朴素式 `(A AND B) OR (C AND D)` 的每个操作数都恒二值(判别列
    `eventTypeCode` 是 NOT NULL ⇒ `IN` 恒二值;`IS [NOT] NULL` 亦恒二值),**不可能**
    塌成 NULL —— 把它说成"OR 就会塌"是套用第一刀教训的**误述**,与本表事实不符。
    真正的理由:①朴素单条 OR 会**静默误杀合法行** —— `early_departure_close` 让两条
    支路**同时为假**,整式 false;变异实测装上朴素式后,一条带 reason 的合法
    `early_departure_close` 立刻被 23514 拒。②拆开后每侧有独立可断言的约束名。
    采用的 `CASE … ELSE TRUE` 显式放行未点名的 eventType,不误杀。
  - **坐标成对用计数式**(`(CASE WHEN … THEN 1 ELSE 0 END + …) IN (0,2)`),三态
    (全空 / 全有 / 半有)各一条用例。**`accuracy` / `distance` 刻意不入成对判定** ——
    设备可以给出坐标却给不出精度估计,`distance` 还需一个参照点,而"不要求定位"的场次
    根本没有参照点;并进来会比合同更严、误杀合法行。
  - **两条 partial unique 的键列全 NOT NULL** ⇒ 与第二刀
    `activity_invitation_active_unique` 不同,**不需要** `NULLS NOT DISTINCT`。
    第三条 `attendance_punch_event_supersede_target_unique` 键列可空,按仓内纪律带上了
    该子句,但**诚实说明**:supersede shape CHECK 已强制该谓词命中的行必有非空键
    ⇒ 该子句在当前约束集下**无独立可观测行为**,配套 spec 无法为它单独产出"被拒"证据,
    保留它是纵深防御而非已验证判据。

  **时间重叠刻意不进 DB**:§3.18 明写「时间重叠校验在**现有 member lock 内**完成」
  ⇒ 零 exclusion constraint、零 `btree_gist`,并用 `pg_constraint contype='x'` +
  `pg_extension` 两条 e2e 断言把"不做"钉成会变红的判据。

  与合同的偏离(均因合同自身要求而必需,PR body 逐条列):
  `ParticipantServiceSegmentRevision` 的 `sourceCloseEventId` / `checkOutAt` /
  `serviceHours` 三列**改可空** —— 合同字段表未标 `?`,但 §4.5「无开放段＋check_in → open」
  定义了"已签到、尚未闭合"的段,此刻三者都不存在,NOT NULL 会让这个合同自己定义的形态
  **根本写不进来**(沿第二刀同一处置)。`reason` 必填只落**能无歧义映射到编码**的三类
  (特殊闭合 / 作废 / 替代);合同的「人工」在 `sourceCode` 闭集里没有唯一对应
  (`proxy`? `bulk`? `correction`?)故不自行选定。
  合同**未给**的一律不发明:`EvidenceSeal` 的「一活动至多一个 active seal」**不建**
  (§3.17 没给;§11.3「必需索引」只给 Closure 点了「partial unique active activity」),
  并用一条「第二条 active 必须放行」的 e2e 把"刻意不建"钉成会变红的判据。
  三个跨切片外键列 `offlinePackageId` / `importJobItemId` / `effectiveBatchId` **不建**
  (目标表分别在第 6 批与第四刀);其中 `OfflinePackage` 是**合同第三处内部矛盾** ——
  被修订说明 §5 列为核心新对象、被 §3.16 当外键列引用、被 §5.7 详述协议字段,
  但 §3 数据模型从头到尾**没有定义它**,故不从散文推导表结构。
