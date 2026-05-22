> **归档说明**(2026-05-22 PR-1 `docs: archive TASKS.md V1.1 and V2 design segments` 起)
>
> 本文件是 `TASKS.md` 原 §5 的历史快照,包含 **V2 设计期任务卡 V2-D1 ~ V2-D8** + **A 档基建快车道** §5.5(A1 / A2 / A3 / A4 / A5)。
>
> **当前状态**:
> - V2-D8 立项已于 2026-05-08 完成;V2 第一阶段开发(原 TASKS.md §6 Step 1-7)已全部 ✅
> - A 档:A1(soft-delete util)/ A2(redact paths 扩展)✅ 已完成;A3 ⏸️ 暂缓;A4 / A5 ❌ 不做
> - 本文件**只作历史证据**,不再作为当前执行约束
>
> **重要 redirect — V2.x 复活触发条件**(原 §5.5.4.3):
> - **当前事实**以 [`docs/V2红线与复活路径.md §4.3`](../../../V2红线与复活路径.md)(active 滚动维护)为准
> - 本文件归档版本仅作 **D7-min 决议时刻**(2026-05-07,commit `4333c31`)的历史快照
> - `audit_logs` 已在 v0.7.0 局部启动;`member_profiles` / `attachments` / `events` / `event_participants` **仍延后**(沿 V2 红线 §4.3 C-1 / C-7 / C-8 / C-9 / C-10)
>
> **承接当前事实**:
> - V2 第一阶段已交付能力 → [`docs/current-state.md §2`](../../../current-state.md) "V2 数据底座" / "V2 批次"段
> - 架构蓝图 → [`ARCHITECTURE.md §12`](../../../../ARCHITECTURE.md)(请先读顶部"当前阶段说明")
> - 完整数据模型 → [`docs/v2-data-model.md`](../../../v2-data-model.md)
> - 完整接口契约 → [`docs/v2-api-contract.md`](../../../v2-api-contract.md)
> - 长期 AI 协作铁律 → [`AGENTS.md`](../../../../AGENTS.md)(原 §18 V2 设计纪律已自承归档,仅保留 §18.4 / §18.4.1)
>
> **PR-1 归档边界**:`TASKS.md` 原 §5(lines 505-944,从 commit `bbc47bf` 起)完整迁出,**未做内容编辑**;V2-D5..D8 各任务卡的"完成情况"事实块原样保留。
>
> **外部引用提示**:`ARCHITECTURE.md` / `docs/V2红线与复活路径.md` / `docs/v2-plan.md` / `docs/v2-data-model.md` / `docs/srvf-foundation-data-model-draft.md` 中仍存在指向 `TASKS.md §5.5.4.3` 等的旧引用;**本 PR-1 不更新这些外部引用**(留给后续治理 PR);读者遇到旧引用时,以本文件 + V2 红线 §4.3 为准。
>
> 冲突时:**当前事实 / active 文档优先**,本归档让步。

---

## 5. V2 — srvf-nest-api 基础数据底座(设计阶段)

> **范围**:仅 `srvf-nest-api` 派生项目;不回流 `u-nest-api-starter` 模板仓。
> **本区块覆盖**:V2 设计与调研任务(§5.0-§5.4)+ 完全不依赖业务调研的 **A 档基建快车道**(§5.5)。**不含**业务模块开发任务 — 业务开发(含组织 / 字典 / 队员 / 附件 / 审计 / 事件等表与对应 controller/service/dto)须 V2-D8 通过后另起 `## 6. V2 — srvf-nest-api 基础数据底座(开发阶段)` 区块。
> **铁律依据**:[`docs/srvf-foundation-research.md`](./docs/srvf-foundation-research.md) + [`docs/srvf-foundation-baseline.md`](./docs/srvf-foundation-baseline.md) + `ARCHITECTURE.md §12` + `CLAUDE.md §18` + `AGENTS.md §18`。
> **当前阶段终点**:进入 `docs/srvf-foundation-data-model-draft.md` 起草并通过评审,**不是**进入开发。
> **解除条件**:V2-D7 完成后,另起 `## 6. V2 — srvf-nest-api 基础数据底座(开发阶段)` 区块,**禁止**在本节内追加开发任务。

### 5.0 范围速读

本阶段**只允许**以下动作:

- 读取既有代码 / 文档 / Git 历史
- 撰写 / 修改 V2 设计阶段的 4 类文档(研究 / 草案 / 蓝图登记 / 设计任务卡)
- 用户访谈 / 资料收集 / 调研结果回填
- 评审与标签化结论(已确认 / 当前倾向 / 待调研 / 暂不做)

本阶段**禁止**的动作清单见 `CLAUDE.md §18.1` / `AGENTS.md §18.1`,本节不重复。

**新增隐含约束(自 commit `16876fe` 起)**:本区块所有 V2 任务(含 §5.5 A 档快车道)默认遵守 [`docs/srvf-foundation-baseline.md`](./docs/srvf-foundation-baseline.md) 的全部规范(BizCode 段位、命名约定、响应包装、DTO 白名单、模块结构、错误码命名、配置归属、日志屏蔽、Guard、软删除、v1 兼容性、时区、验收门槛),**无需**逐任务重述。任务卡仅列任务**自身**的额外验收项;违反基线规范任一项视作越权,必须暂停并向用户说明(对应 baseline §14.2)。

