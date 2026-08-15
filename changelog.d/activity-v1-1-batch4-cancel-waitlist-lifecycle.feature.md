### Changed

- 第 4 批整单活动取消现接入永久报名头 lifecycle：Activity 根事务只关闭 canonical `pending|waitlisted`，追加 immutable Registration/Participation revision 并 CAS 投影；已通过报名的历史审批、pointer 与 active capacity 保留。任何 revision、状态、pointer、population 或 reservation 漂移均复用既有 20147 整笔失败。
- 旧 `activity-waitlist-promotion` writer 现仅处理无永久 participation identity 的 legacy header；canonical 候补继续只由 allocation caller 在原场次、原岗位递补。
