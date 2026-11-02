# Activity OS 常规活动首版执行台账

本台账承接用户提供的执行附件；不重开架构设计。L0 只执行本次有界核对，后续在此更新真实结果。尚未实施的接口标为 NOT_IMPLEMENTED，尚未运行的验证标为 NOT_RUN。合并不代表上线。

## 附件和采用基点

- Library：`libfile_f78e51360a1481919258e929ceedf96c`；ZIP 28149 字节，SHA256 `cb3d12ce16b6528fa94c66ff38d7912272ac56e1171ed8e10bb66d7287919312`，已正式物化、独立核大小/摘要、CRC、安全解包并完整阅读。
- `SRVF_ActivityOS_V1_Agent_Execution_Plan_2026-11-02.md`：56760 字节，SHA256 `c3045670632b3cfc8306a22d87b135aadd33de46b41cdb3d1a0947317e261e61`。
- `SRVF_V1_release_manifest.template.yaml`：8310 字节，SHA256 `f7e9f6ba81aa22a92ba8d82164b3b3ad10bc7f2e51770ec9afc1627d51b27141`。
- 后端 remote main：`2fd2a952f77847b498c5438abe4bdb163f25f66f`。#1395：`e37aadb7b094cc770578de4ba52b22587da7bfd8`，完整 CI `41385476216` 15/15 PASS；原 Trusted `41385474139/job/125085350947` 已由用户放行并 PASS；转 Ready 后新 Trusted `41398313337/job/125124459340` WAITING，尚未合并。
- L2 隔离分支：`codex/activityos-v1-single-session-20261102`，基于 #1395 精确 head，不修改其冻结工作树。依赖离线冻结安装、Prisma 生成、`agent:preflight --lane routine_v1` PASS。
- 前端 remote main：`e9da19ec0a937708d535f2d58677101affc4d0e9`。唯一前端 owner 在 2026-11-02 04:48:43 UTC 报告本地 HEAD 相同、13 文件全暂存、tree `23eb16b9c4edbc447655eb01126379277520ac96`、无其他 dirty/conflict；无开放 PR、无候选远端分支。之后 owner 开始 A14 修复，集成前必须取得新的 tree/摘要。
- 前端原候选 Library `libfile_d2c9111820008191ab3b636400310c37`，461114 字节，SHA256 `0556c61723b3754be0f183a437b2797c786a3cb6f5f84a221ffbd20f5b31cb05`；本环境已正式物化并逐项核 13 源文件和 patch。R5 回执/任务恢复与三个统计修复必须保留，不覆盖。

## L0 清点结论

| 工作 | 实际状态 | 本轮处理 |
| --- | --- | --- |
| 后端 #1395 25 文件 | 模板 V4/V5 目录修复、45 unit、2 真实 HTTP、生成物和合法契约声明均已在该 PR；完整 CI PASS | 直接承接，不重复开发；不把 L2 混入该 PR |
| 正式报名→场次 punch→封场→结算→贡献/统计 | `libfile_a907390777848191af99c50c59f050c2` 已有真实小活动证据；独立分支还留 2 个未提交测试文件，不在 #1395 | 保留工作树和真实证据，不重跑成功对象；不冒充本轮 Admin 界面贯通 |
| 前端未合并 13 文件 | R5 回执和统计候选，原 tree 已核；A14 由同一前端 owner 继续 | 后端不写前端；新合同交唯一 owner 接入 |
| #1392 | 4 文件 nightly 分片调整，Draft/未合并 | 不盲合；#1395 已过完整 CI，不以其为前置 |
| 其他旧工作树 | 已记录路径、HEAD、porcelain 状态和实际文件摘要 | 不 reset、stash、clean 或覆盖 |
| 生产目标及只读连接 | 未提供，UNKNOWN；本云端无相应身份 | 不连接生产、不运行测试 SQL；L4 单列预检 |

本环境完整清点证据位于 `activityos-v1-l0-20261102/evidence/`，随交接包保留，不写入业务源码或上传任何凭据/成员资料。正式旅程的两项本地改动是 `test/journeys/activity-formal-time-contribution.realtime-spec.ts` 与 `test/support/journey-activity-registration-checkin.ts`，没有被复制进 L2。

## 已存在的接口与边界