### 5.1 任务总览

| 编号 | 标题 | 状态 | 前置 |
|---|---|---|---|
| **V2-D1** | 输出 `docs/srvf-foundation-research.md`(研究文档) | ✅ 已完成(初稿通过评审) | 无 |
| **V2-D2** | 同步追加 `ARCHITECTURE.md §12` | ✅ 已完成(本批次) | V2-D1 |
| **V2-D3** | 同步追加 `CLAUDE.md §18` / `AGENTS.md §18` | ✅ 已完成(本批次) | V2-D1 |
| **V2-D4** | 同步追加 `TASKS.md` V2 设计任务卡(本节) | ✅ 已完成(本批次) | V2-D1 |
| **V2-D5** | 调研访谈与资料收集(用户主导) | ✅ 已完成(commit `17486fe` / `92d7512`,访谈答案已回填 research.md §4 + 同步到 data-model-draft v0.2) | V2-D1..D4 |
| **V2-D6** | 输出 `docs/srvf-foundation-data-model-draft.md`(候选模型草案) | 🟡 v0.3 D7-min 决议版(commit `4333c31`,**非 D8 开发立项**) | V2-D5 阶段性产出 |
| **V2-D7** | 模型评审会 — 逐模型决议(实现 / 延后 / 砍掉) | ✅ **D7-min 已完成**(commit `4333c31`,4 进入 / 5 延后 / 0 砍掉) | V2-D6 |
| **V2-D8** | 设计阶段终点 — 决定是否进入开发立项 | ✅ **D8 立项文档完成(5/5),等待用户最后拍板进入 Step 1 开发** | V2-D7 |

#### A 档基建快车道(与 V2-D5..D8 并行,详见 §5.5)

| 编号 | 标题 | 状态 | 前置 |
|---|---|---|---|
| **A1** | 新增 `src/common/prisma/soft-delete.util.ts` 纯函数 helper + 单元测试 | ✅ 已完成(commit `d8fd444`) | V2-D2..D4 完成 + baseline §10.2 锁定 |
| **A2** | 日志屏蔽清单代码侧扩展(`src/bootstrap/logger-options.ts` `redact` 配置) | ✅ 已完成(commit `3c61dfa`) | V2 默认预屏蔽,后续新增敏感字段仍按 baseline §8.4 与 schema 同批次或先于维护 |
| **A3** | `biz-code.constant.ts` 加段位映射 JSDoc 注释 | ⏸️ 暂缓 | 等首次新增 V2 BizCode 时同 commit 联动 |
| **A4** | V2 通用命名 / DTO / Swagger / Guard / 验收 代码侧"适配" | ❌ 不做 | v1 已按 baseline 实现,无需"适配" |
| **A5** | 其他公共工具(时间格式化 / 字典查询 helper 等)预先抽象 | ❌ 不做 | YAGNI;真有第二个使用方时单独立项 |

### 5.2 任务卡

#### V2-D1 输出 `docs/srvf-foundation-research.md`(研究文档)

- **状态**:✅ 已完成
- **产出**:研究文档初稿 → 1 轮小修 → 评审通过,作为 V2 设计阶段的边界文档冻结
- **验收(已满足)**:用户对研究文档 §3 / §4 / §5 / §6 / §7 五节逐项确认无遗留意见

#### V2-D2 同步追加 `ARCHITECTURE.md §12`

- **状态**:✅ 已完成(本批次)
- **范围**:在 `ARCHITECTURE.md` 末尾追加 §12,仅包含"V2 派生项目方向"声明,**不**包含 schema / 字段 / API 路径 / 实施顺序
- **验收(已满足)**:
  - 不动 `ARCHITECTURE.md §1-§11`
  - §12 内容仅引用 `docs/srvf-foundation-research.md`,不重复罗列具体清单
  - 显式声明"派生项目专属"+"不破坏模板仓 freeze"

#### V2-D3 同步追加 `CLAUDE.md §18` / `AGENTS.md §18`

- **状态**:✅ 已完成(本批次)
- **范围**:V2 调研 / 设计阶段约束,**非执行约束**;两份文档对齐
- **验收(已满足)**:
  - 不动 `CLAUDE.md §1-§17` / `AGENTS.md §1-§17`
  - §18.1 列硬禁止清单(行为级)
  - §18.2 列设计期内容禁止(草案表达级)
  - §18.3 列设计期表达要求(措辞级)
  - §18.4 列协作纪律
  - §18.5 列工具链约束(Claude / 通用 agent 各一版本)
  - §18.6 列"顺手做"反模式
  - §18.7 列解除时机

#### V2-D4 同步追加 `TASKS.md` V2 设计任务卡

- **状态**:✅ 已完成(本批次,即本节)
- **范围**:仅设计阶段任务,**不含**任何开发任务
- **验收(已满足)**:
  - 任务名不得出现"实现 / 创建 / migration / service / controller / E2E / Swagger / Seed 落地"等执行词
  - 终点显式指向"是否进入开发立项",不是"完成开发"

#### V2-D5 调研访谈与资料收集(用户主导)

