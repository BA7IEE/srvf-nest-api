# 现实状态与生产边界

这里记录无法从代码或 GitHub 推导的现场状态，不记录计数和每次 PR 进度。
以下沿用精简前最后确认的现场信息；仓库合并或 CI 通过不自动改变这些结论。

## 生产仍为 NO-GO

- 企业微信 `loginEnabled` / `messageEnabled` 尚不可开启。域名已注册、队长换证已完成，
  备案仍待推进；真实 HTTPS Cookie、双标签并发、上游耗时及 OAuth 全链未验。
  T6 真机验证后还须总评审。第三刀免的是单独复审，不是这次总评审。
- 前端与 API 必须同 origin。现有 `__Host-`/HttpOnly/SameSite=Lax Cookie 方案不支持直接改成跨 origin；
  变更拓扑前须重新评审，不自行打开 credentialed CORS。
- 2026-08-20 的 PG16、镜像与 readiness 验证仅为 `APP_ENV=smoke` 第一阶段，不是生产验收。
  v0.66.0 pre-release 永久不代表可部署；生产使用 [部署 runbook](ops/server-deployment-runbook.md)。
- 活动 v1.1、R5、D8-OPS、保险及真实外部通道的生产启用均需维护者另行执行。
  实际 ingress/ACL、registry digest、exact deployed SHA、fleet、worker 排空、稳定窗、
  前端适配和 10a/10b 证据仍未完成。不得以离线夹具或生成契约代替现场回执。

## 活动交付与开关

- D8-1/D8-2 仓库交付不等于不可逆生产切换。无收据时既有统计按原口径，正式证明 fail-closed。
  D8-OPS 现场两次授权、证据包、结算只读及排空未执行；AI 不运行 `--execute`。
- E3 来源/映射证明与影子复核能力已仓内交付，31 类真实映射继续 hold；
  shadow/Gate 关闭，真实业务未验收。详见 [影子对账](ops/contribution-shadow-reconciliation.md)。
- E4/E5 默认 off，active→off 恢复旧规则管理写，永久 cutover latch 尚未实施。
  首次上线方案为新空库，无旧业务数据转换。历史失败、验收与预算见
  [R5 发布准备](plans/activity-os-r5-limited500-release-readiness.md) 和
  [账本预算](plans/activity-os-r5-e4-ledger-commit-budget.md)；active500 边界不变。
- `ACTIVITY_V11_WORKFLOW_ENABLED` 不由 AI 开启。开闸前执行 `pnpm cutover:check` 并按业务合同顺序：
  停旧写 → 部署 migration 与同版本全套应用 → 开闸 → 全链 smoke。
  A 项失败不能放行，B/C 项须人工确认。`--profile r5-limited500` 仅为已批准的受限首发口径。
- AC-013/020/025 上线后按诉求立项、AC-017 搁置，四项仍为 TODO，完整合同 9a 不宣称完成。
  ADV-010/P2-21 已接真实账本进度验证。贡献 off 读旧考勤北京日封顶3，
  on 只读 committed credited，不叠加、不二次封顶、不空时回退。
  存量旧分若需迁移，必须先转换、逐人生涯与入队 cutoff 对账；见
  [存量考勤转换](ops/legacy-attendance-ledger-conversion.md)。

## 其他现场待办与已定边界

- 保险启用须 drain 旧 server，禁混档；新 worker fleet 未确认前不启用企微消息。
- 证书标准库 migration 67 为不可逆 DROP，生产尚未部署；按
  [go-live](ops/certificate-standard-library-go-live.md) 停写、备份验证、探针后由维护者 deploy。
  对外契约变更已发版，前端适配尚待完成。只内置法规定死内容的标准（业余无线电 A/B/C）；
  队内认定标准须按 [初始化 SOP](ops/certificate-standard-library-initialization.md) 人工创建，
  `code` 不可撤销，招新 `first_aid`/`bsafe` 选择器仍依赖该初始化。
- COS、微信小程序、腾讯云 OCR/SMS 的真实通道由维护者按 `docs/ops/` 验证。
  SMS/招新脱敏清理仍走手动 SOP；招新身份证 v1 明文入库为已有决定，加密/哈希另行立项。
- Decision 15.1=B/15.2=B（业务负责人最终确认:2026-07-27）：
  通知/内容管理为 SA 或 GLOBAL 读码，ADMIN 不直通；
  部门接收按 PRIMARY/SECONDARY/TEMPORARY/SUPPORT 有效任职与组织 ACTIVE。
  审计 SA 全量，其他持码者只看 self/USER，extra 禁 PII。
- scoped 授权余面、招新后续、入队同意书/退队清理期限、storage 深化、CMS 后续、
  repository 抽象与大 service 重构均按真实需求另行授权，不自动启动。
  多次锁等待累计预算、考勤审核备注永久留存的隐私口径仍待处理。

现行 API 见 `docs/handoff/`，业务规格与未完项见对应 `docs/plans/` 和
[未完事项索引](ai-harness/NEXT_TASKS.md)。历史全文使用 `git show harness-v3-final:<原路径>`。
