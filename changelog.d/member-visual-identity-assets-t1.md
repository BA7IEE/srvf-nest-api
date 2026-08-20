### Added

- **队员视觉身份资产终态升级 —— expand 段(issue #1055 T1)**:把当前混在一起的三类图片
  (账号头像 / 队员标准照 / 身份证件影像)拆成三条独立链,本刀只建地基、**不切任何读写路径**。
  - 新模型 `MemberOfficialPortrait`(表 `member_official_portraits`):队员标准照的**版本历史**。
    每次替换新建一行、旧行转 `SUPERSEDED` 保留,正式材料(队员证 / 年度名录 / 对外报送)
    引用具体 `MemberOfficialPortrait.id` 而不是"当前那张" —— 换照片不会让已定稿的材料背后变图。
  - `User.avatarAttachmentId`:账号头像从裸 storage key 改为指向真实 Attachment。
    本刀与既有 `User.avatarKey` **刻意并存**(expand/contract 中间态,中间没有任何代码同时写两列);
    `avatarKey` 连同其全部读写契约在 T5 一次删净。
  - 两个 internal-only owner type(`user-avatar` / `member-official-portrait`)及其
    `attachment_type_configs` 默认行(JPEG/PNG,10 MiB)。二者在**每一个通用 Attachment 端点上
    fail-closed**,只能走各自的专用 facade —— 通用接口无从知晓「必须是本人的」
    「一个 Member 至多一张 ACTIVE」「替换要版本化」这些领域不变量。
  - 权限码 `member-portrait.manage.record` / `member-portrait.read.history`
    与 6 个审计事件名(`user.avatar.{change,clear}.self`、
    `member.official-portrait.{activate,replace,void,purge}`):**只登记不接线**,
    消费方在 T3 / T4 到位(沿证书标准库 PR-2「事件名先落」范式)。

### 数据库约束(第 91 个 migration,纯 additive)

Prisma DSL 表达不了、因而手写在 migration 里的部分:

- partial unique `member_official_portrait_one_active_per_member`(`WHERE status = 'ACTIVE'`)
  —— 一个 Member 至多一张 ACTIVE 标准照。它是唯一**不依赖应用代码写对**的兜底:
  替换事务是「旧行转 SUPERSEDED + 新行 ACTIVE」两步,并发时行锁保证串行但不保证后来者重读。
- 4 条 CHECK:ACTIVE 行相容性(须有二进制、不得带终结/清理字段)· 终态行须留下终结人与时刻 ·
  已清理二进制的行不得仍指向附件 · `specVersion` 受控闭集(当前仅 `uniform-portrait-v1`)。

**每条约束都配了一个违反它的负面用例,外加 3 条反向对照**证明它们不是恒红
(第二条 SUPERSEDED 必须放行 / 多个 NULL 头像必须共存 / 附件删后版本行必须留存并置空指针)。

### 两处有理由的偏离

- **`activatedAt` 不给 `@default(now())`**(issue §5.2 的建议模型里有)。有默认值时应用侧漏传
  就悄悄吃库时钟,而「写用库时钟、判用应用时钟」在本仓是一整类缺陷。无默认值 ⇒ Prisma `create`
  必填 ⇒ 漏传是编译错误。顺带让 T4 的替换事务能把旧版 `endedAt` 与新版 `activatedAt`
  取同一瞬间,版本历史不留缝也不重叠。
- **两条新权限码登记但不绑任何角色**。issue §8.1 明写 `member-portrait.manage.record`
  必须走组织数据范围;而 `biz-admin` 的绑定是 GLOBAL 的,先绑再收回等于缩小既有角色权限。
  绑定与 scoped 判权一并在 T4 定。

### Changed

- internal-only owner 名单从**三份手抄副本**(一个三路 `||` + 两个内联 `notIn` 数组)收敛成
  唯一常量 `INTERNAL_ONLY_ATTACHMENT_OWNER_TYPES`。此前新增一个 internal owner 要同时改三处,
  漏任何一处都是静默敞口(漏 predicate = 写路径洞开;漏 `notIn` = 内部附件泄进通用列表),
  且三处都不会因漏改而编译失败或测试变红。常量带 `satisfies` 约束,拼错一个字符即编译错误。
  **对既有 owner type 的行为逐字不变**。