- **状态**:✅ **已完成阶段性调研回填**(2026-05-07)
- **前置**:V2-D1..D4 全部完成
- **执行主体**:**用户主导**,AI 仅做信息整理与文档回填
- **调研项**(对应研究文档 §4 待调研清单):
  - V2-D5.1 真实组织结构形态(层级深度 / 是否多树根 / 是否跨树移动)— 研究文档 §4.1
  - V2-D5.2 队员等级 / 资质体系形态(取值数量级 / 互斥关系 / 是否需要历史)— §4.2
  - V2-D5.3 敏感信息合规口径(身份证 / 紧急联系人 / 医疗信息的存储与访问规则)— §4.3
  - V2-D5.4 历史 / 版本化需求(是否需要 / 粒度 / 真实使用场景)— §4.4
  - V2-D5.5 一人多部门形态(常态 / 例外 / 是否区分主部门)— §4.5
  - V2-D5.6 events 模型承载范围(救援 / 训练 / 会议 / 公益活动 / 考核 字段差异)— §4.6
  - V2-D5.7 历史数据迁移需求是否存在(仅记录,不评估方案)— §4.7
  - V2-D5.8 字典是否需要"类型元数据"(决定双表 vs 单表)— §4.8
  - V2-D5.9 附件元数据归属模式(多态外键 vs 业务表自挂 vs 多对多)— §4.9
- **产出**:每项调研结论以 `已确认 / 当前倾向 / 待调研(延后) / 暂不做` 四档之一回填到研究文档 §4 对应小节
- **验收**:
  - 9 项 [待调研] 全部有阶段性结论或显式延后
  - 任何"我现在还不能定"的项标注为"延后到 V2.x"或"延后到草案评审中讨论",**不留白**
- **红线**:
  - 调研结果**不**直接写进 `ARCHITECTURE.md §12` 或 `CLAUDE.md §18` / `AGENTS.md §18`
  - 真实的部门名 / 等级取值 / 字典内容**不进**公共仓库 — 见研究文档 §5.1 与 §7-R13
- **完成说明**(2026-05-07):
  - **轻量访谈工具就位**:commit `c18db59` 交付 [`docs/srvf-foundation-interview-brief.md`](./docs/srvf-foundation-interview-brief.md)(450 行,18 题),设计为"被访谈人 20 分钟以内能答完",覆盖 9 个 [待调研] 项中的 8 个(§4.7 历史数据迁移略去,因 `research.md §3.15` 已锁定 V2 不做导入工具)
  - **research.md §4 回填(Stage 1)**:commit `17486fe` 把用户 18 题访谈答案翻译为四档结论,逐节追加 `#### 4.x.X 调研结论(V2-D5 回填,2026-05-07)` 子段,原 [待调研] 正文与标签保留
  - **data-model-draft v0.2 同步(Stage 2)**:commit `92d7512` 把 D5 结论联动到草案 §3 / §4 / §6 — §3.x.9 D5 调研结论(9 处)+ §4 D5 联动(4 处)+ §6 D5 进展三档标记(9 处)+ §7.1 v0.2 版本行
  - `docs/srvf-foundation-research-questions.md`(详细版 82 题)继续 Untracked,作为**升级路径**保留;若后续需要更深入访谈可启用
  - **当前 D5 状态**:**已完成阶段性调研回填**;9 个候选模型从"骨架级"演进到"形态级有阶段性结论"
- **D5 结论速览**(详见 `research.md §4` / `data-model-draft.md §3.x.9`):
  - 组织结构:单根树 / 3 层不写死 / 支持增删改但不可改父级
  - 队员部门:一人一部门(路径 B 保留中间表 + 单归属约束)
  - 队员等级:约 9 类走字典,不保留等级历史
  - 离队档案:完整保留
  - 敏感信息:F1 / F2 / F3 三问业务侧已答,**[当前倾向 + 合规待确认] C2**
  - events:升级为"全做(档 a 升级版)",大类+子类,兼容人工录入考勤
  - 字典:双表当前倾向,dict_items 父子树形(类别总数 / 异质性仍待补)
  - 附件:队员 + 活动归属,单归属默认,多态外键
- **后续如有补充访谈,作为 v0.3 增量回填**:
  - 不影响当前 D5 阶段性完成状态
  - 走相同三阶段流程(回填 research.md → 同步 data-model-draft → 同步 TASKS.md)
  - 触发场景示例:D7 评审中发现新的待调研项 / 用户主动恢复详细版访谈 / 合规口径 / 部门具体名单录入

#### V2-D6 输出 `docs/srvf-foundation-data-model-draft.md`(候选模型草案)

- **状态**:🟡 **v0.3 D7-min 决议版**(commit `4333c31`,**非 D8 开发立项**)
- **前置**:V2-D5 至少完成 §4.1 / §4.5 / §4.6 / §4.8 / §4.9 五项(决定模型形态的关键调研)
- **范围**:候选模型草案,每个模型必须带 6 维标签([稳/研][赖][敏][史][先])与"待确认清单"
- **草案应覆盖的 10 个候选模型**(顺序 ≠ 优先级,顺序 ≠ 实施顺序):
  1. dict_types / dict_items
  2. organizations(组织树)
  3. users(沿用 v1)+ 与 members 关联方案讨论
  4. members(队员主表)
  5. member_profiles(扩展资料)
  6. member_departments(关系中间表)
  7. attachments(通用附件元数据)
  8. audit_logs(审计)
  9. events(通用事件 — 含回退三档讨论)
  10. event_participants(参与关系 — 可能延后或砍掉)
