## D7-2 满额绑定守护修复（实施中）

- 第126条 migration 仅将 `CorrectionTimeAllocationBinding` 的插入守护从逐行校验改为
  语句级集合校验，避免满额来源集合重复锁定相同证明、申请、分配和待物化记录。
- 原有同活动锚点、准备／应用／就绪状态、待物化分配精确匹配与
  `ctsp_assert_complete` 来源集合完整性校验保持 fail-closed；不新增表、字段、权限、DML、回填或
  业务数据删除。
- 第126条 SQL 摘要的 3b 已由维护者重签；隔离验证与 Draft PR CI 仍按既定边界推进，未 Ready、
  合并、部署或启用 Gate。
