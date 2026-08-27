### 审计事件登记表 + 双向对拍判据 —— 合同 ④「Audit events 对账」那一半从零执行位到机器核对

P2-23b(2026-08-27)。合同 ④ 的另一半:Audit events。摸底发现事件名**已被**
`audit-logs.types.ts` 的闭 union `AuditLogEvent`(147 项)收编,三条写库漏斗
(`AuditLogsService.log()` / `writeConfigAudit()` / user-roles 内联)全部
`event: AuditLogEvent` 类型锁 —— TS 已静态保证「新增事件不进 union 编译不过」。
真正缺的是**对外清单与对拍**:union 里有哪些事件无人逐条核对,④-b 签字只能「接受现状」。
本刀交付两件:

- `docs/ai-harness/AUDIT_EVENT_REGISTRY.md`:147 个事件逐条点名(AST 提取生成后人工复核,
  非手抄),每条带「仓内出现次数」;5 个零产出事件显式标注,不许静默死。
- `src/modules/audit-logs/audit-event-registry.spec.ts`(unit 轮,不连库、零红区):
  AST 读 union + AST 全仓计数,六维判决(D0 仪器健康 / D1 union 提取闭集 fail-closed /
  D2 声明行对拍 / D3 漏登记 / D4 多登记 / D5 出现次数逐条镜像 / D6 零产出闭集)各自成 it;
  常驻变异对拍 M1–M6 红集精确、两两不相交,含「攻击者只改计数让总数对上」的外科变异(M3)。

⇒ 此后改 union(审计事件新增/退役)= 同一 PR 必须同步改登记表,否则 CI 红。

摸底新发现(本刀只登记不删,待维护者拍板):3 个 union 成员零产出且未标注退役 ——
`recruitment-application.certificate-upload` / `recruitment-application.certificate-review` /
`member.official-portrait.purge`,已在登记表备注「⚠️ 零产出且 union 未标注退役」。
