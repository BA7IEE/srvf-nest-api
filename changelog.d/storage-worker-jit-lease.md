### Fixed

- Storage consistency worker 改为在每条 operation 即将执行前才领取单条 PostgreSQL lease，并继续保留生产 worker 默认每轮 20 条的 drain budget；显式 `limit` 仍保留既有 1..100 范围。慢首条 Effect 不再预占批尾 lease，其他实例可通过既有 `SKIP LOCKED` 安全消费未领取余量，Provider、ledger fence/backoff、schema 与 API 语义不变。
