# C1 D2b 活动指标选择与 Template V3 交付、验证及回退

状态：已随 [#1282](https://github.com/BA7IEE/srvf-nest-api/pull/1282) 合入 `f5b5b226`；最终 PR HEAD `1ceaedac`，18 项检查与可信红区审批通过，[合并后 main CI](https://github.com/BA7IEE/srvf-nest-api/actions/runs/34030385503) 通过。本文不是生产执行授权。D2a 已交付的目录沿用
[`activity-metric-catalogue-rollout.md`](activity-metric-catalogue-rollout.md)。
本步依据冻结的 [`C1 D2b 实施清单`](../archive/plans/activity-os-r3-c1-d2b-implementation-plan.md)，
实施授权以维护者后续确认及精确写集为准，冻结稿中的历史“待授权”状态不回改。

## D2b 交付证据与后续边界

- 两项补充方案 A 已获维护者确认并实施：两个 App options 先校验当前队员对目标组织的
  发起资格，候选上限 1000，超限明确返回 20183/409；完整可新选过滤先于分页和 total。
  Admin 目录仍可读 draft/retired 历史版本，不能替代 App options。
- Quick V3 已透传事务内复验的当前身份到既有 `activity.publish` 创建审计；
  回归先复现旧角色快照，再验证修复。V1/V2 没有该新身份结果时保留原分支。
- 12 操作的 OpenAPI、六个 surface 的客户端及交接文档已同步，contract 的
  1016 项测试和两个 snapshot 通过。组织资格原语改造、权限说明联动及生成物刷新后，
  最终 quick 退出 0：缓存 lint、typecheck、harness 通过，unit 为 323 套、7425 通过、
  0 失败、5 todo。实施阶段五个变动 TS 文件及最终三份旧测试的无缓存定向 lint 均通过；最终 PR CI 五个 E2E 分片全部通过。
- 2026-09-06 维护者的两条精确授权已包含旧码说明联动；现已补充
  `activity.update.record` 指标选择的 businessDescription，并由生成器同步其 6→8 管辖面
  及两条新模板码的派生权限基线。三文件权限定向测试 22 项通过；基线 diff 仅这三条码。
  没有改动权限语义、seed 短描述或角色授码。
- 架构检查曾报告四处新身份：组织 options 的两处查询及 Authz 的任职查询，与 HEAD 的
  查询参数逐一相同，新增局部变量造成 AST 定位偏移。改为显式 `(tx ?? this.prisma)`
  后，三处仍被扫描为原有已登记查询，208 条台账身份重新全部匹配；架构基线和扫描器未改。
  相关三个事务单测文件 50 项通过，不能据此宣称偿还了这些历史债。
- 维护者已确认“C1 D2b 组织资格属主原语扩展方案 A”，组织资格原语、对应测试及
  组织本地说明三文件已纳入写集并实现。A7 调用组织模块的同事务资格原因接口，再映射
  原有的不存在、停用、根节点错误；既有 boolean Readiness 接口复用同一判定且返回不变。
  改动前 41 项行为回归通过，改动后连同新增原语测试 48 项通过；组织停用优先于根节点，
  身份和权限优先于组织查询。新增架构债 1→0，208 条已登记身份全部匹配，
  未放宽读白名单、登记新债、删除 active 检查或改变架构基线。
  后续四套真实 PostgreSQL 回归 48 项通过，含 A7 在调用者事务内看到未提交的组织停用/软删，
  以及旧 A7 系列生成、V3 身份、五条创建兼容和锁等待竞态；组织测试修改均回滚。
  最终 contract 1016 项及两个 snapshot、build、12 项 docs 检查和 FROZEN 派生闸均通过。
- 3b/4b 已于 2026-09-06 按维护者确认重签；最终 PR CI、可信红区审批及明确合并许可均已闭合。
  PR CI run 34028624264、可信审批 run 34028623344、Docker smoke run 34028624236 均成功。
- D2c 的 v7 提案冻结与内部 Readiness 已在当前分支实现，详见
  [V7 提案与 Readiness 交付说明](activity-metric-proposal-v7-rollout.md)。它不新增成果登记，
  不改 D2b 的选择/模板合同，也不代表已合并、生产部署或 C1 整体完成。

### 维护者已确认重签的核对值（2026-09-06）

最终 CI 曾有两类问题，均已按独立批准处理后复跑成功：R11 把新增 optional metricSelection
下的 required 子字段误判为旧请求必填，最小复现确认 14 条 finding；fragment 加两条精确
误报申报，未改比较器、DTO 或旧契约。三份旧 E2E 则遗漏新 FK 的清理适配及跨版本默认列：
按批准补测试清理 CASCADE，D1 rehearsal 先保留 109→110 原整行等式，再验证 110→112
旧字段不变和四个新默认值、112 重放整行不变；没有删除测试或放宽行为断言。
三套本地 57/57 通过，最终 PR CI 五分片通过；实际写集 127 / 已授权 134，越界 0。

以上只记录 D2b 完成交付。D2c 已按其
[实施与授权清单](../archive/plans/activity-os-r3-c1-d2c-implementation-plan.md)在独立当前分支实现；
它的 PR、可信审批、整体跨模型复审、合并和生产仍须分别收口，不能由本页的 D2b 历史证据替代。

- 3b：第 112 条 `20260906114906_activity_os_r3_c1_metric_selection_template_v3`，
  SQL SHA-256 `7d033165ee7a786c826c49965095be34ffb1722f1d06c624defee82581b5bbbb`。
  app_test 中对应 migration 已完成、未回滚，记录 checksum 与该 SQL 逐字一致；
  112 冷回放及 111→112 非空升级的 63 项迁移用例此前已通过，本次组织原语改造未改 SQL。
- 4b：权限码 252，仅新增两条 Human GLOBAL 模板权限；既有 activity.update.record
  只补说明及 6→8 管辖面基线，不改变授码。Audit events 总计 161、活跃 156、退役 5，
  字典 30 types / 277 items；登记表判据均通过，seed-sha256-12 为 `5f6250db794f`。
- [`CUTOVER_SIGNOFF.md`](../ai-harness/CUTOVER_SIGNOFF.md) 已按本次对话确认登记 3b/4b，保留前签历史；
  本节也不授予 PR 合并、生产 deploy、初始化内容、人员授码或 Gate 开启权限。

## 数据与兼容性

第 112 条迁移为 `20260906114906_activity_os_r3_c1_metric_selection_template_v3`。
只扩展 Activity 四列、指标集精确 id/hash 唯一锚点、已有领域收据的两个目标列，
并增加/替换对应 FK 与 CHECK。不改已合入的 110/111 SQL，不回填旧业务事实。

| 选择状态 | 含义 |
|---|---|
| unconfigured | 三列 NULL、revision=0；旧活动和省略新字段的旧创建保持原态 |
| not_required | 显式声明不要求指标，指针 NULL；不是“尚未配置” |
| required | 精确集版本与 hash 同时存在，由复合 Restrict FK 证明属于同一版本 |

初始配置 revision=1；新草稿选择命令即使内容相同也加一。同 key 重放不增加 revision、
不重复写审计。不提供重置为 unconfigured 的入口。
原八类目录收据保持原目标/结果合同，新模板收据六字段、新选择收据四字段分开解释。
V1/V2、旧创建请求/hash/响应、既有提案 v2–v6 不因本步改写。

seed 仅增加 `activity-template.read.catalog` 与 `activity-template.manage.version` 两个权限码，
不自动给内建角色、绑定或职务策略授码。人/角色配置及首批模板内容须单独审批。

## 已实现的入口边界

Admin 全局模板目录为 `/api/admin/v1/activity-template-versions`：列表、详情、创建、
`/:id/draft` 整份编辑、`/:id/activate` 激活、`/:id/retire` 退役，共六操作。
只接受 Human GLOBAL 权限，读写互不隐含，普通 ADMIN 不直通，Service token 不可进入。
Family 必须 global、无 ownerOrganizationId 且 active；V1/V2 可读、可作为精确复制来源，不能原地改成 V3。
版本号由调用者显式指定，不自动取 max+1；激活后内容与版本身份冻结。

选择读写各有独立 Admin/App DTO：

- `/api/admin/v1/activities/:id/metric-selection`
- `/api/app/v1/my/managed-activities/:activityId/metric-selection`

GET 沿各自现有活动可见性；PUT 需要 Activity scope 的 `activity.update.record`、
当前草稿/managed 属主规则、无 pending publish review 及匹配的 expectedRevision。
模板管理权限不等于活动管理权限。App 每次还必须满足当前 ACTIVE User/Member 准入。

App options 为 managed 前缀下的 `metric-set-options` 和 `template-version-options` 两个 GET。
均要求 organizationId，默认 page=1/pageSize=20，pageSize 最大 100。
每个目录先只读最多 1001 个候选 ID；第 1001 个触发明确错误，不加载大定义、不返回截断 total。
未超限时在同一只读 RepeatableRead 事务内加载有界定义闭包，按 createdAt DESC/id DESC
过滤、计数和分页。V3 引用的集及每个定义都须仍可新选，V1/V2 保持自身 grammar。
目录判读不返回原始定义/表单、治理信息或权限码，也不因读取写入命令收据或审计。

专业、紧急创建只在显式提供 metricSelection 时进入新分支；省略字段保持旧 hash。
A6/快速创建和 Series 从精确 V3 物化选择；普通 clone 复制已配置选择前重新验证其可新选性。
集及定义退役后仍能解释历史选择和成功收据，但不能作为新的 required 选择。
V3 时间窗口沿 A6 元数据规则，不额外引入“当前墙钟必须在窗口内”的 Gate。
敏感表单题目仍受既有逐题审批门禁约束，复制来源可以解析不等于获准启用。

## 命令重放、停止与排错

等待业务锁后必须使用同一事务重读当前身份、权限和相关 Family 可见性。
历史 key 不能绕过撤权、User/Member 失效或目标不可见；重放返回第一次的结果，
需 GET 才能获取资源当前状态。不要把旧收据中的 draft 当作资源现在仍为 draft。

| 错误 | 处置 |
|---|---|
| 20172 | 指标引用已不可新选或完整 hash 闭包校验失败；刷新并重新选择，不改库绕过 |
| 20174 / 20178 | 选择/模板定义不合法，修正完整输入；不降级为 unconfigured |
| 20175 / 20181 | revision 或模板/source hash 已变化；重新读取，由使用者决定下一次操作 |
| 20176 / 20182 | 同 key 对应不同请求；禁止自动换 key 掩盖冲突 |
| 20177 / 20173 | 选择/模板收据形状损坏；停止重试，保留原记录并调查 |
| 20179 / 20180 | 模板不可见或不存在 / Family 或版本身份占用；不覆盖旧版本 |
| 20183 | 目录候选超过 1000；联系管理员整理目录，不增大 pageSize 或自动截断 |

认证与权限沿 40100/30100，未知异常保留 500。失败不得留下半套 Family、Version、
Activity 选择、收据或审计。两个新事件为 `activity.metric-selection.command` 与
`activity.template-version.command`；只记主体、目标、固定操作/来源和前后状态/revision/hash，
不记 operationKey、配置全文、题干、成果值或附件链接。

## 验证证据与运行边界

仅在维护者明确允许对应测试库验证与重建后运行定向 E2E。主仓目标限定为
`app_test`（只 deploy/核验）、`app_test_w1`（串行 E2E/contract）、`app_test_w98`（本步迁移演练）。
重建会删除隔离库测试数据，靠 fixture 重建，不是生产备份恢复机制。
contract 与 E2E 不并行；不运行会创建其他 worker/scratch 库的历史全量回放。

| 执行位 | 已验证的范围 |
|---|---|
| `activity-os-r3-c1-d2b-selection-template-migration.e2e-spec.ts` | 112 冷重放、111→112 非空升级；旧 Activity 业务字段/八类收据字节不变；seed 二跑；CHECK/FK/收据不可改删；当前 Prisma diff 与原 19 语句基线逐字一致 |
| `activity-os-r3-c1-d2b-template-catalogue.e2e-spec.ts` | 真实 HTTP 的目录到活动创建链、读写分离、机器令牌拒绝、复制/表单门禁、重放与整笔回滚；Family 在集锁等待中退役时拒绝四类写入；App options 静态路由/资格/精确分页/退役引用/1001 候选报错 |
| `activity-os-r3-c1-d2b-metric-selection.e2e-spec.ts` | 两个 surface 的可见性、草稿选择、revision/key、历史引用解释及失败回滚 |
| `activity-os-r3-c1-d2b-selection-concurrency.e2e-spec.ts` | 独立连接池下同 key/不同 key 竞争，以及等待锁时身份、grant、角色、组织、发起人和引用变化 |
| `activity-os-r3-c1-d2b-authz-transaction.e2e-spec.ts` | V3 A6/Series 当前身份与重放；Series 等待锁期间撤权；A6/Series 当前角色审计 |
| `activity-os-r3-c1-d2b-creation-compatibility.e2e-spec.ts` | 五条创建/复制链及旧 V1/V2、省略字段的创建兼容性；Quick V3 当前角色的创建审计；不代替本节顶部待闭合项 |

上述文件均位于 `test/e2e/`。Prisma diff 只覆盖它能比较的结构，不代替 CHECK/trigger 的正反例。
14 份旧 migration E2E 只同步 CURRENT_MIGRATION_COUNT=112，不能据此宣称其完整回放已在本地通过。
本地不跑全仓 E2E；完整验收由同一 PR 的 CI 冷跑执行，结果不得用定向计数替代。

## 上线与回退硬门

D2b 的迁移审查、真实 3b/4b、可信审批、CI 和明确合并证据已齐。阶段性跨模型复审按维护者要求延后至整体完成后，尚未取得独立结论，不记为通过。
生产部署和首批内容/人员授码仍是独立授权，不由本说明、测试库 deploy 或合并自动授予。
不新增或自动开启任何 Gate，不执行生产初始化、回填或批量改写。

若要暂停写入，维护者先进入相应维护窗口并停止受影响的新命令；保留历史版本、选择、
收据和审计。退役不是删除，更不是撤销已物化活动的事实。
V3 或新收据已写入后，不能仅回滚为只认识 V1/V2/旧八类收据的二进制；须保留兼容读者。
本步不提供 DROP 列/表、回改历史 SQL、物理删除收据或自动数据降级脚本。
禁止自动执行 migrate dev/reset、db push、force-reset 或 accept-data-loss。