| 动作 | 当前真实接口/业务链 | 授权及注意事项 |
| --- | --- | --- |
| 可发起组织、安全模板摘要 | App `GET /api/app/v1/my/managed-activities/organization-options`、`template-version-options` | 当前有效正式成员、现有组织准入；模板摘要保留 13 字段和精确版本/hash，不要求 GLOBAL 模板管理权 |
| 创建 | Admin `POST /api/admin/v1/activities` 仍走旧 ActivityWriteService；App `POST .../managed-activities/from-template` 走 B6 根事务 | Admin 现入口并不等于 B6 创建；创建权限不包含政策选择或审核权限 |
| 详情/旧编辑 | Admin `GET/PATCH /api/admin/v1/activities/{id}` | 现有详情和更新权限保留；旧 PATCH 未提供本轮完整父子/地点/政策一致保存合同 |
| 提交发布 | App `POST .../{activityId}/publish-reviews` 有客户端 operationKey；Admin `PATCH .../{id}/publish` 通过 compatibilityPublish 调当前 proposal | 工作流开启时 HTTP 成功只代表提交审核，不代表 published；兼容桥使用服务端随机键，前端 A14 必须显示真实状态 |
| 发布审核 | Admin `GET /api/admin/v1/activity-publish-reviews`、`GET /{id}`、`POST /{id}/approve`、`POST /{id}/return` | 复用现有 scoped reviewer binding、read/approve/return 授权和独立审核规则 |
| 变更/取消/结束 | App 当前 change-reviews；Admin cancel、complete 已存在 | 已发布事实走变更审核；complete 不是正式封场、结算审核或账本发布的替代入口 |
| 正式封场/结算/更正 | 当前 evidence-seals、allocation、time-settlement、Human request/review/prepare/job/status/retry 链已实现 | 复用现有权限、预算、原子账本/audit/outbox；不因补 Admin 表单而重写 |

## L2 短合同与最小写集

以下六个 Admin 接入面现已全部实现。独立隔离 PG16 q6/q8 的真实普通 USER、组织范围授权（无 GLOBAL binding）创建／整体保存／独立发布审核链 PASS；复核指出的当前专业时段/窗口覆盖风险已修复。全量单测发现的重复日界换算已改为复用既有公共工具，最终运行字节由 q8 再验。四处派生同步经用户批准，q7 完整 OpenAPI 契约 1126/1126 PASS；全 CI 由新 Draft PR 冷跑裁决。

| 方法及路径（均加 `/api/admin/v1/activities`） | 最小输入/结果 |
| --- | --- |
| `GET /organization-options` | 当前本人可发起组织；复用现有 formal member 和组织检查 |
| `GET /template-version-options` | `organizationId/page/pageSize`；与 #1395 相同安全摘要、分页/候选上限/精确引用校验 |
| `POST /from-template` | 现有 Quick 根事实、精确 templateVersionId、operationKey、类型化地点；可选封闭 `instance` 本次参数；返回创建 ID 和明确 replay 状态 |
| `GET /{id}/simple-draft` | 有权读取的服务端最终事实、精确模板引用/政策摘要、单场次/岗位/地点和 `draftHash`；不返回成员档案/敏感地点给无权者 |
| `PUT /{id}/simple-draft` | 完整目标值 + `expectedDraftHash`；根锁后鉴权、比对、单事务更新父子/地点/政策与审计，返回最终事实及新 hash |
| `POST /{id}/publish-reviews` | 独立 Admin DTO `{operationKey, confirmation}` 显式映射当前 proposal 命令；返回实际 review/活动状态，不假报发布 |

`instance` 只允许本次容量（正整数或明确不限）、registrationDeadline、本次 description/registrationNotes；缺省与 null 区分。沿用 root title/organizationId/startAt/endAt/location、现有 typed places。`confirmedCapacity` 仍仅确认模板容量，不借其改语义；未传 instance 的旧请求/hash/replay 不变。各字段界限沿现有模型和时序校验，最终 DTO 生成后登记；不开放任意政策/保险/资格/分配方式/多场次覆盖。

首版限单场次、单默认参与岗位和既有 attendance role、first_come。发现复杂结构拒绝，不删除额外结构。时间按批准偏移一致生成父子及签到签退窗口，人数与地点解释一致，重验时长/贡献政策对新时间覆盖；保留原模板 version/hash。待审核不可编辑；锁后重新校验 actor/组织/责任/权限。`draftHash` 是固定排序的窄并发栅栏，不是认证凭据。保存、读取最终事实、预览、确认、提交审核是分开的动作。

最小 C 档目标及写集：

- **DoD**：普通正式成员发布人能经 Admin 创建/整体保存合法简单草稿，再交现有独立审核；旧 Quick 合同不变，失败整体回滚，无 pending-review 旁路。
- **源码写集**：`activity-creation-command.ts`、`activity-creation-quick.ts`、`activity-from-template.service.ts`；必要的 `activity-creation.service.ts`/`activity-write.service.ts`/`activity-draft.service.ts` transaction-bound 原语；一个窄 simple-draft 服务及独立 Admin controller/DTO；现有模块注册和针对性测试。按实际改动收敛，不做全域重构。
- **契约派生**：新增路由对应 OpenAPI、Admin client/types、contract、ROUTE_AUTHZ/计数地图等官方派生物，受保护路径走当前官方批准链；本台账不自发 grant。
- **探针顺序**：先旧 Quick characterization 与相关单测；后封闭参数/旧 hash、结构拒绝、时间/容量/地点/政策一致性、冲突/锁后撤权/待审拒绝、同 tx 回滚；最后普通业务账号真实 API 小活动正链及必要拒绝。未运行的全部 NOT_RUN。
- **授权及禁止域**：本次用户附件授权内的代码、隔离测试；不得触生产/旧 q1 成功对象、新持久身份或对象增权、schema/migration/seed、全局 guard、账本算法、事务预算、R6/R7；不得覆盖前端或 #1395 写集。用户另已批准四个精确保护路径同步和 L2 公开分支、新 Draft PR、完整 CI；不含新 L2 PR 合并或部署。