- **草案应覆盖的 4 个跨模型模式**:
  - 字典使用模式(双表 vs 单表 + 回退条件)
  - 软删除模式(逐表评估)
  - 审计日志写入模式(显式 vs 拦截器 + 回退条件)
  - 附件归属模式(多态外键 vs 业务表自挂 vs 多对多)
- **验收**:
  - 10 个候选模型全部带 6 维标签
  - 4 个跨模型模式各列**至少 1 个备选方案 + 回退条件**
  - 不出现 Prisma DSL / API 路径 / 最终 ER 图 / 真实救援队字典内容
  - 与研究文档 §3 / §6 无冲突;若有冲突,先回到研究文档评审
- **红线**:草案禁止"实现 / 创建 / 落表"措辞;只允许"形态 / 候选 / 待确认 / 风险"措辞
- **演进轨迹**(2026-05-07):
  - **骨架版(v0.1)**:commit `308ce5a` 交付 `docs/srvf-foundation-data-model-draft.md` 初稿(1014 行) — 9 候选模型 + 6 跨模型模式 + baseline 锁定清单 + D5 依赖列表
  - **v0.2 含 D5 结论**:commit `92d7512` 同步 D5 访谈结论(基于 commit `17486fe` research.md §4 回填),改动 +344 / -16,文件总行数 1342:
    - §2 总览表 [先] 列升级为"当前倾向"
    - §3.x.9 D5 调研结论子段(9 处)
    - §4 跨模型模式 D5 联动(§4.1.6 / §4.2.5 / §4.5.5 / §4.6.4,4 处)
    - §6 D5 调研依赖列表三档进展标记(9 处)+ §6.X 整体速览表
    - §7.1 v0.2 版本行
  - **v0.3 D7-min 决议**:commit `4333c31` 同步 D7-min 决议(路线切换为"V2 第一阶段最小可开发版"),改动 +391 / -19,文件总行数 1714:
    - §2 总览表 [先(D7-min)] 列升级为最终决议
    - §3.x.10 D7-min 决议子段(9 处) — 4 进入模型锁定 schema 决策摘要 / 5 延后模型写明延后原因 + 复活路径
    - §4 跨模型模式 D7-min 联动(§4.1.7 / §4.2.6 / §4.3.4 / §4.4.5 / §4.5.6 / §4.6.5,6 处)
    - §6.Y D7-min 决议速览
    - §7.1 v0.3 版本行
- **当前 D6 状态**:🟡 **v0.3 D7-min 决议版**
  - 4 模型形态级方向 D7-min 已锁定:`dictionaries` / `organizations` / `members` / `member_departments`(进入 V2 第一阶段)
  - 5 模型 D7-min 已锁定延后:`member_profiles` / `attachments` / `audit_logs` / `events` / `event_participants`(全部延后到 V2.x,无砍掉)
  - **仍非 D8 开发立项**;V2 第一阶段进入开发由 D8 决议拍板
- **下一步**:
  - **V2-D8 决策**(用户拍板):是否升级 `ARCHITECTURE.md §12` 为开发蓝图(§12.7+);是否新建 `docs/v2-plan.md` / `docs/v2-data-model.md` / `docs/v2-api-contract.md`;是否在 `TASKS.md` 新增 §6 V2 开发阶段
  - 通过 D8 → V2 第一阶段开发启动(4 模型 + v1 `users.memberId` 可空外键追加)
- **明确禁止**(承接草案 §0.3 / §7.3 / §3.x.9 / §3.x.10 各模型尾注):
  - **不得**据此直接开发 schema / migration / API / V2 业务模块 controller / service / dto
  - **不得**因 v0.3 落地就把"V2 第一阶段进入"视为"已拍板开发"
  - **不得**绕过 D8 决策直接进入实施层
  - 开发阶段以 D8 决议为准

#### V2-D7 模型评审会 — 逐模型决议

- **状态**:✅ **D7-min 已完成**(commit `4333c31`,2026-05-07)
- **前置**:V2-D6 完成
- **路线**:**V2 第一阶段最小可开发版(D7-min)** — 用户拍板从原计划"完整 D7-1/D7-2/D7-3/D7-4 分批评审" → "最小可开发版一次拍板",理由:效率优先,先完成人员底座闭环;5 延后模型保留 V2.x 复活路径
- **9 模型最终决议**:
  - ✅ **进入 V2 第一阶段(4 个)**:`dictionaries` / `organizations` / `members` / `member_departments`
  - ⏸️ **延后到 V2.x(5 个)**:`member_profiles` / `attachments` / `audit_logs` / `events` / `event_participants`
  - ❌ **砍掉**:**无**(所有延后模型保留 BizCode 段位 + 形态级讨论作为 V2.x 起点)
