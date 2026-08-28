---
"feat(activities)": AC-010 改期联动 —— 单场次改期作废旧二维码并按新窗口重签(P1-28 9a C 档,todo 6→5)

- 新增 `attendance-qr-session-reissue.ts`(attendances,事务内受信原语):该场次 active 凭证
  全部作废(revokeReason=场次改期)+ 按**改期后**的时间窗为 check_in/check_out 各重签版本 +1
  —— 与取消作废原语同模块兄弟,头注四条结构性理由逐条同样成立
- 新增 `activity-session-reschedule-effects.ts`(activities):与取消联动成对;格子对照表见头注
  (名单/通知/人口/名额刻意不动 —— 通知由既有 enqueueScheduleChange 承载);一条聚合审计
  (activity.publish 伞 + extra.operation=activity-session-reschedule)
- 提案接线:`resolveRescheduledSessionIds`(只比六列时间窗,改名/改容量不触发)在 applySessions
  **前**取差异,联动在 apply **后**落(重签冻结新窗)
- e2e 四例(与取消联动同 spec 复用夹具):改期路径落库(此前全仓零测试)/旧码作废+新窗重签/
  B 场次与名单/人口纹丝不动(反向)/聚合审计;变异证据:卸检测 ⇒ QR+审计两例当场红
- 登记表 AC-010 接通,9a 读数 todo 6→5

BREAKING: 无(改期路径此前无行为;发布后变更审核新增联动效果)
