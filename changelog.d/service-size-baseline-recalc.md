### Changed

- 重算尺寸棘轮基线(Phase 6-B 第三域七刀收官):条目 **27 → 21**,六个经拆分跌破 700 阈值的文件退出,**未新增、未上调任何条目**。转闸摩擦(SERVICE_SIZE_RATCHET §3 严口径)由 **93 降至 27**,低于判据线 30 —— 连同 PR#1054/#1056 达成的 EC-1,该文 §4 Exit Criteria 的两条 ❌ 全部清除。

### Fixed

- 记录并绕开一个真缺陷:`pnpm harness:servicesize:write` **不是棘轮安全的** —— 它按当前磁盘状态整体重算,既会新增条目也会上调既有条目,两者都被 base-trusted 裁判(EC-1 新增的 `judgeNumericMonotonicity`)正确拒绝且审批盖不掉。本刀改用「对 base 基线逐条取 min、丢弃跌破阈值的、绝不新增也绝不上调」的单调向下重算。缺陷成因与正确做法见 `SERVICE_SIZE_RATCHET.md §3.2`。