- **D7-2 / D7-3 / D7-4 转为 V2.x 触发条件**:
  - 原计划 D7-2(members + member_departments):**已合并**到 D7-min,完成
  - 原计划 D7-3(member_profiles 合规专场):**转为 V2.x 触发** — 等合规材料补齐后启动
  - 原计划 D7-4(events + event_participants):**转为 V2.x 触发** — 等用户拍板需求后启动
- **产出**:草案 v0.3 D7-min 决议版(`docs/srvf-foundation-data-model-draft.md` commit `4333c31`)
  - §3.x.10 9 个模型决议子段就位
  - §4 6 个跨模型模式 D7-min 联动子段就位
  - §6.Y D7-min 决议速览就位
  - §7.1 版本表 v0.3 行就位
- **验收(已满足)**:
  - 9 个候选模型全部有决议(无悬空)
  - 4 进入模型锁定 schema 决策摘要(D-/O-/M-/MD- 编号)
  - 5 延后模型写明延后原因 + 复活路径
  - 草案进入"D7-min 决议版"状态(仍非 D8 开发立项)
- **红线**(沿用 + 强化):
  - 评审通过 ≠ 开发启动;**V2-D7-min 完成后仍禁止** schema / migration / 模块代码动作
  - **D8 仍需用户单独拍板**;不得因 D7-min 已完成就跳进 D8 / 跳进开发
  - 4 个跨模型模式全部拍板单一方案(可以是"暂时保留双方案对比",但需写明触发选边的条件)
  - 草案文档进入"冻结"状态,后续修改需走变更说明
- **红线**:评审通过≠开发启动;V2-D7 完成后仍**禁止** schema / migration / 模块代码动作

#### V2-D8 设计阶段终点 — 决定是否进入开发立项

- **状态**:✅ **立项文档完成,等待用户最终开发拍板**(2026-05-08)
- **前置**:V2-D7 完成 ✅
- **决议**:**A. 进入开发**(用户已拍板,5 份立项文档已就位)
- **已交付的 5 份立项产出物**:
  - **D8-1** `ARCHITECTURE.md §12.8-§12.11` V2 第一阶段开发蓝图 — commit `85cec75`
  - **D8-2** `docs/v2-plan.md` V2 第一阶段开发执行计划(7 步顺序 + 每步任务卡)— commit `bff9c93`
  - **D8-3** `docs/v2-data-model.md` 4 模型 + `users.memberId` 数据模型说明 — commit `af236f2`
  - **D8-4** `docs/v2-api-contract.md` 29 个 V2 接口契约草案 — commit `627eda5`
  - **D8-5** `TASKS.md §6` V2 第一阶段开发任务卡(本次同步 commit)— 见 §6
- **第一阶段开发范围(D7-min 锁定)**:
  - ✅ `dictionaries`(`dict_types` + `dict_items`)
  - ✅ `organizations`
  - ✅ `members`
  - ✅ `member_departments`
  - ✅ v1 `users.memberId` 可空外键追加
- **延后到 V2.x**(无砍掉):
  - ⏸️ `member_profiles`(合规未补)
  - ⏸️ `attachments`
  - ⏸️ `audit_logs`(V2.x 第一个增量)
  - ⏸️ `events`
  - ⏸️ `event_participants`
- **明确禁止**(D8 立项完成 ≠ 开发启动):
  - ❌ **未经用户最后拍板,不得修改 `prisma/schema.prisma`**
  - ❌ **不得生成 migration**
  - ❌ **不得新建 V2 controller / service / dto**(`src/modules/dictionaries/` / `organizations/` / `members/` / `member-departments/` 任一)
  - ❌ **不得写 seed 真实业务取值**(neutral-demo 也需 Step 2 启动后才写)
  - ❌ **不得开始 Step 1**(V2-D8 ✅ 仅表示立项文档就位;开发由用户单独拍板触发)
  - ❌ 不得据此跳过 §6 的 7 步开发顺序
  - ❌ 不得据此偷开发延后 5 模型
- **D8 关闭后下一步路径**:
  - 用户拍板"启动 V2 第一阶段开发" → 进入 §6 任务卡 Step 1
  - 用户拍板"延后开发" → §6 各 Step 维持 ⏳ 待启动;V2-D8 状态保持 ✅(立项档案)
  - 用户拍板"范围调整" → 回到 V2-D6 / D7-min 重新拍板;§6 任务卡可能需重新校对

### 5.3 通用执行 checklist(适用 V2-D2..D7 任意文档型任务)

每次 V2 设计阶段任务开始前 / commit 前,逐项过一遍:

- [ ] 本次动作仅修改文档,未修改 `src/**` / `prisma/**` / `test/**` / `package.json` / `pnpm-lock.yaml` / `Dockerfile` / `docker-compose.yml` / `.github/workflows/**`
- [ ] 本次动作未运行 `pnpm add` / `prisma migrate` / `prisma db push` / `prisma generate` / 任何 seed 写入
- [ ] 文档措辞使用四档标签(已确认 / 当前倾向 / 待调研 / 暂不做),无模糊措辞
- [ ] 涉及救援队真实信息(部门名 / 等级 / 字典内容)的内容**未**进入公共仓库历史
- [ ] 与研究文档 §3 / §6 无冲突;若发现冲突,已先回到研究文档评审
- [ ] commit 仅含文档变更,message 前缀为 `v2-design: <章节> <简述>`

