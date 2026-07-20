### Fixed

- 修复 PostgreSQL shared throttler 新建空桶的毫秒精度窗口漂移：仅当 raw hits 为空且不存在有效 block 时，使用锁后数据库时钟初始化完整 TTL；active block 与 expired block 的计数/解除语义不变，expired-block+raw-empty 的窗口按完整 TTL 初始化，rolling hits、retention 与多实例串行语义保持不变。
