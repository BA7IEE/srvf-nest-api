# Activity OS C4：活动结束工作台评审与授权清单

> 2026-09-09；核验基点 main `36ff609c`（#1301）。状态：**方案 A 已获维护者确认，未实施**。维护者已追加授权补充 changelog、提交、推送并创建文档评审 PR；不合并、不实施，不操作数据库、生产、Gate 或删除业务数据。下方候选路径仍须在精确实施计划中定稿，不因本次方案确认成为代码写授权。

## 1. 要解决什么

负责人结束活动后，需要知道成果是否已形成正式版本、有没有更正待处理，以及去哪里继续处理。推荐方案 A：提供一个只读汇总入口，把已有能力组织起来；所有录入、计算、确认、更正、结算和归档仍走原命令及原权限。

不推荐重做一套结算或新增“全部办完才能结束”的总状态：这会产生两套事实，并改变已有业务门槛。C4 的提示不能拦截报名、考勤、时长、贡献、Incident 关闭或归档。

## 2. 依据与现状

| 依据 | 已核对事实与约束 |
|---|---|
| 原始终态蓝图 Release 3（第 2369 行）及 [T0 合同](../archive/reviews/activity-os-t0-terminal-review.md) | C4 是活动结束工作台；C5 是报表 DTO；Release 4 D4 是分类时长与结算工作台。不能混作同一交付。 |
| [C3 合同 §4.2、§6](../archive/reviews/activity-os-r3-c3-automatic-metrics-confirmation-review.md) | 正式成果必须使用现行 confirmed 选择器，不取最大 revision；不增成果硬门。 |
| `src/modules/activities/activity-outcome-confirmed-query.service.ts`：`readCurrentConfirmedOutcomeInTx` / `get` | 已有现行正式选择器、事务及访问复验；更正草稿存在时旧 confirmed 仍正式有效。 |
| `src/modules/activities/activity-outcome-query.service.ts`：`list` / `get` | 历史读面已经存在；不改变旧 DTO，不全量加载历史到汇总接口。 |
| `src/modules/activities/activity-outcome-access.service.ts`：`authorize` | Human App、当前身份、显式权限、组织资格与范围、draft initiator／非 draft owner；归档历史沿原资格规则。 |
| `src/modules/activities/activity-settlement-http.service.ts`：`workbench`；managed controller 的 `GET :activityId/settlement` | 既有结算工作台有独立资格，包含 owner／attendance collaborator 访问语义；不能拿成果 read 权限替代。 |
| [#1300](https://github.com/BA7IEE/srvf-nest-api/pull/1300)、[#1301](https://github.com/BA7IEE/srvf-nest-api/pull/1301) | C3-2 已合并。最新 [main CI](https://github.com/BA7IEE/srvf-nest-api/actions/runs/34369385145) 通过；原紧急创建 500 未定位，诊断不等于修复。 |

上位合同未细定 C4 的接口字段与权限。本稿建议经拍板后再形成逐路径实施合同，不从“工作台”三个字推导新增写操作。

## 3. 推荐方案 A 的数据与访问合同

### 3.1 单活动只读摘要

建议新增 App managed `GET :activityId/ending-workbench`，返回显式 DTO；不得扩充旧成果或结算响应。建议包含：

- 活动锚点及现有活动状态，不新增“已全面结束”业务状态。
- 指标选择状态：明确区分 `not_required`、已选择、尚未确定；不把缺失读成零成果。
- 现行正式成果的 ID、revision、确认时间和值数量；无正式成果返回 null。实际值、附件、历史详情沿原受控入口，不重复输出。
- 当前草稿／更正的安全锚点与提示；必须依据现行模型状态与关联判断，取消的更正不能仍提示待确认。不能将最大 revision 当正式成果。
- 封闭提示码及对应既有动作标识：例如尚未选择、尚无正式成果、存在待处理更正。不新增业务阻断，只帮助用户定位下一步。

建议不自动计算候选、不在 GET 中写入收据或审计业务事件、不新增 schema、migration、权限码、角色默认授权、缓存或定时器。已有候选是否过期应沿原查询语义按需查询；不得为了填摘要在每次 GET 做大规模复算。

### 3.2 跨域入口，不跨域泄露

工作台主体沿 `activity.outcome.read` 的完整访问规则；不扩大到普通参与者、仅结算协作者、机器身份或 delegated 身份。无访问资格沿现有泛化错误，不泄露活动存在性。

结算及归档仅作为既有功能入口，不在此响应装入结算名单、真实姓名、成员编号、结算金额或归档内部信息。客户端进入原接口时由原服务重新判权；显示入口不是获得权限。若需要返回“可操作”能力，必须调用各自公开判权原语，不由 read 权限、角色名或前端状态推算。

本方案不强求将各域摘要揉进一个事务：本次成果摘要在自身一致的读取边界内构造；独立页面继续按各自接口读取，不声称整场活动跨域原子快照。需要新增属主原语时先列精确路径与理由，不跨模块深引或直查私有表。

### 3.3 状态、数据保留与敏感性

草稿／进行中可显示准备信息，completed／terminated 可引导已授权确认；cancelled／archived 只显示符合既有资格的历史，不通过工作台恢复写权限。按钮提示不能替代命令端状态、版本与权限检查。

用途仅是负责人查看办理进度；查看角色沿成果读面；不新增敏感字段或名单。全部成果、来源、证据与收据继续保留，不设计到期删除、退队清理或历史压缩。退队导致访问资格失效，不等于删除历史。

## 4. 交付边界与建议实施包

本仓交付后端只读 API、测试及前端交接文档，不冒充已交付前端页面。实际前端发布是独立仓库与授权范围。

| 范围 | 建议路径／责任 | 实施前要求 |
|---|---|---|
| 新查询与 DTO | `src/modules/activities/activity-ending-workbench-query.service.ts`、`src/modules/activities/dto/app/app-ending-workbench.dto.ts` | 定稿字段、null 与提示闭集，明确读取一致性及有界查询。 |
| 接线 | `src/modules/activities/controllers/app-managed-activities.controller.ts`、`src/modules/activities/activities.module.ts` | 精确新增路由、依赖与访问声明，不改旧命令。 |
| 既有成果属主能力 | `activity-outcome-confirmed-query.service.ts`、`activity-outcome-access.service.ts`（均在 activities 模块） | 优先复用；只有引用链证明需要才列入修改写集，不能顺手重构。 |
| 测试 | 新 query 单测及 `test/e2e/activity-os-r3-c4-ending-workbench.e2e-spec.ts` | 新文件建议名；旧测试不预授权改断言。 |
| 派生与交接 | 契约 snapshot、路由登记、API 派生文档及前端交接、CODEMAP、模块说明 | 实施计划必须通过实际生成与引用链列出每个路径及预期增量，不以本行通配授权。 |

以上是评审候选写集，**不是可执行精确写集**。推荐一份完整实施计划一次列齐路由、DTO、引用链、派生项和验收，不把普通包内步骤反复拆授权；如果验证后确认必须新增权限、数据库模型或跨域生产修改，则回到评审，不夹带实施。

## 5. 验收清单

1. 正式选择器：无成果、有 draft、初次 confirmed、更正 pending、更正取消、新正式替代；pending 和取消都不得让旧正式消失。
2. 指标选择：未选择、not_required、已选择分开表示；空数据不伪装为完成或零值。
3. 权限：无权限、跨组织、失效组织、非 owner、退队、停用身份、SP/delegated 均按既有规则拒绝；归档历史只对仍有权者可见。
4. 并发：读与确认／取消／更正交错不形成混合摘要；涉及锁等待时复验撤权和负责人变化。明确两连接真实库用例，不用 mock 冒充锁安全。
5. 隐私与纯读：响应无名单、原始来源、真实姓名、附件 key／签名 URL；调用不改变成果、收据、活动或结算状态。
6. 兼容：旧成果读写、正式选择器、结算与归档行为保持；无成果仍不阻断原流程。旧 snapshot 每个增量可解释，不盲更新。
7. 有界读取：历史再多也不全量展开；查询数与摘要规模有界，超限／异常正式多头按既有安全失败语义处理。
8. 文档与 CI：lint、typecheck、受影响单测及 E2E、contract 和派生闸；若扩大到 common/authz 等枢纽须按仓库规则全量验证。最终以真实执行结果登记，不提前填写通过数。

## 6. 一次列齐的授权清单

方案 A 及本轮文档提交、推送、开 PR 已获确认；以下保留授权分层，不能将文档 PR 许可当作实施许可。精确实施计划尚待授权：

> 确认 C4 方案 A，起草精确实施计划及完整授权清单；仅文档，不实施。

本轮已收到的文档 PR 授权（不再重复请求）：

> 允许补充 changelog，提交、推送并创建 C4 文档评审 PR；不合并、不实施、不操作数据库、不启用 Gate。

实施包定稿后一次确认：精确文件名单、必要红区维护者授权、隔离测试库范围、验证后是否可提交推送开 PR。合并、生产和 Gate 不随实施许可自动解锁。当前不要求运行数据库命令；尚未定稿的路径不生成宽泛 grant 命令，也不重签 3b/4b。

## 7. 本次未做

未实现 C4、未改任何生产代码／测试／schema／权限，未操作数据库、删除业务数据、提交推送或开 PR。C5、分类时长 D4、前端页面、部署、Gate 与整体跨模型复审未完成。原紧急创建 500 仅保留诊断，不宣称修复。