### 5.4 范围外的统一处理

V2 设计阶段任务执行过程中遇到任何"看起来该顺手做"的事项(不论是代码、schema、依赖、测试、新文档),**全部**走以下流程:

1. **暂停**,不要先实现 / 不要先写
2. 在与用户的对话里声明:这件事在 V2 设计阶段范围外,具体属于:
   - `CLAUDE.md §18.1` / `AGENTS.md §18.1` 的哪条硬禁止?
   - `CLAUDE.md §18.2` / `AGENTS.md §18.2` 的哪条内容禁止?
   - 研究文档 §3 的哪条暂不做项?
3. 由用户决定:
   - **a. 写入研究文档 §4 待调研项**(若需要进一步调研)
   - **b. 等待 V2-D6 草案阶段处理**(若属于模型形态决策)
   - **c. 等待 V2-D8 / 后续开发阶段处理**(若属于实现层动作)
   - **d. 直接放弃**(若不需要)

**禁止**未经用户确认就动作。这是 V2 设计阶段最容易破口的地方,与 V1.1 §4 的纪律一致。

---

### 5.5 A 档 — V2 基建快车道(与 V2-D5..D8 并行)

#### 5.5.0 范围与边界

A 档快车道源自 [`docs/srvf-foundation-baseline.md`](./docs/srvf-foundation-baseline.md) 锁定的"完全不依赖业务调研"的通用基建,与 V2-D5..D8 设计阶段任务**并行而非替代**。

**A 档允许做的**:

- ✅ 基线规范代码侧落地(纯函数 helper 等)
- ✅ 与业务调研结果**完全无关**的内部基建
- ✅ 新建 `src/common/<新子目录>/` 中的纯工具文件

**A 档禁止做的**(违反任一视作越权):

- ❌ 绕过 D6/D7 引入业务表 / Schema / 业务模块 controller/service/dto
- ❌ 实现研究文档 §3 任一暂不做项
- ❌ 在没有 D5 调研结果支撑下决策业务模型字段集
- ❌ 修改 v1 已交付 src/(`auth/` / `users/` / `health/` / `config/` / `common/` 已有文件 / `database/` / `bootstrap/`)— 这是 `CLAUDE.md §18.1` 的硬禁止,**新建** `src/common/<子目录>` 不算修改既有

**A 档存在意义**:让 V2 在调研周期内仍能稳步推进**不依赖业务结论**的基建,而**不**为快进 D6/D7 而牺牲设计纪律。

#### 5.5.1 A 档任务总览

(见 §5.1 末尾的 A 档表格,本节不重复)

#### 5.5.2 任务卡

##### A1 新增 `src/common/prisma/soft-delete.util.ts` 纯函数 helper

- **状态**:✅ 已完成
- **commit**:`d8fd444` `chore: add soft-delete pure-function util`
- **交付**:
  - `src/common/prisma/soft-delete.util.ts`(22 行,导出 `notDeletedWhere<T>`)
  - `src/common/prisma/soft-delete.util.spec.ts`(61 行,8 个单元测试)
- **形态铁律对照**:baseline §10.2.2(纯函数;**不**引入 class / `@Injectable` / Prisma middleware / client extension / BaseRepository / 装饰器 / Pipe / Guard / Interceptor)
- **影响**:零 — 未接入任何 service,v1 接口契约不变,Prisma schema / migration / package 全部不动
- **验收(已满足)**:
  - `pnpm lint` ✅(0 warnings / 0 errors)
  - `pnpm typecheck` ✅(tsc src + tsc test 双段无错)
  - `pnpm test` ✅(3 suites / 119 tests,新 spec 8 测全过)
  - `pnpm test:e2e` ✅(19 suites / 162 tests,v1 零退化)
  - `pnpm test:contract` 不需要(不涉及 OpenAPI)

##### A2 日志屏蔽清单代码侧扩展

- **状态**:✅ 已完成
- **commit**:`3c61dfa` `chore: extend log redact paths for V2 sensitive fields`
- **解锁路径**:用户在 A4 批次评估中显式许可触碰 `src/bootstrap/`(`CLAUDE.md §18.1` 列入禁止区);经评估**字段尚未落表 → 屏蔽规则提前加无害**(pino redact 路径不命中即跳过,零运行时副作用),baseline §8.4 同时允许"先于"字段落表,故采用"防御性预扩展"路径
- **交付**:
  - `src/bootstrap/logger-options.ts`(+62 / -1):在 v1 既有 16 项 redact paths 之上**追加** 7 个分类共 39 个 V2 字段(个人身份证 / 联系方式 / 医疗健康 / 财务防御 / 地址 / 出生信息 / 第三方账号与凭证)
  - `src/bootstrap/logger-options.spec.ts`(+153,新建):58 个静态断言测试,覆盖 v1 既有项保留 + V2 39 字段就位 + 整体属性(无重复 / 无空 / `censor === '[REDACTED]'`)
