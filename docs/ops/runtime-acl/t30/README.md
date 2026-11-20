# T30 首发契约与共享权限退役验证

**推荐保留候选当前配置。** 常规单场次首版的后端合同已经明确。Admin 通过模板创建 Simple 草稿，提交初审，由独立审核人发布。V3 是本次验证采用的一种兼容模板版本。既有 App managed 草稿仍有自身合同；关闭新建入口时，客户端不得转用旧入口绕过关闭态。仓内后端交付与 UI、部署、上线准入分别验收。

| 事实 | 依据 |
|---|---|
| 简单模板、目标组织创建权限、独立审核及角色范围 | docs/plans/activity-os-routine-v1-execution-20261102.md 的 L2/L3/L4；docs/handoff/activity-os-simple-activities.md 的身份和六入口 |
| off 拒绝、shadow 限试运行、active 展示；前端控制人群 | docs/handoff/miniapp.md 的 R2/B7。src/config/app.config.ts 的配置校验要求 production/smoke 启用 active 时同时开启 V1.1 |
| 责任制 true 的来历 | T26b 专为测试 managed 流程将 false 改为 true；本轮 SSH 确认现行 compose 与 enabled.sha 相符，restore.sh 存在且语法通过。没有候选已切至 V3 的证据 |
| 版本 | 运行源码 108feebb84b85c7e4955c5af8bbfc016702e4529；GitHub main 2b3eee0a954ea65abaef3edb35fd391eaa1567e9。树差异仅 scripts/cutover-check.ts |
| 候选同期观测 | sh preflight.sh exit 0。true/off/false；短信、企业微信消息、微信订阅的有效外发条件均 false；合格版本初筛模板 0、创建码 0。未尝试投递 |
| 候选责任制恢复 | /var/tmp/srvf-t26b.fMwTQBTr/restore.sh，运行恢复 NOT_RUN |

卡 A 冻结 2a0fd5adbaddf01ee9cac5c16d49cfc21790aed7，仅恢复更新、发布、结算终审三码的预置映射，不补 activity.create.record，不给用户绑定角色。A/B 候选均 NOT_RUN，GRANT=0。候选装配另附预检与回退草案，不把孤立的 130 项列权限送作业务盲批。

## 卡 B 的实际写入及退役

在 PG16 一次性库复制候选有效 ACL，用运行版 Nest 和相同 V3 模板走两组测试。非所有者应用连接承担业务操作；隔离库所有者承担夹具、故障注入、退役及对账。没有启动发送 Worker 或调用外部供应商。

| 实验 | 结果 |
|---|---|
| 候选等价开关与基线 ACL，另给合法测试目录、普通发起人和模板 | off 拒绝 20163；活动和意图均 0。证明即使资源就绪仍受控制面约束 |
| shadow、拟议 ACL，审核提交阶段注入 audit_logs 写失败 | 应用报注入错误；发布前后核对绑定、意图、审计数量，活动及审核状态完全相同；随后正常发布 |
| 同键重试创建、批准 | 两次均正常重放；绑定、意图、审计数量及活动/审核状态未变 |
| 运行链实际新增 | 活动级 MEMBER → activity-owner 绑定 1 条。notification.targeted → activity_publish_review/member 1 条；notification.system-broadcast → activity/visibility 1 条。均 pending。独立审核员的组织级夹具绑定单列，不计为应用新建 |
| 事务提交后的处置 | 在隔离库按测试活动及绑定 ID 精确置 ENDED，活动绑定 ACTIVE=0。用应用 outbox 服务按精确事件键领取并用 lease fence 转 dead；再次 claim 为空，2 条 sentAt 为空；5 条既有审计逐行读回一致 |
| 范围 | 撤绑定已验证存储状态。已存在的责任投影、审计、活动、角色目录仍保留；仅结束绑定不足以证明普通用户失去所有业务访问。未验证线上停用账户、清理在途 provider 请求、线上操作或自动禁止人工 replay |

未来允许 Worker 接管测试数据前须停止消费者，逐一核准测试活动与审核对应的事件键、检查无在途/已发送记录及已派生子项，限定未发 pending 后按受保护的退役流程处理，并验证不可再次领取。已领取或存在外部调用的项先对账，不能宣称可撤回。保留终态、原审计及退役清单；不对这些测试事件人工 replay。真实部署若没有获批的逐事件操作入口，维持消费隔离。隔离 owner 调用 fenced 服务的证据不构成候选执行授权。

共享 API 数据库身份的能力覆盖所有使用它的进程与行，能新增活动角色绑定和通知意图，无法用列 ACL 限定为测试数据。若要硬隔离，应使用独立测试栈、数据与消费者；仅换一个连接身份会同时改变整个 API 的授权面。永久修复归部署角色契约及预检维护方，在 Draft #1442 证据基础上版本化审核配置、基线与精确回退，并将权限目录和部署版本一起核对。本轮仅提交证据，正式部署修复、前端页面、候选切换、真实通知均 NOT_RUN。

复现用 T29c 固定版归档与依赖，暂存路径写入 srcpath，从相邻 t29c 复制 acl.jsonl 与 grant.sql。依次运行 `LAB_EXPECT_OFF=1 python3 run.py`、`python3 run.py`，均 exit 0。脚本仅创建本地一次性 PG，退出清理。结果分别见 off.log 与 shadow.log。
