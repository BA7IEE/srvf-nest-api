E4 evaluation 批量写入改用外层 JSON 行展开，避免先将整个证明集合转换为 JSONB。持久化明细仍使用原 JSONB 列、完整来源引用及原 hash／数量校验；事务预算保持 30 秒。