- **形态铁律对照**:baseline §8.2(屏蔽清单分类)+ baseline §8.4(修订纪律 — "字段不存在时无害,字段一旦落表自动生效")
- **关于子串通配规则**:baseline §8.2 提到的 `secret` / `credential` / `private` / `pwd` 子串通配,**pino `redact.paths` 不支持**;本次仅枚举具体字段名,源码注释中已显式声明此局限;子串约定继续作为团队规范由 code review 守护
- **验收(全过)**:
  - `pnpm lint` ✅(0 errors)
  - `pnpm typecheck` ✅(双段无错)
  - `pnpm test` ✅(4 suites / 177 tests,新 spec 58 测全过)
  - `pnpm test:e2e` ✅(19 suites / 162 tests,v1 零退化)
  - `pnpm test:contract` 不适用(redact 不影响 OpenAPI schema)
  - B 档启动验证 ✅:`pnpm start:dev` 1 秒就绪 / `GET /api/health/live` HTTP 200 / `GET /api/docs-json` HTTP 200(32 KB)/ 启动日志无 redact 解析错误 / SIGTERM 优雅关闭(2 秒内端口释放)
- **不影响范围**(零变更):Prisma schema / migration / seed / `package.json` / v1 14 接口契约 / v1 16 项原 redact paths / logger 行为架构 / 全局中间件注册 / Guard / Pipe / 拦截器
- **后续维护**:再有敏感字段进入 schema 时,仍**必须**按 baseline §8.4 在**同批次或先于** schema commit 维护本清单(见 §5.5.4)

##### A3 `biz-code.constant.ts` 加段位映射 JSDoc 注释

- **状态**:⏸️ 暂缓
- **范围**:在文件顶部加 baseline §1.1 总段位映射的 JSDoc 注释(**不改任何代码值**)
- **暂缓原因**:
  - 仍触碰 v1 src/(虽只加注释,仍属修改 v1 已交付文件)
  - 价值低 — 段位映射在 baseline §1.1 已锁,代码内不重复登记不影响开发
  - 真新增 V2 BizCode 时本就要打开此文件,届时一并做更经济
- **解锁条件**:首次有 V2 模块需要在 `biz-code.constant.ts` 新增 BizCode 时,**与该新增同 commit** 完成注释扩展
- **不独立立项**:同 A2

##### A4 V2 通用命名 / DTO / Swagger / Guard / 验收 代码侧"适配"

- **状态**:❌ 不做
- **原因**:这些规则在 baseline §2 / §3 / §4 / §6 / §7 / §9 / §13 中是"约定 / 政策";v1 / V1.1 代码已按相同政策实现(全局 `ValidationPipe` / `ResponseInterceptor` / `AllExceptionsFilter` / `@ApiWrappedXxx` 三装饰器 / Guard 全局注册 / `IdParamDto` 等)。V2 新模块按规范写即可,**无需**专门"适配"。
- **何时复活**:除非未来发现 v1 实现与 baseline 政策出现实质偏差(届时按 v1 §6 接口兼容性优先,以 baseline 让步)。

##### A5 其他公共工具(时间格式化 / 字典查询 helper 等)预先抽象

- **状态**:❌ 不做
- **原因**:无现有使用方,过早抽象违反 YAGNI。任何公共工具应"先有第二个使用场景,再抽公共"。
- **何时复活**:某 V2 业务模块开发时发现需要的工具与已有 helper 形态相近,**且至少有两个使用方**,才抽公共;单使用方继续放在该模块内。

#### 5.5.3 与 V2-D5..D8 的关系

- **A 档不绕过 D6/D7**:A 档只做"无 schema、无业务模块"的基建;任何业务模型表设计仍走完整 D5 → D6 → D7 → D8
- **A 档不替代 D5 调研**:A 档不能用"先做基建"当借口跳过敏感字段 / 等级 / 组织结构的调研
- **A 档与 D5 解耦推进**:A 档不依赖 D5 业务调研结论,A1 已证明在 D5 任意阶段(暂停 / 进行中 / 已完成)均可独立推进
- **A 档完成不触发 D8 升级**:A 档完成 ≠ "开发阶段开启";开发阶段仍以 D8 决议为准

#### 5.5.4 A2 / A3 解锁触发器

#### 5.5.4.1 A2 已提前完成(自 commit `3c61dfa`)

A2 已经以"防御性预扩展"路径完成 V2 默认预屏蔽,**不再**等待"首个敏感字段进入 schema"触发。

后续维护规则(承接 baseline §8.4):

| 后续场景 | 维护要求 |
|---|---|
| 新增敏感字段到任何 V2 schema | **必须**按 baseline §8.4 在**同批次或先于**该 schema commit 维护 `LOG_REDACT_PATHS` 清单与对应单元测试 |
| 重命名已屏蔽字段 | 同 commit 更新清单,旧名称防御性留置 |
| 删除已屏蔽字段 | 清单条目**保留**(防御性留置,避免后续误恢复字段时漏屏蔽) |
| 引入新类别敏感字段(生物特征 / 位置轨迹 / 图像内容描述等) | 必须扩展 baseline §8.2 分类 + 同 commit 扩展本清单 |

#### 5.5.4.2 A3 解锁触发器(未变)

A3 解锁的规则:**与 v1 src/ 改动同 commit 才有实质价值**。