## 155 与生产独立前置

155 SQL SHA256 `5a286ec74fa8231a5cb427b32c53bdc666c7df376e212f9603070f22d19a704c`。待安装时源码要求 AttendanceCorrectionRequest 空、两个新守卫表不存在，以及五个既有 NOLOGIN 角色及精确两条 membership；迁移不负责创建登录/密码/HBA。已安装目标需核 migration checksum/目录，不能重放或永久要求请求表为空。未知/非空前置失败时停止，不删数据、不跳迁移、不伪登记 applied。

更正可信连接当前源码另明确限定 `app_test_r5_setmat_20261029_q1` 和固定角色名；不能只换 record/env 宣称支持新的正式目标。目标身份、PG/迁移实况、角色属性/membership、实际普通 N/P 连接、备份恢复和 stop-write 条件尚未提供/核验，均 UNKNOWN/NOT_RUN。这个生产资格缺口与 L2 草稿代码分开，不用生产写入换进度。

## 执行包状态

| 包 | 准确范围 | 状态 |
| --- | --- | --- |
| L0 | 附件、两仓、未合并写集、现成接口、155 前置和短合同 | COMPLETE；只读事实及本台账，无业务执行 |
| L1 | #1395 合同/生成物/CI/Trusted/正常合并和 main 核验 | 代码/完整 CI PASS；旧 Trusted PASS；用户已批准 Ready 后新 41398313337 检查，但代理调用被 GitHub integration 403 拒绝，已停止该动作、未合并 |
| L2 | 上述单场次一致保存、薄 Admin 适配和真实 API | 6/6 实现；原 131 定向 unit 与日界修复后 35 项回归 PASS，最终 types PASS；q8 最终运行字节真实六接口、同 XID／真实回滚／锁后撤权及当前专业时段/窗口拒绝 PASS；四处官方派生已同步，q7 完整 contract 1126/1126 PASS，原 945 schema/522 path 块未变；新增债务 0。完整 quick 留有下述阻断，不冒充全绿 |
| L3 | 唯一前端 owner 接既有表单/审核/必要结束链，保留 R5/统计候选 | 按最新用户指令 UI 延期；前端 owner 已安全暂停，18 文件 tree ae1a6370a586459709301b9f1c4339b2bff92be4（原 13 文件保留），真实新 UI NOT_RUN |
| L4 | 同版普通账号完整验收、目标 155/部署/启用前置 | NOT_RUN；生产目标和资格 UNKNOWN；API 验收与延期 UI/A16 分列，不代表已上线 |

当前是有界集成，非新架构。父线程的 1–2 天可联调候选、2–4 天验收/上线前检查只是条件性估算；实际时长取决于整体保存实现、普通身份真实验证、受保护审批以及正式目标前置，不能把该估算写成上线承诺。

提交前完整 quick 的原始失败保留：单测日界结构拒绝已修复并回归；`harness/domain-map.json` 仅模块输入摘要过期，但不在本轮四路径批准内，未修改，须精确补批后重验（模块/模型/归属和债务不变）；本机 Node24 全仓 lint 在既有 6GiB 堆上 OOM，使用 CI 同版 Node22、相同 6GiB 堆的独立冷验另记，未提高预算或放松断言。新 Draft PR 可先依赖 #1395 分支，保证差分仅含 L2；#1395 合并后再正常继承 main 并核新 head，不强推、不把旧 CI 视为新 head 通过。

## 本次未做

未运行生产、原 q1 或旧成功对象，未合并新 L2 PR、部署或启动 R6/R7。四个精确保护路径由代理按用户委托通过官方 grant 执行，未改守卫或自造令牌；公开分支/Draft PR 与全 CI 按新授权推进。仅新 socket-only、无外部网络、五 NOLOGIN fixture 角色的隔离 PG16 做 L2 合成 API/契约验证，正常销毁；q1/q2/q3 失败留证与 q4/q5/q6/q7 PASS 分别保留。#1395 未混入 L2；指定 Trusted 的代理批准被 GitHub integration 403 拒绝，未绕行或合并。正式结算／更正本轮未重跑，只按历史真实证据原范围复用。
