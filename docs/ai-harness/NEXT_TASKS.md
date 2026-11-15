# 未完事项索引

不再逐 PR 回填进度、计数或固定状态格式。以下保留尚有业务意义的事项，
开始工作时核对对应代码、GitHub 与现场证据，不把旧摘要当成新授权。
旧台账全文（含逐项证据与已收口事项）：
`git show harness-v3-final:docs/ai-harness/NEXT_TASKS.md`。

## 生产与当前业务

- **P1-27 / P1-25**：企微真实 HTTPS/T6 与其后总评审、后台配置、部署、前端联调及开关仍待维护者；
  域名备案和 fleet 前置见 `docs/current-state.md`、`docs/ops/wecom-message-channel-rollout.md`。
- **P1-28 / P1-33 / P2-21**：活动 v1.1/Activity OS/R5 的生产准入与真实业务验收未完成。
  业务合同保留在 `docs/archive/reviews/activity-business-overhaul-v1.1/`；
  当前阶段见 `docs/plans/activity-os-r5-limited500-release-readiness.md`。
  AC-013/017/020/025 仍为 TODO，不能当作永久豁免；D8-OPS、真实映射和生产 Gate 不自动执行。
- **P1-10**：保险代码交付与 runtime enable/deploy 分开，部署窗口必须 drain 旧 server、禁混档。
- **P1-24**：证书标准库生产 migration 67、队内认定初始化与前端适配未完。
  法规定死内容才内置，其他标准人工建立；见 `docs/ops/certificate-standard-library-go-live.md`。
- **P1-30**：Integration 后续以现行模块与对应计划为准，旧 PR1–8 摘要不是当前交付事实；
  ServicePrincipal 与 Human 边界、RoleBinding 和运行准入不能省略。
- **P1-32**：RBAC PR6–7 等前端投用；PR8 的旧入口退役不等于已完成前端适配和所有清理。
  权限目录、影响预览与 step-up 的安全语义继续有效，见 permissions 当地规则。

## 需求触发的后续

- **P1-14**：报名前 openid 推送、短信投递查询；**P1-20**：App 证书图；**P1-15**：存量队员批量导入。
- **P1-22**：专业队/gate 配置化；**P1-23**：`isForeigner` 物理列改名。均不自动启动。
- **P2-6/7**：真实 COS/实名通道、attachment.other enforcement 和 seed 字典治理时处理已接受残余，
  具体四项/两项依据从旧台账相应编号读取，不将“当前无危害”推断为永久无需处理。
- **P2-10**：SMS `SENT` 表示 provider 已接受，不代表送达；三态与回调需独立业务决定。
- **P2-11**：外键副本来源保护剩 append-only trigger；既有“只锁编号”不替代不可变保障。
- **P2-13**：权限说明与 surface 绑定余项；ROUTE_AUTHZ 的旧自述不是授权真相。
- **P2-19**：`feedback.eligibilityCorrected` 恒 false 的修正等前端评价面真实使用。
- **P2-20**：三处 Swagger description 的旧 coverImageUrl/裸 URL 文字需在相关契约任务核对处理。
- **P2-22**：旧读者闭包具名清单尚需处理，现有计数不能代替逐项对账。
- 锁等待累计预算、考勤自由备注永久原文审计的隐私口径仍开放。

旧 **P1-29/P2-17** 的架构台账翻闸与本地 hook 扩面随 harness 精简退役，不再作为待开发需求。
大 service 改动仍须先理解调用链、做 characterization、保持事务/锁和行为测试。

## 已定通知口径

Decision 15.1=B、Decision 15.2=B；业务负责人最终确认日期：2026-07-27。
管理读面限 SUPER_ADMIN 或 GLOBAL 显式读码，Role.ADMIN 不直通。
部门接收依 PRIMARY、SECONDARY、TEMPORARY、SUPPORT 有效任职，组织 ACTIVE 且未软删；
历史规则不因流程台账退出而改变。实现与完整约束见 notifications 模块规则。