| 触发场景 | 联动任务 |
|---|---|
| 首次新增 V2 模块的 BizCode | A3 联动(同 commit 加段位注释) |
| 其他"顺手做"反模式 | 暂缓,等独立任务 |

A1 / A2 已分别独立完成;A3-A5 中的 A3 仍要求**搭车**于业务任务,**不**独立立项;A4 / A5 标记"不做"维持。

#### 5.5.4.3 V2.x 复活触发条件(D7-min 延后模型,自 commit `4333c31`)

D7-min 决议(§5.2 V2-D7)原将 5 个模型延后到 V2.x;复活触发条件如下,**任一即可启动对应延后模型的 V2.x 立项**:

> **当前状态**(v0.7.0 后):`audit_logs` 已作为 V2.x 第一个增量于 v0.7.0 局部启动(批次 6 经业务确认稿 + D6 评审 + 用户拍板 + PR #29 / PR #30 实施);**仍延后 4 个**:`member_profiles` / `attachments` / `events` / `event_participants`;`audit_logs` 剩余 22 处 `auditPlaceholder` 调用渐进迁移见 [`docs/V2红线与复活路径.md`](../docs/V2红线与复活路径.md) §4.1 C-1。

| 模型 | V2.x 复活触发条件 | 复活后流程 |
|---|---|---|
| `member_profiles` | **合规材料补齐**:永久保存敏感信息合规依据 + 数据最小化说明 + 退队最小化处理方案 + 医疗信息"紧急通知等"用途的更具体表述(应急联络 / 安全保障 / 出动风险参考) | 启动 D7-3 评审 → V2.x 开发立项 |
| `attachments` | 任一即可:(a) `member_profiles` 解锁(承载证件附件元数据);(b) `events` 解锁(承载活动现场照 / 纪要);(c) 用户拍板独立的"队员档案附件"需求 | 启动 D7 attachments 评审 → V2.x 开发立项 |
| `audit_logs` | **作为 V2.x 第一个增量启动**(无独立触发条件,跟随 V2.x 启动节奏);接入 V2 第一阶段已交付 4 模型的关键写操作(管理员状态变更 / 删除 / 角色变更 / 部门归属变更等) | ✅ **v0.7.0 第一波已实施**(`emergency-contacts` + `certificates` 8 处写操作 + 2 查询接口);剩余 22 处迁移见 `docs/V2红线与复活路径.md §4.1 C-1` |
| `events` | 用户拍板需求(救援队需要在系统中记录哪些类型的活动 / 事件成为强诉求) | 启动 D7-4 评审(对应原计划批次)→ V2.x 开发立项 |
| `event_participants` | **跟随 events 复活路径**(无独立触发条件) | 与 events 同批进 V2.x 开发立项 |

**所有延后模型保留**:

- BizCode 段位(baseline §1.1):`130xx`/`131xx`(attachments)/ `140xx`/`141xx`(audit_logs)/ `160xx`/`161xx`(member_profiles)/ `180xx`/`181xx`(events)/ `190xx`/`191xx`(event_participants)
- 草案 §3.x.1 - §3.x.10 形态级讨论作为 V2.x 起点
- D5 调研结论 + D7-min 决议作为 V2.x 起手时的"当前倾向"

**复活时的红线**(D7-min 已锁,V2.x 不再重新讨论):

- `member_profiles`:任何敏感字段进入实施层前**必须**走 `research.md §4.3` 三问 + 合规依据补全
- `events`:回退档"全做(档 a 升级版)"沿用;但**禁止**强行通用化做大宽表;**禁止**完整状态机引擎;**兼容人工录入考勤** + **报名考勤维持弱关联**
- `audit_logs`:不替代版本化;不读审计;`before/after` 快照写入前必须按 baseline §8 屏蔽
- `attachments`:**仅元数据,不实装 Provider**(沿用 `research.md §3.10`)
- 真实业务取值(部门名 / 等级名 / 字典内容)继续不进 git history(R13)

#### 5.5.5 A 档执行 checklist

A 档任务**不**适用 §5.3 的"仅文档变更" checklist(A 档涉及代码)。改用以下:

- [ ] 本次动作严守 baseline §10.2.2 / §13 / 任务卡对应章节的形态铁律
- [ ] 不接入任何现有 service / controller / Prisma path(除非任务卡显式声明搭车)
- [ ] 不引入新依赖(`package.json` / `pnpm-lock.yaml` 不变)
- [ ] 不修改 `prisma/schema.prisma` / `migrations/` / `seed.ts`
- [ ] 不修改 v1 已交付 src/(`CLAUDE.md §18.1` 列出的禁止区)
- [ ] 跑 baseline §13 验收门槛对应档位:
  - 纯新增 src 文件且不接入任何运行路径 → 仅 A 档(`pnpm lint` / `pnpm typecheck` / `pnpm test` / `pnpm test:e2e`;`pnpm test:contract` 仅当影响 OpenAPI 时跑)
  - 涉及全局中间件 / 拦截器 / Guard / Controller / Swagger → A + B 档
- [ ] commit message 前缀按性质区分:
  - 纯基础设施代码:`chore: <简述>`
  - V2 设计文档同步:`v2-design: <简述>`
  - 修复:`fix: <简述>`

---
