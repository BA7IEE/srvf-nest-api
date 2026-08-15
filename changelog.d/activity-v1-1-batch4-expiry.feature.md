### Added

- 第 4 批活动开始 expiry：复用现有两个 worker context 与 PostgreSQL `ActivityBatchJob` lease/fence，在不新增 cron、queue 或进程的前提下，为到点且仍有 canonical `pending|waitlisted` 报名或 pending invitation 的 published Activity 建立 reconciliation job。执行在 Activity 根事务内追加 system participation revision、清空 stale pointer/population、更新兼容报名摘要并过期邀请；pass 与 active capacity 不动，投影或 reservation 漂移统一以既有 20147 fail-closed。
